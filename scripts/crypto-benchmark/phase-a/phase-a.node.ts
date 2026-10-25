/**
 * CRYPTO-01 Phase A Node unit/mock tests and explicit CLI entry.
 *
 * Test run (from cloud/api):
 *   node --import tsx --test ../../scripts/crypto-benchmark/phase-a/phase-a.node.ts
 *
 * These tests inject fake child processes, fake memory samplers, and fake
 * timers. They never spawn a benchmark child, never load libsodium, and never
 * perform KDF/seal/open or OS memory probes. A passing Node run is NOT a Bun
 * measurement and does not prove Phase A.
 *
 * Explicit actual-run CLI (only after independent exact-harness review and
 * safety GO):
 *   bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --run-phase-a
 */

import assert from "node:assert/strict";
import {
	CANDIDATE_DEFINITION,
	CANDIDATE_FRAME_BYTES,
	CANDIDATE_LIMITS,
	CANDIDATE_MEM_LIMIT_BYTES,
	CANDIDATE_OPS_LIMIT,
	CANDIDATE_SALT_BYTES,
	CASE_IDS,
	MAX_CHILD_STARTS,
	PHASE_A_CASES,
	SAMPLES_PER_CASE,
	A0_BRIDGE_PLAN,
	A1_CONTROL_MAX_CHILD_STARTS,
	A1_CONTROL_PLAN,
	A2_CONTAINER_MAX_CHILD_STARTS,
	A2_CONTAINER_PLAN,
	A3_A6_SMALL_MAX_CHILD_STARTS,
	A3_A6_SMALL_PLAN,
	FULL_PHASE_A_PLAN,
	candidateReport,
	casePlanReport,
	requireCase,
	type CaseId,
} from "./cases.ts";
import {
	LAUNCH_NONCE_ENV,
	LAUNCH_PARENT_PID_ENV,
	LAUNCH_PLAN_MODE_ENV,
	MAX_PROTOCOL_LINE_BYTES,
	PHASE_A_PROTOCOL_VERSION,
	PhaseAProtocolError,
	BoundedLineAssembler,
	ChildMessageState,
	assertReadyMatchesRequest,
	isLaunchNonce,
	isPhaseARunMode,
	parseChildMessageLine,
	parseStartCommandLine,
	type ChildCompleteMessage,
	type ChildReadyMessage,
	type ExpectedPhaseARuntime,
	type PhaseAOperationReport,
} from "./protocol.ts";
import {
	PHASE_A_FRESHNESS_FILES,
	PHASE_A_MAX_CHILD_ENVELOPE_MS,
	PHASE_A_OPERATIONAL_BOUNDS,
	buildPhaseAReport,
	computePhaseAStats,
	type PhaseAFailureRecord,
	type PhaseAFreshnessEntry,
	type PhaseALibsodiumEvidence,
	type PhaseAReportInput,
	type PhaseASampleRecord,
} from "./report.ts";
import {
	ChildOutputChannel,
	ChildProtocolSession,
	MemoryObservationTracker,
	RetainedBudget,
	checkSupportedRuntime,
	parseBunLockMetadata,
	parseSupervisorArgs,
	runPhaseA,
	runSingleChild,
	runSupervisorCli,
	shouldDispatchCli,
	terminateOwnedChild,
	type ActualRuntime,
	type ChildProcessHandle,
	type PhaseAPorts,
	type ProcessMemoryCounters,
} from "./supervisor.ts";
import {
	CHILD_ACTUAL_RUNNABLE_CASE_IDS,
	bytesEqual,
	checkChildRuntime,
	consumeSealedSource,
	isChildCaseRunnable,
	parseChildArgs,
	runChildCase,
	runContainerOperations,
	validateSupervisorLaunchGuard,
} from "./child.ts";

const cliMain = (import.meta as ImportMeta & { main?: boolean }).main === true;
const cliArgv = process.argv.slice(2);

if (shouldDispatchCli(cliMain)) {
	if (cliArgv[0] === "--child-case") {
		const { runChildCli } = await import("./child.ts");
		process.exit(await runChildCli(cliArgv));
	}
	const { runSupervisorCli } = await import("./supervisor.ts");
	process.exit(await runSupervisorCli(cliArgv));
} else {
	const { default: test } = await import("node:test");

	const ENCODER = new TextEncoder();
	const MIB = 1024 * 1024;
	const GIB = 1024 * MIB;
	const RUNTIME = {
		bun: "1.3.10",
		nodeCompat: "24.3.0",
		platform: "win32",
		arch: "x64",
		libsodiumVersion: "1.0.22",
	} as const;
	const EXPECTED_RUNTIME: ExpectedPhaseARuntime = {
		bun: RUNTIME.bun,
		nodeCompat: RUNTIME.nodeCompat,
		platform: RUNTIME.platform,
		arch: RUNTIME.arch,
	};

	function protocolLine(value: unknown): Uint8Array {
		return ENCODER.encode(`${JSON.stringify(value)}\n`);
	}

	function createReady(
		caseId: CaseId,
		overrides: {
			runtime?: Partial<ChildReadyMessage["runtime"]>;
			candidate?: Partial<ReturnType<typeof candidateReport>>;
			plan?: Partial<ReturnType<typeof casePlanReport>>;
		} = {},
	): ChildReadyMessage {
		const definition = requireCase(caseId);
		const baseCandidate = candidateReport();
		const candidateOverrides = overrides.candidate ?? {};
		const candidate = {
			...baseCandidate,
			...candidateOverrides,
			limits: candidateOverrides.limits ?? baseCandidate.limits,
		};
		return {
			type: "ready",
			protocol: PHASE_A_PROTOCOL_VERSION,
			pid: 4242,
			caseId,
			runtime: { ...RUNTIME, ...overrides.runtime },
			candidate,
			plan: { ...casePlanReport(definition), ...overrides.plan },
		};
	}

	function createComplete(caseId: CaseId): ChildCompleteMessage {
		const definition = requireCase(caseId);
		if (caseId === "A0") {
			return { type: "complete", protocol: PHASE_A_PROTOCOL_VERSION, caseId, pid: 4242, ok: true };
		}
		if (caseId === "A1") {
			return {
				type: "complete",
				protocol: PHASE_A_PROTOCOL_VERSION,
				caseId,
				pid: 4242,
				ok: true,
				kdfControlMs: 25,
			};
		}
		return {
			type: "complete",
			protocol: PHASE_A_PROTOCOL_VERSION,
			caseId,
			pid: 4242,
			ok: true,
			operations: Array.from({ length: definition.pairs }, (_, index) => ({
				sealMs: 10 + index,
				openMs: 20 + index,
				artifactBytes: 1000 + index,
				roundTripMatched: true,
			})),
		};
	}

	function createSample(caseId: CaseId, sampleIndex: number): PhaseASampleRecord {
		const definition = requireCase(caseId);
		const operations: PhaseAOperationReport[] =
			definition.kind === "baseline" || definition.kind === "kdf-control"
				? []
				: Array.from({ length: definition.pairs }, (_, pair) => ({
						sealMs: 10 + sampleIndex + pair * 5,
						openMs: 20 + sampleIndex + pair * 5,
						artifactBytes: 1000 + sampleIndex + pair,
						roundTripMatched: true,
					}));
		return {
			caseId,
			sampleIndex,
			childPid: 5000 + sampleIndex,
			childExitCode: 0,
			runtime: RUNTIME,
			baselineWorkingSetBytes: 100 * MIB,
			sampledIncrementalWorkingSetBytes: 50 * MIB,
			sampledPollCount: 3,
			samplingSpanMs: 40,
			lifetimePeakWorkingSetBytes: 300 * MIB,
			lifetimePeakSource: "post-exit-query",
			termination: "owned-child-exit-verified",
			operations,
			kdfControlMs: caseId === "A1" ? 25 + sampleIndex : null,
		};
	}

	function allSamples(): PhaseASampleRecord[] {
		return PHASE_A_CASES.flatMap((definition) =>
			Array.from({ length: SAMPLES_PER_CASE }, (_, sampleIndex) => createSample(definition.id, sampleIndex)),
		);
	}

	function freshnessFiles(): PhaseAFreshnessEntry[] {
		return PHASE_A_FRESHNESS_FILES.map((relativePath, index) => ({
			path: relativePath,
			bytes: index + 1,
			sha256: "a".repeat(64),
		}));
	}

	function fakeLibsodiumEvidence(): PhaseALibsodiumEvidence {
		return {
			packageName: "libsodium-wrappers-sumo",
			expectedVersion: "0.8.4",
			installed: {
				version: "0.8.4",
				resolvedPackageJsonPath: "C:\\fake\\node_modules\\libsodium-wrappers-sumo\\package.json",
				packageJsonBytes: 2048,
				packageJsonSha256: "b".repeat(64),
				installedBytesIntegrityVerified: false,
			},
			lock: {
				path: "bun.lock",
				entryFound: true,
				resolvedVersion: "0.8.4",
				integrity: "sha512-ql7hcgulKZ3ekfa2DGAogcCKsWU0diA/0nArz1CFzh93WQdb46/Kj18ka/Hifq6uA3Ush34Pc6vU/6HXeRwUkg==",
				integrityKind: "lock-metadata",
				installedBytesVerified: false,
			},
			versionMatchesLock: true,
			note: "Fake metadata only; installed-byte integrity is not verified.",
		};
	}

	function makeReportInput(
		samples: readonly PhaseASampleRecord[],
		overrides: Partial<PhaseAReportInput> = {},
	): PhaseAReportInput {
		return {
			generatedAtIso: "2026-10-19T00:00:00.000Z",
			status: "completed",
			plan: FULL_PHASE_A_PLAN,
			attemptedSamples: MAX_CHILD_STARTS,
			childStarts: MAX_CHILD_STARTS,
			stoppedBySafety: false,
			retainedOutputBytes: 1024,
			runtime: {
				expected: EXPECTED_RUNTIME,
				parent: EXPECTED_RUNTIME,
				children: [RUNTIME],
			},
			freshness: {
				algorithm: "sha256",
				capturedAtIso: "2026-10-19T00:00:00.000Z",
				files: freshnessFiles(),
			},
			libsodium: fakeLibsodiumEvidence(),
			memory: {
				preflightRequiredBytes: PHASE_A_OPERATIONAL_BOUNDS.physicalMemoryPreflightBytes,
				stopBelowBytes: PHASE_A_OPERATIONAL_BOUNDS.physicalMemoryStopBelowBytes,
				source: "fake-physical",
				observedBeforeRunBytes: 4 * GIB,
				observedMinimumDuringRunBytes: 3 * GIB,
				physicalMemoryReadFailures: 0,
			},
			samples,
			failures: [],
			...overrides,
		};
	}

	test("cases: exactly A0-A6 in plan order with 3 samples and 21-child cap", () => {
		assert.deepEqual(CASE_IDS, ["A0", "A1", "A2", "A3", "A4", "A5", "A6"]);
		assert.deepEqual(
			PHASE_A_CASES.map((definition) => definition.id),
			[...CASE_IDS],
		);
		assert.equal(PHASE_A_CASES.length, 7);
		assert.equal(SAMPLES_PER_CASE, 3);
		assert.equal(MAX_CHILD_STARTS, 21);
	});

	test("cases: payload, pair, and password kinds match the approved small-only plan", () => {
		assert.deepEqual(
			PHASE_A_CASES.map((definition) => [
				definition.id,
				definition.payloadBytes,
				definition.pairs,
				definition.passwordKind,
			]),
			[
				["A0", 0, 0, "none"],
				["A1", 0, 0, "wrapper-passphrase"],
				["A2", 32, 1, "wrapper-passphrase"],
				["A3", 256, 1, "wrapper-passphrase"],
				["A4", 1024, 1, "object-root"],
				["A5", 64 * 1024, 1, "object-root"],
				["A6", 32, 2, "wrapper-passphrase"],
			],
		);
		assert.equal(requireCase("A3").wrapperIllustrative, true);
		assert.equal(requireCase("A6").wrapperIllustrative, true);
		assert.equal(requireCase("A5").wrapperIllustrative, false);
	});

	test("cases: candidate is an explicit local borrowed input, not a product profile", () => {
		assert.equal(CANDIDATE_DEFINITION.id, "sessionport-phase-a-candidate-2ops-128mib-not-selected");
		assert.equal(CANDIDATE_DEFINITION.kdf.opsLimit, CANDIDATE_OPS_LIMIT);
		assert.equal(CANDIDATE_DEFINITION.kdf.memLimit, CANDIDATE_MEM_LIMIT_BYTES);
		assert.equal(CANDIDATE_DEFINITION.framing.chunkBytes, CANDIDATE_FRAME_BYTES);
		assert.deepEqual(CANDIDATE_DEFINITION.limits, CANDIDATE_LIMITS);
		assert.equal(CANDIDATE_SALT_BYTES, 16);
		assert.equal(CANDIDATE_FRAME_BYTES, 64 * 1024);
		assert.equal(CANDIDATE_MEM_LIMIT_BYTES, 128 * MIB);
		assert.deepEqual(candidateReport(), {
			id: CANDIDATE_DEFINITION.id,
			opsLimit: 2,
			memLimitBytes: 128 * MIB,
			saltBytes: 16,
			frameBytes: 64 * 1024,
			limits: CANDIDATE_LIMITS,
		});
	});

	test("plans: A0/A1/A2 and grouped A3-A6 are explicit subsets; full plan remains mock/planning only", () => {
		assert.equal(A0_BRIDGE_PLAN.mode, "a0-bridge");
		assert.deepEqual(A0_BRIDGE_PLAN.caseIds, ["A0"]);
		assert.equal(A0_BRIDGE_PLAN.samplesPerCase, 3);
		assert.equal(A0_BRIDGE_PLAN.maxChildStarts, 3);
		assert.equal(A0_BRIDGE_PLAN.runDeadlineMs, 30 * 60 * 1000);
		assert.equal(A1_CONTROL_PLAN.mode, "a1-control");
		assert.deepEqual(A1_CONTROL_PLAN.caseIds, ["A1"]);
		assert.equal(A1_CONTROL_PLAN.samplesPerCase, 3);
		assert.equal(A1_CONTROL_PLAN.maxChildStarts, 3);
		assert.equal(A1_CONTROL_PLAN.maxChildStarts, A1_CONTROL_MAX_CHILD_STARTS);
		assert.equal(A1_CONTROL_PLAN.runDeadlineMs, 30 * 60 * 1000);
		assert.equal(A2_CONTAINER_PLAN.mode, "a2-container");
		assert.deepEqual(A2_CONTAINER_PLAN.caseIds, ["A2"]);
		assert.equal(A2_CONTAINER_PLAN.samplesPerCase, 3);
		assert.equal(A2_CONTAINER_PLAN.maxChildStarts, 3);
		assert.equal(A2_CONTAINER_PLAN.maxChildStarts, A2_CONTAINER_MAX_CHILD_STARTS);
		assert.equal(A2_CONTAINER_PLAN.label, "A2-only container round-trip");
		assert.equal(A2_CONTAINER_PLAN.runDeadlineMs, 30 * 60 * 1000);
		assert.equal(A3_A6_SMALL_PLAN.mode, "a3-a6-small");
		assert.deepEqual(A3_A6_SMALL_PLAN.caseIds, ["A3", "A4", "A5", "A6"]);
		assert.equal(A3_A6_SMALL_PLAN.samplesPerCase, 3);
		assert.equal(A3_A6_SMALL_PLAN.maxChildStarts, 12);
		assert.equal(A3_A6_SMALL_PLAN.maxChildStarts, A3_A6_SMALL_MAX_CHILD_STARTS);
		assert.equal(A3_A6_SMALL_PLAN.runDeadlineMs, 30 * 60 * 1000);
		assert.equal(A3_A6_SMALL_PLAN.label, "A3-A6 small grouped cases");
		assert.equal(FULL_PHASE_A_PLAN.mode, "full-phase-a");
		assert.deepEqual(FULL_PHASE_A_PLAN.caseIds, [...CASE_IDS]);
		assert.equal(FULL_PHASE_A_PLAN.maxChildStarts, 21);
		assert.equal(FULL_PHASE_A_PLAN.samplesPerCase, 3);
		assert.equal(A0_BRIDGE_PLAN.maxChildStarts < MAX_CHILD_STARTS, true);
		assert.equal(A1_CONTROL_PLAN.maxChildStarts < MAX_CHILD_STARTS, true);
		assert.equal(A2_CONTAINER_PLAN.maxChildStarts < MAX_CHILD_STARTS, true);
		assert.equal(A3_A6_SMALL_PLAN.maxChildStarts < MAX_CHILD_STARTS, true);
	});

	test("protocol: valid READY and all case-specific COMPLETE shapes parse", () => {
		const ready = createReady("A0");
		assert.deepEqual(parseChildMessageLine(JSON.stringify(ready)), ready);
		for (const caseId of CASE_IDS) {
			const complete = createComplete(caseId);
			assert.deepEqual(parseChildMessageLine(JSON.stringify(complete)), complete);
		}
		const failure = {
			type: "complete",
			protocol: 1,
			caseId: "A2",
			pid: 4242,
			ok: false,
			failureCode: "open-failed",
		};
		assert.deepEqual(parseChildMessageLine(JSON.stringify(failure)), failure);
		const error = { type: "error", protocol: 1, caseId: "A2", code: "seal-failed" };
		assert.deepEqual(parseChildMessageLine(JSON.stringify(error)), error);
	});

	test("protocol: unknown fields, missing fields, and unknown message types fail", () => {
		assert.throws(
			() => parseChildMessageLine(JSON.stringify({ ...createReady("A0"), extra: true })),
			/unexpected field/,
		);
		const missing = createReady("A0") as unknown as Record<string, unknown>;
		delete missing["runtime"];
		assert.throws(() => parseChildMessageLine(JSON.stringify(missing)), /missing required field/);
		assert.throws(() => parseChildMessageLine(JSON.stringify({ type: "unknown" })), /unknown type/);
	});

	test("protocol: invalid JSON, oversized line, and multiline input fail closed", () => {
		assert.throws(() => parseChildMessageLine(""), /empty/);
		assert.throws(() => parseChildMessageLine("not-json"), /valid JSON/);
		assert.throws(
			() => parseChildMessageLine("x".repeat(MAX_PROTOCOL_LINE_BYTES + 1)),
			/64 KiB/,
		);
		assert.throws(
			() => parseChildMessageLine(`${JSON.stringify(createReady("A0"))}\nmore`),
			/single line/,
		);
	});

	test("protocol: numeric, case, operation-count, and failure-code validation", () => {
		assert.throws(
			() =>
				parseChildMessageLine(
					JSON.stringify({
						...createComplete("A2"),
						operations: [{ sealMs: -1, openMs: 2, artifactBytes: 10, roundTripMatched: true }],
					}),
				),
			/non-negative/,
		);
		assert.throws(
			() =>
				parseChildMessageLine(
					JSON.stringify({
						...createComplete("A2"),
						operations: [{ sealMs: "1", openMs: 2, artifactBytes: 10, roundTripMatched: true }],
					}),
				),
			/finite number/,
		);
		const a6Complete = createComplete("A6");
		const a6Operations = "operations" in a6Complete ? a6Complete.operations : undefined;
		assert.throws(
			() =>
				parseChildMessageLine(
					JSON.stringify({
						...a6Complete,
						operations: a6Operations?.slice(0, 1),
					}),
				),
			/exactly 2 operation/,
		);
		assert.throws(
			() =>
				parseChildMessageLine(
					JSON.stringify({
						type: "complete",
						protocol: 1,
						caseId: "A2",
						pid: 1,
						ok: false,
						failureCode: "raw-vendor-error",
					}),
				),
			/allowed child failure code/,
		);
		assert.throws(() => parseChildMessageLine(JSON.stringify({ ...createReady("A0"), caseId: "A9" })), /case id/);
	});

	test("protocol: READY runtime/candidate/plan must match the requested case", () => {
		assert.throws(
			() =>
				assertReadyMatchesRequest(
					createReady("A0", { runtime: { bun: "1.2.0" } }),
					requireCase("A0"),
					EXPECTED_RUNTIME,
					candidateReport(),
				),
			/runtime does not match/,
		);
		assert.throws(
			() =>
				assertReadyMatchesRequest(
					createReady("A0", { candidate: { opsLimit: 3 } }),
					requireCase("A0"),
					EXPECTED_RUNTIME,
					candidateReport(),
				),
			/candidate does not match/,
		);
		assert.throws(
			() => assertReadyMatchesRequest(createReady("A1"), requireCase("A2"), EXPECTED_RUNTIME, candidateReport()),
			/case id does not match/,
		);
		assert.throws(
			() =>
				assertReadyMatchesRequest(
					createReady("A2", { plan: { payloadBytes: 1 } }),
					requireCase("A2"),
					EXPECTED_RUNTIME,
					candidateReport(),
				),
			/plan does not match/,
		);
	});

	test("protocol: sequence state requires one READY before one COMPLETE", () => {
		const state = new ChildMessageState();
		assert.throws(() => state.accept(createComplete("A0")), /before READY/);
		state.accept(createReady("A0"));
		state.accept(createComplete("A0"));
		assert.throws(() => state.accept(createComplete("A0")), /more than one COMPLETE/);
		const second = new ChildMessageState();
		second.accept(createReady("A0"));
		assert.throws(() => second.accept(createReady("A0")), /more than one READY/);
	});

	test("protocol: line assembler enforces 64 KiB and newline termination", () => {
		const assembler = new BoundedLineAssembler();
		assert.deepEqual(assembler.push(ENCODER.encode("a\nb\n")), ["a", "b"]);
		const incomplete = new BoundedLineAssembler();
		incomplete.push(ENCODER.encode("a"));
		assert.throws(() => incomplete.finish(), /ended inside/);
		const overflow = new BoundedLineAssembler();
		assert.throws(
			() => overflow.push(ENCODER.encode("x".repeat(MAX_PROTOCOL_LINE_BYTES + 1))),
			/64 KiB/,
		);
		const invalidUtf8 = new BoundedLineAssembler();
		assert.throws(() => invalidUtf8.push(new Uint8Array([0xff, 0x0a])), /valid UTF-8/);
	});

	test("protocol: start command parser is exact, nonce-bound, mode-bound, and case-bounded", () => {
		const nonce = "a".repeat(32);
		assert.deepEqual(
			parseStartCommandLine(
				JSON.stringify({ type: "start", protocol: 1, caseId: "A1", launchNonce: nonce, mode: "a1-control" }),
			),
			{
				type: "start",
				protocol: 1,
				caseId: "A1",
				launchNonce: nonce,
				mode: "a1-control",
			},
		);
		assert.throws(
			() =>
				parseStartCommandLine(
					JSON.stringify({ type: "start", protocol: 1, caseId: "A3", launchNonce: nonce, mode: "a0-bridge", extra: true }),
				),
			/unexpected field/,
		);
		assert.throws(
			() =>
				parseStartCommandLine(
					JSON.stringify({ type: "start", protocol: 1, caseId: "A9", launchNonce: nonce, mode: "a0-bridge" }),
				),
			/case id/,
		);
		assert.throws(
			() =>
				parseStartCommandLine(
					JSON.stringify({ type: "start", protocol: 1, caseId: "A1", launchNonce: "bad", mode: "a1-control" }),
				),
			/launch nonce/,
		);
		assert.throws(
			() =>
				parseStartCommandLine(
					JSON.stringify({ type: "start", protocol: 1, caseId: "A1", launchNonce: nonce, mode: "not-a-mode" }),
				),
			/run mode/,
		);
		assert.equal(isLaunchNonce(nonce), true);
		assert.equal(isLaunchNonce("bad"), false);
		assert.equal(isPhaseARunMode("a1-control"), true);
		assert.equal(isPhaseARunMode("a2-container"), true);
		assert.equal(isPhaseARunMode("full-phase-a"), true);
		assert.equal(isPhaseARunMode("other"), false);
	});

	test("output: per-channel and shared run retained budgets are enforced", () => {
		const run = new RetainedBudget(10);
		const stdout = new ChildOutputChannel(6, run);
		stdout.push(ENCODER.encode("1234567"));
		assert.equal(stdout.totalBytes, 7);
		assert.equal(stdout.retainedBytes, 6);
		assert.equal(stdout.overflow, true);
		assert.equal(run.retainedBytes, 6);
		const stderr = new ChildOutputChannel(6, run);
		stderr.push(ENCODER.encode("12345"));
		assert.equal(stderr.retainedBytes, 4);
		assert.equal(stderr.runOverflow, true);
		assert.equal(run.retainedBytes, 10);
		const zero = new RetainedBudget(0);
		assert.deepEqual(zero.reserve(1), { retained: 0, overflow: true });
	});

	test("stats: min/median/max only, including even-count median", () => {
		assert.deepEqual(computePhaseAStats([3, 1, 2]), { count: 3, min: 1, median: 2, max: 3 });
		assert.deepEqual(computePhaseAStats([1, 2, 3, 4]), { count: 4, min: 1, median: 2.5, max: 4 });
		assert.equal(computePhaseAStats([]), null);
		assert.throws(() => computePhaseAStats([-1]));
		const stats = computePhaseAStats([1]);
		assert.ok(stats !== null);
		assert.equal("p95" in stats, false);
	});

	test("bounds: corrected operational bounds fit the 30-minute run deadline", () => {
		assert.equal(PHASE_A_OPERATIONAL_BOUNDS.childDeadlineMs, 45_000);
		assert.equal(PHASE_A_OPERATIONAL_BOUNDS.childStopGraceMs, 5_000);
		assert.equal(PHASE_A_OPERATIONAL_BOUNDS.runDeadlineMs, 30 * 60 * 1000);
		assert.equal(PHASE_A_OPERATIONAL_BOUNDS.maxChildStarts, 21);
		assert.equal(PHASE_A_OPERATIONAL_BOUNDS.maxProtocolLineBytes, 64 * 1024);
		assert.equal(PHASE_A_OPERATIONAL_BOUNDS.maxRetainedStdoutBytesPerChild, 512 * 1024);
		assert.equal(PHASE_A_OPERATIONAL_BOUNDS.maxRetainedStderrBytesPerChild, 512 * 1024);
		assert.equal(PHASE_A_OPERATIONAL_BOUNDS.maxRetainedOutputBytesPerRun, 4 * 1024 * 1024);
		assert.equal(PHASE_A_OPERATIONAL_BOUNDS.physicalMemoryPreflightBytes, 2 * GIB);
		assert.equal(PHASE_A_OPERATIONAL_BOUNDS.physicalMemoryStopBelowBytes, 1 * GIB);
		assert.equal(PHASE_A_MAX_CHILD_ENVELOPE_MS, 21 * (45_000 + 5_000));
		assert.ok(PHASE_A_MAX_CHILD_ENVELOPE_MS < PHASE_A_OPERATIONAL_BOUNDS.runDeadlineMs);
	});

	test("runtime: only Windows Bun 1.3.10 x64/arm64 is accepted", () => {
		assert.deepEqual(checkSupportedRuntime({ bun: "1.3.10", nodeCompat: "24.3.0", platform: "win32", arch: "x64" }), {
			ok: true,
		});
		assert.deepEqual(checkSupportedRuntime({ bun: "1.2.0", nodeCompat: "24.3.0", platform: "win32", arch: "x64" }), {
			ok: false,
			code: "preflight-runtime",
		});
		assert.deepEqual(checkSupportedRuntime({ bun: "1.3.10", nodeCompat: "24.3.0", platform: "linux", arch: "x64" }), {
			ok: false,
			code: "preflight-runtime",
		});
		assert.deepEqual(checkSupportedRuntime({ bun: "1.3.10", nodeCompat: "24.3.0", platform: "win32", arch: "ia32" }), {
			ok: false,
			code: "preflight-runtime",
		});
		assert.equal(checkChildRuntime({ platform: "win32", arch: "x64", bun: "1.3.10" }), true);
		assert.equal(checkChildRuntime({ platform: "win32", arch: "x64", bun: "1.2.0" }), false);
	});

	test("cli: grouped/container/control/bridge modes, full run fail-closed, child flag, and inert import guard", () => {
		assert.deepEqual(parseSupervisorArgs(["--bridge-a0-only"]), { kind: "bridge-a0-only" });
		assert.deepEqual(parseSupervisorArgs(["--control-a1-only"]), { kind: "control-a1-only" });
		assert.deepEqual(parseSupervisorArgs(["--container-a2-only"]), { kind: "container-a2-only" });
		assert.deepEqual(parseSupervisorArgs(["--small-a3-a6-only"]), { kind: "small-a3-a6-only" });
		assert.deepEqual(parseSupervisorArgs(["--run-phase-a"]), { kind: "full-review-required" });
		assert.deepEqual(parseSupervisorArgs(["--help"]), { kind: "help" });
		assert.equal(shouldDispatchCli(false), false);
		assert.equal(shouldDispatchCli(true), true);
		assert.throws(() => parseSupervisorArgs([]), /explicit --small-a3-a6-only/);
		assert.deepEqual(parseChildArgs(["--child-case", "A0"]), { kind: "run", caseId: "A0" });
		assert.deepEqual(parseChildArgs(["--child-case", "A1"]), { kind: "run", caseId: "A1" });
		assert.deepEqual(parseChildArgs(["--child-case", "A2"]), { kind: "run", caseId: "A2" });
		assert.deepEqual(parseChildArgs(["--child-case", "A3"]), { kind: "run", caseId: "A3" });
		assert.deepEqual(parseChildArgs(["--child-case", "A6"]), { kind: "run", caseId: "A6" });
		assert.throws(() => parseChildArgs(["--child-case"]));
		assert.throws(() => parseChildArgs(["--child-case", "A9"]));
		assert.deepEqual(CHILD_ACTUAL_RUNNABLE_CASE_IDS, [...CASE_IDS]);
		assert.equal(CASE_IDS.filter((caseId) => !isChildCaseRunnable(caseId)).length, 0);
	});

	test("cli: --run-phase-a fails closed without runtime setup or child launch", async () => {
		const originalWrite = process.stderr.write;
		let captured = "";
		process.stderr.write = ((chunk: unknown) => {
			captured += String(chunk);
			return true;
		}) as typeof process.stderr.write;
		try {
			const code = await runSupervisorCli(["--run-phase-a"]);
			assert.equal(code, 1);
			assert.match(captured, /FAIL-CLOSED/);
			assert.match(captured, /not authorized/);
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	test("child: direct A3-A6 invocation without supervisor context fails closed; all cases have source modes", async () => {
		assert.equal(CHILD_ACTUAL_RUNNABLE_CASE_IDS.length, 7);
		assert.deepEqual(CHILD_ACTUAL_RUNNABLE_CASE_IDS, [...CASE_IDS]);
		assert.equal(CASE_IDS.filter((caseId) => !isChildCaseRunnable(caseId)).length, 0);
		for (const caseId of ["A3", "A4", "A5", "A6"] as const) {
			assert.equal(await runChildCase(caseId), 1);
		}
	});

	test("child: supervisor launch guard requires matching plan mode, nonce, expected parent PID, and case", () => {
		const nonce = "c".repeat(32);
		assert.deepEqual(
			validateSupervisorLaunchGuard({
				caseId: "A0",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a0-bridge",
				actualParentPid: 1234,
			}),
			{ ok: true, nonce, planMode: "a0-bridge" },
		);
		assert.deepEqual(
			validateSupervisorLaunchGuard({
				caseId: "A1",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a1-control",
				actualParentPid: 1234,
			}),
			{ ok: true, nonce, planMode: "a1-control" },
		);
		assert.deepEqual(
			validateSupervisorLaunchGuard({
				caseId: "A2",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a2-container",
				actualParentPid: 1234,
			}),
			{ ok: true, nonce, planMode: "a2-container" },
		);
		assert.deepEqual(
			validateSupervisorLaunchGuard({
				caseId: "A3",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a3-a6-small",
				actualParentPid: 1234,
			}),
			{ ok: true, nonce, planMode: "a3-a6-small" },
		);
		assert.deepEqual(
			validateSupervisorLaunchGuard({
				caseId: "A6",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a3-a6-small",
				actualParentPid: 1234,
			}),
			{ ok: true, nonce, planMode: "a3-a6-small" },
		);
		assert.equal(
			validateSupervisorLaunchGuard({
				caseId: "A3",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a2-container",
				actualParentPid: 1234,
			}).ok,
			false,
		);
		assert.equal(
			validateSupervisorLaunchGuard({
				caseId: "A6",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a1-control",
				actualParentPid: 1234,
			}).ok,
			false,
		);
		assert.equal(
			validateSupervisorLaunchGuard({
				caseId: "A2",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a1-control",
				actualParentPid: 1234,
			}).ok,
			false,
		);
		assert.equal(
			validateSupervisorLaunchGuard({
				caseId: "A1",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a0-bridge",
				actualParentPid: 1234,
			}).ok,
			false,
		);
		assert.equal(
			validateSupervisorLaunchGuard({
				caseId: "A3",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a2-container",
				actualParentPid: 1234,
			}).ok,
			false,
		);
		assert.equal(
			validateSupervisorLaunchGuard({
				caseId: "A2",
				envNonce: nonce,
				envParentPid: "1234",
				envPlanMode: "a2-container",
				actualParentPid: 9999,
			}).ok,
			false,
		);
		assert.equal(
			validateSupervisorLaunchGuard({
				caseId: "A2",
				envNonce: undefined,
				envParentPid: "1234",
				envPlanMode: "a2-container",
				actualParentPid: 1234,
			}).ok,
			false,
		);
		assert.equal(isLaunchNonce(nonce), true);
	});

	test("metadata: bun.lock entry parser records version/integrity as lock metadata", () => {
		const lockText =
			'"libsodium-wrappers-sumo": ["libsodium-wrappers-sumo@0.8.4", "", ' +
			'{ "dependencies": { "libsodium-sumo": "^0.8.0" } }, "sha512-abc123=="],';
		assert.deepEqual(parseBunLockMetadata(lockText), {
			entryFound: true,
			resolvedVersion: "0.8.4",
			integrity: "sha512-abc123==",
		});
		assert.deepEqual(parseBunLockMetadata("no entry"), {
			entryFound: false,
			resolvedVersion: null,
			integrity: null,
		});
	});

	test("child: sealed source consumption awaits every chunk and equality is boolean-only", async () => {
		const chunks = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
		async function* source(): AsyncGenerator<Uint8Array> {
			for (const chunk of chunks) yield chunk;
		}
		const artifact = await consumeSealedSource(source());
		assert.deepEqual([...artifact], [1, 2, 3, 4, 5, 6]);
		assert.equal(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
		assert.equal(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
		assert.equal(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false);
	});

	test("container: injected fake seal/open roundtrip consumes async ciphertext and checks byte equality", async () => {
		const payload = new Uint8Array(32);
		for (let index = 0; index < payload.length; index += 1) payload[index] = index + 1;
		const password = new Uint8Array([11, 22, 33]);
		const ciphertextChunks = [new Uint8Array([9, 8]), new Uint8Array([7, 6, 5])];
		const ciphertextBytes = ciphertextChunks.flatMap((chunk) => [...chunk]);
		let asyncArtifactConsumed = false;
		const fakeCrypto = {
			async seal(source: AsyncIterable<Uint8Array>, suppliedPassword: Uint8Array) {
				const chunks: Uint8Array[] = [];
				for await (const chunk of source) chunks.push(chunk);
				assert.equal(chunks.length, 1);
				assert.deepEqual([...chunks[0]!], [...payload]);
				assert.deepEqual([...suppliedPassword], [...password]);
				return (async function* () {
					asyncArtifactConsumed = true;
					for (const chunk of ciphertextChunks) yield chunk;
				})();
			},
			async openAndStage(artifact: AsyncIterable<Uint8Array>, suppliedPassword: Uint8Array) {
				const chunks: Uint8Array[] = [];
				for await (const chunk of artifact) chunks.push(chunk);
				assert.deepEqual(
					chunks.flatMap((chunk) => [...chunk]),
					ciphertextBytes,
				);
				assert.deepEqual([...suppliedPassword], [...password]);
				return { bytes: payload.slice(), artifactIdentity: new Uint8Array(16) };
			},
		};
		const fakeSodium = {
			memzero() {
				// injected mock; no real crypto
			},
		};
		const operations = await runContainerOperations(
			fakeSodium as unknown as Parameters<typeof runContainerOperations>[0],
			fakeCrypto as unknown as Parameters<typeof runContainerOperations>[1],
			[payload],
			password,
		);
		assert.equal(operations.length, 1);
		assert.equal(operations[0]?.roundTripMatched, true);
		assert.equal(operations[0]?.artifactBytes, ciphertextBytes.length);
		assert.equal(asyncArtifactConsumed, true);
		assert.equal(typeof operations[0]?.sealMs, "number");
		assert.equal(typeof operations[0]?.openMs, "number");
	});

	test("report: labels, no unsupported percentile, and no product-cap claims", () => {
		const report = buildPhaseAReport(makeReportInput(allSamples()));
		assert.equal(report.status, "completed");
		assert.equal(report.runCompleted, true);
		assert.equal(report.crypto01Passed, false);
		assert.equal(report.profileSelected, false);
		assert.equal(report.formatFrozen, false);
		assert.equal(report.phaseBExecuted, false);
		assert.equal(report.candidate.notSelected, true);
		assert.equal(report.harness.oneChildAtATime, true);
		assert.equal(report.harness.retries, false);
		assert.equal(report.harness.mode, "full-phase-a");
		assert.equal(report.harness.maxChildStarts, 21);
		assert.equal(report.harness.fullPhaseAReviewRequired, true);
		assert.equal(report.coverage.a0Executed, true);
		assert.equal(report.coverage.a1ControlExecuted, true);
		assert.equal(report.coverage.a2ContainerExecuted, true);
		assert.equal(report.coverage.a2ToA6Executed, true);
		assert.equal(report.coverage.a3ToA6Executed, true);
		assert.equal(report.coverage.a1ToA6Executed, true);
		assert.equal(report.coverage.kdfControlExecuted, true);
		assert.equal(report.coverage.containerSealOpenExecuted, true);
		assert.equal(report.summary.completedSamples, 21);
		assert.equal(report.summary.failedSamples, 0);
		assert.equal(report.libsodium.installed.installedBytesIntegrityVerified, false);
		assert.equal(report.libsodium.lock.integrityKind, "lock-metadata");
		assert.equal(report.libsodium.lock.installedBytesVerified, false);
		assert.equal(report.memory.physicalMemoryReadFailures, 0);
		assert.equal(report.bounds.a0BridgeMaxChildStarts, 3);
		assert.equal(report.bounds.a0BridgeMaxChildEnvelopeMs, 150_000);

		const a0 = report.cases.find((entry) => entry.caseId === "A0")!;
		const a1 = report.cases.find((entry) => entry.caseId === "A1")!;
		const a2 = report.cases.find((entry) => entry.caseId === "A2")!;
		const a6 = report.cases.find((entry) => entry.caseId === "A6")!;
		assert.equal(a0.sealMs, null);
		assert.equal(a0.openMs, null);
		assert.equal(a0.kdfControlMs, null);
		assert.equal(a1.sealMs, null);
		assert.equal(a1.kdfControlMs?.count, 3);
		assert.equal(a2.sealMs?.count, 3);
		assert.equal(a2.openMs?.count, 3);
		assert.equal(a2.artifactBytes?.count, 3);
		assert.equal(a6.sealMs?.count, 6);
		assert.equal(a6.openMs?.count, 6);
		assert.equal(a6.kdfControlMs, null);
		assert.equal(report.aggregate.kdfControlMs?.count, 3);
		assert.equal(report.summary.roundTripOperationCount, 18);
		assert.equal(report.summary.roundTripMatchedOperations, 18);
		assert.equal(a0.memory.baselineWorkingSetBytes?.count, 3);
		assert.equal(a0.memory.sampledIncrementalWorkingSetBytes?.count, 3);
		assert.equal(a0.memory.lifetimePeakWorkingSetBytes?.count, 3);

		const serialized = JSON.stringify(report);
		assert.equal(serialized.includes("p95"), false);
		assert.equal(serialized.includes("privateCommitBytes"), false);
		assert.equal(serialized.includes("heapBytes"), false);
		assert.equal(serialized.includes("processCapBytes"), false);
		assert.equal(report.bounds.maxChildEnvelopeMs, PHASE_A_MAX_CHILD_ENVELOPE_MS);
		assert.equal(report.bounds.maxChildEnvelopeFitsRunDeadline, true);
		assert.ok(report.limitations.some((line) => line.includes("not passed")));
	});

	test("report: A0 bridge report truthfully shows 3-start plan and no A1-A6/KDF/seal-open", () => {
		const samples = allSamples().filter((sample) => sample.caseId === "A0");
		const report = buildPhaseAReport(
			makeReportInput(samples, {
				plan: A0_BRIDGE_PLAN,
				attemptedSamples: 3,
				childStarts: 3,
			}),
		);
		assert.equal(report.status, "completed");
		assert.equal(report.harness.mode, "a0-bridge");
		assert.deepEqual(report.harness.caseIds, ["A0"]);
		assert.equal(report.harness.label, "A0-only supervised bridge");
		assert.equal(/not\s+executed|not\s+authorized/i.test(report.harness.label), false);
		assert.equal(report.harness.maxChildStarts, 3);
		assert.equal(report.harness.runDeadlineMs, 30 * 60 * 1000);
		assert.equal(report.harness.fullPhaseAReviewRequired, true);
		assert.equal(report.summary.plannedSamples, 3);
		assert.equal(report.summary.completedSamples, 3);
		assert.equal(report.cases.length, 1);
		assert.equal(report.cases[0]?.caseId, "A0");
		assert.equal(report.samples.every((sample) => sample.caseId === "A0"), true);
		assert.equal(report.coverage.a0Executed, true);
		assert.equal(report.coverage.a1ControlExecuted, false);
		assert.equal(report.coverage.a2ContainerExecuted, false);
		assert.equal(report.coverage.a2ToA6Executed, false);
		assert.equal(report.coverage.a3ToA6Executed, false);
		assert.equal(report.coverage.a1ToA6Executed, false);
		assert.equal(report.coverage.kdfControlExecuted, false);
		assert.equal(report.coverage.containerSealOpenExecuted, false);
		assert.equal(report.aggregate.kdfControlMs, null);
		assert.equal(report.aggregate.sealMs, null);
		assert.equal(report.aggregate.openMs, null);
	});

	test("report: A1 control report shows 3-start KDF coverage and no container/A2-A6 pretense", () => {
		const samples = allSamples().filter((sample) => sample.caseId === "A1");
		const report = buildPhaseAReport(
			makeReportInput(samples, {
				plan: A1_CONTROL_PLAN,
				attemptedSamples: 3,
				childStarts: 3,
			}),
		);
		assert.equal(report.status, "completed");
		assert.equal(report.harness.mode, "a1-control");
		assert.deepEqual(report.harness.caseIds, ["A1"]);
		assert.equal(report.harness.label, "A1-only KDF control");
		assert.equal(/not\s+executed|not\s+authorized/i.test(report.harness.label), false);
		assert.equal(report.harness.maxChildStarts, 3);
		assert.equal(report.harness.runDeadlineMs, 30 * 60 * 1000);
		assert.equal(report.harness.fullPhaseAReviewRequired, true);
		assert.equal(report.summary.plannedSamples, 3);
		assert.equal(report.summary.completedSamples, 3);
		assert.equal(report.cases.length, 1);
		assert.equal(report.cases[0]?.caseId, "A1");
		assert.equal(report.cases[0]?.kdfControlMs?.count, 3);
		assert.equal(report.cases[0]?.sealMs, null);
		assert.equal(report.cases[0]?.openMs, null);
		assert.equal(report.samples.every((sample) => sample.caseId === "A1"), true);
		assert.equal(report.samples.every((sample) => typeof sample.kdfControlMs === "number"), true);
		assert.equal(report.samples.every((sample) => sample.operations.length === 0), true);
		assert.equal(report.coverage.a0Executed, false);
		assert.equal(report.coverage.a1ControlExecuted, true);
		assert.equal(report.coverage.a2ContainerExecuted, false);
		assert.equal(report.coverage.a2ToA6Executed, false);
		assert.equal(report.coverage.a3ToA6Executed, false);
		assert.equal(report.coverage.a1ToA6Executed, true);
		assert.equal(report.coverage.kdfControlExecuted, true);
		assert.equal(report.coverage.containerSealOpenExecuted, false);
		assert.equal(report.aggregate.kdfControlMs?.count, 3);
		assert.equal(report.aggregate.sealMs, null);
		assert.equal(report.aggregate.openMs, null);
		assert.equal(report.bounds.a1ControlMaxChildStarts, 3);
		assert.equal(report.bounds.a1ControlMaxChildEnvelopeMs, 150_000);
	});

	test("report: A2 container report shows 3-start round-trip coverage and no A1/A3-A6/KDF-control pretense", () => {
		const samples = allSamples().filter((sample) => sample.caseId === "A2");
		const report = buildPhaseAReport(
			makeReportInput(samples, {
				plan: A2_CONTAINER_PLAN,
				attemptedSamples: 3,
				childStarts: 3,
			}),
		);
		assert.equal(report.status, "completed");
		assert.equal(report.harness.mode, "a2-container");
		assert.deepEqual(report.harness.caseIds, ["A2"]);
		assert.equal(report.harness.label, "A2-only container round-trip");
		assert.equal(/not\s+executed|not\s+authorized/i.test(report.harness.label), false);
		assert.equal(report.harness.maxChildStarts, 3);
		assert.equal(report.harness.runDeadlineMs, 30 * 60 * 1000);
		assert.equal(report.harness.fullPhaseAReviewRequired, true);
		assert.equal(report.summary.plannedSamples, 3);
		assert.equal(report.summary.completedSamples, 3);
		assert.equal(report.cases.length, 1);
		assert.equal(report.cases[0]?.caseId, "A2");
		assert.equal(report.cases[0]?.sealMs?.count, 3);
		assert.equal(report.cases[0]?.openMs?.count, 3);
		assert.equal(report.cases[0]?.artifactBytes?.count, 3);
		assert.equal(report.cases[0]?.kdfControlMs, null);
		assert.equal(report.samples.every((sample) => sample.caseId === "A2"), true);
		assert.equal(report.samples.every((sample) => sample.operations.length === 1), true);
		assert.equal(report.samples.every((sample) => sample.operations[0]?.roundTripMatched === true), true);
		assert.equal(report.samples.every((sample) => sample.kdfControlMs === null), true);
		assert.equal(report.coverage.a0Executed, false);
		assert.equal(report.coverage.a1ControlExecuted, false);
		assert.equal(report.coverage.a2ContainerExecuted, true);
		assert.equal(report.coverage.a2ToA6Executed, true);
		assert.equal(report.coverage.a3ToA6Executed, false);
		assert.equal(report.coverage.a1ToA6Executed, true);
		assert.equal(report.coverage.kdfControlExecuted, false);
		assert.equal(report.coverage.containerSealOpenExecuted, true);
		assert.equal(report.aggregate.sealMs?.count, 3);
		assert.equal(report.aggregate.openMs?.count, 3);
		assert.equal(report.aggregate.kdfControlMs, null);
		assert.equal(report.bounds.a2ContainerMaxChildStarts, 3);
		assert.equal(report.bounds.a2ContainerMaxChildEnvelopeMs, 150_000);
	});

	test("report: integrity rejects operation-count mismatch, unsafe codes, and incomplete full runs", () => {
		const badA6 = { ...createSample("A6", 0), operations: createSample("A6", 0).operations.slice(0, 1) };
		assert.throws(
			() =>
				buildPhaseAReport(
					makeReportInput([badA6], {
						status: "stopped-safety",
						stoppedBySafety: true,
						attemptedSamples: 1,
						childStarts: 1,
					}),
				),
			/exactly 2 operation/,
		);
		const unsafeFailure: PhaseAFailureRecord = {
			caseId: "A0",
			sampleIndex: 0,
			code: "raw-vendor-error" as never,
			phase: "crypto",
		};
		assert.throws(
			() =>
				buildPhaseAReport(
					makeReportInput([], {
						status: "stopped-safety",
						stoppedBySafety: true,
						attemptedSamples: 1,
						childStarts: 1,
						failures: [unsafeFailure],
					}),
				),
			/not an allowed safe code/,
		);
		assert.throws(
			() => buildPhaseAReport(makeReportInput(allSamples().slice(0, 20))),
			/exactly one completed sample or failure record/,
		);
	});

	interface ControlledStream {
		readonly stream: ReadableStream<Uint8Array>;
		push(bytes: Uint8Array): void;
		close(): void;
	}

	function createControlledStream(): ControlledStream {
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		let closed = false;
		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
		});
		return {
			stream,
			push(bytes) {
				if (closed) return;
				try {
					controller!.enqueue(bytes);
				} catch {
					closed = true;
				}
			},
			close() {
				if (closed) return;
				closed = true;
				try {
					controller!.close();
				} catch {
					// Reader cancellation may have already closed the stream.
				}
			},
		};
	}

	interface FakeChildIo {
		pushMessage(message: unknown): void;
		pushStdout(bytes: Uint8Array): void;
		pushStderr(bytes: Uint8Array): void;
		closeStdout(): void;
		closeStderr(): void;
		exit(code: number): void;
	}

	interface FakeChildOptions {
		readonly caseId: CaseId;
		readonly ready?: ChildReadyMessage | null;
		readonly stdoutBeforeReady?: readonly Uint8Array[];
		readonly stderrBeforeReady?: readonly Uint8Array[];
		readonly onStart?: (io: FakeChildIo) => void;
		readonly killResolves?: boolean;
	}

	interface FakeChild extends ChildProcessHandle {
		readonly killCalls: readonly (string | undefined)[];
		readonly stdinLines: readonly string[];
	}

	let fakePid = 7000;

	function createFakeChild(options: FakeChildOptions): FakeChild {
		const stdout = createControlledStream();
		const stderr = createControlledStream();
		const killCalls: (string | undefined)[] = [];
		const stdinLines: string[] = [];
		let exitResolved = false;
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const finishExit = (code: number): void => {
			if (exitResolved) return;
			exitResolved = true;
			resolveExit(code);
		};
		const io: FakeChildIo = {
			pushMessage(message) {
				stdout.push(protocolLine(message));
			},
			pushStdout(bytes) {
				stdout.push(bytes);
			},
			pushStderr(bytes) {
				stderr.push(bytes);
			},
			closeStdout: () => stdout.close(),
			closeStderr: () => stderr.close(),
			exit: finishExit,
		};

		for (const chunk of options.stdoutBeforeReady ?? []) stdout.push(chunk);
		for (const chunk of options.stderrBeforeReady ?? []) stderr.push(chunk);
		if (options.ready !== null) {
			stdout.push(protocolLine(options.ready ?? createReady(options.caseId)));
		}

		const stdin = {
			write(data: string) {
				stdinLines.push(data);
				if (options.onStart !== undefined) {
					options.onStart(io);
					return;
				}
				io.pushMessage(createComplete(options.caseId));
				io.closeStdout();
				io.closeStderr();
				io.exit(0);
			},
			async flush() {
				return undefined;
			},
		};

		const pid = fakePid++;
		return {
			pid,
			stdin,
			stdout: stdout.stream,
			stderr: stderr.stream,
			exited,
			killCalls,
			stdinLines,
			kill(signal?: string) {
				killCalls.push(signal);
				if (options.killResolves === false) return;
				stdout.close();
				stderr.close();
				finishExit(137);
			},
		};
	}

	interface FakeTimers {
		setTimeout(callback: () => void, timeoutMs: number): number;
		clearTimeout(handle: unknown): void;
		setInterval(callback: () => void, intervalMs: number): number;
		clearInterval(handle: unknown): void;
		fireNextTimeout(): boolean;
		fireIntervals(): void;
		readonly pendingTimeouts: number;
		readonly pendingIntervals: number;
	}

	function createFakeTimers(): FakeTimers {
		let nextHandle = 1;
		const timeouts = new Map<number, () => void>();
		const intervals = new Map<number, () => void>();
		return {
			setTimeout(callback) {
				const handle = nextHandle++;
				timeouts.set(handle, callback);
				return handle;
			},
			clearTimeout(handle) {
				if (typeof handle === "number") timeouts.delete(handle);
			},
			setInterval(callback) {
				const handle = nextHandle++;
				intervals.set(handle, callback);
				return handle;
			},
			clearInterval(handle) {
				if (typeof handle === "number") intervals.delete(handle);
			},
			fireNextTimeout() {
				const entry = timeouts.entries().next();
				if (entry.done) return false;
				timeouts.delete(entry.value[0]);
				entry.value[1]();
				return true;
			},
			fireIntervals() {
				for (const callback of [...intervals.values()]) callback();
			},
			get pendingTimeouts() {
				return timeouts.size;
			},
			get pendingIntervals() {
				return intervals.size;
			},
		};
	}

	function createFakeMemoryReader(pid: number): {
		readonly pid: number;
		read(): ProcessMemoryCounters;
		close(): void;
	} {
		const sequence: ProcessMemoryCounters[] = [
			{ workingSetBytes: 100 * MIB, peakWorkingSetBytes: 200 * MIB },
			{ workingSetBytes: 150 * MIB, peakWorkingSetBytes: 250 * MIB },
			{ workingSetBytes: 160 * MIB, peakWorkingSetBytes: 300 * MIB },
		];
		let index = 0;
		return {
			pid,
			read() {
				const value = sequence[Math.min(index, sequence.length - 1)]!;
				index += 1;
				return { ...value };
			},
			close() {
				// no-op
			},
		};
	}

	interface FakeHarness {
		readonly ports: PhaseAPorts;
		readonly timers: FakeTimers;
		readonly children: {
			readonly command: readonly string[];
			readonly env: Readonly<Record<string, string>>;
			readonly proc: ChildProcessHandle;
		}[];
		readonly stdout: string[];
		readonly stderr: string[];
	}

	function createFakeHarness(
		overrides: {
			readonly physicalMemoryValues?: readonly number[];
			readonly physicalMemoryReadErrorAt?: number;
			readonly childFactory?: (command: readonly string[], index: number) => ChildProcessHandle;
			readonly runtime?: ActualRuntime;
			readonly hashFiles?: (paths: readonly string[]) => Promise<readonly PhaseAFreshnessEntry[]>;
			readonly libsodiumEvidence?: () => Promise<PhaseALibsodiumEvidence>;
			readonly nonceFactory?: (index: number) => string;
		} = {},
	): FakeHarness {
		const timers = createFakeTimers();
		const children: {
			command: readonly string[];
			env: Readonly<Record<string, string>>;
			proc: ChildProcessHandle;
		}[] = [];
		const stdout: string[] = [];
		const stderr: string[] = [];
		const physicalValues = overrides.physicalMemoryValues ?? [4 * GIB];
		let physicalIndex = 0;
		let physicalReadCount = 0;
		let spawnIndex = 0;
		let nonceIndex = 0;
		const runtime: ActualRuntime = overrides.runtime ?? {
			bun: RUNTIME.bun,
			nodeCompat: RUNTIME.nodeCompat,
			platform: RUNTIME.platform,
			arch: RUNTIME.arch,
		};

		const ports: PhaseAPorts = {
			runtime,
			execPath: "C:\\fake\\bun.exe",
			childScriptPath: "C:\\fake\\phase-a.node.ts",
			repositoryRoot: "C:\\fake\\repo",
			spawn(command, env) {
				const caseId = command[command.length - 1];
				assert.ok(caseId !== undefined);
				const proc =
					overrides.childFactory?.(command, spawnIndex) ??
					createFakeChild({ caseId: caseId as CaseId });
				spawnIndex += 1;
				children.push({ command: [...command], env: { ...env }, proc });
				return proc;
			},
			openMemoryReader(pid) {
				return createFakeMemoryReader(pid);
			},
			physicalMemory: {
				read() {
					physicalReadCount += 1;
					if (overrides.physicalMemoryReadErrorAt === physicalReadCount) {
						throw new Error("fake physical memory read failure");
					}
					const bytes = physicalValues[Math.min(physicalIndex, physicalValues.length - 1)]!;
					physicalIndex += 1;
					return { bytes, source: "fake-physical" };
				},
			},
			async hashFiles(paths) {
				if (overrides.hashFiles !== undefined) return overrides.hashFiles(paths);
				return paths.map((relativePath, index) => ({
					path: relativePath,
					bytes: index + 1,
					sha256: "a".repeat(64),
				}));
			},
			createLaunchNonce() {
				nonceIndex += 1;
				if (overrides.nonceFactory !== undefined) return overrides.nonceFactory(nonceIndex);
				return nonceIndex.toString(16).padStart(32, "0");
			},
			async collectLibsodiumEvidence() {
				return overrides.libsodiumEvidence?.() ?? fakeLibsodiumEvidence();
			},
			now: () => 1_000,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
			setInterval: timers.setInterval,
			clearInterval: timers.clearInterval,
			writeStdout(text) {
				stdout.push(text);
			},
			writeStderr(text) {
				stderr.push(text);
			},
		};
		return { ports, timers, children, stdout, stderr };
	}

	async function tick(): Promise<void> {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			if (condition()) return;
			await tick();
		}
		throw new Error("condition did not become true in time");
	}

	test("supervisor: one fake child completes with separate memory labels and timings", async () => {
		const harness = createFakeHarness();
		const result = await runSingleChild({
			caseDef: requireCase("A2"),
			sampleIndex: 0,
			planMode: "full-phase-a",
			ports: harness.ports,
			outputBudget: new RetainedBudget(4 * MIB),
			memoryTracker: new MemoryObservationTracker(4 * GIB),
			launchNonces: new Set<string>(),
			runDeadlineAt: 1_000_000,
		});
		assert.equal(result.kind, "sample");
		if (result.kind !== "sample") return;
		assert.equal(result.sample.baselineWorkingSetBytes, 100 * MIB);
		assert.equal(result.sample.sampledIncrementalWorkingSetBytes, 50 * MIB);
		assert.equal(result.sample.lifetimePeakWorkingSetBytes, 300 * MIB);
		assert.equal(result.sample.lifetimePeakSource, "post-exit-query");
		assert.equal(result.sample.operations.length, 1);
		assert.equal(result.sample.kdfControlMs, null);
		assert.equal(result.sample.termination, "owned-child-exit-verified");
		assert.equal(harness.timers.pendingTimeouts, 0);
		assert.equal(harness.timers.pendingIntervals, 0);
		assert.equal(harness.children.length, 1);
	});

	test("supervisor: READY runtime mismatch fails closed and terminates the owned child", async () => {
		const child = createFakeChild({
			caseId: "A0",
			ready: createReady("A0", { runtime: { bun: "1.2.0" } }),
		});
		const harness = createFakeHarness({ childFactory: () => child });
		const result = await runSingleChild({
			caseDef: requireCase("A0"),
			sampleIndex: 0,
			planMode: "a0-bridge",
			ports: harness.ports,
			outputBudget: new RetainedBudget(4 * MIB),
			memoryTracker: new MemoryObservationTracker(4 * GIB),
			launchNonces: new Set<string>(),
			runDeadlineAt: 1_000_000,
		});
		assert.equal(result.kind, "failure");
		if (result.kind !== "failure") return;
		assert.equal(result.stop, true);
		assert.equal(result.failures[0]?.code, "protocol-runtime-mismatch");
		assert.ok(child.killCalls.length > 0);
		assert.equal(harness.timers.pendingTimeouts, 0);
	});

	test("supervisor: COMPLETE before READY fails closed", async () => {
		const child = createFakeChild({
			caseId: "A2",
			ready: null,
			stdoutBeforeReady: [protocolLine(createComplete("A2"))],
		});
		const harness = createFakeHarness({ childFactory: () => child });
		const result = await runSingleChild({
			caseDef: requireCase("A2"),
			sampleIndex: 0,
			planMode: "full-phase-a",
			ports: harness.ports,
			outputBudget: new RetainedBudget(4 * MIB),
			memoryTracker: new MemoryObservationTracker(4 * GIB),
			launchNonces: new Set<string>(),
			runDeadlineAt: 1_000_000,
		});
		assert.equal(result.kind, "failure");
		if (result.kind !== "failure") return;
		assert.equal(result.stop, true);
		assert.equal(result.failures[0]?.code, "protocol-order");
	});

	test("supervisor: per-child output overflow fails closed", async () => {
		const hugeStderr = new Uint8Array(PHASE_A_OPERATIONAL_BOUNDS.maxRetainedStderrBytesPerChild + 1);
		hugeStderr.fill(0x78);
		const child = createFakeChild({ caseId: "A0", stderrBeforeReady: [hugeStderr] });
		const harness = createFakeHarness({ childFactory: () => child });
		const result = await runSingleChild({
			caseDef: requireCase("A0"),
			sampleIndex: 0,
			planMode: "a0-bridge",
			ports: harness.ports,
			outputBudget: new RetainedBudget(4 * MIB),
			memoryTracker: new MemoryObservationTracker(4 * GIB),
			launchNonces: new Set<string>(),
			runDeadlineAt: 1_000_000,
		});
		assert.equal(result.kind, "failure");
		if (result.kind !== "failure") return;
		assert.equal(result.stop, true);
		assert.equal(result.failures[0]?.code, "output-overflow");
	});

	test("supervisor: child deadline terminates the owned child and stops without success", async () => {
		const child = createFakeChild({ caseId: "A0", ready: null });
		const harness = createFakeHarness({ childFactory: () => child });
		const pending = runSingleChild({
			caseDef: requireCase("A0"),
			sampleIndex: 0,
			planMode: "a0-bridge",
			ports: harness.ports,
			outputBudget: new RetainedBudget(4 * MIB),
			memoryTracker: new MemoryObservationTracker(4 * GIB),
			launchNonces: new Set<string>(),
			runDeadlineAt: 1_000_000,
		});
		await waitFor(() => harness.timers.pendingTimeouts > 0);
		harness.timers.fireNextTimeout();
		const result = await pending;
		assert.equal(result.kind, "failure");
		if (result.kind !== "failure") return;
		assert.equal(result.stop, true);
		assert.equal(result.failures[0]?.code, "child-deadline");
		assert.ok(child.killCalls.length > 0);
	});

	test("supervisor: unverifiable child termination is classified uncertain", async () => {
		const child = createFakeChild({ caseId: "A0", ready: null, killResolves: false });
		const timers = createFakeTimers();
		const pending = terminateOwnedChild(child, timers, 5_000);
		await waitFor(() => timers.pendingTimeouts > 0);
		timers.fireNextTimeout();
		await waitFor(() => timers.pendingTimeouts > 0);
		timers.fireNextTimeout();
		assert.equal(await pending, "uncertain");
		assert.deepEqual(child.killCalls, [undefined, "SIGKILL"]);
	});

	test("supervisor: preflight physical memory below 2 GiB spawns no child", async () => {
		const harness = createFakeHarness({ physicalMemoryValues: [GIB] });
		const result = await runPhaseA(harness.ports, FULL_PHASE_A_PLAN);
		assert.equal(result.exitCode, 1);
		assert.equal(result.report, null);
		assert.equal(result.preflightFailure, "preflight-memory");
		assert.equal(harness.children.length, 0);
	});

	test("supervisor: physical memory below the 1 GiB stop floor stops before the next child", async () => {
		const harness = createFakeHarness({ physicalMemoryValues: [4 * GIB, 512 * MIB] });
		const result = await runPhaseA(harness.ports, FULL_PHASE_A_PLAN);
		assert.equal(result.exitCode, 2);
		assert.ok(result.report !== null);
		assert.equal(result.report.status, "stopped-safety");
		assert.equal(result.report.summary.attemptedSamples, 0);
		assert.equal(result.report.failures[0]?.code, "memory-stop");
		assert.equal(result.report.memory.observedMinimumDuringRunBytes, 512 * MIB);
		assert.equal(harness.children.length, 0);
	});

	test("supervisor: full fake run uses exactly 21 sequential children", async () => {
		const harness = createFakeHarness();
		const result = await runPhaseA(harness.ports, FULL_PHASE_A_PLAN);
		assert.equal(result.exitCode, 0);
		assert.ok(result.report !== null);
		assert.equal(result.report.status, "completed");
		assert.equal(result.report.summary.completedSamples, 21);
		assert.equal(result.report.summary.failedSamples, 0);
		assert.equal(result.report.summary.childStarts, 21);
		assert.equal(result.report.samples.length, 21);
		assert.equal(result.report.cases.length, 7);
		assert.equal(harness.children.length, 21);
		assert.deepEqual(
			harness.children.map((entry) => entry.command[entry.command.length - 1]),
			PHASE_A_CASES.flatMap((definition) => [definition.id, definition.id, definition.id]),
		);
		for (const entry of harness.children) {
			assert.equal(entry.command[0], harness.ports.execPath);
			assert.equal(entry.command[1], harness.ports.childScriptPath);
			assert.equal(entry.command[2], "--child-case");
			const nonce = entry.env[LAUNCH_NONCE_ENV];
			assert.equal(isLaunchNonce(nonce), true);
			assert.equal(entry.env[LAUNCH_PARENT_PID_ENV], String(process.pid));
			assert.equal(entry.env[LAUNCH_PLAN_MODE_ENV], "full-phase-a");
			const start = parseStartCommandLine((entry.proc as FakeChild).stdinLines[0]!.trim());
			assert.equal(start.launchNonce, nonce);
			assert.equal(start.caseId, entry.command[entry.command.length - 1]);
			assert.equal(start.mode, "full-phase-a");
		}
		const nonces = harness.children.map((entry) => entry.env[LAUNCH_NONCE_ENV]);
		assert.equal(new Set(nonces).size, 21);
		assert.equal(harness.timers.pendingTimeouts, 0);
		assert.equal(harness.timers.pendingIntervals, 0);
		assert.equal(result.report.runtime.children.length, 1);
		assert.equal(result.report.freshness.files.length, PHASE_A_FRESHNESS_FILES.length);
		assert.equal(result.report.memory.observedMinimumDuringRunBytes, 4 * GIB);
		assert.equal(result.report.libsodium.lock.entryFound, true);
		assert.equal(result.report.libsodium.lock.integrityKind, "lock-metadata");
		assert.equal(result.report.libsodium.installed.installedBytesIntegrityVerified, false);
	});

	test("supervisor: A0 bridge plan runs exactly 3 A0 children and reports no A1-A6/KDF/seal-open", async () => {
		const harness = createFakeHarness();
		const result = await runPhaseA(harness.ports, A0_BRIDGE_PLAN);
		assert.equal(result.exitCode, 0);
		assert.ok(result.report !== null);
		assert.equal(result.report.status, "completed");
		assert.equal(result.report.harness.mode, "a0-bridge");
		assert.deepEqual(result.report.harness.caseIds, ["A0"]);
		assert.equal(result.report.harness.maxChildStarts, 3);
		assert.equal(result.report.summary.plannedSamples, 3);
		assert.equal(result.report.summary.completedSamples, 3);
		assert.equal(result.report.summary.childStarts, 3);
		assert.equal(result.report.cases.length, 1);
		assert.equal(result.report.cases[0]?.caseId, "A0");
		assert.equal(result.report.samples.every((sample) => sample.caseId === "A0"), true);
		assert.equal(result.report.coverage.a0Executed, true);
		assert.equal(result.report.coverage.a1ControlExecuted, false);
		assert.equal(result.report.coverage.a2ToA6Executed, false);
		assert.equal(result.report.coverage.a1ToA6Executed, false);
		assert.equal(result.report.coverage.kdfControlExecuted, false);
		assert.equal(result.report.coverage.containerSealOpenExecuted, false);
		assert.equal(harness.children.length, 3);
		assert.deepEqual(
			harness.children.map((entry) => entry.command[entry.command.length - 1]),
			["A0", "A0", "A0"],
		);
		assert.equal(new Set(harness.children.map((entry) => entry.env[LAUNCH_NONCE_ENV])).size, 3);
	});

	test("supervisor: A1 control plan runs exactly 3 A1 children and reports KDF-only coverage", async () => {
		const harness = createFakeHarness();
		const result = await runPhaseA(harness.ports, A1_CONTROL_PLAN);
		assert.equal(result.exitCode, 0);
		assert.ok(result.report !== null);
		assert.equal(result.report.status, "completed");
		assert.equal(result.report.harness.mode, "a1-control");
		assert.deepEqual(result.report.harness.caseIds, ["A1"]);
		assert.equal(result.report.harness.maxChildStarts, 3);
		assert.equal(result.report.summary.plannedSamples, 3);
		assert.equal(result.report.summary.completedSamples, 3);
		assert.equal(result.report.summary.childStarts, 3);
		assert.equal(result.report.cases.length, 1);
		assert.equal(result.report.cases[0]?.caseId, "A1");
		assert.equal(result.report.cases[0]?.kdfControlMs?.count, 3);
		assert.equal(result.report.cases[0]?.sealMs, null);
		assert.equal(result.report.cases[0]?.openMs, null);
		assert.equal(result.report.samples.every((sample) => sample.caseId === "A1"), true);
		assert.equal(result.report.samples.every((sample) => typeof sample.kdfControlMs === "number"), true);
		assert.equal(result.report.samples.every((sample) => sample.operations.length === 0), true);
		assert.equal(result.report.coverage.a0Executed, false);
		assert.equal(result.report.coverage.a1ControlExecuted, true);
		assert.equal(result.report.coverage.a2ToA6Executed, false);
		assert.equal(result.report.coverage.a1ToA6Executed, true);
		assert.equal(result.report.coverage.kdfControlExecuted, true);
		assert.equal(result.report.coverage.containerSealOpenExecuted, false);
		assert.equal(result.report.aggregate.kdfControlMs?.count, 3);
		assert.equal(result.report.aggregate.sealMs, null);
		assert.equal(result.report.aggregate.openMs, null);
		assert.equal(harness.children.length, 3);
		assert.deepEqual(
			harness.children.map((entry) => entry.command[entry.command.length - 1]),
			["A1", "A1", "A1"],
		);
		assert.equal(new Set(harness.children.map((entry) => entry.env[LAUNCH_NONCE_ENV])).size, 3);
		for (const entry of harness.children) {
			assert.equal(entry.env[LAUNCH_PLAN_MODE_ENV], "a1-control");
			const start = parseStartCommandLine((entry.proc as FakeChild).stdinLines[0]!.trim());
			assert.equal(start.mode, "a1-control");
			assert.equal(start.caseId, "A1");
		}
	});

	test("supervisor: grouped A3-A6 plan runs exactly 12 sequential children and exposes A6 pairs", async () => {
		const harness = createFakeHarness();
		const result = await runPhaseA(harness.ports, A3_A6_SMALL_PLAN);
		assert.equal(result.exitCode, 0);
		assert.ok(result.report !== null);
		assert.equal(result.report.status, "completed");
		assert.equal(result.report.harness.mode, "a3-a6-small");
		assert.deepEqual(result.report.harness.caseIds, ["A3", "A4", "A5", "A6"]);
		assert.equal(result.report.harness.label, "A3-A6 small grouped cases");
		assert.equal(result.report.harness.maxChildStarts, 12);
		assert.equal(result.report.summary.plannedSamples, 12);
		assert.equal(result.report.summary.completedSamples, 12);
		assert.equal(result.report.summary.childStarts, 12);
		assert.equal(result.report.cases.length, 4);
		for (const entry of result.report.cases) {
			assert.equal(entry.samplesCompleted, 3);
			assert.equal(entry.samplesFailed, 0);
		}
		const a3 = result.report.cases.find((entry) => entry.caseId === "A3")!;
		const a4 = result.report.cases.find((entry) => entry.caseId === "A4")!;
		const a5 = result.report.cases.find((entry) => entry.caseId === "A5")!;
		const a6 = result.report.cases.find((entry) => entry.caseId === "A6")!;
		assert.equal(a3.payloadBytes, 256);
		assert.equal(a4.payloadBytes, 1024);
		assert.equal(a5.payloadBytes, 64 * 1024);
		assert.equal(a5.passwordKind, "object-root");
		assert.equal(a5.operationPairs.length, 1);
		assert.equal(a5.operationPairs[0]?.roundTripOperationCount, 3);
		assert.equal("compressedBytes" in a5, false);
		assert.equal("frameCount" in a5, false);
		assert.equal(a6.pairs, 2);
		assert.equal(a6.operationPairs.length, 2);
		for (const pair of a6.operationPairs) {
			assert.equal(pair.roundTripOperationCount, 3);
			assert.equal(pair.roundTripMatchedOperations, 3);
			assert.equal(pair.sealMs?.count, 3);
			assert.equal(pair.openMs?.count, 3);
		}
		assert.equal(a6.operationPairs[0]?.sealMs?.median, 10);
		assert.equal(a6.operationPairs[1]?.sealMs?.median, 11);
		assert.equal(a6.sealMs?.count, 6);
		assert.equal(result.report.samples.filter((sample) => sample.caseId === "A6").every((sample) => sample.operations.length === 2), true);
		assert.equal(result.report.coverage.a0Executed, false);
		assert.equal(result.report.coverage.a1ControlExecuted, false);
		assert.equal(result.report.coverage.a2ContainerExecuted, false);
		assert.equal(result.report.coverage.a3ToA6Executed, true);
		assert.equal(result.report.coverage.kdfControlExecuted, false);
		assert.equal(result.report.coverage.containerSealOpenExecuted, true);
		assert.equal(result.report.bounds.a3A6SmallMaxChildStarts, 12);
		assert.equal(result.report.bounds.a3A6SmallMaxChildEnvelopeMs, 600_000);
		assert.equal(result.report.bounds.a3A6SmallFutureOuterTimeoutMs, 900_000);
		assert.equal(harness.children.length, 12);
		assert.deepEqual(
			harness.children.map((entry) => entry.command[entry.command.length - 1]),
			["A3", "A3", "A3", "A4", "A4", "A4", "A5", "A5", "A5", "A6", "A6", "A6"],
		);
		assert.equal(new Set(harness.children.map((entry) => entry.env[LAUNCH_NONCE_ENV])).size, 12);
		for (const entry of harness.children) {
			assert.equal(entry.env[LAUNCH_PLAN_MODE_ENV], "a3-a6-small");
			const start = parseStartCommandLine((entry.proc as FakeChild).stdinLines[0]!.trim());
			assert.equal(start.mode, "a3-a6-small");
			assert.equal(start.caseId, entry.command[entry.command.length - 1]);
		}
	});

	test("supervisor: grouped A3-A6 safety failure stops before the 12-child cap", async () => {
		const harness = createFakeHarness({
			childFactory(command, index) {
				const caseId = command[command.length - 1] as CaseId;
				if (index === 4) {
					return createFakeChild({
						caseId,
						ready: createReady(caseId, { runtime: { bun: "1.2.0" } }),
					});
				}
				return createFakeChild({ caseId });
			},
		});
		const result = await runPhaseA(harness.ports, A3_A6_SMALL_PLAN);
		assert.equal(result.exitCode, 2);
		assert.ok(result.report !== null);
		assert.equal(result.report.status, "stopped-safety");
		assert.equal(result.report.summary.childStarts, 5);
		assert.equal(result.report.summary.attemptedSamples, 5);
		assert.equal(result.report.failures[0]?.code, "protocol-runtime-mismatch");
		assert.equal(harness.children.length, 5);
	});

	test("supervisor: duplicate launch nonce is rejected before a second child", async () => {
		const duplicate = "d".repeat(32);
		const harness = createFakeHarness({ nonceFactory: () => duplicate });
		const result = await runPhaseA(harness.ports, A0_BRIDGE_PLAN);
		assert.equal(result.exitCode, 2);
		assert.ok(result.report !== null);
		assert.equal(result.report.status, "stopped-safety");
		assert.equal(result.report.failures[0]?.code, "launch-guard-failed");
		assert.equal(result.report.summary.childStarts, 1);
		assert.equal(harness.children.length, 1);
	});

	test("supervisor: physical-memory read failure stops with safe observability error and count", async () => {
		const harness = createFakeHarness({ physicalMemoryValues: [4 * GIB], physicalMemoryReadErrorAt: 2 });
		const result = await runPhaseA(harness.ports, A0_BRIDGE_PLAN);
		assert.equal(result.exitCode, 2);
		assert.ok(result.report !== null);
		assert.equal(result.report.status, "stopped-safety");
		assert.equal(result.report.failures[0]?.code, "memory-observability-failed");
		assert.equal(result.report.memory.physicalMemoryReadFailures, 1);
		assert.equal(harness.children.length, 0);
	});

	test("supervisor: physical-memory poll failure during work fails closed and is counted", async () => {
		const child = createFakeChild({ caseId: "A0", onStart() {} });
		const harness = createFakeHarness({ physicalMemoryReadErrorAt: 1, childFactory: () => child });
		const tracker = new MemoryObservationTracker(4 * GIB);
		const pending = runSingleChild({
			caseDef: requireCase("A0"),
			sampleIndex: 0,
			planMode: "a0-bridge",
			ports: harness.ports,
			outputBudget: new RetainedBudget(4 * MIB),
			memoryTracker: tracker,
			launchNonces: new Set<string>(),
			runDeadlineAt: 1_000_000,
		});
		await waitFor(() => harness.timers.pendingIntervals > 0);
		harness.timers.fireIntervals();
		const result = await pending;
		assert.equal(result.kind, "failure");
		if (result.kind !== "failure") return;
		assert.equal(result.stop, true);
		assert.equal(result.failures[0]?.code, "memory-observability-failed");
		assert.equal(tracker.readFailures, 1);
	});

	test("supervisor: libsodium metadata mismatch fails preflight before any child", async () => {
		const evidence = fakeLibsodiumEvidence();
		const harness = createFakeHarness({
			libsodiumEvidence: async () => ({
				...evidence,
				installed: { ...evidence.installed, version: "0.8.3" },
				versionMatchesLock: false,
			}),
		});
		const result = await runPhaseA(harness.ports, A0_BRIDGE_PLAN);
		assert.equal(result.exitCode, 1);
		assert.equal(result.report, null);
		assert.equal(result.preflightFailure, "preflight-libsodium-metadata");
		assert.equal(harness.children.length, 0);
	});

	test("supervisor: a child case failure is reported but does not stop the planned run", async () => {
		let spawnIndex = 0;
		const harness = createFakeHarness({
			childFactory(command) {
				const caseId = command[command.length - 1] as CaseId;
				const index = spawnIndex;
				spawnIndex += 1;
				if (index === 0) {
					return createFakeChild({
						caseId,
						onStart(io) {
							io.pushMessage({
								type: "complete",
								protocol: 1,
								caseId,
								pid: 4242,
								ok: false,
								failureCode: "seal-failed",
							});
							io.closeStdout();
							io.closeStderr();
							io.exit(0);
						},
					});
				}
				return createFakeChild({ caseId });
			},
		});
		const result = await runPhaseA(harness.ports, FULL_PHASE_A_PLAN);
		assert.equal(result.exitCode, 2);
		assert.ok(result.report !== null);
		assert.equal(result.report.status, "completed-with-failures");
		assert.equal(result.report.summary.attemptedSamples, 21);
		assert.equal(result.report.summary.completedSamples, 20);
		assert.equal(result.report.summary.failedSamples, 1);
		assert.equal(result.report.failures[0]?.code, "seal-failed");
		assert.equal(result.report.failures[0]?.phase, "crypto");
		assert.equal(harness.children.length, 21);
	});

	test("supervisor: a safety/protocol failure stops the run without success", async () => {
		const harness = createFakeHarness({
			childFactory(command) {
				const caseId = command[command.length - 1] as CaseId;
				return createFakeChild({
					caseId,
					ready: createReady(caseId, { runtime: { bun: "1.2.0" } }),
				});
			},
		});
		const result = await runPhaseA(harness.ports, FULL_PHASE_A_PLAN);
		assert.equal(result.exitCode, 2);
		assert.ok(result.report !== null);
		assert.equal(result.report.status, "stopped-safety");
		assert.equal(result.report.summary.attemptedSamples, 1);
		assert.equal(result.report.summary.completedSamples, 0);
		assert.equal(result.report.failures[0]?.code, "protocol-runtime-mismatch");
		assert.equal(harness.children.length, 1);
	});
}
