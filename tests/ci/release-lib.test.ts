import { describe, expect, test } from "bun:test";
import {
	buildReleaseMetadata,
	evaluateEvidence,
	evaluateReleaseBindings,
	evaluateReleaseGate,
	evaluateStagedNames,
	EXPECTED_PACKAGE_NAME,
	EXPECTED_REPO_SLUG,
	EXPECTED_REPOSITORY_URL,
	pickVerifiedEvidenceCandidate,
	tagVersion,
} from "../../scripts/ci/release-lib.mjs";

/**
 * Synthetic tests for the CI-02 fail-closed release gate, metadata staging
 * selection, artifact bindings, and packed-identity expectations. No network,
 * no filesystem, no installs — only pure helper behavior.
 */

const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);
const VERSION = "0.2.0";
const TARBALL_NAME = `${EXPECTED_PACKAGE_NAME}-${VERSION}.tgz`;

const goodEvidence = {
	withInstall: true,
	problems: [],
	consumers: { npmBaseline: { files: [] }, npmHostPeers: { files: [] }, bunBaseline: { files: [] } },
	tarball: { path: `C:\\repo\\.package-verify-work\\abc\\tarball\\${TARBALL_NAME}`, sha256: SHA },
};

const SOURCE = {
	tag: `v${VERSION}`,
	sourceRunID: "12345",
	sourceRunAttempt: "1",
	sourceArtifactID: "67890",
	sourceArtifactDigest: `sha256:${SHA}`,
};
const WORKFLOW_COMMIT = "b".repeat(40);
const RELEASE_RUN_ID = "99999";

const goodEnv = {
	enabled: "true",
	approvedVersion: VERSION,
	dispatchTag: `v${VERSION}`,
	eventName: "workflow_dispatch",
	ref: "refs/heads/main",
	repoSlug: EXPECTED_REPO_SLUG,
};

function goodMetadata() {
	const result = buildReleaseMetadata({
		version: VERSION,
		commit: COMMIT,
		tag: `v${VERSION}`,
		sha256: SHA,
		repo: EXPECTED_REPO_SLUG,
		sourceRunID: "12345",
		sourceRunAttempt: "1",
		sourceArtifactID: "67890",
		sourceArtifactDigest: `sha256:${SHA}`,
		workflowCommit: WORKFLOW_COMMIT,
		releaseRunID: RELEASE_RUN_ID,
	});
	return result.metadata;
}

const packedManifest = {
	name: EXPECTED_PACKAGE_NAME,
	version: VERSION,
	repository: { type: "git", url: EXPECTED_REPOSITORY_URL },
};

function goodBindings() {
	return {
		metadata: goodMetadata(),
		manifestVersion: VERSION,
		tagRef: `v${VERSION}`,
		commit: COMMIT,
		repoSlug: EXPECTED_REPO_SLUG,
		tarballSha256: SHA,
		packedManifest,
		source: SOURCE,
		workflowCommit: WORKFLOW_COMMIT,
		releaseRunID: RELEASE_RUN_ID,
	};
}

describe("tagVersion", () => {
	test("accepts v<version> and strips the prefix", () => {
		expect(tagVersion("v0.2.0")).toBe("0.2.0");
		expect(tagVersion("v0.2.0-rc.1")).toBe("0.2.0-rc.1");
	});
	test("rejects non-tag refs and malformed versions", () => {
		expect(tagVersion("0.2.0")).toBeNull();
		expect(tagVersion("v")).toBeNull();
		expect(tagVersion("v0.2")).toBeNull();
		expect(tagVersion(undefined)).toBeNull();
	});
});

describe("evaluateReleaseGate", () => {
	test("opens only for a main dispatch with the approved tag and enabled flag", () => {
		expect(evaluateReleaseGate(goodEnv)).toEqual({ ok: true, version: VERSION, problems: [] });
	});
	test("rejects tag pushes even with a v* ref", () => {
		expect(evaluateReleaseGate({ ...goodEnv, eventName: "push", ref: `refs/tags/v${VERSION}` }).ok).toBe(false);
	});
	test("rejects non-main dispatch refs", () => {
		expect(evaluateReleaseGate({ ...goodEnv, ref: `refs/tags/v${VERSION}` }).ok).toBe(false);
		expect(evaluateReleaseGate({ ...goodEnv, ref: "refs/heads/feature" }).ok).toBe(false);
	});
	test("requires enabled exactly true and a non-empty tag input", () => {
		expect(evaluateReleaseGate({ ...goodEnv, enabled: "" }).ok).toBe(false);
		expect(evaluateReleaseGate({ ...goodEnv, enabled: "TRUE" }).ok).toBe(false);
		expect(evaluateReleaseGate({ ...goodEnv, dispatchTag: "" }).ok).toBe(false);
	});
	test("approved version must equal the tag version and immutable versions block", () => {
		expect(evaluateReleaseGate({ ...goodEnv, approvedVersion: "" }).ok).toBe(false);
		expect(evaluateReleaseGate({ ...goodEnv, approvedVersion: "0.2.1" }).ok).toBe(false);
		expect(evaluateReleaseGate({ ...goodEnv, dispatchTag: "0.1.7" }).ok).toBe(false);
		const immutable = evaluateReleaseGate({ ...goodEnv, dispatchTag: "v0.1.6", approvedVersion: "0.1.6" });
		expect(immutable.ok).toBe(false);
		expect(immutable.problems.join(";")).toContain("immutable");
	});
	test("does not require the current checkout package.json version", () => {
		// main may have advanced to 0.1.8 while resuming the 0.1.7 artifact.
		expect(evaluateReleaseGate({ ...goodEnv, manifestVersion: "0.1.8" }).ok).toBe(true);
	});
	test("repository identity is enforced (case-insensitive slug match)", () => {
		expect(evaluateReleaseGate({ ...goodEnv, repoSlug: "attacker/repo" }).ok).toBe(false);
		expect(evaluateReleaseGate({ ...goodEnv, repoSlug: "Maivand-Rahmani/OpenCode-Session-Port" }).ok).toBe(true);
	});
});

describe("buildReleaseMetadata", () => {
	test("builds the exact twelve-key metadata for valid input", () => {
		const metadata = goodMetadata();
		expect(Object.keys(metadata).sort()).toEqual([
			"commit", "name", "releaseRunID", "repo", "sha256", "sourceArtifactDigest",
			"sourceArtifactID", "sourceRunAttempt", "sourceRunID", "tag", "version", "workflowCommit",
		]);
		expect(metadata.sourceRunID).toBe("12345");
		expect(metadata.sourceArtifactDigest).toBe(`sha256:${SHA}`);
		expect(metadata.workflowCommit).toBe(WORKFLOW_COMMIT);
		expect(metadata.releaseRunID).toBe(RELEASE_RUN_ID);
	});
	test("rejects malformed commit, sha, tag, version, and repo", () => {
		expect(buildReleaseMetadata({ version: VERSION, commit: "zz", tag: `v${VERSION}`, sha256: SHA, repo: EXPECTED_REPO_SLUG }).ok).toBe(false);
		expect(buildReleaseMetadata({ version: VERSION, commit: COMMIT, tag: `v${VERSION}`, sha256: "x", repo: EXPECTED_REPO_SLUG }).ok).toBe(false);
		expect(buildReleaseMetadata({ version: VERSION, commit: COMMIT, tag: "v9.9.9", sha256: SHA, repo: EXPECTED_REPO_SLUG }).ok).toBe(false);
		expect(buildReleaseMetadata({ version: "not-a-version", commit: COMMIT, tag: "vnot-a-version", sha256: SHA, repo: EXPECTED_REPO_SLUG }).ok).toBe(false);
		expect(buildReleaseMetadata({ version: VERSION, commit: COMMIT, tag: `v${VERSION}`, sha256: SHA, repo: "someone/else" }).ok).toBe(false);
	});
});

describe("evaluateEvidence", () => {
	test("accepts the successful install shape", () => {
		expect(evaluateEvidence(goodEvidence, { sha256: SHA, expectedTarballBasename: TARBALL_NAME }).ok).toBe(true);
	});
	test("rejects non-objects, non-install runs, and recorded problems", () => {
		expect(evaluateEvidence(null).ok).toBe(false);
		expect(evaluateEvidence("evidence").ok).toBe(false);
		expect(evaluateEvidence({ ...goodEvidence, withInstall: false }).ok).toBe(false);
		expect(evaluateEvidence({ ...goodEvidence, problems: ["boom"] }).ok).toBe(false);
	});
	test("requires all three consumer results", () => {
		expect(evaluateEvidence({ ...goodEvidence, consumers: { npmBaseline: {}, npmHostPeers: {} } }).ok).toBe(false);
	});
	test("binds digest and tarball basename when provided", () => {
		expect(evaluateEvidence(goodEvidence, { sha256: "c".repeat(64) }).ok).toBe(false);
		expect(evaluateEvidence(goodEvidence, { expectedTarballBasename: "other.tgz" }).ok).toBe(false);
	});
});

describe("pickVerifiedEvidenceCandidate", () => {
	const good = { dir: "/scratch/one", evidencePath: "/scratch/one/evidence.json", evidence: goodEvidence };
	test("no candidates fails closed", () => {
		expect(pickVerifiedEvidenceCandidate([]).ok).toBe(false);
	});
	test("exactly one successful candidate is selected", () => {
		const result = pickVerifiedEvidenceCandidate([good]);
		expect(result.ok).toBe(true);
		expect(result.selected).toBe(good);
	});
	test("ambiguity fails", () => {
		const second = { dir: "/scratch/two", evidencePath: "/scratch/two/evidence.json", evidence: goodEvidence };
		const result = pickVerifiedEvidenceCandidate([good, second]);
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("exactly one");
	});
	test("any malformed candidate fails even beside a good one", () => {
		expect(pickVerifiedEvidenceCandidate([good, { dir: "/scratch/bad", error: "evidence.json is not valid JSON" }]).ok).toBe(false);
		expect(pickVerifiedEvidenceCandidate([good, { dir: "/scratch/bad", evidence: { withInstall: true, problems: ["x"] } }]).ok).toBe(false);
	});
});

describe("evaluateStagedNames", () => {
	test("accepts exactly the three staged files", () => {
		expect(evaluateStagedNames(["release-metadata.json", "evidence.json", "exact.tgz"]).ok).toBe(true);
	});
	test("rejects extras, missing files, and subdirectories", () => {
		expect(evaluateStagedNames(["exact.tgz", "evidence.json", "release-metadata.json", "extra.txt"]).ok).toBe(false);
		expect(evaluateStagedNames(["exact.tgz", "evidence.json"]).ok).toBe(false);
		expect(evaluateStagedNames(["exact.tgz", "evidence.json", "release-metadata.json", "npm-baseline"]).ok).toBe(false);
	});
});

describe("evaluateReleaseBindings", () => {
	test("accepts a fully bound artifact", () => {
		expect(evaluateReleaseBindings(goodBindings())).toEqual({ ok: true, problems: [] });
	});
	test("rejects digest, commit, tag, version, and repo mismatches", () => {
		expect(evaluateReleaseBindings({ ...goodBindings(), tarballSha256: "d".repeat(64) }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), commit: "e".repeat(40) }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), tagRef: "v0.2.1" }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), manifestVersion: "0.1.6" }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), repoSlug: "attacker/repo" }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), source: { ...SOURCE, sourceRunID: "55555" } }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), source: { ...SOURCE, sourceArtifactDigest: `sha256:${"d".repeat(64)}` } }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), workflowCommit: "c".repeat(40) }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), releaseRunID: "11111" }).ok).toBe(false);
	});
	test("rejects metadata with unknown or missing keys", () => {
		const extra = { ...goodMetadata(), unexpected: true };
		expect(evaluateReleaseBindings({ ...goodBindings(), metadata: extra }).ok).toBe(false);
		const { commit: _commit, ...missing } = goodMetadata();
		expect(evaluateReleaseBindings({ ...goodBindings(), metadata: missing }).ok).toBe(false);
	});
	test("packed identity inside the tarball is required (metadata alone is not trusted)", () => {
		expect(evaluateReleaseBindings({ ...goodBindings(), packedManifest: { ...packedManifest, name: "attacker-pkg" } }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), packedManifest: { ...packedManifest, version: "9.9.9" } }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), packedManifest: { ...packedManifest, repository: { type: "git", url: "git+https://github.com/attacker/pkg.git" } } }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), packedManifest: { ...packedManifest, repository: "maivand-rahmani/opencode-session-port" } }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), packedManifest: { ...packedManifest, repository: { type: "git", url: EXPECTED_REPOSITORY_URL, extra: true } } }).ok).toBe(false);
		expect(evaluateReleaseBindings({ ...goodBindings(), packedManifest: null }).ok).toBe(false);
	});
});
