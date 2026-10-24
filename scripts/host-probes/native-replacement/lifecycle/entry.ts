// Parent entry wiring for the isolated M1 native-replacement lifecycle.
// This module performs no host, network, container, database, Git, or secret access at import time.

import { randomBytes } from "node:crypto"
import { pathToFileURL } from "node:url"
import {
  LifecycleError,
  verifyOpenApiArchiveContract,
  withIsolatedHost,
} from "./runner.mjs"
import {
  OLD_ROOT_TITLE,
  SYNTHETIC_TAIL_TEXT,
  buildImportPayload,
  createSyntheticFixture,
  type FixtureIDs,
  type NativeFixture,
  type NativeImportPayload,
  type SyntheticMessage,
} from "../fixtures"
import {
  NotFoundError,
  archiveState,
  createRestartManifest,
  parseRestartManifest,
  runNativeReplacement,
  validateRestartReadback,
  type AdapterMessage,
  type NativeReplacementResult,
  type RestartManifest,
} from "../state-machine"
import { createHttpProbeAdapter } from "../http-adapter"

const PROJECT_ID = "m1-native-replacement-probe"
const BASE_URL = "http://127.0.0.1:4096"
const SESSION_ID = /^ses_[0-9a-f]{64}$/
const MESSAGE_ID = /^msg_[0-9a-f]{64}$/

export type GuardedRequest = (spec: {
  method: string
  path: string
  body?: unknown
}) => Promise<unknown>

export type GuardedPortContext = {
  request: GuardedRequest
  sessionIDs: string[]
  profileDir: string
  phase: string
}

export type EntryCallbacks = {
  probe: (context: GuardedPortContext) => Promise<unknown>
  snapshot: (context: GuardedPortContext) => Promise<unknown>
  state: () => { fixture: NativeFixture | null; result: NativeReplacementResult | null }
}

export function generateFixtureIDs(random: (size: number) => Buffer = randomBytes): FixtureIDs {
  const hex = () => random(32).toString("hex")
  const ids: FixtureIDs = {
    oldRootID: `ses_${hex()}`,
    candidateID: `ses_${hex()}`,
    oldMessageIDs: [`msg_${hex()}`, `msg_${hex()}`],
    candidateMessageIDs: [`msg_${hex()}`, `msg_${hex()}`, `msg_${hex()}`],
  }
  const all = [
    ids.oldRootID,
    ids.candidateID,
    ...ids.oldMessageIDs,
    ...ids.candidateMessageIDs,
  ]
  if (
    !SESSION_ID.test(ids.oldRootID) ||
    !SESSION_ID.test(ids.candidateID) ||
    !ids.oldMessageIDs.every((id) => MESSAGE_ID.test(id)) ||
    !ids.candidateMessageIDs.every((id) => MESSAGE_ID.test(id))
  ) {
    throw new LifecycleError("E_CONFIG")
  }
  if (new Set(all).size !== all.length) throw new LifecycleError("E_CONFIG")
  return ids
}

export function buildOldImportPayload(fixture: NativeFixture): NativeImportPayload {
  const times = fixture.oldMessages.map((message) => message.time.created)
  const updated = Math.max(...times)
  const created = Math.min(...times) - 1000
  return {
    info: {
      id: fixture.oldRootID,
      projectID: fixture.projectID,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, updated, idle: updated },
      title: OLD_ROOT_TITLE,
      location: { directory: fixture.directory },
    },
    messages: fixture.oldMessages.map(toImportMessage),
    location: { directory: fixture.directory },
  }
}

function toImportMessage(message: SyntheticMessage): SyntheticMessage {
  if (message.type === "user") {
    return {
      id: message.id,
      type: "user",
      text: message.text!,
      time: { created: message.time.created },
    }
  }
  return {
    id: message.id,
    type: "assistant",
    agent: "probe",
    model: { id: "probe-model", providerID: "probe-provider" },
    time: { created: message.time.created, completed: message.time.completed! },
    content: [{ type: "text", text: message.content![0]!.text }],
  }
}

function bridgeRequest(port: GuardedRequest) {
  return async (input: {
    url: string
    method: "GET" | "POST" | "PATCH"
    headers: Record<string, string>
    body?: string
  }) => {
    const url = new URL(input.url)
    const path = `${url.pathname}${url.search}`
    try {
      const data = await port({
        method: input.method,
        path,
        ...(input.body === undefined ? {} : { body: JSON.parse(input.body) }),
      })
      return {
        status: 200,
        body: data === null || data === undefined ? "" : JSON.stringify(data),
      }
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "E_NOT_FOUND") {
        throw new NotFoundError("http-probe")
      }
      throw error
    }
  }
}

function createAdapter(
  port: GuardedRequest,
  fixture: NativeFixture,
  onImportResponse?: (body: unknown) => void,
) {
  const request = bridgeRequest(port)
  return createHttpProbeAdapter({
    baseUrl: BASE_URL,
    request: async (input) => {
      const response = await request(input)
      if (input.method === "POST" && onImportResponse) {
        try { onImportResponse(JSON.parse(response.body)) } catch {}
      }
      return response
    },
    paths: {
      importSession: "/api/experimental/session/import",
      session: (sessionID) => `/api/session/${sessionID}`,
      messages: (sessionID) => `/api/session/${sessionID}/message?order=asc`,
      sessions: ({ archived }) =>
        archived === undefined ? "/api/session" : `/api/session?archived=${archived}`,
      updateSession: (sessionID) => `/api/session/${sessionID}`,
    },
  })
}

const CANONICAL_PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/

function isCanonicalProjectID(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_PROJECT_ID.test(value)
}

export function createEntryCallbacks(input: {
  ids: FixtureIDs
  projectID?: string
  rearchive?: boolean
}): EntryCallbacks {
  const projectID = input.projectID ?? PROJECT_ID
  const expectedArchived = input.rearchive === true
  let fixture: NativeFixture | null = null
  let result: NativeReplacementResult | null = null
  let restartManifest: RestartManifest | null = null

  const probe = async (context: GuardedPortContext) => {
    if (
      !Array.isArray(context.sessionIDs) ||
      context.sessionIDs[0] !== input.ids.oldRootID ||
      context.sessionIDs[1] !== input.ids.candidateID
    ) {
      throw new LifecycleError("E_CONFIG")
    }

    const openapi = await context.request({ method: "GET", path: "/openapi.json" })
    verifyOpenApiArchiveContract(openapi)

    fixture = createSyntheticFixture({
      directory: context.profileDir,
      projectID,
      ids: input.ids,
      now: Date.now(),
    })
    let importBody: unknown = null
    const adapter = createAdapter(context.request, fixture, (body) => { importBody = body })
    const oldPayload = buildOldImportPayload(fixture)

    // The old root must be explicitly seeded before the state machine baseline read.
    // Observed on the pinned 2.1.3 runtime: import preserves `created` exactly, but the
    // server stamps `updated` with its own import time rather than echoing the payload.
    // The import window is measured on the same Date.now clock as the readback; no
    // format-derived allowance is accepted.
    const importStartedAt = Date.now()
    const oldImport = await adapter.importSession(oldPayload)
    const importFinishedAt = Date.now()
    if (oldImport.id !== fixture.oldRootID) throw new LifecycleError("E_OLD_IMPORT")
    const oldReadback = await adapter.getSession(fixture.oldRootID)
    const oldCreated = oldReadback.time?.created
    const oldUpdated = oldReadback.time?.updated
    if (
      oldCreated !== oldPayload.info.time.created ||
      typeof oldUpdated !== "number" ||
      !Number.isFinite(oldUpdated) ||
      oldUpdated === oldPayload.info.time.updated ||
      oldUpdated < importStartedAt ||
      oldUpdated > importFinishedAt
    ) {
      throw new LifecycleError("E_OLD_TIME")
    }

    // The host owns project metadata and may replace the synthetic projectID on import.
    // Bind the canonical public projectID from the old import response (when the adapter
    // exposes it) and the first readback, requiring exact agreement before any candidate work.
    const readbackProjectID = oldReadback.projectID
    if (!isCanonicalProjectID(readbackProjectID)) throw new LifecycleError("E_PROJECT_ID")
    const importResponse = isRecord(importBody) && isRecord(importBody.data) ? importBody.data : null
    const importProjectID = importResponse?.projectID
    if (!isCanonicalProjectID(importProjectID) || importProjectID !== readbackProjectID) {
      throw new LifecycleError("E_PROJECT_ID")
    }
    const canonicalFixture: NativeFixture = { ...fixture, projectID: readbackProjectID }
    fixture = canonicalFixture

    result = await runNativeReplacement(adapter, canonicalFixture, { rearchive: expectedArchived })
    if (result.outcome === "api-verified") {
      const parsed = parseRestartManifest(JSON.stringify(createRestartManifest(result)))
      if (!parsed.ok) throw new LifecycleError("E_MANIFEST")
      restartManifest = parsed.manifest
    }
    return { ...sanitizeProbeResult(result), restartManifestReady: restartManifest !== null }
  }

  const snapshot = async (context: GuardedPortContext) => {
    if (!fixture || !result || result.outcome !== "api-verified" || !restartManifest) {
      return { status: "failed", step: "precondition", errorCategory: "E_SNAPSHOT_NOT_READY", steps: [] }
    }
    const adapter = createAdapter(context.request, fixture)
    const steps: Array<Record<string, unknown>> = []
    const category = (error: unknown) => {
      if (isRecord(error) && typeof error.code === "string") {
        return error.code === "not-found" ? "E_NOT_FOUND" : error.code
      }
      if (isRecord(error) && error.name === "NotFoundError") return "E_NOT_FOUND"
      return "E_SNAPSHOT_READ"
    }
    const readStep = async (
      step: string,
      run: () => Promise<unknown>,
      meta: (value: any) => Record<string, unknown>,
    ) => {
      try {
        const value = await run()
        steps.push({ step, status: "ok", ...meta(value) })
        return { ok: true as const, value }
      } catch (error) {
        const errorCategory = category(error)
        steps.push({ step, status: "failed", errorCategory })
        return { ok: false as const, errorCategory }
      }
    }
    const timeFields = (session: any) => ({
      idPresent: typeof session?.id === "string",
      createdFinite: Number.isFinite(session?.time?.created),
      updatedFinite: Number.isFinite(session?.time?.updated),
      archivedNumeric: Number.isFinite(session?.time?.archived),
    })

    const oldInfo = await readStep("old-info", () => adapter.getSession(fixture!.oldRootID), timeFields)
    if (!oldInfo.ok) return { status: "failed", step: "old-info", errorCategory: oldInfo.errorCategory, steps }
    const newInfo = await readStep("new-info", () => adapter.getSession(fixture!.candidateID), timeFields)
    if (!newInfo.ok) return { status: "failed", step: "new-info", errorCategory: newInfo.errorCategory, steps }
    const oldMessages = await readStep("old-messages", () => adapter.listMessages(fixture!.oldRootID), (value) => ({ count: value.length }))
    if (!oldMessages.ok) return { status: "failed", step: "old-messages", errorCategory: oldMessages.errorCategory, steps }
    const candidateMessages = await readStep("new-messages", () => adapter.listMessages(fixture!.candidateID), (value) => ({ count: value.length }))
    if (!candidateMessages.ok) return { status: "failed", step: "new-messages", errorCategory: candidateMessages.errorCategory, steps }
    const active = await readStep("active-list", () => adapter.listSessions({ directory: fixture!.directory, archived: false }), (value) => ({ count: value.length }))
    if (!active.ok) return { status: "failed", step: "active-list", errorCategory: active.errorCategory, steps }
    const archived = await readStep("archived-list", () => adapter.listSessions({ directory: fixture!.directory, archived: true }), (value) => ({ count: value.length }))
    if (!archived.ok) return { status: "failed", step: "archived-list", errorCategory: archived.errorCategory, steps }

    const oldRoot = oldInfo.value
    const candidate = newInfo.value
    const oldRootMessages = oldMessages.value
    const newMessages = candidateMessages.value
    const activeList = active.value
    const archivedList = archived.value
    const validation = validateRestartReadback(
      { oldRoot, candidate, oldMessages: oldRootMessages, candidateMessages: newMessages },
      fixture,
      expectedArchived,
    )
    const exactIDs =
      sameOrderedIDs(oldRootMessages, fixture.oldMessages) &&
      sameOrderedIDs(newMessages, fixture.candidateMessages)
    const distinctTail =
      newMessages.length === 3 &&
      newMessages[2]?.type === "user" &&
      newMessages[2]?.text === SYNTHETIC_TAIL_TEXT
    const oldArchive = archiveState(oldRoot)
    const candidateArchive = archiveState(candidate)
    const expectedState = expectedArchived ? "archived" : "active"
    const activeOld = activeList.some((session) => session.id === fixture!.oldRootID)
    const activeCandidate = activeList.some((session) => session.id === fixture!.candidateID)
    const archivedOld = archivedList.some((session) => session.id === fixture!.oldRootID)
    const oldPlacement = expectedArchived ? !activeOld && archivedOld : activeOld && !archivedOld
    const listFiltering = oldPlacement && activeCandidate ? "observed" : "unverified"
    const expectedActiveCount = expectedArchived ? 1 : 2
    const expectedArchivedCount = expectedArchived ? 1 : 0
    const countsOk = activeList.length === expectedActiveCount && archivedList.length === expectedArchivedCount
    const ok =
      validation.ok &&
      exactIDs &&
      distinctTail &&
      oldArchive === expectedState &&
      candidateArchive === "active" &&
      listFiltering === "observed" &&
      countsOk

    return {
      status: ok ? "verified" : "failed",
      reason: ok ? null : validation.ok ? "snapshot-compare-failed" : validation.code,
      ...(ok ? {} : { step: "validation", errorCategory: "E_SNAPSHOT_VALIDATION" }),
      steps,
      manifestVersion: restartManifest.version,
      oldArchive,
      candidateArchive,
      oldMessageCount: oldRootMessages.length,
      candidateMessageCount: newMessages.length,
      distinctTail,
      exactIDs,
      activeCount: activeList.length,
      archivedCount: archivedList.length,
      listFiltering,
      nativeUi: "not-observed",
      ordinaryContinuation: "not-tested",
      permissionsForms: "not-tested",
    }
  }

  return {
    probe,
    snapshot,
    state: () => ({ fixture, result }),
  }
}

const KNOWN_BLOCKERS = new Set([
  "old-root-unreadable",
  "old-root-already-archived",
  "old-root-archive-state-unknown",
  "old-root-baseline-mismatch",
  "candidate-id-present",
  "candidate-id-lookup-ambiguous",
  "candidate-archive-state-unknown",
  "archive-transport-unsupported",
  "archive-request-error-observed-active",
  "archive-request-error-observed-archived",
  "archive-readback-unknown",
  "archive-readback-not-verified",
  "unarchive-transport-unsupported",
  "unarchive-readback-not-verified",
  "rearchive-transport-unsupported",
])
const LIST_FILTER_VALUES = new Set([
  "not-tested",
  "observed",
  "not-filtering",
  "unverified",
  "unsupported",
  "error",
])

export function sanitizeBlocker(value: unknown): string {
  if (typeof value !== "string") return "unknown"
  if (KNOWN_BLOCKERS.has(value)) return value
  const prefix = "list-archived-filter:"
  if (value.startsWith(prefix)) {
    const suffix = value.slice(prefix.length)
    if (LIST_FILTER_VALUES.has(suffix)) return `${prefix}${suffix}`
  }
  return "unknown"
}

export function sanitizeProbeResult(result: NativeReplacementResult) {
  return {
    outcome: result.outcome,
    blocker: sanitizeBlocker(result.blocker),
    ...(result.baselineDiagnostic ? { baseline: result.baselineDiagnostic } : {}),
    phases: result.completedPhases,
    candidateLookup: result.api.candidateLookup,
    oldArchiveBefore: result.api.oldArchiveBefore,
    candidateArchive: result.api.candidateArchive,
    archiveRequest: result.api.archiveRequest,
    archiveObserved: result.api.archiveObserved,
    archiveReadback: result.api.archiveReadback,
    listFiltering: result.api.listFiltering,
    unarchiveReadback: result.api.unarchiveReadback,
    oldContentRetained: result.api.oldContentRetained,
    candidateRetained: result.api.candidateRetained,
    restartReadback: result.api.restartReadback,
    counts: result.fixture.expected,
    native: result.native,
    ordinaryContinuation: result.safety.ordinaryContinuation,
    permissionsForms: result.safety.permissionsForms,
    concurrency: result.safety.concurrency,
  }
}

function sameOrderedIDs(actual: readonly AdapterMessage[], expected: readonly SyntheticMessage[]): boolean {
  return actual.length === expected.length && actual.every((message, index) => message.id === expected[index]?.id)
}

export function finalizeRunResult(
  probe: unknown,
  snapshot: unknown,
  cleanup: unknown,
  probeFailure: unknown = null,
  snapshotReason: unknown = null,
) {
  const probeOutcome = isRecord(probe) && typeof probe.outcome === "string" ? probe.outcome : null
  const snapshotStatus = isRecord(snapshot) && typeof snapshot.status === "string" ? snapshot.status : null
  const failedProbe = isRecord(probeFailure) && typeof probeFailure.code === "string"
  const failedSnapshot = isRecord(snapshot) && typeof snapshot.errorCategory === "string"
  const ok = !failedProbe && probeOutcome === "api-verified" && snapshotStatus === "verified"
  const failure = ok
    ? null
    : failedProbe
      ? String(probeFailure.code)
      : failedSnapshot
        ? String((snapshot as Record<string, unknown>).errorCategory)
        : typeof snapshotReason === "string"
          ? "E_VERIFY"
          : "E_VERIFY"
  return {
    status: ok ? "ok" : "failed",
    failure,
    probe: probe ?? probeFailure,
    probeFailure,
    snapshot,
    ...(typeof snapshotReason === "string" ? { snapshotReason } : {}),
    cleanup,
  }
}

export function exitCodeForResult(result: unknown): number {
  return isRecord(result) && result.status === "ok" ? 0 : 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function runEntry() {
  const ids = generateFixtureIDs()
  const callbacks = createEntryCallbacks({ ids })
  try {
    const run = await withIsolatedHost(
      {
        sessionIDs: [ids.oldRootID, ids.candidateID],
        binaryPath: "/usr/local/bin/opencode",
        profileBase: "/run/sessionport",
        snapshot: callbacks.snapshot,
      },
      callbacks.probe,
    )
    return finalizeRunResult(run.probe, run.snapshot, run.cleanup, run.probeFailure, run.snapshotReason)
  } catch (error) {
    if (error instanceof LifecycleError) {
      const facts = "facts" in error && isRecord((error as { facts?: unknown }).facts)
        ? (error as { facts: Record<string, unknown> }).facts
        : {}
      return {
        ...facts,
        status: error.code === "E_UNSUPPORTED" ? "unsupported" : "error",
        code: error.code,
      }
    }
    return { status: "error", code: "E_INTERNAL" }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runEntry()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = exitCodeForResult(result)
}
