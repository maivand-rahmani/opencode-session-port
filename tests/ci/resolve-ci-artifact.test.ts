/**
 * Synthetic resolver tests: no network, no filesystem writes, no tokens.
 * Fake GitHub API documents cover tag peeling, main-push run selection, and
 * the exact unexpired artifact selection; every ambiguity or mismatch fails.
 */
import { describe, expect, test } from "bun:test";
import {
	peelTagCommit,
	selectCiArtifact,
	selectSourceRun,
} from "../../scripts/ci/resolve-ci-artifact.mjs";

const REPO = "maivand-rahmani/opencode-session-port";
const COMMIT = "a".repeat(40);
const TAG_OBJECT = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;

function run(overrides: Record<string, unknown> = {}) {
	return {
		id: 40212562472,
		run_attempt: 1,
		path: ".github/workflows/ci.yml",
		event: "push",
		status: "completed",
		conclusion: "success",
		head_branch: "main",
		head_sha: COMMIT,
		head_repository: { full_name: REPO },
		repository: { full_name: REPO },
		...overrides,
	};
}

function artifact(overrides: Record<string, unknown> = {}) {
	return {
		id: 123456,
		name: "package-verify-evidence",
		expired: false,
		digest: DIGEST,
		workflow_run: { id: 40212562472, head_sha: COMMIT, head_branch: "main" },
		...overrides,
	};
}

describe("selectSourceRun", () => {
	test("accepts exactly one successful main push ci.yml run for the commit", () => {
		expect(selectSourceRun([run()], { commit: COMMIT, repo: REPO }).ok).toBe(true);
	});
	test("rejects PR, fork, failed, in-progress, wrong SHA, wrong repo, wrong workflow, ambiguity", () => {
		const cases = [
			run({ event: "pull_request" }),
			run({ head_repository: { full_name: "fork/repo" } }),
			run({ repository: { full_name: "fork/repo" } }),
			run({ conclusion: "failure" }),
			run({ status: "in_progress", conclusion: null }),
			run({ head_sha: "d".repeat(40) }),
			run({ head_branch: "feature" }),
			run({ path: ".github/workflows/other.yml" }),
		];
		for (const candidate of cases) {
			expect(selectSourceRun([candidate], { commit: COMMIT, repo: REPO }).ok).toBe(false);
		}
		expect(selectSourceRun([run(), run({ id: 7 })], { commit: COMMIT, repo: REPO }).ok).toBe(false);
		expect(selectSourceRun([], { commit: COMMIT, repo: REPO }).ok).toBe(false);
	});
	test("requires a source run attempt", () => {
		expect(selectSourceRun([run({ run_attempt: 0 })], { commit: COMMIT, repo: REPO }).ok).toBe(false);
	});
});

describe("selectCiArtifact", () => {
	test("accepts exactly one unexpired digest-bearing evidence artifact", () => {
		expect(selectCiArtifact([artifact()], { runID: 40212562472, commit: COMMIT }).ok).toBe(true);
	});
	test("rejects missing, expired, wrong name, missing digest, wrong run, wrong SHA, ambiguity", () => {
		const cases = [
			[],
			[artifact({ expired: true })],
			[artifact({ name: "release-verify-artifact" })],
			[artifact({ digest: undefined })],
			[artifact({ workflow_run: { id: 1, head_sha: COMMIT, head_branch: "main" } })],
			[artifact({ workflow_run: { id: 40212562472, head_sha: "e".repeat(40), head_branch: "main" } })],
			[artifact(), artifact({ id: 2 })],
		];
		for (const list of cases) {
			expect(selectCiArtifact(list, { runID: 40212562472, commit: COMMIT }).ok).toBe(false);
		}
	});
});

describe("peelTagCommit", () => {
	test("peels an annotated tag to its commit with bounded API calls", async () => {
		const calls: string[] = [];
		const fetchImpl = async (url: string) => {
			calls.push(url);
			if (url.endsWith("/git/ref/tags/v0.1.7")) {
				return { ok: true, json: async () => ({ object: { type: "tag", sha: TAG_OBJECT } }) };
			}
			if (url.endsWith(`/git/tags/${TAG_OBJECT}`)) {
				return { ok: true, json: async () => ({ object: { type: "commit", sha: COMMIT } }) };
			}
			throw new Error("unexpected url");
		};
		const result = await peelTagCommit({ repo: REPO, tag: "v0.1.7", token: "t", fetchImpl });
		expect(result).toEqual({ ok: true, commit: COMMIT, problems: [] });
		expect(calls).toHaveLength(2);
	});
	test("accepts a lightweight tag and rejects a foreign repo, missing tag, and non-commit peel", async () => {
		const lightweight = async () => ({
			ok: true,
			json: async () => ({ object: { type: "commit", sha: COMMIT } }),
		});
		expect((await peelTagCommit({ repo: REPO, tag: "v0.1.7", token: "t", fetchImpl: lightweight })).ok).toBe(true);
		const foreign = await peelTagCommit({ repo: "attacker/repo", tag: "v0.1.7", token: "t", fetchImpl: lightweight });
		expect(foreign.ok).toBe(false);
		const missing = async () => ({ ok: false, json: async () => ({}) });
		expect((await peelTagCommit({ repo: REPO, tag: "v0.1.7", token: "t", fetchImpl: missing })).ok).toBe(false);
		const blob = async () => ({
			ok: true,
			json: async () => ({ object: { type: "blob", sha: TAG_OBJECT } }),
		});
		expect((await peelTagCommit({ repo: REPO, tag: "v0.1.7", token: "t", fetchImpl: blob })).ok).toBe(false);
	});
});

describe("tag-SHA identity: resume v0.1.7, never the latest main artifact", () => {
	// Real recorded identities: tag v0.1.7 -> 6f491ab (CI 40212562472 success);
	// newer main 3e96264 (CI 40214445908 success) must not be selected.
	const TAG_COMMIT = "6f491ab8e64add08a9831c144fecdb5648e4e344";
	const LATEST_MAIN = "3e96264d294c37f50a93bb5f306814e8dc1f3f32";
	const NEWER_RUN_ID = 40214445908;
	const TAG_RUN_ID = 40212562472;

	function fakeFetch(url: string) {
		const json = (value: unknown) => ({ ok: true, json: async () => value });
		if (url.endsWith("/git/ref/tags/v0.1.7")) {
			return json({ object: { type: "tag", sha: "b".repeat(40) } });
		}
		if (url.endsWith(`/git/tags/${"b".repeat(40)}`)) {
			return json({ object: { type: "commit", sha: TAG_COMMIT } });
		}
		if (url.includes("/actions/workflows/ci.yml/runs")) {
			expect(url).toContain(`head_sha=${TAG_COMMIT}`);
			return json({
				workflow_runs: [
					run({ id: NEWER_RUN_ID, head_sha: LATEST_MAIN, run_attempt: 1 }),
					run({ id: TAG_RUN_ID, head_sha: TAG_COMMIT, run_attempt: 1 }),
				],
			});
		}
		if (url.includes(`/actions/runs/${TAG_RUN_ID}/artifacts`)) {
			return json({
				artifacts: [artifact({ id: 777, workflow_run: { id: TAG_RUN_ID, head_sha: TAG_COMMIT, head_branch: "main" } })],
			});
		}
		if (url.includes(`/actions/runs/${NEWER_RUN_ID}/artifacts`)) {
			throw new Error("must not query the newer main run");
		}
		throw new Error(`unexpected url: ${url}`);
	}

	const env = {
		SESSIONPORT_RELEASE_ENABLED: "true",
		SESSIONPORT_RELEASE_VERSION: "0.1.7",
		GITHUB_REF_NAME: "main",
		GITHUB_REF: "refs/heads/main",
		GITHUB_EVENT_NAME: "workflow_dispatch",
		SESSIONPORT_RELEASE_DISPATCH_TAG: "v0.1.7",
		GITHUB_REPOSITORY: REPO,
		GITHUB_TOKEN: "token-not-logged",
	};

	test("selects the exact tag commit run and its artifact, ignoring a newer main success", async () => {
		const { resolveReleaseSource } = await import("../../scripts/ci/resolve-ci-artifact.mjs");
		const result = await resolveReleaseSource({ env, fetchImpl: fakeFetch });
		expect(result.ok).toBe(true);
		expect(result.source.commit).toBe(TAG_COMMIT);
		expect(result.source.sourceRunID).toBe(String(TAG_RUN_ID));
		expect(result.source.sourceArtifactID).toBe("777");
		expect(JSON.stringify(result)).not.toContain(env.GITHUB_TOKEN);
	});

	test("blocks when the tag commit has no successful main push run", async () => {
		const { resolveReleaseSource } = await import("../../scripts/ci/resolve-ci-artifact.mjs");
		const onlyNewer = async (url: string) => {
			if (url.includes("/actions/workflows/ci.yml/runs")) {
				return {
					ok: true,
					json: async () => ({ workflow_runs: [run({ id: NEWER_RUN_ID, head_sha: LATEST_MAIN })] }),
				};
			}
			return fakeFetch(url);
		};
		const result = await resolveReleaseSource({ env, fetchImpl: onlyNewer });
		expect(result.ok).toBe(false);
		expect(result.source).toBeNull();
	});
});

describe("pagination and fresh tag re-verification (fail closed)", () => {
	test("three full pages of runs fail closed instead of hiding a fourth page", async () => {
		const { listPaged } = await import("../../scripts/ci/resolve-ci-artifact.mjs");
		const page = Array.from({ length: 100 }, (_, index) => ({ id: index }));
		const fetchImpl = async (url: string) => ({
			ok: true,
			json: async () => ({ workflow_runs: page, page: new URL(url).searchParams.get("page") }),
		});
		await expect(listPaged(fetchImpl, "https://api.github.com/repos/x/actions/workflows/ci.yml/runs", "t")).rejects.toThrow("exceeds");
		const terminal = async (url: string) => ({
			ok: true,
			json: async () => ({ workflow_runs: new URL(url).searchParams.get("page") === "3" ? [] : page }),
		});
		await expect(listPaged(terminal, "https://api.github.com/repos/x/actions/workflows/ci.yml/runs?event=push", "t")).resolves.toHaveLength(200);
	});

	test("recheck aborts when the tag moved after the artifact proof was recorded", async () => {
		const { recheckTagCommit } = await import("../../scripts/ci/resolve-ci-artifact.mjs");
		const resolution = { tag: "v0.1.7", commit: "6f491ab8e64add08a9831c144fecdb5648e4e344" };
		const peelTo = (sha: string) => async () => ({ ok: true, json: async () => ({ object: { type: "commit", sha } }) });
		expect((await recheckTagCommit({ env: { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "t" }, fetchImpl: peelTo(resolution.commit), resolution })).ok).toBe(true);
		expect((await recheckTagCommit({ env: { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "t" }, fetchImpl: peelTo("3e96264d294c37f50a93bb5f306814e8dc1f3f32"), resolution })).ok).toBe(false);
		expect((await recheckTagCommit({ env: { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "" }, fetchImpl: peelTo(resolution.commit), resolution })).ok).toBe(false);
	});
});
