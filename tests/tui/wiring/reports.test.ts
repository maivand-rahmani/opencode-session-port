/**
 * Report-copy tests for the Phase 2 wiring lane.
 *
 * These are pure string/shape tests over synthetic outcomes and real error
 * classes. They pin the sanitization rule (no raw exception text, ever), the
 * truthful-success rule (empty/canceled outcomes never report success), the
 * fixed reason/code diagnostics for known collection/plan error codes
 * (explicit allowlist only; unknown/forged codes stay generic), and the
 * O-06/O-15 report default (aggregate counts plus per-session facts; partial
 * progress states no atomic rollback).
 */

import { describe, expect, test } from "bun:test";
import { HostAdapterError } from "../../../src/tui/adapters/index.ts";
import { LocationResolutionError } from "../../../src/tui/adapters/location-resolver.ts";
import { ProjectDestinationError } from "../../../src/tui/adapters/project-destinations.ts";
import { ArtifactFileError } from "../../../src/tui/artifacts/files.ts";
import { CryptoContainerError, type CryptoErrorCode } from "../../../src/core/crypto/errors.ts";
import { RestorePlanError, type RestorePlanErrorCode } from "../../../src/core/restore/planner.ts";
import { SessionCollectionError, type SessionCollectionErrorCode } from "../../../src/core/sessions/index.ts";
import type { RestoreExecutionResult, RestoreReplacementReport } from "../../../src/tui/orchestration/index.ts";
import {
	reportCheckpointFailure,
	reportCheckpointOutcome,
	reportRestoreAuthenticationFailed,
	reportRestoreCanceled,
	reportRestoreCapabilityUnavailable,
	reportRestoreExecution,
	reportRestoreFailure,
	reportRestoreNoActiveProject,
	reportRestoreNoCheckpointFound,
	reportRestoreUsage,
} from "../../../src/tui/wiring/index.ts";
import {
	mapRestoreExecutionToReportPresentation,
	reportRestoreExecutionFallback,
	reportRestoreReplacementFallback,
	type CheckpointRetentionSummary,
} from "../../../src/tui/wiring/reports.ts";

const RAW = "RAW-HOST-DETAIL";

describe("checkpoint reports", () => {
	test("reports path/size/count only for a written outcome", () => {
		const written = reportCheckpointOutcome({
			status: "written",
			artifactPath: "C:/work/.sessionport/checkpoint-a.sessionport",
			sessionCount: 4,
			encryptedBytes: 1234,
		});
		expect(written.variant).toBe("success");
		expect(written.message).toContain("C:/work/.sessionport/checkpoint-a.sessionport");
		expect(written.message).toContain("1234 bytes");
		expect(written.message).toContain("4 sessions");

		expect(reportCheckpointOutcome({ status: "no-sessions" }).variant).toBe("warning");
		expect(reportCheckpointOutcome({ status: "canceled" }).variant).toBe("info");
	});

	test("pins the written message byte-for-byte when no retention summary is supplied", () => {
		const written = reportCheckpointOutcome({
			status: "written",
			artifactPath: "C:/work/.sessionport/checkpoint-a.sessionport",
			sessionCount: 4,
			encryptedBytes: 1234,
		});
		expect(written).toEqual({
			title: "Checkpoint created",
			message: "Wrote C:/work/.sessionport/checkpoint-a.sessionport (1234 bytes, 4 sessions).",
			variant: "success",
		});
	});

	test("appends the exact retention sentence when older subagent sessions were excluded", () => {
		const retention: CheckpointRetentionSummary = {
			mode: "latest",
			projectSessionCount: 9,
			keptSessionCount: 4,
			excludedSessionCount: 5,
			keptRootCount: 2,
			maxSubagentSessions: 2,
			maxRootSessions: null,
		};
		const written = reportCheckpointOutcome(
			{
				status: "written",
				artifactPath: "C:/work/.sessionport/checkpoint-b.sessionport",
				sessionCount: 4,
				encryptedBytes: 2048,
			},
			retention,
		);
		expect(written).toEqual({
			title: "Checkpoint created",
			message:
				"Wrote C:/work/.sessionport/checkpoint-b.sessionport (2048 bytes, 4 sessions). " +
				"Experimental retention (latest subagent sessions): kept 4 of 9 project sessions " +
				"(all root sessions plus the latest 2 subagent sessions); 5 older subagent sessions were excluded.",
			variant: "success",
		});
	});

	test("names since-compaction mode and appends its exact retention sentence", () => {
		const retention: CheckpointRetentionSummary = {
			mode: "since-compaction",
			projectSessionCount: 7,
			keptSessionCount: 3,
			excludedSessionCount: 4,
			keptRootCount: 1,
			maxSubagentSessions: 3,
			maxRootSessions: null,
		};
		const written = reportCheckpointOutcome(
			{
				status: "written",
				artifactPath: "C:/work/.sessionport/checkpoint-d.sessionport",
				sessionCount: 3,
				encryptedBytes: 1024,
			},
			retention,
		);
		expect(written).toEqual({
			title: "Checkpoint created",
			message:
				"Wrote C:/work/.sessionport/checkpoint-d.sessionport (1024 bytes, 3 sessions). " +
				"Experimental retention (subagents after compaction): kept 3 of 7 project sessions " +
				"(all root sessions plus subagent sessions created after the most recent compaction); " +
				"4 older subagent sessions were excluded.",
			variant: "success",
		});
	});

	test("names roots mode and appends its exact retention sentence", () => {
		const retention: CheckpointRetentionSummary = {
			mode: "roots",
			projectSessionCount: 12,
			keptSessionCount: 6,
			excludedSessionCount: 6,
			keptRootCount: 2,
			maxSubagentSessions: null,
			maxRootSessions: 2,
		};
		const written = reportCheckpointOutcome(
			{
				status: "written",
				artifactPath: "C:/work/.sessionport/checkpoint-roots.sessionport",
				sessionCount: 6,
				encryptedBytes: 4096,
			},
			retention,
		);
		expect(written).toEqual({
			title: "Checkpoint created",
			message:
				"Wrote C:/work/.sessionport/checkpoint-roots.sessionport (4096 bytes, 6 sessions). " +
				"Experimental retention (last root sessions): kept 6 of 12 project sessions " +
				"(the 2 most recently active root sessions plus all of their subagent sessions); " +
				"6 older sessions were excluded.",
			variant: "success",
		});
	});

	test("appends the exact no-exclusions retention sentence when the limit was not exceeded", () => {
		const retention: CheckpointRetentionSummary = {
			mode: "latest",
			projectSessionCount: 3,
			keptSessionCount: 3,
			excludedSessionCount: 0,
			keptRootCount: 1,
			maxSubagentSessions: 10,
			maxRootSessions: null,
		};
		const written = reportCheckpointOutcome(
			{
				status: "written",
				artifactPath: "C:/work/.sessionport/checkpoint-c.sessionport",
				sessionCount: 3,
				encryptedBytes: 512,
			},
			retention,
		);
		expect(written).toEqual({
			title: "Checkpoint created",
			message:
				"Wrote C:/work/.sessionport/checkpoint-c.sessionport (512 bytes, 3 sessions). " +
				"Experimental retention (latest subagent sessions): all 3 project sessions were kept.",
			variant: "success",
		});
	});

	test("ignores a retention summary for no-sessions and canceled outcomes", () => {
		const retention: CheckpointRetentionSummary = {
			mode: "latest",
			projectSessionCount: 9,
			keptSessionCount: 4,
			excludedSessionCount: 5,
			keptRootCount: 2,
			maxSubagentSessions: 2,
			maxRootSessions: null,
		};
		const noSessions = reportCheckpointOutcome({ status: "no-sessions" }, retention);
		expect(noSessions).toEqual({
			title: "Checkpoint not created",
			message: "No sessions were found for this project, so no checkpoint was created.",
			variant: "warning",
		});
		const canceled = reportCheckpointOutcome({ status: "canceled" }, retention);
		expect(canceled).toEqual({
			title: "Checkpoint canceled",
			message: "The password prompt was canceled; no artifact was written.",
			variant: "info",
		});
		// Retention facts never leak into non-written copy.
		for (const notification of [noSessions, canceled]) {
			expect(notification.message).not.toContain("Experimental retention");
			expect(notification.message).not.toContain("9");
			expect(notification.message).not.toContain("5");
		}
	});

	test("sanitizes every classified failure and never echoes raw text", () => {
		const failures: Array<{ readonly error: unknown; readonly expectMessage: string }> = [
			{ error: new HostAdapterError("capability-unavailable", RAW), expectMessage: "session-listing capability" },
			{ error: new LocationResolutionError("capability-unavailable", RAW), expectMessage: "project-location capability" },
			{ error: new LocationResolutionError("mismatch", RAW), expectMessage: "could not be verified" },
			{ error: new SessionCollectionError("total-message-limit-exceeded", RAW), expectMessage: "Collecting" },
			{ error: new ArtifactFileError("path-exists", RAW), expectMessage: "already exists" },
			{ error: new ArtifactFileError("invalid-request", RAW), expectMessage: "output path is not usable" },
			{ error: new CryptoContainerError("cipher-failure", RAW), expectMessage: "could not be encrypted" },
			{ error: new Error(RAW), expectMessage: "Checkpoint failed" },
		];

		for (const { error, expectMessage } of failures) {
			const notification = reportCheckpointFailure(error);
			expect(notification.variant).toBe("error");
			expect(notification.title).toBe("Checkpoint failed");
			expect(notification.message).toContain(expectMessage);
			expect(notification.message).not.toContain(RAW);
		}
	});

	test("adds a fixed reason and the exact known code for every known collection failure code", () => {
		const expected: ReadonlyArray<readonly [SessionCollectionErrorCode, string]> = [
			["invalid-request", "the session collection request was invalid"],
			["invalid-policy", "the session collection policy was invalid"],
			["session-list-failed", "the host session list could not be read"],
			["message-list-failed", "a session's message history could not be read"],
			["malformed-session-page", "the host returned a malformed session list page"],
			["malformed-message-page", "the host returned a malformed message list page"],
			["malformed-session-record", "the host returned a malformed session record"],
			["malformed-message-record", "the host returned a malformed message record"],
			["session-project-mismatch", "a listed session did not belong to the requested project"],
			["duplicate-session-id", "the host returned a session more than once"],
			["duplicate-message-id", "the host returned a message more than once"],
			["repeated-session-cursor", "the host repeated a session list cursor"],
			["repeated-message-cursor", "the host repeated a message list cursor"],
			["session-limit-exceeded", "the session count exceeded the configured limit"],
			["message-limit-exceeded", "a session's message count exceeded the configured limit"],
			["total-message-limit-exceeded", "the total message count exceeded the configured limit"],
			["unsettled-message", "the project history contains an unfinished message"],
		];

		for (const [code, reason] of expected) {
			const notification = reportCheckpointFailure(new SessionCollectionError(code, RAW));
			expect(notification).toEqual({
				title: "Checkpoint failed",
				message: `Collecting the project's sessions failed; no artifact was written. Reason: ${reason} (${code}).`,
				variant: "error",
			});
		}
	});

	test("unknown or forged collection codes, raw messages, and non-collection errors never leak", () => {
		const genericCollection = "Collecting the project's sessions failed; no artifact was written.";

		for (const code of ["future-unknown-code", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
			const forged = new SessionCollectionError(code as SessionCollectionErrorCode, RAW);
			const notification = reportCheckpointFailure(forged);
			expect(notification.message).toBe(genericCollection);
			expect(notification.message).not.toContain(code);
			expect(notification.message).not.toContain(RAW);
		}

		// A code-shaped plain object is not a SessionCollectionError: stays fully generic.
		const fake = reportCheckpointFailure({ code: "unsettled-message", message: RAW });
		expect(fake.message).toBe("Checkpoint failed; no artifact was written.");
		expect(fake.message).not.toContain("unsettled-message");
		expect(fake.message).not.toContain(RAW);

		// Restore's collection category now surfaces the same fixed reason map
		// with its own restore base copy; raw text still never leaks.
		const restore = reportRestoreFailure(new SessionCollectionError("unsettled-message", RAW), false);
		expect(restore.message).toBe(
			"The destination project's sessions could not be read; no sessions were changed. " +
				"Reason: the project history contains an unfinished message (unsettled-message).",
		);
		expect(restore.message).not.toContain(RAW);
	});

	test("adds a fixed reason and the exact known code for every known crypto failure code", () => {
		const expected: ReadonlyArray<readonly [CryptoErrorCode, string]> = [
			["invalid-policy-definition", "the crypto policy configuration was invalid"],
			["unknown-policy", "the selected crypto policy is unknown"],
			["unknown-kdf-profile", "the crypto key-derivation profile is unknown"],
			["invalid-password", "the password material was invalid"],
			["unsupported-runtime", "the required crypto runtime is unavailable"],
			["invalid-header", "the encrypted artifact header was invalid"],
			["unsupported-format-version", "the artifact format version is unsupported"],
			["unsupported-algorithm", "the artifact algorithm is unsupported"],
			["artifact-too-large", "the encrypted artifact would exceed the configured size limit"],
			["invalid-artifact-source", "the checkpoint data stream was invalid"],
			["truncated-artifact", "the encrypted artifact ended unexpectedly"],
			["invalid-frame", "the encrypted artifact contains an invalid frame"],
			["cipher-failure", "encryption or decryption failed"],
			["authentication-failed", "the password or artifact authentication failed"],
			["unexpected-tag", "the encrypted artifact contains an unexpected frame tag"],
			["missing-final-tag", "the encrypted artifact is missing its final frame"],
			["trailing-data", "the encrypted artifact contains trailing data"],
			["compressed-limit-exceeded", "the compressed checkpoint data exceeds the configured size limit"],
			["decompressed-limit-exceeded", "the session data exceeds the configured size limit"],
			["expansion-limit-exceeded", "the checkpoint data exceeds the configured compression ratio limit"],
			["gzip-error", "the checkpoint data could not be compressed or decompressed"],
		];

		for (const [code, reason] of expected) {
			if (code === "authentication-failed") continue; // Own checkpoint category: generic copy.
			const notification = reportCheckpointFailure(new CryptoContainerError(code, RAW));
			expect(notification).toEqual({
				title: "Checkpoint failed",
				message: `The checkpoint could not be encrypted; no artifact was written. Reason: ${reason} (${code}).`,
				variant: "error",
			});
			expect(notification.message).not.toContain(RAW);
		}

		// authentication-failed stays in its own (unreachable on checkpoint)
		// category and never appends a crypto reason or raw text.
		const auth = reportCheckpointFailure(new CryptoContainerError("authentication-failed", RAW));
		expect(auth.message).toBe("Checkpoint failed; no artifact was written.");
		expect(auth.message).not.toContain("Reason:");
		expect(auth.message).not.toContain(RAW);
	});

	test("unknown or forged crypto codes and code-shaped plain objects keep the generic checkpoint copy", () => {
		const cryptoBase = "The checkpoint could not be encrypted; no artifact was written.";

		for (const code of ["future-code", "constructor", "__proto__", "toString"]) {
			const forged = reportCheckpointFailure(new CryptoContainerError(code as CryptoErrorCode, RAW));
			expect(forged.message).toBe(cryptoBase);
			expect(forged.message).not.toContain(code);
			expect(forged.message).not.toContain(RAW);
		}

		// A forged object with the class prototype but no own code classifies as
		// crypto yet keeps the base copy.
		const prototypeForged = reportCheckpointFailure(Object.create(CryptoContainerError.prototype));
		expect(prototypeForged.message).toBe(cryptoBase);
		expect(prototypeForged.message).not.toContain(RAW);

		// A code-shaped plain object has no crypto class; the filesystem probe
		// rejects the non-allowlisted code and the generic copy is used.
		for (const code of ["cipher-failure", "future-code"]) {
			const fake = reportCheckpointFailure({ code, message: RAW });
			expect(fake.message).toBe("Checkpoint failed; no artifact was written.");
			expect(fake.message).not.toContain(code);
			expect(fake.message).not.toContain(RAW);
		}
	});

	test("classifies memory exhaustion as a resource failure", () => {
		const notification = reportCheckpointFailure(new RangeError(RAW));
		expect(notification.message).toBe(
			"The checkpoint could not be built because the session data is too large for the available memory; no artifact was written.",
		);
		expect(notification.message).not.toContain(RAW);
		expect(notification.message).not.toBe("Checkpoint failed; no artifact was written.");
		expect(notification.variant).toBe("error");
	});

	test("maps known raw filesystem codes to fixed checkpoint copy and never echoes unknown codes", () => {
		const expected: ReadonlyArray<readonly [string, string]> = [
			["ENOSPC", "There is not enough free disk space to write the checkpoint; no artifact was written."],
			[
				"EACCES",
				"The checkpoint could not be written because the output location is not writable; no artifact was written.",
			],
			["EPERM", "The checkpoint could not be written because the output location is not writable; no artifact was written."],
			["EROFS", "The checkpoint could not be written because the output location is not writable; no artifact was written."],
			["EBUSY", "The checkpoint file could not be written because the output location is busy; no artifact was written."],
			["ETXTBSY", "The checkpoint file could not be written because the output location is busy; no artifact was written."],
			["EMFILE", "The checkpoint file could not be written because the output location is busy; no artifact was written."],
			["ENFILE", "The checkpoint file could not be written because the output location is busy; no artifact was written."],
		];

		for (const [code, message] of expected) {
			const rawError = Object.assign(new Error(RAW), { code });
			const notification = reportCheckpointFailure(rawError);
			expect(notification.message).toBe(message);
			expect(notification.message).not.toContain(code);
			expect(notification.message).not.toContain(RAW);
		}

		// Raw fs errors are plain objects too; that must still classify.
		const plain = reportCheckpointFailure({ code: "ENOSPC", message: RAW });
		expect(plain.message).toBe(
			"There is not enough free disk space to write the checkpoint; no artifact was written.",
		);
		expect(plain.message).not.toContain(RAW);

		// Unknown filesystem codes fall through to the generic unknown copy.
		const unknown = reportCheckpointFailure(Object.assign(new Error(RAW), { code: "EWEIRD" }));
		expect(unknown.message).toBe("Checkpoint failed; no artifact was written.");
		expect(unknown.message).not.toContain("EWEIRD");
		expect(unknown.message).not.toContain(RAW);

		// A RangeError carrying a filesystem code stays a resource failure.
		const rangeWithCode = Object.assign(new RangeError(RAW), { code: "ENOSPC" });
		const resource = reportCheckpointFailure(rangeWithCode);
		expect(resource.message).toBe(
			"The checkpoint could not be built because the session data is too large for the available memory; no artifact was written.",
		);
		expect(resource.message).not.toContain("ENOSPC");
		expect(resource.message).not.toContain(RAW);
	});
});

describe("non-object thrown values", () => {
	test("thrown strings, null, numbers, and arrays keep the generic copies on both paths", () => {
		for (const thrown of [RAW, null, 42, [RAW]] as const) {
			const checkpoint = reportCheckpointFailure(thrown);
			expect(checkpoint.message).toBe("Checkpoint failed; no artifact was written.");
			expect(checkpoint.message).not.toContain(RAW);

			const restore = reportRestoreFailure(thrown, false);
			expect(restore.message).toBe("Restore failed; no sessions were changed.");
			expect(restore.message).not.toContain(RAW);
		}
	});
});

describe("restore reports", () => {
	test("usage, capability, cancel, and authentication failures never report success", () => {
		for (const notification of [
			reportRestoreUsage(),
			reportRestoreCapabilityUnavailable(),
			reportRestoreCanceled(),
			reportRestoreAuthenticationFailed(),
		]) {
			expect(notification.variant).not.toBe("success");
		}
		expect(reportRestoreUsage().message).toContain("Usage: /restore");
		expect(reportRestoreUsage().message).toContain("[artifact-path]");
		expect(reportRestoreCapabilityUnavailable().message).toContain("session-import capability");
		expect(reportRestoreAuthenticationFailed().message).toContain("3 password attempts");
	});

	test("bare-restore fixed copies: no active project and no checkpoint found never report success", () => {
		const noActive = reportRestoreNoActiveProject();
		expect(noActive.variant).toBe("warning");
		expect(noActive.message).toContain("active project directory is unavailable");
		expect(noActive.message).toContain("no sessions were changed");

		const noCheckpoint = reportRestoreNoCheckpointFound();
		expect(noCheckpoint.variant).toBe("warning");
		expect(noCheckpoint.message).toContain(".sessionport");
		expect(noCheckpoint.message).toContain("no sessions were changed");
		expect(noCheckpoint.message).not.toContain("Usage:");
	});

	test("sanitizes restore failures and distinguishes the execution-started phase", () => {
		const failures: Array<{ readonly error: unknown; readonly expectMessage: string }> = [
			{ error: new HostAdapterError("capability-unavailable", RAW), expectMessage: "capability required to restore" },
			{ error: new LocationResolutionError("capability-unavailable", RAW), expectMessage: "project-location capability" },
			{ error: new LocationResolutionError("mismatch", RAW), expectMessage: "could not be verified" },
			{ error: new ProjectDestinationError(RAW), expectMessage: "project list" },
			{ error: new SessionCollectionError("session-list-failed", RAW), expectMessage: "destination project" },
			{ error: new RestorePlanError("invalid-input", RAW), expectMessage: "does not match this destination" },
			{ error: new ArtifactFileError("invalid-request", RAW), expectMessage: "artifact path is not usable" },
			{ error: new CryptoContainerError("truncated-artifact", RAW), expectMessage: "could not be opened" },
			{ error: new Error(RAW), expectMessage: "Restore failed" },
		];

		for (const { error, expectMessage } of failures) {
			const notification = reportRestoreFailure(error, false);
			expect(notification.variant).toBe("error");
			expect(notification.message).toContain(expectMessage);
			expect(notification.message).not.toContain(RAW);
		}

		const afterExecution = reportRestoreFailure(new Error(RAW), true);
		expect(afterExecution.message).not.toContain(RAW);
		expect(afterExecution.message).not.toContain("no sessions were changed");
		expect(afterExecution.message).toContain("no atomic rollback");
	});

	test("adds a fixed reason and the exact known code for every known restore plan failure code", () => {
		const expected: ReadonlyArray<readonly [RestorePlanErrorCode, string]> = [
			["invalid-input", "the restore planning request was invalid"],
			["malformed-payload", "the checkpoint payload was malformed"],
			["malformed-destination", "the destination session history could not be read"],
			["divergent-artifact-session", "the checkpoint repeats a session with different content"],
			["duplicate-artifact-message-id", "the checkpoint repeats a message ID across sessions"],
			["ambiguous-destination", "the destination repeats a session or message ID"],
			["dangling-session-reference", "a session reference does not resolve in the destination or plan"],
			["dangling-message-reference", "a message reference does not resolve in the destination"],
			["session-id-collision", "a planned session ID collides with existing session history"],
			["message-id-collision", "a planned message ID collides with existing session history"],
			["dependency-cycle", "session parent/reference relationships contain a cycle"],
			["derivation-failure", "a remapped session or message ID could not be derived"],
		];

		for (const [code, reason] of expected) {
			const notification = reportRestoreFailure(new RestorePlanError(code, RAW), false);
			expect(notification).toEqual({
				title: "Restore failed",
				message: `The checkpoint does not match this destination safely; no sessions were changed. Reason: ${reason} (${code}).`,
				variant: "error",
			});
			expect(notification.message).not.toContain(RAW);
		}
	});

	test("unknown or forged plan codes, prototype keys, and non-instance objects keep the generic restore copy", () => {
		const genericPlan = "The checkpoint does not match this destination safely; no sessions were changed.";

		for (const code of ["future-unknown-code", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
			const forged = new RestorePlanError(code as RestorePlanErrorCode, RAW);
			const notification = reportRestoreFailure(forged, false);
			expect(notification.message).toBe(genericPlan);
			expect(notification.message).not.toContain(code);
			expect(notification.message).not.toContain(RAW);
		}

		// A code-shaped plain object is not a RestorePlanError: it cannot reach
		// the plan category and keeps the unknown-category copy.
		const fake = reportRestoreFailure({ code: "invalid-input", message: RAW }, false);
		expect(fake.message).toBe("Restore failed; no sessions were changed.");
		expect(fake.message).not.toContain("invalid-input");
		expect(fake.message).not.toContain(RAW);

		// A forged object with the class prototype but no own code property
		// classifies as a plan error yet keeps the generic plan copy.
		const prototypeForged = reportRestoreFailure(Object.create(RestorePlanError.prototype), false);
		expect(prototypeForged.message).toBe(genericPlan);
		expect(prototypeForged.message).not.toContain(RAW);

		// An unclassified error keeps the unknown-category copy.
		const unknown = reportRestoreFailure(new Error(RAW), false);
		expect(unknown.message).toBe("Restore failed; no sessions were changed.");
		expect(unknown.message).not.toContain(RAW);
	});

	test("known restore collection codes surface the shared fixed reasons with the restore base copy", () => {
		const expected: ReadonlyArray<readonly [SessionCollectionErrorCode, string]> = [
			["invalid-request", "the session collection request was invalid"],
			["invalid-policy", "the session collection policy was invalid"],
			["session-list-failed", "the host session list could not be read"],
			["message-list-failed", "a session's message history could not be read"],
			["malformed-session-page", "the host returned a malformed session list page"],
			["malformed-message-page", "the host returned a malformed message list page"],
			["malformed-session-record", "the host returned a malformed session record"],
			["malformed-message-record", "the host returned a malformed message record"],
			["session-project-mismatch", "a listed session did not belong to the requested project"],
			["duplicate-session-id", "the host returned a session more than once"],
			["duplicate-message-id", "the host returned a message more than once"],
			["repeated-session-cursor", "the host repeated a session list cursor"],
			["repeated-message-cursor", "the host repeated a message list cursor"],
			["session-limit-exceeded", "the session count exceeded the configured limit"],
			["message-limit-exceeded", "a session's message count exceeded the configured limit"],
			["total-message-limit-exceeded", "the total message count exceeded the configured limit"],
			["unsettled-message", "the project history contains an unfinished message"],
		];

		for (const [code, reason] of expected) {
			const notification = reportRestoreFailure(new SessionCollectionError(code, RAW), false);
			expect(notification).toEqual({
				title: "Restore failed",
				message: `The destination project's sessions could not be read; no sessions were changed. Reason: ${reason} (${code}).`,
				variant: "error",
			});
			expect(notification.message).not.toContain(RAW);
		}

		// Unknown/forged collection codes keep the restore base copy with no leak.
		const genericCollection = "The destination project's sessions could not be read; no sessions were changed.";
		for (const code of ["future-unknown-code", "constructor", "__proto__", "toString"]) {
			const forged = reportRestoreFailure(new SessionCollectionError(code as SessionCollectionErrorCode, RAW), false);
			expect(forged.message).toBe(genericCollection);
			expect(forged.message).not.toContain(code);
			expect(forged.message).not.toContain(RAW);
		}
	});

	test("adds a fixed reason and the exact known code for every known crypto failure code except authentication", () => {
		const expected: ReadonlyArray<readonly [CryptoErrorCode, string]> = [
			["invalid-policy-definition", "the crypto policy configuration was invalid"],
			["unknown-policy", "the selected crypto policy is unknown"],
			["unknown-kdf-profile", "the crypto key-derivation profile is unknown"],
			["invalid-password", "the password material was invalid"],
			["unsupported-runtime", "the required crypto runtime is unavailable"],
			["invalid-header", "the encrypted artifact header was invalid"],
			["unsupported-format-version", "the artifact format version is unsupported"],
			["unsupported-algorithm", "the artifact algorithm is unsupported"],
			["artifact-too-large", "the encrypted artifact would exceed the configured size limit"],
			["invalid-artifact-source", "the checkpoint data stream was invalid"],
			["truncated-artifact", "the encrypted artifact ended unexpectedly"],
			["invalid-frame", "the encrypted artifact contains an invalid frame"],
			["cipher-failure", "encryption or decryption failed"],
			["authentication-failed", "the password or artifact authentication failed"],
			["unexpected-tag", "the encrypted artifact contains an unexpected frame tag"],
			["missing-final-tag", "the encrypted artifact is missing its final frame"],
			["trailing-data", "the encrypted artifact contains trailing data"],
			["compressed-limit-exceeded", "the compressed checkpoint data exceeds the configured size limit"],
			["decompressed-limit-exceeded", "the session data exceeds the configured size limit"],
			["expansion-limit-exceeded", "the checkpoint data exceeds the configured compression ratio limit"],
			["gzip-error", "the checkpoint data could not be compressed or decompressed"],
		];

		for (const [code, reason] of expected) {
			if (code === "authentication-failed") continue; // Own authentication category below.
			const notification = reportRestoreFailure(new CryptoContainerError(code, RAW), false);
			expect(notification).toEqual({
				title: "Restore failed",
				message:
					"The file could not be opened as a SessionPort checkpoint; no sessions were changed. " +
					`Reason: ${reason} (${code}).`,
				variant: "error",
			});
			expect(notification.message).not.toContain(RAW);
		}

		// authentication-failed stays in its own category: fixed authentication
		// copy with no crypto reason and no raw text.
		const auth = reportRestoreFailure(new CryptoContainerError("authentication-failed", RAW), false);
		expect(auth.message).toBe("The checkpoint could not be authenticated; no sessions were changed.");
		expect(auth.message).not.toContain("Reason:");
		expect(auth.message).not.toContain(RAW);
	});

	test("unknown or forged crypto codes and code-shaped plain objects keep the generic restore copy", () => {
		const cryptoBase = "The file could not be opened as a SessionPort checkpoint; no sessions were changed.";

		for (const code of ["future-code", "constructor", "__proto__", "toString"]) {
			const forged = reportRestoreFailure(new CryptoContainerError(code as CryptoErrorCode, RAW), false);
			expect(forged.message).toBe(cryptoBase);
			expect(forged.message).not.toContain(code);
			expect(forged.message).not.toContain(RAW);
		}

		const prototypeForged = reportRestoreFailure(Object.create(CryptoContainerError.prototype), false);
		expect(prototypeForged.message).toBe(cryptoBase);
		expect(prototypeForged.message).not.toContain(RAW);

		// A crypto-shaped plain object is not a CryptoContainerError and its code
		// is not on the filesystem allowlist: generic copy, no leak.
		for (const code of ["cipher-failure", "future-code"]) {
			const fake = reportRestoreFailure({ code, message: RAW }, false);
			expect(fake.message).toBe("Restore failed; no sessions were changed.");
			expect(fake.message).not.toContain(code);
			expect(fake.message).not.toContain(RAW);
		}
	});

	test("classifies memory exhaustion as a resource failure before and after execution", () => {
		const notification = reportRestoreFailure(new RangeError(RAW), false);
		expect(notification.message).toBe(
			"The checkpoint could not be processed because its data is too large for the available memory; no sessions were changed.",
		);
		expect(notification.message).not.toContain(RAW);
		expect(notification.message).not.toBe("Checkpoint failed; no artifact was written.");

		// The execution-started branch still wins over the resource category.
		const afterExecution = reportRestoreFailure(new RangeError(RAW), true);
		expect(afterExecution.message).toContain("no atomic rollback");
		expect(afterExecution.message).not.toContain(RAW);
	});

	test("maps known raw filesystem codes to fixed restore copy and never echoes unknown codes", () => {
		const expected: ReadonlyArray<readonly [string, string]> = [
			["ENOENT", "The checkpoint file no longer exists; no sessions were changed."],
			["EACCES", "The checkpoint file could not be read because it is not accessible; no sessions were changed."],
			["EPERM", "The checkpoint file could not be read because it is not accessible; no sessions were changed."],
			["EISDIR", "The checkpoint path is not a regular file; no sessions were changed."],
			["ENOTDIR", "The checkpoint path is not a regular file; no sessions were changed."],
		];

		for (const [code, message] of expected) {
			const rawError = Object.assign(new Error(RAW), { code });
			const notification = reportRestoreFailure(rawError, false);
			expect(notification.message).toBe(message);
			expect(notification.message).not.toContain(code);
			expect(notification.message).not.toContain(RAW);
		}

		const plain = reportRestoreFailure({ code: "ENOENT", message: RAW }, false);
		expect(plain.message).toBe("The checkpoint file no longer exists; no sessions were changed.");
		expect(plain.message).not.toContain(RAW);

		const unknown = reportRestoreFailure(Object.assign(new Error(RAW), { code: "EWEIRD" }), false);
		expect(unknown.message).toBe("Restore failed; no sessions were changed.");
		expect(unknown.message).not.toContain("EWEIRD");
		expect(unknown.message).not.toContain(RAW);

		// A RangeError carrying a filesystem code stays a resource failure.
		const rangeWithCode = Object.assign(new RangeError(RAW), { code: "ENOENT" });
		const resource = reportRestoreFailure(rangeWithCode, false);
		expect(resource.message).toBe(
			"The checkpoint could not be processed because its data is too large for the available memory; no sessions were changed.",
		);
		expect(resource.message).not.toContain("ENOENT");
		expect(resource.message).not.toContain(RAW);
	});

	test("an empty execution result is never reported as success", () => {
		const empty = reportRestoreExecution({
			outcomes: [],
			summary: { total: 0, imported: 0, skipped: 0, failed: 0, blocked: 0, notAttempted: 0 },
		});
		expect(empty.variant).toBe("warning");
		expect(empty.message).toContain("no sessions");
	});

	test("reports aggregate counts, per-session facts, skip reasons, and the no-rollback note", () => {
		const result: RestoreExecutionResult = {
			outcomes: [
				{
					sourceSessionID: "ses_parent",
					targetSessionID: "ses_parent",
					classification: "imported",
					status: "imported",
				},
				{
					sourceSessionID: "ses_skip",
					targetSessionID: "ses_skip",
					classification: "skipped",
					status: "skipped",
					skipReason: "exact-local-duplicate",
				},
				{
					sourceSessionID: "ses_fail",
					targetSessionID: "ses_fail",
					classification: "renamed",
					status: "failed",
				},
				{
					sourceSessionID: "ses_child",
					targetSessionID: "ses_child_derived",
					classification: "imported",
					status: "blocked",
				},
			],
			summary: { total: 4, imported: 1, skipped: 1, failed: 1, blocked: 1, notAttempted: 0 },
		};

		const notification = reportRestoreExecution(result);
		expect(notification.variant).toBe("warning");
		expect(notification.message).toContain("1 imported");
		expect(notification.message).toContain("1 skipped");
		expect(notification.message).toContain("1 failed");
		expect(notification.message).toContain("1 blocked");
		expect(notification.message).toContain("ses_parent");
		expect(notification.message).toContain("exact-local-duplicate");
		expect(notification.message).toContain("no atomic rollback");
	});

	test("a clean import result reports success; an all-skipped result reports informationally", () => {
		const clean = reportRestoreExecution({
			outcomes: [
				{ sourceSessionID: "ses_a", targetSessionID: "ses_a", classification: "imported", status: "imported" },
			],
			summary: { total: 1, imported: 1, skipped: 0, failed: 0, blocked: 0, notAttempted: 0 },
		});
		expect(clean.variant).toBe("success");

		const allSkipped = reportRestoreExecution({
			outcomes: [
				{
					sourceSessionID: "ses_a",
					targetSessionID: "ses_a",
					classification: "skipped",
					status: "skipped",
					skipReason: "exact-local-duplicate",
				},
			],
			summary: { total: 1, imported: 0, skipped: 1, failed: 0, blocked: 0, notAttempted: 0 },
		});
		expect(allSkipped.variant).toBe("info");
	});

	test("maps execution facts into the designer presentation model, preserving every status and skip reason", () => {
		const result: RestoreExecutionResult = {
			outcomes: [
				{ sourceSessionID: "ses_parent", targetSessionID: "ses_parent", classification: "imported", status: "imported" },
				{
					sourceSessionID: "ses_duplicate",
					targetSessionID: "ses_duplicate",
					classification: "skipped",
					status: "skipped",
					skipReason: "exact-local-duplicate",
				},
				{
					sourceSessionID: "ses_retry",
					targetSessionID: "ses_retry_derived",
					classification: "skipped",
					status: "skipped",
					skipReason: "exact-planned-retry",
				},
				{ sourceSessionID: "ses_fail", targetSessionID: "ses_fail", classification: "renamed", status: "failed" },
				{ sourceSessionID: "ses_blocked", targetSessionID: "ses_blocked", classification: "imported", status: "blocked" },
				{ sourceSessionID: "ses_later", targetSessionID: "ses_later", classification: "imported", status: "not-attempted" },
			],
			summary: { total: 6, imported: 1, skipped: 2, failed: 1, blocked: 1, notAttempted: 1 },
		};

		const model = mapRestoreExecutionToReportPresentation(result);

		expect(model.summary).toEqual({ total: 6, imported: 1, skipped: 2, failed: 1, blocked: 1, notAttempted: 1 });
		expect(model.sessions.map((session) => session.sessionID)).toEqual([
			"ses_parent",
			"ses_duplicate",
			"ses_retry",
			"ses_fail",
			"ses_blocked",
			"ses_later",
		]);
		expect(model.sessions.map((session) => session.classification)).toEqual([
			"imported",
			"skipped",
			"skipped",
			"renamed",
			"imported",
			"imported",
		]);
		expect(model.sessions.map((session) => session.status)).toEqual([
			"imported",
			"skipped",
			"skipped",
			"failed",
			"blocked",
			"not-attempted",
		]);
		expect(model.sessions[1]?.skipReason).toBe("exact-local-duplicate");
		expect(model.sessions[2]?.skipReason).toBe("exact-planned-retry");
		expect(model.sessions[0]?.skipReason).toBeUndefined();
		expect(model.sessions[3]?.skipReason).toBeUndefined();
	});

	test("the dialog-display fallback is aggregate-only and preserves the no-rollback notice", () => {
		const partial: RestoreExecutionResult = {
			outcomes: [
				{ sourceSessionID: "ses_fail", targetSessionID: "ses_fail", classification: "renamed", status: "failed" },
			],
			summary: { total: 2, imported: 1, skipped: 0, failed: 1, blocked: 0, notAttempted: 0 },
		};
		const fallback = reportRestoreExecutionFallback(partial);
		expect(fallback.title).toBe("Restore finished");
		expect(fallback.variant).toBe("warning");
		expect(fallback.message).toContain("1 imported");
		expect(fallback.message).toContain("1 failed");
		expect(fallback.message).toContain("could not be displayed");
		expect(fallback.message).toContain("no atomic rollback");
		expect(fallback.message).not.toContain("ses_");
		expect(fallback.message).not.toContain("Restore failed");
		expect(fallback.message).not.toContain("no sessions were changed");
		expect(fallback.message).not.toContain(RAW);

		const clean = reportRestoreExecutionFallback({
			outcomes: [
				{ sourceSessionID: "ses_a", targetSessionID: "ses_a", classification: "imported", status: "imported" },
			],
			summary: { total: 1, imported: 1, skipped: 0, failed: 0, blocked: 0, notAttempted: 0 },
		});
		expect(clean.variant).toBe("success");
		expect(clean.message).toContain("1 imported");
		expect(clean.message).not.toContain("no atomic rollback");
		expect(clean.message).not.toContain("ses_");

		// Defensive: an empty result keeps the truthful non-success copy.
		const empty = reportRestoreExecutionFallback({
			outcomes: [],
			summary: { total: 0, imported: 0, skipped: 0, failed: 0, blocked: 0, notAttempted: 0 },
		});
		expect(empty).toEqual(
			reportRestoreExecution({
				outcomes: [],
				summary: { total: 0, imported: 0, skipped: 0, failed: 0, blocked: 0, notAttempted: 0 },
			}),
		);
	});

	test("the replacement fallback reports the updated count and still shows the recovery path", () => {
		const report: RestoreReplacementReport = {
			entries: [
				{ sessionID: "ses_update", title: "Updated session", outcome: "updated" },
				{ sessionID: "ses_copy", title: "Copied session", outcome: "copied" },
			],
			recoveryPath: "C:/work/.sessionport/recovery.sessionport",
		};

		const fallback = reportRestoreReplacementFallback(report);

		expect(fallback.title).toBe("Restore finished");
		expect(fallback.variant).toBe("success");
		expect(fallback.message).toContain("0 replaced, 1 updated, 1 copied");
		expect(fallback.message).toContain("2 total");
		expect(fallback.message).toContain("could not be displayed");
		expect(fallback.message).toContain("Encrypted recovery file: C:/work/.sessionport/recovery.sessionport");
		expect(fallback.message).not.toContain("ses_");
		expect(fallback.message).not.toContain("no atomic rollback");
	});
});
