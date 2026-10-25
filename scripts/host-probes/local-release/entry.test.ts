import { describe, expect, test } from "bun:test";
import type { SessionDependencyReadPort } from "../../../src/tui/adapters/index.ts";
import type { SessionCollectionPolicy } from "../../../src/core/sessions/index.ts";
import {
	isExplicit404,
	makeFlowPassword,
	patchSucceeded,
	readExactRecord,
} from "./entry.ts";

const POLICY: SessionCollectionPolicy = {
	sessionPageSize: 10,
	messagePageSize: 10,
	maxSessions: 10,
	maxMessagesPerSession: 10,
	maxTotalMessages: 20,
};

function port(overrides: Partial<SessionDependencyReadPort> = {}): SessionDependencyReadPort {
	const base: SessionDependencyReadPort = {
		async listSessions() {
			throw new Error("not used");
		},
		async listMessages(request) {
			return { data: [{ id: "msg_one", type: "user", text: "one", time: { created: 1 } }], cursor: null };
		},
		async getSession() {
			return { id: "ses_one", projectID: "proj", title: "one", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 }, location: { directory: "/work" } };
		},
	};
	return { ...base, ...overrides };
}

describe("local-release probe guards", () => {
	test("only explicit 404 is absence", () => {
		expect(isExplicit404({ status: 404 })).toBe(true);
		expect(isExplicit404({ status: 500 })).toBe(false);
		expect(isExplicit404({ code: "404" })).toBe(false);
		expect(isExplicit404(new Error("unavailable"))).toBe(false);
		expect(isExplicit404(null)).toBe(false);
	});

	test("exact read maps 404 to undefined and never calls message.list", async () => {
		let messageCalls = 0;
		const fake = port({
			async getSession() {
				throw Object.assign(new Error("not found"), { status: 404 });
			},
			async listMessages() {
				messageCalls += 1;
				return { data: [], cursor: null };
			},
		});
		expect(await readExactRecord(fake, "ses_missing", POLICY)).toBeUndefined();
		expect(messageCalls).toBe(0);
	});

	test("exact read fails closed on 500 and unavailable capability", async () => {
		const unavailable = port({
			async getSession() {
				throw Object.assign(new Error("unavailable"), { status: 500 });
			},
		});
		await expect(readExactRecord(unavailable, "ses_one", POLICY)).rejects.toThrow("unavailable");

		let messageCalls = 0;
		const noRead = port({
			async getSession() {
				return { id: "ses_one" };
			},
			async listMessages() {
				messageCalls += 1;
				throw new Error("message list unavailable");
			},
		});
		await expect(readExactRecord(noRead, "ses_one", POLICY)).rejects.toThrow("message list unavailable");
		expect(messageCalls).toBe(1);
	});

	test("exact read returns the full record on success", async () => {
		const record = await readExactRecord(port(), "ses_one", POLICY);
		expect(record?.info["id"]).toBe("ses_one");
		expect(record?.messages).toHaveLength(1);
	});

	test("flow password is an independent copy and its wipe does not touch the base", () => {
		const base = Uint8Array.of(1, 2, 3);
		const flow = makeFlowPassword(base);
		expect(flow).not.toBe(base);
		expect([...flow]).toEqual([...base]);
		flow.fill(0);
		expect([...base]).toEqual([1, 2, 3]);
	});

	test("PATCH success accepts exactly 200 or 204", () => {
		expect(patchSucceeded(200)).toBe(true);
		expect(patchSucceeded(204)).toBe(true);
		expect(patchSucceeded(201)).toBe(false);
		expect(patchSucceeded(500)).toBe(false);
	});
});
