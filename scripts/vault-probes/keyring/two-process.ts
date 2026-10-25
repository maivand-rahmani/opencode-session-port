/**
 * Owner-authorized synthetic two-process persistence probe for the pinned
 * `@napi-rs/keyring@2.1.2` binding. The parent creates 32 CSPRNG bytes in
 * memory and sends them only over child stdin. Child A preflights the exact
 * UUID-derived entry, writes, verifies its own readback, and exits without
 * deleting. After A's exit tree is verified stopped, child B reads the same
 * exact entry in a fresh process, compares bytes and SHA-256 with the
 * parent-expected stdin value, deletes exactly that entry, and verifies
 * absence. No enumeration, plaintext file, secret-bearing env/argv/log, or
 * production credential is used.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createKeyringVault } from "../../../src/cloud/vault/keyring.ts";
import type { KeyringAsyncEntryConstructor } from "../../../src/cloud/vault/keyring.ts";
import type { SecureVault, VaultEntry } from "../../../src/cloud/vault/types.ts";
import { probeEntry } from "./probe.ts";

const MODULE_ID = "@napi-rs/keyring";
const RUN_FLAG = "--run-two-process-probe";
const CHILD_FLAG = "--child";
const MIN_DEADLINE_MS = 1_000;
const MAX_DEADLINE_MS = 120_000;
const SECRET_BYTES = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHILD_TIMEOUT_GRACE_MS = 2_000;
const TREE_CHECK_TIMEOUT_MS = 5_000;
const MAX_CHILD_OUTPUT_BYTES = 4_096;
const SCRIPT_PATH = fileURLToPath(new URL("./two-process.ts", import.meta.url));
const USAGE = `usage: bun run two-process.ts ${RUN_FLAG} --run-id <canonical-uuid> --deadline-ms <${MIN_DEADLINE_MS}..${MAX_DEADLINE_MS}>`;

export type ChildRole = "write" | "read-delete" | "cleanup";
export type ProbeOutcome = "pass" | "fail" | "uncertain" | "timeout";

export interface ProbeIo {
	stdout(line: string): void;
	stderr(line: string): void;
}

const processIo: ProbeIo = {
	stdout: (line) => process.stdout.write(`${line}\n`),
	stderr: (line) => process.stderr.write(`${line}\n`),
};

export interface ChildExecution {
	exitCode: number | null;
	timedOut: boolean;
	treeStopped: boolean;
	stderrPresent: boolean;
	report: Record<string, unknown> | null;
}

export type ChildRunner = (
	role: ChildRole,
	runId: string,
	deadlineMs: number,
	secret: Uint8Array,
) => Promise<ChildExecution>;

export interface TwoProcessResult {
	probe: "synthetic-keyring-two-process";
	runId: string;
	runtime: { platform: string; arch: string; bun: string };
	childA: ChildExecution;
	childB: ChildExecution | null;
	cleanup: ChildExecution | null;
	initialEntryPresent: boolean;
	entryAbsentAfter: boolean | null;
	exactEntryRetained: boolean;
	entryStateUncertain: boolean;
	ok: boolean;
	exitCode: number;
	failedStage: string | null;
	secretLength: number;
	limitations: readonly string[];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function sha256(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function parseDeadline(value: string | undefined): number {
	if (value === undefined || !/^\d+$/.test(value)) throw new Error(USAGE);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < MIN_DEADLINE_MS || parsed > MAX_DEADLINE_MS) {
		throw new Error(USAGE);
	}
	return parsed;
}

function parseRunId(value: string | undefined): string {
	if (value === undefined || !UUID_PATTERN.test(value)) throw new Error(USAGE);
	return value;
}

function parseRole(value: string | undefined): ChildRole {
	if (value === "write" || value === "read-delete" || value === "cleanup") return value;
	throw new Error(USAGE);
}

/** Parent flags only; child flags are rejected. */
export function parseTwoProcessArgs(argv: readonly string[]): { runId: string; deadlineMs: number } {
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
			runId = parseRunId(argv[index + 1]);
			index += 1;
			continue;
		}
		if (arg === "--deadline-ms") {
			if (deadlineMs !== undefined) throw new Error(USAGE);
			deadlineMs = parseDeadline(argv[index + 1]);
			index += 1;
			continue;
		}
		throw new Error(USAGE);
	}
	if (!enabled || runId === undefined || deadlineMs === undefined) throw new Error(USAGE);
	return { runId, deadlineMs };
}

/** Internal child flags only. Secret bytes are never accepted from argv. */
export function parseChildArgs(argv: readonly string[]): {
	role: ChildRole;
	runId: string;
	deadlineMs: number;
} {
	let role: ChildRole | undefined;
	let runId: string | undefined;
	let deadlineMs: number | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === CHILD_FLAG) {
			if (role !== undefined) throw new Error(USAGE);
			role = parseRole(argv[index + 1]);
			index += 1;
			continue;
		}
		if (arg === "--run-id") {
			if (runId !== undefined) throw new Error(USAGE);
			runId = parseRunId(argv[index + 1]);
			index += 1;
			continue;
		}
		if (arg === "--deadline-ms") {
			if (deadlineMs !== undefined) throw new Error(USAGE);
			deadlineMs = parseDeadline(argv[index + 1]);
			index += 1;
			continue;
		}
		throw new Error(USAGE);
	}
	if (role === undefined || runId === undefined || deadlineMs === undefined) throw new Error(USAGE);
	return { role, runId, deadlineMs };
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

async function readStdinSecret(): Promise<Uint8Array | null> {
	const chunks: number[] = [];
	try {
		for await (const chunk of process.stdin) {
			const bytes = chunk as Uint8Array;
			for (const byte of bytes) {
				chunks.push(byte);
				if (chunks.length > SECRET_BYTES) return null;
			}
		}
	} catch {
		return null;
	}
	if (chunks.length !== SECRET_BYTES) return null;
	return new Uint8Array(chunks);
}

interface ChildState {
	precheckAbsent: boolean | null;
	setSettled: boolean;
	readbackMatched: boolean;
	entryPresent: boolean | null;
	bytesMatch: boolean;
	sha256Match: boolean;
	deleteAttempted: boolean;
	deleteSettled: boolean;
	deleteDeleted: boolean | null;
	finalAbsent: boolean | null;
	entryWasPresent: boolean | null;
	mutationUncertain: boolean;
	activeStage: string;
	failedStage: string | null;
}

/**
 * Runs one child role. The watchdog hard-exits on deadline; its report reflects
 * only state already observed and makes no rollback claim.
 */
export async function runChild(
	role: ChildRole,
	runId: string,
	deadlineMs: number,
	io: ProbeIo = processIo,
): Promise<number> {
	const state: ChildState = {
		precheckAbsent: null,
		setSettled: false,
		readbackMatched: false,
		entryPresent: null,
		bytesMatch: false,
		sha256Match: false,
		deleteAttempted: false,
		deleteSettled: false,
		deleteDeleted: null,
		finalAbsent: null,
		entryWasPresent: null,
		mutationUncertain: false,
		activeStage: "stdin",
		failedStage: "stdin",
	};
	let reported = false;
	const report = (outcome: ProbeOutcome, stage: string | null): void => {
		if (reported) return;
		reported = true;
		io.stdout(
			JSON.stringify({
				probe: "synthetic-keyring-two-process",
				role,
				runId,
				outcome,
				precheckAbsent: state.precheckAbsent,
				setSettled: state.setSettled,
				readbackMatched: state.readbackMatched,
				entryPresent: state.entryPresent,
				bytesMatch: state.bytesMatch,
				sha256Match: state.sha256Match,
				deleteAttempted: state.deleteAttempted,
				deleteSettled: state.deleteSettled,
				deleteDeleted: state.deleteDeleted,
				finalAbsent: state.finalAbsent,
				entryWasPresent: state.entryWasPresent,
				mutationUncertain: state.mutationUncertain,
				secretLength: SECRET_BYTES,
				failedStage: stage,
			}),
		);
	};
	const timer = setTimeout(() => {
		report("timeout", state.activeStage);
		process.exit(2);
	}, deadlineMs);

	const finish = (outcome: ProbeOutcome, stage: string | null, exitCode: number): number => {
		clearTimeout(timer);
		report(outcome, stage);
		return exitCode;
	};

	const secret = await readStdinSecret();
	if (secret === null) return finish("fail", "stdin", 1);

	let vault: SecureVault | undefined;
	let entry: VaultEntry | undefined;
	try {
		const AsyncEntry = await loadBinding();
		vault = createKeyringVault(AsyncEntry, { maxSecretBytes: SECRET_BYTES });
		entry = probeEntry(runId);

		if (role === "write") {
			state.activeStage = state.failedStage = "precheck";
			let existing: Uint8Array | null;
			try {
				existing = await vault.read(entry);
			} catch {
				return finish("fail", "precheck", 1);
			}
			state.precheckAbsent = existing === null;
			if (!state.precheckAbsent) return finish("fail", "precheck", 1);

			state.activeStage = state.failedStage = "set";
			try {
				await vault.write(entry, secret);
				state.setSettled = true;
			} catch {
				state.mutationUncertain = true;
				return finish("uncertain", "set", 3);
			}

			state.activeStage = state.failedStage = "readback";
			try {
				const readback = await vault.read(entry);
				state.readbackMatched = readback !== null && bytesEqual(readback, secret);
			} catch {
				state.mutationUncertain = true;
				return finish("uncertain", "readback", 3);
			}
			if (!state.readbackMatched) return finish("fail", "readback", 1);
			return finish("pass", null, 0);
		}

		if (role === "read-delete") {
			state.activeStage = state.failedStage = "read";
			let stored: Uint8Array | null;
			try {
				stored = await vault.read(entry);
			} catch {
				return finish("fail", "read", 1);
			}
			state.entryPresent = stored !== null;
			if (stored === null) return finish("fail", "missing", 1);
			state.bytesMatch = bytesEqual(stored, secret);
			state.sha256Match = bytesEqual(sha256(stored), sha256(secret));
			if (!state.bytesMatch || !state.sha256Match) return finish("fail", "mismatch", 1);

			state.activeStage = state.failedStage = "delete";
			state.deleteAttempted = true;
			try {
				state.deleteDeleted = await vault.remove(entry);
				state.deleteSettled = true;
			} catch {
				state.mutationUncertain = true;
				return finish("uncertain", "delete", 3);
			}
			state.activeStage = state.failedStage = "final-read";
			try {
				state.finalAbsent = (await vault.read(entry)) === null;
			} catch {
				state.mutationUncertain = true;
				return finish("uncertain", "final-read", 3);
			}
			if (state.deleteDeleted === true && state.finalAbsent) return finish("pass", null, 0);
			return finish("fail", "delete", 1);
		}

		state.activeStage = state.failedStage = "read";
		let stored: Uint8Array | null;
		try {
			stored = await vault.read(entry);
		} catch {
			return finish("fail", "read", 1);
		}
		state.entryWasPresent = stored !== null;
		if (stored === null) {
			state.finalAbsent = true;
			return finish("pass", null, 0);
		}
		state.bytesMatch = bytesEqual(stored, secret);
		state.sha256Match = bytesEqual(sha256(stored), sha256(secret));
		if (!state.bytesMatch || !state.sha256Match) return finish("fail", "mismatch", 1);

		state.activeStage = state.failedStage = "delete";
		state.deleteAttempted = true;
		try {
			state.deleteDeleted = await vault.remove(entry);
			state.deleteSettled = true;
		} catch {
			state.mutationUncertain = true;
			return finish("uncertain", "delete", 3);
		}
		state.activeStage = state.failedStage = "final-read";
		try {
			state.finalAbsent = (await vault.read(entry)) === null;
		} catch {
			state.mutationUncertain = true;
			return finish("uncertain", "final-read", 3);
		}
		if (state.deleteDeleted === true && state.finalAbsent) return finish("pass", null, 0);
		return finish("fail", "delete", 1);
	} catch {
		return finish("fail", "internal", 1);
	} finally {
		secret.fill(0);
	}
}

async function verifyTreeStopped(pid: number | undefined): Promise<boolean> {
	if (process.platform !== "win32" || pid === undefined) return false;
	const ps = spawn(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$p=Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" -ErrorAction SilentlyContinue; if ($null -eq $p) { 0 } else { @($p).Count }`,
		],
		{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
	);
	let stdout = "";
	let timedOut = false;
	const limit = setTimeout(() => {
		timedOut = true;
		try {
			ps.kill("SIGKILL");
		} catch {
			// The check process already exited.
		}
	}, TREE_CHECK_TIMEOUT_MS);
	ps.stdout.on("data", (chunk: Uint8Array) => {
		if (stdout.length < 16) stdout += chunk.toString();
	});
	const code = await new Promise<number | null>((resolve) => {
		ps.on("close", (exitCode) => resolve(exitCode));
		ps.on("error", () => resolve(null));
	});
	clearTimeout(limit);
	return !timedOut && code === 0 && stdout.trim() === "0";
}

function killOwnedTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.on("error", () => undefined);
			setTimeout(() => {
				try {
					killer.kill("SIGKILL");
				} catch {
					// Already exited.
				}
			}, TREE_CHECK_TIMEOUT_MS).unref?.();
			return;
		}
		process.kill(pid, "SIGKILL");
	} catch {
		// The exact child already exited; never target another process.
	}
}

function parseChildReport(stdout: string, role: ChildRole, runId: string): Record<string, unknown> | null {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length !== 1 || lines[0].length > MAX_CHILD_OUTPUT_BYTES) return null;
	try {
		const parsed: unknown = JSON.parse(lines[0]);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const report = parsed as Record<string, unknown>;
		if (report.probe !== "synthetic-keyring-two-process" || report.role !== role || report.runId !== runId) {
			return null;
		}
		return report;
	} catch {
		return null;
	}
}

export const spawnChildRole: ChildRunner = async (role, runId, deadlineMs, secret) => {
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(
			process.execPath,
			[SCRIPT_PATH, CHILD_FLAG, role, "--run-id", runId, "--deadline-ms", String(deadlineMs)],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
	} catch {
		return { exitCode: null, timedOut: false, treeStopped: false, stderrPresent: false, report: null };
	}

	let stdout = "";
	let stderrPresent = false;
	let timedOut = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const finish = async (exitCode: number | null): Promise<ChildExecution> => {
		if (settled) return { exitCode, timedOut, treeStopped: false, stderrPresent, report: null };
		settled = true;
		if (timer !== undefined) clearTimeout(timer);
		const treeStopped = await verifyTreeStopped(child.pid);
		return {
			exitCode,
			timedOut,
			treeStopped,
			stderrPresent,
			report: parseChildReport(stdout, role, runId),
		};
	};

	const done = new Promise<ChildExecution>((resolve) => {
		child.once("error", () => {
			void finish(null).then(resolve);
		});
		child.once("close", (exitCode) => {
			void finish(exitCode).then(resolve);
		});
		child.stdout.on("data", (chunk: Uint8Array) => {
			if (stdout.length < MAX_CHILD_OUTPUT_BYTES) {
				stdout += chunk.toString().slice(0, MAX_CHILD_OUTPUT_BYTES - stdout.length);
			}
		});
		child.stderr.on("data", () => {
			stderrPresent = true;
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(secret);
		timer = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) killOwnedTree(child.pid);
		}, deadlineMs + CHILD_TIMEOUT_GRACE_MS);
	});
	return done;
};

function reportPassA(report: Record<string, unknown> | null): boolean {
	return (
		report !== null &&
		report.outcome === "pass" &&
		report.precheckAbsent === true &&
		report.setSettled === true &&
		report.readbackMatched === true &&
		report.deleteAttempted === false
	);
}

function reportPassB(report: Record<string, unknown> | null): boolean {
	return (
		report !== null &&
		report.outcome === "pass" &&
		report.entryPresent === true &&
		report.bytesMatch === true &&
		report.sha256Match === true &&
		report.deleteAttempted === true &&
		report.deleteSettled === true &&
		report.deleteDeleted === true &&
		report.finalAbsent === true
	);
}

function reportPassCleanup(report: Record<string, unknown> | null): boolean {
	if (report === null || report.outcome !== "pass" || report.finalAbsent !== true) return false;
	if (report.entryWasPresent === false) return true;
	return report.bytesMatch === true && report.deleteSettled === true && report.deleteDeleted === true;
}

const LIMITATIONS = [
	"two cooperating child processes, not an OS reboot or restart",
	"not locked/unavailable Windows credential-store proof",
	"not macOS/Linux/platform-matrix or general AUTH-02 proof",
	"not a product/TUI/login/provider/LLM integration test",
] as const;

export async function runTwoProcessProbe(
	argv: readonly string[],
	runner: ChildRunner = spawnChildRole,
	secretFactory: () => Uint8Array = () => new Uint8Array(randomBytes(SECRET_BYTES)),
): Promise<{ exitCode: number; result: TwoProcessResult }> {
	const config = parseTwoProcessArgs(argv);
	const secret = secretFactory();
	if (!(secret instanceof Uint8Array) || secret.length !== SECRET_BYTES) {
		throw new Error(USAGE);
	}

	const emptyChild: ChildExecution = {
		exitCode: null,
		timedOut: false,
		treeStopped: false,
		stderrPresent: false,
		report: null,
	};
	const runtime = {
		platform: process.platform,
		arch: process.arch,
		bun: typeof process.versions.bun === "string" ? process.versions.bun : "unknown",
	};

	let childA = emptyChild;
	let childB: ChildExecution | null = null;
	let cleanup: ChildExecution | null = null;
	let initialEntryPresent = false;
	let entryAbsentAfter: boolean | null = null;
	let exactEntryRetained = false;
	let entryStateUncertain = false;
	let ok = false;
	let exitCode = 1;
	let failedStage: string | null = null;

	try {
		childA = await runner("write", config.runId, config.deadlineMs, secret);
		const aPass = !childA.timedOut && childA.treeStopped && childA.exitCode === 0 && reportPassA(childA.report);
		initialEntryPresent = childA.report?.precheckAbsent === false;
		const owned = childA.report?.precheckAbsent === true && childA.report?.setSettled === true;

		if (!aPass) {
			failedStage = childA.timedOut
				? "child-a-timeout"
				: !childA.treeStopped
					? "child-a-tree"
					: typeof childA.report?.failedStage === "string"
						? childA.report.failedStage
						: "child-a";
			entryStateUncertain = !initialEntryPresent && entryAbsentAfter !== true;
		} else {
			childB = await runner("read-delete", config.runId, config.deadlineMs, secret);
			const bPass = !childB.timedOut && childB.treeStopped && childB.exitCode === 0 && reportPassB(childB.report);
			if (!bPass) {
				failedStage = childB.timedOut
					? "child-b-timeout"
					: !childB.treeStopped
						? "child-b-tree"
						: typeof childB.report?.failedStage === "string"
							? childB.report.failedStage
							: "child-b";
			}
			ok = bPass;
			entryAbsentAfter = childB.report?.finalAbsent === true ? true : null;
		}

		if (ok) {
			entryAbsentAfter = true;
			exitCode = 0;
		} else {
			const bothStopped = childA.treeStopped && (childB === null || childB.treeStopped);
			const mayRemain = heldEntryMayRemain(childA, childB);
			if (bothStopped && mayRemain) {
				cleanup = await runner("cleanup", config.runId, config.deadlineMs, secret);
				if (!cleanup.timedOut && cleanup.treeStopped && cleanup.exitCode === 0 && reportPassCleanup(cleanup.report)) {
					entryAbsentAfter = true;
				} else {
					entryAbsentAfter = cleanup.report?.finalAbsent === true ? true : false;
					failedStage = cleanup.timedOut
						? "cleanup-timeout"
						: !cleanup.treeStopped
							? "cleanup-tree"
							: "cleanup";
					entryStateUncertain = true;
				}
			}
			exactEntryRetained =
				!initialEntryPresent &&
				entryAbsentAfter !== true &&
				(childA.timedOut || childA.report?.precheckAbsent === true || childA.report?.setSettled === true);
			entryStateUncertain = entryStateUncertain || (exactEntryRetained && failedStage !== "cleanup");
			const timedOut = childA.timedOut || childB?.timedOut === true || cleanup?.timedOut === true;
			exitCode = timedOut ? 2 : exactEntryRetained || childB?.report?.mutationUncertain === true || cleanup !== null ? 3 : 1;
		}
	} finally {
		secret.fill(0);
	}

	return {
		exitCode,
		result: {
			probe: "synthetic-keyring-two-process",
			runId: config.runId,
			runtime,
			childA,
			childB,
			cleanup,
			initialEntryPresent,
			entryAbsentAfter,
			exactEntryRetained,
			entryStateUncertain,
			ok,
			exitCode,
			failedStage,
			secretLength: SECRET_BYTES,
			limitations: LIMITATIONS,
		},
	};
}

function heldEntryMayRemain(childA: ChildExecution, childB: ChildExecution | null): boolean {
	if (childA.report?.precheckAbsent !== true || childA.report?.setSettled !== true) return false;
	if (childB === null) return true;
	return childB.report?.finalAbsent !== true;
}

async function main(): Promise<void> {
	if (process.argv[2] === CHILD_FLAG) {
		let config: ReturnType<typeof parseChildArgs>;
		try {
			config = parseChildArgs(process.argv.slice(2));
		} catch {
			processIo.stderr(USAGE);
			process.exitCode = 1;
			return;
		}
		process.exitCode = await runChild(config.role, config.runId, config.deadlineMs, processIo);
		return;
	}

	let running: Awaited<ReturnType<typeof runTwoProcessProbe>>;
	try {
		running = await runTwoProcessProbe(process.argv.slice(2));
	} catch {
		processIo.stderr(USAGE);
		process.exitCode = 1;
		return;
	}
	processIo.stdout(JSON.stringify(running.result));
	process.exitCode = running.exitCode;
}

if (import.meta.main) void main();
