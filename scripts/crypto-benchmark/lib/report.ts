/**
 * Pure report assembly for the Windows-only KDF diagnostic harness.
 * No I/O, no crypto, no process APIs; safe to unit test.
 *
 * Report design requirements (deliberate):
 * - Latency stats: p50/p95/max (plus min/mean/count) over KDF samples.
 * - Memory is reported under two clearly separated labels:
 *   `sampledIncrementalDeltaBytes` (approx., sampled working set during the KDF
 *   window minus the pre-KDF baseline) and `processLifetimePeakWorkingSetBytes`
 *   (per-child lifetime PeakWorkingSetSize, which includes pre-KDF work).
 * - Units, sampling interval, sample counts, runtime/library versions, and the
 *   limitations list are always included.
 * - The measured ops/memory values are diagnostic candidate inputs; no crypto
 *   profile is selected and the report states that explicitly.
 */

import { computeStats, type NumericStats } from "./stats.ts";
import {
	KDF_ALGORITHM,
	KDF_FUNCTION,
	KDF_OUTPUT_BYTES,
	KDF_SETTINGS_NOTE,
} from "./settings.ts";

export const REPORT_SCHEMA = "sessionport.crypto-benchmark.diagnostic.v1";

export type LifetimePeakSource = "post-exit-query" | "query-after-last-kdf";

export interface SampleRecord {
	index: number;
	/** performance.now() delta around only the synchronous crypto_pwhash call, milliseconds. */
	latencyMs: number;
	/** Current working set captured after child READY (post sodium.ready + byte prep) and before GO, bytes. */
	baselineWorkingSetBytes: number;
	/** Max working set observed by the supervisor during the KDF window (polls + post-call read), bytes. */
	sampledPeakWorkingSetBytes: number;
	/** sampledPeakWorkingSetBytes - baselineWorkingSetBytes (clamped at 0); approximate, bytes. */
	sampledIncrementalDeltaBytes: number;
	/** Number of successful working-set polls during the KDF window. */
	sampledPollCount: number;
	/** Time from GO to the last poll, milliseconds (best-effort timer). */
	samplingSpanMs: number;
	/** Per-child lifetime PeakWorkingSetSize, bytes; includes pre-KDF work. */
	lifetimePeakWorkingSetBytes: number;
	lifetimePeakSource: LifetimePeakSource;
	/** PeakWorkingSetSize read after child exit when available (retained process counters), bytes. */
	postExitPeakWorkingSetBytes: number | null;
	childPid: number;
	childExitCode: number | null;
}

export interface SampleFailureRecord {
	index: number;
	message: string;
}

export interface ReportInput {
	generatedAtIso: string;
	host: {
		platform: string;
		arch: string;
		osRelease: string;
		cpuModel: string;
		totalMemoryBytes: number;
	};
	runtime: {
		bun: string;
		nodeCompat: string;
		libsodiumPackage: string;
		libsodiumVersionString: string;
	};
	/** Diagnostic candidate settings this run actually measured. */
	kdfSettings: {
		opsLimit: number;
		memoryLimitBytes: number;
	};
	methodology: {
		samplesRequested: number;
		samplesCompleted: number;
		failedSamples: number;
		samplingIntervalRequestedMs: number;
		sampledPollsTotal: number;
	};
	samples: readonly SampleRecord[];
	failures: readonly SampleFailureRecord[];
}

export interface BenchmarkReport {
	schema: string;
	generatedAtIso: string;
	diagnosticOnly: true;
	profileSelected: false;
	host: ReportInput["host"];
	runtime: ReportInput["runtime"];
	kdfSettings: {
		function: string;
		algorithm: string;
		opsLimit: number;
		memoryLimitBytes: number;
		outputBytes: number;
		note: string;
	};
	methodology: {
		freshChildProcessPerSample: true;
		samplesSequential: true;
		samplesRequested: number;
		samplesCompleted: number;
		failedSamples: number;
		samplingIntervalRequestedMs: number;
		sampledPollsTotal: number;
		observedMeanSamplingIntervalMs: number | null;
		units: { latency: "milliseconds"; memory: "bytes" };
		latencyScope: string;
		memoryScope: string;
	};
	limitations: string[];
	aggregate: {
		latencyMs: NumericStats;
		sampledIncrementalDeltaBytes: NumericStats;
		processLifetimePeakWorkingSetBytes: NumericStats;
	};
	samples: SampleRecord[];
	failures: SampleFailureRecord[];
}

export const DIAGNOSTIC_LIMITATIONS: readonly string[] = [
	"Diagnostic only: the measured ops/memory values are candidate comparison inputs; the 2 ops / 64 MiB default reproduces the earlier recorded diagnostic run. They are not a selected or approved crypto profile, and no profile, cap, or format value is chosen from these results (O-01/O-03 remain OPEN).",
	"Results describe only this Windows test host and runtime. They are not a minimum-device floor, not macOS/Linux, and not the OpenCode plugin runtime; no cross-platform, minimum-device, or support claim follows.",
	"Latency is measured with performance.now() around only the synchronous crypto_pwhash call in the child. Process spawn, sodium.ready / embedded-WASM instantiation, synthetic byte preparation, IPC, and JSON reporting are excluded; the interval still includes JS-wrapper-to-WASM boundary overhead, so it is not pure native compute time.",
	"Each KDF sample ran in a fresh child process, sequentially, so every measured call includes any per-process first-call costs (for example WASM heap growth) and no sample is warmed.",
	"Memory values are working set (physical residency) in bytes, not private/commit memory; they come from Windows GetProcessMemoryInfo WorkingSetSize / PeakWorkingSetSize.",
	"Working-set samples are taken by the supervisor on a best-effort JS timer; the requested interval is not guaranteed and short-lived peaks between samples can be missed.",
	"sampledIncrementalDeltaBytes is the max sampled working set during the KDF window minus the per-child pre-KDF baseline; it is approximate and is not a precise KDF memory-cost measurement.",
	"processLifetimePeakWorkingSetBytes is the child's lifetime PeakWorkingSetSize; it includes all pre-KDF work (process startup, sodium initialization including embedded-WASM instantiation, synthetic byte preparation), so it is not attributable to the KDF alone.",
	"The KDF is synchronous and blocks the child; memory is sampled only by the separate supervisor process, never by the blocked child.",
	"The harness writes no files and persists no secret material; the synthetic password/salt live in child memory only and are best-effort zeroed (no secure-deletion claim).",
	"The synthetic password is fixed-length random bytes and is not representative of user-entered passphrases.",
];

export function buildDiagnosticReport(input: ReportInput): BenchmarkReport {
	if (input.samples.length === 0) {
		throw new Error("buildDiagnosticReport requires at least one completed sample");
	}
	const { opsLimit, memoryLimitBytes } = input.kdfSettings;
	if (!Number.isSafeInteger(opsLimit) || opsLimit <= 0) {
		throw new Error(`buildDiagnosticReport requires a positive integer opsLimit, got ${opsLimit}`);
	}
	if (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes <= 0) {
		throw new Error(`buildDiagnosticReport requires a positive integer memoryLimitBytes, got ${memoryLimitBytes}`);
	}
	const samples = [...input.samples];
	const observedIntervals = samples
		.filter((sample) => sample.sampledPollCount > 0)
		.map((sample) => sample.samplingSpanMs / sample.sampledPollCount);
	const observedMeanSamplingIntervalMs =
		observedIntervals.length > 0
			? observedIntervals.reduce((total, value) => total + value, 0) / observedIntervals.length
			: null;

	return {
		schema: REPORT_SCHEMA,
		generatedAtIso: input.generatedAtIso,
		diagnosticOnly: true,
		profileSelected: false,
		host: input.host,
		runtime: input.runtime,
		kdfSettings: {
			function: KDF_FUNCTION,
			algorithm: KDF_ALGORITHM,
			opsLimit,
			memoryLimitBytes,
			outputBytes: KDF_OUTPUT_BYTES,
			note: KDF_SETTINGS_NOTE,
		},
		methodology: {
			freshChildProcessPerSample: true,
			samplesSequential: true,
			samplesRequested: input.methodology.samplesRequested,
			samplesCompleted: input.methodology.samplesCompleted,
			failedSamples: input.methodology.failedSamples,
			samplingIntervalRequestedMs: input.methodology.samplingIntervalRequestedMs,
			sampledPollsTotal: input.methodology.sampledPollsTotal,
			observedMeanSamplingIntervalMs,
			units: { latency: "milliseconds", memory: "bytes" },
			latencyScope:
				"performance.now() around only the synchronous crypto_pwhash call in the child; startup and reporting excluded",
			memoryScope:
				"Windows GetProcessMemoryInfo working set (physical residency) in bytes; sampled incremental delta and process lifetime peak are separate labels",
		},
		limitations: [...DIAGNOSTIC_LIMITATIONS],
		aggregate: {
			latencyMs: computeStats(samples.map((sample) => sample.latencyMs)),
			sampledIncrementalDeltaBytes: computeStats(samples.map((sample) => sample.sampledIncrementalDeltaBytes)),
			processLifetimePeakWorkingSetBytes: computeStats(samples.map((sample) => sample.lifetimePeakWorkingSetBytes)),
		},
		samples,
		failures: [...input.failures],
	};
}
