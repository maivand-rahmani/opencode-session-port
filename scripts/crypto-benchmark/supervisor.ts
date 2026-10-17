#!/usr/bin/env bun
/**
 * Windows-only KDF diagnostic harness (supervisor entry point).
 *
 * Measures the pinned `libsodium-wrappers-sumo@0.8.4` synchronous Argon2id
 * `crypto_pwhash` at a diagnostic candidate (default 2 ops / 64 MiB, which
 * reproduces the earlier recorded diagnostic run; `--ops` / `--memory-mib`
 * parameterize the candidate for diagnostic comparison) and reports
 * p50/p95/max latency plus separately labeled working-set metrics.
 *
 * The supervisor spawns this *same source file* in child mode (`--child`) for
 * each sample; the handshake is stdio-only and no staging/temp files exist.
 *
 * This is a diagnostic measurement harness, not a production profile or a
 * crypto decision: no profile/cap/format value is selected and O-01/O-03 remain
 * OPEN. See README.md in this directory for design, limitations, and run notes.
 *
 * Run (from the repository root):
 *   bun run scripts/crypto-benchmark/supervisor.ts
 *   bun run scripts/crypto-benchmark/supervisor.ts --samples 30 --ops 2 --memory-mib 128
 *
 * stdout: one JSON report. stderr: progress. No files are written.
 * (`--child` is internal; do not invoke it directly.)
 */

import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseBenchmarkArgs, UsageError, USAGE } from "./lib/args.ts";
import { buildDiagnosticReport, type SampleFailureRecord, type SampleRecord } from "./lib/report.ts";
import { LIBSODIUM_PACKAGE_ID } from "./lib/settings.ts";
import { runSampleSession } from "./supervisor-lib.ts";

const READY_TIMEOUT_MS = 60_000;
const SAMPLE_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 15_000;

async function main(argv: readonly string[]): Promise<number> {
	if (process.platform !== "win32") {
		process.stderr.write(
			"This diagnostic harness is Windows-only (it samples working set through Windows GetProcessMemoryInfo).\n",
		);
		return 1;
	}

	let parsed;
	try {
		parsed = parseBenchmarkArgs(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n\n${USAGE}\n`);
			return 1;
		}
		throw error;
	}
	if (parsed.kind === "help") {
		await Bun.write(Bun.stdout, `${USAGE}\n`);
		return 0;
	}
	const { samples, intervalMs, opsLimit, memoryLimitMiB } = parsed.options;
	const memoryLimitBytes = memoryLimitMiB * 1024 * 1024;

	const selfScript = fileURLToPath(new URL("./supervisor.ts", import.meta.url));
	const command = [
		process.execPath,
		selfScript,
		"--child",
		"--ops",
		String(opsLimit),
		"--memory-mib",
		String(memoryLimitMiB),
	];

	process.stderr.write(
		"SessionPort crypto diagnostic harness (Windows-only).\n" +
			`Diagnostic candidate: ${opsLimit} ops / ${memoryLimitMiB} MiB Argon2id crypto_pwhash. NOT a selected crypto profile.\n` +
			`Samples: ${samples} (fresh child process per sample, sequential). Working-set poll interval: ${intervalMs} ms.\n`,
	);

	const records: SampleRecord[] = [];
	const failures: SampleFailureRecord[] = [];
	let libsodiumVersionString = "unavailable";

	for (let index = 0; index < samples; index += 1) {
		try {
			const result = await runSampleSession(index, {
				command,
				intervalMs,
				expectedKdfSettings: { opsLimit, memoryLimitBytes },
				readyTimeoutMs: READY_TIMEOUT_MS,
				sampleTimeoutMs: SAMPLE_TIMEOUT_MS,
				exitTimeoutMs: EXIT_TIMEOUT_MS,
			});
			records.push(result.record);
			if (libsodiumVersionString === "unavailable") {
				libsodiumVersionString = result.versions.libsodiumVersionString;
			}
			const { record } = result;
			process.stderr.write(
				`sample ${index + 1}/${samples}: latency ${record.latencyMs.toFixed(2)} ms; ` +
					`incremental delta ${formatMiB(record.sampledIncrementalDeltaBytes)}; ` +
					`lifetime peak ${formatMiB(record.lifetimePeakWorkingSetBytes)}\n`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push({ index, message });
			process.stderr.write(`sample ${index + 1}/${samples} failed: ${message}\n`);
		}
	}

	if (records.length === 0) {
		process.stderr.write(
			`No samples completed (${failures.length} failure(s)); no report produced. Check that the pinned ` +
				"libsodium-wrappers-sumo@0.8.4 install is present and re-run.\n",
		);
		return 1;
	}

	const report = buildDiagnosticReport({
		generatedAtIso: new Date().toISOString(),
		host: {
			platform: process.platform,
			arch: process.arch,
			osRelease: os.release(),
			cpuModel: os.cpus()[0]?.model ?? "unknown",
			totalMemoryBytes: os.totalmem(),
		},
		runtime: {
			bun: process.versions.bun ?? "unknown",
			// Under Bun this is Bun's Node-compatibility version, not system Node.
			nodeCompat: process.versions.node,
			libsodiumPackage: LIBSODIUM_PACKAGE_ID,
			libsodiumVersionString,
		},
		kdfSettings: { opsLimit, memoryLimitBytes },
		methodology: {
			samplesRequested: samples,
			samplesCompleted: records.length,
			failedSamples: failures.length,
			samplingIntervalRequestedMs: intervalMs,
			sampledPollsTotal: records.reduce((total, record) => total + record.sampledPollCount, 0),
		},
		samples: records,
		failures,
	});

	await Bun.write(Bun.stdout, `${JSON.stringify(report, null, 2)}\n`);
	process.stderr.write(
		`Report written to stdout (${records.length}/${samples} samples completed` +
			`${failures.length > 0 ? `, ${failures.length} failed` : ""}).\n`,
	);
	return failures.length > 0 ? 2 : 0;
}

function formatMiB(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const CHILD_MODE_FLAG = "--child";

if (process.argv.includes(CHILD_MODE_FLAG)) {
	// Internal child mode: this same file, spawned by the supervisor. Runs exactly
	// one KDF sample at the requested diagnostic candidate settings behind the
	// stdio handshake; loads sodium only here, so the supervisor process never
	// initializes the crypto library.
	const { runChildMode } = await import("./lib/child-mode.ts");
	process.exit(await runChildMode(process.argv.slice(2)));
} else {
	process.exit(await main(process.argv.slice(2)));
}
