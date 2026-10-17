/**
 * Seal/open byte-accounting cap tests (Oracle ora-32 blocker).
 *
 * Required behavior pinned here:
 * - `seal` rejects before it can emit the final-tagged frame when the source
 *   plaintext exceeds `maxDecompressedBytes`, the compressed gzip output
 *   exceeds `maxCompressedBytes`, or the final decompressed/compressed gzip
 *   byte ratio exceeds `maxExpansionRatio`;
 * - `openAndStage` computes the same ratio as decompressed payload bytes
 *   divided by decrypted compressed gzip bytes — never total envelope bytes;
 * - exact boundary values are accepted on both sides and one byte over
 *   rejects on both sides under the same policy;
 * - a same-policy seal/open pair agrees on every boundary.
 *
 * Every policy here is a clearly test-only tiny definition with
 * library-minimum KDF costs. The provisional envelope (O-02) and all
 * production numeric caps (O-03) remain OPEN; synthetic in-memory data only.
 */
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { createCheckpointCryptoFactory, CryptoContainerError } from "../../../src/core/crypto/index.ts";
import {
	bytesEqual,
	collect,
	concat,
	craftFramedArtifact,
	createTestCrypto,
	interceptSecretstreamPush,
	secretstreamTagFinal,
	sourceFrom,
	testOnlyPolicy,
	utf8,
	type TestCryptoSetup,
} from "./test-only-support.ts";

const PASSWORD = utf8("synthetic-test-password-a");
/** Test-only definitions compress at zlib level 1. */
const TEST_COMPRESSION_LEVEL = 1;

async function rejectionOf(promise: Promise<unknown>): Promise<CryptoContainerError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof CryptoContainerError) return error;
		throw error;
	}
	throw new Error("expected the operation to reject, but it resolved");
}

async function openWith(setup: TestCryptoSetup, artifact: Uint8Array) {
	return (await setup.factory.create({ id: setup.policy.id })).openAndStage(sourceFrom([artifact]), PASSWORD);
}

/**
 * Drives `seal` over the given source chunks to completion or failure and
 * returns whatever partial artifact bytes were yielded before a failure
 * (callers must discard them, per the module's partial-output rule).
 */
async function sealPartial(
	crypto: TestCryptoSetup["crypto"],
	chunks: readonly Uint8Array[],
): Promise<{ artifact: Uint8Array; error?: CryptoContainerError }> {
	const out: Uint8Array[] = [];
	try {
		const sealed = await crypto.seal(sourceFrom(chunks), PASSWORD);
		for await (const chunk of sealed) out.push(Uint8Array.from(chunk));
		return { artifact: concat(out) };
	} catch (error) {
		if (error instanceof CryptoContainerError) return { artifact: concat(out), error };
		throw error;
	}
}

describe("seal/open byte accounting: decompressed cap", () => {
	test("exact boundary seals and opens under the same policy", async () => {
		const payload = utf8("d".repeat(64));
		const setup = await createTestCrypto({ chunkBytes: 16, maxDecompressedBytes: payload.length });
		const artifact = await collect(await setup.crypto.seal(sourceFrom([payload]), PASSWORD));
		const opened = await openWith(setup, artifact);
		expect(bytesEqual(opened.bytes, payload)).toBe(true);
	});

	test("one byte over rejects mid-stream on seal with no final tag, and on open under the same policy", async () => {
		const payload = utf8("d".repeat(65));
		const setup = await createTestCrypto({ chunkBytes: 16, maxDecompressedBytes: 64 });
		const finalTag = await secretstreamTagFinal();
		const probe = await interceptSecretstreamPush();
		try {
			// The source spans two chunks so the cap trips after compression has
			// already started, exercising the mid-stream abort path.
			const { artifact, error } = await sealPartial(setup.crypto, [
				payload.subarray(0, 64),
				payload.subarray(64),
			]);
			expect(error?.code).toBe("decompressed-limit-exceeded");
			// The final-tagged frame was never produced...
			expect(probe.tags.includes(finalTag)).toBe(false);
			// ...so the partial output cannot be opened as an artifact.
			const partialError = await rejectionOf(openWith(setup, artifact));
			expect(["missing-final-tag", "gzip-error", "truncated-artifact"]).toContain(partialError.code);
		} finally {
			probe.restore();
		}

		// Same policy on open: a complete crafted artifact over the cap rejects.
		const crafted = await craftFramedArtifact(
			setup.policy,
			gzipSync(payload, { level: TEST_COMPRESSION_LEVEL }),
			PASSWORD,
		);
		const openError = await rejectionOf(openWith(setup, crafted));
		expect(openError.code).toBe("decompressed-limit-exceeded");
	});
});

describe("seal/open byte accounting: compressed cap", () => {
	test("exact gzip-output boundary seals and opens; one byte under rejects before any final tag", async () => {
		const payload = utf8("compressed-cap boundary payload ".repeat(4));
		const compressedLength = gzipSync(payload, { level: TEST_COMPRESSION_LEVEL }).length;

		const exact = await createTestCrypto({ chunkBytes: 32, maxCompressedBytes: compressedLength });
		const artifact = await collect(await exact.crypto.seal(sourceFrom([payload]), PASSWORD));
		const opened = await openWith(exact, artifact);
		expect(bytesEqual(opened.bytes, payload)).toBe(true);

		const under = await createTestCrypto({ chunkBytes: 32, maxCompressedBytes: compressedLength - 1 });
		const finalTag = await secretstreamTagFinal();
		const probe = await interceptSecretstreamPush();
		try {
			const { error } = await sealPartial(under.crypto, [payload]);
			expect(error?.code).toBe("compressed-limit-exceeded");
			expect(probe.tags.includes(finalTag)).toBe(false);
		} finally {
			probe.restore();
		}

		// Same policy on open: the identical gzip stream is one byte over.
		const crafted = await craftFramedArtifact(
			under.policy,
			gzipSync(payload, { level: TEST_COMPRESSION_LEVEL }),
			PASSWORD,
		);
		const openError = await rejectionOf(openWith(under, crafted));
		expect(openError.code).toBe("compressed-limit-exceeded");
	});
});

describe("seal/open byte accounting: expansion ratio", () => {
	test("exact ratio boundary seals and opens; over-limit rejects on both sides under the same policy", async () => {
		const payload = utf8("expand ".repeat(64));
		const compressedLength = gzipSync(payload, { level: TEST_COMPRESSION_LEVEL }).length;
		const actualRatio = payload.length / compressedLength;
		expect(actualRatio).toBeGreaterThan(1);

		// Exact boundary: the policy ratio is exactly the artifact's ratio.
		const exact = await createTestCrypto({ chunkBytes: 64, maxExpansionRatio: actualRatio });
		const artifact = await collect(await exact.crypto.seal(sourceFrom([payload]), PASSWORD));
		const opened = await openWith(exact, artifact);
		expect(bytesEqual(opened.bytes, payload)).toBe(true);

		// Over-limit: half the actual ratio rejects on seal before any final tag.
		const capped = await createTestCrypto({ chunkBytes: 64, maxExpansionRatio: actualRatio / 2 });
		const finalTag = await secretstreamTagFinal();
		const probe = await interceptSecretstreamPush();
		try {
			const { error } = await sealPartial(capped.crypto, [payload]);
			expect(error?.code).toBe("expansion-limit-exceeded");
			expect(probe.tags.includes(finalTag)).toBe(false);
		} finally {
			probe.restore();
		}

		// Same policy on open: the crafted gzip stream exceeds the same ratio.
		const crafted = await craftFramedArtifact(
			capped.policy,
			gzipSync(payload, { level: TEST_COMPRESSION_LEVEL }),
			PASSWORD,
		);
		const openError = await rejectionOf(openWith(capped, crafted));
		expect(openError.code).toBe("expansion-limit-exceeded");
	});

	test("open ratio denominator is decrypted gzip bytes, not total envelope bytes", async () => {
		// Highly compressible payload: decompressed/gzip ratio is much larger
		// than decompressed/envelope ratio, so a policy ratio strictly between
		// them distinguishes the two formulas (the old envelope-byte
		// denominator would have accepted this artifact).
		const payload = new Uint8Array(4096);
		const gzip = gzipSync(payload, { level: TEST_COMPRESSION_LEVEL });
		const generous = await testOnlyPolicy({ chunkBytes: 64 });
		const crafted = await craftFramedArtifact(generous, gzip, PASSWORD);

		const gzipRatio = payload.length / gzip.length;
		const envelopeRatio = payload.length / crafted.length;
		expect(gzipRatio).toBeGreaterThan(envelopeRatio);

		const policy = await testOnlyPolicy({
			chunkBytes: 64,
			maxExpansionRatio: (gzipRatio + envelopeRatio) / 2,
		});
		const factory = await createCheckpointCryptoFactory([policy]);
		const error = await rejectionOf(
			(await factory.create({ id: policy.id })).openAndStage(sourceFrom([crafted]), PASSWORD),
		);
		expect(error.code).toBe("expansion-limit-exceeded");
	});
});

describe("seal/open byte accounting: same-policy consistency", () => {
	test("all three caps exactly at their real boundary values seal and open under one tiny policy", async () => {
		const payload = utf8("consistent ".repeat(32));
		const compressedLength = gzipSync(payload, { level: TEST_COMPRESSION_LEVEL }).length;
		const setup = await createTestCrypto({
			chunkBytes: 48,
			maxDecompressedBytes: payload.length,
			maxCompressedBytes: compressedLength,
			maxExpansionRatio: payload.length / compressedLength,
		});
		const artifact = await collect(await setup.crypto.seal(sourceFrom([payload]), PASSWORD));
		const opened = await openWith(setup, artifact);
		expect(bytesEqual(opened.bytes, payload)).toBe(true);
	});

	test("empty payload at a zero decompressed cap seals and opens", async () => {
		const setup = await createTestCrypto({ chunkBytes: 16, maxDecompressedBytes: 0 });
		const artifact = await collect(await setup.crypto.seal(sourceFrom([]), PASSWORD));
		const opened = await openWith(setup, artifact);
		expect(opened.bytes.length).toBe(0);
	});
});
