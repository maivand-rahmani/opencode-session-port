/**
 * Production composition tests: openLocalState + selected SPST codec + fake
 * in-memory SecureVault. Real libsodium is used through the production codec.
 *
 * These tests cover process close/reopen and simulated failures only. They do
 * NOT claim OS crash/power-loss durability (no directory fsync).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
	LOCAL_STATE_MAX_SNAPSHOT_BYTES,
	LOCAL_STATE_SNAPSHOT_FILE_NAME,
	openLocalState,
	StateStore,
	StateStoreError,
} from "../../../src/cloud/state/index.ts";
import type { SecureVault, VaultEntry } from "../../../src/cloud/vault/types.ts";

const WINDOWS = process.platform === "win32";
const TEST_ROOT = join(tmpdir(), "opencode");
const roots = new Set<string>();
const stores = new Set<StateStore>();
let cachedWindowsSid: string | undefined;

function trackRoot(root: string): string {
	const resolved = resolve(root);
	if (!resolved.startsWith(`${resolve(TEST_ROOT)}${sep}`)) throw new Error("non-synthetic test root");
	roots.add(resolved);
	return resolved;
}

function currentWindowsSid(): string {
	if (cachedWindowsSid !== undefined) return cachedWindowsSid;
	const result = Bun.spawnSync({
		cmd: ["whoami", "/user", "/fo", "csv", "/nh"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const match = /"(S-1-[^"]+)"/.exec(result.stdout.toString());
	if (result.exitCode !== 0 || match === null) throw new Error("could not read current SID");
	cachedWindowsSid = match[1]!;
	return cachedWindowsSid;
}

function restrictWindowsAcl(directory: string): void {
	const result = Bun.spawnSync({
		cmd: ["icacls", directory, "/inheritance:r", "/grant:r", `*${currentWindowsSid()}:(OI)(CI)F`],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error("icacls failed");
}

async function privateDirectory(path: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	if (WINDOWS) restrictWindowsAcl(path);
	else await chmod(path, 0o700);
	return path;
}

class MemoryVault implements SecureVault {
	readonly values = new Map<string, Uint8Array>();
	writes = 0;
	unavailable = false;

	private key(entry: VaultEntry): string {
		return `${entry.service}\0${entry.account}`;
	}

	async read(entry: VaultEntry): Promise<Uint8Array | null> {
		if (this.unavailable) throw new Error("vault unavailable");
		const value = this.values.get(this.key(entry));
		return value === undefined ? null : value.slice();
	}

	async write(entry: VaultEntry, secret: Uint8Array): Promise<void> {
		this.writes += 1;
		if (this.unavailable) throw new Error("vault unavailable");
		this.values.set(this.key(entry), secret.slice());
	}

	async remove(entry: VaultEntry): Promise<boolean> {
		if (this.unavailable) throw new Error("vault unavailable");
		return this.values.delete(this.key(entry));
	}

	firstStoredKey(): Uint8Array | null {
		for (const value of this.values.values()) return value.slice();
		return null;
	}

	replaceStoredKey(bytes: Uint8Array): void {
		const first = this.values.keys().next();
		if (first.done === true) throw new Error("no stored key");
		this.values.set(first.value, bytes.slice());
	}
}

interface Fixture {
	readonly root: string;
	readonly stateDirectory: string;
	readonly vault: MemoryVault;
	readonly hostScope: string;
	readonly snapshotPath: string;
}

async function fixture(label: string): Promise<Fixture> {
	const root = trackRoot(join(TEST_ROOT, `local-${label}-${randomUUID()}`));
	const stateDirectory = await privateDirectory(join(root, "state"));
	const hostScope = `host-instance-${label}`;
	return {
		root,
		stateDirectory,
		vault: new MemoryVault(),
		hostScope,
		snapshotPath: join(stateDirectory, LOCAL_STATE_SNAPSHOT_FILE_NAME),
	};
}

async function open(fx: Fixture, overrides: Partial<Record<string, unknown>> = {}): Promise<StateStore> {
	const store = await openLocalState({
		stateDirectory: overrides.stateDirectory as string ?? fx.stateDirectory,
		hostScope: overrides.hostScope as string ?? fx.hostScope,
		vault: overrides.vault as SecureVault ?? fx.vault,
	});
	stores.add(store);
	return store;
}

async function rejectCode(action: Promise<unknown>, code: string): Promise<void> {
	try {
		await action;
	} catch (error) {
		expect(error).toBeInstanceOf(StateStoreError);
		expect((error as StateStoreError).code).toBe(code);
		return;
	}
	throw new Error(`expected rejection with ${code}`);
}

const encoder = new TextEncoder();

afterEach(async () => {
	for (const store of stores) await store.close().catch(() => undefined);
	stores.clear();
	for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
	roots.clear();
});

describe("production local state composition", () => {
	test("writes a selected SPST snapshot and reopens with the same vault key", async () => {
		const fx = await fixture("envelope");
		const store = await open(fx);
		expect(store.snapshotFileName).toBe("state.v1.enc");
		expect(store.hostScope).toBe(fx.hostScope);
		expect(store.maxSnapshotBytes).toBe(67_108_909);
		expect(LOCAL_STATE_MAX_SNAPSHOT_BYTES).toBe(67_108_909);
		expect(fx.vault.writes).toBe(1);
		const originalKey = fx.vault.firstStoredKey()!;
		expect(originalKey.length).toBe(32);

		const operation = await store.createLocalOperation({
			operationID: "op-envelope",
			revisionID: "rev-envelope",
			parentRevisionID: null,
			plaintext: encoder.encode("plaintext-marker-never-on-disk"),
		});
		const raw = await readFile(fx.snapshotPath);
		expect(raw.subarray(0, 4).toString("ascii")).toBe("SPST");
		expect(raw[4]).toBe(1);
		const rawText = raw.toString("latin1");
		expect(rawText.includes("plaintext-marker-never-on-disk")).toBe(false);
		expect(rawText.includes("op-envelope")).toBe(false);
		expect(rawText.includes("state.v1.enc")).toBe(false);
		await store.close();

		const reopened = await open(fx);
		expect(fx.vault.writes).toBe(1);
		expect(Buffer.from(fx.vault.firstStoredKey()!).equals(Buffer.from(originalKey))).toBe(true);
		expect(reopened.getOperation("op-envelope").revisionID).toBe("rev-envelope");
		expect(Buffer.from(reopened.getOperation("op-envelope").ciphertext).equals(Buffer.from(operation.ciphertext))).toBe(true);
	});

	test("resume retains stable IDs, exact ciphertext, page cursor, watermark, and journal state", async () => {
		const fx = await fixture("resume");
		const store = await open(fx);
		await store.createLocalOperation({
			operationID: "op-local",
			revisionID: "rev-local",
			parentRevisionID: null,
			plaintext: encoder.encode("local"),
		});
		const before = store.getOperation("op-local");
		await store.recordStagingReservation("op-local", "upload-1");
		await store.recordStagingReservation("op-local", "upload-2");
		const retried = store.getOperation("op-local");
		expect(retried.uploadID).toBe("upload-2");
		expect(Buffer.from(retried.ciphertext).equals(Buffer.from(before.ciphertext))).toBe(true);

		await store.commitFetchedPage({
			cursor: "cursor-resume",
			revisions: [
				{
					operationID: "op-remote",
					revisionID: "rev-remote",
					parentRevisionID: null,
					ciphertext: Uint8Array.from([1, 6, 1, 8]),
				},
			],
		});
		await store.beginNativeApply("op-remote", encoder.encode("opaque-candidate"));
		await store.close();

		const recovered = await open(fx);
		expect(recovered.getOperation("op-remote").status).toBe("apply-pending");
		expect(recovered.snapshot().nativeApply.state).toBe("ambiguous");
		expect(recovered.snapshot().applyWatermark).toBeNull();
		expect(recovered.snapshot().cursor).toBe("cursor-resume");
		expect(Buffer.from(recovered.getOperation("op-remote").ciphertext).equals(Buffer.from([1, 6, 1, 8]))).toBe(true);
		await recovered.resolveAmbiguousNativeApply("op-remote", "applied");
		expect(recovered.snapshot().applyWatermark).toBe("rev-remote");
		await recovered.close();

		const final = await open(fx);
		expect(final.getOperation("op-local").revisionID).toBe("rev-local");
		expect(final.getOperation("op-local").uploadID).toBe("upload-2");
		expect(Buffer.from(final.getOperation("op-local").ciphertext).equals(Buffer.from(before.ciphertext))).toBe(true);
		expect(final.getOperation("op-remote").status).toBe("applied");
		expect(final.snapshot().cursor).toBe("cursor-resume");
		expect(final.snapshot().applyWatermark).toBe("rev-remote");
	});

	test("tamper, wrong scope, wrong key, and missing key fail without overwriting", async () => {
		const fx = await fixture("tamper");
		const store = await open(fx);
		await store.createLocalOperation({
			operationID: "op-safe",
			revisionID: "rev-safe",
			parentRevisionID: null,
			plaintext: encoder.encode("safe"),
		});
		await store.close();
		const original = await readFile(fx.snapshotPath);
		const originalKey = fx.vault.firstStoredKey()!;
		const writesBefore = fx.vault.writes;

		const tampered = Buffer.from(original);
		tampered[tampered.length - 1] ^= 0xff;
		await writeFile(fx.snapshotPath, tampered);
		await rejectCode(open(fx), "state-corrupt");
		expect(Buffer.from(await readFile(fx.snapshotPath)).equals(tampered)).toBe(true);
		expect(Buffer.from(fx.vault.firstStoredKey()!).equals(Buffer.from(originalKey))).toBe(true);

		await writeFile(fx.snapshotPath, original);
		await rejectCode(open(fx, { hostScope: "another-host-scope" }), "state-key-unavailable");
		expect(Buffer.from(await readFile(fx.snapshotPath)).equals(Buffer.from(original))).toBe(true);

		fx.vault.replaceStoredKey(new Uint8Array(32));
		const wrongKey = fx.vault.firstStoredKey()!;
		await rejectCode(open(fx), "state-corrupt");
		expect(Buffer.from(await readFile(fx.snapshotPath)).equals(Buffer.from(original))).toBe(true);
		expect(Buffer.from(fx.vault.firstStoredKey()!).equals(Buffer.from(wrongKey))).toBe(true);

		fx.vault.values.clear();
		await rejectCode(open(fx), "state-key-unavailable");
		expect(fx.vault.writes).toBe(writesBefore);
		expect(Buffer.from(await readFile(fx.snapshotPath)).equals(Buffer.from(original))).toBe(true);
	});

	test("unavailable vault refuses first-key creation and leaves no snapshot", async () => {
		const fx = await fixture("vault-unavailable");
		fx.vault.unavailable = true;
		await rejectCode(open(fx), "state-key-unavailable");
		expect(fx.vault.writes).toBe(0);
		expect(await readdir(fx.stateDirectory)).toEqual([]);
		fx.vault.unavailable = false;
		const store = await open(fx);
		expect(fx.vault.writes).toBe(1);
		expect(store.closed).toBe(false);
	});

	test("strict options reject unknown props and accessors, and fixed name/cap cannot be overridden", async () => {
		const fx = await fixture("options");
		const base = {
			stateDirectory: fx.stateDirectory,
			hostScope: fx.hostScope,
			vault: fx.vault,
		};
		await rejectCode(
			openLocalState({ ...base, snapshotFileName: "other.enc" } as never),
			"invalid-input",
		);
		await rejectCode(
			openLocalState({ ...base, maxSnapshotBytes: 1 } as never),
			"invalid-input",
		);
		const accessor = Object.defineProperty(
			{ stateDirectory: fx.stateDirectory, vault: fx.vault },
			"hostScope",
			{ enumerable: true, get: () => fx.hostScope },
		);
		await rejectCode(openLocalState(accessor as never), "invalid-input");
		await rejectCode(
			openLocalState({ ...base, hostScope: "bad\u0000scope" } as never),
			"invalid-input",
		);
		expect(await readdir(fx.stateDirectory)).toEqual([]);
	});

	test("close waits for accepted production-composed mutations", async () => {
		const fx = await fixture("pending-close");
		const store = await open(fx);
		const first = store.createLocalOperation({
			operationID: "op-pending-1",
			revisionID: "rev-pending-1",
			parentRevisionID: null,
			plaintext: encoder.encode("one"),
		});
		const second = store.createLocalOperation({
			operationID: "op-pending-2",
			revisionID: "rev-pending-2",
			parentRevisionID: null,
			plaintext: encoder.encode("two"),
		});
		const close = store.close();
		await Promise.all([first, second, close]);
		expect(store.closed).toBe(true);

		const reopened = await open(fx);
		expect(reopened.snapshot().operations.map((operation) => operation.operationID).sort()).toEqual([
			"op-pending-1",
			"op-pending-2",
		]);
	});
});
