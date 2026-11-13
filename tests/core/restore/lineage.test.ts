import { describe, expect, test } from "bun:test";
import type { JsonObject, SessionRecord } from "../../../src/core/contracts/index.ts";
import {
	fingerprintSessionContent,
	fingerprintSessionLineageInfo,
	fingerprintSessionMessages,
	readLineageID,
	sessionLineageID,
	SESSIONPORT_METADATA_KEY,
	stampSessionLineage,
} from "../../../src/core/restore/index.ts";

function record(
	id: string,
	messageIDs: readonly string[],
	infoExtra: Record<string, unknown> = {},
	metadata?: unknown,
): SessionRecord {
	return {
		info: {
			id,
			projectID: "proj_a",
			title: "Title",
			time: { created: 1, updated: 2 },
			...(metadata !== undefined ? { metadata } : {}),
			...infoExtra,
		} as unknown as JsonObject,
		messages: messageIDs.map(
			(messageID) =>
				({
					id: messageID,
					role: "user",
					text: `text ${messageID}`,
					time: { created: 1 },
				}) as unknown as JsonObject,
		),
	};
}

describe("lineage metadata", () => {
	test("reads only a valid versioned stamp", () => {
		const valid = stampSessionLineage(record("ses_a", ["msg_1"]), "ses_a");
		expect(readLineageID(valid.info)).toBe("ses_a");

		expect(readLineageID(record("ses_a", [], {}, undefined).info)).toBeUndefined();
		expect(readLineageID(record("ses_a", [], {}, { [SESSIONPORT_METADATA_KEY]: { version: 2, lineageID: "x" } }).info)).toBeUndefined();
		expect(readLineageID(record("ses_a", [], {}, { [SESSIONPORT_METADATA_KEY]: { version: 1, lineageID: "bad id" } }).info)).toBeUndefined();
		expect(readLineageID(record("ses_a", [], {}, "not-an-object").info)).toBeUndefined();
	});

	test("an unstamped record belongs to its own session ID", () => {
		expect(sessionLineageID(record("ses_a", []))).toBe("ses_a");
		expect(sessionLineageID(stampSessionLineage(record("ses_b", []), "ses_origin"))).toBe("ses_origin");
	});

	test("stamping preserves unrelated metadata and never overwrites a valid stamp", () => {
		const original = record("ses_a", ["msg_1"], {}, { topic: "kept", nested: { alpha: 1 } });
		const stamped = stampSessionLineage(original, "ses_origin");
		expect(stamped.info["metadata"]).toEqual({
			topic: "kept",
			nested: { alpha: 1 },
			[SESSIONPORT_METADATA_KEY]: { version: 1, lineageID: "ses_origin" },
		});
		// Caller input is detached.
		expect(original.info["metadata"]).toEqual({ topic: "kept", nested: { alpha: 1 } });

		const twice = stampSessionLineage(stamped, "ses_other");
		expect(readLineageID(twice.info)).toBe("ses_origin");
	});

	test("malformed metadata is preserved instead of replaced", () => {
		const malformed = record("ses_a", [], {}, "opaque");
		const stamped = stampSessionLineage(malformed, "ses_a");
		expect(stamped.info["metadata"]).toBe("opaque");
		expect(readLineageID(stamped.info)).toBeUndefined();
	});

	test("content fingerprint ignores the lineage stamp but keeps other metadata", () => {
		const plain = record("ses_a", ["msg_1"], { title: "T" }, { topic: "same" });
		const stamped = stampSessionLineage(plain, "ses_a");
		expect(fingerprintSessionContent(stamped)).toBe(fingerprintSessionContent(plain));

		const differentMetadata = record("ses_a", ["msg_1"], { title: "T" }, { topic: "different" });
		expect(fingerprintSessionContent(differentMetadata)).not.toBe(fingerprintSessionContent(plain));
	});
});

describe("lineage info and message fingerprints", () => {
	test("usage counters and volatile time do not make a continuation a conflict", () => {
		const base = record("ses_a", ["msg_1"], { cost: 0, tokens: { input: 0 } });
		const continued = record("ses_a", ["msg_1"], {
			cost: 12,
			tokens: { input: 900 },
			time: { created: 1, updated: 999 },
		});
		expect(fingerprintSessionLineageInfo(continued)).toBe(fingerprintSessionLineageInfo(base));
	});

	test("meaningful info changes are significant", () => {
		const base = record("ses_a", ["msg_1"], { title: "Title" });
		const renamed = record("ses_a", ["msg_1"], { title: "Renamed" });
		const otherMetadata = record("ses_a", ["msg_1"], { title: "Title" }, { topic: "x" });
		expect(fingerprintSessionLineageInfo(renamed)).not.toBe(fingerprintSessionLineageInfo(base));
		expect(fingerprintSessionLineageInfo(otherMetadata)).not.toBe(fingerprintSessionLineageInfo(base));
	});

	test("lineage stamp itself is not part of the info fingerprint", () => {
		const base = record("ses_a", ["msg_1"], { title: "Title" });
		expect(fingerprintSessionLineageInfo(stampSessionLineage(base, "ses_a"))).toBe(
			fingerprintSessionLineageInfo(base),
		);
	});

	test("message fingerprints ignore IDs and preserve content changes", () => {
		const first = record("ses_a", ["msg_1", "msg_2"]);
		const renamedIDs = record("ses_b", ["msg_9", "msg_8"]);
		// Rename only the IDs, keep the bodies.
		renamedIDs.messages[0]!["text"] = "text msg_1";
		renamedIDs.messages[1]!["text"] = "text msg_2";
		expect(fingerprintSessionMessages(renamedIDs)).toEqual(fingerprintSessionMessages(first));

		const changed = record("ses_a", ["msg_1", "msg_2"]);
		changed.messages[1]!["text"] = "different";
		expect(fingerprintSessionMessages(changed)[1]).not.toBe(fingerprintSessionMessages(first)[1]);
	});
});
