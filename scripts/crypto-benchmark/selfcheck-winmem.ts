#!/usr/bin/env bun
/**
 * Cheap no-KDF self-check for the Windows process-memory reader used by the
 * diagnostic harness. Runs no KDF work and writes no files.
 *
 * Verifies:
 *   1. Bun FFI can load GetProcessMemoryInfo and read PROCESS_MEMORY_COUNTERS.
 *   2. Byte units: WorkingSetSize is compared with process.memoryUsage().rss on
 *      this process (on Windows both are bytes; they should be close).
 *   3. A terminated child's PeakWorkingSetSize remains readable while our
 *      OpenProcess handle is open (the supervisor's post-exit peak capture).
 *
 * Run (from the repository root):
 *   bun run scripts/crypto-benchmark/selfcheck-winmem.ts
 *
 * Exit code 0 = byte-unit check plausible; 1 = not plausible (do not trust the
 * harness's memory numbers until this is explained).
 */

import { openProcessMemoryReader } from "./lib/winmem.ts";

async function main(): Promise<number> {
	if (process.platform !== "win32") {
		console.error("Windows-only self-check.");
		return 1;
	}

	const selfReader = openProcessMemoryReader(process.pid);
	const selfCounters = selfReader.read();
	const rssBytes = process.memoryUsage().rss;
	selfReader.close();

	const workingSetOverRss = selfCounters.workingSetBytes / rssBytes;
	const plausibleByteUnits = Number.isFinite(workingSetOverRss) && workingSetOverRss > 0.5 && workingSetOverRss < 2;

	console.log(
		JSON.stringify(
			{
				check: "winmem-self",
				units: "bytes",
				processWorkingSetBytes: selfCounters.workingSetBytes,
				processPeakWorkingSetBytes: selfCounters.peakWorkingSetBytes,
				bunReportedRssBytes: rssBytes,
				workingSetOverRss: Number(workingSetOverRss.toFixed(4)),
				plausibleByteUnits,
			},
			null,
			2,
		),
	);

	// Terminated-child peak probe: trivial child, no KDF work.
	const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 200)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const childReader = openProcessMemoryReader(child.pid);
	await Bun.sleep(50);
	const aliveCounters = childReader.read();
	const exitCode = await child.exited;
	let postExitCounters: { workingSetBytes: number; peakWorkingSetBytes: number } | null = null;
	try {
		postExitCounters = childReader.read();
	} catch {
		postExitCounters = null;
	}
	childReader.close();

	const postExitPeakReadable = postExitCounters !== null && postExitCounters.peakWorkingSetBytes > 0;

	console.log(
		JSON.stringify(
			{
				check: "winmem-terminated-child",
				childExitCode: exitCode,
				childAliveWorkingSetBytes: aliveCounters.workingSetBytes,
				childAlivePeakWorkingSetBytes: aliveCounters.peakWorkingSetBytes,
				postExitCounters,
				postExitPeakReadable,
			},
			null,
			2,
		),
	);

	return plausibleByteUnits ? 0 : 1;
}

process.exit(await main());
