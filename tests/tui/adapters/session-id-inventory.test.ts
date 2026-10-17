/**
 * SessionPort session-ID inventory adapter tests (2026-10-14 owner-approved
 * cross-project collision amendment).
 *
 * Fake read ports only: no real host call, no message read, no filesystem,
 * crypto, or import. These tests pin the metadata-only scan, the collector's
 * known page semantics, the aggregate `maxSessions` ceiling, and the
 * fail-closed behavior for malformed/duplicate/scope/overflow/API failures.
 * No runtime, completeness, or compatibility claim follows.
 */

import { describe, expect, test } from "bun:test";
import { SessionCollectionError } from "../../../src/core/sessions/index.ts";
import type {
	MessageListPageRequest,
	SessionCollectionPolicy,
	SessionListPageRequest,
	SessionReadPort,
} from "../../../src/core/sessions/index.ts";
import { createSessionIdInventory, type SessionIdInventoryProject } from "../../../src/tui/adapters/index.ts";

/** Synthetic policy only; selects no production numeric cap (O-03 stays OPEN). */
const POLICY: SessionCollectionPolicy = {
	sessionPageSize: 2,
	messagePageSize: 5,
	maxSessions: 10,
	maxMessagesPerSession: 5,
	maxTotalMessages: 20,
};

/** One synthetic session info record with the pinned v2.0.22 required fields. */
function sessionInfo(id: string, projectID: string): Record<string, unknown> {
	return {
		id,
		projectID,
		title: `title ${id}`,
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
		time: { created: 1, updated: 2 },
		location: { directory: "C:/work/project" },
	};
}

function projects(...ids: readonly string[]): readonly SessionIdInventoryProject[] {
	return ids.map((projectID) => ({ projectID }));
}

/** One `{ data, cursor }` page; `next` is omitted when undefined. */
function page(items: readonly unknown[], next?: string): unknown {
	return { data: items, cursor: next === undefined ? null : { next } };
}

interface FakePortHandle {
	readonly port: SessionReadPort;
	readonly sessionRequests: SessionListPageRequest[];
	readonly messageRequests: MessageListPageRequest[];
}

/**
 * Fake read port: records every `listSessions` request and makes any
 * `listMessages` call fail loudly, proving the inventory is metadata-only.
 */
function createFakePort(handler: (request: SessionListPageRequest) => unknown | Promise<unknown>): FakePortHandle {
	const sessionRequests: SessionListPageRequest[] = [];
	const messageRequests: MessageListPageRequest[] = [];
	return {
		port: {
			async listSessions(request: SessionListPageRequest): Promise<unknown> {
				sessionRequests.push({ ...request });
				return handler(request);
			},
			async listMessages(request: MessageListPageRequest): Promise<unknown> {
				messageRequests.push({ ...request });
				throw new Error("message.list must never be called by the session-ID inventory");
			},
		},
		sessionRequests,
		messageRequests,
	};
}

/** Builds an inventory over the fake port with the synthetic policy by default. */
function createInventory(
	handle: FakePortHandle,
	input: {
		readonly projects?: readonly SessionIdInventoryProject[] | unknown;
		readonly selectedProjectID?: string;
		readonly policy?: SessionCollectionPolicy;
		readonly readPort?: unknown;
	} = {},
) {
	return createSessionIdInventory({
		readPort: "readPort" in input ? (input.readPort as SessionReadPort) : handle.port,
		projects: "projects" in input ? (input.projects as readonly SessionIdInventoryProject[]) : projects("proj_a"),
		selectedProjectID: input.selectedProjectID ?? "proj_a",
		policy: input.policy ?? POLICY,
	});
}

/** Captures and asserts a rejected `SessionCollectionError` (returns it for code checks). */
async function captureCollectionError(run: () => Promise<unknown>): Promise<SessionCollectionError> {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(SessionCollectionError);
		return error as SessionCollectionError;
	}
	throw new Error("expected the inventory to reject with a SessionCollectionError");
}

/* ------------------------------------------------------------------------- */
/* Bounded scan behavior                                                     */
/* ------------------------------------------------------------------------- */

describe("session-ID inventory scan", () => {
	test("pages every validated project to exhaustion in candidate order and appends the missing selected project", async () => {
		const handle = createFakePort(async (request) => {
			if (request.project === "proj_a") {
				return request.cursor === undefined
					? page([sessionInfo("ses_a1", "proj_a"), sessionInfo("ses_a2", "proj_a")], "cursor-a")
					: page([sessionInfo("ses_a3", "proj_a")]);
			}
			if (request.project === "proj_b") return page([sessionInfo("ses_b1", "proj_b")]);
			if (request.project === "proj_c") return page([sessionInfo("ses_c1", "proj_c")]);
			throw new Error(`unexpected project ${request.project}`);
		});
		const inventory = createInventory(handle, {
			projects: projects("proj_a", "proj_b"),
			selectedProjectID: "proj_c",
		});

		const ids = await inventory.readGloballyVisibleSessionIDs();

		expect(ids).toEqual(["ses_a1", "ses_a2", "ses_a3", "ses_b1", "ses_c1"]);
		expect(handle.sessionRequests).toEqual([
			{ project: "proj_a", limit: 2 },
			{ project: "proj_a", limit: 2, cursor: "cursor-a" },
			{ project: "proj_b", limit: 2 },
			{ project: "proj_c", limit: 2 },
		]);
		// The first request never carries a cursor; the page size is the
		// explicit injected policy value, never an API default.
		expect("cursor" in handle.sessionRequests[0]!).toBe(false);
		expect(handle.messageRequests).toEqual([]);
	});

	test("includes a selected project that is already a candidate exactly once", async () => {
		const handle = createFakePort(async (request) => {
			if (request.project === "proj_a") return page([sessionInfo("ses_a1", "proj_a")]);
			if (request.project === "proj_b") return page([sessionInfo("ses_b1", "proj_b")]);
			throw new Error(`unexpected project ${request.project}`);
		});
		const inventory = createInventory(handle, {
			projects: projects("proj_a", "proj_b"),
			selectedProjectID: "proj_a",
		});

		const ids = await inventory.readGloballyVisibleSessionIDs();

		expect(ids).toEqual(["ses_a1", "ses_b1"]);
		expect(handle.sessionRequests.map((request) => request.project)).toEqual(["proj_a", "proj_b"]);
	});

	test("scans only the selected project when the candidate list is empty", async () => {
		const handle = createFakePort(async (request) => {
			expect(request.project).toBe("proj_selected");
			return page([sessionInfo("ses_only", "proj_selected")]);
		});
		const inventory = createInventory(handle, { projects: [], selectedProjectID: "proj_selected" });

		expect(await inventory.readGloballyVisibleSessionIDs()).toEqual(["ses_only"]);
		expect(handle.messageRequests).toEqual([]);
	});

	test("uses the injected page size and applies maxSessions as an aggregate ceiling across projects", async () => {
		const singlePagePolicy: SessionCollectionPolicy = { ...POLICY, sessionPageSize: 1 };
		const handle = createFakePort(async (request) => {
			if (request.project === "proj_a") {
				return request.cursor === undefined
					? page([sessionInfo("ses_a1", "proj_a")], "cursor-a")
					: page([sessionInfo("ses_a2", "proj_a")]);
			}
			return page([sessionInfo("ses_b1", "proj_b")]);
		});
		const inventory = createInventory(handle, {
			projects: projects("proj_a", "proj_b"),
			selectedProjectID: "proj_a",
			policy: singlePagePolicy,
		});

		expect(await inventory.readGloballyVisibleSessionIDs()).toEqual(["ses_a1", "ses_a2", "ses_b1"]);
		expect(handle.sessionRequests.every((request) => request.limit === 1)).toBe(true);

		// Aggregate ceiling: four IDs across two projects with maxSessions=3 fails
		// closed on the fourth item instead of returning a partial inventory.
		const overflowHandle = createFakePort(async (request) =>
			request.project === "proj_a"
				? page([sessionInfo("ses_a1", "proj_a"), sessionInfo("ses_a2", "proj_a")])
				: page([sessionInfo("ses_b1", "proj_b"), sessionInfo("ses_b2", "proj_b")]),
		);
		const overflowInventory = createInventory(overflowHandle, {
			projects: projects("proj_a", "proj_b"),
			selectedProjectID: "proj_a",
			policy: { ...POLICY, maxSessions: 3 },
		});

		const error = await captureCollectionError(() => overflowInventory.readGloballyVisibleSessionIDs());
		expect(error.code).toBe("session-limit-exceeded");
	});

	test("the scan result is a fresh deterministic array per call", async () => {
		const handle = createFakePort(async () => page([sessionInfo("ses_a1", "proj_a")]));
		const inventory = createInventory(handle);

		const first = await inventory.readGloballyVisibleSessionIDs();
		const second = await inventory.readGloballyVisibleSessionIDs();

		expect(first).toEqual(["ses_a1"]);
		expect(second).toEqual(["ses_a1"]);
		expect(first).not.toBe(second);
		expect(handle.sessionRequests).toHaveLength(2);
	});
});

/* ------------------------------------------------------------------------- */
/* Input validation (before any host call)                                   */
/* ------------------------------------------------------------------------- */

describe("session-ID inventory input validation", () => {
	test("rejects malformed or duplicate project inventories before any host call", () => {
		const handle = createFakePort(async () => page([]));
		const cases: ReadonlyArray<{ readonly label: string; readonly input: Parameters<typeof createInventory>[1] }> = [
			{ label: "missing projects", input: { projects: undefined } },
			{ label: "non-array projects", input: { projects: "proj_a" } },
			{ label: "null entry", input: { projects: [null] } },
			{ label: "non-object entry", input: { projects: ["proj_a"] } },
			{ label: "missing projectID", input: { projects: [{}] } },
			{ label: "non-string projectID", input: { projects: [{ projectID: 5 }] } },
			{ label: "blank projectID", input: { projects: [{ projectID: "   " }] } },
			{ label: "duplicate projectID", input: { projects: [{ projectID: "proj_a" }, { projectID: "proj_a" }] } },
			{ label: "blank selected project", input: { selectedProjectID: "" } },
			{ label: "missing readPort", input: { readPort: undefined } },
			{ label: "readPort without listSessions", input: { readPort: { listMessages: async () => page([]) } } },
		];

		for (const testCase of cases) {
			let caught: unknown;
			try {
				createInventory(handle, testCase.input);
			} catch (error) {
				caught = error;
			}
			if (!(caught instanceof SessionCollectionError)) {
				throw new Error(`expected invalid-request for ${testCase.label}`);
			}
			expect(caught.code).toBe("invalid-request");
		}
		expect(handle.sessionRequests).toEqual([]);
	});

	test("rejects an invalid collection policy with the shared invalid-policy code", () => {
		const handle = createFakePort(async () => page([]));
		const cases: readonly SessionCollectionPolicy[] = [
			{ ...POLICY, sessionPageSize: 0 },
			{ ...POLICY, maxSessions: 0 },
			{ ...POLICY, messagePageSize: 201 },
		];
		for (const policy of cases) {
			let caught: unknown;
			try {
				createInventory(handle, { policy });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(SessionCollectionError);
			expect((caught as SessionCollectionError).code).toBe("invalid-policy");
		}
		expect(handle.sessionRequests).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- */
/* Fail-closed page and record semantics                                     */
/* ------------------------------------------------------------------------- */

describe("session-ID inventory fail-closed page semantics", () => {
	test("malformed page envelopes fail closed as malformed-session-page", async () => {
		const responses: readonly unknown[] = [
			null,
			"page",
			[],
			{},
			{ data: "not-an-array" },
			{ data: [], cursor: 5 },
			{ data: [], cursor: { next: 5 } },
			{ data: [], cursor: { next: "" } },
			{ data: [], cursor: { next: "n" } },
		];
		for (const response of responses) {
			const handle = createFakePort(async () => response);
			const inventory = createInventory(handle);
			const error = await captureCollectionError(() => inventory.readGloballyVisibleSessionIDs());
			expect(error.code).toBe("malformed-session-page");
		}
	});

	test("malformed items and non-JSON-stable records fail closed as malformed-session-record", async () => {
		const itemSets: readonly unknown[][] = [
			[null],
			[7],
			[{}],
			[{ projectID: "proj_a" }],
			[{ id: 5, projectID: "proj_a" }],
			[{ id: "", projectID: "proj_a" }],
			[{ id: "ses_a1", projectID: "proj_a", bad: undefined }],
			[{ id: "ses_a1", projectID: "proj_a", bad: () => undefined }],
		];
		for (const items of itemSets) {
			const handle = createFakePort(async () => page(items));
			const inventory = createInventory(handle);
			const error = await captureCollectionError(() => inventory.readGloballyVisibleSessionIDs());
			expect(error.code).toBe("malformed-session-record");
		}
	});

	test("missing or mismatched item project scope fails closed as session-project-mismatch", async () => {
		const itemSets: readonly unknown[][] = [
			[{ id: "ses_a1" }],
			[{ id: "ses_a1", projectID: "proj_other" }],
			[{ id: "ses_a1", projectID: 5 }],
		];
		for (const items of itemSets) {
			const handle = createFakePort(async () => page(items));
			const inventory = createInventory(handle);
			const error = await captureCollectionError(() => inventory.readGloballyVisibleSessionIDs());
			expect(error.code).toBe("session-project-mismatch");
		}
	});

	test("duplicate session IDs fail closed within one project and across projects", async () => {
		const withinProject = createFakePort(async () =>
			page([sessionInfo("ses_dup", "proj_a"), sessionInfo("ses_dup", "proj_a")]),
		);
		const withinError = await captureCollectionError(() =>
			createInventory(withinProject).readGloballyVisibleSessionIDs(),
		);
		expect(withinError.code).toBe("duplicate-session-id");

		const acrossProjects = createFakePort(async (request) =>
			page([sessionInfo("ses_dup", request.project)]),
		);
		const acrossInventory = createInventory(acrossProjects, {
			projects: projects("proj_a", "proj_b"),
			selectedProjectID: "proj_a",
		});
		const acrossError = await captureCollectionError(() => acrossInventory.readGloballyVisibleSessionIDs());
		expect(acrossError.code).toBe("duplicate-session-id");
	});

	test("repeated cursors fail closed as repeated-session-cursor", async () => {
		const handle = createFakePort(async (request) =>
			request.cursor === undefined
				? page([sessionInfo("ses_a1", "proj_a")], "cursor-loop")
				: page([sessionInfo("ses_a2", "proj_a")], "cursor-loop"),
		);
		const inventory = createInventory(handle);

		const error = await captureCollectionError(() => inventory.readGloballyVisibleSessionIDs());
		expect(error.code).toBe("repeated-session-cursor");
	});

	test("API failures are wrapped as session-list-failed with the cause preserved", async () => {
		const cause = new Error("RAW-HOST-DETAIL");
		const handle = createFakePort(async () => {
			throw cause;
		});
		const inventory = createInventory(handle);

		const error = await captureCollectionError(() => inventory.readGloballyVisibleSessionIDs());
		expect(error.code).toBe("session-list-failed");
		expect(error.cause).toBe(cause);
		// No partial ID list is ever returned: the failure rejects the call.
		expect(handle.sessionRequests).toHaveLength(1);
	});
});
