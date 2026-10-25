/**
 * CRYPTO-01 Phase A child workload.
 *
 * This module is side-effect free on import. Actual crypto imports
 * (`libsodium-wrappers-sumo`, the product container factory) happen lazily
 * inside `runChildCase`, which is reached only through the explicit
 * `--child-case` CLI branch. Importing this module under Node for unit tests
 * does not load libsodium, initialize the factory, or perform any KDF/seal/open
 * work.
 *
 * The child does not spawn processes or import child-process/external-command
 * APIs. It writes only bounded JSON protocol lines and never writes payload
 * bytes, keys, salts, ciphertext, digests, artifact identities, or raw error
 * text to stdout/stderr.
 */

import {
	CANDIDATE_DEFINITION,
	CANDIDATE_LIMITS,
	CANDIDATE_MEM_LIMIT_BYTES,
	CANDIDATE_OPS_LIMIT,
	CANDIDATE_POLICY_ID,
	CANDIDATE_SALT_BYTES,
	CASE_IDS,
	OBJECT_ROOT_BYTES,
	WRAPPER_PASSPHRASE_FIXTURE_TEXT,
	candidateReport,
	casePlanReport,
	isCaseId,
	requireCase,
	type CaseId,
	type PhaseARunMode,
} from "./cases.ts";
import type { AuthenticatedPayload, CheckpointCrypto } from "../../../src/core/contracts/crypto.ts";
import {
	BoundedLineAssembler,
	LAUNCH_NONCE_ENV,
	LAUNCH_PARENT_PID_ENV,
	LAUNCH_PLAN_MODE_ENV,
	MAX_PROTOCOL_LINE_BYTES,
	PHASE_A_PROTOCOL_VERSION,
	PhaseAProtocolError,
	isLaunchNonce,
	isPhaseARunMode,
	parseStartCommandLine,
	type ChildFailureCode,
	type ChildMessage,
	type ChildReadyMessage,
	type PhaseAOperationReport,
} from "./protocol.ts";

type SodiumModule = typeof import("libsodium-wrappers-sumo");
type SodiumApi = SodiumModule["default"];
type ContainerModule = typeof import("../../../src/core/crypto/index.ts");

const ARGON2ID13_ID = 2;
const KDF_OUTPUT_BYTES = 32;

interface BunApi {
	readonly stdout: unknown;
	readonly stdin: { stream(): ReadableStream<Uint8Array> };
	write(destination: unknown, data: string): Promise<number>;
}

function getBun(): BunApi {
	const bun = (globalThis as { Bun?: BunApi }).Bun;
	if (bun === undefined) {
		throw new Error("the Phase A child requires the Bun runtime");
	}
	return bun;
}

class ChildCaseError extends Error {
	constructor(
		readonly code: ChildFailureCode,
		message: string,
	) {
		super(message);
		this.name = "ChildCaseError";
	}
}

function childCaseError(code: ChildFailureCode, message: string): ChildCaseError {
	return new ChildCaseError(code, message);
}

export interface ChildRuntimeProbe {
	readonly platform: string;
	readonly arch: string;
	readonly bun: string | undefined;
}

/** Pure runtime check used by the child (and testable without changing process state). */
export function checkChildRuntime(probe: ChildRuntimeProbe): boolean {
	return (
		probe.platform === "win32" &&
		(probe.arch === "x64" || probe.arch === "arm64") &&
		probe.bun === "1.3.10"
	);
}

function assertChildRuntime(): void {
	const bun = (process.versions as { bun?: string }).bun;
	if (!checkChildRuntime({ platform: process.platform, arch: process.arch, bun })) {
		throw childCaseError(
			"runtime-mismatch",
			"the Phase A child requires Windows with Bun 1.3.10 on x64 or arm64",
		);
	}
}

export const CHILD_ACTUAL_RUNNABLE_CASE_IDS: readonly CaseId[] = Object.freeze([...CASE_IDS]);

export function isChildCaseRunnable(caseId: CaseId): boolean {
	return CASE_IDS.includes(caseId);
}

export interface SupervisorLaunchGuardInput {
	readonly caseId: CaseId;
	readonly envNonce: string | undefined;
	readonly envParentPid: string | undefined;
	readonly envPlanMode: string | undefined;
	readonly actualParentPid: number | undefined;
}

export type SupervisorLaunchGuardResult =
	| { readonly ok: true; readonly nonce: string; readonly planMode: PhaseARunMode }
	| { readonly ok: false; readonly code: ChildFailureCode; readonly reason: string };

/**
 * Explicit accidental-invocation guard, not a security sandbox. It requires a
 * supervisor-generated per-child nonce, the supervisor's expected parent PID in
 * the environment, a matching actual parent PID, and a matching parent-owned
 * plan mode. A0 is valid only with a0-bridge; A1 is valid only with a1-control.
 * A2-A6 are rejected before any crypto import regardless of nonce.
 */
export function validateSupervisorLaunchGuard(input: SupervisorLaunchGuardInput): SupervisorLaunchGuardResult {
	const expectedPlanMode: PhaseARunMode | null =
		input.caseId === "A0"
			? "a0-bridge"
			: input.caseId === "A1"
				? "a1-control"
				: input.caseId === "A2"
					? "a2-container"
					: input.caseId === "A3" || input.caseId === "A4" || input.caseId === "A5" || input.caseId === "A6"
						? "a3-a6-small"
						: null;
	if (expectedPlanMode === null) {
		return {
			ok: false,
			code: "case-failed",
			reason: "only matching A0/A1/A2/A3-A6 supervisor plan-mode contexts are source-prepared",
		};
	}
	if (!isPhaseARunMode(input.envPlanMode) || input.envPlanMode !== expectedPlanMode) {
		return { ok: false, code: "case-failed", reason: "supervisor plan-mode context does not match the child case" };
	}
	if (!isLaunchNonce(input.envNonce)) {
		return { ok: false, code: "case-failed", reason: "supervisor launch nonce is missing or invalid" };
	}
	if (typeof input.envParentPid !== "string" || !/^[1-9][0-9]*$/.test(input.envParentPid)) {
		return { ok: false, code: "case-failed", reason: "supervisor parent PID is missing or invalid" };
	}
	const expectedParentPid = Number(input.envParentPid);
	if (!Number.isSafeInteger(expectedParentPid) || expectedParentPid <= 0) {
		return { ok: false, code: "case-failed", reason: "supervisor parent PID is outside the safe range" };
	}
	if (!Number.isSafeInteger(input.actualParentPid) || (input.actualParentPid ?? 0) <= 0) {
		return { ok: false, code: "case-failed", reason: "actual parent PID is unavailable or invalid" };
	}
	if (input.actualParentPid !== expectedParentPid) {
		return { ok: false, code: "case-failed", reason: "actual parent PID does not match the supervisor context" };
	}
	return { ok: true, nonce: input.envNonce, planMode: expectedPlanMode };
}

async function writeProtocol(message: ChildMessage): Promise<void> {
	const bun = getBun();
	const line = JSON.stringify(message);
	if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
		throw new PhaseAProtocolError("protocol-line-overflow", "child protocol line exceeds 64 KiB");
	}
	await bun.write(bun.stdout, `${line}\n`);
}

async function safeWrite(message: ChildMessage): Promise<void> {
	try {
		await writeProtocol(message);
	} catch {
		// Parent is gone or the write failed; there is no safe retry channel.
	}
}

function runtimeIdentity(sodium: SodiumApi) {
	return {
		bun: (process.versions as { bun?: string }).bun ?? "unknown",
		nodeCompat: process.versions.node,
		platform: process.platform,
		arch: process.arch,
		libsodiumVersion: sodium.SODIUM_VERSION_STRING,
	};
}

function sendReady(sodium: SodiumApi, caseId: CaseId): Promise<void> {
	const definition = requireCase(caseId);
	return writeProtocol({
		type: "ready",
		protocol: PHASE_A_PROTOCOL_VERSION,
		pid: process.pid,
		caseId,
		runtime: runtimeIdentity(sodium),
		candidate: candidateReport(),
		plan: casePlanReport(definition),
	});
}

function sendCompleteSuccess(
	caseId: CaseId,
	payload: { readonly kdfControlMs?: number; readonly operations?: readonly PhaseAOperationReport[] },
): Promise<void> {
	if (caseId === "A0") {
		return writeProtocol({
			type: "complete",
			protocol: PHASE_A_PROTOCOL_VERSION,
			caseId,
			pid: process.pid,
			ok: true,
		});
	}
	if (caseId === "A1") {
		return writeProtocol({
			type: "complete",
			protocol: PHASE_A_PROTOCOL_VERSION,
			caseId,
			pid: process.pid,
			ok: true,
			kdfControlMs: payload.kdfControlMs ?? 0,
		});
	}
	return writeProtocol({
		type: "complete",
		protocol: PHASE_A_PROTOCOL_VERSION,
		caseId,
		pid: process.pid,
		ok: true,
		operations: payload.operations ?? [],
	});
}

async function waitForStart(caseId: CaseId, expectedLaunchNonce: string, expectedPlanMode: PhaseARunMode): Promise<void> {
	const bun = getBun();
	const reader = bun.stdin.stream().getReader();
	const assembler = new BoundedLineAssembler();
	try {
		for (;;) {
			const step = await reader.read();
			if (step.done) {
				assembler.finish();
				throw new PhaseAProtocolError("protocol-invalid", "child stdin ended before the start command");
			}
			const lines = assembler.push(step.value);
			if (lines.length > 1) {
				throw new PhaseAProtocolError("protocol-invalid", "child received more than one start command");
			}
			if (lines.length === 1) {
				const command = parseStartCommandLine(lines[0]!);
				if (command.caseId !== caseId) {
					throw new PhaseAProtocolError("protocol-case-mismatch", "start command case id does not match");
				}
				if (command.launchNonce !== expectedLaunchNonce) {
					throw new PhaseAProtocolError("protocol-invalid", "start command launch nonce does not match the supervisor context");
				}
				if (command.mode !== expectedPlanMode) {
					throw new PhaseAProtocolError("protocol-invalid", "start command plan mode does not match the supervisor context");
				}
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

async function* bytesToSource(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	yield bytes;
}

export async function consumeSealedSource(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of source) {
		if (!(chunk instanceof Uint8Array)) {
			throw new Error("sealed source yielded a non-byte chunk");
		}
		total += chunk.length;
		if (!Number.isSafeInteger(total) || total > CANDIDATE_LIMITS.maxArtifactBytes) {
			throw new Error("sealed artifact exceeds the candidate artifact cap");
		}
		chunks.push(chunk);
	}
	if (total <= 0) {
		throw new Error("sealed source produced no artifact bytes");
	}
	const artifact = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		artifact.set(chunk, offset);
		offset += chunk.length;
	}
	return artifact;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left[index]! ^ right[index]!;
	}
	return difference === 0;
}

function bestEffortZero(sodium: SodiumApi, bytes: Uint8Array | undefined): void {
	if (bytes === undefined || !(bytes instanceof Uint8Array)) return;
	try {
		sodium.memzero(bytes);
	} catch {
		// Best-effort only; no zeroization or secure-deletion claim.
	}
}

function createWrapperPassphrase(): Uint8Array {
	return new TextEncoder().encode(WRAPPER_PASSPHRASE_FIXTURE_TEXT);
}

async function runKdfControl(sodium: SodiumApi, password: Uint8Array, salt: Uint8Array): Promise<number> {
	let derived: Uint8Array | undefined;
	try {
		const started = performance.now();
		derived = sodium.crypto_pwhash(
			KDF_OUTPUT_BYTES,
			password,
			salt,
			CANDIDATE_OPS_LIMIT,
			CANDIDATE_MEM_LIMIT_BYTES,
			sodium.crypto_pwhash_ALG_ARGON2ID13,
		);
		const finished = performance.now();
		if (!(derived instanceof Uint8Array) || derived.length !== KDF_OUTPUT_BYTES) {
			throw childCaseError("kdf-control-failed", "crypto_pwhash returned an unexpected output");
		}
		return finished - started;
	} catch (error) {
		if (error instanceof ChildCaseError) throw error;
		throw childCaseError("kdf-control-failed", "the KDF control call failed");
	} finally {
		bestEffortZero(sodium, derived);
	}
}

export async function runContainerOperations(
	sodium: SodiumApi,
	checkpointCrypto: CheckpointCrypto,
	payloads: readonly Uint8Array[],
	password: Uint8Array,
): Promise<PhaseAOperationReport[]> {
	const operations: PhaseAOperationReport[] = [];
	for (const payload of payloads) {
		let phase: "seal" | "open" | "roundtrip" = "seal";
		let ciphertext: Uint8Array | undefined;
		let opened: AuthenticatedPayload | undefined;
		try {
			const sealStarted = performance.now();
			const sealed = await checkpointCrypto.seal(bytesToSource(payload), password);
			ciphertext = await consumeSealedSource(sealed);
			const sealMs = performance.now() - sealStarted;

			phase = "open";
			const openStarted = performance.now();
			opened = await checkpointCrypto.openAndStage(bytesToSource(ciphertext), password);
			const openMs = performance.now() - openStarted;

			phase = "roundtrip";
			const roundTripMatched = bytesEqual(payload, opened.bytes);
			operations.push({
				sealMs,
				openMs,
				artifactBytes: ciphertext.length,
				roundTripMatched,
			});
			if (!roundTripMatched) {
				throw childCaseError("roundtrip-mismatch", "opened payload did not match the original payload");
			}
		} catch (error) {
			if (error instanceof ChildCaseError) throw error;
			if (phase === "seal") {
				throw childCaseError("seal-failed", "seal or ciphertext consumption failed");
			}
			if (phase === "open") {
				throw childCaseError("open-failed", "openAndStage failed");
			}
			throw childCaseError("roundtrip-mismatch", "round-trip comparison failed");
		} finally {
			if (opened !== undefined) {
				bestEffortZero(sodium, opened.bytes);
				bestEffortZero(sodium, opened.artifactIdentity);
			}
			bestEffortZero(sodium, ciphertext);
		}
	}
	return operations;
}

/**
 * Runs exactly one case in this fresh child. Crypto is imported lazily here.
 * Returns a process exit code; case-level crypto failures are reported as a
 * safe COMPLETE(ok=false) and exit 0 so the parent can continue the planned
 * samples. Pre-READY failures exit non-zero so the parent stops the run.
 */
export async function runChildCase(caseId: CaseId): Promise<number> {
	const definition = requireCase(caseId);
	let sodium: SodiumApi | undefined;
	let readySent = false;
	const ephemeral: Uint8Array[] = [];

	try {
		const launchGuard = validateSupervisorLaunchGuard({
			caseId,
			envNonce: process.env[LAUNCH_NONCE_ENV],
			envParentPid: process.env[LAUNCH_PARENT_PID_ENV],
			envPlanMode: process.env[LAUNCH_PLAN_MODE_ENV],
			actualParentPid: (process as { ppid?: number }).ppid,
		});
		if (!launchGuard.ok) {
			throw childCaseError(launchGuard.code, launchGuard.reason);
		}
		assertChildRuntime();

		const sodiumModule = (await import("libsodium-wrappers-sumo")) as SodiumModule;
		sodium = sodiumModule.default;
		await sodium.ready;
		if (sodium.crypto_pwhash_ALG_ARGON2ID13 !== ARGON2ID13_ID) {
			throw childCaseError("ready-failed", "unexpected Argon2id algorithm id");
		}
		if (sodium.crypto_pwhash_SALTBYTES !== CANDIDATE_SALT_BYTES) {
			throw childCaseError("ready-failed", "unexpected crypto_pwhash salt size");
		}

		if (caseId === "A0") {
			await sendReady(sodium, caseId);
			readySent = true;
			await waitForStart(caseId, launchGuard.nonce, launchGuard.planMode);
			await sendCompleteSuccess(caseId, {});
			return 0;
		}

		if (caseId === "A1") {
			const password = createWrapperPassphrase();
			const salt = sodium.randombytes_buf(CANDIDATE_SALT_BYTES);
			ephemeral.push(password, salt);
			await sendReady(sodium, caseId);
			readySent = true;
			await waitForStart(caseId, launchGuard.nonce, launchGuard.planMode);
			const kdfControlMs = await runKdfControl(sodium, password, salt);
			await sendCompleteSuccess(caseId, { kdfControlMs });
			return 0;
		}

		const containerModule = (await import("../../../src/core/crypto/index.ts")) as ContainerModule;
		const factory = await containerModule.createCheckpointCryptoFactory([CANDIDATE_DEFINITION]);
		const checkpointCrypto = await factory.create({ id: CANDIDATE_POLICY_ID });

		const password =
			definition.passwordKind === "object-root"
				? sodium.randombytes_buf(OBJECT_ROOT_BYTES)
				: createWrapperPassphrase();
		ephemeral.push(password);

		const payloads: Uint8Array[] = [];
		for (let pair = 0; pair < definition.pairs; pair += 1) {
			const payload = sodium.randombytes_buf(definition.payloadBytes);
			payloads.push(payload);
			ephemeral.push(payload);
		}

		await sendReady(sodium, caseId);
		readySent = true;
		await waitForStart(caseId, launchGuard.nonce, launchGuard.planMode);
		const operations = await runContainerOperations(sodium, checkpointCrypto, payloads, password);
		await sendCompleteSuccess(caseId, { operations });
		return 0;
	} catch (error) {
		const code: ChildFailureCode = error instanceof ChildCaseError ? error.code : "case-failed";
		if (readySent) {
			await safeWrite({
				type: "complete",
				protocol: PHASE_A_PROTOCOL_VERSION,
				caseId,
				pid: process.pid,
				ok: false,
				failureCode: code,
			});
			return 0;
		}
		await safeWrite({
			type: "error",
			protocol: PHASE_A_PROTOCOL_VERSION,
			caseId,
			code,
		});
		return 1;
	} finally {
		if (sodium !== undefined) {
			for (const bytes of ephemeral) bestEffortZero(sodium, bytes);
		}
	}
}

export type ParsedChildArgs = { readonly kind: "run"; readonly caseId: CaseId };

export function parseChildArgs(argv: readonly string[]): ParsedChildArgs {
	if (argv.length === 2 && argv[0] === "--child-case" && isCaseId(argv[1])) {
		return { kind: "run", caseId: argv[1] };
	}
	throw new Error("expected exactly --child-case <A0|A1|A2|A3|A4|A5|A6>");
}

export async function runChildCli(argv: readonly string[]): Promise<number> {
	let caseId: CaseId;
	try {
		caseId = parseChildArgs(argv).caseId;
	} catch {
		process.stderr.write("Phase A child: expected exactly --child-case A0..A6\n");
		return 2;
	}
	if (!isChildCaseRunnable(caseId)) {
		process.stderr.write("Phase A child: requested case is not source-prepared\n");
		return 2;
	}
	return runChildCase(caseId);
}
