#!/usr/bin/env node
/**
 * CI-02 npm registry existence check (fail-closed).
 *
 * Binds the precheck to the explicit dispatched tag (SESSIONPORT_RELEASE_TAG)
 * and the staged metadata: the tag, its version, and the metadata tag must all
 * agree. GITHUB_REF_NAME is deliberately ignored because a dispatch from main
 * names the branch, not the release tag. Then uses the Node builtin fetch
 * against the fixed public npm registry with a bounded timeout. Only a
 * recognized npm "version not found" 404 response may proceed; an existing
 * version, any network/server error, timeout, redirect, or malformed response
 * aborts the release. Synthetic fetch tests live in
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
	const parsed = parseBodyObject(bodyText);
	const parsedOk = parsed !== null;
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

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBodyObject(bodyText) {
	try {
		const parsed = JSON.parse(typeof bodyText === "string" ? bodyText : "");
		return isPlainObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function parseJsonValue(bodyText) {
	try {
		return { ok: true, value: JSON.parse(typeof bodyText === "string" ? bodyText : "") };
	} catch {
		return { ok: false, value: null };
	}
}

/**
 * Only a valid-JSON 404 whose wording is not the recognized version-not-found
 * form warrants the package-metadata fallback. npm may return either an error
 * object or a bare JSON error string; other JSON shapes and malformed bodies
 * stay fail-closed without a second request.
 */
function isUnrecognizedVersion404(status, bodyText) {
	if (status !== 404) return false;
	const parsed = parseJsonValue(bodyText);
	if (!parsed.ok) return false;
	const objectError = isPlainObject(parsed.value) && typeof parsed.value.error === "string";
	const errorLike = typeof parsed.value === "string" || objectError;
	const recognized = objectError && /version not found/i.test(parsed.value.error);
	return errorLike && !recognized;
}

async function fetchBoundedText(fetchImpl, url, { signal, accept, maxBodyBytes }) {
	const response = await fetchImpl(url, {
		method: "GET",
		redirect: "error",
		signal,
		headers: { accept },
	});
	const bodyText = await response.text();
	if (typeof bodyText !== "string" || bodyText.length > maxBodyBytes) {
		return { ok: false, reason: "registry response body was missing or exceeded the bounded size" };
	}
	return { ok: true, status: response.status, bodyText };
}

/**
 * Authoritative check against the abbreviated packument. Absence is only
 * reported for a 200 with the exact package name and a plain versions object
 * whose entries are all objects; the requested version is decided by own
 * property presence, so prototype keys can never fake an existing release.
 */
export function classifyPackageMetadataResponse(status, bodyText, { name, version } = {}) {
	if (typeof status !== "number" || !Number.isInteger(status)) {
		return { kind: "error", reason: `registry returned an invalid status: ${String(status)}` };
	}
	if (status !== 200) {
		return { kind: "error", reason: `registry package metadata responded with status ${status}` };
	}
	const parsed = parseBodyObject(bodyText);
	if (parsed === null) {
		return { kind: "error", reason: "registry package metadata was not a valid JSON object" };
	}
	if (parsed.name !== name) {
		return { kind: "error", reason: "registry package metadata named a different package" };
	}
	if (!isPlainObject(parsed.versions)) {
		return { kind: "error", reason: "registry package metadata did not contain a versions object" };
	}
	for (const key of Object.keys(parsed.versions)) {
		if (key === "" || !isPlainObject(parsed.versions[key])) {
			return { kind: "error", reason: "registry package metadata contained a malformed version entry" };
		}
	}
	if (typeof version !== "string" || version === "") {
		return { kind: "error", reason: "package version must be a non-empty string" };
	}
	return Object.prototype.hasOwnProperty.call(parsed.versions, version) ? { kind: "exists" } : { kind: "absent" };
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
	const packageUrl = `${String(registry).replace(/\/+$/, "")}/${encodeURIComponent(name)}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const first = await fetchBoundedText(fetchImpl, url, {
			signal: controller.signal,
			accept: "application/json",
			maxBodyBytes,
		});
		if (!first.ok) {
			return { kind: "error", reason: first.reason };
		}
		const classification = classifyRegistryResponse(first.status, first.bodyText);
		if (classification.kind !== "error" || !isUnrecognizedVersion404(first.status, first.bodyText)) {
			return classification;
		}
		const packument = await fetchBoundedText(fetchImpl, packageUrl, {
			signal: controller.signal,
			accept: "application/vnd.npm.install-v1+json",
			maxBodyBytes,
		});
		if (!packument.ok) {
			return { kind: "error", reason: packument.reason };
		}
		return classifyPackageMetadataResponse(packument.status, packument.bodyText, { name, version });
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

/**
 * Pure precheck identity binding, evaluated before any registry request.
 * The explicit dispatch tag and the staged metadata must agree, and the
 * optional approved version (workflow context) must match as well.
 */
export function evaluateRegistryIdentity({ metadata, tag, approvedVersion } = {}) {
	const problems = [];
	const record = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : null;
	const version = record !== null && typeof record.version === "string" && record.version !== "" ? record.version : null;
	if (record === null || record.name !== EXPECTED_PACKAGE_NAME) {
		problems.push(`release metadata must name ${EXPECTED_PACKAGE_NAME}`);
	}
	if (version === null) {
		problems.push("release metadata must record the exact version");
	}
	if (typeof tag !== "string" || tag === "") {
		problems.push("SESSIONPORT_RELEASE_TAG must be the explicit dispatched tag (missing or empty is rejected)");
	} else {
		const tagVersionValue = tagVersion(tag);
		if (tagVersionValue === null) {
			problems.push(`release tag must match "v<version>" (got ${JSON.stringify(tag)})`);
		} else if (version !== null && tagVersionValue !== version) {
			problems.push(`release tag (${JSON.stringify(tag)}) must match the metadata version (${JSON.stringify(version)})`);
		}
		if (record !== null && record.tag !== tag) {
			problems.push(`metadata tag (${JSON.stringify(record.tag ?? null)}) must match the explicit release tag (${JSON.stringify(tag)})`);
		}
	}
	if (typeof approvedVersion === "string" && approvedVersion !== "" && version !== null && approvedVersion !== version) {
		problems.push(`SESSIONPORT_RELEASE_VERSION (${approvedVersion}) must equal the metadata version (${JSON.stringify(version)})`);
	}
	return { ok: problems.length === 0, version, problems };
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
	const metadata = readJsonObject(path.join(path.resolve(artifactDir), "release-metadata.json"));
	const identity = evaluateRegistryIdentity({
		metadata,
		tag: process.env.SESSIONPORT_RELEASE_TAG ?? "",
		approvedVersion: process.env.SESSIONPORT_RELEASE_VERSION,
	});
	if (!identity.ok) {
		console.error(JSON.stringify({ registryCheck: "aborted", problems: identity.problems }, null, 2));
		process.exitCode = 1;
		return;
	}
	const version = identity.version;
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
