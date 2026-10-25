/**
 * Local-first 0.1.7 restore wiring tests.
 *
 * These call the real `createSessionPortHandlers` restore callback with the
 * real core replacement planner/executor. Host effects are synthetic fake
 * clients except for one end-to-end recovery test that uses the real
 * experimental crypto factory and an isolated approved temp directory.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
	encodeJson,
	type ByteSource,
	type CheckpointCryptoFactory,
	type CryptoPolicy,
	type SessionRecord,
} from "../../../src/core/contracts/index.ts";
import { createCheckpointCryptoFactory } from "../../../src/core/crypto/index.ts";
import { resolveLatestCheckpointArtifact, resolveRecoveryArtifactPath, writeEncryptedArtifact, readEncryptedArtifact } from "../../../src/tui/artifacts/files.ts";
import {
	EXPERIMENTAL_CRYPTO_POLICY,
	EXPERIMENTAL_CRYPTO_POLICY_DEFINITION,
	EXPERIMENTAL_MAX_PASSWORD_BYTES,
} from "../../../src/tui/wiring/index.ts";
import { createSessionPortHandlers, type SessionPortHandlerDependencies } from "../../../src/tui/wiring/index.ts";
import type { RestoreReplacementPreview, RestoreReplacementReport } from "../../../src/tui/orchestration/index.ts";
import {
	createFakeClient,
	createFakeDialog,
	createFakePasswordProvider,
	sessionRecord,
	userMessage,
	TEST_ACTIVE_DIRECTORY,
	TEST_DEST_DIRECTORY,
	TEST_DEST_PROJECT_ID,
} from "./test-support.ts";

const ARTIFACT_PATH = "C:/work/artifacts/checkpoint-local.sessionport";
const PASSWORD = new TextEncoder().encode("test-only-password");
const ARTIFACT_IDENTITY = Uint8Array.from({ length: 16 }, (_, index) => index + 7);
const TEST_TEMP_ROOT = "C:/Users/PC/AppData/Local/Temp/opencode";

function destinationProjects(): unknown {
	return [{ id: TEST_DEST_PROJECT_ID, canonical: TEST_DEST_DIRECTORY, name: "Dest" }];
}



interface ReversibleCryptoOptions {
	readonly checkpointBytes: Uint8Array;
	readonly corruptRecovery?: boolean;
}

/**
 * In-memory reversible crypto stand-in for non-crypto wiring tests. Plaintext
 * never touches disk: `seal` maps a random token to memory and `writeEncryptedArtifact`
 * stores only that token, while `openAndStage` resolves it back. Real crypto is
 * exercised by the separate temp-directory integration test.
 */
function createReversibleCrypto(options: ReversibleCryptoOptions): CheckpointCryptoFactory {
	const sealed = new Map<string, Uint8Array>();
	let counter = 0;
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const factory: CheckpointCryptoFactory = {
		async create(_policy: CryptoPolicy) {
			return {
				async seal(plaintext, _password) {
					const chunks: Uint8Array[] = [];
					for await (const chunk of plaintext) chunks.push(Uint8Array.from(chunk));
					const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
					const bytes = new Uint8Array(total);
					let offset = 0;
					for (const chunk of chunks) {
						bytes.set(chunk, offset);
						offset += chunk.byteLength;
					}
					const token = `sealed-token-${counter++}`;
					sealed.set(token, bytes);
					return (async function* sealedSource() {
						yield encoder.encode(token);
					})();
				},
				async openAndStage(artifact, _password) {
					let text = "";
					for await (const chunk of artifact) text += decoder.decode(chunk, { stream: true });
					text += decoder.decode();
					const stored = sealed.get(text);
					if (stored === undefined) {
						return { bytes: options.checkpointBytes, artifactIdentity: ARTIFACT_IDENTITY };
					}
					if (!options.corruptRecovery) {
						return { bytes: stored, artifactIdentity: ARTIFACT_IDENTITY };
					}
					const parsed = JSON.parse(decoder.decode(stored)) as { sessions?: Array<{ info?: Record<string, unknown> }> };
					if (parsed.sessions?.[0]?.info !== undefined) parsed.sessions[0].info["title"] = "CORRUPTED-RECOVERY";
					return { bytes: encoder.encode(JSON.stringify(parsed)), artifactIdentity: ARTIFACT_IDENTITY };
				},
			};
		},
	};
	return factory;
}

interface HarnessOptions {
	readonly destination: readonly SessionRecord[];
	readonly checkpoint: readonly SessionRecord[];
	readonly withRemove?: boolean;
	readonly confirm?: (preview: RestoreReplacementPreview) => boolean | Promise<boolean>;
	readonly crypto?: CheckpointCryptoFactory;
	readonly corruptRecovery?: boolean;
	readonly onImport?: (record: SessionRecord, sessions: SessionRecord[]) => void;
	readonly recoveryPath?: string;
	readonly readEncryptedArtifact?: (targetPath: string) => ByteSource;
	readonly writeEncryptedArtifact?: (targetPath: string, source: ByteSource) => Promise<number>;
	readonly resolveRecoveryPath?: (options: { readonly projectDirectory: string; readonly now: Date }) => Promise<string>;
	readonly latest?: string | undefined;
	/** Makes the unfiltered global inventory request fail (incomplete => copy only). */
	readonly breakGlobalInventory?: boolean;
	/** Removes the callable session.get dependency-read capability. */
	readonly withoutSessionGet?: boolean;
}

interface Harness {
	readonly handlers: ReturnType<typeof createSessionPortHandlers>;
	readonly client: ReturnType<typeof createFakeClient>;
	readonly previews: RestoreReplacementPreview[];
	readonly reports: RestoreReplacementReport[];
	readonly passwordCalls: Array<{ readonly mode: "checkpoint" | "restore"; readonly maxPasswordBytes: number }>;
	readonly notifications: Array<{ readonly title: string; readonly message: string; readonly variant: string }>;
	readonly written: Array<{ readonly path: string; readonly bytes: number }>;
	readonly sessions: SessionRecord[];
}

function createHarness(options: HarnessOptions): Harness {
	const sessions: SessionRecord[] = [...options.destination];
	const client = createFakeClient({
		sessions,
		withRemove: options.withRemove,
		withSessionGet: options.withoutSessionGet !== true,
		projects: async () => destinationProjects(),
		...(options.breakGlobalInventory === true
			? {
					sessionList: async (input: {
						readonly project?: string;
						readonly limit: number;
						readonly cursor?: string;
					}) => {
						if (input.project === undefined) throw new Error("global inventory failed");
						return {
							data: sessions
								.filter((record) => record.info["projectID"] === input.project)
								.map((record) => record.info),
							cursor: null,
						};
					},
				}
			: {}),
		locationGet: async (input) => ({
			directory: input.location.directory,
			project: { id: TEST_DEST_PROJECT_ID, directory: input.location.directory, canonical: input.location.directory },
		}),
		importSession: async (input) => {
			const call = input as {
				readonly info: Record<string, unknown>;
				readonly messages: readonly Record<string, unknown>[];
				readonly location: { readonly directory: string };
			};
			const now = Date.now();
			const record: SessionRecord = {
				info: {
					...call.info,
					projectID: TEST_DEST_PROJECT_ID,
					location: { directory: TEST_DEST_DIRECTORY },
					time: { ...(call.info["time"] as Record<string, unknown>), updated: now },
				} as SessionRecord["info"],
				messages: call.messages as SessionRecord["messages"],
			};
			sessions.push(record);
			options.onImport?.(record, sessions);
			return {
				id: record.info["id"],
				projectID: TEST_DEST_PROJECT_ID,
				location: { directory: TEST_DEST_DIRECTORY },
			};
		},
	});
	const dialog = createFakeDialog();
	const password = createFakePasswordProvider({ result: PASSWORD });
	const previews: RestoreReplacementPreview[] = [];
	const reports: RestoreReplacementReport[] = [];
	const notifications: Harness["notifications"] = [];
	const written: Array<{ path: string; bytes: number }> = [];
	const files = new Map<string, Uint8Array>();
	const checkpointBytes = encodeJson({ sessions: options.checkpoint });
	const crypto = options.crypto ?? createReversibleCrypto({ checkpointBytes, corruptRecovery: options.corruptRecovery });
	const write = options.writeEncryptedArtifact ?? (async (targetPath, source) => {
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for await (const chunk of source) {
			chunks.push(Uint8Array.from(chunk));
			bytes += chunk.byteLength;
		}
		const stored = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			stored.set(chunk, offset);
			offset += chunk.byteLength;
		}
		files.set(targetPath, stored);
		written.push({ path: targetPath, bytes });
		return bytes;
	});
	const read = options.readEncryptedArtifact ?? ((targetPath: string): ByteSource => {
		const stored = files.get(targetPath);
		return (async function* artifact() {
			yield stored ?? Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
		})();
	});
	const resolveRecoveryPath = options.resolveRecoveryPath ?? (async () => options.recoveryPath ?? "C:/work/dest/.sessionport/recovery-test.sessionport");

	const dependencies: SessionPortHandlerDependencies = {
		client: client.client,
		getActiveDirectory: () => TEST_ACTIVE_DIRECTORY,
		dialog: dialog.dialog,
		notify: (notification) => notifications.push(notification),
		showRestoreReport: () => {
			throw new Error("legacy report presenter must not be used when replacement UI is supplied");
		},
		restoreReplacementUi: {
			async confirm(preview) {
				previews.push(preview);
				return (await options.confirm?.(preview)) ?? true;
			},
			async report(report) {
				reports.push(report);
			},
		},
		resolveRecoveryArtifactPath: resolveRecoveryPath,
		clock: () => Date.now(),
		requestPassword: password.provider,
		cryptoFactory: crypto,
		idDeriver: {
			derive(namespace, _identity, originalID) {
				const prefix = namespace === "session" ? "ses_" : "msg_";
				const hex = [...new TextEncoder().encode(`${namespace}:${originalID}`)]
					.map((byte) => byte.toString(16).padStart(2, "0"))
					.join("")
					.padEnd(64, "0")
					.slice(0, 64);
				return prefix + hex;
			},
		},
		resolveCheckpointOutputPath: async () => "C:/work/active/.sessionport/checkpoint-test.sessionport",
		resolveLatestCheckpointArtifact: async () => options.latest,
		writeEncryptedArtifact: write,
		readEncryptedArtifact: read,
	};

	return {
		handlers: createSessionPortHandlers(dependencies),
		client,
		previews,
		reports,
		passwordCalls: password.calls,
		notifications,
		written,
		sessions,
	};
}

function localSession(id: string, title: string, projectID = TEST_DEST_PROJECT_ID): SessionRecord {
	return sessionRecord(id, [userMessage(`msg_${id}`)], projectID, { title });
}

describe("local-first restore wiring", () => {
	test("preview cancellation performs zero imports, recovery writes, or deletes", async () => {
		const harness = createHarness({
			destination: [localSession("ses_old", "local title")],
			checkpoint: [sessionRecord("ses_old", [userMessage("msg_old")], "proj_source", { title: "checkpoint title" })],
			withRemove: true,
			confirm: () => false,
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.previews).toHaveLength(1);
		expect(harness.client.importInputs).toHaveLength(0);
		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.written).toHaveLength(0);
		expect(harness.notifications[0]?.message).toContain("canceled");
	});

	test("an absent target is imported only and never deleted", async () => {
		const harness = createHarness({
			destination: [],
			checkpoint: [sessionRecord("ses_new", [userMessage("msg_new")], "proj_source")],
		});

		await harness.handlers.restore(ARTIFACT_PATH);
		expect(harness.client.importInputs).toHaveLength(1);
		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.reports[0]?.entries.map((entry) => entry.outcome)).toEqual(["imported"]);
		expect(harness.previews[0]?.entries.map((entry) => entry.action)).toEqual(["import"]);
	});

	test("an exact plaintext duplicate is skipped without import or delete", async () => {
		const duplicate = sessionRecord(
			"ses_same",
			[userMessage("msg_same")],
			TEST_DEST_PROJECT_ID,
			{ title: "same title" },
		);
		const harness = createHarness({ destination: [duplicate], checkpoint: [duplicate] });

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.importInputs).toHaveLength(0);
		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.previews[0]?.entries[0]?.action).toBe("skip");
		expect(harness.previews[0]?.entries[0]?.reason).toBe("exact-duplicate");
	});

	test("a malformed original graph fails closed before any reference is stripped", async () => {
		const harness = createHarness({
			destination: [],
			checkpoint: [
				sessionRecord("ses_child", [userMessage("msg_child")], "proj_source", { parentID: "ses_missing" }),
			],
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.previews).toHaveLength(0);
		expect(harness.client.importInputs).toHaveLength(0);
		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.notifications[0]?.variant).toBe("error");
		expect(harness.notifications[0]?.message).not.toContain("ses_missing");
	});

	test("an incomplete global reference inventory downgrades replace to copy without aborting", async () => {
		const harness = createHarness({
			destination: [localSession("ses_old", "local title")],
			checkpoint: [sessionRecord("ses_old", [userMessage("msg_old")], "proj_source", { title: "checkpoint title" })],
			withRemove: true,
			breakGlobalInventory: true,
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.previews[0]?.entries[0]?.reason).toBe("inventory-incomplete");
		expect(harness.client.importInputs).toHaveLength(1);
		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.reports[0]?.entries[0]?.reason).toBe("inventory-incomplete");
	});

	test("a missing session.remove capability downgrades replace to copy", async () => {
		const harness = createHarness({
			destination: [localSession("ses_old", "local title")],
			checkpoint: [sessionRecord("ses_old", [userMessage("msg_old")], "proj_source", { title: "checkpoint title" })],
			withRemove: false,
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.previews[0]?.entries[0]?.action).toBe("copy");
		expect(harness.previews[0]?.entries[0]?.reason).toBe("delete-capability-unavailable");
		expect(harness.client.importInputs).toHaveLength(1);
		expect(harness.reports[0]?.entries[0]?.outcome).toBe("copied");
	});

	test("a fork record is copied parentless with a warning and no DELETE", async () => {
		const parent = sessionRecord("ses_parent", [userMessage("msg_parent")], "proj_source");
		const child = sessionRecord("ses_child", [userMessage("msg_child")], "proj_source", {
			fork: { sessionID: "ses_parent", boundary: { type: "through", messageID: "msg_parent" } },
		});
		const harness = createHarness({
			destination: [localSession("ses_child", "local child")],
			checkpoint: [parent, child],
			withRemove: true,
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.removeInputs).toHaveLength(0);
		const importedChild = harness.client.importInputs.find(
			(input) => (input as { info: { id: string } }).info.id !== "ses_parent",
		) as { info: { parentID?: unknown; fork?: unknown; revert?: unknown } } | undefined;
		expect(importedChild?.info.parentID).toBeUndefined();
		expect(importedChild?.info.fork).toBeUndefined();
		expect(importedChild?.info.revert).toBeUndefined();
		const childReport = harness.reports[0]?.entries.find((entry) => entry.sessionID === "ses_child");
		expect(childReport?.outcome).toBe("copied");
		// The raw fork/parent graph differs from the local standalone target, so
		// the engine conservatively warns and copies instead of deleting.
		expect(["original-fork-or-revert", "incoming-reference"]).toContain(childReport?.reason);
	});

	test("a target changed after preview keeps the old session and never deletes", async () => {
		const harness = createHarness({
			destination: [localSession("ses_old", "local title")],
			checkpoint: [sessionRecord("ses_old", [userMessage("msg_old")], "proj_source", { title: "checkpoint title" })],
			withRemove: true,
			onImport: (_record, sessions) => {
				const target = sessions.find((record) => record.info["id"] === "ses_old");
				if (target !== undefined) target.info["title"] = "edited during restore";
			},
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.removeInputs).toHaveLength(0);
		const kept = harness.reports[0]?.entries.find((entry) => entry.sessionID === "ses_old");
		expect(kept?.outcome).toBe("kept");
		expect(kept?.reason).toBe("target-changed");
	});

	test("missing session.get prevents full verification and never deletes", async () => {
		const harness = createHarness({
			destination: [localSession("ses_old", "local title")],
			checkpoint: [sessionRecord("ses_old", [userMessage("msg_old")], "proj_source", { title: "checkpoint title" })],
			withRemove: true,
			withoutSessionGet: true,
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.previews[0]?.entries[0]?.action).toBe("copy");
		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.reports[0]?.entries[0]?.outcome).toBe("failed");
		expect(harness.client.importInputs).toHaveLength(1);
	});

	test("a recovery readback mismatch keeps the old session and never deletes", async () => {
		const harness = createHarness({
			destination: [localSession("ses_old", "local title")],
			checkpoint: [sessionRecord("ses_old", [userMessage("msg_old")], "proj_source", { title: "checkpoint title" })],
			withRemove: true,
			corruptRecovery: true,
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.removeInputs).toHaveLength(0);
		const kept = harness.reports[0]?.entries.find((entry) => entry.sessionID === "ses_old");
		expect(kept?.outcome).toBe("kept");
		expect(kept?.reason).toBe("recovery-unverified");
	});

	test("an eligible replacement uses the real experimental factory and a verified encrypted recovery file", async () => {
		const tempRoot = path.join(TEST_TEMP_ROOT, `sessionport-local-restore-${process.pid}-${Date.now()}`);
		const destinationDirectory = path.join(tempRoot, "destination");
		const checkpointPath = path.join(tempRoot, "checkpoint.sessionport");
		await mkdir(path.join(destinationDirectory, ".sessionport"), { recursive: true });
		try {
			const factory = await createCheckpointCryptoFactory([EXPERIMENTAL_CRYPTO_POLICY_DEFINITION]);
			const checkpointBytes = encodeJson({
				sessions: [sessionRecord("ses_old", [userMessage("msg_old")], "proj_source", { title: "checkpoint title" })],
			});
			const sealedCheckpoint = await (await factory.create(EXPERIMENTAL_CRYPTO_POLICY)).seal(
				(async function* source() {
					yield checkpointBytes;
				})(),
				PASSWORD,
			);
			await writeEncryptedArtifact(checkpointPath, sealedCheckpoint);

			const destination = [
				{
					info: {
						id: "ses_old",
						projectID: TEST_DEST_PROJECT_ID,
						title: "local different title",
						cost: 0,
						tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
						time: { created: 1, updated: 2 },
						location: { directory: destinationDirectory },
					},
					messages: [userMessage("msg_old")],
				},
			];
			const harness = createHarness({
				destination,
				checkpoint: [],
				withRemove: true,
				crypto: factory,
				readEncryptedArtifact,
				writeEncryptedArtifact,
				resolveRecoveryPath: (options) =>
					resolveRecoveryArtifactPath({
						projectDirectory: destinationDirectory,
						now: options.now,
						randomSuffix: "abcdef1234567890",
					}),
			});
			// The fixture above is the authenticated artifact; the harness reads it by path.
			await harness.handlers.restore(checkpointPath);

			expect(harness.client.removeInputs).toEqual([{ sessionID: "ses_old" }]);
			const replaced = harness.reports[0]?.entries.find((entry) => entry.sessionID === "ses_old");
			expect(replaced?.outcome).toBe("replaced");
			expect(harness.reports[0]?.recoveryPath).toBeDefined();

			const recoveryName = (await readdir(path.join(destinationDirectory, ".sessionport"))).find((name) =>
				name.startsWith("recovery-"),
			);
			expect(recoveryName).toBeDefined();
			const recoveryBytes = await readFile(path.join(destinationDirectory, ".sessionport", recoveryName!));
			expect(recoveryBytes.byteLength).toBeGreaterThan(0);
			const opened = await (await factory.create(EXPERIMENTAL_CRYPTO_POLICY)).openAndStage(
				(async function* source() {
					yield recoveryBytes;
				})(),
				PASSWORD,
			);
			const recovered = JSON.parse(new TextDecoder().decode(opened.bytes)) as { sessions: Array<{ info: { id: string; title: string } }> };
			expect(recovered.sessions[0]?.info.id).toBe("ses_old");
			expect(recovered.sessions[0]?.info.title).toBe("local different title");
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("two real-crypto replacements write two verified recovery artifacts and report the first path", async () => {
		const tempRoot = path.join(TEST_TEMP_ROOT, `sessionport-local-multi-${process.pid}-${Date.now()}`);
		const destinationDirectory = path.join(tempRoot, "destination");
		const checkpointPath = path.join(tempRoot, "checkpoint.sessionport");
		await mkdir(path.join(destinationDirectory, ".sessionport"), { recursive: true });
		try {
			const factory = await createCheckpointCryptoFactory([EXPERIMENTAL_CRYPTO_POLICY_DEFINITION]);
			const checkpointBytes = encodeJson({
				sessions: [
					sessionRecord("ses_one", [userMessage("msg_one")], "proj_source", { title: "checkpoint one" }),
					sessionRecord("ses_two", [userMessage("msg_two")], "proj_source", { title: "checkpoint two" }),
				],
			});
			await writeEncryptedArtifact(
				checkpointPath,
				await (await factory.create(EXPERIMENTAL_CRYPTO_POLICY)).seal(
					(async function* source() {
						yield checkpointBytes;
					})(),
					PASSWORD,
				),
			);

			const destination = [
				{
					info: {
						id: "ses_one",
						projectID: TEST_DEST_PROJECT_ID,
						title: "local one",
						cost: 0,
						tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
						time: { created: 1, updated: 2 },
						location: { directory: destinationDirectory },
					},
					messages: [userMessage("msg_one")],
				},
				{
					info: {
						id: "ses_two",
						projectID: TEST_DEST_PROJECT_ID,
						title: "local two",
						cost: 0,
						tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
						time: { created: 1, updated: 2 },
						location: { directory: destinationDirectory },
					},
					messages: [userMessage("msg_two")],
				},
			];
			let recoveryIndex = 0;
			const recoveryPaths: string[] = [];
			const harness = createHarness({
				destination,
				checkpoint: [],
				withRemove: true,
				crypto: factory,
				readEncryptedArtifact,
				writeEncryptedArtifact,
				resolveRecoveryPath: async (options) => {
					const resolved = await resolveRecoveryArtifactPath({
						projectDirectory: destinationDirectory,
						now: options.now,
						randomSuffix: `multi${recoveryIndex++}`,
					});
					recoveryPaths.push(resolved);
					return resolved;
				},
			});
			await harness.handlers.restore(checkpointPath);

			expect(harness.client.removeInputs).toHaveLength(2);
			expect(recoveryPaths).toHaveLength(2);
			expect(new Set(recoveryPaths).size).toBe(2);
			expect(harness.reports[0]?.recoveryPath).toBe(recoveryPaths[0]);
			const files = (await readdir(path.join(destinationDirectory, ".sessionport"))).filter((name) =>
				name.startsWith("recovery-"),
			);
			expect(files).toHaveLength(2);
			for (const file of files) {
				const opened = await (await factory.create(EXPERIMENTAL_CRYPTO_POLICY)).openAndStage(
					(async function* source() {
						yield await readFile(path.join(destinationDirectory, ".sessionport", file));
					})(),
					PASSWORD,
				);
				const recovered = JSON.parse(new TextDecoder().decode(opened.bytes)) as {
					sessions: Array<{ info: { id: string } }>;
				};
				expect(recovered.sessions.length).toBeGreaterThanOrEqual(2);
			}
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("latest checkpoint discovery ignores newer recovery artifacts", async () => {
		const tempRoot = path.join(TEST_TEMP_ROOT, `sessionport-latest-${process.pid}-${Date.now()}`);
		const directory = path.join(tempRoot, ".sessionport");
		await mkdir(directory, { recursive: true });
		try {
			const checkpointPath = path.join(directory, "checkpoint-2026.sessionport");
			const recoveryPath = path.join(directory, "recovery-2027.sessionport");
			await writeFile(checkpointPath, "checkpoint");
			await writeFile(recoveryPath, "recovery");
			const later = new Date(Date.now() + 10_000);
			await import("node:fs/promises").then(({ utimes }) => utimes(recoveryPath, later, later));
			expect(await resolveLatestCheckpointArtifact({ projectDirectory: tempRoot })).toBe(checkpointPath);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});


