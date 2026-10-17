import { describe, expect, test } from "bun:test";
import {
	bunCommand,
	REPO_ROOT,
	runCommand,
	terminateProcessTree,
	toTerminableProcess,
	type KillerProcess,
	type TerminationDeps,
	type TerminableProcess,
} from "../../scripts/package-verify/verify.ts";

/**
 * Deadline-termination semantics (Ora-43 remediation). The Windows tree kill
 * is PID-based and must never run after the direct child already exited; a
 * nonzero/failed/absent/timed-out helper falls back to the handle-backed
 * direct-child kill and reports cleanup as uncertain. Branch tests use a
 * controlled fake subprocess interface so no real process is ever killed;
 * the real synthetic-tree tests spawn only their own bounded command tree.
 */

function fakeProc(options: { readonly exited?: boolean } = {}): { proc: TerminableProcess; killCalls: () => number } {
	let killCalls = 0;
	return {
		proc: {
			pid: 4242,
			hasExited: () => options.exited ?? false,
			kill: () => {
				killCalls += 1;
			},
		},
		killCalls: () => killCalls,
	};
}

function fakeDeps(overrides: Partial<TerminationDeps>): TerminationDeps {
	return {
		platform: "win32",
		spawnKiller: () => undefined,
		killerTimeoutMs: 25,
		killerReapMs: 25,
		...overrides,
	};
}

describe("terminateProcessTree branch semantics", () => {
	test("taskkill success is reported and no fallback kill runs", async () => {
		const { proc, killCalls } = fakeProc();
		let helperKillCalls = 0;
		const deps = fakeDeps({
			spawnKiller: () => ({
				exited: Promise.resolve(0),
				kill: () => {
					helperKillCalls += 1;
				},
			}),
		});
		const report = await terminateProcessTree(proc, deps);
		expect(report.cleanup).toBe("reported");
		expect(report.detail).toContain("taskkill");
		expect(killCalls()).toBe(0);
		expect(helperKillCalls).toBe(0);
	});

	test("taskkill nonzero exit falls back to the handle kill and reports uncertain", async () => {
		const { proc, killCalls } = fakeProc();
		const deps = fakeDeps({ spawnKiller: () => ({ exited: Promise.resolve(128), kill: () => {} }) });
		const report = await terminateProcessTree(proc, deps);
		expect(report.cleanup).toBe("uncertain");
		expect(report.detail).toContain("status 128");
		expect(killCalls()).toBe(1);
	});

	test("already-exited child is never targeted by the PID-based tree kill", async () => {
		const { proc, killCalls } = fakeProc({ exited: true });
		let spawnCalls = 0;
		const deps = fakeDeps({
			spawnKiller: () => {
				spawnCalls += 1;
				return { exited: Promise.resolve(0), kill: () => {} };
			},
		});
		const report = await terminateProcessTree(proc, deps);
		expect(spawnCalls).toBe(0);
		expect(report.cleanup).toBe("uncertain");
		expect(report.detail).toContain("already exited");
		expect(killCalls()).toBe(0);
	});

	test("killer spawn failure falls back to the handle kill", async () => {
		const { proc, killCalls } = fakeProc();
		const deps = fakeDeps({ spawnKiller: () => undefined });
		const report = await terminateProcessTree(proc, deps);
		expect(report.cleanup).toBe("uncertain");
		expect(report.detail).toContain("could not be spawned");
		expect(killCalls()).toBe(1);
	});

	test("killer timeout kills the helper, stays bounded, and falls back", async () => {
		const { proc, killCalls } = fakeProc();
		let helperKillCalls = 0;
		const never = new Promise<number | null>(() => {});
		const deps = fakeDeps({
			spawnKiller: () => ({
				exited: never,
				kill: () => {
					helperKillCalls += 1;
				},
			}),
		});
		const started = Date.now();
		const report = await terminateProcessTree(proc, deps);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(1_000);
		expect(helperKillCalls).toBe(1);
		expect(report.cleanup).toBe("uncertain");
		expect(report.detail).toContain("exceeded 25ms");
		expect(report.detail).toContain("reap unconfirmed");
		expect(killCalls()).toBe(1);
	});

	test("killer timeout with a reapable helper reports the helper kill", async () => {
		const { proc } = fakeProc();
		let resolveExited: ((code: number | null) => void) | undefined;
		const exited = new Promise<number | null>((resolve) => {
			resolveExited = resolve;
		});
		const deps = fakeDeps({
			spawnKiller: () => ({
				exited,
				kill: () => resolveExited?.(1),
			}),
		});
		const report = await terminateProcessTree(proc, deps);
		expect(report.cleanup).toBe("uncertain");
		expect(report.detail).toContain("was killed");
	});

	test("non-Windows platforms use only the direct-child kill", async () => {
		const { proc, killCalls } = fakeProc();
		let spawnCalls = 0;
		const deps = fakeDeps({
			platform: "linux",
			spawnKiller: () => {
				spawnCalls += 1;
				return undefined;
			},
		});
		const report = await terminateProcessTree(proc, deps);
		expect(spawnCalls).toBe(0);
		expect(report.cleanup).toBe("uncertain");
		expect(killCalls()).toBe(1);
	});
});

describe("real subprocess behavior (Bun 1.3.10 Windows)", () => {
	test("handle exit semantics used by the stale check are concrete", async () => {
		const child = Bun.spawn([bunCommand(), "-e", "setTimeout(()=>{},3000)"], {
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		const handle = toTerminableProcess(child);
		expect(handle.hasExited()).toBe(false);
		expect(child.exitCode).toBeNull();
		handle.kill();
		await child.exited;
		// Bun 1.3.10 keeps `exitCode` null after a kill (only natural exits set a
		// number); the handle-backed `exited` signal is what flips hasExited.
		expect(handle.hasExited()).toBe(true);
		expect(child.exitCode).toBeNull();
	});

	test("natural exit sets a numeric exitCode", async () => {
		const child = Bun.spawn([bunCommand(), "-e", "0"], {
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		const handle = toTerminableProcess(child);
		await child.exited;
		expect(handle.hasExited()).toBe(true);
		expect(typeof child.exitCode).toBe("number");
	});

	test("normal command completion is unaffected", async () => {
		// Space-free args keep this on the verifier's production arg shape.
		const result = await runCommand(bunCommand(), ["-e", "console.log('termination-ok')"], REPO_ROOT, 30_000);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("termination-ok");
		expect(result.cleanup).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	test.skipIf(process.platform !== "win32")("deadline terminates the synthetic tree and reports taskkill success", async () => {
		const started = Date.now();
		const result = await runCommand(bunCommand(), ["-e", "setInterval(function(){},60000)"], REPO_ROOT, 1_500);
		const elapsed = Date.now() - started;
		expect(result.status).toBeNull();
		expect(result.error).toContain("timeout after 1500ms");
		expect(result.error).not.toContain("uncertain");
		expect(result.cleanup).toBe("reported");
		expect(elapsed).toBeLessThan(10_000);
	});
});
