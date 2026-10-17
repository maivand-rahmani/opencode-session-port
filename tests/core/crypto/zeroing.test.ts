/**
 * PROVISIONAL crypto container: failure-path memory-clearing tests.
 *
 * These tests observe that module-owned plaintext copies are best-effort
 * cleared on BOTH success and failure paths (Oracle Gate 2 fix). They do NOT
 * assert secure deletion: `bestEffortZero` only overwrites buffers the module
 * allocated, and A-07 (no secure-delete claim) still stands. All payloads and
 * passwords are synthetic and in-memory.
 *
 * The second describe block covers the Gate-2 re-review findings:
 * - seal-side, a compressed chunk can be split into a multi-copy frame batch;
 *   every copy not yet processed must be cleared on push/cap failure and on
 *   consumer cancellation, not only the copy handed to encryption;
 * - open-side, each `secretstream_pull` plaintext chunk is module-owned and
 *   must be cleared once the consumer has advanced, on stream error, and on
 *   early iterator exit; a successfully pulled message whose tag is rejected
 *   must be cleared in the iterator `finally` even though it is never handed
 *   off to the consumer.
 *
 * The observation seams wrap `sodium.memzero` / secretstream `push` / `pull`
 * through the pinned runtime object and are restored in `finally` blocks; they
 * are test-only and are not production hooks.
 */
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { ByteSource } from "../../../src/core/contracts/crypto.ts";
import { collectGunzipBounded } from "../../../src/core/crypto/gzip-stream.ts";
import { CryptoContainerError } from "../../../src/core/crypto/index.ts";
import {
	allZero,
	bytesEqual,
	collect,
	createTestCrypto,
	flipByte,
	interceptMemzero,
	interceptSecretstreamPull,
	interceptSecretstreamPush,
	openDecryptFramesForTest,
	parseArtifact,
	reassemble,
	secretstreamTagFinal,
	sourceFrom,
	utf8,
} from "./test-only-support.ts";

const PASSWORD = utf8("synthetic-test-password-a");

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the operation to reject, but it resolved");
}

async function cryptoRejection(promise: Promise<unknown>): Promise<CryptoContainerError> {
	const error = await rejectionOf(promise);
	if (!(error instanceof CryptoContainerError)) throw error;
	return error;
}

function xorshiftBytes(length: number, seed: number): Uint8Array {
	const out = new Uint8Array(length);
	let state = seed >>> 0;
	for (let index = 0; index < out.length; index += 1) {
		state ^= (state << 13) >>> 0;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= (state << 5) >>> 0;
		state >>>= 0;
		out[index] = state & 0xff;
	}
	return out;
}

function splitViews(bytes: Uint8Array, size: number): Uint8Array[] {
	const views: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.length; offset += size) {
		views.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
	}
	return views;
}

function isPrefixOf(prefix: Uint8Array, bytes: Uint8Array): boolean {
	if (prefix.length > bytes.length) return false;
	for (let index = 0; index < prefix.length; index += 1) {
		if (prefix[index] !== bytes[index]) return false;
	}
	return true;
}

describe("PROVISIONAL crypto container: module-owned buffers are cleared on failure paths", () => {
	test("module-owned frame copy is zeroed when secretstream push throws", async () => {
		const { crypto } = await createTestCrypto({ chunkBytes: 7 });
		const probe = await interceptSecretstreamPush({ failOn: () => true });
		try {
			const error = await rejectionOf(
				collect(await crypto.seal(sourceFrom([utf8("push-failure zeroing payload")]), PASSWORD)),
			);
			expect(error).toBeInstanceOf(Error);
			expect(probe.calls.length).toBe(1);
			// TAG_MESSAGE is 0 on the pinned runtime (asserted at factory build).
			expect(probe.tags).toEqual([0]);
			expect(probe.calls[0]!.length).toBe(7);
			// Captured at call time: the copy really held compressed plaintext.
			expect(allZero(probe.snapshots[0]!)).toBe(false);
			// Cleared by the per-frame `finally`, not only on the success path.
			expect(allZero(probe.calls[0]!)).toBe(true);
		} finally {
			probe.restore();
		}
	});

	test("module-owned remainder copy is zeroed when the final push throws", async () => {
		const { crypto } = await createTestCrypto({ chunkBytes: 64 });
		const finalTag = await secretstreamTagFinal();
		const probe = await interceptSecretstreamPush({ failOn: (_index, tag) => tag === finalTag });
		try {
			const error = await rejectionOf(collect(await crypto.seal(sourceFrom([utf8("tiny")]), PASSWORD)));
			expect(error).toBeInstanceOf(Error);
			// The tiny payload gzips to less than one chunk, so the only frame
			// is the final-tagged remainder.
			expect(probe.calls.length).toBe(1);
			expect(probe.tags[0]).toBe(finalTag);
			expect(probe.calls[0]!.length).toBeGreaterThan(0);
			expect(probe.calls[0]!.length).toBeLessThan(64);
			expect(allZero(probe.snapshots[0]!)).toBe(false);
			expect(allZero(probe.calls[0]!)).toBe(true);
		} finally {
			probe.restore();
		}
	});

	test("module-owned frame copy is zeroed when the artifact cap rejects after encryption", async () => {
		// Fixed headers are 72 bytes (48-byte envelope header + 24-byte
		// secretstream header); the first 7-byte plaintext frame adds 28 framed
		// bytes, pushing `written` to 100 over the 95-byte cap.
		const { crypto } = await createTestCrypto({ chunkBytes: 7, maxArtifactBytes: 95 });
		const probe = await interceptSecretstreamPush();
		try {
			const error = await cryptoRejection(
				collect(await crypto.seal(sourceFrom([utf8("cap-after-encryption payload")]), PASSWORD)),
			);
			expect(error.code).toBe("artifact-too-large");
			expect(probe.calls.length).toBe(1);
			expect(probe.calls[0]!.length).toBe(7);
			expect(allZero(probe.snapshots[0]!)).toBe(false);
			expect(allZero(probe.calls[0]!)).toBe(true);
		} finally {
			probe.restore();
		}
	});

	test("collectGunzipBounded clears owned output/scratch on success and never clears borrowed chunks", async () => {
		const plaintext = utf8("gzip-success zeroing payload ".repeat(4));
		const gzip = gzipSync(plaintext);
		const first = gzip.subarray(0, 9);
		const second = gzip.subarray(9);
		const firstOriginal = Uint8Array.from(first);
		const secondOriginal = Uint8Array.from(second);
		const probe = await interceptMemzero();
		try {
			const out = (await collectGunzipBounded(sourceFrom([first, second]), 1 << 20, 1 << 20)).bytes;
			expect(bytesEqual(out, plaintext)).toBe(true);
			// Every buffer handed to memzero is zero afterwards.
			for (const zeroed of probe.calls) expect(allZero(zeroed)).toBe(true);
			// The staged output chunk held the live plaintext before it was
			// cleared (the result was copied into a fresh caller buffer first).
			expect(probe.snapshots.some((snapshot) => bytesEqual(snapshot, plaintext))).toBe(true);
			// The bounded inflater scratch is module-owned and cleared too.
			expect(probe.calls.some((call) => call.length === 64 * 1024)).toBe(true);
			// Borrowed source chunks are not the module's to clear, and the
			// decoder never copies/mutates them.
			expect(bytesEqual(first, firstOriginal)).toBe(true);
			expect(bytesEqual(second, secondOriginal)).toBe(true);
		} finally {
			probe.restore();
		}
	});

	test("collectGunzipBounded clears staged output when the decompressed cap rejects", async () => {
		// Incompressible data keeps the compressed input large while the cap
		// aborts decoding after the first staged output chunk.
		const plaintext = xorshiftBytes(256 * 1024, 0x12345678);
		const gzip = gzipSync(plaintext);
		const views = splitViews(gzip, 32 * 1024);
		const originals = views.map((view) => Uint8Array.from(view));
		const probe = await interceptMemzero();
		try {
			const error = await cryptoRejection(collectGunzipBounded(sourceFrom(views), 1 << 20, 1024));
			expect(error.code).toBe("decompressed-limit-exceeded");
			// Staged output held a live plaintext prefix before it was cleared.
			expect(
				probe.snapshots.some((snapshot) => snapshot.length > 0 && isPrefixOf(snapshot, plaintext)),
			).toBe(true);
			for (const zeroed of probe.calls) expect(allZero(zeroed)).toBe(true);
			// Borrowed source chunks stay untouched, including on the abort path.
			views.forEach((view, index) => expect(bytesEqual(view, originals[index]!)).toBe(true));
		} finally {
			probe.restore();
		}
	});

	test("collectGunzipBounded clears staged output when the source fails", async () => {
		const plaintext = utf8("source-failure zeroing payload");
		const gzip = gzipSync(plaintext);
		const original = Uint8Array.from(gzip);
		const source: ByteSource = (async function* () {
			yield gzip;
			throw new Error("synthetic source failure (test-only)");
		})();
		const probe = await interceptMemzero();
		try {
			const error = await cryptoRejection(collectGunzipBounded(source, 1 << 20, 1 << 20));
			expect(error.code).toBe("gzip-error");
			expect(probe.snapshots.some((snapshot) => bytesEqual(snapshot, plaintext))).toBe(true);
			for (const zeroed of probe.calls) expect(allZero(zeroed)).toBe(true);
			// The borrowed chunk was not copied and was not mutated.
			expect(bytesEqual(gzip, original)).toBe(true);
		} finally {
			probe.restore();
		}
	});

	test("collectGunzipBounded never reads a borrowed chunk after the producer zeroes it", async () => {
		const plaintext = utf8("zero-on-advance ownership payload ".repeat(6));
		const gzip = gzipSync(plaintext);
		const pieces: Uint8Array[] = [];
		for (let offset = 0; offset < gzip.length; offset += 2) {
			pieces.push(gzip.subarray(offset, Math.min(offset + 2, gzip.length)));
		}
		// Simulates `decryptFrames` ownership: the previous borrowed chunk is
		// zeroed as soon as the consumer advances. Correct output proves the
		// decoder consumed each chunk before advancing.
		const source: ByteSource = (async function* () {
			let previous: Uint8Array | undefined;
			for (const piece of pieces) {
				if (previous !== undefined) previous.fill(0);
				previous = piece;
				yield piece;
			}
		})();
		const out = (await collectGunzipBounded(source, 1 << 20, 1 << 20)).bytes;
		expect(bytesEqual(out, plaintext)).toBe(true);
	});
});

const BATCH_CHUNK_BYTES = 7;

/** Finds the whole-gzip-chunk snapshot captured when the outer `finally` cleared it. */
function findGzipChunkSnapshot(snapshots: readonly Uint8Array[]): Uint8Array | undefined {
	let best: Uint8Array | undefined;
	for (const snapshot of snapshots) {
		if (snapshot.length <= BATCH_CHUNK_BYTES) continue;
		if (snapshot[0] !== 0x1f || snapshot[1] !== 0x8b) continue;
		if (best === undefined || snapshot.length > best.length) best = snapshot;
	}
	return best;
}

/**
 * Asserts every full plaintext frame copy split out of the first compressed
 * chunk was handed to best-effort clearing. Copies are consecutive
 * `BATCH_CHUNK_BYTES`-sized slices of that chunk, so each slice must appear
 * among the buffers `bestEffortZero` was called on.
 */
function expectEveryFullCopyCleared(snapshots: readonly Uint8Array[], gzipChunk: Uint8Array): number {
	const copies = Math.floor(gzipChunk.length / BATCH_CHUNK_BYTES);
	expect(copies).toBeGreaterThan(1);
	for (let index = 0; index < copies; index += 1) {
		const slice = gzipChunk.slice(index * BATCH_CHUNK_BYTES, (index + 1) * BATCH_CHUNK_BYTES);
		expect(snapshots.some((snapshot) => bytesEqual(snapshot, slice))).toBe(true);
	}
	return copies;
}

describe("PROVISIONAL crypto container: frame-batch and pulled-plaintext ownership", () => {
	test("all frame copies of a batch are cleared when the artifact cap rejects after the first frame was emitted", async () => {
		// Incompressible input guarantees the first gzip chunk spans many
		// 7-byte frame copies. Fixed headers are 72 bytes; the first frame
		// pushes `written` to exactly 100, so the second frame trips the
		// 100-byte cap after the first frame was already yielded to the
		// consumer.
		const payload = xorshiftBytes(64 * 1024, 0x5eed_1234);
		const { crypto } = await createTestCrypto({ chunkBytes: BATCH_CHUNK_BYTES, maxArtifactBytes: 100 });
		const pushProbe = await interceptSecretstreamPush();
		const memzeroProbe = await interceptMemzero();
		try {
			const error = await cryptoRejection(collect(await crypto.seal(sourceFrom([payload]), PASSWORD)));
			expect(error.code).toBe("artifact-too-large");
			// Both processed copies (frame 1 yielded, frame 2 cap-rejected) were
			// pushed to the cipher; every later copy in the batch was never
			// processed and must still have been cleared.
			expect(pushProbe.calls.length).toBe(2);
			expect(pushProbe.snapshots[0]!.some((byte) => byte !== 0)).toBe(true);
			expect(pushProbe.snapshots[1]!.some((byte) => byte !== 0)).toBe(true);
			for (const call of pushProbe.calls) expect(allZero(call)).toBe(true);
			const gzipChunk = findGzipChunkSnapshot(memzeroProbe.snapshots);
			expect(gzipChunk).toBeDefined();
			expectEveryFullCopyCleared(memzeroProbe.snapshots, gzipChunk!);
			for (const cleared of memzeroProbe.calls) expect(allZero(cleared)).toBe(true);
		} finally {
			pushProbe.restore();
			memzeroProbe.restore();
		}
	});

	test("untouched frame copies of a batch are cleared when push fails on the second frame", async () => {
		const payload = xorshiftBytes(64 * 1024, 0x0bad_f00d);
		const { crypto } = await createTestCrypto({ chunkBytes: BATCH_CHUNK_BYTES });
		const pushProbe = await interceptSecretstreamPush({ failOn: (index) => index === 1 });
		const memzeroProbe = await interceptMemzero();
		try {
			const error = await rejectionOf(collect(await crypto.seal(sourceFrom([payload]), PASSWORD)));
			expect(error).toBeInstanceOf(Error);
			expect(pushProbe.calls.length).toBe(2);
			// The second copy was cleared by the per-frame helper...
			expect(pushProbe.snapshots[1]!.some((byte) => byte !== 0)).toBe(true);
			expect(allZero(pushProbe.calls[1]!)).toBe(true);
			// ...and every later, never-encrypted copy by the batch `finally`.
			const gzipChunk = findGzipChunkSnapshot(memzeroProbe.snapshots);
			expect(gzipChunk).toBeDefined();
			expectEveryFullCopyCleared(memzeroProbe.snapshots, gzipChunk!);
			for (const cleared of memzeroProbe.calls) expect(allZero(cleared)).toBe(true);
		} finally {
			pushProbe.restore();
			memzeroProbe.restore();
		}
	});

	test("consumer cancellation after the first yielded frame clears every untouched batch copy", async () => {
		const payload = xorshiftBytes(64 * 1024, 0xfeed_beef);
		const { crypto } = await createTestCrypto({ chunkBytes: BATCH_CHUNK_BYTES });
		const pushProbe = await interceptSecretstreamPush();
		const memzeroProbe = await interceptMemzero();
		try {
			const sealed = await crypto.seal(sourceFrom([payload]), PASSWORD);
			const iterator = sealed[Symbol.asyncIterator]();
			expect((await iterator.next()).done).toBe(false); // envelope header
			expect((await iterator.next()).done).toBe(false); // secretstream header
			const firstFrame = await iterator.next();
			expect(firstFrame.done).toBe(false);
			// The generator is suspended at the first frame `yield`; the rest
			// of the batch has been allocated but never encrypted.
			expect(pushProbe.calls.length).toBe(1);

			await iterator.return(undefined);

			const gzipChunk = findGzipChunkSnapshot(memzeroProbe.snapshots);
			expect(gzipChunk).toBeDefined();
			expectEveryFullCopyCleared(memzeroProbe.snapshots, gzipChunk!);
			for (const cleared of memzeroProbe.calls) expect(allZero(cleared)).toBe(true);
		} finally {
			pushProbe.restore();
			memzeroProbe.restore();
		}
	});

	test("openAndStage returns the correct bytes and zeroes every pulled plaintext chunk", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: BATCH_CHUNK_BYTES });
		const payload = utf8("decrypt ownership payload ".repeat(8));
		const artifact = await collect(await crypto.seal(sourceFrom([payload]), PASSWORD));
		const pullProbe = await interceptSecretstreamPull();
		try {
			const opened = await (await factory.create({ id: policy.id })).openAndStage(
				sourceFrom([artifact]),
				PASSWORD,
			);
			expect(bytesEqual(opened.bytes, payload)).toBe(true);
			expect(pullProbe.messages.length).toBeGreaterThan(1);
			// At least one pulled chunk held live plaintext when it was handed off...
			expect(pullProbe.snapshots.some((snapshot) => !allZero(snapshot))).toBe(true);
			// ...and every chunk is cleared once the consumer has fully advanced.
			for (const message of pullProbe.messages) expect(allZero(message)).toBe(true);
		} finally {
			pullProbe.restore();
		}
	});

	test("owned pulled plaintext is zeroed when the stream fails after a handoff", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: BATCH_CHUNK_BYTES });
		const payload = utf8("tamper after the first handoff ".repeat(8));
		const artifact = await collect(await crypto.seal(sourceFrom([payload]), PASSWORD));
		const parsed = parseArtifact(artifact);
		expect(parsed.frames.length).toBeGreaterThanOrEqual(3);
		// Corrupt the second frame so the consumer receives frame 1's
		// plaintext and authentication then fails when it asks for more.
		const secondFrame = parsed.frames[1]!;
		const tampered = flipByte(secondFrame, secondFrame.length - 1);
		const badArtifact = reassemble(parsed, [parsed.frames[0]!, tampered, ...parsed.frames.slice(2)]);
		const pullProbe = await interceptSecretstreamPull();
		try {
			const error = await cryptoRejection(
				(await factory.create({ id: policy.id })).openAndStage(sourceFrom([badArtifact]), PASSWORD),
			);
			expect(error.code).toBe("authentication-failed");
			expect(pullProbe.messages.length).toBe(1);
			expect(allZero(pullProbe.snapshots[0]!)).toBe(false);
			// The failing request for the next chunk cleared the handed-off one.
			expect(allZero(pullProbe.messages[0]!)).toBe(true);
		} finally {
			pullProbe.restore();
		}
	});

	test("a successfully pulled message with an unexpected tag is rejected and the exact buffer is zeroed", async () => {
		const { policy, crypto } = await createTestCrypto({ chunkBytes: BATCH_CHUNK_BYTES });
		const payload = utf8("unexpected-tag zeroing payload ".repeat(8));
		const artifact = await collect(await crypto.seal(sourceFrom([payload]), PASSWORD));
		// 1 is TAG_PUSH on the pinned runtime: a successful pull with a tag
		// that is neither TAG_MESSAGE (0) nor TAG_FINAL (3).
		const unexpectedTag = 1;
		const pullProbe = await interceptSecretstreamPull({
			tagOverrideOn: (index) => (index === 0 ? unexpectedTag : undefined),
		});
		try {
			const frames = await openDecryptFramesForTest(policy, artifact, PASSWORD);
			const error = await cryptoRejection(frames.next());
			expect(error.code).toBe("unexpected-tag");
			// The first pull returned one authentic message before the tag
			// branch threw, and it never reached the consumer...
			expect(pullProbe.messages.length).toBe(1);
			expect(allZero(pullProbe.snapshots[0]!)).toBe(false);
			// ...so the iterator `finally` (not a handoff advance) must have
			// cleared that exact buffer.
			expect(allZero(pullProbe.messages[0]!)).toBe(true);
		} finally {
			pullProbe.restore();
		}
	});

	test("the decrypt iterator clears each handed-off chunk when the consumer requests the next one", async () => {
		const { policy, crypto } = await createTestCrypto({ chunkBytes: BATCH_CHUNK_BYTES });
		const payload = utf8("manual decrypt iteration ".repeat(8));
		const artifact = await collect(await crypto.seal(sourceFrom([payload]), PASSWORD));
		const pullProbe = await interceptSecretstreamPull();
		try {
			const frames = await openDecryptFramesForTest(policy, artifact, PASSWORD);
			const first = await frames.next();
			expect(first.done).toBe(false);
			expect(pullProbe.messages.length).toBe(1);
			const firstBuffer = pullProbe.messages[0]!;
			expect(allZero(pullProbe.snapshots[0]!)).toBe(false);
			expect(bytesEqual(first.value as Uint8Array, pullProbe.snapshots[0]!)).toBe(true);

			const second = await frames.next();
			expect(second.done).toBe(false);
			// Advancing cleared the first chunk; the second is live.
			expect(allZero(firstBuffer)).toBe(true);
			expect(allZero(pullProbe.messages[1]!)).toBe(false);

			await frames.return(undefined);
			expect(allZero(pullProbe.messages[1]!)).toBe(true);
		} finally {
			pullProbe.restore();
		}
	});

	test("early iterator exit clears the currently handed-off decrypted chunk", async () => {
		const { policy, crypto } = await createTestCrypto({ chunkBytes: BATCH_CHUNK_BYTES });
		const payload = utf8("early exit decrypt iteration ".repeat(8));
		const artifact = await collect(await crypto.seal(sourceFrom([payload]), PASSWORD));
		const pullProbe = await interceptSecretstreamPull();
		try {
			const frames = await openDecryptFramesForTest(policy, artifact, PASSWORD);
			const first = await frames.next();
			expect(first.done).toBe(false);
			const firstBuffer = pullProbe.messages[0]!;
			expect(allZero(firstBuffer)).toBe(false);

			await frames.return(undefined);

			expect(allZero(firstBuffer)).toBe(true);
		} finally {
			pullProbe.restore();
		}
	});
});
