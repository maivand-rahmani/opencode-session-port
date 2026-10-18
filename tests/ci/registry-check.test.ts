import { describe, expect, test } from "bun:test";
import { checkVersionAbsent, classifyRegistryResponse } from "../../scripts/ci/registry-check.mjs";

/**
 * Synthetic tests for the fail-closed npm version existence check. The fetch
 * implementation is injected — no network access, no installs.
 */

type FetchLike = (url: string, init: any) => Promise<any>;

function jsonResponse(status: number, body: unknown): FetchLike {
	return async () => ({ status, text: async () => JSON.stringify(body) });
}

describe("classifyRegistryResponse", () => {
	test("200 with a version document means the version exists", () => {
		expect(classifyRegistryResponse(200, JSON.stringify({ name: "pkg", version: "0.2.0" }))).toEqual({ kind: "exists" });
	});
	test("200 without a valid version document is an error, not absence", () => {
		expect(classifyRegistryResponse(200, "not json").kind).toBe("error");
		expect(classifyRegistryResponse(200, JSON.stringify({})).kind).toBe("error");
	});
	test("404 with the npm version-not-found body is the only accepted absence", () => {
		expect(classifyRegistryResponse(404, JSON.stringify({ error: "version not found: 0.2.0" }))).toEqual({ kind: "absent" });
	});
	test("404 for a missing package or malformed body is an error, not absence", () => {
		expect(classifyRegistryResponse(404, JSON.stringify({ error: "Not found" })).kind).toBe("error");
		expect(classifyRegistryResponse(404, "<html>404</html>").kind).toBe("error");
	});
	test("server errors and invalid statuses are errors", () => {
		expect(classifyRegistryResponse(500, JSON.stringify({ error: "boom" })).kind).toBe("error");
		expect(classifyRegistryResponse(302, "{}").kind).toBe("error");
		expect(classifyRegistryResponse("200" as unknown as number, "{}").kind).toBe("error");
	});
});

describe("checkVersionAbsent", () => {
	test("requests the fixed registry URL for the exact package/version", async () => {
		let requested = "";
		const fetchImpl: FetchLike = async (url) => {
			requested = url;
			return { status: 404, text: async () => JSON.stringify({ error: "version not found: 0.2.0" }) };
		};
		const result = await checkVersionAbsent({ fetchImpl, name: "opencode-session-port", version: "0.2.0" });
		expect(result).toEqual({ kind: "absent" });
		expect(requested).toBe("https://registry.npmjs.org/opencode-session-port/0.2.0");
	});

	test("existing version fails", async () => {
		const result = await checkVersionAbsent({
			fetchImpl: jsonResponse(200, { name: "opencode-session-port", version: "0.2.0" }),
			name: "opencode-session-port",
			version: "0.2.0",
		});
		expect(result.kind).toBe("exists");
	});

	test("network failure fails closed", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("connection reset");
		};
		const result = await checkVersionAbsent({ fetchImpl, name: "opencode-session-port", version: "0.2.0" });
		expect(result.kind).toBe("error");
		expect(result.reason).toContain("registry request failed");
	});

	test("timeout aborts within the bound and fails closed", async () => {
		const fetchImpl: FetchLike = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const result = await checkVersionAbsent({ fetchImpl, name: "opencode-session-port", version: "0.2.0", timeoutMs: 20 });
		expect(result.kind).toBe("error");
	});

	test("oversized or missing response bodies fail closed", async () => {
		const fetchImpl: FetchLike = async () => ({ status: 404, text: async () => "x".repeat(100) });
		const result = await checkVersionAbsent({ fetchImpl, name: "opencode-session-port", version: "0.2.0", maxBodyBytes: 10 });
		expect(result.kind).toBe("error");
	});

	test("empty name or version fails closed before any request", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("must not be called");
		};
		expect((await checkVersionAbsent({ fetchImpl, name: "", version: "0.2.0" })).kind).toBe("error");
		expect((await checkVersionAbsent({ fetchImpl, name: "opencode-session-port", version: "" })).kind).toBe("error");
	});
});
