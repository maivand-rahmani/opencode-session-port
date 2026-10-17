/**
 * TEST-ONLY support for the PROVISIONAL crypto container.
 *
 * This module is not production code and must never be imported from `src/`.
 * - KDF costs are libsodium's absolute library minimums, chosen ONLY to keep
 *   tests cheap — not a production recommendation or candidate profile.
 * - Caps/chunk sizes are tiny arbitrary test values, not policy proposals.
 * - All data is synthetic and in-memory; no real passwords/session data, no
 *   filesystem, no temp files, no OpenCode host.
 * - Envelope helpers here deliberately mirror `src/core/crypto/envelope.ts`
 *   so tests can craft malformed artifacts; the format is PROVISIONAL (O-02)
 *   and may change once the owner/Oracle Gate 2 resolve it.
 */
import sodium from "libsodium-wrappers-sumo";
import { ARTIFACT_IDENTITY_BYTES, type ByteSource } from "../../../src/core/contracts/crypto.ts";
import {
	buildFrameAad,
	decodeEnvelopeHeader,
	ENVELOPE_HEADER_BYTES,
	ENVELOPE_IDENTITY_OFFSET,
	ENVELOPE_SECRETSTREAM_HEADER_BYTES,
	encodeEnvelopeHeader,
	encodeFrame,
} from "../../../src/core/crypto/envelope.ts";
import { ArtifactReader, decryptFrames } from "../../../src/core/crypto/container.ts";
import {
	createCheckpointCryptoFactory,
	type CryptoFactoryTestSeams,
} from "../../../src/core/crypto/index.ts";
import { sodiumArgon2idDerivation, type PasswordKeyDerivation } from "../../../src/core/crypto/kdf.ts";
import type { CryptoPolicyDefinition } from "../../../src/core/crypto/policy.ts";

export async function ready(): Promise<void> {
	await sodium.ready;
}

/** Arbitrary test-only profile code; production codes are OPEN (O-01). */
export const TEST_ONLY_PROFILE_CODE = 241;

export interface TestOnlyPolicyOptions {
	readonly id?: string;
	readonly profileCode?: number;
	readonly chunkBytes?: number;
	readonly maxPasswordBytes?: number;
	readonly maxArtifactBytes?: number;
	readonly maxCompressedBytes?: number;
	readonly maxDecompressedBytes?: number;
	readonly maxExpansionRatio?: number;
}

/** Builds a clearly test-only policy definition (library-minimum KDF costs). */
export async function testOnlyPolicy(options: TestOnlyPolicyOptions = {}): Promise<CryptoPolicyDefinition> {
	await sodium.ready;
	return {
		id: options.id ?? "test-only-minimum-costs",
		profileCode: options.profileCode ?? TEST_ONLY_PROFILE_CODE,
		kdf: {
			// Library absolute minimums: TEST-ONLY.
			opsLimit: sodium.crypto_pwhash_OPSLIMIT_MIN,
			memLimit: sodium.crypto_pwhash_MEMLIMIT_MIN,
		},
		compression: { level: 1 },
		framing: { chunkBytes: options.chunkBytes ?? 64 },
		limits: {
			maxPasswordBytes: options.maxPasswordBytes ?? 256,
			maxArtifactBytes: options.maxArtifactBytes ?? 1 << 20,
			// Arbitrary test-only values; production caps remain OPEN (O-03).
			maxCompressedBytes: options.maxCompressedBytes ?? 1 << 20,
			maxDecompressedBytes: options.maxDecompressedBytes ?? 1 << 20,
			maxExpansionRatio: options.maxExpansionRatio ?? 1024,
		},
	};
}

export interface TestCryptoSetup {
	readonly policy: CryptoPolicyDefinition;
	readonly factory: Awaited<ReturnType<typeof createCheckpointCryptoFactory>>;
	readonly crypto: Awaited<ReturnType<TestCryptoSetup["factory"]["create"]>>;
}

/** One-policy factory + instance for the common test shape. */
export async function createTestCrypto(
	options: TestOnlyPolicyOptions = {},
	seams?: CryptoFactoryTestSeams,
): Promise<TestCryptoSetup> {
	const policy = await testOnlyPolicy(options);
	const factory = await createCheckpointCryptoFactory([policy], seams);
	const crypto = await factory.create({ id: policy.id });
	return { policy, factory, crypto };
}

export interface CountingDerivation {
	readonly derivation: PasswordKeyDerivation;
	readonly calls: () => number;
}

/** Wraps the real derivation with a call counter so tests can assert KDF ordering. */
export function countingDerivation(): CountingDerivation {
	let calls = 0;
	return {
		calls: () => calls,
		derivation: {
			deriveKey(definition, password, salt) {
				calls += 1;
				return sodiumArgon2idDerivation.deriveKey(definition, password, salt);
			},
		},
	};
}

export function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export async function collect(source: ByteSource): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of source) chunks.push(Uint8Array.from(chunk));
	return concat(chunks);
}

export function sourceFrom(chunks: readonly Uint8Array[]): ByteSource {
	return (async function* () {
		for (const chunk of chunks) yield chunk;
	})();
}

export function splitSource(bytes: Uint8Array, chunkSizes: readonly number[] | number): ByteSource {
	const sizes = typeof chunkSizes === "number" ? [chunkSizes] : chunkSizes;
	return (async function* () {
		let offset = 0;
		let index = 0;
		while (offset < bytes.length) {
			const requested = sizes[index % sizes.length] ?? 1;
			const size = Math.max(1, requested);
			yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
			offset += size;
			index += 1;
		}
	})();
}

export interface ParsedArtifact {
	readonly header: Uint8Array;
	/** Identity bytes as placed in the provisional header (offset 32, 16 bytes). */
	readonly artifactIdentity: Uint8Array;
	readonly secretstreamHeader: Uint8Array;
	/** Full frames (4-byte length prefix + ciphertext). */
	readonly frames: readonly Uint8Array[];
}

export function parseArtifact(artifact: Uint8Array): ParsedArtifact {
	const base = ENVELOPE_HEADER_BYTES + ENVELOPE_SECRETSTREAM_HEADER_BYTES;
	if (artifact.length < base + 4) throw new Error("artifact too short to parse");
	const header = artifact.slice(0, ENVELOPE_HEADER_BYTES);
	const artifactIdentity = artifact.slice(
		ENVELOPE_IDENTITY_OFFSET,
		ENVELOPE_IDENTITY_OFFSET + ARTIFACT_IDENTITY_BYTES,
	);
	const secretstreamHeader = artifact.slice(ENVELOPE_HEADER_BYTES, base);
	const frames: Uint8Array[] = [];
	let offset = base;
	while (offset < artifact.length) {
		if (offset + 4 > artifact.length) throw new Error("truncated frame prefix");
		const length = new DataView(artifact.buffer, artifact.byteOffset + offset, 4).getUint32(0, false);
		if (offset + 4 + length > artifact.length) throw new Error("truncated frame");
		frames.push(artifact.slice(offset, offset + 4 + length));
		offset += 4 + length;
	}
	return { header, artifactIdentity, secretstreamHeader, frames };
}

export function reassemble(parsed: ParsedArtifact, frames: readonly Uint8Array[]): Uint8Array {
	return concat([parsed.header, parsed.secretstreamHeader, ...frames]);
}

export function withByte(bytes: Uint8Array, index: number, value: number): Uint8Array {
	const copy = Uint8Array.from(bytes);
	copy[index] = value & 0xff;
	return copy;
}

export function flipByte(bytes: Uint8Array, index: number): Uint8Array {
	const copy = Uint8Array.from(bytes);
	copy[index] = (copy[index] ?? 0) ^ 0x01;
	return copy;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function allZero(bytes: Uint8Array): boolean {
	return bytes.every((byte) => byte === 0);
}

/**
 * TEST-ONLY observation of best-effort clearing. Wraps `sodium.memzero` so
 * tests can see which buffers the crypto code zeroes and capture their bytes
 * immediately before the real memzero call. This mutates the shared sodium
 * object for the current process: always `restore()` in a `finally` block.
 * It grants no production guarantee; A-07 (no secure-delete claim) stands.
 */
export interface MemzeroProbe {
	/** Buffers passed to `memzero`, in call order (already zeroed). */
	readonly calls: readonly Uint8Array[];
	/** Byte snapshots taken immediately before each `memzero` call. */
	readonly snapshots: readonly Uint8Array[];
	restore(): void;
}

export async function interceptMemzero(): Promise<MemzeroProbe> {
	await sodium.ready;
	const original = sodium.memzero;
	const mutable = sodium as unknown as { memzero: (bytes: Uint8Array) => void };
	const calls: Uint8Array[] = [];
	const snapshots: Uint8Array[] = [];
	mutable.memzero = (bytes: Uint8Array): void => {
		calls.push(bytes);
		snapshots.push(Uint8Array.from(bytes));
		original(bytes);
	};
	return {
		calls,
		snapshots,
		restore: () => {
			mutable.memzero = original;
		},
	};
}

/**
 * TEST-ONLY fault-injection seam for `crypto_secretstream_xchacha20poly1305_push`.
 * Records each plaintext argument (and a byte snapshot) and can throw instead
 * of encrypting, so tests can verify that module-owned frame copies are
 * cleared when push fails. Mutates the shared sodium object for the current
 * process: always `restore()` in a `finally` block.
 */
export interface SecretstreamPushProbeOptions {
	/** Return true to record the call and throw instead of encrypting. */
	readonly failOn?: (callIndex: number, tag: number) => boolean;
}

export interface SecretstreamPushProbe {
	/** Plaintext argument of each push call, in call order. */
	readonly calls: readonly Uint8Array[];
	/** Byte snapshot of each plaintext argument captured at call time. */
	readonly snapshots: readonly Uint8Array[];
	/** Tag argument of each push call. */
	readonly tags: readonly number[];
	restore(): void;
}

export async function interceptSecretstreamPush(
	options: SecretstreamPushProbeOptions = {},
): Promise<SecretstreamPushProbe> {
	await sodium.ready;
	const original = sodium.crypto_secretstream_xchacha20poly1305_push;
	const mutable = sodium as unknown as {
		crypto_secretstream_xchacha20poly1305_push: typeof original;
	};
	const calls: Uint8Array[] = [];
	const snapshots: Uint8Array[] = [];
	const tags: number[] = [];
	let callIndex = 0;
	mutable.crypto_secretstream_xchacha20poly1305_push = (state, message, ad, tag, outputFormat?) => {
		const index = callIndex;
		callIndex += 1;
		calls.push(message as Uint8Array);
		snapshots.push(Uint8Array.from(message as Uint8Array));
		tags.push(tag);
		if (options.failOn?.(index, tag) === true) {
			throw new Error("synthetic secretstream push failure (test-only)");
		}
		return original(state, message, ad, tag, outputFormat);
	};
	return {
		calls,
		snapshots,
		tags,
		restore: () => {
			mutable.crypto_secretstream_xchacha20poly1305_push = original;
		},
	};
}

export async function secretstreamTagFinal(): Promise<number> {
	await sodium.ready;
	return sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
}

/**
 * TEST-ONLY observation of `crypto_secretstream_xchacha20poly1305_pull`
 * results. Records the plaintext `message` buffer handed to the caller (and a
 * byte snapshot from the moment it was returned) so tests can assert that the
 * module best-effort clears pulled plaintext after the consumer advances, on
 * source error, and on early iterator exit. `tagOverrideOn` additionally lets
 * a test hand back the authentic message under a synthesized unexpected tag,
 * so the tag-rejection path stays observable against the exact buffer. This
 * mutates the shared sodium object for the current process: always
 * `restore()` in a `finally` block.
 */
export interface SecretstreamPullProbe {
	/** `message` buffer of each successful pull call, in call order. */
	readonly messages: readonly Uint8Array[];
	/** Byte snapshot of each `message` captured when the call returned. */
	readonly snapshots: readonly Uint8Array[];
	restore(): void;
}

export interface SecretstreamPullProbeOptions {
	/**
	 * Return a replacement tag for the successful pull result at a given call
	 * index (or `undefined` to keep the runtime's tag). When a tag is
	 * returned, the seam returns a synthesized `{ message, tag }` object
	 * carrying the authentic message buffer.
	 */
	readonly tagOverrideOn?: (callIndex: number) => number | undefined;
}

export async function interceptSecretstreamPull(
	options: SecretstreamPullProbeOptions = {},
): Promise<SecretstreamPullProbe> {
	await sodium.ready;
	const mutable = sodium as unknown as {
		crypto_secretstream_xchacha20poly1305_pull: (
			state: unknown,
			ciphertext: Uint8Array,
			ad: Uint8Array | string | null,
			outputFormat?: unknown,
		) => unknown;
	};
	const original = mutable.crypto_secretstream_xchacha20poly1305_pull;
	const messages: Uint8Array[] = [];
	const snapshots: Uint8Array[] = [];
	let callIndex = 0;
	mutable.crypto_secretstream_xchacha20poly1305_pull = (state, ciphertext, ad, outputFormat) => {
		const index = callIndex;
		callIndex += 1;
		const result = original(state, ciphertext, ad, outputFormat);
		if (result === false || result === null || typeof result !== "object") return result;
		const message = (result as { message?: unknown }).message;
		if (!(message instanceof Uint8Array)) return result;
		messages.push(message);
		snapshots.push(Uint8Array.from(message));
		const replacementTag = options.tagOverrideOn?.(index);
		if (replacementTag === undefined) return result;
		return { message, tag: replacementTag };
	};
	return {
		messages,
		snapshots,
		restore: () => {
			mutable.crypto_secretstream_xchacha20poly1305_pull = original;
		},
	};
}

/**
 * TEST-ONLY: opens the raw `decryptFrames` generator for a well-formed test
 * artifact so tests can drive iterator cancellation/early exit directly.
 * Mirrors the `openAndStage` setup (header decode, KDF, pull-state init) and
 * feeds the frame bytes only. Never used by production code.
 */
export async function openDecryptFramesForTest(
	policy: CryptoPolicyDefinition,
	artifact: Uint8Array,
	password: Uint8Array,
): Promise<AsyncGenerator<Uint8Array>> {
	await sodium.ready;
	const parsed = parseArtifact(artifact);
	const decoded = decodeEnvelopeHeader(parsed.header);
	const key = sodiumArgon2idDerivation.deriveKey(policy, password, decoded.salt);
	const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(parsed.secretstreamHeader, key);
	sodium.memzero(key);
	sodium.memzero(decoded.salt);
	const reader = new ArtifactReader(sourceFrom([concat(parsed.frames)]));
	return decryptFrames(reader, policy, pullState, parsed.header);
}

export interface CraftArtifactOptions {
	readonly profileCode?: number;
	readonly chunkBytes?: number;
	readonly omitFinalTag?: boolean;
	readonly trailingBytes?: Uint8Array;
	/** Optional fixed identity for crafting; defaults to a fresh random 16-byte value. */
	readonly artifactIdentity?: Uint8Array;
}

/**
 * Crafts a well-framed artifact over arbitrary plaintext using the pinned
 * primitives and the PROVISIONAL envelope. Used only to bring malformed or
 * deliberate payloads (e.g., non-gzip bytes) to the container boundary.
 */
export async function craftFramedArtifact(
	definition: CryptoPolicyDefinition,
	plaintext: Uint8Array,
	password: Uint8Array,
	options: CraftArtifactOptions = {},
): Promise<Uint8Array> {
	await sodium.ready;
	const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
	const key = sodium.crypto_pwhash(
		sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
		password,
		salt,
		definition.kdf.opsLimit,
		definition.kdf.memLimit,
		sodium.crypto_pwhash_ALG_ARGON2ID13,
	);
	const { state, header: secretstreamHeader } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
	sodium.memzero(key);

	const profileCode = options.profileCode ?? definition.profileCode;
	const artifactIdentity = options.artifactIdentity ?? sodium.randombytes_buf(ARTIFACT_IDENTITY_BYTES);
	const envelopeHeader = encodeEnvelopeHeader({ profileCode, salt, artifactIdentity });
	sodium.memzero(salt);

	const abytes = sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
	const tagMessage = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
	const tagFinal = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
	const chunkBytes = options.chunkBytes ?? definition.framing.chunkBytes;

	const parts: Uint8Array[] = [envelopeHeader, secretstreamHeader];
	let sequence = 0;

	const pushChunk = (chunk: Uint8Array, tag: number): void => {
		const ciphertext = sodium.crypto_secretstream_xchacha20poly1305_push(
			state,
			chunk,
			buildFrameAad(envelopeHeader, sequence, chunk.length + abytes),
			tag,
		);
		parts.push(encodeFrame(ciphertext));
		sequence += 1;
	};

	if (plaintext.length === 0) {
		pushChunk(new Uint8Array(0), options.omitFinalTag ? tagMessage : tagFinal);
	} else {
		let offset = 0;
		while (offset < plaintext.length) {
			const chunk = plaintext.subarray(offset, Math.min(offset + chunkBytes, plaintext.length));
			offset += chunk.length;
			pushChunk(chunk, offset >= plaintext.length && !options.omitFinalTag ? tagFinal : tagMessage);
		}
	}

	if (options.trailingBytes !== undefined) parts.push(options.trailingBytes);
	return concat(parts);
}
