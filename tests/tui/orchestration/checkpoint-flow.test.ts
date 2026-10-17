/**
 * Checkpoint-flow tests (Phase 4 orchestration; `fix-57`).
 *
 * Fake session ports, fake password providers, fake crypto factories, and fake
 * store functions only: no real host call, KDF, filesystem write, or import.
 * These tests pin the required sequence and short-circuit invariants for the
 * injected checkpoint flow and make no runtime, compatibility, or production
 * policy claim (O-01/O-02/O-03/O-10/O-11/O-15 stay OPEN). Password zeroing is
 * best-effort byte overwriting, not secure deletion (A-07).
 */

import { describe, expect, test } from "bun:test";
import { serializeCheckpointPayload, SessionCollectionError } from "../../../src/core/sessions/index.ts";
import type { SessionRecord } from "../../../src/core/contracts/index.ts";
import { runCheckpointFlow, type CheckpointFlowInput } from "../../../src/tui/orchestration/index.ts";
import type { ResolveCheckpointOutputPathOptions } from "../../../src/tui/artifacts/files.ts";
import {
	createEventLog,
	createFakeCryptoFactory,
	createFakeSessionPort,
	sessionRecord,
	userMessage,
	TEST_COLLECTION_POLICY,
	TEST_CRYPTO_POLICY,
	type EventLog,
	type FakeCryptoFactoryOptions,
} from "./test-support.ts";

const PROJECT_ID = "proj_test";
const PROJECT_DIRECTORY = "C:/work/project";
const ARTIFACT_PATH = "C:/work/project/.sessionport/checkpoint-test.sessionport";

interface CheckpointHarnessOptions {
	readonly sessions?: readonly SessionRecord[];
	/** Defaults to a synthetic non-zero password; `"cancel"` resolves `undefined`. */
	readonly passwordResult?: Uint8Array | "cancel";
	readonly crypto?: FakeCryptoFactoryOptions;
	readonly resolveError?: Error;
	readonly writeError?: Error;
	readonly writeErrorAfterConsume?: Error;
	readonly explicitOutputPath?: string;
	readonly portError?: Error;
}

interface CheckpointHarness {
	readonly input: CheckpointFlowInput;
	readonly events: EventLog;
	readonly crypto: ReturnType<typeof createFakeCryptoFactory>;
	readonly passwordCalls: string[];
	readonly resolveCalls: ResolveCheckpointOutputPathOptions[];
	readonly writeCalls: Array<{ readonly targetPath: string; readonly bytes: number }>;
	readonly password: Uint8Array | undefined;
	readonly port: Parameters<typeof runCheckpointFlow>[0];
}

/** Builds a fully injected fake checkpoint environment; every effect is recorded. */
function createCheckpointHarness(options: CheckpointHarnessOptions = {}): CheckpointHarness {
	const events = createEventLog();
	const sessions = options.sessions ?? [sessionRecord("ses_a", [userMessage("msg_1")])];
	const port = options.portError
		? {
				async listSessions(): Promise<unknown> {
					throw options.portError;
				},
				async listMessages(): Promise<unknown> {
					throw options.portError;
				},
			}
		: createFakeSessionPort(sessions, events);
	const crypto = createFakeCryptoFactory(options.crypto ?? {}, events);
	const passwordCalls: string[] = [];
	const resolveCalls: ResolveCheckpointOutputPathOptions[] = [];
	const writeCalls: Array<{ targetPath: string; bytes: number }> = [];
	const password =
		options.passwordResult === "cancel" ? undefined : (options.passwordResult ?? new Uint8Array([1, 2, 3, 4]));

	const input: CheckpointFlowInput = {
		projectID: PROJECT_ID,
		projectDirectory: PROJECT_DIRECTORY,
		policy: TEST_COLLECTION_POLICY,
		cryptoFactory: crypto.factory,
		cryptoPolicy: TEST_CRYPTO_POLICY,
		resolveCheckpointOutputPath: async (resolveOptions) => {
			events.record("resolve-path");
			resolveCalls.push(resolveOptions);
			if (options.resolveError !== undefined) throw options.resolveError;
			return ARTIFACT_PATH;
		},
		writeEncryptedArtifact: async (targetPath, source) => {
			events.record("write");
			if (options.writeError !== undefined) throw options.writeError;
			let bytes = 0;
			for await (const chunk of source) bytes += chunk.byteLength;
			if (options.writeErrorAfterConsume !== undefined) throw options.writeErrorAfterConsume;
			writeCalls.push({ targetPath, bytes });
			return bytes;
		},
		requestPassword: async (purpose) => {
			events.record("password");
			passwordCalls.push(purpose);
			return password;
		},
		...(options.explicitOutputPath !== undefined ? { explicitOutputPath: options.explicitOutputPath } : {}),
	};

	return { input, events, crypto, passwordCalls, resolveCalls, writeCalls, password, port };
}

function allZero(bytes: Uint8Array): boolean {
	return bytes.every((byte) => byte === 0);
}

describe("runCheckpointFlow", () => {
	test("writes the sealed artifact and reports only low-level facts", async () => {
		const harness = createCheckpointHarness();

		const outcome = await runCheckpointFlow(harness.port, harness.input);

		expect(outcome).toEqual({
			status: "written",
			artifactPath: ARTIFACT_PATH,
			sessionCount: 1,
			encryptedBytes: 5,
		});
		expect(harness.events.events).toEqual([
			"collect:sessions",
			"collect:messages",
			"password",
			"resolve-path",
			"crypto:create",
			"crypto:seal",
			"write",
			"crypto:seal-iterate",
		]);
		expect(harness.crypto.createPolicies).toEqual([TEST_CRYPTO_POLICY]);
		expect(harness.crypto.createPolicies[0]).toBe(TEST_CRYPTO_POLICY);
		expect(harness.writeCalls).toEqual([{ targetPath: ARTIFACT_PATH, bytes: 5 }]);
		expect(harness.passwordCalls).toEqual(["checkpoint"]);

		// The sealed plaintext is exactly the serialized collected payload.
		const expectedPlaintext = new TextDecoder().decode(
			serializeCheckpointPayload({ sessions: [sessionRecord("ses_a", [userMessage("msg_1")])] }),
		);
		expect(harness.crypto.sealIterations[0]?.plaintextText).toBe(expectedPlaintext);

		// The password stayed intact while write consumed the sealed source, then was zeroed.
		expect(harness.crypto.sealIterations[0]?.passwordIntact).toBe(true);
		expect(Array.from(harness.password!)).toEqual([0, 0, 0, 0]);
	});

	test("zero sessions short-circuits before prompt, path, crypto, and write (P-04)", async () => {
		const harness = createCheckpointHarness({ sessions: [] });

		const outcome = await runCheckpointFlow(harness.port, harness.input);

		expect(outcome).toEqual({ status: "no-sessions" });
		expect(harness.passwordCalls).toEqual([]);
		expect(harness.resolveCalls).toEqual([]);
		expect(harness.crypto.createPolicies).toEqual([]);
		expect(harness.crypto.sealPasswords).toEqual([]);
		expect(harness.writeCalls).toEqual([]);
		expect(harness.events.events).toEqual(["collect:sessions"]);
	});

	test("cancelled password returns canceled without path, crypto, or write", async () => {
		const harness = createCheckpointHarness({ passwordResult: "cancel" });

		const outcome = await runCheckpointFlow(harness.port, harness.input);

		expect(outcome).toEqual({ status: "canceled" });
		expect(harness.resolveCalls).toEqual([]);
		expect(harness.crypto.createPolicies).toEqual([]);
		expect(harness.crypto.sealPasswords).toEqual([]);
		expect(harness.writeCalls).toEqual([]);
	});

	test("a write failure propagates and still zeroes the password", async () => {
		const password = new Uint8Array([7, 7, 7]);
		const writeError = new Error("disk full");
		const harness = createCheckpointHarness({ passwordResult: password, writeError });

		await expect(runCheckpointFlow(harness.port, harness.input)).rejects.toThrow("disk full");

		expect(allZero(password)).toBe(true);
		expect(harness.writeCalls).toEqual([]);
	});

	test("a write failure after consuming the sealed source still zeroes the password", async () => {
		const password = new Uint8Array([8, 8, 8, 8]);
		const harness = createCheckpointHarness({
			passwordResult: password,
			writeErrorAfterConsume: new Error("close failed"),
		});

		await expect(runCheckpointFlow(harness.port, harness.input)).rejects.toThrow("close failed");

		expect(harness.crypto.sealIterations[0]?.passwordIntact).toBe(true);
		expect(allZero(password)).toBe(true);
	});

	test("a seal failure propagates, skips write, and zeroes the password", async () => {
		const password = new Uint8Array([9, 9]);
		const harness = createCheckpointHarness({
			passwordResult: password,
			crypto: {
				seal: async () => {
					throw new Error("seal failed");
				},
			},
		});

		await expect(runCheckpointFlow(harness.port, harness.input)).rejects.toThrow("seal failed");

		expect(harness.crypto.createPolicies).toEqual([TEST_CRYPTO_POLICY]);
		expect(harness.writeCalls).toEqual([]);
		expect(allZero(password)).toBe(true);
	});

	test("a path-resolution failure propagates before crypto and write, and zeroes the password", async () => {
		const password = new Uint8Array([3, 3, 3]);
		const harness = createCheckpointHarness({
			passwordResult: password,
			resolveError: new Error("refusing to overwrite an existing artifact"),
		});

		await expect(runCheckpointFlow(harness.port, harness.input)).rejects.toThrow("refusing to overwrite");

		expect(harness.crypto.createPolicies).toEqual([]);
		expect(harness.crypto.sealPasswords).toEqual([]);
		expect(harness.writeCalls).toEqual([]);
		expect(allZero(password)).toBe(true);
	});

	test("an explicit output path is forwarded; the default omits the override key", async () => {
		const explicitHarness = createCheckpointHarness({ explicitOutputPath: "artifacts/custom.sessionport" });
		await runCheckpointFlow(explicitHarness.port, explicitHarness.input);
		expect(explicitHarness.resolveCalls).toEqual([
			{ projectDirectory: PROJECT_DIRECTORY, explicitPath: "artifacts/custom.sessionport" },
		]);

		const defaultHarness = createCheckpointHarness();
		await runCheckpointFlow(defaultHarness.port, defaultHarness.input);
		expect(defaultHarness.resolveCalls).toEqual([{ projectDirectory: PROJECT_DIRECTORY }]);
		expect(Object.prototype.hasOwnProperty.call(defaultHarness.resolveCalls[0], "explicitPath")).toBe(false);
	});

	test("a collection failure propagates before any password prompt or effect", async () => {
		const harness = createCheckpointHarness({ portError: new Error("host down") });

		await expect(runCheckpointFlow(harness.port, harness.input)).rejects.toBeInstanceOf(SessionCollectionError);

		expect(harness.passwordCalls).toEqual([]);
		expect(harness.resolveCalls).toEqual([]);
		expect(harness.crypto.createPolicies).toEqual([]);
		expect(harness.writeCalls).toEqual([]);
	});

	test("a missing password provider is rejected before collection", async () => {
		const harness = createCheckpointHarness();
		const badInput = { ...harness.input, requestPassword: undefined } as unknown as CheckpointFlowInput;

		await expect(runCheckpointFlow(harness.port, badInput)).rejects.toThrow(TypeError);

		expect(harness.events.events).toEqual([]);
	});
});
