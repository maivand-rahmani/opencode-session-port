// Bounded native-replacement TUI probe.
//
// This entry imports two fresh parentless synthetic roots once, verifies their
// public readback and ordered histories, then navigates to the candidate root
// and leaves that route visible for the runner's observation window. It never
// submits input, calls a generation endpoint, reads credentials, or archives.
//
// The optional testable core below takes a narrow public-context shape so it
// can run against a fake host in focused tests. The default export is the
// ordinary TUI plugin definition.

import { randomBytes } from "node:crypto"
import { existsSync, lstatSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, onCleanup } from "solid-js"
import {
  CANDIDATE_MESSAGE_TEXT,
  CANDIDATE_TITLE,
  OLD_MESSAGE_TEXT,
  OLD_ROOT_TITLE,
  SYNTHETIC_TAIL_TEXT,
  buildImportPayload,
  createSyntheticFixture,
  hasExactKeys,
  isRecord,
  validateFixture,
  type FixtureIDs,
  type NativeFixture,
  type NativeImportPayload,
  type SyntheticMessage,
} from "../fixtures"

const PROBE_NAME = "sessionport-native-replacement-tui"
const PLUGIN_ID = "sessionport-native-replacement-tui-probe"
const SYNTHETIC_PROJECT_ID = "native-replacement-tui-probe"
const RESULT_LIMIT_BYTES = 4 * 1024
const ROUTE_WAIT_MS = 500
const CONTEXT_WAIT_MS = 1000
const POLL_MS = 25
const CANONICAL_PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/

export type NativeProbeStage =
  | "preflight"
  | "import-old"
  | "import-candidate"
  | "verify-history"
  | "navigate"
  | "complete"
  | "failed"

export type NativeProbeReason =
  | "none"
  | "isolation"
  | "capability"
  | "import"
  | "history"
  | "navigation"
  | "internal"

/** Exact shared result shape. No IDs, content, paths, or arbitrary strings. */
export type NativeProbeResult = {
  probe: typeof PROBE_NAME
  version: 1
  ok: boolean
  stage: NativeProbeStage
  reason: NativeProbeReason
  importedCount: 0 | 1 | 2
  oldMessageCount: number
  candidateMessageCount: number
  nativeRouteObserved: boolean
  parentlessVerified: boolean
  archiveNotTested: true
  composerNotTested: true
  pickerNotTested: true
}

export type ProbeEnv = Record<string, string | undefined>

export type NativeProbeContext = {
  readonly location?: {
    /** Raw requested location/cwd. Informational only; not the project guard. */
    readonly directory?: string
    /** Resolved project root supplied by the host location readback. */
    readonly project?: {
      readonly directory?: string
      readonly canonical?: string
    }
  }
  readonly client: {
    readonly session: {
      import(input: NativeImportPayload): Promise<unknown>
      get(input: { readonly sessionID: string }): Promise<unknown>
      /**
       * Runtime 2.1.1 host client may expose a wider update surface than the pinned
       * 2.0.22 type. This narrow structural adapter is verified by canonical GET,
       * never by the call result or a success assumption.
       */
      update?(input: { readonly sessionID: string; readonly archived: boolean }): Promise<unknown>
    }
    readonly message: {
      list(input: {
        readonly sessionID: string
        readonly limit: number
        readonly order: "asc"
      }): Promise<unknown>
    }
  }
  readonly data: {
    readonly session: {
      sync(sessionID: string): Promise<void>
      invalidate?(sessionID: string): void
      readonly message: {
        sync(sessionID: string): Promise<void>
        invalidate?(sessionID: string): void
      }
    }
  }
  readonly ui: {
    readonly router: {
      navigate(destination: { readonly type: "session"; readonly sessionID: string }): void
      current?(): unknown
    }
  }
}

export type NativeProbeOutcome = {
  result: NativeProbeResult
  forbidden: readonly string[]
}

const ARCHIVE_PROBE_NAME = "sessionport-native-replacement-tui-archive"
const RECOVERY_DELAY_MS = 60_000

export type ArchiveStage =
  | "preflight"
  | "import-old"
  | "import-candidate"
  | "verify-history"
  | "archive"
  | "verify-archive"
  | "navigate"
  | "recovery"
  | "verify-recovery"
  | "complete"
  | "failed"

export type ArchiveReason =
  | "none"
  | "isolation"
  | "capability"
  | "import"
  | "history"
  | "archive"
  | "navigation"
  | "recovery"
  | "internal"

export type ArchiveCall = "not-attempted" | "accepted" | "error" | "unsupported"
export type ArchiveReadback = "active" | "archived" | "unknown" | "not-read"

export type ArchiveProbeResult = {
  probe: typeof ARCHIVE_PROBE_NAME
  version: 2
  ok: boolean
  stage: ArchiveStage
  reason: ArchiveReason
  importedCount: 0 | 1 | 2
  oldMessageCount: number
  candidateMessageCount: number
  nativeRouteObserved: boolean
  parentlessVerified: boolean
  archiveNotTested: boolean
  composerNotTested: true
  pickerNotTested: true
  archiveCall: ArchiveCall
  archiveReadback: ArchiveReadback
  recoveryReadback: ArchiveReadback
  recoveryVerified: boolean
  mutationTargetOldOnly: true
}

export type ArchiveTiming = {
  readonly schedule?: (callback: () => void, delayMs: number) => unknown
  readonly cancel?: (handle: unknown) => void
  readonly recoveryDelayMs?: number
}

export type ArchiveProbeOutcome = {
  result: ArchiveProbeResult
  forbidden: readonly string[]
  cancelRecovery: () => void
  recoverNow: () => Promise<void>
}

const ARCHIVE_RESULT_KEYS = [
  "probe",
  "version",
  "ok",
  "stage",
  "reason",
  "importedCount",
  "oldMessageCount",
  "candidateMessageCount",
  "nativeRouteObserved",
  "parentlessVerified",
  "archiveNotTested",
  "composerNotTested",
  "pickerNotTested",
  "archiveCall",
  "archiveReadback",
  "recoveryReadback",
  "recoveryVerified",
  "mutationTargetOldOnly",
] as const

const ARCHIVE_STAGES: readonly ArchiveStage[] = [
  "preflight",
  "import-old",
  "import-candidate",
  "verify-history",
  "archive",
  "verify-archive",
  "navigate",
  "recovery",
  "verify-recovery",
  "complete",
  "failed",
]

const ARCHIVE_REASONS: readonly ArchiveReason[] = [
  "none",
  "isolation",
  "capability",
  "import",
  "history",
  "archive",
  "navigation",
  "recovery",
  "internal",
]

const ARCHIVE_CALLS: readonly ArchiveCall[] = ["not-attempted", "accepted", "error", "unsupported"]
const ARCHIVE_READBACKS: readonly ArchiveReadback[] = ["active", "archived", "unknown", "not-read"]

export function createArchiveProbeResult(): ArchiveProbeResult {
  return {
    probe: ARCHIVE_PROBE_NAME,
    version: 2,
    ok: false,
    stage: "preflight",
    reason: "none",
    importedCount: 0,
    oldMessageCount: 0,
    candidateMessageCount: 0,
    nativeRouteObserved: false,
    parentlessVerified: false,
    archiveNotTested: true,
    composerNotTested: true,
    pickerNotTested: true,
    archiveCall: "not-attempted",
    archiveReadback: "not-read",
    recoveryReadback: "not-read",
    recoveryVerified: false,
    mutationTargetOldOnly: true,
  }
}


const RESULT_KEYS = [
  "probe",
  "version",
  "ok",
  "stage",
  "reason",
  "importedCount",
  "oldMessageCount",
  "candidateMessageCount",
  "nativeRouteObserved",
  "parentlessVerified",
  "archiveNotTested",
  "composerNotTested",
  "pickerNotTested",
] as const

const STAGES: readonly NativeProbeStage[] = [
  "preflight",
  "import-old",
  "import-candidate",
  "verify-history",
  "navigate",
  "complete",
  "failed",
]

const REASONS: readonly NativeProbeReason[] = [
  "none",
  "isolation",
  "capability",
  "import",
  "history",
  "navigation",
  "internal",
]

export function createProbeResult(): NativeProbeResult {
  return {
    probe: PROBE_NAME,
    version: 1,
    ok: false,
    stage: "preflight",
    reason: "none",
    importedCount: 0,
    oldMessageCount: 0,
    candidateMessageCount: 0,
    nativeRouteObserved: false,
    parentlessVerified: false,
    archiveNotTested: true,
    composerNotTested: true,
    pickerNotTested: true,
  }
}

export function createProbeFixtureIDs(random: (size: number) => Buffer = randomBytes): FixtureIDs {
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
  if (new Set(all).size !== all.length) throw new Error("fixture-id-collision")
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

export async function runNativeTuiProbe(
  context: NativeProbeContext,
  env: ProbeEnv,
): Promise<NativeProbeOutcome> {
  const result = createProbeResult()
  const forbidden: string[] = []
  let finished = false

  const finish = (stage: NativeProbeStage, reason: NativeProbeReason): NativeProbeOutcome => {
    finished = true
    result.stage = stage
    result.reason = reason
    result.ok =
      stage === "complete" &&
      reason === "none" &&
      result.importedCount === 2 &&
      result.oldMessageCount === 2 &&
      result.candidateMessageCount === 3 &&
      result.parentlessVerified &&
      result.nativeRouteObserved
    return { result, forbidden }
  }

  try {
    const isolation = await resolveIsolation(context, env)
    if (!isolation) return finish("preflight", "isolation")
    forbidden.push(isolation.root, isolation.project, isolation.resultPath, isolation.resultsDir)
    if (context.location?.directory) forbidden.push(context.location.directory)

    if (!hasCapability(context)) return finish("preflight", "capability")

    const ids = createProbeFixtureIDs()
    forbidden.push(ids.oldRootID, ids.candidateID, ...ids.oldMessageIDs, ...ids.candidateMessageIDs)
    forbidden.push(...OLD_MESSAGE_TEXT, ...CANDIDATE_MESSAGE_TEXT, SYNTHETIC_TAIL_TEXT, OLD_ROOT_TITLE, CANDIDATE_TITLE)

    const fixture = createSyntheticFixture({
      directory: isolation.project,
      projectID: SYNTHETIC_PROJECT_ID,
      ids,
      now: Date.now(),
    })
    if (validateFixture(fixture).length > 0) return finish("failed", "internal")

    result.stage = "import-old"
    const oldPayload = buildOldImportPayload(fixture)
    const oldStarted = Date.now()
    const oldImportRaw = await callImport(context, oldPayload)
    const oldFinished = Date.now()
    if (oldImportRaw === null) return finish("import-old", "import")
    result.importedCount = 1
    const oldImport = asSessionView(oldImportRaw)
    if (!oldImport || oldImport.id !== ids.oldRootID) return finish("import-old", "import")
    if (!isCanonicalProjectID(oldImport.projectID)) return finish("import-old", "import")

    const oldReadbackRaw = await callGet(context, ids.oldRootID)
    if (oldReadbackRaw === null) return finish("import-old", "import")
    const oldReadback = asSessionView(oldReadbackRaw)
    if (!oldReadback || oldReadback.id !== ids.oldRootID) return finish("import-old", "import")
    const oldReadbackProjectID = oldReadback.projectID
    if (!isCanonicalProjectID(oldReadbackProjectID)) return finish("import-old", "import")
    if (oldReadbackProjectID !== oldImport.projectID) return finish("import-old", "import")
    const canonicalProjectID = oldReadbackProjectID

    const oldMessagesRaw = await callList(context, ids.oldRootID)
    if (oldMessagesRaw === null) return finish("import-old", "history")
    result.oldMessageCount = boundedCount(oldMessagesRaw.length, 3)
    if (!sessionMatches(oldReadback, ids.oldRootID, OLD_ROOT_TITLE, canonicalProjectID, isolation.project)) {
      return finish("import-old", "history")
    }
    if (!sessionTimeMatches(oldReadback, oldPayload, oldStarted, oldFinished)) {
      return finish("import-old", "history")
    }
    if (!messagesMatch(fixture.oldMessages, oldMessagesRaw)) {
      return finish("import-old", "history")
    }

    result.stage = "import-candidate"
    const canonicalFixture: NativeFixture = { ...fixture, projectID: canonicalProjectID }
    const candidatePayload = buildImportPayload(canonicalFixture)
    const candidateStarted = Date.now()
    const candidateImportRaw = await callImport(context, candidatePayload)
    const candidateFinished = Date.now()
    if (candidateImportRaw === null) return finish("import-candidate", "import")
    result.importedCount = 2
    const candidateImport = asSessionView(candidateImportRaw)
    if (!candidateImport || candidateImport.id !== ids.candidateID) {
      return finish("import-candidate", "import")
    }
    if (candidateImport.projectID !== canonicalProjectID) {
      return finish("import-candidate", "import")
    }

    const candidateReadbackRaw = await callGet(context, ids.candidateID)
    if (candidateReadbackRaw === null) return finish("import-candidate", "import")
    const candidateReadback = asSessionView(candidateReadbackRaw)
    if (!candidateReadback || candidateReadback.id !== ids.candidateID) {
      return finish("import-candidate", "import")
    }
    if (candidateReadback.projectID !== canonicalProjectID) {
      return finish("import-candidate", "import")
    }

    const candidateMessagesRaw = await callList(context, ids.candidateID)
    if (candidateMessagesRaw === null) return finish("import-candidate", "history")
    result.candidateMessageCount = boundedCount(candidateMessagesRaw.length, 4)
    if (
      !sessionMatches(candidateReadback, ids.candidateID, CANDIDATE_TITLE, canonicalProjectID, isolation.project)
    ) {
      return finish("import-candidate", "history")
    }
    if (!sessionTimeMatches(candidateReadback, candidatePayload, candidateStarted, candidateFinished)) {
      return finish("import-candidate", "history")
    }
    if (!messagesMatch(fixture.candidateMessages, candidateMessagesRaw)) {
      return finish("import-candidate", "history")
    }
    if (!hasDistinctTail(candidateMessagesRaw)) return finish("import-candidate", "history")

    result.stage = "verify-history"
    const oldFinalRaw = await callGet(context, ids.oldRootID)
    const candidateFinalRaw = await callGet(context, ids.candidateID)
    const oldFinalMessagesRaw = await callList(context, ids.oldRootID)
    const candidateFinalMessagesRaw = await callList(context, ids.candidateID)
    if (!oldFinalRaw || !candidateFinalRaw || !oldFinalMessagesRaw || !candidateFinalMessagesRaw) {
      return finish("verify-history", "history")
    }
    const oldFinal = asSessionView(oldFinalRaw)
    const candidateFinal = asSessionView(candidateFinalRaw)
    if (!oldFinal || !candidateFinal) return finish("verify-history", "history")
    result.oldMessageCount = boundedCount(oldFinalMessagesRaw.length, 3)
    result.candidateMessageCount = boundedCount(candidateFinalMessagesRaw.length, 4)
    result.parentlessVerified = isParentless(oldFinal) && isParentless(candidateFinal)
    if (
      !result.parentlessVerified ||
      !sessionMatches(oldFinal, ids.oldRootID, OLD_ROOT_TITLE, canonicalProjectID, isolation.project) ||
      !sessionMatches(candidateFinal, ids.candidateID, CANDIDATE_TITLE, canonicalProjectID, isolation.project) ||
      !messagesMatch(fixture.oldMessages, oldFinalMessagesRaw) ||
      !messagesMatch(fixture.candidateMessages, candidateFinalMessagesRaw)
    ) {
      return finish("verify-history", "history")
    }

    result.stage = "navigate"
    try {
      await context.data.session.sync(ids.candidateID)
      await context.data.session.message.sync(ids.candidateID)
      context.ui.router.navigate({ type: "session", sessionID: ids.candidateID })
    } catch {
      return finish("navigate", "navigation")
    }

    const current = typeof context.ui.router.current === "function" ? context.ui.router.current : undefined
    const routeWait = await waitForRoute(current, ids.candidateID)
    result.nativeRouteObserved = routeWait.observed
    if (!routeWait.observed) {
      return finish("navigate", routeWait.currentAvailable ? "navigation" : "capability")
    }

    return finish("complete", "none")
  } catch {
    if (!finished) return finish("failed", "internal")
    return { result, forbidden }
  }
}

function archiveComplete(result: ArchiveProbeResult): boolean {
  return (
    result.stage === "complete" &&
    result.reason === "none" &&
    result.importedCount === 2 &&
    result.oldMessageCount === 2 &&
    result.candidateMessageCount === 3 &&
    result.nativeRouteObserved &&
    result.parentlessVerified &&
    result.archiveReadback === "archived" &&
    result.archiveNotTested === false &&
    result.recoveryReadback === "active" &&
    result.recoveryVerified &&
    result.mutationTargetOldOnly
  )
}

function archiveState(value: unknown): ArchiveReadback {
  if (!isRecord(value) || !isRecord(value.time)) return "unknown"
  const created = value.time.created
  const updated = value.time.updated
  const archived = value.time.archived
  if (
    typeof created !== "number" ||
    !Number.isFinite(created) ||
    typeof updated !== "number" ||
    !Number.isFinite(updated)
  ) {
    return "unknown"
  }
  if (archived === undefined) return "active"
  if (typeof archived === "number" && Number.isFinite(archived)) return "archived"
  return "unknown"
}

type ArchiveUpdate = (input: { readonly sessionID: string; readonly archived: boolean }) => Promise<unknown>

/** Narrow structural adapter for the runtime host client only; success is always GET-verified. */
function archiveUpdater(context: NativeProbeContext): ArchiveUpdate | null {
  const update = context.client.session.update
  if (typeof update !== "function") return null
  return (input) => update.call(context.client.session, input)
}

async function syncArchiveCaches(context: NativeProbeContext, sessionID: string): Promise<void> {
  try {
    context.data.session.invalidate?.(sessionID)
  } catch {
    // Cache invalidation is best-effort; route observation is the actual check.
  }
  try {
    await context.data.session.sync(sessionID)
  } catch {
    // Refresh failure does not change the canonical GET evidence.
  }
  try {
    context.data.session.message.invalidate?.(sessionID)
  } catch {
    // Cache invalidation is best-effort.
  }
  try {
    await context.data.session.message.sync(sessionID)
  } catch {
    // Refresh failure does not change the canonical GET evidence.
  }
}

export async function runArchiveTuiProbe(
  context: NativeProbeContext,
  env: ProbeEnv,
  timing: ArchiveTiming = {},
  onScheduled?: (cancel: () => void) => void,
): Promise<ArchiveProbeOutcome> {
  const result = createArchiveProbeResult()
  const forbidden: string[] = []
  let fixture: NativeFixture | null = null
  let ids: FixtureIDs | null = null
  let canonicalProjectID = ""
  let updater: ArchiveUpdate | null = null
  let recoveryStarted = false
  let recoveryHandle: unknown
  const schedule = timing.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const cancel = timing.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const noopCancel = () => undefined
  const noopRecover = async () => undefined

  const finish = (stage: ArchiveStage, reason: ArchiveReason): ArchiveProbeOutcome => {
    result.stage = stage
    result.reason = reason
    result.ok = archiveComplete(result)
    return { result, forbidden, cancelRecovery: noopCancel, recoverNow: noopRecover }
  }

  try {
    const isolation = await resolveIsolation(context, env)
    if (!isolation) return finish("preflight", "isolation")
    forbidden.push(isolation.root, isolation.project, isolation.resultPath, isolation.resultsDir)
    if (context.location?.directory) forbidden.push(context.location.directory)

    if (!hasCapability(context)) return finish("preflight", "capability")

    ids = createProbeFixtureIDs()
    forbidden.push(ids.oldRootID, ids.candidateID, ...ids.oldMessageIDs, ...ids.candidateMessageIDs)
    forbidden.push(...OLD_MESSAGE_TEXT, ...CANDIDATE_MESSAGE_TEXT, SYNTHETIC_TAIL_TEXT, OLD_ROOT_TITLE, CANDIDATE_TITLE)

    fixture = createSyntheticFixture({
      directory: isolation.project,
      projectID: SYNTHETIC_PROJECT_ID,
      ids,
      now: Date.now(),
    })
    if (validateFixture(fixture).length > 0) return finish("failed", "internal")

    result.stage = "import-old"
    const oldPayload = buildOldImportPayload(fixture)
    const oldStarted = Date.now()
    const oldImportRaw = await callImport(context, oldPayload)
    const oldFinished = Date.now()
    if (oldImportRaw === null) return finish("import-old", "import")
    result.importedCount = 1
    const oldImport = asSessionView(oldImportRaw)
    if (!oldImport || oldImport.id !== ids.oldRootID) return finish("import-old", "import")
    if (!isCanonicalProjectID(oldImport.projectID)) return finish("import-old", "import")

    const oldReadbackRaw = await callGet(context, ids.oldRootID)
    if (oldReadbackRaw === null) return finish("import-old", "import")
    const oldReadback = asSessionView(oldReadbackRaw)
    if (!oldReadback || oldReadback.id !== ids.oldRootID) return finish("import-old", "import")
    const oldReadbackProjectID = oldReadback.projectID
    if (!isCanonicalProjectID(oldReadbackProjectID)) return finish("import-old", "import")
    if (oldReadbackProjectID !== oldImport.projectID) return finish("import-old", "import")
    canonicalProjectID = oldReadbackProjectID

    const oldMessagesRaw = await callList(context, ids.oldRootID)
    if (oldMessagesRaw === null) return finish("import-old", "history")
    result.oldMessageCount = boundedCount(oldMessagesRaw.length, 3)
    if (!sessionMatches(oldReadback, ids.oldRootID, OLD_ROOT_TITLE, canonicalProjectID, isolation.project)) {
      return finish("import-old", "history")
    }
    if (!sessionTimeMatches(oldReadback, oldPayload, oldStarted, oldFinished)) {
      return finish("import-old", "history")
    }
    if (!messagesMatch(fixture.oldMessages, oldMessagesRaw)) return finish("import-old", "history")

    result.stage = "import-candidate"
    const canonicalFixture: NativeFixture = { ...fixture, projectID: canonicalProjectID }
    const candidatePayload = buildImportPayload(canonicalFixture)
    const candidateStarted = Date.now()
    const candidateImportRaw = await callImport(context, candidatePayload)
    const candidateFinished = Date.now()
    if (candidateImportRaw === null) return finish("import-candidate", "import")
    result.importedCount = 2
    const candidateImport = asSessionView(candidateImportRaw)
    if (!candidateImport || candidateImport.id !== ids.candidateID) return finish("import-candidate", "import")
    if (candidateImport.projectID !== canonicalProjectID) return finish("import-candidate", "import")

    const candidateReadbackRaw = await callGet(context, ids.candidateID)
    if (candidateReadbackRaw === null) return finish("import-candidate", "import")
    const candidateReadback = asSessionView(candidateReadbackRaw)
    if (!candidateReadback || candidateReadback.id !== ids.candidateID) {
      return finish("import-candidate", "import")
    }
    if (candidateReadback.projectID !== canonicalProjectID) return finish("import-candidate", "import")

    const candidateMessagesRaw = await callList(context, ids.candidateID)
    if (candidateMessagesRaw === null) return finish("import-candidate", "history")
    result.candidateMessageCount = boundedCount(candidateMessagesRaw.length, 4)
    if (!sessionMatches(candidateReadback, ids.candidateID, CANDIDATE_TITLE, canonicalProjectID, isolation.project)) {
      return finish("import-candidate", "history")
    }
    if (!sessionTimeMatches(candidateReadback, candidatePayload, candidateStarted, candidateFinished)) {
      return finish("import-candidate", "history")
    }
    if (!messagesMatch(fixture.candidateMessages, candidateMessagesRaw)) {
      return finish("import-candidate", "history")
    }
    if (!hasDistinctTail(candidateMessagesRaw)) return finish("import-candidate", "history")

    result.stage = "verify-history"
    const oldFinalRaw = await callGet(context, ids.oldRootID)
    const candidateFinalRaw = await callGet(context, ids.candidateID)
    const oldFinalMessagesRaw = await callList(context, ids.oldRootID)
    const candidateFinalMessagesRaw = await callList(context, ids.candidateID)
    if (!oldFinalRaw || !candidateFinalRaw || !oldFinalMessagesRaw || !candidateFinalMessagesRaw) {
      return finish("verify-history", "history")
    }
    const oldFinal = asSessionView(oldFinalRaw)
    const candidateFinal = asSessionView(candidateFinalRaw)
    if (!oldFinal || !candidateFinal) return finish("verify-history", "history")
    result.oldMessageCount = boundedCount(oldFinalMessagesRaw.length, 3)
    result.candidateMessageCount = boundedCount(candidateFinalMessagesRaw.length, 4)
    result.parentlessVerified = isParentless(oldFinal) && isParentless(candidateFinal)
    if (
      !result.parentlessVerified ||
      !sessionMatches(oldFinal, ids.oldRootID, OLD_ROOT_TITLE, canonicalProjectID, isolation.project) ||
      !sessionMatches(candidateFinal, ids.candidateID, CANDIDATE_TITLE, canonicalProjectID, isolation.project) ||
      !messagesMatch(fixture.oldMessages, oldFinalMessagesRaw) ||
      !messagesMatch(fixture.candidateMessages, candidateFinalMessagesRaw)
    ) {
      return finish("verify-history", "history")
    }

    result.stage = "archive"
    const initialState = archiveState(oldFinalRaw)
    result.archiveReadback = initialState
    if (initialState !== "active") {
      result.archiveCall = "not-attempted"
      result.archiveNotTested = true
      return finish("archive", "archive")
    }
    updater = archiveUpdater(context)
    if (!updater) {
      result.archiveCall = "unsupported"
      result.archiveNotTested = true
      return finish("archive", "capability")
    }

    result.archiveNotTested = false
    try {
      await updater({ sessionID: ids.oldRootID, archived: true })
      result.archiveCall = "accepted"
    } catch {
      result.archiveCall = "error"
    }

    result.stage = "verify-archive"
    const archivedRaw = await callGet(context, ids.oldRootID)
    result.archiveReadback = archivedRaw === null ? "unknown" : archiveState(archivedRaw)
    if (result.archiveReadback !== "archived") return finish("verify-archive", "archive")

    await syncArchiveCaches(context, ids.oldRootID)
    await syncArchiveCaches(context, ids.candidateID)

    result.stage = "navigate"
    try {
      context.ui.router.navigate({ type: "session", sessionID: ids.candidateID })
    } catch {
      result.reason = "navigation"
    }
    const current = typeof context.ui.router.current === "function" ? context.ui.router.current : undefined
    const routeWait = await waitForRoute(current, ids.candidateID)
    result.nativeRouteObserved = routeWait.observed
    result.reason = routeWait.observed ? "none" : routeWait.currentAvailable ? "navigation" : "capability"
    result.ok = false

    const recoverNow = async () => {
      if (recoveryStarted) return
      recoveryStarted = true
      if (!ids || !fixture || !updater || canonicalProjectID.length === 0) return
      try {
        result.stage = "recovery"
        try {
          await updater({ sessionID: ids.oldRootID, archived: false })
        } catch {
          // No retry: the canonical GET below decides whether recovery applied.
        }
        result.stage = "verify-recovery"
        const oldRaw = await callGet(context, ids.oldRootID)
        const oldMessages = await callList(context, ids.oldRootID)
        result.recoveryReadback = oldRaw === null ? "unknown" : archiveState(oldRaw)
        const oldSession = oldRaw === null ? null : asSessionView(oldRaw)
        result.recoveryVerified = Boolean(
          result.recoveryReadback === "active" &&
            oldSession &&
            oldMessages &&
            sessionMatches(oldSession, ids.oldRootID, OLD_ROOT_TITLE, canonicalProjectID, fixture.directory) &&
            messagesMatch(fixture.oldMessages, oldMessages),
        )
        if (result.recoveryVerified) {
          await syncArchiveCaches(context, ids.oldRootID)
          await syncArchiveCaches(context, ids.candidateID)
          if (result.nativeRouteObserved) {
            result.stage = "complete"
            result.reason = "none"
          } else if (result.reason === "none") {
            result.reason = "navigation"
          }
          result.ok = archiveComplete(result)
        } else {
          result.stage = "verify-recovery"
          result.reason = "recovery"
          result.ok = false
        }
        writeArchiveProbeResult(env, result, forbidden)
      } catch {
        result.stage = "verify-recovery"
        result.reason = "recovery"
        result.recoveryReadback = "unknown"
        result.recoveryVerified = false
        result.ok = false
        writeArchiveProbeResult(env, result, forbidden)
      }
    }

    const delay = timing.recoveryDelayMs ?? RECOVERY_DELAY_MS
    recoveryHandle = schedule(() => {
      void recoverNow()
    }, delay)
    const cancelRecovery = () => {
      if (recoveryHandle === undefined) return
      cancel(recoveryHandle)
      recoveryHandle = undefined
    }
    onScheduled?.(cancelRecovery)

    return { result, forbidden, cancelRecovery, recoverNow }
  } catch {
    return finish("failed", "internal")
  }
}

function checkIsolation(
  context: NativeProbeContext,
  env: ProbeEnv,
): { root: string; project: string; resultPath: string; resultsDir: string } | null {
  const rawRoot = env.SP_PROBE_ROOT ?? ""
  const rawProject = env.SP_PROBE_PROJECT ?? ""
  const rawResult = env.SP_PROBE_RESULT ?? ""
  if (!rawRoot || !rawProject || !rawResult) return null
  if (!path.isAbsolute(rawRoot) || !path.isAbsolute(rawProject) || !path.isAbsolute(rawResult)) return null

  const root = path.resolve(rawRoot)
  const project = path.resolve(rawProject)
  const resultPath = path.resolve(rawResult)
  const resultsDir = path.join(root, "results")

  if (!under(project, root) || !under(resultPath, root) || !under(resultPath, resultsDir)) return null
  if (!samePath(path.dirname(resultPath), resultsDir)) return null
  const contextProject = contextProjectPath(context)
  if (!contextProject) return null
  const canonicalContextProject = canonicalPath(contextProject)
  if (!canonicalContextProject || !safeDirectory(canonicalContextProject)) return null
  if (!underCanonical(contextProject, project) && !underCanonical(project, contextProject)) return null
  if (!underCanonical(contextProject, root)) return null
  if (!safeDirectory(root) || !safeDirectory(project) || !safeDirectory(resultsDir)) return null
  if (!safeResultFile(resultPath)) return null

  return { root, project, resultPath, resultsDir }
}

/** Bounded wait for the host location readback to expose its resolved project root. */
async function resolveIsolation(
  context: NativeProbeContext,
  env: ProbeEnv,
): Promise<ReturnType<typeof checkIsolation>> {
  const deadline = Date.now() + CONTEXT_WAIT_MS
  let isolation = checkIsolation(context, env)
  while (!isolation && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    isolation = checkIsolation(context, env)
  }
  return isolation
}

/**
 * The host's `location.directory` is the raw requested location and may be a subroot.
 * The resolved project identity is `location.project.directory` (or `canonical`).
 * Never fall back to the raw directory; a missing project readback fails closed.
 */
function contextProjectPath(context: NativeProbeContext): string | null {
  const project = context.location?.project
  if (project && typeof project.directory === "string" && project.directory.length > 0) {
    return project.directory
  }
  if (project && typeof project.canonical === "string" && project.canonical.length > 0) {
    return project.canonical
  }
  return null
}

function canonicalPath(value: string): string | null {
  try {
    return realpathSync.native(value)
  } catch {
    try {
      return realpathSync(value)
    } catch {
      return null
    }
  }
}

function underCanonical(child: string, parent: string): boolean {
  const candidate = canonicalPath(child)
  const root = canonicalPath(parent)
  return candidate !== null && root !== null && under(candidate, root)
}

function checkWriterPaths(
  env: ProbeEnv,
): { root: string; project: string; resultPath: string; resultsDir: string } | null {
  const rawRoot = env.SP_PROBE_ROOT ?? ""
  const rawProject = env.SP_PROBE_PROJECT ?? ""
  const rawResult = env.SP_PROBE_RESULT ?? ""
  if (!rawRoot || !rawProject || !rawResult) return null
  if (!path.isAbsolute(rawRoot) || !path.isAbsolute(rawProject) || !path.isAbsolute(rawResult)) return null

  const root = path.resolve(rawRoot)
  const project = path.resolve(rawProject)
  const resultPath = path.resolve(rawResult)
  const resultsDir = path.join(root, "results")

  if (!under(project, root) || !under(resultPath, root) || !under(resultPath, resultsDir)) return null
  if (!samePath(path.dirname(resultPath), resultsDir)) return null
  if (!safeDirectory(root) || !safeDirectory(project) || !safeDirectory(resultsDir)) return null
  if (!safeResultFile(resultPath)) return null

  return { root, project, resultPath, resultsDir }
}

function safeDirectory(candidate: string): boolean {
  try {
    const info = lstatSync(candidate)
    if (info.isSymbolicLink() || !info.isDirectory()) return false
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function safeResultFile(candidate: string): boolean {
  try {
    if (!existsSync(candidate)) {
      const temporary = `${candidate}.tmp`
      if (existsSync(temporary)) return false
      return true
    }
    const info = lstatSync(candidate)
    return !info.isSymbolicLink() && info.isFile()
  } catch {
    return false
  }
}

function under(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function hasCapability(context: NativeProbeContext): boolean {
  const client = context.client as unknown
  const data = context.data as unknown
  const ui = context.ui as unknown
  if (!isRecord(client) || !isRecord(client.session) || !isRecord(client.message)) return false
  if (!isRecord(data) || !isRecord(data.session) || !isRecord(data.session.message)) return false
  if (!isRecord(ui) || !isRecord(ui.router)) return false
  return (
    typeof client.session.import === "function" &&
    typeof client.session.get === "function" &&
    typeof client.message.list === "function" &&
    typeof data.session.sync === "function" &&
    typeof data.session.message.sync === "function" &&
    typeof ui.router.navigate === "function"
  )
}

async function callImport(context: NativeProbeContext, payload: NativeImportPayload): Promise<unknown | null> {
  try {
    return await context.client.session.import(payload)
  } catch {
    return null
  }
}

async function callGet(context: NativeProbeContext, sessionID: string): Promise<unknown | null> {
  try {
    return await context.client.session.get({ sessionID })
  } catch {
    return null
  }
}

async function callList(context: NativeProbeContext, sessionID: string): Promise<unknown[] | null> {
  try {
    const response = await context.client.message.list({ sessionID, limit: 50, order: "asc" })
    if (!isRecord(response) || !Array.isArray(response.data)) return null
    return response.data
  } catch {
    return null
  }
}

type SessionView = {
  id?: unknown
  parentID?: unknown
  projectID?: unknown
  title?: unknown
  time?: { created?: unknown; updated?: unknown }
  location?: { directory?: unknown }
}

function asSessionView(value: unknown): SessionView | null {
  if (!isRecord(value)) return null
  return {
    id: value.id,
    parentID: value.parentID,
    projectID: value.projectID,
    title: value.title,
    time: isRecord(value.time)
      ? { created: value.time.created, updated: value.time.updated }
      : undefined,
    location: isRecord(value.location) ? { directory: value.location.directory } : undefined,
  }
}

function sessionMatches(
  session: SessionView,
  expectedID: string,
  title: string,
  projectID: string,
  directory: string,
): boolean {
  return (
    session.id === expectedID &&
    isParentless(session) &&
    session.title === title &&
    session.projectID === projectID &&
    sameDirectory(session.location?.directory, directory)
  )
}

function isParentless(session: SessionView): boolean {
  return !session.parentID
}

function sessionTimeMatches(
  session: SessionView,
  payload: NativeImportPayload,
  started: number,
  finished: number,
): boolean {
  const created = session.time?.created
  const updated = session.time?.updated
  return (
    created === payload.info.time.created &&
    typeof updated === "number" &&
    Number.isFinite(updated) &&
    updated !== payload.info.time.updated &&
    updated >= started &&
    updated <= finished
  )
}

function messagesMatch(expected: readonly SyntheticMessage[], observed: readonly unknown[]): boolean {
  if (expected.length !== observed.length) return false
  return expected.every((message, index) => {
    const actual = observed[index]
    if (!isRecord(actual) || actual.id !== message.id || actual.type !== message.type) return false
    if (message.type === "user") return actual.text === message.text
    const expectedText = message.content?.[0]?.text
    if (typeof expectedText !== "string") return false
    const time = actual.time
    return (
      Array.isArray(actual.content) &&
      actual.content.some((part) => isRecord(part) && part.type === "text" && part.text === expectedText) &&
      isRecord(time) &&
      typeof time.completed === "number"
    )
  })
}

function hasDistinctTail(observed: readonly unknown[]): boolean {
  const first = observed[0]
  const last = observed[2]
  return (
    isRecord(first) &&
    isRecord(last) &&
    last.text === SYNTHETIC_TAIL_TEXT &&
    first.text !== SYNTHETIC_TAIL_TEXT
  )
}

function sameDirectory(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const a = normalize(left)
  const b = normalize(right)
  const windowsPath = /^[A-Za-z]:\//.test(a) || /^[A-Za-z]:\//.test(b) || a.startsWith("//") || b.startsWith("//")
  return windowsPath ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isCanonicalProjectID(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_PROJECT_ID.test(value)
}

function boundedCount(value: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, value))
}

async function waitForRoute(
  current: (() => unknown) | undefined,
  sessionID: string,
): Promise<{ observed: boolean; currentAvailable: boolean }> {
  if (!current) return { observed: false, currentAvailable: false }
  const read = (): unknown => {
    try {
      return current()
    } catch {
      return undefined
    }
  }
  const deadline = Date.now() + ROUTE_WAIT_MS
  while (Date.now() < deadline) {
    if (routeMatches(read(), sessionID)) return { observed: true, currentAvailable: true }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return { observed: routeMatches(read(), sessionID), currentAvailable: true }
}

function routeMatches(value: unknown, sessionID: string): boolean {
  return isRecord(value) && value.type === "session" && value.sessionID === sessionID
}

export function isNativeProbeResult(value: unknown): value is NativeProbeResult {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, RESULT_KEYS)) return false
  if (value.probe !== PROBE_NAME || value.version !== 1) return false
  if (typeof value.ok !== "boolean" || typeof value.stage !== "string" || typeof value.reason !== "string") return false
  if (!STAGES.includes(value.stage as NativeProbeStage)) return false
  if (!REASONS.includes(value.reason as NativeProbeReason)) return false
  if (!isBoundedInteger(value.importedCount, 2)) return false
  if (!isBoundedInteger(value.oldMessageCount, 3)) return false
  if (!isBoundedInteger(value.candidateMessageCount, 4)) return false
  if (typeof value.nativeRouteObserved !== "boolean") return false
  if (typeof value.parentlessVerified !== "boolean") return false
  if (value.archiveNotTested !== true || value.composerNotTested !== true || value.pickerNotTested !== true) return false
  const expectedOk =
    value.stage === "complete" &&
    value.reason === "none" &&
    value.importedCount === 2 &&
    value.oldMessageCount === 2 &&
    value.candidateMessageCount === 3 &&
    value.parentlessVerified &&
    value.nativeRouteObserved
  return value.ok === expectedOk
}

function isBoundedInteger(value: unknown, maximum: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum
}

/** Pure, host-free isolation contract used by focused producer/consumer tests. */
export function validateIsolation(context: NativeProbeContext, env: ProbeEnv): boolean {
  return checkIsolation(context, env) !== null
}

/** Only the exact fixed switch value enables the archive branch. */
export function archiveProbeEnabled(env: ProbeEnv): boolean {
  return env.SP_PROBE_ARCHIVE === "1"
}

export function isArchiveProbeResult(value: unknown): value is ArchiveProbeResult {
  if (!isRecord(value) || !hasExactKeys(value, ARCHIVE_RESULT_KEYS)) return false
  if (value.probe !== ARCHIVE_PROBE_NAME || value.version !== 2) return false
  if (typeof value.ok !== "boolean" || typeof value.stage !== "string" || typeof value.reason !== "string") return false
  if (!ARCHIVE_STAGES.includes(value.stage as ArchiveStage)) return false
  if (!ARCHIVE_REASONS.includes(value.reason as ArchiveReason)) return false
  if (!isBoundedInteger(value.importedCount, 2)) return false
  if (!isBoundedInteger(value.oldMessageCount, 3)) return false
  if (!isBoundedInteger(value.candidateMessageCount, 4)) return false
  if (typeof value.nativeRouteObserved !== "boolean" || typeof value.parentlessVerified !== "boolean") return false
  if (typeof value.archiveNotTested !== "boolean" || typeof value.recoveryVerified !== "boolean") return false
  if (value.composerNotTested !== true || value.pickerNotTested !== true) return false
  if (value.mutationTargetOldOnly !== true) return false
  if (!ARCHIVE_CALLS.includes(value.archiveCall as ArchiveCall)) return false
  if (!ARCHIVE_READBACKS.includes(value.archiveReadback as ArchiveReadback)) return false
  if (!ARCHIVE_READBACKS.includes(value.recoveryReadback as ArchiveReadback)) return false
  const attempted = value.archiveCall === "accepted" || value.archiveCall === "error"
  if (value.archiveNotTested !== !attempted) return false
  return value.ok === archiveComplete(value as unknown as ArchiveProbeResult)
}

export function writeArchiveProbeResult(
  env: ProbeEnv,
  result: ArchiveProbeResult,
  forbidden: readonly string[] = [],
): boolean {
  try {
    const paths = checkWriterPaths(env)
    if (!paths) return false
    if (!isArchiveProbeResult(result)) return false

    const serialized = JSON.stringify(result)
    if (Buffer.byteLength(serialized, "utf8") > RESULT_LIMIT_BYTES) return false
    for (const value of forbidden) {
      if (value.length > 0 && serialized.includes(value)) return false
    }

    const temporary = `${paths.resultPath}.tmp`
    if (existsSync(temporary)) return false
    writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 })
    renameSync(temporary, paths.resultPath)
    return true
  } catch {
    return false
  }
}

export function writeNativeProbeResult(
  env: ProbeEnv,
  result: NativeProbeResult,
  forbidden: readonly string[] = [],
): boolean {
  try {
    const paths = checkWriterPaths(env)
    if (!paths) return false
    if (!isNativeProbeResult(result)) return false

    const serialized = JSON.stringify(result)
    if (Buffer.byteLength(serialized, "utf8") > RESULT_LIMIT_BYTES) return false
    for (const value of forbidden) {
      if (value.length > 0 && serialized.includes(value)) return false
    }

    const temporary = `${paths.resultPath}.tmp`
    if (existsSync(temporary)) return false
    writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 })
    renameSync(temporary, paths.resultPath)
    return true
  } catch {
    return false
  }
}

let started = false

function NativeProbeController(props: { context: Context }) {
  let cancelRecovery: (() => void) | undefined
  let disposed = false
  onCleanup(() => {
    disposed = true
    cancelRecovery?.()
  })
  createEffect(() => {
    if (started) return
    started = true
    const context = props.context as unknown as NativeProbeContext
    if (archiveProbeEnabled(process.env)) {
      void runArchiveTuiProbe(context, process.env, undefined, (cancel) => {
        cancelRecovery = cancel
        if (disposed) cancel()
      }).then(
        (outcome) => {
          cancelRecovery = outcome.cancelRecovery
          writeArchiveProbeResult(process.env, outcome.result, outcome.forbidden)
        },
        () => {
          const fallback = createArchiveProbeResult()
          fallback.stage = "failed"
          fallback.reason = "internal"
          writeArchiveProbeResult(process.env, fallback, [])
        },
      )
      return
    }
    void runNativeTuiProbe(context, process.env).then(
      (outcome) => {
        writeNativeProbeResult(process.env, outcome.result, outcome.forbidden)
      },
      () => {
        // A bounded missing-result failure is reported by the runner. No exception text is retained.
        const fallback = createProbeResult()
        fallback.stage = "failed"
        fallback.reason = "internal"
        writeNativeProbeResult(process.env, fallback, [])
      },
    )
  })
  return null
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    return context.ui.slot({
      append: "app",
      render: () => <NativeProbeController context={context} />,
    })
  },
})
