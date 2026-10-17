/**
 * PROVISIONAL SessionPort encrypted container.
 *
 * Scope and boundaries:
 * - Factory construction requires caller-supplied, allow-listed policy
 *   definitions; there is NO default policy and no fallback. The artifact can
 *   only reference a one-byte profile code that must resolve through that
 *   allow-list, and resolution/bounds checks happen before any KDF work.
 * - `seal` streams gzip-compressed plaintext through XChaCha20-Poly1305
 *   secretstream frames; `openAndStage` consumes the whole artifact and only
 *   returns an `AuthenticatedPayload` after every chunk, the required final
 *   tag, clean gzip termination, and all policy caps pass. No partial
 *   plaintext stream/callback/file/temp artifact is exposed, and failures
 *   return nothing.
 * - `seal` enforces the same byte accounting as restore before it can emit
 *   the final-tagged frame: source plaintext bytes against
 *   `maxDecompressedBytes` (incrementally, aborting compression early),
 *   compressed gzip output bytes against `maxCompressedBytes`, and the final
 *   decompressed/compressed gzip ratio against `maxExpansionRatio`. A
 *   violation rejects with no final tag, so no valid artifact is ever
 *   produced for a payload that the same policy could not open.
 * - O-22: `seal` generates one fresh random 128-bit artifact identity per
 *   artifact with pinned `randombytes_buf(16)`; the provisional header carries
 *   it at offset 32 (fixed header length 48), and the complete header is bound
 *   into every frame AAD, so identity tampering fails authentication.
 *   `openAndStage` decodes the identity with the header but surfaces it to the
 *   caller only after full authentication, strict gzip end-of-input, and every
 *   bound check have passed. The identity is public artifact data and must
 *   never be reused as the Argon2 salt. Its placement remains PROVISIONAL
 *   (O-02): this is not a format freeze or a backward-compatibility approval.
 * - The envelope/framing is PROVISIONAL (O-02) and isolated in
 *   `envelope.ts`; do not freeze or publish artifacts from it yet.
 * - `seal` is streaming: if it fails partway (e.g., a mid-stream artifact,
 *   compressed, or decompressed cap violation or source/zlib error), earlier
 *   ciphertext chunks may already have been yielded, but the final-tagged
 *   frame is never emitted. This module never writes files, and callers must
 *   discard any partial output on error so no partial artifact is kept.
 * - Module-owned plaintext copies (seal-side frame chunks — including frame
 *   copies split from one compressed chunk that are never encrypted because a
 *   later frame fails or the consumer cancels — decrypt-side
 *   `secretstream_pull` messages after the consumer advances, collected gzip
 *   output, and the gzip inflater scratch buffer) are best-effort cleared on
 *   success AND failure paths; this is not secure deletion (A-07). The
 *   strict gzip decoder consumes the borrowed decrypted chunks in place and
 *   never retains or copies the compressed input.
 * - `decryptFrames` yields module-owned `secretstream_pull` plaintext under the
 *   shared borrowed-chunk rules: a chunk is valid while the consumer processes
 *   it and is best-effort cleared as soon as the consumer requests the next
 *   chunk, or in `finally` on error/early exit. A successfully pulled message
 *   is tracked before tag validation, so a message rejected for an unexpected
 *   tag is cleared even though it is never yielded. Consumers must copy a
 *   chunk before advancing the iterator (the internal gunzip feeder already
 *   does).
 *
 * Known follow-ups:
 * - `crypto_pwhash` is synchronous and may block (see `kdf.ts`). The
 *   Promise-based API does not promise a nonblocking KDF; execution strategy
 *   is not wired to the TUI in this phase.
 * - `openAndStage` resolves the artifact profile through the whole factory
 *   allow-list. Whether an instance should additionally be restricted to the
 *   policy selected at `create` time is an OPEN question for Oracle Gate 2.
 * - secretstream state tokens are released by dropping references; pinned
 *   0.8.4 has no documented generic free helper. Only module-owned byte
 *   buffers are best-effort zeroed; no secure-delete claim (A-07).
 */
import sodium from "libsodium-wrappers-sumo";
import { ARTIFACT_IDENTITY_BYTES } from "../contracts/crypto.ts";
import type {
	AuthenticatedPayload,
	ByteSource,
	CheckpointCrypto,
	CheckpointCryptoFactory,
	CryptoPolicy,
	PasswordMaterial,
} from "../contracts/crypto.ts";
import {
	buildFrameAad,
	decodeEnvelopeHeader,
	decodeFrameLength,
	ENVELOPE_FRAME_OVERHEAD_BYTES,
	ENVELOPE_HEADER_BYTES,
	ENVELOPE_SECRETSTREAM_HEADER_BYTES,
	encodeEnvelopeHeader,
	encodeFrame,
	FRAME_LENGTH_BYTES,
	FRAME_MAX_CIPHERTEXT_BYTES,
} from "./envelope.ts";
import { CryptoContainerError } from "./errors.ts";
import { collectGunzipBounded, compressStream } from "./gzip-stream.ts";
import {
	type PasswordKeyDerivation,
	requireSupportedSodiumRuntime,
	sodiumArgon2idDerivation,
} from "./kdf.ts";
import {
	buildCryptoPolicyRegistry,
	type CryptoPolicyDefinition,
	type CryptoPolicyRegistry,
	resolvePolicyById,
	resolvePolicyByProfileCode,
} from "./policy.ts";
import { bestEffortZero } from "./zero.ts";

/** Secretstream state shapes, derived structurally from the pinned typings. */
type PushState = Parameters<typeof sodium.crypto_secretstream_xchacha20poly1305_push>[0];
/** @internal Exported only so the crypto tests can drive `decryptFrames` directly. */
export type PullState = Parameters<typeof sodium.crypto_secretstream_xchacha20poly1305_pull>[0];

/**
 * Internal/test-only seams. NOT part of the public crypto contract and not
 * for TUI/plugin use. They exist so tests can observe that allow-list
 * resolution and bounds checks happen before any KDF work.
 */
export interface CryptoFactoryTestSeams {
	readonly derivation?: PasswordKeyDerivation;
}

/**
 * Builds a fail-closed factory over an explicit allow-list of policy
 * definitions. An empty allow-list is valid and rejects every `create`.
 */
export async function createCheckpointCryptoFactory(
	definitions: readonly CryptoPolicyDefinition[],
	seams?: CryptoFactoryTestSeams,
): Promise<CheckpointCryptoFactory> {
	await requireSupportedSodiumRuntime();
	const registry = buildCryptoPolicyRegistry(definitions, {
		opsLimitMin: sodium.crypto_pwhash_OPSLIMIT_MIN,
		memLimitMin: sodium.crypto_pwhash_MEMLIMIT_MIN,
		ciphertextOverheadBytes: sodium.crypto_secretstream_xchacha20poly1305_ABYTES,
	});
	const derivation = seams?.derivation ?? sodiumArgon2idDerivation;
	return {
		async create(policy: CryptoPolicy): Promise<CheckpointCrypto> {
			// Unknown/absent policy ids fail closed here, before any crypto work.
			resolvePolicyById(registry, policy);
			return {
				seal: (plaintext, password) => seal(registry, derivation, plaintext, password, policy),
				openAndStage: (artifact, password) => openAndStage(registry, derivation, artifact, password),
			};
		},
	};
}

function validatePassword(definition: CryptoPolicyDefinition, password: PasswordMaterial): void {
	if (!(password instanceof Uint8Array) || password.length === 0) {
		throw new CryptoContainerError("invalid-password", "password material must be a non-empty byte array");
	}
	if (password.length > definition.limits.maxPasswordBytes) {
		throw new CryptoContainerError("invalid-password", "password material exceeds the policy limit");
	}
}

async function seal(
	registry: CryptoPolicyRegistry,
	derivation: PasswordKeyDerivation,
	plaintext: ByteSource,
	password: PasswordMaterial,
	policy: CryptoPolicy,
): Promise<ByteSource> {
	await requireSupportedSodiumRuntime();
	// Re-resolve (cheap) so `seal` never uses a stale definition if the
	// registry were ever swapped; the selected policy is mandatory.
	const definition = resolvePolicyById(registry, policy);
	validatePassword(definition, password);

	const minimumArtifactBytes =
		ENVELOPE_HEADER_BYTES +
		ENVELOPE_SECRETSTREAM_HEADER_BYTES +
		FRAME_LENGTH_BYTES +
		ENVELOPE_FRAME_OVERHEAD_BYTES;
	if (definition.limits.maxArtifactBytes < minimumArtifactBytes) {
		throw new CryptoContainerError("artifact-too-large", "policy artifact cap cannot hold even one envelope frame");
	}

	const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
	// O-22: one fresh random 128-bit identity per artifact, generated with the
	// pinned runtime and authenticated via the header AAD. Public artifact
	// data — deliberately independent of the Argon2 salt.
	const artifactIdentity = sodium.randombytes_buf(ARTIFACT_IDENTITY_BYTES);
	let key: Uint8Array | undefined;
	try {
		key = derivation.deriveKey(definition, password, salt);
		if (!(key instanceof Uint8Array) || key.length !== sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES) {
			throw new CryptoContainerError("cipher-failure", "key derivation returned an unexpected key size");
		}
		const initiated = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
		const envelopeHeader = encodeEnvelopeHeader({
			profileCode: definition.profileCode,
			salt,
			artifactIdentity,
		});
		return sealArtifactStream(definition, initiated.state, envelopeHeader, initiated.header, plaintext);
	} finally {
		if (key !== undefined) bestEffortZero(key);
		bestEffortZero(salt);
	}
}

/** Buffers bytes into fixed-size plaintext chunks owned by this module. */
class PlainChunkBuffer {
	readonly #chunkBytes: number;
	#buffer: Uint8Array;
	#length = 0;

	constructor(chunkBytes: number) {
		this.#chunkBytes = chunkBytes;
		this.#buffer = new Uint8Array(chunkBytes);
	}

	push(chunk: Uint8Array): Uint8Array[] {
		const out: Uint8Array[] = [];
		let offset = 0;
		while (offset < chunk.length) {
			const take = Math.min(this.#chunkBytes - this.#length, chunk.length - offset);
			this.#buffer.set(chunk.subarray(offset, offset + take), this.#length);
			this.#length += take;
			offset += take;
			if (this.#length === this.#chunkBytes) {
				out.push(this.#buffer.slice());
				this.#length = 0;
			}
		}
		return out;
	}

	/** Returns the remaining buffered bytes as a fresh copy. */
	takeRemainder(): Uint8Array {
		const remainder = this.#buffer.slice(0, this.#length);
		this.#length = 0;
		return remainder;
	}

	/** Best-effort clears the internal plaintext buffer. */
	clear(): void {
		bestEffortZero(this.#buffer);
		this.#length = 0;
	}
}

interface EncryptedFrame {
	readonly frame: Uint8Array;
	readonly ciphertextBytes: number;
}

function encryptFrame(
	state: PushState,
	plaintextChunk: Uint8Array,
	envelopeHeader: Uint8Array,
	sequence: number,
	tag: number,
): EncryptedFrame {
	const ciphertextBytes = plaintextChunk.length + sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
	if (ciphertextBytes > FRAME_MAX_CIPHERTEXT_BYTES) {
		throw new CryptoContainerError("cipher-failure", "plaintext chunk exceeds the framing range");
	}
	const aad = buildFrameAad(envelopeHeader, sequence, ciphertextBytes);
	const ciphertext = sodium.crypto_secretstream_xchacha20poly1305_push(state, plaintextChunk, aad, tag);
	if (!(ciphertext instanceof Uint8Array) || ciphertext.length !== ciphertextBytes) {
		throw new CryptoContainerError("cipher-failure", "secretstream push produced an unexpected ciphertext size");
	}
	return { frame: encodeFrame(ciphertext), ciphertextBytes };
}

/**
 * Encrypts one module-owned plaintext frame copy and best-effort clears that
 * copy immediately after encryption succeeds — and also when push/encoding
 * throws. The copy is therefore never held across a `yield` or after an
 * error.
 */
function encryptFrameAndClearPlaintext(
	state: PushState,
	plaintextChunk: Uint8Array,
	envelopeHeader: Uint8Array,
	sequence: number,
	tag: number,
): EncryptedFrame {
	try {
		return encryptFrame(state, plaintextChunk, envelopeHeader, sequence, tag);
	} finally {
		bestEffortZero(plaintextChunk);
	}
}

async function* sealArtifactStream(
	definition: CryptoPolicyDefinition,
	pushState: PushState,
	envelopeHeader: Uint8Array,
	secretstreamHeader: Uint8Array,
	plaintext: ByteSource,
): AsyncGenerator<Uint8Array> {
	const maxArtifactBytes = definition.limits.maxArtifactBytes;
	const maxCompressedBytes = definition.limits.maxCompressedBytes;
	const maxDecompressedBytes = definition.limits.maxDecompressedBytes;
	const maxExpansionRatio = definition.limits.maxExpansionRatio;
	const tagMessage = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
	const tagFinal = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;

	let written = envelopeHeader.length + secretstreamHeader.length;
	if (written > maxArtifactBytes) {
		throw new CryptoContainerError("artifact-too-large", "artifact exceeds the policy size limit");
	}
	yield envelopeHeader;
	yield secretstreamHeader;

	// Count source plaintext bytes as they stream into gzip so the
	// decompressed cap is enforced incrementally: an over-limit source aborts
	// compression early and can never reach the final-tagged frame below.
	let plaintextBytes = 0;
	const countedPlaintext: ByteSource = (async function* () {
		for await (const chunk of plaintext) {
			if (!(chunk instanceof Uint8Array)) {
				throw new CryptoContainerError("invalid-artifact-source", "plaintext source yielded a non-byte chunk");
			}
			plaintextBytes += chunk.length;
			if (plaintextBytes > maxDecompressedBytes) {
				throw new CryptoContainerError(
					"decompressed-limit-exceeded",
					"source plaintext exceeds the policy decompressed limit",
				);
			}
			yield chunk;
		}
	})();

	const chunks = new PlainChunkBuffer(definition.framing.chunkBytes);
	let sequence = 0;
	let compressedBytes = 0;
	try {
		try {
			for await (const gzipChunk of compressStream(countedPlaintext, definition.compression.level)) {
				try {
					// Count compressed output before buffering it: the compressed
					// cap is enforced incrementally and no over-limit chunk is
					// ever buffered or encrypted.
					compressedBytes += gzipChunk.length;
					if (compressedBytes > maxCompressedBytes) {
						throw new CryptoContainerError(
							"compressed-limit-exceeded",
							"compressed gzip output exceeds the policy limit",
						);
					}
					// `chunks.push` may split one compressed chunk into several
					// module-owned plaintext copies. Every emitted copy is tracked:
					// `encryptFrameAndClearPlaintext` clears the one being
					// encrypted immediately, and the `finally` below clears every
					// copy that was never processed when the batch is abandoned —
					// push/framing failure, artifact-cap failure, or consumer
					// cancellation at the `yield`.
					const batch = chunks.push(gzipChunk);
					let next = 0;
					try {
						while (next < batch.length) {
							const plaintextChunk = batch[next]!;
							const encrypted = encryptFrameAndClearPlaintext(
								pushState,
								plaintextChunk,
								envelopeHeader,
								sequence,
								tagMessage,
							);
							next += 1;
							written += FRAME_LENGTH_BYTES + encrypted.ciphertextBytes;
							if (written > maxArtifactBytes) {
								throw new CryptoContainerError("artifact-too-large", "artifact exceeds the policy size limit");
							}
							sequence += 1;
							yield encrypted.frame;
						}
					} finally {
						// Clear every copy not yet handed to encryption. Copies
						// already processed were cleared by the helper (clearing
						// one of those again would be harmless but is not needed).
						for (let index = next; index < batch.length; index += 1) {
							bestEffortZero(batch[index]!);
						}
					}
				} finally {
					bestEffortZero(gzipChunk);
				}
			}
		} catch (error) {
			// If the source counter tripped, surface the deterministic
			// decompressed-cap code no matter how the stream runtime wrapped
			// the failure; otherwise preserve the original error (stream and
			// cipher errors keep their existing behavior).
			if (plaintextBytes > maxDecompressedBytes) {
				throw new CryptoContainerError(
					"decompressed-limit-exceeded",
					"source plaintext exceeds the policy decompressed limit",
				);
			}
			throw error;
		}

		// Fail-closed re-checks before the final-tagged frame is produced. The
		// streaming checks above already cover the normal paths; these guarantee
		// that no valid final-tagged artifact is ever emitted when any policy
		// byte bound is exceeded, even if a stream runtime ever swallowed the
		// mid-stream abort. The expansion ratio is only meaningful on the final
		// totals (a running ratio is not monotonic), and it uses the same
		// accounting as restore: decompressed plaintext bytes divided by the
		// compressed gzip output bytes — never envelope bytes.
		if (plaintextBytes > maxDecompressedBytes) {
			throw new CryptoContainerError(
				"decompressed-limit-exceeded",
				"source plaintext exceeds the policy decompressed limit",
			);
		}
		if (compressedBytes <= 0 || plaintextBytes / compressedBytes > maxExpansionRatio) {
			throw new CryptoContainerError(
				"expansion-limit-exceeded",
				"decompressed/compressed byte ratio exceeds the policy expansion limit",
			);
		}

		// Exactly one final-tagged frame terminates the artifact; it is empty
		// when the gzip output ended exactly on a chunk boundary.
		const remainder = chunks.takeRemainder();
		const finalFrame = encryptFrameAndClearPlaintext(pushState, remainder, envelopeHeader, sequence, tagFinal);
		written += FRAME_LENGTH_BYTES + finalFrame.ciphertextBytes;
		if (written > maxArtifactBytes) {
			throw new CryptoContainerError("artifact-too-large", "artifact exceeds the policy size limit");
		}
		yield finalFrame.frame;
	} finally {
		chunks.clear();
	}
}

/**
 * Pull-based reader over a one-shot `ByteSource` with a consumed-bytes cap.
 *
 * @internal Exported only so the crypto tests can drive `decryptFrames`
 * directly; NOT part of the public crypto contract (`index.ts`).
 */
export class ArtifactReader {
	readonly #iterator: AsyncIterator<Uint8Array>;
	#chunk: Uint8Array | undefined;
	#offset = 0;
	#done = false;
	#consumedBytes = 0;

	constructor(source: ByteSource) {
		const candidate: unknown = source;
		if (
			candidate === null ||
			typeof candidate !== "object" ||
			typeof (candidate as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function"
		) {
			throw new CryptoContainerError("invalid-artifact-source", "artifact must be an async iterable of byte chunks");
		}
		this.#iterator = (candidate as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
	}

	get consumedBytes(): number {
		return this.#consumedBytes;
	}

	async #fill(): Promise<boolean> {
		while (this.#chunk === undefined || this.#offset >= this.#chunk.length) {
			if (this.#done) return false;
			const step = await this.#iterator.next();
			if (step.done === true) {
				this.#done = true;
				this.#chunk = undefined;
				return false;
			}
			const value: unknown = step.value;
			if (!(value instanceof Uint8Array)) {
				throw new CryptoContainerError("invalid-artifact-source", "artifact source yielded a non-byte chunk");
			}
			if (value.length === 0) continue;
			this.#chunk = value;
			this.#offset = 0;
		}
		return true;
	}

	/**
	 * Reads exactly `byteCount` bytes. Returns `undefined` only on clean EOF at
	 * a field boundary; a partial field throws `truncated-artifact`. Enforces a
	 * running consumed-bytes cap.
	 */
	async readExactly(byteCount: number, maxConsumedBytes: number): Promise<Uint8Array | undefined> {
		if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
			throw new CryptoContainerError("invalid-frame", "invalid fixed-size read length");
		}
		const out = new Uint8Array(byteCount);
		let filled = 0;
		while (filled < byteCount) {
			const available = await this.#fill();
			if (!available) {
				if (filled === 0) return undefined;
				throw new CryptoContainerError("truncated-artifact", "artifact ended inside a fixed-size field");
			}
			const take = Math.min(byteCount - filled, this.#chunk!.length - this.#offset);
			out.set(this.#chunk!.subarray(this.#offset, this.#offset + take), filled);
			this.#offset += take;
			filled += take;
			this.#consumedBytes += take;
			if (this.#consumedBytes > maxConsumedBytes) {
				throw new CryptoContainerError("artifact-too-large", "artifact exceeds the policy size limit");
			}
		}
		return out;
	}
}

/**
 * Yields authenticated plaintext chunks in order. Enforces frame bounds,
 * exact sequencing, the required final tag, and rejects trailing data after
 * the final tag. Any failure destroys the consumer side with the original
 * error so no partial output can be returned.
 *
 * Ownership: each yielded `pulled.message` is module-owned (a fresh buffer
 * from the pinned wrapper). It follows the borrowed-chunk rules: it stays
 * valid while the consumer processes/copies it and is best-effort zeroed as
 * soon as the consumer requests the next chunk, and in `finally` when the
 * iterator is closed early or fails. A successfully pulled message is tracked
 * immediately after `pull` returns (before the tag branch that can throw), so
 * an unexpected-tag rejection still clears that exact message in `finally`.
 *
 * @internal Exported only so the crypto tests can drive cancellation and
 * error lifecycles directly; NOT part of the public crypto contract.
 */
export async function* decryptFrames(
	reader: ArtifactReader,
	definition: CryptoPolicyDefinition,
	pullState: PullState,
	envelopeHeader: Uint8Array,
): AsyncGenerator<Uint8Array> {
	const abytes = sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
	const tagMessage = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
	const tagFinal = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
	const maxCiphertextBytes = definition.framing.chunkBytes + abytes;
	const maxArtifactBytes = definition.limits.maxArtifactBytes;

	let sequence = 0;
	let sawFinalTag = false;
	// The most recently pulled plaintext buffer, recorded as soon as `pull`
	// succeeds and before any tag branch that can throw; cleared on the next
	// request (consumer has advanced), when an unexpected tag rejects it, or on
	// early exit/error.
	let handedOff: Uint8Array | undefined;

	try {
		while (true) {
			if (handedOff !== undefined) {
				// The consumer has advanced past the previous chunk; it is no
				// longer allowed to read it, so clear it before any awaits.
				bestEffortZero(handedOff);
				handedOff = undefined;
			}

			const lengthPrefix = await reader.readExactly(FRAME_LENGTH_BYTES, maxArtifactBytes);
			if (lengthPrefix === undefined) {
				if (!sawFinalTag) {
					throw new CryptoContainerError("missing-final-tag", "artifact ended without a final secretstream tag");
				}
				return;
			}
			if (sawFinalTag) {
				throw new CryptoContainerError("trailing-data", "artifact contains bytes after the final tag");
			}

			const ciphertextBytes = decodeFrameLength(lengthPrefix);
			if (ciphertextBytes < abytes || ciphertextBytes > maxCiphertextBytes) {
				throw new CryptoContainerError("invalid-frame", "frame ciphertext length is outside the policy bounds");
			}
			const ciphertext = await reader.readExactly(ciphertextBytes, maxArtifactBytes);
			if (ciphertext === undefined) {
				throw new CryptoContainerError("truncated-artifact", "artifact ended inside a frame");
			}

			const aad = buildFrameAad(envelopeHeader, sequence, ciphertextBytes);
			const pulled = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, ciphertext, aad);
			if (pulled === false) {
				throw new CryptoContainerError("authentication-failed", "secretstream chunk failed authentication");
			}

			// `pull` already succeeded, so `pulled.message` is module-owned
			// plaintext: record it as tracked BEFORE either tag branch below,
			// since the unexpected-tag branch can throw. Otherwise that throw
			// would abort with the message untracked and `finally` could not
			// clear it. Tracking does not change handoff semantics: the buffer
			// is only yielded to the consumer below and is still cleared when
			// the consumer advances (top of loop) or on early exit/error.
			handedOff = pulled.message;

			if (pulled.tag === tagFinal) {
				sawFinalTag = true;
			} else if (pulled.tag !== tagMessage) {
				throw new CryptoContainerError("unexpected-tag", "unexpected secretstream tag");
			}
			sequence += 1;
			yield handedOff;
		}
	} finally {
		if (handedOff !== undefined) bestEffortZero(handedOff);
	}
}

async function openAndStage(
	registry: CryptoPolicyRegistry,
	derivation: PasswordKeyDerivation,
	artifact: ByteSource,
	password: PasswordMaterial,
): Promise<AuthenticatedPayload> {
	await requireSupportedSodiumRuntime();
	if (!(password instanceof Uint8Array) || password.length === 0) {
		throw new CryptoContainerError("invalid-password", "password material must be a non-empty byte array");
	}

	const reader = new ArtifactReader(artifact);

	// The header is fixed-size; read it under no policy cap yet, then resolve
	// the profile through the caller-supplied allow-list BEFORE any KDF work.
	const headerBytes = await reader.readExactly(ENVELOPE_HEADER_BYTES, Number.MAX_SAFE_INTEGER);
	if (headerBytes === undefined) {
		throw new CryptoContainerError("truncated-artifact", "artifact ended before the envelope header");
	}
	const header = decodeEnvelopeHeader(headerBytes);
	const definition = resolvePolicyByProfileCode(registry, header.profileCode);

	// All cheap bounds checks happen before the expensive KDF.
	if (password.length > definition.limits.maxPasswordBytes) {
		throw new CryptoContainerError("invalid-password", "password material exceeds the policy limit");
	}
	if (reader.consumedBytes > definition.limits.maxArtifactBytes) {
		throw new CryptoContainerError("artifact-too-large", "artifact exceeds the policy size limit");
	}
	const secretstreamHeader = await reader.readExactly(
		ENVELOPE_SECRETSTREAM_HEADER_BYTES,
		definition.limits.maxArtifactBytes,
	);
	if (secretstreamHeader === undefined) {
		throw new CryptoContainerError("truncated-artifact", "artifact ended before the secretstream header");
	}

	let pullState: PullState | undefined;
	let key: Uint8Array | undefined;
	try {
		key = derivation.deriveKey(definition, password, header.salt);
		if (!(key instanceof Uint8Array) || key.length !== sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES) {
			throw new CryptoContainerError("cipher-failure", "key derivation returned an unexpected key size");
		}
		pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(secretstreamHeader, key);
	} finally {
		if (key !== undefined) bestEffortZero(key);
		bestEffortZero(header.salt);
	}
	if (pullState === undefined) {
		throw new CryptoContainerError("cipher-failure", "secretstream pull state was not initialized");
	}

	const decryptedChunks = decryptFrames(reader, definition, pullState, headerBytes);
	// Both caps are required policy fields: the distinct compressed-input cap
	// is enforced while streaming the decrypted gzip bytes, and the
	// decompressed cap during decode. Neither is derived from maxArtifactBytes.
	const { bytes: payload, compressedBytes } = await collectGunzipBounded(
		decryptedChunks,
		definition.limits.maxCompressedBytes,
		definition.limits.maxDecompressedBytes,
	);

	// The expansion ratio is decompressed payload bytes divided by the
	// decrypted compressed gzip bytes — NOT by total envelope bytes (headers,
	// frame prefixes, and AEAD tags must not dilute the bound). This is the
	// same accounting the seal side applies to source plaintext over gzip
	// output, so a same-policy seal/open pair agrees on the boundary. The
	// decompressed cap above remains the primary guard.
	if (compressedBytes <= 0 || payload.length / compressedBytes > definition.limits.maxExpansionRatio) {
		bestEffortZero(payload);
		throw new CryptoContainerError(
			"expansion-limit-exceeded",
			"decompressed payload exceeds the policy expansion ratio",
		);
	}

	// `header.artifactIdentity` is a caller-owned copy decoded from the
	// authenticated header. This is the only return path, and it is reached
	// only after the full stream, the required final tag, strict gzip
	// end-of-input, and every bound check have passed.
	return { bytes: payload, artifactIdentity: header.artifactIdentity };
}
