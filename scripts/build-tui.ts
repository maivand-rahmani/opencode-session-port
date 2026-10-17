/**
 * SessionPort TUI bundle build (`build:tui`, wired as `prepack`).
 *
 * The host loads the plugin from `dist/tui.js` (via `exports["./tui"]` and the
 * root `tui.ts` shim), so the Solid TSX source under `src/` must be compiled
 * before `npm pack`/publish. This script runs `Bun.build` with the pinned
 * `@opentui/solid/bun-plugin` transform (the package exposes its Solid
 * transform as the module's default export; imported here as `solidPlugin`)
 * and fails nonzero on any build error or missing output.
 *
 * External specifiers stay unbundled so the host runtime resolves them:
 * `@opencode/plugin` (host plugin API), `@opentui/core` and `@opentui/solid`
 * (host-supplied UI peers), and `solid-js` (host-supplied peer). Runtime
 * dependencies (`libsodium-wrappers-sumo`, `pako`) are intentionally bundled
 * into `dist/tui.js`.
 *
 * Output contract: exactly `dist/tui.js` (explicit entry naming). `dist/` is
 * generated build output and is gitignored; it is part of the packed `files`
 * allowlist.
 */

import { existsSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import solidPlugin from "@opentui/solid/bun-plugin";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outdir = path.join(repoRoot, "dist");
const entry = path.join(outdir, "tui.js");

rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ["./src/tui.ts"],
	outdir: "./dist",
	target: "bun",
	plugins: [solidPlugin],
	external: [
		"@opencode/plugin",
		"@opencode/plugin/*",
		"@opentui/core",
		"@opentui/core/*",
		"@opentui/solid",
		"@opentui/solid/*",
		"solid-js",
		"solid-js/*",
	],
	naming: { entry: "tui.js" },
	sourcemap: "none",
});

for (const log of result.logs) {
	console.error(`[build:tui] ${log.level}: ${log.message}`);
}

if (!result.success) {
	console.error("build:tui failed: Bun.build reported errors");
	process.exit(1);
}

if (!existsSync(entry)) {
	console.error(`build:tui failed: expected compiled entry at ${entry}`);
	process.exit(1);
}

const bytes = statSync(entry).size;
if (bytes === 0) {
	console.error(`build:tui failed: ${entry} is empty`);
	process.exit(1);
}

// Informational output goes to stderr so machine-readable `npm pack --json`
// stdout stays clean (prepack runs during `npm pack`).
console.error(`build:tui ok: dist/tui.js (${bytes} bytes)`);
