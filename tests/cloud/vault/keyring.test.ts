import { describe, expect, test } from "bun:test";
import {
	createKeyringVault,
	type KeyringAsyncEntryConstructor,
	type KeyringEntryOptions,
} from "../../../src/cloud/vault/keyring.ts";
import { VaultError, type VaultErrorCode } from "../../../src/cloud/vault/types.ts";
import { parseProbeArgs, probeEntry, runProbe } from "../../../scripts/vault-probes/keyring/probe.ts";

const ENTRY = { service: "sessionport-test-service", account: "sessionport-test-account" } as const;
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

interface FakeOptions {
	beforeSet?: (call: number) => Promise<void>;
	beforeDelete?: (call: number) => Promise<void>;
	setError?: Error;
	getError?: Error;
	deleteError?: Error;
	setErrorAfterApply?: Error;
	deleteErrorAfterApply?: Error;
	constructionError?: Error;
	getResult?: (key: string) => unknown;
}

class FakeBackend {
	readonly store = new Map<string, Uint8Array>();
	readonly constructed: Array<{ service: string; account: string; options?: KeyringEntryOptions }> = [];
	readonly events: string[] = [];
	setCalls = 0;
	getCalls = 0;
	deleteCalls = 0;
	beforeSet?: (call: number) => Promise<void>;
	beforeDelete?: (call: number) => Promise<void>;
	setError?: Error;
	getError?: Error;
	deleteError?: Error;
	setErrorAfterApply?: Error;
	deleteErrorAfterApply?: Error;
	constructionError?: Error;
	getResult?: (key: string) => unknown;
	readonly AsyncEntry: KeyringAsyncEntryConstructor;

	constructor(options: FakeOptions = {}) {
		this.beforeSet = options.beforeSet;
		this.beforeDelete = options.beforeDelete;
		this.setError = options.setError;
		this.getError = options.getError;
		this.deleteError = options.deleteError;
		this.setErrorAfterApply = options.setErrorAfterApply;
		this.deleteErrorAfterApply = options.deleteErrorAfterApply;
		this.constructionError = options.constructionError;
		this.getResult = options.getResult;
		const backend = this;
		this.AsyncEntry = class {
			private readonly key: string;
			constructor(service: string, account: string, entryOptions?: KeyringEntryOptions) {
				if (backend.constructionError !== undefined) throw backend.constructionError;
				backend.constructed.push({ service, account, options: entryOptions });
				this.key = JSON.stringify([service, account]);
			}
			async setSecret(secret: Uint8Array): Promise<void> {
				const call = (backend.setCalls += 1);
				backend.events.push(`set-start-${call}`);
				await backend.beforeSet?.(call);
				backend.events.push(`set-write-${call}`);
				if (backend.setErrorAfterApply !== undefined) {
					backend.store.set(this.key, new Uint8Array(secret));
					throw backend.setErrorAfterApply;
				}
				if (backend.setError !== undefined) throw backend.setError;
				backend.store.set(this.key, new Uint8Array(secret));
				backend.events.push(`set-end-${call}`);
			}
			async getSecret(): Promise<number[] | null> {
				backend.getCalls += 1;
				backend.events.push("get");
				if (backend.getError !== undefined) throw backend.getError;
				if (backend.getResult !== undefined) return backend.getResult(this.key) as number[] | null;
				const value = backend.store.get(this.key);
				return value === undefined ? null : Array.from(value);
			}
			async deleteCredential(): Promise<boolean> {
				const call = (backend.deleteCalls += 1);
				backend.events.push(`delete-start-${call}`);
				await backend.beforeDelete?.(call);
				if (backend.deleteErrorAfterApply !== undefined) {
					backend.store.delete(this.key);
					throw backend.deleteErrorAfterApply;
				}
				if (backend.deleteError !== undefined) throw backend.deleteError;
				const existed = backend.store.delete(this.key);
				backend.events.push(`delete-end-${call}`);
				return existed;
			}
		};
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function rejection(promise: Promise<unknown>): Promise<VaultError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(VaultError);
		return error as VaultError;
	}
	throw new Error("expected the vault operation to reject");
}

function syncRejection(action: () => unknown): VaultError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(VaultError);
		return error as VaultError;
	}
	throw new Error("expected the factory call to throw");
}

function arrayOf(bytes: Uint8Array | null): number[] {
	if (bytes === null) throw new Error("expected bytes, got null");
	return Array.from(bytes);
}

describe("keyring SecureVault adapter", () => {
	test("round-trips bytes, copies in both directions, and handles delete/missing", async () => {
		const backend = new FakeBackend();
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });
		const input = new Uint8Array([0, 1, 127, 255]);

		await vault.write(ENTRY, input);
		input[0] = 9;
		const stored = backend.store.values().next().value;
		expect(stored).toBeDefined();
		expect(Array.from(stored as Uint8Array)).toEqual([0, 1, 127, 255]);

		const first = await vault.read(ENTRY);
		expect(arrayOf(first)).toEqual([0, 1, 127, 255]);
		(first as Uint8Array)[0] = 7;
		expect(arrayOf(await vault.read(ENTRY))).toEqual([0, 1, 127, 255]);

		expect(await vault.remove(ENTRY)).toBe(true);
		expect(await vault.read(ENTRY)).toBeNull();
		expect(await vault.remove(ENTRY)).toBe(false);
		expect(backend.constructed.every((entry) => entry.options === undefined)).toBe(true);
	});

	test("redacts native failures and rejects malformed native byte arrays", async () => {
		const sentinel = "raw-native-secret-9f3a-service-account";
		const backend = new FakeBackend();
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 4, platform: "win32" });

		backend.setError = new Error(sentinel);
		const writeError = await rejection(vault.write(ENTRY, new Uint8Array([1])));
		expect(writeError.code).toBe("outcome-uncertain");
		expect(writeError.message).toBe("The vault mutation outcome could not be verified.");
		expect(writeError.message).not.toContain(sentinel);
		expect(writeError.cause).toBeUndefined();

		backend.setError = undefined;
		backend.getError = new Error(sentinel);
		const getError = await rejection(vault.read(ENTRY));
		expect(getError.code).toBe("unavailable");
		expect(getError.message).not.toContain(sentinel);
		expect(getError.cause).toBeUndefined();

		backend.getError = undefined;
		backend.getResult = () => [0, 256];
		expect((await rejection(vault.read(ENTRY))).code).toBe("invalid-native-response");
		backend.getResult = () => [1.5];
		expect((await rejection(vault.read(ENTRY))).code).toBe("invalid-native-response");
		backend.getResult = () => new Uint8Array([1, 2]);
		expect((await rejection(vault.read(ENTRY))).code).toBe("invalid-native-response");
		backend.getResult = () => [1, 2, 3, 4, 5];
		expect((await rejection(vault.read(ENTRY))).code).toBe("too-large");
	});

	test("a rejected set after the mutation actually applied is outcome-uncertain with one exact readback", async () => {
		const sentinel = "raw-native-applied-set-failure";
		const backend = new FakeBackend({ setErrorAfterApply: new Error(sentinel) });
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });

		const error = await rejection(vault.write(ENTRY, new Uint8Array([4, 5])));
		expect(error.code).toBe("outcome-uncertain");
		expect(error.message).toBe("The vault mutation outcome could not be verified.");
		expect(error.message).not.toContain(sentinel);
		expect(error.cause).toBeUndefined();
		expect(backend.setCalls).toBe(1);
		expect(backend.getCalls).toBe(1);
		expect(Array.from(backend.store.values().next().value as Uint8Array)).toEqual([4, 5]);
		expect(
			backend.constructed.every(
				(entry) => entry.service === ENTRY.service && entry.account === ENTRY.account,
			),
		).toBe(true);
	});

	test("a failed exact readback after a rejected set remains outcome-uncertain and does not retry", async () => {
		const sentinel = "raw-native-readback-failure";
		const backend = new FakeBackend({ setErrorAfterApply: new Error("applied") });
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });
		backend.getError = new Error(sentinel);

		const error = await rejection(vault.write(ENTRY, new Uint8Array([6])));
		expect(error.code).toBe("outcome-uncertain");
		expect(error.message).not.toContain(sentinel);
		expect(backend.setCalls).toBe(1);
		expect(backend.getCalls).toBe(1);
	});

	test("a rejected delete after the credential was actually removed is outcome-uncertain with one exact readback", async () => {
		const sentinel = "raw-native-applied-delete-failure";
		const backend = new FakeBackend();
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });
		await vault.write(ENTRY, new Uint8Array([9]));
		backend.constructed.length = 0;
		backend.getCalls = 0;
		backend.deleteErrorAfterApply = new Error(sentinel);

		const error = await rejection(vault.remove(ENTRY));
		expect(error.code).toBe("outcome-uncertain");
		expect(error.message).toBe("The vault mutation outcome could not be verified.");
		expect(error.message).not.toContain(sentinel);
		expect(error.cause).toBeUndefined();
		expect(backend.deleteCalls).toBe(1);
		expect(backend.getCalls).toBe(1);
		expect(backend.store.has(JSON.stringify([ENTRY.service, ENTRY.account]))).toBe(false);
		expect(
			backend.constructed.every(
				(entry) => entry.service === ENTRY.service && entry.account === ENTRY.account,
			),
		).toBe(true);
	});

	test("a constructor failure before mutation stays unavailable and starts no write or delete", async () => {
		const sentinel = "raw-native-constructor-failure";
		const backend = new FakeBackend({ constructionError: new Error(sentinel) });
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });

		const writeError = await rejection(vault.write(ENTRY, new Uint8Array([1])));
		expect(writeError.code).toBe("unavailable");
		expect(writeError.message).not.toContain(sentinel);
		const removeError = await rejection(vault.remove(ENTRY));
		expect(removeError.code).toBe("unavailable");
		expect(backend.setCalls).toBe(0);
		expect(backend.deleteCalls).toBe(0);
		expect(backend.getCalls).toBe(0);
	});

	test("validates config, entries, signals, and the write byte ceiling before mutation", async () => {
		const backend = new FakeBackend();
		expect(syncRejection(() => createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 0 })).code).toBe(
			"invalid-input",
		);
		expect(syncRejection(() => createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 1.5 })).code).toBe(
			"invalid-input",
		);
		expect(
			syncRejection(() => createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "freebsd" }))
				.code,
		).toBe("unsupported-platform");
		expect(
			syncRejection(() =>
				createKeyringVault(undefined as unknown as KeyringAsyncEntryConstructor, { maxSecretBytes: 8 }),
			).code,
		).toBe("invalid-input");

		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 2, platform: "win32" });
		expect((await rejection(vault.read({ service: "", account: "a" }))).code).toBe("invalid-input");
		expect((await rejection(vault.read(ENTRY, { signal: {} as AbortSignal }))).code).toBe("invalid-input");
		expect((await rejection(vault.write(ENTRY, new Uint8Array([1, 2, 3])))).code).toBe("too-large");
		expect(backend.setCalls).toBe(0);
	});

	test("pins Linux to secret-service with no keyutils fallback", async () => {
		const backend = new FakeBackend();
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "linux" });
		expect(await vault.read(ENTRY)).toBeNull();
		expect(backend.constructed).toHaveLength(1);
		expect(backend.constructed[0]?.options).toEqual({ linux: { store: "secret-service" } });
	});

	test("rejects pre-aborted operations before constructing or mutating the entry", async () => {
		const backend = new FakeBackend();
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });
		const controller = new AbortController();
		controller.abort();

		expect((await rejection(vault.read(ENTRY, { signal: controller.signal }))).code).toBe("aborted");
		expect(
			(await rejection(vault.write(ENTRY, new Uint8Array([1]), { signal: controller.signal }))).code,
		).toBe("aborted");
		expect((await rejection(vault.remove(ENTRY, { signal: controller.signal }))).code).toBe("aborted");
		expect(backend.constructed).toHaveLength(0);
		expect(backend.setCalls).toBe(0);
		expect(backend.deleteCalls).toBe(0);
	});

	test("serializes concurrent callers per entry while separate entries proceed independently", async () => {
		const backend = new FakeBackend();
		const gate = deferred();
		backend.beforeSet = (call) => (call === 1 ? gate.promise : Promise.resolve());
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });
		const other = { service: "sessionport-test-service", account: "other-account" } as const;

		const first = vault.write(ENTRY, new Uint8Array([1]));
		const second = vault.write(ENTRY, new Uint8Array([2]));
		const independent = vault.write(other, new Uint8Array([3]));
		await flush();
		expect(backend.setCalls).toBe(2);

		const orderBeforeRelease = backend.events.slice(0, 2);
		expect(orderBeforeRelease).toEqual(["set-start-1", "set-start-2"]);
		gate.resolve();
		await Promise.all([first, second, independent]);
		expect(backend.setCalls).toBe(3);
		expect(backend.events.filter((event) => event.startsWith("set-start"))).toEqual([
			"set-start-1",
			"set-start-2",
			"set-start-3",
		]);
		expect(arrayOf(await vault.read(ENTRY))).toEqual([2]);
		expect(arrayOf(await vault.read(other))).toEqual([3]);
	});

	test("abort while queued rejects before the queued mutation starts", async () => {
		const backend = new FakeBackend();
		const gate = deferred();
		backend.beforeSet = (call) => (call === 1 ? gate.promise : Promise.resolve());
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });
		const controller = new AbortController();

		const first = vault.write(ENTRY, new Uint8Array([1]));
		const queued = vault.write(ENTRY, new Uint8Array([2]), { signal: controller.signal });
		await flush();
		expect(backend.setCalls).toBe(1);
		controller.abort();
		gate.resolve();
		await first;
		expect((await rejection(queued)).code).toBe("aborted");
		expect(backend.setCalls).toBe(1);
	});

	test("abort during a native write waits for settlement, then proves the exact readback", async () => {
		const backend = new FakeBackend();
		const gate = deferred();
		backend.beforeSet = () => gate.promise;
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });
		const controller = new AbortController();
		let settled = false;

		const write = vault.write(ENTRY, new Uint8Array([4, 5, 6]), { signal: controller.signal });
		const observed = write.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await flush();
		controller.abort();
		await flush();
		expect(settled).toBe(false);
		gate.resolve();
		await write;
		await observed;
		expect(settled).toBe(true);
		expect(backend.getCalls).toBeGreaterThan(0);
		expect(backend.events).toContain("set-end-1");
		expect(backend.events.indexOf("set-end-1")).toBeLessThan(backend.events.indexOf("get"));
		expect(arrayOf(await vault.read(ENTRY))).toEqual([4, 5, 6]);
	});

	test("abort plus a native write failure cannot claim cancellation and is outcome-uncertain", async () => {
		const backend = new FakeBackend();
		const gate = deferred();
		backend.beforeSet = () => gate.promise;
		backend.setError = new Error("unstructured native failure");
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });
		const controller = new AbortController();

		const write = vault.write(ENTRY, new Uint8Array([7]), { signal: controller.signal });
		await flush();
		controller.abort();
		gate.resolve();
		const error = await rejection(write);
		expect(error.code).toBe("outcome-uncertain");
		expect(error.message).toBe("The vault mutation outcome could not be verified.");
		expect(error.cause).toBeUndefined();
		expect(backend.getCalls).toBeGreaterThan(0);
	});

	test("abort during a native delete waits for settlement and verifies absence", async () => {
		const backend = new FakeBackend();
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });
		await vault.write(ENTRY, new Uint8Array([8]));

		const gate = deferred();
		backend.beforeDelete = () => gate.promise;
		const controller = new AbortController();
		const remove = vault.remove(ENTRY, { signal: controller.signal });
		await flush();
		controller.abort();
		gate.resolve();
		expect(await remove).toBe(true);
		expect(backend.deleteCalls).toBe(1);
		expect(await vault.read(ENTRY)).toBeNull();
	});

	test("abort plus a native delete failure retains uncertainty without a blind retry", async () => {
		const backend = new FakeBackend();
		const vault = createKeyringVault(backend.AsyncEntry, { maxSecretBytes: 8, platform: "win32" });
		await vault.write(ENTRY, new Uint8Array([9]));

		const gate = deferred();
		backend.beforeDelete = () => gate.promise;
		backend.deleteError = new Error("unstructured delete failure");
		const controller = new AbortController();
		const remove = vault.remove(ENTRY, { signal: controller.signal });
		await flush();
		controller.abort();
		gate.resolve();
		expect((await rejection(remove)).code).toBe("outcome-uncertain");
		expect(backend.deleteCalls).toBe(1);
		expect(arrayOf(await vault.read(ENTRY))).toEqual([9]);
	});
});

describe("synthetic keyring probe source", () => {
	test("is import-safe and no-argument invocation stops before dependency load", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = await runProbe([], {
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
		});
		expect(code).toBe(1);
		expect(stdout).toEqual([]);
		expect(stderr).toHaveLength(1);
		expect(stderr[0]).toContain("usage:");
		expect(() => parseProbeArgs([])).toThrow("usage:");
	});

	test("derives exactly one pair from a validated run id", () => {
		expect(
			parseProbeArgs([
				"--run-synthetic-keyring-probe",
				"--run-id",
				RUN_ID,
				"--deadline-ms",
				"30000",
			]),
		).toEqual({ runId: RUN_ID, deadlineMs: 30_000 });
		expect(probeEntry(RUN_ID)).toEqual({
			service: `sessionport-vault-probe-${RUN_ID}`,
			account: `synthetic-${RUN_ID}`,
		});
		expect(() =>
			parseProbeArgs([
				"--run-synthetic-keyring-probe",
				"--run-id",
				RUN_ID,
				"--deadline-ms",
				"999",
			]),
		).toThrow("usage:");
	});
});
