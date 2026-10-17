import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
	bunCommand,
	checkPackedListing,
	classifyPackedPath,
	parseBunPackListing,
	parseNpmPackJson,
	PACK_TIMEOUT_MS,
	REPO_ROOT,
	runCommand,
} from "../../scripts/package-verify/verify.ts";

/**
 * Packed-surface whitelist and safe no-publish behavior. Pure classification
 * tests pin the allowlist (including the compiled `dist/tui.js` entry); the
 * live dry-run tests confirm npm and Bun both honor the `files` allowlist for
 * the actual workspace, including exclusion of the repository-local
 * `.package-verify-work/` scratch directory. npm runs `prepack` (build:tui)
 * during the dry run, so the listing proves the compiled entry is packed.
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
			".package-verify-work/abc123/tarball/opencode-session-port-0.1.5.tgz",
		]) {
			expect(classifyPackedPath(forbidden)).toBe("forbidden");
		}
	});

	test("anything outside the allowlist is unexpected", () => {
		for (const unexpected of ["tui.jsx", "tsconfig.ts", "opencode-session-port.tgz"]) {
			expect(classifyPackedPath(unexpected)).toBe("unexpected");
		}
	});

	test("checkPackedListing reports missing required paths and forbidden entries", () => {
		expect(
			checkPackedListing(["tui.ts", "src/tui.ts", "src/tui/wiring/index.ts", "dist/tui.js", "tsconfig.json", "package.json", "README.md", "LICENSE"]),
		).toEqual([]);
		const problems = checkPackedListing(["package.json", "README.md", "tui.ts", "src/tui.ts", "src/tui/wiring/index.ts", "tsconfig.json", "docs/v1/decision-log.md"]);
		expect(problems.some((problem) => problem.includes("docs/v1/decision-log.md"))).toBe(true);
		expect(problems.some((problem) => problem.includes("missing required path: LICENSE"))).toBe(true);
		expect(problems.some((problem) => problem.includes("missing required path: dist/tui.js"))).toBe(true);
		const missing = checkPackedListing(["package.json", "README.md"]);
		expect(missing.some((problem) => problem.includes("missing required path: tui.ts"))).toBe(true);
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
		// 56 whitelist-only files after adding the compiled dist/tui.js entry (E51 baseline: 55).
		expect(files.length).toBe(56);
		expect(files).not.toContain("bun.lock");
		expect(files.some((file) => file.startsWith(".package-verify-work/"))).toBe(false);
		expect(existsSync(path.join(REPO_ROOT, "opencode-session-port-0.1.5.tgz"))).toBe(false);
	});

	test("bun pm pack --dry-run honors the allowlist and writes no tarball", async () => {
		const result = await runCommand(bunCommand(), ["pm", "pack", "--dry-run"], REPO_ROOT, PACK_TIMEOUT_MS);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const files = parseBunPackListing(result.stdout);
		expect(checkPackedListing(files)).toEqual([]);
		expect(files).toContain("tui.ts");
		expect(files).toContain("LICENSE");
		expect(files).toContain("dist/tui.js");
		expect(files.length).toBe(56);
		expect(files).not.toContain("bun.lock");
		expect(files.some((file) => file.startsWith(".package-verify-work/"))).toBe(false);
		expect(existsSync(path.join(REPO_ROOT, "opencode-session-port-0.1.5.tgz"))).toBe(false);
	});
});
