/**
 * SessionPort core session lane — collector tests (Phase 2, lane A).
 *
 * Synthetic in-memory data only: no real sessions, no host/API calls, no model
 * calls, no filesystem, no Git. The fake port returns raw unknown values so the
 * collector's validation and fail-closed paths are exercised directly.
 *
 * Evidence boundary: these tests validate this lane's behavior against the
 * recorded v2.0.22 declaration/source findings (E13–E15). v2.0.22 message
 * records (`Session.Message.Info`) carry no `sessionID`; message association
 * is endpoint-scoped through the `listMessages` request target, so fixtures
 * use bare records. They are not runtime validation of a live OpenCode host,
 * and they make no snapshot-consistency claim (OQ-23).
 */

import { describe, expect, test } from "bun:test";
import {
	collectCheckpointPayload,
	SessionCollectionError,
	type MessageListPageRequest,
	type SessionCollectionPolicy,
	type SessionListPageRequest,
	type SessionReadPort,
} from "../../../src/core/sessions/index.ts";

interface FakeCursor {
	readonly previous?: string | null;
	readonly next?: string | null;
	readonly [key: string]: unknown;
}

interface FakePage {
	readonly data: readonly unknown[];
	readonly cursor?: FakeCursor;
	readonly [key: string]: unknown;
}

interface FakePortHandle {
	readonly port: SessionReadPort;
	readonly sessionRequests: SessionListPageRequest[];
	readonly messageRequests: MessageListPageRequest[];
}

/** Deterministic fake port: pages are consumed in call order; extra requests fail loudly. */
function createFakePort(
	sessionPages: readonly FakePage[],
	messagePages: Readonly<Record<string, readonly FakePage[]>>,
): FakePortHandle {
	const sessionRequests: SessionListPageRequest[] = [];
	const messageRequests: MessageListPageRequest[] = [];
	let sessionPageIndex = 0;
	const messagePageIndex = new Map<string, number>();

	const port: SessionReadPort = {
		async listSessions(request) {
			sessionRequests.push(request);
			const page = sessionPages[sessionPageIndex];
			sessionPageIndex += 1;
			if (page === undefined) throw new Error(`unexpected session page request ${sessionPageIndex}`);
			return page;
		},
		async listMessages(request) {
			messageRequests.push(request);
			const pages = messagePages[request.sessionID] ?? [];
			const index = messagePageIndex.get(request.sessionID) ?? 0;
			const page = pages[index];
			if (page === undefined) throw new Error(`unexpected message page request ${index + 1} for ${request.sessionID}`);
			messagePageIndex.set(request.sessionID, index + 1);
			return page;
		},
	};

	return { port, sessionRequests, messageRequests };
}

function policy(overrides: Partial<SessionCollectionPolicy> = {}): SessionCollectionPolicy {
	return {
		sessionPageSize: 2,
		messagePageSize: 3,
		maxSessions: 10,
		maxMessagesPerSession: 10,
		maxTotalMessages: 10,
		...overrides,
	};
}

const PROJECT_ID = "proj_1";

function sessionInfo(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		projectID: PROJECT_ID,
		location: { directory: "C:/repo" },
		title: `title ${id}`,
		time: { created: 1, updated: 2 },
		cost: 0,
		tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
		...extra,
	};
}

function userMessage(id: string): Record<string, unknown> {
	return { id, type: "user", text: `text ${id}`, time: { created: 3 } };
}

/** `completed: null` deliberately omits `time.completed` (unsettled fixture). */
function assistantMessage(id: string, completed: number | null = 3): Record<string, unknown> {
	const time: Record<string, unknown> = { created: 2 };
	if (completed !== null) time["completed"] = completed;
	return {
		id,
		type: "assistant",
		agent: "build",
		model: { id: "model_1", providerID: "provider_1" },
		content: [],
		time,
	};
}

function shellMessage(id: string, status: string): Record<string, unknown> {
	return { id, type: "shell", shellID: "shell_1", command: "ls", status, time: { created: 3 } };
}

function compactionMessage(id: string, status: string): Record<string, unknown> {
	return { id, type: "compaction", reason: "auto", summary: "s", recent: "r", status, time: { created: 3 } };
}

async function expectCollectionError(promise: Promise<unknown>, code: string): Promise<SessionCollectionError> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(SessionCollectionError);
	const collectionError = caught as SessionCollectionError;
	expect(collectionError.code).toBe(code);
	return collectionError;
}

describe("collectCheckpointPayload: cursor traversal and ordering", () => {
	test("pages the session list and each message list to exhaustion in server order", async () => {
		const { port, sessionRequests, messageRequests } = createFakePort(
			[
				{ data: [sessionInfo("ses_1")], cursor: { previous: null, next: "session-page-2" } },
				{ data: [sessionInfo("ses_2")], cursor: { previous: "session-page-1", next: null } },
			],
			{
				ses_1: [
					{ data: [userMessage("msg_1")], cursor: { next: "message-page-2" } },
					{ data: [assistantMessage("msg_2")], cursor: { next: null } },
				],
				ses_2: [{ data: [userMessage("msg_3")] }],
			},
		);

		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions.map((record) => record.info["id"])).toEqual(["ses_1", "ses_2"]);
		expect(payload.sessions[0]!.messages.map((message) => message["id"])).toEqual(["msg_1", "msg_2"]);
		expect(payload.sessions[1]!.messages.map((message) => message["id"])).toEqual(["msg_3"]);

		expect(sessionRequests).toEqual([
			{ project: PROJECT_ID, limit: 2 },
			{ project: PROJECT_ID, limit: 2, cursor: "session-page-2" },
		]);
		expect(messageRequests).toEqual([
			{ sessionID: "ses_1", limit: 3, order: "asc" },
			{ sessionID: "ses_1", limit: 3, cursor: "message-page-2" },
			{ sessionID: "ses_2", limit: 3, order: "asc" },
		]);

		// No type filter is ever sent, so all message variants/tool content survive.
		for (const request of messageRequests) expect("type" in request).toBe(false);
		// Order is only combined with the first page, never with a cursor.
		expect("order" in messageRequests[1]!).toBe(false);
	});

	test("stops following cursor.next when it is absent or null and ignores unknown page fields", async () => {
		const { port, sessionRequests, messageRequests } = createFakePort(
			[{ data: [sessionInfo("ses_1")], cursor: { next: null }, total: 999, hasMore: true }],
			{ ses_1: [{ data: [userMessage("msg_1")], cursor: { previous: "unused" } }] },
		);

		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions).toHaveLength(1);
		expect(sessionRequests).toHaveLength(1);
		expect(messageRequests).toHaveLength(1);
	});

	test("includes every session the API returns, including archived sessions (no filtering)", async () => {
		const archived = sessionInfo("ses_archived", { time: { created: 1, updated: 2, archived: 9 } });
		const { port } = createFakePort([{ data: [archived] }], { ses_archived: [{ data: [] }] });

		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions).toHaveLength(1);
		expect(payload.sessions[0]!.info["time"]).toEqual({ created: 1, updated: 2, archived: 9 });
	});

	test("preserves root, child, and fork references as opaque data", async () => {
		const child = sessionInfo("ses_child", {
			parentID: "ses_parent",
			fork: { sessionID: "ses_source", boundary: { type: "through", messageID: "msg_7" } },
		});
		const { port } = createFakePort([{ data: [child] }], { ses_child: [{ data: [] }] });

		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions[0]!.info).toEqual(child);
		expect(payload.sessions[0]!.info["parentID"]).toBe("ses_parent");
		expect(payload.sessions[0]!.info["fork"]).toEqual({
			sessionID: "ses_source",
			boundary: { type: "through", messageID: "msg_7" },
		});
	});

	test("preserves tool content, unknown message variants, and unknown fields without coercion", async () => {
		const toolAssistant = {
			...assistantMessage("msg_tool"),
			content: [
				{ type: "text", text: "before" },
				{
					type: "tool",
					id: "call_1",
					name: "read",
					executed: true,
					providerState: { nested: [1, 2, { deep: null }] },
					state: {
						status: "completed",
						input: { path: "src/index.ts" },
						content: [{ type: "text", text: "file body" }],
						metadata: { bytes: 42 },
					},
				},
				{ type: "reasoning", text: "hmm", time: { created: 1, completed: 2 } },
			],
			snapshot: { start: "snap_1", end: "snap_2", files: ["a.ts"] },
		};
		const unknownVariant = {
			id: "msg_future",
			type: "future-variant",
			arbitrary: { list: [true, false, null, 3.5], opaque: "value" },
			time: { created: 9 },
		};
		const { port } = createFakePort(
			[{ data: [sessionInfo("ses_1")] }],
			{ ses_1: [{ data: [toolAssistant, unknownVariant] }] },
		);

		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions[0]!.messages[0]).toEqual(toolAssistant);
		expect(payload.sessions[0]!.messages[1]).toEqual(unknownVariant);
	});

	test("snapshots are detached: mutating API-owned objects after collection cannot change the payload", async () => {
		const session = sessionInfo("ses_1", { metadata: { note: "original" } });
		const message = userMessage("msg_1");
		const { port } = createFakePort([{ data: [session] }], { ses_1: [{ data: [message] }] });

		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });
		(session["metadata"] as Record<string, unknown>)["note"] = "mutated";
		message["text"] = "mutated";

		expect((payload.sessions[0]!.info["metadata"] as Record<string, unknown>)["note"]).toBe("original");
		expect(payload.sessions[0]!.messages[0]!["text"]).toBe("text msg_1");
	});
});

describe("collectCheckpointPayload: unsettled-message fail-closed", () => {
	const unsettledCases: readonly [string, Record<string, unknown>, string][] = [
		["assistant without time.completed", assistantMessage("msg_1", null), "assistant-without-completion"],
		["running shell", shellMessage("msg_1", "running"), "shell-running"],
		["running compaction", compactionMessage("msg_1", "running"), "compaction-running"],
	];

	for (const [name, message, reason] of unsettledCases) {
		test(`fails the whole collection on ${name}`, async () => {
			const { port } = createFakePort([{ data: [sessionInfo("ses_1")] }], { ses_1: [{ data: [message] }] });

			const error = await expectCollectionError(
				collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
				"unsettled-message",
			);
			expect(error.message).toContain(reason);
			expect(error.message).toContain("ses_1");
			expect(error.message).toContain("msg_1");
		});
	}

	test("collects settled assistant, shell, and compaction variants", async () => {
		const settled = [
			assistantMessage("msg_1", 5),
			shellMessage("msg_2", "exited"),
			shellMessage("msg_3", "timeout"),
			shellMessage("msg_4", "killed"),
			compactionMessage("msg_5", "completed"),
			compactionMessage("msg_6", "failed"),
		];
		const { port } = createFakePort([{ data: [sessionInfo("ses_1")] }], { ses_1: [{ data: settled }] });

		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions[0]!.messages).toHaveLength(6);
	});
});

describe("collectCheckpointPayload: loop and duplicate protection", () => {
	test("rejects a repeated session cursor instead of looping", async () => {
		const { port } = createFakePort(
			[
				{ data: [sessionInfo("ses_1")], cursor: { next: "cursor-a" } },
				{ data: [sessionInfo("ses_2")], cursor: { next: "cursor-a" } },
			],
			{ ses_1: [{ data: [] }], ses_2: [{ data: [] }] },
		);

		await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
			"repeated-session-cursor",
		);
	});

	test("rejects a repeated message cursor instead of looping", async () => {
		const { port } = createFakePort(
			[{ data: [sessionInfo("ses_1")] }],
			{
				ses_1: [
					{ data: [userMessage("msg_1")], cursor: { next: "cursor-a" } },
					{ data: [userMessage("msg_2")], cursor: { next: "cursor-a" } },
				],
			},
		);

		await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
			"repeated-message-cursor",
		);
	});

	test("rejects a duplicate session id across pages", async () => {
		const { port } = createFakePort(
			[
				{ data: [sessionInfo("ses_1")], cursor: { next: "cursor-a" } },
				{ data: [sessionInfo("ses_1")], cursor: { next: null } },
			],
			{ ses_1: [{ data: [] }] },
		);

		await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
			"duplicate-session-id",
		);
	});

	test("rejects a duplicate message id across pages", async () => {
		const { port } = createFakePort(
			[{ data: [sessionInfo("ses_1")] }],
			{
				ses_1: [
					{ data: [userMessage("msg_1")], cursor: { next: "cursor-a" } },
					{ data: [userMessage("msg_1")], cursor: { next: null } },
				],
			},
		);

		await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
			"duplicate-message-id",
		);
	});

	test("rejects an empty page that still advertises a next cursor", async () => {
		const { port } = createFakePort([{ data: [], cursor: { next: "cursor-a" } }], {});

		await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
			"malformed-session-page",
		);
	});
});

describe("collectCheckpointPayload: API failures and malformed data", () => {
	test("wraps a session list API failure with code and cause", async () => {
		const port: SessionReadPort = {
			async listSessions() {
				throw new Error("session backend exploded");
			},
			async listMessages() {
				throw new Error("unexpected message call");
			},
		};

		const error = await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
			"session-list-failed",
		);
		expect((error.cause as Error).message).toBe("session backend exploded");
	});

	test("wraps a message list API failure with code and cause", async () => {
		const { port } = createFakePort([{ data: [sessionInfo("ses_1")] }], {});
		const failingPort: SessionReadPort = {
			listSessions: port.listSessions,
			async listMessages() {
				throw new Error("message backend exploded");
			},
		};

		const error = await expectCollectionError(
			collectCheckpointPayload(failingPort, { projectID: PROJECT_ID, policy: policy() }),
			"message-list-failed",
		);
		expect((error.cause as Error).message).toBe("message backend exploded");
	});

	test("rejects malformed envelopes and records", async () => {
		const malformedEnvelopes: readonly [string, unknown][] = [
			["null page", null],
			["missing data array", { cursor: {} }],
			["non-object item", { data: [null] }],
			["non-string cursor.next", { data: [sessionInfo("ses_1")], cursor: { next: 7 } }],
		];
		for (const [name, page] of malformedEnvelopes) {
			const port: SessionReadPort = {
				async listSessions() {
					return page;
				},
				async listMessages() {
					return { data: [] };
				},
			};
			await expectCollectionError(
				collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
				name === "non-object item" ? "malformed-session-record" : "malformed-session-page",
			);
		}
	});

	test("rejects records carrying values JSON would omit or coerce", async () => {
		const { port } = createFakePort(
			[{ data: [sessionInfo("ses_1")] }],
			{ ses_1: [{ data: [{ id: "msg_1", type: "user", bad: undefined, time: { created: 1 } }] }] },
		);

		const error = await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
			"malformed-message-record",
		);
		expect(error.message).toContain("not JSON-stable");
	});
});

describe("collectCheckpointPayload: returned-data scope binding", () => {
	test("rejects the whole collection when a session belongs to a different project", async () => {
		const { port } = createFakePort(
			[
				{ data: [sessionInfo("ses_ok")], cursor: { next: "page-2" } },
				{ data: [sessionInfo("ses_other", { projectID: "proj_other" })], cursor: { next: null } },
			],
			{ ses_ok: [{ data: [userMessage("msg_ok")] }] },
		);

		const error = await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
			"session-project-mismatch",
		);
		expect(error.message).toContain("ses_other");
		expect(error.message).toContain("proj_other");
		expect(error.message).toContain(PROJECT_ID);
	});

	test("rejects a session record with no projectID", async () => {
		const missingProject = { id: "ses_1", title: "no project" };
		const { port } = createFakePort([{ data: [missingProject] }], {});

		const error = await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
			"session-project-mismatch",
		);
		expect(error.message).toContain("no projectID");
		expect(error.message).toContain("ses_1");
	});

	test("rejects a session record whose projectID is present but not a string", async () => {
		const { port } = createFakePort([{ data: [sessionInfo("ses_1", { projectID: null })] }], {});

		await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() }),
			"session-project-mismatch",
		);
	});

	test("passes the collected session id to listMessages and accepts bare v2.0.22 message records", async () => {
		// v2.0.22 Session.Message.Info carries no sessionID: association is
		// endpoint-scoped through the listMessages request target, so bare
		// records must collect verbatim without any per-record binding check.
		const bare = { id: "msg_1", type: "user", text: "bare", time: { created: 3 } };
		const { port, messageRequests } = createFakePort([{ data: [sessionInfo("ses_1")] }], {
			ses_1: [{ data: [bare] }],
		});

		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });

		expect(messageRequests).toEqual([{ sessionID: "ses_1", limit: 3, order: "asc" }]);
		expect(payload.sessions[0]!.messages).toEqual([bare]);
	});

	test("keeps an extra sessionID-shaped message field opaque instead of treating it as a binding", async () => {
		// The per-message field is not part of the v2.0.22 shape and future
		// extra-field behavior is OPEN: unknown fields stay preserved and are
		// never validated, required, or normalized into a session binding.
		const withExtraField = { id: "msg_1", type: "user", text: "t", sessionID: "ses_legacy", time: { created: 3 } };
		const { port } = createFakePort([{ data: [sessionInfo("ses_1")] }], { ses_1: [{ data: [withExtraField] }] });

		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions[0]!.messages).toEqual([withExtraField]);
	});
});

describe("collectCheckpointPayload: explicit bounds and request validation", () => {
	test("fails when the session count exceeds maxSessions", async () => {
		const { port } = createFakePort(
			[{ data: [sessionInfo("ses_1"), sessionInfo("ses_2")] }],
			{ ses_1: [{ data: [] }], ses_2: [{ data: [] }] },
		);

		await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy({ maxSessions: 1 }) }),
			"session-limit-exceeded",
		);
	});

	test("fails when a session's message count exceeds maxMessagesPerSession", async () => {
		const { port } = createFakePort(
			[{ data: [sessionInfo("ses_1")] }],
			{ ses_1: [{ data: [userMessage("msg_1"), userMessage("msg_2")] }] },
		);

		await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy({ maxMessagesPerSession: 1 }) }),
			"message-limit-exceeded",
		);
	});

	test("rejects invalid or missing policy limits instead of applying defaults", async () => {
		const { port } = createFakePort([{ data: [] }], {});
		const invalidPolicies: readonly [string, unknown][] = [
			["message page above the declared cap", policy({ messagePageSize: 201 })],
			["zero session page size", policy({ sessionPageSize: 0 })],
			["non-integer limit", policy({ messagePageSize: 1.5 })],
			["missing field", { sessionPageSize: 1, messagePageSize: 1, maxSessions: 1 }],
			["missing total message bound", { sessionPageSize: 1, messagePageSize: 1, maxSessions: 1, maxMessagesPerSession: 1 }],
			["non-finite limit", policy({ maxMessagesPerSession: Number.NaN })],
			["negative total message bound", policy({ maxTotalMessages: -1 })],
			["non-integer total message bound", policy({ maxTotalMessages: 1.5 })],
			["non-finite total message bound", policy({ maxTotalMessages: Number.POSITIVE_INFINITY })],
		];
		for (const [name, invalid] of invalidPolicies) {
			await expectCollectionError(
				collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: invalid as SessionCollectionPolicy }),
				"invalid-policy",
			);
		}
	});

	test("accepts the declared message page cap of 200", async () => {
		const { port } = createFakePort([{ data: [sessionInfo("ses_1")] }], { ses_1: [{ data: [] }] });

		const payload = await collectCheckpointPayload(port, {
			projectID: PROJECT_ID,
			policy: policy({ messagePageSize: 200 }),
		});

		expect(payload.sessions).toHaveLength(1);
	});

	test("requires an explicit non-empty projectID", async () => {
		const { port } = createFakePort([{ data: [] }], {});

		await expectCollectionError(
			collectCheckpointPayload(port, { projectID: "", policy: policy() }),
			"invalid-request",
		);
	});
});

describe("collectCheckpointPayload: total message bound across sessions and pages", () => {
	test("accepts a collection whose total message count is exactly maxTotalMessages across sessions", async () => {
		const { port } = createFakePort(
			[{ data: [sessionInfo("ses_1"), sessionInfo("ses_2")] }],
			{
				ses_1: [{ data: [userMessage("msg_1"), userMessage("msg_2")] }],
				ses_2: [{ data: [userMessage("msg_3")] }],
			},
		);

		const payload = await collectCheckpointPayload(port, {
			projectID: PROJECT_ID,
			policy: policy({ maxTotalMessages: 3 }),
		});

		expect(payload.sessions).toHaveLength(2);
		expect(payload.sessions[0]!.messages.map((message) => message["id"])).toEqual(["msg_1", "msg_2"]);
		expect(payload.sessions[1]!.messages.map((message) => message["id"])).toEqual(["msg_3"]);
	});

	test("accepts a collection whose total message count is exactly maxTotalMessages across pages", async () => {
		const { port } = createFakePort(
			[{ data: [sessionInfo("ses_1")] }],
			{
				ses_1: [
					{ data: [userMessage("msg_1"), userMessage("msg_2")], cursor: { next: "message-page-2" } },
					{ data: [userMessage("msg_3")], cursor: { next: null } },
				],
			},
		);

		const payload = await collectCheckpointPayload(port, {
			projectID: PROJECT_ID,
			policy: policy({ maxTotalMessages: 3 }),
		});

		expect(payload.sessions[0]!.messages.map((message) => message["id"])).toEqual(["msg_1", "msg_2", "msg_3"]);
	});

	test("rejects the whole collection when one more message arrives from a later session", async () => {
		const { port, messageRequests } = createFakePort(
			[{ data: [sessionInfo("ses_1"), sessionInfo("ses_2")] }],
			{
				ses_1: [{ data: [userMessage("msg_1"), userMessage("msg_2")] }],
				ses_2: [{ data: [userMessage("msg_3"), userMessage("msg_4")] }],
			},
		);

		const error = await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy({ maxTotalMessages: 3 }) }),
			"total-message-limit-exceeded",
		);
		expect(error.message).toContain("maxTotalMessages=3");
		expect(error.message).toContain("ses_2");
		// ses_2's page would only partially fit; it is rejected whole and no
		// payload is returned (no truncation, no partial result).
		expect(messageRequests).toHaveLength(2);
	});

	test("rejects the whole collection when one more message arrives on a later page", async () => {
		const { port } = createFakePort(
			[{ data: [sessionInfo("ses_1")] }],
			{
				ses_1: [
					{ data: [userMessage("msg_1"), userMessage("msg_2")], cursor: { next: "message-page-2" } },
					{ data: [userMessage("msg_3"), userMessage("msg_4")], cursor: { next: null } },
				],
			},
		);

		await expectCollectionError(
			collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy({ maxTotalMessages: 3 }) }),
			"total-message-limit-exceeded",
		);
	});

	test("supports a zero total bound: empty sessions collect and any message rejects", async () => {
		const empty = createFakePort([{ data: [sessionInfo("ses_1")] }], { ses_1: [{ data: [] }] });

		const payload = await collectCheckpointPayload(empty.port, {
			projectID: PROJECT_ID,
			policy: policy({ maxTotalMessages: 0 }),
		});

		expect(payload.sessions).toHaveLength(1);
		expect(payload.sessions[0]!.messages).toHaveLength(0);

		const withMessage = createFakePort([{ data: [sessionInfo("ses_1")] }], {
			ses_1: [{ data: [userMessage("msg_1")] }],
		});

		await expectCollectionError(
			collectCheckpointPayload(withMessage.port, { projectID: PROJECT_ID, policy: policy({ maxTotalMessages: 0 }) }),
			"total-message-limit-exceeded",
		);
	});

	test("keeps the per-session bound checked independently of the total bound", async () => {
		const { port } = createFakePort(
			[{ data: [sessionInfo("ses_1")] }],
			{ ses_1: [{ data: [userMessage("msg_1"), userMessage("msg_2")] }] },
		);

		await expectCollectionError(
			collectCheckpointPayload(port, {
				projectID: PROJECT_ID,
				policy: policy({ maxMessagesPerSession: 1, maxTotalMessages: 5 }),
			}),
			"message-limit-exceeded",
		);
	});
});
