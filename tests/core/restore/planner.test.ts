/**
 * Pure restore preflight/planning tests (Phase 3; O-04/O-05/O-22).
 *
 * All records are synthetic and all derivation uses an injected deterministic
 * test deriver (SHA-256-based, `ses_`/`msg_` + 64 lowercase hex). A single
 * smoke test uses the real provisional BLAKE2b deriver. These tests pin the
 * owner-approved policy: canonical full-record comparison, identical-record
 * collapse, whole-artifact message-ID uniqueness, exact-local and exact-retry
 * skips, deterministic rederivation of every message ID of every imported
 * session, schema-scoped reference rewriting, collision/dangling failures,
 * payload-root key strictness, artifact-identity isolation from the deriver,
 * and a parent-before-child import order. O-06 partial-retry/reporting
 * semantics remain OPEN and are intentionally not claimed here.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	ARTIFACT_IDENTITY_BYTES,
	type CheckpointPayload,
	type SessionRecord,
} from "../../../src/core/contracts/index.ts";
import {
	createRemappedIdDeriver,
	planRestore,
	RestorePlanError,
	type RemappedIdDeriver,
	type RestorePlan,
	type RestorePlanEntry,
	type RestorePlanErrorCode,
} from "../../../src/core/restore/index.ts";

/* ------------------------------------------------------------------ */
/* Synthetic helpers                                                   */
/* ------------------------------------------------------------------ */

const IDENTITY = Uint8Array.from({ length: ARTIFACT_IDENTITY_BYTES }, (_, index) => index + 1);

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic injected deriver; outputs are valid 68-char `ses_`/`msg_` hex IDs. */
function createTestDeriver(): RemappedIdDeriver {
	return {
		derive(namespace, artifactIdentity, originalID) {
			const prefix = namespace === "session" ? "ses_" : "msg_";
			let identityHex = "";
			for (const byte of artifactIdentity) identityHex += byte.toString(16).padStart(2, "0");
			return prefix + sha256Hex(`${namespace}|${identityHex}|${originalID}`);
		},
	};
}

const deriver = createTestDeriver();

function sessionRecord(
	id: string,
	messageIDs: readonly string[],
	infoExtra: Record<string, unknown> = {},
	messageExtras: ReadonlyArray<Record<string, unknown>> = [],
): SessionRecord {
	const messages: Array<Record<string, unknown>> = [];
	for (let index = 0; index < messageIDs.length; index++) {
		messages.push({ id: messageIDs[index]!, role: "user", ...(messageExtras[index] ?? {}) });
	}
	return { info: { id, projectID: "proj_test", ...infoExtra }, messages } as unknown as SessionRecord;
}

function payloadOf(sessions: readonly SessionRecord[]): CheckpointPayload {
	return { sessions } as unknown as CheckpointPayload;
}

function runPlan(
	sessions: readonly SessionRecord[],
	destination: readonly SessionRecord[],
	overrideDeriver: RemappedIdDeriver = deriver,
	identity: Uint8Array = IDENTITY,
): RestorePlan {
	return planRestore({
		payload: payloadOf(sessions),
		artifactIdentity: identity,
		destination,
		idDeriver: overrideDeriver,
	});
}

function runPlanWithGlobal(
	sessions: readonly SessionRecord[],
	destination: readonly SessionRecord[],
	globallyVisibleSessionIDs: readonly string[],
	overrideDeriver: RemappedIdDeriver = deriver,
): RestorePlan {
	return planRestore({
		payload: payloadOf(sessions),
		artifactIdentity: IDENTITY,
		destination,
		globallyVisibleSessionIDs,
		idDeriver: overrideDeriver,
	});
}

function expectCode(run: () => unknown, code: RestorePlanErrorCode): void {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(RestorePlanError);
	expect((caught as RestorePlanError).code).toBe(code);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function derivedSessionID(sourceID: string): string {
	return deriver.derive("session", IDENTITY, sourceID);
}

function derivedMessageID(sourceID: string): string {
	return deriver.derive("message", IDENTITY, sourceID);
}

function messageIDsOf(record: SessionRecord): string[] {
	const ids: string[] = [];
	for (let index = 0; index < record.messages.length; index++) ids.push(record.messages[index]!["id"] as string);
	return ids;
}

function entryFor(plan: RestorePlan, sourceSessionID: string): RestorePlanEntry {
	for (const entry of plan.entries) {
		if (entry.sourceSessionID === sourceSessionID) return entry;
	}
	throw new Error(`plan has no entry for ${sourceSessionID}`);
}

/** Independent expected remap for records without references (retry fixtures). */
function remapForTest(record: SessionRecord, targetSessionID: string): SessionRecord {
	const info = cloneJson(record.info) as unknown as Record<string, unknown>;
	info["id"] = targetSessionID;
	const messages: Array<Record<string, unknown>> = [];
	for (let index = 0; index < record.messages.length; index++) {
		const message = cloneJson(record.messages[index]!) as unknown as Record<string, unknown>;
		message["id"] = derivedMessageID(message["id"] as string);
		messages.push(message);
	}
	return { info, messages } as unknown as SessionRecord;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const key of Object.keys(value)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
		Object.freeze(value);
	}
	return value;
}

/* ------------------------------------------------------------------ */
/* Canonical comparison (O-04)                                         */
/* ------------------------------------------------------------------ */

describe("canonical full-record comparison (O-04)", () => {
	test("treats object key order as insignificant at every nesting level", () => {
		const source = {
			info: { id: "ses_a", projectID: "proj_test", meta: { alpha: 1, beta: { gamma: true, delta: null } } },
			messages: [{ id: "msg_1", role: "user", extra: { one: 1, two: 2 } }],
		} as unknown as SessionRecord;
		const destination = {
			info: { meta: { beta: { delta: null, gamma: true }, alpha: 1 }, projectID: "proj_test", id: "ses_a" },
			messages: [{ extra: { two: 2, one: 1 }, role: "user", id: "msg_1" }],
		} as unknown as SessionRecord;

		const plan = runPlan([source], [destination]);
		expect(plan.entries.length).toBe(1);
		expect(plan.entries[0]!.classification).toBe("skipped");
		expect(plan.entries[0]!.skipReason).toBe("exact-local-duplicate");
		expect(plan.importOrder.length).toBe(0);
		expect(messageIDsOf(plan.entries[0]!.record)).toEqual(["msg_1"]);
	});

	test("treats value differences as divergent", () => {
		const source = sessionRecord("ses_a", ["msg_1"], { meta: { alpha: 1 } });
		const destination = sessionRecord("ses_a", ["msg_1"], { meta: { alpha: 2 } });
		const plan = runPlan([source], [destination]);
		expect(plan.entries[0]!.classification).toBe("renamed");
	});

	test("treats array order as significant", () => {
		const source = sessionRecord("ses_a", ["msg_1", "msg_2"]);
		const destination = sessionRecord("ses_a", ["msg_2", "msg_1"]);
		const plan = runPlan([source], [destination]);
		expect(plan.entries[0]!.classification).toBe("renamed");
	});

	test("treats absent and null as different", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const destination = sessionRecord("ses_a", ["msg_1"], { note: null });
		const plan = runPlan([source], [destination]);
		expect(plan.entries[0]!.classification).toBe("renamed");
	});
});

/* ------------------------------------------------------------------ */
/* Artifact collapse and message-ID uniqueness                         */
/* ------------------------------------------------------------------ */

describe("artifact collapse and message-ID uniqueness", () => {
	test("collapses fully identical repeated session records first", () => {
		const source = sessionRecord("ses_a", ["msg_1", "msg_2"]);
		const plan = runPlan([source, cloneJson(source), cloneJson(source)], []);
		expect(plan.entries.length).toBe(1);
		expect(plan.collapsedDuplicateCount).toBe(2);
	});

	test("rejects divergent artifact records sharing a session ID", () => {
		const first = sessionRecord("ses_a", ["msg_1"]);
		const second = sessionRecord("ses_a", ["msg_2"]);
		expectCode(() => runPlan([first, second], []), "divergent-artifact-session");
	});

	test("message-ID reuse caused only by an identical repeat does not reject", () => {
		const source = sessionRecord("ses_a", ["msg_1", "msg_2"]);
		const plan = runPlan([source, cloneJson(source)], []);
		expect(plan.collapsedDuplicateCount).toBe(1);
		expect(plan.entries.length).toBe(1);
	});

	test("rejects message-ID reuse across unique artifact records", () => {
		const first = sessionRecord("ses_a", ["msg_shared"]);
		const second = sessionRecord("ses_b", ["msg_shared"]);
		expectCode(() => runPlan([first, second], []), "duplicate-artifact-message-id");
	});

	test("rejects message-ID reuse within one record", () => {
		const source = sessionRecord("ses_a", ["msg_dup", "msg_dup"]);
		expectCode(() => runPlan([source], []), "duplicate-artifact-message-id");
	});

	test("rejects a duplicate message ID that survives collapse", () => {
		const repeated = sessionRecord("ses_a", ["msg_shared"]);
		const other = sessionRecord("ses_b", ["msg_shared"]);
		expectCode(() => runPlan([repeated, cloneJson(repeated), other], []), "duplicate-artifact-message-id");
	});
});

/* ------------------------------------------------------------------ */
/* Destination ambiguity                                               */
/* ------------------------------------------------------------------ */

describe("destination snapshot ambiguity", () => {
	test("rejects duplicate session IDs in the destination", () => {
		const a = sessionRecord("ses_a", ["msg_1"]);
		const b = sessionRecord("ses_a", ["msg_2"]);
		expectCode(() => runPlan([sessionRecord("ses_x", ["msg_x"])], [a, b]), "ambiguous-destination");
	});

	test("rejects globally duplicate message IDs in the destination", () => {
		const a = sessionRecord("ses_a", ["msg_shared"]);
		const b = sessionRecord("ses_b", ["msg_shared"]);
		expectCode(() => runPlan([sessionRecord("ses_x", ["msg_x"])], [a, b]), "ambiguous-destination");
	});
});

/* ------------------------------------------------------------------ */
/* Classification and deterministic derivation                         */
/* ------------------------------------------------------------------ */

describe("classification and deterministic derivation", () => {
	test("imports a new session under its original ID and rederives every message ID", () => {
		const source = sessionRecord("ses_a", ["msg_1", "msg_2"]);
		const plan = runPlan([source], []);
		const entry = plan.entries[0]!;

		expect(entry.classification).toBe("imported");
		expect(entry.targetSessionID).toBe("ses_a");
		expect(entry.skipReason).toBeUndefined();
		expect(entry.record.info["id"]).toBe("ses_a");
		expect(messageIDsOf(entry.record)).toEqual([derivedMessageID("msg_1"), derivedMessageID("msg_2")]);
		expect(messageIDsOf(entry.record)).not.toEqual(["msg_1", "msg_2"]);
		expect(plan.importOrder.length).toBe(1);
		expect(plan.importOrder[0]).toBe(entry);
	});

	test("renames a divergent same-ID session and derives all IDs", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const destination = sessionRecord("ses_a", ["msg_other"]);
		const plan = runPlan([source], [destination]);
		const entry = plan.entries[0]!;

		expect(entry.classification).toBe("renamed");
		expect(entry.targetSessionID).toBe(derivedSessionID("ses_a"));
		expect(entry.record.info["id"]).toBe(derivedSessionID("ses_a"));
		expect(messageIDsOf(entry.record)).toEqual([derivedMessageID("msg_1")]);
		expect(plan.importOrder.length).toBe(1);
	});

	test("rederives message IDs even when nothing collides", () => {
		const source = sessionRecord("ses_a", ["msg_1", "msg_2", "msg_3"]);
		const plan = runPlan([source], []);
		const ids = messageIDsOf(plan.entries[0]!.record);
		expect(ids.length).toBe(3);
		for (const id of ids) {
			expect(id.startsWith("msg_")).toBe(true);
			expect(id.length).toBe(68);
		}
		expect(ids[0]).toBe(derivedMessageID("msg_1"));
		expect(ids[1]).toBe(derivedMessageID("msg_2"));
		expect(ids[2]).toBe(derivedMessageID("msg_3"));
	});

	test("leaves a skipped exact local duplicate unchanged, including message IDs", () => {
		const source = sessionRecord("ses_a", ["msg_1", "msg_2"]);
		const plan = runPlan([source], [cloneJson(source)]);
		const entry = plan.entries[0]!;
		expect(entry.classification).toBe("skipped");
		expect(entry.skipReason).toBe("exact-local-duplicate");
		expect(entry.targetSessionID).toBe("ses_a");
		expect(messageIDsOf(entry.record)).toEqual(["msg_1", "msg_2"]);
	});

	test("fails closed when the deriver returns a wrong-shaped ID", () => {
		const badDeriver: RemappedIdDeriver = { derive: () => "nope" };
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"])], [], badDeriver), "derivation-failure");
	});

	test("wraps deriver exceptions as derivation failures", () => {
		const badDeriver: RemappedIdDeriver = {
			derive: () => {
				throw new Error("deriver exploded");
			},
		};
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"])], [], badDeriver), "derivation-failure");
	});

	test("fails closed when a derived ID does not match the exact target shape", () => {
		const wrongShapes: ReadonlyArray<readonly [string, RemappedIdDeriver]> = [
			["prefix only", { derive(namespace) { return namespace === "session" ? "ses_" : "msg_"; } }],
			["short digest", { derive(namespace) { return (namespace === "session" ? "ses_" : "msg_") + "a".repeat(63); } }],
			["long digest", { derive(namespace) { return (namespace === "session" ? "ses_" : "msg_") + "a".repeat(65); } }],
			["uppercase hex", { derive(namespace) { return (namespace === "session" ? "ses_" : "msg_") + "AB".repeat(32); } }],
			["non-hex digest", { derive(namespace) { return (namespace === "session" ? "ses_" : "msg_") + "g".repeat(64); } }],
			["trailing data", { derive(namespace) { return (namespace === "session" ? "ses_" : "msg_") + "ab".repeat(32) + "0"; } }],
		];
		for (const [, badDeriver] of wrongShapes) {
			expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"])], [], badDeriver), "derivation-failure");
		}
	});

	test("fails closed when only a derived message ID is malformed", () => {
		const badMessageDeriver: RemappedIdDeriver = {
			derive(namespace, artifactIdentity, originalID) {
				if (namespace === "message") return "msg_" + "zz".repeat(32);
				return deriver.derive(namespace, artifactIdentity, originalID);
			},
		};
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"])], [], badMessageDeriver), "derivation-failure");
	});
});

/* ------------------------------------------------------------------ */
/* Exact deterministic retry detection                                 */
/* ------------------------------------------------------------------ */

describe("exact deterministic retry detection", () => {
	test("skips an exact retry at the source session ID", () => {
		const source = sessionRecord("ses_a", ["msg_1", "msg_2"]);
		const destination = [remapForTest(source, "ses_a")];
		const plan = runPlan([source], destination);
		const entry = plan.entries[0]!;

		expect(entry.classification).toBe("skipped");
		expect(entry.skipReason).toBe("exact-planned-retry");
		expect(entry.targetSessionID).toBe("ses_a");
		expect(messageIDsOf(entry.record)).toEqual([derivedMessageID("msg_1"), derivedMessageID("msg_2")]);
		expect(plan.importOrder.length).toBe(0);
	});

	test("skips an exact retry at the derived session ID", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const divergent = sessionRecord("ses_a", ["msg_other"]);
		const destination = [divergent, remapForTest(source, derivedSessionID("ses_a"))];
		const plan = runPlan([source], destination);
		const entry = plan.entries[0]!;

		expect(entry.classification).toBe("skipped");
		expect(entry.skipReason).toBe("exact-planned-retry");
		expect(entry.targetSessionID).toBe(derivedSessionID("ses_a"));
		expect(messageIDsOf(entry.record)).toEqual([derivedMessageID("msg_1")]);
		expect(plan.importOrder.length).toBe(0);
	});

	test("does not confuse a source-identical record with a planned retry", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const plan = runPlan([source], [cloneJson(source)]);
		expect(plan.entries[0]!.skipReason).toBe("exact-local-duplicate");
	});

	test("classifies an exact child retry before its parent regardless of source order", () => {
		const parentSource = sessionRecord("ses_parent", ["msg_p"]);
		const childSource = sessionRecord("ses_child", ["msg_c"], { parentID: "ses_parent" });
		// The child's destination retry record keeps the source parent reference
		// ("ses_parent"), which only matches once the parent plan is itself
		// recognized as an exact retry at its source session ID.
		const destination = [remapForTest(childSource, "ses_child"), remapForTest(parentSource, "ses_parent")];

		const childFirst = runPlan([childSource, parentSource], destination);
		const parentFirst = runPlan([parentSource, childSource], destination);

		for (const plan of [childFirst, parentFirst]) {
			const childEntry = entryFor(plan, "ses_child");
			expect(childEntry.classification).toBe("skipped");
			expect(childEntry.skipReason).toBe("exact-planned-retry");
			expect(childEntry.targetSessionID).toBe("ses_child");
			expect(childEntry.record.info["parentID"]).toBe("ses_parent");
			expect(messageIDsOf(childEntry.record)).toEqual([derivedMessageID("msg_c")]);

			const parentEntry = entryFor(plan, "ses_parent");
			expect(parentEntry.classification).toBe("skipped");
			expect(parentEntry.skipReason).toBe("exact-planned-retry");
			expect(parentEntry.targetSessionID).toBe("ses_parent");
			expect(messageIDsOf(parentEntry.record)).toEqual([derivedMessageID("msg_p")]);

			expect(plan.importOrder.length).toBe(0);
		}
	});
});

/* ------------------------------------------------------------------ */
/* Collisions                                                          */
/* ------------------------------------------------------------------ */

describe("planned-ID collisions", () => {
	test("fails when the derived session ID exists with different data", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const divergent = sessionRecord("ses_a", ["msg_other"]);
		const occupied = sessionRecord(derivedSessionID("ses_a"), ["msg_zzz"]);
		expectCode(() => runPlan([source], [divergent, occupied]), "session-id-collision");
	});

	test("fails when two planned sessions derive the same target session ID", () => {
		const collidingDeriver: RemappedIdDeriver = {
			derive(namespace, artifactIdentity, originalID) {
				if (namespace === "session" && originalID === "ses_b") {
					return deriver.derive(namespace, artifactIdentity, "ses_a");
				}
				return deriver.derive(namespace, artifactIdentity, originalID);
			},
		};
		const sourceA = sessionRecord("ses_a", ["msg_a"]);
		const sourceB = sessionRecord("ses_b", ["msg_b"]);
		const destination = [sessionRecord("ses_a", ["msg_other_a"]), sessionRecord("ses_b", ["msg_other_b"])];
		expectCode(() => runPlan([sourceA, sourceB], destination, collidingDeriver), "session-id-collision");
	});

	test("fails when a planned message ID already exists in the destination", () => {
		const fixed = `msg_${"ab".repeat(32)}`;
		const fixedDeriver: RemappedIdDeriver = {
			derive(namespace, artifactIdentity, originalID) {
				if (namespace === "message" && originalID === "msg_1") return fixed;
				return deriver.derive(namespace, artifactIdentity, originalID);
			},
		};
		const source = sessionRecord("ses_a", ["msg_1"]);
		const destination = [sessionRecord("ses_b", [fixed])];
		expectCode(() => runPlan([source], destination, fixedDeriver), "message-id-collision");
	});

	test("fails when two planned messages derive the same target message ID", () => {
		const fixed = `msg_${"cd".repeat(32)}`;
		const fixedDeriver: RemappedIdDeriver = {
			derive(namespace, artifactIdentity, originalID) {
				if (namespace === "message") return fixed;
				return deriver.derive(namespace, artifactIdentity, originalID);
			},
		};
		const source = sessionRecord("ses_a", ["msg_1", "msg_2"]);
		expectCode(() => runPlan([source], [], fixedDeriver), "message-id-collision");
	});

	test("fails when two exact-retry sessions coalesce onto one derived target", () => {
		// The injected deriver collapses both distinct source sessions onto the
		// same derived session ID and both messages onto the same derived message
		// ID, so their transformed records become identical and each matches the
		// same destination retry record. Both would otherwise classify as
		// exact-planned-retry skips and silently coalesce; planning must reject
		// the collision before returning any entries or import order.
		const sharedSessionTarget = derivedSessionID("ses_a");
		const sharedMessageTarget = derivedMessageID("msg_a");
		const collidingDeriver: RemappedIdDeriver = {
			derive(namespace) {
				return namespace === "session" ? sharedSessionTarget : sharedMessageTarget;
			},
		};
		const sourceA = sessionRecord("ses_a", ["msg_a"]);
		const sourceB = sessionRecord("ses_b", ["msg_b"]);
		const sharedRetryRecord = {
			info: { id: sharedSessionTarget, projectID: "proj_test" },
			messages: [{ id: sharedMessageTarget, role: "user" }],
		} as unknown as SessionRecord;
		const destination = [
			sessionRecord("ses_a", ["msg_other_a"]),
			sessionRecord("ses_b", ["msg_other_b"]),
			sharedRetryRecord,
		];
		expectCode(() => runPlan([sourceA, sourceB], destination, collidingDeriver), "session-id-collision");
	});

	test("fails when a skipped session's message ID and a planned import's target coalesce", () => {
		// Final mapped message IDs must be unique across every artifact entry:
		// the exact-local skip keeps its original ID and the import rederives to
		// the same target.
		const sharedMessageTarget = `msg_${"ab".repeat(32)}`;
		const collidingDeriver: RemappedIdDeriver = {
			derive(namespace, artifactIdentity, originalID) {
				if (namespace === "message" && originalID === "msg_new") return sharedMessageTarget;
				return deriver.derive(namespace, artifactIdentity, originalID);
			},
		};
		const skipped = sessionRecord("ses_skip", [sharedMessageTarget]);
		const imported = sessionRecord("ses_new", ["msg_new"]);
		expectCode(() => runPlan([skipped, imported], [cloneJson(skipped)], collidingDeriver), "message-id-collision");
	});
});

/* ------------------------------------------------------------------ */
/* Cross-project global session inventory (2026-10-14 owner amendment) */
/* ------------------------------------------------------------------ */

describe("cross-project global session inventory", () => {
	test("treats an omitted inventory exactly like an empty one", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const omitted = runPlan([source], []);
		const empty = runPlanWithGlobal([source], [], []);
		expect(omitted).toEqual(empty);
		expect(entryFor(empty, "ses_a").classification).toBe("imported");
		expect(entryFor(empty, "ses_a").targetSessionID).toBe("ses_a");
	});

	test("leaves a non-colliding inventory entry without effect", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const plan = runPlanWithGlobal([source], [], ["ses_other"]);
		expect(entryFor(plan, "ses_a").classification).toBe("imported");
		expect(entryFor(plan, "ses_a").targetSessionID).toBe("ses_a");
	});

	test("keeps an exact local duplicate skipped when its ID also appears in the global inventory", () => {
		const source = sessionRecord("ses_a", ["msg_1", "msg_2"]);
		const plan = runPlanWithGlobal([source], [cloneJson(source)], ["ses_a"]);
		const entry = plan.entries[0]!;
		expect(entry.classification).toBe("skipped");
		expect(entry.skipReason).toBe("exact-local-duplicate");
		expect(entry.targetSessionID).toBe("ses_a");
		expect(messageIDsOf(entry.record)).toEqual(["msg_1", "msg_2"]);
		expect(plan.importOrder.length).toBe(0);
	});

	test("remaps a global-only source-ID collision with the same deterministic derivation", () => {
		const source = sessionRecord("ses_a", ["msg_1", "msg_2"]);
		const globalOnly = runPlanWithGlobal([source], [], ["ses_a"]);
		const destinationConflict = runPlan([source], [sessionRecord("ses_a", ["msg_other"])]);
		const entry = entryFor(globalOnly, "ses_a");

		expect(entry.classification).toBe("renamed");
		expect(entry.targetSessionID).toBe(derivedSessionID("ses_a"));
		expect(entry.targetSessionID).toBe(entryFor(destinationConflict, "ses_a").targetSessionID);
		expect(entry.record.info["id"]).toBe(derivedSessionID("ses_a"));
		expect(messageIDsOf(entry.record)).toEqual([derivedMessageID("msg_1"), derivedMessageID("msg_2")]);
		expect(globalOnly.importOrder.map((item) => item.sourceSessionID)).toEqual(["ses_a"]);

		// Deterministic: replanning with the same inventory derives the same IDs.
		expect(runPlanWithGlobal([source], [], ["ses_a"])).toEqual(globalOnly);
	});

	test("keeps a divergent destination conflict renamed regardless of the global inventory", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const destination = [sessionRecord("ses_a", ["msg_other"])];
		const withoutGlobal = runPlan([source], destination);
		const withGlobal = runPlanWithGlobal([source], destination, ["ses_a"]);
		expect(entryFor(withoutGlobal, "ses_a").classification).toBe("renamed");
		expect(entryFor(withGlobal, "ses_a").classification).toBe("renamed");
		expect(entryFor(withGlobal, "ses_a").targetSessionID).toBe(entryFor(withoutGlobal, "ses_a").targetSessionID);
		expect(entryFor(withGlobal, "ses_a").targetSessionID).toBe(derivedSessionID("ses_a"));
	});

	test("recognizes an exact planned retry at the derived session ID with a global-only source collision", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const destination = [remapForTest(source, derivedSessionID("ses_a"))];
		const plan = runPlanWithGlobal([source], destination, ["ses_a"]);
		const entry = entryFor(plan, "ses_a");
		expect(entry.classification).toBe("skipped");
		expect(entry.skipReason).toBe("exact-planned-retry");
		expect(entry.targetSessionID).toBe(derivedSessionID("ses_a"));
		expect(messageIDsOf(entry.record)).toEqual([derivedMessageID("msg_1")]);
		expect(plan.importOrder.length).toBe(0);
	});

	test("recognizes an exact planned retry at the source session ID when the inventory overlaps the destination", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const destination = [remapForTest(source, "ses_a")];
		const plan = runPlanWithGlobal([source], destination, ["ses_a"]);
		const entry = entryFor(plan, "ses_a");
		expect(entry.classification).toBe("skipped");
		expect(entry.skipReason).toBe("exact-planned-retry");
		expect(entry.targetSessionID).toBe("ses_a");
		expect(plan.importOrder.length).toBe(0);
	});

	test("fails closed when the derived target is occupied outside the destination", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		expectCode(
			() => runPlanWithGlobal([source], [], ["ses_a", derivedSessionID("ses_a")]),
			"session-id-collision",
		);
	});

	test("fails closed when the derived target exists in the destination with different data", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const destination = [
			sessionRecord("ses_a", ["msg_other"]),
			sessionRecord(derivedSessionID("ses_a"), ["msg_zzz"]),
		];
		expectCode(() => runPlanWithGlobal([source], destination, ["ses_a"]), "session-id-collision");
	});

	test("rewrites parent, fork boundary, and revert references for global-only collisions", () => {
		const parent = sessionRecord("ses_parent", ["msg_parent"]);
		const child = sessionRecord(
			"ses_child",
			["msg_child"],
			{
				parentID: "ses_parent",
				fork: { sessionID: "ses_parent", boundary: { type: "before", messageID: "msg_parent" } },
				revert: { messageID: "msg_child" },
			},
		);
		const plan = runPlanWithGlobal([child, parent], [], ["ses_parent"]);

		const parentEntry = entryFor(plan, "ses_parent");
		expect(parentEntry.classification).toBe("renamed");
		expect(parentEntry.targetSessionID).toBe(derivedSessionID("ses_parent"));

		const childEntry = entryFor(plan, "ses_child");
		expect(childEntry.classification).toBe("imported");
		expect(childEntry.targetSessionID).toBe("ses_child");
		const info = childEntry.record.info as unknown as Record<string, unknown>;
		expect(info["parentID"]).toBe(derivedSessionID("ses_parent"));
		const fork = info["fork"] as Record<string, unknown>;
		expect(fork["sessionID"]).toBe(derivedSessionID("ses_parent"));
		expect((fork["boundary"] as Record<string, unknown>)["messageID"]).toBe(derivedMessageID("msg_parent"));
		expect((info["revert"] as Record<string, unknown>)["messageID"]).toBe(derivedMessageID("msg_child"));
		expect(plan.importOrder.map((item) => item.sourceSessionID)).toEqual(["ses_parent", "ses_child"]);
	});

	test("never lets the global inventory satisfy a session reference", () => {
		const planned = sessionRecord("ses_child", ["msg_child"], { parentID: "ses_global_only" });
		expectCode(() => runPlanWithGlobal([planned], [], ["ses_global_only"]), "dangling-session-reference");

		const skipped = sessionRecord("ses_a", ["msg_1"], { parentID: "ses_global_only" });
		expectCode(
			() => runPlanWithGlobal([skipped], [cloneJson(skipped)], ["ses_global_only"]),
			"dangling-session-reference",
		);
	});

	test("preserves all-artifact target uniqueness across global-remapped entries", () => {
		const sharedTarget = deriver.derive("session", IDENTITY, "ses_shared");
		const collidingDeriver: RemappedIdDeriver = {
			derive(namespace, artifactIdentity, originalID) {
				if (namespace === "session" && (originalID === "ses_a" || originalID === "ses_b")) return sharedTarget;
				return deriver.derive(namespace, artifactIdentity, originalID);
			},
		};
		const sourceA = sessionRecord("ses_a", ["msg_a"]);
		const sourceB = sessionRecord("ses_b", ["msg_b"]);
		const destination = [sessionRecord("ses_b", ["msg_other_b"])];
		expectCode(
			() => runPlanWithGlobal([sourceA, sourceB], destination, ["ses_a"], collidingDeriver),
			"session-id-collision",
		);
	});

	test("rejects a malformed global inventory", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		const badInventories: readonly unknown[] = [null, "ses_a", {}, 7, [7], [null], [""], ["   "]];
		for (const bad of badInventories) {
			expectCode(
				() =>
					planRestore({
						payload: payloadOf([source]),
						artifactIdentity: IDENTITY,
						destination: [],
						globallyVisibleSessionIDs: bad as unknown as readonly string[],
						idDeriver: deriver,
					}),
				"invalid-input",
			);
		}
	});

	test("rejects duplicate IDs in the global inventory", () => {
		const source = sessionRecord("ses_a", ["msg_1"]);
		expectCode(() => runPlanWithGlobal([source], [], ["ses_a", "ses_b", "ses_a"]), "invalid-input");
	});
});

/* ------------------------------------------------------------------ */
/* Reference remapping (O-05)                                          */
/* ------------------------------------------------------------------ */

describe("reference remapping", () => {
	test("rewrites only the schema-defined reference fields", () => {
		const parent = sessionRecord("ses_parent", ["msg_parent"]);
		const child = sessionRecord(
			"ses_child",
			["msg_child"],
			{
				parentID: "ses_parent",
				fork: { sessionID: "ses_parent", boundary: { type: "before", messageID: "msg_parent" }, note: "keep-fork-note" },
				revert: { messageID: "msg_child", partID: "prt_keep" },
				snapshot: "snap_keep",
				decoy: { messageID: "msg_decoy", partID: "prt_decoy" },
			},
			[{ parentID: "msg_decoy", parts: [{ id: "prt_part" }] }],
		);
		const destination = [sessionRecord("ses_parent", ["msg_other"])];
		const plan = runPlan([parent, child], destination);

		const parentEntry = entryFor(plan, "ses_parent");
		expect(parentEntry.classification).toBe("renamed");
		const childEntry = entryFor(plan, "ses_child");
		expect(childEntry.classification).toBe("imported");

		const info = childEntry.record.info as unknown as Record<string, unknown>;
		expect(info["id"]).toBe("ses_child");
		expect(info["parentID"]).toBe(parentEntry.targetSessionID);
		expect(info["snapshot"]).toBe("snap_keep");
		const fork = info["fork"] as Record<string, unknown>;
		expect(fork["sessionID"]).toBe(parentEntry.targetSessionID);
		expect(fork["note"]).toBe("keep-fork-note");
		expect((fork["boundary"] as Record<string, unknown>)["messageID"]).toBe(derivedMessageID("msg_parent"));
		const revert = info["revert"] as Record<string, unknown>;
		expect(revert["messageID"]).toBe(derivedMessageID("msg_child"));
		expect(revert["partID"]).toBe("prt_keep");
		const decoy = info["decoy"] as Record<string, unknown>;
		expect(decoy["messageID"]).toBe("msg_decoy");
		expect(decoy["partID"]).toBe("prt_decoy");

		const message = childEntry.record.messages[0] as unknown as Record<string, unknown>;
		expect(message["id"]).toBe(derivedMessageID("msg_child"));
		expect(message["parentID"]).toBe("msg_decoy");
		expect((message["parts"] as Array<Record<string, unknown>>)[0]!["id"]).toBe("prt_part");

		expect(plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_parent", "ses_child"]);
	});

	test("maps internal references to skipped local duplicates to their unchanged IDs", () => {
		const parent = sessionRecord("ses_parent", ["msg_parent"]);
		const child = sessionRecord("ses_child", ["msg_child"], { parentID: "ses_parent" });
		const plan = runPlan([child, parent], [cloneJson(parent)]);

		expect(entryFor(plan, "ses_parent").classification).toBe("skipped");
		const info = entryFor(plan, "ses_child").record.info as unknown as Record<string, unknown>;
		expect(info["parentID"]).toBe("ses_parent");
		expect(plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_child"]);
	});

	test("maps internal references to an exact-retry session's rederived message IDs", () => {
		const parent = sessionRecord("ses_parent", ["msg_parent"]);
		const child = sessionRecord("ses_child", ["msg_child"], {
			fork: { sessionID: "ses_parent", boundary: { type: "before", messageID: "msg_parent" } },
		});
		const plan = runPlan([parent, child], [remapForTest(parent, "ses_parent")]);

		expect(entryFor(plan, "ses_parent").classification).toBe("skipped");
		const fork = entryFor(plan, "ses_child").record.info["fork"] as unknown as Record<string, unknown>;
		expect((fork["boundary"] as Record<string, unknown>)["messageID"]).toBe(derivedMessageID("msg_parent"));
		expect(plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_child"]);
	});

	test("keeps external references that resolve to destination objects", () => {
		const child = sessionRecord("ses_child", ["msg_child"], {
			parentID: "ses_local_parent",
			fork: { sessionID: "ses_local_parent", boundary: { type: "through", messageID: "msg_local" } },
		});
		const destination = [sessionRecord("ses_local_parent", ["msg_local"])];
		const plan = runPlan([child], destination);

		const info = plan.entries[0]!.record.info as unknown as Record<string, unknown>;
		expect(info["parentID"]).toBe("ses_local_parent");
		const fork = info["fork"] as Record<string, unknown>;
		expect(fork["sessionID"]).toBe("ses_local_parent");
		expect((fork["boundary"] as Record<string, unknown>)["messageID"]).toBe("msg_local");
	});

	test("rejects dangling external session references", () => {
		const child = sessionRecord("ses_child", ["msg_child"], { parentID: "ses_missing" });
		expectCode(() => runPlan([child], []), "dangling-session-reference");
	});

	test("rejects dangling external message references", () => {
		const parent = sessionRecord("ses_parent", ["msg_parent"]);
		const child = sessionRecord("ses_child", ["msg_child"], {
			fork: { sessionID: "ses_parent", boundary: { type: "before", messageID: "msg_missing" } },
		});
		expectCode(() => runPlan([child, parent], []), "dangling-message-reference");

		const revertChild = sessionRecord("ses_child2", ["msg_child"], { revert: { messageID: "msg_missing" } });
		expectCode(() => runPlan([revertChild], []), "dangling-message-reference");
	});

	test("rejects dangling references in an exact-local skipped record", () => {
		const danglingSession = sessionRecord("ses_a", ["msg_1"], { parentID: "ses_missing" });
		expectCode(() => runPlan([danglingSession], [cloneJson(danglingSession)]), "dangling-session-reference");

		const danglingForkSession = sessionRecord("ses_a", ["msg_1"], {
			fork: { sessionID: "ses_missing", boundary: { type: "before", messageID: "msg_1" } },
		});
		expectCode(() => runPlan([danglingForkSession], [cloneJson(danglingForkSession)]), "dangling-session-reference");

		const danglingForkBoundary = sessionRecord("ses_a", ["msg_1"], {
			fork: { sessionID: "ses_a", boundary: { type: "before", messageID: "msg_missing" } },
		});
		expectCode(() => runPlan([danglingForkBoundary], [cloneJson(danglingForkBoundary)]), "dangling-message-reference");

		const danglingRevert = sessionRecord("ses_a", ["msg_1"], { revert: { messageID: "msg_missing" } });
		expectCode(() => runPlan([danglingRevert], [cloneJson(danglingRevert)]), "dangling-message-reference");
	});

	test("rejects an unchanged skipped record's internal reference to a rederived message", () => {
		const imported = sessionRecord("ses_b", ["msg_b"]);
		const skipped = sessionRecord("ses_a", ["msg_1"], { revert: { messageID: "msg_b" } });
		expectCode(() => runPlan([skipped, imported], [cloneJson(skipped)]), "dangling-message-reference");
	});

	test("accepts an unchanged skipped record's reference to an artifact session kept at the same id", () => {
		const parent = sessionRecord("ses_parent", ["msg_parent"]);
		const skipped = sessionRecord("ses_a", ["msg_1"], { parentID: "ses_parent" });
		const plan = runPlan([skipped, parent], [cloneJson(skipped)]);

		const skippedEntry = entryFor(plan, "ses_a");
		expect(skippedEntry.classification).toBe("skipped");
		expect(skippedEntry.skipReason).toBe("exact-local-duplicate");
		expect(skippedEntry.record.info["parentID"]).toBe("ses_parent");
		expect(entryFor(plan, "ses_parent").targetSessionID).toBe("ses_parent");
	});

	test("accepts an unchanged skipped record's reference that already exists in the destination", () => {
		const localParent = sessionRecord("ses_parent", ["msg_local"]);
		const sourceParent = sessionRecord("ses_parent", ["msg_parent"]);
		const skipped = sessionRecord("ses_a", ["msg_1"], { parentID: "ses_parent" });
		const plan = runPlan([skipped, sourceParent], [cloneJson(skipped), localParent]);

		expect(entryFor(plan, "ses_a").classification).toBe("skipped");
		expect(entryFor(plan, "ses_parent").classification).toBe("renamed");
	});
});

/* ------------------------------------------------------------------ */
/* Import order                                                        */
/* ------------------------------------------------------------------ */

describe("import order", () => {
	test("orders imported parents before children even when children come first", () => {
		const parent = sessionRecord("ses_parent", ["msg_p"]);
		const child = sessionRecord("ses_child", ["msg_c"], { parentID: "ses_parent" });
		const plan = runPlan([child, parent], []);
		expect(plan.entries.map((entry) => entry.sourceSessionID)).toEqual(["ses_child", "ses_parent"]);
		expect(plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_parent", "ses_child"]);
	});

	test("orders fork sources before forks", () => {
		const origin = sessionRecord("ses_origin", ["msg_o"]);
		const forked = sessionRecord("ses_fork", ["msg_f"], {
			fork: { sessionID: "ses_origin", boundary: { type: "before", messageID: "msg_o" } },
		});
		const plan = runPlan([forked, origin], []);
		expect(plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_origin", "ses_fork"]);
	});

	test("orders a cross-session message reference source before the referrer", () => {
		const source = sessionRecord("ses_source", ["msg_s"]);
		const referrer = sessionRecord("ses_ref", ["msg_r"], { revert: { messageID: "msg_s" } });
		const plan = runPlan([referrer, source], []);
		expect(plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_source", "ses_ref"]);
	});

	test("keeps deterministic source order for independent sessions", () => {
		const plan = runPlan(
			[sessionRecord("ses_a", ["msg_a"]), sessionRecord("ses_b", ["msg_b"]), sessionRecord("ses_c", ["msg_c"])],
			[],
		);
		expect(plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_a", "ses_b", "ses_c"]);
	});

	test("rejects reference cycles instead of emitting an unsafe order", () => {
		const a = sessionRecord("ses_a", ["msg_a"], { parentID: "ses_b" });
		const b = sessionRecord("ses_b", ["msg_b"], { parentID: "ses_a" });
		expectCode(() => runPlan([a, b], []), "dependency-cycle");
	});

	test("rejects a fork cycle", () => {
		const a = sessionRecord("ses_a", ["msg_a"], {
			fork: { sessionID: "ses_b", boundary: { type: "before", messageID: "msg_b" } },
		});
		const b = sessionRecord("ses_b", ["msg_b"], {
			fork: { sessionID: "ses_a", boundary: { type: "through", messageID: "msg_a" } },
		});
		expectCode(() => runPlan([a, b], []), "dependency-cycle");
	});

	test("rejects a session that references itself as its own parent", () => {
		const a = sessionRecord("ses_a", ["msg_a"], { parentID: "ses_a" });
		expectCode(() => runPlan([a], []), "dependency-cycle");
	});
});

/* ------------------------------------------------------------------ */
/* Input handling                                                      */
/* ------------------------------------------------------------------ */

describe("input handling", () => {
	test("does not mutate caller inputs", () => {
		const payload = payloadOf([sessionRecord("ses_a", ["msg_1"], { nested: { list: [1, 2, 3] } })]);
		const destination = [sessionRecord("ses_b", ["msg_2"])];
		const before = JSON.stringify({ payload, destination });
		planRestore({ payload, artifactIdentity: IDENTITY, destination, idDeriver: deriver });
		expect(JSON.stringify({ payload, destination })).toBe(before);
	});

	test("isolates a mutating deriver from the caller's identity and later derivations", () => {
		const identity = Uint8Array.from(IDENTITY);
		const originalIdentity = Uint8Array.from(identity);
		const observed: Uint8Array[] = [];
		const mutatingDeriver: RemappedIdDeriver = {
			derive(namespace, artifactIdentity, originalID) {
				const result = deriver.derive(namespace, artifactIdentity, originalID);
				observed.push(Uint8Array.from(artifactIdentity));
				// Wipe the buffer this call received; it must be a private copy.
				artifactIdentity.fill(0xff);
				return result;
			},
		};
		const source = sessionRecord("ses_a", ["msg_1", "msg_2"]);
		const destination = [sessionRecord("ses_a", ["msg_other"])];
		const plan = planRestore({
			payload: payloadOf([source]),
			artifactIdentity: identity,
			destination,
			idDeriver: mutatingDeriver,
		});

		// The caller's identity bytes are untouched.
		expect(identity).toEqual(originalIdentity);
		// Every derive call observed the original identity bytes (1 session + 2 messages).
		expect(observed.length).toBe(3);
		for (const seen of observed) expect(seen).toEqual(originalIdentity);
		// Results are the derivations of the original bytes.
		const entry = plan.entries[0]!;
		expect(entry.classification).toBe("renamed");
		expect(entry.targetSessionID).toBe(derivedSessionID("ses_a"));
		expect(messageIDsOf(entry.record)).toEqual([derivedMessageID("msg_1"), derivedMessageID("msg_2")]);
	});

	test("works on deeply frozen inputs without mutating them", () => {
		const payload = payloadOf([sessionRecord("ses_a", ["msg_1"], { nested: { list: [1, 2] } })]);
		const destination = [sessionRecord("ses_b", ["msg_2"], { other: { value: null } })];
		deepFreeze(payload);
		deepFreeze(destination);
		const plan = planRestore({ payload, artifactIdentity: IDENTITY, destination, idDeriver: deriver });
		expect(plan.entries[0]!.classification).toBe("imported");
	});

	test("rejects a non-object payload", () => {
		expectCode(
			() =>
				planRestore({
					payload: null as unknown as CheckpointPayload,
					artifactIdentity: IDENTITY,
					destination: [],
					idDeriver: deriver,
				}),
			"malformed-payload",
		);
	});

	test("rejects payload.sessions that is not an array", () => {
		expectCode(
			() =>
				planRestore({
					payload: { sessions: {} } as unknown as CheckpointPayload,
					artifactIdentity: IDENTITY,
					destination: [],
					idDeriver: deriver,
				}),
			"malformed-payload",
		);
	});

	test("rejects an unsupported top-level payload key instead of ignoring it", () => {
		const payload = {
			sessions: [sessionRecord("ses_a", ["msg_1"])],
			extra: { unsupported: true },
		} as unknown as CheckpointPayload;
		expectCode(
			() => planRestore({ payload, artifactIdentity: IDENTITY, destination: [], idDeriver: deriver }),
			"malformed-payload",
		);
	});

	test("rejects a session without a valid structure or session ID", () => {
		expectCode(() => runPlan([{ messages: [] } as unknown as SessionRecord], []), "malformed-payload");
		expectCode(() => runPlan([{ info: {}, messages: [] } as unknown as SessionRecord], []), "malformed-payload");
		expectCode(() => runPlan([{ info: { id: "abc" }, messages: [] } as unknown as SessionRecord], []), "malformed-payload");
		expectCode(() => runPlan([{ info: { id: 5 }, messages: [] } as unknown as SessionRecord], []), "malformed-payload");
		expectCode(() => runPlan([{ info: { id: "ses_a" }, messages: {} } as unknown as SessionRecord], []), "malformed-payload");
	});

	test("rejects a message without a valid msg_ ID", () => {
		expectCode(() => runPlan([{ info: { id: "ses_a" }, messages: [{}] } as unknown as SessionRecord], []), "malformed-payload");
		expectCode(() => runPlan([{ info: { id: "ses_a" }, messages: [{ id: "msg1" }] } as unknown as SessionRecord], []), "malformed-payload");
	});

	test("rejects present non-string schema references", () => {
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"], { parentID: null })], []), "malformed-payload");
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"], { fork: "nope" })], []), "malformed-payload");
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"], { revert: { messageID: 7 } })], []), "malformed-payload");
	});

	test("rejects unsupported top-level keys on a session record", () => {
		const extraOnPayload = { info: { id: "ses_a" }, messages: [], extra: true } as unknown as SessionRecord;
		expectCode(() => runPlan([extraOnPayload], []), "malformed-payload");

		const extraOnDestination = { info: { id: "ses_b" }, messages: [], extra: true } as unknown as SessionRecord;
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"])], [extraOnDestination]), "malformed-destination");
	});

	test("rejects malformed fork and revert nested shapes", () => {
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"], { fork: {} })], []), "malformed-payload");
		expectCode(
			() => runPlan([sessionRecord("ses_a", ["msg_1"], { fork: { sessionID: "ses_parent" } })], []),
			"malformed-payload",
		);
		expectCode(
			() => runPlan([sessionRecord("ses_a", ["msg_1"], { fork: { sessionID: "ses_parent", boundary: null } })], []),
			"malformed-payload",
		);
		expectCode(
			() => runPlan([sessionRecord("ses_a", ["msg_1"], { fork: { sessionID: "ses_parent", boundary: {} } })], []),
			"malformed-payload",
		);
		expectCode(
			() =>
				runPlan(
					[
						sessionRecord("ses_a", ["msg_1"], {
							fork: { sessionID: "ses_parent", boundary: { type: "sideways", messageID: "msg_1" } },
						}),
					],
					[],
				),
			"malformed-payload",
		);
		expectCode(
			() =>
				runPlan(
					[sessionRecord("ses_a", ["msg_1"], { fork: { sessionID: "ses_parent", boundary: { type: "before" } } })],
					[],
				),
			"malformed-payload",
		);
		expectCode(
			() =>
				runPlan(
					[
						sessionRecord("ses_a", ["msg_1"], {
							fork: { sessionID: "ses_parent", boundary: { type: "before", messageID: 7 } },
						}),
					],
					[],
				),
			"malformed-payload",
		);
		expectCode(
			() =>
				runPlan(
					[
						sessionRecord("ses_a", ["msg_1"], {
							fork: { sessionID: 7, boundary: { type: "before", messageID: "msg_1" } },
						}),
					],
					[],
				),
			"malformed-payload",
		);
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"], { revert: {} })], []), "malformed-payload");
	});

	test("accepts both schema boundary types", () => {
		for (const type of ["before", "through"] as const) {
			const parent = sessionRecord("ses_parent", ["msg_parent"]);
			const forked = sessionRecord("ses_a", ["msg_1"], {
				fork: { sessionID: "ses_parent", boundary: { type, messageID: "msg_parent" } },
			});
			const plan = runPlan([forked, parent], []);
			expect(entryFor(plan, "ses_a").classification).toBe("imported");
		}
	});

	test("rejects references with the wrong schema prefix", () => {
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"], { parentID: "msg_1" })], []), "malformed-payload");
		expectCode(
			() =>
				runPlan(
					[
						sessionRecord("ses_a", ["msg_1"], {
							fork: { sessionID: "msg_1", boundary: { type: "before", messageID: "msg_1" } },
						}),
					],
					[],
				),
			"malformed-payload",
		);
		expectCode(
			() =>
				runPlan(
					[
						sessionRecord("ses_a", ["msg_1"], {
							fork: { sessionID: "ses_parent", boundary: { type: "before", messageID: "ses_parent" } },
						}),
					],
					[],
				),
			"malformed-payload",
		);
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"], { revert: { messageID: "ses_parent" } })], []), "malformed-payload");
	});

	test("rejects non-JSON values instead of silently dropping them", () => {
		const withUndefined = { info: { id: "ses_a" }, messages: [{ id: "msg_1", opaque: undefined }] } as unknown as SessionRecord;
		expectCode(() => runPlan([withUndefined], []), "malformed-payload");

		class NotJson {}
		const withInstance = { info: { id: "ses_a" }, messages: [{ id: "msg_1", opaque: new NotJson() }] } as unknown as SessionRecord;
		expectCode(() => runPlan([withInstance], []), "malformed-payload");
	});

	test("rejects a malformed destination record", () => {
		expectCode(
			() => runPlan([sessionRecord("ses_a", ["msg_1"])], [{ info: { id: 5 }, messages: [] } as unknown as SessionRecord]),
			"malformed-destination",
		);
	});

	test("rejects a destination that is not an array", () => {
		expectCode(
			() =>
				planRestore({
					payload: payloadOf([sessionRecord("ses_a", ["msg_1"])]),
					artifactIdentity: IDENTITY,
					destination: {} as unknown as SessionRecord[],
					idDeriver: deriver,
				}),
			"invalid-input",
		);
	});

	test("rejects an invalid artifact identity", () => {
		expectCode(() => runPlan([sessionRecord("ses_a", ["msg_1"])], [], deriver, new Uint8Array(15)), "invalid-input");
	});

	test("rejects a missing deriver", () => {
		expectCode(
			() =>
				planRestore({
					payload: payloadOf([sessionRecord("ses_a", ["msg_1"])]),
					artifactIdentity: IDENTITY,
					destination: [],
					idDeriver: {} as unknown as RemappedIdDeriver,
				}),
			"invalid-input",
		);
	});

	test("errors do not echo complete records", () => {
		const distinctive = "distinctive-record-content-4f8a2c";
		const first = sessionRecord("ses_a", ["msg_1"], { marker: distinctive });
		const second = sessionRecord("ses_a", ["msg_1"], { marker: distinctive, changed: true });

		let caught: unknown;
		try {
			runPlan([first, second], []);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(RestorePlanError);
		expect((caught as Error).message).not.toContain(distinctive);
	});
});

/* ------------------------------------------------------------------ */
/* Determinism and the real deriver                                    */
/* ------------------------------------------------------------------ */

describe("determinism", () => {
	test("planning is deterministic and never regenerates IDs", () => {
		const sessions = [sessionRecord("ses_a", ["msg_1"]), sessionRecord("ses_b", ["msg_2"])];
		const destination = [sessionRecord("ses_a", ["msg_other"])];
		const first = runPlan(sessions, destination);
		const second = runPlan(sessions, destination);

		expect(first).toEqual(second);
		expect(entryFor(first, "ses_b").targetSessionID).toBe("ses_b");
		expect(entryFor(first, "ses_a").targetSessionID).toBe(derivedSessionID("ses_a"));
		expect(first.collapsedDuplicateCount).toBe(0);
	});

	test("works with the real provisional BLAKE2b deriver", async () => {
		const realDeriver = await createRemappedIdDeriver();
		const identity = Uint8Array.from({ length: ARTIFACT_IDENTITY_BYTES }, (_, index) => 0xa0 + index);
		const source = sessionRecord("ses_real", ["msg_real"]);
		const plan = planRestore({
			payload: payloadOf([source]),
			artifactIdentity: identity,
			destination: [],
			idDeriver: realDeriver,
		});

		const entry = plan.entries[0]!;
		expect(entry.classification).toBe("imported");
		expect(entry.targetSessionID).toBe("ses_real");
		const messageID = entry.record.messages[0]!["id"] as string;
		expect(messageID).toBe(realDeriver.derive("message", identity, "msg_real"));
		expect(messageID.length).toBe(68);
	});
});
