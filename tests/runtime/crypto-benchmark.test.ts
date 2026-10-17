/**
 * Focused pure tests for the Windows-only crypto diagnostic harness
 * (`scripts/crypto-benchmark/**`).
 *
 * These tests deliberately do NOT run the KDF. They cover only deterministic
 * logic: statistics, CLI argument/candidate validation, child-protocol
 * parsing/settings checks, and report assembly/labels/limitations.
 *
 * The harness itself is diagnostic only and is not a selected crypto profile
 * (O-01/O-03 remain OPEN). See scripts/crypto-benchmark/README.md.
 */

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_INTERVAL_MS,
	DEFAULT_SAMPLES,
	parseBenchmarkArgs,
	parseChildSettingsArgs,
	UsageError,
} from "../../scripts/crypto-benchmark/lib/args.ts";
import {
	assertReadyMatchesRequestedSettings,
	CHILD_PROTOCOL_VERSION,
	parseChildMessage,
	type ChildReadyMessage,
	type ChildSettingsReport,
} from "../../scripts/crypto-benchmark/lib/protocol.ts";
import {
	buildDiagnosticReport,
	DIAGNOSTIC_LIMITATIONS,
	REPORT_SCHEMA,
	type SampleRecord,
} from "../../scripts/crypto-benchmark/lib/report.ts";
import {
	DEFAULT_KDF_MEMORY_LIMIT_BYTES,
	DEFAULT_KDF_OPS_LIMIT,
	MAX_KDF_MEMORY_LIMIT_MIB,
	MAX_KDF_OPS_LIMIT,
	MIN_KDF_MEMORY_LIMIT_MIB,
	MIN_KDF_OPS_LIMIT,
} from "../../scripts/crypto-benchmark/lib/settings.ts";
import { computeStats } from "../../scripts/crypto-benchmark/lib/stats.ts";

const MIB = 1024 * 1024;
const DEFAULT_MEMORY_MIB = DEFAULT_KDF_MEMORY_LIMIT_BYTES / MIB;

describe("crypto-benchmark: computeStats (nearest-rank percentiles)", () => {
	test("computes p50/p95/max deterministically for 1..100", () => {
		const values = Array.from({ length: 100 }, (_unused, index) => index + 1);
		const stats = computeStats(values);
		expect(stats.count).toBe(100);
		expect(stats.min).toBe(1);
		expect(stats.max).toBe(100);
		// nearest-rank: p50 -> rank 50 -> index 49 -> value 50; p95 -> rank 95 -> value 95.
		expect(stats.p50).toBe(50);
		expect(stats.p95).toBe(95);
		expect(stats.mean).toBe(50.5);
	});

	test("handles a single value and unsorted input", () => {
		expect(computeStats([10])).toEqual({ count: 1, min: 10, p50: 10, p95: 10, max: 10, mean: 10 });
		const stats = computeStats([5, 1, 3]);
		expect(stats.min).toBe(1);
		expect(stats.max).toBe(5);
		// nearest-rank: p50 -> ceil(1.5)=2 -> index 1 -> 3; p95 -> ceil(2.85)=3 -> 5.
		expect(stats.p50).toBe(3);
		expect(stats.p95).toBe(5);
		expect(stats.mean).toBe(3);
	});

	test("rejects empty, non-finite, and negative inputs", () => {
		expect(() => computeStats([])).toThrow();
		expect(() => computeStats([Number.NaN])).toThrow();
		expect(() => computeStats([Number.POSITIVE_INFINITY])).toThrow();
		expect(() => computeStats([-1])).toThrow();
	});
});

describe("crypto-benchmark: CLI argument parsing", () => {
	test("defaults to a safe sample count, interval, and the 2 ops / 64 MiB diagnostic candidate", () => {
		expect(parseBenchmarkArgs([])).toEqual({
			kind: "run",
			options: {
				samples: DEFAULT_SAMPLES,
				intervalMs: DEFAULT_INTERVAL_MS,
				opsLimit: DEFAULT_KDF_OPS_LIMIT,
				memoryLimitMiB: DEFAULT_MEMORY_MIB,
			},
		});
		expect(DEFAULT_SAMPLES).toBe(100);
		expect(DEFAULT_KDF_OPS_LIMIT).toBe(2);
		expect(DEFAULT_MEMORY_MIB).toBe(64);
	});

	test("accepts explicit --samples and --interval-ms with default candidate settings", () => {
		expect(parseBenchmarkArgs(["--samples", "7", "--interval-ms", "25"])).toEqual({
			kind: "run",
			options: {
				samples: 7,
				intervalMs: 25,
				opsLimit: DEFAULT_KDF_OPS_LIMIT,
				memoryLimitMiB: DEFAULT_MEMORY_MIB,
			},
		});
	});

	test("accepts the diagnostic comparison candidates via --ops/--memory-mib", () => {
		expect(parseBenchmarkArgs(["--ops", "1", "--memory-mib", "64"])).toEqual({
			kind: "run",
			options: { samples: DEFAULT_SAMPLES, intervalMs: DEFAULT_INTERVAL_MS, opsLimit: 1, memoryLimitMiB: 64 },
		});
		expect(parseBenchmarkArgs(["--ops", "2", "--memory-mib", "64"])).toEqual({
			kind: "run",
			options: { samples: DEFAULT_SAMPLES, intervalMs: DEFAULT_INTERVAL_MS, opsLimit: 2, memoryLimitMiB: 64 },
		});
		expect(parseBenchmarkArgs(["--ops", "3", "--memory-mib", "64"])).toEqual({
			kind: "run",
			options: { samples: DEFAULT_SAMPLES, intervalMs: DEFAULT_INTERVAL_MS, opsLimit: 3, memoryLimitMiB: 64 },
		});
		expect(parseBenchmarkArgs(["--ops", "2", "--memory-mib", "128"])).toEqual({
			kind: "run",
			options: { samples: DEFAULT_SAMPLES, intervalMs: DEFAULT_INTERVAL_MS, opsLimit: 2, memoryLimitMiB: 128 },
		});
		// Flags are order-independent.
		expect(parseBenchmarkArgs(["--memory-mib", "128", "--ops", "1", "--samples", "30"])).toEqual({
			kind: "run",
			options: { samples: 30, intervalMs: DEFAULT_INTERVAL_MS, opsLimit: 1, memoryLimitMiB: 128 },
		});
	});

	test("returns help for -h/--help", () => {
		expect(parseBenchmarkArgs(["--help"]).kind).toBe("help");
		expect(parseBenchmarkArgs(["-h"]).kind).toBe("help");
	});

	test("rejects unknown flags and invalid values", () => {
		expect(() => parseBenchmarkArgs(["--nope"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--samples"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--samples", "0"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--samples", "1001"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--samples", "1.5"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--samples", "abc"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--interval-ms", "0"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--interval-ms", "1001"])).toThrow(UsageError);
	});

	test("validates the --ops/--memory-mib harness input guards fail-closed", () => {
		expect(() => parseBenchmarkArgs(["--ops"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--memory-mib"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--ops", String(MIN_KDF_OPS_LIMIT - 1)])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--ops", String(MAX_KDF_OPS_LIMIT + 1)])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--ops", "2.5"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--ops", "two"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--memory-mib", String(MIN_KDF_MEMORY_LIMIT_MIB - 1)])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--memory-mib", String(MAX_KDF_MEMORY_LIMIT_MIB + 1)])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--memory-mib", "-64"])).toThrow(UsageError);
		expect(() => parseBenchmarkArgs(["--memory-mib", "64MiB"])).toThrow(UsageError);
	});

	test("accepts the documented candidate bounds and rejects the values just outside them", () => {
		const atBounds = parseBenchmarkArgs([
			"--ops",
			String(MAX_KDF_OPS_LIMIT),
			"--memory-mib",
			String(MAX_KDF_MEMORY_LIMIT_MIB),
		]);
		expect(atBounds.kind).toBe("run");
		if (atBounds.kind === "run") {
			expect(atBounds.options.opsLimit).toBe(MAX_KDF_OPS_LIMIT);
			expect(atBounds.options.memoryLimitMiB).toBe(MAX_KDF_MEMORY_LIMIT_MIB);
		}
		const atMin = parseBenchmarkArgs([
			"--ops",
			String(MIN_KDF_OPS_LIMIT),
			"--memory-mib",
			String(MIN_KDF_MEMORY_LIMIT_MIB),
		]);
		expect(atMin.kind).toBe("run");
	});
});

describe("crypto-benchmark: child settings argument parsing", () => {
	test("defaults to the 2 ops / 64 MiB diagnostic candidate when flags are absent", () => {
		expect(parseChildSettingsArgs(["--child"])).toEqual({
			opsLimit: DEFAULT_KDF_OPS_LIMIT,
			memoryLimitMiB: DEFAULT_MEMORY_MIB,
		});
	});

	test("accepts explicit --ops/--memory-mib in any order", () => {
		expect(parseChildSettingsArgs(["--child", "--ops", "3", "--memory-mib", "128"])).toEqual({
			opsLimit: 3,
			memoryLimitMiB: 128,
		});
		expect(parseChildSettingsArgs(["--child", "--memory-mib", "64", "--ops", "1"])).toEqual({
			opsLimit: 1,
			memoryLimitMiB: 64,
		});
	});

	test("rejects unknown flags, missing values, and out-of-guard values", () => {
		expect(() => parseChildSettingsArgs(["--child", "--bogus"])).toThrow(UsageError);
		expect(() => parseChildSettingsArgs(["--child", "--ops"])).toThrow(UsageError);
		expect(() => parseChildSettingsArgs(["--child", "--ops", "0"])).toThrow(UsageError);
		expect(() => parseChildSettingsArgs(["--child", "--ops", String(MAX_KDF_OPS_LIMIT + 1)])).toThrow(UsageError);
		expect(() => parseChildSettingsArgs(["--child", "--memory-mib", "0"])).toThrow(UsageError);
		expect(() => parseChildSettingsArgs(["--child", "--memory-mib", String(MAX_KDF_MEMORY_LIMIT_MIB + 1)])).toThrow(
			UsageError,
		);
	});
});

function makeReadyMessage(
	overrides: { protocol?: number; settings?: Partial<ChildSettingsReport> } = {},
): ChildReadyMessage {
	return {
		type: "ready",
		protocol: overrides.protocol ?? CHILD_PROTOCOL_VERSION,
		pid: 4321,
		settings: {
			function: "crypto_pwhash",
			algorithm: "argon2id13",
			algorithmId: 2,
			opsLimit: DEFAULT_KDF_OPS_LIMIT,
			memoryLimitBytes: DEFAULT_KDF_MEMORY_LIMIT_BYTES,
			outputBytes: 32,
			...overrides.settings,
		},
		versions: {
			bun: "1.3.10",
			nodeCompat: "24.3.0",
			libsodiumPackage: "libsodium-wrappers-sumo@0.8.4",
			libsodiumVersionString: "1.0.22",
		},
	};
}

describe("crypto-benchmark: child protocol parsing and settings check", () => {
	test("parses ready/sample/error messages", () => {
		const ready = parseChildMessage(JSON.stringify(makeReadyMessage()));
		expect(ready.type).toBe("ready");
		expect(parseChildMessage(JSON.stringify({ type: "sample", latencyMs: 125.5 }))).toEqual({
			type: "sample",
			latencyMs: 125.5,
		});
		expect(parseChildMessage(JSON.stringify({ type: "error", message: "boom" }))).toEqual({
			type: "error",
			message: "boom",
		});
	});

	test("rejects malformed messages", () => {
		expect(() => parseChildMessage("not json")).toThrow();
		expect(() => parseChildMessage(JSON.stringify({ latencyMs: 1 }))).toThrow();
		expect(() => parseChildMessage(JSON.stringify({ type: "sample", latencyMs: -1 }))).toThrow();
		expect(() => parseChildMessage(JSON.stringify({ type: "sample", latencyMs: "fast" }))).toThrow();
		expect(() => parseChildMessage(JSON.stringify({ type: "other" }))).toThrow();
	});

	test("accepts a child that reports exactly the requested candidate settings", () => {
		const candidates = [
			{ opsLimit: 1, memoryLimitBytes: 64 * MIB },
			{ opsLimit: 2, memoryLimitBytes: 64 * MIB },
			{ opsLimit: 3, memoryLimitBytes: 64 * MIB },
			{ opsLimit: 2, memoryLimitBytes: 128 * MIB },
		];
		for (const expected of candidates) {
			const ready = parseChildMessage(
				JSON.stringify(makeReadyMessage({ settings: expected })),
			);
			if (ready.type !== "ready") {
				throw new Error("expected ready message");
			}
			expect(() => assertReadyMatchesRequestedSettings(ready, expected)).not.toThrow();
		}
	});

	test("rejects drift between the child report and the requested candidate", () => {
		const good = parseChildMessage(JSON.stringify(makeReadyMessage()));
		if (good.type !== "ready") {
			throw new Error("expected ready message");
		}
		expect(() => assertReadyMatchesRequestedSettings(good, { opsLimit: 2, memoryLimitBytes: 64 * MIB })).not.toThrow();

		// Child ran 2/64 but 3/64 was requested.
		expect(() => assertReadyMatchesRequestedSettings(good, { opsLimit: 3, memoryLimitBytes: 64 * MIB })).toThrow();
		// Child ran 2/64 but 2/128 was requested.
		expect(() => assertReadyMatchesRequestedSettings(good, { opsLimit: 2, memoryLimitBytes: 128 * MIB })).toThrow();

		const wrongOps = parseChildMessage(JSON.stringify(makeReadyMessage({ settings: { opsLimit: 3 } })));
		expect(() => assertReadyMatchesRequestedSettings(wrongOps as ChildReadyMessage, { opsLimit: 2, memoryLimitBytes: 64 * MIB })).toThrow();

		const wrongMemory = parseChildMessage(
			JSON.stringify(makeReadyMessage({ settings: { memoryLimitBytes: 256 * MIB } })),
		);
		expect(() => assertReadyMatchesRequestedSettings(wrongMemory as ChildReadyMessage, { opsLimit: 2, memoryLimitBytes: 64 * MIB })).toThrow();

		const wrongProtocol = parseChildMessage(JSON.stringify(makeReadyMessage({ protocol: 99 })));
		expect(() => assertReadyMatchesRequestedSettings(wrongProtocol as ChildReadyMessage, { opsLimit: 2, memoryLimitBytes: 64 * MIB })).toThrow();

		const wrongAlgorithm = parseChildMessage(JSON.stringify(makeReadyMessage({ settings: { algorithmId: 1 } })));
		expect(() => assertReadyMatchesRequestedSettings(wrongAlgorithm as ChildReadyMessage, { opsLimit: 2, memoryLimitBytes: 64 * MIB })).toThrow();

		const wrongOutput = parseChildMessage(JSON.stringify(makeReadyMessage({ settings: { outputBytes: 64 } })));
		expect(() => assertReadyMatchesRequestedSettings(wrongOutput as ChildReadyMessage, { opsLimit: 2, memoryLimitBytes: 64 * MIB })).toThrow();
	});
});

function makeRecord(index: number, overrides: Partial<SampleRecord> = {}): SampleRecord {
	return {
		index,
		latencyMs: 100 + index * 10,
		baselineWorkingSetBytes: 10_000_000,
		sampledPeakWorkingSetBytes: 70_000_000,
		sampledIncrementalDeltaBytes: 60_000_000,
		sampledPollCount: 5,
		samplingSpanMs: 50,
		lifetimePeakWorkingSetBytes: 80_000_000,
		lifetimePeakSource: "post-exit-query",
		postExitPeakWorkingSetBytes: 80_000_000,
		childPid: 1000 + index,
		childExitCode: 0,
		...overrides,
	};
}

function makeReportInput(
	samples: SampleRecord[],
	kdfSettings: { opsLimit: number; memoryLimitBytes: number } = {
		opsLimit: DEFAULT_KDF_OPS_LIMIT,
		memoryLimitBytes: DEFAULT_KDF_MEMORY_LIMIT_BYTES,
	},
) {
	return {
		generatedAtIso: "2026-10-11T00:00:00.000Z",
		host: {
			platform: "win32",
			arch: "x64",
			osRelease: "10.0.26100",
			cpuModel: "test-cpu",
			totalMemoryBytes: 34_000_000_000,
		},
		runtime: {
			bun: "1.3.10",
			nodeCompat: "24.3.0",
			libsodiumPackage: "libsodium-wrappers-sumo@0.8.4",
			libsodiumVersionString: "1.0.22",
		},
		kdfSettings,
		methodology: {
			samplesRequested: samples.length,
			samplesCompleted: samples.length,
			failedSamples: 0,
			samplingIntervalRequestedMs: 10,
			sampledPollsTotal: samples.reduce((total, sample) => total + sample.sampledPollCount, 0),
		},
		samples,
		failures: [],
	};
}

describe("crypto-benchmark: report assembly", () => {
	test("computes aggregates and keeps the memory labels separate", () => {
		const samples = [
			makeRecord(0, { latencyMs: 100, sampledIncrementalDeltaBytes: 60_000_000, lifetimePeakWorkingSetBytes: 80_000_000 }),
			makeRecord(1, { latencyMs: 300, sampledIncrementalDeltaBytes: 70_000_000, lifetimePeakWorkingSetBytes: 90_000_000 }),
			makeRecord(2, { latencyMs: 200, sampledIncrementalDeltaBytes: 65_000_000, lifetimePeakWorkingSetBytes: 85_000_000 }),
		];
		const report = buildDiagnosticReport(makeReportInput(samples));

		expect(report.schema).toBe(REPORT_SCHEMA);
		expect(report.diagnosticOnly).toBe(true);
		expect(report.profileSelected).toBe(false);

		expect(report.aggregate.latencyMs).toEqual(computeStats([100, 300, 200]));
		expect(report.aggregate.latencyMs.p50).toBe(200);
		expect(report.aggregate.latencyMs.p95).toBe(300);
		expect(report.aggregate.latencyMs.max).toBe(300);

		// The two memory measurements are distinct labels, not one merged number.
		expect(report.aggregate.sampledIncrementalDeltaBytes.max).toBe(70_000_000);
		expect(report.aggregate.processLifetimePeakWorkingSetBytes.max).toBe(90_000_000);
		expect(report.methodology.units).toEqual({ latency: "milliseconds", memory: "bytes" });
		expect(report.methodology.freshChildProcessPerSample).toBe(true);
		expect(report.methodology.sampledPollsTotal).toBe(15);

		// Diagnostic candidate settings, explicitly not a selected profile.
		expect(report.kdfSettings.opsLimit).toBe(DEFAULT_KDF_OPS_LIMIT);
		expect(report.kdfSettings.memoryLimitBytes).toBe(DEFAULT_KDF_MEMORY_LIMIT_BYTES);
		expect(report.kdfSettings.note).toContain("NOT a selected or approved crypto profile");
	});

	test("echoes the requested candidate settings for a non-default candidate", () => {
		const report = buildDiagnosticReport(
			makeReportInput([makeRecord(0)], { opsLimit: 2, memoryLimitBytes: 128 * MIB }),
		);
		expect(report.kdfSettings.opsLimit).toBe(2);
		expect(report.kdfSettings.memoryLimitBytes).toBe(128 * MIB);
		expect(report.kdfSettings.function).toBe("crypto_pwhash");
		expect(report.kdfSettings.algorithm).toBe("argon2id13");
		expect(report.kdfSettings.outputBytes).toBe(32);
	});

	test("rejects invalid candidate settings", () => {
		expect(() =>
			buildDiagnosticReport(makeReportInput([makeRecord(0)], { opsLimit: 0, memoryLimitBytes: 64 * MIB })),
		).toThrow();
		expect(() =>
			buildDiagnosticReport(makeReportInput([makeRecord(0)], { opsLimit: 1.5, memoryLimitBytes: 64 * MIB })),
		).toThrow();
		expect(() =>
			buildDiagnosticReport(makeReportInput([makeRecord(0)], { opsLimit: 2, memoryLimitBytes: -1 })),
		).toThrow();
		expect(() =>
			buildDiagnosticReport(
				makeReportInput([makeRecord(0)], { opsLimit: 2, memoryLimitBytes: Number.NaN }),
			),
		).toThrow();
	});

	test("derives the observed mean sampling interval from per-sample spans", () => {
		const samples = [
			makeRecord(0, { sampledPollCount: 4, samplingSpanMs: 40 }), // 10 ms mean
			makeRecord(1, { sampledPollCount: 8, samplingSpanMs: 80 }), // 10 ms mean
		];
		const report = buildDiagnosticReport(makeReportInput(samples));
		expect(report.methodology.observedMeanSamplingIntervalMs).toBe(10);
	});

	test("includes the required limitations verbatim", () => {
		const report = buildDiagnosticReport(makeReportInput([makeRecord(0)]));
		expect(report.limitations).toEqual([...DIAGNOSTIC_LIMITATIONS]);
		const joined = report.limitations.join("\n");
		expect(joined).toContain("candidate comparison inputs");
		expect(joined).toContain("short-lived peaks between samples can be missed");
		expect(joined).toContain("includes all pre-KDF work");
		expect(joined).toContain("not attributable to the KDF alone");
		expect(joined).toContain("not a selected or approved crypto profile");
		expect(joined).toContain("WorkingSetSize");
		expect(joined).toContain("not private/commit memory");
	});

	test("rejects an empty sample set", () => {
		expect(() => buildDiagnosticReport(makeReportInput([]))).toThrow();
	});
});
