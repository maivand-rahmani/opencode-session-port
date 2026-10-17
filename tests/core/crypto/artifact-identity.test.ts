/**
 * PROVISIONAL artifact-identity tests (O-22, Phase 3A).
 *
 * The owner-selected O-22 scheme (2026-10-09) generates one random 128-bit
 * identity per checkpoint artifact and authenticates it in the artifact. This
 * file pins the provisional header placement (identity appended at offset 32;
 * fixed header length 48; the complete header is frame AAD), the seal/open
 * roundtrip, tamper rejection, and that the identity is surfaced only after
 * complete authentication plus strict gzip/bounds checks.
 *
 * All values are synthetic and in-memory. The envelope remains PROVISIONAL
 * (O-02): nothing here freezes the format or claims backward compatibility.
 */
import { describe, expect, test } from "bun:test";
import { ARTIFACT_IDENTITY_BYTES } from "../../../src/core/contracts/crypto.ts";
import {
	decodeEnvelopeHeader,
	ENVELOPE_FORMAT_VERSION,
	ENVELOPE_HEADER_BYTES,
	ENVELOPE_HEADER_SALT_BYTES,
	ENVELOPE_HEADER_SALT_OFFSET,
	ENVELOPE_IDENTITY_BYTES,
	ENVELOPE_IDENTITY_OFFSET,
	ENVELOPE_MAGIC,
	ENVELOPE_SECRETSTREAM_HEADER_BYTES,
	encodeEnvelopeHeader,
} from "../../../src/core/crypto/envelope.ts";
import { CryptoContainerError } from "../../../src/core/crypto/index.ts";
import {
	bytesEqual,
	collect,
	createTestCrypto,
	flipByte,
	interceptSecretstreamPull,
	parseArtifact,
	reassemble,
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

describe("PROVISIONAL artifact identity (O-22)", () => {
	test("seal/open roundtrip surfaces the authenticated 16-byte identity", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: 7 });
		const payload = utf8("artifact identity roundtrip payload ".repeat(4));
		const artifact = await collect(await crypto.seal(sourceFrom([payload]), PASSWORD));
		const parsed = parseArtifact(artifact);

		const opened = await (await factory.create({ id: policy.id })).openAndStage(
			sourceFrom([artifact]),
			PASSWORD,
		);
		expect(bytesEqual(opened.bytes, payload)).toBe(true);
		expect(opened.artifactIdentity).toBeInstanceOf(Uint8Array);
		expect(opened.artifactIdentity.length).toBe(ARTIFACT_IDENTITY_BYTES);
		expect(bytesEqual(opened.artifactIdentity, parsed.artifactIdentity)).toBe(true);
	});

	test("separate seals produce distinct artifact identities (probabilistic smoke only)", async () => {
		const { crypto } = await createTestCrypto({ chunkBytes: 7 });
		const payload = utf8("identical payload for distinct-identity check");
		const first = parseArtifact(await collect(await crypto.seal(sourceFrom([payload]), PASSWORD)));
		const second = parseArtifact(await collect(await crypto.seal(sourceFrom([payload]), PASSWORD)));

		expect(bytesEqual(first.artifactIdentity, second.artifactIdentity)).toBe(false);
	});

	test("tampering with an identity header byte is authenticated and rejected", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await collect(await crypto.seal(sourceFrom([utf8("identity tamper payload")]), PASSWORD));
		const parsed = parseArtifact(artifact);
		const tamperedHeader = flipByte(parsed.header, ENVELOPE_IDENTITY_OFFSET + 5);

		// The identity bytes are opaque to the decoder, so header decoding still
		// succeeds; the complete header is frame AAD, so authentication must fail.
		expect(() => decodeEnvelopeHeader(tamperedHeader)).not.toThrow();
		const error = await rejectionOf(
			(await factory.create({ id: policy.id })).openAndStage(
				sourceFrom([reassemble({ ...parsed, header: tamperedHeader }, parsed.frames)]),
				PASSWORD,
			),
		);
		expect(error).toBeInstanceOf(CryptoContainerError);
		expect((error as CryptoContainerError).code).toBe("authentication-failed");
	});

	test("identity is not surfaced when authentication or bound checks fail", async () => {
		const { policy, factory, crypto } = await createTestCrypto({ chunkBytes: 7 });
		const payload = utf8("identity exposure guard payload ".repeat(8));
		const artifact = await collect(await crypto.seal(sourceFrom([payload]), PASSWORD));
		const parsed = parseArtifact(artifact);
		expect(parsed.frames.length).toBeGreaterThanOrEqual(2);

		// (a) Removed final tag: rejects with no payload and no identity.
		const withoutFinal = reassemble(parsed, parsed.frames.slice(0, -1));
		const missingFinal = await rejectionOf(
			(await factory.create({ id: policy.id })).openAndStage(sourceFrom([withoutFinal]), PASSWORD),
		);
		expect(missingFinal).toBeInstanceOf(CryptoContainerError);
		expect((missingFinal as CryptoContainerError).code).toBe("missing-final-tag");
		expect("bytes" in (missingFinal as object)).toBe(false);
		expect("artifactIdentity" in (missingFinal as object)).toBe(false);

		// (b) First frame authentic (its plaintext is really pulled and
		// processed), second frame tampered: rejection still exposes nothing.
		const tamperedSecond = flipByte(parsed.frames[1]!, parsed.frames[1]!.length - 1);
		const badArtifact = reassemble(parsed, [parsed.frames[0]!, tamperedSecond, ...parsed.frames.slice(2)]);
		const pullProbe = await interceptSecretstreamPull();
		try {
			const error = await rejectionOf(
				(await factory.create({ id: policy.id })).openAndStage(sourceFrom([badArtifact]), PASSWORD),
			);
			expect(error).toBeInstanceOf(CryptoContainerError);
			expect((error as CryptoContainerError).code).toBe("authentication-failed");
			expect(pullProbe.messages.length).toBeGreaterThanOrEqual(1);
			expect("bytes" in (error as object)).toBe(false);
			expect("artifactIdentity" in (error as object)).toBe(false);
		} finally {
			pullProbe.restore();
		}
	});

	test("provisional header keeps prior field offsets and appends the identity at offset 32", async () => {
		const { policy, crypto } = await createTestCrypto({ chunkBytes: 7 });
		const artifact = await collect(await crypto.seal(sourceFrom([utf8("header offset payload")]), PASSWORD));
		const parsed = parseArtifact(artifact);
		const header = parsed.header;

		expect(ENVELOPE_HEADER_BYTES).toBe(48);
		expect(ENVELOPE_IDENTITY_OFFSET).toBe(32);
		expect(ENVELOPE_IDENTITY_BYTES).toBe(ARTIFACT_IDENTITY_BYTES);
		expect(header.length).toBe(ENVELOPE_HEADER_BYTES);
		expect(header.slice(0, ENVELOPE_MAGIC.length)).toEqual(ENVELOPE_MAGIC);
		expect(header[8]).toBe(ENVELOPE_FORMAT_VERSION);
		expect(header[10]).toBe(policy.profileCode);
		expect(parsed.artifactIdentity.length).toBe(ARTIFACT_IDENTITY_BYTES);
		expect(parsed.secretstreamHeader.length).toBe(ENVELOPE_SECRETSTREAM_HEADER_BYTES);
		expect(
			bytesEqual(
				header.slice(ENVELOPE_IDENTITY_OFFSET, ENVELOPE_IDENTITY_OFFSET + ARTIFACT_IDENTITY_BYTES),
				parsed.artifactIdentity,
			),
		).toBe(true);
		// O-22 explicitly must not reuse the Argon2 salt as the identity.
		const salt = header.slice(ENVELOPE_HEADER_SALT_OFFSET, ENVELOPE_HEADER_SALT_OFFSET + ENVELOPE_HEADER_SALT_BYTES);
		expect(bytesEqual(salt, parsed.artifactIdentity)).toBe(false);
	});

	test("decodeEnvelopeHeader returns a caller-owned identity copy, not an alias", () => {
		const identity = Uint8Array.from({ length: ARTIFACT_IDENTITY_BYTES }, (_, index) => index + 1);
		const header = encodeEnvelopeHeader({
			profileCode: 7,
			salt: new Uint8Array(ENVELOPE_HEADER_SALT_BYTES),
			artifactIdentity: identity,
		});
		const decoded = decodeEnvelopeHeader(header);
		expect(bytesEqual(decoded.artifactIdentity, identity)).toBe(true);

		header.fill(0);
		expect(bytesEqual(decoded.artifactIdentity, identity)).toBe(true);
	});

	test("encodeEnvelopeHeader rejects identities that are not exactly 16 bytes", () => {
		for (const length of [0, 15, 17]) {
			let caught: unknown;
			try {
				encodeEnvelopeHeader({
					profileCode: 7,
					salt: new Uint8Array(ENVELOPE_HEADER_SALT_BYTES),
					artifactIdentity: new Uint8Array(length),
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(CryptoContainerError);
			expect((caught as CryptoContainerError).code).toBe("invalid-header");
		}
	});
});
