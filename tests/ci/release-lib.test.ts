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

const goodEnv = {
	enabled: "true",
	approvedVersion: VERSION,
	tagRef: `v${VERSION}`,
	manifestVersion: VERSION,
	repoSlug: EXPECTED_REPO_SLUG,
};

function goodMetadata() {
	const result = buildReleaseMetadata({ version: VERSION, commit: COMMIT, tag: `v${VERSION}`, sha256: SHA, repo: EXPECTED_REPO_SLUG });
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
	test("opens only for enabled + approved + matching tag/manifest/repo", () => {
		expect(evaluateReleaseGate(goodEnv)).toEqual({ ok: true, version: VERSION, problems: [] });
	});
	test("absent enable flag blocks", () => {
		const result = evaluateReleaseGate({ ...goodEnv, enabled: "" });
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("SESSIONPORT_RELEASE_ENABLED");
	});
	test("only the exact true string enables release", () => {
		expect(evaluateReleaseGate({ ...goodEnv, enabled: "TRUE" }).ok).toBe(false);
		expect(evaluateReleaseGate({ ...goodEnv, enabled: "1" }).ok).toBe(false);
	});
	test("absent or mismatched approved version blocks", () => {
		expect(evaluateReleaseGate({ ...goodEnv, approvedVersion: "" }).ok).toBe(false);
		const mismatch = evaluateReleaseGate({ ...goodEnv, approvedVersion: "0.2.1" });
		expect(mismatch.ok).toBe(false);
		expect(mismatch.problems.join(" ")).toContain("SESSIONPORT_RELEASE_VERSION");
	});
	test("tag must be v<version>", () => {
		expect(evaluateReleaseGate({ ...goodEnv, tagRef: VERSION }).ok).toBe(false);
	});
	test("manifest version must equal the tag version", () => {
		expect(evaluateReleaseGate({ ...goodEnv, manifestVersion: "0.1.6" }).ok).toBe(false);
	});
	test("immutable versions never release again", () => {
		const result = evaluateReleaseGate({
			enabled: "true",
			approvedVersion: "0.1.6",
			tagRef: "v0.1.6",
			manifestVersion: "0.1.6",
			repoSlug: EXPECTED_REPO_SLUG,
		});
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("immutable");
	});
	test("repository identity is enforced (case-insensitive slug match)", () => {
		expect(evaluateReleaseGate({ ...goodEnv, repoSlug: "attacker/repo" }).ok).toBe(false);
		expect(evaluateReleaseGate({ ...goodEnv, repoSlug: "Maivand-Rahmani/OpenCode-Session-Port" }).ok).toBe(true);
	});
});

describe("buildReleaseMetadata", () => {
	test("builds the exact six-key metadata for valid input", () => {
		const result = buildReleaseMetadata({ version: VERSION, commit: COMMIT, tag: `v${VERSION}`, sha256: SHA, repo: EXPECTED_REPO_SLUG });
		expect(result.ok).toBe(true);
		expect(result.metadata).toEqual({
			name: EXPECTED_PACKAGE_NAME,
			version: VERSION,
			commit: COMMIT,
			tag: `v${VERSION}`,
			sha256: SHA,
			repo: EXPECTED_REPO_SLUG,
		});
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
