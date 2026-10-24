/**
 * Vault-backed state-key provider tests.
 *
 * TEST-ONLY: an in-memory fake `SecureVault` stands in for every platform
 * binding. No real vault, credential, keyring, host session, or platform
 * support is exercised or claimed.
 */
import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	STATE_KEY_VAULT_SERVICE,
	VaultStateKeyError,
	type VaultStateKeyErrorCode,
	type VaultStateKeyProviderConfig,
	createVaultStateKeyProvider,
} from "../../../src/cloud/state-key/index.ts";
import type {
	SecureVault,
	VaultEntry,
	VaultOperationOptions,
} from "../../../src/cloud/vault/types.ts";

const ACCOUNT_PREFIX = "sessionport-state-vault-account-v1\0";
const STATE_KEY_ENTRY_SERVICE = "opencode-session-port/local-state-key/v1";
const HOST_SCOPE = "host-instance-\u00e9-\u{1f600}";
const AUTH_ENTRY: VaultEntry = {
	service: "opencode-session-port/auth",
	account: "configured-auth-token",
};

interface FakeOptions {
	readError?: unknown;
	writeError?: unknown;
	writeErrorAfterApply?: unknown;
	readErrorAfterWrite?: unknown;
	dropWrite?: boolean;
	corruptWrite?: boolean;
	overrideRead?: { readonly value: unknown };
	retainWriteReference?: boolean;
	returnSharedRead?: boolean;
}

function keyBytes(fill: number): Uint8Array {
	return new Uint8Array(32).fill(fill);
}

function entryKey(entry: VaultEntry): string {
	return JSON.stringify([entry.service, entry.account]);
}

function expectedAccount(hostScope: string): string {
	return createHash("sha256")
		.update(Buffer.from(ACCOUNT_PREFIX, "utf8"))
		.update(Buffer.from(hostScope, "utf8"))
		.digest("hex");
}

function expectedEntry(hostScope: string): VaultEntry {
	return {
		service: STATE_KEY_ENTRY_SERVICE,
		account: expectedAccount(hostScope),
	};
}

class MemoryVault implements SecureVault {
	readonly entries = new Map<string, Uint8Array>();
	readonly readEntries: VaultEntry[] = [];
	readonly writeEntries: VaultEntry[] = [];
	readonly writeCopies: Uint8Array[] = [];
	lastWriteReference: Uint8Array | null = null;

	readonly read = mock(
		async (entry: VaultEntry, options?: VaultOperationOptions): Promise<Uint8Array | null> => {
			void options;
			this.readEntries.push({ service: entry.service, account: entry.account });
			if (this.options.readError !== undefined) throw this.options.readError;
			if (
				this.options.readErrorAfterWrite !== undefined &&
				this.writeEntries.length > 0
			) {
				throw this.options.readErrorAfterWrite;
			}
			if (this.options.overrideRead !== undefined) {
				return this.options.overrideRead.value as Uint8Array | null;
			}
			const stored = this.entries.get(entryKey(entry));
			if (stored === undefined) return null;
			return this.options.returnSharedRead ? stored : new Uint8Array(stored);
		},
	);

	readonly write = mock(
		async (
			entry: VaultEntry,
			secret: Uint8Array,
			options?: VaultOperationOptions,
		): Promise<void> => {
			void options;
			this.writeEntries.push({ service: entry.service, account: entry.account });
			this.writeCopies.push(new Uint8Array(secret));
			if (this.options.retainWriteReference) this.lastWriteReference = secret;
			if (this.options.writeError !== undefined) throw this.options.writeError;
			if (!this.options.dropWrite) {
				const stored = new Uint8Array(secret);
				if (this.options.corruptWrite) stored[0] = (stored[0] ?? 0) ^ 0xff;
				this.entries.set(entryKey(entry), stored);
			}
			if (this.options.writeErrorAfterApply !== undefined) {
				throw this.options.writeErrorAfterApply;
			}
		},
	);

	readonly remove = mock(
		async (entry: VaultEntry, options?: VaultOperationOptions): Promise<boolean> => {
			void options;
			return this.entries.delete(entryKey(entry));
		},
	);

	constructor(private readonly options: FakeOptions = {}) {}

	seed(entry: VaultEntry, bytes: Uint8Array): void {
		this.entries.set(entryKey(entry), new Uint8Array(bytes));
	}

	get(entry: VaultEntry): Uint8Array | undefined {
		const stored = this.entries.get(entryKey(entry));
		return stored === undefined ? undefined : new Uint8Array(stored);
	}
}

function setup(options: FakeOptions = {}): MemoryVault {
	return new MemoryVault(options);
}

function providerFor(vault: SecureVault, hostScope = HOST_SCOPE) {
	return createVaultStateKeyProvider({ vault, hostScope });
}

async function rejection(promise: Promise<unknown>): Promise<VaultStateKeyError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(VaultStateKeyError);
		const typed = error as VaultStateKeyError;
		expect(typed.cause).toBeUndefined();
		return typed;
	}
	throw new Error("expected the operation to reject");
}

function expectCode(error: VaultStateKeyError, code: VaultStateKeyErrorCode): void {
	expect(error.code).toBe(code);
}

function factoryError(config: unknown): VaultStateKeyError {
	try {
		createVaultStateKeyProvider(config as VaultStateKeyProviderConfig);
	} catch (error) {
		expect(error).toBeInstanceOf(VaultStateKeyError);
		return error as VaultStateKeyError;
	}
	throw new Error("expected the factory to throw");
}

describe("vault state-key provider namespace", () => {
	test("derives the fixed service and exact lowercase SHA-256 account", async () => {
		const vault = setup();
		const provider = providerFor(vault, HOST_SCOPE);

		expect(await provider.load()).toBeNull();
		const account = expectedAccount(HOST_SCOPE);
		expect(account).toMatch(/^[0-9a-f]{64}$/);
		expect(vault.read).toHaveBeenCalledTimes(1);
		expect(vault.read.mock.calls[0]?.[0]).toEqual({
			service: STATE_KEY_ENTRY_SERVICE,
			account,
		});
		expect(vault.write).not.toHaveBeenCalled();
		expect(vault.remove).not.toHaveBeenCalled();
	});

	test("never touches a configured auth entry", async () => {
		const vault = setup();
		const authBytes = new Uint8Array([1, 2, 3, 4]);
		vault.seed(AUTH_ENTRY, authBytes);

		const created = await providerFor(vault).createIfMissing();

		expect(Array.from(created)).toHaveLength(32);
		expect(vault.get(AUTH_ENTRY)).toEqual(authBytes);
		expect(vault.write).toHaveBeenCalledTimes(1);
		expect(vault.read).toHaveBeenCalledTimes(2);
		expect(vault.remove).not.toHaveBeenCalled();
		for (const entry of [...vault.readEntries, ...vault.writeEntries]) {
			expect(entry).toEqual(expectedEntry(HOST_SCOPE));
			expect(entry.service).not.toBe(AUTH_ENTRY.service);
			expect(entry.account).not.toBe(AUTH_ENTRY.account);
		}
	});

	test("different host scopes produce different accounts and key material", async () => {
		const vault = setup();
		const first = providerFor(vault, "host-a");
		const second = providerFor(vault, "host-b");

		const firstKey = await first.createIfMissing();
		const secondKey = await second.createIfMissing();

		expect(expectedAccount("host-a")).not.toBe(expectedAccount("host-b"));
		expect(Array.from(firstKey)).not.toEqual(Array.from(secondKey));
		expect(vault.entries.has(entryKey(expectedEntry("host-a")))).toBe(true);
		expect(vault.entries.has(entryKey(expectedEntry("host-b")))).toBe(true);
		expect(Array.from((await first.load()) ?? [])).toEqual(Array.from(firstKey));
		expect(Array.from((await second.load()) ?? [])).toEqual(Array.from(secondKey));
		expect(vault.write).toHaveBeenCalledTimes(2);
		expect(vault.remove).not.toHaveBeenCalled();
	});

	test("does not normalize the host scope", async () => {
		const vault = setup();
		const composed = providerFor(vault, "\u00e9");
		const decomposed = providerFor(vault, "e\u0301");

		expect(await composed.load()).toBeNull();
		expect(await decomposed.load()).toBeNull();

		const accounts = vault.read.mock.calls.map((call) => call[0]?.account);
		expect(accounts[0]).toBe(expectedAccount("\u00e9"));
		expect(accounts[1]).toBe(expectedAccount("e\u0301"));
		expect(accounts[0]).not.toBe(accounts[1]);
	});
});

describe("vault state-key provider load", () => {
	test("absent load is read-only and returns null", async () => {
		const vault = setup();
		const provider = providerFor(vault);

		expect(await provider.load()).toBeNull();
		expect(vault.entries.size).toBe(0);
		expect(vault.write).not.toHaveBeenCalled();
		expect(vault.remove).not.toHaveBeenCalled();
	});

	test("present load returns a caller-owned copy without mutating vault bytes", async () => {
		const vault = setup({ returnSharedRead: true });
		const seeded = keyBytes(7);
		vault.seed(expectedEntry(HOST_SCOPE), seeded);
		const provider = providerFor(vault);

		const loaded = await provider.load();
		expect(loaded).not.toBeNull();
		expect(loaded).not.toBe(seeded);
		expect(Array.from(loaded ?? [])).toEqual(Array.from(seeded));
		expect(Array.from(vault.get(expectedEntry(HOST_SCOPE)) ?? [])).toEqual(
			Array.from(seeded),
		);

		(loaded as Uint8Array).fill(0xaa);
		expect(Array.from(vault.get(expectedEntry(HOST_SCOPE)) ?? [])).toEqual(
			Array.from(seeded),
		);
		expect(Array.from((await provider.load()) ?? [])).toEqual(Array.from(seeded));
		expect(vault.write).not.toHaveBeenCalled();
		expect(vault.remove).not.toHaveBeenCalled();
	});

	test("an existing key is returned without any write", async () => {
		const vault = setup();
		const seeded = keyBytes(3);
		vault.seed(expectedEntry(HOST_SCOPE), seeded);
		const provider = providerFor(vault);

		const created = await provider.createIfMissing();

		expect(Array.from(created)).toEqual(Array.from(seeded));
		expect(vault.read).toHaveBeenCalledTimes(1);
		expect(vault.write).not.toHaveBeenCalled();
		expect(vault.remove).not.toHaveBeenCalled();
	});
});

describe("vault state-key provider creation", () => {
	test("writes exactly once, verifies the readback, and returns a caller-owned copy", async () => {
		const vault = setup({ retainWriteReference: true });
		const provider = providerFor(vault);

		const created = await provider.createIfMissing();
		expect(created).toBeInstanceOf(Uint8Array);
		expect(created.byteLength).toBe(32);
		expect(vault.write).toHaveBeenCalledTimes(1);
		expect(vault.read).toHaveBeenCalledTimes(2);
		expect(vault.remove).not.toHaveBeenCalled();

		const stored = vault.get(expectedEntry(HOST_SCOPE));
		expect(stored).toBeDefined();
		expect(Array.from(stored ?? [])).toEqual(Array.from(created));
		expect(Array.from(vault.writeCopies[0] ?? [])).toEqual(Array.from(created));

		// The module-owned write copy is wiped, while the stored copy survives.
		expect(Array.from(vault.lastWriteReference ?? [])).toEqual(new Array(32).fill(0));
		expect(Array.from(vault.get(expectedEntry(HOST_SCOPE)) ?? [])).toEqual(
			Array.from(stored ?? []),
		);

		// A second explicit call sees the existing entry and does not write again.
		const again = await provider.createIfMissing();
		expect(Array.from(again)).toEqual(Array.from(stored ?? []));
		expect(vault.write).toHaveBeenCalledTimes(1);

		// The returned key is caller-owned; zeroing it cannot alter the vault.
		created.fill(0x11);
		expect(Array.from(vault.get(expectedEntry(HOST_SCOPE)) ?? [])).toEqual(
			Array.from(stored ?? []),
		);
		expect(Array.from((await provider.load()) ?? [])).toEqual(Array.from(stored ?? []));
	});

	test("malformed existing entries fail closed without overwrite or delete", async () => {
		const malformed: Array<Uint8Array | { readonly value: unknown }> = [
			new Uint8Array(0),
			new Uint8Array(31),
			new Uint8Array(33),
			{ value: "not-bytes" },
			{ value: undefined },
		];
		for (const value of malformed) {
			const vault =
				value instanceof Uint8Array
					? setup()
					: setup({ overrideRead: value });
			if (value instanceof Uint8Array) {
				vault.seed(expectedEntry(HOST_SCOPE), value);
			}
			const provider = providerFor(vault);
			const before = vault.get(expectedEntry(HOST_SCOPE));

			const loadError = await rejection(provider.load());
			expectCode(loadError, "state-key-corrupt");
			expect(loadError.message).toBe("The vault state-key entry is invalid.");

			const createError = await rejection(provider.createIfMissing());
			expectCode(createError, "state-key-corrupt");
			expect(vault.write).not.toHaveBeenCalled();
			expect(vault.remove).not.toHaveBeenCalled();
			if (value instanceof Uint8Array) {
				expect(Array.from(vault.get(expectedEntry(HOST_SCOPE)) ?? [])).toEqual(
					Array.from(before ?? []),
				);
			}
		}
	});

	test("unavailable reads fail closed with a redacted error and no writes", async () => {
		const sentinel = "raw-vault-read-material-11f0";
		const vault = setup({ readError: new Error(sentinel) });
		const provider = providerFor(vault);

		const loadError = await rejection(provider.load());
		expectCode(loadError, "state-key-unavailable");
		expect(loadError.message).toBe("The vault state key is unavailable.");
		expect(loadError.message).not.toContain(sentinel);

		const createError = await rejection(provider.createIfMissing());
		expectCode(createError, "state-key-unavailable");
		expect(vault.write).not.toHaveBeenCalled();
		expect(vault.remove).not.toHaveBeenCalled();
	});
});

describe("vault state-key provider uncertain writes", () => {
	test("a rejected write is uncertain, never retried, overwritten, or deleted", async () => {
		const sentinel = "raw-native-write-material-84c1";
		const vault = setup({ writeError: new Error(sentinel) });
		const provider = providerFor(vault);

		const error = await rejection(provider.createIfMissing());
		expectCode(error, "state-key-write-uncertain");
		expect(error.message).toBe("The vault state-key write outcome is uncertain.");
		expect(error.message).not.toContain(sentinel);
		expect(vault.write).toHaveBeenCalledTimes(1);
		expect(vault.read).toHaveBeenCalledTimes(1);
		expect(vault.remove).not.toHaveBeenCalled();
		expect(vault.entries.size).toBe(0);
	});

	test("a rejected write that applied is left in place without erase or retry", async () => {
		const vault = setup({ writeErrorAfterApply: new Error("applied but rejected") });
		const provider = providerFor(vault);

		const error = await rejection(provider.createIfMissing());
		expectCode(error, "state-key-write-uncertain");
		expect(vault.write).toHaveBeenCalledTimes(1);
		expect(vault.read).toHaveBeenCalledTimes(1);
		expect(vault.remove).not.toHaveBeenCalled();
		expect(vault.get(expectedEntry(HOST_SCOPE))).toEqual(vault.writeCopies[0]);
	});

	test("a failed readback is uncertain and leaves the entry untouched", async () => {
		const vault = setup({ readErrorAfterWrite: new Error("readback failed") });
		const provider = providerFor(vault);

		const error = await rejection(provider.createIfMissing());
		expectCode(error, "state-key-write-uncertain");
		expect(vault.write).toHaveBeenCalledTimes(1);
		expect(vault.read).toHaveBeenCalledTimes(2);
		expect(vault.remove).not.toHaveBeenCalled();
		expect(vault.get(expectedEntry(HOST_SCOPE))).toEqual(vault.writeCopies[0]);
	});

	test("a null readback is uncertain, writes once, and does not erase", async () => {
		const vault = setup({ dropWrite: true });
		const provider = providerFor(vault);

		const error = await rejection(provider.createIfMissing());
		expectCode(error, "state-key-write-uncertain");
		expect(vault.write).toHaveBeenCalledTimes(1);
		expect(vault.read).toHaveBeenCalledTimes(2);
		expect(vault.remove).not.toHaveBeenCalled();
		expect(vault.get(expectedEntry(HOST_SCOPE))).toBeUndefined();
	});

	test("a mismatched readback is uncertain and is not overwritten", async () => {
		const vault = setup({ corruptWrite: true });
		const provider = providerFor(vault);

		const error = await rejection(provider.createIfMissing());
		expectCode(error, "state-key-write-uncertain");
		expect(vault.write).toHaveBeenCalledTimes(1);
		expect(vault.read).toHaveBeenCalledTimes(2);
		expect(vault.remove).not.toHaveBeenCalled();

		const stored = vault.get(expectedEntry(HOST_SCOPE));
		expect(stored).toBeDefined();
		expect(Array.from(stored ?? [])).not.toEqual(
			Array.from(vault.writeCopies[0] ?? []),
		);
		expect(Array.from(vault.get(expectedEntry(HOST_SCOPE)) ?? [])).toEqual(
			Array.from(stored ?? []),
		);
	});
});

describe("vault state-key provider configuration", () => {
	test("rejects invalid host scopes before any vault operation", () => {
		const vault = setup();
		const invalid: unknown[] = [
			undefined,
			null,
			1,
			"",
			"a\u0000b",
			"\u0001",
			"\u001f",
			"\u007f",
			"\ud800",
			"a\ud800",
			"\udfff",
			"a".repeat(513),
			"\u00e9".repeat(257),
			"\u{1f600}".repeat(129),
		];
		for (const hostScope of invalid) {
			const error = factoryError({ vault, hostScope });
			expectCode(error, "invalid-input");
			expect(error.message).toBe("The vault state-key configuration is invalid.");
		}
		expect(vault.read).not.toHaveBeenCalled();
		expect(vault.write).not.toHaveBeenCalled();
		expect(vault.remove).not.toHaveBeenCalled();
	});

	test("accepts exact 512-byte host scopes and rejects 513 bytes", () => {
		expect(() =>
			providerFor(setup(), "a".repeat(512)),
		).not.toThrow();
		expect(() =>
			providerFor(setup(), "\u00e9".repeat(256)),
		).not.toThrow();
		expect(() =>
			providerFor(setup(), "\u{1f600}".repeat(128)),
		).not.toThrow();
		expect(() =>
			providerFor(setup(), "a".repeat(513)),
		).toThrow(VaultStateKeyError);
	});

	test("rejects namespace/auth overrides and malformed config", () => {
		const vault = setup();
		const invalidConfigs: unknown[] = [
			null,
			undefined,
			[],
			{},
			{ vault },
			{ hostScope: "host" },
			{ vault: null, hostScope: "host" },
			{ vault: {}, hostScope: "host" },
			{ vault, hostScope: "host", service: "caller-service" },
			{ vault, hostScope: "host", account: "caller-account" },
			{ vault, hostScope: "host", namespace: "caller-namespace" },
		];
		for (const config of invalidConfigs) {
			expectCode(factoryError(config), "invalid-input");
		}
		expect(vault.read).not.toHaveBeenCalled();
		expect(vault.write).not.toHaveBeenCalled();
	});

	test("exposes no key-delete API", () => {
		const provider = providerFor(setup());
		expect(typeof provider.load).toBe("function");
		expect(typeof provider.createIfMissing).toBe("function");
		expect("remove" in provider).toBe(false);
		expect("delete" in provider).toBe(false);
		expect(STATE_KEY_VAULT_SERVICE).toBe(
			"opencode-session-port/local-state-key/v1",
		);
	});
});
