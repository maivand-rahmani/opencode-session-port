/**
 * Pure CLI argument parsing/validation for the Windows-only diagnostic harness.
 * No side effects; safe to unit test.
 */

import {
	DEFAULT_KDF_MEMORY_LIMIT_BYTES,
	DEFAULT_KDF_OPS_LIMIT,
	MAX_KDF_MEMORY_LIMIT_MIB,
	MAX_KDF_OPS_LIMIT,
	MIN_KDF_MEMORY_LIMIT_MIB,
	MIN_KDF_OPS_LIMIT,
} from "./settings.ts";

export interface BenchmarkOptions {
	/** Number of KDF samples; each runs in a fresh child process. */
	samples: number;
	/** Requested supervisor working-set polling interval, milliseconds (best-effort). */
	intervalMs: number;
	/** Argon2id opslimit for the diagnostic candidate. */
	opsLimit: number;
	/** Argon2id memlimit for the diagnostic candidate, MiB. */
	memoryLimitMiB: number;
}

export type ParsedArgs = { kind: "run"; options: BenchmarkOptions } | { kind: "help" };

export const DEFAULT_SAMPLES = 100;
export const DEFAULT_INTERVAL_MS = 10;
export const MIN_SAMPLES = 1;
export const MAX_SAMPLES = 1000;
export const MIN_INTERVAL_MS = 1;
export const MAX_INTERVAL_MS = 1000;

export class UsageError extends Error {}

export function parseBenchmarkArgs(argv: readonly string[]): ParsedArgs {
	let samples = DEFAULT_SAMPLES;
	let intervalMs = DEFAULT_INTERVAL_MS;
	let opsLimit = DEFAULT_KDF_OPS_LIMIT;
	let memoryLimitMiB = DEFAULT_KDF_MEMORY_LIMIT_BYTES / (1024 * 1024);
	let help = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--samples" || arg === "--interval-ms" || arg === "--ops" || arg === "--memory-mib") {
			const raw = argv[index + 1];
			if (raw === undefined) {
				throw new UsageError(`missing value for ${arg}`);
			}
			index += 1;
			if (arg === "--samples") {
				samples = parseInteger(raw, arg, MIN_SAMPLES, MAX_SAMPLES);
			} else if (arg === "--interval-ms") {
				intervalMs = parseInteger(raw, arg, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
			} else if (arg === "--ops") {
				opsLimit = parseInteger(raw, arg, MIN_KDF_OPS_LIMIT, MAX_KDF_OPS_LIMIT);
			} else {
				memoryLimitMiB = parseInteger(raw, arg, MIN_KDF_MEMORY_LIMIT_MIB, MAX_KDF_MEMORY_LIMIT_MIB);
			}
			continue;
		}
		throw new UsageError(`unknown argument: ${arg}`);
	}

	if (help) {
		return { kind: "help" };
	}
	return { kind: "run", options: { samples, intervalMs, opsLimit, memoryLimitMiB } };
}

export interface ChildKdfSettings {
	/** Argon2id opslimit the child must run. */
	opsLimit: number;
	/** Argon2id memlimit the child must run, MiB. */
	memoryLimitMiB: number;
}

/**
 * Parse the KDF settings the supervisor passes to the child process
 * (`--child --ops <n> --memory-mib <n>`). Fail-closed: unknown flags and
 * out-of-bounds values are rejected; the internal `--child` marker itself is
 * accepted and ignored. Defaults apply only when a flag is absent.
 */
export function parseChildSettingsArgs(argv: readonly string[]): ChildKdfSettings {
	let opsLimit = DEFAULT_KDF_OPS_LIMIT;
	let memoryLimitMiB = DEFAULT_KDF_MEMORY_LIMIT_BYTES / (1024 * 1024);

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--child") {
			continue;
		}
		if (arg === "--ops" || arg === "--memory-mib") {
			const raw = argv[index + 1];
			if (raw === undefined) {
				throw new UsageError(`missing value for ${arg}`);
			}
			index += 1;
			if (arg === "--ops") {
				opsLimit = parseInteger(raw, arg, MIN_KDF_OPS_LIMIT, MAX_KDF_OPS_LIMIT);
			} else {
				memoryLimitMiB = parseInteger(raw, arg, MIN_KDF_MEMORY_LIMIT_MIB, MAX_KDF_MEMORY_LIMIT_MIB);
			}
			continue;
		}
		throw new UsageError(`unknown child argument: ${arg}`);
	}

	return { opsLimit, memoryLimitMiB };
}

function parseInteger(raw: string, flag: string, min: number, max: number): number {
	if (!/^[0-9]+$/.test(raw)) {
		throw new UsageError(`${flag} expects a positive integer, got "${raw}"`);
	}
	const value = Number.parseInt(raw, 10);
	if (value < min || value > max) {
		throw new UsageError(`${flag} must be between ${min} and ${max}, got ${value}`);
	}
	return value;
}

export const USAGE = `SessionPort Windows-only KDF diagnostic harness (supervisor).

Usage:
  bun run scripts/crypto-benchmark/supervisor.ts [--samples <n>] [--interval-ms <n>]
                                                 [--ops <n>] [--memory-mib <n>]

Options:
  --samples <n>       KDF samples, each in a fresh child process (default ${DEFAULT_SAMPLES}, max ${MAX_SAMPLES}).
  --interval-ms <n>   Requested supervisor working-set poll interval (default ${DEFAULT_INTERVAL_MS} ms, max ${MAX_INTERVAL_MS}).
  --ops <n>           Argon2id opslimit for this diagnostic candidate (default ${DEFAULT_KDF_OPS_LIMIT},
                      range ${MIN_KDF_OPS_LIMIT}-${MAX_KDF_OPS_LIMIT}).
  --memory-mib <n>    Argon2id memlimit in MiB for this diagnostic candidate
                      (default ${DEFAULT_KDF_MEMORY_LIMIT_BYTES / (1024 * 1024)}, range ${MIN_KDF_MEMORY_LIMIT_MIB}-${MAX_KDF_MEMORY_LIMIT_MIB}).
  -h, --help          Show this help.

The --ops/--memory-mib ranges are harness input guards for diagnostic comparison
only - not a product resource cap, crypto profile, or support claim.

What it measures (diagnostic candidate inputs only; NOT a selected crypto profile):
  - Argon2id crypto_pwhash latency (p50/p95/max), timed with performance.now()
    around only the synchronous call in the child.
  - Working set of each child via Windows GetProcessMemoryInfo, in bytes:
    sampled incremental delta during the KDF window, and per-child lifetime peak
    (PeakWorkingSetSize), reported separately.

Output: a single JSON report on stdout; progress on stderr. No files are written.
Exit codes: 0 = all samples completed; 2 = partial (some samples failed); 1 = fatal.
`;
