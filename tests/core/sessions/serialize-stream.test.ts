/**
 * SessionPort core session lane — streaming payload serialization tests.
 *
 * Synthetic in-memory data only. These tests compare the incremental chunk
 * stream with the eager `serializeCheckpointPayload` bytes; they are not an
 * artifact-container test (no compression/encryption here), make no RSS or
 * host claim, and deliberately stay well under ~50 MiB of test allocations.
 */

import { describe, expect, test } from "bun:test";
import {
	serializeCheckpointPayload,
	serializeCheckpointPayloadChunks,
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

/** Payload covering escaping, BMP/astral text, lone surrogates, nulls, and number formatting. */
function escapedPayload(): CheckpointPayload {
	return {
		sessions: [
			{
				info: {
					id: "ses_escapes",
					quotes: 'he said "hi" and \\ backslash',
					newline: "line1\nline2",
					tab: "a\tb",
					controls: "\u0000\u0001\u001f\u007f",
					bmp: "café 世界 Ω",
					astral: "😀🚀",
					loneHigh: "\uD800",
					loneLow: "\uDFFF",
					nul: null,
					numbers: [0, 123, -17, 0.5, -0.25, 1e-300, 1e300, 5e-324, 1.7976931348623157e308],
					emptyArray: [],
					emptyObject: {},
					nested: { a: [1, [2, [{ x: null }]]], b: { c: [] } },
				},
				messages: [
					{
						id: "msg_escapes",
						content: [{ type: "text", text: "line1\nline2\t\\\"", emoji: "😀" }],
						nulls: [null, { n: null }],
					},
				],
			},
		],
	};
}

async function collectChunks(payload: CheckpointPayload, chunkBytes?: number): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = [];
	const options = chunkBytes === undefined ? undefined : { chunkBytes };
	for await (const chunk of serializeCheckpointPayloadChunks(payload, options)) {
		chunks.push(chunk);
	}
	return chunks;
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const chunk of chunks) length += chunk.byteLength;
	const joined = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/** Asserts exact eager-byte equality and non-empty bounded chunks; returns the chunks. */
async function expectByteExact(payload: CheckpointPayload, chunkBytes?: number): Promise<Uint8Array[]> {
	const eager = serializeCheckpointPayload(payload);
	const chunks = await collectChunks(payload, chunkBytes);
	expect(chunks.length).toBeGreaterThan(0);

	for (const chunk of chunks) {
		expect(chunk).toBeInstanceOf(Uint8Array);
		expect(chunk.byteLength).toBeGreaterThanOrEqual(1);
		if (chunkBytes !== undefined) expect(chunk.byteLength).toBeLessThanOrEqual(chunkBytes);
	}

	const joined = concatChunks(chunks);
	expect(joined.byteLength).toBe(eager.byteLength);
	expect(bytesEqual(joined, eager)).toBe(true);
	return chunks;
}

async function expectStreamTypeError(payload: unknown, chunkBytes?: number): Promise<TypeError> {
	let caught: unknown;
	try {
		const options = chunkBytes === undefined ? undefined : { chunkBytes };
		// Drain every chunk: a later record may be the one that rejects.
		for await (const _chunk of serializeCheckpointPayloadChunks(payload as CheckpointPayload, options)) {
			// Intentionally empty.
		}
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(TypeError);
	return caught as TypeError;
}

describe("serializeCheckpointPayloadChunks", () => {
	test("matches the eager sample payload byte-for-byte", async () => {
		await expectByteExact(samplePayload());
		await expectByteExact(samplePayload(), 7);
	});

	test("matches eager bytes for escaping, nested values, nulls, and number formatting", async () => {
		const payload = escapedPayload();
		for (const chunkBytes of [1, 7, 4096, undefined]) {
			await expectByteExact(payload, chunkBytes);
		}
	});

	test("preserves own-key order and extra envelope fields like eager serialization", async () => {
		const payload = {
			metadata: { note: "extra root field" },
			sessions: [
				{
					messages: [{ id: "msg_1", value: [1, { two: 2 }] }],
					info: { id: "ses_1" },
					extra: null,
				},
			],
		} as unknown as CheckpointPayload;
		await expectByteExact(payload);
		await expectByteExact(payload, 5);
	});

	test("handles null-prototype payload, session, info, message, and array objects", async () => {
		const nestedArray = Object.setPrototypeOf([1, "two"], null) as unknown[];
		const info = Object.create(null) as Record<string, unknown>;
		info["id"] = "ses_nullproto";
		info["nested"] = Object.setPrototypeOf({ deep: nestedArray }, null);

		const message = Object.create(null) as Record<string, unknown>;
		message["id"] = "msg_nullproto";
		message["content"] = Object.setPrototypeOf(["x", { y: 2 }], null);

		const messages = Object.setPrototypeOf([message], null) as unknown[];
		const session = Object.create(null) as Record<string, unknown>;
		session["info"] = info;
		session["messages"] = messages;

		const sessions = Object.setPrototypeOf([session], null) as unknown[];
		const payload = Object.create(null) as Record<string, unknown>;
		payload["sessions"] = sessions;

		for (const chunkBytes of [7, undefined]) {
			await expectByteExact(payload as unknown as CheckpointPayload, chunkBytes);
		}
	});

	test("yields non-empty chunks at or below chunkBytes 1, 7, and 4096", async () => {
		const payload = escapedPayload();
		for (const chunkBytes of [1, 7, 4096]) {
			const chunks = await expectByteExact(payload, chunkBytes);
			for (const chunk of chunks) {
				expect(chunk.byteLength).toBeGreaterThan(0);
				expect(chunk.byteLength).toBeLessThanOrEqual(chunkBytes);
			}
		}
	});

	test("defaults to 64 KiB chunks", async () => {
		const payload: CheckpointPayload = {
			sessions: [{ info: { id: "ses_default", blob: "a".repeat(200_000) }, messages: [] }],
		};
		const chunks = await expectByteExact(payload);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024);
		}
		expect(chunks.some((chunk) => chunk.byteLength === 64 * 1024)).toBe(true);
	});

	test("streams a ~2 MiB mixed ASCII/multibyte string in 4096-byte chunks", async () => {
		const longText = "abc😀é世界xyz\n\t\\\"".repeat(100_000);
		expect(longText.length).toBeGreaterThan(1_400_000);
		const payload: CheckpointPayload = {
			sessions: [{ info: { id: "ses_long", text: longText }, messages: [] }],
		};
		const chunks = await expectByteExact(payload, 4096);
		expect(chunks.length).toBeGreaterThan(100);
		for (const chunk of chunks) expect(chunk.byteLength).toBeLessThanOrEqual(4096);
	});

	test("serializes the empty payload to exactly the eager text", async () => {
		const chunks = await collectChunks({ sessions: [] });
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.byteLength).toBeGreaterThan(0);
		const text = new TextDecoder().decode(concatChunks(chunks));
		expect(text).toBe('{"sessions":[]}');
	});
});

describe("serializeCheckpointPayloadChunks rejections", () => {
	const cyclicMessage: Record<string, unknown> = { id: "msg_cycle" };
	cyclicMessage["self"] = cyclicMessage;

	const sparseArray = new Array<unknown>(3);
	sparseArray[0] = 1;

	class ClassRecord {
		readonly id = "msg_class";
	}

	const cases: ReadonlyArray<readonly [string, unknown]> = [
		["a null payload", null],
		["an array payload", []],
		["a non-array sessions value", { sessions: {} }],
		["a non-object session", { sessions: ["nope"] }],
		["a session without info", { sessions: [{ messages: [] }] }],
		["a non-object info", { sessions: [{ info: undefined, messages: [] }] }],
		["a non-array messages value", { sessions: [{ info: {}, messages: {} }] }],
		[
			"an undefined message property",
			{ sessions: [{ info: {}, messages: [{ id: "msg_undefined", value: undefined }] }] },
		],
		[
			"a function message property",
			{ sessions: [{ info: {}, messages: [{ id: "msg_function", value: () => "RAW_FUNCTION_CONTENT" }] }] },
		],
		[
			"a NaN message property",
			{ sessions: [{ info: {}, messages: [{ id: "msg_nan", value: Number.NaN }] }] },
		],
		[
			"an Infinity message property",
			{ sessions: [{ info: {}, messages: [{ id: "msg_inf", value: Number.POSITIVE_INFINITY }] }] },
		],
		[
			"a negative zero message property",
			{ sessions: [{ info: {}, messages: [{ id: "msg_negzero", value: -0 }] }] },
		],
		["a cyclic message", { sessions: [{ info: {}, messages: [cyclicMessage] }] }],
		["a class-instance message", { sessions: [{ info: {}, messages: [new ClassRecord()] }] }],
		[
			"a sparse array message property",
			{ sessions: [{ info: {}, messages: [{ id: "msg_sparse", values: sparseArray }] }] },
		],
	];

	for (const [label, payload] of cases) {
		test(`rejects ${label} with TypeError`, async () => {
			const error = await expectStreamTypeError(payload);
			expect(error.message).not.toContain("RAW_");
		});
	}

	test("rejects invalid chunkBytes values with TypeError", async () => {
		for (const chunkBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
			let caught: unknown;
			try {
				for await (const _chunk of serializeCheckpointPayloadChunks({ sessions: [] }, { chunkBytes })) {
					// Intentionally empty.
				}
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(TypeError);
		}
	});
});
