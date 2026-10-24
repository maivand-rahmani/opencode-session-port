/**
 * Vault-backed local state-key provider.
 *
 * The production namespace is fixed here and has no caller override:
 * service `opencode-session-port/local-state-key/v1`, account is the lowercase
 * SHA-256 hex of UTF-8 `sessionport-state-vault-account-v1<NUL>` followed by
 * the exact UTF-8 host scope. This is a separate vault entry from auth tokens;
 * no credential store, access token, or namespace argument is accepted.
 *
 * `load()` is read-only. `createIfMissing()` exists because the state store has
 * no key-creation path: integration must prove the encrypted snapshot absent
 * and hold the state owner lease first. The vault contract has no atomic
 * create-if-absent operation, so this provider cannot make that decision safe
 * across processes, and it never retries, overwrites, erases, or deletes after
 * an uncertain outcome. Local logout must retain this key and the encrypted
 * outbox; no delete API is exposed.
 *
 * Buffer contract: vault reads are copied before being returned and are never
 * wiped here because an adapter may return shared bytes. Secrets passed to
 * `write` are module-owned copies and are wiped in `finally`. The returned key
 * is a caller-owned copy; the caller is responsible for zeroing it.
 *
 * No platform, keyring-locking, or real-vault behavior is claimed here; the
 * injected `SecureVault` supplies all platform behavior.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	STATE_KEY_BYTES,
	type StateKeyProvider,
} from "../state/types.ts";
import type {
	SecureVault,
	VaultEntry,
} from "../vault/types.ts";

/** Fixed production namespace; never accepts a caller namespace override. */
export const STATE_KEY_VAULT_SERVICE = "opencode-session-port/local-state-key/v1";

/** Literal UTF-8 account prefix, including one actual NUL separator. */
const ACCOUNT_PREFIX = "sessionport-state-vault-account-v1\0";
const MAX_HOST_SCOPE_UTF8_BYTES = 512;
const UTF8_ENCODER = new TextEncoder();

export type VaultStateKeyErrorCode =
	| "invalid-input"
	| "state-key-unavailable"
	| "state-key-corrupt"
	| "state-key-write-uncertain";

const ERROR_MESSAGES: Readonly<Record<VaultStateKeyErrorCode, string>> = Object.freeze({
	"invalid-input": "The vault state-key configuration is invalid.",
	"state-key-unavailable": "The vault state key is unavailable.",
	"state-key-corrupt": "The vault state-key entry is invalid.",
	"state-key-write-uncertain": "The vault state-key write outcome is uncertain.",
});

/** Fixed, redacted error: no host scope, key bytes, native text, or cause. */
export class VaultStateKeyError extends Error {
	readonly code: VaultStateKeyErrorCode;

	constructor(code: VaultStateKeyErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "VaultStateKeyError";
		this.code = code;
	}
}

export interface VaultStateKeyProviderConfig {
	/** Injected bytes-only vault; this module never loads a native keyring. */
	readonly vault: SecureVault;
	/** Caller-selected host-instance scope, used verbatim as UTF-8. */
	readonly hostScope: string;
}

/** StateStore-compatible provider plus the explicit first-creation path. */
export interface VaultStateKeyProvider extends StateKeyProvider {
	load(): Promise<Uint8Array | null>;
	/**
	 * CRITICAL PRECONDITION: the caller owns the state owner lease and has
	 * proved the encrypted snapshot absent. If the key entry exists it is
	 * returned without a write; any existing malformed or unavailable entry
	 * fails closed. The provider cannot prove snapshot absence or provide
	 * cross-process atomicity by itself.
	 */
	createIfMissing(): Promise<Uint8Array>;
}

/** Validates config shape without accepting namespace/auth overrides. */
function isConfig(value: unknown): value is VaultStateKeyProviderConfig {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const keys = Object.keys(value);
	return (
		keys.length === 2 &&
		Object.hasOwn(value, "vault") &&
		Object.hasOwn(value, "hostScope")
	);
}

function isVault(value: unknown): value is SecureVault {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as SecureVault).read === "function" &&
		typeof (value as SecureVault).write === "function"
	);
}

/** Rejects control characters and unpaired UTF-16 surrogates. */
function hasForbiddenHostScopeCodeUnit(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f) return true;
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

/**
 * Validates and encodes the exact host scope. No normalization is applied;
 * the returned bytes are the exact UTF-8 representation used for the account.
 */
function encodeHostScope(value: unknown): Uint8Array {
	if (typeof value !== "string" || value.length === 0) {
		throw new VaultStateKeyError("invalid-input");
	}
	if (hasForbiddenHostScopeCodeUnit(value)) {
		throw new VaultStateKeyError("invalid-input");
	}
	const bytes = UTF8_ENCODER.encode(value);
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_HOST_SCOPE_UTF8_BYTES) {
		throw new VaultStateKeyError("invalid-input");
	}
	return bytes;
}

class VaultStateKeyProviderImpl implements VaultStateKeyProvider {
	constructor(
		private readonly vault: SecureVault,
		private readonly entry: VaultEntry,
	) {}

	/** Read-only; `null` means absent. Never creates or deletes. */
	load(): Promise<Uint8Array | null> {
		return this.readExisting();
	}

	async createIfMissing(): Promise<Uint8Array> {
		const existing = await this.readExisting();
		if (existing !== null) return existing;

		let key: Uint8Array;
		try {
			key = new Uint8Array(randomBytes(STATE_KEY_BYTES));
		} catch {
			throw new VaultStateKeyError("state-key-unavailable");
		}
		const writeInput = new Uint8Array(key);
		try {
			try {
				await this.vault.write(this.entry, writeInput);
			} catch {
				// The mutation may have applied. Never retry, overwrite, or erase.
				throw new VaultStateKeyError("state-key-write-uncertain");
			}

			let readback: Uint8Array | null;
			try {
				readback = await this.vault.read(this.entry);
			} catch {
				throw new VaultStateKeyError("state-key-write-uncertain");
			}
			if (
				!(readback instanceof Uint8Array) ||
				readback.byteLength !== STATE_KEY_BYTES ||
				!timingSafeEqual(readback, key)
			) {
				// The write may have applied differently or not at all. Leave the
				// entry untouched for explicit operator/integration handling.
				throw new VaultStateKeyError("state-key-write-uncertain");
			}
			return new Uint8Array(key);
		} finally {
			key.fill(0);
			writeInput.fill(0);
		}
	}

	private async readExisting(): Promise<Uint8Array | null> {
		let raw: Uint8Array | null;
		try {
			raw = await this.vault.read(this.entry);
		} catch {
			throw new VaultStateKeyError("state-key-unavailable");
		}
		if (raw === null) return null;
		if (!(raw instanceof Uint8Array) || raw.byteLength !== STATE_KEY_BYTES) {
			throw new VaultStateKeyError("state-key-corrupt");
		}
		// Caller-owned copy; never wipe the adapter's returned buffer.
		return new Uint8Array(raw);
	}
}

/**
 * Builds the fixed-namespace provider. Invalid config, host scope, or vault
 * shape throws synchronously before any vault operation.
 */
export function createVaultStateKeyProvider(
	config: VaultStateKeyProviderConfig,
): VaultStateKeyProvider {
	if (!isConfig(config) || !isVault(config.vault)) {
		throw new VaultStateKeyError("invalid-input");
	}
	const hostScopeBytes = encodeHostScope(config.hostScope);
	const account = createHash("sha256")
		.update(UTF8_ENCODER.encode(ACCOUNT_PREFIX))
		.update(hostScopeBytes)
		.digest("hex");
	return new VaultStateKeyProviderImpl(
		config.vault,
		Object.freeze({ service: STATE_KEY_VAULT_SERVICE, account }),
	);
}
