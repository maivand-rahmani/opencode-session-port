import {
  CANDIDATE_TITLE,
  NATIVE_REPLACEMENT_VERSION,
  OLD_ROOT_TITLE,
  buildImportPayload,
  hasExactKeys,
  isMessageID,
  isRecord,
  isSessionID,
  validateFixture,
  type NativeFixture,
  type NativeImportPayload,
  type SyntheticMessage,
} from "./fixtures"

export const RESTART_MANIFEST_VERSION = 1 as const
export const RESTART_MANIFEST_LIMIT_BYTES = 8192

export const PHASES = [
  "preflight",
  "baseline-read",
  "candidate-imported",
  "candidate-verified",
  "archive-requested",
  "archive-readback",
  "list-checked",
  "unarchive-requested",
  "unarchive-readback",
  "history-verified",
  "restart-readback",
  "complete",
] as const

export type Phase = (typeof PHASES)[number]

export type Outcome =
  | "invalid-fixture"
  | "blocked"
  | "failed"
  | "api-verified"
  | "api-verified-partial"

export type ArchiveReadback = "not-tested" | "verified" | "mismatch" | "unknown" | "unsupported" | "failed"
export type ArchiveState = "active" | "archived" | "unknown"
export type ArchiveRequest = "not-run" | "accepted" | "timeout" | "error" | "unsupported"
export type ListFiltering = "not-tested" | "observed" | "not-filtering" | "unverified" | "unsupported" | "error"
export type Verification = "not-tested" | "verified" | "failed"

export type AdapterSession = {
  id: string
  parentID?: string | null
  title?: string
  projectID?: string
  location?: { directory?: string }
  /** Canonical public Session.Info shape: required created/updated, optional numeric archived. */
  time?: { created?: number; updated?: number; archived?: number | null }
}

export type AdapterMessage = {
  id: string
  type?: string
  text?: string
  time?: { created?: number; completed?: number }
  content?: readonly { type?: string; text?: string }[]
}

export type NativeReplacementAdapter = {
  importSession(payload: NativeImportPayload): Promise<{ id: string; projectID?: string }>
  getSession(sessionID: string): Promise<AdapterSession>
  listMessages(sessionID: string): Promise<readonly AdapterMessage[]>
  listSessions(input: { directory: string; archived?: boolean }): Promise<readonly AdapterSession[]>
  setArchived(sessionID: string, archived: boolean): Promise<void>
}

export class UnsupportedFeatureError extends Error {
  readonly code = "unsupported-feature"

  constructor(readonly feature: string) {
    super(`unsupported feature: ${feature}`)
    this.name = "UnsupportedFeatureError"
  }
}

export class NotFoundError extends Error {
  readonly code = "not-found"

  constructor(readonly operation: string) {
    super(`not found: ${operation}`)
    this.name = "NotFoundError"
  }
}

export class AdapterTimeoutError extends Error {
  readonly code = "adapter-timeout"

  constructor(readonly operation: string) {
    super(`adapter timeout: ${operation}`)
    this.name = "AdapterTimeoutError"
  }
}

export function isUnsupportedFeatureError(error: unknown): error is UnsupportedFeatureError {
  return (
    error instanceof UnsupportedFeatureError ||
    (isRecord(error) && error.code === "unsupported-feature")
  )
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError || (isRecord(error) && error.code === "not-found")
}

export function isAdapterTimeoutError(error: unknown): error is AdapterTimeoutError {
  return error instanceof AdapterTimeoutError || (isRecord(error) && error.code === "adapter-timeout")
}

export type PostRestartSnapshot = {
  oldRoot: AdapterSession
  candidate: AdapterSession
  oldMessages: readonly AdapterMessage[]
  candidateMessages: readonly AdapterMessage[]
}

export type RunOptions = {
  rearchive?: boolean
}

export type MutationRecord = { sessionID: string; archived: boolean }

export type NativeReplacementResult = {
  version: typeof NATIVE_REPLACEMENT_VERSION
  phase: Phase
  completedPhases: Phase[]
  candidateCreated: boolean
  outcome: Outcome
  blocker: string | null
  failure: string | null
  fixture: {
    oldRootID: string
    candidateID: string
    oldMessageIDs: string[]
    candidateMessageIDs: string[]
    expected: { oldMessages: 2; candidateMessages: 3 }
  }
  api: {
    import: "not-run" | "created" | "unexpected-root" | "failed"
    candidateLookup: "not-run" | "absent" | "present" | "ambiguous"
    oldArchiveBefore: ArchiveState
    candidateArchive: ArchiveState
    oldBaseline: Verification
    parentless: Verification
    history: Verification
    oldRootIntact: Verification
    archiveRequest: ArchiveRequest
    /** Observed immediately after the archive request/follow-up readback. */
    archiveObserved: ArchiveState
    archiveReadback: ArchiveReadback
    listFiltering: ListFiltering
    unarchiveReadback: ArchiveReadback
    oldContentRetained: Verification
    candidateRetained: Verification
    rearchiveReadback: ArchiveReadback
    restartReadback: Verification
  }
  mutations: MutationRecord[]
  /** True means this probe issued no delete for the root; it is not a live-readability claim. */
  retained: { oldRoot: boolean; candidate: boolean }
  native: {
    picker: "not-observed"
    route: "not-observed"
    composer: "not-tested"
  }
  safety: {
    deleteCalls: 0
    publicDeleteUsed: false
    candidateMutationCalls: 0
    terminalRestore: "not-proven"
    ordinaryContinuation: "not-tested"
    permissionsForms: "not-tested"
    concurrency: "not-tested"
    nativeUiInferredFromList: false
    lateEditDetected: boolean
    casClaim: false
    residual: "manual-quiescence-required"
    cleanup: "host-owned-disposable-root"
  }
  featureFlags: {
    archivedPatch: "readback-required"
    archivedListFilter: "readback-required"
    archiveReadbackSource: "session-time-archived-number-or-absent"
    nativePickerArchiveFilter: "unknown"
    nativeRoute: "unknown"
    composer: "not-tested"
  }
  /** Diagnostic-only snapshot when the old-root baseline blocks. Never used by the predicate. */
  baselineDiagnostic?: BaselineDiagnostic
}

export type RestartManifest = {
  version: typeof RESTART_MANIFEST_VERSION
  phase: Phase
  completedPhases: Phase[]
  oldRootID: string
  candidateID: string
  oldMessageIDs: string[]
  candidateMessageIDs: string[]
  expectedCounts: { oldMessages: 2; candidateMessages: 3 }
}

export async function runNativeReplacement(
  adapter: NativeReplacementAdapter,
  fixture: NativeFixture,
  options: RunOptions = {},
): Promise<NativeReplacementResult> {
  const result = createResult(fixture)
  const fixtureErrors = validateFixture(fixture)
  if (fixtureErrors.length > 0) {
    result.outcome = "invalid-fixture"
    result.failure = fixtureErrors[0] ?? "fixture-invalid"
    return result
  }

  mark(result, "preflight")

  let baseline: Snapshot
  try {
    baseline = await readRoot(adapter, fixture.oldRootID)
  } catch {
    return blocked(result, "old-root-unreadable")
  }
  result.api.oldArchiveBefore = archiveState(baseline.session)
  if (result.api.oldArchiveBefore === "archived") {
    return blocked(result, "old-root-already-archived")
  }
  if (result.api.oldArchiveBefore !== "active") {
    return blocked(result, "old-root-archive-state-unknown")
  }
  if (!oldRootMatchesBaseline(baseline, fixture)) {
    result.baselineDiagnostic = diagnoseOldRootBaseline(baseline, fixture)
    return blocked(result, "old-root-baseline-mismatch")
  }
  result.retained.oldRoot = true
  result.api.oldBaseline = "verified"
  result.api.oldRootIntact = "verified"
  mark(result, "baseline-read")

  try {
    await adapter.getSession(fixture.candidateID)
    result.api.candidateLookup = "present"
    return blocked(result, "candidate-id-present")
  } catch (error) {
    if (!isNotFoundError(error)) {
      result.api.candidateLookup = "ambiguous"
      return blocked(result, "candidate-id-lookup-ambiguous")
    }
    result.api.candidateLookup = "absent"
  }

  let imported: { id: string }
  try {
    imported = await adapter.importSession(buildImportPayload(fixture))
  } catch {
    result.api.import = "failed"
    result.failure = "import-failed"
    result.api.oldRootIntact = (await oldStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.outcome = "failed"
    return result
  }
  if (!imported || imported.id !== fixture.candidateID) {
    result.api.import = "unexpected-root"
    result.failure = "import-returned-unexpected-root"
    result.api.oldRootIntact = (await oldStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.outcome = "failed"
    return result
  }
  result.api.import = "created"
  result.candidateCreated = true
  result.retained.candidate = true
  mark(result, "candidate-imported")

  let candidate: Snapshot
  try {
    candidate = await readRoot(adapter, fixture.candidateID)
  } catch {
    result.failure = "candidate-unreadable"
    result.api.oldRootIntact = (await oldStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.outcome = "failed"
    return result
  }

  const parentless = isParentless(candidate.session)
  result.api.parentless = parentless ? "verified" : "failed"
  result.api.history = messagesMatch(fixture.candidateMessages, candidate.messages) ? "verified" : "failed"
  result.api.candidateArchive = archiveState(candidate.session)
  const candidateMetadata = candidateMetadataMatches(candidate.session, fixture)
  if (result.api.candidateArchive === "archived") {
    result.failure = "candidate-already-archived"
    result.api.oldRootIntact = (await oldStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.outcome = "failed"
    return result
  }
  if (!parentless || result.api.history !== "verified" || !candidateMetadata) {
    result.failure = !parentless
      ? "candidate-parent-present"
      : result.api.history !== "verified"
        ? "candidate-history-mismatch"
        : "candidate-metadata-mismatch"
    result.api.oldRootIntact = (await oldStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.outcome = "failed"
    return result
  }
  if (result.api.candidateArchive === "unknown") {
    result.api.oldRootIntact = (await oldStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.outcome = "api-verified-partial"
    result.blocker = "candidate-archive-state-unknown"
    return result
  }
  mark(result, "candidate-verified")

  const intactAfterImport = await oldStillMatches(adapter, fixture)
  result.api.oldRootIntact = intactAfterImport ? "verified" : "failed"
  if (!intactAfterImport) {
    result.failure = "old-root-changed-during-import"
    result.outcome = "failed"
    return result
  }

  mark(result, "archive-requested")
  result.mutations.push({ sessionID: fixture.oldRootID, archived: true })
  try {
    await adapter.setArchived(fixture.oldRootID, true)
    result.api.archiveRequest = "accepted"
  } catch (error) {
    result.api.archiveRequest = isUnsupportedFeatureError(error)
      ? "unsupported"
      : isAdapterTimeoutError(error)
        ? "timeout"
        : "error"
  }

  result.api.archiveObserved = await readArchiveState(adapter, fixture.oldRootID)
  if (result.api.archiveObserved === "archived") {
    result.api.archiveReadback = "verified"
    if (result.api.archiveRequest !== "accepted") {
      result.api.oldRootIntact = (await oldStillMatches(adapter, fixture)) ? "verified" : "not-tested"
    }
    mark(result, "archive-readback")
  } else if (result.api.archiveRequest === "unsupported") {
    result.api.archiveReadback = "unsupported"
    result.api.oldRootIntact = (await oldStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.api.candidateRetained = (await candidateStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.outcome = "blocked"
    result.blocker = "archive-transport-unsupported"
    return result
  } else if (result.api.archiveObserved === "active") {
    result.api.archiveReadback = "mismatch"
    result.api.oldRootIntact = (await oldStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.api.candidateRetained = (await candidateStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.outcome = "blocked"
    result.blocker = result.api.archiveRequest === "accepted"
      ? "archive-readback-not-verified"
      : "archive-request-error-observed-active"
    return result
  } else {
    result.api.archiveReadback = result.api.archiveRequest === "unsupported" ? "unsupported" : "unknown"
    result.api.oldRootIntact = "not-tested"
    result.api.candidateRetained = (await candidateStillMatches(adapter, fixture)) ? "verified" : "failed"
    result.outcome = "blocked"
    result.blocker = result.api.archiveRequest === "unsupported"
      ? "archive-transport-unsupported"
      : "archive-readback-unknown"
    return result
  }

  result.api.listFiltering = await checkArchivedListFiltering(adapter, fixture)
  mark(result, "list-checked")

  mark(result, "unarchive-requested")
  result.mutations.push({ sessionID: fixture.oldRootID, archived: false })
  try {
    await adapter.setArchived(fixture.oldRootID, false)
  } catch (error) {
    result.api.unarchiveReadback = isUnsupportedFeatureError(error) ? "unsupported" : "failed"
    result.failure = isUnsupportedFeatureError(error) ? null : "unarchive-request-failed"
    result.outcome = isUnsupportedFeatureError(error) ? "blocked" : "failed"
    result.blocker = isUnsupportedFeatureError(error) ? "unarchive-transport-unsupported" : null
    return result
  }

  let restored: Snapshot
  try {
    restored = await readRoot(adapter, fixture.oldRootID)
  } catch {
    result.api.unarchiveReadback = "failed"
    result.outcome = "failed"
    result.failure = "unarchive-readback-unavailable"
    return result
  }

  const restoredState = archiveState(restored.session)
  if (restoredState === "archived") {
    result.api.unarchiveReadback = "failed"
    result.api.oldContentRetained = messagesMatch(fixture.oldMessages, restored.messages) ? "verified" : "failed"
    result.outcome = "failed"
    result.failure = "unarchive-readback-not-verified"
    return result
  }
  result.api.unarchiveReadback = restoredState === "active" ? "verified" : "unknown"
  mark(result, "unarchive-readback")

  const oldFinal = messagesMatch(fixture.oldMessages, restored.messages)
  const candidateFinal = await candidateStillMatches(adapter, fixture)
  result.api.oldContentRetained = oldFinal ? "verified" : "failed"
  result.api.candidateRetained = candidateFinal ? "verified" : "failed"
  if (!oldFinal) {
    result.safety.lateEditDetected = true
    result.failure = "late-edit-detected-old-root"
    result.outcome = "failed"
    return result
  }
  if (!candidateFinal) {
    result.failure = "candidate-history-changed"
    result.outcome = "failed"
    return result
  }
  mark(result, "history-verified")

  if (result.api.unarchiveReadback !== "verified") {
    mark(result, "complete")
    result.outcome = "api-verified-partial"
    result.blocker = "unarchive-readback-not-verified"
    return result
  }

  if (options.rearchive) {
    result.mutations.push({ sessionID: fixture.oldRootID, archived: true })
    try {
      await adapter.setArchived(fixture.oldRootID, true)
      const again = await readRoot(adapter, fixture.oldRootID)
      if (archiveState(again.session) === "archived" && messagesMatch(fixture.oldMessages, again.messages)) {
        result.api.rearchiveReadback = "verified"
      } else {
        result.api.rearchiveReadback = "mismatch"
        result.failure = "rearchive-readback-not-verified"
        result.outcome = "failed"
        return result
      }
    } catch (error) {
      result.api.rearchiveReadback = isUnsupportedFeatureError(error) ? "unsupported" : "failed"
      result.failure = isUnsupportedFeatureError(error) ? null : "rearchive-request-failed"
      result.outcome = isUnsupportedFeatureError(error) ? "blocked" : "failed"
      result.blocker = isUnsupportedFeatureError(error) ? "rearchive-transport-unsupported" : null
      return result
    }
  }

  result.api.restartReadback = "not-tested"
  mark(result, "complete")

  const apiVerified =
    result.api.import === "created" &&
    result.api.oldArchiveBefore === "active" &&
    result.api.candidateArchive === "active" &&
    result.api.parentless === "verified" &&
    result.api.history === "verified" &&
    result.api.archiveReadback === "verified" &&
    result.api.unarchiveReadback === "verified" &&
    result.api.oldContentRetained === "verified" &&
    result.api.candidateRetained === "verified"

  if (!apiVerified) {
    result.outcome = "failed"
    result.failure ??= "api-verification-incomplete"
    return result
  }

  if (result.api.listFiltering === "observed") {
    result.outcome = "api-verified"
    result.blocker = null
  } else {
    result.outcome = "api-verified-partial"
    result.blocker = `list-archived-filter:${result.api.listFiltering}`
  }
  return result
}

export function createRestartManifest(result: NativeReplacementResult): RestartManifest {
  const completedPhases = result.completedPhases.includes(result.phase)
    ? [...result.completedPhases]
    : [...result.completedPhases, result.phase]
  return {
    version: RESTART_MANIFEST_VERSION,
    phase: result.phase,
    completedPhases,
    oldRootID: result.fixture.oldRootID,
    candidateID: result.fixture.candidateID,
    oldMessageIDs: [...result.fixture.oldMessageIDs],
    candidateMessageIDs: [...result.fixture.candidateMessageIDs],
    expectedCounts: { oldMessages: 2, candidateMessages: 3 },
  }
}

export function parseRestartManifest(
  text: string,
): { ok: true; manifest: RestartManifest } | { ok: false; code: string } {
  if (new TextEncoder().encode(text).byteLength > RESTART_MANIFEST_LIMIT_BYTES) {
    return { ok: false, code: "manifest-too-large" }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, code: "manifest-json-invalid" }
  }
  if (!isRecord(value)) return { ok: false, code: "manifest-shape-invalid" }
  const keys = [
    "version",
    "phase",
    "completedPhases",
    "oldRootID",
    "candidateID",
    "oldMessageIDs",
    "candidateMessageIDs",
    "expectedCounts",
  ]
  if (!hasExactKeys(value, keys)) return { ok: false, code: "manifest-shape-invalid" }
  if (value.version !== RESTART_MANIFEST_VERSION) return { ok: false, code: "manifest-version-invalid" }
  if (!isPhase(value.phase)) return { ok: false, code: "manifest-phase-invalid" }
  if (!Array.isArray(value.completedPhases) || !value.completedPhases.every(isPhase)) {
    return { ok: false, code: "manifest-phases-invalid" }
  }
  const completedPhases = value.completedPhases as Phase[]
  if (new Set(completedPhases).size !== completedPhases.length) {
    return { ok: false, code: "manifest-phases-invalid" }
  }
  const phaseIndexes = completedPhases.map((phase) => PHASES.indexOf(phase))
  if (phaseIndexes.some((index, position) => position > 0 && index <= phaseIndexes[position - 1]!)) {
    return { ok: false, code: "manifest-phases-invalid" }
  }
  if (!completedPhases.includes(value.phase)) {
    return { ok: false, code: "manifest-phases-invalid" }
  }
  if (!isSessionID(value.oldRootID) || !isSessionID(value.candidateID)) {
    return { ok: false, code: "manifest-root-invalid" }
  }
  if (value.oldRootID === value.candidateID) return { ok: false, code: "manifest-root-duplicate" }
  const oldMessageIDs = value.oldMessageIDs
  const candidateMessageIDs = value.candidateMessageIDs
  if (!isIDArray(oldMessageIDs, 2) || !isIDArray(candidateMessageIDs, 3)) {
    return { ok: false, code: "manifest-message-ids-invalid" }
  }
  const counts = value.expectedCounts
  if (
    !isRecord(counts) ||
    !hasExactKeys(counts, ["oldMessages", "candidateMessages"]) ||
    counts.oldMessages !== 2 ||
    counts.candidateMessages !== 3
  ) {
    return { ok: false, code: "manifest-counts-invalid" }
  }

  const allIDs = [
    value.oldRootID,
    value.candidateID,
    ...oldMessageIDs,
    ...candidateMessageIDs,
  ]
  if (new Set(allIDs).size !== allIDs.length) return { ok: false, code: "manifest-id-duplicate" }

  return {
    ok: true,
    manifest: {
      version: RESTART_MANIFEST_VERSION,
      phase: value.phase,
      completedPhases: [...completedPhases],
      oldRootID: value.oldRootID,
      candidateID: value.candidateID,
      oldMessageIDs: [...oldMessageIDs],
      candidateMessageIDs: [...candidateMessageIDs],
      expectedCounts: { oldMessages: 2, candidateMessages: 3 },
    },
  }
}

type Snapshot = {
  session: AdapterSession
  messages: readonly AdapterMessage[]
}

function createResult(fixture: NativeFixture): NativeReplacementResult {
  return {
    version: NATIVE_REPLACEMENT_VERSION,
    phase: "preflight",
    completedPhases: [],
    candidateCreated: false,
    outcome: "failed",
    blocker: null,
    failure: null,
    fixture: {
      oldRootID: fixture.oldRootID,
      candidateID: fixture.candidateID,
      oldMessageIDs: fixture.oldMessages.map((message) => message.id),
      candidateMessageIDs: fixture.candidateMessages.map((message) => message.id),
      expected: { oldMessages: 2, candidateMessages: 3 },
    },
    api: {
      import: "not-run",
      candidateLookup: "not-run",
      oldArchiveBefore: "unknown",
      candidateArchive: "unknown",
      oldBaseline: "not-tested",
      parentless: "not-tested",
      history: "not-tested",
      oldRootIntact: "not-tested",
      archiveRequest: "not-run",
      archiveObserved: "unknown",
      archiveReadback: "not-tested",
      listFiltering: "not-tested",
      unarchiveReadback: "not-tested",
      oldContentRetained: "not-tested",
      candidateRetained: "not-tested",
      rearchiveReadback: "not-tested",
      restartReadback: "not-tested",
    },
    mutations: [],
    retained: { oldRoot: false, candidate: false },
    native: { picker: "not-observed", route: "not-observed", composer: "not-tested" },
    safety: {
      deleteCalls: 0,
      publicDeleteUsed: false,
      candidateMutationCalls: 0,
      terminalRestore: "not-proven",
      ordinaryContinuation: "not-tested",
      permissionsForms: "not-tested",
      concurrency: "not-tested",
      nativeUiInferredFromList: false,
      lateEditDetected: false,
      casClaim: false,
      residual: "manual-quiescence-required",
      cleanup: "host-owned-disposable-root",
    },
    featureFlags: {
      archivedPatch: "readback-required",
      archivedListFilter: "readback-required",
      archiveReadbackSource: "session-time-required-plus-optional-archived",
      nativePickerArchiveFilter: "unknown",
      nativeRoute: "unknown",
      composer: "not-tested",
    },
  }
}

async function readRoot(adapter: NativeReplacementAdapter, sessionID: string): Promise<Snapshot> {
  const session = await adapter.getSession(sessionID)
  const messages = await adapter.listMessages(sessionID)
  return { session, messages }
}

export function archiveState(session: AdapterSession): ArchiveState {
  const time = session.time
  if (!isRecord(time)) return "unknown"
  if (
    typeof time.created !== "number" ||
    !Number.isFinite(time.created) ||
    typeof time.updated !== "number" ||
    !Number.isFinite(time.updated)
  ) {
    return "unknown"
  }
  if (!Object.prototype.hasOwnProperty.call(time, "archived")) return "active"
  const value = time.archived
  if (typeof value === "number" && Number.isFinite(value)) return "archived"
  return "unknown"
}

async function readArchiveState(
  adapter: NativeReplacementAdapter,
  sessionID: string,
): Promise<ArchiveState> {
  try {
    return archiveState(await adapter.getSession(sessionID))
  } catch {
    return "unknown"
  }
}

async function oldStillMatches(adapter: NativeReplacementAdapter, fixture: NativeFixture): Promise<boolean> {
  try {
    const current = await readRoot(adapter, fixture.oldRootID)
    return isParentless(current.session) && messagesMatch(fixture.oldMessages, current.messages)
  } catch {
    return false
  }
}

async function candidateStillMatches(
  adapter: NativeReplacementAdapter,
  fixture: NativeFixture,
): Promise<boolean> {
  try {
    const current = await readRoot(adapter, fixture.candidateID)
    return (
      isParentless(current.session) &&
      archiveState(current.session) === "active" &&
      candidateMetadataMatches(current.session, fixture) &&
      messagesMatch(fixture.candidateMessages, current.messages)
    )
  } catch {
    return false
  }
}

async function checkArchivedListFiltering(
  adapter: NativeReplacementAdapter,
  fixture: NativeFixture,
): Promise<ListFiltering> {
  try {
    const active = await adapter.listSessions({ directory: fixture.directory, archived: false })
    const archived = await adapter.listSessions({ directory: fixture.directory, archived: true })
    const oldInActive = active.some((session) => session.id === fixture.oldRootID)
    const oldInArchived = archived.some((session) => session.id === fixture.oldRootID)
    const candidateInActive = active.some((session) => session.id === fixture.candidateID)
    const candidateInArchived = archived.some((session) => session.id === fixture.candidateID)
    if (oldInActive || candidateInArchived) return "not-filtering"
    if (!candidateInActive) return "unverified"
    if (oldInArchived) return "observed"
    return "unverified"
  } catch (error) {
    return isUnsupportedFeatureError(error) ? "unsupported" : "error"
  }
}

export type BaselineDiagnostic = {
  checks: {
    returnedSessionID: boolean
    parentAbsent: boolean
    titleMatch: boolean
    archiveActive: boolean
    projectIDMatch: boolean
    directoryMatch: boolean
    messageCountMatch: boolean
    orderedIDsMatch: boolean
    messageRoleMatch: boolean
    userTextMatch: boolean
    assistantContentMatch: boolean
  }
  session: {
    idPresent: boolean
    idMatches: boolean
    parentFieldPresent: boolean
    titlePresent: boolean
    titleMatches: boolean
    projectIDPresent: boolean
    projectIDMatches: boolean
    directoryPresent: boolean
    directoryMatches: boolean
    archiveState: ArchiveState
  }
  messages: {
    observedCount: number
    expectedCount: number
    countOverflow: boolean
    observedRoles: string[]
    expectedRoles: string[]
    fieldPresence: Array<{
      idPresent: boolean
      typePresent: boolean
      textPresent: boolean
      contentPresent: boolean
      timeCreatedFinite: boolean
      timeCompletedFinite: boolean
      extraFieldCount: number
    }>
  }
}

const MESSAGE_FIELDS = new Set(["id", "type", "text", "time", "content"])

export function diagnoseOldRootBaseline(
  snapshot: Snapshot,
  fixture: NativeFixture,
): BaselineDiagnostic {
  const expected = fixture.oldMessages
  const observed = snapshot.messages
  const expectedByIndex = expected
  const countMatch = expected.length === observed.length
  const orderedIDsMatch =
    countMatch && expected.every((message, index) => observed[index]?.id === message.id)
  const messageRoleMatch =
    countMatch && expected.every((message, index) => observed[index]?.type === message.type)
  const userTextMatch =
    countMatch &&
    expected.every((message, index) =>
      message.type === "user" ? observed[index]?.text === message.text : true,
    )
  const assistantContentMatch =
    countMatch &&
    expected.every((message, index) => {
      if (message.type !== "assistant") return true
      const actual = observed[index]
      const expectedText = message.content?.find((part) => part.type === "text")?.text
      return (
        expectedText !== undefined &&
        typeof actual?.time?.completed === "number" &&
        Array.isArray(actual?.content) &&
        actual.content.some((part) => part.type === "text" && part.text === expectedText)
      )
    })
  const role = (value: unknown) => (value === "user" || value === "assistant" ? value : "other")
  const capped = observed.slice(0, 5)
  return {
    checks: {
      returnedSessionID: snapshot.session.id === fixture.oldRootID,
      parentAbsent: isParentless(snapshot.session),
      titleMatch: snapshot.session.title === OLD_ROOT_TITLE,
      archiveActive: archiveState(snapshot.session) === "active",
      projectIDMatch: snapshot.session.projectID === fixture.projectID,
      directoryMatch: sameDirectory(snapshot.session.location?.directory, fixture.directory),
      messageCountMatch: countMatch,
      orderedIDsMatch,
      messageRoleMatch,
      userTextMatch,
      assistantContentMatch,
    },
    session: {
      idPresent: typeof snapshot.session.id === "string",
      idMatches: snapshot.session.id === fixture.oldRootID,
      parentFieldPresent: snapshot.session.parentID !== undefined && snapshot.session.parentID !== null,
      titlePresent: typeof snapshot.session.title === "string",
      titleMatches: snapshot.session.title === OLD_ROOT_TITLE,
      projectIDPresent: typeof snapshot.session.projectID === "string",
      projectIDMatches: snapshot.session.projectID === fixture.projectID,
      directoryPresent: typeof snapshot.session.location?.directory === "string",
      directoryMatches: sameDirectory(snapshot.session.location?.directory, fixture.directory),
      archiveState: archiveState(snapshot.session),
    },
    messages: {
      observedCount: observed.length,
      expectedCount: expected.length,
      countOverflow: observed.length > capped.length,
      observedRoles: capped.map((message) => role(message.type)),
      expectedRoles: expectedByIndex.map((message) => message.type),
      fieldPresence: capped.map((message) => ({
        idPresent: typeof message.id === "string",
        typePresent: typeof message.type === "string",
        textPresent: typeof message.text === "string",
        contentPresent: Array.isArray(message.content),
        timeCreatedFinite: Number.isFinite(message.time?.created),
        timeCompletedFinite: Number.isFinite(message.time?.completed),
        extraFieldCount: Object.keys(message).filter((key) => !MESSAGE_FIELDS.has(key)).length,
      })),
    },
  }
}

function oldRootMatchesBaseline(snapshot: Snapshot, fixture: NativeFixture): boolean {
  return (
    snapshot.session.id === fixture.oldRootID &&
    isParentless(snapshot.session) &&
    archiveState(snapshot.session) === "active" &&
    snapshot.session.projectID === fixture.projectID &&
    sameDirectory(snapshot.session.location?.directory, fixture.directory) &&
    messagesMatch(fixture.oldMessages, snapshot.messages)
  )
}

function candidateMetadataMatches(session: AdapterSession, fixture: NativeFixture): boolean {
  return (
    session.id === fixture.candidateID &&
    session.title === CANDIDATE_TITLE &&
    session.projectID === fixture.projectID &&
    sameDirectory(session.location?.directory, fixture.directory)
  )
}

export function validateRestartReadback(
  snapshot: PostRestartSnapshot,
  fixture: NativeFixture,
  expectedArchived: boolean,
): { ok: true } | { ok: false; code: string } {
  if (snapshot.oldRoot.id !== fixture.oldRootID) return { ok: false, code: "restart-old-root-missing" }
  if (snapshot.oldRoot.projectID !== fixture.projectID) return { ok: false, code: "restart-old-project-mismatch" }
  if (!isParentless(snapshot.oldRoot)) return { ok: false, code: "restart-old-root-parent-present" }
  if (snapshot.candidate.id !== fixture.candidateID) return { ok: false, code: "restart-candidate-missing" }
  if (snapshot.candidate.projectID !== fixture.projectID) return { ok: false, code: "restart-candidate-project-mismatch" }
  if (!isParentless(snapshot.candidate)) return { ok: false, code: "restart-candidate-parent-present" }
  if (archiveState(snapshot.candidate) !== "active") {
    return { ok: false, code: "restart-candidate-not-active" }
  }
  const expectedState: ArchiveState = expectedArchived ? "archived" : "active"
  if (archiveState(snapshot.oldRoot) !== expectedState) {
    return { ok: false, code: "restart-archive-state-mismatch" }
  }
  if (!messagesMatch(fixture.oldMessages, snapshot.oldMessages)) {
    return { ok: false, code: "restart-old-history-mismatch" }
  }
  if (!messagesMatch(fixture.candidateMessages, snapshot.candidateMessages)) {
    return { ok: false, code: "restart-candidate-history-mismatch" }
  }
  return { ok: true }
}

function messagesMatch(
  expected: readonly SyntheticMessage[],
  observed: readonly AdapterMessage[],
): boolean {
  if (expected.length !== observed.length) return false
  return expected.every((message, index) => {
    const actual = observed[index]
    if (actual?.id !== message.id || actual.type !== message.type) return false
    if (message.type === "user") return actual.text === message.text
    const expectedText = message.content?.find((part) => part.type === "text")?.text
    if (expectedText === undefined || typeof actual.time?.completed !== "number") return false
    return (
      Array.isArray(actual.content) &&
      actual.content.some((part) => part.type === "text" && part.text === expectedText)
    )
  })
}

function isParentless(session: AdapterSession): boolean {
  return session.parentID === undefined || session.parentID === null
}

function sameDirectory(left: string | undefined, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  if (left === undefined) return false
  const a = normalize(left)
  const b = normalize(right)
  const windowsPath = /^[A-Za-z]:\//.test(a) || /^[A-Za-z]:\//.test(b) || a.startsWith("//") || b.startsWith("//")
  return windowsPath ? a.toLowerCase() === b.toLowerCase() : a === b
}

function mark(result: NativeReplacementResult, phase: Phase): void {
  if (!result.completedPhases.includes(phase)) result.completedPhases.push(phase)
  result.phase = phase
}

function blocked(result: NativeReplacementResult, blocker: string): NativeReplacementResult {
  result.outcome = "blocked"
  result.blocker = blocker
  return result
}

function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value)
}

function isIDArray(value: unknown, length: number): value is string[] {
  return Array.isArray(value) && value.length === length && value.every((item) => isMessageID(item))
}
