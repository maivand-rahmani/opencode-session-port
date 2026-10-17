import { describe, expect, test } from "bun:test";
import { encodeJson, snapshotJsonValue } from "../../../src/core/contracts/json.ts";

describe("JSON payload contract", () => {
	test("encodes complete nested OpenCode-shaped JSON without narrowing fields", () => {
		const payload = {
			sessions: [
				{
					info: { id: "ses_fixture", parentID: "ses_parent", fork: { sessionID: "ses_source", boundary: "msg_1" } },
					messages: [
						{ id: "msg_1", sessionID: "ses_fixture", type: "assistant", content: [{ type: "tool", id: "call_1", name: "read", state: { status: "completed" } }] },
					],
				},
			],
		};

		const bytes = encodeJson(payload);
		expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(payload);
		expect(() => snapshotJsonValue(payload)).not.toThrow();
	});

	test("rejects values JSON.stringify would silently omit or coerce", () => {
		expect(() => encodeJson({ omitted: undefined })).toThrow("Non-JSON value");
		expect(() => encodeJson({ coerced: Number.NaN })).toThrow("Non-finite number");
		expect(() => encodeJson(-0)).toThrow("Negative zero");
		expect(() => encodeJson({ unsupported: 1n })).toThrow("Non-JSON value");
		expect(() => encodeJson({ nested: () => "not data" })).toThrow("Non-JSON value");
	});

	test("rejects cyclic and sparse data rather than emitting a partial representation", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => encodeJson(cyclic)).toThrow("Cyclic value");

		const sparse = new Array(2);
		sparse[1] = "present";
		expect(() => encodeJson(sparse)).toThrow("Sparse array");
	});

	test("rejects accessors and non-plain instances", () => {
		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => "hidden" });
		expect(() => encodeJson(accessor)).toThrow("accessor property");
		expect(() => encodeJson({ date: new Date(0) })).toThrow("Non-plain object");
	});

	test("detaches source data and ignores inherited toJSON hooks", () => {
		const input = { nested: { value: 1 }, list: ["before"] };
		const snapshot = snapshotJsonValue(input);
		input.nested.value = 2;
		input.list[0] = "after";

		const priorObjectHook = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
		const priorArrayHook = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
		let bytes: Uint8Array;
		try {
			Object.defineProperty(Object.prototype, "toJSON", {
				configurable: true,
				value: () => "object-hook",
			});
			Object.defineProperty(Array.prototype, "toJSON", {
				configurable: true,
				value: () => "array-hook",
			});
			bytes = encodeJson(snapshot);
		} finally {
			if (priorObjectHook) Object.defineProperty(Object.prototype, "toJSON", priorObjectHook);
			else delete (Object.prototype as { toJSON?: unknown }).toJSON;
			if (priorArrayHook) Object.defineProperty(Array.prototype, "toJSON", priorArrayHook);
			else delete (Array.prototype as { toJSON?: unknown }).toJSON;
		}
		expect(JSON.parse(new TextDecoder().decode(bytes!))).toEqual({
			nested: { value: 1 },
			list: ["before"],
		});
	});
});
