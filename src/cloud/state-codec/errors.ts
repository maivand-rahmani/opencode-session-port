/**
 * Fixed, redacted errors for the selected local-state codec.
 *
 * Every failure surfaces only a stable code and a fixed message. No key,
 * plaintext, host scope, ciphertext, path, or underlying cause is retained on
 * the error object (including `cause`). Callers that need to distinguish
 * outcomes branch on `code`, never on message text.
 */

export type StateCodecErrorCode =
	| "invalid-input"
	| "invalid-key"
	| "invalid-context"
	| "state-too-large"
	| "state-corrupt"
	| "unsupported-version"
	| "codec-failure";

const ERROR_MESSAGES: Readonly<Record<StateCodecErrorCode, string>> = Object.freeze({
	"invalid-input": "The state codec input must be a byte array.",
	"invalid-key": "The state key must be exactly 32 bytes.",
	"invalid-context": "The state codec context is invalid.",
	"state-too-large": "The state codec input exceeds the configured byte limit.",
	"state-corrupt": "The encrypted state is corrupt or failed authentication.",
	"unsupported-version": "The encrypted state envelope version is unsupported.",
	"codec-failure": "The state encryption codec failed.",
});

/** Redacted codec failure: fixed code and message only, never a cause. */
export class StateCodecError extends Error {
	readonly code: StateCodecErrorCode;

	constructor(code: StateCodecErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "StateCodecError";
		this.code = code;
	}
}
