/**
 * Restore-execution tests (Phase 4 orchestration).
 *
 * Synthetic completed plans and fake importers only: no real host call,
 * import, filesystem, crypto, or UI effect. These tests pin the owner-decided
 * O-06 handling policy — sequential parent-first execution of
 * `plan.importOrder`, no retries, exact-skip preservation, descendant
 * blocking, independent-branch continuation, truthful `not-attempted` stop
 * behavior, and complete outcome accounting — with no runtime, compatibility,
 * or production-policy claim (O-01/O-02/O-03/O-15 remain OPEN; the O-16 target
 * stays caller-owned).
 */

import { describe, expect, spyOn, test } from "bun:test";
import { planRestore, type RestorePlan, type RestorePlanEntry } from "../../../src/core/restore/index.ts";
import type { SessionImportAdapter, SessionImportRequest, SessionImportResult } from "../../../src/tui/adapters/index.ts";
import * as orchestration from "../../../src/tui/orchestration/index.ts";
import { runRestoreExecution } from "../../../src/tui/orchestration/index.ts";
import {
	createFakeIdDeriver,
	sessionRecord,
	TEST_ARTIFACT_IDENTITY,
	TEST_IMPORT_PROJECT_ID,
	userMessage,
} from "./test-support.ts";

const TARGET_DIRECTORY = "C:/work/restore-target";

interface EntrySpec {
	readonly source: string;
	/** Planned target session ID; defaults to the source ID. */
	readonly target?: string;
	readonly classification?: "imported" | "renamed" | "skipped";
	readonly skipReason?: "exact-local-duplicate" | "exact-planned-retry";
	/** Planned target session ID of the parent entry, when this session has one. */
	readonly parent?: string;
}

/** Hand-built plan entry that satisfies the executor's fail-closed plan shape. */
function makeEntry(spec: EntrySpec): RestorePlanEntry {
	const target = spec.target ?? spec.source;
	const classification = spec.classification ?? "imported";
	const record = sessionRecord(
		target,
		[userMessage(`msg_${target}`)],
		"proj_dest",
		spec.parent !== undefined ? { parentID: spec.parent } : {},
	);
	return {
		sourceSessionID: spec.source,
		targetSessionID: target,
		classification,
		record,
		...(spec.skipReason !== undefined ? { skipReason: spec.skipReason } : {}),
	};
}

function makePlan(entries: readonly RestorePlanEntry[], importOrder?: readonly RestorePlanEntry[]): RestorePlan {
	return {
		entries,
		importOrder: importOrder ?? entries.filter((entry) => entry.classification !== "skipped"),
		collapsedDuplicateCount: 0,
	};
}

interface RecordingImporter {
	readonly importer: SessionImportAdapter;
	readonly calls: SessionImportRequest[];
}

/**
 * One well-formed `SessionImportResult` for the fake importer: the request
 * record's own ID (the adapter requires response/request ID equality) and the
 * explicit target directory. This suite runs after adapter validation, so a
 * resolved call is a success; the fake must not pin `{}` as a success shape.
 */
function wellFormedImportResult(request: SessionImportRequest): SessionImportResult {
	const id = request.record.info["id"];
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("synthetic record is missing a nonblank info.id");
	}
	return { id, projectID: TEST_IMPORT_PROJECT_ID, location: { directory: request.target.directory } };
}

function createRecordingImporter(onImport?: (request: SessionImportRequest) => void): RecordingImporter {
	const calls: SessionImportRequest[] = [];
	return {
		calls,
		importer: {
			async importSession(request: SessionImportRequest) {
				calls.push(request);
				onImport?.(request);
				return wellFormedImportResult(request);
			},
		},
	};
}

/** Fails the import when the planned record's session ID matches. */
function failForSession(failingSessionID: string): (request: SessionImportRequest) => void {
	return (request) => {
		if (request.record.info["id"] === failingSessionID) {
			throw new Error(`synthetic host failure for ${failingSessionID}`);
		}
	};
}

function calledSessionIDs(importer: RecordingImporter): unknown[] {
	return importer.calls.map((call) => call.record.info["id"]);
}

describe("runRestoreExecution", () => {
	test("imports only plan.importOrder parent-first with the explicit target and verbatim records", async () => {
		const child = makeEntry({ source: "ses_child", parent: "ses_parent" });
		const parent = makeEntry({ source: "ses_parent" });
		// Entries are deliberately in child-first order; importOrder must win.
		const plan = makePlan([child, parent], [parent, child]);
		const recording = createRecordingImporter();

		const result = await runRestoreExecution({ plan, importer: recording.importer, targetDirectory: TARGET_DIRECTORY });

		expect(calledSessionIDs(recording)).toEqual(["ses_parent", "ses_child"]);
		expect(recording.calls[0]!.record).toBe(parent.record);
		expect(recording.calls[1]!.record).toBe(child.record);
		expect(recording.calls.every((call) => call.target.directory === TARGET_DIRECTORY)).toBe(true);
		// Outcomes stay in plan.entries order (child first), independent of call order.
		expect(result.outcomes).toEqual([
			{ sourceSessionID: "ses_child", targetSessionID: "ses_child", classification: "imported", status: "imported" },
			{ sourceSessionID: "ses_parent", targetSessionID: "ses_parent", classification: "imported", status: "imported" },
		]);
		expect(result.summary).toEqual({ total: 2, imported: 2, skipped: 0, failed: 0, blocked: 0, notAttempted: 0 });
	});

	test("preserves exact local and exact retry skip outcomes and treats skipped parents as present", async () => {
		const localSkip = makeEntry({ source: "ses_local", classification: "skipped", skipReason: "exact-local-duplicate" });
		const retrySkip = makeEntry({
			source: "ses_retry",
			target: "ses_retry_remapped",
			classification: "skipped",
			skipReason: "exact-planned-retry",
		});
		const localChild = makeEntry({ source: "ses_local_child", parent: "ses_local" });
		const retryChild = makeEntry({ source: "ses_retry_child", parent: "ses_retry_remapped" });
		const plan = makePlan([localSkip, retrySkip, localChild, retryChild], [localChild, retryChild]);
		const recording = createRecordingImporter();

		const result = await runRestoreExecution({ plan, importer: recording.importer, targetDirectory: TARGET_DIRECTORY });

		expect(calledSessionIDs(recording)).toEqual(["ses_local_child", "ses_retry_child"]);
		expect(result.outcomes).toEqual([
			{
				sourceSessionID: "ses_local",
				targetSessionID: "ses_local",
				classification: "skipped",
				status: "skipped",
				skipReason: "exact-local-duplicate",
			},
			{
				sourceSessionID: "ses_retry",
				targetSessionID: "ses_retry_remapped",
				classification: "skipped",
				status: "skipped",
				skipReason: "exact-planned-retry",
			},
			{
				sourceSessionID: "ses_local_child",
				targetSessionID: "ses_local_child",
				classification: "imported",
				status: "imported",
			},
			{
				sourceSessionID: "ses_retry_child",
				targetSessionID: "ses_retry_child",
				classification: "imported",
				status: "imported",
			},
		]);
		expect(Object.prototype.hasOwnProperty.call(result.outcomes[2]!, "skipReason")).toBe(false);
	});

	test("preserves the renamed planner classification alongside the imported execution status", async () => {
		const renamed = makeEntry({ source: "ses_conflict", target: "ses_conflict_remapped", classification: "renamed" });
		const plan = makePlan([renamed]);
		const recording = createRecordingImporter();

		const result = await runRestoreExecution({ plan, importer: recording.importer, targetDirectory: TARGET_DIRECTORY });

		expect(calledSessionIDs(recording)).toEqual(["ses_conflict_remapped"]);
		expect(result.outcomes).toEqual([
			{
				sourceSessionID: "ses_conflict",
				targetSessionID: "ses_conflict_remapped",
				classification: "renamed",
				status: "imported",
			},
		]);
		expect(result.summary).toEqual({ total: 1, imported: 1, skipped: 0, failed: 0, blocked: 0, notAttempted: 0 });
	});

	test("supplies the explicit target directory on every import and never infers one", async () => {
		const a = makeEntry({ source: "ses_a" });
		const b = makeEntry({ source: "ses_b" });
		const c = makeEntry({ source: "ses_c" });
		const plan = makePlan([a, b, c]);
		const recording = createRecordingImporter();

		await runRestoreExecution({ plan, importer: recording.importer, targetDirectory: "D:/explicit/restore/target" });

		expect(recording.calls.length).toBe(3);
		expect(recording.calls.every((call) => call.target.directory === "D:/explicit/restore/target")).toBe(true);
	});

	test("a failed parent blocks its descendants while independent branches continue", async () => {
		const parent = makeEntry({ source: "ses_p" });
		const child = makeEntry({ source: "ses_c", parent: "ses_p" });
		const grandchild = makeEntry({ source: "ses_g", parent: "ses_c" });
		const independent = makeEntry({ source: "ses_i" });
		const plan = makePlan([parent, child, grandchild, independent], [parent, child, grandchild, independent]);
		const recording = createRecordingImporter(failForSession("ses_p"));

		const result = await runRestoreExecution({ plan, importer: recording.importer, targetDirectory: TARGET_DIRECTORY });

		expect(calledSessionIDs(recording)).toEqual(["ses_p", "ses_i"]);
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["failed", "blocked", "blocked", "imported"]);
		expect(result.summary).toEqual({ total: 4, imported: 1, skipped: 0, failed: 1, blocked: 2, notAttempted: 0 });
	});

	test("a host error on one independent entry does not stop the remaining independent entries", async () => {
		const first = makeEntry({ source: "ses_a" });
		const failing = makeEntry({ source: "ses_b" });
		const last = makeEntry({ source: "ses_c" });
		const plan = makePlan([first, failing, last], [first, failing, last]);
		const recording = createRecordingImporter(failForSession("ses_b"));

		const result = await runRestoreExecution({ plan, importer: recording.importer, targetDirectory: TARGET_DIRECTORY });

		expect(calledSessionIDs(recording)).toEqual(["ses_a", "ses_b", "ses_c"]);
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["imported", "failed", "imported"]);
	});

	test("never retries a failed import", async () => {
		const failing = makeEntry({ source: "ses_x" });
		const later = makeEntry({ source: "ses_y" });
		const plan = makePlan([failing, later], [failing, later]);
		const recording = createRecordingImporter(failForSession("ses_x"));

		const result = await runRestoreExecution({ plan, importer: recording.importer, targetDirectory: TARGET_DIRECTORY });

		expect(calledSessionIDs(recording)).toEqual(["ses_x", "ses_y"]);
		expect(recording.calls.length).toBe(2);
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["failed", "imported"]);
	});

	test("assumes a parent outside the plan is already present and does not block", async () => {
		const entry = makeEntry({ source: "ses_child", parent: "ses_destination_parent" });
		const plan = makePlan([entry]);
		const recording = createRecordingImporter();

		const result = await runRestoreExecution({ plan, importer: recording.importer, targetDirectory: TARGET_DIRECTORY });

		expect(calledSessionIDs(recording)).toEqual(["ses_child"]);
		expect(result.outcomes[0]!.status).toBe("imported");
	});

	test("marks remaining independent entries not-attempted when shouldContinue stops, and blocks descendants of the unattempted parent", async () => {
		const a = makeEntry({ source: "ses_a" });
		const b = makeEntry({ source: "ses_b", parent: "ses_a" });
		const c = makeEntry({ source: "ses_c", parent: "ses_b" });
		const d = makeEntry({ source: "ses_d" });
		const plan = makePlan([a, b, c, d], [a, b, c, d]);
		const recording = createRecordingImporter();
		let checks = 0;

		const result = await runRestoreExecution({
			plan,
			importer: recording.importer,
			targetDirectory: TARGET_DIRECTORY,
			shouldContinue: () => {
				checks += 1;
				return checks === 1;
			},
		});

		expect(calledSessionIDs(recording)).toEqual(["ses_a"]);
		expect(checks).toBe(2);
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
			"imported",
			"not-attempted",
			"blocked",
			"not-attempted",
		]);
	});

	test("a stop before the first import leaves every planned entry accounted for without any call", async () => {
		const a = makeEntry({ source: "ses_a" });
		const b = makeEntry({ source: "ses_b", parent: "ses_a" });
		const plan = makePlan([a, b], [a, b]);
		const recording = createRecordingImporter();
		let checks = 0;

		const result = await runRestoreExecution({
			plan,
			importer: recording.importer,
			targetDirectory: TARGET_DIRECTORY,
			shouldContinue: () => {
				checks += 1;
				return false;
			},
		});

		expect(recording.calls).toEqual([]);
		expect(checks).toBe(1);
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["not-attempted", "blocked"]);
		expect(result.summary).toEqual({ total: 2, imported: 0, skipped: 0, failed: 0, blocked: 1, notAttempted: 1 });
	});

	test("a nonboolean stop-check after partial progress stops remaining imports and keeps full accounting", async () => {
		const a = makeEntry({ source: "ses_a" });
		const b = makeEntry({ source: "ses_b", parent: "ses_a" });
		const c = makeEntry({ source: "ses_c", parent: "ses_b" });
		const d = makeEntry({ source: "ses_d" });
		const plan = makePlan([a, b, c, d], [a, b, c, d]);
		const recording = createRecordingImporter();
		let checks = 0;

		const result = await runRestoreExecution({
			plan,
			importer: recording.importer,
			targetDirectory: TARGET_DIRECTORY,
			shouldContinue: () => {
				checks += 1;
				return checks === 1 ? true : ("continue" as unknown as boolean);
			},
		});

		// The already-attempted import is never repeated; the nonboolean value
		// latches a stop and is treated exactly like an explicit `false`.
		expect(calledSessionIDs(recording)).toEqual(["ses_a"]);
		expect(recording.calls.length).toBe(1);
		expect(checks).toBe(2);
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
			"imported",
			"not-attempted",
			"blocked",
			"not-attempted",
		]);
		expect(result.summary).toEqual({ total: 4, imported: 1, skipped: 0, failed: 0, blocked: 1, notAttempted: 2 });
	});

	test("a throwing stop-check after partial progress stops remaining imports without exposing the error", async () => {
		const marker = "sensitive-stop-check-marker";
		const a = makeEntry({ source: "ses_a" });
		const b = makeEntry({ source: "ses_b", parent: "ses_a" });
		const d = makeEntry({ source: "ses_d" });
		const plan = makePlan([a, b, d], [a, b, d]);
		const recording = createRecordingImporter();
		let checks = 0;
		const logSpy = spyOn(console, "log");
		const warnSpy = spyOn(console, "warn");
		const errorSpy = spyOn(console, "error");
		let result: Awaited<ReturnType<typeof runRestoreExecution>>;
		try {
			result = await runRestoreExecution({
				plan,
				importer: recording.importer,
				targetDirectory: TARGET_DIRECTORY,
				shouldContinue: () => {
					checks += 1;
					if (checks === 1) return true;
					throw new Error(marker);
				},
			});
		} finally {
			logSpy.mockRestore();
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}

		// The helper returns a complete result instead of rejecting, the raw
		// callback error never surfaces, and no attempted import is repeated.
		expect(calledSessionIDs(recording)).toEqual(["ses_a"]);
		expect(recording.calls.length).toBe(1);
		expect(checks).toBe(2);
		expect(result!.outcomes.map((outcome) => outcome.status)).toEqual(["imported", "not-attempted", "not-attempted"]);
		expect(JSON.stringify(result!)).not.toContain(marker);
		expect(logSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("accounts for every entry exactly once with a truthful summary across all outcome states", async () => {
		const skipped = makeEntry({ source: "ses_skip", classification: "skipped", skipReason: "exact-local-duplicate" });
		const imported = makeEntry({ source: "ses_ok" });
		const failed = makeEntry({ source: "ses_fail" });
		const blocked = makeEntry({ source: "ses_blocked", parent: "ses_fail" });
		const notAttempted = makeEntry({ source: "ses_stop" });
		const entries = [skipped, imported, failed, blocked, notAttempted];
		const plan = makePlan(entries, [imported, failed, blocked, notAttempted]);
		const recording = createRecordingImporter(failForSession("ses_fail"));
		let checks = 0;

		const result = await runRestoreExecution({
			plan,
			importer: recording.importer,
			targetDirectory: TARGET_DIRECTORY,
			shouldContinue: () => {
				checks += 1;
				return checks <= 2;
			},
		});

		expect(calledSessionIDs(recording)).toEqual(["ses_ok", "ses_fail"]);
		expect(result.outcomes.map((outcome) => outcome.sourceSessionID)).toEqual(entries.map((entry) => entry.sourceSessionID));
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
			"skipped",
			"imported",
			"failed",
			"blocked",
			"not-attempted",
		]);
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index]!;
			const outcome = result.outcomes[index]!;
			expect(outcome.targetSessionID).toBe(entry.targetSessionID);
			expect(outcome.classification).toBe(entry.classification);
		}
		expect(result.summary).toEqual({
			total: 5,
			imported: 1,
			skipped: 1,
			failed: 1,
			blocked: 1,
			notAttempted: 1,
		});
	});

	test("does not write to the console and never exposes host error text or record content", async () => {
		const marker = "sensitive-host-error-marker";
		const failing = makeEntry({ source: "ses_fail" });
		const ok = makeEntry({ source: "ses_ok" });
		const plan = makePlan([failing, ok], [failing, ok]);
		const recording = createRecordingImporter((request) => {
			if (request.record.info["id"] === "ses_fail") throw new Error(marker);
		});
		const logSpy = spyOn(console, "log");
		const warnSpy = spyOn(console, "warn");
		const errorSpy = spyOn(console, "error");
		let result: Awaited<ReturnType<typeof runRestoreExecution>>;
		try {
			result = await runRestoreExecution({ plan, importer: recording.importer, targetDirectory: TARGET_DIRECTORY });
		} finally {
			logSpy.mockRestore();
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}

		expect(logSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
		const serialized = JSON.stringify(result!);
		expect(serialized).not.toContain(marker);
		expect(serialized).not.toContain("title");
		expect(serialized).not.toContain("text");
		expect(result!.outcomes.map((outcome) => outcome.status)).toEqual(["failed", "imported"]);
	});

	test("executes a real planRestore plan: parent-first order, renamed target, exact-local skip", async () => {
		const payload = {
			sessions: [
				sessionRecord("ses_p", [userMessage("msg_p")], "proj_source"),
				sessionRecord("ses_c", [userMessage("msg_c")], "proj_source", { parentID: "ses_p" }),
				sessionRecord("ses_dup", [userMessage("msg_dup")], "proj_source"),
				sessionRecord("ses_same", [userMessage("msg_same")], "proj_source"),
			],
		};
		const destination = [
			sessionRecord("ses_dup", [userMessage("msg_dup")], "proj_dest", { title: "different local title" }),
			sessionRecord("ses_same", [userMessage("msg_same")], "proj_source"),
		];
		const plan = planRestore({
			payload,
			artifactIdentity: TEST_ARTIFACT_IDENTITY,
			destination,
			idDeriver: createFakeIdDeriver(),
		});

		expect(plan.entries.map((entry) => entry.classification)).toEqual(["imported", "imported", "renamed", "skipped"]);
		expect(plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_p", "ses_c", "ses_dup"]);

		const recording = createRecordingImporter();
		const result = await runRestoreExecution({ plan, importer: recording.importer, targetDirectory: TARGET_DIRECTORY });

		expect(calledSessionIDs(recording)).toEqual(plan.importOrder.map((entry) => entry.targetSessionID));
		expect(recording.calls[0]!.record).toBe(plan.importOrder[0]!.record);
		expect(recording.calls.every((call) => call.target.directory === TARGET_DIRECTORY)).toBe(true);

		const bySource = new Map(result.outcomes.map((outcome) => [outcome.sourceSessionID, outcome]));
		expect(bySource.get("ses_p")!.status).toBe("imported");
		expect(bySource.get("ses_c")!.status).toBe("imported");
		expect(bySource.get("ses_dup")!.classification).toBe("renamed");
		expect(bySource.get("ses_dup")!.status).toBe("imported");
		expect(bySource.get("ses_same")!.status).toBe("skipped");
		expect(bySource.get("ses_same")!.skipReason).toBe("exact-local-duplicate");
		expect(result.summary).toEqual({ total: 4, imported: 3, skipped: 1, failed: 0, blocked: 0, notAttempted: 0 });
	});

	test("executes a real exact-planned-retry skip: the deterministic rerun is never imported again", async () => {
		const payload = { sessions: [sessionRecord("ses_x", [userMessage("msg_x")], "proj_source")] };
		const localConflict = sessionRecord("ses_x", [userMessage("msg_x")], "proj_dest", { title: "different local title" });
		const first = planRestore({
			payload,
			artifactIdentity: TEST_ARTIFACT_IDENTITY,
			destination: [localConflict],
			idDeriver: createFakeIdDeriver(),
		});
		expect(first.entries[0]!.classification).toBe("renamed");

		const second = planRestore({
			payload,
			artifactIdentity: TEST_ARTIFACT_IDENTITY,
			destination: [localConflict, first.entries[0]!.record],
			idDeriver: createFakeIdDeriver(),
		});
		expect(second.entries[0]!.classification).toBe("skipped");
		expect(second.entries[0]!.skipReason).toBe("exact-planned-retry");
		expect(second.importOrder).toEqual([]);

		const recording = createRecordingImporter();
		const result = await runRestoreExecution({ plan: second, importer: recording.importer, targetDirectory: TARGET_DIRECTORY });

		expect(recording.calls).toEqual([]);
		expect(result.outcomes).toEqual([
			{
				sourceSessionID: "ses_x",
				targetSessionID: second.entries[0]!.targetSessionID,
				classification: "skipped",
				status: "skipped",
				skipReason: "exact-planned-retry",
			},
		]);
		expect(result.summary).toEqual({ total: 1, imported: 0, skipped: 1, failed: 0, blocked: 0, notAttempted: 0 });
	});

	test("the orchestration surface exposes the executor without any export name matching /import/i", () => {
		expect(typeof orchestration.runRestoreExecution).toBe("function");
		expect(Object.keys(orchestration).filter((name) => /import/i.test(name))).toEqual([]);
	});
});

describe("runRestoreExecution fail-closed input validation", () => {
	test("requires a non-empty explicit target directory before any import", async () => {
		const plan = makePlan([makeEntry({ source: "ses_a" })]);
		const recording = createRecordingImporter();

		await expect(
			runRestoreExecution({ plan, importer: recording.importer, targetDirectory: "" }),
		).rejects.toThrow(TypeError);
		expect(recording.calls).toEqual([]);
	});

	test("requires a callable importSession dependency", async () => {
		const plan = makePlan([makeEntry({ source: "ses_a" })]);

		await expect(
			runRestoreExecution({
				plan,
				importer: {} as unknown as SessionImportAdapter,
				targetDirectory: TARGET_DIRECTORY,
			}),
		).rejects.toThrow(TypeError);
	});

	test("rejects an importOrder that omits or repeats a planned entry", async () => {
		const a = makeEntry({ source: "ses_a" });
		const b = makeEntry({ source: "ses_b" });
		const recording = createRecordingImporter();

		await expect(
			runRestoreExecution({ plan: makePlan([a, b], [a]), importer: recording.importer, targetDirectory: TARGET_DIRECTORY }),
		).rejects.toThrow(TypeError);
		await expect(
			runRestoreExecution({
				plan: makePlan([a, b], [a, b, b]),
				importer: recording.importer,
				targetDirectory: TARGET_DIRECTORY,
			}),
		).rejects.toThrow(TypeError);
		expect(recording.calls).toEqual([]);
	});

	test("rejects a skipped entry inside importOrder and a non-parent-first importOrder", async () => {
		const skip = makeEntry({ source: "ses_skip", classification: "skipped", skipReason: "exact-local-duplicate" });
		const parent = makeEntry({ source: "ses_p" });
		const child = makeEntry({ source: "ses_c", parent: "ses_p" });
		const recording = createRecordingImporter();

		await expect(
			runRestoreExecution({ plan: makePlan([skip], [skip]), importer: recording.importer, targetDirectory: TARGET_DIRECTORY }),
		).rejects.toThrow(TypeError);
		await expect(
			runRestoreExecution({
				plan: makePlan([parent, child], [child, parent]),
				importer: recording.importer,
				targetDirectory: TARGET_DIRECTORY,
			}),
		).rejects.toThrow(TypeError);
		expect(recording.calls).toEqual([]);
	});

	test("rejects a record whose info.id does not match its planned target", async () => {
		const entry = makeEntry({ source: "ses_a" });
		const broken: RestorePlanEntry = { ...entry, record: sessionRecord("ses_wrong", [userMessage("msg_x")]) };
		const recording = createRecordingImporter();

		await expect(
			runRestoreExecution({ plan: makePlan([broken]), importer: recording.importer, targetDirectory: TARGET_DIRECTORY }),
		).rejects.toThrow(TypeError);
		expect(recording.calls).toEqual([]);
	});

	test("rejects an exact-local-duplicate skip whose target differs from its source before any import", async () => {
		const remappedSkip = makeEntry({
			source: "ses_absent",
			target: "ses_elsewhere",
			classification: "skipped",
			skipReason: "exact-local-duplicate",
		});
		// Under a remapped local-duplicate skip, this child's parent would resolve
		// to the skipped outcome and be treated as already present; validation must
		// reject the malformed plan before any import instead.
		const child = makeEntry({ source: "ses_child", parent: "ses_elsewhere" });
		const recording = createRecordingImporter();

		await expect(
			runRestoreExecution({
				plan: makePlan([remappedSkip, child], [child]),
				importer: recording.importer,
				targetDirectory: TARGET_DIRECTORY,
			}),
		).rejects.toThrow(TypeError);
		expect(recording.calls).toEqual([]);

		// The same shape with exact-planned-retry stays legitimate: a renamed
		// retry may target a derived ID, so no equality is imposed there.
		const retrySkip = makeEntry({
			source: "ses_retry",
			target: "ses_retry_remapped",
			classification: "skipped",
			skipReason: "exact-planned-retry",
		});
		const retryRecording = createRecordingImporter();
		const retryResult = await runRestoreExecution({
			plan: makePlan([retrySkip]),
			importer: retryRecording.importer,
			targetDirectory: TARGET_DIRECTORY,
		});
		expect(retryRecording.calls).toEqual([]);
		expect(retryResult.outcomes[0]!.status).toBe("skipped");
		expect(retryResult.outcomes[0]!.targetSessionID).toBe("ses_retry_remapped");
	});
});
