import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import {
	bunCommand,
	checkBuiltEntry,
	checkRootShim,
	EXPECTED_EXPORTS,
	REPO_ROOT,
	runCommand,
} from "../../scripts/package-verify/verify.ts";

/**
 * Compiled-entry build checks. `build:tui` (wired as `prepack`) must compile
 * the Solid TSX source into `dist/tui.js` before any pack, and the bundle must
 * be plain JavaScript with no React imports and with the host externals
 * (`@opencode/plugin`, `@opentui/solid`, `solid-js`) left unbundled. These
 * checks read the built artifact only; they never load the plugin or call
 * plugin setup. The build always runs here so no checked-in `dist/` is
 * required (the directory is gitignored).
 */

const builtEntry = path.join(REPO_ROOT, "dist", "tui.js");

beforeAll(async () => {
	const result = await runCommand(bunCommand(), ["run", "build:tui"], REPO_ROOT, 120_000);
	expect(result.status).toBe(0);
});

describe("compiled TUI bundle", () => {
	test("build:tui produces a non-empty dist/tui.js", () => {
		expect(existsSync(builtEntry)).toBe(true);
		expect(statSync(builtEntry).size).toBeGreaterThan(0);
	});

	test("dist/tui.js is plain JS with no React and keeps required externals", () => {
		const source = readFileSync(builtEntry, "utf8");
		expect(checkBuiltEntry(source)).toEqual([]);
		expect(source).not.toMatch(/from\s+["']react/);
		expect(source).not.toContain("jsx-runtime");
	});

	test("native keyring stays external and no .node binary is bundled or copied", async () => {
		const source = readFileSync(builtEntry, "utf8");
		expect(source).toContain("@napi-rs/keyring");
		expect(readdirSync(path.dirname(builtEntry)).filter((name) => name.endsWith(".node"))).toEqual([]);
		const buildScript = await Bun.file(path.join(REPO_ROOT, "scripts", "build-tui.ts")).text();
		expect(buildScript).toContain('"@napi-rs/keyring"');
		expect(buildScript).toContain('"@napi-rs/keyring/*"');
	});

	test("./tui export and root shim both target the compiled bundle", async () => {
		const manifest = (await Bun.file(path.join(REPO_ROOT, "package.json")).json()) as { exports?: Record<string, string> };
		expect(manifest.exports).toEqual(EXPECTED_EXPORTS);
		const resolved = Bun.resolveSync("opencode-session-port/tui", REPO_ROOT).replaceAll("\\", "/");
		expect(resolved.endsWith("/dist/tui.js")).toBe(true);
		const shim = await Bun.file(path.join(REPO_ROOT, "tui.ts")).text();
		expect(checkRootShim(shim)).toEqual([]);
	});
});
