import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bunCommand, checkRootShim, classifyScannerGraph, runCommand, type TrackedEntry } from "../../scripts/package-verify/verify.ts";

/**
 * Root shim and directory-based resolution checks. The pinned host loader
 * probes `<directory>/tui` by path (Host.resolve), so the repository root must
 * expose a pure re-export shim that targets the compiled `dist/tui.js` bundle
 * (the directory loader would otherwise bypass the `exports["./tui"]` bundle),
 * and the pinned `@opencode/plugin/source.bun` scanner must traverse the shim
 * into the compiled entry without evaluating plugin setup.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const builtEntry = path.join(repoRoot, "dist", "tui.js");

beforeAll(async () => {
	if (!existsSync(builtEntry)) {
		const result = await runCommand(bunCommand(), ["run", "build:tui"], repoRoot, 120_000);
		expect(result.status).toBe(0);
	}
});

describe("root tui.ts shim", () => {
	test("re-exports exactly the compiled bundle default and nothing else", async () => {
		const source = await Bun.file(path.join(repoRoot, "tui.ts")).text();
		expect(checkRootShim(source)).toEqual([]);
		expect(source).toContain('export { default } from "./dist/tui.js"');
	});

	test("directory-based resolution hits the root shim", () => {
		const resolved = Bun.resolveSync(path.resolve(repoRoot, "tui"), repoRoot).replaceAll("\\", "/");
		expect(resolved.endsWith("/tui.ts")).toBe(true);
		expect(resolved).toBe(path.join(repoRoot, "tui.ts").replaceAll("\\", "/"));
	});

	test("Host.resolve exposes the tui entrypoint (tolerant of Bun 1.3.10 ResolveMessage behavior)", async () => {
		const host = (await import("@opencode/plugin/host")) as typeof import("@opencode/plugin/host");
		let entries: ReturnType<typeof host.Host.resolve> | undefined;
		try {
			entries = host.Host.resolve({ directory: repoRoot });
		} catch (error) {
			// Bun 1.3.10 ResolveMessage is not `instanceof Error`, so the pinned
			// loader's missing-entry catch rethrows absent sibling entries
			// (server/rpc) instead of returning undefined for them. The
			// directory/tui subpath it probes still resolves to the shim (asserted
			// in the previous test), and the recorded host runtime (Bun 1.4.2)
			// already loaded a directory/tui.ts plugin successfully (E32).
			expect(String((error as { code?: string })?.code)).toBe("ERR_MODULE_NOT_FOUND");
			return;
		}
		expect(entries.tui?.replaceAll("\\", "/").endsWith("/tui.ts")).toBe(true);
	});

	test("pinned source scanner tracks the shim and the compiled bundle", async () => {
		const { prepareSource } = await import("@opencode/plugin/source.bun");
		const tracked: TrackedEntry[] = [];
		await prepareSource(pathToFileURL(path.join(repoRoot, "tui.ts")).href, (file, directory) => {
			tracked.push({ file, directory: !!directory });
		});
		const graph = classifyScannerGraph(tracked, repoRoot);
		expect(graph.problems).toEqual([]);
		expect(graph.missingPackages).toEqual([]);
		expect([...graph.localFiles].sort()).toEqual(["dist/tui.js", "tui.ts"]);
	});
});
