/**
 * Incoming-reference inventory tests (`session-reference-inventory.ts`).
 *
 * Synthetic fake clients only: no live host call, no message read, no native
 * picker, no filesystem, crypto, import, or delete. These tests pin the global
 * and all-projects scan scope, complete page-following semantics, projected
 * parent/fork/revert references, unknown-JSON preservation, and fail-closed
 * incomplete results (no partial entries, no delete eligibility). No runtime
 * or cross-version claim follows.
 */

import { describe, expect, test } from "bun:test";
import {
	SessionCollectionError,
	type SessionCollectionPolicy,
} from "../../../src/core/sessions/index.ts";
import {
	createSessionReferenceInventoryPort,
	type SessionReferenceInventoryOptions,
	type SessionReferenceInventoryResult,
	type SessionReferenceInventoryScope,
} from "../../../src/tui/adapters/session-reference-inventory.ts";

/** Synthetic policy only; selects no production numeric cap (O-03 stays OPEN). */
const POLICY: SessionCollectionPolicy = {
	sessionPageSize: 2,
	messagePageSize: 5,
	maxSessions: 10,
	maxMessagesPerSession: 5,
	maxTotalMessages: 20,
};

/** One synthetic session info record with the pinned v2.0.22 required fields. */
function sessionInfo(
	id: string,
	projectID: string,
	extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		id,
		projectID,
		title: `title ${id}`,
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
		time: { created: 1, updated: 2 },
		location: { directory: "C:/work/project" },
		...extra,
	};
}

/** One `{ data, cursor }` page; `next` is omitted (null) when undefined. */
function page(items: readonly unknown[], next?: string): unknown {
	return { data: items, cursor: next === undefined ? null : { next } };
}

interface FakeListHandle {
	readonly client: unknown;
	readonly requests: unknown[];
}

/**
 * Fake public client: records every `session.list` request and fails loudly
 * if any other host surface (messages, get, import, remove) is touched.
 */
function createFakeListClient(handler: (input: unknown) => unknown | Promise<unknown>): FakeListHandle {
	const requests: unknown[] = [];
	const client = {
		session: {
			async list(input: unknown): Promise<unknown> {
				requests.push(input);
				return handler(input);
			},
			async get(): Promise<never> {
				throw new Error("session.get must never be called by the reference inventory");
			},
			async import(): Promise<never> {
				throw new Error("session.import must never be called by the reference inventory");
			},
			async remove(): Promise<never> {
				throw new Error("session.remove must never be called by the reference inventory");
			},
		},
		message: {
			async list(): Promise<never> {
				throw new Error("message.list must never be called by the reference inventory");
			},
		},
	};
	return { client, requests };
}

function createInventory(
	client: unknown,
	scope: SessionReferenceInventoryScope = { kind: "global" },
	policy: SessionCollectionPolicy = POLICY,
) {
	return createSessionReferenceInventoryPort(client, { scope, policy });
}

function expectComplete(result: SessionReferenceInventoryResult) {
	if (result.status !== "complete") {
		throw new Error(`expected a complete inventory, got ${result.reason}: ${result.detail}`);
	}
	return result;
}

function expectIncomplete(result: SessionReferenceInventoryResult, reason: string) {
	expect(result.status).toBe("incomplete");
	if (result.status !== "incomplete") throw new Error("expected an incomplete inventory");
	expect(result.reason).toBe(reason);
	expect(result.deleteEligible).toBe(false);
	expect("entries" in result).toBe(false);
	return result;
}

/* ------------------------------------------------------------------------- */
/* Global scope and complete pagination                                      */
/* ------------------------------------------------------------------------- */

describe("incoming-reference inventory global scan", () => {
	test("pages the unfiltered session.list to exhaustion and projects child, fork, revert, and unknown JSON", async () => {
		const handle = createFakeListClient((input) => {
			const cursor = (input as { readonly cursor?: string }).cursor;
			if (cursor === undefined) {
				return page(
					[
						sessionInfo("ses_child", "proj_a", {
							parentID: "ses_old",
							metadata: { nested: { unknownField: [1, true, null] } },
						}),
						sessionInfo("ses_plain", "proj_a", { revert: { messageID: "msg_1" } }),
					],
					"cursor-1",
				);
			}
			if (cursor === "cursor-1") {
				return page([
					sessionInfo("ses_fork", "proj_b", {
						fork: { sessionID: "ses_old", boundary: { messageID: "msg_0" } },
					}),
				]);
			}
			throw new Error("unexpected cursor");
		});

		const result = expectComplete(await createInventory(handle.client).readIncomingReferences());

		expect(handle.requests).toEqual([{ limit: 2 }, { limit: 2, cursor: "cursor-1" }]);
		expect(result.scope).toBe("global");
		expect(result.deleteEligible).toBe(true);
		expect(result.entries).toHaveLength(3);
		expect(result.entries.map((entry) => entry.id)).toEqual(["ses_child", "ses_plain", "ses_fork"]);

		const child = result.entries[0];
		expect(child.parentID).toBe("ses_old");
		expect("forkSessionID" in child).toBe(false);
		expect(child.revertPresent).toBe(false);
		expect(child.info["metadata"]).toEqual({ nested: { unknownField: [1, true, null] } });

		const plain = result.entries[1];
		expect("parentID" in plain).toBe(false);
		expect("forkSessionID" in plain).toBe(false);
		expect(plain.revertPresent).toBe(true);

		const fork = result.entries[2];
		expect(fork.forkSessionID).toBe("ses_old");
		expect(fork.projectID).toBe("proj_b");
		expect(fork.revertPresent).toBe(false);

		// Incoming-reference detection is the caller's projection over these fields.
		const incoming = result.entries
			.filter((entry) => entry.parentID === "ses_old" || entry.forkSessionID === "ses_old")
			.map((entry) => entry.id);
		expect(incoming).toEqual(["ses_child", "ses_fork"]);
	});

	test("accepts an empty terminal page as complete", async () => {
		const handle = createFakeListClient((input) => {
			const cursor = (input as { readonly cursor?: string }).cursor;
			if (cursor === undefined) return page([sessionInfo("ses_a", "proj_a")], "cursor-1");
			return page([]);
		});

		const result = expectComplete(await createInventory(handle.client).readIncomingReferences());
		expect(result.entries.map((entry) => entry.id)).toEqual(["ses_a"]);
		expect(handle.requests).toEqual([{ limit: 2 }, { limit: 2, cursor: "cursor-1" }]);
	});

	test("rejects a repeated cursor as incomplete with no entries", async () => {
		let pageIndex = 0;
		const handle = createFakeListClient(() => {
			pageIndex += 1;
			return page([sessionInfo(`ses_${pageIndex}`, "proj_a")], "cursor-loop");
		});

		const result = expectIncomplete(
			await createInventory(handle.client).readIncomingReferences(),
			"repeated-session-cursor",
		);
		expect(result.detail).not.toContain("cursor-loop");
		expect(handle.requests).toHaveLength(2);
	});

	test("rejects an empty page carrying a next cursor", async () => {
		const handle = createFakeListClient(() => page([], "cursor-next"));
		expectIncomplete(await createInventory(handle.client).readIncomingReferences(), "malformed-session-page");
	});

	test("rejects malformed pages on late pages without returning partial entries", async () => {
		const handle = createFakeListClient((input) => {
			const cursor = (input as { readonly cursor?: string }).cursor;
			if (cursor === undefined) return page([sessionInfo("ses_a", "proj_a")], "cursor-1");
			return { cursor: { next: "cursor-2" } };
		});

		expectIncomplete(await createInventory(handle.client).readIncomingReferences(), "malformed-session-page");
	});

	test("rejects duplicate IDs across pages without returning partial entries", async () => {
		const handle = createFakeListClient((input) => {
			const cursor = (input as { readonly cursor?: string }).cursor;
			if (cursor === undefined) return page([sessionInfo("ses_a", "proj_a")], "cursor-1");
			return page([sessionInfo("ses_a", "proj_b")]);
		});

		expectIncomplete(await createInventory(handle.client).readIncomingReferences(), "duplicate-session-id");
	});

	test("rejects a declared-info record with a throwing getter with a fixed redacted reason", async () => {
		const hostile = sessionInfo("ses_hostile", "proj_a");
		Object.defineProperty(hostile, "title", {
			enumerable: true,
			get(): never {
				throw new Error("host-secret-getter-value");
			},
		});
		const handle = createFakeListClient(() => page([hostile]));

		const result = expectIncomplete(
			await createInventory(handle.client).readIncomingReferences(),
			"malformed-session-record",
		);
		expect(result.detail).not.toContain("host-secret-getter-value");
	});

	test("rejects missing IDs and project IDs as malformed records", async () => {
		for (const badInfo of [{ projectID: "proj_a" }, { id: "ses_a" }, { id: "", projectID: "proj_a" }]) {
			const handle = createFakeListClient(() => page([badInfo]));
			expectIncomplete(await createInventory(handle.client).readIncomingReferences(), "malformed-session-record");
		}
	});

	test("rejects a list failure with a fixed redacted result", async () => {
		const hostSecret = "host-list-failure-secret";
		const handle = createFakeListClient(() => {
			throw new Error(hostSecret);
		});
		const result = expectIncomplete(
			await createInventory(handle.client).readIncomingReferences(),
			"session-list-failed",
		);
		expect(JSON.stringify(result)).not.toContain(hostSecret);
	});

	test("reports a missing session.list as typed capability-unavailable, not a throw", async () => {
		const result = expectIncomplete(
			await createInventory({ session: {} }).readIncomingReferences(),
			"capability-unavailable",
		);
		expect(result.scope).toBe("global");
	});

	test("fails closed when the explicit maxSessions bound is exceeded", async () => {
		const handle = createFakeListClient(() =>
			page([sessionInfo("ses_a", "proj_a"), sessionInfo("ses_b", "proj_a")]),
		);
		const result = expectIncomplete(
			await createInventory(handle.client, { kind: "global" }, { ...POLICY, maxSessions: 1 }).readIncomingReferences(),
			"session-limit-exceeded",
		);
		expect(result.detail).not.toContain("ses_");
	});

	test("rejects every unrecognized known-reference shape instead of ignoring it", async () => {
		const cases: readonly Record<string, unknown>[] = [
			{ parentID: 42 },
			{ parentID: null },
			{ parentID: "" },
			{ fork: "ses_old" },
			{ fork: { boundary: {} } },
			{ fork: { sessionID: 42 } },
			{ revert: "staged" },
		];
		for (const extra of cases) {
			const handle = createFakeListClient(() => page([sessionInfo("ses_a", "proj_a", extra)]));
			expectIncomplete(await createInventory(handle.client).readIncomingReferences(), "unknown-reference-shape");
		}
	});
});

/* ------------------------------------------------------------------------- */
/* All-project scope                                                         */
/* ------------------------------------------------------------------------- */

describe("incoming-reference inventory all-projects scan", () => {
	test("pages every explicitly listed project and marks the completed scan delete-eligible", async () => {
		const handle = createFakeListClient((input) => {
			const request = input as { readonly project?: string; readonly cursor?: string };
			if (request.project === "proj_a") return page([sessionInfo("ses_a", "proj_a")]);
			if (request.project === "proj_b") return page([sessionInfo("ses_b", "proj_b", { parentID: "ses_a" })]);
			throw new Error("unexpected project filter");
		});

		const result = expectComplete(
			await createInventory(handle.client, { kind: "all-projects", projectIDs: ["proj_a", "proj_b"] }).readIncomingReferences(),
		);
		expect(handle.requests).toEqual([
			{ project: "proj_a", limit: 2 },
			{ project: "proj_b", limit: 2 },
		]);
		expect(result.scope).toBe("all-projects");
		expect(result.deleteEligible).toBe(true);
		expect(result.entries.map((entry) => entry.id)).toEqual(["ses_a", "ses_b"]);
	});

	test("rejects a record returned outside the requested project scope", async () => {
		const handle = createFakeListClient(() => page([sessionInfo("ses_a", "proj_other")]));
		expectIncomplete(
			await createInventory(handle.client, { kind: "all-projects", projectIDs: ["proj_a"] }).readIncomingReferences(),
			"session-project-mismatch",
		);
	});

	test("rejects duplicate IDs across projects", async () => {
		const handle = createFakeListClient((input) => {
			const request = input as { readonly project: string };
			return page([sessionInfo("ses_shared", request.project)]);
		});
		expectIncomplete(
			await createInventory(handle.client, { kind: "all-projects", projectIDs: ["proj_a", "proj_b"] }).readIncomingReferences(),
			"duplicate-session-id",
		);
	});

	test("rejects an empty, duplicate, or single-project scope at construction", () => {
		const client = createFakeListClient(() => page([])).client;
		const invalidScopes: readonly unknown[] = [
			{ kind: "all-projects", projectIDs: [] },
			{ kind: "all-projects", projectIDs: ["proj_a", "proj_a"] },
			{ kind: "all-projects", projectIDs: [""] },
			{ kind: "project", projectID: "proj_a" },
			{ kind: "global", projectID: "proj_a" },
			undefined,
		];
		for (const scope of invalidScopes) {
			expect(() =>
				createSessionReferenceInventoryPort(client, {
					scope: scope as SessionReferenceInventoryOptions["scope"],
					policy: POLICY,
				}),
			).toThrow(SessionCollectionError);
		}
	});

	test("rejects an invalid policy at construction", () => {
		const client = createFakeListClient(() => page([])).client;
		expect(() =>
			createSessionReferenceInventoryPort(client, {
				scope: { kind: "global" },
				policy: { ...POLICY, sessionPageSize: 0 },
			}),
		).toThrow(SessionCollectionError);
	});
});
