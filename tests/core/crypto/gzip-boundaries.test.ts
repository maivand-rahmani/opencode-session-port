/**
 * Container-level strict gzip boundary tests.
 *
 * Owner-approved policy: accept one or more complete RFC 1952 members and
 * reject every byte after the final member, including zero padding. These
 * tests bring the boundary through the PROVISIONAL container (`openAndStage`)
 * so the decrypted-gzip layer is exercised with real secretstream framing:
 * no payload is returned on any boundary failure, and staged plaintext is
 * best-effort zeroed.
 *
 * Format assumptions (O-02) and numeric caps (O-03) remain OPEN; the values
 * used here are arbitrary test-only values.
 */
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { CryptoContainerError } from "../../../src/core/crypto/index.ts";
import { buildGzipMember, gzipStream } from "./gzip-fixtures.ts";
import {
	allZero,
	bytesEqual,
	concat,
	createTestCrypto,
	craftFramedArtifact,
	interceptMemzero,
	sourceFrom,
	utf8,
} from "./test-only-support.ts";

const PASSWORD = utf8("synthetic-test-password-a");

async function cryptoRejection(promise: Promise<unknown>): Promise<CryptoContainerError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof CryptoContainerError) return error;
		throw error;
	}
	throw new Error("expected the operation to reject, but it resolved");
}

async function openCraftedGzip(plaintext: Uint8Array): Promise<Uint8Array> {
	const { policy, factory } = await createTestCrypto({ chunkBytes: 64 });
	const artifact = await craftFramedArtifact(policy, plaintext, PASSWORD);
	const opened = await (await factory.create({ id: policy.id })).openAndStage(
		sourceFrom([artifact]),
		PASSWORD,
	);
	return opened.bytes;
}

async function rejectCraftedGzip(plaintext: Uint8Array): Promise<CryptoContainerError> {
	const { policy, factory } = await createTestCrypto({ chunkBytes: 64 });
	const artifact = await craftFramedArtifact(policy, plaintext, PASSWORD);
	const error = await cryptoRejection(
		(await factory.create({ id: policy.id })).openAndStage(sourceFrom([artifact]), PASSWORD),
	);
	expect("bytes" in error).toBe(false);
	return error;
}

describe("container strict gzip boundary (owner-approved policy)", () => {
	test("concatenated gzip members open to the concatenation", async () => {
		const firstPlain = utf8("container-member-one");
		const secondPlain = utf8("container-member-two");
		const out = await openCraftedGzip(concat([gzipSync(firstPlain), gzipSync(secondPlain)]));
		expect(bytesEqual(out, concat([firstPlain, secondPlain]))).toBe(true);
	});

	test("trailing zero padding (1..16) rejects and returns no payload", async () => {
		const plain = utf8("payload before zero padding");
		const member = gzipSync(plain);
		for (let padding = 1; padding <= 16; padding += 1) {
			const error = await rejectCraftedGzip(concat([member, new Uint8Array(padding)]));
			expect(error.code).toBe("gzip-error");
		}
	});

	test("non-zero junk after the final member rejects", async () => {
		const plaintext = concat([gzipSync(utf8("member payload")), Uint8Array.from([9, 9, 9, 9, 9])]);
		const error = await rejectCraftedGzip(plaintext);
		expect(error.code).toBe("gzip-error");
	});

	test("valid member followed by a truncated second member rejects", async () => {
		const first = gzipSync(utf8("first container member"));
		const second = buildGzipMember({ data: utf8("second container member") });
		for (const point of [1, second.headerLength + 1, second.bytes.length - 1]) {
			const error = await rejectCraftedGzip(concat([first, second.bytes.subarray(0, point)]));
			expect(error.code).toBe("gzip-error");
		}
	});

	test("valid member followed by a malformed second member rejects", async () => {
		const first = gzipSync(utf8("first container member"));
		const malformed = buildGzipMember({
			data: utf8("malformed second container member"),
			corrupt: { invalidBlockType: true },
		});
		const error = await rejectCraftedGzip(concat([first, malformed.bytes]));
		expect(error.code).toBe("gzip-error");
	});

	test("all optional header fields and FHCRC open", async () => {
		const plain = utf8("container optional header payload");
		const member = buildGzipMember({
			data: plain,
			extra: Uint8Array.from([0xaa, 0xbb]),
			name: "container.bin",
			comment: "container comment",
			fhcrc: true,
		});
		const out = await openCraftedGzip(member.bytes);
		expect(bytesEqual(out, plain)).toBe(true);
	});

	test("corrupt FHCRC / CRC32 / ISIZE / DEFLATE members reject", async () => {
		const plain = utf8("container checksum payload");
		const cases = [
			buildGzipMember({ data: plain, fhcrc: true, corrupt: { fhcrc: true } }),
			buildGzipMember({ data: plain, corrupt: { crc32: true } }),
			buildGzipMember({ data: plain, corrupt: { isize: true } }),
			buildGzipMember({ data: plain, corrupt: { invalidBlockType: true } }),
		];
		for (const member of cases) {
			const error = await rejectCraftedGzip(member.bytes);
			expect(error.code).toBe("gzip-error");
		}
	});

	test("a late-member failure zeroes the already-staged plaintext", async () => {
		const firstPlain = utf8("container staged plaintext ".repeat(4));
		const second = gzipSync(utf8("container second member"));
		const plaintext = concat([gzipSync(firstPlain), second.subarray(0, second.length - 3)]);
		const { policy, factory } = await createTestCrypto({ chunkBytes: 64 });
		const artifact = await craftFramedArtifact(policy, plaintext, PASSWORD);
		const probe = await interceptMemzero();
		try {
			const error = await cryptoRejection(
				(await factory.create({ id: policy.id })).openAndStage(sourceFrom([artifact]), PASSWORD),
			);
			expect(error.code).toBe("gzip-error");
			// The first member's plaintext was decompressed privately before the
			// second member failed; it must have been best-effort cleared and
			// never returned.
			expect(probe.snapshots.some((snapshot) => bytesEqual(snapshot, firstPlain))).toBe(true);
			for (const zeroed of probe.calls) expect(allZero(zeroed)).toBe(true);
		} finally {
			probe.restore();
		}
	});

	test("multi-member stream with FHCRC and optional fields round-trips through the container", async () => {
		const parts = [utf8("alpha|"), utf8("beta|"), utf8("gamma")];
		const stream = gzipStream([
			buildGzipMember({ data: parts[0]!, fhcrc: true }).bytes,
			buildGzipMember({ data: parts[1]!, name: "beta.bin" }).bytes,
			buildGzipMember({ data: parts[2]!, extra: Uint8Array.from([7, 7]) }).bytes,
		]);
		const out = await openCraftedGzip(stream);
		expect(bytesEqual(out, concat(parts))).toBe(true);
	});
});
