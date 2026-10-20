import { describe, expect, test } from "bun:test";
import {
	CredentialStore,
} from "../../../src/cloud/auth/credential-store.ts";
import {
	type NativeAuthErrorCode,
	NativeAuthError,
	type TokenCredential,
} from "../../../src/cloud/auth/types.ts";
import {
	type SecureVault,
	VaultError,
	type VaultEntry,
	type VaultOperationOptions,
} from "../../../src/cloud/vault/types.ts";

const ENTRY: VaultEntry = {
	service: "sessionport-auth-test",
	account: "credential-store",
};
const OTHER_ENTRY: VaultEntry = {
	service: "sessionport-auth-test",
	account: "other",
};
const MAX_BYTES = 4096;
const NOW = 1_700_000_000_000;

function token(seed: number): string {
	return Buffer.alloc(32, seed).toString("base64url");
}

function credential(
	overrides: Partial<TokenCredential> = {},
): TokenCredential {
	return {
		accessToken: token(1),
		refreshToken: token(2),
		accessExpiresAtMillis: NOW + 60_000,
		scope: "projects:read projects:write",
		...overrides,
	};
}

function key(entry: VaultEntry): string {
	return `${entry.service}\u0000${entry.account}`;
}

function encode(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

function decode(bytes: Uint8Array | undefined): string {
	if (bytes === undefined) throw new Error("missing bytes");
	return new TextDecoder().decode(bytes);
}

class MemoryVault implements SecureVault {
	readonly entries = new Map<string, Uint8Array>();
	readCalls = 0;
	writeCalls = 0;
	removeCalls = 0;
	failRead: unknown;
	failWrite: unknown;
	failRemove: unknown;
	failWriteAtCall: number | undefined;
	beforeWrite: ((call: number) => Promise<void>) | undefined;

	seed(entry: VaultEntry, bytes: Uint8Array): void {
		this.entries.set(key(entry), new Uint8Array(bytes));
	}

	async read(
		entry: VaultEntry,
		options?: VaultOperationOptions,
	): Promise<Uint8Array | null> {
		void options;
		this.readCalls += 1;
		if (this.failRead !== undefined) throw this.failRead;
		const value = this.entries.get(key(entry));
		return value === undefined ? null : new Uint8Array(value);
	}

	async write(
		entry: VaultEntry,
		secret: Uint8Array,
		options?: VaultOperationOptions,
	): Promise<void> {
		void options;
		const call = (this.writeCalls += 1);
		await this.beforeWrite?.(call);
		if (
			this.failWrite !== undefined ||
			this.failWriteAtCall === call
		) {
			throw this.failWrite ?? new Error("write failed");
		}
		this.entries.set(key(entry), new Uint8Array(secret));
	}

	async remove(
		entry: VaultEntry,
		options?: VaultOperationOptions,
	): Promise<boolean> {
		void options;
		this.removeCalls += 1;
		if (this.failRemove !== undefined) throw this.failRemove;
		return this.entries.delete(key(entry));
	}
}

function setup(
	options: {
		vault?: MemoryVault;
		maxCredentialBytes?: number;
	} = {},
) {
	const vault = options.vault ?? new MemoryVault();
	const store = new CredentialStore({
		vault,
		entry: ENTRY,
		maxCredentialBytes: options.maxCredentialBytes ?? MAX_BYTES,
	});
	return { vault, store };
}

async function expectError(
	promise: Promise<unknown>,
	code: NativeAuthErrorCode,
): Promise<NativeAuthError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(NativeAuthError);
		const native = error as NativeAuthError;
		expect(native.code).toBe(code);
		return native;
	}
	throw new Error(`expected NativeAuthError ${code}`);
}

function expectSyncError(
	action: () => unknown,
	code: NativeAuthErrorCode,
): NativeAuthError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(NativeAuthError);
		const native = error as NativeAuthError;
		expect(native.code).toBe(code);
		return native;
	}
	throw new Error(`expected NativeAuthError ${code}`);
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("credential store ready state", () => {
	test("writes and reads only the versioned token credential JSON", async () => {
		const { vault, store } = setup();
		const value = credential();
		await store.writeReady(value);

		expect(vault.writeCalls).toBe(1);
		expect(vault.entries.size).toBe(1);
		const raw = JSON.parse(decode(vault.entries.get(key(ENTRY)))) as Record<
			string,
			unknown
		>;
		expect(raw).toEqual({
			version: 1,
			state: "ready",
			accessToken: value.accessToken,
			refreshToken: value.refreshToken,
			accessExpiresAtMillis: value.accessExpiresAtMillis,
			scope: value.scope,
		});

		const read = await store.read();
		expect(read).toEqual({
			version: 1,
			state: "ready",
			...value,
		});
		expect(Object.isFrozen(read)).toBe(true);
		expect(read).not.toBe(await store.read());
	});

	test("copies caller input and revalidates every read", async () => {
		const { store } = setup();
		const mutable = { ...credential() };
		await store.writeReady(mutable);
		mutable.accessToken = token(99);
		mutable.scope = "widened:scope";

		const first = await store.read();
		expect(first).toEqual({ version: 1, state: "ready", ...credential() });
		expect(first?.state).toBe("ready");
		if (first?.state !== "ready") throw new Error("unreachable");
		expect(() => {
			(first as { accessToken: string }).accessToken = "mutated";
		}).toThrow();
		expect((await store.read())?.state).toBe("ready");
	});

	test("enforces the required explicit byte ceiling", async () => {
		const { vault, store } = setup({ maxCredentialBytes: 64 });
		await expectError(
			store.writeReady(credential()),
			"too-large",
		);
		expect(vault.writeCalls).toBe(0);

		for (const maxCredentialBytes of [0, -1, 1.5, Number.NaN]) {
			expectSyncError(
				() =>
					new CredentialStore({
						vault,
						entry: ENTRY,
						maxCredentialBytes,
					}),
				"invalid-input",
			);
		}

		const oversized = setup();
		oversized.vault.seed(
			ENTRY,
			new Uint8Array(MAX_BYTES + 1),
		);
		await expectError(oversized.store.read(), "credential-corrupt");
	});

	test("returns null only for an absent exact entry", async () => {
		const { vault, store } = setup();
		vault.seed(OTHER_ENTRY, encode({ unrelated: true }));
		expect(await store.read()).toBeNull();
		expect(vault.readCalls).toBe(1);

		await store.writeReady(credential());
		expect((await store.read())?.state).toBe("ready");
		expect(vault.readCalls).toBe(2);
	});
});

describe("credential store malformed state", () => {
	test("fails closed on invalid UTF-8, a BOM, invalid JSON, and non-object JSON", async () => {
		for (const bytes of [
			new Uint8Array([0xff, 0xfe, 0x00]),
			new TextEncoder().encode("{"),
			new TextEncoder().encode("[]"),
			new TextEncoder().encode("null"),
			new TextEncoder().encode("true"),
			new TextEncoder().encode("1"),
			new Uint8Array([
				0xef,
				0xbb,
				0xbf,
				...new TextEncoder().encode(
					JSON.stringify({ version: 1, state: "unauthorized" }),
				),
			]),
		]) {
			const { vault, store } = setup();
			vault.seed(ENTRY, bytes);
			await expectError(store.read(), "credential-corrupt");
			expect(vault.writeCalls).toBe(0);
			expect(vault.removeCalls).toBe(0);
		}
	});

	test("rejects wrong versions, unknown states, missing fields, and extras", async () => {
		const ready = {
			version: 1,
			state: "ready",
			...credential(),
		};

		const cases: unknown[] = [
			{ ...ready, version: 2 },
			{ ...ready, state: "unknown" },
			{ ...ready, extra: "field" },
			{ version: 1, state: "refresh-uncertain", accessToken: token(1) },
			{ version: 1, state: "unauthorized", scope: "x" },
			{ version: 1, state: "ready" },
			{ version: 1 },
			{ state: "ready", ...credential() },
		];

		for (const value of cases) {
			const { vault, store } = setup();
			vault.seed(ENTRY, encode(value));
			await expectError(store.read(), "credential-corrupt");
			expect(vault.writeCalls).toBe(0);
			expect(vault.removeCalls).toBe(0);
		}
	});

	test("rejects non-canonical tokens, expiry, and scope fields", async () => {
		const cases: Array<Partial<TokenCredential>> = [
			{ accessToken: "A".repeat(42) },
			{ accessToken: `${"A".repeat(42)}B` },
			{ refreshToken: `${"A".repeat(42)}B` },
			{ accessExpiresAtMillis: 0 },
			{ accessExpiresAtMillis: -1 },
			{ accessExpiresAtMillis: 1.5 },
			{ scope: "" },
			{ scope: " projects:read" },
			{ scope: "projects:read " },
			{ scope: "projects:read  projects:write" },
			{ scope: "projects:read projects:read" },
			{ scope: "projects:read\tprojects:write" },
		];

		for (const overrides of cases) {
			const { vault, store } = setup();
			vault.seed(
				ENTRY,
				encode({ version: 1, state: "ready", ...credential(), ...overrides }),
			);
			await expectError(store.read(), "credential-corrupt");
		}
	});

	test("reads only the exact marker states, with no embedded tokens", async () => {
		const first = setup();
		await first.store.markRefreshUncertain();
		const uncertain = await first.store.read();
		expect(uncertain).toEqual({
			version: 1,
			state: "refresh-uncertain",
		});
		expect(Object.isFrozen(uncertain)).toBe(true);
		expect(
			JSON.parse(decode(first.vault.entries.get(key(ENTRY)))),
		).toEqual({ version: 1, state: "refresh-uncertain" });

		const second = setup();
		await second.store.markUnauthorized();
		expect(await second.store.read()).toEqual({
			version: 1,
			state: "unauthorized",
		});
		expect(
			JSON.parse(decode(second.vault.entries.get(key(ENTRY)))),
		).toEqual({ version: 1, state: "unauthorized" });
	});

	test("validates and copies marker-like input before writing", async () => {
		const { vault, store } = setup();
		await store.writeReady(credential());
		const writes = vault.writeCalls;
		await store.markRefreshUncertain();
		expect(vault.writeCalls).toBe(writes + 1);
		expect(await store.read()).toEqual({
			version: 1,
			state: "refresh-uncertain",
		});
	});
});

describe("credential store vault failures", () => {
	test("maps read failures without fallback or clearing", async () => {
		for (const [failure, code] of [
			[new VaultError("unavailable"), "credential-unavailable"],
			[new Error("raw native detail"), "credential-unavailable"],
			[
				new VaultError("invalid-native-response"),
				"credential-corrupt",
			],
		] as const) {
			const { vault, store } = setup();
			vault.seed(ENTRY, encode(credential()));
			vault.failRead = failure;
			const error = await expectError(store.read(), code);
			expect(error.message).not.toContain("raw native");
			expect(vault.writeCalls).toBe(0);
			expect(vault.removeCalls).toBe(0);
		}
	});

	test("maps write failures and never silently succeeds", async () => {
		for (const [failure, code] of [
			[new VaultError("unavailable"), "credential-unavailable"],
			[
				new VaultError("outcome-uncertain"),
				"write-outcome-uncertain",
			],
			[new VaultError("too-large"), "too-large"],
			[new VaultError("aborted"), "aborted"],
			[new Error("raw native detail"), "write-outcome-uncertain"],
		] as const) {
			const { vault, store } = setup();
			vault.failWrite = failure;
			const error = await expectError(
				store.writeReady(credential()),
				code,
			);
			expect(error.message).not.toContain("raw native");
			expect(vault.removeCalls).toBe(0);
		}
	});

	test("maps remove failures and preserves the exact entry on failure", async () => {
		const { vault, store } = setup();
		await store.writeReady(credential());
		vault.failRemove = new VaultError("unavailable");
		await expectError(store.remove(), "credential-unavailable");
		expect((await store.read())?.state).toBe("ready");
	});
});

describe("credential store serialization and scope", () => {
	test("removes only the exact configured entry", async () => {
		const { vault, store } = setup();
		await store.writeReady(credential());
		vault.seed(OTHER_ENTRY, new TextEncoder().encode("other"));

		expect(await store.remove()).toBe(true);
		expect(vault.entries.has(key(ENTRY))).toBe(false);
		expect(decode(vault.entries.get(key(OTHER_ENTRY)))).toBe("other");
		expect(await store.remove()).toBe(false);
	});

	test("serializes writes per store instance", async () => {
		const { vault, store } = setup();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		vault.beforeWrite = async () => {
			if (first) {
				first = false;
				await gate;
			}
		};

		const firstWrite = store.writeReady(credential({ scope: "first" }));
		const secondWrite = store.writeReady(
			credential({ scope: "second" }),
		);
		await flush();
		expect(vault.writeCalls).toBe(1);
		release();
		await Promise.all([firstWrite, secondWrite]);
		expect(vault.writeCalls).toBe(2);
		expect(
			JSON.parse(decode(vault.entries.get(key(ENTRY)))),
		).toMatchObject({ scope: "second" });
	});

	test("rejects invalid constructor inputs", () => {
		const vault = new MemoryVault();
		expectSyncError(
			() =>
				new CredentialStore({
					vault: {} as SecureVault,
					entry: ENTRY,
					maxCredentialBytes: MAX_BYTES,
				}),
			"invalid-input",
		);
		expectSyncError(
			() =>
				new CredentialStore({
					vault,
					entry: { service: "", account: "x" },
					maxCredentialBytes: MAX_BYTES,
				}),
			"invalid-input",
		);
		expectSyncError(
			() =>
				new CredentialStore({
					vault,
					entry: ENTRY,
					maxCredentialBytes: 0,
				}),
			"invalid-input",
		);
		expectSyncError(
			() =>
				new CredentialStore({
					vault,
					entry: ENTRY,
					maxCredentialBytes: 1.5,
				}),
			"invalid-input",
		);
	});
});
