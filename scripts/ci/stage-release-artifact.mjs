#!/usr/bin/env node
/**
 * CI-02 staging step (runs in the Windows verify job under Node).
 *
 * After a successful `verify:package --install --keep`, scans
 * `.package-verify-work/` and selects exactly one successful install evidence
 * plus its tarball under that owned scratch root, then stages ONLY
 * exact.tgz / evidence.json / release-metadata.json into `release-artifact/`
 * for the fixed same-run artifact upload. Consumer trees are never copied.
 * Symlinks, path escapes, malformed evidence, and ambiguity fail closed.
 */
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildReleaseMetadata,
	EXPECTED_PACKAGE_NAME,
	evaluateEvidence,
	evaluateStagedNames,
	pickVerifiedEvidenceCandidate,
	tagVersion,
} from "./release-lib.mjs";

export const SCRATCH_DIR_NAME = ".package-verify-work";
export const ARTIFACT_DIR_NAME = "release-artifact";
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_WALK_DEPTH = 6;
const MAX_WALK_ENTRIES = 64;

export function sha256File(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function collectEvidenceCandidates(scratchBase) {
	const base = path.resolve(scratchBase);
	const candidates = [];
	let baseStat;
	try {
		baseStat = lstatSync(base);
	} catch {
		return candidates;
	}
	if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
		return [{ dir: base, error: "verifier scratch root is not a regular directory" }];
	}
	for (const entry of readdirSync(base)) {
		const dir = path.join(base, entry);
		let stat;
		try {
			stat = lstatSync(dir);
		} catch (error) {
			candidates.push({ dir, error: `scratch entry is unreadable: ${error instanceof Error ? error.message : String(error)}` });
			continue;
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
		const evidencePath = path.join(dir, "evidence.json");
		let evidenceStat;
		try {
			evidenceStat = lstatSync(evidencePath);
		} catch {
			continue;
		}
		if (evidenceStat.isSymbolicLink() || !evidenceStat.isFile()) {
			candidates.push({ dir, error: "evidence.json is not a regular file" });
			continue;
		}
		if (evidenceStat.size > MAX_EVIDENCE_BYTES) {
			candidates.push({ dir, error: "evidence.json exceeds the bounded size" });
			continue;
		}
		let evidence;
		try {
			evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
		} catch (error) {
			candidates.push({ dir, error: `evidence.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
			continue;
		}
		candidates.push({ dir, evidencePath, evidence });
	}
	return candidates;
}

function resolveTarball(candidate, version) {
	const problems = [];
	const tarballPath = path.resolve(candidate.evidence.tarball.path);
	const scratchDir = path.resolve(candidate.dir);
	const relative = path.relative(scratchDir, tarballPath);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		problems.push(`evidence tarball path escapes its scratch directory (${candidate.evidence.tarball.path})`);
	}
	const expectedName = `${EXPECTED_PACKAGE_NAME}-${version}.tgz`;
	if (path.basename(tarballPath) !== expectedName) {
		problems.push(`tarball file name must be ${expectedName} (got ${JSON.stringify(path.basename(tarballPath))})`);
	}
	let stat;
	try {
		stat = lstatSync(tarballPath);
	} catch (error) {
		problems.push(`tarball is unreadable: ${error instanceof Error ? error.message : String(error)}`);
		return { problems, tarballPath: null, sha256: null };
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {
		problems.push("tarball is not a regular file");
		return { problems, tarballPath: null, sha256: null };
	}
	const sha256 = sha256File(tarballPath);
	if (candidate.evidence.tarball.sha256 !== sha256) {
		problems.push("evidence tarball sha256 does not match the actual file");
	}
	return { problems, tarballPath, sha256 };
}

export function stageReleaseArtifact({ scratchBase = SCRATCH_DIR_NAME, artifactDir = ARTIFACT_DIR_NAME, env = process.env } = {}) {
	const version = tagVersion(env.GITHUB_REF_NAME ?? "");
	if (version === null) {
		return { ok: false, problems: [`staging requires a "v<version>" tag run (got ${JSON.stringify(env.GITHUB_REF_NAME ?? "")})`] };
	}
	const selection = pickVerifiedEvidenceCandidate(collectEvidenceCandidates(scratchBase));
	if (!selection.ok) return { ok: false, problems: selection.problems };
	const candidate = selection.selected;
	const evaluated = evaluateEvidence(candidate.evidence, {
		expectedTarballBasename: `${EXPECTED_PACKAGE_NAME}-${version}.tgz`,
	});
	if (!evaluated.ok) {
		return { ok: false, problems: evaluated.problems.map((problem) => `${candidate.dir}: ${problem}`) };
	}
	const tarball = resolveTarball(candidate, version);
	if (tarball.problems.length > 0) return { ok: false, problems: tarball.problems };
	const metadataResult = buildReleaseMetadata({
		version,
		commit: env.GITHUB_SHA ?? "",
		tag: env.GITHUB_REF_NAME ?? "",
		sha256: tarball.sha256,
		repo: env.GITHUB_REPOSITORY ?? "",
		sourceRunID: env.SOURCE_RUN_ID ?? "",
		sourceRunAttempt: env.SOURCE_RUN_ATTEMPT ?? "",
		sourceArtifactID: env.SOURCE_ARTIFACT_ID ?? "",
		sourceArtifactDigest: env.SOURCE_ARTIFACT_DIGEST ?? "",
		workflowCommit: env.WORKFLOW_COMMIT ?? env.GITHUB_SHA ?? "",
		releaseRunID: env.RELEASE_RUN_ID ?? env.GITHUB_RUN_ID ?? "",
	});
	if (!metadataResult.ok) return { ok: false, problems: metadataResult.problems };
	const outDir = path.resolve(artifactDir);
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: false });
	copyFileSync(tarball.tarballPath, path.join(outDir, "exact.tgz"));
	copyFileSync(candidate.evidencePath, path.join(outDir, "evidence.json"));
	writeFileSync(path.join(outDir, "release-metadata.json"), `${JSON.stringify(metadataResult.metadata, null, 2)}\n`);
	const staged = evaluateStagedNames(readdirSync(outDir));
	if (!staged.ok) return { ok: false, problems: staged.problems };
	return { ok: true, artifactDir: outDir, metadata: metadataResult.metadata, problems: [] };
}


function walkDownloaded(root, state = { entries: 0, files: [], evidence: [] }, depth = 0) {
	if (depth > MAX_WALK_DEPTH) throw new Error("downloaded artifact nesting exceeds the bound");
	let names;
	try {
		names = readdirSync(root);
	} catch (error) {
		throw new Error(`downloaded artifact directory is unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (const name of names) {
		state.entries += 1;
		if (state.entries > MAX_WALK_ENTRIES) throw new Error("downloaded artifact has too many entries");
		const child = path.join(root, name);
		const stat = lstatSync(child);
		if (stat.isSymbolicLink()) throw new Error("downloaded artifact contains a symlink (rejected)");
		if (stat.isDirectory()) {
			walkDownloaded(child, state, depth + 1);
			continue;
		}
		if (!stat.isFile()) throw new Error("downloaded artifact contains a non-regular entry (rejected)");
		if (stat.nlink !== 1) throw new Error("downloaded artifact contains a hard-linked file (rejected)");
		if (name === "evidence.json") {
			state.evidence.push({ path: child, size: stat.size });
		} else if (name.endsWith(".tgz")) {
			state.files.push({ path: child, size: stat.size, name });
		} else {
			throw new Error(`downloaded artifact contains an unexpected file (rejected): ${name}`);
		}
	}
	return state;
}

/**
 * Stage the ACTUAL downloaded CI artifact layout (nested verifier run
 * directories, legacy Windows evidence.tarball.path) into the exact
 * exact.tgz / evidence.json / release-metadata.json contract.
 *
 * The stale absolute Windows path in evidence is never opened or resolved: only
 * its basename and digest are compared against the tarball found in this
 * download. Exactly one evidence.json and one matching .tgz are required.
 */
export async function stageDownloadedArtifact({ downloadedDir, outDir = ARTIFACT_DIR_NAME, resolutionPath = path.join("release-resolution", "resolved-source.json"), env = process.env }) {
	const downloaded = path.resolve(downloadedDir);
	let downloadedStat;
	try {
		downloadedStat = lstatSync(downloaded);
	} catch {
		return { ok: false, problems: ["downloaded artifact directory is missing"] };
	}
	if (!downloadedStat.isDirectory() || downloadedStat.isSymbolicLink()) {
		return { ok: false, problems: ["downloaded artifact directory is not a regular directory"] };
	}
	let walked;
	try {
		walked = walkDownloaded(downloaded);
	} catch (error) {
		return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
	}
	if (walked.evidence.length !== 1) {
		return { ok: false, problems: [`expected exactly one evidence.json, found ${walked.evidence.length}`] };
	}
	if (walked.evidence[0].size > MAX_EVIDENCE_BYTES) {
		return { ok: false, problems: ["evidence.json exceeds the bounded size"] };
	}
	let resolution;
	try {
		resolution = JSON.parse(readFileSync(path.resolve(resolutionPath), "utf8"));
	} catch {
		return { ok: false, problems: ["resolved source proof is unreadable"] };
	}
	let evidence;
	try {
		evidence = JSON.parse(readFileSync(walked.evidence[0].path, "utf8"));
	} catch {
		return { ok: false, problems: ["evidence.json is not valid JSON"] };
	}
	const version = resolution?.version;
	if (typeof version !== "string" || resolution?.tag !== `v${version}`) {
		return { ok: false, problems: ["resolved source proof version/tag is malformed"] };
	}
	const expectedBasename = `${EXPECTED_PACKAGE_NAME}-${version}.tgz`;
	const evaluated = evaluateEvidence(evidence, { expectedTarballBasename: expectedBasename });
	if (!evaluated.ok) return { ok: false, problems: evaluated.problems };
	const evidenceSha = evidence.tarball.sha256;
	const matches = walked.files.filter((file) => file.name === expectedBasename && file.size <= MAX_TARBALL_BYTES && sha256File(file.path) === evidenceSha);
	if (matches.length !== 1) {
		return { ok: false, problems: [`expected exactly one ${expectedBasename} matching the evidence digest, found ${matches.length}`] };
	}
	const metadataResult = buildReleaseMetadata({
		version,
		commit: resolution.commit,
		tag: resolution.tag,
		sha256: evidenceSha,
		repo: env.GITHUB_REPOSITORY ?? "",
		sourceRunID: resolution.sourceRunID,
		sourceRunAttempt: resolution.sourceRunAttempt,
		sourceArtifactID: resolution.sourceArtifactID,
		sourceArtifactDigest: resolution.sourceArtifactDigest,
		workflowCommit: env.GITHUB_SHA ?? "",
		releaseRunID: env.GITHUB_RUN_ID ?? "",
	});
	if (!metadataResult.ok) return { ok: false, problems: metadataResult.problems };
	const out = path.resolve(outDir);
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: false });
	copyFileSync(matches[0].path, path.join(out, "exact.tgz"));
	copyFileSync(walked.evidence[0].path, path.join(out, "evidence.json"));
	writeFileSync(path.join(out, "release-metadata.json"), `${JSON.stringify(metadataResult.metadata, null, 2)}\n`);
	const staged = evaluateStagedNames(readdirSync(out));
	if (!staged.ok) return { ok: false, problems: staged.problems };
	return { ok: true, artifactDir: out, metadata: metadataResult.metadata, problems: [] };
}

async function main() {
	const args = process.argv.slice(2);
	let downloaded = null;
	let outDir = ARTIFACT_DIR_NAME;
	let resolutionPath = path.join("release-resolution", "resolved-source.json");
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--downloaded" && typeof args[index + 1] === "string") { downloaded = args[index + 1]; index += 1; }
		else if (args[index] === "--out" && typeof args[index + 1] === "string") { outDir = args[index + 1]; index += 1; }
		else if (args[index] === "--resolution" && typeof args[index + 1] === "string") { resolutionPath = args[index + 1]; index += 1; }
	}
	if (downloaded !== null) {
		const downloadedSummary = await stageDownloadedArtifact({ downloadedDir: downloaded, outDir, resolutionPath });
		if (!downloadedSummary.ok) {
			console.error(JSON.stringify({ stage: "failed", problems: downloadedSummary.problems }, null, 2));
			process.exitCode = 1;
			return;
		}
		console.log(JSON.stringify({ stage: "ok", mode: "downloaded", artifactDir: downloadedSummary.artifactDir, metadata: downloadedSummary.metadata }, null, 2));
		return;
	}
	const summary = stageReleaseArtifact();
	if (!summary.ok) {
		console.error(JSON.stringify({ stage: "failed", problems: summary.problems }, null, 2));
		process.exitCode = 1;
		return;
	}
	console.log(JSON.stringify({ stage: "ok", artifactDir: summary.artifactDir, metadata: summary.metadata }, null, 2));
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	await main();
}
