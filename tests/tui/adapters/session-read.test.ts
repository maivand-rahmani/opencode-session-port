/**
 * SessionPort TUI host read adapter tests (Phase 4, non-visual lane; `fix-51`).
 *
 * Fake public clients only: no real host calls, no imports, no filesystem, no
 * Git, no model calls. These tests validate adapter behavior against the
 * recorded v2.0.22 declaration/source findings (E13/E14/E18) and the core
 * `SessionReadPort` contract; they are not runtime validation of a live host
 * and make no snapshot-consistency claim (O-21/OQ-23).
 */

import { describe, expect, test } from "bun:test";
import {
	collectCheckpointPayload,
	collectCheckpointPayloadWithDependencies,
	type SessionCollectionPolicy,
	type SessionListPageRequest,
} from "../../../src/core/sessions/index.ts";
import {
	createSessionDependencyReadAdapter,
	createSessionReadAdapter,
	HostAdapterError,
} from "../../../src/tui/adapters/index.ts";

interface FakeReadClientOptions {
	readonly sessionList?: (input: unknown) => Promise<unknown>;
	readonly messageList?: (input: unknown) => Promise<unknown>;
	/** Defaults to a direct unwrapped info object for the requested ID. */
	readonly sessionGet?: (input: unknown) => Promise<unknown>;
}

interface FakeReadClientHandle {
	readonly client: unknown;
	readonly sessionListCalls: unknown[];
	readonly messageListCalls: unknown[];
	readonly sessionGetCalls: unknown[];
}

/** Recording fake of the public read surface; scripts page responses per call. */
function createFakeReadClient(options: FakeReadClientOptions = {}): FakeReadClientHandle {
	const sessionListCalls: unknown[] = [];
	const messageListCalls: unknown[] = [];
	const sessionGetCalls: unknown[] = [];
	const client = {
		session: {
			async list(input: unknown): Promise<unknown> {
				sessionListCalls.push(input);
				return options.sessionList ? options.sessionList(input) : undefined;
			},
			async get(input: unknown): Promise<unknown> {
				sessionGetCalls.push(input);
				if (options.sessionGet) return options.sessionGet(input);
				return sessionInfo((input as { readonly sessionID: string }).sessionID);
			},
		},
		message: {
			async list(input: unknown): Promise<unknown> {
				messageListCalls.push(input);
				return options.messageList ? options.messageList(input) : undefined;
			},
		},
	};
	return { client, sessionListCalls, messageListCalls, sessionGetCalls };
}

/** Sequential-page fake: session pages and per-session message pages are consumed in call order. */
function createScriptedReadClient(
	sessionPages: readonly unknown[],
	messagePages: Readonly<Record<string, readonly unknown[]>>,
	dependencyInfos: Readonly<Record<string, unknown>> = {},
): FakeReadClientHandle {
	let sessionPageIndex = 0;
	const messagePageIndexes = new Map<string, number>();
	const sessionListCalls: unknown[] = [];
	const messageListCalls: unknown[] = [];
	const sessionGetCalls: unknown[] = [];
	const client = {
		session: {
			async list(input: unknown): Promise<unknown> {
				sessionListCalls.push(input);
				const page = sessionPages[sessionPageIndex];
				sessionPageIndex += 1;
				if (page === undefined) throw new Error(`unexpected session page request ${sessionPageIndex}`);
				return page;
			},
			async get(input: unknown): Promise<unknown> {
				sessionGetCalls.push(input);
				const sessionID = (input as { readonly sessionID: string }).sessionID;
				if (!(sessionID in dependencyInfos)) throw new Error(`unexpected session.get for ${sessionID}`);
				return dependencyInfos[sessionID];
			},
		},
		message: {
			async list(input: unknown): Promise<unknown> {
				messageListCalls.push(input);
				const sessionID = (input as { readonly sessionID: string }).sessionID;
				const index = messagePageIndexes.get(sessionID) ?? 0;
				messagePageIndexes.set(sessionID, index + 1);
				const page = (messagePages[sessionID] ?? [])[index];
				if (page === undefined) throw new Error(`unexpected message page request ${index + 1} for ${sessionID}`);
				return page;
			},
		},
	};
	return { client, sessionListCalls, messageListCalls, sessionGetCalls };
}

/** Captures and asserts a thrown `HostAdapterError` (returns it for code checks). */
function captureHostAdapterError(run: () => unknown): HostAdapterError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(HostAdapterError);
		return error as HostAdapterError;
	}
	throw new Error("expected a HostAdapterError");
}

const PROJECT_ID = "proj_1";

function sessionInfo(id: string): Record<string, unknown> {
	return {
		id,
		projectID: PROJECT_ID,
		location: { directory: "C:/repo" },
		title: `title ${id}`,
		time: { created: 1, updated: 2 },
		cost: 0,
		tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
	};
}

function userMessage(id: string): Record<string, unknown> {
	return { id, type: "user", text: `text ${id}`, time: { created: 3 } };
}

function assistantMessage(id: string): Record<string, unknown> {
	return {
		id,
		type: "assistant",
		agent: "build",
		model: { id: "model_1", providerID: "provider_1" },
		content: [],
		time: { created: 2, completed: 4 },
	};
}

function policy(overrides: Partial<SessionCollectionPolicy> = {}): SessionCollectionPolicy {
	return {
		sessionPageSize: 2,
		messagePageSize: 2,
		maxSessions: 10,
		maxMessagesPerSession: 10,
		maxTotalMessages: 20,
		...overrides,
	};
}

describe("createSessionReadAdapter capability detection", () => {
	test("fails closed when session.list is missing or not callable", () => {
		for (const client of [
			{},
			{ session: {} },
			{ session: { list: 42 } },
			{ session: { list: null } },
			{ message: { list: async () => undefined } },
			null,
			undefined,
			"client",
			[],
		]) {
			const error = captureHostAdapterError(() => createSessionReadAdapter(client));
			expect(error.code).toBe("capability-unavailable");
			expect(error.message).toContain("session.list");
		}
	});

	test("fails closed when message.list is missing or not callable", () => {
		const error = captureHostAdapterError(() =>
			createSessionReadAdapter({ session: { list: async () => undefined } }),
		);
		expect(error.code).toBe("capability-unavailable");
		expect(error.message).toContain("message.list");
	});

	test("returns a SessionReadPort when both methods are callable", () => {
		const { client } = createFakeReadClient();
		const port = createSessionReadAdapter(client);
		expect(typeof port.listSessions).toBe("function");
		expect(typeof port.listMessages).toBe("function");
	});
});

describe("session page request mapping", () => {
	test("maps the first page to { project, limit } only", async () => {
		const { client, sessionListCalls } = createFakeReadClient({ sessionList: async () => ({ data: [], cursor: {} }) });
		const port = createSessionReadAdapter(client);
		await port.listSessions({ project: PROJECT_ID, limit: 2 });
		expect(sessionListCalls).toEqual([{ project: PROJECT_ID, limit: 2 }]);
	});

	test("maps later pages to { project, limit, cursor }", async () => {
		const { client, sessionListCalls } = createFakeReadClient({ sessionList: async () => ({ data: [], cursor: {} }) });
		const port = createSessionReadAdapter(client);
		await port.listSessions({ project: PROJECT_ID, limit: 2, cursor: "sp-2" });
		expect(sessionListCalls).toEqual([{ project: PROJECT_ID, limit: 2, cursor: "sp-2" }]);
	});

	test("fails closed on a missing/blank project or non-explicit page size without calling the host", async () => {
		const { client, sessionListCalls } = createFakeReadClient();
		const port = createSessionReadAdapter(client);
		const malformed = [
			{ project: "", limit: 2 },
			{ limit: 2 },
			{ project: PROJECT_ID, limit: 0 },
			{ project: PROJECT_ID, limit: 1.5 },
		] as unknown as SessionListPageRequest[];
		for (const request of malformed) {
			await expect(port.listSessions(request)).rejects.toMatchObject({ code: "invalid-request" });
		}
		expect(sessionListCalls.length).toBe(0);
	});
});

describe("message page request mapping", () => {
	test('maps the first page to { sessionID, limit, order: "asc" } with no cursor and no type filter', async () => {
		const { client, messageListCalls } = createFakeReadClient({ messageList: async () => ({ data: [], cursor: {} }) });
		const port = createSessionReadAdapter(client);
		await port.listMessages({ sessionID: "ses_1", limit: 3, order: "asc" });
		expect(messageListCalls).toEqual([{ sessionID: "ses_1", limit: 3, order: "asc" }]);
		const call = messageListCalls[0] as Record<string, unknown>;
		expect("cursor" in call).toBe(false);
		expect("type" in call).toBe(false);
	});

	test("maps later pages to { sessionID, limit, cursor } with no order and no type filter", async () => {
		const { client, messageListCalls } = createFakeReadClient({ messageList: async () => ({ data: [], cursor: {} }) });
		const port = createSessionReadAdapter(client);
		await port.listMessages({ sessionID: "ses_1", limit: 3, cursor: "mp-2" });
		expect(messageListCalls).toEqual([{ sessionID: "ses_1", limit: 3, cursor: "mp-2" }]);
		const call = messageListCalls[0] as Record<string, unknown>;
		expect("order" in call).toBe(false);
		expect("type" in call).toBe(false);
	});

	test("fails closed on a missing/blank session scope or page size without calling the host", async () => {
		const { client, messageListCalls } = createFakeReadClient();
		const port = createSessionReadAdapter(client);
		const malformed = [
			{ sessionID: "", limit: 3, order: "asc" },
			{ limit: 3, order: "asc" },
			{ sessionID: "ses_1", limit: 0, order: "asc" },
			{ sessionID: "ses_1", limit: 3 },
		] as unknown as Parameters<typeof port.listMessages>[0][];
		for (const request of malformed) {
			await expect(port.listMessages(request)).rejects.toMatchObject({ code: "invalid-request" });
		}
		expect(messageListCalls.length).toBe(0);
	});

	test("never forwards extra or filter-shaped request fields (fresh mapped objects only)", async () => {
		const { client, sessionListCalls, messageListCalls } = createFakeReadClient({
			sessionList: async () => ({ data: [], cursor: {} }),
			messageList: async () => ({ data: [], cursor: {} }),
		});
		const port = createSessionReadAdapter(client);

		const smuggledSession = {
			project: PROJECT_ID,
			limit: 2,
			cursor: "c1",
			search: "x",
			parentID: "ses_p",
			directory: "D:/x",
			subpath: "s",
			order: "desc",
		} as unknown as SessionListPageRequest;
		await port.listSessions(smuggledSession);
		expect(sessionListCalls).toEqual([{ project: PROJECT_ID, limit: 2, cursor: "c1" }]);
		expect(Object.keys(sessionListCalls[0] as object).sort()).toEqual(["cursor", "limit", "project"]);

		const smuggledMessage = {
			sessionID: "ses_1",
			limit: 2,
			cursor: "mc",
			order: "desc",
			type: "user",
		} as unknown as Parameters<typeof port.listMessages>[0];
		await port.listMessages(smuggledMessage);
		expect(messageListCalls).toEqual([{ sessionID: "ses_1", limit: 2, cursor: "mc" }]);
		expect(Object.keys(messageListCalls[0] as object).sort()).toEqual(["cursor", "limit", "sessionID"]);
	});
});

describe("raw page preservation and error propagation", () => {
	test("returns page envelopes unchanged: no filtering, truncation, or variant dropping", async () => {
		const sessionPage = {
			data: [{ id: "ses_1", projectID: PROJECT_ID, secretShapedField: "kept" }],
			cursor: { previous: null, next: "sp-2" },
		};
		const messageVariants = [
			{ id: "msg_1", type: "assistant", content: [{ type: "tool", toolCallID: "tool_1" }], time: { created: 1, completed: 2 } },
			{ id: "msg_2", type: "shell", shellID: "shell_1", status: "exited", time: { created: 3 } },
			{ id: "msg_3", type: "compaction", time: { created: 4 } },
			{ id: "msg_4", type: "synthetic", text: "hidden", secret: true, time: { created: 5 } },
		];
		const messagePage = { data: messageVariants, cursor: { next: "mp-2" } };
		const { client } = createFakeReadClient({
			sessionList: async () => sessionPage,
			messageList: async () => messagePage,
		});
		const port = createSessionReadAdapter(client);
		expect(await port.listSessions({ project: PROJECT_ID, limit: 1 })).toBe(sessionPage);
		expect(await port.listMessages({ sessionID: "ses_1", limit: 4, order: "asc" })).toBe(messagePage);
	});

	test("propagates host errors unchanged (no wrapping or retry)", async () => {
		const hostError = Object.assign(new Error("session list rejected"), { name: "HostApiError", status: 500 });
		const { client } = createFakeReadClient({
			sessionList: async () => {
				throw hostError;
			},
			messageList: async () => {
				throw hostError;
			},
		});
		const port = createSessionReadAdapter(client);
		await expect(port.listSessions({ project: PROJECT_ID, limit: 1 })).rejects.toBe(hostError);
		await expect(port.listMessages({ sessionID: "ses_1", limit: 1, order: "asc" })).rejects.toBe(hostError);
	});
});

describe("integration with the core collector", () => {
	test("drives collectCheckpointPayload over fake public pages with exact pagination mapping", async () => {
		const { client, sessionListCalls, messageListCalls } = createScriptedReadClient(
			[
				{ data: [sessionInfo("ses_1"), sessionInfo("ses_2")], cursor: { next: "sp-2" } },
				{ data: [sessionInfo("ses_3")], cursor: { next: null } },
			],
			{
				ses_1: [
					{ data: [userMessage("msg_1"), assistantMessage("msg_2")], cursor: { next: "mp-2" } },
					{ data: [userMessage("msg_3")], cursor: {} },
				],
				ses_2: [{ data: [userMessage("msg_4")], cursor: {} }],
				ses_3: [{ data: [userMessage("msg_5")], cursor: {} }],
			},
		);
		const port = createSessionReadAdapter(client);
		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions.map((session) => session.info["id"])).toEqual(["ses_1", "ses_2", "ses_3"]);
		expect(payload.sessions[0]!.messages.map((message) => message["id"])).toEqual(["msg_1", "msg_2", "msg_3"]);
		expect(sessionListCalls).toEqual([
			{ project: PROJECT_ID, limit: 2 },
			{ project: PROJECT_ID, limit: 2, cursor: "sp-2" },
		]);
		expect(messageListCalls).toEqual([
			{ sessionID: "ses_1", limit: 2, order: "asc" },
			{ sessionID: "ses_1", limit: 2, cursor: "mp-2" },
			{ sessionID: "ses_2", limit: 2, order: "asc" },
			{ sessionID: "ses_3", limit: 2, order: "asc" },
		]);
	});
});

/* ------------------------------------------------------------------------- */
/* Dependency-capable read adapter (checkpoint closure, 2026-10-18 amendment) */
/* ------------------------------------------------------------------------- */

describe("createSessionDependencyReadAdapter capability detection", () => {
	test("fails closed when session.list or message.list is missing or not callable", () => {
		for (const client of [
			{},
			{ session: {} },
			{ session: { list: 42 } },
			{ message: { list: async () => undefined } },
			null,
			undefined,
			"client",
			[],
		]) {
			const error = captureHostAdapterError(() => createSessionDependencyReadAdapter(client));
			expect(error.code).toBe("capability-unavailable");
		}
	});

	test("fails closed when session.get is missing or not callable", () => {
		for (const getValue of [undefined, 42, null]) {
			const client = {
				session: { list: async () => undefined, ...(getValue === undefined ? {} : { get: getValue }) },
				message: { list: async () => undefined },
			};
			const error = captureHostAdapterError(() => createSessionDependencyReadAdapter(client));
			expect(error.code).toBe("capability-unavailable");
			expect(error.message).toContain("session.get");
		}
	});

	test("returns a SessionDependencyReadPort when all three methods are callable", () => {
		const { client } = createFakeReadClient();
		const port = createSessionDependencyReadAdapter(client);
		expect(typeof port.listSessions).toBe("function");
		expect(typeof port.listMessages).toBe("function");
		expect(typeof port.getSession).toBe("function");
	});
});

describe("dependency getSession mapping", () => {
	test("sends exactly { sessionID } and returns the raw direct info unchanged", async () => {
		const directInfo = sessionInfo("ses_dep");
		const { client, sessionGetCalls } = createFakeReadClient({ sessionGet: async () => directInfo });
		const port = createSessionDependencyReadAdapter(client);

		const result = await port.getSession("ses_dep");

		expect(result).toBe(directInfo);
		expect(sessionGetCalls).toEqual([{ sessionID: "ses_dep" }]);
		expect(Object.keys(sessionGetCalls[0] as object)).toEqual(["sessionID"]);
	});

	test("does not unwrap or repair an enveloped response (raw value passes through)", async () => {
		const enveloped = { data: sessionInfo("ses_dep") };
		const { client } = createFakeReadClient({ sessionGet: async () => enveloped });
		const port = createSessionDependencyReadAdapter(client);

		expect(await port.getSession("ses_dep")).toBe(enveloped);
	});

	test("fails closed on a missing/blank session ID without calling the host", async () => {
		const { client, sessionGetCalls } = createFakeReadClient();
		const port = createSessionDependencyReadAdapter(client);

		await expect(port.getSession("")).rejects.toMatchObject({ code: "invalid-request" });
		await expect(port.getSession(undefined as unknown as string)).rejects.toMatchObject({ code: "invalid-request" });
		expect(sessionGetCalls.length).toBe(0);
	});

	test("propagates host errors unchanged", async () => {
		const hostError = Object.assign(new Error("session get rejected"), { name: "HostApiError", status: 404 });
		const { client } = createFakeReadClient({
			sessionGet: async () => {
				throw hostError;
			},
		});
		const port = createSessionDependencyReadAdapter(client);

		await expect(port.getSession("ses_dep")).rejects.toBe(hostError);
	});

	test("never fetches dependencies proactively: list reads make no get calls", async () => {
		const { client, sessionGetCalls } = createFakeReadClient({
			sessionList: async () => ({ data: [], cursor: {} }),
			messageList: async () => ({ data: [], cursor: {} }),
		});
		const port = createSessionDependencyReadAdapter(client);

		await port.listSessions({ project: PROJECT_ID, limit: 2 });
		await port.listMessages({ sessionID: "ses_1", limit: 2, order: "asc" });
		expect(sessionGetCalls.length).toBe(0);
	});
});

describe("dependency adapter with the closure collector", () => {
	test("resolves an external referenced parent through the raw get response and includes its history", async () => {
		const externalInfo = { ...sessionInfo("ses_ext"), projectID: "proj_other" };
		const { client, sessionGetCalls } = createScriptedReadClient(
			[
				{
					data: [{ ...sessionInfo("ses_child"), parentID: "ses_ext" }],
					cursor: null,
				},
			],
			{
				ses_child: [{ data: [userMessage("msg_child")], cursor: {} }],
				ses_ext: [{ data: [userMessage("msg_ext")], cursor: {} }],
			},
			{ ses_ext: externalInfo },
		);
		const port = createSessionDependencyReadAdapter(client);
		const payload = await collectCheckpointPayloadWithDependencies(port, {
			projectID: PROJECT_ID,
			policy: policy(),
		});

		expect(payload.sessions.map((session) => session.info["id"]).sort()).toEqual(["ses_child", "ses_ext"]);
		const child = payload.sessions.find((session) => session.info["id"] === "ses_child");
		const dependency = payload.sessions.find((session) => session.info["id"] === "ses_ext");
		expect(child?.messages.map((message) => message["id"])).toEqual(["msg_child"]);
		expect(dependency?.messages.map((message) => message["id"])).toEqual(["msg_ext"]);

		// Only the schema-referenced, not-yet-collected session was fetched, and
		// exactly `{ sessionID }` was sent.
		expect(sessionGetCalls).toEqual([{ sessionID: "ses_ext" }]);
	});
});
