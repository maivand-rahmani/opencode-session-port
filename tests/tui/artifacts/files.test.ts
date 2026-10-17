/**
 * SessionPort encrypted artifact filesystem adapter tests (Phase 4,
 * non-visual lane; `fix-56`).
 *
 * Synthetic bytes only: no real checkpoint, no crypto/password use, no host
 * calls. Every test creates its own exact temp root (`mkdtemp`) and only
 * those exact roots are removed afterward. These tests validate the P-15 path
 * policy, exclusive no-overwrite behavior, exact byte streaming, and
 * partial-file cleanup on an injected midstream failure; nothing here is a
 * file-format freeze, crypto parameter selection, or runtime/compatibility
 * claim.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	ArtifactFileError,
	readEncryptedArtifact,
	resolveCheckpointOutputPath,
	writeEncryptedArtifact,
} from "../../../src/tui/artifacts/files.ts";

/** Exact temp roots created by this file; nothing else is ever removed. */
const createdRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "sessionport-artifacts-test-"));
	createdRoots.push(root);
	return root;
}

afterAll(async () => {
	for (const root of createdRoots) {
		await rm(root, { recursive: true, force: true });
	}
});

/** Yields the given synthetic chunks in order (including empty chunks). */
async function* byteSource(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
	for (const chunk of chunks) yield chunk;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of source) chunks.push(chunk);
	return chunks;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

/** Deterministic synthetic "ciphertext" bytes; never real key material. */
function syntheticBytes(length: number, seed = 0): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let index = 0; index < length; index += 1) {
		bytes[index] = (seed + index * 31) % 256;
	}
	return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return Buffer.from(a).equals(Buffer.from(b));
}

describe("resolveCheckpointOutputPath (P-15)", () => {
	test("defaults beneath <projectDirectory>/.sessionport with a timestamped Windows-safe filename", async () => {
		const root = await makeTempRoot();
		const resolved = await resolveCheckpointOutputPath({
			projectDirectory: root,
			now: new Date("2026-10-10T12:34:56.789Z"),
		});

		expect(path.dirname(resolved)).toBe(path.join(root, ".sessionport"));
		const name = path.basename(resolved);
		expect(name).toBe("checkpoint-2026-10-10T12-34-56-789Z.sessionport");
		// Windows-safe: only characters legal in a Windows file name, and the
		// generated name can never be a reserved device name (checkpoint- prefix).
		expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
		expect(name).not.toMatch(/[:*?"<>|]/);
		expect((await lstat(path.join(root, ".sessionport"))).isDirectory()).toBe(true);
	});

	test("timestamp is injectable and deterministic; distinct instants produce distinct names", async () => {
		const root = await makeTempRoot();
		const first = await resolveCheckpointOutputPath({
			projectDirectory: root,
			now: new Date("2026-10-10T12:34:56.789Z"),
		});
		const second = await resolveCheckpointOutputPath({
			projectDirectory: root,
			now: new Date("2026-10-10T12:34:56.789Z"),
		});
		const third = await resolveCheckpointOutputPath({
			projectDirectory: root,
			now: new Date("2026-10-10T12:34:56.790Z"),
		});

		expect(first).toBe(second);
		expect(path.basename(third)).not.toBe(path.basename(first));
	});

	test("relative explicitPath resolves against projectDirectory without the default directory", async () => {
		const root = await makeTempRoot();
		const resolved = await resolveCheckpointOutputPath({
			projectDirectory: root,
			explicitPath: path.join("nested", "custom-artifact.bin"),
		});

		expect(resolved).toBe(path.resolve(root, "nested", "custom-artifact.bin"));
	});

	test("absolute explicitPath stays absolute and is never rebased on projectDirectory", async () => {
		const root = await makeTempRoot();
		const other = await makeTempRoot();
		const absoluteTarget = path.join(other, "elsewhere.sessionport");

		const resolved = await resolveCheckpointOutputPath({ projectDirectory: root, explicitPath: absoluteTarget });

		expect(resolved).toBe(absoluteTarget);
	});

	test("existing artifact fails clearly; prior contents are never overwritten", async () => {
		const root = await makeTempRoot();
		const target = path.join(root, "existing.sessionport");
		const prior = syntheticBytes(32, 5);
		await writeFile(target, prior);

		let resolveError: unknown;
		try {
			await resolveCheckpointOutputPath({ projectDirectory: root, explicitPath: "existing.sessionport" });
		} catch (error) {
			resolveError = error;
		}
		expect(resolveError).toBeInstanceOf(ArtifactFileError);
		expect((resolveError as ArtifactFileError).code).toBe("path-exists");

		// The writer's exclusive open is the authoritative guard and preserves
		// the original EEXIST error.
		await expect(writeEncryptedArtifact(target, byteSource([syntheticBytes(8)]))).rejects.toMatchObject({
			code: "EEXIST",
		});

		expect(sameBytes(new Uint8Array(await readFile(target)), prior)).toBe(true);
	});

	test("default-name collision fails instead of auto-regenerating a new name", async () => {
		const root = await makeTempRoot();
		const now = new Date("2026-10-10T12:34:56.789Z");
		const first = await resolveCheckpointOutputPath({ projectDirectory: root, now });
		await writeFile(first, syntheticBytes(4));

		await expect(resolveCheckpointOutputPath({ projectDirectory: root, now })).rejects.toMatchObject({
			code: "path-exists",
		});
	});

	test("rejects empty projectDirectory, empty explicitPath, and an invalid now", async () => {
		const root = await makeTempRoot();
		await expect(resolveCheckpointOutputPath({ projectDirectory: "" })).rejects.toMatchObject({
			code: "invalid-request",
		});
		await expect(
			resolveCheckpointOutputPath({ projectDirectory: root, explicitPath: "" }),
		).rejects.toMatchObject({ code: "invalid-request" });
		await expect(
			resolveCheckpointOutputPath({ projectDirectory: root, now: new Date(Number.NaN) }),
		).rejects.toMatchObject({ code: "invalid-request" });
	});
});

describe("writeEncryptedArtifact / readEncryptedArtifact", () => {
	test("writes already-sealed bytes exactly and streams them back exactly", async () => {
		const root = await makeTempRoot();
		const target = path.join(root, "artifact.sessionport");
		const chunks = [
			syntheticBytes(1, 1),
			new Uint8Array(0),
			syntheticBytes(3, 2),
			syntheticBytes(65_536, 3),
			syntheticBytes(17, 4),
		];
		const expected = concat(chunks);

		const written = await writeEncryptedArtifact(target, byteSource(chunks));
		expect(written).toBe(expected.byteLength);
		expect(sameBytes(new Uint8Array(await readFile(target)), expected)).toBe(true);

		const streamed = concat(await collect(readEncryptedArtifact(target)));
		expect(streamed.byteLength).toBe(expected.byteLength);
		expect(sameBytes(streamed, expected)).toBe(true);

		// The adapter creates exactly the requested file (no temp siblings).
		expect(await readdir(root)).toEqual(["artifact.sessionport"]);
	});

	test("empty sealed source writes an exact zero-byte file and returns 0", async () => {
		const root = await makeTempRoot();
		const target = path.join(root, "empty.sessionport");

		expect(await writeEncryptedArtifact(target, byteSource([]))).toBe(0);
		expect((await readFile(target)).byteLength).toBe(0);
	});

	test("readEncryptedArtifact is lazy: a missing file fails on iteration, not at call time", async () => {
		const root = await makeTempRoot();
		const source = readEncryptedArtifact(path.join(root, "missing.sessionport"));

		await expect(collect(source)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(root)).toEqual([]);
	});

	test("midstream failure removes only its partial file and preserves the original error", async () => {
		const root = await makeTempRoot();
		const target = path.join(root, "partial.sessionport");
		const sibling = path.join(root, "unrelated.bin");
		await writeFile(sibling, syntheticBytes(6, 9));
		const failure = new Error("injected synthetic midstream failure");

		async function* failingSource(): AsyncGenerator<Uint8Array> {
			yield syntheticBytes(4096, 7);
			yield syntheticBytes(7, 8);
			throw failure;
		}

		await expect(writeEncryptedArtifact(target, failingSource())).rejects.toBe(failure);

		// Only the partial file this call created is gone; the sibling survives.
		await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(root)).toEqual(["unrelated.bin"]);
	});

	test("rejects an empty path with invalid-request", async () => {
		await expect(writeEncryptedArtifact("", byteSource([]))).rejects.toMatchObject({ code: "invalid-request" });
		expect(() => readEncryptedArtifact("")).toThrow(ArtifactFileError);
	});
});
