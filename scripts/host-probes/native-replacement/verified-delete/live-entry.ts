// Live M1 verified-delete entry. No host, network, Docker, database, Git, or secret
// access happens at import time. This is an isolated probe, not production durability.

import { createHash, randomBytes } from "node:crypto"
import { pathToFileURL } from "node:url"
import type { CheckpointPayload } from "../../../../src/core/contracts/session.ts"
import { createCheckpointCryptoFactory } from "../../../../src/core/crypto/index.ts"
import { serializeCheckpointPayload } from "../../../../src/core/sessions/serialize.ts"
import {
  EXPERIMENTAL_CRYPTO_POLICY,
  EXPERIMENTAL_CRYPTO_POLICY_DEFINITION,
} from "../../../../src/tui/wiring/experimental-profile.ts"
import { LifecycleError, verifyOpenApi, withIsolatedHost } from "../lifecycle/runner.mjs"
import type {
  InventorySession,
  ProbeImportPayload,
  ProbeMessage,
  ProbeSession,
  RecoveryPort,
  VerifiedDeletePort,
} from "./contract.ts"
import { PortNotFoundError, PortTimeoutError, isPortNotFoundError } from "./contract.ts"
import {
  CANDIDATE_TITLE,
  EXPECTED_COUNTS,
  OLD_ROOT_TITLE,
  SYNTHETIC_TAIL_TEXT,
  isMessageID,
  isRecord,
  isSessionID,
  toCheckpointPayload,
  validateFixture,
  type FlatMessage,
  type FlatRoot,
  type VerifiedDeleteFixture,
} from "./fixtures.ts"
import { createEncryptedRecoveryPort } from "./recovery.ts"
import {
  runVerifiedDelete,
  type VerifiedDeleteResult,
} from "./state-machine.ts"

const PROJECT_ID = "m1-verified-delete-probe"
const CANONICAL_PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/
const SESSION_PATH = /^\/api\/session\/(ses_[0-9a-f]{64})$/
const SESSION_KEYS = new Set([
  "id", "parentID", "fork", "projectID", "agent", "model", "cost", "tokens", "outcome",
  "time", "title", "location", "subpath", "metadata", "permissions", "revert",
])
const SESSION_TIME_KEYS = new Set(["created", "updated", "idle", "viewed", "archived"])
const MESSAGE_KEYS = new Set(["id", "metadata", "time", "type", "text", "files", "agents", "skills",
  "agent", "model", "content", "snapshot", "finish", "rawFinish", "providerState", "cost", "tokens", "error", "retry"])
const LIST_KEYS = new Set(["data", "cursor"])
const CURSOR_KEYS = new Set(["previous", "next"])
const PAGE_LIMIT = 50
// Probe-only cap for the fixed two-root/three-message fixture. It is not a product limit.
const MAX_PAGES = 8
// Fixed probe fixture bounds: two roots and five messages total. Not product limits.
const MAX_SESSIONS = 8
const MAX_MESSAGES = 8
const CURSOR_VALUE = /^[A-Za-z0-9_-]{1,8192}$/

export type GuardedRequest = (spec: { method: string; path: string; body?: unknown }) => Promise<unknown>
export type GuardedContext = { request: GuardedRequest; sessionIDs: string[]; profileDir: string; phase: string }

export type FixtureIDs = {
  oldSessionID: string
  candidateSessionID: string
  oldMessageIDs: readonly [string, string]
  candidateMessageIDs: readonly [string, string, string]
}

export type RestartManifest = {
  oldID: string
  newID: string
  canonicalProject: string
  oldPayloadDigest: string
  newPayloadDigest: string
  expectedCounts: { oldMessages: 2; candidateMessages: 3 }
}

export function generateFixtureIDs(random: (size: number) => Buffer = randomBytes): FixtureIDs {
  const hex = () => random(32).toString("hex")
  const ids: FixtureIDs = {
    oldSessionID: `ses_${hex()}`,
    candidateSessionID: `ses_${hex()}`,
    oldMessageIDs: [`msg_${hex()}`, `msg_${hex()}`],
    candidateMessageIDs: [`msg_${hex()}`, `msg_${hex()}`, `msg_${hex()}`],
  }
  const all = [ids.oldSessionID, ids.candidateSessionID, ...ids.oldMessageIDs, ...ids.candidateMessageIDs]
  if (!isSessionID(ids.oldSessionID) || !isSessionID(ids.candidateSessionID) ||
      ![...ids.oldMessageIDs, ...ids.candidateMessageIDs].every(isMessageID) || new Set(all).size !== all.length) {
    throw new LifecycleError("E_CONFIG")
  }
  return ids
}

function nativeMessage(message: FlatMessage) {
  if (message.type === "user") {
    return { id: message.id, type: "user", text: message.text, time: { created: message.time.created } }
  }
  return {
    id: message.id, type: "assistant", agent: "probe",
    model: { id: "probe-model", providerID: "probe-provider" },
    time: { created: message.time.created, completed: message.time.completed! },
    content: [{ type: "text", text: message.text }],
  }
}

function nativeImport(payload: ProbeImportPayload, lastMessageCreated: number) {
  return {
    info: {
      id: payload.info.id, projectID: payload.info.projectID, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: payload.info.time.created, updated: lastMessageCreated, idle: lastMessageCreated },
      title: payload.info.title, location: { directory: payload.info.directory },
    },
    messages: payload.messages.map(nativeMessage),
    location: { directory: payload.info.directory },
  }
}

async function importSeed(request: GuardedRequest, payload: ProbeImportPayload) {
  const info = data(await request({
    method: "POST",
    path: "/api/experimental/session/import",
    body: nativeImport(payload, Math.max(...payload.messages.map((message) => message.time.created))),
  }))
  if (info.id !== payload.info.id) fail("E_OLD_IMPORT")
  if (typeof info.projectID !== "string" || !CANONICAL_PROJECT_ID.test(info.projectID)) fail("E_PROJECT_ID")
  return { id: info.id, projectID: info.projectID }
}

function fail(code: string): never {
  throw new LifecycleError(code)
}

function data(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.data)) fail("E_HOST_CONTRACT")
  return value.data
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function sameDirectory(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const a = normalize(left)
  const b = normalize(right)
  const windows = /^[A-Za-z]:\//.test(a) || /^[A-Za-z]:\//.test(b)
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b
}

function sessionWire(value: unknown, directory: string): ProbeSession {
  if (!isRecord(value) || !exactKeys(value, SESSION_KEYS)) fail("E_HOST_CONTRACT")
  if (!isSessionID(value.id) || !isRecord(value.location) || !sameDirectory(value.location.directory, directory)) {
    fail("E_HOST_CONTRACT")
  }
  if (!isRecord(value.time) || !exactKeys(value.time, SESSION_TIME_KEYS)) fail("E_HOST_CONTRACT")
  if (!finite(value.time.created) || !finite(value.time.updated)) fail("E_HOST_CONTRACT")
  if (value.parentID !== undefined && value.parentID !== null) fail("E_HOST_CONTRACT")
  if (value.fork !== undefined || value.revert !== undefined) fail("E_HOST_CONTRACT")
  if (typeof value.projectID !== "string" || !CANONICAL_PROJECT_ID.test(value.projectID)) fail("E_HOST_CONTRACT")
  if (typeof value.title !== "string" || value.title.length === 0) fail("E_HOST_CONTRACT")
  if (value.time.archived !== undefined && !finite(value.time.archived)) fail("E_HOST_CONTRACT")
  return {
    id: value.id,
    parentID: value.parentID ?? null,
    title: value.title,
    projectID: value.projectID,
    directory: value.location.directory,
    time: {
      created: value.time.created,
      updated: value.time.updated,
      ...(value.time.archived === undefined ? {} : { archived: value.time.archived }),
    },
  }
}

function messageWire(value: unknown): ProbeMessage {
  if (!isRecord(value) || !exactKeys(value, MESSAGE_KEYS)) fail("E_HOST_CONTRACT")
  if (!isMessageID(value.id) || !isRecord(value.time) || !finite(value.time.created)) fail("E_HOST_CONTRACT")
  if (value.type === "user") {
    if (typeof value.text !== "string") fail("E_HOST_CONTRACT")
    for (const key of ["files", "agents", "skills"] as const) {
      if (value[key] !== undefined && !Array.isArray(value[key])) fail("E_HOST_CONTRACT")
    }
    return { id: value.id, type: "user", text: value.text, time: { created: value.time.created } }
  }
  if (value.type !== "assistant" || !finite(value.time.completed)) fail("E_HOST_CONTRACT")
  if (value.error !== undefined || value.retry !== undefined) fail("E_HOST_CONTRACT")
  if (!Array.isArray(value.content) || value.content.length !== 1) fail("E_HOST_CONTRACT")
  const part = value.content[0]
  if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") fail("E_HOST_CONTRACT")
  return {
    id: value.id, type: "assistant", text: part.text,
    time: { created: value.time.created, completed: value.time.completed },
  }
}

// Both public 2.1.3 envelopes are `{data, cursor:{previous?, next?}}`. The server
// returns `next` anchored at the last item of every non-empty page, including the
// final item, so a non-empty page is not terminal. Only an empty page is terminal.
function cursorEnvelope(value: unknown, parse: (item: unknown) => unknown): {
  items: unknown[]
  next: string | undefined
} {
  if (!isRecord(value) || !exactKeys(value, LIST_KEYS) || !Array.isArray(value.data)) fail("E_HOST_CONTRACT")
  const raw = value.cursor
  const cursor = raw === undefined || raw === null ? {} : raw
  if (!isRecord(cursor) || !exactKeys(cursor, CURSOR_KEYS)) fail("E_INVENTORY_PAGING")
  const position = (value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined
    if (typeof value !== "string" || !CURSOR_VALUE.test(value)) fail("E_INVENTORY_PAGING")
    return value
  }
  const next = position(cursor.next)
  const previous = position(cursor.previous)
  const items = value.data.map(parse)
  if (items.length === 0) {
    if (next !== undefined || previous !== undefined) fail("E_INVENTORY_PAGING")
  } else if (next === undefined) {
    fail("E_INVENTORY_PAGING")
  }
  return { items, next }
}

function createAdapter(request: GuardedRequest, ids: FixtureIDs, directory: string): VerifiedDeletePort & {
  readInventory(): Promise<readonly InventorySession[]>
  removeSession(sessionID: string): Promise<void>
} {
  const allowed = new Set([ids.oldSessionID, ids.candidateSessionID])
  const scoped = (sessionID: string) => {
    if (typeof sessionID !== "string" || !allowed.has(sessionID)) fail("E_SCOPE")
    return sessionID
  }
  const bridge = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "E_NOT_FOUND") throw new PortNotFoundError(operation)
      if (error instanceof LifecycleError && error.code === "E_TIMEOUT") throw new PortTimeoutError(operation)
      throw error
    }
  }
  const listMessages = (sessionID: string) => bridge("message-list", async () => {
    const id = scoped(sessionID)
    const messages: ProbeMessage[] = []
    const ids = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let pages = 0; ; pages += 1) {
      if (pages >= MAX_PAGES) fail("E_INVENTORY_PAGING_LIMIT")
      const path = cursor === undefined
        ? `/api/session/${id}/message?order=asc&limit=${PAGE_LIMIT}`
        : `/api/session/${id}/message?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
      const page = cursorEnvelope(await request({ method: "GET", path }), (item) => item)
      for (const item of page.items) {
        const message = messageWire(item)
        if (ids.has(message.id)) fail("E_INVENTORY_DUPLICATE")
        if (ids.size >= MAX_MESSAGES) fail("E_INVENTORY_SHAPE")
        ids.add(message.id)
        messages.push(message)
      }
      if (page.items.length === 0) return messages
      if (cursors.has(page.next!)) fail("E_INVENTORY_PAGING_CYCLE")
      cursors.add(page.next!)
      cursor = page.next!
    }
  })
  return {
    getSession: (sessionID) => bridge("session-get", async () => {
      const value = await request({ method: "GET", path: `/api/session/${scoped(sessionID)}` })
      const session = sessionWire(data(value), directory)
      if (session.id !== sessionID) fail("E_HOST_CONTRACT")
      return session
    }),
    listMessages,
    async importSession(payload): Promise<{ id: string; projectID: string }> {
      if (payload.info.id !== ids.candidateSessionID) fail("E_SCOPE")
      const created = payload.messages.map((message) => message.time.created)
      const body = nativeImport(payload, Math.max(...created))
      const value = data(await request({ method: "POST", path: "/api/experimental/session/import", body }))
      if (value.id !== ids.candidateSessionID) fail("E_IMPORT_RESPONSE")
      if (typeof value.projectID !== "string" || !CANONICAL_PROJECT_ID.test(value.projectID)) fail("E_PROJECT_ID")
      return { id: value.id, projectID: value.projectID }
    },
    async readInventory() {
      const sessions: ProbeSession[] = []
      const ids = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (let pages = 0; ; pages += 1) {
        if (pages >= MAX_PAGES) fail("E_INVENTORY_PAGING_LIMIT")
        const path = cursor === undefined
          ? `/api/session?limit=${PAGE_LIMIT}&order=asc`
          : `/api/session?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
        const page = cursorEnvelope(await request({ method: "GET", path }), (item) => item)
        for (const item of page.items) {
          if (!isRecord(item) || !isSessionID(item.id)) fail("E_HOST_CONTRACT")
          const session = sessionWire(item, directory)
          if (ids.has(session.id)) fail("E_INVENTORY_DUPLICATE")
          if (ids.size >= MAX_SESSIONS) fail("E_INVENTORY_SHAPE")
          ids.add(session.id)
          sessions.push(session)
        }
        if (page.items.length === 0) break
        if (cursors.has(page.next!)) fail("E_INVENTORY_PAGING_CYCLE")
        cursors.add(page.next!)
        cursor = page.next!
      }
      const entries: InventorySession[] = []
      for (const session of sessions) {
        entries.push({
          id: session.id, parentID: session.parentID, projectID: session.projectID,
          messageIDs: (await listMessages(session.id)).map((message) => message.id),
        })
      }
      return entries
    },
    removeSession: (sessionID) => bridge("session-remove", async () => {
      if (sessionID !== ids.oldSessionID) fail("E_SCOPE")
      await request({ method: "DELETE", path: `/api/session/${sessionID}` })
    }),
  }
}

function buildFixture(input: {
  ids: FixtureIDs
  directory: string
  projectID: string
  oldSession: ProbeSession
  oldMessages: readonly ProbeMessage[]
  now: number
}): VerifiedDeleteFixture {
  const messages: FlatMessage[] = input.oldMessages.map((message) => ({
    id: message.id, type: message.type, text: message.text, time: { ...message.time },
  }))
  const oldRoot: FlatRoot = {
    session: {
      id: input.oldSession.id, title: OLD_ROOT_TITLE, projectID: input.projectID,
      directory: input.directory,
      time: { created: input.oldSession.time.created, updated: input.oldSession.time.updated },
    },
    messages,
  }
  return {
    version: 1,
    projectID: input.projectID,
    directory: input.directory,
    oldRoot,
    candidateRoot: {
      session: {
        id: input.ids.candidateSessionID, title: CANDIDATE_TITLE, projectID: input.projectID,
        directory: input.directory,
        time: { created: input.now - 2000, updated: input.now - 1000 },
      },
      messages: [
        { ...messages[0]!, id: input.ids.candidateMessageIDs[0], time: { ...messages[0]!.time } },
        { ...messages[1]!, id: input.ids.candidateMessageIDs[1], time: { ...messages[1]!.time } },
        { id: input.ids.candidateMessageIDs[2], type: "user", text: SYNTHETIC_TAIL_TEXT, time: { created: input.now - 500 } },
      ],
    },
    expected: EXPECTED_COUNTS,
  }
}

function digest(payload: CheckpointPayload): string {
  return createHash("sha256").update(serializeCheckpointPayload(payload)).digest("hex")
}

function createManifest(fixture: VerifiedDeleteFixture, oldPayload: CheckpointPayload): RestartManifest {
  const manifest: RestartManifest = {
    oldID: fixture.oldRoot.session.id,
    newID: fixture.candidateRoot.session.id,
    canonicalProject: fixture.projectID,
    oldPayloadDigest: digest(oldPayload),
    newPayloadDigest: digest(toCheckpointPayload(fixture.candidateRoot)),
    expectedCounts: { oldMessages: 2, candidateMessages: 3 },
  }
  if (!validateManifest(manifest, fixture)) fail("E_MANIFEST")
  return Object.freeze(manifest)
}

export function validateManifest(value: unknown, fixture: VerifiedDeleteFixture): value is RestartManifest {
  if (!isRecord(value) || Object.keys(value).length !== 6) return false
  if (value.oldID !== fixture.oldRoot.session.id || value.newID !== fixture.candidateRoot.session.id) return false
  if (value.canonicalProject !== fixture.projectID || value.canonicalProject !== fixture.oldRoot.session.projectID) return false
  if (typeof value.oldPayloadDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.oldPayloadDigest)) return false
  if (typeof value.newPayloadDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.newPayloadDigest)) return false
  const counts = value.expectedCounts
  return isRecord(counts) && counts.oldMessages === 2 && counts.candidateMessages === 3
}

export function createLiveEntryCallbacks(input: { ids: FixtureIDs; projectID?: string }): {
  probe(context: GuardedContext): Promise<Record<string, unknown>>
  snapshot(context: GuardedContext): Promise<Record<string, unknown>>
  state(): { fixture: VerifiedDeleteFixture | null; result: VerifiedDeleteResult | null; manifest: RestartManifest | null }
  dispose(): void
} {
  const projectID = input.projectID ?? PROJECT_ID
  let fixture: VerifiedDeleteFixture | null = null
  let result: VerifiedDeleteResult | null = null
  let manifest: RestartManifest | null = null
  let oldPayload: CheckpointPayload | null = null
  let recovery: RecoveryPort | null = null

  const checkContext = (context: GuardedContext, phase: string) => {
    if (!Array.isArray(context.sessionIDs) || context.sessionIDs.length !== 2 ||
        context.sessionIDs[0] !== input.ids.oldSessionID || context.sessionIDs[1] !== input.ids.candidateSessionID ||
        typeof context.profileDir !== "string" || context.phase !== phase) {
      throw new LifecycleError("E_CONFIG")
    }
  }

  const probe = async (context: GuardedContext) => {
    checkContext(context, "first")
    const openapi = await context.request({ method: "GET", path: "/openapi.json" })
    verifyOpenApi(openapi)
    if (!isRecord(openapi) || !isRecord(openapi.paths) || !isRecord(openapi.paths["/api/session/{sessionID}"]) ||
        !openapi.paths["/api/session/{sessionID}"].delete) {
      fail("E_CONTRACT")
    }

    const now = Date.now()
    // The explicit old seed carries the frozen two-message prefix.
    const seeded = createSeed(fixtureSeed(input.ids, context.profileDir, projectID, now))
    const started = Date.now()
    const imported = await importSeed(context.request, seeded.payload)
    const finished = Date.now()
    if (imported.id !== input.ids.oldSessionID) fail("E_OLD_IMPORT")
    const adapter = createAdapter(context.request, input.ids, context.profileDir)
    const oldSession = await adapter.getSession(input.ids.oldSessionID)
    if (oldSession.time.created !== seeded.payload.info.time.created ||
        oldSession.time.updated === seeded.nativeTime.updated ||
        oldSession.time.updated < started || oldSession.time.updated > finished) {
      fail("E_OLD_TIME")
    }
    const oldMessages = await adapter.listMessages(input.ids.oldSessionID)
    if (oldMessages.length !== 2) fail("E_OLD_SHAPE")
    if (oldSession.title !== OLD_ROOT_TITLE || !sameDirectory(oldSession.directory, context.profileDir)) {
      fail("E_OLD_SHAPE")
    }
    const observedProject = oldSession.projectID
    if (imported.projectID !== observedProject) fail("E_PROJECT_ID")

    fixture = buildFixture({
      ids: input.ids, directory: context.profileDir, projectID: observedProject, oldSession, oldMessages, now,
    })
    if (validateFixture(fixture).length > 0) fail("E_FIXTURE")
    oldPayload = toCheckpointPayload(fixture.oldRoot)
    const factory = await createCheckpointCryptoFactory([EXPERIMENTAL_CRYPTO_POLICY_DEFINITION])
    const crypto = await factory.create(EXPERIMENTAL_CRYPTO_POLICY)
    recovery = await createEncryptedRecoveryPort(oldPayload, crypto)
    result = await runVerifiedDelete(adapter, recovery, fixture)
    if (result.outcome === "delete-verified") {
      manifest = createManifest(fixture, oldPayload)
    }
    return sanitizeResult(result, manifest !== null)
  }

  const snapshot = async (context: GuardedContext) => {
    checkContext(context, "restart-readonly")
    if (!fixture || !result || result.outcome !== "delete-verified" || !manifest || !oldPayload || !recovery) {
      return { status: "failed", step: "precondition", errorCategory: "E_SNAPSHOT_NOT_READY", steps: [] }
    }
    if (!validateManifest(manifest, fixture) ||
        manifest.oldPayloadDigest !== digest(oldPayload) ||
        manifest.newPayloadDigest !== digest(toCheckpointPayload(fixture.candidateRoot))) {
      return { status: "failed", step: "manifest", errorCategory: "E_MANIFEST", steps: [] }
    }
    const adapter = createAdapter(context.request, input.ids, context.profileDir)
    const steps: Array<Record<string, unknown>> = []
    const failed = (step: string, category: string) => ({
      status: "failed", step, errorCategory: category, steps,
      nativeRestore: "not-proven",
    })

    try {
      await adapter.getSession(input.ids.oldSessionID)
      return failed("old-absent", "E_OLD_PRESENT")
    } catch (error) {
      if (!isPortNotFoundError(error)) return failed("old-absent", "E_OLD_ABSENT_UNKNOWN")
    }
    steps.push({ step: "old-absent", status: "ok" })

    let candidate: ProbeSession
    let messages: readonly ProbeMessage[]
    try {
      candidate = await adapter.getSession(input.ids.candidateSessionID)
      messages = await adapter.listMessages(input.ids.candidateSessionID)
    } catch {
      return failed("candidate-read", "E_CANDIDATE_READ")
    }
    if (!candidateMatches(candidate, messages, fixture)) {
      return failed("candidate-verify", "E_CANDIDATE_CHANGED")
    }
    steps.push({ step: "candidate-verify", status: "ok", count: messages.length })

    try {
      const inventory = await adapter.readInventory()
      const ids = inventory[0]?.messageIDs ?? []
      if (inventory.length !== 1 || inventory[0]!.id !== input.ids.candidateSessionID ||
          inventory[0]!.parentID !== null || inventory[0]!.projectID !== fixture.projectID ||
          ids.length !== 3 || !ids.every((id, index) => id === fixture!.candidateRoot.messages[index]!.id)) {
        return failed("inventory", "E_INVENTORY_CHANGED")
      }
    } catch {
      return failed("inventory", "E_INVENTORY_READ")
    }
    steps.push({ step: "inventory", status: "ok", sessions: 1 })

    try {
      if ((await recovery.verify(oldPayload)) !== true) return failed("recovery-verify", "E_RECOVERY_VERIFY")
      const recovered = await recovery.recover()
      if (!jsonEqual(recovered, oldPayload)) return failed("recovery-payload", "E_RECOVERY_MISMATCH")
    } catch {
      return failed("recovery-verify", "E_RECOVERY_VERIFY")
    }
    steps.push({ step: "recovery-verify", status: "ok" })
    steps.push({ step: "recovery-payload", status: "ok" })

    return {
      status: "verified", reason: null, steps,
      oldAbsent: true, candidateMessages: messages.length, inventorySessions: 1,
      recoveryVerify: "verified", recoveryPayload: "strict-equal",
      manifestValidated: true, restoreImportMutation: "not-run",
      nativeRestore: "not-proven", durability: "parent-memory-only",
    }
  }

  return {
    probe,
    snapshot,
    state: () => ({ fixture, result, manifest }),
    dispose() {
      if (recovery) recovery.destroy()
    },
  }
}

function fixtureSeed(ids: FixtureIDs, directory: string, projectID: string, now: number) {
  return {
    ids, directory, projectID, now,
    oldMessages: [
      { id: ids.oldMessageIDs[0], type: "user" as const, text: "synthetic verified-delete old user", time: { created: now - 4000 } },
      { id: ids.oldMessageIDs[1], type: "assistant" as const, text: "synthetic verified-delete old assistant", time: { created: now - 3500, completed: now - 3000 } },
    ],
  }
}

function createSeed(seed: ReturnType<typeof fixtureSeed>): {
  payload: ProbeImportPayload
  nativeTime: { created: number; updated: number }
} {
  const updated = Math.max(...seed.oldMessages.map((message) => message.time.created))
  const created = Math.min(...seed.oldMessages.map((message) => message.time.created)) - 1000
  return {
    payload: {
      info: {
        id: seed.ids.oldSessionID, title: OLD_ROOT_TITLE, projectID: seed.projectID,
        directory: seed.directory, time: { created, updated },
      },
      messages: seed.oldMessages,
    },
    nativeTime: { created, updated },
  }
}

function candidateMatches(session: ProbeSession, messages: readonly ProbeMessage[], fixture: VerifiedDeleteFixture): boolean {
  if (session.id !== fixture.candidateRoot.session.id || session.title !== CANDIDATE_TITLE ||
      session.projectID !== fixture.projectID || !sameDirectory(session.directory, fixture.directory) ||
      (session.parentID !== undefined && session.parentID !== null) ||
      !finite(session.time.created) || !finite(session.time.updated) || session.time.archived !== undefined) {
    return false
  }
  if (messages.length !== 3) return false
  return messages.every((message, index) => {
    const expected = fixture.candidateRoot.messages[index]!
    return message.id === expected.id && message.type === expected.type && message.text === expected.text &&
      message.time.created === expected.time.created && message.time.completed === expected.time.completed
  }) && messages[2]!.text === SYNTHETIC_TAIL_TEXT
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function sanitizeResult(result: VerifiedDeleteResult, manifestReady: boolean) {
  const verified = result.outcome === "delete-verified" && manifestReady
  return {
    outcome: verified ? "api-verified" : result.outcome,
    reason: result.reason,
    phase: result.phase,
    completedPhases: result.completedPhases,
    counts: result.counts,
    checks: result.checks,
    delete: result.delete,
    retained: result.retained,
    safety: result.safety,
    restartManifestReady: verified,
  }
}

export function finalizeRunResult(run: Record<string, unknown>) {
  const probe = isRecord(run.probe) ? run.probe : null
  const snapshot = isRecord(run.snapshot) ? run.snapshot : null
  const probeFailure = isRecord(run.probeFailure) ? run.probeFailure : null
  const verified = run.status === "ok" && run.cleanup === "profile-removed" &&
    probe?.outcome === "api-verified" && probe.restartManifestReady === true &&
    snapshot?.status === "verified"
  const failure = verified ? null
    : typeof probeFailure?.code === "string" ? probeFailure.code
    : typeof probe?.reason === "string" ? probe.reason
    : typeof snapshot?.errorCategory === "string" ? snapshot.errorCategory
    : typeof run.snapshotReason === "string" ? run.snapshotReason : "E_VERIFY"
  return {
    status: verified ? "ok" : "failed",
    failure, probe, probeFailure, snapshot,
    cleanup: run.cleanup,
    ...(typeof run.snapshotReason === "string" ? { snapshotReason: run.snapshotReason } : {}),
  }
}

export function exitCodeForResult(result: unknown): number {
  return isRecord(result) && result.status === "ok" ? 0 : 1
}

export async function runEntry() {
  const ids = generateFixtureIDs()
  const callbacks = createLiveEntryCallbacks({ ids })
  try {
    const run = await withIsolatedHost({
      sessionIDs: [ids.oldSessionID, ids.candidateSessionID],
      binaryPath: "/usr/local/bin/opencode",
      profileBase: "/run/sessionport",
      syntheticDeleteTarget: ids.oldSessionID,
      snapshot: callbacks.snapshot,
    }, callbacks.probe)
    return finalizeRunResult(run as unknown as Record<string, unknown>)
  } catch (error) {
    if (error instanceof LifecycleError) {
      const facts = "facts" in error && isRecord((error as { facts?: unknown }).facts)
        ? (error as { facts: Record<string, unknown> }).facts : {}
      return { ...facts, status: "error", code: error.code }
    }
    return { status: "error", code: "E_INTERNAL" }
  } finally {
    callbacks.dispose()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runEntry()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = exitCodeForResult(result)
}
