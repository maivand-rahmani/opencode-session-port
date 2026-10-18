import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

/**
 * CI-02 isolation wrapper for the entry regression tests.
 *
 * `bun test` runs all discovered files in one process, and the entry tests own
 * process-wide `mock.module` fake seams for the UI dialogs and the core
 * crypto/restore modules. Those registrations previously leaked into every
 * test file loaded afterwards (missing named exports, stubbed `planRestore`).
 *
 * The cases and seams therefore live, unchanged, in
 * `tests/tui/fixtures/entry-isolated.fixture.ts` — a name Bun's discovery does
 * NOT match (no `.test`/`_test_`/`.spec`/`_spec_`), so a full `bun test` run can
 * never load it in-process. This wrapper launches exactly that single fixture
 * as a bounded child process (`./`-prefixed path = explicit path, not a
 * discovery filter) and fails hard when the child cannot launch, crashes on a
 * signal, times out, exits non-zero, or changes the expected case counts — the
 * isolated cases cannot silently vanish.
 *
 * The child runs only the synthetic entry tests: no user host, config, or
 * runtime input, and no real crypto initialization (the fixture keeps its
 * original fake seams).
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const fixturePath = path.join(import.meta.dir, "fixtures", "entry-isolated.fixture.ts");
const fixtureFilter = `./${path.relative(repoRoot, fixturePath).split(path.sep).join("/")}`;
const CHILD_TIMEOUT_MS = 30_000;
const PARENT_TEST_TIMEOUT_MS = 45_000;

function runIsolatedFixture(): { status: number | null; signal: NodeJS.Signals | null; error?: Error; output: string } {
	const result = spawnSync(process.execPath, ["test", fixtureFilter], {
		cwd: repoRoot,
		encoding: "utf8",
		timeout: CHILD_TIMEOUT_MS,
		maxBuffer: 2 * 1024 * 1024,
		windowsHide: true,
	});
	return {
		status: result.status,
		signal: result.signal,
		error: result.error,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

describe("SessionPort plugin entrypoint (isolated fixture child)", () => {
	test(
		"runs every entry case in a bounded child with no failures",
		() => {
			const { status, signal, error, output } = runIsolatedFixture();
			expect(error, `child launch failed: ${String(error)}\n${output}`).toBeUndefined();
			expect(signal, `child terminated by signal ${String(signal)}\n${output}`).toBeNull();
			expect(status, `child exited with status ${String(status)}\n${output}`).toBe(0);

			// Exact counts so a child that silently drops or weakens cases fails here.
			expect(output, output).toContain("Ran 6 tests across 1 file");
			const fail = Number(/\b(\d+) fail\b/.exec(output)?.[1] ?? -1);
			const pass = Number(/\b(\d+) pass\b/.exec(output)?.[1] ?? -1);
			// Bun omits zero-count summary lines, so an absent skip line means 0.
			const skip = Number(/\b(\d+) skip\b/.exec(output)?.[1] ?? 0);
			expect(fail, output).toBe(0);
			if (process.platform === "win32") {
				expect(pass, output).toBe(6);
				expect(skip, output).toBe(0);
			} else {
				// The two Windows-only cases keep their original skip behavior.
				expect(pass, output).toBe(4);
				expect(skip, output).toBe(2);
			}
		},
		PARENT_TEST_TIMEOUT_MS,
	);

	test("the child's module mocks never reach this process: real crypto/restore modules stay real", async () => {
		// Directly imports the modules the fixture mocks. If the mock registrations
		// leaked into this process, these imports would throw / expose fakes.
		const crypto = (await import("../../src/core/crypto/index.ts")) as Record<string, unknown>;
		expect(typeof crypto.CryptoContainerError).toBe("function");
		const realCrypto = await import("../../src/core/crypto/container.ts");
		expect(realCrypto.createCheckpointCryptoFactory).toBe(crypto.createCheckpointCryptoFactory);

		const restore = (await import("../../src/core/restore/index.ts")) as Record<string, unknown>;
		expect(typeof restore.RestorePlanError).toBe("function");
		expect(typeof restore.planRestore).toBe("function");
		// The fixture's stub throws "planRestore is not used by entry tests";
		// the real function must not be that stub.
		expect(String(restore.planRestore)).not.toContain("planRestore is not used by entry tests");
	});
});
