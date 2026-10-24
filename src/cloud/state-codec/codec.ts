/**
 * Selected production local-state authenticated-encryption codec (V2).
 *
 * Decision: `docs/V2/SECURITY.md` section 5.1 (2026-10-25) — a separate raw
 * 32-byte state key, libsodium XChaCha20-Poly1305 (IETF), a fresh 24-byte nonce
 * per seal, and AAD binding the host scope plus the fixed purpose/version.
 *
 * Status boundary: this is the selected crypto and envelope format, but it is
 * NOT yet wired into the product. This module writes no files, performs no
 * network or vault access, and makes no power-loss/durability, secure-deletion,
 * backup, or platform-support claim.
 *
 * Envelope bytes (max plaintext 67,108,864; max envelope 67,108,909):
 *   magic "SPST" (4 bytes) | version 0x01 (1) | nonce (24) | ciphertext+tag
 * Header = the first 29 bytes (magic | version | nonce).
 * AAD = the 29-byte header, then three U32BE length-prefixed UTF-8 fields:
 *   purpose "sessionport-local-state", version "1", and the exact host scope.
 *
 * Ownership/zeroing: the caller's key is never modified or retained; a private
 * 32-byte copy is best-effort zeroed after every operation. Caller plaintext is
 * borrowed and never modified or zeroed. Decrypted plaintext returned by
 * `open` is a fresh caller-owned buffer that the codec neither retains nor
 * clears. Module-owned AAD/scope copies are best-effort zeroed in `finally`.
 * This is not a secure-deletion guarantee.
 */
import sodium from "libsodium-wrappers-sumo";
import type { AuthenticatedStateCodec, StateCodecContext } from "../state/types.ts";
import { bestEffortZero } from "../../core/crypto/zero.ts";
import { StateCodecError } from "./errors.ts";

/** ASCII envelope magic selected by the 2026-10-25 decision. */
export const STATE_CODEC_MAGIC = "SPST";
/** Envelope version byte; also the required context `formatVersion`. */
export const STATE_CODEC_VERSION = 1;
/** Fixed purpose bound into the AAD. */
export const STATE_CODEC_PURPOSE = "sessionport-local-state";
/** Human-readable version text bound into the AAD. */
export const STATE_CODEC_VERSION_FIELD = "1";
/** Raw state-key length; the key is separate from auth credentials. */
export const STATE_CODEC_KEY_BYTES = 32;
/** XChaCha20-Poly1305 nonce length. */
export const STATE_CODEC_NONCE_BYTES = 24;
/** XChaCha20-Poly1305 authentication tag length. */
export const STATE_CODEC_TAG_BYTES = 16;
/** Magic (4) + version (1) + nonce (24); also the exact AAD prefix length. */
export const STATE_CODEC_HEADER_BYTES = 29;
/** Header (29) + tag (16). */
export const STATE_CODEC_ENVELOPE_OVERHEAD_BYTES = 45;
/** Minimum valid envelope: empty plaintext plus header and tag. */
export const STATE_CODEC_MIN_ENVELOPE_BYTES = 45;
/** Maximum accepted/emitted plaintext bytes (64 MiB). */
export const STATE_CODEC_MAX_PLAINTEXT_BYTES = 67_108_864;
/** Maximum accepted/emitted envelope bytes (64 MiB + 45). */
export const STATE_CODEC_MAX_ENVELOPE_BYTES = 67_108_909;
/** Maximum exact host-scope size in UTF-8 bytes. */
export const STATE_CODEC_MAX_SCOPE_BYTES = 512;

const TEXT_ENCODER = new TextEncoder();
const MAGIC_BYTES = TEXT_ENCODER.encode(STATE_CODEC_MAGIC);
const VERSION_OFFSET = MAGIC_BYTES.length;
const NONCE_OFFSET = VERSION_OFFSET + 1;
const BODY_OFFSET = STATE_CODEC_HEADER_BYTES;
const PURPOSE_BYTES = TEXT_ENCODER.encode(STATE_CODEC_PURPOSE);
const VERSION_FIELD_BYTES = TEXT_ENCODER.encode(STATE_CODEC_VERSION_FIELD);

if (
	STATE_CODEC_HEADER_BYTES !== MAGIC_BYTES.length + 1 + STATE_CODEC_NONCE_BYTES ||
	STATE_CODEC_ENVELOPE_OVERHEAD_BYTES !== STATE_CODEC_HEADER_BYTES + STATE_CODEC_TAG_BYTES ||
	STATE_CODEC_MIN_ENVELOPE_BYTES !== STATE_CODEC_ENVELOPE_OVERHEAD_BYTES ||
	STATE_CODEC_MAX_ENVELOPE_BYTES !== STATE_CODEC_MAX_PLAINTEXT_BYTES + STATE_CODEC_ENVELOPE_OVERHEAD_BYTES
) {
	throw new StateCodecError("codec-failure");
}

let sodiumReady: Promise<void> | undefined;

/**
 * Awaits `sodium.ready` once per module instance and asserts the exact AEAD
 * primitives/constants this format requires. Mismatches fail closed with a
 * redacted codec error; no runtime detail is attached.
 */
function requireSodiumReady(): Promise<void> {
	sodiumReady ??= (async () => {
		try {
			await sodium.ready;
			if (
				typeof sodium.crypto_aead_xchacha20poly1305_ietf_encrypt !== "function" ||
				typeof sodium.crypto_aead_xchacha20poly1305_ietf_decrypt !== "function" ||
				typeof sodium.randombytes_buf !== "function" ||
				typeof sodium.memzero !== "function" ||
				sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES !== STATE_CODEC_KEY_BYTES ||
				sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES !== STATE_CODEC_NONCE_BYTES ||
				sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES !== STATE_CODEC_TAG_BYTES ||
				sodium.crypto_aead_xchacha20poly1305_ietf_NSECBYTES !== 0
			) {
				throw new StateCodecError("codec-failure");
			}
		} catch (error) {
			throw error instanceof StateCodecError ? error : new StateCodecError("codec-failure");
		}
	})();
	return sodiumReady;
}

function invalidContext(): StateCodecError {
	return new StateCodecError("invalid-context");
}

/**
 * Validates and UTF-8 encodes a host scope without normalization.
 *
 * Accepted: nonempty strings of at most 512 UTF-8 bytes with well-formed
 * Unicode. Rejected: unpaired surrogates and U+0000–U+001F / U+007F controls.
 * The returned bytes are a fresh copy owned by the caller.
 */
export function validateStateScope(scope: string): Uint8Array {
	if (typeof scope !== "string" || scope.length === 0) throw invalidContext();
	for (let index = 0; index < scope.length; index += 1) {
		const unit = scope.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = scope.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalidContext();
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			throw invalidContext();
		} else if (unit <= 0x1f || unit === 0x7f) {
			throw invalidContext();
		}
	}
	const bytes = TEXT_ENCODER.encode(scope);
	if (bytes.length === 0 || bytes.length > STATE_CODEC_MAX_SCOPE_BYTES) throw invalidContext();
	return bytes;
}

function requireScope(context: StateCodecContext): Uint8Array {
	try {
		const candidate: unknown = context;
		if (candidate === null || typeof candidate !== "object") throw invalidContext();
		const fields = candidate as Partial<StateCodecContext>;
		if (fields.purpose !== STATE_CODEC_PURPOSE) throw invalidContext();
		if (fields.formatVersion !== STATE_CODEC_VERSION) throw invalidContext();
		return validateStateScope(fields.hostScope as string);
	} catch (error) {
		throw error instanceof StateCodecError ? error : invalidContext();
	}
}

function copyKey(key: Uint8Array): Uint8Array {
	if (!(key instanceof Uint8Array) || key.length !== STATE_CODEC_KEY_BYTES) {
		throw new StateCodecError("invalid-key");
	}
	const copy = new Uint8Array(STATE_CODEC_KEY_BYTES);
	copy.set(key);
	return copy;
}

function requirePlaintext(plaintext: Uint8Array): Uint8Array {
	if (!(plaintext instanceof Uint8Array)) throw new StateCodecError("invalid-input");
	if (plaintext.length > STATE_CODEC_MAX_PLAINTEXT_BYTES) throw new StateCodecError("state-too-large");
	return plaintext;
}

function requireEnvelope(ciphertext: Uint8Array): Uint8Array {
	if (!(ciphertext instanceof Uint8Array)) throw new StateCodecError("invalid-input");
	if (ciphertext.length < STATE_CODEC_MIN_ENVELOPE_BYTES) throw new StateCodecError("state-corrupt");
	if (ciphertext.length > STATE_CODEC_MAX_ENVELOPE_BYTES) throw new StateCodecError("state-too-large");
	for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
		if (ciphertext[index] !== MAGIC_BYTES[index]) throw new StateCodecError("state-corrupt");
	}
	if (ciphertext[VERSION_OFFSET] !== STATE_CODEC_VERSION) {
		throw new StateCodecError("unsupported-version");
	}
	return ciphertext;
}

function buildAad(header: Uint8Array, scopeBytes: Uint8Array): Uint8Array {
	const aad = new Uint8Array(
		STATE_CODEC_HEADER_BYTES +
			4 +
			PURPOSE_BYTES.length +
			4 +
			VERSION_FIELD_BYTES.length +
			4 +
			scopeBytes.length,
	);
	aad.set(header, 0);
	const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
	let offset = STATE_CODEC_HEADER_BYTES;
	for (const field of [PURPOSE_BYTES, VERSION_FIELD_BYTES, scopeBytes]) {
		view.setUint32(offset, field.length, false);
		aad.set(field, offset + 4);
		offset += 4 + field.length;
	}
	if (offset !== aad.length) throw new StateCodecError("codec-failure");
	return aad;
}

function asCodecFailure(error: unknown): StateCodecError {
	return error instanceof StateCodecError ? error : new StateCodecError("codec-failure");
}

async function seal(
	plaintext: Uint8Array,
	key: Uint8Array,
	context: StateCodecContext,
): Promise<Uint8Array> {
	await requireSodiumReady();
	requirePlaintext(plaintext);
	const scopeBytes = requireScope(context);
	const keyCopy = copyKey(key);
	let aad: Uint8Array | undefined;
	try {
		// Sized once: header + plaintext + tag. No growing/concatenating copies.
		const envelope = new Uint8Array(STATE_CODEC_ENVELOPE_OVERHEAD_BYTES + plaintext.length);
		envelope.set(MAGIC_BYTES, 0);
		envelope[VERSION_OFFSET] = STATE_CODEC_VERSION;
		const nonce = sodium.randombytes_buf(STATE_CODEC_NONCE_BYTES);
		if (!(nonce instanceof Uint8Array) || nonce.length !== STATE_CODEC_NONCE_BYTES) {
			throw new StateCodecError("codec-failure");
		}
		envelope.set(nonce, NONCE_OFFSET);
		aad = buildAad(envelope.subarray(0, STATE_CODEC_HEADER_BYTES), scopeBytes);
		const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			plaintext,
			aad,
			null,
			nonce,
			keyCopy,
		);
		if (
			!(ciphertext instanceof Uint8Array) ||
			ciphertext.length !== plaintext.length + STATE_CODEC_TAG_BYTES
		) {
			if (ciphertext instanceof Uint8Array) bestEffortZero(ciphertext);
			throw new StateCodecError("codec-failure");
		}
		envelope.set(ciphertext, BODY_OFFSET);
		bestEffortZero(ciphertext);
		return envelope;
	} catch (error) {
		throw asCodecFailure(error);
	} finally {
		bestEffortZero(keyCopy);
		if (aad !== undefined) bestEffortZero(aad);
		bestEffortZero(scopeBytes);
	}
}

async function open(
	ciphertext: Uint8Array,
	key: Uint8Array,
	context: StateCodecContext,
): Promise<Uint8Array> {
	await requireSodiumReady();
	requireEnvelope(ciphertext);
	const scopeBytes = requireScope(context);
	const keyCopy = copyKey(key);
	let aad: Uint8Array | undefined;
	try {
		aad = buildAad(ciphertext.subarray(0, STATE_CODEC_HEADER_BYTES), scopeBytes);
		let plaintext: Uint8Array;
		try {
			plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
				null,
				ciphertext.subarray(BODY_OFFSET),
				aad,
				ciphertext.subarray(NONCE_OFFSET, BODY_OFFSET),
				keyCopy,
			);
		} catch {
			// Authentication failures and any wrapper-level decryption error are
			// indistinguishable to callers; never attach the underlying cause.
			throw new StateCodecError("state-corrupt");
		}
		if (
			!(plaintext instanceof Uint8Array) ||
			plaintext.length !== ciphertext.length - STATE_CODEC_ENVELOPE_OVERHEAD_BYTES
		) {
			if (plaintext instanceof Uint8Array) bestEffortZero(plaintext);
			throw new StateCodecError("state-corrupt");
		}
		return plaintext;
	} catch (error) {
		throw asCodecFailure(error);
	} finally {
		bestEffortZero(keyCopy);
		if (aad !== undefined) bestEffortZero(aad);
		bestEffortZero(scopeBytes);
	}
}

/**
 * Creates the selected local-state codec. There is deliberately no
 * configuration/default policy parameter: the format, caps, and namespace are
 * fixed by the 2026-10-25 decision. Sodium readiness is awaited once per
 * process and reused.
 */
export function createAuthenticatedStateCodec(): AuthenticatedStateCodec {
	return Object.freeze({
		seal,
		open,
	});
}
