/**
 * CRYPTO-01 Phase A case definitions (small-only, inert harness).
 *
 * This module is deliberately side-effect free: it imports only types from the
 * product core (erased at runtime) and defines the seven A0-A6 cases, the local
 * explicit candidate definition, and synthetic fixture shapes. It never loads
 * libsodium, never creates a factory, and never performs crypto work.
 *
 * Candidate values below are borrowed, read-only inputs from the archived
 * experimental candidate (2 Argon2id ops / 128 MiB, 16-byte salt, 64 KiB
 * frames, existing 66/64/256 MiB caps, expansion ratio 128). They are NOT
 * selected V2 defaults and are NOT a production profile. The definition exists
 * only as a local allow-list entry for this diagnostic harness; it is passed to
 * the public `createCheckpointCryptoFactory` by the child at explicit runtime.
 */

import type { CryptoPolicyDefinition } from "../../../src/core/crypto/policy.ts";

export const CASE_IDS = ["A0", "A1", "A2", "A3", "A4", "A5", "A6"] as const;
export type CaseId = (typeof CASE_IDS)[number];

export type CaseKind = "baseline" | "kdf-control" | "container" | "sequential-container";
export type PasswordKind = "none" | "wrapper-passphrase" | "object-root";

export interface PhaseACase {
	readonly id: CaseId;
	readonly label: string;
	readonly kind: CaseKind;
	/** Plaintext bytes per seal operation. Zero for baseline/KDF control. */
	readonly payloadBytes: number;
	/** Number of seal+open pairs performed in one child. */
	readonly pairs: number;
	readonly passwordKind: PasswordKind;
	/** Wrapper payloads are illustrative, never a frozen V2 wrapper format. */
	readonly wrapperIllustrative: boolean;
}

export const SAMPLES_PER_CASE = 3;
export const MAX_CHILD_STARTS = CASE_IDS.length * SAMPLES_PER_CASE;
export const A0_BRIDGE_MAX_CHILD_STARTS = SAMPLES_PER_CASE;
export const A1_CONTROL_MAX_CHILD_STARTS = SAMPLES_PER_CASE;
export const A2_CONTAINER_MAX_CHILD_STARTS = SAMPLES_PER_CASE;
export const A3_A6_SMALL_MAX_CHILD_STARTS = 4 * SAMPLES_PER_CASE;
export const PHASE_A_RUN_DEADLINE_MS = 30 * 60 * 1000;
export const PHASE_A_CHILD_DEADLINE_MS = 45_000;
export const PHASE_A_CHILD_STOP_GRACE_MS = 5_000;
export const EXPECTED_LIBSODIUM_PACKAGE_VERSION = "0.8.4";

export type PhaseARunMode = "a0-bridge" | "a1-control" | "a2-container" | "a3-a6-small" | "full-phase-a";

export interface PhaseARunPlan {
	readonly mode: PhaseARunMode;
	readonly caseIds: readonly CaseId[];
	readonly samplesPerCase: number;
	readonly maxChildStarts: number;
	readonly runDeadlineMs: number;
	readonly label: string;
}

const A0_BRIDGE_CASE_IDS: readonly CaseId[] = Object.freeze(["A0"]);
const A1_CONTROL_CASE_IDS: readonly CaseId[] = Object.freeze(["A1"]);
const A2_CONTAINER_CASE_IDS: readonly CaseId[] = Object.freeze(["A2"]);
const A3_A6_SMALL_CASE_IDS: readonly CaseId[] = Object.freeze(["A3", "A4", "A5", "A6"]);
const FULL_PHASE_A_CASE_IDS: readonly CaseId[] = Object.freeze([...CASE_IDS]);

/** Explicit A0-only bridge plan. */
export const A0_BRIDGE_PLAN: PhaseARunPlan = Object.freeze({
	mode: "a0-bridge",
	caseIds: A0_BRIDGE_CASE_IDS,
	samplesPerCase: SAMPLES_PER_CASE,
	maxChildStarts: A0_BRIDGE_MAX_CHILD_STARTS,
	runDeadlineMs: PHASE_A_RUN_DEADLINE_MS,
	label: "A0-only supervised bridge",
});

/** Explicit A1-only KDF-control plan. */
export const A1_CONTROL_PLAN: PhaseARunPlan = Object.freeze({
	mode: "a1-control",
	caseIds: A1_CONTROL_CASE_IDS,
	samplesPerCase: SAMPLES_PER_CASE,
	maxChildStarts: A1_CONTROL_MAX_CHILD_STARTS,
	runDeadlineMs: PHASE_A_RUN_DEADLINE_MS,
	label: "A1-only KDF control",
});

/** Explicit A2-only container round-trip plan. */
export const A2_CONTAINER_PLAN: PhaseARunPlan = Object.freeze({
	mode: "a2-container",
	caseIds: A2_CONTAINER_CASE_IDS,
	samplesPerCase: SAMPLES_PER_CASE,
	maxChildStarts: A2_CONTAINER_MAX_CHILD_STARTS,
	runDeadlineMs: PHASE_A_RUN_DEADLINE_MS,
	label: "A2-only container round-trip",
});

/** Explicit grouped A3-A6 small-case plan. */
export const A3_A6_SMALL_PLAN: PhaseARunPlan = Object.freeze({
	mode: "a3-a6-small",
	caseIds: A3_A6_SMALL_CASE_IDS,
	samplesPerCase: SAMPLES_PER_CASE,
	maxChildStarts: A3_A6_SMALL_MAX_CHILD_STARTS,
	runDeadlineMs: PHASE_A_RUN_DEADLINE_MS,
	label: "A3-A6 small grouped cases",
});

/** Full A0-A6 planning/mock plan. The actual --run-phase-a CLI fails closed. */
export const FULL_PHASE_A_PLAN: PhaseARunPlan = Object.freeze({
	mode: "full-phase-a",
	caseIds: FULL_PHASE_A_CASE_IDS,
	samplesPerCase: SAMPLES_PER_CASE,
	maxChildStarts: MAX_CHILD_STARTS,
	runDeadlineMs: PHASE_A_RUN_DEADLINE_MS,
	label: "full A0-A6 planning/mock plan (not authorized for actual execution)",
});

/** Fail-closed plan shape validation shared by the runner and report. */
export function validatePhaseARunPlan(plan: PhaseARunPlan): string | null {
	if (plan === null || typeof plan !== "object") return "run plan must be an object";
	if (
		plan.mode !== "a0-bridge" &&
		plan.mode !== "a1-control" &&
		plan.mode !== "a2-container" &&
		plan.mode !== "a3-a6-small" &&
		plan.mode !== "full-phase-a"
	) {
		return "run plan mode is not allowed";
	}
	if (typeof plan.label !== "string" || plan.label.length === 0) return "run plan label must be non-empty";
	if (!Number.isSafeInteger(plan.samplesPerCase) || plan.samplesPerCase !== SAMPLES_PER_CASE) {
		return "run plan samplesPerCase must be 3";
	}
	if (!Number.isSafeInteger(plan.maxChildStarts) || plan.maxChildStarts < 1) {
		return "run plan maxChildStarts must be a positive integer";
	}
	if (!Number.isSafeInteger(plan.runDeadlineMs) || plan.runDeadlineMs <= 0 || plan.runDeadlineMs > PHASE_A_RUN_DEADLINE_MS) {
		return "run plan runDeadlineMs must be positive and no greater than the operational run deadline";
	}
	if (!Array.isArray(plan.caseIds) || plan.caseIds.length === 0) return "run plan caseIds must be non-empty";
	const seen = new Set<CaseId>();
	for (const caseId of plan.caseIds) {
		if (!isCaseId(caseId)) return "run plan caseIds contains an unknown case";
		if (seen.has(caseId)) return "run plan caseIds contains a duplicate";
		seen.add(caseId);
	}
	if (plan.maxChildStarts !== plan.caseIds.length * plan.samplesPerCase) {
		return "run plan maxChildStarts must equal caseIds length times samplesPerCase";
	}
	if (plan.mode === "a0-bridge") {
		if (plan.caseIds.length !== 1 || plan.caseIds[0] !== "A0") return "A0 bridge plan must contain only A0";
		if (plan.maxChildStarts !== A0_BRIDGE_MAX_CHILD_STARTS) return "A0 bridge plan must cap child starts at 3";
	} else if (plan.mode === "a1-control") {
		if (plan.caseIds.length !== 1 || plan.caseIds[0] !== "A1") return "A1 control plan must contain only A1";
		if (plan.maxChildStarts !== A1_CONTROL_MAX_CHILD_STARTS) return "A1 control plan must cap child starts at 3";
	} else if (plan.mode === "a2-container") {
		if (plan.caseIds.length !== 1 || plan.caseIds[0] !== "A2") return "A2 container plan must contain only A2";
		if (plan.maxChildStarts !== A2_CONTAINER_MAX_CHILD_STARTS) return "A2 container plan must cap child starts at 3";
	} else if (plan.mode === "a3-a6-small") {
		if (plan.caseIds.length !== 4) return "A3-A6 small plan must contain exactly four cases";
		const expected = ["A3", "A4", "A5", "A6"] as const;
		for (let index = 0; index < expected.length; index += 1) {
			if (plan.caseIds[index] !== expected[index]) return "A3-A6 small plan cases/order must be A3,A4,A5,A6";
		}
		if (plan.maxChildStarts !== A3_A6_SMALL_MAX_CHILD_STARTS) return "A3-A6 small plan must cap child starts at 12";
	} else {
		if (plan.caseIds.length !== CASE_IDS.length) return "full plan must contain all seven cases";
		for (let index = 0; index < CASE_IDS.length; index += 1) {
			if (plan.caseIds[index] !== CASE_IDS[index]) return "full plan case order/entities must match A0-A6";
		}
		if (plan.maxChildStarts !== MAX_CHILD_STARTS) return "full plan must cap child starts at 21";
		if (plan.runDeadlineMs !== PHASE_A_RUN_DEADLINE_MS) return "full plan run deadline must match the operational deadline";
	}
	return null;
}

export const CANDIDATE_POLICY_ID = "sessionport-phase-a-candidate-2ops-128mib-not-selected";
export const CANDIDATE_PROFILE_CODE = 1;
export const CANDIDATE_OPS_LIMIT = 2;
export const CANDIDATE_MEM_LIMIT_BYTES = 128 * 1024 * 1024;
export const CANDIDATE_SALT_BYTES = 16;
export const CANDIDATE_FRAME_BYTES = 64 * 1024;
export const OBJECT_ROOT_BYTES = 32;

/** Borrowed historical candidate caps, not V2 defaults and not a product budget. */
export const CANDIDATE_LIMITS = Object.freeze({
	maxPasswordBytes: 4 * 1024,
	maxArtifactBytes: 66 * 1024 * 1024,
	maxCompressedBytes: 64 * 1024 * 1024,
	maxDecompressedBytes: 256 * 1024 * 1024,
	maxExpansionRatio: 128,
});

/**
 * Local explicit allow-list definition. It is intentionally not imported from
 * `src/tui/wiring/experimental-profile.ts` and not registered anywhere.
 */
export const CANDIDATE_DEFINITION: CryptoPolicyDefinition = Object.freeze({
	id: CANDIDATE_POLICY_ID,
	profileCode: CANDIDATE_PROFILE_CODE,
	kdf: Object.freeze({
		opsLimit: CANDIDATE_OPS_LIMIT,
		memLimit: CANDIDATE_MEM_LIMIT_BYTES,
	}),
	compression: Object.freeze({ level: undefined }),
	framing: Object.freeze({ chunkBytes: CANDIDATE_FRAME_BYTES }),
	limits: CANDIDATE_LIMITS,
});

/**
 * Synthetic wrapper passphrase fixture. This is not a user password, not a
 * secret, and is never persisted or reported. A fresh byte copy is created per
 * child and best-effort cleared; no zeroization claim is made.
 */
export const WRAPPER_PASSPHRASE_FIXTURE_TEXT =
	"SessionPort Phase A synthetic wrapper passphrase fixture - not a secret";

export const PHASE_A_CASES: readonly PhaseACase[] = Object.freeze([
	Object.freeze({
		id: "A0",
		label: "process-and-sodium-baseline",
		kind: "baseline",
		payloadBytes: 0,
		pairs: 0,
		passwordKind: "none",
		wrapperIllustrative: false,
	}),
	Object.freeze({
		id: "A1",
		label: "kdf-control-2ops-128mib",
		kind: "kdf-control",
		payloadBytes: 0,
		pairs: 0,
		passwordKind: "wrapper-passphrase",
		wrapperIllustrative: false,
	}),
	Object.freeze({
		id: "A2",
		label: "root-wrapper-32-byte",
		kind: "container",
		payloadBytes: OBJECT_ROOT_BYTES,
		pairs: 1,
		passwordKind: "wrapper-passphrase",
		wrapperIllustrative: true,
	}),
	Object.freeze({
		id: "A3",
		label: "illustrative-wrapper-approximately-256-byte",
		kind: "container",
		payloadBytes: 256,
		pairs: 1,
		passwordKind: "wrapper-passphrase",
		wrapperIllustrative: true,
	}),
	Object.freeze({
		id: "A4",
		label: "small-object-1kib",
		kind: "container",
		payloadBytes: 1024,
		pairs: 1,
		passwordKind: "object-root",
		wrapperIllustrative: false,
	}),
	Object.freeze({
		id: "A5",
		label: "frame-boundary-object-64kib",
		kind: "container",
		payloadBytes: 64 * 1024,
		pairs: 1,
		passwordKind: "object-root",
		wrapperIllustrative: false,
	}),
	Object.freeze({
		id: "A6",
		label: "sequential-two-wrappers",
		kind: "sequential-container",
		payloadBytes: OBJECT_ROOT_BYTES,
		pairs: 2,
		passwordKind: "wrapper-passphrase",
		wrapperIllustrative: true,
	}),
]);

const CASE_BY_ID: ReadonlyMap<CaseId, PhaseACase> = new Map(PHASE_A_CASES.map((definition) => [definition.id, definition]));

export function isCaseId(value: unknown): value is CaseId {
	return typeof value === "string" && (CASE_IDS as readonly string[]).includes(value);
}

export function requireCase(caseId: CaseId): PhaseACase {
	const definition = CASE_BY_ID.get(caseId);
	if (definition === undefined) {
		throw new Error(`unknown Phase A case id: ${caseId}`);
	}
	return definition;
}

/** Candidate report shape sent by the child and re-checked by the parent. */
export interface CandidateReport {
	readonly id: string;
	readonly opsLimit: number;
	readonly memLimitBytes: number;
	readonly saltBytes: number;
	readonly frameBytes: number;
	readonly limits: {
		readonly maxPasswordBytes: number;
		readonly maxArtifactBytes: number;
		readonly maxCompressedBytes: number;
		readonly maxDecompressedBytes: number;
		readonly maxExpansionRatio: number;
	};
}

export function candidateReport(): CandidateReport {
	return {
		id: CANDIDATE_POLICY_ID,
		opsLimit: CANDIDATE_OPS_LIMIT,
		memLimitBytes: CANDIDATE_MEM_LIMIT_BYTES,
		saltBytes: CANDIDATE_SALT_BYTES,
		frameBytes: CANDIDATE_FRAME_BYTES,
		limits: {
			maxPasswordBytes: CANDIDATE_LIMITS.maxPasswordBytes,
			maxArtifactBytes: CANDIDATE_LIMITS.maxArtifactBytes,
			maxCompressedBytes: CANDIDATE_LIMITS.maxCompressedBytes,
			maxDecompressedBytes: CANDIDATE_LIMITS.maxDecompressedBytes,
			maxExpansionRatio: CANDIDATE_LIMITS.maxExpansionRatio,
		},
	};
}

/** Case plan shape sent by the child and re-checked by the parent. */
export interface CasePlanReport {
	readonly caseId: CaseId;
	readonly payloadBytes: number;
	readonly pairs: number;
	readonly passwordKind: PasswordKind;
}

export function casePlanReport(definition: PhaseACase): CasePlanReport {
	return {
		caseId: definition.id,
		payloadBytes: definition.payloadBytes,
		pairs: definition.pairs,
		passwordKind: definition.passwordKind,
	};
}
