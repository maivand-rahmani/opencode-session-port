/**
 * SessionPort V1 TUI orchestration (Phase 4, bounded non-visual lane; `fix-57`).
 *
 * Public surface:
 * - `runCheckpointFlow(port, input)` → collect, prompt, resolve the P-15 path,
 *   seal, and write one encrypted artifact; returns only `no-sessions` /
 *   `canceled` / `written` low-level facts.
 * - `runRestorePreflight(client, input)` → O-12 capability probe, one password
 *   attempt, authenticated strict-parse of the artifact, destination snapshot,
 *   the required bounded metadata-only cross-project session-ID occupancy
 *   inventory (owner-approved 2026-10-14 amendment; after auth/parse and the
 *   destination read, before planning), and a completed `planRestore`; returns
 *   the plan plus the caller's explicit target directory.
 * - `runRestorePreflightWithPasswordAttempts(client, input)` → the
 *   owner-decided three-attempt restore password loop around
 *   `runRestorePreflight`; retries only the stable `authentication-failed`
 *   code and returns a terminal `authentication-failed` outcome after the
 *   permitted attempts instead of rethrowing the raw crypto error.
 * - `runRestoreExecution(input)` → sequential parent-first execution of one
 *   completed `RestorePlan` through the injected `SessionImportAdapter` with
 *   truthful per-session outcomes (imported / skipped / failed / blocked /
 *   not-attempted), no retries, independent-branch continuation, blocked
 *   descendants of a failed/blocked/unattempted parent, and the caller's
 *   explicit target on every import (O-06 handling policy; the final report
 *   format stays OPEN as O-15).
 *
 * This lane performs no command registration, no real host calls, and no
 * production crypto configuration. All effects are injected; tests use fake
 * ports, fake clients, fake importers, fake crypto, and fake store functions
 * only.
 *
 * OPEN decision boundaries preserved here: O-01/O-02/O-03 (no production
 * profile, format, or numeric cap), O-06 (owner handling policy implemented;
 * runtime partial-import behavior remains unvalidated), O-10 (child-session
 * enumeration: the checkpoint flow adds none), O-11 (damage policy), O-15
 * (final error taxonomy/report format: none is produced here), O-16 (the
 * restore caller supplies an explicit target). No runtime, compatibility, or
 * security claim follows from this module.
 */

export { runCheckpointFlow } from "./checkpoint.ts";
export type { CheckpointFlowInput, CheckpointOutcome } from "./checkpoint.ts";
export { runRestorePreflight } from "./restore-preflight.ts";
export type { RestorePreflightInput, RestorePreflightOutcome } from "./restore-preflight.ts";
export { isAuthenticationFailure, RESTORE_PASSWORD_ATTEMPT_LIMIT, runRestorePreflightWithPasswordAttempts } from "./restore-auth.ts";
export type { RestoreAuthenticatedPreflightOutcome } from "./restore-auth.ts";
export { runRestoreExecution } from "./restore-execution.ts";
export type {
	RestoreExecutionInput,
	RestoreExecutionResult,
	RestoreExecutionSummary,
	RestoreSessionExecutionStatus,
	RestoreSessionOutcome,
} from "./restore-execution.ts";
export type { PasswordProvider, PasswordPurpose } from "./shared.ts";
