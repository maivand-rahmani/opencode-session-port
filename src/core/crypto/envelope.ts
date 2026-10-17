/**
 * PROVISIONAL SessionPort artifact envelope (format assumptions only).
 *
 * ============================ NOT FROZEN ============================
 * The exact artifact header layout, framing, AAD construction, and format
 * versioning are OPEN (O-02) and this module is a minimal, isolated,
 * provisional versioned envelope built only so the container can round-trip
 * under tests. Do not treat these bytes as a published/frozen format, do not
 * write compatibility claims against them, and resolve the format question
 * with the owner/Oracle Gate 2 before any release.
 * ===================================================================
 *
 * Every format-level assumption lives in this one module so the rest of the
 * crypto code does not bake in framing details.
 *
 * Provisional layout (all integers big-endian where relevant):
 *
 *   offset  size  field
 *   0       8     magic "SESSPORT"
 *   8       1     format version (1)
 *   9       1     KDF algorithm id (2 = crypto_pwhash_ALG_ARGON2ID13)
 *   10      1     allow-listed KDF profile code (1..255)
 *   11      1     cipher id (1 = XChaCha20-Poly1305 secretstream)
 *   12      1     compression id (1 = gzip, RFC 1952)
 *   13      1     flags (0; any other value rejected)
 *   14      2     reserved (0; any other value rejected)
 *   16      16    per-artifact Argon2id salt (must equal crypto_pwhash_SALTBYTES)
 *   32      16    per-artifact identity (O-22; random, authenticated, not secret)
 *   48      24    secretstream header (crypto_secretstream_xchacha20poly1305_HEADERBYTES)
 *   72      ..    frames: uint32 BE ciphertext byte length, then ciphertext
 *
 * The owner-selected O-22 identity was appended at offset 32, preserving every
 * prior field offset; the fixed header length therefore changed from 32 to 48
 * bytes. This is a PROVISIONAL layout change, not a backward-compatibility
 * decision: no artifact format has been frozen or released, so no
 * compatibility with any prior provisional bytes is claimed or required.
 *
 * Each frame's AAD is: full 48-byte envelope header || uint32 BE frame
 * sequence (starting at 0) || uint32 BE ciphertext byte length. This binds the
 * header — including the identity — ordering, and framing lengths to the
 * authenticated ciphertext, so tampering with any identity byte fails
 * authentication.
 *
 * Only a valid secretstream final tag terminates a well-formed artifact.
 */
import { ARTIFACT_IDENTITY_BYTES } from "../contracts/crypto.ts";
import { CryptoContainerError } from "./errors.ts";

/** ASCII "SESSPORT" — provisional magic bytes. */
export const ENVELOPE_MAGIC = Uint8Array.from([0x53, 0x45, 0x53, 0x53, 0x50, 0x4f, 0x52, 0x54]);

/** Provisional envelope format version. Unknown versions must be rejected. */
export const ENVELOPE_FORMAT_VERSION = 1;

export const ENVELOPE_HEADER_FLAGS_OFFSET = 13;
export const ENVELOPE_HEADER_RESERVED_OFFSET = 14;
export const ENVELOPE_HEADER_SALT_OFFSET = 16;
export const ENVELOPE_HEADER_SALT_BYTES = 16;
/** O-22 identity appended after the salt; placement remains PROVISIONAL (O-02). */
export const ENVELOPE_IDENTITY_OFFSET = 32;
export const ENVELOPE_IDENTITY_BYTES = ARTIFACT_IDENTITY_BYTES;
/** Fixed header: metadata, salt (16..31), and identity (32..47). */
export const ENVELOPE_HEADER_BYTES = ENVELOPE_IDENTITY_OFFSET + ENVELOPE_IDENTITY_BYTES;
export const ENVELOPE_PROFILE_CODE_MIN = 1;
export const ENVELOPE_PROFILE_CODE_MAX = 255;

/**
 * Wire algorithm ids are fixed by the provisional format and validated
 * against the pinned runtime during factory construction. They are not
 * per-artifact tunables and never select implementation behavior.
 */
export const ENVELOPE_KDF_ARGON2ID13 = 2;
export const ENVELOPE_CIPHER_SECRETSTREAM_XCHACHA20POLY1305 = 1;
export const ENVELOPE_COMPRESSION_GZIP = 1;
export const ENVELOPE_FLAGS_NONE = 0;

/** Must equal crypto_secretstream_xchacha20poly1305_HEADERBYTES (asserted at runtime). */
export const ENVELOPE_SECRETSTREAM_HEADER_BYTES = 24;
/** Must equal crypto_secretstream_xchacha20poly1305_ABYTES (asserted at runtime). */
export const ENVELOPE_FRAME_OVERHEAD_BYTES = 17;

export const FRAME_LENGTH_BYTES = 4;
export const FRAME_MAX_CIPHERTEXT_BYTES = 0xffffffff;
export const FRAME_AAD_BYTES = ENVELOPE_HEADER_BYTES + 8;

export interface EnvelopeHeaderFields {
	readonly profileCode: number;
	/** Per-artifact KDF salt; copied. */
	readonly salt: Uint8Array;
	/** Per-artifact O-22 identity; must be exactly `ARTIFACT_IDENTITY_BYTES`; copied. */
	readonly artifactIdentity: Uint8Array;
}

export interface DecodedEnvelopeHeader {
	readonly profileCode: number;
	/** Copy owned by the caller; clear with best-effort zeroing once used. */
	readonly salt: Uint8Array;
	/**
	 * Caller-owned copy of the authenticated identity bytes. Opaque, public
	 * (not secret); the caller must not mutate the returned copy.
	 */
	readonly artifactIdentity: Uint8Array;
}

function invalidHeader(message: string): never {
	throw new CryptoContainerError("invalid-header", message);
}

/** Encodes a fresh 48-byte envelope header. Ownership transfers to the caller. */
export function encodeEnvelopeHeader(fields: EnvelopeHeaderFields): Uint8Array {
	const { profileCode, salt, artifactIdentity } = fields;
	if (
		!Number.isSafeInteger(profileCode) ||
		profileCode < ENVELOPE_PROFILE_CODE_MIN ||
		profileCode > ENVELOPE_PROFILE_CODE_MAX
	) {
		invalidHeader("policy profile code is outside the encodable range");
	}
	if (!(salt instanceof Uint8Array) || salt.length !== ENVELOPE_HEADER_SALT_BYTES) {
		invalidHeader("KDF salt must be exactly the envelope salt size");
	}
	if (!(artifactIdentity instanceof Uint8Array) || artifactIdentity.length !== ENVELOPE_IDENTITY_BYTES) {
		invalidHeader("artifact identity must be exactly the envelope identity size");
	}
	const out = new Uint8Array(ENVELOPE_HEADER_BYTES);
	out.set(ENVELOPE_MAGIC, 0);
	out[8] = ENVELOPE_FORMAT_VERSION;
	out[9] = ENVELOPE_KDF_ARGON2ID13;
	out[10] = profileCode;
	out[11] = ENVELOPE_CIPHER_SECRETSTREAM_XCHACHA20POLY1305;
	out[12] = ENVELOPE_COMPRESSION_GZIP;
	out[13] = ENVELOPE_FLAGS_NONE;
	out[14] = 0;
	out[15] = 0;
	out.set(salt, ENVELOPE_HEADER_SALT_OFFSET);
	out.set(artifactIdentity, ENVELOPE_IDENTITY_OFFSET);
	return out;
}

/**
 * Strictly decodes and pre-validates an envelope header. Rejects wrong magic,
 * unknown versions/algorithms, and any nonzero flag/reserved byte. Does NOT
 * resolve the profile code; the caller must resolve it through an allow-list
 * before any KDF work.
 */
export function decodeEnvelopeHeader(bytes: Uint8Array): DecodedEnvelopeHeader {
	if (!(bytes instanceof Uint8Array) || bytes.length !== ENVELOPE_HEADER_BYTES) {
		invalidHeader("envelope header must be exactly the fixed header size");
	}
	for (let index = 0; index < ENVELOPE_MAGIC.length; index += 1) {
		if (bytes[index] !== ENVELOPE_MAGIC[index]) invalidHeader("unrecognized artifact magic");
	}
	if (bytes[8] !== ENVELOPE_FORMAT_VERSION) {
		throw new CryptoContainerError("unsupported-format-version", "unsupported artifact format version");
	}
	if (bytes[9] !== ENVELOPE_KDF_ARGON2ID13) {
		throw new CryptoContainerError("unsupported-algorithm", "unsupported KDF algorithm id");
	}
	if (bytes[11] !== ENVELOPE_CIPHER_SECRETSTREAM_XCHACHA20POLY1305) {
		throw new CryptoContainerError("unsupported-algorithm", "unsupported cipher id");
	}
	if (bytes[12] !== ENVELOPE_COMPRESSION_GZIP) {
		throw new CryptoContainerError("unsupported-algorithm", "unsupported compression id");
	}
	if (bytes[ENVELOPE_HEADER_FLAGS_OFFSET] !== ENVELOPE_FLAGS_NONE) invalidHeader("unknown header flags are not allowed");
	if (bytes[ENVELOPE_HEADER_RESERVED_OFFSET] !== 0 || bytes[ENVELOPE_HEADER_RESERVED_OFFSET + 1] !== 0) {
		invalidHeader("nonzero reserved header bytes are not allowed");
	}
	return {
		profileCode: bytes[10]!,
		salt: bytes.slice(ENVELOPE_HEADER_SALT_OFFSET, ENVELOPE_HEADER_SALT_OFFSET + ENVELOPE_HEADER_SALT_BYTES),
		artifactIdentity: bytes.slice(
			ENVELOPE_IDENTITY_OFFSET,
			ENVELOPE_IDENTITY_OFFSET + ENVELOPE_IDENTITY_BYTES,
		),
	};
}

function requireUint32(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > FRAME_MAX_CIPHERTEXT_BYTES) {
		throw new CryptoContainerError("invalid-frame", `${field} is outside the uint32 framing range`);
	}
	return value;
}

/** Builds a 4-byte BE frame ciphertext-length prefix. */
export function encodeFrameLengthPrefix(ciphertextBytes: number): Uint8Array {
	const out = new Uint8Array(FRAME_LENGTH_BYTES);
	new DataView(out.buffer).setUint32(0, requireUint32(ciphertextBytes, "frame ciphertext length"), false);
	return out;
}

/** Reads a 4-byte BE frame ciphertext-length prefix. */
export function decodeFrameLength(prefix: Uint8Array): number {
	if (!(prefix instanceof Uint8Array) || prefix.length !== FRAME_LENGTH_BYTES) {
		throw new CryptoContainerError("invalid-frame", "frame length prefix must be exactly four bytes");
	}
	return new DataView(prefix.buffer, prefix.byteOffset, FRAME_LENGTH_BYTES).getUint32(0, false);
}

/** Encodes a frame prefix plus ciphertext into one fresh buffer. */
export function encodeFrame(ciphertext: Uint8Array): Uint8Array {
	if (!(ciphertext instanceof Uint8Array)) {
		throw new CryptoContainerError("cipher-failure", "ciphertext must be a byte array");
	}
	const out = new Uint8Array(FRAME_LENGTH_BYTES + ciphertext.length);
	out.set(encodeFrameLengthPrefix(ciphertext.length), 0);
	out.set(ciphertext, FRAME_LENGTH_BYTES);
	return out;
}

/**
 * AAD for one secretstream frame: envelope header || frame sequence ||
 * ciphertext length. Both sides must construct this identically.
 */
export function buildFrameAad(
	envelopeHeader: Uint8Array,
	sequence: number,
	ciphertextBytes: number,
): Uint8Array {
	if (!(envelopeHeader instanceof Uint8Array) || envelopeHeader.length !== ENVELOPE_HEADER_BYTES) {
		throw new CryptoContainerError("invalid-header", "AAD requires the full fixed envelope header");
	}
	requireUint32(sequence, "frame sequence");
	requireUint32(ciphertextBytes, "frame ciphertext length");
	const aad = new Uint8Array(FRAME_AAD_BYTES);
	aad.set(envelopeHeader, 0);
	const view = new DataView(aad.buffer);
	view.setUint32(ENVELOPE_HEADER_BYTES, sequence, false);
	view.setUint32(ENVELOPE_HEADER_BYTES + 4, ciphertextBytes, false);
	return aad;
}
