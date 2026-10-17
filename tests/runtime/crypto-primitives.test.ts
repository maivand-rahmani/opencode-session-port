/**
 * SessionPort — isolated runtime smoke tests for pinned dependencies (Phase 1).
 *
 * Scope and evidence boundaries:
 * - Synthetic, in-memory only. No real project/session/password data, no file I/O,
 *   no temp artifacts, no network, no Git, and no OpenCode host state.
 * - These tests exercise primitive availability and basic round trips for the
 *   pinned `libsodium-wrappers-sumo@0.8.4` and Node-compatible `node:stream` /
 *   `node:zlib` under Bun 1.3.10.
 * - NO production crypto design is chosen here: no production Argon2id profile,
 *   chunk size, frame format, or size cap is selected or implied. The KDF runs at
 *   the library's absolute minimum limits purely to keep the smoke test cheap.
 * - No key, password, salt, or plaintext is printed or persisted; byte material is
 *   compared in memory and best-effort zeroed with sodium.memzero().
 *
 * Packaging note (observed on Bun 1.3.10 with libsodium-wrappers-sumo 0.8.4):
 * the runtime ESM build (`dist/modules-sumo-esm/libsodium-wrappers.mjs`) has
 * `export default t`, where `t` is the object populated after `ready` resolves.
 * It does NOT provide runtime named exports for `crypto_pwhash` or the
 * `crypto_secretstream_*` functions (its named exports are only utilities such as
 * `ready`, `to_hex`, `memzero`, ...), even though the shipped `.d.mts` declares
 * them. A namespace import (`import * as sodium`) therefore leaves those crypto
 * functions `undefined` at runtime. The working, typed form is the default import
 * used below. Do not "fix" this by reaching into package internals.
 */

import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import sodium from "libsodium-wrappers-sumo";

/** Narrow the `{ message, tag } | false` result of secretstream pull. */
function requirePulled(
	result: { message: Uint8Array; tag: number } | false,
): { message: Uint8Array; tag: number } {
	if (result === false) {
		throw new Error("secretstream authentication failed (pull returned false)");
	}
	return result;
}

describe("runtime smoke: libsodium SUMO + node:stream gzip (Bun)", () => {
	test("ESM default import initializes and exposes crypto_pwhash + secretstream APIs", async () => {
		// `ready` is a thenable; all crypto operations require it.
		expect(sodium.ready).toBeInstanceOf(Promise);
		await sodium.ready;

		// Version string is informative evidence only; do not pin an exact upstream version here.
		expect(typeof sodium.SODIUM_VERSION_STRING).toBe("string");
		expect(sodium.SODIUM_VERSION_STRING.length).toBeGreaterThan(0);

		// Argon2id KDF surface (SUMO-only; not present in the non-sumo wrappers).
		expect(typeof sodium.crypto_pwhash).toBe("function");
		expect(typeof sodium.crypto_pwhash_ALG_ARGON2ID13).toBe("number");
		// libsodium's documented Argon2id algorithm identifier (RFC 9106 id 2);
		// asserted to catch accidental reliance on the alias constant.
		expect(sodium.crypto_pwhash_ALG_ARGON2ID13).toBe(2);
		expect(typeof sodium.crypto_pwhash_OPSLIMIT_MIN).toBe("number");
		expect(typeof sodium.crypto_pwhash_MEMLIMIT_MIN).toBe("number");
		expect(typeof sodium.crypto_pwhash_SALTBYTES).toBe("number");

		// XChaCha20-Poly1305 secretstream surface and wire-format constants.
		expect(typeof sodium.crypto_secretstream_xchacha20poly1305_keygen).toBe("function");
		expect(typeof sodium.crypto_secretstream_xchacha20poly1305_init_push).toBe("function");
		expect(typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull).toBe("function");
		expect(typeof sodium.crypto_secretstream_xchacha20poly1305_push).toBe("function");
		expect(typeof sodium.crypto_secretstream_xchacha20poly1305_pull).toBe("function");
		expect(typeof sodium.crypto_secretstream_xchacha20poly1305_rekey).toBe("function");
		expect(sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES).toBe(32);
		expect(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES).toBe(24);
		expect(sodium.crypto_secretstream_xchacha20poly1305_ABYTES).toBe(17);
		expect(sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE).toBe(0);
		expect(sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL).toBe(3);
	});

	test("Argon2id crypto_pwhash runs at library-minimum smoke-test cost", async () => {
		await sodium.ready;

		// Synthetic input only. Never substitute real project/session password data here.
		const password = sodium.from_string("sessionport-synthetic-smoke-password");
		const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);

		// Smoke-test output length only. Production KDF output policy is OPEN (O-01/O-03)
		// and must not be inferred from this test; 32 is used purely as a small fixed size.
		const outputBytes = 32;

		// OPSLIMIT_MIN / MEMLIMIT_MIN are libsodium's absolute minimums. They are
		// chosen ONLY to keep this smoke test fast and are NOT a production
		// recommendation or a candidate profile.
		const derived = sodium.crypto_pwhash(
			outputBytes,
			password,
			salt,
			sodium.crypto_pwhash_OPSLIMIT_MIN,
			sodium.crypto_pwhash_MEMLIMIT_MIN,
			sodium.crypto_pwhash_ALG_ARGON2ID13,
		);
		expect(derived).toBeInstanceOf(Uint8Array);
		expect(derived.length).toBe(outputBytes);

		// Deterministic for identical inputs (same salt) — sanity property, not a design claim.
		const derivedAgain = sodium.crypto_pwhash(
			outputBytes,
			password,
			salt,
			sodium.crypto_pwhash_OPSLIMIT_MIN,
			sodium.crypto_pwhash_MEMLIMIT_MIN,
			sodium.crypto_pwhash_ALG_ARGON2ID13,
		);
		expect(sodium.memcmp(derived, derivedAgain)).toBe(true);

		// Distinct salt yields distinct output.
		const otherSalt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
		const derivedOtherSalt = sodium.crypto_pwhash(
			outputBytes,
			password,
			otherSalt,
			sodium.crypto_pwhash_OPSLIMIT_MIN,
			sodium.crypto_pwhash_MEMLIMIT_MIN,
			sodium.crypto_pwhash_ALG_ARGON2ID13,
		);
		expect(sodium.memcmp(derived, derivedOtherSalt)).toBe(false);

		// Best-effort cleanup of all derived/input byte material.
		sodium.memzero(derived);
		sodium.memzero(derivedAgain);
		sodium.memzero(derivedOtherSalt);
		sodium.memzero(otherSalt);
		sodium.memzero(salt);
		sodium.memzero(password);
	});

	test("secretstream: two-chunk round trip with required final tag, tamper and wrong-key failure", async () => {
		await sodium.ready;

		const TAG_MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
		const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;

		const key = sodium.crypto_secretstream_xchacha20poly1305_keygen();
		expect(key).toBeInstanceOf(Uint8Array);
		expect(key.length).toBe(sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES);

		// Encryption side: explicit header plus at least two chunks; only the last
		// chunk carries the required final tag.
		const { state: pushState, header } =
			sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
		expect(header).toBeInstanceOf(Uint8Array);
		expect(header.length).toBe(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);

		const chunk1 = sodium.from_string("synthetic-chunk-one");
		const chunk2 = sodium.from_string("synthetic-chunk-two");
		const cipher1 = sodium.crypto_secretstream_xchacha20poly1305_push(
			pushState,
			chunk1,
			null,
			TAG_MESSAGE,
		);
		const cipher2 = sodium.crypto_secretstream_xchacha20poly1305_push(
			pushState,
			chunk2,
			null,
			TAG_FINAL,
		);
		expect(cipher1.length).toBe(chunk1.length + sodium.crypto_secretstream_xchacha20poly1305_ABYTES);
		expect(cipher2.length).toBe(chunk2.length + sodium.crypto_secretstream_xchacha20poly1305_ABYTES);

		// Decryption side: strict chunk order; last tag must be TAG_FINAL.
		const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
		const pulled1 = requirePulled(
			sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, cipher1, null),
		);
		const pulled2 = requirePulled(
			sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, cipher2, null),
		);
		expect(sodium.memcmp(pulled1.message, chunk1)).toBe(true);
		expect(sodium.memcmp(pulled2.message, chunk2)).toBe(true);
		expect(pulled1.tag).toBe(TAG_MESSAGE);
		expect(pulled2.tag).toBe(TAG_FINAL); // required end-of-stream marker observed

		// Tampered ciphertext must fail authentication. A fresh pull state is used so
		// the failure is attributable to the tamper, not to consumed pull state.
		const tamperedCipher = Uint8Array.from(cipher1);
		tamperedCipher[tamperedCipher.length - 1] ^= 0x01;
		const pullTampered = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
		expect(
			sodium.crypto_secretstream_xchacha20poly1305_pull(pullTampered, tamperedCipher, null),
		).toBe(false);

		// Tampered header (security-relevant input) must also fail authentication.
		const tamperedHeader = Uint8Array.from(header);
		tamperedHeader[0] ^= 0x01;
		const pullBadHeader = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
			tamperedHeader,
			key,
		);
		expect(
			sodium.crypto_secretstream_xchacha20poly1305_pull(pullBadHeader, cipher1, null),
		).toBe(false);

		// Wrong key must fail authentication.
		const wrongKey = sodium.crypto_secretstream_xchacha20poly1305_keygen();
		const pullWrongKey = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, wrongKey);
		expect(
			sodium.crypto_secretstream_xchacha20poly1305_pull(pullWrongKey, cipher1, null),
		).toBe(false);

		// libsodium-wrappers-sumo 0.8.4 exposes no documented free/release API for
		// secretstream state tokens (no `*_free` function). States are dropped for
		// garbage collection; all byte material we control is zeroed best-effort.
		sodium.memzero(key);
		sodium.memzero(wrongKey);
		sodium.memzero(chunk1);
		sodium.memzero(chunk2);
		sodium.memzero(pulled1.message);
		sodium.memzero(pulled2.message);
	});

	test("node:stream + node:zlib gzip/gunzip streaming round trip is fully in memory", async () => {
		const plainChunks = [
			Buffer.from("sessionport synthetic gzip chunk 1 ".repeat(16)),
			Buffer.from("sessionport synthetic gzip chunk 2 ".repeat(16)),
			Buffer.from("sessionport synthetic gzip chunk 3 ".repeat(16)),
		];
		const expected = Buffer.concat(plainChunks);

		// Compress by streaming the chunks through createGzip() (no file I/O).
		const gzChunks: Buffer[] = [];
		await pipeline(
			Readable.from(plainChunks),
			createGzip(),
			new Writable({
				write(chunk: Buffer, _encoding, callback) {
					gzChunks.push(Buffer.from(chunk));
					callback();
				},
			}),
		);
		expect(gzChunks.length).toBeGreaterThan(0);
		const gzipped = Buffer.concat(gzChunks);
		// gzip magic bytes (RFC 1952) — sanity check that node:zlib produced gzip framing.
		expect(gzipped[0]).toBe(0x1f);
		expect(gzipped[1]).toBe(0x8b);
		expect(gzipped.length).toBeLessThan(expected.length);

		// Decompress by streaming the gzip bytes through createGunzip() (no file I/O).
		const outChunks: Buffer[] = [];
		await pipeline(
			Readable.from(gzChunks),
			createGunzip(),
			new Writable({
				write(chunk: Buffer, _encoding, callback) {
					outChunks.push(Buffer.from(chunk));
					callback();
				},
			}),
		);
		const roundTripped = Buffer.concat(outChunks);
		expect(roundTripped.length).toBe(expected.length);
		expect(roundTripped.equals(expected)).toBe(true);
	});
});
