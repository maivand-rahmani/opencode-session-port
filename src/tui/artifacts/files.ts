/**
 * Encrypted artifact filesystem adapter (Phase 4, non-visual lane; `fix-56`).
 *
 * Scope and boundaries:
 * - P-15 artifact-path policy only: the default checkpoint directory is
 *   `<projectDirectory>/.sessionport/`, default artifact filenames are
 *   timestamped and Windows-safe, an existing artifact is never overwritten
 *   (path resolution and exclusive creation both fail closed), and an explicit
 *   output path overrides the default with ordinary absolute/relative
 *   resolution. The timestamp format and the `.sessionport` filename extension
 *   are local implementation details — not a file-format, extension, or
 *   compatibility freeze (O-02 remains OPEN).
 * - Bytes only: `writeEncryptedArtifact` stores the already-sealed ciphertext
 *   `ByteSource` exactly as the crypto boundary produced it, and
 *   `readEncryptedArtifact` lazily streams the stored ciphertext back. This
 *   module has no crypto or password interface: it never encrypts, decrypts,
 *   authenticates, stages plaintext, selects profiles/parameters/caps, or
 *   creates temp files. Decryption/authentication stay in the crypto
 *   boundary (`openAndStage`).
 *
 * Filesystem behavior:
 * - `writeEncryptedArtifact` creates the file with flag `"wx"` (exclusive
 *   create). An existing path fails with the original `EEXIST` error and is
 *   never truncated, overwritten, or auto-regenerated; the resolver's
 *   existence check is the early clear failure, and `"wx"` remains the
 *   authoritative race guard. Each write is awaited before the next source
 *   chunk is pulled (natural backpressure) and partial writes are looped to
 *   completion; the return value is the exact number of bytes written.
 * - On any error after the exclusive open — including a source iterator
 *   failure, a write failure, or a close failure — only the partial file this
 *   call created is removed, best-effort, and the original error propagates
 *   unchanged (cleanup failures never replace it). An `EEXIST` from the open
 *   itself performs no cleanup because this call did not create the file.
 * - `resolveCheckpointOutputPath` ensures the default `.sessionport/`
 *   directory exists (recursive mkdir) so the default path works on a fresh
 *   project; explicit override paths are resolved and collision-checked only
 *   (their parent directories are not created). The writer writes at exactly
 *   the given path and never creates directories or temp files.
 * - Windows safety: the generated filename uses only `[A-Za-z0-9._-]` (no
 *   `:` from the UTC timestamp, no reserved device name), and drive-relative
 *   explicit paths (`C:foo`) fail closed instead of silently anchoring to the
 *   per-drive current directory.
 */

/// <reference types="node" />
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import * as path from "node:path";
import type { ByteSource } from "../../core/contracts/index.ts";

/* ------------------------------------------------------------------------- */
/* Errors                                                                    */
/* ------------------------------------------------------------------------- */

/** Stable machine-readable failure codes for artifact path/file handling. */
export type ArtifactFileErrorCode =
	/** The caller supplied an unusable path, timestamp, or option value. */
	| "invalid-request"
	/** The resolved output path already exists; nothing is overwritten. */
	| "path-exists";

/**
 * Fail-closed artifact path/input error. Filesystem and source errors from an
 * in-progress write are never wrapped in this class: they propagate unchanged
 * so failure reporting stays truthful (only the resolver's early collision
 * check and caller-input validation use this type).
 */
export class ArtifactFileError extends Error {
	readonly code: ArtifactFileErrorCode;

	constructor(code: ArtifactFileErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ArtifactFileError";
		this.code = code;
	}
}

/* ------------------------------------------------------------------------- */
/* Path resolution (P-15)                                                    */
/* ------------------------------------------------------------------------- */

/** Default checkpoint directory name under the project directory (P-15). */
const CHECKPOINT_DIRECTORY_NAME = ".sessionport";

/**
 * Default filename shape. Prefix/extension and the UTC timestamp layout are
 * implementation details (P-15/O-08), not a format or compatibility claim.
 */
const CHECKPOINT_FILENAME_PREFIX = "checkpoint-";
const CHECKPOINT_FILENAME_EXTENSION = ".sessionport";

/** Options for `resolveCheckpointOutputPath`. */
export interface ResolveCheckpointOutputPathOptions {
	/** Current project directory; the default checkpoint directory sits beneath it. */
	readonly projectDirectory: string;
	/**
	 * Explicit output-path override (P-15). Absolute paths stay absolute;
	 * relative paths resolve against `projectDirectory`. Omitted → default.
	 */
	readonly explicitPath?: string;
	/** Injectable current time for deterministic default filenames (tests). */
	readonly now?: Date;
}

/**
 * Resolves the exact artifact output path under the P-15 policy and fails
 * clearly (`ArtifactFileError`, code `path-exists`) when the path already
 * exists. The path is never auto-regenerated or suffixed.
 *
 * Default: `<projectDirectory>/.sessionport/checkpoint-<UTC timestamp>.sessionport`
 * (the directory is created if needed). Explicit override: normal absolute/
 * relative resolution only — no extension, timestamp, or safety rewriting.
 * The `.sessionport` extension and timestamp format are implementation
 * details, not compatibility claims.
 */
export async function resolveCheckpointOutputPath(options: ResolveCheckpointOutputPathOptions): Promise<string> {
	const input: unknown = options;
	if (typeof input !== "object" || input === null) {
		throw new ArtifactFileError("invalid-request", "resolveCheckpointOutputPath options must be an object");
	}
	const fields = input as {
		readonly projectDirectory?: unknown;
		readonly explicitPath?: unknown;
		readonly now?: unknown;
	};
	const projectDirectory = requireNonEmptyString(fields.projectDirectory, "projectDirectory");
	const now = fields.now;
	if (now !== undefined && (!(now instanceof Date) || Number.isNaN(now.getTime()))) {
		throw new ArtifactFileError("invalid-request", "now must be a valid Date when provided");
	}

	let resolved: string;
	const explicitPath = fields.explicitPath;
	if (explicitPath !== undefined) {
		const explicit = requireNonEmptyString(explicitPath, "explicitPath");
		rejectDriveRelativePath(explicit);
		resolved = path.isAbsolute(explicit) ? path.resolve(explicit) : path.resolve(projectDirectory, explicit);
	} else {
		const defaultDirectory = path.resolve(projectDirectory, CHECKPOINT_DIRECTORY_NAME);
		resolved = path.join(defaultDirectory, buildDefaultFilename(now ?? new Date()));
		// The default location must be usable on a fresh project; creating the
		// directory is idempotent and creates no file.
		await mkdir(defaultDirectory, { recursive: true });
	}

	await assertPathDoesNotExist(resolved);
	return resolved;
}

/**
 * UTC timestamp formatted with only Windows-safe characters (`:` replaced by
 * `-`, milliseconds included, `Z` suffix). Deterministic for an injected Date.
 */
function buildDefaultFilename(instant: Date): string {
	const pad = (value: number, width: number): string => String(value).padStart(width, "0");
	const date = `${pad(instant.getUTCFullYear(), 4)}-${pad(instant.getUTCMonth() + 1, 2)}-${pad(instant.getUTCDate(), 2)}`;
	const time = `${pad(instant.getUTCHours(), 2)}-${pad(instant.getUTCMinutes(), 2)}-${pad(instant.getUTCSeconds(), 2)}-${pad(instant.getUTCMilliseconds(), 3)}`;
	return `${CHECKPOINT_FILENAME_PREFIX}${date}T${time}Z${CHECKPOINT_FILENAME_EXTENSION}`;
}

/**
 * Fails closed on Windows drive-relative paths (`C:foo`): they are neither
 * absolute nor project-relative, and ordinary resolution would silently
 * anchor them to the per-drive current directory.
 */
function rejectDriveRelativePath(explicitPath: string): void {
	if (process.platform === "win32" && !path.isAbsolute(explicitPath) && path.win32.parse(explicitPath).root.length > 0) {
		throw new ArtifactFileError(
			"invalid-request",
			`explicitPath must be absolute or relative to projectDirectory (drive-relative paths are not supported): ${explicitPath}`,
		);
	}
}

/** Rejects (code `path-exists`) when any directory entry exists at `candidate`. */
async function assertPathDoesNotExist(candidate: string): Promise<void> {
	try {
		// lstat: a dangling symlink is still an existing entry and must not be overwritten.
		await lstat(candidate);
	} catch (error) {
		if (isErrnoCode(error, "ENOENT")) return;
		throw error;
	}
	throw new ArtifactFileError("path-exists", `Refusing to overwrite an existing artifact: ${candidate}`);
}

function isErrnoCode(value: unknown, code: string): boolean {
	return typeof value === "object" && value !== null && (value as { readonly code?: unknown }).code === code;
}

/* ------------------------------------------------------------------------- */
/* Exclusive write / lazy read                                               */
/* ------------------------------------------------------------------------- */

/** Streaming read chunk size; a fixed buffer, not a policy cap (O-03 OPEN). */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Writes the provided already-sealed bytes directly to `targetPath` as an
 * exclusive new file (`"wx"`) and resolves with the exact number of bytes
 * written. Never overwrites an existing path, never creates a temp file, and
 * never accepts crypto/password material.
 *
 * Backpressure: each `FileHandle.write` is awaited before the next source
 * chunk is pulled, and partial writes are looped to completion. On any error
 * after the exclusive open, only the partial file this call created is
 * removed (best-effort); the original error propagates unchanged. The parent
 * directory must already exist (use `resolveCheckpointOutputPath` for the
 * default location).
 */
export async function writeEncryptedArtifact(targetPath: string, source: ByteSource): Promise<number> {
	const pathString = requireNonEmptyString(targetPath, "path");
	// Exclusive create: an existing path fails with the original EEXIST and is
	// never truncated; this open is the authoritative overwrite guard.
	const handle = await open(pathString, "wx");
	let closed = false;
	try {
		let totalBytes = 0;
		for await (const chunk of source) {
			if (chunk.byteLength === 0) continue;
			let offset = 0;
			while (offset < chunk.byteLength) {
				const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
				if (bytesWritten < 1) {
					throw new Error(`artifact write made no progress at byte ${totalBytes + offset}`);
				}
				offset += bytesWritten;
			}
			totalBytes += offset;
		}
		await handle.close();
		closed = true;
		return totalBytes;
	} catch (error) {
		if (!closed) {
			try {
				await handle.close();
			} catch {
				// Best-effort only; the original error below is authoritative.
			}
		}
		try {
			// Only the partial file this call created (exclusive open succeeded).
			await unlink(pathString);
		} catch {
			// Best-effort only; cleanup failures must never replace the original error.
		}
		throw error;
	}
}

/**
 * Lazily streams the stored ciphertext bytes from `targetPath` as fresh
 * chunks. The file is opened only when iteration starts; this function
 * performs no decryption, authentication, plaintext staging, or file
 * creation/deletion. Read and open errors propagate unchanged.
 */
export function readEncryptedArtifact(targetPath: string): ByteSource {
	const pathString = requireNonEmptyString(targetPath, "path");
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
			const handle = await open(pathString, "r");
			try {
				for (;;) {
					const chunk = new Uint8Array(READ_CHUNK_BYTES);
					const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
					if (bytesRead === 0) return;
					yield bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead);
				}
			} finally {
				await handle.close();
			}
		},
	};
}

/* ------------------------------------------------------------------------- */
/* Small validation helpers                                                  */
/* ------------------------------------------------------------------------- */

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ArtifactFileError("invalid-request", `${label} must be a non-empty string`);
	}
	return value;
}
