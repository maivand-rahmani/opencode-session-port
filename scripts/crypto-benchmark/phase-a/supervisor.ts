/**
 * CRYPTO-01 Phase A parent supervisor.
 *
 * Dedicated bounded runner (not the older KDF supervisor): one fresh child at
 * a time, sequential, no retries/resume/escalation. It owns output retention,
 * protocol-sequence validation, deadlines, physical-memory preflight/soft-stop,
 * and verified exit of the exact child handle it spawned. It does not accept
 * arbitrary PIDs, does not use a shell, and does not claim process-tree or
 * memory hard containment.
 *
 * All crypto/KDF/container execution lives in the child. This module imports
 * the Windows memory sampler lazily only when the explicit run branch creates
 * default ports, and imports `bun:ffi` lazily only for a physical-memory probe.
 * Importing this module under Node is inert.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	A0_BRIDGE_MAX_CHILD_STARTS,
	A0_BRIDGE_PLAN,
	A1_CONTROL_MAX_CHILD_STARTS,
	A1_CONTROL_PLAN,
	A2_CONTAINER_MAX_CHILD_STARTS,
	A2_CONTAINER_PLAN,
	A3_A6_SMALL_MAX_CHILD_STARTS,
	A3_A6_SMALL_PLAN,
	CANDIDATE_LIMITS,
	CASE_IDS,
	EXPECTED_LIBSODIUM_PACKAGE_VERSION,
	FULL_PHASE_A_PLAN,
	MAX_CHILD_STARTS,
	PHASE_A_CASES,
	SAMPLES_PER_CASE,
	candidateReport,
	isCaseId,
	validatePhaseARunPlan,
	type CaseId,
	type PhaseACase,
	type PhaseARunMode,
	type PhaseARunPlan,
} from "./cases.ts";
import {
	BoundedLineAssembler,
	ChildMessageState,
	LAUNCH_NONCE_HEX_BYTES,
	LAUNCH_NONCE_ENV,
	LAUNCH_PARENT_PID_ENV,
	LAUNCH_PLAN_MODE_ENV,
	MAX_PROTOCOL_LINE_BYTES,
	PHASE_A_PROTOCOL_VERSION,
	PhaseAProtocolError,
	assertCompleteMatchesCase,
	assertReadyMatchesRequest,
	isLaunchNonce,
	parseChildMessageLine,
	type ChildCompleteMessage,
	type ChildMessage,
	type ChildReadyMessage,
	type ExpectedPhaseARuntime,
	type SafeFailureCode,
} from "./protocol.ts";
import {
	PHASE_A_FRESHNESS_FILES,
	PHASE_A_OPERATIONAL_BOUNDS,
	buildPhaseAReport,
	type LifetimePeakSource,
	type PhaseAFailurePhase,
	type PhaseAFailureRecord,
	type PhaseAFreshnessEntry,
	type PhaseALibsodiumEvidence,
	type PhaseAOperationRecord,
	type PhaseAReport,
	type PhaseAReportStatus,
	type PhaseASampleRecord,
} from "./report.ts";

export interface ProcessMemoryCounters {
	readonly workingSetBytes: number;
	readonly peakWorkingSetBytes: number;
}

export interface ProcessMemoryReader {
	readonly pid: number;
	read(): ProcessMemoryCounters;
	close(): void;
}

export interface ChildStdin {
	write(data: string): unknown;
	flush(): Promise<unknown>;
}

export interface ChildProcessHandle {
	readonly pid: number;
	readonly stdin: ChildStdin;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal?: string): void;
}

export interface PhysicalMemoryReading {
	readonly bytes: number;
	readonly source: string;
}

export interface ActualRuntime {
	readonly bun: string;
	readonly nodeCompat: string;
	readonly platform: string;
	readonly arch: string;
}

export interface PhaseAPorts {
	readonly runtime: ActualRuntime;
	readonly execPath: string;
	readonly childScriptPath: string;
	readonly repositoryRoot: string;
	spawn(command: readonly string[], env: Readonly<Record<string, string>>): ChildProcessHandle;
	openMemoryReader(pid: number): ProcessMemoryReader;
	readonly physicalMemory: { readonly read: () => PhysicalMemoryReading };
	hashFiles(paths: readonly string[]): Promise<readonly PhaseAFreshnessEntry[]>;
	createLaunchNonce(): string;
	collectLibsodiumEvidence(): Promise<PhaseALibsodiumEvidence>;
	now(): number;
	setTimeout(callback: () => void, timeoutMs: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(callback: () => void, intervalMs: number): unknown;
	clearInterval(handle: unknown): void;
	writeStdout(text: string): void;
	writeStderr(text: string): void;
}

export interface PhaseARunResult {
	readonly report: PhaseAReport | null;
	readonly exitCode: 0 | 1 | 2;
	readonly preflightFailure?: SafeFailureCode;
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
	readonly settled: boolean;
	readonly rejected: boolean;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	let settled = false;
	let rejected = false;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = (value) => {
			if (settled) return;
			settled = true;
			resolvePromise(value);
		};
		reject = (error) => {
			if (settled) return;
			settled = true;
			rejected = true;
			rejectPromise(error);
		};
	});
	return {
		promise,
		resolve,
		reject,
		get settled() {
			return settled;
		},
		get rejected() {
			return rejected;
		},
	};
}

interface DeadlineSignal {
	readonly promise: Promise<never>;
	cancel(): void;
}

function createDeadline(timeoutMs: number, ports: PhaseAPorts, code: SafeFailureCode): DeadlineSignal {
	let handle: unknown;
	let cancelled = false;
	const promise = new Promise<never>((_resolve, reject) => {
		handle = ports.setTimeout(() => {
			if (cancelled) return;
			cancelled = true;
			reject(new PhaseAProtocolError(code, `deadline expired after ${timeoutMs} ms`));
		}, timeoutMs);
	});
	void promise.catch(() => undefined);
	return {
		promise,
		cancel() {
			if (cancelled) return;
			cancelled = true;
			ports.clearTimeout(handle);
		},
	};
}

function waitForExit(proc: ChildProcessHandle, timeoutMs: number, ports: PhaseAPorts): Promise<number | null> {
	let handle: unknown;
	const timeout = new Promise<null>((resolve) => {
		handle = ports.setTimeout(() => resolve(null), Math.max(0, timeoutMs));
	});
	return Promise.race([proc.exited, timeout]).finally(() => ports.clearTimeout(handle));
}

/**
 * Terminates only the exact child handle this run spawned. The child script is
 * controlled and imports no spawn/external-command API, but this is still not a
 * descendant-tree termination proof or hard containment claim. If exit cannot
 * be verified inside the grace window, the caller must classify uncertainty and
 * stop without success.
 */
export async function terminateOwnedChild(
	proc: ChildProcessHandle,
	ports: Pick<PhaseAPorts, "setTimeout" | "clearTimeout">,
	graceMs: number,
): Promise<"verified" | "uncertain"> {
	try {
		proc.kill();
	} catch {
		// Already exited or the runtime refused the signal; exit verification follows.
	}
	const firstBudget = graceMs > 1_000 ? graceMs - 1_000 : 0;
	const first = await waitForExit(proc, firstBudget, ports as PhaseAPorts);
	if (first !== null) return "verified";
	try {
		proc.kill("SIGKILL");
	} catch {
		// Follow with the remaining grace window.
	}
	const second = await waitForExit(proc, Math.min(1_000, graceMs), ports as PhaseAPorts);
	return second !== null ? "verified" : "uncertain";
}

/** Shared retained-output budget for one run (4 MiB by default). */
export class RetainedBudget {
	#retained = 0;

	constructor(readonly limitBytes: number) {
		if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
			throw new Error("RetainedBudget requires a non-negative safe integer limit");
		}
	}

	get retainedBytes(): number {
		return this.#retained;
	}

	get remainingBytes(): number {
		return Math.max(0, this.limitBytes - this.#retained);
	}

	reserve(bytes: number): { retained: number; overflow: boolean } {
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new Error("RetainedBudget.reserve requires a non-negative safe integer");
		}
		const allowed = Math.min(bytes, this.remainingBytes);
		this.#retained += allowed;
		return { retained: allowed, overflow: allowed < bytes };
	}
}

/** One bounded stdout or stderr channel with a shared run retained budget. */
export class ChildOutputChannel {
	readonly #chunks: Uint8Array[] = [];
	#totalBytes = 0;
	#retainedBytes = 0;
	overflow = false;
	runOverflow = false;

	constructor(
		readonly perChannelLimitBytes: number,
		readonly runBudget: RetainedBudget,
	) {
		if (!Number.isSafeInteger(perChannelLimitBytes) || perChannelLimitBytes < 0) {
			throw new Error("ChildOutputChannel requires a non-negative safe integer limit");
		}
	}

	get totalBytes(): number {
		return this.#totalBytes;
	}

	get retainedBytes(): number {
		return this.#retainedBytes;
	}

	push(chunk: Uint8Array): void {
		if (!(chunk instanceof Uint8Array)) {
			throw new Error("output stream yielded a non-byte chunk");
		}
		if (chunk.length === 0) return;
		this.#totalBytes += chunk.length;
		if (this.#totalBytes > this.perChannelLimitBytes) {
			this.overflow = true;
		}
		const remainingChannel = Math.max(0, this.perChannelLimitBytes - this.#retainedBytes);
		const desired = Math.min(chunk.length, remainingChannel);
		const reservation = this.runBudget.reserve(desired);
		if (reservation.retained > 0) {
			this.#chunks.push(chunk.slice(0, reservation.retained));
			this.#retainedBytes += reservation.retained;
		}
		if (reservation.overflow) {
			this.runOverflow = true;
		}
	}
}

function failurePhase(code: SafeFailureCode): PhaseAFailurePhase {
	if (code === "invalid-run-plan" || code.startsWith("preflight-")) return "preflight";
	if (code === "spawn-failed" || code === "launch-guard-failed") return "process";
	if (code === "stdin-failed" || code.startsWith("child-exit-")) return "process";
	if (code === "ready-failed") return "process";
	if (code === "runtime-mismatch") return "protocol";
	if (code.startsWith("protocol-")) return "protocol";
	if (code === "output-overflow" || code === "run-output-overflow") return "output";
	if (code === "child-deadline" || code === "run-deadline") return "deadline";
	if (code === "memory-stop" || code === "memory-observability-failed") return "memory";
	if (code === "sampler-failed") return "sampler";
	if (code === "cleanup-uncertain") return "cleanup";
	if (code === "internal") return "internal";
	return "crypto";
}

function makeFailure(
	caseId: CaseId | null,
	sampleIndex: number | null,
	code: SafeFailureCode,
): PhaseAFailureRecord {
	return { caseId, sampleIndex, code, phase: failurePhase(code) };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readPhysicalMemory(ports: PhaseAPorts): PhysicalMemoryReading {
	const reading = ports.physicalMemory.read();
	if (!reading || !isNonNegativeSafeInteger(reading.bytes) || typeof reading.source !== "string" || reading.source.length === 0) {
		throw new Error("physical-memory reading is invalid");
	}
	return reading;
}

export class MemoryObservationTracker {
	#minimumBytes: number;
	#readFailures = 0;

	constructor(initialBytes: number) {
		if (!isNonNegativeSafeInteger(initialBytes)) throw new Error("initial memory must be non-negative");
		this.#minimumBytes = initialBytes;
	}

	observe(bytes: number): void {
		if (!isNonNegativeSafeInteger(bytes)) return;
		if (bytes < this.#minimumBytes) this.#minimumBytes = bytes;
	}

	recordReadFailure(): void {
		this.#readFailures += 1;
	}

	get minimumBytes(): number {
		return this.#minimumBytes;
	}

	get readFailures(): number {
		return this.#readFailures;
	}
}

/** Child protocol/output reader. Never buffers a line beyond 64 KiB. */
export class ChildProtocolSession {
	readonly ready: Promise<ChildReadyMessage>;
	readonly complete: Promise<ChildCompleteMessage>;
	readonly failure: Promise<never>;
	readonly stdoutChannel: ChildOutputChannel;
	readonly stderrChannel: ChildOutputChannel;

	readonly #readyDeferred = deferred<ChildReadyMessage>();
	readonly #completeDeferred = deferred<ChildCompleteMessage>();
	readonly #failureDeferred = deferred<never>();
	readonly #state = new ChildMessageState();
	#failed = false;
	#failureCode: SafeFailureCode | null = null;
	#readyMessage: ChildReadyMessage | null = null;
	#stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	#stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	constructor(
		stdout: ReadableStream<Uint8Array>,
		stderr: ReadableStream<Uint8Array>,
		readonly expectedCase: PhaseACase,
		readonly expectedRuntime: ExpectedPhaseARuntime,
		readonly expectedCandidate: ReturnType<typeof candidateReport>,
		runBudget: RetainedBudget,
	) {
		this.ready = this.#readyDeferred.promise;
		this.complete = this.#completeDeferred.promise;
		this.failure = this.#failureDeferred.promise;
		void this.failure.catch(() => undefined);
		this.stdoutChannel = new ChildOutputChannel(
			PHASE_A_OPERATIONAL_BOUNDS.maxRetainedStdoutBytesPerChild,
			runBudget,
		);
		this.stderrChannel = new ChildOutputChannel(
			PHASE_A_OPERATIONAL_BOUNDS.maxRetainedStderrBytesPerChild,
			runBudget,
		);
		void this.#readStdout(stdout);
		void this.#readStderr(stderr);
	}

	get hasFailed(): boolean {
		return this.#failed;
	}

	get failureCode(): SafeFailureCode | null {
		return this.#failureCode;
	}

	get outputOverflow(): boolean {
		return this.stdoutChannel.overflow || this.stderrChannel.overflow;
	}

	get runOutputOverflow(): boolean {
		return this.stdoutChannel.runOverflow || this.stderrChannel.runOverflow;
	}

	#fail(error: unknown): void {
		if (this.#failed) return;
		const protocolError =
			error instanceof PhaseAProtocolError
				? error
				: new PhaseAProtocolError("internal", "child protocol reader failed");
		this.#failed = true;
		this.#failureCode = protocolError.code;
		this.#failureDeferred.reject(protocolError);
		void this.#stdoutReader?.cancel().catch(() => undefined);
		void this.#stderrReader?.cancel().catch(() => undefined);
	}

	#consume(channel: ChildOutputChannel, chunk: Uint8Array): void {
		channel.push(chunk);
		if (channel.overflow) {
			this.#fail(new PhaseAProtocolError("output-overflow", "child output exceeded a per-stream retention cap"));
			return;
		}
		if (channel.runOverflow) {
			this.#fail(new PhaseAProtocolError("run-output-overflow", "run retained-output budget was exceeded"));
		}
	}

	async #readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		this.#stdoutReader = reader;
		const assembler = new BoundedLineAssembler();
		try {
			for (;;) {
				if (this.#failed) return;
				const step = await reader.read();
				if (step.done) break;
				if (!(step.value instanceof Uint8Array)) {
					throw new PhaseAProtocolError("protocol-invalid", "stdout yielded a non-byte chunk");
				}
				this.#consume(this.stdoutChannel, step.value);
				if (this.#failed) return;
				const lines = assembler.push(step.value);
				for (const line of lines) {
					this.#onLine(line);
					if (this.#failed) return;
				}
			}
			assembler.finish();
			if (!this.#failed && !this.#state.completeSeen) {
				this.#fail(
					new PhaseAProtocolError(
						this.#state.readySeen ? "protocol-missing-completion" : "protocol-missing-ready",
						"child stdout ended before the expected protocol message",
					),
				);
			}
		} catch (error) {
			this.#fail(error);
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// best-effort cleanup
			}
		}
	}

	async #readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		this.#stderrReader = reader;
		try {
			for (;;) {
				if (this.#failed) return;
				const step = await reader.read();
				if (step.done) return;
				if (!(step.value instanceof Uint8Array)) {
					throw new PhaseAProtocolError("protocol-invalid", "stderr yielded a non-byte chunk");
				}
				this.#consume(this.stderrChannel, step.value);
			}
		} catch (error) {
			this.#fail(error);
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// best-effort cleanup
			}
		}
	}

	#onLine(line: string): void {
		let message: ChildMessage;
		try {
			message = parseChildMessageLine(line);
		} catch (error) {
			this.#fail(error);
			return;
		}
		if (message.type === "error") {
			if (message.caseId !== this.expectedCase.id) {
				this.#fail(new PhaseAProtocolError("protocol-case-mismatch", "child error case id does not match"));
				return;
			}
			this.#fail(new PhaseAProtocolError(message.code, "child reported a safe failure"));
			return;
		}
		try {
			this.#state.accept(message);
		} catch (error) {
			this.#fail(error);
			return;
		}
		if (message.type === "ready") {
			try {
				assertReadyMatchesRequest(message, this.expectedCase, this.expectedRuntime, this.expectedCandidate);
			} catch (error) {
				this.#fail(error);
				return;
			}
			this.#readyMessage = message;
			this.#readyDeferred.resolve(message);
			return;
		}
		try {
			assertCompleteMatchesCase(message, this.expectedCase.id);
			if (this.#readyMessage === null || message.pid !== this.#readyMessage.pid) {
				throw new PhaseAProtocolError("protocol-invalid", "completion PID does not match the READY PID");
			}
		} catch (error) {
			this.#fail(error);
			return;
		}
		this.#completeDeferred.resolve(message);
	}
}

async function writeStartCommand(
	stdin: ChildStdin,
	caseId: CaseId,
	launchNonce: string,
	planMode: PhaseARunMode,
): Promise<void> {
	if (!isLaunchNonce(launchNonce)) {
		throw new PhaseAProtocolError("launch-guard-failed", "launch nonce is not a valid supervisor nonce");
	}
	const line = JSON.stringify({
		type: "start",
		protocol: PHASE_A_PROTOCOL_VERSION,
		caseId,
		launchNonce,
		mode: planMode,
	});
	if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
		throw new PhaseAProtocolError("protocol-line-overflow", "start command exceeds 64 KiB");
	}
	stdin.write(`${line}\n`);
	await stdin.flush();
}

function validCounters(counters: ProcessMemoryCounters): boolean {
	return (
		isNonNegativeSafeInteger(counters.workingSetBytes) &&
		isNonNegativeSafeInteger(counters.peakWorkingSetBytes)
	);
}

export interface SingleChildOptions {
	readonly caseDef: PhaseACase;
	readonly sampleIndex: number;
	readonly planMode: PhaseARunMode;
	readonly ports: PhaseAPorts;
	readonly outputBudget: RetainedBudget;
	readonly memoryTracker: MemoryObservationTracker;
	readonly launchNonces: Set<string>;
	readonly runDeadlineAt: number;
}

export type SingleChildResult =
	| { readonly kind: "sample"; readonly sample: PhaseASampleRecord; readonly spawned: true }
	| {
			readonly kind: "failure";
			readonly failures: readonly PhaseAFailureRecord[];
			readonly stop: boolean;
			readonly spawned: boolean;
	  };

export async function runSingleChild(options: SingleChildOptions): Promise<SingleChildResult> {
	const { caseDef, sampleIndex, planMode, ports, outputBudget, memoryTracker, launchNonces, runDeadlineAt } = options;
	const remainingRunMs = runDeadlineAt - ports.now();
	if (remainingRunMs <= 0) {
		return { kind: "failure", failures: [makeFailure(caseDef.id, sampleIndex, "run-deadline")], stop: true, spawned: false };
	}
	const deadlineCode: SafeFailureCode = remainingRunMs < PHASE_A_OPERATIONAL_BOUNDS.childDeadlineMs ? "run-deadline" : "child-deadline";
	const childDeadlineMs = Math.min(PHASE_A_OPERATIONAL_BOUNDS.childDeadlineMs, remainingRunMs);

	let launchNonce: string;
	try {
		launchNonce = ports.createLaunchNonce();
	} catch {
		return { kind: "failure", failures: [makeFailure(caseDef.id, sampleIndex, "launch-guard-failed")], stop: true, spawned: false };
	}
	if (!isLaunchNonce(launchNonce)) {
		return { kind: "failure", failures: [makeFailure(caseDef.id, sampleIndex, "launch-guard-failed")], stop: true, spawned: false };
	}
	if (launchNonces.has(launchNonce)) {
		return { kind: "failure", failures: [makeFailure(caseDef.id, sampleIndex, "launch-guard-failed")], stop: true, spawned: false };
	}
	launchNonces.add(launchNonce);
	const launchEnv = {
		[LAUNCH_NONCE_ENV]: launchNonce,
		[LAUNCH_PARENT_PID_ENV]: String(process.pid),
		[LAUNCH_PLAN_MODE_ENV]: planMode,
	};

	let proc: ChildProcessHandle;
	try {
		proc = ports.spawn([ports.execPath, ports.childScriptPath, "--child-case", caseDef.id], launchEnv);
	} catch {
		return { kind: "failure", failures: [makeFailure(caseDef.id, sampleIndex, "spawn-failed")], stop: true, spawned: false };
	}

	const deadline = createDeadline(childDeadlineMs, ports, deadlineCode);
	const memoryStop = deferred<never>();
	let reader: ProcessMemoryReader | null = null;
	let intervalHandle: unknown;
	let operationStartedAt = 0;
	const pollWorkingSets: number[] = [];
	const pollTimes: number[] = [];

	try {
		try {
			reader = ports.openMemoryReader(proc.pid);
		} catch {
			throw new PhaseAProtocolError("sampler-failed", "could not open the owned child process-memory sampler");
		}

		const session = new ChildProtocolSession(
			proc.stdout,
			proc.stderr,
			caseDef,
			ports.runtime,
			candidateReport(),
			outputBudget,
		);

		const ready = await Promise.race([session.ready, session.failure, deadline.promise]);
		void ready;

		let baseline: ProcessMemoryCounters;
		try {
			baseline = reader.read();
		} catch {
			throw new PhaseAProtocolError("sampler-failed", "could not read the pre-operation baseline working set");
		}
		if (!validCounters(baseline)) {
			throw new PhaseAProtocolError("sampler-failed", "pre-operation working-set counters are invalid");
		}

		try {
			await writeStartCommand(proc.stdin, caseDef.id, launchNonce, planMode);
		} catch {
			throw new PhaseAProtocolError("stdin-failed", "could not write the bounded start command");
		}
		operationStartedAt = ports.now();

		intervalHandle = ports.setInterval(() => {
			if (memoryStop.rejected || session.hasFailed) return;
			try {
				const counters = reader!.read();
				if (validCounters(counters)) {
					pollWorkingSets.push(counters.workingSetBytes);
					pollTimes.push(ports.now() - operationStartedAt);
				}
			} catch {
				// The child may have exited between polls; the end-of-operation read is authoritative.
			}
			try {
				const memory = readPhysicalMemory(ports);
				memoryTracker.observe(memory.bytes);
				if (memory.bytes < PHASE_A_OPERATIONAL_BOUNDS.physicalMemoryStopBelowBytes) {
					memoryStop.reject(
						new PhaseAProtocolError("memory-stop", "available physical memory fell below the operational stop floor"),
					);
				}
			} catch {
				memoryTracker.recordReadFailure();
				memoryStop.reject(
					new PhaseAProtocolError(
						"memory-observability-failed",
						"physical-memory read failed during the monitored interval",
					),
				);
			}
		}, PHASE_A_OPERATIONAL_BOUNDS.memoryPollIntervalMs);

		const complete = await Promise.race([
			session.complete,
			session.failure,
			deadline.promise,
			memoryStop.promise,
		]);
		deadline.cancel();
		if (intervalHandle !== undefined) {
			ports.clearInterval(intervalHandle);
			intervalHandle = undefined;
		}
		if (memoryStop.rejected) {
			throw new PhaseAProtocolError("memory-stop", "run stopped because physical memory fell below the stop floor");
		}

		let atEnd: ProcessMemoryCounters;
		try {
			atEnd = reader.read();
		} catch {
			throw new PhaseAProtocolError("sampler-failed", "could not read end-of-operation working-set counters");
		}
		if (!validCounters(atEnd)) {
			throw new PhaseAProtocolError("sampler-failed", "end-of-operation working-set counters are invalid");
		}

		const exitCode = await waitForExit(proc, PHASE_A_OPERATIONAL_BOUNDS.childStopGraceMs, ports);
		if (exitCode === null) {
			throw new PhaseAProtocolError("child-exit-timeout", "owned child did not exit inside the stop grace window");
		}
		if (exitCode !== 0) {
			throw new PhaseAProtocolError("child-exit-nonzero", "owned child exited with a non-zero code");
		}
		if (session.hasFailed) {
			throw new PhaseAProtocolError(session.failureCode ?? "protocol-invalid", "child protocol/output failed");
		}

		let postExit: ProcessMemoryCounters | null = null;
		try {
			const counters = reader.read();
			if (validCounters(counters) && counters.peakWorkingSetBytes > 0) postExit = counters;
		} catch {
			postExit = null;
		}

		const sampledPeakWorkingSetBytes = Math.max(
			baseline.workingSetBytes,
			atEnd.workingSetBytes,
			...pollWorkingSets,
		);
		const sampledIncrementalWorkingSetBytes = Math.max(0, sampledPeakWorkingSetBytes - baseline.workingSetBytes);
		const lifetimePeakWorkingSetBytes = Math.max(
			atEnd.peakWorkingSetBytes,
			postExit?.peakWorkingSetBytes ?? 0,
			sampledPeakWorkingSetBytes,
		);
		const lifetimePeakSource: LifetimePeakSource =
			postExit !== null && postExit.peakWorkingSetBytes >= atEnd.peakWorkingSetBytes
				? "post-exit-query"
				: "query-after-last-operation";

		if (!complete.ok) {
			return {
				kind: "failure",
				failures: [makeFailure(caseDef.id, sampleIndex, complete.failureCode)],
				stop: false,
				spawned: true,
			};
		}
		const operations: readonly PhaseAOperationRecord[] = complete.operations ?? [];
		if (operations.some((operation) => !operation.roundTripMatched)) {
			return {
				kind: "failure",
				failures: [makeFailure(caseDef.id, sampleIndex, "roundtrip-mismatch")],
				stop: false,
				spawned: true,
			};
		}

		const sample: PhaseASampleRecord = {
			caseId: caseDef.id,
			sampleIndex,
			childPid: proc.pid,
			childExitCode: 0,
			runtime: ready.runtime,
			baselineWorkingSetBytes: baseline.workingSetBytes,
			sampledIncrementalWorkingSetBytes,
			sampledPollCount: pollWorkingSets.length,
			samplingSpanMs: pollTimes.length > 0 ? pollTimes[pollTimes.length - 1]! : 0,
			lifetimePeakWorkingSetBytes,
			lifetimePeakSource,
			termination: "owned-child-exit-verified",
			operations,
			kdfControlMs: complete.kdfControlMs ?? null,
		};
		return { kind: "sample", sample, spawned: true };
	} catch (error) {
		const code = error instanceof PhaseAProtocolError ? error.code : "internal";
		const termination = await terminateOwnedChild(proc, ports, PHASE_A_OPERATIONAL_BOUNDS.childStopGraceMs);
		const failures: PhaseAFailureRecord[] = [makeFailure(caseDef.id, sampleIndex, code)];
		if (termination === "uncertain") {
			failures.push(makeFailure(caseDef.id, sampleIndex, "cleanup-uncertain"));
		}
		return { kind: "failure", failures, stop: true, spawned: true };
	} finally {
		deadline.cancel();
		if (intervalHandle !== undefined) ports.clearInterval(intervalHandle);
		reader?.close();
	}
}

export function checkSupportedRuntime(runtime: ActualRuntime): { ok: true } | { ok: false; code: SafeFailureCode } {
	if (runtime.platform !== "win32") return { ok: false, code: "preflight-runtime" };
	if (runtime.bun !== "1.3.10") return { ok: false, code: "preflight-runtime" };
	if (runtime.arch !== "x64" && runtime.arch !== "arm64") return { ok: false, code: "preflight-runtime" };
	if (typeof runtime.nodeCompat !== "string" || runtime.nodeCompat.length === 0) {
		return { ok: false, code: "preflight-runtime" };
	}
	return { ok: true };
}

function expectedRuntimeFor(runtime: ActualRuntime): ExpectedPhaseARuntime {
	return {
		bun: "1.3.10",
		nodeCompat: runtime.nodeCompat,
		platform: "win32",
		arch: runtime.arch,
	};
}

function uniqueChildRuntimes(samples: readonly PhaseASampleRecord[]) {
	const seen = new Set<string>();
	const runtimes = [];
	for (const sample of samples) {
		const key = JSON.stringify(sample.runtime);
		if (seen.has(key)) continue;
		seen.add(key);
		runtimes.push(sample.runtime);
	}
	return runtimes;
}

export async function runPhaseA(ports: PhaseAPorts, plan: PhaseARunPlan): Promise<PhaseARunResult> {
	const planError = validatePhaseARunPlan(plan);
	if (planError !== null) {
		ports.writeStderr("[phase-a] preflight failed: invalid-run-plan\n");
		return { report: null, exitCode: 1, preflightFailure: "invalid-run-plan" };
	}
	const runtimeCheck = checkSupportedRuntime(ports.runtime);
	if (!runtimeCheck.ok) {
		ports.writeStderr(`[phase-a] preflight failed: ${runtimeCheck.code}\n`);
		return { report: null, exitCode: 1, preflightFailure: runtimeCheck.code };
	}

	const runStarted = ports.now();
	const runDeadlineAt = runStarted + plan.runDeadlineMs;

	let preflightMemory: PhysicalMemoryReading;
	try {
		preflightMemory = readPhysicalMemory(ports);
	} catch {
		ports.writeStderr("[phase-a] preflight failed: preflight-memory\n");
		return { report: null, exitCode: 1, preflightFailure: "preflight-memory" };
	}
	if (preflightMemory.bytes < PHASE_A_OPERATIONAL_BOUNDS.physicalMemoryPreflightBytes) {
		ports.writeStderr("[phase-a] preflight failed: preflight-memory\n");
		return { report: null, exitCode: 1, preflightFailure: "preflight-memory" };
	}
	const memoryTracker = new MemoryObservationTracker(preflightMemory.bytes);

	let freshness: readonly PhaseAFreshnessEntry[];
	let freshnessCapturedAtIso: string;
	try {
		freshness = await ports.hashFiles(PHASE_A_FRESHNESS_FILES);
		if (freshness.length !== PHASE_A_FRESHNESS_FILES.length) {
			throw new Error("freshness hash count mismatch");
		}
		freshnessCapturedAtIso = new Date(Date.now()).toISOString();
	} catch {
		ports.writeStderr("[phase-a] preflight failed: preflight-hash\n");
		return { report: null, exitCode: 1, preflightFailure: "preflight-hash" };
	}

	let libsodium: PhaseALibsodiumEvidence;
	try {
		libsodium = await ports.collectLibsodiumEvidence();
		validateLibsodiumEvidence(libsodium);
	} catch {
		ports.writeStderr("[phase-a] preflight failed: preflight-libsodium-metadata\n");
		return { report: null, exitCode: 1, preflightFailure: "preflight-libsodium-metadata" };
	}

	const outputBudget = new RetainedBudget(PHASE_A_OPERATIONAL_BOUNDS.maxRetainedOutputBytesPerRun);
	const launchNonces = new Set<string>();
	const samples: PhaseASampleRecord[] = [];
	const failures: PhaseAFailureRecord[] = [];
	let attemptedSamples = 0;
	let childStarts = 0;
	let stopped = false;

	outer: for (const caseId of plan.caseIds) {
		const caseDef = PHASE_A_CASES.find((definition) => definition.id === caseId);
		if (caseDef === undefined) {
			failures.push(makeFailure(null, null, "internal"));
			stopped = true;
			break outer;
		}
		for (let sampleIndex = 0; sampleIndex < plan.samplesPerCase; sampleIndex += 1) {
			if (stopped) break outer;
			if (runDeadlineAt - ports.now() <= 0) {
				failures.push(makeFailure(null, null, "run-deadline"));
				stopped = true;
				break outer;
			}

			let memory: PhysicalMemoryReading;
			try {
				memory = readPhysicalMemory(ports);
			} catch {
				memoryTracker.recordReadFailure();
				failures.push(makeFailure(null, null, "memory-observability-failed"));
				stopped = true;
				break outer;
			}
			memoryTracker.observe(memory.bytes);
			if (memory.bytes < PHASE_A_OPERATIONAL_BOUNDS.physicalMemoryStopBelowBytes) {
				failures.push(makeFailure(null, null, "memory-stop"));
				stopped = true;
				break outer;
			}

			attemptedSamples += 1;
			const result = await runSingleChild({
				caseDef,
				sampleIndex,
				planMode: plan.mode,
				ports,
				outputBudget,
				memoryTracker,
				launchNonces,
				runDeadlineAt,
			});
			if (result.spawned) childStarts += 1;
			if (result.kind === "sample") {
				samples.push(result.sample);
				ports.writeStderr(
					`[phase-a] ${caseDef.id} sample ${sampleIndex + 1}/${plan.samplesPerCase} completed\n`,
				);
			} else {
				failures.push(...result.failures);
				const firstCode = result.failures[0]?.code ?? "internal";
				ports.writeStderr(
					`[phase-a] ${caseDef.id} sample ${sampleIndex + 1}/${plan.samplesPerCase} failed: ${firstCode}\n`,
				);
				if (result.stop) {
					stopped = true;
					break outer;
				}
			}
		}
	}

	const status: PhaseAReportStatus = stopped
		? "stopped-safety"
		: failures.length > 0
			? "completed-with-failures"
			: "completed";
	const generatedAtIso = new Date(Date.now()).toISOString();
	let report: PhaseAReport;
	try {
		report = buildPhaseAReport({
			generatedAtIso,
			status,
			plan,
			attemptedSamples,
			childStarts,
			stoppedBySafety: stopped,
			retainedOutputBytes: outputBudget.retainedBytes,
			runtime: {
				expected: expectedRuntimeFor(ports.runtime),
				parent: {
					bun: ports.runtime.bun,
					nodeCompat: ports.runtime.nodeCompat,
					platform: ports.runtime.platform,
					arch: ports.runtime.arch,
				},
				children: uniqueChildRuntimes(samples),
			},
			freshness: {
				algorithm: "sha256",
				capturedAtIso: freshnessCapturedAtIso,
				files: freshness,
			},
			libsodium,
			memory: {
				preflightRequiredBytes: PHASE_A_OPERATIONAL_BOUNDS.physicalMemoryPreflightBytes,
				stopBelowBytes: PHASE_A_OPERATIONAL_BOUNDS.physicalMemoryStopBelowBytes,
				source: preflightMemory.source,
				observedBeforeRunBytes: preflightMemory.bytes,
				observedMinimumDuringRunBytes: memoryTracker.minimumBytes,
				physicalMemoryReadFailures: memoryTracker.readFailures,
			},
			samples,
			failures,
		});
	} catch {
		ports.writeStderr("[phase-a] report assembly failed: internal\n");
		return { report: null, exitCode: 1, preflightFailure: "internal" };
	}

	const exitCode: 0 | 1 | 2 = status === "completed" ? 0 : 2;
	ports.writeStderr(
		`[phase-a] ${status}: ${samples.length}/${plan.maxChildStarts} samples completed, ${failures.length} failure record(s), ` +
			`child starts ${childStarts}, retained output ${outputBudget.retainedBytes} bytes, ` +
			`plan ${plan.mode}, max child envelope ${plan.maxChildStarts * (PHASE_A_OPERATIONAL_BOUNDS.childDeadlineMs + PHASE_A_OPERATIONAL_BOUNDS.childStopGraceMs)} ms <= run deadline ${plan.runDeadlineMs} ms\n`,
	);
	return { report, exitCode };
}

export interface SupervisorArgs {
	readonly kind:
		| "bridge-a0-only"
		| "control-a1-only"
		| "container-a2-only"
		| "small-a3-a6-only"
		| "full-review-required"
		| "help";
}

export function parseSupervisorArgs(argv: readonly string[]): SupervisorArgs {
	if (argv.length === 1 && argv[0] === "--bridge-a0-only") return { kind: "bridge-a0-only" };
	if (argv.length === 1 && argv[0] === "--control-a1-only") return { kind: "control-a1-only" };
	if (argv.length === 1 && argv[0] === "--container-a2-only") return { kind: "container-a2-only" };
	if (argv.length === 1 && argv[0] === "--small-a3-a6-only") return { kind: "small-a3-a6-only" };
	if (argv.length === 1 && argv[0] === "--run-phase-a") return { kind: "full-review-required" };
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { kind: "help" };
	throw new Error(
		"explicit --small-a3-a6-only, --container-a2-only, --control-a1-only, --bridge-a0-only, or --run-phase-a flag is required (help: --help)",
	);
}

export function shouldDispatchCli(importMetaMain: boolean): boolean {
	// Direct execution dispatches to the CLI; the CLI itself still requires an
	// explicit flag. Module import (and Node's test runner) never dispatches.
	return importMetaMain;
}

export const PHASE_A_USAGE = `SessionPort CRYPTO-01 Phase A small-only diagnostic harness (INERT SOURCE; review required before execution).

Usage:
  bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --small-a3-a6-only
  bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --container-a2-only
  bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --control-a1-only
  bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --bridge-a0-only
  bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --run-phase-a   (FAILS CLOSED NOW)

--small-a3-a6-only is the new grouped A3-A6 mode: A3, A4, A5, A6 only,
3 fresh samples per case, max 12 child starts, strict sequential. It is SOURCE
ONLY and has never been executed; separate Oracle exact-source review and
explicit safety GO are required before any A3-A6 execution.

Future grouped outer-wrapper planning label: 900,000 ms. This is an operational
planning label for 12 children, not a product budget. Existing A0/A1/A2 modes
remain source modes; do not run them in this preparation phase.

--run-phase-a fails closed before runtime setup or child launch: full A0-A6
execution is not authorized. There is no default run mode.

The internal child mode is spawned only by the supervisor. The child requires
supervisor plan-mode, nonce, and parent-PID context and rejects mismatched
case/mode or direct bare invocation.

Requirements: Windows x64/arm64, Bun 1.3.10. Node unit tests do not prove Bun
measurements. No full Phase A authorization and no CRYPTO-01 pass is implied.
`;

function getBunRuntime(): {
	spawn(
		command: readonly string[],
		options: {
			stdin: "pipe";
			stdout: "pipe";
			stderr: "pipe";
			env: Record<string, string | undefined>;
		},
	): ChildProcessHandle;
} {
	const bun = (
		globalThis as {
			Bun?: {
				spawn(
					command: readonly string[],
					options: {
						stdin: "pipe";
						stdout: "pipe";
						stderr: "pipe";
						env: Record<string, string | undefined>;
					},
				): ChildProcessHandle;
			};
		}
	).Bun;
	if (bun === undefined) {
		throw new Error("the Bun runtime is unavailable");
	}
	return bun;
}

interface FfiModule {
	dlopen(
		name: string,
		symbols: Record<string, { args: readonly unknown[]; returns: unknown }>,
	): { symbols: Record<string, (...args: unknown[]) => number> };
	readonly FFIType: { readonly ptr: unknown; readonly i32: unknown };
}

async function createPhysicalMemoryReader(): Promise<{ read(): PhysicalMemoryReading }> {
	try {
		const ffiSpecifier = ["bun", "ffi"].join(":");
		const ffi = (await import(ffiSpecifier)) as FfiModule;
		const kernel32 = ffi.dlopen("kernel32.dll", {
			GlobalMemoryStatusEx: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
		});
		const getMemoryStatus = kernel32.symbols["GlobalMemoryStatusEx"];
		if (getMemoryStatus === undefined) throw new Error("GlobalMemoryStatusEx is unavailable");
		const buffer = new Uint8Array(64);
		const view = new DataView(buffer.buffer);
		return {
			read() {
				view.setUint32(0, 64, true);
				if (getMemoryStatus(buffer) === 0) {
					throw new Error("GlobalMemoryStatusEx failed");
				}
				return {
					bytes: Number(view.getBigUint64(16, true)),
					source: "GlobalMemoryStatusEx",
				};
			},
		};
	} catch {
		return {
			read() {
				return { bytes: os.freemem(), source: "os.freemem" };
			},
		};
	}
}

export interface BunLockMetadata {
	readonly entryFound: boolean;
	readonly resolvedVersion: string | null;
	readonly integrity: string | null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pure read-only parser for a bun.lock package entry (lock metadata, not installed bytes). */
export function parseBunLockMetadata(
	lockText: string,
	packageName = "libsodium-wrappers-sumo",
): BunLockMetadata {
	if (typeof lockText !== "string" || lockText.length === 0) {
		return { entryFound: false, resolvedVersion: null, integrity: null };
	}
	const escaped = escapeRegExp(packageName);
	const pattern = new RegExp(
		`"${escaped}":\\s*\\[\\s*"${escaped}@([^"]+)"[\\s\\S]*?"(sha512-[^"]+)"\\s*\\]`,
	);
	const match = pattern.exec(lockText);
	if (match === null) {
		return { entryFound: false, resolvedVersion: null, integrity: null };
	}
	return {
		entryFound: true,
		resolvedVersion: match[1]!,
		integrity: match[2]!,
	};
}

async function resolveInstalledPackageJsonPath(packageName: string): Promise<string> {
	const require = createRequire(import.meta.url);
	try {
		return require.resolve(`${packageName}/package.json`);
	} catch {
		// The package "exports" map may not expose package.json. Walk up from
		// the resolved entry point instead of guessing a path.
	}
	const entry = require.resolve(packageName);
	let directory = path.dirname(entry);
	for (let depth = 0; depth < 8; depth += 1) {
		const candidate = path.join(directory, "package.json");
		try {
			const raw = await readFile(candidate, "utf8");
			const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
			if (parsed.name === packageName && typeof parsed.version === "string") return candidate;
		} catch {
			// Continue walking toward the package root.
		}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`could not resolve the installed ${packageName} package.json`);
}

export async function collectLibsodiumEvidence(repositoryRoot: string): Promise<PhaseALibsodiumEvidence> {
	const packageName = "libsodium-wrappers-sumo";
	const resolvedPackageJsonPath = await resolveInstalledPackageJsonPath(packageName);
	const packageJsonBytes = await readFile(resolvedPackageJsonPath);
	const packageJsonText = packageJsonBytes.toString("utf8");
	const parsed = JSON.parse(packageJsonText) as { name?: unknown; version?: unknown };
	if (parsed.name !== packageName || typeof parsed.version !== "string" || parsed.version.length === 0) {
		throw new Error("resolved libsodium package.json does not have the expected name/version");
	}
	const lockText = await readFile(path.join(repositoryRoot, "bun.lock"), "utf8");
	const lock = parseBunLockMetadata(lockText, packageName);
	return {
		packageName,
		expectedVersion: EXPECTED_LIBSODIUM_PACKAGE_VERSION,
		installed: {
			version: parsed.version,
			resolvedPackageJsonPath,
			packageJsonBytes: packageJsonBytes.length,
			packageJsonSha256: createHash("sha256").update(packageJsonBytes).digest("hex"),
			installedBytesIntegrityVerified: false,
		},
		lock: {
			path: "bun.lock",
			entryFound: lock.entryFound,
			resolvedVersion: lock.resolvedVersion,
			integrity: lock.integrity,
			integrityKind: "lock-metadata",
			installedBytesVerified: false,
		},
		versionMatchesLock: lock.entryFound && lock.resolvedVersion === parsed.version,
		note:
			"Resolved package.json metadata and matching bun.lock entry only. Lock integrity is metadata, not proof of installed/extracted bytes; no archive hash or installed-package integrity verification was performed. Version strings are not integrity proofs.",
	};
}

export function validateLibsodiumEvidence(evidence: PhaseALibsodiumEvidence): void {
	if (evidence.packageName !== "libsodium-wrappers-sumo") {
		throw new Error("libsodium package name mismatch");
	}
	if (evidence.expectedVersion !== EXPECTED_LIBSODIUM_PACKAGE_VERSION) {
		throw new Error("libsodium expected-version marker mismatch");
	}
	if (evidence.installed.version !== EXPECTED_LIBSODIUM_PACKAGE_VERSION) {
		throw new Error("resolved libsodium package version does not match the candidate pin");
	}
	if (!evidence.lock.entryFound || evidence.lock.resolvedVersion !== evidence.installed.version) {
		throw new Error("bun.lock entry does not match the resolved libsodium package version");
	}
	if (evidence.lock.integrity === null || !evidence.lock.integrity.startsWith("sha512-")) {
		throw new Error("bun.lock integrity metadata is missing or malformed");
	}
	if (!evidence.versionMatchesLock) {
		throw new Error("libsodium version/lock match flag is not true");
	}
	if (!/^[0-9a-f]{64}$/.test(evidence.installed.packageJsonSha256)) {
		throw new Error("installed package.json source hash is malformed");
	}
	if (!isNonNegativeSafeInteger(evidence.installed.packageJsonBytes)) {
		throw new Error("installed package.json byte count is malformed");
	}
	if (evidence.installed.installedBytesIntegrityVerified !== false || evidence.lock.installedBytesVerified !== false) {
		throw new Error("libsodium evidence must not claim installed-byte integrity verification");
	}
	if (evidence.lock.integrityKind !== "lock-metadata") {
		throw new Error("libsodium lock evidence kind must remain lock-metadata");
	}
}

export async function createDefaultPorts(): Promise<PhaseAPorts> {
	const bun = getBunRuntime();
	const winmemSpecifier = ["..", "lib", "winmem.ts"].join("/");
	const winmem = (await import(winmemSpecifier)) as {
		openProcessMemoryReader(pid: number): ProcessMemoryReader;
	};
	const physicalMemory = await createPhysicalMemoryReader();
	const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
	const childScriptPath = fileURLToPath(new URL("./phase-a.node.ts", import.meta.url));

	return {
		runtime: {
			bun: (process.versions as { bun?: string }).bun ?? "unknown",
			nodeCompat: process.versions.node,
			platform: process.platform,
			arch: process.arch,
		},
		execPath: process.execPath,
		childScriptPath,
		repositoryRoot,
		spawn(command, launchEnv) {
			return bun.spawn([...command], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, ...launchEnv },
			});
		},
		openMemoryReader(pid) {
			return winmem.openProcessMemoryReader(pid);
		},
		physicalMemory,
		async hashFiles(paths) {
			const entries: PhaseAFreshnessEntry[] = [];
			for (const relativePath of paths) {
				const bytes = await readFile(path.join(repositoryRoot, relativePath));
				entries.push({
					path: relativePath,
					bytes: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				});
			}
			return entries;
		},
		createLaunchNonce() {
			return randomBytes(LAUNCH_NONCE_HEX_BYTES).toString("hex");
		},
		async collectLibsodiumEvidence() {
			return collectLibsodiumEvidence(repositoryRoot);
		},
		now: () => performance.now(),
		setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
		clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
		writeStdout: (text) => {
			process.stdout.write(text);
		},
		writeStderr: (text) => {
			process.stderr.write(text);
		},
	};
}

export async function runSupervisorCli(argv: readonly string[]): Promise<number> {
	let parsed: SupervisorArgs;
	try {
		parsed = parseSupervisorArgs(argv);
	} catch {
		process.stderr.write(`${PHASE_A_USAGE}\n`);
		return 1;
	}
	if (parsed.kind === "help") {
		process.stdout.write(`${PHASE_A_USAGE}\n`);
		return 0;
	}
	if (parsed.kind === "full-review-required") {
		process.stderr.write(
			"[phase-a] --run-phase-a is FAIL-CLOSED: full A0-A6 execution is not authorized. " +
				"Only A0-bridge, A1-control, A2-container, and grouped A3-A6 source modes are prepared; independent exact-source review and explicit safety GO are required before any execution.\n",
		);
		return 1;
	}
	if (
		parsed.kind !== "bridge-a0-only" &&
		parsed.kind !== "control-a1-only" &&
		parsed.kind !== "container-a2-only" &&
		parsed.kind !== "small-a3-a6-only"
	) {
		process.stderr.write("[phase-a] no run mode selected\n");
		return 1;
	}

	const runtime = {
		bun: (process.versions as { bun?: string }).bun ?? "unknown",
		nodeCompat: process.versions.node,
		platform: process.platform,
		arch: process.arch,
	};
	const supported = checkSupportedRuntime(runtime);
	if (!supported.ok) {
		process.stderr.write(
			`[phase-a] preflight failed: ${supported.code} (requires Windows x64/arm64 and Bun 1.3.10)\n`,
		);
		return 1;
	}

	let ports: PhaseAPorts;
	try {
		ports = await createDefaultPorts();
	} catch {
		process.stderr.write("[phase-a] preflight failed: preflight-sampler\n");
		return 1;
	}
	const plan =
		parsed.kind === "small-a3-a6-only"
			? A3_A6_SMALL_PLAN
			: parsed.kind === "container-a2-only"
				? A2_CONTAINER_PLAN
				: parsed.kind === "control-a1-only"
					? A1_CONTROL_PLAN
					: A0_BRIDGE_PLAN;
	const result = await runPhaseA(ports, plan);
	if (result.report !== null) {
		ports.writeStdout(`${JSON.stringify(result.report, null, 2)}\n`);
	} else {
		ports.writeStderr(`[phase-a] preflight failed: ${result.preflightFailure ?? "internal"}\n`);
	}
	return result.exitCode;
}

export const SUPERVISOR_CASE_IDS = CASE_IDS;
export const SUPERVISOR_SAMPLE_COUNT = SAMPLES_PER_CASE;
export const SUPERVISOR_MAX_CHILD_STARTS = MAX_CHILD_STARTS;
export const SUPERVISOR_A0_BRIDGE_MAX_CHILD_STARTS = A0_BRIDGE_MAX_CHILD_STARTS;
export const SUPERVISOR_A1_CONTROL_MAX_CHILD_STARTS = A1_CONTROL_MAX_CHILD_STARTS;
export const SUPERVISOR_A2_CONTAINER_MAX_CHILD_STARTS = A2_CONTAINER_MAX_CHILD_STARTS;
export const SUPERVISOR_A3_A6_SMALL_MAX_CHILD_STARTS = A3_A6_SMALL_MAX_CHILD_STARTS;
export const SUPERVISOR_A0_BRIDGE_PLAN = A0_BRIDGE_PLAN;
export const SUPERVISOR_A1_CONTROL_PLAN = A1_CONTROL_PLAN;
export const SUPERVISOR_A2_CONTAINER_PLAN = A2_CONTAINER_PLAN;
export const SUPERVISOR_A3_A6_SMALL_PLAN = A3_A6_SMALL_PLAN;
export const SUPERVISOR_FULL_PHASE_A_PLAN = FULL_PHASE_A_PLAN;
export const SUPERVISOR_CANDIDATE_LIMITS = CANDIDATE_LIMITS;
export const SUPERVISOR_CASE_PLAN = PHASE_A_CASES;
export const SUPERVISOR_IS_CASE_ID = isCaseId;
