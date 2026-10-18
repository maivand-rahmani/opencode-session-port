import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { PROBE_SOURCE } from "../../scripts/package-verify/verify.ts";

/**
 * Regression for the package verifier's dependency-boundary scan.
 *
 * The compiled bundle (built by Bun) emits bare Node builtins
 * (`fs/promises`, `path`, `stream`, `stream/promises`, `zlib`). The embedded
 * probe must exclude Node builtins from the package-dependency set using the
 * authoritative `node:module` isBuiltin check — without suppressing real
 * packages that merely look like builtins (fs-extra, stream-browserify,
 * scoped names, builtin-like subpaths) or hiding absent dependencies.
 *
 * These tests execute the *generated probe* against a fixture install so the
 * behavior is exercised through the real scanner + Bun parsing, not by
 * re-asserting the host isBuiltin API. Scratch lives under the repository's
 * owned `.package-verify-work/` and is cleaned up.
 */

const repoRoot = path.resolve(import.meta.dir, "../..");
const ownedRoots: string[] = [];

afterAll(() => {
	const allowedPrefix = `${path.resolve(repoRoot, ".package-verify-work")}${path.sep}`;
	for (const root of ownedRoots) {
		if (path.resolve(root).startsWith(allowedPrefix)) rmSync(root, { recursive: true, force: true });
	}
});

interface ProbeFixture {
	root: string;
	consumer: string;
	packageRoot: string;
	entry: string;
	wiring: string;
	probe: string;
}

function makeFixture(): ProbeFixture {
	const base = path.join(repoRoot, ".package-verify-work");
	mkdirSync(base, { recursive: true });
	const root = path.join(base, `builtins-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
	ownedRoots.push(root);
	const consumer = path.join(root, "consumer");
	const packageRoot = path.join(consumer, "node_modules", "opencode-session-port");
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "opencode-session-port", version: "0.2.0" }));
	writeFileSync(path.join(packageRoot, "local.js"), "export default 1;\n");

	// Lookalikes that resolve inside the consumer (must stay dependencies).
	for (const name of ["fs-extra", "stream-browserify", "path-extra", "@scope/pkg"]) {
		const dir = path.join(consumer, "node_modules", ...name.split("/"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", main: "index.js" }));
		writeFileSync(path.join(dir, "index.js"), "module.exports = {};\n");
	}

	const entry = path.join(packageRoot, "entry.ts");
	writeFileSync(
		entry,
		[
			// Node builtins in bare form (what Bun.build emits) and prefixed form.
			'import a from "fs/promises";',
			'import b from "path";',
			'import c from "stream";',
			'import d from "stream/promises";',
			'import e from "zlib";',
			'import f from "node:fs";',
			'import g from "node:test";',
			// Package lookalikes: resolvable in this fixture consumer.
			'import h from "fs-extra";',
			'import i from "stream-browserify";',
			'import j from "path-extra";',
			'import k from "@scope/pkg";',
			// Lookalikes that are not builtins and do not resolve here.
			'import l from "fs/promises/extra";',
			'import m from "@scope/fs";',
			'import n from "unknown-synthetic-package";',
			// Local specifier: never a package dependency.
			'import o from "./local.js";',
			"export default [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o];",
			"",
		].join("\n"),
	);
	const wiring = path.join(packageRoot, "wiring.ts");
	writeFileSync(wiring, "export {};\n");
	const probe = path.join(consumer, "probe.mjs");
	writeFileSync(probe, PROBE_SOURCE);
	return { root, consumer, packageRoot, entry, wiring, probe };
}

interface BareFact {
	resolved?: string;
	insideConsumer?: boolean;
	absent?: boolean;
}

function runProbeScan(fixture: ProbeFixture): { mode: string; bare: Record<string, BareFact> } {
	const result = spawnSync(
		process.execPath,
		[fixture.probe, "scan", fixture.packageRoot, fixture.entry, fixture.wiring],
		{ cwd: fixture.consumer, encoding: "utf8", timeout: 60_000, windowsHide: true },
	);
	expect(result.status).toBe(0);
	const line = String(result.stdout)
		.trim()
		.split("\n")
		.filter((candidate) => candidate.trim().startsWith("{"))
		.pop();
	expect(line).toBeTruthy();
	return JSON.parse(line as string) as { mode: string; bare: Record<string, BareFact> };
}

describe("package-verifier builtin classification", () => {
	test("generated probe excludes Node builtins from the dependency set via isBuiltin", () => {
		expect(PROBE_SOURCE).toContain('import { isBuiltin } from "node:module"');
		expect(PROBE_SOURCE).toContain("const isDependencySpecifier = (specifier) =>");
		expect(PROBE_SOURCE).toMatch(/return !isBuiltin\(specifier\);/);
		expect(PROBE_SOURCE).toContain("if (!isDependencySpecifier(specifier)) continue;");
		// The old prefix-only guard must not survive in the collection loop.
		expect(PROBE_SOURCE).not.toMatch(/specifier\.startsWith\("node:"\) \|\| specifier\.startsWith\("file:"\)\) continue;/);
	});

	test("real probe scan skips builtins but keeps lookalikes and absent packages", () => {
		const facts = runProbeScan(makeFixture());
		expect(facts.mode).toBe("scan");
		const bare = facts.bare;

		// Bare builtins emitted by the compiled bundle, prefixed builtins, and
		// a relative specifier are not package dependencies.
		for (const builtin of [
			"fs/promises",
			"path",
			"stream",
			"stream/promises",
			"zlib",
			"node:fs",
			"node:test",
			"./local.js",
		]) {
			expect(bare[builtin]).toBeUndefined();
		}

		// Real packages that look like builtins stay dependencies, resolved
		// inside the clean consumer.
		for (const lookalike of ["fs-extra", "stream-browserify", "path-extra", "@scope/pkg"]) {
			expect(bare[lookalike]).toBeDefined();
			expect(bare[lookalike].insideConsumer).toBe(true);
		}

		// Builtin-like subpaths and scoped names are not builtins; unresolved
		// ones must still surface as absent (failure paths preserved).
		for (const absentLookalike of ["fs/promises/extra", "@scope/fs", "unknown-synthetic-package"]) {
			expect(bare[absentLookalike]).toBeDefined();
			expect(bare[absentLookalike].absent).toBe(true);
		}
	});
});
