import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
	checkManifest,
	EXPECTED_VERSION,
	PACKAGE_FILES_ALLOWLIST,
	REPO_ROOT,
} from "../../scripts/package-verify/verify.ts";

/**
 * Nested pack boundary for the unwired M3 cloud client/vault sources.
 *
 * The root `files` allowlist intentionally stays `src/**` so the cloud sources
 * remain typechecked and unit-testable from the repository. The five unwired
 * `src/cloud/auth` and `src/cloud/vault` modules must therefore be excluded
 * from the plugin tarball by the nested `src/cloud/.npmignore`, not by
 * weakening the allowlist or moving the sources. The live 58-entry proof is
 * `npm pack --dry-run --ignore-scripts --json`; these assertions pin the
 * static invariants that keep that exclusion and the frozen root whitelist in
 * place.
 */

const repoRoot = new URL("../..", import.meta.url);
const rootManifest = (await Bun.file(new URL("package.json", repoRoot)).json()) as Record<string, unknown>;
const rootTsconfig = (await Bun.file(new URL("tsconfig.json", repoRoot)).json()) as Record<string, unknown>;
const nestedIgnore = await Bun.file(new URL("src/cloud/.npmignore", repoRoot)).text();

const CLOUD_SOURCE_FILES = [
	"src/cloud/auth/client.ts",
	"src/cloud/auth/credential-store.ts",
	"src/cloud/auth/types.ts",
	"src/cloud/vault/keyring.ts",
	"src/cloud/vault/types.ts",
];

describe("cloud source pack boundary", () => {
	test("src/cloud/.npmignore excludes its whole tree with no re-inclusion patterns", () => {
		const patterns = nestedIgnore
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
		expect(patterns).toEqual(["*"]);
		expect(patterns.some((pattern) => pattern.startsWith("!"))).toBe(false);
	});

	test("the five unwired cloud sources still exist for client and vault tests", () => {
		for (const relativePath of CLOUD_SOURCE_FILES) {
			expect(existsSync(path.join(REPO_ROOT, relativePath))).toBe(true);
		}
	});

	test("root manifest keeps the exact plugin allowlist, identity, and exports", () => {
		expect(rootManifest.version).toBe(EXPECTED_VERSION);
		expect(rootManifest.files).toEqual([...PACKAGE_FILES_ALLOWLIST]);
		expect(PACKAGE_FILES_ALLOWLIST).toEqual(["tui.ts", "src/**", "dist/**", "tsconfig.json"]);
		expect(PACKAGE_FILES_ALLOWLIST.some((entry) => entry.startsWith("src/cloud"))).toBe(false);
		expect(rootManifest.exports).toEqual({ "./tui": "./dist/tui.js" });
		expect(checkManifest(rootManifest)).toEqual([]);
	});

	test("root TypeScript include still covers src for the cloud unit tests", () => {
		expect(rootTsconfig.include).toEqual(["src"]);
		expect((rootTsconfig.compilerOptions as Record<string, unknown>).noEmit).toBe(true);
	});
});
