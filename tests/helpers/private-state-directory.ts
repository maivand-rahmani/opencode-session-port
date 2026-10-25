/**
 * Shared synthetic private-directory fixture for the ACL-gated local state and
 * session-owner tests.
 *
 * TEST-ONLY. Every directory is newly created, owned by the current process
 * user, and physically verified before use. Parent directories are never
 * re-ACLed, no broad group is granted, and cleanup removes only the exact
 * tracked root under the synthetic base.
 *
 * Why this exists: the production state lock requires a private state directory
 * (current-user owner, no group/other access on POSIX, and on Windows only the
 * current user, SYSTEM, Administrators, or CREATOR OWNER). The previous test
 * helpers inherited the generic runner temp ACL and granted only the current
 * user, so their fixtures depended on whatever the host temp root happened to
 * look like. This helper instead applies the repository's reviewed private
 * directory ACL (see `scripts/host-probes/command-integration/run-command-integration-probe.ps1`:
 * remove inheritance, then grant the current user, SYSTEM, and Administrators)
 * to a fresh root, and refuses to run when that cannot be established.
 *
 * Windows note: the production ACL reader executes `powershell.exe` (Windows
 * PowerShell 5.1) and autoloads `Get-Acl`. CI runs `bun test` under `pwsh`, so
 * this helper additively ensures the canonical Windows PowerShell 5.1 module
 * and executable paths are present in the inherited environment. It only
 * appends canonical paths; it does not remove entries and does not alter any
 * ACL check.
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export const WINDOWS = process.platform === "win32";

const ACL_GRANT_SIDS = [
	// NT AUTHORITY\SYSTEM
	"S-1-5-18",
	// BUILTIN\Administrators
	"S-1-5-32-544",
] as const;

/** BUILTIN\Users: only ever applied to a deliberately unsafe child fixture. */
const USERS_SID = "S-1-5-32-545";

let cachedWindowsSid: string | undefined;
let cachedWindowsAccountName: string | undefined;

/** `DOMAIN\user` for the current process token (used to read back `icacls`). */
export function currentWindowsAccountName(): string {
	if (!WINDOWS) throw new Error("currentWindowsAccountName is Windows-only");
	if (cachedWindowsAccountName !== undefined) return cachedWindowsAccountName;
	const result = Bun.spawnSync({ cmd: ["whoami"], stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error("private-directory-helper: whoami unavailable");
	const name = result.stdout.toString().trim();
	if (name.length === 0) throw new Error("private-directory-helper: current account not found");
	cachedWindowsAccountName = name;
	return cachedWindowsAccountName;
}

export function currentWindowsSid(): string {
	if (!WINDOWS) throw new Error("currentWindowsSid is Windows-only");
	if (cachedWindowsSid !== undefined) return cachedWindowsSid;
	const result = Bun.spawnSync({
		cmd: ["whoami", "/user", "/fo", "csv", "/nh"],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`private-directory-helper: whoami unavailable (exit ${result.exitCode}): ${bounded(result.stderr)}`,
		);
	}
	const match = /"(S-1-[^"]+)"/.exec(result.stdout.toString());
	if (match === null) throw new Error("private-directory-helper: current SID not found");
	cachedWindowsSid = match[1]!;
	return cachedWindowsSid;
}

/** Deterministic, content-free ACL markup used for before/after comparisons. */
export function windowsAclFingerprint(directory: string): string {
	if (!WINDOWS) throw new Error("windowsAclFingerprint is Windows-only");
	const result = Bun.spawnSync({
		cmd: ["icacls", directory],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`private-directory-helper: icacls read failed (exit ${result.exitCode}): ${bounded(result.stderr)}`,
		);
	}
	const target = resolve(directory);
	const raw = result.stdout.toString();
	const withoutPath = raw.split(target).join("").split(target.toLowerCase()).join("");
	const lines = withoutPath
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(
			(line) => line.length > 0 && !line.toLowerCase().startsWith("successfully processed"),
		);
	return lines.sort().join("|");
}

/** Removes the helper's now-unused locale-dependent group lookup. */

/** Runs a fixed ACL script for one directory; the path crosses via the env. */
function runAclPowerShell(script: string, directory: string): { ok: boolean; stdout: string } {
	const result = Bun.spawnSync({
		cmd: [
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
		],
		env: { ...process.env, PRIVATE_DIRECTORY_PROBE: directory },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`private-directory-helper: Windows PowerShell ACL script failed ` +
				`(exit ${result.exitCode}) stderr=${bounded(result.stderr)}`,
		);
	}
	return { ok: true, stdout: result.stdout.toString().trim() };
}

/** Reads the exact owner SID of a directory (SID only, no names/paths). */
export function windowsAclOwnerSid(directory: string): string {
	if (!WINDOWS) throw new Error("windowsAclOwnerSid is Windows-only");
	const script = [
		"$ErrorActionPreference='Stop'",
		"$acl=Get-Acl -LiteralPath $env:PRIVATE_DIRECTORY_PROBE",
		"$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
	].join("\n");
	const output = runAclPowerShell(script, directory).stdout;
	if (!/^S-1-[0-9-]+$/.test(output)) {
		throw new Error("private-directory-helper: ACL owner SID not found");
	}
	return output;
}

export interface AclEntry {
	readonly sid: string | null;
	readonly allow: boolean;
	/** ACE grants read/list (ReadData/ListDirectory bit). */
	readonly grantsRead: boolean;
}

/**
 * Semantic ACL readback through the same fixed `Get-Acl` child. Only SIDs,
 * access types, and read capability cross the boundary; no names or paths.
 * Total ACE counts are not used because Windows may canonicalize, merge, or
 * drop entries depending on host policy.
 */
export function windowsAclEntries(directory: string): AclEntry[] {
	if (!WINDOWS) throw new Error("windowsAclEntries is Windows-only");
	const script = [
		"$ErrorActionPreference='Stop'",
		"$acl=Get-Acl -LiteralPath $env:PRIVATE_DIRECTORY_PROBE",
		"$out=@()",
		"foreach($a in $acl.Access){",
		"  $sid=$null",
		"  try { $sid=$a.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid=$null }",
		"  $rights=0",
		"  try { $rights=[int]$a.FileSystemRights } catch { $rights=0 }",
		"  $out += [pscustomobject]@{sid=$sid;allow=($a.AccessControlType -eq 'Allow');grantsRead=(($rights -band 1) -eq 1)}",
		"}",
		"$out | ConvertTo-Json -Depth 3 -Compress",
	].join("\n");
	const text = runAclPowerShell(script, directory).stdout;
	if (text.length === 0) return [];
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("private-directory-helper: ACL entries are not valid JSON");
	}
	const list: unknown[] = Array.isArray(value) ? value : value === null ? [] : [value];
	const entries: AclEntry[] = [];
	for (const item of list) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("private-directory-helper: invalid ACL entry");
		}
		const record = item as Record<string, unknown>;
		const sid = record.sid;
		const allow = record.allow;
		const grantsRead = record.grantsRead;
		if (sid !== null && typeof sid !== "string") {
			throw new Error("private-directory-helper: invalid ACL entry SID");
		}
		if (typeof allow !== "boolean" || typeof grantsRead !== "boolean") {
			throw new Error("private-directory-helper: invalid ACL entry flags");
		}
		entries.push({ sid: sid as string | null, allow, grantsRead });
	}
	return entries;
}

/** True when the directory lets BUILTIN\Users read. */
export function hasUsersReadAcl(directory: string): boolean {
	return windowsAclEntries(directory).some(
		(entry) => entry.sid === USERS_SID && entry.allow && entry.grantsRead,
	);
}

/**
 * Sets the owner of a directory this test just created. Used for private test
 * fixtures and, in one regression test, to build a deliberately unsafe
 * Administrators-owned fixture. Never applied to a pre-existing host directory.
 */
export function setWindowsOwner(directory: string, sid = currentWindowsSid()): void {
	if (!WINDOWS) throw new Error("setWindowsOwner is Windows-only");
	const script = [
		"$ErrorActionPreference='Stop'",
		"$acl=Get-Acl -LiteralPath $env:PRIVATE_DIRECTORY_PROBE",
		"$owner=New-Object System.Security.Principal.SecurityIdentifier($env:PRIVATE_DIRECTORY_OWNER)",
		"$acl.SetOwner($owner)",
		"Set-Acl -LiteralPath $env:PRIVATE_DIRECTORY_PROBE -AclObject $acl",
	].join("\n");
	const result = Bun.spawnSync({
		cmd: [
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
		],
		env: { ...process.env, PRIVATE_DIRECTORY_PROBE: directory, PRIVATE_DIRECTORY_OWNER: sid },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`private-directory-helper: set-owner failed (exit ${result.exitCode}): ${bounded(result.stderr)}`,
		);
	}
}

interface PrivateAclOptions {
	/** Adds BUILTIN\Users read; used only by the unsafe-fixture regression test. */
	readonly grantUsersRead?: boolean;
}

let aclToolDiagnostic: string | undefined;

/**
 * Fails the fixture clearly when Windows PowerShell cannot read an ACL, instead
 * of letting the production gate surface an opaque `invalid-state-directory`.
 * The probe mirrors the production dependency (`powershell.exe` + `Get-Acl`);
 * exit code and a bounded stderr/stdout excerpt are retained.
 */
function assertWindowsAclTooling(directory: string): void {
	if (aclToolDiagnostic === "ok") return;
	if (aclToolDiagnostic !== undefined) throw new Error(aclToolDiagnostic);
	const script = [
		"$ErrorActionPreference='Stop'",
		"$acl=Get-Acl -LiteralPath $env:PRIVATE_DIRECTORY_PROBE",
		"[pscustomobject]@{owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value} | ConvertTo-Json -Compress",
	].join("\n");
	const result = Bun.spawnSync({
		cmd: [
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
		],
		env: { ...process.env, PRIVATE_DIRECTORY_PROBE: directory },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		aclToolDiagnostic =
			`private-directory-helper: Windows PowerShell Get-Acl probe failed ` +
			`(exit ${result.exitCode}) stdout=${bounded(result.stdout)} stderr=${bounded(result.stderr)}`;
		throw new Error(aclToolDiagnostic);
	}
	aclToolDiagnostic = "ok";
}

function applyWindowsPrivateAcl(directory: string): void {
	assertWindowsAclTooling(directory);
	const args = [
		directory,
		"/inheritance:r",
		"/grant:r",
		`*${currentWindowsSid()}:(OI)(CI)F`,
		...ACL_GRANT_SIDS.map((sid) => `*${sid}:(OI)(CI)F`),
	];
	const result = Bun.spawnSync({
		cmd: ["icacls", ...args],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`private-directory-helper: icacls failed (exit ${result.exitCode}): ${bounded(result.stderr)}`,
		);
	}
	const fingerprint = windowsAclFingerprint(directory);
	const account = currentWindowsAccountName().toLowerCase();
	if (!fingerprint.toLowerCase().includes(account)) {
		throw new Error(
			`private-directory-helper: current user ACE missing after icacls: ${boundedFingerprint(fingerprint)}`,
		);
	}
}

function boundedFingerprint(value: string): string {
	return value.length <= 200 ? value : `${value.slice(0, 200)}…`;
}

function bounded(value: Uint8Array | undefined): string {
	if (value === undefined) return "";
	return new TextDecoder().decode(value.subarray(0, 200)).replace(/\s+/g, " ").trim();
}

function isAbsoluteLocalPath(value: string): boolean {
	if (!isAbsolute(value)) return false;
	if (!WINDOWS) return true;
	return /^[A-Za-z]:[\\/]$/.test(parse(value).root);
}

function hasReparsePointInChain(path: string): boolean {
	let current = resolve(path);
	while (true) {
		let stats;
		try {
			stats = lstatSync(current);
		} catch {
			return false;
		}
		if (stats.isSymbolicLink()) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/**
 * Controlled synthetic base. `RUNNER_TEMP` is accepted only when it is an
 * existing absolute local-drive directory whose ancestor chain contains no
 * reparse point, so the production symlink-ancestor contract is never bypassed.
 */
function selectSyntheticBase(): string {
	const candidates: string[] = [];
	if (WINDOWS) {
		for (const name of ["RUNNER_TEMP", "TEMP", "TMP"]) {
			const value = process.env[name];
			if (typeof value === "string" && value.length > 0) candidates.push(value);
		}
	}
	candidates.push(tmpdir());
	for (const candidate of candidates) {
		try {
			if (!isAbsoluteLocalPath(candidate)) continue;
			const resolved = resolve(candidate);
			if (hasReparsePointInChain(resolved)) continue;
			const stats = lstatSync(resolved);
			if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
			return resolved;
		} catch {
			continue;
		}
	}
	return resolve(tmpdir());
}

function prependPathEntry(name: string, entry: string): void {
	if (!existsSync(entry)) return;
	let key = name;
	for (const existing of Object.keys(process.env)) {
		if (existing.toLowerCase() === name.toLowerCase()) {
			key = existing;
			break;
		}
	}
	const current = process.env[key];
	if (current === undefined || current.length === 0) {
		process.env[key] = entry;
		return;
	}
	const entries = current.split(";").map((part) => part.toLowerCase());
	if (entries.includes(entry.toLowerCase())) return;
	process.env[key] = `${entry};${current}`;
}

function ensureWindowsPowerShellEnvironment(): void {
	if (!WINDOWS) return;
	const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	const system32 = join(systemRoot, "System32");
	const shellDirectory = join(system32, "WindowsPowerShell", "v1.0");
	prependPathEntry("PATH", shellDirectory);
	prependPathEntry("PATH", system32);
	prependPathEntry("PSModulePath", join(shellDirectory, "Modules"));
}

ensureWindowsPowerShellEnvironment();

/** `<base>/opencode`; every synthetic root must be a strict child of this. */
export const SYNTHETIC_TEMP_ROOT = join(selectSyntheticBase(), "opencode");

export function isSyntheticRoot(path: string): boolean {
	return resolve(path).startsWith(`${resolve(SYNTHETIC_TEMP_ROOT)}${sep}`);
}

export function trackRoot(root: string): string {
	const resolved = resolve(root);
	if (!isSyntheticRoot(resolved)) throw new Error("refusing to track a non-synthetic path");
	return resolved;
}

async function assertPhysicalDirectory(directory: string): Promise<void> {
	const stats = await lstat(directory, { bigint: true });
	if (!stats.isDirectory() || stats.isSymbolicLink() || stats.ino === 0n) {
		throw new Error("private-directory-helper: unexpected non-directory fixture");
	}
}

/**
 * Applies a private ACL to an already-created, newly-owned directory. Never
 * called on a parent or pre-existing host directory.
 */
export async function makePrivate(directory: string, options: PrivateAclOptions = {}): Promise<string> {
	await assertPhysicalDirectory(directory);
	if (WINDOWS) {
		// Claim ownership first: an elevated token can leave a fresh directory
		// owned by Administrators, which the production gate (correctly)
		// refuses. Only freshly created fixtures are re-owned.
		setWindowsOwner(directory);
		if (windowsAclOwnerSid(directory) !== currentWindowsSid()) {
			throw new Error("private-directory-helper: could not establish current-user ownership");
		}
		applyWindowsPrivateAcl(directory);
		if (options.grantUsersRead === true) {
			await grantUsersRead(directory);
			if (!hasUsersReadAcl(directory)) {
				throw new Error("private-directory-helper: unsafe BUILTIN\\Users read grant was not applied");
			}
		}
	} else if (options.grantUsersRead === true) {
		await chmod(directory, 0o755);
	} else {
		await chmod(directory, 0o700);
		const stats = await lstat(directory, { bigint: true });
		const getuid = process.getuid;
		if (typeof getuid !== "function") throw new Error("private-directory-helper: no process uid");
		if (stats.uid !== BigInt(getuid()) || (stats.mode & 0o077n) !== 0n) {
			throw new Error("private-directory-helper: could not establish a POSIX private mode");
		}
	}
	return directory;
}

/**
 * Creates (recursively) `path` and applies the private ACL to the leaf.
 * Intermediate directories are created by this call; only the leaf is re-ACLed,
 * so no pre-existing directory is ever modified.
 */
export async function createPrivateDirectoryAt(path: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	return makePrivate(path);
}

/** Creates a fresh, tracked synthetic root under the controlled base. */
export async function createPrivateRoot(label: string): Promise<string> {
	const root = trackRoot(join(SYNTHETIC_TEMP_ROOT, `${label}-${randomUUID()}`));
	await mkdir(root, { recursive: true, mode: 0o700 });
	return makePrivate(root);
}

/** Creates a fresh private directory inside an existing synthetic root. */
export async function createPrivateDirectory(root: string, name = "state"): Promise<string> {
	const directory = join(trackRoot(root), name);
	return createPrivateDirectoryAt(directory);
}

/**
 * Deliberately unsafe fixture: current-user-owned directory that additionally
 * grants BUILTIN\Users read. Only the leaf is re-ACLed; its parent is untouched.
 */
export async function createUnsafeDirectory(root: string, name = "loose"): Promise<string> {
	const directory = join(trackRoot(root), name);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return makePrivate(directory, { grantUsersRead: true });
}

/** Grants BUILTIN\Users read on a leaf directory only (never a parent). */
export async function grantUsersRead(directory: string): Promise<void> {
	await assertPhysicalDirectory(directory);
	if (WINDOWS) {
		// Some hosts canonicalize grants aggressively; verify the semantic ACE
		// (Users + allow + read) and retry once with the additive form.
		for (const flag of ["/grant:r", "/grant"]) {
			const result = Bun.spawnSync({
				cmd: ["icacls", directory, flag, `*${USERS_SID}:(OI)(CI)R`],
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) {
				throw new Error(
					`private-directory-helper: icacls grant failed (exit ${result.exitCode}): ${bounded(result.stderr)}`,
				);
			}
			if (hasUsersReadAcl(directory)) return;
		}
		throw new Error("private-directory-helper: BUILTIN\\Users read grant did not appear");
	}
	await chmod(directory, 0o755);
}

/** Removes exactly one tracked synthetic root; refuses anything else. */
export async function removeSyntheticRoot(root: string): Promise<void> {
	const resolved = resolve(root);
	if (!isSyntheticRoot(resolved)) throw new Error("refusing non-synthetic cleanup");
	await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}
