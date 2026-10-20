/**
 * Shared contracts for the native device-authorization client and the
 * vault-backed credential store.
 *
 * Device codes, human codes, access tokens, and refresh tokens are secrets.
 * This module never logs them, never puts them in a URL, and never writes them
 * to a browser store, cache, or file. All parsing is strict: no normalization,
 * aliases, or client-side scope widening are applied. No zeroization or
 * secure-memory claim is made.
 */

/** Frozen native namespace paths. No caller input is interpolated into these. */
export const NATIVE_DEVICE_AUTHORIZATIONS_PATH =
	"/api/native/v1/device-authorizations";
export const NATIVE_VERIFICATION_PATH =
	"/api/native/v1/device-authorizations/verify";
export const NATIVE_TOKEN_PATH = "/api/native/v1/token";

/** The only credential-store JSON version understood by this module. */
export const CREDENTIAL_STORE_VERSION = 1;

/** Frozen native credential shape: 32 CSPRNG bytes as unpadded base64url. */
export const CANONICAL_CREDENTIAL_LENGTH = 43;
export const CANONICAL_CREDENTIAL_BYTES = 32;

/**
 * Frozen human-code alphabet copied from the server contract. There are no
 * aliases for I, L, O, or U and no case/Unicode normalization.
 */
export const HUMAN_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const HUMAN_CODE_LENGTH = 12;

/** Lowercase error codes shared with the planned native lifecycle routes. */
export type WireErrorCode =
	| "authorization-pending"
	| "slow-down"
	| "authorization-denied"
	| "authorization-expired"
	| "authorization-consumed"
	| "invalid-credential"
	| "refresh-replay"
	| "state-conflict";

/** Fixed public error taxonomy for this module. */
export type NativeAuthErrorCode =
	| WireErrorCode
	| "invalid-input"
	| "invalid-response"
	| "response-too-large"
	| "aborted"
	| "request-timeout"
	| "network-outcome-uncertain"
	| "refresh-outcome-uncertain"
	| "reauth-required"
	| "credential-unavailable"
	| "credential-corrupt"
	| "too-large"
	| "write-outcome-uncertain";

const ERROR_MESSAGES: Readonly<Record<NativeAuthErrorCode, string>> =
	Object.freeze({
		"authorization-pending": "Authorization is pending.",
		"slow-down": "Polling must slow down.",
		"authorization-denied": "Authorization was denied.",
		"authorization-expired": "Authorization expired.",
		"authorization-consumed": "Authorization was already consumed.",
		"invalid-credential": "The credential is invalid.",
		"refresh-replay": "The refresh credential was already used.",
		"state-conflict": "The authorization state conflicts with the request.",
		"invalid-input": "The input is invalid.",
		"invalid-response": "The server response is invalid.",
		"response-too-large":
			"The server response exceeds the configured byte limit.",
		aborted: "The operation was aborted before it started.",
		"request-timeout":
			"The request timed out; its outcome is uncertain.",
		"network-outcome-uncertain": "The request outcome is uncertain.",
		"refresh-outcome-uncertain":
			"The refresh outcome is uncertain. Reauthorization is required.",
		"reauth-required": "Reauthorization is required.",
		"credential-unavailable": "Stored credentials are unavailable.",
		"credential-corrupt": "Stored credentials are invalid.",
		"too-large": "The credential exceeds the configured byte limit.",
		"write-outcome-uncertain":
			"The credential write outcome is uncertain.",
	});

/**
 * Fixed, redacted error. No response body, status text, JSON document, token,
 * code, caller input, or cause is retained on the error.
 */
export class NativeAuthError extends Error {
	readonly code: NativeAuthErrorCode;

	constructor(code: NativeAuthErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "NativeAuthError";
		this.code = code;
	}
}

/** True for non-null, non-array object records. */
export function isPlainRecord(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Positive safe integers only; zero, fractions, and strings are rejected. */
export function isPositiveSafeInteger(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0
	);
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Strict 32-byte base64url credential check. The trailing pad bits must be
 * canonical, so non-canonical spellings of the same bytes are rejected.
 */
export function isCanonicalCredentialToken(
	value: unknown,
): value is string {
	if (
		typeof value !== "string" ||
		value.length !== CANONICAL_CREDENTIAL_LENGTH ||
		!BASE64URL_PATTERN.test(value)
	) {
		return false;
	}

	try {
		const binary = atob(
			`${value.replace(/-/g, "+").replace(/_/g, "/")}=`,
		);
		if (binary.length !== CANONICAL_CREDENTIAL_BYTES) return false;
		const canonical = btoa(binary)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		return canonical === value;
	} catch {
		return false;
	}
}

const HUMAN_CODE_PATTERN = new RegExp(
	`^[${HUMAN_CODE_ALPHABET}]{${HUMAN_CODE_LENGTH}}$`,
);

/** Exact uppercase Crockford code; no aliases or normalization. */
export function isCanonicalHumanCode(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length === HUMAN_CODE_LENGTH &&
		HUMAN_CODE_PATTERN.test(value)
	);
}

const SCOPE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Space-delimited scope string. Every token must be valid and unique, with no
 * leading, trailing, or repeated separators. This client never sends a scope
 * request and never merges the server-returned scope with anything else.
 */
export function isCanonicalScope(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.trim() !== value
	) {
		return false;
	}

	const tokens = value.split(" ");
	for (const token of tokens) {
		if (!SCOPE_TOKEN_PATTERN.test(token)) return false;
	}
	return new Set(tokens).size === tokens.length;
}

/** Stored credential DTO. It never contains a trusted user or account ID. */
export interface TokenCredential {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly accessExpiresAtMillis: number;
	readonly scope: string;
}

/** Ready state: the only state that may expose an unexpired access token. */
export interface ReadyStoredCredential extends TokenCredential {
	readonly version: 1;
	readonly state: "ready";
}

/**
 * Refresh was marked before the HTTP request. A credential in this state must
 * never expose an access token or resend the old refresh token.
 */
export interface RefreshUncertainStoredCredential {
	readonly version: 1;
	readonly state: "refresh-uncertain";
}

/** Deterministic terminal credential failure; reauthorization is required. */
export interface UnauthorizedStoredCredential {
	readonly version: 1;
	readonly state: "unauthorized";
}

export type StoredCredentialState =
	| ReadyStoredCredential
	| RefreshUncertainStoredCredential
	| UnauthorizedStoredCredential;

/** The exact vault boundary the client needs; no enumeration or account root. */
export interface NativeCredentialStorePort {
	read(): Promise<StoredCredentialState | null>;
	writeReady(credential: TokenCredential): Promise<void>;
	markRefreshUncertain(): Promise<void>;
	markUnauthorized(): Promise<void>;
	remove(): Promise<boolean>;
}

const TOKEN_CREDENTIAL_KEYS = [
	"accessToken",
	"refreshToken",
	"accessExpiresAtMillis",
	"scope",
] as const;

export type TokenCredentialValidationCode =
	| "invalid-input"
	| "invalid-response"
	| "credential-corrupt";

/**
 * Validate and copy an untrusted credential DTO. Extra properties are rejected
 * so a malformed vault record cannot smuggle unvalidated fields forward.
 */
export function readTokenCredential(
	value: unknown,
	invalidCode: TokenCredentialValidationCode,
): TokenCredential {
	try {
		if (!isPlainRecord(value)) throw new NativeAuthError(invalidCode);

		const keys = Object.keys(value);
		if (
			keys.length !== TOKEN_CREDENTIAL_KEYS.length ||
			TOKEN_CREDENTIAL_KEYS.some((key) => !Object.hasOwn(value, key))
		) {
			throw new NativeAuthError(invalidCode);
		}

		const accessToken = value.accessToken;
		const refreshToken = value.refreshToken;
		const accessExpiresAtMillis = value.accessExpiresAtMillis;
		const scope = value.scope;

		if (
			!isCanonicalCredentialToken(accessToken) ||
			!isCanonicalCredentialToken(refreshToken) ||
			!isPositiveSafeInteger(accessExpiresAtMillis) ||
			!isCanonicalScope(scope)
		) {
			throw new NativeAuthError(invalidCode);
		}

		return Object.freeze({
			accessToken,
			refreshToken,
			accessExpiresAtMillis,
			scope,
		});
	} catch (error) {
		if (error instanceof NativeAuthError) throw error;
		throw new NativeAuthError(invalidCode);
	}
}

/** A returned device authorization; the raw codes stay only with the caller. */
export interface DeviceAuthorization {
	/** Memory-only pending-login handle; callers must not persist it. */
	readonly deviceCode: string;
	/** Shown to the user for manual browser entry; never logged or URL-encoded. */
	readonly userCode: string;
	readonly verificationUri: string;
	readonly expiresIn: number;
	readonly pollInterval: number;
}

/**
 * One poll attempt's safe outcome. `approved` carries an unpersisted credential;
 * the caller must pass it to the client's storeCredential API to commit it.
 */
export type PollAuthorizationResult =
	| {
			readonly status: "pending";
			/** Sanitized server Retry-After seconds, when one was supplied. */
			readonly retryAfterSeconds?: number;
	  }
	| {
			readonly status: "slow-down";
			/** Required sanitized Retry-After; never replaced by a default. */
			readonly retryAfterSeconds: number;
	  }
	| {
			readonly status: "approved";
			readonly credential: TokenCredential;
	  }
	| { readonly status: "denied" }
	| { readonly status: "expired" }
	| { readonly status: "consumed" };
