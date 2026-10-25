/**
 * Import-safe synthetic probe for keyring 2.1.2; single-process run executed
 * 2026-10-20 within synthetic-only scope. No native load or store access occurs
 * unless run as the entrypoint with the exact flags and authorization. Results
 * contain fixed booleans/length and the operator's non-secret run id only: no
 * bytes, entry names, native errors, or environment data. See README.md.
 */
import { randomBytes } from "node:crypto";
import { createKeyringVault } from "../../../src/cloud/vault/keyring.ts";
import type { KeyringAsyncEntryConstructor } from "../../../src/cloud/vault/keyring.ts";
import type { SecureVault, VaultEntry } from "../../../src/cloud/vault/types.ts";

const MODULE_ID = "@napi-rs/keyring";
const RUN_FLAG = "--run-synthetic-keyring-probe";
const MIN_DEADLINE_MS = 1_000;
const MAX_DEADLINE_MS = 120_000;
const SECRET_BYTES = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USAGE = `usage: bun run probe.ts ${RUN_FLAG} --run-id <canonical-uuid> --deadline-ms <${MIN_DEADLINE_MS}..${MAX_DEADLINE_MS}>`;

export type ProbeOutcome = "pass" | "fail" | "uncertain" | "timeout";

export type ProbeIo = { stdout(line: string): void; stderr(line: string): void };

const processIo: ProbeIo = {
	stdout: (line) => process.stdout.write(`${line}\n`),
	stderr: (line) => process.stderr.write(`${line}\n`),
};

export function parseProbeArgs(argv: readonly string[]): { runId: string; deadlineMs: number } {
	let enabled = false;
	let runId: string | undefined;
	let deadlineMs: number | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === RUN_FLAG) {
			if (enabled) throw new Error(USAGE);
			enabled = true;
			continue;
		}
		if (arg === "--run-id") {
			if (runId !== undefined) throw new Error(USAGE);
			const value = argv[index + 1];
			index += 1;
			if (value === undefined || !UUID_PATTERN.test(value)) throw new Error(USAGE);
			runId = value;
			continue;
		}
		if (arg === "--deadline-ms") {
			if (deadlineMs !== undefined) throw new Error(USAGE);
			const value = argv[index + 1];
			index += 1;
			if (value === undefined || !/^\d+$/.test(value)) throw new Error(USAGE);
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || parsed < MIN_DEADLINE_MS || parsed > MAX_DEADLINE_MS) {
				throw new Error(USAGE);
			}
			deadlineMs = parsed;
			continue;
		}
		throw new Error(USAGE);
	}
	if (!enabled || runId === undefined || deadlineMs === undefined) throw new Error(USAGE);
	return { runId, deadlineMs };
}

/** Exact pair for manual review; the probe never prints it. */
export function probeEntry(runId: string): VaultEntry {
	return { service: `sessionport-vault-probe-${runId}`, account: `synthetic-${runId}` };
}

async function loadBinding(): Promise<KeyringAsyncEntryConstructor> {
	const moduleId = MODULE_ID;
	let loaded: unknown;
	try {
		loaded = await import(moduleId);
	} catch {
		throw new Error("binding-unavailable");
	}
	const AsyncEntry = loaded !== null && typeof loaded === "object" ? (loaded as { AsyncEntry?: unknown }).AsyncEntry : undefined;
	if (typeof AsyncEntry !== "function") throw new Error("binding-unavailable");
	return AsyncEntry as KeyringAsyncEntryConstructor;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/** Exit codes: 0 pass, 1 fail/usage, 2 timeout, 3 uncertain. */
export async function runProbe(argv: readonly string[], io: ProbeIo = processIo): Promise<number> {
	let config: ReturnType<typeof parseProbeArgs>;
	try {
		config = parseProbeArgs(argv);
	} catch {
		io.stderr(USAGE);
		return 1;
	}

	const state = {
		precheckAbsent: false,
		setSettled: false,
		readbackMatched: false,
		deleteSettled: false,
		deleteDeleted: null as boolean | null,
		deleteAttempted: false,
		finalAbsent: null as boolean | null,
		cleanupAttempted: false,
		cleanupAbsent: null as boolean | null,
		mutationUncertain: false,
		activeStage: "load",
		failedStage: "load" as string | null,
	};
	let reported = false;
	const report = (outcome: ProbeOutcome, stage: string | null): void => {
		if (reported) return;
		reported = true;
		io.stdout(
			JSON.stringify({
				probe: "synthetic-keyring",
				runId: config.runId,
				outcome,
				precheckAbsent: state.precheckAbsent,
				setSettled: state.setSettled,
				readbackMatched: state.readbackMatched,
				secretLength: SECRET_BYTES,
				deleteSettled: state.deleteSettled,
				finalAbsent: state.finalAbsent,
				cleanupAttempted: state.cleanupAttempted,
				cleanupAbsent: state.cleanupAbsent,
				failedStage: stage,
			}),
		);
	};
	const timer = setTimeout(() => {
		report("timeout", state.activeStage);
		process.exit(2);
	}, config.deadlineMs);

	let vault: SecureVault | undefined;
	let entry: VaultEntry | undefined;
	try {
		const AsyncEntry = await loadBinding();
		vault = createKeyringVault(AsyncEntry, { maxSecretBytes: SECRET_BYTES });
		entry = probeEntry(config.runId);
		state.activeStage = state.failedStage = "precheck";
		state.precheckAbsent = (await vault.read(entry)) === null;

		if (state.precheckAbsent) {
			const secret = new Uint8Array(randomBytes(SECRET_BYTES));
			state.activeStage = state.failedStage = "set";
			try {
				await vault.write(entry, secret);
				state.setSettled = true;
			} catch {
				state.mutationUncertain = true;
			}
			if (state.setSettled) {
				state.activeStage = state.failedStage = "readback";
				try {
					const readback = await vault.read(entry);
					state.readbackMatched = readback !== null && bytesEqual(readback, secret);
				} catch {
					state.mutationUncertain = true;
				}
				if (state.readbackMatched) {
					state.activeStage = state.failedStage = "delete";
					state.deleteAttempted = true;
					try {
						state.deleteDeleted = await vault.remove(entry);
						state.deleteSettled = true;
						if (!state.deleteDeleted) state.failedStage = "delete";
					} catch {
						state.mutationUncertain = true;
					}
				}
			}
		}
	} catch {
		// Load/construction/precheck failures mutate nothing.
	}

	if (state.deleteSettled && vault !== undefined && entry !== undefined) {
		state.activeStage = state.failedStage = "final-read";
		try {
			state.finalAbsent = (await vault.read(entry)) === null;
		} catch {
			state.mutationUncertain = true;
		}
	}

	// Exact cleanup only after a settled write, absent precheck, and no delete
	// attempt. Uncertain native mutations/attempted deletes are retained.
	if (state.precheckAbsent && state.setSettled && !state.deleteAttempted && vault && entry) {
		state.cleanupAttempted = true;
		try {
			await vault.remove(entry);
			state.cleanupAbsent = (await vault.read(entry)) === null;
			if (!state.cleanupAbsent) {
				state.failedStage = "cleanup";
				state.mutationUncertain = true;
			}
		} catch {
			state.cleanupAbsent = null;
			state.failedStage = "cleanup";
			state.mutationUncertain = true;
		}
	}

	let outcome: ProbeOutcome = "fail";
	let exitCode = 1;
	if (
		state.precheckAbsent &&
		state.setSettled &&
		state.readbackMatched &&
		state.deleteSettled &&
		state.deleteDeleted === true &&
		state.finalAbsent === true
	) {
		outcome = "pass";
		exitCode = 0;
		state.failedStage = null;
	} else if (state.mutationUncertain) {
		outcome = "uncertain";
		exitCode = 3;
	}
	clearTimeout(timer);
	report(outcome, state.failedStage);
	return exitCode;
}

async function main(): Promise<void> {
	process.exitCode = await runProbe(process.argv.slice(2));
}

if (import.meta.main) void main();
