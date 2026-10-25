import { describe, expect, test } from "bun:test";
import {
	type ChildExecution,
	type ChildRole,
	type ChildRunner,
	type DirectoryManager,
	decodeChildPayload,
	encodeChildPayload,
	parseChildArgs,
	parseProbeArgs,
	type RunDirectories,
	runSyntheticCredentialProbe,
} from "./credential-vault.ts";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const ARGS = [
	"--run-credential-vault-probe",
	"--run-id",
	RUN_ID,
	"--deadline-ms",
	"30000",
] as const;
const ACCESS_TOKEN = Buffer.alloc(32, 10).toString("base64url");
const REFRESH_TOKEN = Buffer.alloc(32, 11).toString("base64url");
const CREDENTIAL = {
	accessToken: ACCESS_TOKEN,
	refreshToken: REFRESH_TOKEN,
	accessExpiresAtMillis: 1_700_000_000_000,
	scope: "probe:read",
} as const;
const PIN = {
	moduleVersion: "2.1.2",
	nativeVersion: "2.1.2",
	nativeSha256: "52b16658275b7848f8081a6542fee3448f1b1c5d3a36487107ae0e7cec95ac6f",
	moduleVersionMatch: true,
	nativeVersionMatch: true,
	nativeSha256Match: true,
} as const;

const DIRECTORIES: RunDirectories = {
	root: "C:\\Temp\\opencode\\sessionport-m3-credential-probe\\test-run",
	write: "C:\\Temp\\opencode\\sessionport-m3-credential-probe\\test-run\\state-write",
	fault: "C:\\Temp\\opencode\\sessionport-m3-credential-probe\\test-run\\state-fault",
	readLogout:
		"C:\\Temp\\opencode\\sessionport-m3-credential-probe\\test-run\\state-read-logout",
	cleanup:
		"C:\\Temp\\opencode\\sessionport-m3-credential-probe\\test-run\\state-cleanup",
};

function execution(
	report: Record<string, unknown> | null,
	fields: Partial<ChildExecution> = {},
): ChildExecution {
	return {
		exitCode: 0,
		timedOut: false,
		treeStopped: true,
		stderrPresent: false,
		report,
		secretLeakDetected: false,
		...fields,
	};
}

function report(role: ChildRole, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		probe: "synthetic-credential-vault",
		role,
		runId: RUN_ID,
		outcome: "pass",
		failedStage: null,
		secretLength: 32,
		platformGatePassed: true,
		pin: PIN,
		precheckAbsent: null,
		setSettled: false,
		storeReadState: null,
		versionMatch: false,
		stateReady: false,
		accessTokenMatch: false,
		refreshTokenMatch: false,
		expiryMatch: false,
		scopeMatch: false,
		serializedSha256Match: false,
		readCalls: 0,
		writeCalls: 0,
		removeCalls: 0,
		foreignEntryCalls: 0,
		deleteAttempted: false,
		deleteSettled: false,
		deleteDeleted: null,
		entryPresent: null,
		entryAbsentAfter: null,
		entryWasPresent: null,
		bytesMatch: false,
		sha256Match: false,
		finalAbsent: null,
		mutationUncertain: false,
		controllerStatusBeforeLogout: null,
		controllerStatusAfterLogout: null,
		loginOutcome: null,
		logoutSettled: false,
		disposeSettled: false,
		fetchCalls: 0,
		failureInjection: null,
		stateDirectoryEmptyAfterDispose: null,
		...fields,
	};
}

function writePass(): ChildExecution {
	return execution(
		report("write", {
			precheckAbsent: true,
			setSettled: true,
			storeReadState: "ready",
			versionMatch: true,
			stateReady: true,
			accessTokenMatch: true,
			refreshTokenMatch: true,
			expiryMatch: true,
			scopeMatch: true,
			serializedSha256Match: true,
			readCalls: 2,
			writeCalls: 1,
			removeCalls: 0,
			foreignEntryCalls: 0,
			deleteAttempted: false,
		}),
	);
}

function faultPass(): ChildExecution {
	return execution(
		report("fault", {
			disposeSettled: true,
			stateDirectoryEmptyAfterDispose: true,
			failureInjection: {
				kind: "deterministic-fixed-unavailable",
				seam: "scoped-native-adapter-read",
				claim: "fault-injection-on-real-composition-not-OS-lock",
				notOsLock: true,
				storeReadCode: "credential-unavailable",
				storeReadAttempts: 1,
				controllerStatusReadAttempts: 1,
				controllerStatus: "unavailable",
				loginOutcome: "cancelled",
				httpFetchCalls: 0,
				vaultWrites: 0,
				vaultDeletes: 0,
				foreignEntryCalls: 0,
				readRetried: true,
				plaintextFallbackObserved: false,
				stateDirectoryEmptyAfterDispose: true,
			},
		}),
	);
}

function readLogoutPass(): ChildExecution {
	return execution(
		report("read-logout", {
			entryPresent: true,
			versionMatch: true,
			stateReady: true,
			accessTokenMatch: true,
			refreshTokenMatch: true,
			expiryMatch: true,
			scopeMatch: true,
			serializedSha256Match: true,
			controllerStatusBeforeLogout: "signed-in",
			logoutSettled: true,
			controllerStatusAfterLogout: "signed-out",
			deleteAttempted: true,
			deleteSettled: true,
			deleteDeleted: true,
			entryAbsentAfter: true,
			fetchCalls: 0,
			disposeSettled: true,
			writeCalls: 0,
			removeCalls: 1,
			foreignEntryCalls: 0,
			stateDirectoryEmptyAfterDispose: true,
		}),
	);
}

function cleanupPass(present = true): ChildExecution {
	return execution(
		report("cleanup", {
			entryWasPresent: present,
			bytesMatch: present,
			sha256Match: present,
			deleteAttempted: present,
			deleteSettled: present,
			deleteDeleted: present ? true : null,
			finalAbsent: true,
		}),
	);
}

const directoryManager: DirectoryManager = {
	async prepare(): Promise<RunDirectories> {
		return DIRECTORIES;
	},
	async cleanup() {
		return { removed: 5, residual: 0 };
	},
};

interface Call {
	readonly role: ChildRole;
	readonly credential: unknown;
	readonly stateDirectory: string | null;
}

function runnerFrom(
	responses: Partial<Record<ChildRole, ChildExecution>>,
	calls: Call[] = [],
): ChildRunner {
	return async (role, _runId, _deadlineMs, payload) => {
		const decoded = decodeChildPayload(new Uint8Array(payload));
		calls.push({
			role,
			credential: decoded?.credential ?? null,
			stateDirectory: decoded?.stateDirectory ?? null,
		});
		const response = responses[role];
		if (response === undefined) throw new Error(`unexpected role ${role}`);
		return response;
	};
}

async function run(
	responses: Partial<Record<ChildRole, ChildExecution>>,
	calls: Call[] = [],
): Promise<Awaited<ReturnType<typeof runSyntheticCredentialProbe>>> {
	return runSyntheticCredentialProbe(ARGS, {
		runner: runnerFrom(responses, calls),
		credentialFactory: () => ({ ...CREDENTIAL }),
		directories: directoryManager,
	});
}

describe("synthetic credential vault probe guards", () => {
	test("parent and child flags parse only in their own mode", () => {
		expect(parseProbeArgs(ARGS)).toEqual({ runId: RUN_ID, deadlineMs: 30_000 });
		expect(
			parseChildArgs(["--child", "read-logout", "--run-id", RUN_ID, "--deadline-ms", "30000"]),
		).toEqual({ role: "read-logout", runId: RUN_ID, deadlineMs: 30_000 });
		expect(() =>
			parseProbeArgs(["--child", "write", "--run-id", RUN_ID, "--deadline-ms", "30000"]),
		).toThrow("usage:");
		expect(() => parseChildArgs(ARGS)).toThrow("usage:");
	});

	test("fixed stdin frame round-trips exactly and rejects malformed frames", () => {
		const encoded = encodeChildPayload(CREDENTIAL, DIRECTORIES.write);
		const decoded = decodeChildPayload(encoded);
		expect(decoded?.credential).toEqual(CREDENTIAL);
		expect(decoded?.stateDirectory).toBe(DIRECTORIES.write);

		const badMagic = new Uint8Array(encoded);
		badMagic[0] = 0;
		expect(decodeChildPayload(badMagic)).toBeNull();
		expect(decodeChildPayload(encoded.subarray(0, encoded.length - 1))).toBeNull();
		encoded.fill(0);
	});

	test("pass path writes, injects a read fault, reads and logs out locally, with no cleanup", async () => {
		const calls: Call[] = [];
		const { exitCode, result } = await run(
			{
				write: writePass(),
				fault: faultPass(),
				"read-logout": readLogoutPass(),
			},
			calls,
		);

		expect(exitCode).toBe(0);
		expect(result.ok).toBe(true);
		expect(result.entryAbsentAfter).toBe(true);
		expect(result.exactEntryRetained).toBe(false);
		expect(result.cleanup).toBeNull();
		expect(result.directoryCleanup).toEqual({ removed: 5, residual: 0 });
		expect(result.pin?.nativeSha256).toBe(PIN.nativeSha256);
		expect(result.pinAllChildrenMatch).toBe(true);
		expect(result.failureInjection).toMatchObject({
			kind: "deterministic-fixed-unavailable",
			seam: "scoped-native-adapter-read",
			storeReadCode: "credential-unavailable",
			controllerStatus: "unavailable",
			loginOutcome: "cancelled",
			httpFetchCalls: 0,
			readRetried: true,
		});
		expect(calls.map((call) => call.role)).toEqual(["write", "fault", "read-logout"]);
		expect(calls[0].credential).toEqual(CREDENTIAL);
		expect(calls[1].credential).toEqual(CREDENTIAL);
		expect(calls[2].credential).toEqual(CREDENTIAL);
		expect(calls[0].stateDirectory).toBe(DIRECTORIES.write);
		expect(calls[1].stateDirectory).toBe(DIRECTORIES.fault);
		expect(calls[2].stateDirectory).toBe(DIRECTORIES.readLogout);

		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(ACCESS_TOKEN);
		expect(serialized).not.toContain(REFRESH_TOKEN);
		expect(serialized).not.toContain("127.0.0.1");
		expect(serialized).not.toContain("sessionport-m3-credential-probe-");
		expect(serialized).not.toContain(DIRECTORIES.write);
		expect(serialized).not.toContain(DIRECTORIES.fault);
		expect(result.stdoutRedaction.rawTokenValuesAbsent).toBe(true);
	});

	test("foreign collision stops before write, fault, logout, and cleanup", async () => {
		const calls: Call[] = [];
		const { exitCode, result } = await run(
			{
				write: execution(
					report("write", {
						outcome: "fail",
						failedStage: "precheck",
						precheckAbsent: false,
					}),
				),
			},
			calls,
		);

		expect(exitCode).toBe(1);
		expect(result.ok).toBe(false);
		expect(result.initialEntryPresent).toBe(true);
		expect(result.exactEntryRetained).toBe(false);
		expect(result.cleanup).toBeNull();
		expect(calls.map((call) => call.role)).toEqual(["write"]);
	});

	test("wrong-pair read does not delete and retains the exact entry", async () => {
		const calls: Call[] = [];
		const { exitCode, result } = await run(
			{
				write: writePass(),
				fault: faultPass(),
				"read-logout": execution(
					report("read-logout", {
						outcome: "fail",
						failedStage: "mismatch",
						entryPresent: true,
						versionMatch: true,
						stateReady: true,
						accessTokenMatch: false,
						serializedSha256Match: false,
					}),
					{ exitCode: 1 },
				),
				cleanup: execution(
					report("cleanup", {
						outcome: "fail",
						failedStage: "mismatch",
						entryWasPresent: true,
						bytesMatch: false,
						sha256Match: false,
						deleteAttempted: false,
						finalAbsent: false,
					}),
					{ exitCode: 1 },
				),
			},
			calls,
		);

		expect(exitCode).toBe(3);
		expect(result.ok).toBe(false);
		expect(result.exactEntryRetained).toBe(true);
		expect(result.entryAbsentAfter).toBe(false);
		expect(result.cleanup?.report?.deleteAttempted).toBe(false);
		expect(calls.map((call) => call.role)).toEqual([
			"write",
			"fault",
			"read-logout",
			"cleanup",
		]);
	});

	test("unverified child tree blocks later children and cleanup", async () => {
		const calls: Call[] = [];
		const { exitCode, result } = await run(
			{
				write: execution(
					report("write", {
						precheckAbsent: true,
						setSettled: true,
						storeReadState: "ready",
						versionMatch: true,
						stateReady: true,
						accessTokenMatch: true,
						refreshTokenMatch: true,
						expiryMatch: true,
						scopeMatch: true,
						serializedSha256Match: true,
						readCalls: 2,
						writeCalls: 1,
					}),
					{ treeStopped: false },
				),
			},
			calls,
		);

		expect(exitCode).toBe(3);
		expect(result.ok).toBe(false);
		expect(result.exactEntryRetained).toBe(true);
		expect(result.entryStateUncertain).toBe(true);
		expect(result.cleanup).toBeNull();
		expect(calls.map((call) => call.role)).toEqual(["write"]);
	});

	test("fault-phase failure stops before logout and cleans up only the exact entry", async () => {
		const calls: Call[] = [];
		const { exitCode, result } = await run(
			{
				write: writePass(),
				fault: execution(
					report("fault", {
						outcome: "fail",
						failedStage: "fault-status",
						failureInjection: {
							kind: "deterministic-fixed-unavailable",
							seam: "scoped-native-adapter-read",
							claim: "fault-injection-on-real-composition-not-OS-lock",
							notOsLock: true,
							storeReadCode: "credential-unavailable",
							storeReadAttempts: 1,
							controllerStatusReadAttempts: 1,
							controllerStatus: "signed-in",
							loginOutcome: "cancelled",
							httpFetchCalls: 0,
							vaultWrites: 0,
							vaultDeletes: 0,
							foreignEntryCalls: 0,
							readRetried: true,
							plaintextFallbackObserved: true,
							stateDirectoryEmptyAfterDispose: true,
						},
					}),
					{ exitCode: 1 },
				),
				cleanup: cleanupPass(),
			},
			calls,
		);

		expect(exitCode).toBe(3);
		expect(result.ok).toBe(false);
		expect(result.entryAbsentAfter).toBe(true);
		expect(result.exactEntryRetained).toBe(false);
		expect(result.failedStage).toBe("fault-status");
		expect(calls.map((call) => call.role)).toEqual(["write", "fault", "cleanup"]);
	});

	test("unverified child B tree blocks cleanup and retains the entry", async () => {
		const calls: Call[] = [];
		const { exitCode, result } = await run(
			{
				write: writePass(),
				fault: faultPass(),
				"read-logout": execution(
					report("read-logout", {
						outcome: "uncertain",
						failedStage: "logout",
						entryPresent: true,
						mutationUncertain: true,
					}),
					{ exitCode: 3, treeStopped: false },
				),
			},
			calls,
		);

		expect(exitCode).toBe(3);
		expect(result.ok).toBe(false);
		expect(result.exactEntryRetained).toBe(true);
		expect(result.cleanup).toBeNull();
		expect(calls.map((call) => call.role)).toEqual(["write", "fault", "read-logout"]);
	});

	test("raw token in a child report is rejected and never serialized", async () => {
		const calls: Call[] = [];
		const { exitCode, result } = await run(
			{
				write: execution({
					...report("write", {
						precheckAbsent: true,
						setSettled: true,
					}),
					leak: ACCESS_TOKEN,
				}),
			},
			calls,
		);

		expect(exitCode).toBe(3);
		expect(result.ok).toBe(false);
		expect(result.secretLeakDetected).toBe(true);
		expect(result.failedStage).toBe("secret-leak");
		expect(result.stdoutRedaction.rawTokenValuesAbsent).toBe(false);
		expect(calls.map((call) => call.role)).toEqual(["write"]);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(ACCESS_TOKEN);
		expect(serialized).not.toContain(REFRESH_TOKEN);
	});

	test("some cleanup reports the exact retained entry only after all children stop", async () => {
		const calls: Call[] = [];
		const { exitCode, result } = await run(
			{
				write: writePass(),
				fault: faultPass(),
				"read-logout": execution(
					report("read-logout", {
						outcome: "fail",
						failedStage: "logout",
						entryPresent: true,
						entryAbsentAfter: false,
					}),
					{ exitCode: 1 },
				),
				cleanup: cleanupPass(false),
			},
			calls,
		);

		expect(exitCode).toBe(3);
		expect(result.entryAbsentAfter).toBe(true);
		expect(result.cleanup?.report?.entryWasPresent).toBe(false);
		expect(calls.map((call) => call.role)).toEqual([
			"write",
			"fault",
			"read-logout",
			"cleanup",
		]);
	});
});
