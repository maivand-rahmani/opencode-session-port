/**
 * Report-copy tests for the Phase 2 wiring lane.
 *
 * These are pure string/shape tests over synthetic outcomes and real error
 * classes. They pin the sanitization rule (no raw exception text, ever), the
 * truthful-success rule (empty/canceled outcomes never report success), and the
 * O-06/O-15 report default (aggregate counts plus per-session facts; partial
 * progress states no atomic rollback).
 */

import { describe, expect, test } from "bun:test";
import { HostAdapterError } from "../../../src/tui/adapters/index.ts";
import { LocationResolutionError } from "../../../src/tui/adapters/location-resolver.ts";
import { ProjectDestinationError } from "../../../src/tui/adapters/project-destinations.ts";
import { ArtifactFileError } from "../../../src/tui/artifacts/files.ts";
import { CryptoContainerError } from "../../../src/core/crypto/errors.ts";
import { RestorePlanError } from "../../../src/core/restore/planner.ts";
import { SessionCollectionError } from "../../../src/core/sessions/index.ts";
import type { RestoreExecutionResult } from "../../../src/tui/orchestration/index.ts";
import {
	reportCheckpointFailure,
	reportCheckpointOutcome,
	reportRestoreAuthenticationFailed,
	reportRestoreCanceled,
	reportRestoreCapabilityUnavailable,
	reportRestoreExecution,
	reportRestoreFailure,
	reportRestoreUsage,
} from "../../../src/tui/wiring/index.ts";
import {
	mapRestoreExecutionToReportPresentation,
	reportRestoreExecutionFallback,
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
		expect(reportRestoreCapabilityUnavailable().message).toContain("session-import capability");
		expect(reportRestoreAuthenticationFailed().message).toContain("3 password attempts");
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
});
