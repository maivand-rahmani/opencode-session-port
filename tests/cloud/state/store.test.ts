/**
 * Local encrypted state/outbox tests (SYNC_PROTOCOL section 8).
 *
 * TEST-ONLY: the injected codec uses a clearly-labelled experimental test
 * policy over the existing provisional container. No production crypto policy,
 * vault binding, or on-disk format is selected or claimed here.
 *
 * All directories are isolated under the approved temp root and removed after
 * each test. No real vault, credential, host session, or product state path is
 * touched.
 *
 * Durability scope: these tests cover normal process close/reopen and simulated
 * atomic failure paths. They do NOT establish OS-crash/power-loss durability;
 * no directory fsync exists, and Windows rename power-loss behavior is
 * unverified. Test names/assertions avoid claiming it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSessionOwner, SessionOwnerError } from "../../../src/cloud/auth/session-owner.ts";
import {
	type AuthenticatedStateCodec,
	StateStore,
	StateStoreError,
	type StateStoreConfig,
	type StateStoreErrorCode,
} from "../../../src/cloud/state/index.ts";
import {
	createTestKeyHolder,
	createTestStateCodec,
	sealRawState,
	testStateKey,
} from "./fixtures/test-codec.ts";
import {
	createPrivateDirectoryAt,
	removeSyntheticRoot,
	SYNTHETIC_TEMP_ROOT,
	trackRoot,
} from "../../helpers/private-state-directory.ts";

const TEST_ROOT = SYNTHETIC_TEMP_ROOT;
const SNAPSHOT_FILE = "state.enc";
const CHILD_FIXTURE = fileURLToPath(
	new URL("../auth/fixtures/session-owner-child.ts", import.meta.url),
);

const roots = new Set<string>();
const stores = new Set<StateStore>();
const children = new Set<ReturnType<typeof Bun.spawn>>();

function rememberRoot(root: string): string {
	const resolved = trackRoot(root);
	roots.add(resolved);
	return resolved;
}

interface StoreFixture {
	readonly root: string;
	readonly stateDirectory: string;
	readonly codec: AuthenticatedStateCodec;
	readonly key: Uint8Array;
	readonly holder: ReturnType<typeof createTestKeyHolder>;
	readonly config: StateStoreConfig;
	readonly snapshotPath: string;
}

async function fixture(label: string, hooks?: StateStoreConfig["testHooks"]): Promise<StoreFixture> {
	const root = rememberRoot(join(TEST_ROOT, `state-${label}-${randomUUID()}`));
	const stateDirectory = await createPrivateDirectoryAt(join(root, "state"));
	const codec = await createTestStateCodec();
	const key = testStateKey(7);
	const holder = createTestKeyHolder(key);
	const config: StateStoreConfig = {
		stateDirectory,
		snapshotFileName: SNAPSHOT_FILE,
		hostScope: "host-instance-test-1",
		stateKey: holder.provider,
		codec,
		maxSnapshotBytes: 8 * 1024 * 1024,
		...(hooks === undefined ? {} : { testHooks: hooks }),
	};
	return {
		root,
		stateDirectory,
		codec,
		key,
		holder,
		config,
		snapshotPath: join(stateDirectory, SNAPSHOT_FILE),
	};
}

async function openStore(fixture: StoreFixture, config: StateStoreConfig = fixture.config): Promise<StateStore> {
	const store = await StateStore.open(config);
	stores.add(store);
	return store;
}

async function rejectCode(action: Promise<unknown>, code: StateStoreErrorCode): Promise<void> {
	try {
		await action;
	} catch (error) {
		expect(error).toBeInstanceOf(StateStoreError);
		expect((error as StateStoreError).code).toBe(code);
		return;
	}
	throw new Error(`expected rejection with ${code}`);
}

interface DeferredCodec {
	readonly codec: AuthenticatedStateCodec;
	readonly entered: Promise<void>;
	release(): void;
	calls(): number;
}

/** Deterministic gate on the Nth codec seal, to force concurrent interleavings. */
function deferredCodec(base: AuthenticatedStateCodec, gateOnCall: number): DeferredCodec {
	let calls = 0;
	let signalEntered!: () => void;
	let releaseGate!: () => void;
	const entered = new Promise<void>((resolveEntered) => {
		signalEntered = resolveEntered;
	});
	const gate = new Promise<void>((resolveGate) => {
		releaseGate = resolveGate;
	});
	return {
		codec: {
			async seal(plaintext, key, context) {
				calls += 1;
				if (calls === gateOnCall) {
					signalEntered();
					await gate;
				}
				return base.seal(plaintext, key, context);
			},
			open: (ciphertext, key, context) => base.open(ciphertext, key, context),
		},
		entered,
		release: () => releaseGate(),
		calls: () => calls,
	};
}

async function stateEntries(directory: string): Promise<string[]> {
	return (await readdir(directory)).sort();
}

async function withoutTemporaryFiles(directory: string): Promise<string[]> {
	return (await stateEntries(directory)).filter((entry) => !entry.endsWith(".tmp"));
}

const encoder = new TextEncoder();

afterEach(async () => {
	for (const child of children) {
		child.kill();
		await child.exited.catch(() => undefined);
	}
	children.clear();
	for (const store of stores) {
		await store.close().catch(() => undefined);
	}
	stores.clear();
	for (const root of roots) {
		await removeSyntheticRoot(root).catch(() => undefined);
	}
	roots.clear();
});

describe("encrypted local state", () => {
	test("process restart reopens exact statuses, cursor, and persisted ciphertext", async () => {
		const fx = await fixture("restart");
		const store = await openStore(fx);

		const local = await store.createLocalOperation({
			operationID: "op-local",
			revisionID: "rev-local",
			parentRevisionID: null,
			plaintext: encoder.encode("plaintext-marker-alpha"),
		});
		expect(local.status).toBe("encrypted");
		expect(await readFile(fx.snapshotPath)).toBeDefined();

		await store.recordStagingReservation("op-local", "upload-1");
		const reserved = store.getOperation("op-local");
		expect(reserved.status).toBe("reserved");
		expect(reserved.uploadID).toBe("upload-1");

		// Retry after reservation expiry: new upload ID, exact same ciphertext.
		await store.recordStagingReservation("op-local", "upload-2");
		const retried = store.getOperation("op-local");
		expect(retried.uploadID).toBe("upload-2");
		expect(Buffer.from(retried.ciphertext).equals(Buffer.from(reserved.ciphertext))).toBe(true);

		const fetched = Uint8Array.from({ length: 64 }, (_unused, index) => (index * 7 + 3) % 256);
		await store.commitFetchedPage({
			cursor: "cursor-1",
			revisions: [
				{
					operationID: "op-remote",
					revisionID: "rev-remote",
					parentRevisionID: "rev-parent",
					ciphertext: fetched,
				},
			],
		});
		expect(store.snapshot().cursor).toBe("cursor-1");
		expect(store.snapshot().applyWatermark).toBeNull();

		const rawBeforeClose = await readFile(fx.snapshotPath);
		await store.close();
		expect(() => store.snapshot()).toThrow(StateStoreError);

		const reopened = await openStore(fx);
		const view = reopened.snapshot();
		expect(view.cursor).toBe("cursor-1");
		expect(view.applyWatermark).toBeNull();
		expect(view.operations.map((operation) => operation.status)).toEqual([
			"reserved",
			"downloaded",
		]);
		expect(Buffer.from(reopened.getOperation("op-local").ciphertext).equals(Buffer.from(reserved.ciphertext))).toBe(true);
		expect(Buffer.from(reopened.getOperation("op-remote").ciphertext).equals(Buffer.from(fetched))).toBe(true);

		// Ciphertext-only file: no plaintext marker, IDs, or JSON at rest.
		const rawText = rawBeforeClose.toString("latin1");
		expect(rawText.includes("plaintext-marker-alpha")).toBe(false);
		expect(rawText.includes("op-local")).toBe(false);
		expect(rawText.includes("cursor-1")).toBe(false);
	});

	test("wrong key and corruption fail closed without mutation or fallback", async () => {
		const fx = await fixture("wrong-key");
		const store = await openStore(fx);
		await store.createLocalOperation({
			operationID: "op-1",
			revisionID: "rev-1",
			parentRevisionID: null,
			plaintext: encoder.encode("stable-state"),
		});
		await store.close();
		const untouched = await readFile(fx.snapshotPath);

		fx.holder.setKey(testStateKey(9));
		await rejectCode(StateStore.open(fx.config), "state-corrupt");
		expect(Buffer.from(await readFile(fx.snapshotPath)).equals(Buffer.from(untouched))).toBe(true);
		expect(await withoutTemporaryFiles(fx.stateDirectory)).toEqual([SNAPSHOT_FILE]);

		// Corruption is rejected, not repaired or replaced.
		await writeFile(fx.snapshotPath, untouched.subarray(0, untouched.length - 7));
		fx.holder.setKey(fx.key);
		await rejectCode(StateStore.open(fx.config), "state-corrupt");
		expect((await readFile(fx.snapshotPath)).length).toBe(untouched.length - 7);

		await writeFile(fx.snapshotPath, untouched);
		const recovered = await openStore(fx);
		expect(recovered.getOperation("op-1").status).toBe("encrypted");
	});

	test("pre-rename interruption keeps the old snapshot; post-rename failure is fail-closed", async () => {
		const fx = await fixture("atomic");
		let failBefore = false;
		const hooked = await openStore(fx, {
			...fx.config,
			testHooks: {
				async beforeRename() {
					if (failBefore) {
						failBefore = false;
						throw new Error("simulated interruption before rename");
					}
				},
			},
		});
		await hooked.createLocalOperation({
			operationID: "op-1",
			revisionID: "rev-1",
			parentRevisionID: null,
			plaintext: encoder.encode("first"),
		});

		failBefore = true;
		await rejectCode(
			hooked.createLocalOperation({
				operationID: "op-2",
				revisionID: "rev-2",
				parentRevisionID: null,
				plaintext: encoder.encode("second"),
			}),
			"write-failed",
		);
		expect(hooked.snapshot().operations.map((operation) => operation.operationID)).toEqual(["op-1"]);
		expect((await stateEntries(fx.stateDirectory)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
		await hooked.close();

		const afterCrash = await openStore(fx);
		expect(afterCrash.snapshot().operations.map((operation) => operation.operationID)).toEqual(["op-1"]);
		await afterCrash.close();
	});

	test("post-rename uncertainty is fail-closed; renamed snapshot is visible to a process restart only (power-loss durability unproven)", async () => {
		const fx = await fixture("uncertain");
		let failAfter = false;
		const store = await openStore(fx, {
			...fx.config,
			testHooks: {
				async afterRename() {
					if (failAfter) {
						failAfter = false;
						throw new Error("simulated loss after rename");
					}
				},
			},
		});
		await store.createLocalOperation({
			operationID: "op-1",
			revisionID: "rev-1",
			parentRevisionID: null,
			plaintext: encoder.encode("first"),
		});
		failAfter = true;
		await rejectCode(
			store.createLocalOperation({
				operationID: "op-2",
				revisionID: "rev-2",
				parentRevisionID: null,
				plaintext: encoder.encode("second"),
			}),
			"write-outcome-uncertain",
		);
		expect(store.closed).toBe(true);
		expect(() => store.snapshot()).toThrow(StateStoreError);
		await store.close();

		const reopened = await openStore(fx);
		expect(reopened.snapshot().operations.map((operation) => operation.operationID).sort()).toEqual([
			"op-1",
			"op-2",
		]);
	});

	test("separate-process and in-process lock contention fail closed", async () => {
		const fx = await fixture("lock");

		const owner = await acquireSessionOwner({ stateDirectory: fx.stateDirectory });
		await rejectCode(StateStore.open(fx.config), "owner-busy");
		await owner.release();
		await (await openStore(fx)).close();

		const child = Bun.spawn(
			[process.execPath, CHILD_FIXTURE, "--state-directory", fx.stateDirectory, "--mode", "hold"],
			{ cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		children.add(child);
		const reader = child.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value).trim()).toBe("ACQUIRED");

		await rejectCode(StateStore.open(fx.config), "owner-busy");
		child.stdin.end();
		await child.exited;
		children.delete(child);

		await (await openStore(fx)).close();
	});

	test("only documented transitions are accepted; native apply advances the watermark", async () => {
		const fx = await fixture("transitions");
		const store = await openStore(fx);
		await store.createLocalOperation({
			operationID: "op-1",
			revisionID: "rev-1",
			parentRevisionID: null,
			plaintext: encoder.encode("one"),
		});
		await rejectCode(store.transition("op-1", "uploaded"), "invalid-transition");
		await store.recordStagingReservation("op-1", "upload-1");
		await rejectCode(store.transition("op-1", "reserved"), "invalid-transition");
		await store.transition("op-1", "uploaded");
		await store.transition("op-1", "committed");
		await store.transition("op-1", "downloaded");

		const remoteCiphertext = Uint8Array.from([9, 8, 7, 6, 5]);
		await store.commitFetchedPage({
			cursor: "cursor-a",
			revisions: [
				{
					operationID: "op-2",
					revisionID: "rev-2",
					parentRevisionID: "rev-1",
					ciphertext: remoteCiphertext,
				},
			],
		});
		await store.beginNativeApply("op-2", encoder.encode("opaque-candidate-payload"));
		expect(store.snapshot().nativeApply.state).toBe("candidate");
		expect(store.snapshot().applyWatermark).toBeNull();
		expect(store.snapshot().cursor).toBe("cursor-a");
		await rejectCode(store.transition("op-2", "applied"), "invalid-transition");
		await rejectCode(store.transition("op-2", "host-update-blocked"), "invalid-transition");
		await store.confirmNativeApply("op-2");
		expect(store.getOperation("op-2").status).toBe("applied");
		expect(store.snapshot().applyWatermark).toBe("rev-2");
		expect(store.snapshot().cursor).toBe("cursor-a");
		await rejectCode(store.transition("op-2", "host-update-blocked"), "invalid-transition");

		await store.commitFetchedPage({
			cursor: "cursor-b",
			revisions: [
				{
					operationID: "op-3",
					revisionID: "rev-3",
					parentRevisionID: "rev-2",
					ciphertext: Uint8Array.from([4, 4, 4]),
				},
			],
		});
		await store.blockHostUpdate("op-3");
		expect(store.getOperation("op-3").status).toBe("host-update-blocked");
		expect(store.snapshot().applyWatermark).toBe("rev-2");
		expect(store.snapshot().cursor).toBe("cursor-b");

		await rejectCode(
			store.createLocalOperation({
				operationID: "op-3",
				revisionID: "rev-new",
				parentRevisionID: null,
				plaintext: encoder.encode("duplicate"),
			}),
			"duplicate-operation",
		);
	});

	test("cursor and apply watermark are separate; a page commits atomically", async () => {
		const fx = await fixture("cursor-watermark");
		const store = await openStore(fx);
		const before = await stateEntries(fx.stateDirectory);
		expect(before).toEqual(["session-owner.lock"]);

		await store.commitFetchedPage({
			cursor: "cursor-1",
			revisions: [
				{
					operationID: "op-a",
					revisionID: "rev-a",
					parentRevisionID: null,
					ciphertext: Uint8Array.from([1, 2, 3]),
				},
			],
		});
		expect(store.snapshot().cursor).toBe("cursor-1");
		expect(store.snapshot().applyWatermark).toBeNull();
		expect(store.getOperation("op-a").status).toBe("downloaded");

		await store.beginNativeApply("op-a", encoder.encode("payload-a"));
		expect(store.snapshot().cursor).toBe("cursor-1");
		expect(store.snapshot().applyWatermark).toBeNull();
		await store.confirmNativeApply("op-a");
		expect(store.snapshot().cursor).toBe("cursor-1");
		expect(store.snapshot().applyWatermark).toBe("rev-a");

		await store.commitFetchedPage({
			cursor: "cursor-2",
			revisions: [
				{
					operationID: "op-b",
					revisionID: "rev-b",
					parentRevisionID: "rev-a",
					ciphertext: Uint8Array.from([5, 5, 5]),
				},
			],
		});
		expect(store.snapshot().cursor).toBe("cursor-2");
		expect(store.snapshot().applyWatermark).toBe("rev-a");
		await store.close();

		const reopened = await openStore(fx);
		expect(reopened.snapshot().cursor).toBe("cursor-2");
		expect(reopened.snapshot().applyWatermark).toBe("rev-a");
		expect(reopened.snapshot().nativeApply.state).toBe("confirmed");
	});

	test("a crash-left candidate journal becomes ambiguous and never auto-applies", async () => {
		const fx = await fixture("journal");
		const store = await openStore(fx);
		await store.commitFetchedPage({
			cursor: "cursor-j",
			revisions: [
				{
					operationID: "op-j",
					revisionID: "rev-j",
					parentRevisionID: null,
					ciphertext: Uint8Array.from([2, 2, 2, 2]),
				},
			],
		});
		await store.beginNativeApply("op-j", encoder.encode("opaque-native-map"));
		await store.close();

		const recovered = await openStore(fx);
		const view = recovered.snapshot();
		expect(view.nativeApply.state).toBe("ambiguous");
		expect(recovered.getOperation("op-j").status).toBe("apply-pending");
		expect(view.applyWatermark).toBeNull();
		expect(Buffer.from(view.nativeApply.payload!).toString()).toBe("opaque-native-map");
		await rejectCode(recovered.transition("op-j", "applied"), "invalid-transition");
		await rejectCode(recovered.blockHostUpdate("op-j"), "invalid-transition");
		await rejectCode(recovered.confirmNativeApply("op-j"), "native-apply-conflict");

		await recovered.resolveAmbiguousNativeApply("op-j", "applied");
		expect(recovered.getOperation("op-j").status).toBe("applied");
		expect(recovered.snapshot().applyWatermark).toBe("rev-j");
		await recovered.close();

		const final = await openStore(fx);
		expect(final.snapshot().nativeApply.state).toBe("confirmed");
		expect(final.getOperation("op-j").status).toBe("applied");
	});

	test("ambiguous resolution can block host update without advancing the watermark", async () => {
		const fx = await fixture("journal-blocked");
		const store = await openStore(fx);
		await store.commitFetchedPage({
			cursor: "cursor-k",
			revisions: [
				{
					operationID: "op-k",
					revisionID: "rev-k",
					parentRevisionID: null,
					ciphertext: Uint8Array.from([3, 3, 3]),
				},
			],
		});
		await store.beginNativeApply("op-k", encoder.encode("payload-k"));
		await store.close();

		const recovered = await openStore(fx);
		await recovered.resolveAmbiguousNativeApply("op-k", "host-update-blocked");
		expect(recovered.getOperation("op-k").status).toBe("host-update-blocked");
		expect(recovered.snapshot().applyWatermark).toBeNull();
		expect(recovered.snapshot().cursor).toBe("cursor-k");
	});

	test("missing ciphertext fails closed and is never resealed", async () => {
		const fx = await fixture("missing-ciphertext");
		const store = await openStore(fx);
		await rejectCode(
			store.commitFetchedPage({
				cursor: "cursor-loss",
				revisions: [
					{
						operationID: "op-loss",
						revisionID: "rev-loss",
						parentRevisionID: null,
						ciphertext: new Uint8Array(0),
					},
				],
			}),
			"missing-ciphertext",
		);
		expect(store.snapshot().cursor).toBeNull();
		expect(() => store.getOperation("op-loss")).toThrow(StateStoreError);
		await store.close();
		expect(await withoutTemporaryFiles(fx.stateDirectory)).toEqual([]);

		const rawState = {
			formatVersion: 1,
			hostScope: fx.config.hostScope,
			cursor: "cursor-loss",
			applyWatermark: null,
			operations: [
				{
					operationID: "op-loss",
					revisionID: "rev-loss",
					parentRevisionID: null,
					status: "downloaded",
					uploadID: null,
					ciphertext: "",
				},
			],
			nativeApply: { state: "none", operationID: null, revisionID: null, payload: null },
		};
		const sealed = await sealRawState(fx.codec, fx.key, rawState, fx.config.hostScope);
		await writeFile(fx.snapshotPath, sealed);
		const untouched = await readFile(fx.snapshotPath);
		await rejectCode(StateStore.open(fx.config), "missing-ciphertext");
		expect(Buffer.from(await readFile(fx.snapshotPath)).equals(Buffer.from(untouched))).toBe(true);
	});

	test("absent state key and mismatched host scope refuse access", async () => {
		const fx = await fixture("keys");
		fx.holder.setKey(null);
		const keyless = await openStore(fx);
		await rejectCode(
			keyless.createLocalOperation({
				operationID: "op-key",
				revisionID: "rev-key",
				parentRevisionID: null,
				plaintext: encoder.encode("needs-key"),
			}),
			"state-key-unavailable",
		);
		expect(await withoutTemporaryFiles(fx.stateDirectory)).toEqual(["session-owner.lock"]);
		await keyless.close();
		expect(await withoutTemporaryFiles(fx.stateDirectory)).toEqual([]);

		fx.holder.setKey(fx.key);
		const store = await openStore(fx);
		await store.createLocalOperation({
			operationID: "op-key",
			revisionID: "rev-key",
			parentRevisionID: null,
			plaintext: encoder.encode("needs-key"),
		});
		await store.close();
		const before = await readFile(fx.snapshotPath);

		fx.holder.setKey(null);
		await rejectCode(StateStore.open(fx.config), "state-key-unavailable");
		expect(Buffer.from(await readFile(fx.snapshotPath)).equals(Buffer.from(before))).toBe(true);

		fx.holder.setKey(fx.key);
		const rawState = {
			formatVersion: 1,
			hostScope: "another-host-instance",
			cursor: null,
			applyWatermark: null,
			operations: [],
			nativeApply: { state: "none", operationID: null, revisionID: null, payload: null },
		};
		const sealed = await sealRawState(fx.codec, fx.key, rawState, fx.config.hostScope);
		await writeFile(fx.snapshotPath, sealed);
		const untouched = await readFile(fx.snapshotPath);
		await rejectCode(StateStore.open(fx.config), "state-scope-mismatch");
		expect(Buffer.from(await readFile(fx.snapshotPath)).equals(Buffer.from(untouched))).toBe(true);
	});

	test("serialized creates survive process restart instead of losing the earlier snapshot", async () => {
		const fx = await fixture("concurrent-create");
		const gate = deferredCodec(fx.codec, 1);
		const store = await openStore(fx, { ...fx.config, codec: gate.codec });

		const first = store.createLocalOperation({
			operationID: "op-first",
			revisionID: "rev-first",
			parentRevisionID: null,
			plaintext: encoder.encode("first"),
		});
		await gate.entered;
		const second = store.createLocalOperation({
			operationID: "op-second",
			revisionID: "rev-second",
			parentRevisionID: null,
			plaintext: encoder.encode("second"),
		});
		expect(gate.calls()).toBe(1);
		gate.release();
		await Promise.all([first, second]);
		expect(store.snapshot().operations.map((operation) => operation.operationID)).toEqual([
			"op-first",
			"op-second",
		]);
		await store.close();

		const reopened = await openStore(fx);
		expect(reopened.snapshot().operations.map((operation) => operation.operationID).sort()).toEqual([
			"op-first",
			"op-second",
		]);
	});

	test("duplicate concurrent creates: exactly one succeeds", async () => {
		const fx = await fixture("concurrent-duplicate");
		const gate = deferredCodec(fx.codec, 1);
		const store = await openStore(fx, { ...fx.config, codec: gate.codec });

		const first = store.createLocalOperation({
			operationID: "op-same",
			revisionID: "rev-same",
			parentRevisionID: null,
			plaintext: encoder.encode("first"),
		});
		await gate.entered;
		const second = store.createLocalOperation({
			operationID: "op-same",
			revisionID: "rev-same",
			parentRevisionID: null,
			plaintext: encoder.encode("second"),
		});
		gate.release();
		const results = await Promise.allSettled([first, second]);
		expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(StateStoreError);
		expect(((rejected as PromiseRejectedResult).reason as StateStoreError).code).toBe(
			"duplicate-operation",
		);
		await store.close();

		const reopened = await openStore(fx);
		expect(reopened.snapshot().operations.length).toBe(1);
	});

	test("cursor page commit and status transition serialize without loss", async () => {
		const fx = await fixture("concurrent-page");
		const gate = deferredCodec(fx.codec, 4);
		const store = await openStore(fx, { ...fx.config, codec: gate.codec });
		await store.createLocalOperation({
			operationID: "op-local",
			revisionID: "rev-local",
			parentRevisionID: null,
			plaintext: encoder.encode("local"),
		});
		await store.recordStagingReservation("op-local", "upload-1");

		const page = store.commitFetchedPage({
			cursor: "cursor-page",
			revisions: [
				{
					operationID: "op-page",
					revisionID: "rev-page",
					parentRevisionID: null,
					ciphertext: Uint8Array.from([7, 7, 7]),
				},
			],
		});
		await gate.entered;
		const transition = store.transition("op-local", "uploaded");
		expect(gate.calls()).toBe(4);
		gate.release();
		await Promise.all([page, transition]);
		expect(store.snapshot().cursor).toBe("cursor-page");
		expect(store.getOperation("op-local").status).toBe("uploaded");
		await store.close();

		const reopened = await openStore(fx);
		expect(reopened.snapshot().cursor).toBe("cursor-page");
		expect(reopened.getOperation("op-local").status).toBe("uploaded");
		expect(reopened.getOperation("op-page").status).toBe("downloaded");
	});

	test("close waits for accepted writes, rejects new calls, and releases the lease once", async () => {
		const fx = await fixture("close-inflight");
		const gate = deferredCodec(fx.codec, 1);
		const store = await openStore(fx, { ...fx.config, codec: gate.codec });

		const create = store.createLocalOperation({
			operationID: "op-inflight",
			revisionID: "rev-inflight",
			parentRevisionID: null,
			plaintext: encoder.encode("inflight"),
		});
		await gate.entered;
		let closeResolved = false;
		const close = store.close().then(() => {
			closeResolved = true;
		});
		await rejectCode(
			store.createLocalOperation({
				operationID: "op-new",
				revisionID: "rev-new",
				parentRevisionID: null,
				plaintext: encoder.encode("new"),
			}),
			"state-closed",
		);
		await rejectCode(StateStore.open(fx.config), "owner-busy");
		expect(closeResolved).toBe(false);

		gate.release();
		await create;
		await close;
		expect(closeResolved).toBe(true);
		expect(store.closed).toBe(true);
		await rejectCode(
			store.createLocalOperation({
				operationID: "op-after",
				revisionID: "rev-after",
				parentRevisionID: null,
				plaintext: encoder.encode("after"),
			}),
			"state-closed",
		);

		const next = await openStore(fx);
		await next.createLocalOperation({
			operationID: "op-next",
			revisionID: "rev-next",
			parentRevisionID: null,
			plaintext: encoder.encode("next"),
		});
		await next.close();

		const reopened = await openStore(fx);
		expect(reopened.snapshot().operations.map((operation) => operation.operationID).sort()).toEqual([
			"op-inflight",
			"op-next",
		]);
	});

	test("a pre-rename failure does not poison queued work and close still releases the lease", async () => {
		const fx = await fixture("queue-failure");
		let failNextRename = true;
		const store = await openStore(fx, {
			...fx.config,
			testHooks: {
				async beforeRename() {
					if (failNextRename) {
						failNextRename = false;
						throw new Error("simulated pre-rename failure");
					}
				},
			},
		});

		const failed = store.createLocalOperation({
			operationID: "op-failed",
			revisionID: "rev-failed",
			parentRevisionID: null,
			plaintext: encoder.encode("failed"),
		});
		const succeeded = store.createLocalOperation({
			operationID: "op-ok",
			revisionID: "rev-ok",
			parentRevisionID: null,
			plaintext: encoder.encode("ok"),
		});
		await rejectCode(failed, "write-failed");
		await succeeded;
		expect(store.snapshot().operations.map((operation) => operation.operationID)).toEqual(["op-ok"]);
		await store.close();

		const reopened = await openStore(fx);
		expect(reopened.snapshot().operations.map((operation) => operation.operationID)).toEqual(["op-ok"]);
	});

	test("a real uncertainty poisons queued work, yet close still releases the lease", async () => {
		const fx = await fixture("queue-uncertain");
		const store = await openStore(fx, {
			...fx.config,
			testHooks: {
				async afterRename() {
					throw new Error("simulated post-rename uncertainty");
				},
			},
		});

		const first = store.createLocalOperation({
			operationID: "op-doubt",
			revisionID: "rev-doubt",
			parentRevisionID: null,
			plaintext: encoder.encode("doubt"),
		});
		const queued = store.createLocalOperation({
			operationID: "op-later",
			revisionID: "rev-later",
			parentRevisionID: null,
			plaintext: encoder.encode("later"),
		});
		await rejectCode(first, "write-outcome-uncertain");
		await rejectCode(queued, "state-closed");
		expect(store.closed).toBe(true);
		await store.close();

		const reopened = await openStore(fx);
		expect(reopened.snapshot().operations.map((operation) => operation.operationID)).toEqual(["op-doubt"]);
	});

	test("absent snapshot creates the initial key under the lease only once", async () => {
		const fx = await fixture("create-key");
		let currentKey: Uint8Array | null = null;
		let createCalls = 0;
		let ownerBusyDuringCreate = false;
		const provider = {
			async load() {
				return currentKey === null ? null : currentKey.slice();
			},
			async createIfMissing() {
				createCalls += 1;
				let unexpectedOwner: Awaited<ReturnType<typeof acquireSessionOwner>> | null = null;
				try {
					unexpectedOwner = await acquireSessionOwner({ stateDirectory: fx.stateDirectory });
				} catch (error) {
					ownerBusyDuringCreate =
						error instanceof SessionOwnerError && error.code === "owner-busy";
				}
				if (unexpectedOwner !== null) await unexpectedOwner.release();
				currentKey = testStateKey(5);
				return currentKey.slice();
			},
		};

		const store = await openStore(fx, { ...fx.config, stateKey: provider });
		expect(createCalls).toBe(1);
		expect(ownerBusyDuringCreate).toBe(true);
		expect(await withoutTemporaryFiles(fx.stateDirectory)).toEqual(["session-owner.lock"]);
		await store.createLocalOperation({
			operationID: "op-created",
			revisionID: "rev-created",
			parentRevisionID: null,
			plaintext: encoder.encode("created"),
		});
		await store.close();

		const reopened = await openStore(fx, {
			...fx.config,
			stateKey: {
				async load() {
					return currentKey === null ? null : currentKey.slice();
				},
			},
		});
		expect(reopened.snapshot().operations.map((operation) => operation.operationID)).toEqual(["op-created"]);
		expect(createCalls).toBe(1);
	});

	test("existing snapshot never calls createIfMissing when the key is missing or corrupt", async () => {
		const fx = await fixture("existing-no-create");
		const store = await openStore(fx);
		await store.createLocalOperation({
			operationID: "op-existing",
			revisionID: "rev-existing",
			parentRevisionID: null,
			plaintext: encoder.encode("existing"),
		});
		await store.close();
		const before = await readFile(fx.snapshotPath);

		let createCalls = 0;
		const missingKeyProvider = {
			async load() {
				return null;
			},
			async createIfMissing() {
				createCalls += 1;
				return testStateKey(6);
			},
		};
		await rejectCode(
			StateStore.open({ ...fx.config, stateKey: missingKeyProvider }),
			"state-key-unavailable",
		);
		expect(createCalls).toBe(0);
		expect(Buffer.from(await readFile(fx.snapshotPath)).equals(Buffer.from(before))).toBe(true);

		await writeFile(fx.snapshotPath, before.subarray(0, before.length - 5));
		const corruptBefore = await readFile(fx.snapshotPath);
		await rejectCode(
			StateStore.open({
				...fx.config,
				stateKey: {
					async load() {
						return testStateKey(7);
					},
					async createIfMissing() {
						createCalls += 1;
						return testStateKey(8);
					},
				},
			}),
			"state-corrupt",
		);
		expect(createCalls).toBe(0);
		expect(Buffer.from(await readFile(fx.snapshotPath)).equals(Buffer.from(corruptBefore))).toBe(true);
	});

	test("invalid created key or readback fails closed, wipes the buffer, and releases the lease", async () => {
		const invalid = await fixture("create-invalid-key");
		const invalidBuffer = new Uint8Array(31).fill(9);
		await rejectCode(
			StateStore.open({
				...invalid.config,
				stateKey: {
					async load() {
						return null;
					},
					async createIfMissing() {
						return invalidBuffer;
					},
				},
			}),
			"state-key-unavailable",
		);
		expect(Array.from(invalidBuffer).every((byte) => byte === 0)).toBe(true);
		const invalidOwner = await acquireSessionOwner({ stateDirectory: invalid.stateDirectory });
		await invalidOwner.release();
		expect(await withoutTemporaryFiles(invalid.stateDirectory)).toEqual([]);

		const mismatch = await fixture("create-readback-mismatch");
		const createdBuffer = testStateKey(11);
		const secretText = Buffer.from(createdBuffer).toString("hex");
		await rejectCode(
			StateStore.open({
				...mismatch.config,
				stateKey: {
					async load() {
						return testStateKey(12);
					},
					async createIfMissing() {
						return createdBuffer;
					},
				},
			}),
			"state-key-unavailable",
		);
		expect(Array.from(createdBuffer).every((byte) => byte === 0)).toBe(true);
		const mismatchOwner = await acquireSessionOwner({ stateDirectory: mismatch.stateDirectory });
		await mismatchOwner.release();

		const throwing = await fixture("create-throws");
		let caught: unknown;
		try {
			await StateStore.open({
				...throwing.config,
				stateKey: {
					async load() {
						return null;
					},
					async createIfMissing(): Promise<Uint8Array> {
						throw new Error(`provider-secret-${secretText}`);
					},
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(StateStoreError);
		expect((caught as StateStoreError).code).toBe("state-key-unavailable");
		expect((caught as Error).message.includes(secretText)).toBe(false);
		const throwingOwner = await acquireSessionOwner({ stateDirectory: throwing.stateDirectory });
		await throwingOwner.release();
	});
});
