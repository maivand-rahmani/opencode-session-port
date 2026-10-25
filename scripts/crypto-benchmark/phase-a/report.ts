/**
 * CRYPTO-01 Phase A report assembly.
 *
 * Pure data validation/aggregation only: no I/O, no crypto, no process APIs.
 * The report deliberately reports min/median/max (never an unsupported
 * percentile from three samples), keeps baseline/incremental/lifetime working
 * set as separate labels, and never includes payload bytes, keys, salts,
 * ciphertext, digests, raw vendor error text, or retained child output.
 */

import {
	CANDIDATE_DEFINITION,
	CANDIDATE_SALT_BYTES,
	MAX_CHILD_STARTS,
	PHASE_A_CHILD_DEADLINE_MS,
	PHASE_A_CHILD_STOP_GRACE_MS,
	PHASE_A_RUN_DEADLINE_MS,
	SAMPLES_PER_CASE,
	candidateReport,
	isCaseId,
	requireCase,
	validatePhaseARunPlan,
	type CandidateReport,
	type CaseId,
	type CaseKind,
	type PhaseACase,
	type PhaseARunMode,
	type PhaseARunPlan,
	type PasswordKind,
} from "./cases.ts";
import {
	MAX_PROTOCOL_LINE_BYTES,
	isChildFailureCode,
	type ExpectedPhaseARuntime,
	type PhaseARuntimeIdentity,
	type SafeFailureCode,
} from "./protocol.ts";

export const PHASE_A_REPORT_SCHEMA = "sessionport.crypto-benchmark.phase-a.v1";

export const PHASE_A_OPERATIONAL_BOUNDS = Object.freeze({
	childDeadlineMs: PHASE_A_CHILD_DEADLINE_MS,
	childStopGraceMs: PHASE_A_CHILD_STOP_GRACE_MS,
	runDeadlineMs: PHASE_A_RUN_DEADLINE_MS,
	maxChildStarts: MAX_CHILD_STARTS,
	a0BridgeMaxChildStarts: 3,
	a0BridgeMaxChildEnvelopeMs: 3 * (PHASE_A_CHILD_DEADLINE_MS + PHASE_A_CHILD_STOP_GRACE_MS),
	a1ControlMaxChildStarts: 3,
	a1ControlMaxChildEnvelopeMs: 3 * (PHASE_A_CHILD_DEADLINE_MS + PHASE_A_CHILD_STOP_GRACE_MS),
	a2ContainerMaxChildStarts: 3,
	a2ContainerMaxChildEnvelopeMs: 3 * (PHASE_A_CHILD_DEADLINE_MS + PHASE_A_CHILD_STOP_GRACE_MS),
	a3A6SmallMaxChildStarts: 12,
	a3A6SmallMaxChildEnvelopeMs: 12 * (PHASE_A_CHILD_DEADLINE_MS + PHASE_A_CHILD_STOP_GRACE_MS),
	a3A6SmallFutureOuterTimeoutMs: 900_000,
	maxProtocolLineBytes: MAX_PROTOCOL_LINE_BYTES,
	maxRetainedStdoutBytesPerChild: 512 * 1024,
	maxRetainedStderrBytesPerChild: 512 * 1024,
	maxRetainedOutputBytesPerRun: 4 * 1024 * 1024,
	physicalMemoryPreflightBytes: 2 * 1024 * 1024 * 1024,
	physicalMemoryStopBelowBytes: 1 * 1024 * 1024 * 1024,
	memoryPollIntervalMs: 10,
});

export const PHASE_A_MAX_CHILD_ENVELOPE_MS =
	MAX_CHILD_STARTS * (PHASE_A_OPERATIONAL_BOUNDS.childDeadlineMs + PHASE_A_OPERATIONAL_BOUNDS.childStopGraceMs);

export const PHASE_A_FRESHNESS_FILES: readonly string[] = Object.freeze([
	"package.json",
	"bun.lock",
	"src/core/contracts/crypto.ts",
	"src/core/crypto/container.ts",
	"src/core/crypto/envelope.ts",
	"src/core/crypto/index.ts",
	"src/core/crypto/kdf.ts",
	"src/core/crypto/policy.ts",
	"src/core/crypto/gzip-stream.ts",
	"src/core/crypto/zero.ts",
	"scripts/crypto-benchmark/lib/winmem.ts",
	"scripts/crypto-benchmark/phase-a/protocol.ts",
	"scripts/crypto-benchmark/phase-a/cases.ts",
	"scripts/crypto-benchmark/phase-a/child.ts",
	"scripts/crypto-benchmark/phase-a/supervisor.ts",
	"scripts/crypto-benchmark/phase-a/report.ts",
	"scripts/crypto-benchmark/phase-a/phase-a.node.ts",
]);

export type PhaseAReportStatus = "completed" | "completed-with-failures" | "stopped-safety";
export type LifetimePeakSource = "post-exit-query" | "query-after-last-operation";
export type PhaseAFailurePhase =
	| "preflight"
	| "spawn"
	| "process"
	| "protocol"
	| "output"
	| "deadline"
	| "memory"
	| "sampler"
	| "cleanup"
	| "crypto"
	| "internal";

export interface PhaseAStats {
	readonly count: number;
	readonly min: number;
	readonly median: number;
	readonly max: number;
}

export interface PhaseAOperationRecord {
	readonly sealMs: number;
	readonly openMs: number;
	readonly artifactBytes: number;
	readonly roundTripMatched: boolean;
}

export interface PhaseAOperationPairSummary {
	readonly pairIndex: number;
	readonly sealMs: PhaseAStats | null;
	readonly openMs: PhaseAStats | null;
	readonly artifactBytes: PhaseAStats | null;
	readonly roundTripMatchedOperations: number;
	readonly roundTripOperationCount: number;
}

export interface PhaseASampleRecord {
	readonly caseId: CaseId;
	readonly sampleIndex: number;
	readonly childPid: number;
	readonly childExitCode: 0;
	readonly runtime: PhaseARuntimeIdentity;
	readonly baselineWorkingSetBytes: number;
	readonly sampledIncrementalWorkingSetBytes: number;
	readonly sampledPollCount: number;
	readonly samplingSpanMs: number;
	readonly lifetimePeakWorkingSetBytes: number;
	readonly lifetimePeakSource: LifetimePeakSource;
	readonly termination: "owned-child-exit-verified";
	readonly operations: readonly PhaseAOperationRecord[];
	readonly kdfControlMs: number | null;
}

export interface PhaseAFailureRecord {
	readonly caseId: CaseId | null;
	readonly sampleIndex: number | null;
	readonly code: SafeFailureCode;
	readonly phase: PhaseAFailurePhase;
}

export interface PhaseAFreshnessEntry {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

export interface PhaseAMemoryObservation {
	readonly preflightRequiredBytes: number;
	readonly stopBelowBytes: number;
	readonly source: string;
	readonly observedBeforeRunBytes: number;
	readonly observedMinimumDuringRunBytes: number;
	readonly physicalMemoryReadFailures: number;
}

export interface PhaseALibsodiumEvidence {
	readonly packageName: string;
	readonly expectedVersion: string;
	readonly installed: {
		readonly version: string;
		readonly resolvedPackageJsonPath: string;
		readonly packageJsonBytes: number;
		readonly packageJsonSha256: string;
		readonly installedBytesIntegrityVerified: false;
	};
	readonly lock: {
		readonly path: "bun.lock";
		readonly entryFound: boolean;
		readonly resolvedVersion: string | null;
		readonly integrity: string | null;
		readonly integrityKind: "lock-metadata";
		readonly installedBytesVerified: false;
	};
	readonly versionMatchesLock: boolean;
	readonly note: string;
}

export interface PhaseACaseSummary {
	readonly caseId: CaseId;
	readonly label: string;
	readonly kind: CaseKind;
	readonly payloadBytes: number;
	readonly pairs: number;
	readonly passwordKind: PasswordKind;
	readonly wrapperIllustrative: boolean;
	readonly samplesPlanned: number;
	readonly samplesCompleted: number;
	readonly samplesFailed: number;
	readonly sealMs: PhaseAStats | null;
	readonly openMs: PhaseAStats | null;
	readonly kdfControlMs: PhaseAStats | null;
	readonly artifactBytes: PhaseAStats | null;
	readonly roundTripMatchedOperations: number;
	readonly roundTripOperationCount: number;
	readonly operationPairs: readonly PhaseAOperationPairSummary[];
	readonly memory: {
		readonly baselineWorkingSetBytes: PhaseAStats | null;
		readonly sampledIncrementalWorkingSetBytes: PhaseAStats | null;
		readonly lifetimePeakWorkingSetBytes: PhaseAStats | null;
	};
}

export interface PhaseAReportInput {
	readonly generatedAtIso: string;
	readonly status: PhaseAReportStatus;
	readonly plan: PhaseARunPlan;
	readonly attemptedSamples: number;
	readonly childStarts: number;
	readonly stoppedBySafety: boolean;
	readonly retainedOutputBytes: number;
	readonly runtime: {
		readonly expected: ExpectedPhaseARuntime;
		readonly parent: ExpectedPhaseARuntime;
		readonly children: readonly PhaseARuntimeIdentity[];
	};
	readonly freshness: {
		readonly algorithm: "sha256";
		readonly capturedAtIso: string;
		readonly files: readonly PhaseAFreshnessEntry[];
	};
	readonly libsodium: PhaseALibsodiumEvidence;
	readonly memory: PhaseAMemoryObservation;
	readonly samples: readonly PhaseASampleRecord[];
	readonly failures: readonly PhaseAFailureRecord[];
}

export interface PhaseAReport {
	readonly schema: typeof PHASE_A_REPORT_SCHEMA;
	readonly generatedAtIso: string;
	readonly diagnosticOnly: true;
	readonly profileSelected: false;
	readonly formatFrozen: false;
	readonly phaseBExecuted: false;
	readonly crypto01Passed: false;
	readonly status: PhaseAReportStatus;
	readonly runCompleted: boolean;
	readonly stoppedBySafety: boolean;
	readonly attemptedSamples: number;
	readonly harness: {
		readonly phase: "A";
		readonly mode: PhaseARunMode;
		readonly label: string;
		readonly caseIds: readonly CaseId[];
		readonly samplesPerCase: number;
		readonly maxChildStarts: number;
		readonly runDeadlineMs: number;
		readonly oneChildAtATime: true;
		readonly retries: false;
		readonly fullPhaseAReviewRequired: true;
	};
	readonly coverage: {
		readonly a0Executed: boolean;
		readonly a1ControlExecuted: boolean;
		readonly a2ContainerExecuted: boolean;
		readonly a2ToA6Executed: boolean;
		readonly a3ToA6Executed: boolean;
		readonly a1ToA6Executed: boolean;
		readonly kdfControlExecuted: boolean;
		readonly containerSealOpenExecuted: boolean;
	};
	readonly candidate: CandidateReport & {
		readonly notSelected: true;
		readonly wrapperPayloadsIllustrative: true;
		readonly note: string;
	};
	readonly runtime: PhaseAReportInput["runtime"];
	readonly bounds: typeof PHASE_A_OPERATIONAL_BOUNDS & {
		readonly maxChildEnvelopeMs: number;
		readonly planMaxChildEnvelopeMs: number;
		readonly maxChildEnvelopeFitsRunDeadline: true;
	};
	readonly freshness: PhaseAReportInput["freshness"];
	readonly libsodium: PhaseALibsodiumEvidence;
	readonly memory: PhaseAMemoryObservation;
	readonly methodology: {
		readonly freshChildPerSample: true;
		readonly sequential: true;
		readonly noRetries: true;
		readonly noResume: true;
		readonly noEscalation: true;
		readonly timingScope: string;
		readonly memoryScope: string;
		readonly roundTripScope: string;
		readonly dataHandling: string;
		readonly supervision: string;
		readonly outputScope: string;
	};
	readonly limitations: readonly string[];
	readonly aggregate: {
		readonly memory: PhaseACaseSummary["memory"];
		readonly sealMs: PhaseAStats | null;
		readonly openMs: PhaseAStats | null;
		readonly kdfControlMs: PhaseAStats | null;
	};
	readonly cases: readonly PhaseACaseSummary[];
	readonly samples: readonly PhaseASampleRecord[];
	readonly failures: readonly PhaseAFailureRecord[];
	readonly summary: {
		readonly plannedSamples: number;
		readonly attemptedSamples: number;
		readonly completedSamples: number;
		readonly failedSamples: number;
		readonly failureRecords: number;
		readonly childStarts: number;
		readonly stoppedBySafety: boolean;
		readonly roundTripMatchedOperations: number;
		readonly roundTripOperationCount: number;
		readonly retainedOutputBytes: number;
	};
}

export const PHASE_A_LIMITATIONS: readonly string[] = Object.freeze([
	"Diagnostic Phase A output only. CRYPTO-01 remains not passed; no crypto profile, cap, format, or product memory budget is selected or frozen, and no Phase B work is included.",
	"Three fresh child samples per case are a probe, not a statistical basis. Only min/median/max are reported; no production performance, minimum-device, or support claim follows.",
	"Candidate values (2 Argon2id ops, 128 MiB KDF memory parameter, 16-byte salt, 64 KiB frames, borrowed 66/64/256 MiB caps, ratio 128) are gate inputs, not V2 defaults. The 128 MiB value is the Argon2 memory parameter, not a process memory budget.",
	"Memory labels are separate and must not be collapsed: baseline working set, sampled incremental working-set delta, and process lifetime peak. None is private/commit memory, heap, or a product cap.",
	"Working-set values are physical residency sampled by the parent through Windows GetProcessMemoryInfo. Sampling is best-effort, the parent can miss short peaks, and no hard memory containment or Job Object limit exists.",
	"Timing scope: seal duration covers awaiting and fully consuming the sealed async byte source in memory; open duration covers the complete openAndStage call; the A1 control times only the synchronous crypto_pwhash call. Startup, READY, artifact writing, and reporting are excluded.",
	"The KDF is synchronous and blocks the child event loop. The Promise API does not make it nonblocking and provides no cancellation inside the child; a blocked child is terminated only by the parent deadline.",
	"Round-trip verification is an in-memory boolean byte-equality check only. Payload bytes, keys, salts, ciphertext, digests, artifact identities, and raw vendor error text are never reported or persisted.",
	"All fixtures are synthetic and in-memory. Best-effort clearing is performed, but no zeroization, secure-deletion, or memory-erasure guarantee is made.",
	"Wrapper payload sizes are illustrative only and are not a frozen V2 wrapper format or header/layout claim.",
	"Compressed gzip byte counts and frame counts are not exposed by the public container contract and are not reported. Only the total artifact byte count observed while consuming the sealed source is recorded.",
	"Results describe one Windows host and the exact Bun 1.3.10 runtime only. Node unit tests do not prove Bun measurements, and no macOS/Linux, Node-runtime, OpenCode plugin-runtime, or cross-platform claim follows.",
	"Process supervision terminates only the owned spawned child handle and verifies its exit. There is no arbitrary-PID kill, no Job Object, and no reviewed descendant-tree termination proof; termination uncertainty stops the run without success.",
	"The A0-only bridge is source-prepared, not authorized or executed by this report builder. Full --run-phase-a actual execution is fail-closed pending independent exact-source review and explicit safety GO. No CRYPTO-01 pass is implied.",
	"libsodium evidence is resolved package.json metadata plus a matching bun.lock entry only. Lock integrity is metadata; installed/extracted bytes and archive hashes were not verified, and a version string is not an integrity proof. No historical-baseline comparison is claimed.",
	"Physical-memory read failures during a monitored interval stop the run and are counted. Successful samples do not prove uninterrupted monitoring; parent sampling remains best-effort and can miss intervals/peaks.",
	"A1 control measures only one existing synchronous crypto_pwhash call per fresh child at the borrowed candidate values (2 ops / 128 MiB, 16-byte salt, 32-byte output). It does not import the public container, call seal/open, select a product profile, or provide historical comparability. Raw samples and min/median/max only; no unsupported percentile.",
	"A2 container measures one synthetic 32-byte plaintext seal/open round trip per fresh child through the existing public factory and local candidate. The two KDF passes inside seal/open are container cost, not the direct A1 KDF-control measurement. Artifact-only size is reported; compressed/frame counts are not invented. No production wrapper format or historical comparability is claimed.",
	"Grouped A3-A6 selects A3/A4/A5/A6 only. A5's 64 KiB object is a payload-size input, not a claim of one encrypted frame; compressed and frame counts are not exposed by the public core and are not invented. A6 records two within-process seal/open pairs per child (four internal container KDF derivations); operationPairs exposes pairIndex summaries (n=3 per pair), while the case-level 6-operation aggregate is operation-level and not six independent child samples. Memory is per child, not per pair; no reclamation/retention inference is made.",
	"Future grouped outer-wrapper planning timeout 900,000 ms is an operational planning label for 12 children, not a product budget or execution authorization.",
	"sampledIncrementalWorkingSetBytes is a boundary delta (max sampled/end-of-operation working set minus baseline). With zero periodic polls it is a boundary observation, not a sampled time-series peak. sampledPollCount and samplingSpanMs are reported to make that distinction visible.",
	"Partial secret-redaction limits remain: this harness does not intentionally emit payload/key/salt/ciphertext/digest/error text, but general redaction of arbitrary runtime error strings is not proven and no broad redaction guarantee is claimed.",
	"No network, database, host, keychain, account, Git, install, or file-output operation is part of this harness.",
]);

export function computePhaseAStats(values: readonly number[]): PhaseAStats | null {
	if (!Array.isArray(values)) {
		throw new Error("computePhaseAStats requires an array");
	}
	if (values.length === 0) return null;
	for (const value of values) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error("computePhaseAStats requires finite, non-negative numbers");
		}
	}
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
	return {
		count: sorted.length,
		min: sorted[0]!,
		median,
		max: sorted[sorted.length - 1]!,
	};
}

function assertNonNegativeSafeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function assertPositiveSafeInteger(value: unknown, label: string): number {
	const parsed = assertNonNegativeSafeInteger(value, label);
	if (parsed === 0) throw new Error(`${label} must be positive`);
	return parsed;
}

function assertNonNegativeFinite(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a finite, non-negative number`);
	}
	return value;
}

function assertIsoTimestamp(value: string, label: string): void {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
		throw new Error(`${label} must be an ISO timestamp`);
	}
}

function assertRuntimeIdentity(value: PhaseARuntimeIdentity, label: string): void {
	for (const key of ["bun", "nodeCompat", "platform", "arch", "libsodiumVersion"] as const) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			throw new Error(`${label}.${key} must be a non-empty string`);
		}
	}
}

function assertOperation(value: PhaseAOperationRecord, label: string): void {
	assertNonNegativeFinite(value.sealMs, `${label}.sealMs`);
	assertNonNegativeFinite(value.openMs, `${label}.openMs`);
	assertPositiveSafeInteger(value.artifactBytes, `${label}.artifactBytes`);
	if (typeof value.roundTripMatched !== "boolean") throw new Error(`${label}.roundTripMatched must be a boolean`);
}

function assertSample(value: PhaseASampleRecord): void {
	if (!isCaseId(value.caseId)) throw new Error("sample.caseId is not a Phase A case");
	const definition = requireCase(value.caseId);
	assertNonNegativeSafeInteger(value.sampleIndex, "sample.sampleIndex");
	if (value.sampleIndex >= SAMPLES_PER_CASE) throw new Error("sample.sampleIndex exceeds the per-case sample count");
	assertPositiveSafeInteger(value.childPid, "sample.childPid");
	if (value.childExitCode !== 0) throw new Error("sample.childExitCode must be zero for a completed sample");
	assertRuntimeIdentity(value.runtime, "sample.runtime");
	assertNonNegativeSafeInteger(value.baselineWorkingSetBytes, "sample.baselineWorkingSetBytes");
	assertNonNegativeSafeInteger(
		value.sampledIncrementalWorkingSetBytes,
		"sample.sampledIncrementalWorkingSetBytes",
	);
	assertNonNegativeSafeInteger(value.sampledPollCount, "sample.sampledPollCount");
	assertNonNegativeFinite(value.samplingSpanMs, "sample.samplingSpanMs");
	assertNonNegativeSafeInteger(value.lifetimePeakWorkingSetBytes, "sample.lifetimePeakWorkingSetBytes");
	if (value.lifetimePeakSource !== "post-exit-query" && value.lifetimePeakSource !== "query-after-last-operation") {
		throw new Error("sample.lifetimePeakSource is not allowed");
	}
	if (value.termination !== "owned-child-exit-verified") {
		throw new Error("sample.termination is not an accepted verified value");
	}
	if (!Array.isArray(value.operations)) throw new Error("sample.operations must be an array");
	for (const [index, operation] of value.operations.entries()) {
		assertOperation(operation, `sample.operations[${index}]`);
	}

	if (definition.id === "A0") {
		if (value.operations.length !== 0 || value.kdfControlMs !== null) {
			throw new Error("A0 must not carry operation or KDF timings");
		}
	} else if (definition.id === "A1") {
		if (value.operations.length !== 0) throw new Error("A1 must not carry container operations");
		assertNonNegativeFinite(value.kdfControlMs, "sample.kdfControlMs");
	} else {
		if (value.kdfControlMs !== null) throw new Error("container cases must not carry kdfControlMs");
		if (value.operations.length !== definition.pairs) {
			throw new Error(`sample ${definition.id} must carry exactly ${definition.pairs} operation(s)`);
		}
	}
}

function assertLibsodiumEvidence(evidence: PhaseALibsodiumEvidence): void {
	if (typeof evidence.packageName !== "string" || evidence.packageName.length === 0) {
		throw new Error("libsodium.packageName must be non-empty");
	}
	if (typeof evidence.expectedVersion !== "string" || evidence.expectedVersion.length === 0) {
		throw new Error("libsodium.expectedVersion must be non-empty");
	}
	if (typeof evidence.installed.version !== "string" || evidence.installed.version.length === 0) {
		throw new Error("libsodium.installed.version must be non-empty");
	}
	if (typeof evidence.installed.resolvedPackageJsonPath !== "string" || evidence.installed.resolvedPackageJsonPath.length === 0) {
		throw new Error("libsodium.installed.resolvedPackageJsonPath must be non-empty");
	}
	assertNonNegativeSafeInteger(evidence.installed.packageJsonBytes, "libsodium.installed.packageJsonBytes");
	if (!/^[0-9a-f]{64}$/.test(evidence.installed.packageJsonSha256)) {
		throw new Error("libsodium.installed.packageJsonSha256 must be 64 lowercase hex");
	}
	if (evidence.installed.installedBytesIntegrityVerified !== false) {
		throw new Error("libsodium installed-bytes integrity must remain unverified");
	}
	if (evidence.lock.path !== "bun.lock") throw new Error("libsodium.lock.path must be bun.lock");
	if (typeof evidence.lock.entryFound !== "boolean") throw new Error("libsodium.lock.entryFound must be boolean");
	if (evidence.lock.resolvedVersion !== null && typeof evidence.lock.resolvedVersion !== "string") {
		throw new Error("libsodium.lock.resolvedVersion must be string or null");
	}
	if (evidence.lock.integrity !== null && typeof evidence.lock.integrity !== "string") {
		throw new Error("libsodium.lock.integrity must be string or null");
	}
	if (evidence.lock.integrityKind !== "lock-metadata") throw new Error("libsodium.lock.integrityKind must be lock-metadata");
	if (evidence.lock.installedBytesVerified !== false) throw new Error("libsodium lock bytes must remain unverified");
	if (typeof evidence.versionMatchesLock !== "boolean") throw new Error("libsodium.versionMatchesLock must be boolean");
	if (typeof evidence.note !== "string" || evidence.note.length === 0) throw new Error("libsodium.note must be non-empty");
	if (evidence.expectedVersion !== evidence.installed.version) {
		throw new Error("libsodium expected version does not match the installed package version");
	}
	if (!evidence.lock.entryFound || evidence.lock.resolvedVersion === null) {
		throw new Error("libsodium lock entry is missing");
	}
	if (evidence.lock.resolvedVersion !== evidence.installed.version) {
		throw new Error("libsodium lock version does not match the installed package version");
	}
	if (evidence.lock.integrity === null || !evidence.lock.integrity.startsWith("sha512-")) {
		throw new Error("libsodium lock integrity metadata is missing or malformed");
	}
	if (evidence.versionMatchesLock !== true) {
		throw new Error("libsodium versionMatchesLock must be true");
	}
}

function assertPlan(plan: PhaseARunPlan): void {
	const error = validatePhaseARunPlan(plan);
	if (error !== null) throw new Error(error);
}

function assertFailure(value: PhaseAFailureRecord): void {
	if (!isChildFailureCode(value.code)) {
		const operationalCodes: readonly SafeFailureCode[] = [
			"invalid-run-plan",
			"preflight-runtime",
			"preflight-memory",
			"preflight-hash",
			"preflight-sampler",
			"preflight-libsodium-metadata",
			"spawn-failed",
			"stdin-failed",
			"launch-guard-failed",
			"child-deadline",
			"run-deadline",
			"child-exit-early",
			"child-exit-nonzero",
			"child-exit-timeout",
			"cleanup-uncertain",
			"protocol-invalid",
			"protocol-case-mismatch",
			"protocol-runtime-mismatch",
			"protocol-candidate-mismatch",
			"protocol-order",
			"protocol-duplicate",
			"protocol-missing-ready",
			"protocol-missing-completion",
			"protocol-line-overflow",
			"output-overflow",
			"run-output-overflow",
			"memory-stop",
			"memory-observability-failed",
			"sampler-failed",
			"internal",
		];
		if (!operationalCodes.includes(value.code)) throw new Error("failure.code is not an allowed safe code");
	}
	const phases: readonly PhaseAFailurePhase[] = [
		"preflight",
		"spawn",
		"process",
		"protocol",
		"output",
		"deadline",
		"memory",
		"sampler",
		"cleanup",
		"crypto",
		"internal",
	];
	if (!phases.includes(value.phase)) throw new Error("failure.phase is not allowed");
	if (value.caseId !== null) {
		if (!isCaseId(value.caseId)) throw new Error("failure.caseId is not a Phase A case");
		if (value.sampleIndex === null || !Number.isSafeInteger(value.sampleIndex) || value.sampleIndex < 0 || value.sampleIndex >= SAMPLES_PER_CASE) {
			throw new Error("failure.sampleIndex is invalid");
		}
	}
	if (value.caseId === null && value.sampleIndex !== null) {
		throw new Error("a preflight/case-less failure must not carry a sample index");
	}
}

function assertFreshness(files: readonly PhaseAFreshnessEntry[]): void {
	if (!Array.isArray(files) || files.length === 0) throw new Error("freshness.files must be a non-empty array");
	if (files.length !== PHASE_A_FRESHNESS_FILES.length) {
		throw new Error("freshness.files must contain the exact Phase A freshness path set");
	}
	const expected = new Set(PHASE_A_FRESHNESS_FILES);
	const seen = new Set<string>();
	for (const entry of files) {
		if (typeof entry.path !== "string" || entry.path.length === 0) throw new Error("freshness path must be non-empty");
		if (!expected.has(entry.path)) throw new Error(`unexpected freshness path: ${entry.path}`);
		if (seen.has(entry.path)) throw new Error(`duplicate freshness path: ${entry.path}`);
		seen.add(entry.path);
		assertNonNegativeSafeInteger(entry.bytes, `freshness.${entry.path}.bytes`);
		if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`freshness.${entry.path}.sha256 must be 64 lowercase hex`);
	}
}

function caseSummary(
	definition: PhaseACase,
	samples: readonly PhaseASampleRecord[],
	failures: readonly PhaseAFailureRecord[],
): PhaseACaseSummary {
	const caseSamples = samples.filter((sample) => sample.caseId === definition.id);
	const operations = caseSamples.flatMap((sample) => sample.operations);
	const operationPairs: PhaseAOperationPairSummary[] = Array.from(
		{ length: definition.pairs },
		(_, pairIndex) => {
			const pairOperations = caseSamples
				.map((sample) => sample.operations[pairIndex])
				.filter((operation): operation is PhaseAOperationRecord => operation !== undefined);
			return {
				pairIndex,
				sealMs: computePhaseAStats(pairOperations.map((operation) => operation.sealMs)),
				openMs: computePhaseAStats(pairOperations.map((operation) => operation.openMs)),
				artifactBytes: computePhaseAStats(pairOperations.map((operation) => operation.artifactBytes)),
				roundTripMatchedOperations: pairOperations.filter((operation) => operation.roundTripMatched).length,
				roundTripOperationCount: pairOperations.length,
			};
		},
	);
	const failureKeys = new Set<string>();
	for (const failure of failures) {
		if (failure.caseId === definition.id && failure.sampleIndex !== null) {
			failureKeys.add(`${failure.sampleIndex}`);
		}
	}
	return {
		caseId: definition.id,
		label: definition.label,
		kind: definition.kind,
		payloadBytes: definition.payloadBytes,
		pairs: definition.pairs,
		passwordKind: definition.passwordKind,
		wrapperIllustrative: definition.wrapperIllustrative,
		samplesPlanned: SAMPLES_PER_CASE,
		samplesCompleted: caseSamples.length,
		samplesFailed: failureKeys.size,
		sealMs: computePhaseAStats(operations.map((operation) => operation.sealMs)),
		openMs: computePhaseAStats(operations.map((operation) => operation.openMs)),
		kdfControlMs: computePhaseAStats(
			caseSamples
				.map((sample) => sample.kdfControlMs)
				.filter((value): value is number => value !== null),
		),
		artifactBytes: computePhaseAStats(operations.map((operation) => operation.artifactBytes)),
		roundTripMatchedOperations: operations.filter((operation) => operation.roundTripMatched).length,
		roundTripOperationCount: operations.length,
		operationPairs,
		memory: {
			baselineWorkingSetBytes: computePhaseAStats(
				caseSamples.map((sample) => sample.baselineWorkingSetBytes),
			),
			sampledIncrementalWorkingSetBytes: computePhaseAStats(
				caseSamples.map((sample) => sample.sampledIncrementalWorkingSetBytes),
			),
			lifetimePeakWorkingSetBytes: computePhaseAStats(
				caseSamples.map((sample) => sample.lifetimePeakWorkingSetBytes),
			),
		},
	};
}

export function buildPhaseAReport(input: PhaseAReportInput): PhaseAReport {
	assertIsoTimestamp(input.generatedAtIso, "generatedAtIso");
	assertPlan(input.plan);
	assertIsoTimestamp(input.freshness.capturedAtIso, "freshness.capturedAtIso");
	if (input.freshness.algorithm !== "sha256") throw new Error("freshness.algorithm must be sha256");
	assertFreshness(input.freshness.files);
	assertLibsodiumEvidence(input.libsodium);
	assertNonNegativeSafeInteger(input.attemptedSamples, "attemptedSamples");
	if (input.attemptedSamples > input.plan.maxChildStarts) throw new Error("attemptedSamples exceeds the run plan cap");
	assertNonNegativeSafeInteger(input.childStarts, "childStarts");
	if (input.childStarts > input.plan.maxChildStarts) throw new Error("childStarts exceeds the run plan cap");
	assertNonNegativeSafeInteger(input.retainedOutputBytes, "retainedOutputBytes");
	if (input.retainedOutputBytes > PHASE_A_OPERATIONAL_BOUNDS.maxRetainedOutputBytesPerRun) {
		throw new Error("retainedOutputBytes exceeds the run retained-output budget");
	}
	assertNonNegativeSafeInteger(input.memory.preflightRequiredBytes, "memory.preflightRequiredBytes");
	assertNonNegativeSafeInteger(input.memory.stopBelowBytes, "memory.stopBelowBytes");
	assertNonNegativeSafeInteger(input.memory.observedBeforeRunBytes, "memory.observedBeforeRunBytes");
	assertNonNegativeSafeInteger(input.memory.observedMinimumDuringRunBytes, "memory.observedMinimumDuringRunBytes");
	assertNonNegativeSafeInteger(input.memory.physicalMemoryReadFailures, "memory.physicalMemoryReadFailures");
	if (typeof input.memory.source !== "string" || input.memory.source.length === 0) {
		throw new Error("memory.source must be non-empty");
	}
	for (const key of ["bun", "nodeCompat", "platform", "arch"] as const) {
		if (typeof input.runtime.expected[key] !== "string" || input.runtime.expected[key].length === 0) {
			throw new Error(`runtime.expected.${key} must be non-empty`);
		}
		if (typeof input.runtime.parent[key] !== "string" || input.runtime.parent[key].length === 0) {
			throw new Error(`runtime.parent.${key} must be non-empty`);
		}
	}
	for (const [index, runtime] of input.runtime.children.entries()) {
		assertRuntimeIdentity(runtime, `runtime.children[${index}]`);
	}
	if (!Array.isArray(input.samples) || !Array.isArray(input.failures)) {
		throw new Error("samples and failures must be arrays");
	}
	const plannedCases = new Set<CaseId>(input.plan.caseIds);

	const sampleKeys = new Set<string>();
	for (const sample of input.samples) {
		assertSample(sample);
		if (!plannedCases.has(sample.caseId)) throw new Error(`sample case ${sample.caseId} is not in the run plan`);
		const key = `${sample.caseId}:${sample.sampleIndex}`;
		if (sampleKeys.has(key)) throw new Error(`duplicate sample key: ${key}`);
		sampleKeys.add(key);
	}
	for (const failure of input.failures) {
		assertFailure(failure);
		if (failure.caseId !== null && !plannedCases.has(failure.caseId)) {
			throw new Error(`failure case ${failure.caseId} is not in the run plan`);
		}
	}

	const uniqueFailureKeys = new Set<string>();
	for (const failure of input.failures) {
		if (failure.caseId !== null && failure.sampleIndex !== null) {
			uniqueFailureKeys.add(`${failure.caseId}:${failure.sampleIndex}`);
		}
	}
	const failedSamples = uniqueFailureKeys.size;
	if (!input.stoppedBySafety) {
		const covered = new Set<string>([...sampleKeys, ...uniqueFailureKeys]);
		if (covered.size !== input.attemptedSamples) {
			throw new Error("each attempted sample must have exactly one completed sample or failure record");
		}
	}
	if (input.stoppedBySafety) {
		if (input.status !== "stopped-safety") throw new Error("stoppedBySafety requires stopped-safety status");
	} else if (input.attemptedSamples === input.plan.maxChildStarts) {
		if (failedSamples === 0 && input.status !== "completed") {
			throw new Error("a full plan without failures must use completed status");
		}
		if (failedSamples > 0 && input.status !== "completed-with-failures") {
			throw new Error("a full plan with failures must use completed-with-failures status");
		}
	} else {
		throw new Error("an incomplete run plan must be stopped-safety");
	}
	if (input.status === "completed" && input.failures.length !== 0) {
		throw new Error("completed status requires zero failures");
	}

	const summaries = input.plan.caseIds.map((caseId) =>
		caseSummary(requireCase(caseId), input.samples, input.failures),
	);
	const allOperations = input.samples.flatMap((sample) => sample.operations);
	const allCaseSamples = input.samples;
	const roundTripMatchedOperations = allOperations.filter((operation) => operation.roundTripMatched).length;
	const runCompleted = input.attemptedSamples === input.plan.maxChildStarts && !input.stoppedBySafety;
	const candidate = candidateReport();
	const a1ControlExecuted = input.samples.some(
		(sample) => sample.caseId === "A1" && typeof sample.kdfControlMs === "number",
	);
	const a2ContainerExecuted = input.samples.some(
		(sample) => sample.caseId === "A2" && sample.operations.length > 0,
	);
	const a3ToA6Executed = input.samples.some(
		(sample) => sample.caseId === "A3" || sample.caseId === "A4" || sample.caseId === "A5" || sample.caseId === "A6",
	);
	const a2ToA6Executed = a2ContainerExecuted || a3ToA6Executed;
	const kdfControlExecuted = a1ControlExecuted;
	const containerSealOpenExecuted = input.samples.some(
		(sample) =>
			(sample.caseId === "A2" || sample.caseId === "A3" || sample.caseId === "A4" || sample.caseId === "A5" || sample.caseId === "A6") &&
			sample.operations.length > 0,
	);

	return {
		schema: PHASE_A_REPORT_SCHEMA,
		generatedAtIso: input.generatedAtIso,
		diagnosticOnly: true,
		profileSelected: false,
		formatFrozen: false,
		phaseBExecuted: false,
		crypto01Passed: false,
		status: input.status,
		runCompleted,
		stoppedBySafety: input.stoppedBySafety,
		attemptedSamples: input.attemptedSamples,
		harness: {
			phase: "A",
			mode: input.plan.mode,
			label: input.plan.label,
			caseIds: [...input.plan.caseIds],
			samplesPerCase: input.plan.samplesPerCase,
			maxChildStarts: input.plan.maxChildStarts,
			runDeadlineMs: input.plan.runDeadlineMs,
			oneChildAtATime: true,
			retries: false,
			fullPhaseAReviewRequired: true,
		},
		coverage: {
			a0Executed: input.samples.some((sample) => sample.caseId === "A0"),
			a1ControlExecuted,
			a2ContainerExecuted,
			a2ToA6Executed,
			a3ToA6Executed,
			a1ToA6Executed: a1ControlExecuted || a2ToA6Executed,
			kdfControlExecuted,
			containerSealOpenExecuted,
		},
		candidate: {
			...candidate,
			notSelected: true,
			wrapperPayloadsIllustrative: true,
			note:
				"Local explicit candidate values used only as measurement inputs. A0 does not initialize the container; A1 uses one existing crypto_pwhash call and no container/seal/open; A2 uses the public factory for one synthetic 32-byte seal/open round trip only. " +
				"Borrowed experimental candidate inputs only; NOT a V2 default, selected production profile, format freeze, or product memory budget.",
		},
		runtime: {
			expected: { ...input.runtime.expected },
			parent: { ...input.runtime.parent },
			children: input.runtime.children.map((runtime) => ({ ...runtime })),
		},
		bounds: {
			...PHASE_A_OPERATIONAL_BOUNDS,
			maxChildEnvelopeMs: PHASE_A_MAX_CHILD_ENVELOPE_MS,
			planMaxChildEnvelopeMs:
				input.plan.maxChildStarts *
				(PHASE_A_OPERATIONAL_BOUNDS.childDeadlineMs + PHASE_A_OPERATIONAL_BOUNDS.childStopGraceMs),
			maxChildEnvelopeFitsRunDeadline: true,
		},
		freshness: {
			algorithm: "sha256",
			capturedAtIso: input.freshness.capturedAtIso,
			files: input.freshness.files.map((entry) => ({ ...entry })),
		},
		libsodium: {
			...input.libsodium,
			installed: { ...input.libsodium.installed },
			lock: { ...input.libsodium.lock },
		},
		memory: { ...input.memory },
		methodology: {
			freshChildPerSample: true,
			sequential: true,
			noRetries: true,
			noResume: true,
			noEscalation: true,
			timingScope:
				"seal: await + fully consume the sealed async byte source in memory; open: complete openAndStage call; A1: synchronous crypto_pwhash only. Startup, READY, reporting, and round-trip comparison are excluded.",
			memoryScope:
				"Windows GetProcessMemoryInfo working set in bytes; baseline, sampled incremental delta, and process lifetime peak are distinct labels. Parent sampling can miss short peaks.",
			roundTripScope:
				"In-memory boolean byte equality between the original synthetic payload and the opened payload. No bytes, keys, salts, ciphertext, digests, or identities are reported.",
			dataHandling:
				"Synthetic in-memory fixtures only; no files, network, database, host, keychain, accounts, Git, or install. Best-effort clearing only; no zeroization claim.",
			supervision:
				"One fresh child at a time, sequential, no retries/resume/escalation. The parent terminates only its owned child handle and verifies exit; no hard containment or descendant-tree proof.",
			outputScope:
				"Bounded stdout/stderr retention. Protocol lines are capped at 64 KiB; per-child stdout/stderr retention is capped at 512 KiB each and the run retention at 4 MiB. Raw child output is never echoed in the report.",
		},
		limitations: [...PHASE_A_LIMITATIONS],
		aggregate: {
			memory: {
				baselineWorkingSetBytes: computePhaseAStats(
					allCaseSamples.map((sample) => sample.baselineWorkingSetBytes),
				),
				sampledIncrementalWorkingSetBytes: computePhaseAStats(
					allCaseSamples.map((sample) => sample.sampledIncrementalWorkingSetBytes),
				),
				lifetimePeakWorkingSetBytes: computePhaseAStats(
					allCaseSamples.map((sample) => sample.lifetimePeakWorkingSetBytes),
				),
			},
			sealMs: computePhaseAStats(allOperations.map((operation) => operation.sealMs)),
			openMs: computePhaseAStats(allOperations.map((operation) => operation.openMs)),
			kdfControlMs: computePhaseAStats(
				allCaseSamples
					.map((sample) => sample.kdfControlMs)
					.filter((value): value is number => value !== null),
			),
		},
		cases: summaries,
		samples: (input.samples as readonly PhaseASampleRecord[]).map((sample) => ({
			...sample,
			operations: sample.operations.map((operation) => ({ ...operation })),
		})),
		failures: input.failures.map((failure) => ({ ...failure })),
		summary: {
			plannedSamples: input.plan.maxChildStarts,
			attemptedSamples: input.attemptedSamples,
			completedSamples: input.samples.length,
			failedSamples,
			failureRecords: input.failures.length,
			childStarts: input.childStarts,
			stoppedBySafety: input.stoppedBySafety,
			roundTripMatchedOperations,
			roundTripOperationCount: allOperations.length,
			retainedOutputBytes: input.retainedOutputBytes,
		},
	};
}

export const PHASE_A_CANDIDATE_DEFINITION_ID = CANDIDATE_DEFINITION.id;
export const PHASE_A_CANDIDATE_SALT_BYTES = CANDIDATE_SALT_BYTES;
