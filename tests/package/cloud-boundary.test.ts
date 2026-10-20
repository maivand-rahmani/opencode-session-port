import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
	checkManifest,
	classifyPackedPath,
	EXPECTED_VERSION,
	PACKAGE_FILES_ALLOWLIST,
	REQUIRED_PACKED_PATHS,
	REPO_ROOT,
} from "../../scripts/package-verify/verify.ts";

/**
 * Intentional M3 cloud/native pack boundary.
 *
 * The root `files` allowlist stays `src/**`, and the native cloud-auth sources,
 * session owner, keyring adapter, and `/sync` wiring are now delivered inside
 * the plugin tarball. The former blanket `src/cloud/.npmignore` exclusion is
 * intentionally removed so the shipped TUI's source imports resolve and the
 * source graph remains typechecked/unit-tested from the package.
 */

const CLOUD_SOURCE_FILES = [
	"src/cloud/auth/client.ts",
	"src/cloud/auth/configuration.ts",
	"src/cloud/auth/controller.ts",
	"src/cloud/auth/credential-store.ts",
	"src/cloud/auth/session-owner.ts",
	"src/cloud/auth/types.ts",
	"src/cloud/vault/keyring.ts",
	"src/cloud/vault/types.ts",
	"src/tui/wiring/cloud-auth.ts",
	"src/tui/ui/cloud-auth-dialog.tsx",
	"src/tui/ui/cloud-auth-flow.ts",
];

const repoRoot = new URL("../..", import.meta.url);
const rootManifest = (await Bun.file(new URL("package.json", repoRoot)).json()) as Record<string, unknown>;
const rootTsconfig = (await Bun.file(new URL("tsconfig.json", repoRoot)).json()) as Record<string, unknown>;

describe("cloud source pack boundary", () => {
	test("the blanket nested .npmignore exclusion is gone", () => {
		expect(existsSync(path.join(REPO_ROOT, "src/cloud/.npmignore"))).toBe(false);
	});

	test("intentional cloud sources are allowlisted and required in every tarball", () => {
		for (const relativePath of CLOUD_SOURCE_FILES) {
			expect(existsSync(path.join(REPO_ROOT, relativePath))).toBe(true);
			expect(classifyPackedPath(relativePath)).toBe("allowlisted");
			expect(REQUIRED_PACKED_PATHS).toContain(relativePath);
		}
	});

	test("root manifest keeps the exact plugin allowlist, identity, and exports", () => {
		expect(rootManifest.version).toBe(EXPECTED_VERSION);
		expect(rootManifest.files).toEqual([...PACKAGE_FILES_ALLOWLIST]);
		expect(PACKAGE_FILES_ALLOWLIST).toEqual(["tui.ts", "src/**", "dist/**", "tsconfig.json"]);
		expect(rootManifest.exports).toEqual({ "./tui": "./dist/tui.js" });
		expect(checkManifest(rootManifest)).toEqual([]);
	});

	test("root TypeScript include still covers src for the cloud unit tests", () => {
		expect(rootTsconfig.include).toEqual(["src"]);
		expect((rootTsconfig.compilerOptions as Record<string, unknown>).noEmit).toBe(true);
	});
});
