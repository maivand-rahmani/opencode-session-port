import { describe, expect, test } from "bun:test";
import {
	type ChildExecution,
	type ChildRole,
	type ChildRunner,
	parseChildArgs,
	parseTwoProcessArgs,
	runTwoProcessProbe,
} from "./two-process.ts";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const ARGS = ["--run-two-process-probe", "--run-id", RUN_ID, "--deadline-ms", "30000"] as const;
const SECRET = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));

function report(role: ChildRole, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		probe: "synthetic-keyring-two-process",
		role,
		runId: RUN_ID,
		outcome: "pass",
		failedStage: null,
		precheckAbsent: null,
		setSettled: false,
		readbackMatched: false,
		entryPresent: null,
		bytesMatch: false,
		sha256Match: false,
		deleteAttempted: false,
		deleteSettled: false,
		deleteDeleted: null,
		finalAbsent: null,
		entryWasPresent: null,
		mutationUncertain: false,
		...fields,
	};
}

function execution(fields: Partial<ChildExecution> = {}): ChildExecution {
	return {
		exitCode: 0,
		timedOut: false,
		treeStopped: true,
		stderrPresent: false,
		report: null,
		...fields,
	};
}

function writePass(): ChildExecution {
	return execution({
		report: report("write", {
			precheckAbsent: true,
			setSettled: true,
			readbackMatched: true,
			deleteAttempted: false,
		}),
	});
}

function readDeletePass(): ChildExecution {
	return execution({
		report: report("read-delete", {
			entryPresent: true,
			bytesMatch: true,
			sha256Match: true,
			deleteAttempted: true,
			deleteSettled: true,
			deleteDeleted: true,
			finalAbsent: true,
		}),
	});
}

interface Call {
	role: ChildRole;
	secret: Uint8Array;
}

function runnerFrom(
	responses: Partial<Record<ChildRole, ChildExecution>>,
	calls: Call[] = [],
): ChildRunner {
	return async (role, _runId, _deadlineMs, secret) => {
		calls.push({ role, secret: new Uint8Array(secret) });
		const response = responses[role];
		if (response === undefined) throw new Error(`unexpected role ${role}`);
		return response;
	};
}

describe("two-process keyring probe guard tests", () => {
	test("parent and internal child flags parse only in their own mode", () => {
		expect(parseTwoProcessArgs(ARGS)).toEqual({ runId: RUN_ID, deadlineMs: 30_000 });
		expect(parseChildArgs(["--child", "write", "--run-id", RUN_ID, "--deadline-ms", "30000"])).toEqual({
			role: "write",
			runId: RUN_ID,
			deadlineMs: 30_000,
		});
		expect(() => parseTwoProcessArgs(["--child", "write", "--run-id", RUN_ID, "--deadline-ms", "30000"])).toThrow(
			"usage:",
		);
		expect(() => parseChildArgs(ARGS)).toThrow("usage:");
	});

	test("pass path runs write then read-delete with identical stdin bytes and no cleanup", async () => {
		const calls: Call[] = [];
		const runner = runnerFrom({ write: writePass(), "read-delete": readDeletePass() }, calls);
		const { exitCode, result } = await runTwoProcessProbe(ARGS, runner, () => new Uint8Array(SECRET));

		expect(exitCode).toBe(0);
		expect(result.ok).toBe(true);
		expect(calls.map((call) => call.role)).toEqual(["write", "read-delete"]);
		expect(calls[0].secret).toEqual(SECRET);
		expect(calls[1].secret).toEqual(SECRET);
		expect(result.entryAbsentAfter).toBe(true);
		expect(result.cleanup).toBeNull();
		expect(result.exactEntryRetained).toBe(false);
		expect(result.secretLength).toBe(32);
	});

	test("precheck collision stops before write, read-delete, and cleanup", async () => {
		const calls: Call[] = [];
		const runner = runnerFrom(
			{
				write: execution({
					exitCode: 1,
					report: report("write", {
						outcome: "fail",
						failedStage: "precheck",
						precheckAbsent: false,
					}),
				}),
			},
			calls,
		);
		const { exitCode, result } = await runTwoProcessProbe(ARGS, runner, () => new Uint8Array(SECRET));

		expect(exitCode).toBe(1);
		expect(result.ok).toBe(false);
		expect(result.initialEntryPresent).toBe(true);
		expect(result.childB).toBeNull();
		expect(result.cleanup).toBeNull();
		expect(result.exactEntryRetained).toBe(false);
		expect(calls.map((call) => call.role)).toEqual(["write"]);
	});

	test("mismatched child B read retains the exact entry when cleanup also rejects it", async () => {
		const calls: Call[] = [];
		const runner = runnerFrom(
			{
				write: writePass(),
				"read-delete": execution({
					exitCode: 1,
					report: report("read-delete", {
						outcome: "fail",
						failedStage: "mismatch",
						entryPresent: true,
						bytesMatch: false,
						sha256Match: false,
						deleteAttempted: false,
					}),
				}),
				cleanup: execution({
					exitCode: 1,
					report: report("cleanup", {
						outcome: "fail",
						failedStage: "mismatch",
						entryWasPresent: true,
						bytesMatch: false,
						sha256Match: false,
						deleteAttempted: false,
						finalAbsent: false,
					}),
				}),
			},
			calls,
		);
		const { exitCode, result } = await runTwoProcessProbe(ARGS, runner, () => new Uint8Array(SECRET));

		expect(exitCode).toBe(3);
		expect(result.ok).toBe(false);
		expect(calls.map((call) => call.role)).toEqual(["write", "read-delete", "cleanup"]);
		expect(result.cleanup?.report?.deleteAttempted).toBe(false);
		expect(result.entryAbsentAfter).toBe(false);
		expect(result.exactEntryRetained).toBe(true);
	});

	test("delete failure is followed by one bounded exact-entry cleanup after both children stop", async () => {
		const calls: Call[] = [];
		const runner = runnerFrom(
			{
				write: writePass(),
				"read-delete": execution({
					exitCode: 3,
					report: report("read-delete", {
						outcome: "uncertain",
						failedStage: "delete",
						entryPresent: true,
						bytesMatch: true,
						sha256Match: true,
						deleteAttempted: true,
						deleteSettled: false,
						finalAbsent: null,
						mutationUncertain: true,
					}),
				}),
				cleanup: execution({
					report: report("cleanup", {
						entryWasPresent: true,
						bytesMatch: true,
						sha256Match: true,
						deleteAttempted: true,
						deleteSettled: true,
						deleteDeleted: true,
						finalAbsent: true,
					}),
				}),
			},
			calls,
		);
		const { exitCode, result } = await runTwoProcessProbe(ARGS, runner, () => new Uint8Array(SECRET));

		expect(exitCode).toBe(3);
		expect(result.ok).toBe(false);
		expect(calls.map((call) => call.role)).toEqual(["write", "read-delete", "cleanup"]);
		expect(result.cleanup?.exitCode).toBe(0);
		expect(result.entryAbsentAfter).toBe(true);
		expect(result.exactEntryRetained).toBe(false);
	});

	test("timeout with an unverified child tree blocks child B and cleanup", async () => {
		const calls: Call[] = [];
		const runner = runnerFrom(
			{
				write: execution({
					exitCode: 2,
					timedOut: true,
					treeStopped: false,
					report: report("write", {
						outcome: "timeout",
						failedStage: "set",
						precheckAbsent: true,
						setSettled: false,
					}),
				}),
			},
			calls,
		);
		const { exitCode, result } = await runTwoProcessProbe(ARGS, runner, () => new Uint8Array(SECRET));

		expect(exitCode).toBe(2);
		expect(result.ok).toBe(false);
		expect(calls.map((call) => call.role)).toEqual(["write"]);
		expect(result.childB).toBeNull();
		expect(result.cleanup).toBeNull();
		expect(result.entryStateUncertain).toBe(true);
	});

	test("successful child A without verified tree stop is not followed by child B", async () => {
		const calls: Call[] = [];
		const runner = runnerFrom({ write: execution({ ...writePass(), treeStopped: false }) }, calls);
		const { exitCode, result } = await runTwoProcessProbe(ARGS, runner, () => new Uint8Array(SECRET));

		expect(exitCode).toBe(3);
		expect(result.ok).toBe(false);
		expect(calls.map((call) => call.role)).toEqual(["write"]);
		expect(result.failedStage).toBe("child-a-tree");
		expect(result.cleanup).toBeNull();
		expect(result.exactEntryRetained).toBe(true);
	});
});
