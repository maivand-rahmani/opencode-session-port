/**
 * Host native-delete adapter: feature-detects and invokes the public TUI
 * client `context.client.session.remove` method for an explicitly allowed set
 * of old local session IDs.
 *
 * Safety boundaries:
 * - The factory freezes one per-instance copy of the caller's explicit
 *   `allowedSessionIDs` plan. Only those exact IDs may ever produce a DELETE;
 *   candidate IDs, newly created IDs, and every other resource are refused
 *   before any host call.
 * - `session.remove` is invoked at most once per allowed ID per port instance.
 *   The attempt is recorded *before* the host call, so a thrown or uncertain
 *   result is never retried by this adapter. Callers must treat `uncertain` as
 *   "may have happened" and must not re-invoke through a fresh instance
 *   without a new explicit plan (O-06 retry policy stays OPEN).
 * - Only the public generated client operation is called:
 *   `session.remove({ sessionID })`, declared `Promise<void>` in the pinned
 *   v2.0.22 client. No raw HTTP, no host-internal database access, no other
 *   client method, and no response body is read.
 * - All outcomes are structured, fixed values. A thrown host error is reduced
 *   to `{ status: "uncertain", reason: "delete-call-threw" }`; the adapter
 *   never forwards, includes, or logs host error text or response values.
 * - A missing or non-callable `session.remove` is not an installation error.
 *   `probeSessionDeleteCapability` reports it without throwing, and the port
 *   reports a typed `capability-unavailable` outcome with an explicit
 *   `copy-only` fallback.
 *
 * Evidence boundary: the pinned v2.0.22 declaration is checked at compile time
 * in `host-client.ts`, but the native call is unverified against a live host
 * until the parent host probe runs. Synthetic fake-client tests only; no
 * runtime, cross-version, or support claim follows.
 */

import {
	HostAdapterError,
	isObjectRecord,
	requireNonEmptyString,
	resolveUnaryMethod,
	type SessionRemoveCallInput,
} from "./host-client.ts";

/* ------------------------------------------------------------------------- */
/* Public types                                                              */
/* ------------------------------------------------------------------------- */

/** Capability probe outcome; never mutates the client and never throws. */
export type SessionDeleteProbe =
	| { readonly available: true }
	| {
			readonly available: false;
			/** Fixed technical reason for the caller's copy-only fallback message. */
			readonly reason: string;
			/** Explicit fallback: no native delete is available. */
			readonly fallback: "copy-only";
	  };

/** Caller-supplied, frozen native-delete plan. */
export interface SessionDeletePortOptions {
	/**
	 * The exact OLD local session IDs approved for native removal. The array is
	 * copied and frozen at construction; later mutation of the caller's array
	 * has no effect. Duplicate or malformed entries are rejected.
	 */
	readonly allowedSessionIDs: readonly string[];
}

/**
 * Fixed, redacted outcome of one `removeSession` call.
 *
 * `uncertain` is the only outcome for a thrown host call: the DELETE may or
 * may not have applied. No host error text, response value, or classification
 * is exposed, and the adapter never retries.
 */
export type SessionDeleteOutcome =
	| { readonly status: "deleted"; readonly sessionID: string }
	| {
			readonly status: "refused";
			readonly sessionID: string;
			readonly reason: "session-id-not-allowed";
	  }
	| {
			readonly status: "not-retried";
			readonly sessionID: string;
			readonly reason: "delete-already-attempted";
	  }
	| {
			readonly status: "capability-unavailable";
			readonly sessionID: string;
			readonly reason: "session-remove-unavailable";
			readonly fallback: "copy-only";
	  }
	| {
			readonly status: "uncertain";
			readonly sessionID: string;
			readonly reason: "delete-call-threw";
	  };

/** One native-delete port instance with its fixed capability scope. */
export interface SessionDeletePort {
	/** Capability resolved once at construction; never re-probed per call. */
	readonly capability: SessionDeleteProbe;
	/**
	 * Attempts at most one native DELETE for an allowed old ID. Resolves with a
	 * structured outcome; never wraps or rethrows host errors and never retries.
	 * Malformed caller input (non-string/empty ID) throws `HostAdapterError`
	 * (`invalid-request`) before any host call.
	 */
	removeSession(sessionID: string): Promise<SessionDeleteOutcome>;
}

/* ------------------------------------------------------------------------- */
/* Factory                                                                   */
/* ------------------------------------------------------------------------- */

/** Fixed capability message; contains no host response values. */
const REMOVE_UNAVAILABLE_REASON =
	"The installed TUI client does not expose a callable session.remove; native delete is unavailable and the caller must fall back to copy-only";

/**
 * Feature-detects `client.session.remove` as callable. Never throws, never
 * calls the method, and performs no mutation; only property callability is
 * inspected.
 */
export function probeSessionDeleteCapability(client: unknown): SessionDeleteProbe {
	const removeMethod = resolveDeleteMethod(client);
	if (removeMethod === undefined) {
		return { available: false, reason: REMOVE_UNAVAILABLE_REASON, fallback: "copy-only" };
	}
	return { available: true };
}

/**
 * Creates the native-delete port for one frozen plan of old session IDs.
 *
 * The factory itself does not throw when `session.remove` is missing; the
 * capability is reported and every `removeSession` call returns a typed
 * `capability-unavailable` outcome. Invalid option shapes (non-array,
 * blank ID, duplicate ID) throw `HostAdapterError` (`invalid-request`).
 */
export function createSessionDeletePort(client: unknown, options: SessionDeletePortOptions): SessionDeletePort {
	const rawOptions: unknown = options;
	if (!isObjectRecord(rawOptions)) {
		throw new HostAdapterError(
			"invalid-request",
			"createSessionDeletePort requires an options object with an explicit allowedSessionIDs array",
		);
	}
	const allowedSessionIDs = freezeAllowedSessionIDs(rawOptions["allowedSessionIDs"]);

	// Resolve once at construction; a later surface change does not alter this
	// instance's frozen capability scope.
	const removeMethod = resolveDeleteMethod(client);
	const capability: SessionDeleteProbe =
		removeMethod === undefined
			? { available: false, reason: REMOVE_UNAVAILABLE_REASON, fallback: "copy-only" }
			: { available: true };

	const attemptedSessionIDs = new Set<string>();

	return {
		capability,
		async removeSession(sessionID: string): Promise<SessionDeleteOutcome> {
			const id = requireNonEmptyString(sessionID, "removeSession sessionID");
			if (!allowedSessionIDs.has(id)) {
				return { status: "refused", sessionID: id, reason: "session-id-not-allowed" };
			}
			if (removeMethod === undefined) {
				return {
					status: "capability-unavailable",
					sessionID: id,
					reason: "session-remove-unavailable",
					fallback: "copy-only",
				};
			}
			if (attemptedSessionIDs.has(id)) {
				return { status: "not-retried", sessionID: id, reason: "delete-already-attempted" };
			}

			// Record the attempt before calling: a synchronous throw, rejected
			// promise, or lost response can never cause a second DELETE.
			attemptedSessionIDs.add(id);
			try {
				await removeMethod({ sessionID: id });
				return { status: "deleted", sessionID: id };
			} catch {
				// Deliberately no host error text or response value is exposed.
				return { status: "uncertain", sessionID: id, reason: "delete-call-threw" };
			}
		},
	};
}

/* ------------------------------------------------------------------------- */
/* Internal helpers                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Resolves the remove method without ever throwing: a client getter that
 * throws is treated as an unavailable capability, not an installation crash.
 */
function resolveDeleteMethod(client: unknown): ((input: SessionRemoveCallInput) => Promise<unknown>) | undefined {
	try {
		return resolveUnaryMethod<SessionRemoveCallInput>(client, "session", "remove");
	} catch {
		return undefined;
	}
}

/**
 * Copies and validates the caller's explicit allowed-ID plan into a private
 * set. Every entry must be a non-empty string and no ID may repeat; a
 * contradictory deletion plan fails closed before any host call.
 */
function freezeAllowedSessionIDs(value: unknown): ReadonlySet<string> {
	if (!Array.isArray(value)) {
		throw new HostAdapterError(
			"invalid-request",
			"SessionDeletePortOptions.allowedSessionIDs must be an explicit array of old session IDs",
		);
	}
	const allowed = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		const entry: unknown = value[index];
		const id = requireNonEmptyString(entry, `SessionDeletePortOptions.allowedSessionIDs[${index}]`);
		if (allowed.has(id)) {
			throw new HostAdapterError(
				"invalid-request",
				`SessionDeletePortOptions.allowedSessionIDs repeats session id ${JSON.stringify(id)}; refusing an ambiguous delete plan`,
			);
		}
		allowed.add(id);
	}
	return allowed;
}
