import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	bunCommand,
	createScratchRoot,
	planSpawn,
	removeOwnedScratchPath,
	REPO_ROOT,
	runCommand,
} from "../../scripts/package-verify/verify.ts";

/**
 * Windows command-construction and quoting (Ora-43 quoting follow-up).
 *
 * `.exe` commands (including the Bun executable) spawn directly so Bun quotes
 * spaced executable/argument paths itself. Bare names and .cmd/.bat shims run
 * through `cmd.exe /d /s /c "<inner>"` with `windowsVerbatimArguments`, so the
 * pre-quoted command line reaches cmd verbatim and cmd's /S rule strips only
 * the single outer quote pair. Construction tests are deterministic on every
 * platform; the actual-cmd tests are Windows-only and use a workspace-local
 * unique scratch root with verified teardown.
 */

describe("spawn plan construction", () => {
	test("posix spawns directly", () => {
		expect(planSpawn("npm", ["install", "a b"], "linux")).toEqual({
			argv: ["npm", "install", "a b"],
			windowsVerbatimArguments: false,
		});
	});

	test("windows .exe commands spawn directly (no cmd wrapper)", () => {
		const bun = "C:\\Program Files\\Bun\\bun.exe";
		expect(planSpawn(bun, ["-e", "a b"], "win32")).toEqual({
			argv: [bun, "-e", "a b"],
			windowsVerbatimArguments: false,
		});
		expect(planSpawn("C:\\Bun\\BUN.EXE", [], "win32").argv).toEqual(["C:\\Bun\\BUN.EXE"]);
	});

	test("windows bare names use cmd with the extra outer quote pair and verbatim args", () => {
		expect(planSpawn("npm", ["install", "a b"], "win32")).toEqual({
			argv: ["cmd.exe", "/d", "/s", "/c", '"npm install "a b""'],
			windowsVerbatimArguments: true,
		});
	});

	test("windows .cmd paths with spaces and metacharacters are quoted inside the outer pair", () => {
		expect(planSpawn("C:\\Program Files (x86)\\npm.cmd", ["pack", "a&b"], "win32")).toEqual({
			argv: ["cmd.exe", "/d", "/s", "/c", '""C:\\Program Files (x86)\\npm.cmd" pack "a&b""'],
			windowsVerbatimArguments: true,
		});
		expect(planSpawn("C:\\tools\\npm.cmd", ["install"], "win32").argv[4]).toBe('"C:\\tools\\npm.cmd install"');
	});

	test("empty and quote-containing arguments stay grouped", () => {
		expect(planSpawn("npm", ["", 'a"b'], "win32").argv[4]).toBe('"npm "" "a""b""');
	});
});

const isWindows = process.platform === "win32";

describe("actual cmd execution with spaces (Windows only)", () => {
	test.skipIf(!isWindows)("direct .exe spawn passes a spaced script path and spaced arguments", async () => {
		const scratch = createScratchRoot(REPO_ROOT);
		try {
			const script = path.join(scratch, "argv probe.mjs");
			writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
			const result = await runCommand(bunCommand(), [script, "a b", "c d"], REPO_ROOT, 30_000);
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe('["a b","c d"]');
			expect(result.stderr).toBe("");
		} finally {
			removeOwnedScratchPath(REPO_ROOT, scratch);
		}
		expect(existsSync(scratch)).toBe(false);
	});

	test.skipIf(!isWindows)("cmd-wrapped .cmd fixture with a spaced path and metachar arguments executes literally", async () => {
		const scratch = createScratchRoot(REPO_ROOT);
		try {
			const fixture = path.join(scratch, "probe (x) shim.cmd");
			// Delayed expansion prints the received argument after parsing, so the
			// `&` in the value cannot re-split the fixture's own echo line.
			writeFileSync(
				fixture,
				'@echo off\r\nsetlocal EnableDelayedExpansion\r\nset "A=%~1"\r\nset "B=%~2"\r\necho ONE[!A!] TWO[!B!]\r\n',
			);
			const result = await runCommand(fixture, ["a b", "c&d"], REPO_ROOT, 30_000);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("ONE[a b]");
			expect(result.stdout).toContain("TWO[c&d]");
			expect(result.stderr).toBe("");
		} finally {
			removeOwnedScratchPath(REPO_ROOT, scratch);
		}
		expect(existsSync(scratch)).toBe(false);
	});
});
