/**
 * Password KDF boundary for the provisional crypto container.
 *
 * Pinned `libsodium-wrappers-sumo@0.8.4` default ESM import + `await
 * sodium.ready` (Phase 1 evidence: runtime named exports are not populated;
 * the default object is).
 *
 * IMPORTANT (Oracle Gate 1 condition): the `seal`/`openAndStage` Promise
 * boundary permits asynchronous execution but does NOT promise a nonblocking
 * KDF. `crypto_pwhash` is synchronous and may block the event loop. Do not
 * assume worker support and do not wire this into the TUI until the latency
 * and execution strategy are measured (O-21 / O-19 follow-up).
 */
import sodium from "libsodium-wrappers-sumo";
import {
	ENVELOPE_FRAME_OVERHEAD_BYTES,
	ENVELOPE_KDF_ARGON2ID13,
	ENVELOPE_HEADER_SALT_BYTES,
	ENVELOPE_SECRETSTREAM_HEADER_BYTES,
} from "./envelope.ts";
import { CryptoContainerError } from "./errors.ts";
import type { CryptoPolicyDefinition } from "./policy.ts";

/** Derives the 32-byte secretstream key from raw password bytes and a salt. */
export interface PasswordKeyDerivation {
	deriveKey(definition: CryptoPolicyDefinition, password: Uint8Array, salt: Uint8Array): Uint8Array;
}

function unsupported(detail: string): never {
	throw new CryptoContainerError("unsupported-runtime", `unsupported libsodium runtime: ${detail}`);
}

/**
 * Awaits `sodium.ready` and asserts that every primitive/constant this module
 * relies on matches the provisional format assumptions. A mismatch fails
 * closed instead of silently using an unvalidated layout.
 */
export async function requireSupportedSodiumRuntime(): Promise<void> {
	await sodium.ready;

	const requiredFunctions = [
		"crypto_pwhash",
		"crypto_secretstream_xchacha20poly1305_init_push",
		"crypto_secretstream_xchacha20poly1305_init_pull",
		"crypto_secretstream_xchacha20poly1305_push",
		"crypto_secretstream_xchacha20poly1305_pull",
		"randombytes_buf",
		"memzero",
		// O-22: remapped-ID derivation hashes with BLAKE2b-256 through
		// `crypto_generichash`; a runtime without it must fail closed.
		"crypto_generichash",
	] as const;
	for (const name of requiredFunctions) {
		if (typeof sodium[name] !== "function") unsupported(`missing function ${name}`);
	}

	if (sodium.crypto_pwhash_ALG_ARGON2ID13 !== ENVELOPE_KDF_ARGON2ID13) {
		unsupported("Argon2id algorithm id does not match the provisional format");
	}
	if (sodium.crypto_pwhash_SALTBYTES !== ENVELOPE_HEADER_SALT_BYTES) {
		unsupported("crypto_pwhash salt size does not match the provisional format");
	}
	if (sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES !== ENVELOPE_SECRETSTREAM_HEADER_BYTES) {
		unsupported("secretstream header size does not match the provisional format");
	}
	if (sodium.crypto_secretstream_xchacha20poly1305_ABYTES !== ENVELOPE_FRAME_OVERHEAD_BYTES) {
		unsupported("secretstream ciphertext overhead does not match the provisional format");
	}
	if (sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES !== 32) {
		unsupported("secretstream key size does not match the provisional format");
	}
	if (sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE !== 0) {
		unsupported("secretstream message tag does not match the provisional format");
	}
	if (sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL !== 3) {
		unsupported("secretstream final tag does not match the provisional format");
	}
	// The pinned wrappers report crypto_pwhash_BYTES_MAX as a negative sentinel,
	// so only the lower bound is checked here.
	if (sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES < sodium.crypto_pwhash_BYTES_MIN) {
		unsupported("secretstream key size is below the crypto_pwhash output minimum");
	}
}

/**
 * Default derivation: Argon2id via `crypto_pwhash` with the definition's
 * allow-listed costs. The returned key is owned by the caller and must be
 * best-effort zeroed after the secretstream state is initialized.
 */
export const sodiumArgon2idDerivation: PasswordKeyDerivation = {
	deriveKey(definition, password, salt) {
		return sodium.crypto_pwhash(
			sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
			password,
			salt,
			definition.kdf.opsLimit,
			definition.kdf.memLimit,
			sodium.crypto_pwhash_ALG_ARGON2ID13,
		);
	},
};
