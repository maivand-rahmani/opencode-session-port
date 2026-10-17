/**
 * Shared injected-boundary types and fail-closed validation for the Phase 4
 * orchestration helpers (`fix-57`).
 *
 * This module contains no host, filesystem, crypto, or UI code: every effect
 * is supplied by the caller. It exists so the checkpoint flow and the restore
 * preflight can share one password-provider contract and one best-effort
 * zeroing helper without importing each other.
 */

import type { ByteSource } from "../../core/contracts/index.ts";

/** Which command requested the password; only used for provider context, never for policy. */
export type PasswordPurpose = "checkpoint" | "restore";

/**
 * Interactive password-provider callback.
 *
 * Resolves with the password bytes (UTF-8, no normalization — owner decision
 * recorded in O-07) or `undefined` when the user canceled. Ownership of a
 * resolved `Uint8Array` transfers to the orchestration helper, which
 * best-effort zeroes it in a `finally` block; the provider (and the UI behind
 * it) must not retain or reuse the array after resolving.
 *
 * The callback is expected to own all interactive retry/confirmation loops:
 * the owner-decided checkpoint two-entry match loop and the restore
 * three-attempt loop are not implemented here, and this helper calls the
 * provider once per command run. It makes no attempt to classify a rejected
 * password as "wrong password" versus "corrupt artifact".
 */
export type PasswordProvider = (purpose: PasswordPurpose) => Promise<Uint8Array | undefined>;

/**
 * Best-effort overwrite of the password array owned by the orchestration
 * helper. This is not secure deletion (A-07) and does not reach copies the
 * provider/UI/runtime may have retained (JavaScript strings and garbage
 * collector state are outside this module's control).
 */
export function zeroPasswordBestEffort(password: Uint8Array): void {
	password.fill(0);
}

/** True for non-null, non-array object values; used on untrusted caller inputs. */
export function isRecordValue(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wraps already-serialized plaintext bytes as a one-shot `ByteSource` so the
 * crypto boundary's `seal` can consume the serializer's `Uint8Array` output.
 * The single yielded chunk is the caller-provided array itself; the flow hands
 * it over and never mutates or retains it afterwards.
 */
export function asOneShotByteSource(bytes: Uint8Array): ByteSource {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
			yield bytes;
		},
	};
}

/** Requires a callable dependency so a missing injection fails before any effect. */
export function requireCallable(value: unknown, label: string): void {
	if (typeof value !== "function") {
		throw new TypeError(`${label} must be an injected function; no default is applied`);
	}
}

/** Requires a non-empty string dependency so an omitted explicit scope fails closed. */
export function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${label} must be an explicit non-empty string; no default is applied`);
	}
	return value;
}
