import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
	bunCommand,
	checkPackedListing,
	classifyPackedPath,
	parseBunPackListing,
	parseNpmPackJson,
	EXPECTED_PACKED_FILE_COUNT,
	PACK_TIMEOUT_MS,
	REPO_ROOT,
	REQUIRED_PACKED_PATHS,
	runCommand,
} from "../../scripts/package-verify/verify.ts";

/**
 * Packed-surface whitelist and safe no-publish behavior. Pure classification
 * tests pin the allowlist (including the compiled `dist/tui.js` entry and the
 * local-first replacement sources); the live dry-run tests confirm npm and Bun
 * both honor the `files` allowlist for the actual workspace, including
 * exclusion of the repository-local `.package-verify-work/` scratch directory.
 * npm runs `prepack` (build:tui) during the dry run, so the listing proves the
 * compiled entry is built by the normal prepack path and packed.
 */

describe("packed path classification", () => {
	test("allowlisted runtime paths", () => {
		for (const allowed of ["tui.ts", "tsconfig.json", "src/tui.ts", "src/tui/ui/password-dialog.tsx", "dist/tui.js"]) {
			expect(classifyPackedPath(allowed)).toBe("allowlisted");
		}
	});

	test("npm-mandatory manifest/readme/license paths", () => {
		for (const auto of ["package.json", "README.md", "readme", "LICENSE", "LICENSE.md", "licence.txt"]) {
			expect(classifyPackedPath(auto)).toBe("auto");
		}
	});

	test("internal, evidence, scratch, and lock paths are forbidden", () => {
		for (const forbidden of [
			"tests/package/manifest.test.ts",
			"scripts/package-verify/verify.ts",
			"docs/v1/decision-log.md",
			".slim/deepwork/sessionport-v1.md",
			"AGENTS.md",
			"wasm-probe.json",
			"bun.lock",
			"bun.lockb",
			"package-lock.json",
			".ignore",
			".gitignore",
			".vscode/settings.json",
			"node_modules/opencode-session-port/package.json",
			".package-verify-work/abc123/canary.txt",
			".package-verify-work/abc123/tarball/opencode-session-port-0.1.6.tgz",
		]) {
			expect(classifyPackedPath(forbidden)).toBe("forbidden");
		}
	});

	test("anything outside the allowlist is unexpected", () => {
		for (const unexpected of ["tui.jsx", "tsconfig.ts", "src-tui.ts"]) {
			expect(classifyPackedPath(unexpected)).toBe("unexpected");
		}
	});

	test("binary, sensitive, evidence, and nested scratch artifacts stay forbidden even under src/dist", () => {
		for (const forbidden of [
			"src/native/addon.node",
			"dist/lib.dylib",
			"src/.env",
			".npmrc",
			"src/cloud/auth/credentials.json",
			"src/cloud/token",
			"src/keys/id_ed25519",
			"src/keys/server.pem",
			"src/keys/server.key",
			"src/state/profile.json",
			"src/profiles/profile",
			"src/evidence/live-host.json",
			"src/cloud/evidence.json",
			"dist/opencode-session-port-0.1.7.tgz",
			"opencode-session-port-0.1.7.tgz",
		]) {
			expect(classifyPackedPath(forbidden)).toBe("forbidden");
		}
		// Intentional TypeScript sources with similar words are not artifacts.
		for (const allowed of ["src/cloud/auth/credential-store.ts", "src/tui/wiring/experimental-profile.ts"]) {
			expect(classifyPackedPath(allowed)).toBe("allowlisted");
		}
	});

	test("checkPackedListing reports missing required paths and forbidden entries", () => {
		expect(
			checkPackedListing([
				...REQUIRED_PACKED_PATHS,
				"package.json",
				"README.md",
				"LICENSE",
			]),
		).toEqual([]);
		const problems = checkPackedListing(["package.json", "README.md", "tui.ts", "src/tui.ts", "src/tui/wiring/index.ts", "tsconfig.json", "docs/v1/decision-log.md"]);
		expect(problems.some((problem) => problem.includes("docs/v1/decision-log.md"))).toBe(true);
		expect(problems.some((problem) => problem.includes("missing required path: LICENSE"))).toBe(true);
		expect(problems.some((problem) => problem.includes("missing required path: dist/tui.js"))).toBe(true);
		const missing = checkPackedListing(["package.json", "README.md"]);
		expect(missing.some((problem) => problem.includes("missing required path: tui.ts"))).toBe(true);
	});

	test("intentional state modules are required exact packed paths", () => {
		// The owner-requested state outbox ships as source under src/**. These
		// exact paths (no wildcard) must stay required; dropping any state file
		// from a packed listing must be reported as a missing required path.
		const statePaths = [
			"src/cloud/state/index.ts",
			"src/cloud/state/store.ts",
			"src/cloud/state/local.ts",
			"src/cloud/state/atomic.ts",
			"src/cloud/state/types.ts",
			"src/cloud/state-codec/index.ts",
			"src/cloud/state-codec/codec.ts",
			"src/cloud/state-codec/errors.ts",
			"src/cloud/state-key/index.ts",
			"src/cloud/state-key/provider.ts",
		];
		for (const statePath of statePaths) {
			expect(REQUIRED_PACKED_PATHS).toContain(statePath);
			const withoutState = REQUIRED_PACKED_PATHS.filter((required) => required !== statePath);
			const problems = checkPackedListing(withoutState);
			expect(problems).toContain(`packed listing is missing required path: ${statePath}`);
		}
		// No wildcard expansion: every non-built-entry required src path is exact.
		for (const required of REQUIRED_PACKED_PATHS) {
			if (required.startsWith("src/")) expect(required).not.toContain("*");
		}
	});

	test("local-first replacement sources are required exact packed paths", () => {
		// The active 0.1.7 local restore/replacement flow ships as source under
		// src/**. These six exact paths (no wildcard) must stay required, and a
		// listing missing any one of them must fail.
		const replacementPaths = [
			"src/core/restore/replacement.ts",
			"src/tui/adapters/session-delete.ts",
			"src/tui/adapters/session-reference-inventory.ts",
			"src/tui/orchestration/local-restore.ts",
			"src/tui/orchestration/newreplacement-execution.ts",
			"src/tui/ui/restore-replacement-dialog.tsx",
		];
		for (const replacementPath of replacementPaths) {
			expect(REQUIRED_PACKED_PATHS).toContain(replacementPath);
			const withoutReplacement = REQUIRED_PACKED_PATHS.filter((required) => required !== replacementPath);
			expect(checkPackedListing(withoutReplacement)).toContain(
				`packed listing is missing required path: ${replacementPath}`,
			);
		}
	});

	test("parseNpmPackJson tolerates prepended lines and parseBunPackListing extracts packed paths", () => {
		const npmListing = parseNpmPackJson('some lifecycle line\n[{"files":[{"path":"tui.ts"},{"path":"dist/tui.js"}]}]');
		expect(npmListing[0]?.files?.map((file) => file.path)).toEqual(["tui.ts", "dist/tui.js"]);
		expect(() => parseNpmPackJson("no json here")).toThrow();
		const listing = parseBunPackListing("bun pack v1.3.10\n\npacked 0.81KB package.json\npacked 92B .ignore\n");
		expect(listing).toEqual(["package.json", ".ignore"]);
	});
});

describe("live dry-run pack listings", () => {
	const npmAvailable = Bun.which("npm") !== null;
	// Let the bounded pack command finish (including timeout cleanup) before the test runner stops it.
	const livePackTestTimeoutMs = PACK_TIMEOUT_MS + 30_000;

	test.skipIf(!npmAvailable)("npm pack --dry-run honors the allowlist, ships dist/tui.js, and writes no tarball", async () => {
		const result = await runCommand("npm", ["pack", "--dry-run", "--json"], REPO_ROOT, PACK_TIMEOUT_MS);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const parsed = parseNpmPackJson(result.stdout);
		const files = (parsed[0]?.files ?? []).map((item) => String(item.path));
		expect(checkPackedListing(files)).toEqual([]);
		expect(files).toContain("tui.ts");
		expect(files).toContain("LICENSE");
		expect(files).toContain("dist/tui.js");
		expect(files).toContain("src/tui.ts");
		// Intentional M3 tarball: prior whitelist plus the shipped cloud-auth
		// source, native wiring, designer UI source, and the owner-requested
		// state outbox (state, state-codec, state-key). Measured before pinning.
		expect(files.length).toBe(EXPECTED_PACKED_FILE_COUNT);
		expect(files).not.toContain("bun.lock");
		expect(files.some((file) => file.startsWith(".package-verify-work/"))).toBe(false);
		expect(existsSync(path.join(REPO_ROOT, "opencode-session-port-0.1.7.tgz"))).toBe(false);
	}, livePackTestTimeoutMs);

	test("bun pm pack --dry-run honors the allowlist and writes no tarball", async () => {
		const result = await runCommand(bunCommand(), ["pm", "pack", "--dry-run"], REPO_ROOT, PACK_TIMEOUT_MS);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const files = parseBunPackListing(result.stdout);
		expect(checkPackedListing(files)).toEqual([]);
		expect(files).toContain("tui.ts");
		expect(files).toContain("LICENSE");
		expect(files).toContain("dist/tui.js");
		expect(files.length).toBe(EXPECTED_PACKED_FILE_COUNT);
		expect(files).not.toContain("bun.lock");
		expect(files.some((file) => file.startsWith(".package-verify-work/"))).toBe(false);
		expect(existsSync(path.join(REPO_ROOT, "opencode-session-port-0.1.7.tgz"))).toBe(false);
	}, livePackTestTimeoutMs);
});
