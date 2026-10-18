import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import * as path from "node:path";

/**
 * CI-02 durable integration tests: real filesystem scratch + the actual Node
 * CLIs (stage-release-artifact.mjs, validate-release.mjs, release-gate.mjs).
 *
 * - Every workspace is a unique owned directory under the repository's
 *   `.package-verify-work/`; nothing is written outside it.
 * - Each fixture workspace has its own nested `.package-verify-work/` and its
 *   own synthetic package.json, so the repository root manifest and the
 *   repository's historical scratch runs are never read, staged, or modified.
 * - Tarballs are synthetic gzipped tar fixtures; no network, no registry.
 * - The CLIs run under Node (the publish runtime), not Bun, and need only
 *   Node builtins — no project dependencies.
 */

const repoRoot = path.resolve(import.meta.dir, "../..");
const scriptsDir = path.join(repoRoot, "scripts", "ci");
const scratchRootName = ".package-verify-work";
const expectedRepo = "maivand-rahmani/opencode-session-port";
const expectedRepositoryUrl = "git+https://github.com/maivand-rahmani/opencode-session-port.git";
const fixtureCommit = "0123456789abcdef0123456789abcdef01234567";

const ownedRoots: string[] = [];
let candidateCounter = 0;

afterAll(() => {
	const allowedPrefix = `${path.resolve(repoRoot, scratchRootName)}${path.sep}`;
	for (const root of ownedRoots) {
		const resolved = path.resolve(root);
		if (resolved.startsWith(allowedPrefix)) {
			rmSync(resolved, { recursive: true, force: true });
		}
	}
});

function newWorkspace(): string {
	const base = path.join(repoRoot, scratchRootName);
	mkdirSync(base, { recursive: true });
	const root = path.join(base, `ci-integration-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
	mkdirSync(path.join(root, scratchRootName), { recursive: true });
	ownedRoots.push(root);
	return root;
}

function writeFixtureManifest(root: string, version: string): void {
	const manifest = {
		name: "opencode-session-port",
		version,
		private: false,
		repository: { type: "git", url: expectedRepositoryUrl },
	};
	writeFileSync(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function octal(value: number, width: number): string {
	return value.toString(8).padStart(width - 1, "0") + "\u0000";
}

function tarHeader(name: string, size: number, typeflag: string): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000644\u0000", 100, 8, "utf8");
	header.write(octal(0, 8), 108, 8, "utf8");
	header.write(octal(0, 8), 116, 8, "utf8");
	header.write(octal(size, 12), 124, 12, "utf8");
	header.write(octal(0, 12), 136, 12, "utf8");
	header.write("        ", 148, 8, "utf8");
	header.write(typeflag, 156, 1, "utf8");
	header.write("ustar\u000000", 257, 8, "utf8");
	return header;
}

function buildTarball(packedManifestJson: string): Buffer {
	const entries = [
		{ name: "package/tui.ts", content: "export {};" },
		{ name: "package/package.json", content: packedManifestJson },
		{ name: "package/src/tui.ts", content: "export {};" },
	];
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const content = Buffer.from(entry.content, "utf8");
		blocks.push(tarHeader(entry.name, content.length, "0"));
		blocks.push(content);
		const padding = (512 - (content.length % 512)) % 512;
		if (padding > 0) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

function packedManifest(version = "0.2.0", overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		name: "opencode-session-port",
		version,
		repository: { type: "git", url: expectedRepositoryUrl },
		...overrides,
	});
}

interface SyntheticCandidate {
	dir: string;
	evidencePath: string;
	tarballPath: string;
	sha256: string;
}

function writeCandidate(
	root: string,
	options: { version?: string; tarballBytes?: Buffer; tarballNameVersion?: string } = {},
): SyntheticCandidate {
	const version = options.version ?? "0.2.0";
	const bytes = options.tarballBytes ?? buildTarball(packedManifest(version));
	const id = `run-${(candidateCounter += 1)}`;
	const dir = path.join(root, scratchRootName, id);
	const tarballDir = path.join(dir, "tarball");
	mkdirSync(tarballDir, { recursive: true });
	const tarballPath = path.join(tarballDir, `opencode-session-port-${options.tarballNameVersion ?? version}.tgz`);
	writeFileSync(tarballPath, bytes);
	const digest = sha256(bytes);
	const evidence = {
		withInstall: true,
		problems: [],
		consumers: { npmBaseline: { files: [] }, npmHostPeers: { files: [] }, bunBaseline: { files: [] } },
		tarball: { path: tarballPath, sha256: digest },
	};
	const evidencePath = path.join(dir, "evidence.json");
	writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
	return { dir, evidencePath, tarballPath, sha256: digest };
}

function releaseEnv(version: string): Record<string, string> {
	return {
		GITHUB_REF_NAME: `v${version}`,
		GITHUB_SHA: fixtureCommit,
		GITHUB_REPOSITORY: expectedRepo,
	};
}

interface CliResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/** The gate CLI prints a JSON summary followed by a human-readable line. */
function parseLeadingJson(stdout: string): any {
	const lines = stdout.split("\n");
	const end = lines.findIndex((line) => line === "}");
	if (end < 0) throw new Error(`no JSON summary in output: ${stdout}`);
	return JSON.parse(lines.slice(0, end + 1).join("\n"));
}

function runCli(cwd: string, script: string, args: string[] = [], env: Record<string, string> = {}): CliResult {
	const result = spawnSync("node", [path.join(scriptsDir, script), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 60_000,
		windowsHide: true,
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function stage(root: string, version = "0.2.0"): CliResult {
	return runCli(root, "stage-release-artifact.mjs", [], releaseEnv(version));
}

function validate(root: string, version = "0.2.0", artifactDir = "release-artifact"): CliResult {
	return runCli(root, "validate-release.mjs", ["--artifact-dir", artifactDir], releaseEnv(version));
}

describe("CI-02 CLI integration: staging and publish-side validation", () => {
	test("stages exactly the three artifact files with exact metadata, then validates", () => {
		const root = newWorkspace();
		writeFixtureManifest(root, "0.2.0");
		const candidate = writeCandidate(root);

		const staged = stage(root);
		expect(staged.status).toBe(0);
		expect(JSON.parse(staged.stdout).stage).toBe("ok");

		const artifactDir = path.join(root, "release-artifact");
		expect(readdirSync(artifactDir).sort()).toEqual(["evidence.json", "exact.tgz", "release-metadata.json"]);
		const metadata = JSON.parse(readFileSync(path.join(artifactDir, "release-metadata.json"), "utf8"));
		expect(metadata).toEqual({
			name: "opencode-session-port",
			version: "0.2.0",
			commit: fixtureCommit,
			tag: "v0.2.0",
			sha256: candidate.sha256,
			repo: expectedRepo,
		});
		expect(sha256(readFileSync(path.join(artifactDir, "exact.tgz"))) ).toBe(candidate.sha256);

		const validated = validate(root);
		expect(validated.status).toBe(0);
		const summary = JSON.parse(validated.stdout);
		expect(summary.releaseValidation).toBe("ok");
		expect(summary.version).toBe("0.2.0");
		expect(summary.tarballSha256).toBe(candidate.sha256);
	});

	test("release gate CLI opens only for the matching synthetic approval and blocks 0.1.6", () => {
		const futureRoot = newWorkspace();
		writeFixtureManifest(futureRoot, "0.2.0");
		const opened = runCli(futureRoot, "release-gate.mjs", [], {
			...releaseEnv("0.2.0"),
			SESSIONPORT_RELEASE_ENABLED: "true",
			SESSIONPORT_RELEASE_VERSION: "0.2.0",
		});
		expect(opened.status).toBe(0);
		expect(parseLeadingJson(opened.stdout).gate).toBe("open");

		const legacyRoot = newWorkspace();
		writeFixtureManifest(legacyRoot, "0.1.6");
		const blocked = runCli(legacyRoot, "release-gate.mjs", [], {
			...releaseEnv("0.1.6"),
			SESSIONPORT_RELEASE_ENABLED: "true",
			SESSIONPORT_RELEASE_VERSION: "0.1.6",
		});
		expect(blocked.status).toBe(1);
		expect(blocked.stdout).toContain("immutable");
	});

	test("tampered tarball bytes are rejected by the publish validator", () => {
		const root = newWorkspace();
		writeFixtureManifest(root, "0.2.0");
		writeCandidate(root);
		expect(stage(root).status).toBe(0);

		const tarballPath = path.join(root, "release-artifact", "exact.tgz");
		const validBytes = readFileSync(tarballPath);
		expect(sha256(validBytes)).toBe(JSON.parse(readFileSync(path.join(root, "release-artifact", "release-metadata.json"), "utf8")).sha256);

		appendFileSync(tarballPath, Buffer.from([0x00]));
		const validated = validate(root);
		expect(validated.status).toBe(1);
		expect(validated.stdout).toContain("sha256");
	});

	test("digest/commit/tag/version/repo/unknown-key metadata mismatches are rejected", () => {
		const root = newWorkspace();
		writeFixtureManifest(root, "0.2.0");
		const candidate = writeCandidate(root);
		expect(stage(root).status).toBe(0);
		const metadataPath = path.join(root, "release-artifact", "release-metadata.json");
		const base = JSON.parse(readFileSync(metadataPath, "utf8"));

		const tampered = [
			{ ...base, sha256: "d".repeat(64) },
			{ ...base, commit: "e".repeat(40) },
			{ ...base, tag: "v0.2.1" },
			{ ...base, version: "0.2.1" },
			{ ...base, repo: "attacker/repo" },
			{ ...base, unexpected: true },
		];
		for (const variant of tampered) {
			writeFileSync(metadataPath, `${JSON.stringify(variant, null, 2)}\n`);
			const validated = validate(root);
			expect(validated.status).toBe(1);
			expect(JSON.parse(validated.stdout).releaseValidation).toBe("failed");
		}
		writeFileSync(metadataPath, `${JSON.stringify(base, null, 2)}\n`);
		expect(validate(root).status).toBe(0);
		expect(candidate.sha256).toBe(base.sha256);
	});

	test("packed identity inside the tarball must match the staged metadata", () => {
		const cases: Array<Record<string, unknown>> = [
			{ name: "attacker-pkg" },
			{ version: "9.9.9" },
			{ repository: { type: "git", url: "git+https://github.com/attacker/pkg.git" } },
			{ repository: "maivand-rahmani/opencode-session-port" },
		];
		for (const overrides of cases) {
			const root = newWorkspace();
			writeFixtureManifest(root, "0.2.0");
			writeCandidate(root, { tarballBytes: buildTarball(packedManifest("0.2.0", overrides)) });
			expect(stage(root).status).toBe(0);
			const validated = validate(root);
			expect(validated.status).toBe(1);
			expect(validated.stdout).toContain("packed");
		}
	});

	test("unexpected extra files in the artifact directory are rejected", () => {
		const root = newWorkspace();
		writeFixtureManifest(root, "0.2.0");
		writeCandidate(root);
		expect(stage(root).status).toBe(0);
		writeFileSync(path.join(root, "release-artifact", "consumer-tree-marker.txt"), "unexpected");
		const validated = validate(root);
		expect(validated.status).toBe(1);
		expect(validated.stdout).toContain("exactly");
	});

	test("symlinked artifact files are rejected when the platform permits symlinks", () => {
		const root = newWorkspace();
		writeFixtureManifest(root, "0.2.0");
		writeCandidate(root);
		expect(stage(root).status).toBe(0);
		const evidencePath = path.join(root, "release-artifact", "evidence.json");
		const backupPath = path.join(root, "evidence-backup.json");
		renameSync(evidencePath, backupPath);
		try {
			symlinkSync(backupPath, evidencePath);
		} catch {
			renameSync(backupPath, evidencePath);
			return; // Unprivileged Windows cannot create symlinks; unit tests cover the reader.
		}
		const validated = validate(root);
		expect(validated.status).toBe(1);
		expect(validated.stdout).toContain("symlink");
	});

	test("duplicate verified evidence under the scratch root is ambiguous and rejected", () => {
		const root = newWorkspace();
		writeFixtureManifest(root, "0.2.0");
		writeCandidate(root);
		writeCandidate(root);
		const staged = stage(root);
		expect(staged.status).toBe(1);
		expect(staged.stderr).toContain("exactly one");
	});

	test("malformed evidence beside a good candidate fails closed", () => {
		const root = newWorkspace();
		writeFixtureManifest(root, "0.2.0");
		writeCandidate(root);
		const badDir = path.join(root, scratchRootName, "run-bad");
		mkdirSync(badDir, { recursive: true });
		writeFileSync(path.join(badDir, "evidence.json"), "{not json");
		const staged = stage(root);
		expect(staged.status).toBe(1);
		expect(staged.stderr).toContain("not valid JSON");
	});

	test("evidence tarball paths escaping their scratch candidate are rejected", () => {
		const root = newWorkspace();
		writeFixtureManifest(root, "0.2.0");
		const candidate = writeCandidate(root);
		const outsidePath = path.join(root, "outside", "opencode-session-port-0.2.0.tgz");
		mkdirSync(path.dirname(outsidePath), { recursive: true });
		copyFileSync(candidate.tarballPath, outsidePath);
		const evidence = JSON.parse(readFileSync(candidate.evidencePath, "utf8"));
		evidence.tarball.path = outsidePath;
		writeFileSync(candidate.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
		const staged = stage(root);
		expect(staged.status).toBe(1);
		expect(staged.stderr).toContain("escapes its scratch directory");
	});
});
