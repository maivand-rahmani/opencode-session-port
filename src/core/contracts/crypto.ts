/**
 * One-shot byte source. Each yielded chunk is borrowed: producers must not
 * mutate it while the consumer is processing it; consumers must copy a chunk
 * if they retain it after advancing the source.
 */
export type ByteSource = AsyncIterable<Uint8Array>;

/** Raw in-memory password bytes; text encoding/normalization remains an explicit open decision. */
export type PasswordMaterial = Uint8Array;

/**
 * Fixed byte length of an `ArtifactIdentity` (128 bits). The owner-selected
 * O-22 scheme (2026-10-09) generates one random identity per checkpoint
 * artifact; its exact artifact placement remains PROVISIONAL (O-02).
 */
export const ARTIFACT_IDENTITY_BYTES = 16;

/**
 * Opaque per-artifact identity: exactly 16 random bytes (128 bits) generated
 * once per `seal` and authenticated as part of the artifact. It is public
 * artifact data, not a secret, and must never be confused with the Argon2
 * salt. Callers must treat it as opaque and use it only as the stable input
 * for deterministic remapped-ID derivation (O-22).
 */
export type ArtifactIdentity = Uint8Array;

/** Opaque identifier for an explicitly selected, allow-listed crypto policy. */
export interface CryptoPolicy {
	/** A code-selected profile identifier; never take policy values from an artifact. */
	readonly id: string;
}

/**
 * Fully authenticated and decompressed bytes, staged in bounded memory.
 * This value is returned only after the complete stream (including final tag),
 * clean gzip termination, and configured bounds have all passed. The caller
 * still must parse/validate the payload and preflight every session before any
 * import. Ownership of `bytes` transfers exclusively to the caller; callers
 * MUST treat it as immutable and must not retain/mutate aliases before parsing
 * and preflight. No partial plaintext stream/callback is exposed by this boundary.
 */
export interface AuthenticatedPayload {
	readonly bytes: Uint8Array;

	/**
	 * The artifact's authenticated identity, surfaced under the same conditions
	 * as `bytes`: only after the complete stream (including the final tag),
	 * clean strict-gzip end-of-input, and every configured bound have passed.
	 * Caller-owned copy; opaque; never secret. Not exposed on any failure path.
	 */
	readonly artifactIdentity: ArtifactIdentity;
}

/** Crypto service contract. `create` requires an explicit, allow-listed policy; no default profile is implied. */
export interface CheckpointCrypto {
	/** Promise boundary permits asynchronous execution; it does not guarantee the synchronous KDF will not block. */
	seal(plaintext: ByteSource, password: PasswordMaterial): Promise<ByteSource>;

	/** Must reject until the entire artifact has authenticated and decompressed successfully. */
	openAndStage(artifact: ByteSource, password: PasswordMaterial): Promise<AuthenticatedPayload>;
}

/** Public construction boundary: omitting policy is a type error; factories must reject unknown IDs. */
export interface CheckpointCryptoFactory {
	create(policy: CryptoPolicy): Promise<CheckpointCrypto>;
}
