/**
 * Supervisor orchestration for the Windows-only KDF diagnostic harness.
 *
 * One sample = one fresh child process, processed strictly sequentially:
 *   spawn child -> wait READY (sodium.ready + synthetic bytes prepared)
 *   -> read pre-KDF working-set baseline -> send GO
 *   -> poll child working set while the synchronous KDF blocks it
 *   -> receive sample -> read alive peak -> send EXIT -> await exit
 *   -> read retained post-exit peak (fallback to the alive read)
 *
 * The supervisor never samples memory from the blocked child; all memory reads
 * go through Windows GetProcessMemoryInfo (see lib/winmem.ts), in bytes.
 *
 * This module has no CLI side effects; supervisor.ts is the entry point.
 */

import type { ChildMessage, ChildReadyMessage, ChildVersionsReport } from "./lib/protocol.ts";
import {
	assertReadyMatchesRequestedSettings,
	parseChildMessage,
	type ExpectedKdfSettings,
} from "./lib/protocol.ts";
import type { LifetimePeakSource, SampleRecord } from "./lib/report.ts";
import { openProcessMemoryReader, type ProcessMemoryReader } from "./lib/winmem.ts";

export interface SampleSessionOptions {
	/** Child command line, e.g. [process.execPath, pathToChildScript, "--child", "--ops", n, "--memory-mib", n]. */
	command: readonly string[];
	/** Requested working-set poll interval during the KDF window, milliseconds. */
	intervalMs: number;
	/** Exact diagnostic candidate settings the child must report in READY (fail-closed check). */
	expectedKdfSettings: ExpectedKdfSettings;
	readyTimeoutMs?: number;
	sampleTimeoutMs?: number;
	exitTimeoutMs?: number;
}

export interface SampleSessionResult {
	record: SampleRecord;
	versions: ChildVersionsReport;
	stderrText: string;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_SAMPLE_TIMEOUT_MS = 60_000;
const DEFAULT_EXIT_TIMEOUT_MS = 15_000;

export async function runSampleSession(index: number, options: SampleSessionOptions): Promise<SampleSessionResult> {
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const sampleTimeoutMs = options.sampleTimeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS;
	const exitTimeoutMs = options.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;

	const proc = Bun.spawn([...options.command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	let reader: ProcessMemoryReader | null = null;

	try {
		reader = openProcessMemoryReader(proc.pid);
		const memoryReader = reader;
		const stderrTextPromise = collectStreamText(proc.stderr);
		const pump = new ChildMessagePump(proc.stdout);

		const ready = await withTimeout(
			Promise.race([
				pump.ready,
				pump.failure.then((error) => {
					throw error;
				}),
				proc.exited.then((code) => {
					throw new Error(`child exited (code ${code}) before READY`);
				}),
			]),
			readyTimeoutMs,
			"waiting for child READY",
		);
		assertReadyMatchesRequestedSettings(ready, options.expectedKdfSettings);

		// Pre-KDF baseline: child is alive and idle-waiting for GO; sodium is
		// initialized and synthetic bytes are prepared, so both are excluded here.
		const baseline = memoryReader.read();

		const goTime = performance.now();
		await writeChildCommand(proc.stdin, "GO");

		const pollSamples: Array<{ tMs: number; workingSetBytes: number }> = [];
		let polling = true;
		const pollTask = (async () => {
			while (polling) {
				await Bun.sleep(options.intervalMs);
				if (!polling) {
					break;
				}
				try {
					pollSamples.push({ tMs: performance.now() - goTime, workingSetBytes: memoryReader.read().workingSetBytes });
				} catch {
					break; // child exited or handle closed; stop quietly
				}
			}
		})();

		const sample = await withTimeout(
			Promise.race([
				pump.sample,
				pump.failure.then((error) => {
					throw error;
				}),
				proc.exited.then((code) => {
					throw new Error(`child exited (code ${code}) before reporting a sample`);
				}),
			]),
			sampleTimeoutMs,
			"waiting for the KDF sample",
		);
		polling = false;

		// Alive read immediately after the KDF call: PeakWorkingSetSize so far.
		const atKdfEnd = memoryReader.read();

		await writeChildCommand(proc.stdin, "EXIT");
		const exitCode = await withTimeout(proc.exited, exitTimeoutMs, "waiting for child exit");
		await pollTask;

		// Post-exit read: on Windows the retained process counters keep
		// PeakWorkingSetSize readable while our handle is open (verified on the
		// recorded host). Fall back to the alive read if unavailable.
		let postExitPeakWorkingSetBytes: number | null = null;
		try {
			const counters = memoryReader.read();
			if (counters.peakWorkingSetBytes > 0) {
				postExitPeakWorkingSetBytes = counters.peakWorkingSetBytes;
			}
		} catch {
			postExitPeakWorkingSetBytes = null;
		}

		const sampledPeakWorkingSetBytes = Math.max(
			baseline.workingSetBytes,
			atKdfEnd.workingSetBytes,
			...pollSamples.map((poll) => poll.workingSetBytes),
		);
		const lifetimePeakWorkingSetBytes = Math.max(
			atKdfEnd.peakWorkingSetBytes,
			postExitPeakWorkingSetBytes ?? 0,
		);
		const lifetimePeakSource: LifetimePeakSource =
			postExitPeakWorkingSetBytes !== null && postExitPeakWorkingSetBytes >= atKdfEnd.peakWorkingSetBytes
				? "post-exit-query"
				: "query-after-last-kdf";

		const record: SampleRecord = {
			index,
			latencyMs: sample.latencyMs,
			baselineWorkingSetBytes: baseline.workingSetBytes,
			sampledPeakWorkingSetBytes,
			sampledIncrementalDeltaBytes: Math.max(0, sampledPeakWorkingSetBytes - baseline.workingSetBytes),
			sampledPollCount: pollSamples.length,
			samplingSpanMs: pollSamples.length > 0 ? pollSamples[pollSamples.length - 1]!.tMs : 0,
			lifetimePeakWorkingSetBytes,
			lifetimePeakSource,
			postExitPeakWorkingSetBytes,
			childPid: proc.pid,
			childExitCode: exitCode,
		};
		return { record, versions: ready.versions, stderrText: await stderrTextPromise };
	} catch (error) {
		try {
			proc.kill();
		} catch {
			// already exited
		}
		await proc.exited.catch(() => undefined);
		throw error;
	} finally {
		reader?.close();
	}
}

/** Small async line pump over the child's stdout, exposing typed deferreds. */
class ChildMessagePump {
	private readonly readyDeferred = deferred<ChildReadyMessage>();
	private readonly sampleDeferred = deferred<{ latencyMs: number }>();
	private readonly failureDeferred = deferred<Error>();
	private readySeen = false;
	private sampleSeen = false;

	constructor(stream: ReadableStream<Uint8Array>) {
		void this.run(stream);
	}

	get ready(): Promise<ChildReadyMessage> {
		return this.readyDeferred.promise;
	}

	get sample(): Promise<{ latencyMs: number }> {
		return this.sampleDeferred.promise;
	}

	get failure(): Promise<Error> {
		return this.failureDeferred.promise;
	}

	private async run(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			const streamReader = stream.getReader();
			for (;;) {
				const { done, value } = await streamReader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				let newlineIndex: number;
				while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);
					if (line.length > 0) {
						this.dispatch(line);
					}
				}
			}
		} catch (error) {
			this.failureDeferred.resolve(asError(error));
		}
	}

	private dispatch(line: string): void {
		let message: ChildMessage;
		try {
			message = parseChildMessage(line);
		} catch (error) {
			this.failureDeferred.resolve(asError(error));
			return;
		}
		if (message.type === "ready") {
			if (this.readySeen) {
				this.failureDeferred.resolve(new Error("child sent more than one READY message"));
				return;
			}
			this.readySeen = true;
			this.readyDeferred.resolve(message);
			return;
		}
		if (message.type === "sample") {
			if (this.sampleSeen) {
				this.failureDeferred.resolve(new Error("child sent more than one sample message"));
				return;
			}
			this.sampleSeen = true;
			this.sampleDeferred.resolve({ latencyMs: message.latencyMs });
			return;
		}
		this.failureDeferred.resolve(new Error(`child reported an error: ${message.message}`));
	}
}

interface WritableChildStdin {
	write(data: string): unknown;
	flush(): Promise<unknown>;
}

async function writeChildCommand(stdin: WritableChildStdin | number | undefined, command: string): Promise<void> {
	if (stdin === undefined || typeof stdin === "number") {
		throw new Error("child stdin is not a pipe");
	}
	stdin.write(`${command}\n`);
	await stdin.flush();
}

async function collectStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	try {
		const streamReader = stream.getReader();
		for (;;) {
			const { done, value } = await streamReader.read();
			if (done) {
				break;
			}
			text += decoder.decode(value, { stream: true });
		}
	} catch {
		// best-effort diagnostics only
	}
	return text;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms while ${label}`)), timeoutMs);
		}),
	]);
}
