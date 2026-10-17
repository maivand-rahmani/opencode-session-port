/**
 * PROVISIONAL remapped-ID derivation tests (O-22, Phase 3A).
 *
 * Pins the provisional `v1` encoding selected for implementation on
 * 2026-10-09: BLAKE2b-256 (pinned `crypto_generichash`, 32-byte output) over
 * length-prefixed UTF-8 "SessionPort/remapped-id", "v1", the namespace, the
 * raw 16-byte artifact identity, and `JSON.stringify(originalID)`, where every
 * field carries an 8-byte unsigned big-endian byte-length prefix. Outputs are
 * `ses_`/`msg_` + 64 lowercase hex.
 *
 * The encoding is PROVISIONAL and versioned (`v1`); it is not a released
 * format and makes no host-compatibility claim (OQ-24 remains OPEN). All
 * inputs are synthetic.
 */
import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers-sumo";
import { ARTIFACT_IDENTITY_BYTES } from "../../../src/core/contracts/crypto.ts";
import { CryptoContainerError } from "../../../src/core/crypto/index.ts";
import {
	createRemappedIdDeriver,
	RemappedIdError,
	type RemappedIdNamespace,
} from "../../../src/core/restore/identity.ts";

/** BLAKE2b-256 of the empty input (reference vector). */
const BLAKE2B_256_EMPTY_HEX = "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8";

const IDENTITY_A = Uint8Array.from({ length: ARTIFACT_IDENTITY_BYTES }, (_, index) => index);
const IDENTITY_B = Uint8Array.from({ length: ARTIFACT_IDENTITY_BYTES }, (_, index) => 0xf0 + index);

function u64be(value: number): Uint8Array {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
	return out;
}

/** One length-prefixed framed field, rebuilt independently of the module. */
function frame(field: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + field.length);
	out.set(u64be(field.length), 0);
	out.set(field, 8);
	return out;
}

/** Independently rebuilt `v1` framed derivation input. */
function expectedFramedInput(namespace: string, identity: Uint8Array, originalID: string): Uint8Array {
	const encoder = new TextEncoder();
	const parts = [
		frame(encoder.encode("SessionPort/remapped-id")),
		frame(encoder.encode("v1")),
		frame(encoder.encode(namespace)),
		frame(identity),
		frame(encoder.encode(JSON.stringify(originalID))),
	];
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

describe("PROVISIONAL remapped-ID derivation (O-22)", () => {
	test("pinned BLAKE2b-256 empty-input known-answer vector uses the 32-byte parameterization", async () => {
		await sodium.ready;
		const digest32 = sodium.crypto_generichash(32, new Uint8Array(0), null);
		expect(digest32.length).toBe(32);
		expect(sodium.to_hex(digest32)).toBe(BLAKE2B_256_EMPTY_HEX);

		// A 64-byte BLAKE2b digest truncated to 32 bytes is a different
		// function output; the configured-length KAT above must not match it.
		const digest64 = sodium.crypto_generichash(64, new Uint8Array(0), null);
		expect(sodium.to_hex(digest64).slice(0, 64)).not.toBe(BLAKE2B_256_EMPTY_HEX);
	});

	test("outputs use exact prefixes and 68-character lowercase hex", async () => {
		const deriver = await createRemappedIdDeriver();
		const sessionId = deriver.derive("session", IDENTITY_A, "ses_original");
		const messageId = deriver.derive("message", IDENTITY_A, "msg_original");

		expect(sessionId).toMatch(/^ses_[0-9a-f]{64}$/);
		expect(messageId).toMatch(/^msg_[0-9a-f]{64}$/);
		expect(sessionId.length).toBe(68);
		expect(messageId.length).toBe(68);
		expect(sessionId).toBe(sessionId.toLowerCase());
		expect(messageId).toBe(messageId.toLowerCase());
	});

	test("derivation is stable for the same inputs across instances", async () => {
		const first = await createRemappedIdDeriver();
		const second = await createRemappedIdDeriver();
		for (const namespace of ["session", "message"] as const) {
			const a = first.derive(namespace, IDENTITY_A, "ses_stable");
			const b = second.derive(namespace, IDENTITY_A, "ses_stable");
			const c = first.derive(namespace, IDENTITY_A, "ses_stable");
			expect(a).toBe(b);
			expect(a).toBe(c);
		}
	});

	test("namespace, artifact identity, and original ID separate the derivation domain", async () => {
		const deriver = await createRemappedIdDeriver();
		const base = deriver.derive("session", IDENTITY_A, "ses_separation");

		// Same inputs derive the same value.
		expect(deriver.derive("session", IDENTITY_A, "ses_separation")).toBe(base);
		// Namespace separation (compare the hex bodies, not only the prefixes).
		const message = deriver.derive("message", IDENTITY_A, "ses_separation");
		expect(message).not.toBe(base);
		expect(message.slice(4)).not.toBe(base.slice(4));
		// Artifact identity separation.
		expect(deriver.derive("session", IDENTITY_B, "ses_separation")).not.toBe(base);
		// Original ID separation.
		expect(deriver.derive("session", IDENTITY_A, "ses_other")).not.toBe(base);
	});

	test("derivation matches an independently framed BLAKE2b-256 computation", async () => {
		const deriver = await createRemappedIdDeriver();
		const originalIds = ["", "ses_plain", "msg_with spaces/and:punctuation", "😀-emoji-\ud800-lone-surrogate"];
		for (const namespace of ["session", "message"] as const) {
			for (const originalID of originalIds) {
				const digest = sodium.crypto_generichash(
					32,
					expectedFramedInput(namespace, IDENTITY_A, originalID),
					null,
				);
				const prefix = namespace === "session" ? "ses_" : "msg_";
				expect(deriver.derive(namespace, IDENTITY_A, originalID)).toBe(prefix + sodium.to_hex(digest));
			}
		}
	});

	test("JSON string encoding preserves arbitrary JS strings without lossy replacement", async () => {
		const deriver = await createRemappedIdDeriver();
		const loneSurrogateLow = deriver.derive("session", IDENTITY_A, "\ud800");
		const loneSurrogateHigh = deriver.derive("session", IDENTITY_A, "\ud801");
		const replacementChar = deriver.derive("session", IDENTITY_A, "\ufffd");

		// JSON.stringify escapes lone surrogates, so TextEncoder never applies
		// U+FFFD replacement: each distinct JS string derives a distinct output.
		expect(loneSurrogateLow).not.toBe(loneSurrogateHigh);
		expect(loneSurrogateLow).not.toBe(replacementChar);
		expect(loneSurrogateHigh).not.toBe(replacementChar);
	});

	test("input validation fails closed without fallback or regeneration", async () => {
		const deriver = await createRemappedIdDeriver();
		const cases: ReadonlyArray<{ run: () => unknown; code: string }> = [
			{
				run: () => deriver.derive("other" as RemappedIdNamespace, IDENTITY_A, "ses_x"),
				code: "invalid-namespace",
			},
			{
				run: () => deriver.derive("session", new Uint8Array(15), "ses_x"),
				code: "invalid-artifact-identity",
			},
			{
				run: () => deriver.derive("session", new Uint8Array(17), "ses_x"),
				code: "invalid-artifact-identity",
			},
			{
				run: () => deriver.derive("session", null as unknown as Uint8Array, "ses_x"),
				code: "invalid-artifact-identity",
			},
			{
				run: () => deriver.derive("session", IDENTITY_A, 42 as unknown as string),
				code: "invalid-original-id",
			},
		];
		for (const testCase of cases) {
			let caught: unknown;
			try {
				testCase.run();
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(RemappedIdError);
			expect((caught as RemappedIdError).code).toBe(testCase.code);
		}
	});

	test("original IDs never appear in outputs or validation errors", async () => {
		const deriver = await createRemappedIdDeriver();
		const distinctive = "ses_distinctive-original-id-1234";
		expect(deriver.derive("session", IDENTITY_A, distinctive)).not.toContain("distinctive");

		let caught: unknown;
		try {
			deriver.derive("session", new Uint8Array(3), distinctive);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(RemappedIdError);
		expect((caught as Error).message).not.toContain(distinctive);
	});

	test("createRemappedIdDeriver fails closed when crypto_generichash is missing", async () => {
		await sodium.ready;
		const mutable = sodium as unknown as { crypto_generichash?: typeof sodium.crypto_generichash };
		const original = mutable.crypto_generichash;
		mutable.crypto_generichash = undefined;
		try {
			let caught: unknown;
			try {
				await createRemappedIdDeriver();
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(CryptoContainerError);
			expect((caught as CryptoContainerError).code).toBe("unsupported-runtime");
		} finally {
			mutable.crypto_generichash = original;
		}
	});
});
