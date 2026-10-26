import { describe, expect, test } from "bun:test";
import { checkVersionAbsent, classifyRegistryResponse, evaluateRegistryIdentity } from "../../scripts/ci/registry-check.mjs";

/**
 * Synthetic tests for the fail-closed npm version existence check. The fetch
 * implementation is injected — no network access, no installs.
 */

type FetchLike = (url: string, init: any) => Promise<any>;

function jsonResponse(status: number, body: unknown): FetchLike {
	return async () => ({ status, text: async () => JSON.stringify(body) });
}

const stagedMetadata = (overrides: Record<string, unknown> = {}) => ({
	name: "opencode-session-port",
	version: "0.1.7",
	commit: "0123456789abcdef0123456789abcdef01234567",
	tag: "v0.1.7",
	sha256: "a".repeat(64),
	repo: "maivand-rahmani/opencode-session-port",
	sourceRunID: "40212562472",
	sourceRunAttempt: "1",
	sourceArtifactID: "12606815301",
	sourceArtifactDigest: `sha256:${"b".repeat(64)}`,
	workflowCommit: "0123456789abcdef0123456789abcdef01234567",
	releaseRunID: "40304262173",
	...overrides,
});

/** Dispatch env for the 0.1.7 resume: the ref is main, the tag is explicit. */
const dispatchEnv = {
	GITHUB_REF_NAME: "main",
	SESSIONPORT_RELEASE_TAG: "v0.1.7",
	SESSIONPORT_RELEASE_VERSION: "0.1.7",
} as Record<string, string>;

describe("evaluateRegistryIdentity", () => {
	test("accepts staged 0.1.7 metadata with an explicit v0.1.7 dispatch tag from main", () => {
		const result = evaluateRegistryIdentity({
			metadata: stagedMetadata(),
			tag: dispatchEnv.SESSIONPORT_RELEASE_TAG,
			approvedVersion: dispatchEnv.SESSIONPORT_RELEASE_VERSION,
		});
		expect(result).toEqual({ ok: true, version: "0.1.7", problems: [] });
	});

	test("missing explicit tag aborts even when the dispatcher ref is main", () => {
		const result = evaluateRegistryIdentity({
			metadata: stagedMetadata(),
			tag: "",
			approvedVersion: dispatchEnv.SESSIONPORT_RELEASE_VERSION,
		});
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("SESSIONPORT_RELEASE_TAG");
	});

	test("tag/version and metadata-tag mismatches abort", () => {
		const versionMismatch = evaluateRegistryIdentity({
			metadata: stagedMetadata(),
			tag: "v0.1.8",
			approvedVersion: dispatchEnv.SESSIONPORT_RELEASE_VERSION,
		});
		expect(versionMismatch.ok).toBe(false);
		expect(versionMismatch.problems.join(" ")).toContain("must match the metadata version");

		const metadataTagMismatch = evaluateRegistryIdentity({
			metadata: stagedMetadata({ tag: "v0.1.8" }),
			tag: "v0.1.7",
			approvedVersion: dispatchEnv.SESSIONPORT_RELEASE_VERSION,
		});
		expect(metadataTagMismatch.ok).toBe(false);
		expect(metadataTagMismatch.problems.join(" ")).toContain("metadata tag");
	});

	test("approved version mismatch aborts before any registry request", () => {
		const result = evaluateRegistryIdentity({
			metadata: stagedMetadata(),
			tag: dispatchEnv.SESSIONPORT_RELEASE_TAG,
			approvedVersion: "0.1.8",
		});
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("SESSIONPORT_RELEASE_VERSION");
	});

	test("malformed or non-release metadata fails closed", () => {
		expect(
			evaluateRegistryIdentity({
				metadata: stagedMetadata({ name: "attacker-pkg" }),
				tag: "v0.1.7",
				approvedVersion: "0.1.7",
			}).ok,
		).toBe(false);
		expect(
			evaluateRegistryIdentity({
				metadata: stagedMetadata({ version: "" }),
				tag: "v0.1.7",
				approvedVersion: "0.1.7",
			}).ok,
		).toBe(false);
		expect(
			evaluateRegistryIdentity({
				metadata: stagedMetadata(),
				tag: "main",
				approvedVersion: "0.1.7",
			}).ok,
		).toBe(false);
	});
});

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
