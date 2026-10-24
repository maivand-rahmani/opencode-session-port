/**
 * TEST-ONLY state codec built from the existing provisional container.
 *
 * This is NOT a production crypto profile and NOT an approved on-disk format.
 * It exists only to exercise this module end-to-end: the explicit
 * `sessionport-experimental-state-test-only` policy is a clearly-labelled test
 * fixture with minimal KDF cost, and the 32-byte test state key is passed to
 * the container as password input exactly as a future caller-owned policy may
 * decide (that decision is UNRESOLVED and not claimed here).
 *
 * The safe context is authenticated as a length-prefixed prefix inside the
 * encrypted plaintext, because the current container API does not expose
 * raw-key/AAD injection. Production implementations must bind context with an
 * approved codec; this fixture is not that codec.
 */
import { createCheckpointCryptoFactory } from "../../../../src/core/crypto/container.ts";
import type {
	AuthenticatedStateCodec,
	StateCodecContext,
	StateKeyProvider,
} from "../../../../src/cloud/state/types.ts";
import { STATE_KEY_BYTES } from "../../../../src/cloud/state/types.ts";

export const TEST_STATE_POLICY_ID = "sessionport-experimental-state-test-only";

const TEST_POLICY = {
	id: TEST_STATE_POLICY_ID,
	profileCode: 201,
	kdf: { opsLimit: 1, memLimit: 8192 },
	compression: { level: 1 },
	framing: { chunkBytes: 4096 },
	limits: {
		maxPasswordBytes: 1024,
		maxArtifactBytes: 4 * 1024 * 1024,
		maxCompressedBytes: 4 * 1024 * 1024,
		maxDecompressedBytes: 4 * 1024 * 1024,
		maxExpansionRatio: 128,
	},
} as const;

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of source) {
		chunks.push(chunk);
		total += chunk.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function* oneChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	yield bytes;
}

function frame(plaintext: Uint8Array, context: StateCodecContext): Uint8Array {
	const contextBytes = new TextEncoder().encode(JSON.stringify(context));
	const framed = new Uint8Array(4 + contextBytes.length + plaintext.length);
	new DataView(framed.buffer).setUint32(0, contextBytes.length, false);
	framed.set(contextBytes, 4);
	framed.set(plaintext, 4 + contextBytes.length);
	return framed;
}

function unframe(framed: Uint8Array, expected: StateCodecContext): Uint8Array {
	if (framed.length < 4) throw new Error("test codec: missing context");
	const length = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(0, false);
	if (length === 0 || 4 + length > framed.length) throw new Error("test codec: invalid context");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(framed.subarray(4, 4 + length));
	const actual = JSON.parse(text) as StateCodecContext;
	if (
		actual.purpose !== expected.purpose ||
		actual.formatVersion !== expected.formatVersion ||
		actual.hostScope !== expected.hostScope
	) {
		throw new Error("test codec: context mismatch");
	}
	return framed.slice(4 + length);
}

/** Builds the test-only injected codec. */
export async function createTestStateCodec(): Promise<AuthenticatedStateCodec> {
	const crypto = await createCheckpointCryptoFactory([TEST_POLICY]).then((factory) =>
		factory.create({ id: TEST_STATE_POLICY_ID }),
	);
	return {
		async seal(plaintext, key, context) {
			const framed = frame(plaintext, context);
			return collect(await crypto.seal(oneChunk(framed), key));
		},
		async open(ciphertext, key, context) {
			const payload = await crypto.openAndStage(oneChunk(ciphertext), key);
			return unframe(payload.bytes, context);
		},
	};
}

export interface TestKeyHolder {
	readonly provider: StateKeyProvider;
	setKey(key: Uint8Array | null): void;
	readonly key: Uint8Array | null;
}

/** Deterministic test-key holder; production uses the caller's vault binding. */
export function createTestKeyHolder(initial: Uint8Array | null): TestKeyHolder {
	let key = initial === null ? null : initial.slice();
	return {
		get key() {
			return key;
		},
		setKey(next) {
			key = next === null ? null : next.slice();
		},
		provider: {
			async load() {
				return key === null ? null : key.slice();
			},
		},
	};
}

export function testStateKey(byte: number): Uint8Array {
	return new Uint8Array(STATE_KEY_BYTES).fill(byte);
}

/** Writes a raw encrypted fixture snapshot (tests only). */
export async function sealRawState(
	codec: AuthenticatedStateCodec,
	key: Uint8Array,
	value: unknown,
	hostScope: string,
): Promise<Uint8Array> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return codec.seal(bytes, key, {
		purpose: "sessionport-local-state",
		formatVersion: 1,
		hostScope,
	});
}
