/**
 * Shared fake-based test support for the Phase 2 wiring lane.
 *
 * Everything here is synthetic: fake public clients, fake crypto (no Argon2,
 * no secretstream, no sodium), fake artifact I/O, a fake password provider, a
 * fake dialog, and a notification recorder. No real host call, filesystem
 * access, KDF, or import is performed. These are test-only fakes; no production
 * policy value or compatibility claim follows.
 */

import {
	encodeJson,
	type ByteSource,
	type CheckpointCrypto,
	type CheckpointCryptoFactory,
	type CryptoPolicy,
	type JsonObject,
	type JsonValue,
	type SessionRecord,
} from "../../../src/core/contracts/index.ts";
import type { ResolveCheckpointOutputPathOptions } from "../../../src/tui/artifacts/files.ts";
import type { LocationGetCallInput } from "../../../src/tui/adapters/index.ts";
import { CryptoContainerError } from "../../../src/core/crypto/errors.ts";
import type { RestoreProjectChoice } from "../../../src/tui/ui/restore-project-selector.ts";
import type { RestoreReportPresentationModel } from "../../../src/tui/ui/restore-report-flow.ts";
import {
	createSessionPortHandlers,
	type SessionPortHandlerDependencies,
	type SessionPortNotification,
	type SessionPortPasswordProvider,
} from "../../../src/tui/wiring/index.ts";
import type { SessionPortCommandHandlers } from "../../../src/tui/ui/sessionport-commands.tsx";

/* ------------------------------------------------------------------ */
/* Synthetic session records                                           */
/* ------------------------------------------------------------------ */

export function userMessage(id: string): JsonObject {
	return { id, type: "user", text: `text ${id}`, time: { created: 1 } };
}

/**
 * One settled assistant message with the pinned v2.0.22 required fields
 * (`time.completed`, `agent`, `model`, `content`) and optional cost/tokens;
 * synthetic values only.
 */
export function assistantMessage(id: string): JsonObject {
	return {
		id,
		type: "assistant",
		time: { created: 1, completed: 2 },
		agent: "build",
		model: { id: "test-model", providerID: "test-provider" },
		content: [{ type: "text", text: `text ${id}` }],
		finish: "stop",
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
	};
}

/**
 * One synthetic session record whose `info` carries the pinned v2.0.22
 * `SessionInfo` required fields (`projectID`, `cost`, `tokens`, `time`,
 * `location`); no production data is represented.
 */
export function sessionRecord(
	id: string,
	messages: readonly JsonObject[] = [],
	projectID = "proj_active",
	infoExtra: Readonly<Record<string, JsonValue>> = {},
): SessionRecord {
	return {
		info: {
			id,
			projectID,
			title: `title ${id}`,
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
			time: { created: 1, updated: 2 },
			location: { directory: "C:/work/project" },
			...infoExtra,
		},
		messages,
	};
}

/**
 * Deterministic test-only derived ID in the selected O-22 shape: `ses_`/`msg_`
 * plus 64 lowercase hex characters. Synthetic derivation only; it makes no
 * production derivation or collision claim.
 */
export function deriveTestId(namespace: "session" | "message", originalID: string): string {
	const prefix = namespace === "session" ? "ses_" : "msg_";
	const digest = `${namespace}:${originalID}`
		.split("")
		.map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
		.join("")
		.padEnd(64, "0")
		.slice(0, 64);
	return prefix + digest;
}

/* ------------------------------------------------------------------ */
/* Fake public client                                                  */
/* ------------------------------------------------------------------ */

export interface FakeClientOptions {
	/** When false, `session.import` is present but not callable (O-12 absence). */
	readonly withImport?: boolean;
	readonly locationGet?: (input: LocationGetCallInput) => Promise<unknown>;
	readonly projects?: () => Promise<unknown>;
	readonly sessions?: readonly SessionRecord[];
	/** Overrides the default project-filtered `session.list` response; inputs are still recorded. */
	readonly sessionList?: (input: {
		readonly project: string;
		readonly limit: number;
		readonly cursor?: string;
	}) => Promise<unknown>;
	/** Overrides the import response; the default derives a well-formed response from the request. */
	readonly importSession?: (input: unknown) => Promise<unknown>;
}

export interface FakeClientHandle {
	readonly client: unknown;
	readonly locationGetInputs: LocationGetCallInput[];
	readonly projectListCalls: number;
	readonly sessionListInputs: Array<{ readonly project: string; readonly limit: number; readonly cursor?: string }>;
	readonly messageListInputs: Array<{
		readonly sessionID: string;
		readonly limit: number;
		readonly order?: "asc";
		readonly cursor?: string;
	}>;
	readonly importInputs: unknown[];
	/** Times `client.session.import` was read (the capability probe is the first read). */
	readonly sessionImportGetterReads: number;
}

/** One well-formed `location.get` response. */
export function locationResponse(directory: string, projectID: string): unknown {
	return { directory, project: { id: projectID, directory, canonical: directory } };
}

/** Fixture target project ID for fake import responses; the adapter enforces no project-ID equality. */
export const TEST_IMPORT_PROJECT_ID = "proj_imported";

/**
 * One well-formed `session.import` response derived from the request payload:
 * the request's session ID, a nonblank fixture project ID, and the explicit
 * target directory. Malformed responses belong only in the negative test.
 */
export function sessionImportResponse(input: unknown): unknown {
	const call = input as { readonly info: { readonly id: string }; readonly location: { readonly directory: string } };
	return { id: call.info.id, projectID: TEST_IMPORT_PROJECT_ID, location: { directory: call.location.directory } };
}

export function createFakeClient(options: FakeClientOptions = {}): FakeClientHandle {
	const sessions = options.sessions ?? [];
	const locationGetInputs: LocationGetCallInput[] = [];
	const sessionListInputs: FakeClientHandle["sessionListInputs"] = [];
	const messageListInputs: FakeClientHandle["messageListInputs"] = [];
	const importInputs: unknown[] = [];
	let projectListCalls = 0;
	let sessionImportGetterReads = 0;

	const session: Record<string, unknown> = {
		async list(input: { project: string; limit: number; cursor?: string }): Promise<unknown> {
			sessionListInputs.push({ ...input });
			if (options.sessionList !== undefined) return options.sessionList(input);
			return {
				data: sessions.filter((record) => record.info["projectID"] === input.project).map((record) => record.info),
				cursor: null,
			};
		},
	};
	Object.defineProperty(session, "import", {
		enumerable: true,
		configurable: true,
		get() {
			sessionImportGetterReads += 1;
			if (options.withImport === false) return undefined;
			return async (input: unknown): Promise<unknown> => {
				importInputs.push(input);
				if (options.importSession !== undefined) return options.importSession(input);
				return sessionImportResponse(input);
			};
		},
	});

	const message = {
		async list(input: { sessionID: string; limit: number; order?: "asc"; cursor?: string }): Promise<unknown> {
			messageListInputs.push({ ...input });
			const record = sessions.find((candidate) => candidate.info["id"] === input.sessionID);
			if (record === undefined) throw new Error(`fake client has no session ${input.sessionID}`);
			return { data: [...record.messages], cursor: null };
		},
	};

	const location = {
		async get(input: LocationGetCallInput): Promise<unknown> {
			locationGetInputs.push({ location: { directory: input.location.directory } });
			if (options.locationGet !== undefined) return options.locationGet(input);
			return locationResponse(input.location.directory, "proj_resolved");
		},
	};

	const project = {
		async list(): Promise<unknown> {
			projectListCalls += 1;
			if (options.projects !== undefined) return options.projects();
			return [];
		},
	};

	return {
		client: { session, message, location, project },
		locationGetInputs,
		get projectListCalls(): number {
			return projectListCalls;
		},
		sessionListInputs,
		messageListInputs,
		importInputs,
		get sessionImportGetterReads(): number {
			return sessionImportGetterReads;
		},
	};
}

/* ------------------------------------------------------------------ */
/* Fake crypto factory                                                 */
/* ------------------------------------------------------------------ */

export interface FakeCryptoOptions {
	readonly sealChunks?: readonly Uint8Array[];
	readonly authenticatedBytes?: Uint8Array;
	/** Per-call errors by 1-based call index; missing/undefined entries succeed. */
	readonly openAndStageErrors?: readonly (Error | undefined)[];
}

export interface FakeCryptoHandle {
	readonly factory: CheckpointCryptoFactory;
	readonly createPolicies: CryptoPolicy[];
	readonly sealPasswords: Uint8Array[];
	readonly openAndStagePasswords: Uint8Array[];
	readonly openAndStageCalls: number;
	/** Total chunks the fake `openAndStage` consumed from the artifact source. */
	readonly artifactChunkIterations: number;
}

/** Synthetic crypto error with a stable code; no real crypto is involved. */
export function fakeCryptoError(
	code: "authentication-failed" | "truncated-artifact" | "invalid-header" | "gzip-error",
	message = "synthetic crypto failure",
): CryptoContainerError {
	return new CryptoContainerError(code, message);
}

export function createFakeCryptoFactory(options: FakeCryptoOptions = {}): FakeCryptoHandle {
	const createPolicies: CryptoPolicy[] = [];
	const sealPasswords: Uint8Array[] = [];
	const openAndStagePasswords: Uint8Array[] = [];
	let openAndStageCalls = 0;
	let artifactChunkIterations = 0;
	const sealChunks = options.sealChunks ?? [Uint8Array.of(1, 2, 3), Uint8Array.of(4)];

	const crypto: CheckpointCrypto = {
		async seal(plaintext, password) {
			sealPasswords.push(password);
			return (async function* fakeSeal() {
				for await (const _chunk of plaintext) {
					// Consume the serialized payload so the flow can complete.
				}
				for (const chunk of sealChunks) yield chunk;
			})();
		},
		async openAndStage(artifact, password) {
			openAndStageCalls += 1;
			openAndStagePasswords.push(password);
			for await (const _chunk of artifact) artifactChunkIterations += 1;
			const configured = options.openAndStageErrors?.[openAndStageCalls - 1];
			if (configured !== undefined) throw configured;
			return {
				bytes: options.authenticatedBytes ?? encodeJson({ sessions: [] }),
				artifactIdentity: Uint8Array.from({ length: 16 }, (_, index) => index + 1),
			};
		},
	};

	const factory: CheckpointCryptoFactory = {
		async create(policy) {
			createPolicies.push(policy);
			return crypto;
		},
	};

	return {
		factory,
		createPolicies,
		sealPasswords,
		openAndStagePasswords,
		get openAndStageCalls(): number {
			return openAndStageCalls;
		},
		get artifactChunkIterations(): number {
			return artifactChunkIterations;
		},
	};
}

/* ------------------------------------------------------------------ */
/* Fake artifact I/O                                                   */
/* ------------------------------------------------------------------ */

export interface FakeArtifactIoOptions {
	readonly outputPath?: string;
	readonly resolveError?: Error;
	readonly writeError?: Error;
	readonly writeBytes?: number;
}

export interface FakeArtifactIoHandle {
	readonly resolveCheckpointOutputPath: (options: ResolveCheckpointOutputPathOptions) => Promise<string>;
	readonly writeEncryptedArtifact: (targetPath: string, source: ByteSource) => Promise<number>;
	readonly readEncryptedArtifact: (targetPath: string) => ByteSource;
	readonly resolveCalls: ResolveCheckpointOutputPathOptions[];
	readonly writeCalls: Array<{ readonly path: string; readonly bytes: number }>;
	readonly readCalls: string[];
	/** Generator bodies started; proves whether any lazy artifact read actually happened. */
	readonly artifactIterations: number;
}

export function createFakeArtifactIo(options: FakeArtifactIoOptions = {}): FakeArtifactIoHandle {
	const resolveCalls: ResolveCheckpointOutputPathOptions[] = [];
	const writeCalls: FakeArtifactIoHandle["writeCalls"] = [];
	const readCalls: string[] = [];
	let artifactIterations = 0;

	return {
		async resolveCheckpointOutputPath(input) {
			resolveCalls.push({ ...input });
			if (options.resolveError !== undefined) throw options.resolveError;
			return options.outputPath ?? "C:/work/active/.sessionport/checkpoint-test.sessionport";
		},
		async writeEncryptedArtifact(targetPath, source) {
			let bytes = 0;
			for await (const chunk of source) bytes += chunk.byteLength;
			if (options.writeError !== undefined) throw options.writeError;
			writeCalls.push({ path: targetPath, bytes });
			return options.writeBytes ?? bytes;
		},
		readEncryptedArtifact(targetPath) {
			readCalls.push(targetPath);
			return (async function* fakeArtifact() {
				artifactIterations += 1;
				yield Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
			})();
		},
		resolveCalls,
		writeCalls,
		readCalls,
		get artifactIterations(): number {
			return artifactIterations;
		},
	};
}

/* ------------------------------------------------------------------ */
/* Fake password provider / dialog / notifier                          */
/* ------------------------------------------------------------------ */

export interface FakePasswordOptions {
	/** Result when no per-call list is given. */
	readonly result?: Uint8Array | "cancel";
	/** Per-call results; missing entries fall back to `result`. */
	readonly results?: ReadonlyArray<Uint8Array | "cancel">;
}

export interface FakePasswordHandle {
	readonly provider: SessionPortPasswordProvider;
	readonly calls: Array<{ readonly mode: "checkpoint" | "restore"; readonly maxPasswordBytes: number }>;
}

export function createFakePasswordProvider(options: FakePasswordOptions = {}): FakePasswordHandle {
	const calls: FakePasswordHandle["calls"] = [];
	const provider: SessionPortPasswordProvider = async (mode, maxPasswordBytes) => {
		calls.push({ mode, maxPasswordBytes });
		const configured = options.results?.[calls.length - 1] ?? options.result;
		if (configured === "cancel") return undefined;
		return configured ?? new Uint8Array([1, 2, 3, 4]);
	};
	return { provider, calls };
}

export interface FakeDialogOptions {
	/** "first" selects the first option; "cancel" returns undefined; a choice is returned as-is. */
	readonly select?: "first" | "cancel" | RestoreProjectChoice;
}

export interface FakeDialogHandle {
	readonly dialog: { select<Value>(options: { readonly options: readonly { readonly value: Value }[] }): Promise<Value | undefined> };
	readonly selectCalls: Array<{ readonly title: string; readonly optionCount: number }>;
}

export function createFakeDialog(options: FakeDialogOptions = {}): FakeDialogHandle {
	const selectCalls: FakeDialogHandle["selectCalls"] = [];
	return {
		dialog: {
			async select<Value>(input: { readonly title: string; readonly options: readonly { readonly value: Value }[] }) {
				selectCalls.push({ title: input.title, optionCount: input.options.length });
				const mode = options.select ?? "first";
				if (mode === "cancel") return undefined;
				if (mode === "first") return input.options[0]?.value;
				return mode as Value;
			},
		},
		selectCalls,
	};
}

/* ------------------------------------------------------------------ */
/* Fake restore report presenter                                       */
/* ------------------------------------------------------------------ */

export interface FakeRestoreReportOptions {
	/** When present, `showRestoreReport` records the model and then throws this value. */
	readonly showError?: unknown;
}

export interface FakeRestoreReportHandle {
	readonly showRestoreReport: (model: RestoreReportPresentationModel) => void;
	/** Models passed to the presenter, in call order. */
	readonly models: RestoreReportPresentationModel[];
}

/** Records the presentation models the wiring passes to the report dialog. */
export function createFakeRestoreReport(options: FakeRestoreReportOptions = {}): FakeRestoreReportHandle {
	const models: RestoreReportPresentationModel[] = [];
	return {
		showRestoreReport(model) {
			models.push(model);
			if (options.showError !== undefined) throw options.showError;
		},
		models,
	};
}

/* ------------------------------------------------------------------ */
/* Full handler harness                                                */
/* ------------------------------------------------------------------ */

export const TEST_ACTIVE_DIRECTORY = "C:/work/active";
export const TEST_DEST_DIRECTORY = "C:/work/dest";
export const TEST_DEST_PROJECT_ID = "proj_dest";

export interface WiringHarnessOptions {
	readonly activeDirectory?: string | undefined;
	readonly client?: FakeClientOptions;
	readonly crypto?: FakeCryptoOptions;
	readonly artifacts?: FakeArtifactIoOptions;
	readonly password?: FakePasswordOptions;
	readonly dialog?: FakeDialogOptions;
	readonly report?: FakeRestoreReportOptions;
}

export interface WiringHarness {
	readonly handlers: SessionPortCommandHandlers;
	readonly dependencies: SessionPortHandlerDependencies;
	readonly client: FakeClientHandle;
	readonly crypto: FakeCryptoHandle;
	readonly artifacts: FakeArtifactIoHandle;
	readonly password: FakePasswordHandle;
	readonly dialog: FakeDialogHandle;
	readonly report: FakeRestoreReportHandle;
	readonly notifications: SessionPortNotification[];
}

/** Builds fully injected handlers over fake clients/crypto/artifact I/O. */
export function createWiringHarness(options: WiringHarnessOptions = {}): WiringHarness {
	const activeDirectory = "activeDirectory" in options ? options.activeDirectory : TEST_ACTIVE_DIRECTORY;
	const client = createFakeClient({
		locationGet: async (input) => {
			if (input.location.directory === activeDirectory) {
				return locationResponse(input.location.directory, "proj_active");
			}
			if (input.location.directory === TEST_DEST_DIRECTORY) {
				return locationResponse(input.location.directory, TEST_DEST_PROJECT_ID);
			}
			return locationResponse(input.location.directory, "proj_resolved");
		},
		...options.client,
	});
	const crypto = createFakeCryptoFactory(options.crypto);
	const artifacts = createFakeArtifactIo(options.artifacts);
	const password = createFakePasswordProvider(options.password);
	const dialog = createFakeDialog(options.dialog);
	const report = createFakeRestoreReport(options.report);
	const notifications: SessionPortNotification[] = [];

	const dependencies: SessionPortHandlerDependencies = {
		client: client.client,
		getActiveDirectory: () => activeDirectory,
		dialog: dialog.dialog,
		notify: (notification) => {
			notifications.push(notification);
		},
		showRestoreReport: report.showRestoreReport,
		requestPassword: password.provider,
		cryptoFactory: crypto.factory,
		idDeriver: {
			derive(namespace, _artifactIdentity, originalID) {
				return deriveTestId(namespace, originalID);
			},
		},
		resolveCheckpointOutputPath: artifacts.resolveCheckpointOutputPath,
		writeEncryptedArtifact: artifacts.writeEncryptedArtifact,
		readEncryptedArtifact: artifacts.readEncryptedArtifact,
	};

	return {
		handlers: createSessionPortHandlers(dependencies),
		dependencies,
		client,
		crypto,
		artifacts,
		password,
		dialog,
		report,
		notifications,
	};
}
