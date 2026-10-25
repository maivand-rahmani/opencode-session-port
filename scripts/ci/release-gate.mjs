#!/usr/bin/env node
/**
 * CI-02 fail-closed release gate.
 *
 * Runs before resolution and again immediately before publish. The release
 * proceeds only when:
 * - SESSIONPORT_RELEASE_ENABLED is exactly "true" (absent blocks);
 * - SESSIONPORT_RELEASE_VERSION equals the effective tag version exactly;
 * - a tag push runs on `refs/tags/v*`, and a manual dispatch runs from
 *   `refs/heads/main` with exactly one `tag` input (the effective tag);
 * - the tag version equals package.json's version and is not immutable;
 * - the workflow runs in the expected repository.
 * The caller's tag input is never trusted beyond the strict version shape; the
 * tag commit itself is resolved independently from the GitHub API.
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
	const eventName = env.GITHUB_EVENT_NAME ?? "push";
	const result = evaluateReleaseGate({
		enabled: env.SESSIONPORT_RELEASE_ENABLED ?? "",
		approvedVersion: env.SESSIONPORT_RELEASE_VERSION ?? "",
		tagRef: env.GITHUB_REF_NAME ?? "",
		manifestVersion,
		repoSlug: env.GITHUB_REPOSITORY ?? "",
		eventName,
		ref: env.GITHUB_REF ?? "",
		dispatchTag: env.SESSIONPORT_RELEASE_DISPATCH_TAG ?? "",
	});
	return {
		ok: result.ok,
		version: result.version,
		repo: EXPECTED_REPO_SLUG,
		event: eventName,
		problems: result.problems,
	};
}

async function main() {
	const summary = runReleaseGate();
	console.log(
		JSON.stringify(
			{
				gate: summary.ok ? "open" : "blocked",
				version: summary.version,
				repo: summary.repo,
				event: summary.event,
				problems: summary.problems,
			},
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
