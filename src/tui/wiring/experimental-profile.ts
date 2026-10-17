/**
 * Experimental runtime defaults (Phase 2 wiring; originally recorded for the
 * Windows-first lane).
 *
 * The `sessionport-experimental-win-v1` selector name is historical and is NOT
 * portability evidence: enabling macOS/Linux changes no profile, format, or cap
 * value below.
 *
 * These are the explicitly selected, owner-authorized experimental values
 * recorded in `docs/v1/decision-log.md` (2026-10-11 entries) for the Windows
 * experimental build; they now apply unchanged to the experimental macOS/Linux
 * enablement, which is NOT host-tested. They are NOT a production approval, not
 * a format freeze, and not a general memory budget, compatibility, or support
 * claim.
 *
 * - Crypto profile `sessionport-experimental-win-v1`: profile code 1,
 *   Argon2id13 `crypto_pwhash`, `opslimit=2`, `memlimit=128 MiB`, the current
 *   implementation's 16-byte random salt, 64-KiB plaintext frames, password cap
 *   4 KiB, total encrypted artifact cap 66 MiB, decrypted gzip input cap
 *   64 MiB, decompressed payload cap 256 MiB, expansion ratio 128 defined as
 *   decompressed payload bytes / decrypted compressed gzip bytes.
 * - Collection bounds: session page size 50, message page size 200, at most
 *   1,000 sessions, at most 10,000 messages per session, and at most 50,000
 *   messages total. Exceeding any bound fails the whole collection; nothing is
 *   ever truncated.
 */

import type { CryptoPolicy } from "../../core/contracts/index.ts";
import type { CryptoPolicyDefinition } from "../../core/crypto/index.ts";
import type { SessionCollectionPolicy } from "../../core/sessions/index.ts";

/** Explicit allow-listed policy id for the experimental profile (historical `-win-` name). */
export const EXPERIMENTAL_CRYPTO_POLICY_ID = "sessionport-experimental-win-v1";

/** The explicit policy selector passed to the crypto factory; never read from an artifact. */
export const EXPERIMENTAL_CRYPTO_POLICY: CryptoPolicy = Object.freeze({
	id: EXPERIMENTAL_CRYPTO_POLICY_ID,
});

/** Experimental password byte limit; the password UI is given the same value. */
export const EXPERIMENTAL_MAX_PASSWORD_BYTES = 4 * 1024;

/**
 * The complete experimental allow-list definition. Numeric values are the
 * owner-recorded Windows-experimental defaults; changing any value requires a
 * new recorded decision and a fresh review (O-01/O-02/O-03 remain PARTIALLY
 * RESOLVED for the experimental Windows build only).
 */
export const EXPERIMENTAL_CRYPTO_POLICY_DEFINITION: CryptoPolicyDefinition = deepFreeze({
	id: EXPERIMENTAL_CRYPTO_POLICY_ID,
	profileCode: 1,
	kdf: {
		opsLimit: 2,
		memLimit: 128 * 1024 * 1024,
	},
	compression: {
		level: undefined,
	},
	framing: {
		chunkBytes: 64 * 1024,
	},
	limits: {
		maxPasswordBytes: EXPERIMENTAL_MAX_PASSWORD_BYTES,
		maxArtifactBytes: 66 * 1024 * 1024,
		maxCompressedBytes: 64 * 1024 * 1024,
		maxDecompressedBytes: 256 * 1024 * 1024,
		maxExpansionRatio: 128,
	},
});

/**
 * The complete experimental collection policy. `maxTotalMessages` is the
 * required core aggregate cap (zero is a valid fail-closed value in core; the
 * experimental value is 50,000).
 */
export const EXPERIMENTAL_COLLECTION_POLICY: SessionCollectionPolicy = deepFreeze({
	sessionPageSize: 50,
	messagePageSize: 200,
	maxSessions: 1000,
	maxMessagesPerSession: 10000,
	maxTotalMessages: 50000,
});

/** Deep-freezes a plain JSON-shaped configuration object. */
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const key of Object.keys(value)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
		Object.freeze(value);
	}
	return value;
}
