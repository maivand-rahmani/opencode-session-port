/**
 * CRYPTO-01 Phase A child/parent line protocol.
 *
 * Pure parsing, exact-shape validation, and sequence state only. No I/O, no
 * crypto, no process APIs, and no filesystem access, so this module is safe to
 * import from Node unit tests.
 *
 * Wire format: one JSON object per line (LF-terminated) on child stdout. The
 * parent sends exactly one start command line on child stdin. Every message is
 * bounded to 64 KiB and every field is checked; unknown fields, non-finite
 * numbers, wrong cases, and wrong runtimes fail closed.
 */

import {
	CASE_IDS,
	isCaseId,
	requireCase,
	type CandidateReport,
	type CaseId,
	type CasePlanReport,
	type PhaseACase,
	type PhaseARunMode,
} from "./cases.ts";

export const PHASE_A_PROTOCOL_VERSION = 1 as const;
export const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;
export const LAUNCH_NONCE_ENV = "PHASE_A_LAUNCH_NONCE";
export const LAUNCH_PARENT_PID_ENV = "PHASE_A_PARENT_PID";
export const LAUNCH_PLAN_MODE_ENV = "PHASE_A_PLAN_MODE";
export const LAUNCH_NONCE_HEX_BYTES = 16;
export const LAUNCH_NONCE_PATTERN = /^[0-9a-f]{32}$/;
export const PHASE_A_RUN_MODES = ["a0-bridge", "a1-control", "a2-container", "a3-a6-small", "full-phase-a"] as const;

export const CHILD_FAILURE_CODES = [
	"ready-failed",
	"seal-failed",
	"open-failed",
	"roundtrip-mismatch",
	"kdf-control-failed",
	"case-failed",
	"runtime-mismatch",
] as const;

export type ChildFailureCode = (typeof CHILD_FAILURE_CODES)[number];

export type OperationalFailureCode =
	| "invalid-run-plan"
	| "preflight-runtime"
	| "preflight-memory"
	| "preflight-hash"
	| "preflight-sampler"
	| "preflight-libsodium-metadata"
	| "spawn-failed"
	| "stdin-failed"
	| "launch-guard-failed"
	| "child-deadline"
	| "run-deadline"
	| "child-exit-early"
	| "child-exit-nonzero"
	| "child-exit-timeout"
	| "cleanup-uncertain"
	| "protocol-invalid"
	| "protocol-case-mismatch"
	| "protocol-runtime-mismatch"
	| "protocol-candidate-mismatch"
	| "protocol-order"
	| "protocol-duplicate"
	| "protocol-missing-ready"
	| "protocol-missing-completion"
	| "protocol-line-overflow"
	| "output-overflow"
	| "run-output-overflow"
	| "memory-stop"
	| "memory-observability-failed"
	| "sampler-failed"
	| "internal";

export type SafeFailureCode = ChildFailureCode | OperationalFailureCode;

export class PhaseAProtocolError extends Error {
	constructor(
		readonly code: SafeFailureCode,
		message: string,
	) {
		super(message);
		this.name = "PhaseAProtocolError";
	}
}

export interface PhaseARuntimeIdentity {
	readonly bun: string;
	readonly nodeCompat: string;
	readonly platform: string;
	readonly arch: string;
	readonly libsodiumVersion: string;
}

export interface ExpectedPhaseARuntime {
	readonly bun: string;
	readonly nodeCompat: string;
	readonly platform: string;
	readonly arch: string;
}

export interface ChildReadyMessage {
	readonly type: "ready";
	readonly protocol: 1;
	readonly pid: number;
	readonly caseId: CaseId;
	readonly runtime: PhaseARuntimeIdentity;
	readonly candidate: CandidateReport;
	readonly plan: CasePlanReport;
}

export interface PhaseAOperationReport {
	readonly sealMs: number;
	readonly openMs: number;
	readonly artifactBytes: number;
	readonly roundTripMatched: boolean;
}

export interface ChildCompleteSuccessMessage {
	readonly type: "complete";
	readonly protocol: 1;
	readonly caseId: CaseId;
	readonly pid: number;
	readonly ok: true;
	readonly operations?: readonly PhaseAOperationReport[];
	readonly kdfControlMs?: number;
}

export interface ChildCompleteFailureMessage {
	readonly type: "complete";
	readonly protocol: 1;
	readonly caseId: CaseId;
	readonly pid: number;
	readonly ok: false;
	readonly failureCode: ChildFailureCode;
}

export type ChildCompleteMessage = ChildCompleteSuccessMessage | ChildCompleteFailureMessage;

export interface ChildErrorMessage {
	readonly type: "error";
	readonly protocol: 1;
	readonly caseId: CaseId;
	readonly code: ChildFailureCode;
}

export type ChildMessage = ChildReadyMessage | ChildCompleteMessage | ChildErrorMessage;

export interface StartCommand {
	readonly type: "start";
	readonly protocol: 1;
	readonly caseId: CaseId;
	readonly launchNonce: string;
	readonly mode: PhaseARunMode;
}

export function isLaunchNonce(value: unknown): value is string {
	return typeof value === "string" && LAUNCH_NONCE_PATTERN.test(value);
}

export function isPhaseARunMode(value: unknown): value is PhaseARunMode {
	return typeof value === "string" && (PHASE_A_RUN_MODES as readonly string[]).includes(value);
}

export function isChildFailureCode(value: unknown): value is ChildFailureCode {
	return typeof value === "string" && (CHILD_FAILURE_CODES as readonly string[]).includes(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new PhaseAProtocolError("protocol-invalid", `${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function assertExactKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
	label: string,
): void {
	const actualKeys = Object.keys(value);
	for (const key of actualKeys) {
		if (!allowedKeys.includes(key)) {
			throw new PhaseAProtocolError("protocol-invalid", `${label} has an unexpected field: ${key}`);
		}
	}
	for (const key of allowedKeys) {
		if (!(key in value)) {
			throw new PhaseAProtocolError("protocol-invalid", `${label} is missing required field: ${key}`);
		}
	}
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new PhaseAProtocolError("protocol-invalid", `${label} must be a non-empty string`);
	}
	return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new PhaseAProtocolError("protocol-invalid", `${label} must be a finite number`);
	}
	return value;
}

function requireNonNegativeFinite(value: unknown, label: string): number {
	const parsed = requireFiniteNumber(value, label);
	if (parsed < 0) {
		throw new PhaseAProtocolError("protocol-invalid", `${label} must be non-negative`);
	}
	return parsed;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new PhaseAProtocolError("protocol-invalid", `${label} must be a positive safe integer`);
	}
	return value;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new PhaseAProtocolError("protocol-invalid", `${label} must be a non-negative safe integer`);
	}
	return value;
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new PhaseAProtocolError("protocol-invalid", `${label} must be a boolean`);
	}
	return value;
}

function requireCaseId(value: unknown, label: string): CaseId {
	if (!isCaseId(value)) {
		throw new PhaseAProtocolError("protocol-case-mismatch", `${label} is not a Phase A case id`);
	}
	return value;
}

function requireProtocolVersion(value: unknown): 1 {
	if (value !== PHASE_A_PROTOCOL_VERSION) {
		throw new PhaseAProtocolError("protocol-invalid", "protocol version does not match");
	}
	return PHASE_A_PROTOCOL_VERSION;
}

function parseRuntime(value: unknown): PhaseARuntimeIdentity {
	const runtime = asRecord(value, "runtime");
	assertExactKeys(runtime, ["bun", "nodeCompat", "platform", "arch", "libsodiumVersion"], "runtime");
	return {
		bun: requireString(runtime["bun"], "runtime.bun"),
		nodeCompat: requireString(runtime["nodeCompat"], "runtime.nodeCompat"),
		platform: requireString(runtime["platform"], "runtime.platform"),
		arch: requireString(runtime["arch"], "runtime.arch"),
		libsodiumVersion: requireString(runtime["libsodiumVersion"], "runtime.libsodiumVersion"),
	};
}

function parseCandidate(value: unknown): CandidateReport {
	const candidate = asRecord(value, "candidate");
	assertExactKeys(
		candidate,
		["id", "opsLimit", "memLimitBytes", "saltBytes", "frameBytes", "limits"],
		"candidate",
	);
	const limits = asRecord(candidate["limits"], "candidate.limits");
	assertExactKeys(
		limits,
		[
			"maxPasswordBytes",
			"maxArtifactBytes",
			"maxCompressedBytes",
			"maxDecompressedBytes",
			"maxExpansionRatio",
		],
		"candidate.limits",
	);
	const maxExpansionRatio = requireFiniteNumber(limits["maxExpansionRatio"], "candidate.limits.maxExpansionRatio");
	if (maxExpansionRatio <= 0) {
		throw new PhaseAProtocolError("protocol-invalid", "candidate.limits.maxExpansionRatio must be positive");
	}
	return {
		id: requireString(candidate["id"], "candidate.id"),
		opsLimit: requirePositiveSafeInteger(candidate["opsLimit"], "candidate.opsLimit"),
		memLimitBytes: requirePositiveSafeInteger(candidate["memLimitBytes"], "candidate.memLimitBytes"),
		saltBytes: requirePositiveSafeInteger(candidate["saltBytes"], "candidate.saltBytes"),
		frameBytes: requirePositiveSafeInteger(candidate["frameBytes"], "candidate.frameBytes"),
		limits: {
			maxPasswordBytes: requireNonNegativeSafeInteger(
				limits["maxPasswordBytes"],
				"candidate.limits.maxPasswordBytes",
			),
			maxArtifactBytes: requirePositiveSafeInteger(
				limits["maxArtifactBytes"],
				"candidate.limits.maxArtifactBytes",
			),
			maxCompressedBytes: requirePositiveSafeInteger(
				limits["maxCompressedBytes"],
				"candidate.limits.maxCompressedBytes",
			),
			maxDecompressedBytes: requireNonNegativeSafeInteger(
				limits["maxDecompressedBytes"],
				"candidate.limits.maxDecompressedBytes",
			),
			maxExpansionRatio,
		},
	};
}

function parsePlan(value: unknown): CasePlanReport {
	const plan = asRecord(value, "plan");
	assertExactKeys(plan, ["caseId", "payloadBytes", "pairs", "passwordKind"], "plan");
	const caseId = requireCaseId(plan["caseId"], "plan.caseId");
	const pairs = requireNonNegativeSafeInteger(plan["pairs"], "plan.pairs");
	if (pairs > 2) {
		throw new PhaseAProtocolError("protocol-invalid", "plan.pairs must be 0, 1, or 2");
	}
	const passwordKind = plan["passwordKind"];
	if (passwordKind !== "none" && passwordKind !== "wrapper-passphrase" && passwordKind !== "object-root") {
		throw new PhaseAProtocolError("protocol-invalid", "plan.passwordKind is not allowed");
	}
	return {
		caseId,
		payloadBytes: requireNonNegativeSafeInteger(plan["payloadBytes"], "plan.payloadBytes"),
		pairs,
		passwordKind,
	};
}

function parseOperation(value: unknown, label: string): PhaseAOperationReport {
	const operation = asRecord(value, label);
	assertExactKeys(operation, ["sealMs", "openMs", "artifactBytes", "roundTripMatched"], label);
	return {
		sealMs: requireNonNegativeFinite(operation["sealMs"], `${label}.sealMs`),
		openMs: requireNonNegativeFinite(operation["openMs"], `${label}.openMs`),
		artifactBytes: requirePositiveSafeInteger(operation["artifactBytes"], `${label}.artifactBytes`),
		roundTripMatched: requireBoolean(operation["roundTripMatched"], `${label}.roundTripMatched`),
	};
}

function parseComplete(parsed: Record<string, unknown>): ChildCompleteMessage {
	const caseId = requireCaseId(parsed["caseId"], "complete.caseId");
	const pid = requirePositiveSafeInteger(parsed["pid"], "complete.pid");
	const ok = requireBoolean(parsed["ok"], "complete.ok");
	const commonKeys = ["type", "protocol", "caseId", "pid", "ok"] as const;

	if (!ok) {
		assertExactKeys(parsed, [...commonKeys, "failureCode"], "complete");
		const failureCode = parsed["failureCode"];
		if (!isChildFailureCode(failureCode)) {
			throw new PhaseAProtocolError("protocol-invalid", "complete.failureCode is not an allowed child failure code");
		}
		return {
			type: "complete",
			protocol: requireProtocolVersion(parsed["protocol"]),
			caseId,
			pid,
			ok: false,
			failureCode,
		};
	}

	const definition = requireCase(caseId);
	if (definition.id === "A0") {
		assertExactKeys(parsed, commonKeys, "complete A0");
		return { type: "complete", protocol: requireProtocolVersion(parsed["protocol"]), caseId, pid, ok: true };
	}
	if (definition.id === "A1") {
		assertExactKeys(parsed, [...commonKeys, "kdfControlMs"], "complete A1");
		return {
			type: "complete",
			protocol: requireProtocolVersion(parsed["protocol"]),
			caseId,
			pid,
			ok: true,
			kdfControlMs: requireNonNegativeFinite(parsed["kdfControlMs"], "complete.kdfControlMs"),
		};
	}

	assertExactKeys(parsed, [...commonKeys, "operations"], "complete container");
	const rawOperations = parsed["operations"];
	if (!Array.isArray(rawOperations)) {
		throw new PhaseAProtocolError("protocol-invalid", "complete.operations must be an array");
	}
	if (rawOperations.length !== definition.pairs) {
		throw new PhaseAProtocolError(
			"protocol-invalid",
			`complete.operations must contain exactly ${definition.pairs} operation(s) for ${definition.id}`,
		);
	}
	return {
		type: "complete",
		protocol: requireProtocolVersion(parsed["protocol"]),
		caseId,
		pid,
		ok: true,
		operations: rawOperations.map((operation, index) => parseOperation(operation, `complete.operations[${index}]`)),
	};
}

function parseReady(parsed: Record<string, unknown>): ChildReadyMessage {
	assertExactKeys(parsed, ["type", "protocol", "pid", "caseId", "runtime", "candidate", "plan"], "ready");
	return {
		type: "ready",
		protocol: requireProtocolVersion(parsed["protocol"]),
		pid: requirePositiveSafeInteger(parsed["pid"], "ready.pid"),
		caseId: requireCaseId(parsed["caseId"], "ready.caseId"),
		runtime: parseRuntime(parsed["runtime"]),
		candidate: parseCandidate(parsed["candidate"]),
		plan: parsePlan(parsed["plan"]),
	};
}

function parseErrorMessage(parsed: Record<string, unknown>): ChildErrorMessage {
	assertExactKeys(parsed, ["type", "protocol", "caseId", "code"], "error");
	const code = parsed["code"];
	if (!isChildFailureCode(code)) {
		throw new PhaseAProtocolError("protocol-invalid", "error.code is not an allowed child failure code");
	}
	return {
		type: "error",
		protocol: requireProtocolVersion(parsed["protocol"]),
		caseId: requireCaseId(parsed["caseId"], "error.caseId"),
		code,
	};
}

/**
 * Parses one complete protocol line. The line must not contain newline bytes,
 * must be <= 64 KiB, and must match exactly one allowed message shape.
 */
export function parseChildMessageLine(line: string): ChildMessage {
	if (typeof line !== "string") {
		throw new PhaseAProtocolError("protocol-invalid", "protocol line must be a string");
	}
	if (line.length === 0) {
		throw new PhaseAProtocolError("protocol-invalid", "protocol line must not be empty");
	}
	if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
		throw new PhaseAProtocolError("protocol-line-overflow", "protocol line exceeds the 64 KiB bound");
	}
	if (line.includes("\n") || line.includes("\r")) {
		throw new PhaseAProtocolError("protocol-invalid", "protocol line must be a single line");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new PhaseAProtocolError("protocol-invalid", "protocol line is not valid JSON");
	}
	const record = asRecord(parsed, "protocol message");
	const type = record["type"];
	if (type === "ready") return parseReady(record);
	if (type === "complete") return parseComplete(record);
	if (type === "error") return parseErrorMessage(record);
	throw new PhaseAProtocolError("protocol-invalid", "protocol message has an unknown type");
}

export function parseStartCommandLine(line: string): StartCommand {
	if (typeof line !== "string" || line.length === 0) {
		throw new PhaseAProtocolError("protocol-invalid", "start command must be a non-empty line");
	}
	if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
		throw new PhaseAProtocolError("protocol-line-overflow", "start command exceeds the 64 KiB bound");
	}
	if (line.includes("\n") || line.includes("\r")) {
		throw new PhaseAProtocolError("protocol-invalid", "start command must be a single line");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new PhaseAProtocolError("protocol-invalid", "start command is not valid JSON");
	}
	const record = asRecord(parsed, "start command");
	assertExactKeys(record, ["type", "protocol", "caseId", "launchNonce", "mode"], "start command");
	if (record["type"] !== "start") {
		throw new PhaseAProtocolError("protocol-invalid", "start command type must be start");
	}
	const launchNonce = record["launchNonce"];
	if (!isLaunchNonce(launchNonce)) {
		throw new PhaseAProtocolError("protocol-invalid", "start command launch nonce is invalid");
	}
	const mode = record["mode"];
	if (!isPhaseARunMode(mode)) {
		throw new PhaseAProtocolError("protocol-invalid", "start command run mode is invalid");
	}
	return {
		type: "start",
		protocol: requireProtocolVersion(record["protocol"]),
		caseId: requireCaseId(record["caseId"], "start.caseId"),
		launchNonce,
		mode,
	};
}

function sameCandidate(left: CandidateReport, right: CandidateReport): boolean {
	return (
		left.id === right.id &&
		left.opsLimit === right.opsLimit &&
		left.memLimitBytes === right.memLimitBytes &&
		left.saltBytes === right.saltBytes &&
		left.frameBytes === right.frameBytes &&
		left.limits.maxPasswordBytes === right.limits.maxPasswordBytes &&
		left.limits.maxArtifactBytes === right.limits.maxArtifactBytes &&
		left.limits.maxCompressedBytes === right.limits.maxCompressedBytes &&
		left.limits.maxDecompressedBytes === right.limits.maxDecompressedBytes &&
		left.limits.maxExpansionRatio === right.limits.maxExpansionRatio
	);
}

export function assertReadyMatchesRequest(
	ready: ChildReadyMessage,
	expectedCase: PhaseACase,
	expectedRuntime: ExpectedPhaseARuntime,
	expectedCandidate: CandidateReport,
): void {
	if (ready.caseId !== expectedCase.id) {
		throw new PhaseAProtocolError("protocol-case-mismatch", "child READY case id does not match the requested case");
	}
	if (
		ready.runtime.bun !== expectedRuntime.bun ||
		ready.runtime.nodeCompat !== expectedRuntime.nodeCompat ||
		ready.runtime.platform !== expectedRuntime.platform ||
		ready.runtime.arch !== expectedRuntime.arch
	) {
		throw new PhaseAProtocolError("protocol-runtime-mismatch", "child runtime does not match the required runtime");
	}
	if (!sameCandidate(ready.candidate, expectedCandidate)) {
		throw new PhaseAProtocolError("protocol-candidate-mismatch", "child candidate does not match the expected candidate");
	}
	const expectedPlan = {
		caseId: expectedCase.id,
		payloadBytes: expectedCase.payloadBytes,
		pairs: expectedCase.pairs,
		passwordKind: expectedCase.passwordKind,
	};
	if (
		ready.plan.caseId !== expectedPlan.caseId ||
		ready.plan.payloadBytes !== expectedPlan.payloadBytes ||
		ready.plan.pairs !== expectedPlan.pairs ||
		ready.plan.passwordKind !== expectedPlan.passwordKind
	) {
		throw new PhaseAProtocolError("protocol-case-mismatch", "child plan does not match the requested case");
	}
}

export function assertCompleteMatchesCase(complete: ChildCompleteMessage, expectedCaseId: CaseId): void {
	if (complete.caseId !== expectedCaseId) {
		throw new PhaseAProtocolError("protocol-case-mismatch", "child completion case id does not match the requested case");
	}
}

/**
 * Pure message-order state: exactly one READY before exactly one COMPLETE,
 * with no message permitted after completion.
 */
export class ChildMessageState {
	#readySeen = false;
	#completeSeen = false;

	get readySeen(): boolean {
		return this.#readySeen;
	}

	get completeSeen(): boolean {
		return this.#completeSeen;
	}

	accept(message: ChildMessage): "ready" | "complete" {
		if (message.type === "ready") {
			if (this.#readySeen) {
				throw new PhaseAProtocolError("protocol-duplicate", "child sent more than one READY message");
			}
			if (this.#completeSeen) {
				throw new PhaseAProtocolError("protocol-order", "child sent READY after COMPLETE");
			}
			this.#readySeen = true;
			return "ready";
		}
		if (message.type === "complete") {
			if (this.#completeSeen) {
				throw new PhaseAProtocolError("protocol-duplicate", "child sent more than one COMPLETE message");
			}
			if (!this.#readySeen) {
				throw new PhaseAProtocolError("protocol-order", "child sent COMPLETE before READY");
			}
			this.#completeSeen = true;
			return "complete";
		}
		throw new PhaseAProtocolError("protocol-order", "child error messages terminate the session, not the ordered state");
	}
}

/**
 * Bounded line assembler. It holds at most 64 KiB for the current line and
 * never grows an unbounded string buffer. Lines must be LF-terminated; an
 * unterminated final fragment fails closed.
 */
export class BoundedLineAssembler {
	readonly #buffer = new Uint8Array(MAX_PROTOCOL_LINE_BYTES);
	readonly #decoder = new TextDecoder("utf-8", { fatal: true });
	#length = 0;

	push(chunk: Uint8Array): string[] {
		if (!(chunk instanceof Uint8Array)) {
			throw new PhaseAProtocolError("protocol-invalid", "protocol stream yielded a non-byte chunk");
		}
		const lines: string[] = [];
		for (const byte of chunk) {
			if (byte === 0x0a) {
				lines.push(this.#decodeCurrentLine());
				this.#length = 0;
				continue;
			}
			if (this.#length >= MAX_PROTOCOL_LINE_BYTES) {
				throw new PhaseAProtocolError("protocol-line-overflow", "protocol line exceeds the 64 KiB bound");
			}
			this.#buffer[this.#length] = byte;
			this.#length += 1;
		}
		return lines;
	}

	finish(): void {
		if (this.#length !== 0) {
			throw new PhaseAProtocolError("protocol-invalid", "protocol stream ended inside a line");
		}
	}

	#decodeCurrentLine(): string {
		try {
			return this.#decoder.decode(this.#buffer.subarray(0, this.#length));
		} catch {
			throw new PhaseAProtocolError("protocol-invalid", "protocol line is not valid UTF-8");
		}
	}
}

export const PHASE_A_CASE_IDS = CASE_IDS;
