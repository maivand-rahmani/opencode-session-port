/**
 * Restore-preflight tests (Phase 4 orchestration; `fix-57`).
 *
 * Fake public clients, fake crypto, fake artifact sources, fake destination
 * callbacks, and a fake inventory callback only: no real host call, artifact
 * read, KDF, destination enumeration, or import. These tests pin the required
 * sequence and short-circuit invariants and make no runtime, compatibility, or
 * production policy claim (O-01/O-02/O-03/O-06/O-10/O-11/O-15 remain OPEN;
 * O-16 target semantics stay caller-owned). Password zeroing is best-effort
 * byte overwriting, not secure deletion (A-07).
 */

import { describe, expect, test } from "bun:test";
import { encodeJson, type SessionRecord } from "../../../src/core/contracts/index.ts";
import { RestorePlanError } from "../../../src/core/restore/index.ts";
import { SessionCollectionError } from "../../../src/core/sessions/index.ts";
import * as orchestration from "../../../src/tui/orchestration/index.ts";
import {
	runRestorePreflight,
	type RestorePreflightInput,
} from "../../../src/tui/orchestration/index.ts";
import {
	createEventLog,
	createFakeCryptoFactory,
	createFakeIdDeriver,
	createFakePublicClient,
	sessionRecord,
	userMessage,
	TEST_CRYPTO_POLICY,
	type EventLog,
	type FakeCryptoFactoryOptions,
} from "./test-support.ts";

const ARTIFACT_PATH = "C:/work/artifacts/checkpoint-test.sessionport";
const DESTINATION_PROJECT_ID = "proj_dest";
const TARGET_DIRECTORY = "C:/work/destination";

interface RestoreHarnessOptions {
	readonly withImport?: boolean;
	/** Defaults to a synthetic non-zero password; `"cancel"` resolves `undefined`. */
	readonly passwordResult?: Uint8Array | "cancel";
	readonly authenticatedBytes?: Uint8Array;
	readonly openAndStageError?: Error;
	readonly destination?: readonly SessionRecord[];
	readonly destinationError?: Error;
	/** Cross-project occupancy IDs returned by the injected inventory; defaults to an empty inventory. */
	readonly inventoryResult?: readonly string[];
	readonly inventoryError?: Error;
}

interface RestoreHarness {
	readonly input: RestorePreflightInput;
	readonly client: unknown;
	readonly events: EventLog;
	readonly crypto: ReturnType<typeof createFakeCryptoFactory>;
	readonly importCalls: unknown[];
	readonly probeObserved: () => boolean;
	readonly passwordCalls: string[];
	/** Probe-observed state captured at each password-provider call. */
	readonly probeStateAtPassword: boolean[];
	readonly readArtifactCalls: string[];
	readonly readDestinationCalls: string[];
	readonly inventoryCalls: number;
	readonly password: Uint8Array | undefined;
}

/** Builds a fully injected fake restore-preflight environment; every effect is recorded. */
function createRestoreHarness(options: RestoreHarnessOptions = {}): RestoreHarness {
	const events = createEventLog();
	const clientHandle = createFakePublicClient({ withImport: options.withImport ?? true });
	const cryptoOptions: FakeCryptoFactoryOptions = {
		...(options.authenticatedBytes !== undefined ? { authenticatedBytes: options.authenticatedBytes } : {}),
		...(options.openAndStageError !== undefined
			? {
					openAndStage: async () => {
						throw options.openAndStageError;
					},
				}
			: {}),
	};
	const crypto = createFakeCryptoFactory(cryptoOptions, events);
	const passwordCalls: string[] = [];
	const probeStateAtPassword: boolean[] = [];
	const readArtifactCalls: string[] = [];
	const readDestinationCalls: string[] = [];
	let inventoryCalls = 0;
	const password =
		options.passwordResult === "cancel" ? undefined : (options.passwordResult ?? new Uint8Array([5, 6, 7]));

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
			probeStateAtPassword.push(clientHandle.probeObserved());
			return password;
		},
		readDestination: async (projectID) => {
			events.record("destination");
			readDestinationCalls.push(projectID);
			if (options.destinationError !== undefined) throw options.destinationError;
			return options.destination ?? [];
		},
		readGloballyVisibleSessionIDs: async () => {
			events.record("inventory");
			inventoryCalls += 1;
			if (options.inventoryError !== undefined) throw options.inventoryError;
			return options.inventoryResult ?? [];
		},
		idDeriver: createFakeIdDeriver(),
	};

	return {
		input,
		client: clientHandle.client,
		events,
		crypto,
		importCalls: clientHandle.importCalls,
		probeObserved: clientHandle.probeObserved,
		passwordCalls,
		probeStateAtPassword,
		readArtifactCalls,
		readDestinationCalls,
		get inventoryCalls(): number {
			return inventoryCalls;
		},
		password,
	};
}

function allZero(bytes: Uint8Array): boolean {
	return bytes.every((byte) => byte === 0);
}

/** Payload bytes with an authenticated parent/child pair; both classify as imported. */
function parentChildPayloadBytes(): Uint8Array {
	const parent = sessionRecord("ses_parent", [userMessage("msg_p1")], "proj_source");
	const child = sessionRecord("ses_child", [userMessage("msg_c1")], "proj_source", { parentID: "ses_parent" });
	return encodeJson({ sessions: [parent, child] });
}

describe("runRestorePreflight", () => {
	test("returns capability-unavailable before password, read, crypto, destination, or import (O-12)", async () => {
		const harness = createRestoreHarness({ withImport: false });

		const outcome = await runRestorePreflight(harness.client, harness.input);

		expect(outcome.status).toBe("capability-unavailable");
		if (outcome.status === "capability-unavailable") {
			expect(outcome.reason).toContain("session.import");
		}
		expect(harness.passwordCalls).toEqual([]);
		expect(harness.readArtifactCalls).toEqual([]);
		expect(harness.crypto.createPolicies).toEqual([]);
		expect(harness.crypto.openAndStagePasswords).toEqual([]);
		expect(harness.readDestinationCalls).toEqual([]);
		expect(harness.inventoryCalls).toBe(0);
		expect(harness.importCalls).toEqual([]);
	});

	test("a client without a session surface is capability-unavailable and untouched otherwise", async () => {
		const harness = createRestoreHarness();

		const outcome = await runRestorePreflight({}, harness.input);

		expect(outcome.status).toBe("capability-unavailable");
		expect(harness.passwordCalls).toEqual([]);
		expect(harness.readArtifactCalls).toEqual([]);
		expect(harness.readDestinationCalls).toEqual([]);
		expect(harness.inventoryCalls).toBe(0);
		expect(harness.importCalls).toEqual([]);
	});

	test("a cancelled password returns canceled without reading the artifact", async () => {
		const harness = createRestoreHarness({ passwordResult: "cancel" });

		const outcome = await runRestorePreflight(harness.client, harness.input);

		expect(outcome).toEqual({ status: "canceled" });
		// Cancel resolves no password bytes, so there is nothing to zero; the
		// invariant is that no artifact read, crypto, destination, inventory, or
		// import follows.
		expect(harness.readArtifactCalls).toEqual([]);
		expect(harness.crypto.createPolicies).toEqual([]);
		expect(harness.crypto.openAndStagePasswords).toEqual([]);
		expect(harness.readDestinationCalls).toEqual([]);
		expect(harness.inventoryCalls).toBe(0);
		expect(harness.importCalls).toEqual([]);
	});

	test("a failed authentication propagates unchanged and blocks parse, destination, and preflight", async () => {
		const password = new Uint8Array([9, 9, 9]);
		const authError = new Error("authentication failed");
		const harness = createRestoreHarness({ passwordResult: password, openAndStageError: authError });

		let caught: unknown;
		try {
			await runRestorePreflight(harness.client, harness.input);
		} catch (error) {
			caught = error;
		}

		// No wrong-password/corruption classification: the exact crypto error is
		// propagated and no later step (parse/destination/inventory/preflight/import) runs.
		expect(caught).toBe(authError);
		expect(harness.readArtifactCalls).toEqual([ARTIFACT_PATH]);
		expect(harness.crypto.createPolicies).toEqual([TEST_CRYPTO_POLICY]);
		expect(harness.crypto.openAndStagePasswords.length).toBe(1);
		expect(harness.readDestinationCalls).toEqual([]);
		expect(harness.inventoryCalls).toBe(0);
		expect(harness.importCalls).toEqual([]);
		expect(allZero(password)).toBe(true);
	});

	test("authenticated strict parse, destination snapshot, and planner complete before any import", async () => {
		const password = new Uint8Array([4, 4, 4, 4]);
		const harness = createRestoreHarness({
			passwordResult: password,
			authenticatedBytes: parentChildPayloadBytes(),
		});

		const outcome = await runRestorePreflight(harness.client, harness.input);

		expect(outcome.status).toBe("planned");
		if (outcome.status !== "planned") throw new Error("expected a completed restore plan");
		expect(outcome.targetDirectory).toBe(TARGET_DIRECTORY);
		expect(outcome.plan.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_parent", "ses_child"]);
		expect(outcome.plan.importOrder.map((entry) => entry.classification)).toEqual(["imported", "imported"]);

		// The probe was the first externally observable action.
		expect(harness.probeObserved()).toBe(true);
		expect(harness.probeStateAtPassword).toEqual([true]);
		expect(harness.passwordCalls).toEqual(["restore"]);
		expect(harness.events.events).toEqual([
			"password",
			"read-artifact",
			"crypto:create",
			"crypto:openAndStage",
			"destination",
			"inventory",
		]);
		expect(harness.readArtifactCalls).toEqual([ARTIFACT_PATH]);
		expect(harness.crypto.createPolicies[0]).toBe(TEST_CRYPTO_POLICY);
		expect(harness.crypto.authenticatedArtifactBytes).toBe(2);

		// The destination scope is the explicit destination project ID, never the
		// source `info.projectID` carried by the payload records.
		expect(harness.readDestinationCalls).toEqual([DESTINATION_PROJECT_ID]);

		// The required cross-project inventory ran once, after the destination
		// snapshot and before the planner.
		expect(harness.inventoryCalls).toBe(1);

		// The importer is never invoked, even though the fake client exposes it.
		expect(harness.importCalls).toEqual([]);
		expect(allZero(password)).toBe(true);
	});

	test("invalid UTF-8 payload bytes fail closed before the destination snapshot", async () => {
		const password = new Uint8Array([1, 1]);
		const harness = createRestoreHarness({
			passwordResult: password,
			authenticatedBytes: Uint8Array.of(0xff, 0xfe, 0xfd),
		});

		await expect(runRestorePreflight(harness.client, harness.input)).rejects.toThrow();

		expect(harness.readDestinationCalls).toEqual([]);
		expect(harness.inventoryCalls).toBe(0);
		expect(harness.importCalls).toEqual([]);
		expect(allZero(password)).toBe(true);
	});

	test("valid UTF-8 that is not JSON fails closed before the destination snapshot", async () => {
		const harness = createRestoreHarness({ authenticatedBytes: new TextEncoder().encode("{not-json") });

		await expect(runRestorePreflight(harness.client, harness.input)).rejects.toThrow();

		expect(harness.readDestinationCalls).toEqual([]);
		expect(harness.inventoryCalls).toBe(0);
		expect(harness.importCalls).toEqual([]);
	});

	test("a leading BOM is not stripped and fails closed instead of being normalized away", async () => {
		const payloadBytes = encodeJson({ sessions: [] });
		const bomBytes = new Uint8Array(3 + payloadBytes.length);
		bomBytes.set([0xef, 0xbb, 0xbf], 0);
		bomBytes.set(payloadBytes, 3);
		const harness = createRestoreHarness({ authenticatedBytes: bomBytes });

		await expect(runRestorePreflight(harness.client, harness.input)).rejects.toThrow();

		expect(harness.readDestinationCalls).toEqual([]);
		expect(harness.inventoryCalls).toBe(0);
		expect(harness.importCalls).toEqual([]);
	});

	test("payload schema enforcement is delegated to planRestore and still zeroes the password", async () => {
		const password = new Uint8Array([6, 6, 6]);
		const harness = createRestoreHarness({
			passwordResult: password,
			authenticatedBytes: encodeJson({ sessions: [], extra: true }),
		});

		await expect(runRestorePreflight(harness.client, harness.input)).rejects.toBeInstanceOf(RestorePlanError);

		// Parse succeeded, so the destination snapshot and the required inventory
		// were read; preflight failed and no import was attempted.
		expect(harness.readDestinationCalls).toEqual([DESTINATION_PROJECT_ID]);
		expect(harness.inventoryCalls).toBe(1);
		expect(harness.importCalls).toEqual([]);
		expect(allZero(password)).toBe(true);
	});

	test("a destination snapshot failure propagates, blocks the inventory, and zeroes the password", async () => {
		const password = new Uint8Array([2, 2, 2]);
		const harness = createRestoreHarness({
			passwordResult: password,
			authenticatedBytes: parentChildPayloadBytes(),
			destinationError: new Error("destination enumeration failed"),
		});

		await expect(runRestorePreflight(harness.client, harness.input)).rejects.toThrow(
			"destination enumeration failed",
		);

		expect(harness.inventoryCalls).toBe(0);
		expect(harness.importCalls).toEqual([]);
		expect(allZero(password)).toBe(true);
	});

	test("an inventory failure fails the whole preflight unchanged with zero imports and no retry", async () => {
		const password = new Uint8Array([3, 3, 3]);
		const inventoryError = new SessionCollectionError(
			"session-list-failed",
			"session metadata inventory request failed",
		);
		const harness = createRestoreHarness({
			passwordResult: password,
			authenticatedBytes: parentChildPayloadBytes(),
			inventoryError,
		});

		let caught: unknown;
		try {
			await runRestorePreflight(harness.client, harness.input);
		} catch (error) {
			caught = error;
		}

		// The inventory error propagates unchanged with its existing sanitized
		// taxonomy; the destination was already read, nothing was planned or
		// imported, and no retry exists at this layer.
		expect(caught).toBe(inventoryError);
		expect(harness.readDestinationCalls).toEqual([DESTINATION_PROJECT_ID]);
		expect(harness.inventoryCalls).toBe(1);
		expect(harness.importCalls).toEqual([]);
		expect(allZero(password)).toBe(true);
	});

	test("inventory IDs occupied outside the destination deterministically rename the source session", async () => {
		const harness = createRestoreHarness({
			authenticatedBytes: encodeJson({
				sessions: [sessionRecord("ses_remote", [userMessage("msg_remote")], "proj_source")],
			}),
			inventoryResult: ["ses_remote"],
		});

		const outcome = await runRestorePreflight(harness.client, harness.input);

		expect(outcome.status).toBe("planned");
		if (outcome.status !== "planned") throw new Error("expected a completed restore plan");
		expect(outcome.plan.entries).toHaveLength(1);
		const entry = outcome.plan.entries[0]!;
		expect(entry.classification).toBe("renamed");
		expect(entry.targetSessionID).not.toBe("ses_remote");
		expect(entry.targetSessionID).toMatch(/^ses_[0-9a-f]{64}$/);
		// Occupancy only: the planned record keeps every non-ID field verbatim.
		expect(entry.record.info["projectID"]).toBe("proj_source");
		expect(entry.record.messages[0]?.["id"]).toMatch(/^msg_[0-9a-f]{64}$/);
		expect(harness.importCalls).toEqual([]);
	});

	test("an empty inventory leaves a non-conflicting source ID unchanged", async () => {
		const harness = createRestoreHarness({
			authenticatedBytes: encodeJson({
				sessions: [sessionRecord("ses_free", [userMessage("msg_free")], "proj_source")],
			}),
			inventoryResult: [],
		});

		const outcome = await runRestorePreflight(harness.client, harness.input);

		expect(outcome.status).toBe("planned");
		if (outcome.status !== "planned") throw new Error("expected a completed restore plan");
		expect(outcome.plan.entries[0]?.classification).toBe("imported");
		expect(outcome.plan.entries[0]?.targetSessionID).toBe("ses_free");
	});

	test("a malformed inventory (duplicate IDs) fails closed as invalid-input before any import", async () => {
		const harness = createRestoreHarness({
			authenticatedBytes: parentChildPayloadBytes(),
			inventoryResult: ["ses_parent", "ses_parent"],
		});

		let caught: unknown;
		try {
			await runRestorePreflight(harness.client, harness.input);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(RestorePlanError);
		expect((caught as RestorePlanError).code).toBe("invalid-input");
		expect(harness.importCalls).toEqual([]);
	});

	test("the explicit target directory is required and rejected before any effect", async () => {
		const harness = createRestoreHarness();
		const badInput = { ...harness.input, targetDirectory: "" } as RestorePreflightInput;

		await expect(runRestorePreflight(harness.client, badInput)).rejects.toThrow(TypeError);

		expect(harness.events.events).toEqual([]);
		expect(harness.passwordCalls).toEqual([]);
	});

	test("the orchestration surface exposes no import executor", () => {
		expect(typeof orchestration.runCheckpointFlow).toBe("function");
		expect(typeof orchestration.runRestorePreflight).toBe("function");
		expect(Object.keys(orchestration).filter((name) => /import/i.test(name))).toEqual([]);
	});
});
