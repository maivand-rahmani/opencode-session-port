/**
 * Focused tests for the pure verified-replacement policy (`replacement.ts`).
 *
 * All records are synthetic. No host, file, network, Git, LLM, tool, or crypto
 * container is used. The tests pin:
 * - standalone preparation removes ONLY info.parentID/fork/revert;
 * - stable complete-record SHA-256 fingerprints (sorted keys, array order,
 *   absent-vs-null);
 * - fail-closed classification (copy, never delete) for references, children,
 *   incoming references, unsettled/pending messages, running tools, missing or
 *   malformed inventories, unknown refs, and missing explicit authorization;
 * - strict imported-record verification with only the observed host
 *   normalizations allowed.
 */
import { describe, expect, test } from "bun:test";
import {
	classifyReplacement,
	fingerprintSessionRecord,
	prepareStandaloneRecord,
	ReplacementPolicyError,
	verifyImportedRecord,
	type JsonObject,
	type SessionRecord,
} from "../../../src/core/restore/replacement.ts";

const SOURCE_ID = "ses_source";
const TARGET_ID = "ses_target";

function userMessage(id: string, text = `text-${id}`, created = 1000): JsonObject {
	return { id, type: "user", text, time: { created } };
}

function assistantMessage(
	id: string,
	content: readonly JsonObject[] = [{ type: "text", text: "done" }],
	overrides: Record<string, unknown> = {},
): JsonObject {
	return {
		id,
		type: "assistant",
		agent: "agent",
		model: { id: "model", providerID: "provider" },
		content,
		time: { created: 1000, completed: 1100 },
		...overrides,
	};
}

function record(
	id: string,
	messages: readonly JsonObject[] = [userMessage("msg_1")],
	info: Record<string, unknown> = {},
): SessionRecord {
	return {
		info: {
			id,
			projectID: "source-project",
			title: `Title ${id}`,
			time: { created: 1000, updated: 2000, idle: 2000 },
			location: { directory: "/source/project" },
			...info,
		},
		messages,
	};
}

function inventoryOf(...sessions: readonly SessionRecord[]): JsonObject[] {
	return sessions.map((session) => session.info);
}

function classify(
	source: SessionRecord,
	target: SessionRecord | undefined,
	inventory: readonly JsonObject[] | undefined,
	options: { readonly authorizedTargetID?: string; readonly inventoryComplete?: boolean } = {},
) {
	return classifyReplacement({
		source,
		target: target as SessionRecord,
		authorizedTargetID: options.authorizedTargetID ?? TARGET_ID,
		referenceInventory: inventory as JsonObject[],
		inventoryComplete: options.inventoryComplete ?? true,
	});
}

const plainSource = record(SOURCE_ID);
const plainTarget = record(TARGET_ID);
const plainInventory = inventoryOf(plainSource, plainTarget);

describe("prepareStandaloneRecord", () => {
	test("removes only info.parentID/fork/revert and preserves full messages/tool parts", () => {
		const toolPart: JsonObject = {
			type: "tool",
			id: "tool_1",
			name: "read",
			state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "ok" }] },
			time: { created: 1000, ran: 1010, completed: 1020 },
		};
		const source = record(
			SOURCE_ID,
			[userMessage("msg_1"), assistantMessage("msg_2", [toolPart])],
			{
				parentID: "ses_parent",
				fork: { sessionID: "ses_fork", boundary: { type: "through", messageID: "msg_boundary" } },
				revert: { messageID: "msg_revert", partID: "part_1", snapshot: "snap_1" },
				opaque: { nested: { reference: "ses_looking-but-opaque" } },
			},
		);
		const before = JSON.parse(JSON.stringify(source)) as unknown;

		const prepared = prepareStandaloneRecord(source);

		expect(prepared.info["parentID"]).toBeUndefined();
		expect(prepared.info["fork"]).toBeUndefined();
		expect(prepared.info["revert"]).toBeUndefined();
		expect(prepared.info["opaque"]).toEqual({ nested: { reference: "ses_looking-but-opaque" } });
		expect(prepared.messages).toEqual(source.messages);
		expect(source).toEqual(before);
		expect(prepared).not.toBe(source);
		expect(prepared.info).not.toBe(source.info);
		expect(prepared.messages).not.toBe(source.messages);
	});

	test("accepts absent and null root references and preserves other fields", () => {
		const prepared = prepareStandaloneRecord(
			record(SOURCE_ID, [userMessage("msg_1")], { parentID: null, fork: null, revert: null }),
		);
		expect(prepared.info["parentID"]).toBeUndefined();
		expect(prepared.info["fork"]).toBeUndefined();
		expect(prepared.info["revert"]).toBeUndefined();
		expect(prepared.info["title"]).toBe(`Title ${SOURCE_ID}`);
	});

	test("rejects a malformed schema reference with a fixed redacted error", () => {
		const malformed = record(SOURCE_ID, [], {
			fork: { sessionID: "ses_fork", boundary: { type: "sideways", messageID: "msg_1" } },
		});
		let caught: unknown;
		try {
			prepareStandaloneRecord(malformed);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ReplacementPolicyError);
		expect((caught as ReplacementPolicyError).code).toBe("unsupported-reference");
		expect((caught as Error).message).toBe("SessionPort replacement policy rejected the input");
		expect((caught as Error).message).not.toContain(SOURCE_ID);
		expect((caught as Error).message).not.toContain("sideways");
	});

	test("rejects non-JSON records without executing getters", () => {
		let getterCalls = 0;
		const hostile = {
			info: {
				id: SOURCE_ID,
				get projectID() {
					getterCalls += 1;
					return "source-project";
				},
			},
			messages: [],
		};
		expect(() => prepareStandaloneRecord(hostile as unknown as SessionRecord)).toThrow(ReplacementPolicyError);
		expect(getterCalls).toBe(0);
	});
});

describe("fingerprintSessionRecord", () => {
	test("is a stable lowercase SHA-256 over canonical complete JSON", () => {
		expect(fingerprintSessionRecord({ info: { id: "ses_a" }, messages: [] })).toBe(
			"8d56a4b0bfbb0d6ecee1b2e0b74ae1788d44a845f6df6d26e76a07f4ec33d1cb",
		);
	});

	test("sorts object keys but preserves array order and null-vs-absent", () => {
		const left: SessionRecord = {
			info: { id: SOURCE_ID, metadata: { b: 2, a: 1 } },
			messages: [userMessage("msg_1"), userMessage("msg_2")],
		};
		const same: SessionRecord = {
			info: { metadata: { a: 1, b: 2 }, id: SOURCE_ID },
			messages: [userMessage("msg_1"), userMessage("msg_2")],
		};
		const reordered: SessionRecord = {
			info: { id: SOURCE_ID, metadata: { b: 2, a: 1 } },
			messages: [userMessage("msg_2"), userMessage("msg_1")],
		};
		const nullValue: SessionRecord = {
			info: { id: SOURCE_ID, metadata: { a: null } },
			messages: [userMessage("msg_1"), userMessage("msg_2")],
		};
		const absentValue: SessionRecord = {
			info: { id: SOURCE_ID, metadata: {} },
			messages: [userMessage("msg_1"), userMessage("msg_2")],
		};

		expect(fingerprintSessionRecord(left)).toBe(fingerprintSessionRecord(same));
		expect(fingerprintSessionRecord(left)).not.toBe(fingerprintSessionRecord(reordered));
		expect(fingerprintSessionRecord(nullValue)).not.toBe(fingerprintSessionRecord(absentValue));
	});

	test("does not mutate the source record", () => {
		const source = record(SOURCE_ID, [userMessage("msg_1")]);
		const before = JSON.parse(JSON.stringify(source)) as unknown;
		fingerprintSessionRecord(source);
		expect(source).toEqual(before);
	});
});

describe("classifyReplacement", () => {
	test("replace is eligible for settled standalone source/target with complete inventory", () => {
		expect(classify(plainSource, plainTarget, plainInventory)).toEqual({ mode: "replace" });
	});

	test("does not require source ID to equal the explicitly confirmed target ID", () => {
		expect(classify(record("ses_other"), plainTarget, inventoryOf(record("ses_other"), plainTarget))).toEqual({
			mode: "replace",
		});
	});

	test("missing, empty, or mismatched authorization copies", () => {
		expect(classify(plainSource, plainTarget, plainInventory, { authorizedTargetID: "" })).toEqual({
			mode: "copy",
			reason: "target-not-authorized",
		});
		expect(classify(plainSource, plainTarget, plainInventory, { authorizedTargetID: "ses_other" })).toEqual({
			mode: "copy",
			reason: "target-not-authorized",
		});
	});

	test("source fork/revert references copy even when the target is plain", () => {
		const forked = record(SOURCE_ID, [userMessage("msg_1")], {
			fork: { sessionID: "ses_ancestor", boundary: { type: "before", messageID: "msg_ancestor" } },
		});
		expect(classify(forked, plainTarget, inventoryOf(forked, plainTarget, record("ses_ancestor")))).toEqual({
			mode: "copy",
			reason: "source-has-references",
		});

		const reverted = record(SOURCE_ID, [userMessage("msg_1")], { revert: { messageID: "msg_1" } });
		expect(classify(reverted, plainTarget, inventoryOf(reverted, plainTarget))).toEqual({
			mode: "copy",
			reason: "source-has-references",
		});
	});

	test("target references copy", () => {
		const targetWithParent = record(TARGET_ID, [userMessage("msg_1")], { parentID: "ses_parent" });
		expect(classify(plainSource, targetWithParent, inventoryOf(plainSource, targetWithParent, record("ses_parent")))).toEqual({
			mode: "copy",
			reason: "target-has-references",
		});

		const targetWithFork = record(TARGET_ID, [userMessage("msg_1")], {
			fork: { sessionID: "ses_ancestor", boundary: { type: "before", messageID: "msg_ancestor" } },
		});
		expect(
			classify(plainSource, targetWithFork, inventoryOf(plainSource, targetWithFork, record("ses_ancestor"))),
		).toEqual({
			mode: "copy",
			reason: "target-has-references",
		});
	});

	test("source children and incoming fork/revert references copy", () => {
		const child = record("ses_child", [], { parentID: SOURCE_ID });
		expect(classify(plainSource, plainTarget, inventoryOf(plainSource, plainTarget, child))).toEqual({
			mode: "copy",
			reason: "source-has-children",
		});

		const targetChild = record("ses_child", [], { parentID: TARGET_ID });
		expect(classify(plainSource, plainTarget, inventoryOf(plainSource, plainTarget, targetChild))).toEqual({
			mode: "copy",
			reason: "target-has-incoming-references",
		});

		const incomingFork = record("ses_child", [], {
			fork: { sessionID: SOURCE_ID, boundary: { type: "through", messageID: "msg_1" } },
		});
		expect(classify(plainSource, plainTarget, inventoryOf(plainSource, plainTarget, incomingFork))).toEqual({
			mode: "copy",
			reason: "source-has-incoming-references",
		});

		// Artifact-payload closure: a referenced ancestor passed in the combined
		// inventory references the source; the delete would dangle that fork.
		const artifactAncestor = record("ses_ancestor", [], {
			fork: { sessionID: SOURCE_ID, boundary: { type: "before", messageID: "msg_1" } },
		});
		expect(classify(plainSource, plainTarget, inventoryOf(plainSource, plainTarget, artifactAncestor))).toEqual({
			mode: "copy",
			reason: "source-has-incoming-references",
		});

		const targetWithUniqueMessage = record(TARGET_ID, [userMessage("msg_target")]);
		const targetMessageRef = record("ses_child", [], { revert: { messageID: "msg_target" } });
		expect(
			classify(plainSource, targetWithUniqueMessage, inventoryOf(plainSource, targetWithUniqueMessage, targetMessageRef)),
		).toEqual({
			mode: "copy",
			reason: "target-has-incoming-references",
		});
	});

	test("pending or running-tool source/target messages copy", () => {
		const pending = record(SOURCE_ID, [
			{ id: "msg_pending", type: "assistant", agent: "agent", model: { id: "m", providerID: "p" }, content: [], time: { created: 1 } },
		]);
		expect(classify(pending, plainTarget, inventoryOf(pending, plainTarget))).toEqual({
			mode: "copy",
			reason: "source-unsettled",
		});

		const targetPending = record(TARGET_ID, [
			{ id: "msg_running", type: "shell", status: "running", time: { created: 1 } },
		]);
		expect(classify(plainSource, targetPending, inventoryOf(plainSource, targetPending))).toEqual({
			mode: "copy",
			reason: "target-unsettled",
		});

		const runningTool = record(SOURCE_ID, [
			assistantMessage("msg_tool", [
				{ type: "tool", id: "tool_1", name: "read", state: { status: "running" }, time: { created: 1 } },
			]),
		]);
		expect(classify(runningTool, plainTarget, inventoryOf(runningTool, plainTarget))).toEqual({
			mode: "copy",
			reason: "source-unsupported-tool",
		});
	});

	test("missing, incomplete, malformed, duplicate, and unknown-ref inventories copy", () => {
		expect(classify(plainSource, plainTarget, undefined)).toEqual({ mode: "copy", reason: "inventory-missing" });
		expect(classify(plainSource, plainTarget, plainInventory, { inventoryComplete: false })).toEqual({
			mode: "copy",
			reason: "inventory-incomplete",
		});
		expect(classify(plainSource, plainTarget, plainInventory.slice(0, 1))).toEqual({
			mode: "copy",
			reason: "inventory-incomplete",
		});
		expect(classify(plainSource, plainTarget, [plainSource.info, plainTarget.info, { id: "ses_bad", fork: {} }])).toEqual({
			mode: "copy",
			reason: "inventory-malformed",
		});
		// Identical duplicates from the destination/artifact combination are
		// collapsed; conflicting duplicates are ambiguous and copy.
		expect(classify(plainSource, plainTarget, [plainSource.info, plainTarget.info, plainTarget.info])).toEqual({
			mode: "replace",
		});
		expect(
			classify(plainSource, plainTarget, [
				plainSource.info,
				plainTarget.info,
				{ ...plainTarget.info, title: "conflicting duplicate" },
			]),
		).toEqual({
			mode: "copy",
			reason: "inventory-malformed",
		});
		expect(
			classify(plainSource, plainTarget, [
				plainSource.info,
				plainTarget.info,
				{ id: "ses_orphan", parentID: "ses_missing" },
			]),
		).toEqual({ mode: "copy", reason: "inventory-unknown-reference" });
	});

	test("does not mutate source, target, or inventory", () => {
		const source = record(SOURCE_ID, [userMessage("msg_1")]);
		const target = record(TARGET_ID, [userMessage("msg_1")]);
		const inventory = inventoryOf(source, target);
		const before = JSON.parse(JSON.stringify({ source, target, inventory })) as unknown;
		classify(source, target, inventory);
		expect(JSON.parse(JSON.stringify({ source, target, inventory }))).toEqual(before);
	});
});

describe("verifyImportedRecord", () => {
	function expectedRecord(): SessionRecord {
		const withRefs = record(
			SOURCE_ID,
			[
				userMessage("msg_1", "hello"),
				assistantMessage("msg_2", [
					{
						type: "tool",
						id: "tool_1",
						name: "read",
						state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "ok" }] },
						time: { created: 1000, ran: 1010, completed: 1020 },
					},
				]),
			],
			{
				parentID: "ses_parent",
				fork: { sessionID: "ses_fork", boundary: { type: "before", messageID: "msg_fork" } },
				revert: { messageID: "msg_2" },
			},
		);
		return prepareStandaloneRecord(withRefs);
	}

	function actualRecord(expected: SessionRecord, overrides: Record<string, unknown> = {}, root = true): SessionRecord {
		const actual: SessionRecord = {
			info: {
				...expected.info,
				projectID: "canonical-project",
				location: { directory: "C:\\Target\\Project\\" },
				time: { ...(expected.info["time"] as JsonObject), updated: 1500 },
				...(root ? { parentID: null, fork: null, revert: null } : {}),
			},
			messages: JSON.parse(JSON.stringify(expected.messages)) as JsonObject[],
		};
		return {
			info: { ...actual.info, ...overrides },
			messages: actual.messages,
		};
	}

	function verify(expected: SessionRecord, actual: SessionRecord) {
		return verifyImportedRecord({
			expected,
			actual,
			canonicalProjectID: "canonical-project",
			locationDirectory: "c:/target/project",
			importStartedAt: 1400,
			importFinishedAt: 1600,
		});
	}

	test("accepts only the observed host normalizations", () => {
		const expected = expectedRecord();
		expect(verify(expected, actualRecord(expected))).toEqual({ verified: true });
		expect(verify(expected, actualRecord(expected, {}, false))).toEqual({ verified: true });
	});

	test("rejects wrong message content, tools, order, extra, missing, and IDs", () => {
		const expected = expectedRecord();
		const wrongContent = actualRecord(expected);
		wrongContent.messages[0] = { ...wrongContent.messages[0]!, text: "tampered" };
		expect(verify(expected, wrongContent)).toEqual({ verified: false, reason: "message-mismatch" });

		const wrongTool = actualRecord(expected);
		const assistant = wrongTool.messages[1]!;
		const content = assistant["content"] as JsonObject[];
		wrongTool.messages[1] = {
			...assistant,
			content: [{ ...content[0]!, state: { status: "error" } }],
		};
		expect(verify(expected, wrongTool)).toEqual({ verified: false, reason: "message-mismatch" });

		const reordered = actualRecord(expected);
		reordered.messages = [reordered.messages[1]!, reordered.messages[0]!];
		expect(verify(expected, reordered)).toEqual({ verified: false, reason: "message-id" });

		const extra = actualRecord(expected);
		extra.messages[0] = { ...extra.messages[0]!, extra: true };
		expect(verify(expected, extra)).toEqual({ verified: false, reason: "message-mismatch" });

		const missing = actualRecord(expected);
		const first = missing.messages[0]!;
		const { text: _removed, ...withoutText } = first;
		missing.messages[0] = withoutText;
		expect(verify(expected, missing)).toEqual({ verified: false, reason: "message-mismatch" });

		const wrongID = actualRecord(expected);
		wrongID.messages[0] = { ...wrongID.messages[0]!, id: "msg_other" };
		expect(verify(expected, wrongID)).toEqual({ verified: false, reason: "message-id" });
	});

	test("rejects wrong time, project, parent candidate ref, title, idle, fields, and location", () => {
		const expected = expectedRecord();

		const wrongCreated = actualRecord(expected);
		wrongCreated.info = { ...wrongCreated.info, time: { ...(wrongCreated.info["time"] as JsonObject), created: 999 } };
		expect(verify(expected, wrongCreated)).toEqual({ verified: false, reason: "session-created" });

		const outsideWindow = actualRecord(expected);
		outsideWindow.info = { ...outsideWindow.info, time: { ...(outsideWindow.info["time"] as JsonObject), updated: 1601 } };
		expect(verify(expected, outsideWindow)).toEqual({ verified: false, reason: "session-updated-window" });

		const wrongProject = actualRecord(expected, { projectID: "other-project" });
		expect(verify(expected, wrongProject)).toEqual({ verified: false, reason: "session-project" });

		const candidateParent = actualRecord(expected, { parentID: "ses_candidate" });
		expect(verify(expected, candidateParent)).toEqual({ verified: false, reason: "session-reference" });

		const wrongTitle = actualRecord(expected, { title: "different" });
		expect(verify(expected, wrongTitle)).toEqual({ verified: false, reason: "session-title" });

		const wrongIdle = actualRecord(expected);
		wrongIdle.info = { ...wrongIdle.info, time: { ...(wrongIdle.info["time"] as JsonObject), idle: 999 } };
		expect(verify(expected, wrongIdle)).toEqual({ verified: false, reason: "session-idle" });

		const extraField = actualRecord(expected, { unknownField: "x" });
		expect(verify(expected, extraField)).toEqual({ verified: false, reason: "session-fields" });

		const extraLocation = actualRecord(expected, { location: { directory: "C:\\Target\\Project", extra: 1 } });
		expect(verify(expected, extraLocation)).toEqual({ verified: false, reason: "session-location" });
	});

	test("rejects expected references and malformed actual records", () => {
		const withRef = record(SOURCE_ID, [userMessage("msg_1")], { parentID: "ses_parent" });
		expect(verify(withRef, actualRecord(withRef))).toEqual({ verified: false, reason: "expected-references" });

		const expected = expectedRecord();
		expect(
			verify(expected, { info: expected.info, messages: undefined } as unknown as SessionRecord),
		).toEqual({ verified: false, reason: "actual-malformed" });
	});
});
