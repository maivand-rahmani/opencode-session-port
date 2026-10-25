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
 * Local-first 0.1.7 cloud/native pack boundary.
 *
 * The paused M3 cloud/native sources (cloud auth, session owner, keyring
 * adapter, state outbox, `/sync` wiring) remain intentionally shipped dormant
 * source inside the plugin tarball: repository and package code are preserved,
 * and the shipped source graph keeps typechecking. They are NOT an active
 * production feature. The active local-first default entry publishes exactly
 * `/checkpoint` and `/restore`, and never constructs a cloud controller,
 * resolves cloud options, reads a keyring, or opens a vault. `/sync` is
 * reachable only through an explicit `createCloudAuth` test seam retained for
 * historical validation, not through the published default runtime.
 *
 * The former blanket `src/cloud/.npmignore` exclusion stays removed so the
 * dormant source imports resolve; binary/native and sensitive artifacts remain
 * forbidden by the package verifier regardless of the `src/**` allowlist.
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
/** Active production composition root for the published entry. */
const installSource = await Bun.file(new URL("src/tui/wiring/install.ts", repoRoot)).text();
/** Command surface shared by the default entry and the explicit test seam. */
const commandsSource = await Bun.file(new URL("src/tui/ui/sessionport-commands.tsx", repoRoot)).text();

describe("cloud source pack boundary", () => {
	test("the blanket nested .npmignore exclusion is gone", () => {
		expect(existsSync(path.join(REPO_ROOT, "src/cloud/.npmignore"))).toBe(false);
	});

	test("intentional cloud sources ship as dormant package source", () => {
		for (const relativePath of CLOUD_SOURCE_FILES) {
			expect(existsSync(path.join(REPO_ROOT, relativePath))).toBe(true);
			expect(classifyPackedPath(relativePath)).toBe("allowlisted");
			expect(REQUIRED_PACKED_PATHS).toContain(relativePath);
		}
	});

	test("active default entry is local-only and activates cloud only through the explicit seam", () => {
		// No static import from the dormant cloud implementation in the active
		// composition root; only the injected handler type is referenced.
		expect(installSource).not.toMatch(/from\s+["'][^"']*\/cloud\//);
		expect(installSource).not.toMatch(/createCloudAuthController\s*\(|createSessionPortCloudAuth\s*\(/);
		expect(installSource).toContain("options.createCloudAuth?.(context)");
		// `/sync` is added only through the conditional spread gated on that seam.
		expect(installSource).toContain("...(cloudAuth !== undefined ? { sync: cloudAuth.sync } : {})");
		// The command layer itself registers only checkpoint/restore before the
		// gated sync block.
		const defaultSurface = commandsSource.slice(0, commandsSource.indexOf("...(handlers.sync"));
		expect(defaultSurface).toContain('slash: { name: "checkpoint"');
		expect(defaultSurface).toContain('slash: { name: "restore"');
		expect(defaultSurface).not.toContain("SESSIONPORT_COMMAND_IDS.sync");
		expect(defaultSurface).not.toContain('name: "sync"');
		expect(commandsSource).toContain("...(handlers.sync !== undefined");
	});

	test("root manifest keeps the exact plugin allowlist, identity, and exports", () => {
		expect(rootManifest.version).toBe(EXPECTED_VERSION);
		expect(rootManifest.files).toEqual([...PACKAGE_FILES_ALLOWLIST]);
		expect(PACKAGE_FILES_ALLOWLIST).toEqual(["tui.ts", "src/**", "dist/**", "tsconfig.json"]);
		expect(rootManifest.exports).toEqual({ "./tui": "./dist/tui.js" });
		expect(checkManifest(rootManifest)).toEqual([]);
	});

	test("root TypeScript include still covers src for the dormant cloud unit tests", () => {
		expect(rootTsconfig.include).toEqual(["src"]);
		expect((rootTsconfig.compilerOptions as Record<string, unknown>).noEmit).toBe(true);
	});
});
