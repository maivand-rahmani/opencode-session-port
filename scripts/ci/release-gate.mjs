#!/usr/bin/env node
/**
 * CI-02 fail-closed release gate.
 *
 * Runs identically in the Windows verify job and the Ubuntu publish job,
 * before any expensive work and again before publish. The release proceeds
 * only when:
 * - SESSIONPORT_RELEASE_ENABLED is exactly "true" (absent blocks);
 * - SESSIONPORT_RELEASE_VERSION equals the pushed tag's version exactly;
 * - the tag version equals package.json's version and is not immutable;
 * - the workflow runs in the expected repository.
 * Owner-side prerequisites (protected environment, tag protections, npm
 * trusted-publisher mapping) are not inferred from this gate.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EXPECTED_REPO_SLUG, evaluateReleaseGate } from "./release-lib.mjs";

export function readManifestVersion(file = "package.json") {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : null;
	} catch {
		return null;
	}
}

export function runReleaseGate(env = process.env, manifestVersion = readManifestVersion()) {
	const result = evaluateReleaseGate({
		enabled: env.SESSIONPORT_RELEASE_ENABLED ?? "",
		approvedVersion: env.SESSIONPORT_RELEASE_VERSION ?? "",
		tagRef: env.GITHUB_REF_NAME ?? "",
		manifestVersion,
		repoSlug: env.GITHUB_REPOSITORY ?? "",
	});
	return { ok: result.ok, version: result.version, repo: EXPECTED_REPO_SLUG, problems: result.problems };
}

async function main() {
	const summary = runReleaseGate();
	console.log(
		JSON.stringify(
			{ gate: summary.ok ? "open" : "blocked", version: summary.version, repo: summary.repo, problems: summary.problems },
			null,
			2,
		),
	);
	if (!summary.ok) {
		console.error(`release gate blocked: ${summary.problems.join("; ")}`);
		process.exitCode = 1;
		return;
	}
	console.log(`release gate open for ${summary.version} (${summary.repo})`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	await main();
}
