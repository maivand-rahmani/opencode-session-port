/**
 * SessionPort core session lane — dependency-closure collector tests
 * (owner-approved 2026-10-18 amendment).
 *
 * Synthetic in-memory data only: no real sessions, no host/API calls, no model
 * calls, no filesystem, no Git. The fake dependency port returns raw unknown
 * values so the closure collector's validation and fail-closed paths are
 * exercised directly. These tests are not runtime validation of a live
 * OpenCode host and make no snapshot-consistency claim (OQ-23).
 */

import { describe, expect, test } from "bun:test";
import {
	collectCheckpointPayload,
	collectCheckpointPayloadWithDependencies,
	SessionCollectionError,
	type MessageListPageRequest,
	type SessionCollectionPolicy,
	type SessionDependencyReadPort,
	type SessionListPageRequest,
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

interface FakeDependencyPortOptions {
	readonly sessionPages?: readonly FakePage[];
	readonly messagePages?: Readonly<Record<string, readonly FakePage[]>>;
	/** Per-ID `getSession` results; a function result may throw. A missing ID throws. */
	readonly getSessionResponses?: Readonly<Record<string, unknown | (() => unknown)>>;
}

interface FakeDependencyPortHandle {
	readonly port: SessionDependencyReadPort;
	readonly sessionRequests: SessionListPageRequest[];
	readonly messageRequests: MessageListPageRequest[];
	readonly getSessionRequests: string[];
}

/** Deterministic fake dependency port: pages are consumed in call order; extra requests fail loudly. */
function createFakeDependencyPort(options: FakeDependencyPortOptions = {}): FakeDependencyPortHandle {
	const sessionRequests: SessionListPageRequest[] = [];
	const messageRequests: MessageListPageRequest[] = [];
	const getSessionRequests: string[] = [];
	const sessionPages = options.sessionPages ?? [];
	const messagePages = options.messagePages ?? {};
	let sessionPageIndex = 0;
	const messagePageIndex = new Map<string, number>();

	const port: SessionDependencyReadPort = {
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
		async getSession(sessionID) {
			getSessionRequests.push(sessionID);
			const configured = options.getSessionResponses?.[sessionID];
			if (configured === undefined) throw new Error(`unexpected getSession for ${sessionID}`);
			if (typeof configured === "function") return (configured as () => unknown)();
			return configured;
		},
	};

	return { port, sessionRequests, messageRequests, getSessionRequests };
}

function policy(overrides: Partial<SessionCollectionPolicy> = {}): SessionCollectionPolicy {
	return {
		sessionPageSize: 2,
		messagePageSize: 3,
		maxSessions: 10,
		maxMessagesPerSession: 10,
		maxTotalMessages: 20,
		...overrides,
	};
}

const PROJECT_ID = "proj_1";
const FOREIGN_PROJECT_ID = "proj_other";

function sessionInfo(
	id: string,
	projectID: string = PROJECT_ID,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		projectID,
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

describe("collectCheckpointPayloadWithDependencies: reference closure", () => {
	test("fetches an omitted cross-project parent via getSession with its full history", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_parent" });
		const parent = sessionInfo("ses_parent", FOREIGN_PROJECT_ID);
		const { port, sessionRequests, messageRequests, getSessionRequests } = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: {
				ses_child: [{ data: [userMessage("msg_child")] }],
				ses_parent: [
					{ data: [userMessage("msg_p1")], cursor: { next: "mp-2" } },
					{ data: [userMessage("msg_p2")], cursor: { next: null } },
				],
			},
			getSessionResponses: { ses_parent: parent },
		});

		const payload = await collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions.map((record) => record.info["id"])).toEqual(["ses_child", "ses_parent"]);
		// The foreign-project dependency is accepted verbatim from the explicit
		// getSession result (no project binding is applied to dependencies).
		expect(payload.sessions[1]!.info).toEqual(parent);
		expect(payload.sessions[1]!.messages.map((message) => message["id"])).toEqual(["msg_p1", "msg_p2"]);

		// One project-scoped list call only; the dependency is resolved by exact
		// ID, never by scanning another project.
		expect(sessionRequests).toEqual([{ project: PROJECT_ID, limit: 2 }]);
		expect(getSessionRequests).toEqual(["ses_parent"]);
		expect(messageRequests).toEqual([
			{ sessionID: "ses_child", limit: 3, order: "asc" },
			{ sessionID: "ses_parent", limit: 3, order: "asc" },
			{ sessionID: "ses_parent", limit: 3, cursor: "mp-2" },
		]);
	});

	test("recursively follows parentID and fork.sessionID across projects", async () => {
		const seed = sessionInfo("ses_seed", PROJECT_ID, { parentID: "ses_a" });
		const a = sessionInfo("ses_a", FOREIGN_PROJECT_ID, { parentID: "ses_b" });
		const b = sessionInfo("ses_b", "proj_third", {
			fork: { sessionID: "ses_c", boundary: { type: "through", messageID: "msg_c1" } },
		});
		const c = sessionInfo("ses_c", "proj_fourth");
		const { port, getSessionRequests } = createFakeDependencyPort({
			sessionPages: [{ data: [seed] }],
			messagePages: {
				ses_seed: [{ data: [userMessage("msg_seed")] }],
				ses_a: [{ data: [userMessage("msg_a")] }],
				ses_b: [{ data: [userMessage("msg_b")] }],
				ses_c: [{ data: [userMessage("msg_c1"), userMessage("msg_c2")] }],
			},
			getSessionResponses: { ses_a: a, ses_b: b, ses_c: c },
		});

		const payload = await collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions.map((record) => record.info["id"])).toEqual(["ses_seed", "ses_a", "ses_b", "ses_c"]);
		expect(getSessionRequests).toEqual(["ses_a", "ses_b", "ses_c"]);
	});

	test("fetches a shared diamond dependency exactly once", async () => {
		const seed = sessionInfo("ses_seed", PROJECT_ID, {
			parentID: "ses_b",
			fork: { sessionID: "ses_c", boundary: { type: "through", messageID: "msg_c1" } },
		});
		const b = sessionInfo("ses_b", FOREIGN_PROJECT_ID, { parentID: "ses_d" });
		const c = sessionInfo("ses_c", FOREIGN_PROJECT_ID, { parentID: "ses_d" });
		const d = sessionInfo("ses_d", FOREIGN_PROJECT_ID);
		const { port, getSessionRequests } = createFakeDependencyPort({
			sessionPages: [{ data: [seed] }],
			messagePages: {
				ses_seed: [{ data: [userMessage("msg_seed")] }],
				ses_b: [{ data: [userMessage("msg_b")] }],
				ses_c: [{ data: [userMessage("msg_c1")] }],
				ses_d: [{ data: [userMessage("msg_d")] }],
			},
			getSessionResponses: { ses_b: b, ses_c: c, ses_d: d },
		});

		const payload = await collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions.map((record) => record.info["id"])).toEqual(["ses_seed", "ses_b", "ses_c", "ses_d"]);
		expect(getSessionRequests).toEqual(["ses_b", "ses_c", "ses_d"]);
	});

	test("does not fetch a referenced session that the seed list already collected", async () => {
		const parent = sessionInfo("ses_parent", PROJECT_ID);
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_parent" });
		const { port, getSessionRequests } = createFakeDependencyPort({
			sessionPages: [{ data: [parent, child] }],
			messagePages: {
				ses_parent: [{ data: [userMessage("msg_p")] }],
				ses_child: [{ data: [userMessage("msg_c")] }],
			},
		});

		const payload = await collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions.map((record) => record.info["id"])).toEqual(["ses_parent", "ses_child"]);
		expect(getSessionRequests).toEqual([]);
	});

	test("rejects the raw { data: sessionInfo } envelope: only direct unwrapped info is the contract", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_ext" });
		const external = sessionInfo("ses_ext", FOREIGN_PROJECT_ID);
		const { port } = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: {
				ses_child: [{ data: [userMessage("msg_child")] }],
				ses_ext: [{ data: [userMessage("msg_ext")] }],
			},
			// Even with the right id inside, an enveloped value is not the
			// declared resolved shape and must fail closed instead of being
			// silently unwrapped by core.
			getSessionResponses: { ses_ext: { data: external } },
		});

		const error = await expectCollectionError(
			collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() }),
			"malformed-session-record",
		);
		expect(error.message).toContain("ses_ext");
	});
});

describe("collectCheckpointPayloadWithDependencies: dependency fail-closed", () => {
	test("wraps a getSession failure with session-list-failed and does not retry", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_missing" });
		const { port, getSessionRequests } = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: { ses_child: [{ data: [userMessage("msg_child")] }] },
		});

		const error = await expectCollectionError(
			collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() }),
			"session-list-failed",
		);
		expect((error.cause as Error).message).toBe("unexpected getSession for ses_missing");
		expect(getSessionRequests).toEqual(["ses_missing"]);
	});

	test("fails with invalid-request when getSession is missing or not callable, before any host read", async () => {
		for (const getSession of [undefined, 42, null]) {
			let listCalls = 0;
			const port = {
				async listSessions(): Promise<unknown> {
					listCalls += 1;
					return { data: [] };
				},
				async listMessages(): Promise<unknown> {
					return { data: [] };
				},
				...(getSession === undefined ? {} : { getSession }),
			} as unknown as SessionDependencyReadPort;

			await expectCollectionError(
				collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() }),
				"invalid-request",
			);
			expect(listCalls).toBe(0);
		}
	});

	test("requires a present nonblank string projectID on dependency records but accepts foreign project values", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_ext" });
		const invalidCases: ReadonlyArray<readonly [string, () => Record<string, unknown>]> = [
			[
				"missing projectID",
				() => {
					const info = sessionInfo("ses_ext", FOREIGN_PROJECT_ID);
					delete (info as Record<string, unknown>)["projectID"];
					return info;
				},
			],
			["null projectID", () => sessionInfo("ses_ext", FOREIGN_PROJECT_ID, { projectID: null })],
			["number projectID", () => sessionInfo("ses_ext", FOREIGN_PROJECT_ID, { projectID: 42 })],
			["empty projectID", () => sessionInfo("ses_ext", "")],
			["whitespace projectID", () => sessionInfo("ses_ext", "   ")],
		];
		for (const [, build] of invalidCases) {
			const { port } = createFakeDependencyPort({
				sessionPages: [{ data: [child] }],
				messagePages: {
					ses_child: [{ data: [userMessage("msg_child")] }],
					ses_ext: [{ data: [userMessage("msg_ext")] }],
				},
				getSessionResponses: { ses_ext: build() },
			});

			const error = await expectCollectionError(
				collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() }),
				"malformed-session-record",
			);
			expect(error.message).toContain("ses_ext");
			expect(error.message).toContain("projectID");
		}

		// A foreign project value (different from the seed project) is valid and
		// must be preserved verbatim, never rewritten to the seed project.
		const valid = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: {
				ses_child: [{ data: [userMessage("msg_child")] }],
				ses_ext: [{ data: [userMessage("msg_ext")] }],
			},
			getSessionResponses: { ses_ext: sessionInfo("ses_ext", FOREIGN_PROJECT_ID) },
		});
		const payload = await collectCheckpointPayloadWithDependencies(valid.port, {
			projectID: PROJECT_ID,
			policy: policy(),
		});
		expect(payload.sessions[1]!.info["projectID"]).toBe(FOREIGN_PROJECT_ID);
	});

	test("rejects wrong-ID, non-object, and non-JSON getSession responses", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_ext" });
		const cases: readonly [string, unknown][] = [
			["wrong id", sessionInfo("ses_other", FOREIGN_PROJECT_ID)],
			["null response", null],
			["array response", []],
			["enveloped response with the right id", { data: sessionInfo("ses_ext", FOREIGN_PROJECT_ID) }],
			["non-object envelope data", { data: 5 }],
			["wrong id inside envelope", { data: sessionInfo("ses_other", FOREIGN_PROJECT_ID) }],
			["non-JSON value", { id: "ses_ext", bad: undefined }],
		];
		for (const [name, response] of cases) {
			const { port } = createFakeDependencyPort({
				sessionPages: [{ data: [child] }],
				messagePages: { ses_child: [{ data: [userMessage("msg_child")] }] },
				getSessionResponses: { ses_ext: response },
			});

			const error = await expectCollectionError(
				collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() }),
				"malformed-session-record",
			);
			expect(error.message).toContain("ses_ext");
			expect(name.length).toBeGreaterThan(0);
		}
	});

	test("rejects malformed or null schema reference fields instead of normalizing them", async () => {
		const cases: readonly [string, Record<string, unknown>, string][] = [
			["non-string parentID", sessionInfo("ses_seed", PROJECT_ID, { parentID: 42 }), '.parentID must be a string starting with "ses" when present'],
			["null parentID", sessionInfo("ses_seed", PROJECT_ID, { parentID: null }), '.parentID must be a string starting with "ses" when present'],
			[
				"non-string fork.sessionID",
				sessionInfo("ses_seed", PROJECT_ID, {
					fork: { sessionID: 7, boundary: { type: "through", messageID: "msg_1" } },
				}),
				'.fork.sessionID must be a string starting with "ses"',
			],
			["missing fork.boundary", sessionInfo("ses_seed", PROJECT_ID, { fork: { sessionID: "ses_x" } }), ".fork.boundary must be an object"],
			[
				"bad boundary.type",
				sessionInfo("ses_seed", PROJECT_ID, {
					fork: { sessionID: "ses_x", boundary: { type: "during", messageID: "msg_1" } },
				}),
				'.fork.boundary.type must be exactly "before" or "through"',
			],
			[
				"bad boundary.messageID prefix",
				sessionInfo("ses_seed", PROJECT_ID, {
					fork: { sessionID: "ses_x", boundary: { type: "through", messageID: "nope" } },
				}),
				'.fork.boundary.messageID must be a string starting with "msg_"',
			],
			["non-string revert.messageID", sessionInfo("ses_seed", PROJECT_ID, { revert: { messageID: 7 } }), '.revert.messageID must be a string starting with "msg_"'],
		];
		for (const [, seed, expectedFragment] of cases) {
			const { port, getSessionRequests } = createFakeDependencyPort({
				sessionPages: [{ data: [seed] }],
				messagePages: { ses_seed: [{ data: [] }] },
			});

			const error = await expectCollectionError(
				collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() }),
				"malformed-session-record",
			);
			expect(error.message).toContain("ses_seed");
			expect(error.message).toContain(expectedFragment);
			expect(getSessionRequests).toEqual([]);
		}
	});

	test("rejects malformed references on a fetched dependency", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_ext" });
		const brokenExternal = sessionInfo("ses_ext", FOREIGN_PROJECT_ID, { parentID: 42 });
		const { port } = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: {
				ses_child: [{ data: [userMessage("msg_child")] }],
				ses_ext: [{ data: [userMessage("msg_ext")] }],
			},
			getSessionResponses: { ses_ext: brokenExternal },
		});

		await expectCollectionError(
			collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() }),
			"malformed-session-record",
		);
	});

	test("fails on unsettled messages and duplicate message ids inside a dependency", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_ext" });
		const unsettled = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: {
				ses_child: [{ data: [userMessage("msg_child")] }],
				ses_ext: [{ data: [assistantMessage("msg_ext", null)] }],
			},
			getSessionResponses: { ses_ext: sessionInfo("ses_ext", FOREIGN_PROJECT_ID) },
		});
		await expectCollectionError(
			collectCheckpointPayloadWithDependencies(unsettled.port, { projectID: PROJECT_ID, policy: policy() }),
			"unsettled-message",
		);

		const duplicated = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: {
				ses_child: [{ data: [userMessage("msg_child")] }],
				ses_ext: [{ data: [userMessage("msg_dup")], cursor: { next: "mp-2" } }, { data: [userMessage("msg_dup")] }],
			},
			getSessionResponses: { ses_ext: sessionInfo("ses_ext", FOREIGN_PROJECT_ID) },
		});
		await expectCollectionError(
			collectCheckpointPayloadWithDependencies(duplicated.port, { projectID: PROJECT_ID, policy: policy() }),
			"duplicate-message-id",
		);
	});
});

describe("collectCheckpointPayloadWithDependencies: aggregate bounds", () => {
	test("maxSessions spans seeds plus dependencies and fails before the extra get", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_ext" });
		const { port, getSessionRequests } = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: { ses_child: [{ data: [] }] },
		});

		const error = await expectCollectionError(
			collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy({ maxSessions: 1 }) }),
			"session-limit-exceeded",
		);
		expect(error.message).toContain("maxSessions=1");
		expect(error.message).toContain("ses_ext");
		// The known session bound rejected the closure before fetching the dependency.
		expect(getSessionRequests).toEqual([]);
	});

	test("maxTotalMessages spans seeds plus dependencies", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_ext" });
		const external = sessionInfo("ses_ext", FOREIGN_PROJECT_ID);
		const messagePages = {
			ses_child: [{ data: [userMessage("msg_child")] }],
			ses_ext: [{ data: [userMessage("msg_p1"), userMessage("msg_p2")] }],
		};

		const failing = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages,
			getSessionResponses: { ses_ext: external },
		});
		await expectCollectionError(
			collectCheckpointPayloadWithDependencies(failing.port, {
				projectID: PROJECT_ID,
				policy: policy({ maxTotalMessages: 1 }),
			}),
			"total-message-limit-exceeded",
		);

		const fitting = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages,
			getSessionResponses: { ses_ext: external },
		});
		const payload = await collectCheckpointPayloadWithDependencies(fitting.port, {
			projectID: PROJECT_ID,
			policy: policy({ maxTotalMessages: 3 }),
		});
		expect(payload.sessions.map((record) => record.messages.length)).toEqual([1, 2]);
	});

	test("maxMessagesPerSession is unchanged for dependency sessions", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_ext" });
		const { port } = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: {
				ses_child: [{ data: [] }],
				ses_ext: [{ data: [userMessage("msg_p1"), userMessage("msg_p2")] }],
			},
			getSessionResponses: { ses_ext: sessionInfo("ses_ext", FOREIGN_PROJECT_ID) },
		});

		await expectCollectionError(
			collectCheckpointPayloadWithDependencies(port, {
				projectID: PROJECT_ID,
				policy: policy({ maxMessagesPerSession: 1 }),
			}),
			"message-limit-exceeded",
		);
	});
});

describe("collectCheckpointPayloadWithDependencies: schema closure validation", () => {
	test("rejects a self-reference and a two-session parent/fork cycle", async () => {
		const selfReferenced = createFakeDependencyPort({
			sessionPages: [{ data: [sessionInfo("ses_seed", PROJECT_ID, { parentID: "ses_seed" })] }],
			messagePages: { ses_seed: [{ data: [] }] },
		});
		await expectCollectionError(
			collectCheckpointPayloadWithDependencies(selfReferenced.port, { projectID: PROJECT_ID, policy: policy() }),
			"malformed-session-record",
		);

		const a = sessionInfo("ses_a", PROJECT_ID, { parentID: "ses_b" });
		const b = sessionInfo("ses_b", FOREIGN_PROJECT_ID, {
			fork: { sessionID: "ses_a", boundary: { type: "through", messageID: "msg_a1" } },
		});
		const cycle = createFakeDependencyPort({
			sessionPages: [{ data: [a] }],
			messagePages: {
				ses_a: [{ data: [userMessage("msg_a1")] }],
				ses_b: [{ data: [userMessage("msg_b1")] }],
			},
			getSessionResponses: { ses_b: b },
		});
		const error = await expectCollectionError(
			collectCheckpointPayloadWithDependencies(cycle.port, { projectID: PROJECT_ID, policy: policy() }),
			"malformed-session-record",
		);
		expect(error.message).toContain("cycle");
	});

	test("rejects unresolved fork.boundary.messageID and revert.messageID references", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, {
			fork: { sessionID: "ses_ext", boundary: { type: "through", messageID: "msg_missing" } },
		});
		const boundaryCase = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: {
				ses_child: [{ data: [userMessage("msg_child")] }],
				ses_ext: [{ data: [userMessage("msg_ext")] }],
			},
			getSessionResponses: { ses_ext: sessionInfo("ses_ext", FOREIGN_PROJECT_ID) },
		});
		const boundaryError = await expectCollectionError(
			collectCheckpointPayloadWithDependencies(boundaryCase.port, { projectID: PROJECT_ID, policy: policy() }),
			"malformed-session-record",
		);
		expect(boundaryError.message).toContain("msg_missing");
		expect(boundaryError.message).toContain("unresolved schema reference");

		const revertCase = createFakeDependencyPort({
			sessionPages: [{ data: [sessionInfo("ses_seed", PROJECT_ID, { revert: { messageID: "msg_gone" } })] }],
			messagePages: { ses_seed: [{ data: [userMessage("msg_seed")] }] },
		});
		await expectCollectionError(
			collectCheckpointPayloadWithDependencies(revertCase.port, { projectID: PROJECT_ID, policy: policy() }),
			"malformed-session-record",
		);
	});

	test("accepts resolved fork boundary and revert references across the closure", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, {
			parentID: "ses_ext",
			fork: { sessionID: "ses_ext", boundary: { type: "through", messageID: "msg_p1" } },
			revert: { messageID: "msg_child" },
		});
		const external = sessionInfo("ses_ext", FOREIGN_PROJECT_ID);
		const { port } = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: {
				ses_child: [{ data: [userMessage("msg_child")] }],
				ses_ext: [{ data: [userMessage("msg_p1")] }],
			},
			getSessionResponses: { ses_ext: external },
		});

		const payload = await collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() });

		expect(payload.sessions.map((record) => record.info["id"])).toEqual(["ses_child", "ses_ext"]);
	});
});

describe("collectCheckpointPayloadWithDependencies: seed scope and project-only collector", () => {
	test("keeps the seed project binding fail-closed even when a dependency fetch could succeed", async () => {
		const foreignSeed = sessionInfo("ses_foreign", FOREIGN_PROJECT_ID);
		const { port, getSessionRequests } = createFakeDependencyPort({
			sessionPages: [{ data: [foreignSeed] }],
			messagePages: { ses_foreign: [{ data: [] }] },
		});

		const error = await expectCollectionError(
			collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() }),
			"session-project-mismatch",
		);
		expect(error.message).toContain("ses_foreign");
		expect(getSessionRequests).toEqual([]);
	});

	test("project-only collectCheckpointPayload never calls getSession and does not follow references", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_missing" });
		const { port, getSessionRequests, sessionRequests } = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: { ses_child: [{ data: [userMessage("msg_child")] }] },
		});

		const payload = await collectCheckpointPayload(port, { projectID: PROJECT_ID, policy: policy() });

		// Exact existing behavior: one project-scoped session, no dependency
		// lookup, no getSession, no reference validation.
		expect(payload.sessions.map((record) => record.info["id"])).toEqual(["ses_child"]);
		expect(sessionRequests).toEqual([{ project: PROJECT_ID, limit: 2 }]);
		expect(getSessionRequests).toEqual([]);
	});

	test("rejects invalid requests and policies before any host call", async () => {
		const { port, sessionRequests, getSessionRequests } = createFakeDependencyPort();

		await expectCollectionError(
			collectCheckpointPayloadWithDependencies(port, { projectID: "", policy: policy() }),
			"invalid-request",
		);
		await expectCollectionError(
			collectCheckpointPayloadWithDependencies(port, {
				projectID: PROJECT_ID,
				policy: policy({ maxSessions: 0 }),
			}),
			"invalid-policy",
		);
		expect(sessionRequests).toEqual([]);
		expect(getSessionRequests).toEqual([]);
	});
});

describe("collectCheckpointPayloadWithDependencies: verbatim preservation", () => {
	test("preserves dependency fields and messages verbatim as detached snapshots", async () => {
		const child = sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_ext" });
		const external = sessionInfo("ses_ext", FOREIGN_PROJECT_ID, {
			metadata: { note: "original", list: [1, null, true], nested: { deep: "value" } },
			unknownFutureField: { shape: "opaque" },
		});
		const message = userMessage("msg_ext");
		const { port } = createFakeDependencyPort({
			sessionPages: [{ data: [child] }],
			messagePages: {
				ses_child: [{ data: [] }],
				ses_ext: [{ data: [message] }],
			},
			getSessionResponses: { ses_ext: external },
		});

		const payload = await collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() });
		const dependency = payload.sessions[1]!;

		expect(dependency.info).toEqual(external);
		expect(Object.prototype.hasOwnProperty.call(dependency.info, "parentID")).toBe(false);
		expect(dependency.messages[0]).toEqual(message);

		// Detached snapshot: mutating the API-owned objects cannot change the payload.
		(external["metadata"] as Record<string, unknown>)["note"] = "mutated";
		message["text"] = "mutated";
		expect((dependency.info["metadata"] as Record<string, unknown>)["note"]).toBe("original");
		expect(dependency.messages[0]!["text"]).toBe("text msg_ext");
	});
});
