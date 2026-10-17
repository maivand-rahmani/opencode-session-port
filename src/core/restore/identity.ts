/**
 * PROVISIONAL per-artifact remapped-ID derivation (owner-selected O-22 scheme).
 *
 * ============================ NOT FROZEN ============================
 * On 2026-10-09 the owner selected the scheme for implementation: remapped
 * IDs are derived with BLAKE2b-256 (via the pinned
 * `libsodium-wrappers-sumo@0.8.4` `crypto_generichash`) over a versioned,
 * namespace-separated, unambiguously length-prefixed tuple of the artifact
 * identity and the original ID, encoded as `ses_` + 64 lowercase hex for
 * sessions and `msg_` + 64 lowercase hex for messages. The exact byte layout
 * below is a PROVISIONAL, versioned encoding fixed only for this
 * implementation so tests can pin it. It is not a released format, carries no
 * backward-compatibility promise, and makes no host/runtime compatibility
 * claim: exact artifact placement of the identity remains subject to O-02,
 * and host validation of derived IDs remains OPEN (OQ-24).
 *
 * The `v1` version tag is part of the derivation domain. Any future encoding
 * change must use a new tag instead of silently reinterpreting `v1`.
 * =====================================================================
 *
 * Framed derivation input, in order. Every field — including the raw identity
 * and the final variable-length JSON string — is prefixed by its byte length
 * encoded as an 8-byte unsigned big-endian integer:
 *
 *   field                              bytes
 *   UTF-8 "SessionPort/remapped-id"      23
 *   UTF-8 "v1"                            2
 *   UTF-8 namespace ("session"/"message") 7
 *   raw artifact identity                16
 *   UTF-8 of JSON.stringify(originalID)  variable
 *
 * `JSON.stringify` is applied to a validated JS string, so arbitrary string
 * values are preserved exactly: lone surrogates are escaped by well-formed
 * JSON.stringify and `TextEncoder` therefore never applies lossy U+FFFD
 * replacement to the original ID. The length prefixes keep the tuple
 * unambiguous despite the variable-length final field.
 *
 * The original ID is never included in any output or error message; only the
 * 32-byte BLAKE2b digest is hex-encoded. There is no fallback or regeneration
 * behavior: invalid inputs fail closed.
 */
import sodium from "libsodium-wrappers-sumo";
import { ARTIFACT_IDENTITY_BYTES, type ArtifactIdentity } from "../contracts/crypto.ts";
import { requireSupportedSodiumRuntime } from "../crypto/kdf.ts";

/** Remap namespaces; each derives in a distinct domain. */
export type RemappedIdNamespace = "session" | "message";

/**
 * Synchronous deriver over the provisional O-22 encoding. Construct it once
 * with `createRemappedIdDeriver()` (which awaits/validates pinned sodium
 * readiness); `derive` is pure and synchronous thereafter.
 */
export interface RemappedIdDeriver {
	derive(namespace: RemappedIdNamespace, artifactIdentity: ArtifactIdentity, originalID: string): string;
}

/** Fail-closed validation/runtime codes for remapped-ID derivation. */
export type RemappedIdErrorCode =
	| "invalid-namespace"
	| "invalid-artifact-identity"
	| "invalid-original-id"
	| "derivation-failure";

/** Error that never echoes the original ID. */
export class RemappedIdError extends Error {
	readonly code: RemappedIdErrorCode;

	constructor(code: RemappedIdErrorCode, message: string) {
		super(message);
		this.name = "RemappedIdError";
		this.code = code;
	}
}

/** Provisional domain/version tags; see the module comment before changing. */
const REMAPPED_ID_DOMAIN = "SessionPort/remapped-id";
const REMAPPED_ID_VERSION = "v1";

const HASH_BYTES = 32;
const LENGTH_PREFIX_BYTES = 8;
const OUTPUT_PREFIX: Readonly<Record<RemappedIdNamespace, string>> = Object.freeze({
	session: "ses_",
	message: "msg_",
});

const textEncoder = new TextEncoder();
const HEX_DIGITS = "0123456789abcdef";

function invalidNamespace(): never {
	throw new RemappedIdError("invalid-namespace", 'namespace must be exactly "session" or "message"');
}

function invalidIdentity(): never {
	throw new RemappedIdError(
		"invalid-artifact-identity",
		`artifact identity must be a Uint8Array of exactly ${ARTIFACT_IDENTITY_BYTES} bytes`,
	);
}

function invalidOriginalId(): never {
	throw new RemappedIdError("invalid-original-id", "original ID must be a string");
}

function validateNamespace(namespace: RemappedIdNamespace): RemappedIdNamespace {
	if (namespace !== "session" && namespace !== "message") invalidNamespace();
	return namespace;
}

function validateArtifactIdentity(artifactIdentity: ArtifactIdentity): ArtifactIdentity {
	if (!(artifactIdentity instanceof Uint8Array) || artifactIdentity.length !== ARTIFACT_IDENTITY_BYTES) {
		invalidIdentity();
	}
	return artifactIdentity;
}

function validateOriginalId(originalID: string): string {
	if (typeof originalID !== "string") invalidOriginalId();
	return originalID;
}

/** 8-byte unsigned big-endian byte-length prefix. */
function encodeLengthPrefix(byteLength: number): Uint8Array {
	const prefix = new Uint8Array(LENGTH_PREFIX_BYTES);
	new DataView(prefix.buffer).setBigUint64(0, BigInt(byteLength), false);
	return prefix;
}

/** One length-prefixed framed field: u64 BE length || raw field bytes. */
function frameField(field: Uint8Array): Uint8Array {
	const out = new Uint8Array(LENGTH_PREFIX_BYTES + field.length);
	out.set(encodeLengthPrefix(field.length), 0);
	out.set(field, LENGTH_PREFIX_BYTES);
	return out;
}

/**
 * Builds the exact framed derivation input documented in the module comment.
 * All inputs are already validated.
 */
function buildDerivationInput(
	namespace: RemappedIdNamespace,
	artifactIdentity: ArtifactIdentity,
	originalID: string,
): Uint8Array {
	const fields = [
		frameField(textEncoder.encode(REMAPPED_ID_DOMAIN)),
		frameField(textEncoder.encode(REMAPPED_ID_VERSION)),
		frameField(textEncoder.encode(namespace)),
		frameField(artifactIdentity),
		frameField(textEncoder.encode(JSON.stringify(originalID))),
	];
	let total = 0;
	for (const field of fields) total += field.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const field of fields) {
		out.set(field, offset);
		offset += field.length;
	}
	return out;
}

/** Lowercase hex over the digest; the original ID is never part of the output. */
function toLowerHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += HEX_DIGITS[byte >>> 4]! + HEX_DIGITS[byte & 0x0f]!;
	return out;
}

function deriveRemappedId(
	namespace: RemappedIdNamespace,
	artifactIdentity: ArtifactIdentity,
	originalID: string,
): string {
	const validatedNamespace = validateNamespace(namespace);
	const validatedIdentity = validateArtifactIdentity(artifactIdentity);
	const validatedOriginalId = validateOriginalId(originalID);
	const digest = sodium.crypto_generichash(
		HASH_BYTES,
		buildDerivationInput(validatedNamespace, validatedIdentity, validatedOriginalId),
		null,
	);
	if (!(digest instanceof Uint8Array) || digest.length !== HASH_BYTES) {
		throw new RemappedIdError("derivation-failure", "BLAKE2b-256 produced an unexpected digest size");
	}
	return OUTPUT_PREFIX[validatedNamespace] + toLowerHex(digest);
}

/**
 * Awaits/validates pinned sodium readiness (including `crypto_generichash`)
 * and returns the synchronous provisional deriver. Fails closed on an
 * unsupported runtime; there is no fallback deriver.
 */
export async function createRemappedIdDeriver(): Promise<RemappedIdDeriver> {
	await requireSupportedSodiumRuntime();
	return {
		derive(namespace, artifactIdentity, originalID) {
			return deriveRemappedId(namespace, artifactIdentity, originalID);
		},
	};
}
