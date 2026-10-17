/**
 * SessionPort core session lane — payload serialization tests (Phase 2, lane A).
 *
 * Synthetic in-memory data only. These tests cover the shared `encodeJson`
 * boundary used by the session lane; they are not an artifact-container test
 * (no compression/encryption here) and make no checkpoint-transaction claim.
 */

import { describe, expect, test } from "bun:test";
import {
	serializeCheckpointPayload,
	type CheckpointPayload,
} from "../../../src/core/sessions/index.ts";

function samplePayload(): CheckpointPayload {
	return {
		sessions: [
			{
				info: {
					id: "ses_1",
					projectID: "proj_1",
					parentID: "ses_parent",
					fork: { sessionID: "ses_source", boundary: { type: "before", messageID: "msg_0" } },
					location: { directory: "C:/repo" },
					time: { created: 1, updated: 2 },
				},
				messages: [
					{
						id: "msg_1",
						type: "assistant",
						content: [
							{
								type: "tool",
								id: "call_1",
								name: "read",
								state: { status: "completed", input: { path: "src/index.ts" } },
							},
						],
						time: { created: 2, completed: 4 },
					},
					{
						id: "msg_2",
						type: "future-variant",
						opaque: { nested: [1, null, "x"] },
						time: { created: 5 },
					},
				],
			},
		],
	};
}

describe("serializeCheckpointPayload", () => {
	test("serializes a complete payload to detached JSON bytes", () => {
		const payload = samplePayload();
		const bytes = serializeCheckpointPayload(payload);

		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(payload);
	});

	test("rejects non-JSON-stable retained data instead of omitting or coercing it", () => {
		const payload = {
			sessions: [{ info: { ok: 1, omitted: undefined }, messages: [] }],
		} as unknown as CheckpointPayload;

		expect(() => serializeCheckpointPayload(payload)).toThrow("Non-JSON value");
	});
});
