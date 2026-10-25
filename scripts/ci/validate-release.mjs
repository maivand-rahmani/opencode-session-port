#!/usr/bin/env node
/**
 * CI-02 publish-side validation (Ubuntu publish job, no project installs).
 *
 * Rebinds the downloaded evidence artifact to the independently resolved
 * source proof and to this release run:
 * - artifact directory contains exactly exact.tgz / evidence.json /
 *   release-metadata.json, regular files only;
 * - resolution document is immutable, in-repo, and matches metadata
 *   (source run/attempt/artifact ID/digest, peeled tag commit, tag, version);
 * - metadata workflowCommit equals this trusted workflow commit and
 *   releaseRunID equals this run;
 * - exact.tgz digest matches metadata; evidence is a successful install run
 *   with all consumer results; the packed identity inside exact.tgz matches.
 * Metadata alone is never trusted; the artifact cannot assert its own source.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	ARTIFACT_FILE_NAMES,
	EXPECTED_PACKAGE_NAME,
	evaluateEvidence,
	evaluateReleaseBindings,
	evaluateStagedNames,
	tagVersion,
} from "./release-lib.mjs";
import { readGzippedTarEntry } from "./tarball-members.mjs";

export const ARTIFACT_DIR_NAME = "release-artifact";
export const RESOLUTION_FILE_NAME = "resolved-source.json";
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export function sha256File(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readJsonBounded(file) {
	try {
		const stat = lstatSync(file);
		if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_JSON_BYTES) {
			return { value: null, error: "not a regular file within the bounded size" };
		}
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? { value: parsed, error: null }
			: { value: null, error: "not a JSON object" };
	} catch (error) {
		return { value: null, error: error instanceof Error ? error.message : String(error) };
	}
}

function evaluateResolution(resolution) {
	const problems = [];
	if (resolution === null || typeof resolution !== "object" || Array.isArray(resolution)) {
		return { source: null, problems: ["resolved source proof is missing"] };
	}
	const keys = ["commit", "repo", "sourceArtifactDigest", "sourceArtifactID", "sourceRunAttempt", "sourceRunID", "tag", "version"].sort();
	if (JSON.stringify(Object.keys(resolution).sort()) !== JSON.stringify(keys)) {
		problems.push("resolved source proof has unexpected or missing fields");
	}
	if (resolution.repo !== "maivand-rahmani/opencode-session-port") problems.push("resolved source repository mismatch");
	return { source: resolution, problems };
}

export function validateReleaseArtifact({
	artifactDir = ARTIFACT_DIR_NAME,
	resolutionFile = path.join(path.dirname(artifactDir), "release-resolution", RESOLUTION_FILE_NAME),
	env = process.env,
	manifestVersion,
} = {}) {
	const problems = [];
	const dir = path.resolve(artifactDir);
	let entries = [];
	try {
		entries = readdirSync(dir);
	} catch (error) {
		return {
			ok: false,
			version: null,
			tarballSha256: null,
			problems: [`release artifact directory is unreadable: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	problems.push(...evaluateStagedNames(entries).problems);
	for (const name of ARTIFACT_FILE_NAMES) {
		try {
			const stat = lstatSync(path.join(dir, name));
			if (stat.isSymbolicLink() || !stat.isFile()) problems.push(`${name} must be a regular file (symlinks are rejected)`);
		} catch (error) {
			problems.push(`${name} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const metadataRead = readJsonBounded(path.join(dir, "release-metadata.json"));
	if (metadataRead.error !== null) problems.push(`release-metadata.json: ${metadataRead.error}`);
	const evidenceRead = readJsonBounded(path.join(dir, "evidence.json"));
	if (evidenceRead.error !== null) problems.push(`evidence.json: ${evidenceRead.error}`);
	const resolutionRead = readJsonBounded(resolutionFile);
	if (resolutionRead.error !== null) problems.push(`resolved-source.json: ${resolutionRead.error}`);
	const resolution = evaluateResolution(resolutionRead.value);
	problems.push(...resolution.problems);
	const source = resolution.source;
	const tagRef = source !== null && typeof source === "object" ? source.tag : "";
	const version = tagVersion(tagRef);
	if (version === null) problems.push(`resolved tag must match "v<version>" (got ${JSON.stringify(tagRef)})`);
	if (source !== null && source.version !== version) problems.push("resolved version must equal the resolved tag version");
	const approvedVersion = env.SESSIONPORT_RELEASE_VERSION ?? "";
	if (source !== null && source.version !== approvedVersion) {
		problems.push("resolved version must equal the owner-approved version");
	}
	const artifactManifestVersion = source !== null && typeof source === "object" ? source.version : null;
	if (source !== null && source.tag !== env.GITHUB_REF_NAME && env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
		problems.push("resolved tag must equal the pushed tag ref");
	}
	lstatSync(path.join(dir, "exact.tgz"));
	const tarballPath = path.join(dir, "exact.tgz");
	let tarballSha256 = null;
	try {
		tarballSha256 = sha256File(tarballPath);
	} catch (error) {
		problems.push(`exact.tgz is unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	let packedManifest = null;
	if (tarballSha256 !== null) {
		try {
			const tarResult = readGzippedTarEntry(readFileSync(tarballPath), "package/package.json");
			if (!tarResult.ok) {
				problems.push(`exact.tgz: ${tarResult.error}`);
			} else {
				try {
					packedManifest = JSON.parse(tarResult.content.toString("utf8"));
				} catch {
					problems.push("packed package/package.json is not valid JSON");
				}
			}
		} catch (error) {
			problems.push(`exact.tgz could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	problems.push(
		...evaluateEvidence(evidenceRead.value, {
			sha256: tarballSha256 ?? undefined,
			expectedTarballBasename: version === null ? undefined : `${EXPECTED_PACKAGE_NAME}-${version}.tgz`,
		}).problems,
	);
	problems.push(
		...evaluateReleaseBindings({
			metadata: metadataRead.value,
			manifestVersion: artifactManifestVersion,
			tagRef,
			commit: source !== null && typeof source === "object" ? source.commit : "",
			repoSlug: env.GITHUB_REPOSITORY ?? "",
			tarballSha256,
			packedManifest,
			source,
			workflowCommit: env.GITHUB_SHA ?? "",
			releaseRunID: env.GITHUB_RUN_ID ?? "",
		}).problems,
	);
	return { ok: problems.length === 0, version, tarballSha256, problems };
}

async function main() {
	const args = process.argv.slice(2);
	let artifactDir = ARTIFACT_DIR_NAME;
	let resolutionFile = path.join("release-resolution", RESOLUTION_FILE_NAME);
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--artifact-dir" && typeof args[index + 1] === "string") {
			artifactDir = args[index + 1];
			index += 1;
		} else if (args[index] === "--resolution" && typeof args[index + 1] === "string") {
			resolutionFile = args[index + 1];
			index += 1;
		}
	}
	const summary = validateReleaseArtifact({ artifactDir, resolutionFile, manifestVersion: process.env.SESSIONPORT_RELEASE_VERSION ?? null });
	console.log(
		JSON.stringify(
			{
				releaseValidation: summary.ok ? "ok" : "failed",
				version: summary.version,
				tarballSha256: summary.tarballSha256,
				problems: summary.problems,
			},
			null,
			2,
		),
	);
	if (!summary.ok) process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	await main();
}
