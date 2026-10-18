/**
 * Narrow restore regression: a dependency-closure checkpoint payload plans
 * against an EMPTY destination (2026-10-18 amendment).
 *
 * Synthetic data only: an in-memory fake dependency port produces the payload
 * through `collectCheckpointPayloadWithDependencies`, and `planRestore` runs
 * with an injected deterministic test deriver. No host call, import, model, or
 * filesystem access. This pins the cross-lane contract that a payload with an
 * omitted cross-project parent/fork dependency is schema-closed for restore
 * semantics instead of failing `dangling-session-reference`.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	ARTIFACT_IDENTITY_BYTES,
	type CheckpointPayload,
	type JsonObject,
	type SessionRecord,
} from "../../../src/core/contracts/index.ts";
import {
	collectCheckpointPayloadWithDependencies,
	type MessageListPageRequest,
	type SessionCollectionPolicy,
	type SessionDependencyReadPort,
} from "../../../src/core/sessions/index.ts";
import {
	planRestore,
	type RemappedIdDeriver,
	type RestorePlan,
	type RestorePlanEntry,
} from "../../../src/core/restore/index.ts";

const IDENTITY = Uint8Array.from({ length: ARTIFACT_IDENTITY_BYTES }, (_, index) => index + 1);
const PROJECT_ID = "proj_source";
const FOREIGN_PROJECT_ID = "proj_other";

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic injected deriver; outputs are valid 68-char `ses_`/`msg_` hex IDs. */
function createTestDeriver(): RemappedIdDeriver {
	return {
		derive(namespace, artifactIdentity, originalID) {
			const prefix = namespace === "session" ? "ses_" : "msg_";
			let identityHex = "";
			for (const byte of artifactIdentity) identityHex += byte.toString(16).padStart(2, "0");
			return prefix + sha256Hex(`${namespace}|${identityHex}|${originalID}`);
		},
	};
}

const deriver = createTestDeriver();

function derivedMessageID(sourceID: string): string {
	return deriver.derive("message", IDENTITY, sourceID);
}

function sessionInfo(id: string, projectID: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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

function userMessage(id: string): JsonObject {
	return { id, type: "user", text: `text ${id}`, time: { created: 3 } };
}

/** Minimal single-page fake dependency port; only referenced IDs resolve through `getSession`. */
function createFakePort(input: {
	readonly seeds: readonly Record<string, unknown>[];
	readonly messages: Readonly<Record<string, readonly JsonObject[]>>;
	readonly dependencies: Readonly<Record<string, Record<string, unknown>>>;
}): SessionDependencyReadPort {
	return {
		async listSessions(): Promise<unknown> {
			return { data: input.seeds, cursor: null };
		},
		async listMessages(request: MessageListPageRequest): Promise<unknown> {
			const messages = input.messages[request.sessionID];
			if (messages === undefined) throw new Error(`unexpected message list for ${request.sessionID}`);
			return { data: [...messages], cursor: null };
		},
		async getSession(sessionID: string): Promise<unknown> {
			const info = input.dependencies[sessionID];
			if (info === undefined) throw new Error(`unexpected getSession for ${sessionID}`);
			return info;
		},
	};
}

function policy(): SessionCollectionPolicy {
	return {
		sessionPageSize: 10,
		messagePageSize: 10,
		maxSessions: 10,
		maxMessagesPerSession: 10,
		maxTotalMessages: 20,
	};
}

function entryFor(plan: RestorePlan, sourceSessionID: string): RestorePlanEntry {
	for (const entry of plan.entries) {
		if (entry.sourceSessionID === sourceSessionID) return entry;
	}
	throw new Error(`plan has no entry for ${sourceSessionID}`);
}

function messageIDsOf(record: SessionRecord): string[] {
	return record.messages.map((message) => message["id"] as string);
}

describe("dependency-closure payload plans against an empty destination", () => {
	test("plans parent-before-child with the omitted cross-project parent included", async () => {
		const port = createFakePort({
			seeds: [sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_parent" })],
			messages: {
				ses_child: [userMessage("msg_child")],
				ses_parent: [userMessage("msg_p1")],
			},
			dependencies: { ses_parent: sessionInfo("ses_parent", FOREIGN_PROJECT_ID) },
		});
		const payload: CheckpointPayload = await collectCheckpointPayloadWithDependencies(port, {
			projectID: PROJECT_ID,
			policy: policy(),
		});

		const plan = planRestore({
			payload,
			artifactIdentity: IDENTITY,
			destination: [],
			idDeriver: deriver,
		});

		expect(plan.entries.map((entry) => entry.sourceSessionID)).toEqual(["ses_child", "ses_parent"]);
		expect(plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_parent", "ses_child"]);
		for (const entry of plan.entries) expect(entry.classification).toBe("imported");

		const childEntry = entryFor(plan, "ses_child");
		expect(childEntry.record.info["parentID"]).toBe("ses_parent");
		expect(messageIDsOf(childEntry.record)).toEqual([derivedMessageID("msg_child")]);
		const parentEntry = entryFor(plan, "ses_parent");
		expect(messageIDsOf(parentEntry.record)).toEqual([derivedMessageID("msg_p1")]);
	});

	test("rewrites fork.sessionID and fork.boundary.messageID from the closure payload", async () => {
		const port = createFakePort({
			seeds: [
				sessionInfo("ses_child", PROJECT_ID, {
					parentID: "ses_parent",
					fork: { sessionID: "ses_parent", boundary: { type: "through", messageID: "msg_p1" } },
				}),
			],
			messages: {
				ses_child: [userMessage("msg_child")],
				ses_parent: [userMessage("msg_p1")],
			},
			dependencies: { ses_parent: sessionInfo("ses_parent", FOREIGN_PROJECT_ID) },
		});
		const payload = await collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() });

		const plan = planRestore({ payload, artifactIdentity: IDENTITY, destination: [], idDeriver: deriver });

		const childEntry = entryFor(plan, "ses_child");
		const fork = childEntry.record.info["fork"] as JsonObject;
		expect(fork["sessionID"]).toBe("ses_parent");
		expect((fork["boundary"] as JsonObject)["messageID"]).toBe(derivedMessageID("msg_p1"));
	});

	test("keeps an exactly matching local dependency as an unchanged skip and still imports the child", async () => {
		const port = createFakePort({
			seeds: [sessionInfo("ses_child", PROJECT_ID, { parentID: "ses_parent" })],
			messages: {
				ses_child: [userMessage("msg_child")],
				ses_parent: [userMessage("msg_p1")],
			},
			dependencies: { ses_parent: sessionInfo("ses_parent", FOREIGN_PROJECT_ID) },
		});
		const payload = await collectCheckpointPayloadWithDependencies(port, { projectID: PROJECT_ID, policy: policy() });

		// The destination already holds exactly the collected parent record.
		const destination = [payload.sessions.find((record) => record.info["id"] === "ses_parent")!];
		const plan = planRestore({ payload, artifactIdentity: IDENTITY, destination, idDeriver: deriver });

		const parentEntry = entryFor(plan, "ses_parent");
		expect(parentEntry.classification).toBe("skipped");
		expect(parentEntry.skipReason).toBe("exact-local-duplicate");
		const childEntry = entryFor(plan, "ses_child");
		expect(childEntry.classification).toBe("imported");
		expect(childEntry.record.info["parentID"]).toBe("ses_parent");
		expect(plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_child"]);
	});
});
