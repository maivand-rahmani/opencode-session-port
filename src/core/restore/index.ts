/**
 * SessionPort V1 restore lane (Phase 3).
 *
 * Pure restore preflight/planning plus the provisional per-artifact remapped-ID
 * derivation (O-22). `planRestore` snapshots and validates the checkpoint
 * payload and local destination, applies the owner-approved canonical-duplicate
 * and reference-remap policy (O-04/O-05), rederives every message ID of every
 * session planned for import (owner clarification 2026-10-10), detects ID
 * collisions and dangling references, and returns a deterministic
 * parent-before-child import order. It performs no host call, file IO, LLM
 * call, or import; broader partial-import retry/reporting semantics remain OPEN
 * (O-06), and derived-ID runtime validation remains OPEN (OQ-24).
 */
export { planRestore, RestorePlanError } from "./planner.ts";
export type {
	PlanRestoreInput,
	RestoreClassification,
	RestorePlan,
	RestorePlanEntry,
	RestorePlanErrorCode,
	RestoreSkipReason,
} from "./planner.ts";
export { createRemappedIdDeriver, RemappedIdError } from "./identity.ts";
export type { RemappedIdDeriver, RemappedIdErrorCode, RemappedIdNamespace } from "./identity.ts";
export {
	classifyReplacement,
	fingerprintSessionRecord,
	prepareStandaloneRecord,
	ReplacementPolicyError,
	verifyImportedRecord,
} from "./replacement.ts";
export type {
	ClassifyReplacementInput,
	ImportedRecordVerification,
	ImportVerificationReason,
	ReplacementClassification,
	ReplacementCopyReason,
	ReplacementMode,
	ReplacementPolicyErrorCode,
	VerifyImportedRecordInput,
} from "./replacement.ts";
