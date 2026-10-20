/**
 * Local cross-process single-owner primitive for one explicitly configured
 * state directory.
 *
 * Acquisition is an atomic exclusive `mkdir` of one fixed lock directory. The
 * lock directory contains exactly one random nonce file: no credential, code,
 * PID, timestamp, or caller text. There is no PID-based staleness heuristic
 * and no automatic stealing. A crashed owner leaves the lock behind for
 * manual recovery.
 *
 * This module is a lock primitive only. It performs no credential or vault
 * operation; callers must hold the lease for the whole controller lifetime.
 *
 * Security boundary: the configured state directory must already be, or be
 * created as, a private directory. POSIX checks the owner UID and rejects any
 * group/other permission bit (POSIX ACLs and ancestor ACLs are not audited).
 * Windows reads the directory ACL through a fixed, trusted PowerShell
 * `Get-Acl` script whose only variable input is the path in an environment
 * variable; it requires a current-user owner and allows only the current user,
 * SYSTEM, Administrators, and CREATOR OWNER allow ACEs. Windows does not
 * pretend that POSIX mode bits are meaningful.
 *
 * Symlink/reparse-point ancestors that Node can detect are rejected. This is
 * a cooperating-process contract: a non-cooperating process with write access
 * to the state directory can replace or populate paths in ways this module
 * cannot fence. No recursive cleanup is ever performed.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join, parse as parsePath, resolve } from "node:path";

const LOCK_DIRECTORY_NAME = "session-owner.lock";
const NONCE_FILE_NAME = "nonce";
const NONCE_TEXT_LENGTH = 64;
const ACL_ENVIRONMENT_NAME = "SESSIONPORT_OWNER_STATE_DIRECTORY";

const ALLOWED_WINDOWS_SIDS: ReadonlySet<string> = new Set([
	// NT AUTHORITY\SYSTEM
	"S-1-5-18",
	// BUILTIN\Administrators
	"S-1-5-32-544",
	// CREATOR OWNER
	"S-1-3-0",
]);

export type SessionOwnerErrorCode =
	| "invalid-state-directory"
	| "owner-busy"
	| "owner-unavailable"
	| "ownership-lost";

const ERROR_MESSAGES: Readonly<Record<SessionOwnerErrorCode, string>> = Object.freeze({
	"invalid-state-directory": "The session state directory is invalid or not private.",
	"owner-busy": "Another session owner holds the local lock.",
	"owner-unavailable": "The local session lock is unavailable.",
	"ownership-lost": "The local session lock ownership could not be verified.",
});

/** Fixed, redacted error: no path, nonce, PID, or cause is retained. */
export class SessionOwnerError extends Error {
	readonly code: SessionOwnerErrorCode;

	constructor(code: SessionOwnerErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "SessionOwnerError";
		this.code = code;
	}
}

export interface AcquireSessionOwnerOptions {
	/** Explicit absolute path; the caller owns its lifecycle and privacy setup. */
	readonly stateDirectory: string;
}

export interface SessionOwner {
	/**
	 * Releases this owner's lease. Idempotent only after this exact owner has
	 * released successfully; a failed verification keeps the lock and fails
	 * closed.
	 */
	release(): Promise<void>;
}

interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly birthtimeMs: bigint;
}

interface WindowsAce {
	readonly sid: string | null;
	readonly allow: boolean;
}

interface WindowsAcl {
	readonly owner: string;
	readonly current: string;
	readonly aces: readonly WindowsAce[];
}

/**
 * Acquires the fixed lock directory under an explicit, private, absolute
 * state directory. The returned lease must be held for the whole controller
 * lifetime and released at shutdown.
 */
export async function acquireSessionOwner(
	options: AcquireSessionOwnerOptions,
): Promise<SessionOwner> {
	const stateDirectory = validateStateDirectory(options);
	await ensurePrivateStateDirectory(stateDirectory);

	const lockDirectory = join(stateDirectory, LOCK_DIRECTORY_NAME);
	try {
		await mkdir(lockDirectory, { mode: 0o700 });
	} catch (error) {
		if (isErrorCode(error, "EEXIST")) throw new SessionOwnerError("owner-busy");
		throw new SessionOwnerError("owner-unavailable");
	}

	let directoryIdentity: FileIdentity;
	try {
		const stats = await lstat(lockDirectory, { bigint: true });
		if (!stats.isDirectory() || stats.isSymbolicLink() || stats.ino === 0n) {
			throw new SessionOwnerError("owner-unavailable");
		}
		assertPosixPrivateMode(stats, "owner-unavailable");
		directoryIdentity = identityFrom(stats);
	} catch (error) {
		throw lockFailure(error);
	}

	const nonce = randomBytes(32).toString("hex");
	const noncePath = join(lockDirectory, NONCE_FILE_NAME);
	try {
		const handle = await open(noncePath, "wx", 0o600);
		try {
			await handle.writeFile(nonce, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		// The newly created lock directory is retained. A partially written
		// nonce or an unexpected entry must fail closed for manual recovery;
		// this module never deletes an unverified path.
		throw lockFailure(error);
	}

	try {
		const nonceStats = await lstat(noncePath, { bigint: true });
		if (
			!nonceStats.isFile() ||
			nonceStats.isSymbolicLink() ||
			nonceStats.nlink !== 1n ||
			nonceStats.size !== BigInt(NONCE_TEXT_LENGTH) ||
			nonceStats.ino === 0n
		) {
			throw new SessionOwnerError("owner-unavailable");
		}
		assertPosixPrivateMode(nonceStats, "owner-unavailable");
		const nonceIdentity = identityFrom(nonceStats);

		const directoryAfter = await lstat(lockDirectory, { bigint: true });
		if (!directoryAfter.isDirectory() || !sameIdentity(directoryIdentity, directoryAfter)) {
			throw new SessionOwnerError("owner-unavailable");
		}
		const entries = await readdir(lockDirectory);
		if (entries.length !== 1 || entries[0] !== NONCE_FILE_NAME) {
			throw new SessionOwnerError("owner-unavailable");
		}

		return new LocalSessionOwner(
			lockDirectory,
			directoryIdentity,
			noncePath,
			nonceIdentity,
			nonce,
		);
	} catch (error) {
		throw lockFailure(error);
	}
}

class LocalSessionOwner implements SessionOwner {
	private released = false;
	private tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly lockDirectory: string,
		private readonly directoryIdentity: FileIdentity,
		private readonly noncePath: string,
		private readonly nonceIdentity: FileIdentity,
		private readonly nonceText: string,
	) {}

	release(): Promise<void> {
		const current = this.tail.then(
			() => this.releaseOnce(),
			() => this.releaseOnce(),
		);
		this.tail = current.then(
			() => undefined,
			() => undefined,
		);
		return current;
	}

	private async releaseOnce(): Promise<void> {
		if (this.released) return;

		// Every verification failure is ownership-lost. The lock is retained
		// exactly as found; there is no best-effort delete and no retry policy.
		let directoryNow;
		try {
			directoryNow = await lstat(this.lockDirectory, { bigint: true });
		} catch {
			throw new SessionOwnerError("ownership-lost");
		}
		if (
			!directoryNow.isDirectory() ||
			directoryNow.isSymbolicLink() ||
			!sameIdentity(this.directoryIdentity, directoryNow)
		) {
			throw new SessionOwnerError("ownership-lost");
		}

		let entries: string[];
		try {
			entries = await readdir(this.lockDirectory);
		} catch {
			throw new SessionOwnerError("ownership-lost");
		}
		if (entries.length !== 1 || entries[0] !== NONCE_FILE_NAME) {
			throw new SessionOwnerError("ownership-lost");
		}

		let nonceNow;
		try {
			nonceNow = await lstat(this.noncePath, { bigint: true });
		} catch {
			throw new SessionOwnerError("ownership-lost");
		}
		if (
			!nonceNow.isFile() ||
			nonceNow.isSymbolicLink() ||
			nonceNow.nlink !== 1n ||
			nonceNow.size !== BigInt(NONCE_TEXT_LENGTH) ||
			!sameIdentity(this.nonceIdentity, nonceNow)
		) {
			throw new SessionOwnerError("ownership-lost");
		}

		let observedNonce: string;
		try {
			const handle = await open(
				this.noncePath,
				fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
			);
			try {
				const openedStats = await handle.stat({ bigint: true });
				if (
					!openedStats.isFile() ||
					openedStats.nlink !== 1n ||
					openedStats.size !== BigInt(NONCE_TEXT_LENGTH) ||
					!sameIdentity(this.nonceIdentity, openedStats)
				) {
					throw new SessionOwnerError("ownership-lost");
				}
				const buffer = new Uint8Array(NONCE_TEXT_LENGTH + 1);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
				if (bytesRead !== NONCE_TEXT_LENGTH) {
					throw new SessionOwnerError("ownership-lost");
				}
				observedNonce = new TextDecoder("utf-8", { fatal: true }).decode(
					buffer.subarray(0, bytesRead),
				);
			} finally {
				await handle.close();
			}
		} catch (error) {
			throw lockFailure(error);
		}
		if (observedNonce !== this.nonceText) {
			throw new SessionOwnerError("ownership-lost");
		}

		// Re-read both paths after the nonce read so a swapped directory or
		// nonce file cannot be attributed to this lease.
		try {
			const directoryAfterRead = await lstat(this.lockDirectory, { bigint: true });
			const nonceAfterRead = await lstat(this.noncePath, { bigint: true });
			if (
				!sameIdentity(this.directoryIdentity, directoryAfterRead) ||
				!sameIdentity(this.nonceIdentity, nonceAfterRead)
			) {
				throw new SessionOwnerError("ownership-lost");
			}
		} catch (error) {
			throw lockFailure(error);
		}

		try {
			await unlink(this.noncePath);
		} catch {
			throw new SessionOwnerError("ownership-lost");
		}
		try {
			await rmdir(this.lockDirectory);
		} catch {
			// A non-cooperating actor can add an entry after the exact-content
			// check. The directory is retained; no recursive delete is used.
			throw new SessionOwnerError("ownership-lost");
		}
		this.released = true;
	}
}

function validateStateDirectory(options: AcquireSessionOwnerOptions): string {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		throw new SessionOwnerError("invalid-state-directory");
	}
	const input = options.stateDirectory;
	if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
		throw new SessionOwnerError("invalid-state-directory");
	}
	const root = parsePath(input).root;
	if (root.length === 0) throw new SessionOwnerError("invalid-state-directory");
	if (process.platform === "win32") {
		// Require a fully qualified local drive path. UNC/network paths and
		// drive-relative rooted paths are not proven to provide local atomic
		// directory semantics, so they fail closed here.
		if (!/^[A-Za-z]:[\\/]$/.test(root)) {
			throw new SessionOwnerError("invalid-state-directory");
		}
	}
	const resolved = resolve(input);
	if (resolved === parsePath(resolved).root) {
		throw new SessionOwnerError("invalid-state-directory");
	}
	return resolved;
}

async function ensurePrivateStateDirectory(stateDirectory: string): Promise<void> {
	let existed = true;
	try {
		await lstat(stateDirectory);
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) {
			throw new SessionOwnerError("invalid-state-directory");
		}
		existed = false;
	}

	let createdByThisCall = false;
	if (!existed) {
		try {
			await mkdir(stateDirectory, { mode: 0o700 });
			createdByThisCall = true;
		} catch (error) {
			if (!isErrorCode(error, "EEXIST")) {
				throw new SessionOwnerError("invalid-state-directory");
			}
		}
	}

	try {
		const stats = await lstat(stateDirectory, { bigint: true });
		if (!stats.isDirectory() || stats.isSymbolicLink() || stats.ino === 0n) {
			throw new SessionOwnerError("invalid-state-directory");
		}
		await rejectSymlinkAncestors(stateDirectory);
		if (process.platform === "win32") {
			await assertPrivateWindowsAcl(stateDirectory);
		} else {
			assertPosixPrivateDirectory(stats);
		}
	} catch (error) {
		if (createdByThisCall) {
			// Only the empty directory this call just created is removed, and
			// only non-recursively. Anything else is left for manual recovery.
			try {
				await rmdir(stateDirectory);
			} catch {
				// Best-effort removal of our own empty directory only.
			}
		}
		if (error instanceof SessionOwnerError) throw error;
		throw new SessionOwnerError("invalid-state-directory");
	}
}

async function rejectSymlinkAncestors(stateDirectory: string): Promise<void> {
	const chain: string[] = [];
	let current = stateDirectory;
	while (true) {
		chain.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const entry of chain.reverse()) {
		const stats = await lstat(entry, { bigint: true });
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new SessionOwnerError("invalid-state-directory");
		}
	}
}

function assertPosixPrivateDirectory(
	stats: { readonly uid: bigint; readonly mode: bigint },
): void {
	const getuid = process.getuid;
	if (typeof getuid !== "function") {
		throw new SessionOwnerError("invalid-state-directory");
	}
	if (stats.uid !== BigInt(getuid()) || (stats.mode & 0o077n) !== 0n) {
		throw new SessionOwnerError("invalid-state-directory");
	}
}

function assertPosixPrivateMode(
	stats: { readonly mode: bigint },
	code: SessionOwnerErrorCode,
): void {
	if (process.platform !== "win32" && (stats.mode & 0o077n) !== 0n) {
		throw new SessionOwnerError(code);
	}
}

async function assertPrivateWindowsAcl(stateDirectory: string): Promise<void> {
	const acl = await readWindowsAcl(stateDirectory);
	if (acl.owner !== acl.current) {
		throw new SessionOwnerError("invalid-state-directory");
	}
	for (const ace of acl.aces) {
		if (!ace.allow) continue;
		if (
			ace.sid === null ||
			(ace.sid !== acl.current && !ALLOWED_WINDOWS_SIDS.has(ace.sid))
		) {
			throw new SessionOwnerError("invalid-state-directory");
		}
	}
}

/**
 * Reads the exact directory ACL and the current process SID with one fixed
 * PowerShell script. The path is passed through the child environment, never
 * interpolated into script text; only SIDs and booleans cross the boundary.
 */
function readWindowsAcl(stateDirectory: string): Promise<WindowsAcl> {
	const script = [
		"$ErrorActionPreference='Stop'",
		`$p=$env:${ACL_ENVIRONMENT_NAME}`,
		"$acl=Get-Acl -LiteralPath $p",
		"$id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
		"$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
		"$aces=@()",
		"foreach($a in $acl.Access){",
		"  try { $sid=$a.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid=$null }",
		"  $aces += [pscustomobject]@{sid=$sid;allow=($a.AccessControlType -eq 'Allow')}",
		"}",
		"[pscustomobject]@{owner=$owner;current=$id;aces=$aces} | ConvertTo-Json -Depth 4 -Compress",
	].join("\n");

	return new Promise<WindowsAcl>((resolvePromise, rejectPromise) => {
		execFile(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				script,
			],
			{
				env: { ...process.env, [ACL_ENVIRONMENT_NAME]: stateDirectory },
				timeout: 15_000,
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout) => {
				if (error !== null && error !== undefined) {
					rejectPromise(new SessionOwnerError("invalid-state-directory"));
					return;
				}
				try {
					resolvePromise(parseWindowsAcl(stdout));
				} catch {
					rejectPromise(new SessionOwnerError("invalid-state-directory"));
				}
			},
		);
	});
}

function parseWindowsAcl(text: string): WindowsAcl {
	const value: unknown = JSON.parse(text);
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("invalid acl document");
	}
	const record = value as Record<string, unknown>;
	const owner = record.owner;
	const current = record.current;
	if (typeof owner !== "string" || typeof current !== "string") {
		throw new Error("invalid acl owner");
	}
	const rawAces = record.aces;
	const list: unknown[] = Array.isArray(rawAces)
		? rawAces
		: rawAces === null || rawAces === undefined
			? []
			: [rawAces];
	const aces: WindowsAce[] = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error("invalid acl entry");
		}
		const ace = entry as Record<string, unknown>;
		if (typeof ace.allow !== "boolean") throw new Error("invalid acl entry");
		if (ace.sid !== null && typeof ace.sid !== "string") {
			throw new Error("invalid acl entry");
		}
		aces.push({ sid: ace.sid as string | null, allow: ace.allow });
	}
	return { owner, current, aces };
}

function identityFrom(stats: {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly birthtimeMs: bigint;
}): FileIdentity {
	return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs };
}

function sameIdentity(
	expected: FileIdentity,
	actual: {
		readonly dev: bigint;
		readonly ino: bigint;
		readonly birthtimeMs: bigint;
	},
): boolean {
	if (actual.ino === 0n) return false;
	return (
		expected.dev === actual.dev &&
		expected.ino === actual.ino &&
		expected.birthtimeMs === actual.birthtimeMs
	);
}

function isErrorCode(error: unknown, code: string): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		(error as { readonly code?: unknown }).code === code
	);
}

function lockFailure(error: unknown): SessionOwnerError {
	if (error instanceof SessionOwnerError) return error;
	return new SessionOwnerError("owner-unavailable");
}
