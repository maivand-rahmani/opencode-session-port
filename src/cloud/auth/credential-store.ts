/**
 * Vault-backed native credential store.
 *
 * The caller supplies one exact `SecureVault` entry. Only the versioned
 * credential JSON below is ever passed to the OS vault as UTF-8 bytes; this
 * module has no file, environment, memory, or plaintext fallback, no vault
 * enumeration, and no account-root, passphrase, or crypto-format handling.
 *
 * A per-instance queue serializes reads, writes, and removal. That is a
 * single-writer contract for one process only; there is no cross-process lock
 * and no invented atomic file replacement.
 */
import { VaultError, validateVaultEntry } from "../vault/types.ts";
import type {
	SecureVault,
	VaultEntry,
} from "../vault/types.ts";
import {
	CREDENTIAL_STORE_VERSION,
	isPlainRecord,
	NativeAuthError,
	readTokenCredential,
} from "./types.ts";
import type {
	NativeCredentialStorePort,
	StoredCredentialState,
	TokenCredential,
} from "./types.ts";

export interface CredentialStoreConfig {
	/** Injected bytes-only adapter; this module never loads a native keyring. */
	readonly vault: SecureVault;
	/** Exact caller-selected service/account namespace. */
	readonly entry: VaultEntry;
	/** Required caller ceiling for the serialized UTF-8 credential bytes. */
	readonly maxCredentialBytes: number;
}

const READY_KEYS = [
	"version",
	"state",
	"accessToken",
	"refreshToken",
	"accessExpiresAtMillis",
	"scope",
] as const;

const MARKER_KEYS = ["version", "state"] as const;
const UTF8_DECODER = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true,
});

/**
 * Concrete store over an injected `SecureVault`. No native binding is imported
 * or selected here.
 */
export class CredentialStore implements NativeCredentialStorePort {
	private readonly vault: SecureVault;
	private readonly entry: VaultEntry;
	private readonly maxCredentialBytes: number;
	private tail: Promise<void> = Promise.resolve();

	constructor(config: CredentialStoreConfig) {
		if (!isPlainRecord(config)) {
			throw new NativeAuthError("invalid-input");
		}
		if (!isVault(config.vault)) {
			throw new NativeAuthError("invalid-input");
		}
		if (
			typeof config.maxCredentialBytes !== "number" ||
			!Number.isSafeInteger(config.maxCredentialBytes) ||
			config.maxCredentialBytes <= 0
		) {
			throw new NativeAuthError("invalid-input");
		}

		let entry: VaultEntry;
		try {
			entry = validateVaultEntry(config.entry);
		} catch {
			throw new NativeAuthError("invalid-input");
		}

		this.vault = config.vault;
		this.entry = Object.freeze({
			service: entry.service,
			account: entry.account,
		});
		this.maxCredentialBytes = config.maxCredentialBytes;
	}

	/** Reads and strictly validates the exact entry; `null` means absent. */
	read(): Promise<StoredCredentialState | null> {
		return this.enqueue(async () => {
			let bytes: Uint8Array | null;
			try {
				bytes = await this.vault.read(this.entry);
			} catch (error) {
				return mapVaultFailure(error, "read");
			}

			if (bytes === null) return null;
			if (!(bytes instanceof Uint8Array)) {
				throw new NativeAuthError("credential-corrupt");
			}
			if (
				bytes.byteLength === 0 ||
				bytes.byteLength > this.maxCredentialBytes
			) {
				throw new NativeAuthError("credential-corrupt");
			}
			return parseStoredCredential(bytes);
		});
	}

	/**
	 * Validates and copies a credential, then commits it as one ready-state
	 * vault write. Validation and serialization happen before the first await,
	 * so later caller mutation cannot change the bytes being written.
	 */
	async writeReady(credential: TokenCredential): Promise<void> {
		const copy = readTokenCredential(credential, "invalid-input");
		const bytes = this.serialize({
			version: CREDENTIAL_STORE_VERSION,
			state: "ready",
			accessToken: copy.accessToken,
			refreshToken: copy.refreshToken,
			accessExpiresAtMillis: copy.accessExpiresAtMillis,
			scope: copy.scope,
		});
		await this.writeSerialized(bytes);
	}

	/**
	 * Replaces the ready state with the attempt marker before any refresh HTTP
	 * request can be sent. A crash or lost reply leaves this marker in place.
	 */
	async markRefreshUncertain(): Promise<void> {
		const bytes = this.serialize({
			version: CREDENTIAL_STORE_VERSION,
			state: "refresh-uncertain",
		});
		await this.writeSerialized(bytes);
	}

	/** Replaces uncertain state after a deterministic credential failure. */
	async markUnauthorized(): Promise<void> {
		const bytes = this.serialize({
			version: CREDENTIAL_STORE_VERSION,
			state: "unauthorized",
		});
		await this.writeSerialized(bytes);
	}

	/**
	 * Removes only the exact configured entry. A false result means it was
	 * already absent. No other entry is inspected or removed.
	 */
	remove(): Promise<boolean> {
		return this.enqueue(async () => {
			try {
				return await this.vault.remove(this.entry);
			} catch (error) {
				return mapVaultFailure(error, "remove");
			}
		});
	}

	private serialize(value: unknown): Uint8Array {
		let json: string;
		try {
			json = JSON.stringify(value);
		} catch {
			throw new NativeAuthError("invalid-input");
		}
		const bytes = new TextEncoder().encode(json);
		if (bytes.byteLength > this.maxCredentialBytes) {
			throw new NativeAuthError("too-large");
		}
		return bytes;
	}

	private writeSerialized(bytes: Uint8Array): Promise<void> {
		return this.enqueue(async () => {
			try {
				await this.vault.write(this.entry, bytes);
			} catch (error) {
				return mapVaultFailure(error, "write");
			}
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		const current = previous.then(operation, operation);
		this.tail = current.then(
			() => undefined,
			() => undefined,
		);
		return current;
	}
}

function isVault(value: unknown): value is SecureVault {
	return (
		isPlainRecord(value) &&
		typeof value.read === "function" &&
		typeof value.write === "function" &&
		typeof value.remove === "function"
	);
}

function hasExactKeys(
	record: Record<string, unknown>,
	required: readonly string[],
): boolean {
	const actual = Object.keys(record);
	return (
		actual.length === required.length &&
		required.every((key) => Object.hasOwn(record, key))
	);
}

function parseStoredCredential(bytes: Uint8Array): StoredCredentialState {
	let text: string;
	try {
		text = UTF8_DECODER.decode(bytes);
	} catch {
		throw new NativeAuthError("credential-corrupt");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new NativeAuthError("credential-corrupt");
	}

	if (!isPlainRecord(parsed)) {
		throw new NativeAuthError("credential-corrupt");
	}
	if (parsed.version !== CREDENTIAL_STORE_VERSION) {
		throw new NativeAuthError("credential-corrupt");
	}

	if (parsed.state === "ready") {
		if (!hasExactKeys(parsed, READY_KEYS)) {
			throw new NativeAuthError("credential-corrupt");
		}
		const credential = readTokenCredential(
			{
				accessToken: parsed.accessToken,
				refreshToken: parsed.refreshToken,
				accessExpiresAtMillis: parsed.accessExpiresAtMillis,
				scope: parsed.scope,
			},
			"credential-corrupt",
		);
		return Object.freeze({
			version: CREDENTIAL_STORE_VERSION,
			state: "ready",
			accessToken: credential.accessToken,
			refreshToken: credential.refreshToken,
			accessExpiresAtMillis: credential.accessExpiresAtMillis,
			scope: credential.scope,
		});
	}

	if (
		parsed.state === "refresh-uncertain" ||
		parsed.state === "unauthorized"
	) {
		if (!hasExactKeys(parsed, MARKER_KEYS)) {
			throw new NativeAuthError("credential-corrupt");
		}
		return Object.freeze({
			version: CREDENTIAL_STORE_VERSION,
			state: parsed.state,
		});
	}

	throw new NativeAuthError("credential-corrupt");
}

function mapVaultFailure(
	error: unknown,
	operation: "read" | "write" | "remove",
): never {
	if (error instanceof VaultError) {
		switch (error.code) {
			case "invalid-input":
				throw new NativeAuthError("invalid-input");
			case "too-large":
				throw new NativeAuthError("too-large");
			case "aborted":
				throw new NativeAuthError("aborted");
			case "unsupported-platform":
			case "unavailable":
				throw new NativeAuthError("credential-unavailable");
			case "invalid-native-response":
				throw new NativeAuthError("credential-corrupt");
			case "outcome-uncertain":
				throw new NativeAuthError(
					operation === "read"
						? "credential-unavailable"
						: "write-outcome-uncertain",
				);
		}
	}

	throw new NativeAuthError(
		operation === "read"
			? "credential-unavailable"
			: "write-outcome-uncertain",
	);
}
