/**
 * SessionPort crypto container errors.
 *
 * PROVISIONAL taxonomy: the user-visible error/report format is still OPEN
 * (O-15). Codes exist so callers and tests can assert fail-closed behavior
 * without depending on message text.
 *
 * Messages must never contain password, key, salt, or plaintext bytes.
 */
export type CryptoErrorCode =
	| "invalid-policy-definition"
	| "unknown-policy"
	| "unknown-kdf-profile"
	| "invalid-password"
	| "unsupported-runtime"
	| "invalid-header"
	| "unsupported-format-version"
	| "unsupported-algorithm"
	| "artifact-too-large"
	| "invalid-artifact-source"
	| "truncated-artifact"
	| "invalid-frame"
	| "cipher-failure"
	| "authentication-failed"
	| "unexpected-tag"
	| "missing-final-tag"
	| "trailing-data"
	| "compressed-limit-exceeded"
	| "decompressed-limit-exceeded"
	| "expansion-limit-exceeded"
	| "gzip-error";

/** Fail-closed crypto container error carrying a stable machine-readable code. */
export class CryptoContainerError extends Error {
	readonly code: CryptoErrorCode;

	constructor(code: CryptoErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CryptoContainerError";
		this.code = code;
	}
}

/** Preserves an existing container error; wraps anything else with a fallback code. */
export function asCryptoContainerError(
	error: unknown,
	fallbackCode: CryptoErrorCode,
	fallbackMessage: string,
): CryptoContainerError {
	if (error instanceof CryptoContainerError) return error;
	return new CryptoContainerError(fallbackCode, fallbackMessage, { cause: error });
}
