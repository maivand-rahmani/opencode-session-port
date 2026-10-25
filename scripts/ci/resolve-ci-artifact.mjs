#!/usr/bin/env node
/**
 * CI-02 source resolver (publish job only).
 *
 * Independent, fail-closed selection of the single successful `ci.yml` push
 * run on `main` for the exact peeled tag commit in this repository, and the
 * single unexpired `package-verify-evidence` artifact from that run. The
 * workflow commit (trusted, current main) is deliberately separate from the
 * artifact source commit: a dispatch resumes an already-verified tag without
 * rebuilding or moving the tag.
 *
 * No caller-supplied run ID, SHA, repository, artifact ID, or download URL is
 * accepted. Only the effective `v<version>` tag and the owner-approved version
 * variable are inputs; everything else comes from the GitHub API for the
 * workflow's own repository. Tokens are read from the environment and are
 * never printed or written.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	EXPECTED_REPO_SLUG,
	evaluateReleaseGate,
	IMMUTABLE_VERSIONS,
	sameRepoSlug,
	tagVersion,
} from "./release-lib.mjs";

export const CI_WORKFLOW_FILE = ".github/workflows/ci.yml";
export const SOURCE_ARTIFACT_NAME = "package-verify-evidence";
export const MAX_API_PAGES = 3;
export const API_VERSION = "2022-11-28";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

class ApiError extends Error {}

async function fetchJson(fetchImpl, url, token) {
	const response = await fetchImpl(url, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": API_VERSION,
		},
		redirect: "follow",
	});
	if (!response.ok) throw new ApiError(`GitHub API request failed with status ${response.status}`);
	return response.json();
}

/**
 * Peel an annotated tag to a commit with bounded follow-through. Lightweight
 * tags resolve directly; nested tag objects are followed at most MAX_API_PAGES
 * times and must terminate in a commit.
 */
export async function peelTagCommit({ repo, tag, token, fetchImpl = fetch }) {
	const problems = [];
	if (!sameRepoSlug(repo, EXPECTED_REPO_SLUG)) {
		return { ok: false, commit: null, problems: [`repository must be ${EXPECTED_REPO_SLUG}`] };
	}
	let object;
	try {
		const ref = await fetchJson(fetchImpl, `https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, token);
		object = ref?.object;
	} catch (error) {
		return { ok: false, commit: null, problems: [`tag ${tag} could not be resolved: ${error instanceof Error ? error.message : String(error)}`] };
	}
	for (let depth = 0; depth < MAX_API_PAGES; depth += 1) {
		if (object === null || typeof object !== "object") break;
		if (object.type === "commit" && typeof object.sha === "string" && SHA_PATTERN.test(object.sha)) {
			return { ok: true, commit: object.sha, problems: [] };
		}
		if (object.type !== "tag" || typeof object.sha !== "string" || !SHA_PATTERN.test(object.sha)) break;
		try {
			const next = await fetchJson(fetchImpl, `https://api.github.com/repos/${repo}/git/tags/${object.sha}`, token);
			object = next?.object;
		} catch (error) {
			problems.push(`tag object peel failed: ${error instanceof Error ? error.message : String(error)}`);
			return { ok: false, commit: null, problems };
		}
	}
	problems.push(`tag ${tag} did not peel to a commit`);
	return { ok: false, commit: null, problems };
}

/** Exactly one completed-successful push run of ci.yml on main for `commit`. */
export function selectSourceRun(runs, { commit, repo }) {
	const problems = [];
	if (!Array.isArray(runs)) return { ok: false, run: null, problems: ["workflow run list is not an array"] };
	const matching = runs.filter((run) => {
		if (run === null || typeof run !== "object") return false;
		if (run.path !== CI_WORKFLOW_FILE) return false;
		if (run.event !== "push") return false;
		if (run.status !== "completed" || run.conclusion !== "success") return false;
		if (run.head_branch !== "main") return false;
		if (run.head_sha !== commit) return false;
		if (run.head_repository?.full_name !== repo) return false;
		if (run.repository?.full_name !== repo) return false;
		return Number.isSafeInteger(run.id) && run.id > 0;
	});
	if (matching.length !== 1) {
		problems.push(`expected exactly one successful main push ci.yml run for ${commit}, found ${matching.length}`);
		return { ok: false, run: null, problems };
	}
	const run = matching[0];
	if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
		problems.push("source run attempt is missing");
		return { ok: false, run: null, problems };
	}
	return { ok: true, run, problems: [] };
}

/** Exactly one unexpired, digest-bearing `package-verify-evidence` artifact. */
export function selectCiArtifact(artifacts, { runID, commit }) {
	const problems = [];
	if (!Array.isArray(artifacts)) return { ok: false, artifact: null, problems: ["artifact list is not an array"] };
	const matching = artifacts.filter((artifact) => {
		if (artifact === null || typeof artifact !== "object") return false;
		if (artifact.name !== SOURCE_ARTIFACT_NAME) return false;
		if (artifact.expired !== false) return false;
		if (typeof artifact.digest !== "string" || !DIGEST_PATTERN.test(artifact.digest)) return false;
		if (artifact.workflow_run?.id !== runID) return false;
		if (artifact.workflow_run?.head_sha !== commit) return false;
		if (artifact.workflow_run?.head_branch !== "main") return false;
		return Number.isSafeInteger(artifact.id) && artifact.id > 0;
	});
	if (matching.length !== 1) {
		problems.push(`expected exactly one unexpired ${SOURCE_ARTIFACT_NAME} artifact, found ${matching.length}`);
		return { ok: false, artifact: null, problems };
	}
	return { ok: true, artifact: matching[0], problems: [] };
}

export async function listPaged(fetchImpl, baseUrl, token) {
	const items = [];
	for (let page = 1; page <= MAX_API_PAGES; page += 1) {
		const document = await fetchJson(fetchImpl, `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token);
		const pageItems = document?.[baseUrl.includes("/artifacts") ? "artifacts" : "workflow_runs"];
		if (!Array.isArray(pageItems)) throw new ApiError("GitHub API list response is malformed");
		items.push(...pageItems);
		if (pageItems.length < 100) return items;
	}
	throw new ApiError(`GitHub API list exceeds ${MAX_API_PAGES} pages (ambiguity is not hidden)`);
}

/** Resolve the complete source proof (called once per release job). */
export async function resolveReleaseSource({ env = process.env, fetchImpl = fetch } = {}) {
	const repo = env.GITHUB_REPOSITORY ?? "";
	const token = env.GITHUB_TOKEN ?? "";
	const dispatchTag = env.SESSIONPORT_RELEASE_DISPATCH_TAG ?? "";
	const eventName = env.GITHUB_EVENT_NAME ?? "";
	const tag = eventName === "workflow_dispatch" ? dispatchTag : env.GITHUB_REF_NAME ?? "";
	const gate = evaluateReleaseGate({
		enabled: env.SESSIONPORT_RELEASE_ENABLED ?? "",
		approvedVersion: env.SESSIONPORT_RELEASE_VERSION ?? "",
		tagRef: tag,
		repoSlug: repo,
		eventName,
		ref: env.GITHUB_REF ?? "",
		dispatchTag,
		immutableVersions: IMMUTABLE_VERSIONS,
	});
	if (!gate.ok) return { ok: false, problems: gate.problems, source: null };
	const version = gate.version;
	if (typeof token !== "string" || token === "") {
		return { ok: false, problems: ["GITHUB_TOKEN is required for source resolution"], source: null };
	}
	const peeled = await peelTagCommit({ repo, tag, token, fetchImpl });
	if (!peeled.ok) return { ok: false, problems: peeled.problems, source: null };
	let runs;
	try {
		runs = await listPaged(
			fetchImpl,
			`https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&head_sha=${peeled.commit}`,
			token,
		);
	} catch (error) {
		return { ok: false, problems: [`workflow runs could not be listed: ${error instanceof Error ? error.message : String(error)}`], source: null };
	}
	const runSelection = selectSourceRun(runs, { commit: peeled.commit, repo });
	if (!runSelection.ok) return { ok: false, problems: runSelection.problems, source: null };
	let artifacts;
	try {
		artifacts = await listPaged(
			fetchImpl,
			`https://api.github.com/repos/${repo}/actions/runs/${runSelection.run.id}/artifacts`,
			token,
		);
	} catch (error) {
		return { ok: false, problems: [`artifacts could not be listed: ${error instanceof Error ? error.message : String(error)}`], source: null };
	}
	const artifactSelection = selectCiArtifact(artifacts, { runID: runSelection.run.id, commit: peeled.commit });
	if (!artifactSelection.ok) return { ok: false, problems: artifactSelection.problems, source: null };
	const source = {
		repo: EXPECTED_REPO_SLUG,
		tag,
		version,
		commit: peeled.commit,
		sourceRunID: String(runSelection.run.id),
		sourceRunAttempt: String(runSelection.run.run_attempt),
		sourceArtifactID: String(artifactSelection.artifact.id),
		sourceArtifactDigest: artifactSelection.artifact.digest,
	};
	return { ok: true, problems: [], source };
}

/** Immutable resolution document written once per release job. */
export function resolutionDocument(source) {
	return {
		repo: source.repo,
		tag: source.tag,
		version: source.version,
		commit: source.commit,
		sourceRunID: source.sourceRunID,
		sourceRunAttempt: source.sourceRunAttempt,
		sourceArtifactID: source.sourceArtifactID,
		sourceArtifactDigest: source.sourceArtifactDigest,
	};
}

/**
 * Re-peel the tag immediately before publish and require the same commit that
 * produced the recorded artifact. A moved tag, or any API disagreement, aborts.
 */
export async function recheckTagCommit({ env = process.env, fetchImpl = fetch, resolution }) {
	const repo = env.GITHUB_REPOSITORY ?? "";
	const token = env.GITHUB_TOKEN ?? "";
	if (resolution === null || typeof resolution !== "object" || typeof resolution.tag !== "string" || typeof resolution.commit !== "string") {
		return { ok: false, problems: ["resolved source proof is missing or malformed"] };
	}
	if (typeof token !== "string" || token === "") {
		return { ok: false, problems: ["GITHUB_TOKEN is required for tag re-verification"] };
	}
	const peeled = await peelTagCommit({ repo, tag: resolution.tag, token, fetchImpl });
	if (!peeled.ok) return { ok: false, problems: peeled.problems };
	if (peeled.commit !== resolution.commit) {
		return {
			ok: false,
			problems: [`tag ${resolution.tag} now points to ${peeled.commit}, recorded artifact source is ${resolution.commit}`],
		};
	}
	return { ok: true, problems: [] };
}

async function main() {
	if (process.argv.includes("--recheck")) {
		const resolutionPath = path.resolve("release-resolution", "resolved-source.json");
		let resolution;
		try {
			resolution = JSON.parse(readFileSync(resolutionPath, "utf8"));
		} catch {
			console.error(JSON.stringify({ recheck: "blocked", problems: ["resolved-source.json is unreadable"] }, null, 2));
			process.exitCode = 1;
			return;
		}
		const checked = await recheckTagCommit({ resolution });
		if (!checked.ok) {
			console.error(JSON.stringify({ recheck: "blocked", problems: checked.problems }, null, 2));
			process.exitCode = 1;
			return;
		}
		console.log(JSON.stringify({ recheck: "ok", commit: resolution.commit }, null, 2));
		return;
	}
	const summary = await resolveReleaseSource();
	const outputPath = process.env.GITHUB_OUTPUT;
	if (!summary.ok) {
		console.error(JSON.stringify({ resolve: "blocked", problems: summary.problems }, null, 2));
		process.exitCode = 1;
		return;
	}
	const resolved = resolutionDocument(summary.source);
	const dir = path.resolve("release-resolution");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "resolved-source.json"), `${JSON.stringify(resolved, null, 2)}\n`);
	if (typeof outputPath === "string" && outputPath !== "") {
		appendFileSync(outputPath, `source-run-id=${resolved.sourceRunID}\n`);
		appendFileSync(outputPath, `source-artifact-id=${resolved.sourceArtifactID}\n`);
	}
	console.log(JSON.stringify({ resolve: "ok", source: resolved }, null, 2));
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	await main();
}
