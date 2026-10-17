/**
 * Sanitized SessionPort command reports (Phase 2 wiring; O-15/OQ-15).
 *
 * Every function here returns a fixed, generic notification object; raw host
 * or exception text is NEVER interpolated. Classification uses stable error
 * classes/codes only, never message text, so a failure report cannot leak
 * session IDs, paths, host internals, or password material. Checkpoint
 * collection failures, restore collection failures, and restore plan failures
 * additionally append a fixed human reason and the exact machine code, but
 * only for `SessionCollectionError`/`RestorePlanError` codes on explicit
 * allowlists; unknown or forged codes keep the generic text. Exact user-facing
 * copy remains OPEN (OQ-15); these strings are the wiring lane's generic
 * sanitized categories.
 *
 * Truthful-outcome rules:
 * - Checkpoint success is reported only for a `written` outcome with the
 *   artifact path, encrypted byte count, and session count.
 * - Restore success is reported only for a non-empty execution result with at
 *   least one imported session and no failed/blocked/not-attempted entries; an
 *   empty artifact, cancel, capability absence, authentication failure, and
 *   every error are reported as non-success.
 * - A completed non-empty restore execution is presented through the
 *   designer-owned keyboard-navigable report dialog using
 *   `mapRestoreExecutionToReportPresentation` (aggregate counts plus one
 *   navigable entry per session: source ID, planner classification, skip
 *   reason when present, and execution status). `reportRestoreExecution`
 *   remains the truthful empty-result notification, and
 *   `reportRestoreExecutionFallback` is the bounded aggregate-only notification
 *   used when that dialog cannot be displayed; partial progress states
 *   explicitly that there is no atomic rollback.
 */

import { ArtifactFileError } from "../artifacts/files.ts";
import { HostAdapterError, ProjectDestinationError } from "../adapters/index.ts";
import { LocationResolutionError } from "../adapters/location-resolver.ts";
import { CryptoContainerError } from "../../core/crypto/errors.ts";
import { RestorePlanError, type RestorePlanErrorCode } from "../../core/restore/planner.ts";
import { SessionCollectionError, type SessionCollectionErrorCode } from "../../core/sessions/index.ts";
import { RESTORE_PASSWORD_ATTEMPT_LIMIT } from "../orchestration/index.ts";
import type { CheckpointOutcome, RestoreExecutionResult } from "../orchestration/index.ts";
import type {
	RestoreReportPresentationModel,
	RestoreReportSession,
} from "../ui/restore-report-flow.ts";

/* ------------------------------------------------------------------------- */
/* Notification shape                                                        */
/* ------------------------------------------------------------------------- */

/** Host toast variants (mirrors `Plugin.Context["ui"]["toast"]`). */
export type SessionPortNotificationVariant = "info" | "success" | "warning" | "error";

/** One sanitized user-facing notification; `message` never contains raw error text. */
export interface SessionPortNotification {
	readonly title: string;
	readonly message: string;
	readonly variant: SessionPortNotificationVariant;
}

/* ------------------------------------------------------------------------- */
/* Checkpoint reports                                                        */
/* ------------------------------------------------------------------------- */

/** Reports one completed checkpoint outcome with its raw path/size/count facts. */
export function reportCheckpointOutcome(outcome: CheckpointOutcome): SessionPortNotification {
	switch (outcome.status) {
		case "no-sessions":
			return {
				title: "Checkpoint not created",
				message: "No sessions were found for this project, so no checkpoint was created.",
				variant: "warning",
			};
		case "canceled":
			return {
				title: "Checkpoint canceled",
				message: "The password prompt was canceled; no artifact was written.",
				variant: "info",
			};
		case "written":
			return {
				title: "Checkpoint created",
				message: `Wrote ${outcome.artifactPath} (${outcome.encryptedBytes} bytes, ${outcome.sessionCount} sessions).`,
				variant: "success",
			};
	}
}

/** Reports one checkpoint failure as a fixed, sanitized category. */
export function reportCheckpointFailure(error: unknown): SessionPortNotification {
	const category = classifyFailure(error);
	switch (category) {
		case "location":
			return checkpointFailure("The active project could not be verified with the host; no artifact was written.");
		case "location-capability":
			return checkpointFailure(
				"This OpenCode host does not expose the project-location capability required to create a checkpoint; no artifact was written.",
			);
		case "capability":
			return checkpointFailure("This OpenCode host does not expose the required session-listing capability; no artifact was written.");
		case "collection":
			return checkpointFailure(checkpointCollectionFailureMessage(error));
		case "path-exists":
			return checkpointFailure("An artifact already exists at that path; nothing was overwritten.");
		case "artifact-path":
			return checkpointFailure("The artifact output path is not usable; no artifact was written.");
		case "crypto":
			return checkpointFailure("The checkpoint could not be encrypted; no artifact was written.");
		case "destinations":
		case "plan":
		case "authentication":
			// Not reachable on the checkpoint path; fall through to the generic case.
			break;
		case "unknown":
			break;
	}
	return checkpointFailure("Checkpoint failed; no artifact was written.");
}

function checkpointFailure(message: string): SessionPortNotification {
	return { title: "Checkpoint failed", message, variant: "error" };
}

/** Existing generic checkpoint collection failure copy; also the fallback for unknown codes. */
const CHECKPOINT_COLLECTION_FAILURE = "Collecting the project's sessions failed; no artifact was written.";

/**
 * Fixed human reason per known `SessionCollectionError` code. This record is
 * the shared explicit allowlist for both the checkpoint and the restore
 * collection category: the raw code is echoed to the user only when it
 * exactly matches one of these keys, and the raw `error.message` (which can
 * contain session/project IDs, paths, and host error text) is never used.
 * Adding a code to `SessionCollectionErrorCode` fails compilation until a
 * fixed reason is added here.
 */
const COLLECTION_FAILURE_REASONS: Readonly<Record<SessionCollectionErrorCode, string>> = {
	"invalid-request": "the session collection request was invalid",
	"invalid-policy": "the session collection policy was invalid",
	"session-list-failed": "the host session list could not be read",
	"message-list-failed": "a session's message history could not be read",
	"malformed-session-page": "the host returned a malformed session list page",
	"malformed-message-page": "the host returned a malformed message list page",
	"malformed-session-record": "the host returned a malformed session record",
	"malformed-message-record": "the host returned a malformed message record",
	"session-project-mismatch": "a listed session did not belong to the requested project",
	"duplicate-session-id": "the host returned a session more than once",
	"duplicate-message-id": "the host returned a message more than once",
	"repeated-session-cursor": "the host repeated a session list cursor",
	"repeated-message-cursor": "the host repeated a message list cursor",
	"session-limit-exceeded": "the session count exceeded the configured limit",
	"message-limit-exceeded": "a session's message count exceeded the configured limit",
	"total-message-limit-exceeded": "the total message count exceeded the configured limit",
	"unsettled-message": "the project history contains an unfinished message",
};

/**
 * Checkpoint collection failure copy: the existing generic message plus
 * `Reason: <fixed human reason> (<known code>).` for a `SessionCollectionError`
 * whose code is on the allowlist. Any other error or code keeps the generic
 * text; only allowlisted literal code strings are ever echoed.
 */
function checkpointCollectionFailureMessage(error: unknown): string {
	return withKnownCollectionReason(error, CHECKPOINT_COLLECTION_FAILURE);
}

/**
 * Shared allowlist lookup for collection failures: appends
 * `Reason: <fixed human reason> (<known code>).` to `base` for a
 * `SessionCollectionError` whose code is on the fixed map. Any other error,
 * non-instance object, or unknown/forged code keeps `base` unchanged; only
 * allowlisted literal code strings are ever echoed.
 */
function withKnownCollectionReason(error: unknown, base: string): string {
	if (!(error instanceof SessionCollectionError)) return base;
	const code: string = error.code;
	if (!Object.hasOwn(COLLECTION_FAILURE_REASONS, code)) return base;
	const reason = COLLECTION_FAILURE_REASONS[code as SessionCollectionErrorCode];
	return `${base} Reason: ${reason} (${code}).`;
}

/* ------------------------------------------------------------------------- */
/* Restore reports                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Exported for compatibility. Bare `/restore` now resolves the newest
 * checkpoint automatically, so the current wiring does not show this usage
 * copy; it documents the optional artifact-path argument.
 */
export function reportRestoreUsage(): SessionPortNotification {
	return {
		title: "Restore usage",
		message:
			"Usage: /restore [artifact-path]. Without a path, the newest checkpoint in the current project's .sessionport directory is used. No sessions were changed.",
		variant: "warning",
	};
}

/**
 * Bare `/restore` with no active project directory: fixed, specific copy with
 * no raw path/error text; nothing was read or changed.
 */
export function reportRestoreNoActiveProject(): SessionPortNotification {
	return {
		title: "Restore unavailable",
		message:
			"The active project directory is unavailable, so the latest checkpoint could not be found; no sessions were changed.",
		variant: "warning",
	};
}

/**
 * Bare `/restore` with no checkpoint in the active project's default
 * `.sessionport/` directory: fixed friendly copy; nothing was read or changed.
 */
export function reportRestoreNoCheckpointFound(): SessionPortNotification {
	return {
		title: "No checkpoint found",
		message:
			"No checkpoint artifact was found in the current project's .sessionport directory; no sessions were changed. Create one with /checkpoint or pass an artifact path to /restore.",
		variant: "warning",
	};
}

/** O-12 capability absence: reported before any artifact read, decrypt, or import. */
export function reportRestoreCapabilityUnavailable(): SessionPortNotification {
	return {
		title: "Restore unavailable",
		message:
			"This OpenCode host does not expose the session-import capability required to restore; no sessions were changed.",
		variant: "warning",
	};
}

/** The user canceled project selection or the password prompt; nothing was changed. */
export function reportRestoreCanceled(): SessionPortNotification {
	return {
		title: "Restore canceled",
		message: "Restore was canceled; no sessions were changed.",
		variant: "info",
	};
}

/** Terminal three-attempt authentication failure; deliberately does not distinguish password vs. damage. */
export function reportRestoreAuthenticationFailed(): SessionPortNotification {
	return {
		title: "Restore stopped",
		message: `The checkpoint could not be opened after ${RESTORE_PASSWORD_ATTEMPT_LIMIT} password attempts; no sessions were changed.`,
		variant: "error",
	};
}

/** Existing generic restore collection failure copy; also the fallback for unknown codes. */
const RESTORE_COLLECTION_FAILURE = "The destination project's sessions could not be read; no sessions were changed.";

/** Existing generic restore plan failure copy; also the fallback for unknown codes. */
const RESTORE_PLAN_FAILURE = "The checkpoint does not match this destination safely; no sessions were changed.";

/**
 * Fixed human reason per known `RestorePlanError` code — the explicit
 * allowlist for the restore plan category. As with collection codes, the raw
 * code is echoed only on an exact key match and the raw `error.message` (which
 * can contain session/message IDs and labels) is never used. Adding a code to
 * `RestorePlanErrorCode` fails compilation until a fixed reason is added here.
 */
const RESTORE_PLAN_REASONS: Readonly<Record<RestorePlanErrorCode, string>> = {
	"invalid-input": "the restore planning request was invalid",
	"malformed-payload": "the checkpoint payload was malformed",
	"malformed-destination": "the destination session history could not be read",
	"divergent-artifact-session": "the checkpoint repeats a session with different content",
	"duplicate-artifact-message-id": "the checkpoint repeats a message ID across sessions",
	"ambiguous-destination": "the destination repeats a session or message ID",
	"dangling-session-reference": "a session reference does not resolve in the destination or plan",
	"dangling-message-reference": "a message reference does not resolve in the destination",
	"session-id-collision": "a planned session ID collides with existing session history",
	"message-id-collision": "a planned message ID collides with existing session history",
	"dependency-cycle": "session parent/reference relationships contain a cycle",
	"derivation-failure": "a remapped session or message ID could not be derived",
};

/**
 * Restore collection failure copy: the existing restore base message plus
 * `Reason: <fixed human reason> (<known code>).` for a known
 * `SessionCollectionError` code (shared allowlist with the checkpoint
 * category). Unknown/forged codes and non-instance errors keep the base text;
 * raw messages, IDs, and paths never leak.
 */
function restoreCollectionFailureMessage(error: unknown): string {
	return withKnownCollectionReason(error, RESTORE_COLLECTION_FAILURE);
}

/**
 * Restore plan failure copy: the existing restore base message plus
 * `Reason: <fixed human reason> (<known code>).` for a `RestorePlanError`
 * whose code is on the allowlist. Unknown/forged codes and non-instance
 * errors keep the base text; raw plan messages (IDs/labels) never leak.
 */
function restorePlanFailureMessage(error: unknown): string {
	if (!(error instanceof RestorePlanError)) return RESTORE_PLAN_FAILURE;
	const code: string = error.code;
	if (!Object.hasOwn(RESTORE_PLAN_REASONS, code)) return RESTORE_PLAN_FAILURE;
	const reason = RESTORE_PLAN_REASONS[code as RestorePlanErrorCode];
	return `${RESTORE_PLAN_FAILURE} Reason: ${reason} (${code}).`;
}

/**
 * Reports one restore failure as a fixed, sanitized category. `executionStarted`
 * is true only once the import executor was invoked; the copy never claims
 * "no sessions were changed" after that point.
 */
export function reportRestoreFailure(error: unknown, executionStarted: boolean): SessionPortNotification {
	if (executionStarted) {
		return {
			title: "Restore stopped",
			message:
				"Restore stopped unexpectedly during execution. Review the session list for partial results; there is no atomic rollback.",
			variant: "error",
		};
	}
	const category = classifyFailure(error);
	switch (category) {
		case "capability":
			return restoreFailure("This OpenCode host does not expose a capability required to restore; no sessions were changed.");
		case "location-capability":
			return restoreFailure(
				"This OpenCode host does not expose the project-location capability required to restore; no sessions were changed.",
			);
		case "location":
			return restoreFailure("The selected project could not be verified with the host; no sessions were changed.");
		case "destinations":
			return restoreFailure("The host project list could not be read; no sessions were changed.");
		case "collection":
			return restoreFailure(restoreCollectionFailureMessage(error));
		case "plan":
			return restoreFailure(restorePlanFailureMessage(error));
		case "artifact-path":
			return restoreFailure("The artifact path is not usable; no sessions were changed.");
		case "path-exists":
			return restoreFailure("The artifact path is not usable for reading; no sessions were changed.");
		case "authentication":
			return restoreFailure("The checkpoint could not be authenticated; no sessions were changed.");
		case "crypto":
			return restoreFailure("The file could not be opened as a SessionPort checkpoint; no sessions were changed.");
		case "unknown":
			return restoreFailure("Restore failed; no sessions were changed.");
	}
}

function restoreFailure(message: string): SessionPortNotification {
	return { title: "Restore failed", message, variant: "error" };
}

/**
 * Reports one completed restore execution: aggregate counts plus per-session
 * facts. Zero sessions never report success; all-skipped results report as
 * informational, not success. Partial progress states the no-rollback policy.
 *
 * Non-empty executions are presented through the designer report dialog
 * instead; this helper remains the truthful empty-result notification (and the
 * defensive empty-result branch of `reportRestoreExecutionFallback`).
 */
export function reportRestoreExecution(result: RestoreExecutionResult): SessionPortNotification {
	const { summary } = result;
	if (summary.total === 0) {
		return {
			title: "Nothing to restore",
			message: "The checkpoint contains no sessions; no sessions were imported.",
			variant: "warning",
		};
	}
	const lines: string[] = [
		`Restore finished: ${summary.imported} imported, ${summary.skipped} skipped, ${summary.failed} failed, ` +
			`${summary.blocked} blocked, ${summary.notAttempted} not attempted (${summary.total} total).`,
	];
	for (const outcome of result.outcomes) {
		const fields = [outcome.sourceSessionID, outcome.classification, outcome.status];
		if (outcome.skipReason !== undefined) fields.push(outcome.skipReason);
		lines.push(fields.join(" · "));
	}
	if (summary.failed > 0 || summary.blocked > 0 || summary.notAttempted > 0) {
		lines.push("Partial progress: no atomic rollback; imported sessions remain.");
	}
	const clean = summary.failed === 0 && summary.blocked === 0 && summary.notAttempted === 0;
	const variant = !clean ? "warning" : summary.imported > 0 ? "success" : "info";
	return {
		title: "Restore finished",
		message: lines.join("\n"),
		variant,
	};
}

/* ------------------------------------------------------------------------- */
/* Restore report dialog integration                                         */
/* ------------------------------------------------------------------------- */

/**
 * Maps one completed, already-sanitized execution result into the designer's
 * `RestoreReportPresentationModel`. Only aggregate counts and display-safe
 * per-session facts (source session ID, planner classification, execution
 * status, and planner skip reason) cross into the model; the derived target
 * session ID, host data, and exception objects are never included.
 */
export function mapRestoreExecutionToReportPresentation(result: RestoreExecutionResult): RestoreReportPresentationModel {
	const sessions: RestoreReportSession[] = result.outcomes.map((outcome) => ({
		sessionID: outcome.sourceSessionID,
		classification: outcome.classification,
		status: outcome.status,
		...(outcome.skipReason !== undefined ? { skipReason: outcome.skipReason } : {}),
	}));
	return {
		summary: {
			total: result.summary.total,
			imported: result.summary.imported,
			skipped: result.summary.skipped,
			failed: result.summary.failed,
			blocked: result.summary.blocked,
			notAttempted: result.summary.notAttempted,
		},
		sessions,
	};
}

/**
 * Bounded aggregate-only fallback for a completed non-empty execution whose
 * interactive report dialog could not be displayed. The execution already
 * finished, so this copy never reports an execution failure; it contains only
 * aggregate counts, a fixed display-failure note, and the partial-progress
 * no-rollback notice when the result is partial. No per-session lines, raw
 * exception text, or dialog error text are ever included.
 */
export function reportRestoreExecutionFallback(result: RestoreExecutionResult): SessionPortNotification {
	const { summary } = result;
	if (summary.total === 0) {
		// Defensive: an empty result keeps the truthful non-success copy.
		return reportRestoreExecution(result);
	}
	const clean = summary.failed === 0 && summary.blocked === 0 && summary.notAttempted === 0;
	const variant = !clean ? "warning" : summary.imported > 0 ? "success" : "info";
	const lines = [
		`Restore finished: ${summary.imported} imported, ${summary.skipped} skipped, ${summary.failed} failed, ` +
			`${summary.blocked} blocked, ${summary.notAttempted} not attempted (${summary.total} total). ` +
			"The per-session report could not be displayed.",
	];
	if (!clean) {
		lines.push("Partial progress: no atomic rollback; imported sessions remain.");
	}
	return {
		title: "Restore finished",
		message: lines.join("\n"),
		variant,
	};
}

/* ------------------------------------------------------------------------- */
/* Error classification (classes/codes only; never message text)             */
/* ------------------------------------------------------------------------- */

type FailureCategory =
	| "capability"
	| "location"
	| "location-capability"
	| "destinations"
	| "collection"
	| "plan"
	| "artifact-path"
	| "path-exists"
	| "authentication"
	| "crypto"
	| "unknown";

function classifyFailure(error: unknown): FailureCategory {
	if (error instanceof HostAdapterError) {
		return error.code === "capability-unavailable" ? "capability" : "unknown";
	}
	if (error instanceof LocationResolutionError) {
		return error.code === "capability-unavailable" ? "location-capability" : "location";
	}
	if (error instanceof ProjectDestinationError) return "destinations";
	if (error instanceof SessionCollectionError) return "collection";
	if (error instanceof RestorePlanError) return "plan";
	if (error instanceof ArtifactFileError) return error.code === "path-exists" ? "path-exists" : "artifact-path";
	if (error instanceof CryptoContainerError) {
		return error.code === "authentication-failed" ? "authentication" : "crypto";
	}
	return "unknown";
}
