/**
 * Subagent checkpoint-retention adapter tests (owner-directed 2026-11-13
 * checkpoint weight policy).
 *
 * Synthetic fake ports only: no host call, database, filesystem, crypto, or
 * import. These tests pin one-shot enumeration, project scoping, the strict
 * page envelope, root/child classification, deterministic latest-N child
 * retention, order preservation, exact summaries, verbatim delegation, and
 * fail-closed behavior. No runtime, completeness, or compatibility claim
 * follows beyond the adapter research.
 */

import { describe, expect, test } from "bun:test";
import { SessionCollectionError } from "../../../src/core/sessions/index.ts";
import type {
	MessageListPageRequest,
	SessionCollectionErrorCode,
	SessionCollectionPolicy,
	SessionDependencyReadPort,
	SessionListPageRequest,
} from "../../../src/core/sessions/index.ts";
import {
	createSubagentRetentionPort,
	readCheckpointRetentionInsights,
	type SubagentRetentionInput,
	type SubagentRetentionMode,
} from "../../../src/tui/adapters/session-retention.ts";

const PROJECT = "proj_retention";

/** Synthetic policy only; selects no production numeric cap (O-03 stays OPEN). */
const POLICY: SessionCollectionPolicy = {
	sessionPageSize: 10,
	messagePageSize: 5,
	maxSessions: 40,
	maxMessagesPerSession: 5,
	maxTotalMessages: 10,
};

const MESSAGE_RESULT = { data: [{ id: "msg_1" }], cursor: null };
const SESSION_RESULT = { id: "ses_delegated" };

/* ------------------------------------------------------------------------- */
/* Synthetic fake port                                                       */
/* ------------------------------------------------------------------------- */

interface FakePortHandle {
	readonly port: SessionDependencyReadPort;
	readonly sessionRequests: SessionListPageRequest[];
	readonly messageRequests: MessageListPageRequest[];
	readonly sessionFetches: string[];
}

/**
 * Fake dependency read port. `listSessions` is scripted by the caller; message
 * and single-session reads record their exact argument. A scripted message
 * handler may be supplied for compaction scans; otherwise the shared message
 * sentinel is returned so delegation tests can assert return identity.
 */
function createFakePort(
	handler: (request: SessionListPageRequest) => unknown | Promise<unknown>,
	messageHandler?: (request: MessageListPageRequest) => unknown | Promise<unknown>,
): FakePortHandle {
	const sessionRequests: SessionListPageRequest[] = [];
	const messageRequests: MessageListPageRequest[] = [];
	const sessionFetches: string[] = [];
	return {
		port: {
			async listSessions(request: SessionListPageRequest): Promise<unknown> {
				sessionRequests.push(request);
				return handler(request);
			},
			async listMessages(request: MessageListPageRequest): Promise<unknown> {
				messageRequests.push(request);
				return messageHandler === undefined ? MESSAGE_RESULT : messageHandler(request);
			},
			async getSession(sessionID: string): Promise<unknown> {
				sessionFetches.push(sessionID);
				return SESSION_RESULT;
			},
		},
		sessionRequests,
		messageRequests,
		sessionFetches,
	};
}

/** Cursor is a simple numeric offset so pagination stays deterministic and tiny. */
function createPagedHandle(
	sessions: readonly Record<string, unknown>[],
	pageSize: number = POLICY.sessionPageSize,
	messageHandler?: (request: MessageListPageRequest) => unknown | Promise<unknown>,
): FakePortHandle {
	return createFakePort((request) => {
		const start = request.cursor === undefined ? 0 : Number(request.cursor);
		const end = start + pageSize;
		const data = sessions.slice(start, end);
		return { data, cursor: end < sessions.length ? { next: String(end) } : null };
	}, messageHandler);
}

/* ------------------------------------------------------------------------- */
/* Synthetic records and helpers                                             */
/* ------------------------------------------------------------------------- */

/** One synthetic session info record with the pinned v2.0.22 required fields. */
function sessionRecord(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		projectID: PROJECT,
		title: `title ${id}`,
		cost: 0,
		time: { created: 1, updated: 1 },
		location: { directory: "C:/work/project" },
		...extra,
	};
}

function rootSession(id: string, updated = 1): Record<string, unknown> {
	return sessionRecord(id, { time: { created: 1, updated } });
}

function childSession(id: string, updated: number, parentID: unknown = "ses_root_1"): Record<string, unknown> {
	return sessionRecord(id, { parentID, time: { created: 1, updated } });
}

function childSessionAt(
	id: string,
	created: number,
	updated: number,
	parentID: unknown = "ses_root_1",
): Record<string, unknown> {
	return sessionRecord(id, { parentID, time: { created, updated } });
}

/** One synthetic message record; `type` is omitted for ordinary messages. */
function messageRecord(
	id: string,
	type?: string,
	time: Record<string, unknown> = { created: 1 },
): Record<string, unknown> {
	return { id, ...(type === undefined ? {} : { type }), time };
}

/** Numeric-offset message pagination for one synthetic session. */
function createMessagePager(
	messages: readonly Record<string, unknown>[],
	pageSize: number,
): (request: MessageListPageRequest) => unknown {
	return (request) => {
		const start = "cursor" in request ? Number(request.cursor) : 0;
		const end = start + pageSize;
		return { data: messages.slice(start, end), cursor: end < messages.length ? { next: String(end) } : null };
	};
}

/** Routes message reads by session and fails loudly on an unexpected session scan. */
function createMessageRouter(
	pagesBySession: Readonly<Record<string, (request: MessageListPageRequest) => unknown>>,
): (request: MessageListPageRequest) => unknown {
	return (request) => {
		const handler = pagesBySession[request.sessionID];
		if (handler === undefined) {
			throw new Error(`unexpected message read for ${request.sessionID}`);
		}
		return handler(request);
	};
}

function inputFor(handle: FakePortHandle, overrides: Partial<SubagentRetentionInput> = {}): SubagentRetentionInput {
	return {
		readPort: handle.port,
		projectID: PROJECT,
		policy: POLICY,
		mode: "latest",
		maxSubagentSessions: 20,
		...overrides,
	};
}

interface RetainedPage {
	readonly data: readonly Record<string, unknown>[];
	readonly cursor: null;
}

/** One consumer read of the retained port's materialized list. */
async function readRetained(port: SessionDependencyReadPort): Promise<RetainedPage> {
	const raw = await port.listSessions({ project: PROJECT, limit: POLICY.sessionPageSize });
	return raw as RetainedPage;
}

async function expectFailure(
	run: () => Promise<unknown>,
	code: SessionCollectionErrorCode,
): Promise<SessionCollectionError> {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(SessionCollectionError);
		const collectionError = error as SessionCollectionError;
		expect(collectionError.code).toBe(code);
		return collectionError;
	}
	throw new Error(`expected SessionCollectionError ${JSON.stringify(code)}, but the call resolved`);
}

async function expectCollectionFailure(
	input: SubagentRetentionInput,
	code: SessionCollectionErrorCode,
): Promise<SessionCollectionError> {
	return expectFailure(() => createSubagentRetentionPort(input), code);
}

/* ------------------------------------------------------------------------- */
/* Retention behavior                                                        */
/* ------------------------------------------------------------------------- */

describe("subagent checkpoint retention", () => {
	test("pages once, keeps roots plus the 20 latest children, preserves original order, and reports exact counts", async () => {
		const sessions = retentionDataset();
		const handle = createPagedHandle(sessions);

		const retention = await createSubagentRetentionPort(inputFor(handle));
		expect(handle.sessionRequests).toHaveLength(3);

		const page = await readRetained(retention.port);
		const expectedKeptIDs = [
			"ses_child_25",
			"ses_root_1",
			...Array.from({ length: 19 }, (_, index) => `ses_child_${String(index + 6).padStart(2, "0")}`),
			"ses_root_2",
			"ses_root_3",
		];
		expect(page.data.map((record) => record["id"])).toEqual(expectedKeptIDs);
		expect(page.cursor).toBeNull();
		expect(page.data[0]).toBe(sessions[0]);

		expect(retention.summary).toEqual({
			mode: "latest",
			projectSessionCount: 28,
			keptSessionCount: 23,
			excludedSessionCount: 5,
			keptRootCount: 3,
			maxSubagentSessions: 20,
			maxRootSessions: null,
		});

		// The consumer read is served from the retained list, not from the host.
		expect(handle.sessionRequests).toHaveLength(3);
	});

	test("treats absent and null parentID as roots and keeps roots only when the child cap is zero", async () => {
		const handle = createPagedHandle([
			childSession("ses_child_newest", 999),
			sessionRecord("ses_root_absent"),
			sessionRecord("ses_root_null", { parentID: null }),
		]);
		const retention = await createSubagentRetentionPort(inputFor(handle, { maxSubagentSessions: 0 }));

		const page = await readRetained(retention.port);
		expect(page.data.map((record) => record["id"])).toEqual(["ses_root_absent", "ses_root_null"]);
		expect(retention.summary).toEqual({
			mode: "latest",
			projectSessionCount: 3,
			keptSessionCount: 2,
			excludedSessionCount: 1,
			keptRootCount: 2,
			maxSubagentSessions: 0,
			maxRootSessions: null,
		});
	});

	test("breaks equal time.updated ties by ascending session id", async () => {
		const handle = createPagedHandle([
			childSession("ses_b_tie", 7),
			childSession("ses_a_tie", 7),
			rootSession("ses_root_tie"),
		]);
		const retention = await createSubagentRetentionPort(inputFor(handle, { maxSubagentSessions: 1 }));

		const page = await readRetained(retention.port);
		expect(page.data.map((record) => record["id"])).toEqual(["ses_a_tie", "ses_root_tie"]);
		expect(retention.summary.keptSessionCount).toBe(2);
	});

	test("delegates listMessages and getSession with the exact argument and return identity", async () => {
		const handle = createPagedHandle([rootSession("ses_root_delegate")]);
		const retention = await createSubagentRetentionPort(inputFor(handle));

		const messageRequest: MessageListPageRequest = {
			sessionID: "ses_root_delegate",
			limit: POLICY.messagePageSize,
			order: "asc",
		};
		const messageResult = await retention.port.listMessages(messageRequest);
		expect(messageResult).toBe(MESSAGE_RESULT);
		expect(handle.messageRequests).toHaveLength(1);
		expect(handle.messageRequests[0]).toBe(messageRequest);

		const sessionResult = await retention.port.getSession("ses_root_delegate");
		expect(sessionResult).toBe(SESSION_RESULT);
		expect(handle.sessionFetches).toEqual(["ses_root_delegate"]);
	});

	test("rejects a second listSessions call because the kept list is already materialized", async () => {
		const handle = createPagedHandle([rootSession("ses_root_once")]);
		const retention = await createSubagentRetentionPort(inputFor(handle));

		const first = await readRetained(retention.port);
		expect(first.cursor).toBeNull();

		await expectFailure(
			() => retention.port.listSessions({ project: PROJECT, limit: POLICY.sessionPageSize }),
			"invalid-request",
		);
		expect(handle.sessionRequests).toHaveLength(1);
	});
});

/* ------------------------------------------------------------------------- */
/* Configurable retention modes                                              */
/* ------------------------------------------------------------------------- */

describe("subagent checkpoint retention modes", () => {
	test("mode all keeps every child and ignores the child cap while echoing it", async () => {
		const sessions = retentionDataset();
		const handle = createPagedHandle(sessions);
		const retention = await createSubagentRetentionPort(
			inputFor(handle, { mode: "all", maxSubagentSessions: 0 }),
		);

		const page = await readRetained(retention.port);
		expect(page.data.map((record) => record["id"])).toEqual(sessions.map((record) => record["id"]));
		expect(retention.summary).toEqual({
			mode: "all",
			projectSessionCount: 28,
			keptSessionCount: 28,
			excludedSessionCount: 0,
			keptRootCount: 3,
			maxSubagentSessions: 0,
			maxRootSessions: null,
		});
	});

	test("since-compaction scans paged root messages, follows cursors, and keeps children created after the latest compaction", async () => {
		const policy = { ...POLICY, messagePageSize: 2, maxMessagesPerSession: 10 };
		const rootAMessages = [
			messageRecord("msg_a1"),
			messageRecord("msg_a2", "compaction", { created: 2, completed: 100 }),
			messageRecord("msg_a3"),
			messageRecord("msg_a4", "compaction", { created: 4, completed: 120 }),
			messageRecord("msg_a5"),
		];
		const rootBMessages = [messageRecord("msg_b1", "compaction", { created: 80 })];
		const messageHandler = createMessageRouter({
			ses_root_a: createMessagePager(rootAMessages, policy.messagePageSize),
			ses_root_b: createMessagePager(rootBMessages, policy.messagePageSize),
		});
		const handle = createPagedHandle(
			[
				childSessionAt("ses_child_before", 40, 1),
				rootSession("ses_root_a"),
				childSessionAt("ses_child_boundary", 120, 2),
				rootSession("ses_root_b"),
				childSessionAt("ses_child_after", 130, 3),
				childSessionAt("ses_child_after_mid", 125, 4),
			],
			POLICY.sessionPageSize,
			messageHandler,
		);

		const retention = await createSubagentRetentionPort(
			inputFor(handle, { mode: "since-compaction", policy, maxSubagentSessions: 5 }),
		);
		const page = await readRetained(retention.port);
		expect(page.data.map((record) => record["id"])).toEqual([
			"ses_root_a",
			"ses_root_b",
			"ses_child_after",
			"ses_child_after_mid",
		]);
		expect(handle.messageRequests).toEqual([
			{ sessionID: "ses_root_a", limit: 2, order: "asc" },
			{ sessionID: "ses_root_a", limit: 2, cursor: "2" },
			{ sessionID: "ses_root_a", limit: 2, cursor: "4" },
			{ sessionID: "ses_root_b", limit: 2, order: "asc" },
		]);
		expect(retention.summary).toEqual({
			mode: "since-compaction",
			projectSessionCount: 6,
			keptSessionCount: 4,
			excludedSessionCount: 2,
			keptRootCount: 2,
			maxSubagentSessions: 5,
			maxRootSessions: null,
		});
	});

	test("since-compaction falls back to latest when no root has a compaction", async () => {
		const policy = { ...POLICY, messagePageSize: 2 };
		const messageHandler = createMessageRouter({
			ses_root_fallback: createMessagePager([messageRecord("msg_fb")], policy.messagePageSize),
		});
		const handle = createPagedHandle(
			[
				sessionRecord("ses_fallback_a", { parentID: "ses_root_fallback", time: { updated: 5 } }),
				rootSession("ses_root_fallback"),
				sessionRecord("ses_fallback_b", { parentID: "ses_root_fallback", time: { updated: 9 } }),
			],
			POLICY.sessionPageSize,
			messageHandler,
		);

		const retention = await createSubagentRetentionPort(
			inputFor(handle, { mode: "since-compaction", policy, maxSubagentSessions: 1 }),
		);
		const page = await readRetained(retention.port);
		expect(page.data.map((record) => record["id"])).toEqual(["ses_root_fallback", "ses_fallback_b"]);
		expect(retention.summary).toEqual({
			mode: "since-compaction",
			projectSessionCount: 3,
			keptSessionCount: 2,
			excludedSessionCount: 1,
			keptRootCount: 1,
			maxSubagentSessions: 1,
			maxRootSessions: null,
		});
	});

	test("since-compaction caps post-compaction children by updated time, not creation time", async () => {
		const policy = { ...POLICY, messagePageSize: 5 };
		const messageHandler = createMessageRouter({
			ses_root_cap: createMessagePager(
				[messageRecord("msg_cap", "compaction", { completed: 100 })],
				policy.messagePageSize,
			),
		});
		const handle = createPagedHandle(
			[
				rootSession("ses_root_cap"),
				childSessionAt("ses_child_pre_compaction_high_updated", 90, 1000),
				childSessionAt("ses_child_created_old", 110, 99),
				childSessionAt("ses_child_created_mid", 120, 2),
				childSessionAt("ses_child_created_new", 130, 3),
			],
			POLICY.sessionPageSize,
			messageHandler,
		);

		const retention = await createSubagentRetentionPort(
			inputFor(handle, { mode: "since-compaction", policy, maxSubagentSessions: 2 }),
		);
		const page = await readRetained(retention.port);
		expect(page.data.map((record) => record["id"])).toEqual([
			"ses_root_cap",
			"ses_child_created_old",
			"ses_child_created_new",
		]);
		expect(retention.summary).toEqual({
			mode: "since-compaction",
			projectSessionCount: 5,
			keptSessionCount: 3,
			excludedSessionCount: 2,
			keptRootCount: 1,
			maxSubagentSessions: 2,
			maxRootSessions: null,
		});
	});

	test("since-compaction keeps roots only when the child cap is zero", async () => {
		const messageHandler = createMessageRouter({
			ses_root_zero: createMessagePager(
				[messageRecord("msg_zero", "compaction", { completed: 100 })],
				POLICY.messagePageSize,
			),
		});
		const handle = createPagedHandle(
			[rootSession("ses_root_zero"), childSessionAt("ses_child_after_zero", 200, 5)],
			POLICY.sessionPageSize,
			messageHandler,
		);

		const retention = await createSubagentRetentionPort(
			inputFor(handle, { mode: "since-compaction", maxSubagentSessions: 0 }),
		);
		const page = await readRetained(retention.port);
		expect(page.data.map((record) => record["id"])).toEqual(["ses_root_zero"]);
		expect(handle.messageRequests).toHaveLength(1);
		expect(retention.summary).toEqual({
			mode: "since-compaction",
			projectSessionCount: 2,
			keptSessionCount: 1,
			excludedSessionCount: 1,
			keptRootCount: 1,
			maxSubagentSessions: 0,
			maxRootSessions: null,
		});
	});

	test("since-compaction fails closed when a child lacks a finite time.created", async () => {
		const policy = { ...POLICY, messagePageSize: 5 };
		const children = [
			sessionRecord("ses_child_no_created", { parentID: "ses_root_created", time: { updated: 5 } }),
			sessionRecord("ses_child_text_created", {
				parentID: "ses_root_created",
				time: { created: "soon", updated: 5 },
			}),
		];

		for (const child of children) {
			const messageHandler = createMessageRouter({
				ses_root_created: createMessagePager(
					[messageRecord("msg_created", "compaction", { completed: 50 })],
					policy.messagePageSize,
				),
			});
			const handle = createPagedHandle(
				[rootSession("ses_root_created"), child],
				POLICY.sessionPageSize,
				messageHandler,
			);
			await expectCollectionFailure(
				inputFor(handle, { mode: "since-compaction", policy }),
				"malformed-session-record",
			);
		}
	});

	test("since-compaction propagates root message-page failures", async () => {
		const handle = createPagedHandle(
			[rootSession("ses_root_error")],
			POLICY.sessionPageSize,
			() => {
				throw new Error("root page exploded");
			},
		);

		const error = await expectCollectionFailure(
			inputFor(handle, { mode: "since-compaction" }),
			"message-list-failed",
		);
		expect(error.cause).toBeInstanceOf(Error);
		expect((error.cause as Error).message).toContain("root page exploded");
	});

	test("since-compaction enforces maxMessagesPerSession", async () => {
		const policy = { ...POLICY, messagePageSize: 2, maxMessagesPerSession: 2 };
		const handle = createPagedHandle(
			[rootSession("ses_root_messages")],
			POLICY.sessionPageSize,
			createMessagePager(
				[messageRecord("msg_m1"), messageRecord("msg_m2"), messageRecord("msg_m3")],
				policy.messagePageSize,
			),
		);

		await expectCollectionFailure(
			inputFor(handle, { mode: "since-compaction", policy }),
			"message-limit-exceeded",
		);
	});

	test("since-compaction rejects duplicate message ids and repeated message cursors", async () => {
		const duplicateHandle = createPagedHandle(
			[rootSession("ses_root_dup_message")],
			POLICY.sessionPageSize,
			createMessagePager(
				[messageRecord("msg_dup"), messageRecord("msg_dup")],
				POLICY.messagePageSize,
			),
		);
		await expectCollectionFailure(
			inputFor(duplicateHandle, { mode: "since-compaction" }),
			"duplicate-message-id",
		);

		const repeatedHandle = createPagedHandle(
			[rootSession("ses_root_repeated_cursor")],
			POLICY.sessionPageSize,
			(request) =>
				request.cursor === undefined
					? { data: [messageRecord("msg_r1")], cursor: { next: "same" } }
					: { data: [messageRecord("msg_r2")], cursor: { next: "same" } },
		);
		await expectCollectionFailure(
			inputFor(repeatedHandle, { mode: "since-compaction" }),
			"repeated-message-cursor",
		);
	});
});

/* ------------------------------------------------------------------------- */
/* Roots retention mode and date-based insights                              */
/* ------------------------------------------------------------------------- */

const DAY = 24 * 60 * 60 * 1000;
const INSIGHTS_NOW = Date.UTC(2026, 10, 13, 12, 0, 0);

describe("roots checkpoint retention mode", () => {
	test("keeps the N most recently active roots and every descendant, preserves order, and reports exact counts", async () => {
		const sessions = [
			childSessionAt("ses_grandchild_a", 1, 9, "ses_child_a"),
			rootSession("ses_root_a", 100),
			rootSession("ses_root_b", 50),
			rootSession("ses_root_c", 10),
			childSessionAt("ses_child_a", 1, 7, "ses_root_a"),
			childSessionAt("ses_child_b", 1, 8, "ses_root_b"),
			childSessionAt("ses_child_c", 1, 6, "ses_root_c"),
			sessionRecord("ses_orphan", { parentID: "ses_missing", time: { created: 1, updated: 11 } }),
		];
		const handle = createPagedHandle(sessions);
		const retention = await createSubagentRetentionPort(
			inputFor(handle, { mode: "roots", maxRootSessions: 2 }),
		);

		const page = await readRetained(retention.port);
		expect(page.data.map((record) => record["id"])).toEqual([
			"ses_grandchild_a",
			"ses_root_a",
			"ses_root_b",
			"ses_child_a",
			"ses_child_b",
		]);
		expect(retention.summary).toEqual({
			mode: "roots",
			projectSessionCount: 8,
			keptSessionCount: 5,
			excludedSessionCount: 3,
			keptRootCount: 2,
			maxSubagentSessions: 20,
			maxRootSessions: 2,
		});
		// No compaction scan is needed in roots mode.
		expect(handle.messageRequests).toHaveLength(0);
	});

	test("keeps every root and child when the root count exceeds the project's roots", async () => {
		const sessions = [
			rootSession("ses_root_only_a", 2),
			childSession("ses_child_only_a", 3, "ses_root_only_a"),
			rootSession("ses_root_only_b", 1),
		];
		const handle = createPagedHandle(sessions);
		const retention = await createSubagentRetentionPort(
			inputFor(handle, { mode: "roots", maxRootSessions: 10 }),
		);

		const page = await readRetained(retention.port);
		expect(page.data.map((record) => record["id"])).toEqual(sessions.map((record) => record["id"]));
		expect(retention.summary.keptRootCount).toBe(2);
		expect(retention.summary.excludedSessionCount).toBe(0);
	});

	test("falls back to time.created when a root has no finite time.updated", async () => {
		const handle = createPagedHandle([
			sessionRecord("ses_root_created_only", { time: { created: 200 } }),
			rootSession("ses_root_updated", 100),
		]);
		const retention = await createSubagentRetentionPort(
			inputFor(handle, { mode: "roots", maxRootSessions: 1 }),
		);

		const page = await readRetained(retention.port);
		expect(page.data.map((record) => record["id"])).toEqual(["ses_root_created_only"]);
	});

	test("fails closed when a root has no finite activity timestamp", async () => {
		const handle = createPagedHandle([
			sessionRecord("ses_root_undated", { time: { updated: "recent" } }),
			rootSession("ses_root_dated", 10),
		]);
		await expectCollectionFailure(
			inputFor(handle, { mode: "roots", maxRootSessions: 1 }),
			"malformed-session-record",
		);
	});

	test("fails closed on a parentID cycle instead of guessing descendants", async () => {
		const handle = createPagedHandle([
			rootSession("ses_root_cycle", 10),
			childSessionAt("ses_child_cycle_a", 1, 2, "ses_child_cycle_b"),
			childSessionAt("ses_child_cycle_b", 1, 3, "ses_child_cycle_a"),
		]);
		await expectCollectionFailure(
			inputFor(handle, { mode: "roots", maxRootSessions: 1 }),
			"malformed-session-record",
		);
	});
});

describe("checkpoint retention insights", () => {
	function insightsInput(
		handle: FakePortHandle,
		overrides: Partial<Parameters<typeof readCheckpointRetentionInsights>[0]> = {},
	): Parameters<typeof readCheckpointRetentionInsights>[0] {
		return {
			readPort: handle.port,
			projectID: PROJECT,
			policy: POLICY,
			now: INSIGHTS_NOW,
			recentDays: 30,
			...overrides,
		};
	}

	test("reads root dates, counts activity windows, and recommends roots N when older roots exist", async () => {
		const handle = createPagedHandle([
			rootSession("ses_root_recent", INSIGHTS_NOW - 2 * DAY),
			rootSession("ses_root_week", INSIGHTS_NOW - 8 * DAY),
			rootSession("ses_root_month", INSIGHTS_NOW - 40 * DAY),
			rootSession("ses_root_old", INSIGHTS_NOW - 400 * DAY),
			childSession("ses_child_insight", 1),
		]);

		const insights = await readCheckpointRetentionInsights(insightsInput(handle));

		expect(insights.totalRootSessions).toBe(4);
		expect(insights.totalChildSessions).toBe(1);
		expect(insights.roots.map((root) => root.id)).toEqual([
			"ses_root_recent",
			"ses_root_week",
			"ses_root_month",
			"ses_root_old",
		]);
		expect(insights.activeRootCounts).toEqual({ days7: 1, days30: 2, days90: 3 });
		expect(insights.newestRootAt).toBe(INSIGHTS_NOW - 2 * DAY);
		expect(insights.oldestRootAt).toBe(INSIGHTS_NOW - 400 * DAY);
		expect(insights.recommendation).toEqual({
			mode: "roots",
			maxRootSessions: 2,
			recentRootCount: 2,
			totalRootCount: 4,
			windowDays: 30,
			windowStartAt: INSIGHTS_NOW - 30 * DAY,
		});
		// Metadata only: no message page is read.
		expect(handle.messageRequests).toHaveLength(0);
	});

	test("recommends since-compaction when every root is recent or the project has no roots", async () => {
		const recent = await readCheckpointRetentionInsights(
			insightsInput(
				createPagedHandle([
					rootSession("ses_root_recent_a", INSIGHTS_NOW - DAY),
					rootSession("ses_root_recent_b", INSIGHTS_NOW - 2 * DAY),
				]),
			),
		);
		expect(recent.recommendation.mode).toBe("since-compaction");
		expect(recent.recommendation.maxRootSessions).toBeNull();

		const empty = await readCheckpointRetentionInsights(
			insightsInput(createPagedHandle([childSession("ses_child_only", 1)])),
		);
		expect(empty.totalRootSessions).toBe(0);
		expect(empty.recommendation.mode).toBe("since-compaction");
		expect(empty.recommendation.maxRootSessions).toBeNull();
		expect(empty.newestRootAt).toBeNull();
		expect(empty.oldestRootAt).toBeNull();
	});

	test("recommends keeping one root when every root is older than the window", async () => {
		const insights = await readCheckpointRetentionInsights(
			insightsInput(
				createPagedHandle([
					rootSession("ses_root_month", INSIGHTS_NOW - 40 * DAY),
					rootSession("ses_root_old", INSIGHTS_NOW - 400 * DAY),
				]),
			),
		);
		expect(insights.recommendation.mode).toBe("roots");
		expect(insights.recommendation.maxRootSessions).toBe(1);
	});

	test("rejects malformed inputs and treats undated roots as unranked without reading messages", async () => {
		const handle = createPagedHandle([rootSession("ses_root_valid", INSIGHTS_NOW)]);
		const base = insightsInput(handle);

		await expectFailure(
			() => readCheckpointRetentionInsights(null as unknown as typeof base),
			"invalid-request",
		);
		await expectFailure(
			() => readCheckpointRetentionInsights({ ...base, now: Number.NaN }),
			"invalid-request",
		);
		await expectFailure(
			() => readCheckpointRetentionInsights({ ...base, recentDays: 0 }),
			"invalid-request",
		);
		await expectFailure(
			() => readCheckpointRetentionInsights({ ...base, projectID: " " }),
			"invalid-request",
		);
		await expectFailure(
			() =>
				readCheckpointRetentionInsights({
					...base,
					readPort: { listSessions: "nope" } as unknown as typeof base.readPort,
				}),
			"invalid-request",
		);

		const undated = createPagedHandle([
			sessionRecord("ses_root_undated", { time: {} }),
			rootSession("ses_root_dated", INSIGHTS_NOW - DAY),
		]);
		const insights = await readCheckpointRetentionInsights(insightsInput(undated));
		expect(insights.roots.map((root) => root.lastActiveAt)).toEqual([INSIGHTS_NOW - DAY, null]);
		expect(insights.newestRootAt).toBe(INSIGHTS_NOW - DAY);
		expect(insights.oldestRootAt).toBe(INSIGHTS_NOW - DAY);
		// An undated root cannot be ranked, so the safe since-compaction mode is
		// recommended; selecting roots mode would fail closed.
		expect(insights.recommendation.mode).toBe("since-compaction");
		expect(insights.recommendation.maxRootSessions).toBeNull();
		expect(handle.messageRequests).toHaveLength(0);
	});
});

/** 28 sessions: 3 roots (one with `parentID: null`), 25 children with updated 1..25. */
function retentionDataset(): Record<string, unknown>[] {
	const roots = [
		rootSession("ses_root_1"),
		sessionRecord("ses_root_2", { parentID: null }),
		rootSession("ses_root_3"),
	];
	const children = Array.from({ length: 25 }, (_, index) =>
		childSession(`ses_child_${String(index + 1).padStart(2, "0")}`, index + 1),
	);
	// Newest child first, then roots interleaved; the original list order must survive.
	return [children[24]!, roots[0]!, ...children.slice(0, 24), roots[1]!, roots[2]!];
}

/* ------------------------------------------------------------------------- */
/* Input validation                                                          */
/* ------------------------------------------------------------------------- */

describe("subagent checkpoint retention input validation", () => {
	test("rejects null, array, blank-project, and non-integer child-cap inputs", async () => {
		const handle = createPagedHandle([rootSession("ses_root_input")]);
		const base = inputFor(handle);

		await expectFailure(
			() => createSubagentRetentionPort(null as unknown as SubagentRetentionInput),
			"invalid-request",
		);
		await expectFailure(
			() => createSubagentRetentionPort([] as unknown as SubagentRetentionInput),
			"invalid-request",
		);
		await expectCollectionFailure({ ...base, projectID: "" }, "invalid-request");
		await expectCollectionFailure({ ...base, projectID: "   " }, "invalid-request");
		await expectCollectionFailure({ ...base, maxSubagentSessions: -1 }, "invalid-request");
		await expectCollectionFailure({ ...base, maxSubagentSessions: 1.5 }, "invalid-request");
		await expectCollectionFailure({ ...base, maxSubagentSessions: Number.NaN }, "invalid-request");
	});

	test("requires a positive maxRootSessions for roots mode and rejects malformed caps elsewhere", async () => {
		const handle = createPagedHandle([rootSession("ses_root_root_cap")]);
		const base = inputFor(handle);

		await expectCollectionFailure(
			{ ...base, mode: "roots", maxRootSessions: undefined },
			"invalid-request",
		);
		await expectCollectionFailure(
			{ ...base, mode: "roots", maxRootSessions: null },
			"invalid-request",
		);
		await expectCollectionFailure(
			{ ...base, mode: "roots", maxRootSessions: 0 },
			"invalid-request",
		);
		await expectCollectionFailure(
			{ ...base, mode: "roots", maxRootSessions: -1 },
			"invalid-request",
		);
		await expectCollectionFailure(
			{ ...base, mode: "roots", maxRootSessions: 1.5 },
			"invalid-request",
		);
		await expectCollectionFailure({ ...base, maxRootSessions: 0 }, "invalid-request");
	});

	test("requires callable listSessions, listMessages, and getSession", async () => {
		const handle = createPagedHandle([rootSession("ses_root_port")]);
		const input = {
			projectID: PROJECT,
			policy: POLICY,
			maxSubagentSessions: 20,
		};

		await expectFailure(
			() =>
				createSubagentRetentionPort({
					...input,
					readPort: {
						listMessages: handle.port.listMessages,
						getSession: handle.port.getSession,
					} as unknown as SessionDependencyReadPort,
				}),
			"invalid-request",
		);
		await expectFailure(
			() =>
				createSubagentRetentionPort({
					...input,
					readPort: {
						listSessions: handle.port.listSessions,
						getSession: handle.port.getSession,
					} as unknown as SessionDependencyReadPort,
				}),
			"invalid-request",
		);
		await expectFailure(
			() =>
				createSubagentRetentionPort({
					...input,
					readPort: {
						listSessions: handle.port.listSessions,
						listMessages: handle.port.listMessages,
					} as unknown as SessionDependencyReadPort,
				}),
			"invalid-request",
		);
	});

	test("rejects an invalid collection policy with the shared core code", async () => {
		const handle = createPagedHandle([rootSession("ses_root_policy")]);
		await expectCollectionFailure(inputFor(handle, { policy: { ...POLICY, sessionPageSize: 0 } }), "invalid-policy");
		await expectCollectionFailure(
			inputFor(handle, { policy: undefined as unknown as SessionCollectionPolicy }),
			"invalid-policy",
		);
	});

	test("rejects an invalid or missing retention mode", async () => {
		const handle = createPagedHandle([rootSession("ses_root_mode")]);
		await expectCollectionFailure(
			inputFor(handle, { mode: "unknown" as SubagentRetentionMode }),
			"invalid-request",
		);
		await expectCollectionFailure(
			inputFor(handle, { mode: undefined as unknown as SubagentRetentionMode }),
			"invalid-request",
		);
	});
});

/* ------------------------------------------------------------------------- */
/* Fail-closed page and record handling                                      */
/* ------------------------------------------------------------------------- */

describe("subagent checkpoint retention fail-closed reads", () => {
	test("rejects malformed page envelopes and an empty page carrying a next cursor", async () => {
		await expectCollectionFailure(
			inputFor(createFakePort(() => "not a page")),
			"malformed-session-page",
		);
		await expectCollectionFailure(
			inputFor(createFakePort(() => ({ cursor: null }))),
			"malformed-session-page",
		);
		await expectCollectionFailure(
			inputFor(createFakePort(() => ({ data: [], cursor: { next: "more" } }))),
			"malformed-session-page",
		);
		await expectCollectionFailure(
			inputFor(createFakePort(() => ({ data: [], cursor: { next: "" } }))),
			"malformed-session-page",
		);
	});

	test("rejects a repeated page cursor", async () => {
		const handle = createFakePort((request) =>
			request.cursor === undefined
				? { data: [rootSession("ses_cursor_1")], cursor: { next: "same" } }
				: { data: [rootSession("ses_cursor_2")], cursor: { next: "same" } },
		);
		await expectCollectionFailure(inputFor(handle), "repeated-session-cursor");
	});

	test("rejects malformed records, duplicates, and scope mismatches with collector codes", async () => {
		const cases: readonly {
			readonly name: string;
			readonly sessions: readonly Record<string, unknown>[];
			readonly code: SessionCollectionErrorCode;
		}[] = [
			{ name: "non-object item", sessions: [null as unknown as Record<string, unknown>], code: "malformed-session-record" },
			{ name: "missing id", sessions: [{ projectID: PROJECT }], code: "malformed-session-record" },
			{ name: "empty id", sessions: [{ id: "", projectID: PROJECT }], code: "malformed-session-record" },
			{
				name: "duplicate id",
				sessions: [rootSession("ses_dup"), rootSession("ses_dup")],
				code: "duplicate-session-id",
			},
			{
				name: "project mismatch",
				sessions: [sessionRecord("ses_other", { projectID: "proj_other" })],
				code: "session-project-mismatch",
			},
			{
				name: "non-string parentID",
				sessions: [sessionRecord("ses_bad_parent", { parentID: 42 })],
				code: "malformed-session-record",
			},
			{
				name: "child without time",
				sessions: [{ id: "ses_no_time", projectID: PROJECT, parentID: "ses_root" }],
				code: "malformed-session-record",
			},
			{
				name: "child without updated",
				sessions: [sessionRecord("ses_no_updated", { parentID: "ses_root", time: { created: 1 } })],
				code: "malformed-session-record",
			},
			{
				name: "child with non-numeric updated",
				sessions: [sessionRecord("ses_text_updated", { parentID: "ses_root", time: { created: 1, updated: "later" } })],
				code: "malformed-session-record",
			},
			{
				name: "child with non-finite updated",
				sessions: [
					sessionRecord("ses_infinite_updated", {
						parentID: "ses_root",
						time: { created: 1, updated: Number.POSITIVE_INFINITY },
					}),
				],
				code: "malformed-session-record",
			},
		];

		for (const testCase of cases) {
			const handle = createPagedHandle(testCase.sessions);
			await expectCollectionFailure(inputFor(handle), testCase.code);
		}
	});

	test("does not leak raw record content in failure messages", async () => {
		const leaky = sessionRecord("ses_leaky", {
			parentID: "ses_root",
			secret: "TOP_SECRET_MARKER",
			time: { created: 1 },
		});
		const error = await expectCollectionFailure(inputFor(createPagedHandle([leaky])), "malformed-session-record");
		expect(error.message).not.toContain("TOP_SECRET_MARKER");
	});

	test("fails closed instead of truncating when maxSessions is exceeded", async () => {
		const handle = createPagedHandle([
			rootSession("ses_limit_1"),
			rootSession("ses_limit_2"),
			rootSession("ses_limit_3"),
		]);
		await expectCollectionFailure(
			inputFor(handle, { policy: { ...POLICY, maxSessions: 2 } }),
			"session-limit-exceeded",
		);
	});
});
