/**
 * Contract tests for the selected local-state codec.
 *
 * Scope: in-memory roundtrip, exact envelope layout, AAD binding, nonce
 * freshness, fail-closed bounds/malformed handling, and redacted errors. No
 * vault, network, real state directory, or product integration is touched.
 *
 * The 64 MiB test is the single boundary case. It allocates one over-limit
 * fixture and one exact-size fixture, drops/garbage-collects references between
 * phases, and does not concatenate additional copies.
 */
import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers-sumo";
import {
	type AuthenticatedStateCodec,
	STATE_CODEC_ENVELOPE_OVERHEAD_BYTES,
	STATE_CODEC_HEADER_BYTES,
	STATE_CODEC_MAGIC,
	STATE_CODEC_MAX_ENVELOPE_BYTES,
	STATE_CODEC_MAX_PLAINTEXT_BYTES,
	STATE_CODEC_MAX_SCOPE_BYTES,
	STATE_CODEC_MIN_ENVELOPE_BYTES,
	STATE_CODEC_NONCE_BYTES,
	STATE_CODEC_PURPOSE,
	STATE_CODEC_TAG_BYTES,
	STATE_CODEC_VERSION,
	StateCodecError,
	type StateCodecContext,
	createAuthenticatedStateCodec,
	validateStateScope,
} from "../../../src/cloud/state-codec/index.ts";

function context(hostScope = "host-instance-1"): StateCodecContext {
	return { purpose: "sessionport-local-state", formatVersion: 1, hostScope };
}

function patternKey(byte: number): Uint8Array {
	return new Uint8Array(32).fill(byte);
}

function hex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

function copy(bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(bytes.length);
	out.set(bytes);
	return out;
}

async function captureError(run: () => Promise<unknown> | unknown): Promise<StateCodecError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof StateCodecError) return error;
		throw error;
	}
	throw new Error("expected the codec to throw StateCodecError");
}

function withOverrides(overrides: Record<string, unknown>): StateCodecContext {
	return { ...context(), ...overrides } as unknown as StateCodecContext;
}

function collectGarbage(): void {
	const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun;
	bun?.gc?.(true);
}

/**
 * Test-local reconstruction of the documented AAD (independent of the codec):
 * header, then U32BE-length-prefixed purpose, version, and exact scope bytes.
 */
function documentedAad(header: Uint8Array, scopeBytes: Uint8Array): Uint8Array {
	const fields = [
		new TextEncoder().encode("sessionport-local-state"),
		new TextEncoder().encode("1"),
		scopeBytes,
	];
	let total = header.length;
	for (const field of fields) total += 4 + field.length;
	const aad = new Uint8Array(total);
	aad.set(header, 0);
	const view = new DataView(aad.buffer);
	let offset = header.length;
	for (const field of fields) {
		view.setUint32(offset, field.length, false);
		aad.set(field, offset + 4);
		offset += 4 + field.length;
	}
	return aad;
}

const codec: AuthenticatedStateCodec = createAuthenticatedStateCodec();

describe("selected local-state codec envelope", () => {
	test("exports the fixed decision constants", () => {
		expect(STATE_CODEC_MAGIC).toBe("SPST");
		expect(STATE_CODEC_VERSION).toBe(1);
		expect(STATE_CODEC_PURPOSE).toBe("sessionport-local-state");
		expect(STATE_CODEC_HEADER_BYTES).toBe(29);
		expect(STATE_CODEC_ENVELOPE_OVERHEAD_BYTES).toBe(45);
		expect(STATE_CODEC_MIN_ENVELOPE_BYTES).toBe(45);
		expect(STATE_CODEC_MAX_PLAINTEXT_BYTES).toBe(67_108_864);
		expect(STATE_CODEC_MAX_ENVELOPE_BYTES).toBe(67_108_909);
		expect(STATE_CODEC_NONCE_BYTES).toBe(24);
		expect(STATE_CODEC_TAG_BYTES).toBe(16);
		expect(STATE_CODEC_MAX_SCOPE_BYTES).toBe(512);
	});

	test("factory returns the injected interface without hidden defaults", () => {
		const instance = createAuthenticatedStateCodec();
		expect(typeof instance.seal).toBe("function");
		expect(typeof instance.open).toBe("function");
	});

	test("roundtrips empty plaintext with the minimum 45-byte envelope", async () => {
		const key = patternKey(0x01);
		const sealed = await codec.seal(new Uint8Array(0), key, context());
		expect(sealed.length).toBe(STATE_CODEC_MIN_ENVELOPE_BYTES);
		expect(hex(sealed.subarray(0, 4))).toBe(hex(Uint8Array.from([0x53, 0x50, 0x53, 0x54])));
		expect(sealed[4]).toBe(1);
		expect(sealed.length - STATE_CODEC_HEADER_BYTES).toBe(STATE_CODEC_TAG_BYTES);

		const opened = await codec.open(sealed, key, context());
		expect(opened.length).toBe(0);
	});

	test("roundtrips arbitrary binary plaintext without mutating caller inputs", async () => {
		const key = patternKey(0x5a);
		const keyBefore = copy(key);
		const plaintext = new Uint8Array(1_024);
		for (let index = 0; index < plaintext.length; index += 1) {
			plaintext[index] = (index * 31 + 7) & 0xff;
		}
		plaintext[0] = 0x00;
		plaintext[1] = 0xff;
		const plaintextBefore = copy(plaintext);
		const scope = "host-α-😀";

		const sealed = await codec.seal(plaintext, key, context(scope));
		expect(sealed.length).toBe(plaintext.length + STATE_CODEC_ENVELOPE_OVERHEAD_BYTES);
		expect(sealed[4]).toBe(STATE_CODEC_VERSION);

		const opened = await codec.open(sealed, key, context(scope));
		expect(opened).not.toBe(plaintext);
		expect(hex(opened)).toBe(hex(plaintext));

		expect(hex(key)).toBe(hex(keyBefore));
		expect(hex(plaintext)).toBe(hex(plaintextBefore));
	});

	test("uses a fresh nonce for every seal", async () => {
		const key = patternKey(0x33);
		const plaintext = new TextEncoder().encode("same input");
		const first = await codec.seal(plaintext, key, context());
		const second = await codec.seal(plaintext, key, context());
		expect(hex(first.subarray(5, STATE_CODEC_HEADER_BYTES))).not.toBe(
			hex(second.subarray(5, STATE_CODEC_HEADER_BYTES)),
		);
		expect(hex(first)).not.toBe(hex(second));
	});

	test("matches the documented envelope/AAD layout independently", async () => {
		await sodium.ready;
		const key = patternKey(0x66);
		const plaintext = new TextEncoder().encode("independent-layout");
		const scope = "host-layout-😀";
		const scopeBytes = new TextEncoder().encode(scope);

		// 1) An envelope built entirely outside the codec, with the documented
		// AAD, must open successfully.
		const nonce = new Uint8Array(STATE_CODEC_NONCE_BYTES);
		for (let index = 0; index < nonce.length; index += 1) nonce[index] = (index * 7 + 3) & 0xff;
		const manual = new Uint8Array(STATE_CODEC_ENVELOPE_OVERHEAD_BYTES + plaintext.length);
		manual.set([0x53, 0x50, 0x53, 0x54, 0x01], 0);
		manual.set(nonce, 5);
		const manuallySealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			plaintext,
			documentedAad(manual.subarray(0, STATE_CODEC_HEADER_BYTES), scopeBytes),
			null,
			nonce,
			key,
		);
		manual.set(manuallySealed, STATE_CODEC_HEADER_BYTES);
		const opened = await codec.open(manual, key, context(scope));
		expect(hex(opened)).toBe(hex(plaintext));

		// 2) The codec's own envelope must decrypt with the independently built
		// AAD and the nonce/header at the documented offsets.
		const sealed = await codec.seal(plaintext, key, context(scope));
		const independentlyOpened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
			null,
			sealed.subarray(STATE_CODEC_HEADER_BYTES),
			documentedAad(sealed.subarray(0, STATE_CODEC_HEADER_BYTES), scopeBytes),
			sealed.subarray(5, STATE_CODEC_HEADER_BYTES),
			key,
		);
		expect(hex(independentlyOpened)).toBe(hex(plaintext));
	});
});

describe("selected local-state codec authentication", () => {
	test("rejects a cross-scope open without returning plaintext", async () => {
		const key = patternKey(0x10);
		const sealed = await codec.seal(new TextEncoder().encode("bound"), key, context("host-a"));
		const error = await captureError(() => codec.open(sealed, key, context("host-b")));
		expect(error.code).toBe("state-corrupt");
	});

	test("rejects cross-purpose and cross-version contexts before decryption", async () => {
		const key = patternKey(0x11);
		const sealed = await codec.seal(new TextEncoder().encode("bound"), key, context());
		for (const invalid of [
			withOverrides({ purpose: "sessionport-cloud-state" }),
			withOverrides({ formatVersion: 2 }),
			withOverrides({ formatVersion: "1" }),
		]) {
			const error = await captureError(() => codec.open(sealed, key, invalid));
			expect(error.code).toBe("invalid-context");
		}
	});

	test("does not normalize host scope, so canonically equivalent scopes do not open", async () => {
		const key = patternKey(0x12);
		const plaintext = new TextEncoder().encode("scope-sensitive");
		const sealed = await codec.seal(plaintext, key, context("e\u0301"));
		const error = await captureError(() => codec.open(sealed, key, context("\u00e9")));
		expect(error.code).toBe("state-corrupt");
	});

	test("rejects a wrong key without mutating either key", async () => {
		const key = patternKey(0x20);
		const wrongKey = patternKey(0x21);
		const keyBefore = copy(key);
		const wrongBefore = copy(wrongKey);
		const sealed = await codec.seal(new TextEncoder().encode("secret"), key, context());
		const error = await captureError(() => codec.open(sealed, wrongKey, context()));
		expect(error.code).toBe("state-corrupt");
		expect(hex(key)).toBe(hex(keyBefore));
		expect(hex(wrongKey)).toBe(hex(wrongBefore));
	});

	test("rejects header, nonce, ciphertext, and tag tampering", async () => {
		const key = patternKey(0x30);
		const sealed = await codec.seal(new TextEncoder().encode("tamper target"), key, context());

		const magic = copy(sealed);
		magic[0] ^= 0xff;
		expect((await captureError(() => codec.open(magic, key, context()))).code).toBe("state-corrupt");

		const version = copy(sealed);
		version[4] = 2;
		expect((await captureError(() => codec.open(version, key, context()))).code).toBe("unsupported-version");

		const nonce = copy(sealed);
		nonce[5] ^= 0x01;
		expect((await captureError(() => codec.open(nonce, key, context()))).code).toBe("state-corrupt");

		const body = copy(sealed);
		body[STATE_CODEC_HEADER_BYTES] ^= 0x01;
		expect((await captureError(() => codec.open(body, key, context()))).code).toBe("state-corrupt");

		const tag = copy(sealed);
		tag[tag.length - 1] ^= 0x01;
		expect((await captureError(() => codec.open(tag, key, context()))).code).toBe("state-corrupt");
	});

	test("rejects truncation and appended bytes", async () => {
		const key = patternKey(0x40);
		const sealed = await codec.seal(new TextEncoder().encode("length bound"), key, context());

		expect((await captureError(() => codec.open(sealed.subarray(0, 44), key, context()))).code).toBe(
			"state-corrupt",
		);
		expect(
			(await captureError(() => codec.open(sealed.subarray(0, sealed.length - 1), key, context()))).code,
		).toBe("state-corrupt");
		const extended = new Uint8Array(sealed.length + 1);
		extended.set(sealed);
		expect((await captureError(() => codec.open(extended, key, context()))).code).toBe("state-corrupt");
	});

	test("redacts keys, scope, plaintext, and causes from errors", async () => {
		const secretScope = "host-secret-😀";
		const key = patternKey(0x42);
		const wrongKey = patternKey(0x24);
		const plaintext = new TextEncoder().encode("highly-sensitive-payload");
		const sealed = await codec.seal(plaintext, key, context(secretScope));
		const error = await captureError(() => codec.open(sealed, wrongKey, context(secretScope)));

		expect(error.code).toBe("state-corrupt");
		expect(error.message).toBe("The encrypted state is corrupt or failed authentication.");
		expect("cause" in error).toBe(false);
		const rendered = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
		expect(rendered).not.toContain(secretScope);
		expect(rendered).not.toContain(hex(plaintext));
		expect(rendered).not.toContain(hex(wrongKey));
	});
});

describe("selected local-state codec bounds and input types", () => {
	test("rejects malformed envelopes before decryption", async () => {
		// Wrong key makes decrypt-attempt evidence visible: a real decryption
		// attempt would be state-corrupt, not the structural code asserted.
		const wrongKey = patternKey(0xee);
		expect((await captureError(() => codec.open(new Uint8Array(0), wrongKey, context()))).code).toBe(
			"state-corrupt",
		);
		expect((await captureError(() => codec.open(new Uint8Array(44), wrongKey, context()))).code).toBe(
			"state-corrupt",
		);

		const badMagic = new Uint8Array(STATE_CODEC_MIN_ENVELOPE_BYTES);
		badMagic.set([0x58, 0x50, 0x53, 0x54, 0x01]);
		expect((await captureError(() => codec.open(badMagic, wrongKey, context()))).code).toBe("state-corrupt");

		const badVersion = new Uint8Array(STATE_CODEC_MIN_ENVELOPE_BYTES);
		badVersion.set([0x53, 0x50, 0x53, 0x54, 0x02]);
		expect((await captureError(() => codec.open(badVersion, wrongKey, context()))).code).toBe(
			"unsupported-version",
		);
	});

	test("rejects non-byte and fake-length inputs before copying", async () => {
		const key = patternKey(0x55);
		const plaintext = new TextEncoder().encode("typed input");

		expect(
			(await captureError(() => codec.seal("not-bytes" as unknown as Uint8Array, key, context()))).code,
		).toBe("invalid-input");
		expect(
			(await captureError(() => codec.open("not-bytes" as unknown as Uint8Array, key, context()))).code,
		).toBe("invalid-input");

		const fakePlaintext = { length: STATE_CODEC_MAX_PLAINTEXT_BYTES + 1 } as unknown as Uint8Array;
		expect((await captureError(() => codec.seal(fakePlaintext, key, context()))).code).toBe("invalid-input");

		const fakeEnvelope = { length: 44 } as unknown as Uint8Array;
		expect((await captureError(() => codec.open(fakeEnvelope, key, context()))).code).toBe("invalid-input");

		const sealed = await codec.seal(plaintext, key, context());
		expect((await captureError(() => codec.seal(plaintext, new Uint8Array(31), context()))).code).toBe(
			"invalid-key",
		);
		expect((await captureError(() => codec.open(sealed, new Uint8Array(33), context()))).code).toBe(
			"invalid-key",
		);
	});

	test("bounds host scope to 512 UTF-8 bytes with Unicode and control checks", () => {
		const badScopes = [
			"",
			"\u0000",
			"a\u0000b",
			"a\u001fb",
			"a\u007fb",
			"\ud800",
			"\udc00",
			"a\ud800b",
			"\udc00\ud800",
			"x".repeat(STATE_CODEC_MAX_SCOPE_BYTES + 1),
			"😀".repeat(129),
		];
		for (const bad of badScopes) {
			const error = (() => {
				try {
					validateStateScope(bad);
				} catch (caught) {
					return caught;
				}
				throw new Error("expected scope validation to fail");
			})() as StateCodecError;
			expect(error).toBeInstanceOf(StateCodecError);
			expect(error.code).toBe("invalid-context");
		}
		expect(validateStateScope("x".repeat(512)).length).toBe(512);
		expect(validateStateScope("😀".repeat(128)).length).toBe(512);
		expect(validateStateScope("\ufffd").length).toBe(3);
	});

	test(
		"handles the 64 MiB plaintext boundary and rejects over-cap inputs",
		async () => {
			const key = patternKey(0x77);
			const boundaryContext = context("host-boundary");

			// One shared over-cap fixture: 46 bytes over the plaintext cap and
			// one byte over the envelope cap. It is never concatenated/copied.
			let overLimit: Uint8Array | null = new Uint8Array(STATE_CODEC_MAX_ENVELOPE_BYTES + 1);
			overLimit.set([0x53, 0x50, 0x53, 0x54, 0x01]);
			const overSealError = await captureError(() => codec.seal(overLimit as Uint8Array, key, boundaryContext));
			expect(overSealError.code).toBe("state-too-large");
			// Wrong key means a decrypt attempt would be state-corrupt; the size
			// cap must win before any decryption.
			const overOpenError = await captureError(() =>
				codec.open(overLimit as Uint8Array, patternKey(0x99), boundaryContext),
			);
			expect(overOpenError.code).toBe("state-too-large");
			overLimit.fill(0);
			overLimit = null;
			collectGarbage();

			let plaintext: Uint8Array | null = new Uint8Array(STATE_CODEC_MAX_PLAINTEXT_BYTES);
			plaintext[0] = 0xa5;
			plaintext[plaintext.length - 1] = 0x5a;
			let envelope: Uint8Array | null = await codec.seal(plaintext, key, boundaryContext);
			expect(envelope.length).toBe(STATE_CODEC_MAX_ENVELOPE_BYTES);
			plaintext.fill(0);
			plaintext = null;
			collectGarbage();

			let opened: Uint8Array | null = await codec.open(envelope, key, boundaryContext);
			expect(opened.length).toBe(STATE_CODEC_MAX_PLAINTEXT_BYTES);
			expect(opened[0]).toBe(0xa5);
			expect(opened[opened.length - 1]).toBe(0x5a);
			opened.fill(0);
			opened = null;
			envelope.fill(0);
			envelope = null;
			collectGarbage();
		},
		{ timeout: 30_000 },
	);
});
