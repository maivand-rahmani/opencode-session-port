/**
 * Owner-decided restore password-attempt loop (Phase 2 experimental wiring).
 *
 * `runRestorePreflightWithPasswordAttempts` wraps the injected
 * `runRestorePreflight` (Phase 4 orchestration) with the owner decision
 * recorded in O-07/P-13 (2026-10-10): a restore permits **three failed
 * password attempts per command run**.
 *
 * Exact semantics:
 * - Each attempt calls `runRestorePreflight` exactly once, which prompts for
 *   the password through the injected provider and performs the full
 *   capability probe, lazy artifact read, authentication, strict parse,
 *   destination snapshot, the required bounded metadata-only cross-project
 *   session-ID occupancy inventory (owner-approved 2026-10-14 amendment), and
 *   the `planRestore` preflight.
 * - Only an error carrying the stable crypto code `"authentication-failed"` is
 *   retried. The classification is structural (`error.code`), never based on
 *   message text, so no raw exception detail is inspected, exposed, or logged.
 * - After the final permitted attempt, the outcome is a truthful
 *   `{ status: "authentication-failed" }`; the raw error is not rethrown, so
 *   the caller reports generic copy. This deliberately does not distinguish a
 *   wrong password from a damaged artifact.
 * - Every other error (truncated/tampered artifact, invalid UTF-8/JSON,
 *   destination/planner failure, missing capability, provider failure)
 *   propagates unchanged on its first occurrence; nothing is retried.
 * - `canceled` and `capability-unavailable` outcomes pass through unchanged and
 *   are never retried.
 *
 * Password ownership stays with `runRestorePreflight`: each attempt's resolved
 * bytes are best-effort zeroed in its `finally` block; this wrapper never
 * retains a password. No import is performed here; the caller owns any later
 * `runRestoreExecution`.
 *
 * Evidence boundary: fake clients, fake crypto, fake artifact sources, fake
 * destination callbacks, and a fake cross-project inventory callback only. No
 * real host call, artifact read, KDF, or import is performed by this lane, and
 * no runtime or compatibility claim follows.
 */

import {
	runRestorePreflight,
	type RestorePreflightInput,
	type RestorePreflightOutcome,
} from "./restore-preflight.ts";
import { isRecordValue } from "./shared.ts";

/**
 * Owner-decided per-command-run restore attempt limit (O-07/P-13,
 * 2026-10-10): three failed password attempts, then stop.
 */
export const RESTORE_PASSWORD_ATTEMPT_LIMIT = 3;

/**
 * Restore-preflight outcome including the terminal three-attempt
 * authentication failure. The final case is returned instead of rethrowing the
 * raw crypto error so callers can report generic copy.
 */
export type RestoreAuthenticatedPreflightOutcome =
	| RestorePreflightOutcome
	| { readonly status: "authentication-failed" };

/** True only for the stable crypto `authentication-failed` code; never inspects message text. */
export function isAuthenticationFailure(error: unknown): boolean {
	return isRecordValue(error) && error["code"] === "authentication-failed";
}

/**
 * Runs the restore preflight with up to `maxAttempts` password attempts
 * (default: the owner-decided three). See the module comment for the exact
 * retry/classification policy.
 */
export async function runRestorePreflightWithPasswordAttempts(
	client: unknown,
	input: RestorePreflightInput,
	maxAttempts: number = RESTORE_PASSWORD_ATTEMPT_LIMIT,
): Promise<RestoreAuthenticatedPreflightOutcome> {
	if (typeof maxAttempts !== "number" || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
		throw new TypeError("maxAttempts must be an explicit positive safe integer");
	}
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await runRestorePreflight(client, input);
		} catch (error) {
			if (!isAuthenticationFailure(error)) throw error;
			if (attempt === maxAttempts) {
				// Give up after the permitted attempts without disclosing the raw
				// crypto error; the caller reports generic copy.
				return { status: "authentication-failed" };
			}
		}
	}
	// Unreachable: the loop returns or throws on every iteration.
	return { status: "authentication-failed" };
}
