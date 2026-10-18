#!/usr/bin/env node
/**
 * CI-02 npm registry existence check (fail-closed).
 *
 * Uses the Node builtin fetch against the fixed public npm registry with a
 * bounded timeout. Only a recognized npm "version not found" 404 response may
 * proceed; an existing version, any network/server error, timeout, redirect,
 * or malformed response aborts the release. Synthetic fetch tests live in
 * tests/ci/registry-check.test.ts.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { EXPECTED_PACKAGE_NAME, NPM_REGISTRY, REGISTRY_TIMEOUT_MS, tagVersion } from "./release-lib.mjs";

export const ARTIFACT_DIR_NAME = "release-artifact";
const MAX_BODY_BYTES = 256 * 1024;

export function classifyRegistryResponse(status, bodyText) {
	if (typeof status !== "number" || !Number.isInteger(status)) {
		return { kind: "error", reason: `registry returned an invalid status: ${String(status)}` };
	}
	let parsed = null;
	let parsedOk = false;
	try {
		parsed = JSON.parse(typeof bodyText === "string" ? bodyText : "");
		parsedOk = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
	} catch {
		parsedOk = false;
	}
	if (status === 200) {
		if (parsedOk && typeof parsed.version === "string" && parsed.version !== "") {
			return { kind: "exists" };
		}
		return { kind: "error", reason: "registry responded 200 but the version document was not a valid JSON version object" };
	}
	if (status === 404) {
		if (parsedOk && typeof parsed.error === "string" && /version not found/i.test(parsed.error)) {
			return { kind: "absent" };
		}
		return { kind: "error", reason: "registry responded 404 without a recognized version-not-found body" };
	}
	return { kind: "error", reason: `registry responded with status ${status}` };
}

export async function checkVersionAbsent({
	fetchImpl = fetch,
	registry = NPM_REGISTRY,
	name,
	version,
	timeoutMs = REGISTRY_TIMEOUT_MS,
	maxBodyBytes = MAX_BODY_BYTES,
} = {}) {
	if (typeof name !== "string" || name === "" || typeof version !== "string" || version === "") {
		return { kind: "error", reason: "package name and version must be non-empty strings" };
	}
	const url = `${String(registry).replace(/\/+$/, "")}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			redirect: "error",
			signal: controller.signal,
			headers: { accept: "application/json" },
		});
		const bodyText = await response.text();
		if (typeof bodyText !== "string" || bodyText.length > maxBodyBytes) {
			return { kind: "error", reason: "registry response body was missing or exceeded the bounded size" };
		}
		return classifyRegistryResponse(response.status, bodyText);
	} catch (error) {
		return { kind: "error", reason: `registry request failed: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		clearTimeout(timer);
	}
}

function readJsonObject(file) {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
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
	const problems = [];
	const metadata = readJsonObject(path.join(path.resolve(artifactDir), "release-metadata.json"));
	const version = metadata !== null && typeof metadata.version === "string" && metadata.version !== "" ? metadata.version : null;
	if (metadata === null || metadata.name !== EXPECTED_PACKAGE_NAME) {
		problems.push(`release metadata must name ${EXPECTED_PACKAGE_NAME}`);
	}
	if (version === null) {
		problems.push("release metadata must record the exact version");
	}
	const tagVersionValue = tagVersion(process.env.GITHUB_REF_NAME ?? "");
	if (tagVersionValue === null || tagVersionValue !== version) {
		problems.push(`workflow tag (${JSON.stringify(process.env.GITHUB_REF_NAME ?? "")}) must match the metadata version (${JSON.stringify(version)})`);
	}
	if (problems.length > 0) {
		console.error(JSON.stringify({ registryCheck: "aborted", problems }, null, 2));
		process.exitCode = 1;
		return;
	}
	const result = await checkVersionAbsent({ name: EXPECTED_PACKAGE_NAME, version });
	if (result.kind === "absent") {
		console.log(
			JSON.stringify(
				{
					registryCheck: "ok",
					package: EXPECTED_PACKAGE_NAME,
					version,
					detail: "version not found on the public registry; publish may proceed",
				},
				null,
				2,
			),
		);
		return;
	}
	console.error(
		JSON.stringify(
			{
				registryCheck: "fail",
				kind: result.kind,
				package: EXPECTED_PACKAGE_NAME,
				version,
				reason: result.kind === "exists" ? "this exact version already exists on npm and is immutable" : result.reason,
			},
			null,
			2,
		),
	);
	process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	await main();
}
