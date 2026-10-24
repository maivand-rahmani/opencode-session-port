/**
 * Atomic ciphertext-only snapshot commit.
 *
 * The only file this module writes is a unique, caller-owned temporary
 * ciphertext file next to the final snapshot, followed by one rename. The
 * temporary file is created exclusively (`wx`), fsynced, and cleaned up only
 * when this call created it and the rename did not happen. No directory-wide
 * cleanup or plaintext temporary file exists.
 *
 * Durability boundary (confirmed by librarian research): the file fsync +
 * rename sequence supports normal process exit/restart and simulated
 * pre/post-rename failure handling. It is NOT proven durable across OS crash
 * or power loss on Windows: no directory fsync is performed (portable
 * directory sync is undocumented), and Node's rename plus file fsync has no
 * verified Windows power-loss rename guarantee. Do not claim power-loss
 * durability, and do not add a native bridge or new dependency here.
 *
 * On Windows, rename replaces an existing file through Node/libuv
 * (`MoveFileExW` with replace); a pre-rename failure leaves the old snapshot
 * untouched. A post-rename failure is reported as uncertain, never retried
 * with different bytes.
 */
import { randomBytes } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AtomicWriteTestHooks } from "./types.ts";

/** Thrown only after the rename happened but commit durability/identity is unproven. */
export class AtomicWriteUncertainError extends Error {
	constructor() {
		super("The atomic write outcome is uncertain.");
		this.name = "AtomicWriteUncertainError";
	}
}

interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly birthtimeMs: bigint;
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
	return (
		actual.ino !== 0n &&
		expected.dev === actual.dev &&
		expected.ino === actual.ino &&
		expected.birthtimeMs === actual.birthtimeMs
	);
}

/**
 * Writes the provided ciphertext to one unique temporary file, fsyncs it, then
 * renames it over `finalPath`. Returns only after the final identity is
 * verified. An uncertain outcome is surfaced as `AtomicWriteUncertainError`.
 *
 * This is a process-restart visibility guarantee only; see the power-loss
 * durability limitation in the module comment.
 */
export async function writeCiphertextAtomically(
	finalPath: string,
	ciphertext: Uint8Array,
	hooks?: AtomicWriteTestHooks,
): Promise<void> {
	const directory = dirname(finalPath);
	const temporaryPath = join(
		directory,
		`.${basename(finalPath)}.${randomBytes(16).toString("hex")}.tmp`,
	);

	let handle;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
	} catch {
		throw new Error("atomic-write-temporary-unavailable");
	}

	let renamed = false;
	try {
		try {
			await handle.writeFile(ciphertext);
			await handle.sync();
		} finally {
			await handle.close();
		}

		const temporaryStats = await lstat(temporaryPath, { bigint: true });
		if (!temporaryStats.isFile() || temporaryStats.isSymbolicLink() || temporaryStats.nlink !== 1n) {
			throw new Error("atomic-write-temporary-invalid");
		}
		const temporaryIdentity = identityFrom(temporaryStats);

		if (hooks?.beforeRename !== undefined) {
			await hooks.beforeRename(temporaryPath);
		}

		await rename(temporaryPath, finalPath);
		renamed = true;

		const finalStats = await lstat(finalPath, { bigint: true });
		if (!finalStats.isFile() || finalStats.isSymbolicLink() || !sameIdentity(temporaryIdentity, finalStats)) {
			throw new AtomicWriteUncertainError();
		}
		if (hooks?.afterRename !== undefined) {
			await hooks.afterRename(finalPath);
		}
	} catch (error) {
		if (renamed) {
			// Never retry or delete after a successful rename: the committed
			// outcome cannot be proven, so the caller must fail closed.
			throw error instanceof AtomicWriteUncertainError ? error : new AtomicWriteUncertainError();
		}
		// Pre-rename failure: remove only the unique temporary file this call
		// created. The previous snapshot is retained unchanged.
		try {
			await unlink(temporaryPath);
		} catch {
			// Best effort on our own temporary path only.
		}
		throw error;
	}
}
