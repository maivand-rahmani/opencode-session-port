export const INTERACTION_OBSERVATION_VERSION = 1

export const INTERACTION_STATUSES = ["observed", "not-observed", "not-tested"] as const
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number]

export const TERMINAL_RESTORE_STATUSES = ["verified", "unverified", "failed"] as const
export type TerminalRestoreStatus = (typeof TERMINAL_RESTORE_STATUSES)[number]

export type PhaseOneObservation = {
  composerVisible: InteractionStatus
  composerFocused: InteractionStatus
  draftTypedNotSubmitted: InteractionStatus
  headNavigation: InteractionStatus
  rootNavigation: InteractionStatus
  tabFocus: InteractionStatus
  ownedStopVerified: InteractionStatus
}

export type PhaseTwoObservation = {
  manifestValid: InteractionStatus
  readbackComplete: InteractionStatus
  cacheReady: InteractionStatus
  routeReady: InteractionStatus
  ownedStopVerified: InteractionStatus
}

export type InteractionObservation = {
  version: typeof INTERACTION_OBSERVATION_VERSION
  phase1: PhaseOneObservation
  phase2: PhaseTwoObservation
  terminalRestored: TerminalRestoreStatus
  ordinaryContinuation: "not-tested"
  permissionsForms: "not-tested"
  concurrency: "not-tested"
  rawContentStored: false
}

const PHASE1_FIELDS = [
  "composerVisible",
  "composerFocused",
  "draftTypedNotSubmitted",
  "headNavigation",
  "rootNavigation",
  "tabFocus",
  "ownedStopVerified",
] as const

const PHASE2_FIELDS = ["manifestValid", "readbackComplete", "cacheReady", "routeReady", "ownedStopVerified"] as const

const FIXED_NOT_TESTED_FIELDS = ["ordinaryContinuation", "permissionsForms", "concurrency"] as const

const TOP_LEVEL_FIELDS = new Set([
  "version",
  "phase1",
  "phase2",
  "terminalRestored",
  ...FIXED_NOT_TESTED_FIELDS,
  "rawContentStored",
])

export function createInteractionObservation(): InteractionObservation {
  return {
    version: INTERACTION_OBSERVATION_VERSION,
    phase1: {
      composerVisible: "not-tested",
      composerFocused: "not-tested",
      draftTypedNotSubmitted: "not-tested",
      headNavigation: "not-tested",
      rootNavigation: "not-tested",
      tabFocus: "not-tested",
      ownedStopVerified: "not-tested",
    },
    phase2: {
      manifestValid: "not-tested",
      readbackComplete: "not-tested",
      cacheReady: "not-tested",
      routeReady: "not-tested",
      ownedStopVerified: "not-tested",
    },
    terminalRestored: "unverified",
    ordinaryContinuation: "not-tested",
    permissionsForms: "not-tested",
    concurrency: "not-tested",
    rawContentStored: false,
  }
}

export function validateInteractionObservation(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ["not-object"] }

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_FIELDS.has(key)) errors.push("unknown-field")
  }
  if (value.version !== INTERACTION_OBSERVATION_VERSION) errors.push("invalid-version")
  validatePhase(value.phase1, PHASE1_FIELDS, errors)
  validatePhase(value.phase2, PHASE2_FIELDS, errors)
  if (!isTerminalRestoreStatus(value.terminalRestored)) errors.push("invalid-terminal-status")
  for (const field of FIXED_NOT_TESTED_FIELDS) {
    if (value[field] !== "not-tested") errors.push("overclaim")
  }
  if (value.rawContentStored !== false) errors.push("raw-content-not-allowed")

  return { ok: errors.length === 0, errors: [...new Set(errors)] }
}

export function summarizeInteractionObservation(record: InteractionObservation): string[] {
  return [
    `phase1.composerVisible=${record.phase1.composerVisible}`,
    `phase1.composerFocused=${record.phase1.composerFocused}`,
    `phase1.draftTypedNotSubmitted=${record.phase1.draftTypedNotSubmitted}`,
    `phase1.headNavigation=${record.phase1.headNavigation}`,
    `phase1.rootNavigation=${record.phase1.rootNavigation}`,
    `phase1.tabFocus=${record.phase1.tabFocus}`,
    `phase1.ownedStopVerified=${record.phase1.ownedStopVerified}`,
    `phase2.manifestValid=${record.phase2.manifestValid}`,
    `phase2.readbackComplete=${record.phase2.readbackComplete}`,
    `phase2.cacheReady=${record.phase2.cacheReady}`,
    `phase2.routeReady=${record.phase2.routeReady}`,
    `phase2.ownedStopVerified=${record.phase2.ownedStopVerified}`,
    `terminalRestored=${record.terminalRestored}`,
    `ordinaryContinuation=${record.ordinaryContinuation}`,
    `permissionsForms=${record.permissionsForms}`,
    `concurrency=${record.concurrency}`,
  ]
}

function validatePhase(
  value: unknown,
  fields: readonly string[],
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push("invalid-phase")
    return
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) errors.push("unknown-field")
  }
  for (const field of fields) {
    if (!isInteractionStatus(value[field])) errors.push("invalid-status")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isInteractionStatus(value: unknown): value is InteractionStatus {
  return typeof value === "string" && (INTERACTION_STATUSES as readonly string[]).includes(value)
}

function isTerminalRestoreStatus(value: unknown): value is TerminalRestoreStatus {
  return typeof value === "string" && (TERMINAL_RESTORE_STATUSES as readonly string[]).includes(value)
}
