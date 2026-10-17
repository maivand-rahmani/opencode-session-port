/**
 * PROVISIONAL crypto container round-trip tests (Phase 2, lane B).
 *
 * All payloads/passwords are synthetic and in-memory. The envelope format,
 * chunk sizing, and caps exercised here are test-only provisional assumptions
 * (O-01/O-02/O-03 remain OPEN); nothing in this file is a production profile.
 */
import { describe, expect, test } from "bun:test";
import {
	collect,
	createTestCrypto,
	parseArtifact,
	sourceFrom,
	splitSource,
	utf8,
} from "./test-only-support.ts";

const PASSWORD_A = utf8("synthetic-test-password-a");

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return Buffer.from(a).equals(Buffer.from(b));
}

describe("crypto container (PROVISIONAL envelope): round trips", () => {
	test("multiple frames round-trip with varied and empty source chunks", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: 7 });
		const payload = utf8("The quick brown fox jumps over the lazy dog. ".repeat(6));
		const artifact = await collect(
			await crypto.seal(
				sourceFrom([payload.subarray(0, 11), new Uint8Array(0), payload.subarray(11)]),
				PASSWORD_A,
			),
		);
		// Tiny chunk size forces several secretstream frames (provisional framing).
		expect(parseArtifact(artifact).frames.length).toBeGreaterThan(1);

		const opened = await (await factory.create({ id: policy.id })).openAndStage(
			sourceFrom([artifact]),
			PASSWORD_A,
		);
		expect(sameBytes(opened.bytes, payload)).toBe(true);
	});

	test("empty payload round-trips", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await collect(await crypto.seal(sourceFrom([]), PASSWORD_A));
		expect(artifact.length).toBeGreaterThan(0);

		const opened = await (await factory.create({ id: policy.id })).openAndStage(
			sourceFrom([artifact]),
			PASSWORD_A,
		);
		expect(opened.bytes.length).toBe(0);
	});

	test("payload consisting of empty source chunks round-trips", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await collect(
			await crypto.seal(sourceFrom([new Uint8Array(0), new Uint8Array(0)]), PASSWORD_A),
		);
		const opened = await (await factory.create({ id: policy.id })).openAndStage(
			sourceFrom([artifact]),
			PASSWORD_A,
		);
		expect(opened.bytes.length).toBe(0);
	});

	test("larger payload round-trips across many frames", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: 64 });
		// Deterministic xorshift payload that gzip cannot compress away, so the
		// frame count really exercises multi-frame streaming.
		const payload = new Uint8Array(64 * 1024);
		let state = 0x12345678;
		for (let index = 0; index < payload.length; index += 1) {
			state ^= (state << 13) >>> 0;
			state >>>= 0;
			state ^= state >>> 17;
			state ^= (state << 5) >>> 0;
			state >>>= 0;
			payload[index] = state & 0xff;
		}

		const artifact = await collect(
			await crypto.seal(splitSource(payload, [1024, 3, 900]), PASSWORD_A),
		);
		expect(parseArtifact(artifact).frames.length).toBeGreaterThan(100);

		const opened = await (await factory.create({ id: policy.id })).openAndStage(
			splitSource(artifact, [1, 5, 4096]),
			PASSWORD_A,
		);
		expect(sameBytes(opened.bytes, payload)).toBe(true);
	});

	test("artifact source chunking does not affect the result", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: 16 });
		const payload = utf8("chunking-invariance ".repeat(20));
		const artifact = await collect(await crypto.seal(sourceFrom([payload]), PASSWORD_A));

		const whole = await (await factory.create({ id: policy.id })).openAndStage(
			sourceFrom([artifact]),
			PASSWORD_A,
		);
		const byteAtATime = await (await factory.create({ id: policy.id })).openAndStage(
			splitSource(artifact, 1),
			PASSWORD_A,
		);
		expect(sameBytes(whole.bytes, payload)).toBe(true);
		expect(sameBytes(byteAtATime.bytes, payload)).toBe(true);
	});

	test("the same artifact decrypts repeatedly from a fresh instance", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: 9 });
		const payload = utf8("repeat-open ".repeat(10));
		const artifact = await collect(await crypto.seal(sourceFrom([payload]), PASSWORD_A));
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const opened = await (await factory.create({ id: policy.id })).openAndStage(
				sourceFrom([artifact]),
				PASSWORD_A,
			);
			expect(sameBytes(opened.bytes, payload)).toBe(true);
		}
	});
});
