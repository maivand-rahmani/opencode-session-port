/**
 * Strict cloud-auth configuration reader.
 *
 * The cloud-auth controller is entirely optional. Absence of the runtime
 * configuration is represented by `null`; a present but malformed object is
 * rejected rather than defaulted. No origin, budget, vault name, or state path
 * is inferred from the environment, a Host header, or a built-in production
 * value.
 *
 * The origin is validated by the same canonical parser the native client uses,
 * so configuration is rejected before any lock, vault, or native binding is
 * touched.
 */
import * as path from "node:path";
import { readCanonicalOrigin } from "./client.ts";
import {
	isPlainRecord,
	isPositiveSafeInteger,
	NativeAuthError,
} from "./types.ts";

/** Validated optional cloud-auth runtime configuration. */
export interface CloudAuthConfig {
	/** Exact canonical HTTPS origin, or explicit loopback HTTP via the flag. */
	readonly origin: string;
	/** Required per-request HTTP deadline; no default is supplied. */
	readonly requestTimeoutMillis: number;
	/** Required response-body ceiling; no default is supplied. */
	readonly maxResponseBytes: number;
	/** Required serialized-credential ceiling; no default is supplied. */
	readonly maxCredentialBytes: number;
	/** Required vault-secret ceiling; must cover the credential budget. */
	readonly maxSecretBytes: number;
	/** Exact keyring service name; not user credential material. */
	readonly vaultService: string;
	/** Exact keyring account name; not user credential material. */
	readonly vaultAccount: string;
	/** Absolute directory for the cooperative process-owner lock. */
	readonly stateDirectory: string;
	/** Explicit opt-in for HTTP only on loopback hosts. Defaults to false. */
	readonly allowLoopbackHttp?: boolean;
}

const REQUIRED_KEYS = [
	"origin",
	"requestTimeoutMillis",
	"maxResponseBytes",
	"maxCredentialBytes",
	"maxSecretBytes",
	"vaultService",
	"vaultAccount",
	"stateDirectory",
] as const;

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
	...REQUIRED_KEYS,
	"allowLoopbackHttp",
]);

const MAX_VAULT_NAME_LENGTH = 512;
const MAX_STATE_DIRECTORY_LENGTH = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Reads the optional `context.options.sessionportCloud` value.
 *
 * `undefined` and `null` mean "not configured" and return `null`. Any other
 * non-object, missing/unknown field, invalid limit, relative state directory,
 * or non-canonical origin throws the fixed `invalid-input` error.
 */
export function readCloudAuthConfig(value: unknown): CloudAuthConfig | null {
	if (value === undefined || value === null) return null;
	try {
		return parseCloudAuthConfig(value);
	} catch (error) {
		throw error instanceof NativeAuthError
			? error
			: new NativeAuthError("invalid-input");
	}
}

function parseCloudAuthConfig(value: unknown): CloudAuthConfig {
	if (!isStrictPlainRecord(value)) throw new NativeAuthError("invalid-input");

	const keys = Object.keys(value);
	if (keys.length < REQUIRED_KEYS.length) {
		throw new NativeAuthError("invalid-input");
	}
	for (const key of keys) {
		if (!ALLOWED_KEYS.has(key)) {
			throw new NativeAuthError("invalid-input");
		}
	}
	for (const key of REQUIRED_KEYS) {
		if (!Object.hasOwn(value, key)) {
			throw new NativeAuthError("invalid-input");
		}
	}

	const requestTimeoutMillis = readPositiveSafeInteger(
		value.requestTimeoutMillis,
	);
	const maxResponseBytes = readPositiveSafeInteger(value.maxResponseBytes);
	const maxCredentialBytes = readPositiveSafeInteger(
		value.maxCredentialBytes,
	);
	const maxSecretBytes = readPositiveSafeInteger(value.maxSecretBytes);
	if (maxSecretBytes < maxCredentialBytes) {
		throw new NativeAuthError("invalid-input");
	}

	const allowLoopbackHttp = value.allowLoopbackHttp;
	if (
		allowLoopbackHttp !== undefined &&
		typeof allowLoopbackHttp !== "boolean"
	) {
		throw new NativeAuthError("invalid-input");
	}

	// Reuse the native client's canonical parser rather than maintaining a
	// second, subtly different origin policy.
	const origin = readCanonicalOrigin(
		value.origin,
		allowLoopbackHttp ?? false,
	);

	const vaultService = readVaultName(value.vaultService);
	const vaultAccount = readVaultName(value.vaultAccount);
	const stateDirectory = readStateDirectory(value.stateDirectory);

	return Object.freeze({
		origin,
		requestTimeoutMillis,
		maxResponseBytes,
		maxCredentialBytes,
		maxSecretBytes,
		vaultService,
		vaultAccount,
		stateDirectory,
		...(allowLoopbackHttp === undefined ? {} : { allowLoopbackHttp }),
	});
}

function readPositiveSafeInteger(value: unknown): number {
	if (!isPositiveSafeInteger(value)) {
		throw new NativeAuthError("invalid-input");
	}
	return value;
}

function readVaultName(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_VAULT_NAME_LENGTH ||
		value.trim() !== value ||
		CONTROL_CHARACTERS.test(value)
	) {
		throw new NativeAuthError("invalid-input");
	}
	return value;
}

function readStateDirectory(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_STATE_DIRECTORY_LENGTH ||
		value.trim() !== value ||
		CONTROL_CHARACTERS.test(value) ||
		!path.isAbsolute(value)
	) {
		throw new NativeAuthError("invalid-input");
	}
	return value;
}

function isStrictPlainRecord(
	value: unknown,
): value is Record<string, unknown> {
	if (!isPlainRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
