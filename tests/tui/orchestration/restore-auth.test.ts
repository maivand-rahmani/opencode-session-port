/**
 * Focused tests for the owner-decided three-attempt restore password loop.
 *
 * Fake clients, fake crypto, fake artifact sources, fake destination
 * callbacks, and a fake inventory callback only: no real host call, artifact
 * read, KDF, or import. The raw authentication error is synthetic and is never
 * surfaced by the wrapper; no runtime, compatibility, or security claim
 * follows.
 */

import { describe, expect, test } from "bun:test";
import { encodeJson, type AuthenticatedPayload, type ByteSource } from "../../../src/core/contracts/index.ts";
import {
	isAuthenticationFailure,
	RESTORE_PASSWORD_ATTEMPT_LIMIT,
	runRestorePreflightWithPasswordAttempts,
	type RestorePreflightInput,
} from "../../../src/tui/orchestration/index.ts";
import {
	createEventLog,
	createFakeCryptoFactory,
	createFakeIdDeriver,
	createFakePublicClient,
	sessionRecord,
	TEST_ARTIFACT_IDENTITY,
	TEST_CRYPTO_POLICY,
	userMessage,
	type EventLog,
} from "./test-support.ts";

const ARTIFACT_PATH = "C:/work/artifacts/checkpoint-test.sessionport";
const DESTINATION_PROJECT_ID = "proj_dest";
const TARGET_DIRECTORY = "C:/work/destination";
const RAW_AUTH_TEXT = "RAW-AUTH-DETAIL";

interface RetryHarnessOptions {
	readonly withImport?: boolean;
	readonly passwordResult?: Uint8Array | "cancel";
	/** Number of leading attempts whose `openAndStage` rejects with the auth error. */
	readonly authFailures?: number;
	/** When set, `openAndStage` rejects with this error on the first call only. */
	readonly firstError?: Error;
	readonly destination?: readonly ReturnType<typeof sessionRecord>[];
}

interface RetryHarness {
	readonly input: RestorePreflightInput;
	readonly client: unknown;
	readonly events: EventLog;
	readonly passwordCalls: string[];
	readonly readArtifactCalls: string[];
	readonly artifactIterations: number;
	readonly openAndStageCalls: number;
	readonly readDestinationCalls: string[];
	readonly inventoryCalls: number;
	readonly importCalls: unknown[];
}

function authError(): Error {
	return Object.assign(new Error(RAW_AUTH_TEXT), { code: "authentication-failed" });
}

function createRetryHarness(options: RetryHarnessOptions = {}): RetryHarness {
	const events = createEventLog();
	const clientHandle = createFakePublicClient({ withImport: options.withImport ?? true });
	const passwordCalls: string[] = [];
	const readArtifactCalls: string[] = [];
	const readDestinationCalls: string[] = [];
	let artifactIterations = 0;
	let openAndStageCalls = 0;
	let inventoryCalls = 0;
	const authFailures = options.authFailures ?? 0;
	const password =
		options.passwordResult === "cancel" ? undefined : (options.passwordResult ?? new Uint8Array([7, 8, 9]));

	const crypto = createFakeCryptoFactory(
		{
			openAndStage: async (artifact: ByteSource, _password: Uint8Array): Promise<AuthenticatedPayload> => {
				openAndStageCalls += 1;
				for await (const _chunk of artifact) artifactIterations += 1;
				if (options.firstError !== undefined && openAndStageCalls === 1) throw options.firstError;
				if (openAndStageCalls <= authFailures) throw authError();
				return {
					bytes:
						encodeJson({
							sessions: [sessionRecord("ses_source", [userMessage("msg_source")], "proj_source")],
						}),
					artifactIdentity: TEST_ARTIFACT_IDENTITY,
				};
			},
		},
		events,
	);

	const input: RestorePreflightInput = {
		artifactPath: ARTIFACT_PATH,
		destinationProjectID: DESTINATION_PROJECT_ID,
		targetDirectory: TARGET_DIRECTORY,
		cryptoFactory: crypto.factory,
		cryptoPolicy: TEST_CRYPTO_POLICY,
		readEncryptedArtifact: (targetPath) => {
			events.record("read-artifact");
			readArtifactCalls.push(targetPath);
			return (async function* fakeArtifact() {
				yield Uint8Array.of(0xde, 0xad);
			})();
		},
		requestPassword: async (purpose) => {
			events.record("password");
			passwordCalls.push(purpose);
			return password;
		},
		readDestination: async (projectID) => {
			events.record("destination");
			readDestinationCalls.push(projectID);
			return options.destination ?? [];
		},
		readGloballyVisibleSessionIDs: async () => {
			inventoryCalls += 1;
			return [];
		},
		idDeriver: createFakeIdDeriver(),
	};

	return {
		input,
		client: clientHandle.client,
		events,
		passwordCalls,
		readArtifactCalls,
		get artifactIterations(): number {
			return artifactIterations;
		},
		get openAndStageCalls(): number {
			return openAndStageCalls;
		},
		readDestinationCalls,
		get inventoryCalls(): number {
			return inventoryCalls;
		},
		importCalls: clientHandle.importCalls,
	};
}

describe("runRestorePreflightWithPasswordAttempts", () => {
	test("the owner-decided attempt limit is three", () => {
		expect(RESTORE_PASSWORD_ATTEMPT_LIMIT).toBe(3);
	});

	test("succeeds on the first attempt with one prompt and one destination read", async () => {
		const harness = createRetryHarness();
		const outcome = await runRestorePreflightWithPasswordAttempts(harness.client, harness.input);

		expect(outcome.status).toBe("planned");
		expect(harness.passwordCalls).toEqual(["restore"]);
		expect(harness.readDestinationCalls).toEqual([DESTINATION_PROJECT_ID]);
		expect(harness.inventoryCalls).toBe(1);
		expect(harness.importCalls).toHaveLength(0);
	});

	test("retries only authentication-failed and stops retrying after the third attempt", async () => {
		const harness = createRetryHarness({ authFailures: 3 });
		const outcome = await runRestorePreflightWithPasswordAttempts(harness.client, harness.input);

		expect(outcome).toEqual({ status: "authentication-failed" });
		expect(Object.keys(outcome)).toEqual(["status"]);
		expect(harness.passwordCalls).toHaveLength(3);
		expect(harness.openAndStageCalls).toBe(3);
		// Authentication never completed, so the destination and the required
		// inventory were never read and nothing was imported.
		expect(harness.readDestinationCalls).toHaveLength(0);
		expect(harness.inventoryCalls).toBe(0);
		expect(harness.importCalls).toHaveLength(0);
	});

	test("a wrong password followed by a correct one plans on the second attempt", async () => {
		const harness = createRetryHarness({ authFailures: 1 });
		const outcome = await runRestorePreflightWithPasswordAttempts(harness.client, harness.input);

		expect(outcome.status).toBe("planned");
		expect(harness.passwordCalls).toHaveLength(2);
		expect(harness.readDestinationCalls).toEqual([DESTINATION_PROJECT_ID]);
		// The inventory ran once, on the successful attempt only.
		expect(harness.inventoryCalls).toBe(1);
	});

	test("a non-authentication error propagates unchanged after exactly one attempt", async () => {
		const truncated = Object.assign(new Error("RAW-TRUNCATED"), { code: "truncated-artifact" });
		const harness = createRetryHarness({ firstError: truncated });

		await expect(runRestorePreflightWithPasswordAttempts(harness.client, harness.input)).rejects.toBe(truncated);
		expect(harness.passwordCalls).toHaveLength(1);
		expect(harness.readDestinationCalls).toHaveLength(0);
		expect(harness.inventoryCalls).toBe(0);
		expect(harness.importCalls).toHaveLength(0);
	});

	test("a canceled password prompt is never retried and reads nothing", async () => {
		const harness = createRetryHarness({ passwordResult: "cancel" });
		const outcome = await runRestorePreflightWithPasswordAttempts(harness.client, harness.input);

		expect(outcome).toEqual({ status: "canceled" });
		expect(harness.passwordCalls).toHaveLength(1);
		expect(harness.readArtifactCalls).toHaveLength(0);
		expect(harness.artifactIterations).toBe(0);
		expect(harness.inventoryCalls).toBe(0);
	});

	test("capability absence short-circuits before any prompt, read, or retry", async () => {
		const harness = createRetryHarness({ withImport: false });
		const outcome = await runRestorePreflightWithPasswordAttempts(harness.client, harness.input);

		expect(outcome.status).toBe("capability-unavailable");
		expect(harness.passwordCalls).toHaveLength(0);
		expect(harness.readArtifactCalls).toHaveLength(0);
		expect(harness.artifactIterations).toBe(0);
		expect(harness.inventoryCalls).toBe(0);
	});

	test("the attempt limit is injectable for focused tests and validated fail-closed", async () => {
		const twoAttempts = createRetryHarness({ authFailures: 3 });
		const outcome = await runRestorePreflightWithPasswordAttempts(twoAttempts.client, twoAttempts.input, 2);
		expect(outcome).toEqual({ status: "authentication-failed" });
		expect(twoAttempts.passwordCalls).toHaveLength(2);

		const invalid = createRetryHarness();
		await expect(runRestorePreflightWithPasswordAttempts(invalid.client, invalid.input, 0)).rejects.toBeInstanceOf(
			TypeError,
		);
	});

	test("isAuthenticationFailure classifies by the stable code only", () => {
		expect(isAuthenticationFailure(authError())).toBe(true);
		expect(isAuthenticationFailure(Object.assign(new Error("x"), { code: "truncated-artifact" }))).toBe(false);
		expect(isAuthenticationFailure(new Error("authentication-failed"))).toBe(false);
		expect(isAuthenticationFailure(null)).toBe(false);
		expect(isAuthenticationFailure("authentication-failed")).toBe(false);
	});
});
