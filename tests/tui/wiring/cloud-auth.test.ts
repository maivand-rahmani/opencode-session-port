import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin/tui";
import {
	createSessionPortCloudAuth,
	parseCloudAuthSyncAction,
} from "../../../src/tui/wiring/cloud-auth.ts";

function fakeContext(options: {
	readonly cloud?: unknown;
	readonly throwOnOptions?: boolean;
}) {
	let optionReads = 0;
	const calls: string[] = [];
	const context = {
		get options() {
			optionReads += 1;
			if (options.throwOnOptions) {
				throw new Error("SECRET OPTIONS DETAIL");
			}
			return options.cloud === undefined
				? {}
				: { sessionportCloud: options.cloud };
		},
		ui: {
			dialog: {
				select: async () => {
					calls.push("select");
					return undefined;
				},
				alert: async (value: { message: string }) => {
					calls.push(`alert:${value.message}`);
				},
				confirm: async () => true,
				clear() {},
				set() {},
				show() {},
			},
			toast: {
				show(value: { message: string }) {
					calls.push(`toast:${value.message}`);
				},
			},
		},
		theme: {},
	} as unknown as Plugin.Context;

	return {
		context,
		calls,
		get optionReads(): number {
			return optionReads;
		},
	};
}

describe("cloud auth /sync parsing", () => {
	test("empty input is usage; only exact login/status/logout actions pass", () => {
		expect(parseCloudAuthSyncAction(undefined)).toBe("usage");
		expect(parseCloudAuthSyncAction("")).toBe("usage");
		expect(parseCloudAuthSyncAction("  \t ")).toBe("usage");
		expect(parseCloudAuthSyncAction(" login ")).toBe("login");
		expect(parseCloudAuthSyncAction("status")).toBe("status");
		expect(parseCloudAuthSyncAction("logout")).toBe("logout");
	});

	test("unknown, future, nested, and non-ASCII input is unsupported", () => {
		for (const raw of [
			"enable",
			"disable",
			"now",
			"login now",
			"status/extra",
			"LOGIN",
			"login\u0000",
			"\u00a0login",
			"login\u00e9",
		]) {
			expect(parseCloudAuthSyncAction(raw)).toBe("unsupported");
		}
	});
});

describe("cloud auth wiring lifetime", () => {
	test("constructs no controller and reads no options until an action", async () => {
		const fake = fakeContext({ cloud: undefined });
		const handlers = createSessionPortCloudAuth(fake.context);

		expect(fake.optionReads).toBe(0);
		await handlers.sync("");
		expect(fake.optionReads).toBe(0);
		expect(fake.calls).toEqual(["select"]);

		const first = await handlers.sync("login");
		expect(first).toBeUndefined(); // sync is a command handler, not an outcome API
		expect(fake.optionReads).toBe(1);
		expect(fake.calls.some((entry) => entry.startsWith("alert:"))).toBe(true);

		await handlers.sync("status");
		expect(fake.optionReads).toBe(1); // the one controller is cached
	});

	test("throwing/malformed options stay fixed and never reach checkpoint registration", async () => {
		const throwing = fakeContext({ throwOnOptions: true });
		const throwingHandlers = createSessionPortCloudAuth(throwing.context);
		await expect(throwingHandlers.sync("login")).resolves.toBeUndefined();
		expect(throwing.calls.join(" ")).not.toContain("SECRET");
		expect(throwing.optionReads).toBe(1);

		const malformed = fakeContext({ cloud: { origin: 1 } });
		const malformedHandlers = createSessionPortCloudAuth(malformed.context);
		await expect(malformedHandlers.sync("login")).resolves.toBeUndefined();
		expect(malformed.optionReads).toBe(1);
		expect(malformed.calls.join(" ")).not.toContain("origin");
	});

	test("unsupported actions report fixed copy without reading options", async () => {
		const fake = fakeContext({ cloud: undefined });
		const handlers = createSessionPortCloudAuth(fake.context);

		await handlers.sync("enable now");
		expect(fake.optionReads).toBe(0);
		expect(fake.calls).toEqual([
			"alert:Unsupported /sync action. Use login, status, or logout.",
		]);
	});

	test("dispose is idempotent at the wiring boundary", async () => {
		const fake = fakeContext({ cloud: undefined });
		const handlers = createSessionPortCloudAuth(fake.context);
		await handlers.dispose();
		await handlers.dispose();
		expect(await handlers.login()).toEqual({ status: "unavailable" });
	});
});
