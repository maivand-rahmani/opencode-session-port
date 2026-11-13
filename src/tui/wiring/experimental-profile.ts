/**
 * Experimental runtime defaults (Phase 2 wiring; originally recorded for the
 * Windows-first lane).
 *
 * The `sessionport-experimental-win-v1` selector name is historical and is NOT
 * portability evidence: enabling macOS/Linux changes no profile, format, or cap
 * value below.
 *
 * These are the explicitly selected, owner-authorized experimental values
 * recorded in `docs/archive/v1/decision-log.md` (2026-10-11 entries) for the Windows
 * experimental build; they now apply unchanged to the experimental macOS/Linux
 * enablement, which is NOT host-tested. They are NOT a production approval, not
 * a format freeze, and not a general memory budget, compatibility, or support
 * claim.
 *
 * - Crypto profile `sessionport-experimental-win-v1`: profile code 1,
 *   Argon2id13 `crypto_pwhash`, `opslimit=2`, `memlimit=128 MiB`, the current
 *   implementation's 16-byte random salt, 64-KiB plaintext frames, password cap
 *   4 KiB, total encrypted artifact cap 560 MiB, decrypted gzip input cap
 *   512 MiB, decompressed payload cap 512 MiB, expansion ratio 128 defined as
 *   decompressed payload bytes / decrypted compressed gzip bytes.
 *   (2026-11-12 owner-directed long-session revision: the previous caps were
 *   66 MiB artifact / 64 MiB compressed / 256 MiB decompressed. A real
 *   246-session workspace project serialized to 244.1 MiB and 65.04 MiB of
 *   gzip, so the old compressed cap rejected every checkpoint of that project.
 *   The profile code, KDF, framing, format, and expansion ratio are unchanged;
 *   only these experimental byte bounds were raised. See
 *   `docs/evidence/long-session-checkpoint-20261112.md`.)
 * - Collection bounds: session page size 50, message page size 200, at most
 *   1,000 sessions, at most 10,000 messages per session, and at most 50,000
 *   messages total. Exceeding any bound fails the whole collection; nothing is
 *   ever truncated.
 * - Subagent retention (2026-11-13 owner-directed checkpoint-weight policy):
 *   checkpoints always include root sessions, plus child (subagent) sessions
 *   selected by the configured mode. The default mode `since-compaction` keeps
 *   every root session and child sessions created after the project's most
 *   recent root-session compaction, capped by `maxSubagentSessions`; `latest`
 *   keeps every root session plus the most recently updated N children;
 *   `roots` keeps the `maxRootSessions` most recently active roots and all of
 *   their descendant children (older roots and their children are omitted);
 *   `all` keeps every child. Excluded sessions are deliberately absent from the
 *   artifact to keep checkpoints small; they remain in the host database and
 *   are NOT deleted by SessionPort. This is an explicit, reported completeness
 *   trade-off, not silent truncation or a core-collection rule: restore
 *   destination snapshots still use the unchanged full collection. Dependency
 *   closure can still add referenced parent/fork sessions after the filter.
 *   The measured effect on the real workspace project was 247.7 MiB payload /
 *   90.3 MiB artifact for all sessions versus 27.7 MiB / 13.6 MiB for the
 *   since-compaction rule (a ~85% reduction). See
 *   `docs/evidence/checkpoint-retention-20261113.md` and
 *   `docs/evidence/root-session-retention-20261113.md`.
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

/** Configured checkpoint subagent-retention mode. */
export type ExperimentalSubagentRetentionMode = "latest" | "since-compaction" | "all" | "roots";

/**
 * Activity window used to recommend "last N root sessions" in the chooser.
 * Thirty days matches the owner's stated intuition that a root session from a
 * week or a month ago is usually no longer needed. It is advisory only: it
 * never filters a checkpoint unless the user picks the `roots` mode.
 */
export const EXPERIMENTAL_RETENTION_RECOMMENDATION_WINDOW_DAYS = 30;

/**
 * Checkpoint retention policy (owner-directed 2026-11-13 to reduce artifact
 * weight; configurable by editing this value). Root inclusion depends on the
 * mode: `roots` keeps only the latest N roots, every other mode keeps all
 * roots:
 * - `since-compaction` (default): keep every child session created after the
 *   most recent compaction of a project root session; no cap. Falls back to
 *   `latest` when no compaction exists.
 * - `latest`: keep the `maxSubagentSessions` most recently updated children.
 * - `roots`: keep the `maxRootSessions` most recently active root sessions and
 *   all of their subagent descendants.
 * - `all`: keep every child session (no weight reduction).
 * `maxSubagentSessions` is a non-negative safe integer or `null` (no cap;
 * valid for `since-compaction`); `0` keeps roots only. `maxRootSessions` is a
 * positive safe integer required by `roots` and `null` otherwise. This is a
 * wiring-level checkpoint policy, not a crypto profile value and not a core
 * collection rule. The checkpoint report states the exact kept and excluded
 * counts.
 */
export const EXPERIMENTAL_SUBAGENT_RETENTION: {
	readonly mode: ExperimentalSubagentRetentionMode;
	readonly maxSubagentSessions: number | null;
	readonly maxRootSessions: number | null;
} = Object.freeze({
	mode: "since-compaction",
	maxSubagentSessions: null,
	maxRootSessions: null,
});

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
		maxArtifactBytes: 560 * 1024 * 1024,
		maxCompressedBytes: 512 * 1024 * 1024,
		maxDecompressedBytes: 512 * 1024 * 1024,
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
