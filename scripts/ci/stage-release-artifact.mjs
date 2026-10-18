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
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

async function main() {
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
