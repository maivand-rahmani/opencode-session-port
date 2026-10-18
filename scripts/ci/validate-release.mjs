#!/usr/bin/env node
/**
 * CI-02 publish-side validation (runs in the Ubuntu publish job under Node,
 * with no project installs). Rebinds the downloaded same-run artifact to this
 * exact run before publish:
 * - the artifact directory contains exactly exact.tgz / evidence.json /
 *   release-metadata.json, regular files only (symlinks rejected);
 * - exact.tgz sha256 equals the staged metadata sha256;
 * - metadata binds to manifest version, workflow tag, checked-out commit,
 *   workflow repository, and the fixed package identity;
 * - evidence.json is a successful install run (problems empty, withInstall
 *   true, all consumer results recorded) with a matching tarball digest/name;
 * - the packed package/package.json inside exact.tgz is read without disk
 *   extraction and must match the expected name/version/repository, so the
 *   metadata alone is never trusted.
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

export function validateReleaseArtifact({ artifactDir = ARTIFACT_DIR_NAME, env = process.env, manifestVersion } = {}) {
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
	const tagRef = env.GITHUB_REF_NAME ?? "";
	const version = tagVersion(tagRef);
	let tarballSha256 = null;
	const tarballPath = path.join(dir, "exact.tgz");
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
	if (version === null) {
		problems.push(`workflow tag must match "v<version>" (got ${JSON.stringify(tagRef)})`);
		problems.push(...evaluateEvidence(evidenceRead.value, { sha256: tarballSha256 ?? undefined }).problems);
	} else {
		problems.push(
			...evaluateEvidence(evidenceRead.value, {
				sha256: tarballSha256 ?? undefined,
				expectedTarballBasename: `${EXPECTED_PACKAGE_NAME}-${version}.tgz`,
			}).problems,
		);
	}
	problems.push(
		...evaluateReleaseBindings({
			metadata: metadataRead.value,
			manifestVersion,
			tagRef,
			commit: env.GITHUB_SHA ?? "",
			repoSlug: env.GITHUB_REPOSITORY ?? "",
			tarballSha256,
			packedManifest,
		}).problems,
	);
	return { ok: problems.length === 0, version, tarballSha256, problems };
}

async function main() {
	const args = process.argv.slice(2);
	let artifactDir = ARTIFACT_DIR_NAME;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--artifact-dir" && typeof args[index + 1] === "string") {
			artifactDir = args[index + 1];
			index += 1;
		}
	}
	let manifestVersion = null;
	try {
		const parsed = JSON.parse(readFileSync("package.json", "utf8"));
		manifestVersion = typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : null;
	} catch {
		manifestVersion = null;
	}
	const summary = validateReleaseArtifact({ artifactDir, manifestVersion });
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
