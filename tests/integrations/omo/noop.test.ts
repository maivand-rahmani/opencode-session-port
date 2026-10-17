import { describe, expect, test } from "bun:test";
import { createOmoAdapter } from "../../../src/integrations/omo/index.ts";

describe("OMO V1 no-op adapter", () => {
	test("transfers no OMO payload and reports why", async () => {
		const adapter = createOmoAdapter();
		const [capture, restore] = await Promise.all([adapter.capture(), adapter.restore()]);
		expect(capture).toEqual({ status: "no-op", reason: "no-public-session-transfer-api" });
		expect(restore).toEqual({ status: "no-op", reason: "no-public-session-transfer-api" });
		expect("data" in capture).toBe(false);
	});
});
