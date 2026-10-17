/**
 * Strict gzip decoder tests (pako 3.0.2 low-level inflate boundary).
 *
 * The owner-approved boundary policy: accept one or more complete RFC 1952
 * members; reject every byte after the final member, including zero padding;
 * accept clean EOF only after at least one complete member. Caps exercised
 * here are arbitrary test-only values; no production numeric profile or cap
 * is selected (O-03 remains OPEN).
 *
 * Coverage matrix:
 * - single / empty-payload / multiple members;
 * - empty compressed input; zero-length source chunks;
 * - trailing zero (1..16) and non-zero suffixes;
 * - valid member then truncated / malformed second member;
 * - all optional gzip header fields + FHCRC; corrupt FHCRC/CRC32/ISIZE;
 * - malformed magic/method, invalid DEFLATE block type, truncated members;
 * - varied async chunking: every two-way split, one-byte chunks, member
 *   boundaries, mixed sizes, delayed microtasks;
 * - exact/over compressed cap (no later chunks pulled after a violation);
 * - exact/over decompressed cap, including aggregate across members;
 * - source errors, non-byte chunks, iterator cleanup, no-use-after-advance;
 * - checked `zlibInflateEnd` teardown handling (test-only seam);
 * - non-vacuity: the same zero-padded stream is accepted by `node:zlib`
 *   `gunzipSync` on the tested runtime, so the strict rejection is the
 *   boundary logic, not a broken fixture.
 *
 * All payloads are synthetic and in-memory.
 */
import { describe, expect, test } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { Z_STREAM_ERROR } from "pako";
import type { ByteSource } from "../../../src/core/contracts/crypto.ts";
import { collectGunzipBounded, type GunzipDecoderTestSeams } from "../../../src/core/crypto/gzip-stream.ts";
import { CryptoContainerError } from "../../../src/core/crypto/index.ts";
import { buildGzipMember, gzipStream } from "./gzip-fixtures.ts";
import {
	allZero,
	bytesEqual,
	concat,
	interceptMemzero,
	sourceFrom,
	splitSource,
	utf8,
} from "./test-only-support.ts";

const GENEROUS_COMPRESSED = 1 << 20;
const GENEROUS_DECOMPRESSED = 1 << 20;

async function decode(
	source: ByteSource,
	maxCompressedBytes = GENEROUS_COMPRESSED,
	maxDecompressedBytes = GENEROUS_DECOMPRESSED,
	seams?: GunzipDecoderTestSeams,
): Promise<Uint8Array> {
	return (await collectGunzipBounded(source, maxCompressedBytes, maxDecompressedBytes, seams)).bytes;
}

async function rejection(promise: Promise<unknown>): Promise<CryptoContainerError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof CryptoContainerError) return error;
		throw error;
	}
	throw new Error("expected the operation to reject, but it resolved");
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

/** Async source with a microtask delay between chunks (varied scheduling). */
function delayedSource(chunks: readonly Uint8Array[]): ByteSource {
	return (async function* () {
		for (const chunk of chunks) {
			await Promise.resolve();
			yield chunk;
		}
	})();
}

describe("strict gzip decoder: members and boundaries", () => {
	test("single member decodes", async () => {
		const plain = utf8("single-member payload");
		const out = await decode(sourceFrom([gzipSync(plain)]));
		expect(bytesEqual(out, plain)).toBe(true);
	});

	test("empty-payload member is a complete member", async () => {
		const out = await decode(sourceFrom([gzipSync(new Uint8Array(0))]));
		expect(out.length).toBe(0);
	});

	test("multiple empty members are accepted, including at a zero output cap", async () => {
		const stream = gzipStream([gzipSync(new Uint8Array(0)), gzipSync(new Uint8Array(0)), gzipSync(new Uint8Array(0))]);
		const out = await decode(sourceFrom([stream]), GENEROUS_COMPRESSED, 0);
		expect(out.length).toBe(0);
	});

	test("multiple members decode to the concatenation", async () => {
		const parts = [utf8("member one|"), utf8("member two|"), utf8("member three")];
		const stream = gzipStream(parts.map((part) => gzipSync(part)));
		const out = await decode(sourceFrom([stream]));
		expect(bytesEqual(out, concat(parts))).toBe(true);
	});

	test("empty compressed input rejects (no complete member)", async () => {
		const error = await rejection(decode(sourceFrom([])));
		expect(error.code).toBe("gzip-error");
	});

	test("zero-length source chunks are skipped without affecting members", async () => {
		const plain = utf8("chunks may be empty");
		const out = await decode(
			sourceFrom([new Uint8Array(0), gzipSync(plain), new Uint8Array(0), new Uint8Array(0)]),
		);
		expect(bytesEqual(out, plain)).toBe(true);
	});

	test("trailing zero bytes (1..16) after the final member reject", async () => {
		const plain = utf8("payload before zero padding");
		const member = gzipSync(plain);
		for (let padding = 1; padding <= 16; padding += 1) {
			const stream = concat([member, new Uint8Array(padding)]);
			const error = await rejection(decode(sourceFrom([stream])));
			expect(error.code).toBe("gzip-error");
		}
	});

	test("trailing zero padding in a separate chunk rejects after clean member EOF", async () => {
		const plain = utf8("member then a separate padded chunk");
		const member = gzipSync(plain);
		// The member ends exactly at the first chunk boundary; the decoder must
		// pull the next chunk to prove EOF and reject its bytes.
		for (const source of [
			sourceFrom([member, new Uint8Array(4)]),
			sourceFrom([member, new Uint8Array(0), new Uint8Array(1)]),
			splitSource(concat([member, new Uint8Array(9)]), 1),
		]) {
			const error = await rejection(decode(source));
			expect(error.code).toBe("gzip-error");
		}
	});

	test("non-zero suffix bytes after the final member reject", async () => {
		const member = gzipSync(utf8("payload before junk"));
		const suffixes = [
			Uint8Array.from([0x01]),
			Uint8Array.from([0xde, 0xad]),
			Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
			utf8("not-a-member"),
		];
		for (const suffix of suffixes) {
			const error = await rejection(decode(sourceFrom([concat([member, suffix])])));
			expect(error.code).toBe("gzip-error");
		}
	});

	test("valid member followed by a truncated second member rejects", async () => {
		const first = gzipSync(utf8("first member"));
		const second = buildGzipMember({ data: utf8("second member payload") });
		const truncationPoints = [1, second.headerLength + 1, second.bytes.length - 7, second.bytes.length - 1];
		for (const point of truncationPoints) {
			const stream = concat([first, second.bytes.subarray(0, point)]);
			const error = await rejection(decode(sourceFrom([stream])));
			expect(error.code).toBe("gzip-error");
		}
	});

	test("valid member followed by a malformed second member rejects", async () => {
		const first = gzipSync(utf8("first member"));
		const invalidBlock = buildGzipMember({
			data: utf8("second member with invalid block type"),
			corrupt: { invalidBlockType: true },
		});
		const wrongMethod = buildGzipMember({ data: utf8("wrong method") });
		wrongMethod.bytes[2] = 9; // 8 = deflate; 9 is not a gzip compression method
		const zeroPrefix = Uint8Array.from([0x00, 0x00, 0x00]);

		for (const second of [invalidBlock.bytes, wrongMethod.bytes, zeroPrefix]) {
			const error = await rejection(decode(sourceFrom([concat([first, second])])));
			expect(error.code).toBe("gzip-error");
		}
	});

	test("all optional gzip header fields and FHCRC decode", async () => {
		const plain = utf8("optional header fields payload");
		const member = buildGzipMember({
			data: plain,
			extra: Uint8Array.from([1, 2, 3, 4, 5]),
			name: "synthetic-name.txt",
			comment: "synthetic comment",
			fhcrc: true,
			mtime: 123456789,
			xfl: 2,
			os: 3,
		});
		// Fixture sanity: the independent runtime accepts this member.
		expect(bytesEqual(new Uint8Array(gunzipSync(member.bytes)), plain)).toBe(true);

		const out = await decode(sourceFrom([member.bytes]));
		expect(bytesEqual(out, plain)).toBe(true);
	});

	test("corrupt FHCRC / CRC32 / ISIZE / DEFLATE data reject", async () => {
		const plain = utf8("checksum-guarded payload");
		const cases = [
			buildGzipMember({ data: plain, fhcrc: true, corrupt: { fhcrc: true } }),
			buildGzipMember({ data: plain, corrupt: { crc32: true } }),
			buildGzipMember({ data: plain, corrupt: { isize: true } }),
			buildGzipMember({ data: plain, corrupt: { invalidBlockType: true } }),
			buildGzipMember({ data: plain, corrupt: { deflateByteXor: 0x01 } }),
		];
		for (const member of cases) {
			const error = await rejection(decode(sourceFrom([member.bytes])));
			expect(error.code).toBe("gzip-error");
		}
	});

	test("malformed magic and method reject", async () => {
		const plain = utf8("malformed header payload");
		const badMagic = gzipSync(plain);
		badMagic[0] = 0x00;
		const badMethod = gzipSync(plain);
		badMethod[2] = 9;
		for (const stream of [badMagic, badMethod, Uint8Array.from([0x1f, 0x8b])]) {
			const error = await rejection(decode(sourceFrom([stream])));
			expect(error.code).toBe("gzip-error");
		}
	});

	test("truncated single member rejects at every stage", async () => {
		const member = buildGzipMember({ data: utf8("truncate me at several points") });
		const points = [1, 5, member.headerLength, member.headerLength + 1, member.bytes.length - 8, member.bytes.length - 1];
		for (const point of points) {
			const error = await rejection(decode(sourceFrom([member.bytes.subarray(0, point)])));
			expect(error.code).toBe("gzip-error");
		}
	});
});

describe("strict gzip decoder: async chunking and boundaries", () => {
	const parts = [utf8("chunk-one|"), utf8("chunk-two|"), utf8("chunk-three|"), utf8("chunk-four")];
	const members = parts.map((part, index) =>
		buildGzipMember({
			data: part,
			name: index === 0 ? "first.bin" : undefined,
			fhcrc: index === 1,
			comment: index === 2 ? "third" : undefined,
		}),
	);
	const stream = gzipStream(members.map((member) => member.bytes));
	const expected = concat(parts);

	test("whole-stream decode baseline matches the concatenation", async () => {
		expect(bytesEqual(await decode(sourceFrom([stream])), expected)).toBe(true);
	});

	test("every two-way split of the stream decodes identically", async () => {
		for (let split = 1; split < stream.length; split += 1) {
			const out = await decode(sourceFrom([stream.subarray(0, split), stream.subarray(split)]));
			expect(bytesEqual(out, expected)).toBe(true);
		}
	});

	test("one-byte chunks across the whole stream decode identically", async () => {
		const out = await decode(splitSource(stream, 1));
		expect(bytesEqual(out, expected)).toBe(true);
	});

	test("chunks split exactly at member boundaries decode identically", async () => {
		const out = await decode(sourceFrom(members.map((member) => member.bytes)));
		expect(bytesEqual(out, expected)).toBe(true);
	});

	test("varied chunk sizes and delayed scheduling decode identically", async () => {
		const sizes = [1, 2, 3, 5, 8, 13, 1, 64];
		const out = await decode(delayedSource(
			(() => {
				const chunks: Uint8Array[] = [];
				let offset = 0;
				let index = 0;
				while (offset < stream.length) {
					const size = sizes[index % sizes.length]!;
					chunks.push(stream.subarray(offset, Math.min(offset + size, stream.length)));
					offset += size;
					index += 1;
				}
				return chunks;
			})(),
		));
		expect(bytesEqual(out, expected)).toBe(true);
	});

	test("larger incompressible payload decodes across varied chunks", async () => {
		const payload = xorshiftBytes(32 * 1024, 0x5eed_1234);
		const gzip = gzipSync(payload);
		for (const sizes of [1, 7, 64, 4096, [1, 5, 64, 1024]] as const) {
			const out = await decode(splitSource(gzip, sizes));
			expect(bytesEqual(out, payload)).toBe(true);
		}
	});
});

describe("strict gzip decoder: compressed-input cap", () => {
	test("exact compressed cap passes and over cap rejects", async () => {
		const plain = utf8("compressed cap payload ".repeat(8));
		const stream = gzipSync(plain);

		const exact = await decode(sourceFrom([stream]), stream.length, GENEROUS_DECOMPRESSED);
		expect(bytesEqual(exact, plain)).toBe(true);

		const error = await rejection(decode(sourceFrom([stream]), stream.length - 1, GENEROUS_DECOMPRESSED));
		expect(error.code).toBe("compressed-limit-exceeded");
		expect("bytes" in error).toBe(false);
	});

	test("the cap is checked before the offending chunk is processed", async () => {
		// A two-byte chunk cannot be a valid member; if it were processed the
		// failure would be a gzip error instead of the cap violation.
		const error = await rejection(decode(sourceFrom([Uint8Array.from([0x1f, 0x8b])]), 1, GENEROUS_DECOMPRESSED));
		expect(error.code).toBe("compressed-limit-exceeded");
	});

	test("no later chunks are pulled after a compressed-cap violation", async () => {
		const plain = utf8("no later pulls after the cap");
		const stream = gzipSync(plain);
		let pulls = 0;
		let sentinelPulled = false;
		const source: ByteSource = (async function* () {
			for (let index = 0; index < stream.length; index += 1) {
				pulls += 1;
				yield stream.subarray(index, index + 1);
			}
			sentinelPulled = true;
			throw new Error("synthetic sentinel: the decoder must not pull past the cap violation");
		})();

		const error = await rejection(decode(source, stream.length - 1, GENEROUS_DECOMPRESSED));
		expect(error.code).toBe("compressed-limit-exceeded");
		expect(pulls).toBe(stream.length);
		expect(sentinelPulled).toBe(false);
	});

	test("exact compressed cap across many chunks passes", async () => {
		const plain = utf8("multi-chunk exact compressed cap");
		const stream = gzipSync(plain);
		const out = await decode(splitSource(stream, [1, 3, 5, 2]), stream.length, GENEROUS_DECOMPRESSED);
		expect(bytesEqual(out, plain)).toBe(true);
	});

	test("compressed cap violation takes precedence over trailing-byte detection", async () => {
		// The padded chunk exceeds the cap before any processing; the
		// deterministic failure is the cap violation.
		const member = gzipSync(utf8("cap precedence payload"));
		const stream = concat([member, new Uint8Array(4)]);
		const error = await rejection(decode(sourceFrom([stream]), member.length, GENEROUS_DECOMPRESSED));
		expect(error.code).toBe("compressed-limit-exceeded");
	});

	test("invalid caps are rejected before decoding", async () => {
		expect((await rejection(decode(sourceFrom([gzipSync(utf8("x"))]), 0))).code).toBe(
			"invalid-policy-definition",
		);
		expect((await rejection(decode(sourceFrom([gzipSync(utf8("x"))]), 1.5))).code).toBe(
			"invalid-policy-definition",
		);
		expect(
			(await rejection(decode(sourceFrom([gzipSync(utf8("x"))]), 1024, -1))).code,
		).toBe("invalid-policy-definition");
	});
});

describe("strict gzip decoder: decompressed-output cap", () => {
	test("exact decompressed cap passes and over cap rejects", async () => {
		const plain = utf8("decompressed cap payload ".repeat(4));
		const stream = gzipSync(plain);

		const exact = await decode(sourceFrom([stream]), GENEROUS_COMPRESSED, plain.length);
		expect(bytesEqual(exact, plain)).toBe(true);

		const error = await rejection(decode(sourceFrom([stream]), GENEROUS_COMPRESSED, plain.length - 1));
		expect(error.code).toBe("decompressed-limit-exceeded");
		expect("bytes" in error).toBe(false);
	});

	test("zero decompressed cap accepts an empty member and rejects output", async () => {
		const emptyMember = await decode(sourceFrom([gzipSync(new Uint8Array(0))]), GENEROUS_COMPRESSED, 0);
		expect(emptyMember.length).toBe(0);

		const error = await rejection(
			decode(sourceFrom([gzipSync(utf8("any output at all"))]), GENEROUS_COMPRESSED, 0),
		);
		expect(error.code).toBe("decompressed-limit-exceeded");
	});

	test("the decompressed cap aggregates across members", async () => {
		const firstPlain = utf8("aaaaaa");
		const secondPlain = utf8("bbbbbb");
		const stream = gzipStream([gzipSync(firstPlain), gzipSync(secondPlain)]);

		const exact = await decode(sourceFrom([stream]), GENEROUS_COMPRESSED, 12);
		expect(bytesEqual(exact, concat([firstPlain, secondPlain]))).toBe(true);

		const error = await rejection(decode(sourceFrom([stream]), GENEROUS_COMPRESSED, 11));
		expect(error.code).toBe("decompressed-limit-exceeded");
	});

	test("a later member tripping the cap returns nothing", async () => {
		const firstPlain = utf8("first member stays private");
		const secondPlain = utf8("second member trips the cap");
		const stream = gzipStream([gzipSync(firstPlain), gzipSync(secondPlain)]);

		const error = await rejection(
			decode(sourceFrom([stream]), GENEROUS_COMPRESSED, firstPlain.length + 4),
		);
		expect(error.code).toBe("decompressed-limit-exceeded");
		expect("bytes" in error).toBe(false);
	});
});

describe("strict gzip decoder: sources, ownership, lifecycle", () => {
	test("a source error after a complete member rejects and returns nothing", async () => {
		const plain = utf8("member then source failure");
		const source: ByteSource = (async function* () {
			yield gzipSync(plain);
			throw new Error("synthetic source failure (test-only)");
		})();
		const error = await rejection(decode(source));
		expect(error.code).toBe("gzip-error");
	});

	test("a non-byte chunk rejects", async () => {
		const source = (async function* () {
			yield "not bytes" as unknown as Uint8Array;
		})();
		const error = await rejection(decode(source));
		expect(error.code).toBe("gzip-error");
	});

	test("a non-iterable source rejects as invalid-artifact-source", async () => {
		const error = await rejection(
			collectGunzipBounded(null as unknown as ByteSource, GENEROUS_COMPRESSED, GENEROUS_DECOMPRESSED),
		);
		expect(error.code).toBe("invalid-artifact-source");
	});

	test("borrowed chunks are never mutated (success and failure)", async () => {
		const plain = utf8("borrowed input stays untouched");
		const stream = concat([gzipSync(plain), new Uint8Array(4)]);
		const chunks = [stream.subarray(0, 7), stream.subarray(7, 19), stream.subarray(19)];
		const originals = chunks.map((chunk) => Uint8Array.from(chunk));

		const error = await rejection(decode(sourceFrom(chunks)));
		expect(error.code).toBe("gzip-error");
		chunks.forEach((chunk, index) => expect(bytesEqual(chunk, originals[index]!)).toBe(true));

		const clean = gzipSync(plain);
		const cleanChunks = [clean.subarray(0, 5), clean.subarray(5)];
		const cleanOriginals = cleanChunks.map((chunk) => Uint8Array.from(chunk));
		const out = await decode(sourceFrom(cleanChunks));
		expect(bytesEqual(out, plain)).toBe(true);
		cleanChunks.forEach((chunk, index) => expect(bytesEqual(chunk, cleanOriginals[index]!)).toBe(true));
	});

	test("decode succeeds when the producer zeroes each chunk on advance", async () => {
		const plain = utf8("zero-on-advance payload ".repeat(4));
		const stream = gzipSync(plain);
		const pieces: Uint8Array[] = [];
		for (let offset = 0; offset < stream.length; offset += 3) {
			pieces.push(stream.subarray(offset, Math.min(offset + 3, stream.length)));
		}
		// Simulates `decryptFrames`: the previous borrowed chunk is zeroed as
		// soon as the consumer advances. A decoder that read retained input
		// after advancing would fail or corrupt the output.
		const source: ByteSource = (async function* () {
			let previous: Uint8Array | undefined;
			for (const piece of pieces) {
				if (previous !== undefined) previous.fill(0);
				previous = piece;
				yield piece;
			}
		})();

		const out = await decode(source);
		expect(bytesEqual(out, plain)).toBe(true);
	});

	test("a failed decode closes the source iterator", async () => {
		let closed = false;
		const source: ByteSource = (async function* () {
			try {
				yield utf8("this is not gzip at all");
				yield utf8("and this would never be read");
			} finally {
				closed = true;
			}
		})();
		const error = await rejection(decode(source));
		expect(error.code).toBe("gzip-error");
		expect(closed).toBe(true);
	});

	test("a successful decode exhausts the source (no return call needed)", async () => {
		let finished = false;
		const source: ByteSource = (async function* () {
			try {
				yield gzipSync(utf8("clean finish"));
			} finally {
				finished = true;
			}
		})();
		const out = await decode(source);
		expect(bytesEqual(out, utf8("clean finish"))).toBe(true);
		expect(finished).toBe(true);
	});

	test("zero-padded stream: node:zlib accepts it, the strict decoder rejects (non-vacuity)", async () => {
		const plain = utf8("non-vacuity contrast payload");
		const padded = concat([gzipSync(plain), new Uint8Array(8)]);
		// The fixture is valid: the pinned runtime's tolerant decoder accepts
		// the padded stream (recorded E20 behavior), so the strict rejection
		// below is boundary logic rather than a malformed fixture.
		expect(bytesEqual(new Uint8Array(gunzipSync(padded)), plain)).toBe(true);
		const error = await rejection(decode(sourceFrom([padded])));
		expect(error.code).toBe("gzip-error");
	});

	test("staged output is zeroed when a late member fails", async () => {
		const firstPlain = utf8("staged first member ".repeat(4));
		const second = gzipSync(utf8("second member"));
		const stream = concat([gzipSync(firstPlain), second.subarray(0, second.length - 3)]);
		const probe = await interceptMemzero();
		try {
			const error = await rejection(decode(sourceFrom([stream])));
			expect(error.code).toBe("gzip-error");
			// The first member's staged plaintext was held by the module and
			// must have been cleared on the late-member failure.
			expect(probe.snapshots.some((snapshot) => bytesEqual(snapshot, firstPlain))).toBe(true);
			for (const zeroed of probe.calls) expect(allZero(zeroed)).toBe(true);
		} finally {
			probe.restore();
		}
	});
});

describe("strict gzip decoder: checked inflater teardown", () => {
	test("every initialized inflater is ended exactly once (multi-member)", async () => {
		const stream = gzipStream([gzipSync(utf8("one")), gzipSync(utf8("two")), gzipSync(utf8("three"))]);
		let endCalls = 0;
		const out = await decode(sourceFrom([stream]), GENEROUS_COMPRESSED, GENEROUS_DECOMPRESSED, {
			inflateEnd: (strm) => {
				endCalls += 1;
				return 0;
			},
		});
		expect(bytesEqual(out, utf8("onetwothree"))).toBe(true);
		expect(endCalls).toBe(3);
	});

	test("a teardown failure with no primary failure rejects", async () => {
		const error = await rejection(
			decode(sourceFrom([gzipSync(utf8("teardown failure"))]), GENEROUS_COMPRESSED, GENEROUS_DECOMPRESSED, {
				inflateEnd: () => Z_STREAM_ERROR,
			}),
		);
		expect(error.code).toBe("gzip-error");
		expect(error.message).toContain("teardown");
	});

	test("a primary failure is preserved when teardown also fails", async () => {
		const plain = utf8("primary failure wins ".repeat(4));
		const stream = gzipSync(plain);
		const error = await rejection(
			decode(sourceFrom([stream]), GENEROUS_COMPRESSED, plain.length - 1, {
				inflateEnd: () => Z_STREAM_ERROR,
			}),
		);
		expect(error.code).toBe("decompressed-limit-exceeded");

		const malformed = await rejection(
			decode(sourceFrom([utf8("definitely not gzip")]), GENEROUS_COMPRESSED, GENEROUS_DECOMPRESSED, {
				inflateEnd: () => Z_STREAM_ERROR,
			}),
		);
		expect(malformed.code).toBe("gzip-error");
		expect(malformed.message).toContain("malformed");
	});
});
