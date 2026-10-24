import type { CheckpointPayload } from "../../../../src/core/contracts/session.ts"
import {
  isPortNotFoundError,
  isPortTimeoutError,
  type InventorySession,
  type ProbeMessage,
  type ProbeSession,
  type RecoveryPort,
  type VerifiedDeletePort,
} from "./contract.ts"
import {
  EXPECTED_COUNTS,
  SYNTHETIC_TAIL_TEXT,
  buildImportPayload,
  isMessageID,
  isRecord,
  toCheckpointPayload,
  validateFixture,
  type FlatMessage,
  type VerifiedDeleteFixture,
} from "./fixtures.ts"

export const VERIFIED_DELETE_VERSION = 1 as const

export const PHASES = [
  "preflight",
  "old-verified",
  "candidate-absent",
  "imported",
  "candidate-verified",
  "predelete-verified",
  "delete-requested",
  "delete-readback",
  "recovered",
  "complete",
] as const

export type Phase = (typeof PHASES)[number]
export type Outcome = "invalid-fixture" | "blocked" | "failed" | "delete-verified"
export type Verification = "not-tested" | "verified" | "failed"
export type ImportState = "not-run" | "created" | "unexpected-root" | "failed"
export type DeleteState = "not-requested" | "deleted" | "not-deleted" | "unknown"
export type RemoveOutcome = "not-run" | "resolved" | "timeout" | "error"

export type Reason =
  | "invalid-fixture"
  | "old-unreadable"
  | "unsupported-session-shape"
  | "old-session-id-mismatch"
  | "old-not-parentless"
  | "old-not-active"
  | "old-project-mismatch"
  | "old-title-mismatch"
  | "old-directory-mismatch"
  | "unsupported-message-shape"
  | "old-message-count"
  | "old-message-mismatch"
  | "recovery-verify-failed-before-import"
  | "candidate-present"
  | "candidate-lookup-ambiguous"
  | "import-failed"
  | "import-unexpected-root"
  | "candidate-unreadable"
  | "candidate-session-id-mismatch"
  | "candidate-not-parentless"
  | "candidate-not-active"
  | "candidate-project-mismatch"
  | "candidate-title-mismatch"
  | "candidate-directory-mismatch"
  | "candidate-message-count"
  | "candidate-message-mismatch"
  | "candidate-tail-mismatch"
  | "candidate-id-unfresh"
  | "candidate-id-duplicate"
  | "recovery-verify-failed-before-delete"
  | "old-changed-before-delete"
  | "inventory-unreadable"
  | "unsupported-inventory-shape"
  | "inventory-foreign-session"
  | "inventory-missing-session"
  | "inventory-duplicate-session"
  | "inventory-session-parent"
  | "inventory-project-mismatch"
  | "inventory-foreign-message"
  | "inventory-missing-message"
  | "inventory-duplicate-message"
  | "delete-not-applied"
  | "delete-state-unknown"
  | "candidate-changed-after-delete"
  | "recovery-failed"
  | "recovery-mismatch"

export type VerifiedDeleteResult = {
  version: typeof VERIFIED_DELETE_VERSION
  phase: Phase
  completedPhases: Phase[]
  outcome: Outcome
  reason: Reason | null
  fixture: {
    oldSessionID: string
    candidateSessionID: string
    oldMessageIDs: string[]
    candidateMessageIDs: string[]
  }
  counts: {
    oldMessages: 2
    candidateMessages: 3
    removeCalls: number
    inventorySessions: number
    inventoryMessages: number
  }
  checks: {
    oldBaseline: Verification
    recoveryBeforeImport: Verification
    candidateAbsent: Verification
    import: ImportState
    candidateReadback: Verification
    recoveryBeforeDelete: Verification
    oldUnchanged: Verification
    inventory: Verification
    recoveryAfterDelete: Verification
  }
  delete: { requested: boolean; state: DeleteState; removeOutcome: RemoveOutcome }
  /** True means "not confirmed deleted", not a claim that the session is readable. */
  retained: { oldRoot: boolean; candidate: boolean }
  safety: {
    deleteCalls: number
    deleteTargetFrozenOldOnly: boolean
    candidateDeleteCalls: 0
    blindRetries: 0
    casClaim: false
    residual: "manual-quiescence-required"
    automaticRestore: false
    inventoryScope: "isolated-host-exact"
  }
}

export async function runVerifiedDelete(
  port: VerifiedDeletePort,
  recovery: RecoveryPort,
  fixture: VerifiedDeleteFixture,
): Promise<VerifiedDeleteResult> {
  const result = createResult(fixture)
  if (validateFixture(fixture).length > 0) {
    result.outcome = "invalid-fixture"
    result.reason = "invalid-fixture"
    return result
  }

  const oldID = fixture.oldRoot.session.id
  const candidateID = fixture.candidateRoot.session.id
  const oldPayload = toCheckpointPayload(fixture.oldRoot)

  const baseline = await readRoot(port, oldID)
  if (baseline === null) return blocked(result, "old-unreadable")
  result.retained.oldRoot = true
  const baselineReason = oldMismatch(baseline, fixture)
  if (baselineReason !== null) return blocked(result, baselineReason)
  result.checks.oldBaseline = "verified"
  mark(result, "old-verified")

  if (!(await verifyRecovery(recovery, oldPayload))) {
    return blocked(result, "recovery-verify-failed-before-import")
  }
  result.checks.recoveryBeforeImport = "verified"

  const lookup = await candidateLookup(port, candidateID)
  if (lookup === "present") {
    result.retained.candidate = true
    return blocked(result, "candidate-present")
  }
  if (lookup === "ambiguous") return blocked(result, "candidate-lookup-ambiguous")
  result.checks.candidateAbsent = "verified"
  mark(result, "candidate-absent")

  let imported: { id: string } | null
  try {
    imported = await port.importSession(buildImportPayload(fixture))
  } catch {
    result.checks.import = "failed"
    return blocked(result, "import-failed")
  }
  if (imported === null || imported.id !== candidateID) {
    result.checks.import = "unexpected-root"
    return blocked(result, "import-unexpected-root")
  }
  result.checks.import = "created"
  result.retained.candidate = true
  mark(result, "imported")

  const candidateSnapshot = await readRoot(port, candidateID)
  if (candidateSnapshot === null) return blocked(result, "candidate-unreadable")
  const candidateCheck = checkCandidate(candidateSnapshot, fixture)
  if (!candidateCheck.ok) return blocked(result, candidateCheck.reason)
  result.checks.candidateReadback = "verified"
  mark(result, "candidate-verified")

  if (!(await verifyRecovery(recovery, oldPayload))) {
    return blocked(result, "recovery-verify-failed-before-delete")
  }
  result.checks.recoveryBeforeDelete = "verified"

  const beforeDelete = await readRoot(port, oldID)
  if (beforeDelete === null || oldMismatch(beforeDelete, fixture) !== null) {
    return blocked(result, "old-changed-before-delete")
  }
  result.checks.oldUnchanged = "verified"

  const inventory = await checkInventory(port, fixture, candidateCheck.messageIDs)
  if (!inventory.ok) return blocked(result, inventory.reason)
  result.checks.inventory = "verified"
  result.counts.inventorySessions = inventory.sessions
  result.counts.inventoryMessages = inventory.messages
  mark(result, "predelete-verified")

  // The only remove call in this lane. The target is the frozen fixture old ID.
  result.delete.requested = true
  result.safety.deleteCalls = 1
  result.counts.removeCalls = 1
  mark(result, "delete-requested")
  try {
    await port.removeSession(oldID)
    result.delete.removeOutcome = "resolved"
  } catch (error) {
    result.delete.removeOutcome = isPortTimeoutError(error) ? "timeout" : "error"
  }

  result.delete.state = await deletionState(port, oldID)
  const candidateAfter = await readRoot(port, candidateID)
  mark(result, "delete-readback")
  if (result.delete.state !== "deleted") {
    result.retained.oldRoot = true
    return failed(result, result.delete.state === "not-deleted" ? "delete-not-applied" : "delete-state-unknown")
  }
  result.retained.oldRoot = false

  if (candidateAfter === null || !checkCandidate(candidateAfter, fixture).ok) {
    return failed(result, "candidate-changed-after-delete")
  }

  const recovered = await recoverRecovery(recovery)
  if (recovered === null) return failed(result, "recovery-failed")
  if (!jsonEqual(recovered, oldPayload)) return failed(result, "recovery-mismatch")
  result.checks.recoveryAfterDelete = "verified"
  mark(result, "recovered")
  mark(result, "complete")
  result.outcome = "delete-verified"
  return result
}

type Snapshot = { session: ProbeSession; messages: readonly ProbeMessage[] }

const SESSION_KEYS = new Set(["id", "parentID", "title", "projectID", "directory", "time"])
const SESSION_TIME_KEYS = new Set(["created", "updated", "archived"])
const MESSAGE_KEYS = new Set(["id", "type", "text", "time"])
const MESSAGE_TIME_KEYS = new Set(["created", "completed"])
const INVENTORY_KEYS = new Set(["id", "parentID", "projectID", "messageIDs"])

function oldMismatch(snapshot: Snapshot, fixture: VerifiedDeleteFixture): Reason | null {
  if (!hasOnlyKeys(snapshot.session, SESSION_KEYS)) return "unsupported-session-shape"
  if (!isRecord(snapshot.session.time) || !hasOnlyKeys(snapshot.session.time, SESSION_TIME_KEYS)) {
    return "unsupported-session-shape"
  }
  if (snapshot.session.id !== fixture.oldRoot.session.id) return "old-session-id-mismatch"
  if (!isParentless(snapshot.session)) return "old-not-parentless"
  if (!isActive(snapshot.session)) return "old-not-active"
  if (snapshot.session.projectID !== fixture.projectID) return "old-project-mismatch"
  if (snapshot.session.title !== fixture.oldRoot.session.title) return "old-title-mismatch"
  if (!sameDirectory(snapshot.session.directory, fixture.directory)) return "old-directory-mismatch"
  if (snapshot.messages.length !== EXPECTED_COUNTS.oldMessages) return "old-message-count"
  for (const [index, message] of snapshot.messages.entries()) {
    if (!validMessageShape(message)) return "unsupported-message-shape"
    if (!messageEquals(message, fixture.oldRoot.messages[index]!)) return "old-message-mismatch"
  }
  return null
}

function checkCandidate(
  snapshot: Snapshot,
  fixture: VerifiedDeleteFixture,
): { ok: true; messageIDs: string[] } | { ok: false; reason: Reason } {
  const session = snapshot.session
  if (!hasOnlyKeys(session, SESSION_KEYS)) return { ok: false, reason: "unsupported-session-shape" }
  if (!isRecord(session.time) || !hasOnlyKeys(session.time, SESSION_TIME_KEYS)) {
    return { ok: false, reason: "unsupported-session-shape" }
  }
  if (session.id !== fixture.candidateRoot.session.id) return { ok: false, reason: "candidate-session-id-mismatch" }
  if (!isParentless(session)) return { ok: false, reason: "candidate-not-parentless" }
  if (!isActive(session)) return { ok: false, reason: "candidate-not-active" }
  if (session.projectID !== fixture.projectID) return { ok: false, reason: "candidate-project-mismatch" }
  if (session.title !== fixture.candidateRoot.session.title) return { ok: false, reason: "candidate-title-mismatch" }
  if (!sameDirectory(session.directory, fixture.directory)) return { ok: false, reason: "candidate-directory-mismatch" }
  if (snapshot.messages.length !== EXPECTED_COUNTS.candidateMessages) {
    return { ok: false, reason: "candidate-message-count" }
  }
  for (const message of snapshot.messages) {
    if (!validMessageShape(message)) return { ok: false, reason: "unsupported-message-shape" }
  }

  const ids = snapshot.messages.map((message) => message.id)
  if (new Set(ids).size !== ids.length) return { ok: false, reason: "candidate-id-duplicate" }
  const oldIDs = new Set(fixture.oldRoot.messages.map((message) => message.id))
  if (ids.some((id) => oldIDs.has(id))) return { ok: false, reason: "candidate-id-unfresh" }

  // Strict bijection: old message order maps to the candidate prefix order.
  // Only the documented native message ID may differ; content, role, and
  // timestamps must match the old prefix exactly.
  for (const index of [0, 1] as const) {
    if (!messageContentEquals(snapshot.messages[index]!, fixture.candidateRoot.messages[index]!)) {
      return { ok: false, reason: "candidate-message-mismatch" }
    }
  }
  const tail = snapshot.messages[2]!
  const expectedTail = fixture.candidateRoot.messages[2]!
  if (!messageContentEquals(tail, expectedTail) || tail.text !== SYNTHETIC_TAIL_TEXT) {
    return { ok: false, reason: "candidate-tail-mismatch" }
  }
  return { ok: true, messageIDs: ids }
}

async function checkInventory(
  port: VerifiedDeletePort,
  fixture: VerifiedDeleteFixture,
  candidateMessageIDs: readonly string[],
): Promise<{ ok: true; sessions: number; messages: number } | { ok: false; reason: Reason }> {
  let inventory: readonly InventorySession[]
  try {
    inventory = await port.readInventory()
  } catch {
    return { ok: false, reason: "inventory-unreadable" }
  }
  if (!Array.isArray(inventory)) return { ok: false, reason: "inventory-unreadable" }

  const oldID = fixture.oldRoot.session.id
  const candidateID = fixture.candidateRoot.session.id
  const expectedSessions = new Set([oldID, candidateID])
  const expectedMessages = new Set([...fixture.oldRoot.messages.map((message) => message.id), ...candidateMessageIDs])
  const seenSessions = new Set<string>()
  const seenMessages = new Set<string>()

  for (const entry of inventory) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, INVENTORY_KEYS)) {
      return { ok: false, reason: "unsupported-inventory-shape" }
    }
    if (typeof entry.id !== "string" || !Array.isArray(entry.messageIDs)) {
      return { ok: false, reason: "unsupported-inventory-shape" }
    }
    if (seenSessions.has(entry.id)) return { ok: false, reason: "inventory-duplicate-session" }
    if (!expectedSessions.has(entry.id)) return { ok: false, reason: "inventory-foreign-session" }
    if (entry.parentID !== undefined && entry.parentID !== null) {
      return { ok: false, reason: "inventory-session-parent" }
    }
    if (entry.projectID !== fixture.projectID) return { ok: false, reason: "inventory-project-mismatch" }
    seenSessions.add(entry.id)
    for (const messageID of entry.messageIDs) {
      if (!isMessageID(messageID)) return { ok: false, reason: "unsupported-inventory-shape" }
      if (seenMessages.has(messageID)) return { ok: false, reason: "inventory-duplicate-message" }
      if (!expectedMessages.has(messageID)) return { ok: false, reason: "inventory-foreign-message" }
      seenMessages.add(messageID)
    }
  }

  if (seenSessions.size !== expectedSessions.size) return { ok: false, reason: "inventory-missing-session" }
  if (seenMessages.size !== expectedMessages.size) return { ok: false, reason: "inventory-missing-message" }
  return { ok: true, sessions: seenSessions.size, messages: seenMessages.size }
}

async function readRoot(port: VerifiedDeletePort, sessionID: string): Promise<Snapshot | null> {
  try {
    const session = await port.getSession(sessionID)
    const messages = await port.listMessages(sessionID)
    if (!Array.isArray(messages)) return null
    return { session, messages }
  } catch {
    return null
  }
}

async function candidateLookup(
  port: VerifiedDeletePort,
  candidateID: string,
): Promise<"absent" | "present" | "ambiguous"> {
  try {
    await port.getSession(candidateID)
    return "present"
  } catch (error) {
    return isPortNotFoundError(error) ? "absent" : "ambiguous"
  }
}

async function deletionState(port: VerifiedDeletePort, oldID: string): Promise<Exclude<DeleteState, "not-requested">> {
  try {
    await port.getSession(oldID)
    return "not-deleted"
  } catch (error) {
    return isPortNotFoundError(error) ? "deleted" : "unknown"
  }
}

async function verifyRecovery(recovery: RecoveryPort, expected: CheckpointPayload): Promise<boolean> {
  try {
    return (await recovery.verify(expected)) === true
  } catch {
    return false
  }
}

async function recoverRecovery(recovery: RecoveryPort): Promise<CheckpointPayload | null> {
  try {
    return await recovery.recover()
  } catch {
    return null
  }
}

function messageEquals(observed: ProbeMessage, expected: FlatMessage): boolean {
  return observed.id === expected.id && messageContentEquals(observed, expected)
}

function messageContentEquals(observed: ProbeMessage, expected: FlatMessage): boolean {
  return (
    observed.type === expected.type &&
    observed.text === expected.text &&
    observed.time.created === expected.time.created &&
    observed.time.completed === expected.time.completed
  )
}

function validMessageShape(message: ProbeMessage): boolean {
  return (
    isRecord(message) &&
    hasOnlyKeys(message, MESSAGE_KEYS) &&
    isMessageID(message.id) &&
    (message.type === "user" || message.type === "assistant") &&
    typeof message.text === "string" &&
    isRecord(message.time) &&
    hasOnlyKeys(message.time, MESSAGE_TIME_KEYS) &&
    finiteNumber(message.time.created) &&
    (message.time.completed === undefined || finiteNumber(message.time.completed))
  )
}

function isActive(session: ProbeSession): boolean {
  if (!isRecord(session.time)) return false
  return finiteNumber(session.time.created) && finiteNumber(session.time.updated) && !("archived" in session.time)
}

function isParentless(session: { parentID?: string | null }): boolean {
  return session.parentID === undefined || session.parentID === null
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const a = normalize(left)
  const b = normalize(right)
  const windowsPath = /^[A-Za-z]:\//.test(a) || /^[A-Za-z]:\//.test(b) || a.startsWith("//") || b.startsWith("//")
  return windowsPath ? a.toLowerCase() === b.toLowerCase() : a === b
}

function hasOnlyKeys(value: object, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function mark(result: VerifiedDeleteResult, phase: Phase): void {
  if (!result.completedPhases.includes(phase)) result.completedPhases.push(phase)
  result.phase = phase
}

function blocked(result: VerifiedDeleteResult, reason: Reason): VerifiedDeleteResult {
  result.outcome = "blocked"
  result.reason = reason
  return result
}

function failed(result: VerifiedDeleteResult, reason: Reason): VerifiedDeleteResult {
  result.outcome = "failed"
  result.reason = reason
  return result
}

function createResult(fixture: VerifiedDeleteFixture): VerifiedDeleteResult {
  const oldRoot = fixture?.oldRoot
  const candidateRoot = fixture?.candidateRoot
  const oldMessages = Array.isArray(oldRoot?.messages) ? oldRoot.messages : []
  const candidateMessages = Array.isArray(candidateRoot?.messages) ? candidateRoot.messages : []
  return {
    version: VERIFIED_DELETE_VERSION,
    phase: "preflight",
    completedPhases: [],
    outcome: "failed",
    reason: null,
    fixture: {
      oldSessionID: typeof oldRoot?.session?.id === "string" ? oldRoot.session.id : "",
      candidateSessionID: typeof candidateRoot?.session?.id === "string" ? candidateRoot.session.id : "",
      oldMessageIDs: oldMessages.map((message) => (typeof message?.id === "string" ? message.id : "")),
      candidateMessageIDs: candidateMessages.map((message) => (typeof message?.id === "string" ? message.id : "")),
    },
    counts: {
      oldMessages: EXPECTED_COUNTS.oldMessages,
      candidateMessages: EXPECTED_COUNTS.candidateMessages,
      removeCalls: 0,
      inventorySessions: 0,
      inventoryMessages: 0,
    },
    checks: {
      oldBaseline: "not-tested",
      recoveryBeforeImport: "not-tested",
      candidateAbsent: "not-tested",
      import: "not-run",
      candidateReadback: "not-tested",
      recoveryBeforeDelete: "not-tested",
      oldUnchanged: "not-tested",
      inventory: "not-tested",
      recoveryAfterDelete: "not-tested",
    },
    delete: { requested: false, state: "not-requested", removeOutcome: "not-run" },
    retained: { oldRoot: false, candidate: false },
    safety: {
      deleteCalls: 0,
      deleteTargetFrozenOldOnly: true,
      candidateDeleteCalls: 0,
      blindRetries: 0,
      casClaim: false,
      residual: "manual-quiescence-required",
      automaticRestore: false,
      inventoryScope: "isolated-host-exact",
    },
  }
}
