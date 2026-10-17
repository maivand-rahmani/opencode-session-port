/**
 * SessionPort TUI host import adapter tests (Phase 4, non-visual lane; `fix-51`).
 *
 * Fake public clients only: no real host calls, no imports, no filesystem, no
 * Git, no model calls. These tests validate the O-12 capability probe, O-16
 * explicit-target propagation, verbatim record pass-through, unchanged
 * host-error propagation, the `buildSessionImportCall` contract regression
 * (required public `SessionInfo` fields and settled `SessionMessageInfo`
 * variants preserved by identity; owner-selected `ses_`/`msg_` + 64 lowercase
 * hex derived-ID shapes passed through verbatim, O-22), zero inventory fetches
 * (`session.list`/`project.list` spies), and the fail-closed `invalid-response`
 * narrowing of the unwrapped import response (malformed values,
 * protocol-envelope-shaped objects, and id mismatches all reject with
 * sanitized messages).
 *
 * Evidence boundary: these are synthetic fake-client tests. They are not
 * runtime validation of a live host and make no cross-version or support claim
 * (E33 is bounded to one host/run); in particular they cannot establish why
 * the single E49 actual-TUI import call was rejected (that cause remains
 * unknown).
 */

import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../../../src/core/contracts/index.ts";
import { findUnsettledMessageReason } from "../../../src/core/sessions/index.ts";
import {
	buildSessionImportCall,
	createSessionImportAdapter,
	HostAdapterError,
	probeSessionImportCapability,
} from "../../../src/tui/adapters/index.ts";

interface FakeImportClientHandle {
	readonly client: unknown;
	readonly calls: unknown[];
	readonly hostResponse: unknown;
	/** Zero-call spies: the import adapter must never fetch inventory itself. */
	readonly sessionListCalls: unknown[];
	readonly projectListCalls: unknown[];
}

/** Valid unwrapped `SessionInfo`-shaped response matching `plannedRecord().info.id`. */
function validImportResponse(): Record<string, unknown> {
	return {
		id: "ses_source",
		projectID: "host-assigned",
		location: { directory: "C:/host-assigned" },
		title: "imported session",
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
		time: { created: 1_700_000_100_000, updated: 1_700_000_200_000 },
	};
}

/**
 * Recording fake of the public import surface; resolves with the given raw
 * response. `session.list`/`project.list` are recorded only so tests can prove
 * the import adapter never fetches inventory itself.
 */
function createFakeImportClientWithResponse(hostResponse: unknown): FakeImportClientHandle {
	const calls: unknown[] = [];
	const sessionListCalls: unknown[] = [];
	const projectListCalls: unknown[] = [];
	const client = {
		session: {
			async import(input: unknown): Promise<unknown> {
				calls.push(input);
				return hostResponse;
			},
			async list(input: unknown): Promise<unknown> {
				sessionListCalls.push(input);
				return { data: [], cursor: {} };
			},
		},
		project: {
			async list(input: unknown): Promise<unknown> {
				projectListCalls.push(input);
				return [];
			},
		},
	};
	return { client, calls, hostResponse, sessionListCalls, projectListCalls };
}

/**
 * Recording fake resolving with a valid unwrapped `SessionInfo`-shaped response
 * matching `plannedRecord().info.id`. Kept separate from
 * `createFakeImportClientWithResponse` so an explicit `undefined` response is
 * passed through instead of triggering a default parameter.
 */
function createFakeImportClient(): FakeImportClientHandle {
	return createFakeImportClientWithResponse(validImportResponse());
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

/** Async variant: awaits a rejecting adapter call and returns the `HostAdapterError`. */
async function captureRejection(run: () => Promise<unknown>): Promise<HostAdapterError> {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(HostAdapterError);
		return error as HostAdapterError;
	}
	throw new Error("expected a HostAdapterError");
}

/**
 * One 64-character lowercase hex string; `ses_`/`msg_` + this suffix is the
 * owner-selected derived-ID shape (O-22). Locally constructed fixture data
 * only: these tests validate adapter pass-through, not SessionPort's BLAKE2b
 * derivation or host acceptance (E28/E33 remain bounded evidence).
 */
const HEX64 = "0123456789abcdef".repeat(4);
const DERIVED_SESSION_ID = `ses_${HEX64}`;
const DERIVED_MESSAGE_ID = `msg_${HEX64}`;

/**
 * Planned record fixture matching the pinned public shapes: `info` carries the
 * required `SessionInfo`/`SessionImportInput.info` fields (`id`, `projectID`,
 * `location`, `cost`, `tokens`, `time`), and the messages are settled
 * `SessionMessageInfo` variants (a user text message and an assistant message
 * with `time.completed`) that the official transfer/import filter would keep.
 */
function plannedRecord(): SessionRecord {
	return {
		info: {
			id: "ses_source",
			projectID: "source-project",
			location: { directory: "C:/source-project" },
			title: "source session",
			cost: 0.25,
			tokens: { input: 120, output: 240, reasoning: 0, cache: { read: 0, write: 0 } },
			time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
		},
		messages: [
			{ id: "msg_source", type: "user", text: "hello", time: { created: 1_700_000_000_000 } },
			{
				id: "msg_source_reply",
				type: "assistant",
				agent: "build",
				model: { id: "model_1", providerID: "provider_1" },
				content: [],
				finish: "stop",
				time: { created: 1_700_000_010_000, completed: 1_700_000_020_000 },
			},
		],
	};
}

describe("probeSessionImportCapability", () => {
	test("reports available when session.import is callable, without calling it", () => {
		const { client, calls, sessionListCalls, projectListCalls } = createFakeImportClient();
		const probe = probeSessionImportCapability(client);
		expect(probe).toEqual({ available: true });
		expect(calls.length).toBe(0);
		expect(sessionListCalls.length).toBe(0);
		expect(projectListCalls.length).toBe(0);
	});

	test("reports unavailable (never throws) for absent or non-callable import", () => {
		for (const client of [
			{},
			{ session: {} },
			{ session: { import: 42 } },
			{ session: { import: null } },
			{ session: { import: "import" } },
			{ session: { import: {} } },
			null,
			undefined,
			"client",
			[],
		]) {
			const probe = probeSessionImportCapability(client);
			expect(probe.available).toBe(false);
			if (probe.available) throw new Error("unreachable");
			expect(probe.reason).toContain("session.import");
		}
	});
});

describe("createSessionImportAdapter capability detection", () => {
	test("fails closed with capability-unavailable when import is absent or not callable", () => {
		for (const client of [{}, { session: {} }, { session: { import: 42 } }, null, undefined]) {
			const error = captureHostAdapterError(() => createSessionImportAdapter(client));
			expect(error.code).toBe("capability-unavailable");
			expect(error.message).toContain("session.import");
		}
	});
});

describe("import invocation", () => {
	test("propagates the explicit caller target and the planned record verbatim", async () => {
		const { client, calls, hostResponse } = createFakeImportClient();
		const adapter = createSessionImportAdapter(client);
		const record = plannedRecord();
		const target = { directory: "C:/restore-target" };

		const result = await adapter.importSession({ record, target });

		expect(calls).toHaveLength(1);
		const call = calls[0] as { readonly info: unknown; readonly messages: unknown; readonly location: unknown };
		expect(Object.keys(call as Record<string, unknown>).sort()).toEqual(["info", "location", "messages"]);
		expect(call.info).toBe(record.info);
		expect(call.messages).toBe(record.messages);
		expect(call.location).toEqual({ directory: "C:/restore-target" });
		expect(result).toBe(hostResponse);
	});

	test("uses the caller target, never the source info.location (O-16)", async () => {
		const { client, calls } = createFakeImportClient();
		const adapter = createSessionImportAdapter(client);
		const record = plannedRecord();
		await adapter.importSession({ record, target: { directory: "D:/other-target" } });
		const call = calls[0] as { readonly info: Record<string, unknown>; readonly location: { readonly directory: string } };
		expect(call.location.directory).toBe("D:/other-target");
		expect(call.info["location"]).toEqual({ directory: "C:/source-project" });
	});

	test("does not strip or rewrite source info fields (pass-through, no preservation promise)", async () => {
		const { client, calls } = createFakeImportClient();
		const adapter = createSessionImportAdapter(client);
		const record = plannedRecord();
		await adapter.importSession({ record, target: { directory: "C:/restore-target" } });
		const call = calls[0] as { readonly info: Record<string, unknown> };
		expect(call.info["projectID"]).toBe("source-project");
		expect(call.info["id"]).toBe("ses_source");
	});

	test("propagates host rejections unchanged (no wrapping, retry, or swallowing)", async () => {
		const hostError = Object.assign(new Error("ConflictError: session already exists"), { name: "ConflictError" });
		const calls: unknown[] = [];
		const client = {
			session: {
				async import(input: unknown): Promise<unknown> {
					calls.push(input);
					throw hostError;
				},
			},
		};
		const adapter = createSessionImportAdapter(client);
		await expect(adapter.importSession({ record: plannedRecord(), target: { directory: "C:/t" } })).rejects.toBe(hostError);
		expect(calls).toHaveLength(1);
	});

	test("validates the request fail-closed before any host call", async () => {
		const { client, calls } = createFakeImportClient();
		const adapter = createSessionImportAdapter(client);
		const malformed = [
			{ record: plannedRecord() },
			{ record: plannedRecord(), target: {} },
			{ record: plannedRecord(), target: { directory: "" } },
			{ record: {}, target: { directory: "C:/t" } },
			{ record: { info: {}, messages: "nope" }, target: { directory: "C:/t" } },
			null,
		] as unknown as Parameters<typeof adapter.importSession>[0][];
		for (const request of malformed) {
			await expect(adapter.importSession(request)).rejects.toMatchObject({ code: "invalid-request" });
		}
		expect(calls.length).toBe(0);
	});

	test("does not fetch session or project inventory itself (zero-call list/project spies)", async () => {
		const { client, calls, sessionListCalls, projectListCalls } = createFakeImportClient();
		const adapter = createSessionImportAdapter(client);

		await adapter.importSession({ record: plannedRecord(), target: { directory: "C:/restore-target" } });

		expect(calls).toHaveLength(1);
		expect(sessionListCalls).toHaveLength(0);
		expect(projectListCalls).toHaveLength(0);
	});
});

describe("buildSessionImportCall contract regression", () => {
	test("preserves required source info fields and settled messages verbatim with the explicit top-level target", () => {
		const record = plannedRecord();
		const target = { directory: "D:/explicit-target" };

		const call = buildSessionImportCall({ record, target });

		expect(Object.keys(call).sort()).toEqual(["info", "location", "messages"]);
		expect(call.info).toBe(record.info);
		expect(call.messages).toBe(record.messages);
		expect(call.location).toEqual({ directory: "D:/explicit-target" });
		expect(Object.keys(call.location!).sort()).toEqual(["directory"]);

		// Required pinned `SessionInfo`/`SessionImportInput.info` fields survive verbatim.
		expect(call.info["id"]).toBe("ses_source");
		expect(call.info["projectID"]).toBe("source-project");
		expect(call.info["location"]).toEqual({ directory: "C:/source-project" });
		expect(call.info["cost"]).toBe(0.25);
		expect(call.info["tokens"]).toEqual({ input: 120, output: 240, reasoning: 0, cache: { read: 0, write: 0 } });
		expect(call.info["time"]).toEqual({ created: 1_700_000_000_000, updated: 1_700_000_060_000 });

		// Fixture messages are settled public variants the official filter would keep.
		expect(call.messages.map((message) => message["id"])).toEqual(["msg_source", "msg_source_reply"]);
		for (const message of call.messages) {
			expect(findUnsettledMessageReason(message)).toBeUndefined();
		}
	});

	test("passes valid derived ses_/msg_ + 64 lowercase hex IDs through verbatim without rewriting", async () => {
		// Fixture self-check: the constants are exactly the owner-selected derived-ID shape.
		expect(DERIVED_SESSION_ID).toMatch(/^ses_[0-9a-f]{64}$/);
		expect(DERIVED_MESSAGE_ID).toMatch(/^msg_[0-9a-f]{64}$/);

		const record: SessionRecord = {
			info: {
				id: DERIVED_SESSION_ID,
				projectID: "source-project",
				location: { directory: "C:/source-project" },
				cost: 0,
				tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
				time: { created: 1, updated: 2 },
			},
			messages: [{ id: DERIVED_MESSAGE_ID, type: "user", text: "hello", time: { created: 1 } }],
		};
		const target = { directory: "C:/restore-target" };

		const call = buildSessionImportCall({ record, target });

		expect(call.info).toBe(record.info);
		expect(call.messages).toBe(record.messages);
		expect(call.info["id"]).toBe(DERIVED_SESSION_ID);
		expect(call.messages[0]!["id"]).toBe(DERIVED_MESSAGE_ID);
		expect(call.location).toEqual({ directory: "C:/restore-target" });

		// End-to-end: the adapter forwards the derived IDs and accepts a matching echo.
		const { client, calls } = createFakeImportClientWithResponse({
			id: DERIVED_SESSION_ID,
			projectID: "host-assigned",
			location: { directory: "C:/restore-target" },
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
			time: { created: 3, updated: 4 },
		});
		const adapter = createSessionImportAdapter(client);
		const result = await adapter.importSession({ record, target });

		expect(result.id).toBe(DERIVED_SESSION_ID);
		expect(calls).toHaveLength(1);
		const sent = calls[0] as {
			readonly info: Record<string, unknown>;
			readonly messages: readonly Record<string, unknown>[];
		};
		expect(sent.info["id"]).toBe(DERIVED_SESSION_ID);
		expect(sent.messages[0]!["id"]).toBe(DERIVED_MESSAGE_ID);
	});
});

describe("import response hardening (fail closed, sanitized)", () => {
	test("resolves with the original unwrapped SessionInfo-shaped response unchanged", async () => {
		const hostResponse = validImportResponse();
		const { client, calls } = createFakeImportClientWithResponse(hostResponse);
		const adapter = createSessionImportAdapter(client);

		const result = await adapter.importSession({ record: plannedRecord(), target: { directory: "C:/restore-target" } });

		expect(result).toBe(hostResponse);
		expect(result.id).toBe("ses_source");
		expect(result.projectID).toBe("host-assigned");
		expect(result.location.directory).toBe("C:/host-assigned");
		expect(calls).toHaveLength(1);
	});

	test("accepts a host-assigned projectID and directory differing from source/target (no unproven equality)", async () => {
		const hostResponse = {
			id: "ses_source",
			projectID: "different-project",
			location: { directory: "D:/elsewhere" },
		};
		const { client } = createFakeImportClientWithResponse(hostResponse);
		const adapter = createSessionImportAdapter(client);

		const result = await adapter.importSession({ record: plannedRecord(), target: { directory: "C:/restore-target" } });

		expect(result).toBe(hostResponse);
		expect(result.projectID).toBe("different-project");
		expect(result.location.directory).toBe("D:/elsewhere");
	});

	test("rejects malformed responses with sanitized invalid-response errors", async () => {
		const malformedResponses: readonly unknown[] = [
			undefined,
			null,
			42,
			true,
			"SessionInfo",
			[],
			[{ id: "ses_source", projectID: "host-assigned", location: { directory: "C:/host-assigned" } }],
			{},
			{ id: "ses_source", projectID: "host-assigned" },
			{ id: "ses_source", projectID: "host-assigned", location: null },
			{ id: "ses_source", projectID: "host-assigned", location: "C:/host-assigned" },
			{ id: "ses_source", projectID: "host-assigned", location: {} },
			{ id: "ses_source", projectID: "host-assigned", location: { directory: "" } },
			{ id: "ses_source", projectID: "host-assigned", location: { directory: "   " } },
			{ id: "ses_source", projectID: "host-assigned", location: { directory: 7 } },
			{ id: "", projectID: "host-assigned", location: { directory: "C:/host-assigned" } },
			{ id: "   ", projectID: "host-assigned", location: { directory: "C:/host-assigned" } },
			{ id: 7, projectID: "host-assigned", location: { directory: "C:/host-assigned" } },
			{ id: "ses_source", projectID: "", location: { directory: "C:/host-assigned" } },
			{ id: "ses_source", projectID: "   ", location: { directory: "C:/host-assigned" } },
			{ id: "ses_source", projectID: 7, location: { directory: "C:/host-assigned" } },
			// Raw protocol envelope: the adapter must not unwrap `.data`.
			{ data: { id: "ses_source", projectID: "host-assigned", location: { directory: "C:/host-assigned" } } },
		];
		for (const response of malformedResponses) {
			const { client, calls } = createFakeImportClientWithResponse(response);
			const adapter = createSessionImportAdapter(client);
			const error = await captureRejection(() =>
				adapter.importSession({ record: plannedRecord(), target: { directory: "C:/restore-target" } }),
			);
			expect(error.code).toBe("invalid-response");
			expect(error.message).toContain("session.import");
			// Sanitized: no IDs, directories, or raw payload text.
			expect(error.message).not.toContain("ses_source");
			expect(error.message).not.toContain("host-assigned");
			expect(error.message).not.toContain("C:/");
			expect(calls).toHaveLength(1);
		}
	});

	test("rejects a well-shaped response whose id does not match the imported record id", async () => {
		const { client } = createFakeImportClientWithResponse({
			id: "ses_other",
			projectID: "host-assigned",
			location: { directory: "C:/host-assigned" },
		});
		const adapter = createSessionImportAdapter(client);

		const error = await captureRejection(() =>
			adapter.importSession({ record: plannedRecord(), target: { directory: "C:/restore-target" } }),
		);

		expect(error.code).toBe("invalid-response");
		expect(error.message).toContain("session.import");
		expect(error.message).not.toContain("ses_source");
		expect(error.message).not.toContain("ses_other");
		expect(error.message).not.toContain("host-assigned");
		expect(error.message).not.toContain("C:/");
	});
});
