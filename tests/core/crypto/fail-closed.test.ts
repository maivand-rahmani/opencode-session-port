/**
 * PROVISIONAL crypto container fail-closed tests (Phase 2, lane B).
 *
 * Every case asserts the container rejects and returns NO payload: wrong
 * password, tampered ciphertext/header/AAD, reorder/drop/truncation/missing
 * final tag, malformed gzip, unknown policy/profile (before KDF), and cap
 * violations. All values are synthetic test-only assumptions; the format and
 * numeric caps remain OPEN (O-01/O-02/O-03).
 */
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { encodeEnvelopeHeader } from "../../../src/core/crypto/envelope.ts";
import {
	createCheckpointCryptoFactory,
	CryptoContainerError,
} from "../../../src/core/crypto/index.ts";
import {
	collect,
	concat,
	countingDerivation,
	craftFramedArtifact,
	createTestCrypto,
	flipByte,
	parseArtifact,
	reassemble,
	sourceFrom,
	testOnlyPolicy,
	utf8,
	withByte,
	type TestCryptoSetup,
} from "./test-only-support.ts";

const PASSWORD = utf8("synthetic-test-password-a");

type Factory = Awaited<ReturnType<typeof createCheckpointCryptoFactory>>;

async function expectRejection(promise: Promise<unknown>): Promise<CryptoContainerError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof CryptoContainerError) return error;
		throw error;
	}
	throw new Error("expected the operation to reject, but it resolved");
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
	return (await expectRejection(promise)).code;
}

async function sealArtifact(crypto: TestCryptoSetup["crypto"], payload: Uint8Array, password = PASSWORD) {
	return collect(await crypto.seal(sourceFrom([payload]), password));
}

async function openArtifact(
	factory: Factory,
	policyId: string,
	artifact: Uint8Array,
	password = PASSWORD,
) {
	return (await factory.create({ id: policyId })).openAndStage(sourceFrom([artifact]), password);
}

function rewriteFrameLength(frame: Uint8Array, length: number): Uint8Array {
	const copy = Uint8Array.from(frame);
	new DataView(copy.buffer).setUint32(0, length, false);
	return copy;
}

describe("crypto container (PROVISIONAL envelope): fail closed", () => {
	test("wrong password rejects and returns no payload", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await sealArtifact(crypto, utf8("synthetic payload for wrong-password test"));

		const error = await expectRejection(
			openArtifact(factory, policy.id, artifact, utf8("synthetic-test-password-wrong")),
		);
		expect(error.code).toBe("authentication-failed");
		expect("bytes" in error).toBe(false);
	});

	test("modified ciphertext byte rejects", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await sealArtifact(crypto, utf8("tamper-me ciphertext payload"));
		const parsed = parseArtifact(artifact);
		const firstFrame = parsed.frames[0]!;
		const tampered = flipByte(firstFrame, firstFrame.length - 1);

		expect(
			await failureCode(
				openArtifact(factory, policy.id, reassemble(parsed, [tampered, ...parsed.frames.slice(1)])),
			),
		).toBe("authentication-failed");
	});

	test("modified envelope salt rejects", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await sealArtifact(crypto, utf8("tamper-me header salt payload"));
		const parsed = parseArtifact(artifact);
		const tamperedHeader = flipByte(parsed.header, 20);

		expect(
			await failureCode(
				openArtifact(factory, policy.id, reassemble({ ...parsed, header: tamperedHeader }, parsed.frames)),
			),
		).toBe("authentication-failed");
	});

	test("modified frame length prefix (AAD) rejects", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await sealArtifact(crypto, utf8("tamper-me frame length prefix"));
		const parsed = parseArtifact(artifact);
		const firstFrame = parsed.frames[0]!;
		const originalLength = new DataView(firstFrame.buffer, firstFrame.byteOffset, 4).getUint32(0, false);
		const tampered = rewriteFrameLength(firstFrame, originalLength - 1);

		expect(
			await failureCode(
				openArtifact(factory, policy.id, reassemble(parsed, [tampered, ...parsed.frames.slice(1)])),
			),
		).toBe("authentication-failed");
	});

	test("absurd frame length prefix rejects before allocation", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await sealArtifact(crypto, utf8("oversized frame length prefix"));
		const parsed = parseArtifact(artifact);
		const tampered = rewriteFrameLength(parsed.frames[0]!, 0xffffffff);

		expect(
			await failureCode(
				openArtifact(factory, policy.id, reassemble(parsed, [tampered, ...parsed.frames.slice(1)])),
			),
		).toBe("invalid-frame");
	});

	test("reordered frames reject", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await sealArtifact(crypto, utf8("reorder these authenticated frames please"));
		const parsed = parseArtifact(artifact);
		expect(parsed.frames.length).toBeGreaterThanOrEqual(2);
		const reordered = [parsed.frames[1]!, parsed.frames[0]!, ...parsed.frames.slice(2)];

		expect(await failureCode(openArtifact(factory, policy.id, reassemble(parsed, reordered)))).toBe(
			"authentication-failed",
		);
	});

	test("dropped middle frame rejects", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await sealArtifact(crypto, utf8("drop a middle frame from this artifact"));
		const parsed = parseArtifact(artifact);
		expect(parsed.frames.length).toBeGreaterThanOrEqual(3);
		const dropped = [...parsed.frames.slice(0, 1), ...parsed.frames.slice(2)];

		expect(await failureCode(openArtifact(factory, policy.id, reassemble(parsed, dropped)))).toBe(
			"authentication-failed",
		);
	});

	test("removed final frame rejects with missing-final-tag", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await sealArtifact(crypto, utf8("remove the final secretstream frame"));
		const parsed = parseArtifact(artifact);
		const withoutFinal = parsed.frames.slice(0, -1);

		expect(await failureCode(openArtifact(factory, policy.id, reassemble(parsed, withoutFinal)))).toBe(
			"missing-final-tag",
		);
	});

	test("truncated artifact rejects", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await sealArtifact(crypto, utf8("truncate the final frame bytes"));

		expect(await failureCode(openArtifact(factory, policy.id, artifact.subarray(0, artifact.length - 1)))).toBe(
			"truncated-artifact",
		);
	});

	test("bytes after the final frame reject as trailing data", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await sealArtifact(crypto, utf8("trailing bytes after the final frame"));
		const parsed = parseArtifact(artifact);
		const withTrailing = reassemble(parsed, [...parsed.frames, new Uint8Array([0, 0, 0, 0])]);

		expect(await failureCode(openArtifact(factory, policy.id, withTrailing))).toBe("trailing-data");
	});

	test("malformed gzip plaintext rejects", async () => {
		const { policy, factory } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await craftFramedArtifact(policy, utf8("this is definitely not gzip data"), PASSWORD);

		expect(await failureCode(openArtifact(factory, policy.id, artifact))).toBe("gzip-error");
	});

	test("truncated gzip stream rejects", async () => {
		const { policy, factory } = await createTestCrypto({ chunkBytes: 7 });
		const gzip = gzipSync(utf8("synthetic gzip payload ".repeat(40)));
		const artifact = await craftFramedArtifact(policy, gzip.subarray(0, gzip.length - 6), PASSWORD);

		expect(await failureCode(openArtifact(factory, policy.id, artifact))).toBe("gzip-error");
	});

	test("unknown policy id rejects before KDF", async () => {
		const counting = countingDerivation();
		const { factory } = await createTestCrypto({}, { derivation: counting.derivation });

		const error = await expectRejection(factory.create({ id: "test-only-does-not-exist" }));
		expect(error.code).toBe("unknown-policy");
		expect(counting.calls()).toBe(0);
	});

	test("unknown profile code rejects before KDF", async () => {
		const counting = countingDerivation();
		const policy = await testOnlyPolicy({});
		const factory = await createCheckpointCryptoFactory([policy], { derivation: counting.derivation });
		const crypto = await factory.create({ id: policy.id });

		const header = encodeEnvelopeHeader({
			profileCode: 199,
			salt: new Uint8Array(16),
			artifactIdentity: new Uint8Array(16),
		});
		const error = await expectRejection(crypto.openAndStage(sourceFrom([header]), PASSWORD));
		expect(error.code).toBe("unknown-kdf-profile");
		expect(counting.calls()).toBe(0);
	});

	test("header field validation rejects before KDF", async () => {
		const counting = countingDerivation();
		const { policy, crypto, factory } = await createTestCrypto(
			{ chunkBytes: 7 },
			{ derivation: counting.derivation },
		);
		const artifact = await sealArtifact(crypto, utf8("header validation payload"));
		const parsed = parseArtifact(artifact);
		// Sealing legitimately performed one KDF; record the count and require
		// that the header rejections below add none.
		const callsAfterSeal = counting.calls();

		const cases: ReadonlyArray<{ index: number; value: number; code: string }> = [
			{ index: 0, value: 0x00, code: "invalid-header" },
			{ index: 8, value: 2, code: "unsupported-format-version" },
			{ index: 9, value: 1, code: "unsupported-algorithm" },
			{ index: 10, value: 199, code: "unknown-kdf-profile" },
			{ index: 11, value: 2, code: "unsupported-algorithm" },
			{ index: 12, value: 2, code: "unsupported-algorithm" },
			{ index: 13, value: 1, code: "invalid-header" },
			{ index: 14, value: 1, code: "invalid-header" },
		];
		for (const mutated of cases) {
			const header = withByte(parsed.header, mutated.index, mutated.value);
			expect(
				await failureCode(
					openArtifact(factory, policy.id, reassemble({ ...parsed, header }, parsed.frames)),
				),
			).toBe(mutated.code);
		}
		expect(counting.calls()).toBe(callsAfterSeal);
	});

	test("profile code swap inside the allow-list still fails authentication (header is AAD)", async () => {
		const first = await testOnlyPolicy({ id: "test-only-profile-one", profileCode: 241, chunkBytes: 7 });
		const second = await testOnlyPolicy({ id: "test-only-profile-two", profileCode: 242, chunkBytes: 7 });
		const factory = await createCheckpointCryptoFactory([first, second]);
		const crypto = await factory.create({ id: first.id });
		const artifact = await sealArtifact(crypto, utf8("profile swap payload"));
		const parsed = parseArtifact(artifact);
		const swappedHeader = withByte(parsed.header, 10, 242);

		expect(
			await failureCode(
				openArtifact(factory, second.id, reassemble({ ...parsed, header: swappedHeader }, parsed.frames)),
			),
		).toBe("authentication-failed");
	});

	test("artifact size cap rejects on seal", async () => {
		const { crypto } = await createTestCrypto({ maxArtifactBytes: 20 });
		expect(await failureCode(crypto.seal(sourceFrom([utf8("x")]), PASSWORD))).toBe("artifact-too-large");
	});

	test("artifact size cap rejects before KDF on open", async () => {
		const generous = await testOnlyPolicy({ chunkBytes: 7 });
		const generousFactory = await createCheckpointCryptoFactory([generous]);
		const artifact = await sealArtifact(
			await generousFactory.create({ id: generous.id }),
			utf8("cap test payload"),
		);

		const counting = countingDerivation();
		const capped = await testOnlyPolicy({ maxArtifactBytes: 20 });
		const cappedFactory = await createCheckpointCryptoFactory([capped], { derivation: counting.derivation });
		const error = await expectRejection(openArtifact(cappedFactory, capped.id, artifact));
		expect(error.code).toBe("artifact-too-large");
		expect(counting.calls()).toBe(0);
	});

	test("decompressed size cap rejects and returns no payload", async () => {
		// Seal now enforces this cap too, so the over-limit artifact is crafted
		// with a generous policy and opened under the capped one (the profile
		// code is shared by the test-only definitions).
		const payload = new Uint8Array(8192);
		const generous = await testOnlyPolicy({ chunkBytes: 64 });
		const artifact = await craftFramedArtifact(generous, gzipSync(payload), PASSWORD);

		const capped = await testOnlyPolicy({ chunkBytes: 64, maxDecompressedBytes: 1024 });
		const cappedFactory = await createCheckpointCryptoFactory([capped]);
		const error = await expectRejection(openArtifact(cappedFactory, capped.id, artifact));
		expect(error.code).toBe("decompressed-limit-exceeded");
		expect("bytes" in error).toBe(false);
	});

	test("compressed input cap rejects exactly over the limit and returns no payload", async () => {
		const gzip = gzipSync(utf8("compressed cap payload ".repeat(8)));
		const generous = await testOnlyPolicy({ chunkBytes: 64 });
		const artifact = await craftFramedArtifact(generous, gzip, PASSWORD);

		const capped = await testOnlyPolicy({ chunkBytes: 64, maxCompressedBytes: gzip.length - 1 });
		const cappedFactory = await createCheckpointCryptoFactory([capped]);
		const error = await expectRejection(openArtifact(cappedFactory, capped.id, artifact));
		expect(error.code).toBe("compressed-limit-exceeded");
		expect("bytes" in error).toBe(false);
	});

	test("compressed input cap exactly at the limit opens", async () => {
		const plain = utf8("compressed cap exact payload ".repeat(8));
		const gzip = gzipSync(plain);
		const generous = await testOnlyPolicy({ chunkBytes: 64 });
		const artifact = await craftFramedArtifact(generous, gzip, PASSWORD);

		const exact = await testOnlyPolicy({ chunkBytes: 64, maxCompressedBytes: gzip.length });
		const exactFactory = await createCheckpointCryptoFactory([exact]);
		const opened = await (await exactFactory.create({ id: exact.id })).openAndStage(
			sourceFrom([artifact]),
			PASSWORD,
		);
		expect(Buffer.from(opened.bytes).equals(Buffer.from(plain))).toBe(true);
	});

	test("decompressed cap aggregates across concatenated gzip members", async () => {
		const firstPlain = utf8("aaaaaa");
		const secondPlain = utf8("bbbbbb");
		const gzip = concat([gzipSync(firstPlain), gzipSync(secondPlain)]);
		const generous = await testOnlyPolicy({ chunkBytes: 64 });
		const artifact = await craftFramedArtifact(generous, gzip, PASSWORD);

		const capped = await testOnlyPolicy({
			chunkBytes: 64,
			maxCompressedBytes: gzip.length,
			maxDecompressedBytes: 11,
		});
		const cappedFactory = await createCheckpointCryptoFactory([capped]);
		const error = await expectRejection(openArtifact(cappedFactory, capped.id, artifact));
		expect(error.code).toBe("decompressed-limit-exceeded");
		expect("bytes" in error).toBe(false);
	});

	test("expansion ratio cap rejects and returns no payload", async () => {
		// Seal now enforces this cap too, so the over-limit artifact is crafted
		// with a generous policy and opened under the capped one.
		const payload = new Uint8Array(64 * 1024);
		const generous = await testOnlyPolicy({ chunkBytes: 64 });
		const artifact = await craftFramedArtifact(generous, gzipSync(payload), PASSWORD);

		const capped = await testOnlyPolicy({
			chunkBytes: 64,
			maxDecompressedBytes: 1 << 20,
			maxExpansionRatio: 2,
		});
		const cappedFactory = await createCheckpointCryptoFactory([capped]);
		const error = await expectRejection(openArtifact(cappedFactory, capped.id, artifact));
		expect(error.code).toBe("expansion-limit-exceeded");
		expect("bytes" in error).toBe(false);
	});

	test("password input rules reject", async () => {
		const { policy, crypto, factory } = await createTestCrypto({ maxPasswordBytes: 32 });
		expect(await failureCode(crypto.seal(sourceFrom([utf8("x")]), new Uint8Array(0)))).toBe(
			"invalid-password",
		);
		expect(await failureCode(crypto.seal(sourceFrom([utf8("x")]), new Uint8Array(33)))).toBe(
			"invalid-password",
		);
		const artifact = await sealArtifact(crypto, utf8("ok"), utf8("synthetic-short"));
		expect(await failureCode(openArtifact(factory, policy.id, artifact, new Uint8Array(0)))).toBe(
			"invalid-password",
		);
	});

	test("invalid policy definitions reject at factory construction", async () => {
		const policy = await testOnlyPolicy({});
		expect(
			await failureCode(
				createCheckpointCryptoFactory([
					{ ...policy, kdf: { opsLimit: 0, memLimit: policy.kdf.memLimit } },
				]),
			),
		).toBe("invalid-policy-definition");
		expect(await failureCode(createCheckpointCryptoFactory([await testOnlyPolicy({ chunkBytes: 0 })]))).toBe(
			"invalid-policy-definition",
		);
		expect(
			await failureCode(
				createCheckpointCryptoFactory([
					{ ...policy, limits: { ...policy.limits, maxExpansionRatio: 0 } },
				]),
			),
		).toBe("invalid-policy-definition");
		// maxCompressedBytes is required and must be a positive safe integer
		// (a gzip stream needs at least one nonempty member; 0 is invalid).
		const missingCompressedCap = {
			...policy,
			limits: { ...policy.limits, maxCompressedBytes: undefined },
		} as unknown as typeof policy;
		for (const limits of [
			missingCompressedCap.limits,
			{ ...policy.limits, maxCompressedBytes: 0 },
			{ ...policy.limits, maxCompressedBytes: -1 },
			{ ...policy.limits, maxCompressedBytes: 1.5 },
			{ ...policy.limits, maxCompressedBytes: Number.NaN },
		]) {
			expect(await failureCode(createCheckpointCryptoFactory([{ ...policy, limits }]))).toBe(
				"invalid-policy-definition",
			);
		}
		const duplicateCode = await testOnlyPolicy({ id: "test-only-duplicate-code" });
		expect(await failureCode(createCheckpointCryptoFactory([policy, duplicateCode]))).toBe(
			"invalid-policy-definition",
		);
	});
});
