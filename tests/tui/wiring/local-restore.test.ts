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
import { planRestore, prepareImportRecord, stampSessionLineage } from "../../../src/core/restore/index.ts";
import { resolveLatestCheckpointArtifact, resolveRecoveryArtifactPath, writeEncryptedArtifact, readEncryptedArtifact } from "../../../src/tui/artifacts/files.ts";
import {
	EXPERIMENTAL_CRYPTO_POLICY,
	EXPERIMENTAL_CRYPTO_POLICY_DEFINITION,
	EXPERIMENTAL_MAX_PASSWORD_BYTES,
} from "../../../src/tui/wiring/index.ts";
import { createSessionPortHandlers, type SessionPortHandlerDependencies } from "../../../src/tui/wiring/index.ts";
import {
	runLocalRestore,
	type LocalRestoreInput,
	type RestoreReplacementPreview,
	type RestoreReplacementReport,
} from "../../../src/tui/orchestration/index.ts";
import {
	createFakeClient,
	createFakeDialog,
	createFakePasswordProvider,
	deriveTestId,
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
	/** User-selected import mode; omitted pins the existing replace behavior. */
	readonly importMode?: "replace" | "keep";
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
		// Every existing test keeps the verified replace behavior unless it
		// explicitly selects keep mode.
		chooseRestoreImportMode: async () => options.importMode ?? "replace",
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

interface DirectRestoreHarness {
	readonly input: LocalRestoreInput;
	readonly previews: RestoreReplacementPreview[];
	readonly reports: RestoreReplacementReport[];
	readonly imports: SessionRecord[];
	readonly deleteFactoryScopes: Array<readonly string[]>;
	readonly deleteCalls: string[];
	readonly recoveryWrites: string[];
}

/**
 * Builds one explicit `LocalRestoreInput` so the import-mode pass-through can
 * be observed without the composition seam that owns the user's mode choice.
 * All effects are synthetic; only the reversible in-memory crypto stand-in is
 * used, and no file, host call, or real password is involved.
 */
function createDirectRestoreHarness(options: {
	readonly destination: readonly SessionRecord[];
	readonly checkpoint: readonly SessionRecord[];
	readonly importMode: "replace" | "keep";
}): DirectRestoreHarness {
	const live = new Map<string, SessionRecord>();
	for (const record of options.destination) live.set(String(record.info["id"]), record);
	const previews: RestoreReplacementPreview[] = [];
	const reports: RestoreReplacementReport[] = [];
	const imports: SessionRecord[] = [];
	const deleteFactoryScopes: string[][] = [];
	const deleteCalls: string[] = [];
	const recoveryWrites: string[] = [];
	const files = new Map<string, Uint8Array>();
	const checkpointBytes = encodeJson({ sessions: options.checkpoint });
	const crypto = createReversibleCrypto({ checkpointBytes });
	const now = 1000;

	const input: LocalRestoreInput = {
		artifactPath: ARTIFACT_PATH,
		destinationProjectID: TEST_DEST_PROJECT_ID,
		targetDirectory: TEST_DEST_DIRECTORY,
		importMode: options.importMode,
		cryptoFactory: crypto,
		cryptoPolicy: EXPERIMENTAL_CRYPTO_POLICY,
		readEncryptedArtifact(targetPath) {
			const stored = files.get(targetPath);
			return (async function* artifact() {
				yield stored ?? Uint8Array.of(0);
			})();
		},
		requestPassword: async () => PASSWORD,
		readDestination: async () => options.destination,
		readGloballyVisibleSessionIDs: async () =>
			options.destination.map((record) => String(record.info["id"])),
		readSession: async (sessionID) => live.get(sessionID),
		readReferenceInventory: async () => ({
			infos: options.destination.map((record) => record.info),
			complete: true,
		}),
		importer: {
			async importSession(request) {
				imports.push(request.record);
				const record: SessionRecord = {
					info: {
						...request.record.info,
						projectID: TEST_DEST_PROJECT_ID,
						location: { directory: TEST_DEST_DIRECTORY },
						time: {
							...(request.record.info["time"] as Record<string, unknown>),
							updated: now,
						},
					} as SessionRecord["info"],
					messages: request.record.messages.map((message) => ({ ...message })),
				};
				live.set(String(record.info["id"]), record);
				return {
					id: record.info["id"],
					projectID: TEST_DEST_PROJECT_ID,
					location: { directory: TEST_DEST_DIRECTORY },
				};
			},
		},
		deletePortFactory(authorizedTargetIDs) {
			deleteFactoryScopes.push([...authorizedTargetIDs]);
			return {
				capability: { available: true },
				async removeSession(sessionID) {
					deleteCalls.push(sessionID);
					live.delete(sessionID);
					return { status: "deleted" };
				},
			};
		},
		resolveRecoveryPath: async () => "C:/work/dest/.sessionport/recovery-direct.sessionport",
		async writeEncryptedArtifact(targetPath, source) {
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
			recoveryWrites.push(targetPath);
			return bytes;
		},
		idDeriver: {
			derive(namespace, _identity, originalID) {
				return deriveTestId(namespace, originalID);
			},
		},
		ui: {
			async confirm(preview) {
				previews.push(preview);
				return true;
			},
			async report(report) {
				reports.push(report);
			},
		},
		clock: () => now,
	};

	return { input, previews, reports, imports, deleteFactoryScopes, deleteCalls, recoveryWrites };
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
		const metadata = harness.sessions[0]!.info["metadata"] as { sessionport?: { lineageID?: string } } | undefined;
		expect(metadata?.sessionport?.lineageID).toBe("ses_new");
	});

	test("local restore passes keep mode through and never deletes an existing target", async () => {
		const harness = createDirectRestoreHarness({
			destination: [localSession("ses_old", "local title")],
			checkpoint: [sessionRecord("ses_old", [userMessage("msg_old")], "proj_source", { title: "checkpoint title" })],
			importMode: "keep",
		});

		const outcome = await runLocalRestore(harness.input);

		expect(outcome.status).toBe("completed");
		if (outcome.status !== "completed") return;
		expect(outcome.preview.entries[0]?.action).toBe("copy");
		expect(outcome.preview.entries[0]?.reason).toBe("keep-existing");
		expect(outcome.preview.recoveryRequired).toBe(false);
		expect(harness.imports).toHaveLength(1);
		expect(String(harness.imports[0]!.info["id"])).not.toBe("ses_old");
		expect(harness.deleteFactoryScopes).toEqual([]);
		expect(harness.deleteCalls).toEqual([]);
		expect(harness.recoveryWrites).toEqual([]);
		expect(outcome.report.entries[0]?.outcome).toBe("copied");
		expect(outcome.report.entries[0]?.reason).toBe("keep-existing");
	});

	test("local restore passes replace mode through with recovery and verified delete", async () => {
		const harness = createDirectRestoreHarness({
			destination: [localSession("ses_old", "local title")],
			checkpoint: [sessionRecord("ses_old", [userMessage("msg_old")], "proj_source", { title: "checkpoint title" })],
			importMode: "replace",
		});

		const outcome = await runLocalRestore(harness.input);

		expect(outcome.status).toBe("completed");
		if (outcome.status !== "completed") return;
		expect(outcome.preview.entries[0]?.action).toBe("replace");
		expect(outcome.preview.recoveryRequired).toBe(true);
		expect(harness.deleteFactoryScopes).toEqual([["ses_old"]]);
		expect(harness.deleteCalls).toEqual(["ses_old"]);
		expect(harness.recoveryWrites).toHaveLength(1);
		expect(outcome.report.entries[0]?.outcome).toBe("replaced");
	});

	test("keep mode imports alongside the existing session and never removes it", async () => {
		const harness = createHarness({
			destination: [localSession("ses_old", "local title")],
			checkpoint: [sessionRecord("ses_old", [userMessage("msg_old")], "proj_source", { title: "checkpoint title" })],
			withRemove: true,
			importMode: "keep",
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.previews[0]?.entries[0]?.action).toBe("copy");
		expect(harness.previews[0]?.entries[0]?.reason).toBe("keep-existing");
		expect(harness.previews[0]?.recoveryRequired).toBe(false);
		expect(harness.client.importInputs).toHaveLength(1);
		expect(harness.client.removeInputs).toEqual([]);
		expect(harness.written).toHaveLength(0);
		expect(harness.reports[0]?.entries[0]?.outcome).toBe("copied");
		expect(harness.reports[0]?.entries[0]?.reason).toBe("keep-existing");
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

	test("a content-identical copy under derived IDs is skipped without import or delete", async () => {
		// The second machine already holds this session as a prior derived-ID
		// copy: same content, different session/message IDs and host-rewritten
		// projectID/time.updated. Re-importing it must not add another copy.
		const sourceMessage = userMessage("msg_same");
		const checkpoint = sessionRecord("ses_same", [sourceMessage], "proj_source", { title: "same title" });
		const copy = sessionRecord(
			deriveTestId("session", "ses_same"),
			[{ ...sourceMessage, id: deriveTestId("message", "msg_same") }],
			TEST_DEST_PROJECT_ID,
			{ title: "same title", time: { created: 1, updated: 999 } },
		);
		const harness = createHarness({ destination: [copy], checkpoint: [checkpoint], withRemove: true });

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.importInputs).toHaveLength(0);
		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.reports[0]?.entries[0]?.outcome).toBe("skipped");
		expect(harness.previews[0]?.entries[0]?.action).toBe("skip");
		expect(harness.previews[0]?.entries[0]?.reason).toBe("exact-duplicate");
	});

	test("the same session ID with host-rewritten volatile fields is skipped, not replaced", async () => {
		// A prior restore rewrote projectID/time.updated but changed no content.
		// Canonical equality fails; content equality must skip instead of
		// deleting the local target and importing it again.
		const checkpoint = sessionRecord("ses_same", [userMessage("msg_same")], "proj_source", { title: "same title" });
		const local = sessionRecord("ses_same", [userMessage("msg_same")], TEST_DEST_PROJECT_ID, {
			title: "same title",
			time: { created: 1, updated: 999 },
		});
		const harness = createHarness({ destination: [local], checkpoint: [checkpoint], withRemove: true });

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.importInputs).toHaveLength(0);
		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.reports[0]?.entries[0]?.outcome).toBe("skipped");
	});

	test("a continued lineage updates the existing destination session in place", async () => {
		const first = { ...userMessage("msg_s1"), text: "shared first" };
		const second = { ...userMessage("msg_s2"), text: "new continuation" };
		const checkpoint = stampSessionLineage(
			sessionRecord("ses_origin", [first, second], "proj_source", { title: "Same title" }),
			"ses_origin",
		);
		const destination = stampSessionLineage(
			sessionRecord(
				"ses_copy",
				[{ ...first, id: "msg_d1" }],
				TEST_DEST_PROJECT_ID,
				{ title: "Same title", time: { created: 1, updated: 999 } },
			),
			"ses_origin",
		);
		const harness = createHarness({ destination: [destination], checkpoint: [checkpoint], withRemove: true });

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.importInputs).toHaveLength(1);
		expect(harness.client.removeInputs).toEqual([{ sessionID: "ses_copy" }]);
		expect(harness.previews[0]?.entries[0]?.action).toBe("update");
		expect(harness.reports[0]?.entries[0]?.outcome).toBe("updated");
		expect(harness.sessions).toHaveLength(1);
		expect(harness.sessions[0]!.info["id"]).toBe("ses_copy");
		expect(harness.sessions[0]!.messages).toHaveLength(2);
		const metadata = harness.sessions[0]!.info["metadata"] as { sessionport?: { lineageID?: string } } | undefined;
		expect(metadata?.sessionport?.lineageID).toBe("ses_origin");

		// A second restore of the same artifact against the now-updated local state
		// must not add another copy or delete the updated session.
		const again = createHarness({
			destination: harness.sessions,
			checkpoint: [checkpoint],
			withRemove: true,
		});
		await again.handlers.restore(ARTIFACT_PATH);
		expect(again.client.importInputs).toHaveLength(0);
		expect(again.client.removeInputs).toHaveLength(0);
		expect(again.previews[0]?.entries[0]?.action).toBe("skip");
		expect(again.reports[0]?.entries[0]?.outcome).toBe("skipped");
		expect(again.sessions).toHaveLength(1);
	});

	test("a repeated restore with a changed derived copy rederives IDs instead of failing", async () => {
		const first = { ...userMessage("msg_s1"), text: "shared first" };
		const checkpoint = stampSessionLineage(
			sessionRecord(
				"ses_origin",
				[first, { ...userMessage("msg_s2"), text: "checkpoint continuation" }],
				"proj_source",
				{ title: "Same title" },
			),
			"ses_origin",
		);
		// Simulate the local copy left by an earlier restore of this artifact:
		// the derived session/message IDs already exist, but the local copy
		// diverged after import. A second restore must preserve a new copy.
		const destination = stampSessionLineage(
			sessionRecord(
				deriveTestId("session", "ses_origin"),
				[
					{ ...first, id: deriveTestId("message", "msg_s1") },
					{ ...userMessage("msg_local"), id: deriveTestId("message", "msg_local") },
				],
				TEST_DEST_PROJECT_ID,
				{ title: "Same title", time: { created: 1, updated: 999 } },
			),
			"ses_origin",
		);
		const harness = createHarness({ destination: [destination], checkpoint: [checkpoint], withRemove: true });

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.client.importInputs).toHaveLength(1);
		expect(harness.reports[0]?.entries[0]?.outcome).toBe("copied");
		const imported = harness.client.importInputs[0] as {
			readonly info: { readonly id: string };
			readonly messages: ReadonlyArray<{ readonly id: string }>;
		};
		expect(imported.info.id).toBe("ses_origin");
		expect(imported.messages.map((message) => message.id)).toEqual([
			deriveTestId("message", "msg_s1#copy-2"),
			deriveTestId("message", "msg_s2#copy-2"),
		]);
		expect(imported.messages.map((message) => message.id)).not.toContain(
			deriveTestId("message", "msg_s1"),
		);
		expect(harness.sessions).toHaveLength(2);
	});

	test("a repeated restore whose prior copy occupies the derived IDs rederives a new copy", async () => {
		const first = { ...userMessage("msg_s1"), text: "shared first" };
		const checkpoint = stampSessionLineage(
			sessionRecord(
				"ses_origin",
				[first, { ...userMessage("msg_s2"), text: "checkpoint continuation" }],
				"proj_source",
				{ title: "Same title" },
			),
			"ses_origin",
		);
		// The destination already contains a same-ID local copy and a prior
		// derived-ID copy left by an earlier restore. Both are stamped with the
		// same lineage, and the prior copy diverged afterwards, so re-restoring
		// the artifact proposes the same derived session/message IDs that the
		// prior copy owns. The planner must derive a free variant instead of
		// failing the whole restore.
		const local = stampSessionLineage(
			sessionRecord(
				"ses_origin",
				[
					{ ...first, id: "msg_local1" },
					{ ...userMessage("msg_local2"), text: "local branch" },
				],
				TEST_DEST_PROJECT_ID,
				{ title: "Same title", time: { created: 1, updated: 999 } },
			),
			"ses_origin",
		);
		const priorCopy = stampSessionLineage(
			sessionRecord(
				deriveTestId("session", "ses_origin"),
				[
					{ ...first, id: deriveTestId("message", "msg_s1") },
					{ ...userMessage("msg_local3"), text: "prior local branch" },
				],
				TEST_DEST_PROJECT_ID,
				{ title: "Same title", time: { created: 1, updated: 999 } },
			),
			"ses_origin",
		);
		const harness = createHarness({ destination: [local, priorCopy], checkpoint: [checkpoint], withRemove: true });

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.client.importInputs).toHaveLength(1);
		expect(harness.reports[0]?.entries[0]?.outcome).toBe("copied");
		const imported = harness.client.importInputs[0] as {
			readonly info: { readonly id: string };
			readonly messages: ReadonlyArray<{ readonly id: string }>;
		};
		expect(imported.info.id).toBe(deriveTestId("session", "ses_origin#copy-2"));
		expect(imported.messages.map((message) => message.id)).toEqual([
			deriveTestId("message", "msg_s1#copy-2"),
			deriveTestId("message", "msg_s2#copy-2"),
		]);
		expect(harness.sessions).toHaveLength(3);
	});

	test("a diverged lineage keeps both versions and never deletes the local one", async () => {
		const localFirst = { ...userMessage("msg_l1"), text: "shared first" };
		const checkpoint = stampSessionLineage(
			sessionRecord(
				"ses_origin",
				[
					{ ...localFirst, id: "msg_s1" },
					{ ...userMessage("msg_s2"), text: "checkpoint branch" },
				],
				"proj_source",
				{ title: "Same title" },
			),
			"ses_origin",
		);
		const destination = stampSessionLineage(
			sessionRecord(
				"ses_copy",
				[localFirst, { ...userMessage("msg_l2"), text: "local branch" }],
				TEST_DEST_PROJECT_ID,
				{ title: "Same title" },
			),
			"ses_origin",
		);
		const harness = createHarness({ destination: [destination], checkpoint: [checkpoint], withRemove: true });

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.removeInputs).toEqual([]);
		expect(harness.client.importInputs).toHaveLength(1);
		expect(harness.previews[0]?.entries[0]?.action).toBe("copy");
		expect(harness.reports[0]?.entries[0]?.outcome).toBe("copied");
		expect(harness.sessions.map((session) => session.info["id"])).toContain("ses_copy");
		expect(harness.sessions).toHaveLength(2);
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

	test("a parent is imported before its child regardless of payload order", async () => {
		const child = sessionRecord("ses_child", [userMessage("msg_child")], "proj_source", {
			parentID: "ses_parent",
		});
		const parent = sessionRecord("ses_parent", [userMessage("msg_parent")], "proj_source");
		const harness = createHarness({ destination: [], checkpoint: [child, parent], withRemove: true });

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.removeInputs).toHaveLength(0);
		expect(
			harness.client.importInputs.map((input) => (input as { readonly info: { readonly id: string } }).info.id),
		).toEqual(["ses_parent", "ses_child"]);
		expect(harness.previews[0]?.entries.map((entry) => entry.sessionID)).toEqual(["ses_parent", "ses_child"]);
		expect(harness.reports[0]?.entries.map((entry) => entry.outcome)).toEqual(["imported", "imported"]);
		const importedChild = harness.client.importInputs.find(
			(input) => (input as { readonly info: { readonly id: string } }).info.id === "ses_child",
		) as { readonly info: { readonly parentID?: unknown } } | undefined;
		expect(importedChild?.info.parentID).toBe("ses_parent");
	});

	test("an exact-duplicate root is skipped while its child is imported in keep and replace modes", async () => {
		const root = sessionRecord("ses_root", [userMessage("msg_root")], TEST_DEST_PROJECT_ID, { title: "root" });
		const child = sessionRecord("ses_child", [userMessage("msg_child")], TEST_DEST_PROJECT_ID, {
			parentID: "ses_root",
		});
		for (const importMode of ["keep", "replace"] as const) {
			const harness = createHarness({
				destination: [
					sessionRecord("ses_root", [userMessage("msg_root")], TEST_DEST_PROJECT_ID, { title: "root" }),
				],
				checkpoint: [root, child],
				withRemove: true,
				importMode,
			});

			await harness.handlers.restore(ARTIFACT_PATH);

			expect(harness.client.removeInputs).toHaveLength(0);
			expect(
				harness.client.importInputs.map((input) => (input as { readonly info: { readonly id: string } }).info.id),
			).toEqual(["ses_child"]);
			expect(harness.reports[0]?.entries.find((entry) => entry.sessionID === "ses_root")?.outcome).toBe("skipped");
			expect(harness.reports[0]?.entries.find((entry) => entry.sessionID === "ses_child")?.outcome).toBe("imported");
			expect(harness.sessions.map((session) => session.info["id"])).toEqual(["ses_root", "ses_child"]);
		}
	});

	test("the imported child keeps the exact-duplicate root as parentID in keep and replace modes", async () => {
		const root = sessionRecord("ses_root", [userMessage("msg_root")], TEST_DEST_PROJECT_ID, { title: "root" });
		const child = sessionRecord("ses_child", [userMessage("msg_child")], TEST_DEST_PROJECT_ID, {
			parentID: "ses_root",
		});
		for (const importMode of ["keep", "replace"] as const) {
			const harness = createHarness({
				destination: [
					sessionRecord("ses_root", [userMessage("msg_root")], TEST_DEST_PROJECT_ID, { title: "root" }),
				],
				checkpoint: [root, child],
				withRemove: true,
				importMode,
			});

			await harness.handlers.restore(ARTIFACT_PATH);

			expect(harness.client.removeInputs).toHaveLength(0);
			expect(harness.client.importInputs).toHaveLength(1);
			const importedChild = harness.client.importInputs[0] as {
				readonly info: { readonly id: string; readonly parentID?: unknown };
			};
			expect(importedChild.info.id).toBe("ses_child");
			expect(importedChild.info.parentID).toBe("ses_root");
		}
	});

	test("a lineage-current root under a different local ID is kept and its child imports under that ID", async () => {
		const lineage = "ses_lineage_root";
		const root = stampSessionLineage(
			sessionRecord("ses_root", [{ ...userMessage("msg_r1"), text: "shared root" }], "proj_source", {
				title: "Root",
			}),
			lineage,
		);
		const child = sessionRecord("ses_child", [userMessage("msg_c")], "proj_source", {
			parentID: "ses_root",
		});
		const localRoot = stampSessionLineage(
			sessionRecord(
				"ses_local_root",
				[
					{ ...userMessage("msg_l1"), text: "shared root" },
					{ ...userMessage("msg_l2"), text: "newer local branch" },
				],
				TEST_DEST_PROJECT_ID,
				{ title: "Root", time: { created: 1, updated: 999 } },
			),
			lineage,
		);
		const harness = createHarness({
			destination: [localRoot],
			checkpoint: [root, child],
			withRemove: true,
			importMode: "keep",
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		expect(harness.client.removeInputs).toHaveLength(0);
		expect(harness.client.importInputs).toHaveLength(1);
		const importedChild = harness.client.importInputs[0] as {
			readonly info: { readonly id: string; readonly parentID?: unknown };
		};
		expect(importedChild.info.id).toBe("ses_child");
		expect(importedChild.info.parentID).toBe("ses_local_root");
		expect(harness.sessions.map((session) => session.info["id"])).toEqual(["ses_local_root", "ses_child"]);
		expect(harness.reports[0]?.entries.some((entry) => entry.outcome === "skipped")).toBe(true);
	});

	test("a copied child keeps the remapped parent ID in keep mode", async () => {
		const parent = sessionRecord("ses_parent", [userMessage("msg_parent")], TEST_DEST_PROJECT_ID, {
			title: "parent",
		});
		const child = sessionRecord("ses_child", [userMessage("msg_child")], TEST_DEST_PROJECT_ID, {
			parentID: "ses_parent",
		});
		const destination = [
			sessionRecord("ses_parent", [userMessage("msg_local_parent")], TEST_DEST_PROJECT_ID, {
				title: "local parent",
			}),
			sessionRecord("ses_child", [userMessage("msg_local_child")], TEST_DEST_PROJECT_ID, {
				parentID: "ses_parent",
			}),
		];
		const harness = createHarness({
			destination,
			checkpoint: [parent, child],
			withRemove: true,
			importMode: "keep",
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		const renamedParentID = deriveTestId("session", "ses_parent");
		const renamedChildID = deriveTestId("session", "ses_child");
		expect(harness.client.removeInputs).toHaveLength(0);
		expect(
			harness.client.importInputs.map((input) => (input as { readonly info: { readonly id: string } }).info.id),
		).toEqual([renamedParentID, renamedChildID]);
		const importedChild = harness.client.importInputs.find(
			(input) => (input as { readonly info: { readonly id: string } }).info.id === renamedChildID,
		) as { readonly info: { readonly parentID?: unknown } } | undefined;
		expect(importedChild?.info.parentID).toBe(renamedParentID);
		expect(harness.sessions.map((session) => session.info["id"])).toEqual([
			"ses_parent",
			"ses_child",
			renamedParentID,
			renamedChildID,
		]);
	});

	test("a child of a renamed parent imports with the remapped parent target in keep mode", async () => {
		const parent = sessionRecord("ses_parent", [userMessage("msg_parent")], TEST_DEST_PROJECT_ID, {
			title: "parent",
		});
		const child = sessionRecord("ses_child", [userMessage("msg_child")], TEST_DEST_PROJECT_ID, {
			parentID: "ses_parent",
		});
		const destination = [
			sessionRecord("ses_parent", [userMessage("msg_local")], TEST_DEST_PROJECT_ID, { title: "local parent" }),
		];
		const harness = createHarness({
			destination,
			checkpoint: [parent, child],
			withRemove: true,
			importMode: "keep",
		});

		await harness.handlers.restore(ARTIFACT_PATH);

		const renamedParentID = deriveTestId("session", "ses_parent");
		expect(harness.client.removeInputs).toHaveLength(0);
		expect(
			harness.client.importInputs.map((input) => (input as { readonly info: { readonly id: string } }).info.id),
		).toEqual([renamedParentID, "ses_child"]);
		const importedChild = harness.client.importInputs.find(
			(input) => (input as { readonly info: { readonly id: string } }).info.id === "ses_child",
		) as { readonly info: { readonly parentID?: unknown } } | undefined;
		expect(importedChild?.info.parentID).toBe(renamedParentID);
		expect(harness.sessions.map((session) => session.info["id"])).toEqual([
			"ses_parent",
			renamedParentID,
			"ses_child",
		]);
	});

	test("import planning remaps a child to a renamed parent target", () => {
		const parent = sessionRecord("ses_parent", [userMessage("msg_parent")], "proj_source");
		const child = sessionRecord("ses_child", [userMessage("msg_child")], "proj_source", {
			parentID: "ses_parent",
		});
		const destination = [sessionRecord("ses_parent", [userMessage("msg_local")], TEST_DEST_PROJECT_ID)];
		const idDeriver = {
			derive(namespace: "session" | "message", _identity: Uint8Array, originalID: string): string {
				return deriveTestId(namespace, originalID);
			},
		};

		const original = planRestore({
			payload: { sessions: [parent, child] },
			artifactIdentity: ARTIFACT_IDENTITY,
			destination,
			idDeriver,
		});
		expect(original.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_parent", "ses_child"]);

		const rawByID = new Map([parent, child].map((record) => [record.info["id"] as string, record]));
		const prepared = original.importOrder.map((entry) =>
			prepareImportRecord(rawByID.get(entry.sourceSessionID)!, { keepParentID: true }),
		);
		const second = planRestore({
			payload: { sessions: prepared },
			artifactIdentity: ARTIFACT_IDENTITY,
			destination,
			idDeriver,
		});
		const parentEntry = second.importOrder.find((entry) => entry.sourceSessionID === "ses_parent")!;
		const childEntry = second.importOrder.find((entry) => entry.sourceSessionID === "ses_child")!;
		expect(parentEntry.classification).toBe("renamed");
		expect(parentEntry.targetSessionID).toBe(deriveTestId("session", "ses_parent"));
		expect(childEntry.record.info["parentID"]).toBe(parentEntry.targetSessionID);
		expect(second.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_parent", "ses_child"]);
	});

	test("import planning resolves a child to an existing exact-duplicate root", () => {
		const root = sessionRecord("ses_root", [userMessage("msg_root")], TEST_DEST_PROJECT_ID, { title: "root" });
		const child = sessionRecord("ses_child", [userMessage("msg_child")], TEST_DEST_PROJECT_ID, {
			parentID: "ses_root",
		});
		const destination = [
			sessionRecord("ses_root", [userMessage("msg_root")], TEST_DEST_PROJECT_ID, { title: "root" }),
		];
		const idDeriver = {
			derive(namespace: "session" | "message", _identity: Uint8Array, originalID: string): string {
				return deriveTestId(namespace, originalID);
			},
		};

		const original = planRestore({
			payload: { sessions: [root, child] },
			artifactIdentity: ARTIFACT_IDENTITY,
			destination,
			idDeriver,
		});
		const rootEntry = original.entries.find((entry) => entry.sourceSessionID === "ses_root")!;
		expect(rootEntry.skipReason).toBe("exact-local-duplicate");
		expect(original.importOrder.map((entry) => entry.sourceSessionID)).toEqual(["ses_child"]);

		const second = planRestore({
			payload: { sessions: [prepareImportRecord(child, { keepParentID: true })] },
			artifactIdentity: ARTIFACT_IDENTITY,
			destination,
			idDeriver,
		});
		const childEntry = second.importOrder[0]!;
		expect(childEntry.sourceSessionID).toBe("ses_child");
		expect(childEntry.record.info["parentID"]).toBe("ses_root");
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


