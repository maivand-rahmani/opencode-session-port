/**
 * SessionPort CI-02 release helpers — shared constants and pure validation.
 *
 * Node builtin ESM only: no project dependencies, no side effects on import.
 * The exported pure functions are covered by focused synthetic Bun tests
 * (tests/ci/). The publish job validates the downloaded artifact with these
 * helpers without installing project dependencies or Bun.
 */

export const EXPECTED_PACKAGE_NAME = "opencode-session-port";
export const EXPECTED_REPO_SLUG = "maivand-rahmani/opencode-session-port";
export const EXPECTED_REPOSITORY_URL = "git+https://github.com/maivand-rahmani/opencode-session-port.git";
export const RELEASE_TAG_PREFIX = "v";
/** Published versions are immutable; 0.1.6 can never be released again. */
export const IMMUTABLE_VERSIONS = Object.freeze(["0.1.6"]);

/** Fixed public npm registry and bounded registry-check timeout; never taken from input. */
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const REGISTRY_TIMEOUT_MS = 30_000;

/** Exactly the files the staging step may place in the release artifact directory. */
export const ARTIFACT_FILE_NAMES = Object.freeze(["evidence.json", "exact.tgz", "release-metadata.json"]);

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const METADATA_KEYS = Object.freeze(["commit", "name", "repo", "sha256", "tag", "version"]);

export function tagVersion(refName) {
	if (typeof refName !== "string" || !refName.startsWith(RELEASE_TAG_PREFIX)) return null;
	const version = refName.slice(RELEASE_TAG_PREFIX.length);
	return VERSION_PATTERN.test(version) ? version : null;
}

export function sameRepoSlug(left, right) {
	return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

/**
 * Fail-closed release gate, evaluated identically in both jobs before any
 * expensive work and again before publish. Absent owner variables block.
 */
export function evaluateReleaseGate({
	enabled,
	approvedVersion,
	tagRef,
	manifestVersion,
	repoSlug,
	expectedRepoSlug = EXPECTED_REPO_SLUG,
	immutableVersions = IMMUTABLE_VERSIONS,
} = {}) {
	const problems = [];
	if (enabled !== "true") {
		problems.push('SESSIONPORT_RELEASE_ENABLED must be exactly "true" (absent or any other value blocks the release)');
	}
	const version = tagVersion(tagRef);
	if (version === null) {
		problems.push(`release tag must match "v<version>" (got ${JSON.stringify(tagRef ?? "")})`);
	}
	if (typeof approvedVersion !== "string" || approvedVersion === "") {
		problems.push("SESSIONPORT_RELEASE_VERSION must be set to the exact owner-approved version");
	} else if (version !== null && approvedVersion !== version) {
		problems.push(`SESSIONPORT_RELEASE_VERSION (${approvedVersion}) must equal the tag version (${version})`);
	}
	if (version !== null && manifestVersion !== version) {
		problems.push(`package.json version (${JSON.stringify(manifestVersion ?? null)}) must equal the tag version (${version})`);
	}
	if (version !== null && immutableVersions.includes(version)) {
		problems.push(`version ${version} is immutable and can never be published again`);
	}
	if (!sameRepoSlug(repoSlug, expectedRepoSlug)) {
		problems.push(`workflow must run in ${expectedRepoSlug} (got ${JSON.stringify(repoSlug ?? "")})`);
	}
	return { ok: problems.length === 0, version, problems };
}

/** Build the exact staged release metadata object; rejects any other identity. */
export function buildReleaseMetadata({ version, commit, tag, sha256, repo, name = EXPECTED_PACKAGE_NAME }) {
	const problems = [];
	if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
		problems.push(`release version is malformed: ${JSON.stringify(version ?? null)}`);
	}
	if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) {
		problems.push(`commit must be a 40-hex SHA (got ${JSON.stringify(commit ?? null)})`);
	}
	if (typeof tag !== "string" || tag !== `${RELEASE_TAG_PREFIX}${String(version)}`) {
		problems.push(`tag must be "${RELEASE_TAG_PREFIX}${String(version)}" (got ${JSON.stringify(tag ?? null)})`);
	}
	if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
		problems.push(`sha256 must be 64 lowercase hex (got ${JSON.stringify(sha256 ?? null)})`);
	}
	if (name !== EXPECTED_PACKAGE_NAME) {
		problems.push(`package name must be ${EXPECTED_PACKAGE_NAME} (got ${JSON.stringify(name)})`);
	}
	if (!sameRepoSlug(repo, EXPECTED_REPO_SLUG)) {
		problems.push(`repository must be ${EXPECTED_REPO_SLUG} (got ${JSON.stringify(repo ?? "")})`);
	}
	const metadata = {
		name: EXPECTED_PACKAGE_NAME,
		version: String(version),
		commit: String(commit),
		tag: String(tag),
		sha256: String(sha256),
		repo: EXPECTED_REPO_SLUG,
	};
	return { ok: problems.length === 0, metadata, problems };
}

function basename(anyPath) {
	return String(anyPath).split(/[\\/]/).pop() ?? "";
}

/**
 * Verify the verifier's evidence.json is a successful install run with all
 * three consumer results recorded; optionally bind digest + tarball name.
 */
export function evaluateEvidence(evidence, { sha256, expectedTarballBasename } = {}) {
	if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
		return { ok: false, problems: ["evidence.json must be a JSON object"] };
	}
	const problems = [];
	if (evidence.withInstall !== true) {
		problems.push("evidence must come from an install run (withInstall must be true)");
	}
	if (!Array.isArray(evidence.problems)) {
		problems.push("evidence.problems must be an array");
	} else if (evidence.problems.length > 0) {
		problems.push(`evidence.problems must be empty (found ${evidence.problems.length})`);
	}
	const consumers = evidence.consumers;
	if (consumers === null || typeof consumers !== "object" || Array.isArray(consumers)) {
		problems.push("evidence.consumers must record the consumer results");
	} else {
		for (const label of ["npmBaseline", "npmHostPeers", "bunBaseline"]) {
			const consumer = consumers[label];
			if (consumer === null || typeof consumer !== "object" || Array.isArray(consumer)) {
				problems.push(`evidence.consumers.${label} result is missing`);
			}
		}
	}
	const tarball = evidence.tarball;
	if (tarball === null || typeof tarball !== "object" || Array.isArray(tarball)) {
		problems.push("evidence.tarball must record the packed tarball");
	} else {
		if (typeof tarball.path !== "string" || tarball.path === "") {
			problems.push("evidence.tarball.path must be a non-empty string");
		} else if (expectedTarballBasename !== undefined && basename(tarball.path) !== expectedTarballBasename) {
			problems.push(`evidence.tarball.path must end with ${expectedTarballBasename} (got ${JSON.stringify(tarball.path)})`);
		}
		if (typeof tarball.sha256 !== "string" || !SHA256_PATTERN.test(tarball.sha256)) {
			problems.push("evidence.tarball.sha256 must be 64 lowercase hex");
		} else if (sha256 !== undefined && tarball.sha256 !== sha256) {
			problems.push("evidence.tarball.sha256 must equal the released tarball digest");
		}
	}
	return { ok: problems.length === 0, problems };
}

/**
 * Select exactly one successful install-evidence candidate from the verifier
 * scratch directories. Any malformed candidate or ambiguity fails closed.
 * Candidates: { dir, evidencePath?, evidence } or { dir, error }.
 */
export function pickVerifiedEvidenceCandidate(candidates) {
	if (!Array.isArray(candidates) || candidates.length === 0) {
		return { ok: false, selected: null, problems: ["no evidence.json found under the verifier scratch directory"] };
	}
	const problems = [];
	const valid = [];
	for (const candidate of candidates) {
		if (candidate === null || typeof candidate !== "object") {
			problems.push("invalid scratch candidate entry");
			continue;
		}
		if (typeof candidate.error === "string" && candidate.error !== "") {
			problems.push(`${candidate.dir}: ${candidate.error}`);
			continue;
		}
		const evaluated = evaluateEvidence(candidate.evidence);
		if (!evaluated.ok) {
			problems.push(...evaluated.problems.map((problem) => `${candidate.dir}: ${problem}`));
			continue;
		}
		valid.push(candidate);
	}
	if (problems.length > 0) return { ok: false, selected: null, problems };
	if (valid.length !== 1) {
		return { ok: false, selected: null, problems: [`expected exactly one successful install evidence, found ${valid.length}`] };
	}
	return { ok: true, selected: valid[0], problems: [] };
}

/** The artifact directory must contain exactly the three staged files. */
export function evaluateStagedNames(entries) {
	if (!Array.isArray(entries)) return { ok: false, problems: ["artifact directory listing is not an array"] };
	const found = [...entries].sort();
	const expected = [...ARTIFACT_FILE_NAMES].sort();
	if (JSON.stringify(found) !== JSON.stringify(expected)) {
		return {
			ok: false,
			problems: [`release artifact must contain exactly ${expected.join(", ")} (found: ${found.join(", ") || "nothing"})`],
		};
	}
	return { ok: true, problems: [] };
}

/**
 * Publish-side rebinding of the downloaded artifact to this run: metadata vs
 * manifest/tag/commit/repo, digest vs the actual exact.tgz, evidence success,
 * and the packed package identity inside the tarball (metadata alone is not
 * trusted).
 */
export function evaluateReleaseBindings({ metadata, manifestVersion, tagRef, commit, repoSlug, tarballSha256, packedManifest }) {
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
		return { ok: false, problems: ["release-metadata.json must be a JSON object"] };
	}
	const problems = [];
	const keys = Object.keys(metadata).sort();
	if (JSON.stringify(keys) !== JSON.stringify([...METADATA_KEYS].sort())) {
		problems.push(`release metadata must contain exactly ${[...METADATA_KEYS].join(", ")} (found: ${keys.join(", ") || "nothing"})`);
	}
	if (metadata.name !== EXPECTED_PACKAGE_NAME) {
		problems.push(`metadata package name must be ${EXPECTED_PACKAGE_NAME} (got ${JSON.stringify(metadata.name ?? null)})`);
	}
	if (!sameRepoSlug(metadata.repo, EXPECTED_REPO_SLUG)) {
		problems.push(`metadata repository must be ${EXPECTED_REPO_SLUG} (got ${JSON.stringify(metadata.repo ?? null)})`);
	}
	const metadataVersion = typeof metadata.version === "string" ? metadata.version : null;
	if (metadataVersion === null) {
		problems.push("metadata version must be a non-empty string");
	} else {
		if (metadata.tag !== `${RELEASE_TAG_PREFIX}${metadataVersion}` || metadata.tag !== tagRef) {
			problems.push(
				`metadata tag (${JSON.stringify(metadata.tag ?? null)}) must match the workflow tag (${JSON.stringify(tagRef ?? null)}) and the metadata version`,
			);
		}
		if (metadataVersion !== manifestVersion) {
			problems.push(`metadata version (${metadataVersion}) must equal the package.json version (${JSON.stringify(manifestVersion ?? null)})`);
		}
	}
	if (metadata.commit !== commit) {
		problems.push(`metadata commit (${JSON.stringify(metadata.commit ?? null)}) must equal the checked-out commit (${JSON.stringify(commit ?? null)})`);
	}
	if (typeof metadata.sha256 !== "string" || !SHA256_PATTERN.test(metadata.sha256)) {
		problems.push("metadata sha256 must be 64 lowercase hex");
	} else if (metadata.sha256 !== tarballSha256) {
		problems.push("metadata sha256 must equal the actual exact.tgz digest");
	}
	if (!sameRepoSlug(repoSlug, EXPECTED_REPO_SLUG)) {
		problems.push(`workflow repository must be ${EXPECTED_REPO_SLUG} (got ${JSON.stringify(repoSlug ?? null)})`);
	}
	if (packedManifest === null || typeof packedManifest !== "object" || Array.isArray(packedManifest)) {
		problems.push("the packed package/package.json must be a JSON object");
	} else {
		if (packedManifest.name !== EXPECTED_PACKAGE_NAME) {
			problems.push(`packed name must be ${EXPECTED_PACKAGE_NAME} (got ${JSON.stringify(packedManifest.name ?? null)})`);
		}
		if (metadataVersion !== null && packedManifest.version !== metadataVersion) {
			problems.push(`packed version (${JSON.stringify(packedManifest.version ?? null)}) must equal the metadata version (${metadataVersion})`);
		}
		const repository = packedManifest.repository;
		const repositoryRecord = repository !== null && typeof repository === "object" && !Array.isArray(repository) ? repository : null;
		const repositoryKeys = repositoryRecord === null ? [] : Object.keys(repositoryRecord).sort();
		if (
			repositoryRecord === null ||
			JSON.stringify(repositoryKeys) !== JSON.stringify(["type", "url"]) ||
			repositoryRecord.type !== "git" ||
			repositoryRecord.url !== EXPECTED_REPOSITORY_URL
		) {
			problems.push(`packed repository must be exactly {"type":"git","url":"${EXPECTED_REPOSITORY_URL}"}`);
		}
	}
	return { ok: problems.length === 0, problems };
}
