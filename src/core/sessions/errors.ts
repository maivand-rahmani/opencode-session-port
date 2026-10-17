/**
 * Fail-closed failure codes for session collection.
 *
 * A thrown `SessionCollectionError` always means the collection stopped without
 * producing a payload or serialized bytes. Callers must never catch it and
 * continue with a partially collected result (P-05: complete history or no
 * artifact; no silent filtering or truncation).
 */
export type SessionCollectionErrorCode =
	| "invalid-request"
	| "invalid-policy"
	| "session-list-failed"
	| "message-list-failed"
	| "malformed-session-page"
	| "malformed-message-page"
	| "malformed-session-record"
	| "malformed-message-record"
	| "session-project-mismatch"
	| "duplicate-session-id"
	| "duplicate-message-id"
	| "repeated-session-cursor"
	| "repeated-message-cursor"
	| "session-limit-exceeded"
	| "message-limit-exceeded"
	| "total-message-limit-exceeded"
	| "unsettled-message";

/** Collection failure with a stable machine-readable code; `cause` preserves the underlying API/validation error. */
export class SessionCollectionError extends Error {
	readonly code: SessionCollectionErrorCode;

	constructor(code: SessionCollectionErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionCollectionError";
		this.code = code;
	}
}
