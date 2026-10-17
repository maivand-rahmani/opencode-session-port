/**
 * SessionPort TUI host adapter receiver-binding regression tests (`fix-51`
 * follow-up; independent Oracle review of detached invocation).
 *
 * `resolveUnaryMethod` resolves a host method once and invokes it through a
 * wrapper. These tests use receiver-dependent fakes (`this` is checked inside
 * every method) that fail if the wrapper drops the owning `session`/`message`
 * object, pinning the contract that the wrapper must invoke a host method with
 * the exact receiver a direct `client.session.list(...)` /
 * `client.message.list(...)` / `client.session.import(...)` call would supply.
 * Inputs and host-error identity are asserted alongside, and a self-check test
 * proves the fakes really do fail when detached, so this suite cannot pass
 * vacuously.
 *
 * The installed v2.0.22 generated promise client happens to build these
 * methods as arrow closures over its transport, so no live-host regression is
 * observable today; these synthetic fakes pin the contract the wrapper must
 * keep for any receiver-dependent implementation (class method, prototype
 * method, or non-arrow object property).
 *
 * Fake clients only: no real host calls, no imports, no filesystem, no Git,
 * no model calls.
 */

import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../../../src/core/contracts/index.ts";
import { resolveUnaryMethod } from "../../../src/tui/adapters/host-client.ts";
import {
	createSessionImportAdapter,
	createSessionReadAdapter,
	probeSessionImportCapability,
} from "../../../src/tui/adapters/index.ts";

/** Distinctive message thrown by the fakes when `this` is not the owning object. */
const DETACHED = "invoked without its owning object as receiver";

interface ReceiverDependentReadOwner {
	readonly ownerTag: string;
	list(input: unknown): Promise<unknown>;
}

interface ReceiverDependentReadClientOptions {
	readonly sessionListError?: unknown;
	readonly messageListError?: unknown;
}

interface ReceiverDependentReadClientHandle {
	readonly client: unknown;
	readonly session: ReceiverDependentReadOwner;
	readonly message: ReceiverDependentReadOwner;
	readonly sessionListCalls: unknown[];
	readonly messageListCalls: unknown[];
}

/**
 * Read-surface fake whose `session.list` / `message.list` verify `this` is the
 * exact owning object before recording the input. Detached invocation throws a
 * distinctive error instead of silently working, so the adapter tests below
 * fail if the wrapper loses the receiver.
 */
function createReceiverDependentReadClient(
	options: ReceiverDependentReadClientOptions = {},
): ReceiverDependentReadClientHandle {
	const sessionListCalls: unknown[] = [];
	const messageListCalls: unknown[] = [];
	const session: ReceiverDependentReadOwner = {
		ownerTag: "session-owner",
		async list(input: unknown): Promise<unknown> {
			if (this !== session || this.ownerTag !== "session-owner") {
				throw new Error(`session.list ${DETACHED}`);
			}
			sessionListCalls.push(input);
			if (options.sessionListError !== undefined) throw options.sessionListError;
			return { data: [], cursor: {} };
		},
	};
	const message: ReceiverDependentReadOwner = {
		ownerTag: "message-owner",
		async list(input: unknown): Promise<unknown> {
			if (this !== message || this.ownerTag !== "message-owner") {
				throw new Error(`message.list ${DETACHED}`);
			}
			messageListCalls.push(input);
			if (options.messageListError !== undefined) throw options.messageListError;
			return { data: [], cursor: {} };
		},
	};
	return { client: { session, message }, session, message, sessionListCalls, messageListCalls };
}

interface ReceiverDependentImportOwner {
	readonly ownerTag: string;
	import(input: unknown): Promise<unknown>;
}

interface ReceiverDependentImportClientOptions {
	readonly hostResponse?: unknown;
	readonly hostError?: unknown;
}

interface ReceiverDependentImportClientHandle {
	readonly client: unknown;
	readonly session: ReceiverDependentImportOwner;
	readonly calls: unknown[];
}

/**
 * Import-surface fake whose `session.import` verifies `this` is the exact
 * owning object before recording the input and before throwing any scripted
 * host error, so host-error identity is only observable when the receiver was
 * correct.
 */
function createReceiverDependentImportClient(
	options: ReceiverDependentImportClientOptions = {},
): ReceiverDependentImportClientHandle {
	const calls: unknown[] = [];
	const session: ReceiverDependentImportOwner = {
		ownerTag: "session-owner",
		async import(input: unknown): Promise<unknown> {
			if (this !== session || this.ownerTag !== "session-owner") {
				throw new Error(`session.import ${DETACHED}`);
			}
			calls.push(input);
			if (options.hostError !== undefined) throw options.hostError;
			return options.hostResponse;
		},
	};
	return { client: { session }, session, calls };
}

function plannedRecord(): SessionRecord {
	return {
		info: {
			id: "ses_source",
			projectID: "source-project",
			location: { directory: "C:/source-project" },
			title: "source session",
		},
		messages: [{ id: "msg_source", type: "user", text: "hello", time: { created: 1 } }],
	};
}

describe("harness self-check: receiver-dependent fakes fail when detached", () => {
	test("detached session.list, message.list, and session.import all reject", async () => {
		const { session, message } = createReceiverDependentReadClient();
		const { session: importOwner } = createReceiverDependentImportClient();

		const detachedSessionList = session.list;
		const detachedMessageList = message.list;
		const detachedImport = importOwner.import;

		await expect(detachedSessionList({ project: "proj_1", limit: 1 })).rejects.toThrow(DETACHED);
		await expect(detachedMessageList({ sessionID: "ses_1", limit: 1, order: "asc" })).rejects.toThrow(DETACHED);
		await expect(detachedImport({ info: {}, messages: [] })).rejects.toThrow(DETACHED);
	});
});

describe("resolveUnaryMethod receiver preservation (unit)", () => {
	test("invokes the method with the exact container object as receiver", async () => {
		const owner = {
			ownerTag: "unit-owner",
			async run(input: unknown): Promise<unknown> {
				if (this !== owner) throw new Error(`unit run ${DETACHED}`);
				return { input, ownerTag: this.ownerTag };
			},
		};
		const call = resolveUnaryMethod<{ readonly value: number }>({ container: owner }, "container", "run");
		expect(call).toBeDefined();
		await expect(call!({ value: 7 })).resolves.toEqual({ input: { value: 7 }, ownerTag: "unit-owner" });
	});

	test("keeps the narrow boundary: non-callable members still resolve to undefined", () => {
		expect(resolveUnaryMethod({ container: { run: 42 } }, "container", "run")).toBeUndefined();
		expect(resolveUnaryMethod({ container: { run: null } }, "container", "run")).toBeUndefined();
		expect(resolveUnaryMethod({ container: "not-an-object" }, "container", "run")).toBeUndefined();
	});
});

describe("receiver-dependent read methods through createSessionReadAdapter", () => {
	test("session.list and message.list keep their owning objects, with inputs unchanged", async () => {
		const { client, sessionListCalls, messageListCalls } = createReceiverDependentReadClient();
		const port = createSessionReadAdapter(client);

		await port.listSessions({ project: "proj_1", limit: 2 });
		await port.listSessions({ project: "proj_1", limit: 2, cursor: "sp-2" });
		await port.listMessages({ sessionID: "ses_1", limit: 3, order: "asc" });
		await port.listMessages({ sessionID: "ses_1", limit: 3, cursor: "mp-2" });

		expect(sessionListCalls).toEqual([
			{ project: "proj_1", limit: 2 },
			{ project: "proj_1", limit: 2, cursor: "sp-2" },
		]);
		expect(messageListCalls).toEqual([
			{ sessionID: "ses_1", limit: 3, order: "asc" },
			{ sessionID: "ses_1", limit: 3, cursor: "mp-2" },
		]);
	});

	test("propagates host errors unchanged from receiver-dependent read methods", async () => {
		const sessionListError = Object.assign(new Error("session list rejected"), { name: "HostApiError", status: 500 });
		const messageListError = Object.assign(new Error("message list rejected"), { name: "HostApiError", status: 500 });
		const { client } = createReceiverDependentReadClient({ sessionListError, messageListError });
		const port = createSessionReadAdapter(client);

		await expect(port.listSessions({ project: "proj_1", limit: 1 })).rejects.toBe(sessionListError);
		await expect(port.listMessages({ sessionID: "ses_1", limit: 1, order: "asc" })).rejects.toBe(messageListError);
	});
});

describe("receiver-dependent session.import through the import adapter", () => {
	test("session.import keeps its owning object, with payload verbatim and response unchanged", async () => {
		// Valid unwrapped response matching `plannedRecord().info.id` and carrying
		// the fields the adapter re-proves (`id`, `projectID`, `location.directory`).
		const hostResponse = { id: "ses_source", projectID: "host-assigned", location: { directory: "C:/host-assigned" } };
		const { client, calls } = createReceiverDependentImportClient({ hostResponse });
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

	test("propagates host errors unchanged from a receiver-dependent session.import", async () => {
		const hostError = Object.assign(new Error("ConflictError: session already exists"), { name: "ConflictError" });
		const { client, calls } = createReceiverDependentImportClient({ hostError });
		const adapter = createSessionImportAdapter(client);

		await expect(adapter.importSession({ record: plannedRecord(), target: { directory: "C:/t" } })).rejects.toBe(hostError);
		expect(calls).toHaveLength(1);
	});

	test("probeSessionImportCapability reports available without invoking the method", () => {
		const { client, calls } = createReceiverDependentImportClient({ hostResponse: { id: "unused" } });
		expect(probeSessionImportCapability(client)).toEqual({ available: true });
		expect(calls.length).toBe(0);
	});
});
