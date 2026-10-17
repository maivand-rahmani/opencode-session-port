import { SessionCollectionError } from "./errors.ts";
import { isJsonObject } from "./guards.ts";

/**
 * Explicit, required collection bounds. Every field has no default and must be
 * supplied by the caller: this lane deliberately ships no production caps or
 * hidden fallbacks (O-03 / OQ-03 remain OPEN and must be benchmarked before
 * freeze). Tests may pass synthetic small values.
 *
 * Exceeding any bound fails the whole collection; the collector never emits a
 * silently truncated or partial payload.
 */
export interface SessionCollectionPolicy {
	/** Page size for `GET /api/session` requests (v2.0.22 declares a default of 50, not a cap). */
	readonly sessionPageSize: number;
	/** Page size for message list requests; must not exceed the declared v2.0.22 cap of 200. */
	readonly messagePageSize: number;
	/** Hard bound on the number of sessions collected across all pages. */
	readonly maxSessions: number;
	/** Hard bound on messages collected for a single session. */
	readonly maxMessagesPerSession: number;
	/**
	 * Hard bound on messages collected across all sessions and pages; checked
	 * against the number already collected plus a whole page before that page
	 * is accumulated, so a page that would push the collection over the bound
	 * rejects it instead of being truncated. Zero is allowed and forbids
	 * collecting any message.
	 */
	readonly maxTotalMessages: number;
}

/** Declared v2.0.22 maximum page size for `GET /api/session/:sessionID/message` (E14). */
export const MESSAGE_PAGE_SIZE_CAP = 200;

/**
 * Validates an explicit policy at the collection boundary. Invalid or missing
 * limits fail closed instead of silently substituting a default.
 */
export function validateSessionCollectionPolicy(policy: SessionCollectionPolicy): void {
	if (!isJsonObject(policy)) {
		throw new SessionCollectionError(
			"invalid-policy",
			"SessionCollectionPolicy is required and must be an explicit object with sessionPageSize, messagePageSize, maxSessions, maxMessagesPerSession, and maxTotalMessages; no defaults are applied",
		);
	}
	requirePositiveSafeInteger(policy.sessionPageSize, "sessionPageSize");
	requirePositiveSafeInteger(policy.messagePageSize, "messagePageSize");
	if (typeof policy.messagePageSize === "number" && policy.messagePageSize > MESSAGE_PAGE_SIZE_CAP) {
		throw new SessionCollectionError(
			"invalid-policy",
			`SessionCollectionPolicy.messagePageSize must not exceed the declared message page cap of ${MESSAGE_PAGE_SIZE_CAP} (got ${policy.messagePageSize})`,
		);
	}
	requirePositiveSafeInteger(policy.maxSessions, "maxSessions");
	requirePositiveSafeInteger(policy.maxMessagesPerSession, "maxMessagesPerSession");
	requireNonNegativeSafeInteger(policy.maxTotalMessages, "maxTotalMessages");
}

function requirePositiveSafeInteger(value: unknown, field: keyof SessionCollectionPolicy): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new SessionCollectionError(
			"invalid-policy",
			`SessionCollectionPolicy.${field} must be an explicit positive safe integer (got ${String(value)})`,
		);
	}
}

/**
 * `maxTotalMessages` is an aggregate cap where zero is a meaningful,
 * fail-closed setting ("collect no messages"), so it accepts zero while the
 * other bounds require at least one.
 */
function requireNonNegativeSafeInteger(value: unknown, field: keyof SessionCollectionPolicy): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new SessionCollectionError(
			"invalid-policy",
			`SessionCollectionPolicy.${field} must be an explicit non-negative safe integer (got ${String(value)})`,
		);
	}
}
