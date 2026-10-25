import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	acquireSessionOwner,
	SessionOwnerError,
	type SessionOwnerErrorCode,
} from "../../../src/cloud/auth/session-owner.ts";
import {
	WINDOWS,
	createPrivateDirectory,
	createPrivateDirectoryAt,
	createPrivateRoot,
	createUnsafeDirectory,
	currentWindowsAccountName,
	currentWindowsSid,
	grantUsersRead,
	hasUsersReadAcl,
	isSyntheticRoot,
	removeSyntheticRoot,
	setWindowsOwner,
	SYNTHETIC_TEMP_ROOT,
	trackRoot,
	windowsAclEntries,
	windowsAclFingerprint,
	windowsAclOwnerSid,
} from "../../helpers/private-state-directory.ts";

const CHILD_FIXTURE = join(import.meta.dir, "fixtures", "session-owner-child.ts");
const TEST_ROOT_PARENT = SYNTHETIC_TEMP_ROOT;
const NONCE_FILE_NAME = "nonce";

const syntheticRoots = new Set<string>();
const activeChildren = new Set<ReturnType<typeof Bun.spawn>>();

interface ChildRun {
	readonly process: ReturnType<typeof Bun.spawn>;
	readLine(): Promise<string>;
	readonly exited: Promise<number>;
}

function trackAndRemember(root: string): string {
	const tracked = trackRoot(root);
	syntheticRoots.add(tracked);
	return tracked;
}

async function createRoot(label: string): Promise<string> {
	return trackAndRemember(await createPrivateRoot(label));
}

async function createPrivateStateDirectory(root: string, name = "state"): Promise<string> {
	return createPrivateDirectory(root, name);
}

/** Local alias kept for the existing unsafe-fixture assertion. */
async function grantWindowsUsersRead(directory: string): Promise<void> {
	await grantUsersRead(directory);
}

function probeSymlinkSupport(): boolean {
	const base = join(TEST_ROOT_PARENT, `symlink-probe-${randomUUID()}`);
	try {
		mkdirSync(base, { recursive: true });
		mkdirSync(join(base, "target"));
		symlinkSync(join(base, "target"), join(base, "link"), WINDOWS ? "junction" : "dir");
		rmSync(base, { recursive: true, force: true });
		return true;
	} catch {
		try {
			rmSync(base, { recursive: true, force: true });
		} catch {
			// Probe cleanup only.
		}
		return false;
	}
}

const SYMLINK_SUPPORTED = probeSymlinkSupport();

function spawnOwnerChild(args: readonly string[]): ChildRun {
	const child = Bun.spawn([process.execPath, CHILD_FIXTURE, ...args], {
		cwd: process.cwd(),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	activeChildren.add(child);

	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	const stderrText = new Response(child.stderr).text().catch(() => "");
	let buffer = "";
	const exited = (async () => {
		const code = await child.exited;
		await stderrText;
		return code;
	})();

	async function readLine(): Promise<string> {
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				return line;
			}
			const { value, done } = await reader.read();
			if (done) {
				if (buffer.length > 0) {
					const line = buffer;
					buffer = "";
					return line;
				}
				throw new Error("child stdout ended before a status line");
			}
			buffer += decoder.decode(value, { stream: true });
		}
	}

	return { process: child, readLine, exited };
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`deadline exceeded: ${label}`)), 20_000);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function closeStdin(run: ChildRun): void {
	const stdin = run.process.stdin as { end?: () => void } | undefined;
	stdin?.end?.();
}

async function expectChildLine(run: ChildRun, expected: string, label: string): Promise<void> {
	expect(await withDeadline(run.readLine(), label)).toBe(expected);
}

async function findLockDirectory(stateDirectory: string): Promise<string> {
	const entries = await readdir(stateDirectory, { withFileTypes: true });
	const directories = entries.filter((entry) => entry.isDirectory());
	expect(directories).toHaveLength(1);
	return join(stateDirectory, directories[0]!.name);
}

async function findNonceFile(lockDirectory: string): Promise<string> {
	const entries = await readdir(lockDirectory);
	expect(entries).toHaveLength(1);
	return join(lockDirectory, entries[0]!);
}

async function expectOwnerError(
	action: Promise<unknown>,
	code: SessionOwnerErrorCode,
): Promise<SessionOwnerError> {
	try {
		await action;
	} catch (error) {
		expect(error).toBeInstanceOf(SessionOwnerError);
		const ownerError = error as SessionOwnerError;
		expect(ownerError.code).toBe(code);
		expect(ownerError.message).not.toContain(TEST_ROOT_PARENT);
		expect(ownerError.cause).toBeUndefined();
		return ownerError;
	}
	throw new Error(`expected SessionOwnerError(${code})`);
}

afterEach(async () => {
	for (const child of activeChildren) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already exited.
		}
	}
	await Promise.allSettled([...activeChildren].map((child) => child.exited));
	activeChildren.clear();

	for (const root of syntheticRoots) {
		if (!isSyntheticRoot(root)) throw new Error("refusing non-synthetic cleanup");
		await removeSyntheticRoot(root);
	}
	syntheticRoots.clear();
});

describe("session owner lock primitive", () => {
	test(
		"creates a private missing state directory, releases idempotently, and admits the next owner",
		async () => {
			const root = await createRoot("owner-normal");
			const stateDirectory = join(root, "created-state");

			const first = spawnOwnerChild(["--state-directory", stateDirectory, "--mode", "hold"]);
			await expectChildLine(first, "ACQUIRED", "first acquire");
			closeStdin(first);
			await expectChildLine(first, "RELEASED", "first release");
			await expectChildLine(first, "SECOND-RELEASE-OK", "second release");
			expect(await withDeadline(first.exited, "first exit")).toBe(0);

			const createdStats = await lstat(stateDirectory);
			expect(createdStats.isDirectory()).toBe(true);
			if (!WINDOWS) {
				expect(createdStats.mode & 0o077).toBe(0);
			}
			expect(await readdir(stateDirectory)).toEqual([]);

			const second = spawnOwnerChild(["--state-directory", stateDirectory, "--mode", "hold"]);
			await expectChildLine(second, "ACQUIRED", "second owner acquire");
			closeStdin(second);
			await expectChildLine(second, "RELEASED", "second owner release");
			await expectChildLine(second, "SECOND-RELEASE-OK", "second owner second release");
			expect(await withDeadline(second.exited, "second owner exit")).toBe(0);
			expect(await readdir(stateDirectory)).toEqual([]);
		},
		60_000,
	);

	test(
		"two actual child processes race: exactly one acquires and the other is owner-busy",
		async () => {
			const root = await createRoot("owner-race");
			const stateDirectory = await createPrivateStateDirectory(root);

			const first = spawnOwnerChild(["--state-directory", stateDirectory, "--mode", "hold"]);
			const second = spawnOwnerChild(["--state-directory", stateDirectory, "--mode", "hold"]);
			const statuses = await withDeadline(
				Promise.all([first.readLine(), second.readLine()]),
				"race statuses",
			);
			const wins = statuses.filter((status) => status === "ACQUIRED");
			const busy = statuses.filter((status) => status === "ERROR:owner-busy");
			expect(wins).toHaveLength(1);
			expect(busy).toHaveLength(1);

			const winnerIndex = statuses.indexOf("ACQUIRED");
			const winner = winnerIndex === 0 ? first : second;
			const loser = winnerIndex === 0 ? second : first;
			closeStdin(winner);
			await expectChildLine(winner, "RELEASED", "race winner release");
			await expectChildLine(winner, "SECOND-RELEASE-OK", "race winner second release");
			expect(await withDeadline(winner.exited, "race winner exit")).toBe(0);
			expect(await withDeadline(loser.exited, "race loser exit")).toBe(2);
			expect(await readdir(stateDirectory)).toEqual([]);

			const next = spawnOwnerChild(["--state-directory", stateDirectory, "--mode", "hold"]);
			await expectChildLine(next, "ACQUIRED", "post-race acquire");
			closeStdin(next);
			await expectChildLine(next, "RELEASED", "post-race release");
			await expectChildLine(next, "SECOND-RELEASE-OK", "post-race second release");
			expect(await withDeadline(next.exited, "post-race exit")).toBe(0);
		},
		60_000,
	);

	test(
		"a killed child leaves the lock; a new child observes owner-busy until test cleanup",
		async () => {
			const root = await createRoot("owner-killed");
			const stateDirectory = await createPrivateStateDirectory(root);

			const killed = spawnOwnerChild(["--state-directory", stateDirectory, "--mode", "hold-forever"]);
			await expectChildLine(killed, "ACQUIRED", "killed child acquire");
			killed.process.kill("SIGKILL");
			await withDeadline(killed.exited, "killed child exit");

			const blocked = spawnOwnerChild(["--state-directory", stateDirectory, "--mode", "hold"]);
			await expectChildLine(blocked, "ERROR:owner-busy", "blocked child acquire");
			expect(await withDeadline(blocked.exited, "blocked child exit")).toBe(2);

			const lockDirectory = await findLockDirectory(stateDirectory);
			const nonceFile = await findNonceFile(lockDirectory);
			expect((await readFile(nonceFile, "utf8")).length).toBe(64);
		},
		60_000,
	);

	test(
		"a changed nonce refuses release with ownership-lost and retains the lock",
		async () => {
			const root = await createRoot("owner-nonce");
			const stateDirectory = await createPrivateStateDirectory(root);

			const run = spawnOwnerChild(["--state-directory", stateDirectory, "--mode", "corrupt-nonce"]);
			await expectChildLine(run, "ACQUIRED", "nonce child acquire");
			await expectChildLine(run, "RELEASE-ERROR:ownership-lost", "nonce child release");
			expect(await withDeadline(run.exited, "nonce child exit")).toBe(0);

			const lockDirectory = await findLockDirectory(stateDirectory);
			const nonceFile = await findNonceFile(lockDirectory);
			expect(await readFile(nonceFile, "utf8")).toBe("f".repeat(64));

			const blocked = spawnOwnerChild(["--state-directory", stateDirectory, "--mode", "hold"]);
			await expectChildLine(blocked, "ERROR:owner-busy", "nonce-retained busy");
			expect(await withDeadline(blocked.exited, "nonce-retained exit")).toBe(2);
		},
		60_000,
	);

	test(
		"an unexpected lock entry refuses release with ownership-lost and retains the lock",
		async () => {
			const root = await createRoot("owner-extra");
			const stateDirectory = await createPrivateStateDirectory(root);

			const run = spawnOwnerChild(["--state-directory", stateDirectory, "--mode", "extra-file"]);
			await expectChildLine(run, "ACQUIRED", "extra-file child acquire");
			await expectChildLine(run, "RELEASE-ERROR:ownership-lost", "extra-file child release");
			expect(await withDeadline(run.exited, "extra-file child exit")).toBe(0);

			const lockDirectory = await findLockDirectory(stateDirectory);
			expect((await readdir(lockDirectory)).sort()).toEqual([NONCE_FILE_NAME, "unexpected-entry"]);
		},
		60_000,
	);

	test("rejects a relative state directory before touching the filesystem", async () => {
		const relative = `relative-owner-${randomUUID()}`;
		const run = spawnOwnerChild(["--state-directory", relative, "--mode", "hold"]);
		await expectChildLine(run, "ERROR:invalid-state-directory", "relative path");
		expect(await withDeadline(run.exited, "relative path exit")).toBe(2);
		await expect(lstat(join(process.cwd(), relative))).rejects.toThrow();
	});

	test(
		"rejects a non-private state directory",
		async () => {
			const root = await createRoot("owner-nonprivate");
			const directory = join(root, "loose");
			await mkdir(directory, { recursive: true, mode: 0o700 });
			if (WINDOWS) await grantWindowsUsersRead(directory);
			else await chmod(directory, 0o755);

			const run = spawnOwnerChild(["--state-directory", directory, "--mode", "hold"]);
			await expectChildLine(run, "ERROR:invalid-state-directory", "non-private directory");
			expect(await withDeadline(run.exited, "non-private directory exit")).toBe(2);
			expect(await readdir(directory)).toEqual([]);
		},
		60_000,
	);

	test.skipIf(!SYMLINK_SUPPORTED)(
		"rejects a symlinked state directory and a symlinked ancestor",
		async () => {
			const root = await createRoot("owner-symlink");
			const target = await createPrivateStateDirectory(root, "target");
			const link = join(root, "link");
			await symlink(target, link, WINDOWS ? "junction" : "dir");

			const direct = spawnOwnerChild(["--state-directory", link, "--mode", "hold"]);
			await expectChildLine(direct, "ERROR:invalid-state-directory", "symlink state directory");
			expect(await withDeadline(direct.exited, "symlink state directory exit")).toBe(2);
			expect(await readdir(target)).toEqual([]);

			const realAncestor = join(root, "real-ancestor");
			const nestedState = join(realAncestor, "nested-state");
			await createPrivateDirectoryAt(nestedState);
			const ancestorLink = join(root, "ancestor-link");
			await symlink(realAncestor, ancestorLink, WINDOWS ? "junction" : "dir");

			const nested = spawnOwnerChild([
				"--state-directory",
				join(ancestorLink, "nested-state"),
				"--mode",
				"hold",
			]);
			await expectChildLine(nested, "ERROR:invalid-state-directory", "symlink ancestor");
			expect(await withDeadline(nested.exited, "symlink ancestor exit")).toBe(2);
			expect(await readdir(nestedState)).toEqual([]);
		},
		60_000,
	);

	test.skipIf(WINDOWS)("rejects POSIX group/other permission bits", async () => {
		const root = await createRoot("owner-posix-mode");
		const loose = join(root, "loose");
		await mkdir(loose, { mode: 0o755 });
		await chmod(loose, 0o755);
		await expectOwnerError(acquireSessionOwner({ stateDirectory: loose }), "invalid-state-directory");

		const tight = join(root, "tight");
		await mkdir(tight, { mode: 0o700 });
		await chmod(tight, 0o700);
		const owner = await acquireSessionOwner({ stateDirectory: tight });
		await owner.release();
		await owner.release();

		const created = join(root, "created");
		const createdOwner = await acquireSessionOwner({ stateDirectory: created });
		await createdOwner.release();
		expect((await lstat(created)).mode & 0o077).toBe(0);
	});

	test("release fails closed when the lock directory identity is replaced", async () => {
		const root = await createRoot("owner-replaced-directory");
		const stateDirectory = await createPrivateStateDirectory(root);
		const owner = await acquireSessionOwner({ stateDirectory });
		const lockDirectory = await findLockDirectory(stateDirectory);
		const nonceFile = await findNonceFile(lockDirectory);
		const nonceText = await readFile(nonceFile, "utf8");

		const savedLock = join(stateDirectory, "saved-lock");
		await rename(lockDirectory, savedLock);
		await mkdir(lockDirectory, { mode: 0o700 });
		await writeFile(join(lockDirectory, NONCE_FILE_NAME), nonceText, { mode: 0o600 });

		await expectOwnerError(owner.release(), "ownership-lost");
		expect((await lstat(savedLock)).isDirectory()).toBe(true);
		expect(await readFile(join(lockDirectory, NONCE_FILE_NAME), "utf8")).toBe(nonceText);
	});

	test("release fails closed when the nonce file identity is replaced", async () => {
		const root = await createRoot("owner-replaced-nonce");
		const stateDirectory = await createPrivateStateDirectory(root);
		const owner = await acquireSessionOwner({ stateDirectory });
		const lockDirectory = await findLockDirectory(stateDirectory);
		const nonceFile = await findNonceFile(lockDirectory);
		const nonceText = await readFile(nonceFile, "utf8");

		await unlink(nonceFile);
		await writeFile(nonceFile, nonceText, { mode: 0o600 });

		await expectOwnerError(owner.release(), "ownership-lost");
		expect(await readFile(nonceFile, "utf8")).toBe(nonceText);
	});

	// Regression coverage for the CI-only fixture failure: a fresh directory must
	// be created with an explicitly private ACL (current user + SYSTEM +
	// Administrators on Windows) instead of inheriting the generic temp ACL.
	test("a helper-created private directory carries the exact private ACL and is admitted", async () => {
		const root = await createRoot("owner-regression-positive");
		const stateDirectory = await createPrivateDirectory(root);
		const parentFingerprint = WINDOWS ? windowsAclFingerprint(root) : "";

		if (WINDOWS) {
			const fingerprint = windowsAclFingerprint(stateDirectory);
			expect(fingerprint.toLowerCase()).toContain(currentWindowsAccountName().toLowerCase());
			// Owner identity, not just the ACE account: Windows defaults can leave
			// a fresh directory owned by Administrators on elevated tokens.
			expect(windowsAclOwnerSid(stateDirectory)).toBe(currentWindowsSid());
			expect(windowsAclOwnerSid(root)).toBe(currentWindowsSid());
		} else {
			expect((await lstat(stateDirectory)).mode & 0o077).toBe(0);
		}

		const owner = await acquireSessionOwner({ stateDirectory });
		await owner.release();
		expect(await readdir(stateDirectory)).toEqual([]);
		expect(await readdir(root)).toEqual(["state"]);
		if (WINDOWS) expect(windowsAclFingerprint(root)).toBe(parentFingerprint);
	});

	test("an owned but unsafe child directory is refused without touching its parent ACL", async () => {
		const root = await createRoot("owner-regression-negative");
		const parentFingerprint = WINDOWS ? windowsAclFingerprint(root) : "";
		const unsafe = await createUnsafeDirectory(root, "unsafe");
		if (WINDOWS) {
			// Semantic SID/access readback, not a raw ACE count: Windows can
			// canonicalize or merge entries, so totals are not portable.
			expect(windowsAclOwnerSid(unsafe)).toBe(currentWindowsSid());
			const unsafeEntries = windowsAclEntries(unsafe);
			expect(unsafeEntries).toContainEqual({
				sid: "S-1-5-32-545",
				allow: true,
				grantsRead: true,
			});
			// The parent remains private: no BUILTIN\Users allow-read ACE.
			const parentEntries = windowsAclEntries(root);
			expect(parentEntries).not.toContainEqual({
				sid: "S-1-5-32-545",
				allow: true,
				grantsRead: true,
			});
			expect(hasUsersReadAcl(root)).toBe(false);
		} else {
			expect((await lstat(unsafe)).mode & 0o077).not.toBe(0);
		}

		await expectOwnerError(acquireSessionOwner({ stateDirectory: unsafe }), "invalid-state-directory");
		// No lock directory or nonce was created in the refused target.
		expect(await readdir(unsafe)).toEqual([]);
		if (WINDOWS) {
			// Exact parent ACL unchanged after the refusal.
			expect(windowsAclFingerprint(root)).toBe(parentFingerprint);
		}
	});

	test("a pre-existing Administrators-owned directory is refused, never re-owned", async () => {
		const root = await createRoot("owner-regression-admin-owned");
		const directory = await createPrivateDirectory(root, "admin-owned");
		const parentFingerprint = WINDOWS ? windowsAclFingerprint(root) : "";

		if (WINDOWS) {
			let administrativelyOwned = false;
			try {
				setWindowsOwner(directory, "S-1-5-32-544");
				administrativelyOwned = windowsAclOwnerSid(directory) === "S-1-5-32-544";
			} catch {
				administrativelyOwned = false;
			}
			if (administrativelyOwned) {
				await expectOwnerError(
					acquireSessionOwner({ stateDirectory: directory }),
					"invalid-state-directory",
				);
				// The production create-only ownership fix must not rewrite it.
				expect(windowsAclOwnerSid(directory)).toBe("S-1-5-32-544");
				expect(await readdir(directory)).toEqual([]);
				return;
			}
			// Non-elevated host: the Administrators-owned fixture cannot be built.
			// The gate must still refuse an owned-but-broadened directory.
			expect(windowsAclOwnerSid(directory)).toBe(currentWindowsSid());
			await grantUsersRead(directory);
		} else {
			await grantUsersRead(directory);
		}

		await expectOwnerError(acquireSessionOwner({ stateDirectory: directory }), "invalid-state-directory");
		expect(await readdir(directory)).toEqual([]);
		if (WINDOWS) expect(windowsAclFingerprint(root)).toBe(parentFingerprint);
	});
});
