/**
 * Bounded local-release live proof for the local-first 0.1.7 restore path.
 *
 * This entry runs inside the retained stock OpenCode 2.1.3 image with no
 * network. It starts one isolated `opencode serve` on loopback using the
 * existing synthetic-profile lifecycle shape, drives the ACTUAL production
 * `runLocalRestore` orchestration with the real experimental crypto factory,
 * real artifact I/O, real adapters, and the real replacement executor, and
 * reports structural checks only.
 *
 * The host client below is a public-API HTTP bridge because this checkout's
 * installed `@opencode/plugin@2.0.22` does not export a constructible
 * OpenCodeClient and the image exposes no TUI context. This is explicitly
 * NOT a packaged-TUI or actual-SDK claim; it is a public-host-API proof.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { posix } from "node:path";
import { encodeJson, type ByteSource, type SessionRecord } from "../../../src/core/contracts/index.ts";
import { createCheckpointCryptoFactory } from "../../../src/core/crypto/index.ts";
import { createRemappedIdDeriver, type RemappedIdDeriver } from "../../../src/core/restore/index.ts";
import { collectCheckpointPayload, type SessionCollectionPolicy } from "../../../src/core/sessions/index.ts";
import { collectSessionMessages } from "../../../src/core/sessions/collector.ts";
import {
	createSessionDependencyReadAdapter,
	createSessionIdInventory,
	createSessionImportAdapter,
	createSessionReadAdapter,
	createSessionReferenceInventoryPort,
	probeSessionDeleteCapability,
} from "../../../src/tui/adapters/index.ts";
import {
	createReplacementDeletePortFactory,
	createReplacementReferenceInventoryReader,
} from "../../../src/tui/orchestration/newreplacement-execution.ts";
import {
	readEncryptedArtifact,
	resolveRecoveryArtifactPath,
	writeEncryptedArtifact,
} from "../../../src/tui/artifacts/files.ts";
import { runLocalRestore, type LocalRestoreUiPort } from "../../../src/tui/orchestration/local-restore.ts";
import {
	EXPERIMENTAL_COLLECTION_POLICY,
	EXPERIMENTAL_CRYPTO_POLICY,
	EXPERIMENTAL_CRYPTO_POLICY_DEFINITION,
} from "../../../src/tui/wiring/experimental-profile.ts";

const IMAGE_VERSION = "2.1.3";
const HOST = "127.0.0.1";
const PORT = 4096;
const BASE_URL = `http://${HOST}:${PORT}`;
const PROFILE_ROOT = "/run/sessionport";
const OPENCODE_BINARY = "/usr/local/bin/opencode";
const NODE_BINARY = "/usr/local/bin/node";
const SENTINEL = "LOCAL_RELEASE_SENTINEL_20261025";
const MAX_BODY = 1_048_576;

interface SessionPage {
	readonly data: readonly JsonRecord[];
	readonly cursor?: { readonly next?: string | null };
}
type JsonRecord = Record<string, unknown>;

interface Bridge {
	readonly client: unknown;
	readonly requests: Array<{ readonly method: string; readonly path: string }>;
	readonly importInputs: SessionRecord[];
	readonly removeInputs: string[];
}

class FixedError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "FixedError";
		this.code = code;
	}
}

function fail(code: string): never {
	throw new FixedError(code);
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authHeader(password: string): string {
	return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

async function requestRaw(
	password: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; value: unknown }> {
	const headers: Record<string, string> = { authorization: authHeader(password) };
	if (body !== undefined) headers["content-type"] = "application/json";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const response = await fetch(`${BASE_URL}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal,
			redirect: "error",
		});
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_BODY) fail("E_BODY_CAP");
		if (response.status === 401 || response.status === 403) fail("E_AUTH");
		if (response.status === 404) return { status: 404, value: undefined };
		if (!response.ok) fail("E_HTTP");
		if (bytes.byteLength === 0) return { status: response.status, value: null };
		try {
			return { status: response.status, value: JSON.parse(new TextDecoder().decode(bytes)) };
		} catch {
			fail("E_CONTRACT");
		}
	} finally {
		clearTimeout(timer);
	}
}

function unwrap(value: unknown): unknown {
	return isRecord(value) && "data" in value ? value["data"] : value;
}

function makeClient(password: string, options: { remove?: boolean } = {}): Bridge {
	const requests: Bridge["requests"] = [];
	const importInputs: SessionRecord[] = [];
	const removeInputs: string[] = [];
	const call = async (method: string, path: string, body?: unknown) => {
		requests.push({ method, path: path.split("?")[0]! });
		return requestRaw(password, method, path, body);
	};
	const list = async (input: { project?: string; limit: number; cursor?: string }) => {
		const q = new URLSearchParams();
		if (input.project !== undefined) q.set("project", input.project);
		q.set("limit", String(input.limit));
		if (input.cursor !== undefined) q.set("cursor", input.cursor);
		const r = await call("GET", `/api/session?${q.toString()}`);
		return r.value;
	};
	const session: Record<string, unknown> = {
		list,
		async get(input: { sessionID: string }) {
			const r = await call("GET", `/api/session/${input.sessionID}`);
			if (r.status === 404) {
				throw Object.assign(new Error("not found"), { status: 404 });
			}
			return unwrap(r.value);
		},
		async import(input: unknown) {
			const r = await call("POST", "/api/experimental/session/import", input);
			importInputs.push(input as SessionRecord);
			return unwrap(r.value);
		},
	};
	if (options.remove !== false) {
		session["remove"] = async (input: { sessionID: string }) => {
			removeInputs.push(input.sessionID);
			await call("DELETE", `/api/session/${input.sessionID}`);
			return undefined;
		};
	}
	const message = {
		async list(input: { sessionID: string; limit: number; order?: "asc"; cursor?: string }) {
			const q = new URLSearchParams();
			q.set("limit", String(input.limit));
			if (input.order !== undefined) q.set("order", input.order);
			if (input.cursor !== undefined) q.set("cursor", input.cursor);
			const r = await call("GET", `/api/session/${input.sessionID}/message?${q.toString()}`);
			return r.value;
		},
	};
	const project = {
		async list() {
			const r = await call("GET", "/api/project");
			return unwrap(r.value);
		},
	};
	return { client: { session, message, project }, requests, importInputs, removeInputs };
}

async function waitReady(child: { exitCode: number | null }, password: string): Promise<void> {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (child.exitCode !== null) fail("E_CHILD_EXIT");
		try {
			const info = await requestRaw(password, "GET", "/api/info");
			const value = info.value as JsonRecord;
			if (value["version"] === IMAGE_VERSION) {
				const openapi = await requestRaw(password, "GET", "/openapi.json");
				if (!isRecord(openapi.value) || !isRecord(openapi.value["paths"])) fail("E_OPENAPI");
				return;
			}
		} catch (error) {
			if (error instanceof FixedError && error.code === "E_AUTH") throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	fail("E_READY");
}

function childEnv(profileDir: string, password: string): Record<string, string> {
	return {
		PATH: "/usr/local/bin:/usr/bin:/bin",
		HOME: `${profileDir}/home`,
		XDG_CONFIG_HOME: `${profileDir}/config`,
		XDG_DATA_HOME: `${profileDir}/data`,
		XDG_CACHE_HOME: `${profileDir}/cache`,
		XDG_STATE_HOME: `${profileDir}/state`,
		OPENCODE_CONFIG_DIR: `${profileDir}/opencode-config`,
		OPENCODE_CONFIG_PROJECT_DISABLE: "1",
		OPENCODE_DISABLE_CLAUDE_CODE: "1",
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_PASSWORD: password,
	};
}

async function startHost(profileDir: string, password: string) {
	for (const suffix of ["", "/home", "/config", "/data", "/cache", "/state", "/opencode-config"]) {
		await mkdir(`${profileDir}${suffix}`, { recursive: true, mode: 0o700 });
	}
	const child = spawn(OPENCODE_BINARY, ["serve", "--hostname", HOST, "--port", String(PORT)], {
		cwd: profileDir,
		env: childEnv(profileDir, password),
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	child.stdout?.on("data", () => {});
	child.stderr?.on("data", () => {});
	child.on("error", () => {});
	await waitReady(child, password);
	return child;
}

async function stopHost(child: { kill: (signal: NodeJS.Signals) => boolean; exitCode: number | null }): Promise<boolean> {
	if (child.exitCode !== null) return true;
	return await new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const timer = setTimeout(() => finish(false), 10_000);
		child.once("exit", () => {
			clearTimeout(timer);
			finish(true);
		});
		try {
			child.kill("SIGTERM");
		} catch {
			clearTimeout(timer);
			finish(false);
		}
	});
}

function ids(prefix: "ses" | "msg"): string {
	return `${prefix}_${randomBytes(32).toString("hex")}`;
}

function userMessage(id: string, text: string, created: number): JsonRecord {
	return { id, type: "user", text, time: { created } };
}

function assistantMessage(id: string, text: string, created: number): JsonRecord {
	return {
		id,
		type: "assistant",
		agent: "probe",
		model: { id: "probe-model", providerID: "probe-provider" },
		time: { created, completed: created + 1 },
		content: [{ type: "text", text }],
		finish: "stop",
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
	};
}

function oldRecord(id: string, title: string, messages: JsonRecord[]): SessionRecord {
	return {
		info: {
			id,
			projectID: "probe",
			title,
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
			time: { created: 1, updated: 2 },
			location: { directory: PROFILE_ROOT },
		},
		messages,
	};
}

async function seed(client: Bridge, record: SessionRecord, directory: string): Promise<{ info: JsonRecord; messages: JsonRecord[] }> {
	const session = (client.client as any).session;
	const imported = await session.import({
		info: { ...record.info, location: { directory } },
		messages: record.messages,
		location: { directory },
	});
	if (!isRecord(imported) || typeof imported["id"] !== "string") fail("E_SEED_IMPORT");
	const read = await session.get({ sessionID: imported["id"] });
	if (!isRecord(read)) fail("E_SEED_READ");
	const page = await (client.client as any).message.list({ sessionID: imported["id"], limit: 50, order: "asc" });
	if (!isRecord(page) || !Array.isArray(page["data"])) fail("E_SEED_MESSAGES");
	return { info: read as JsonRecord, messages: page["data"] as JsonRecord[] };
}

async function readMessages(client: Bridge, sessionID: string): Promise<JsonRecord[]> {
	const out: JsonRecord[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 10; page += 1) {
		const input: { sessionID: string; limit: number; order?: "asc"; cursor?: string } = {
			sessionID,
			limit: 2,
			...(cursor === undefined ? { order: "asc" as const } : { cursor }),
		};
		const result = (await (client.client as any).message.list(input)) as SessionPage;
		if (!isRecord(result) || !Array.isArray(result.data)) fail("E_MESSAGE_PAGE");
		out.push(...(result.data as JsonRecord[]));
		const next = isRecord(result.cursor) && typeof result.cursor.next === "string" ? result.cursor.next : undefined;
		if (next === undefined) break;
		cursor = next;
	}
	return out;
}

function textOf(messages: readonly JsonRecord[]): string {
	return messages
		.map((message) => (typeof message["text"] === "string" ? message["text"] : ""))
		.join("\n");
}

function hasToolMessage(messages: readonly JsonRecord[]): boolean {
	return messages.some((message) => message["type"] === "tool");
}

function checkpointSource(old: { info: JsonRecord; messages: JsonRecord[] }, title: string): SessionRecord {
	const messages = old.messages.slice(0, 2).map((message) => ({ ...message }));
	return {
		info: { ...old.info, title },
		messages,
	};
}

async function writeCheckpoint(
	cryptoFactory: any,
	policy: any,
	path: string,
	password: Uint8Array,
	sessions: readonly SessionRecord[],
): Promise<number> {
	const crypto = await cryptoFactory.create(policy);
	const plaintext = encodeJson({ sessions });
	const source: ByteSource = {
		async *[Symbol.asyncIterator]() {
			yield plaintext;
		},
	};
	const sealed = await crypto.seal(source, password);
	return writeEncryptedArtifact(path, sealed);
}

async function readRecovery(
	cryptoFactory: any,
	policy: any,
	path: string,
	password: Uint8Array,
): Promise<SessionRecord[] | undefined> {
	try {
		const crypto = await cryptoFactory.create(policy);
		const opened = await crypto.openAndStage(readEncryptedArtifact(path), password);
		const parsed = JSON.parse(new TextDecoder().decode(opened.bytes)) as unknown;
		if (!isRecord(parsed) || !Array.isArray(parsed["sessions"])) return undefined;
		return parsed["sessions"] as SessionRecord[];
	} catch {
		return undefined;
	}
}

async function exists(client: Bridge, sessionID: string): Promise<boolean> {
	try {
		await (client.client as any).session.get({ sessionID });
		return true;
	} catch (error) {
		if (isRecord(error) && error["status"] === 404) return false;
		throw error;
	}
}

export async function run(): Promise<JsonRecord> {
	const result: JsonRecord = {
		label: "production-functions-on-public-http-bridge; NOT packaged-TUI; NOT actual-SDK",
		imageVersion: IMAGE_VERSION,
		sdk: { expectedVersion: "2.0.22", constructed: false, reason: "no-exported-client-factory" },
		host: { stockImage: true, tuiContext: "not-available", network: "none" },
		checks: {},
	};
	const checks = result["checks"] as JsonRecord;
	const profileDir = posix.join(PROFILE_ROOT, `run-${randomBytes(8).toString("hex")}`);
	const passwordString = randomBytes(32).toString("base64url");
	const passwordBytes = randomBytes(32);
	const otherDir = posix.join(PROFILE_ROOT, `other-${randomBytes(4).toString("hex")}`);
	let child: Awaited<ReturnType<typeof startHost>> | undefined;
	let stopped = false;
	let profileRemoved = false;
	try {
		const cryptoFactory = await createCheckpointCryptoFactory([EXPERIMENTAL_CRYPTO_POLICY_DEFINITION]);
		const idDeriver: RemappedIdDeriver = await createRemappedIdDeriver();
		child = await startHost(profileDir, passwordString);
		await mkdir(otherDir, { recursive: true, mode: 0o700 });
		const bridge = makeClient(passwordString);
		const session = (bridge.client as any).session;

		checks["sessionRemoveCallable"] = probeSessionDeleteCapability(bridge.client).available === true;
		checks["sessionGetCallable"] = typeof session.get === "function";
		checks["messageListCallable"] = typeof (bridge.client as any).message.list === "function";

		// A second project proves the unfiltered global list really spans projects.
		const otherSeed = await seed(
			bridge,
			oldRecord(ids("ses"), "other project sentinel", [userMessage(ids("msg"), `${SENTINEL} other`, 1)]),
			otherDir,
		);
		const otherProjectID = otherSeed.info["projectID"];
		if (typeof otherProjectID !== "string") fail("E_OTHER_PROJECT");

		// Case 1: 3-message old destination vs 2-message encrypted checkpoint same ID.
		const old1 = await seed(
			bridge,
			oldRecord(ids("ses"), "destination old three", [
				userMessage(ids("msg"), `${SENTINEL} old-one`, 1),
				assistantMessage(ids("msg"), `${SENTINEL} old-two`, 2),
				userMessage(ids("msg"), `${SENTINEL} old-three`, 3),
			]),
			profileDir,
		);
		const destProjectID = old1.info["projectID"];
		if (typeof destProjectID !== "string") fail("E_DEST_PROJECT");
		const old1ID = old1.info["id"] as string;
		const messageCallsBefore = bridge.requests.filter((request) => request.path.includes("/message")).length;
		const old1Baseline = await readMessages(bridge, old1ID);
		const messageCallsAfter = bridge.requests.filter((request) => request.path.includes("/message")).length;
		checks["messageListPaged"] =
			old1Baseline.length === 3 && messageCallsAfter - messageCallsBefore >= 2;
		checks["messageListPageRequests"] = messageCallsAfter - messageCallsBefore;
		const source1 = checkpointSource(old1, "checkpoint source two");
		const checkpointPath1 = posix.join(profileDir, "checkpoint-case1.sessionport");
		await writeCheckpoint(cryptoFactory, EXPERIMENTAL_CRYPTO_POLICY, checkpointPath1, passwordBytes, [source1]);
		const importsBefore1 = bridge.importInputs.length;
		const removesBefore1 = bridge.removeInputs.length;
		const previews1: any[] = [];
		const reports1: any[] = [];
		const ui1: LocalRestoreUiPort = {
			async confirm(preview) {
				previews1.push(preview);
				return true;
			},
			async report(report) {
				reports1.push(report);
			},
		};
		const readPort = createSessionReadAdapter(bridge.client);
		const dependencyPort = createSessionDependencyReadAdapter(bridge.client);
		const referencePort = createSessionReferenceInventoryPort(bridge.client, {
			scope: { kind: "global" },
			policy: { ...EXPERIMENTAL_COLLECTION_POLICY, sessionPageSize: 2 } as SessionCollectionPolicy,
		});
		const globalResult = await referencePort.readIncomingReferences();
		const globalProjects = new Set(
			globalResult.status === "complete"
				? globalResult.entries.map((entry) => entry.projectID)
				: [],
		);
		checks["globalReferenceInventoryComplete"] = globalResult.status === "complete";
		checks["globalReferenceInventoryProjectCount"] = globalProjects.size;
		checks["globalReferenceInventoryIncludesOtherProject"] = globalProjects.has(otherProjectID);
		checks["globalReferenceInventoryIncludesDestination"] = globalProjects.has(destProjectID);
		checks["globalReferenceInventorySessionCount"] = globalResult.status === "complete" ? globalResult.entries.length : 0;
		checks["globalReferenceInventoryUnfiltered"] =
			globalResult.status === "complete" &&
			globalProjects.has(otherProjectID) &&
			globalProjects.has(destProjectID);

		const outcome1 = await runLocalRestore({
			artifactPath: checkpointPath1,
			destinationProjectID: destProjectID,
			targetDirectory: profileDir,
			cryptoFactory,
			cryptoPolicy: EXPERIMENTAL_CRYPTO_POLICY,
			readEncryptedArtifact,
			requestPassword: async () => passwordBytes,
			readDestination: async (projectID) =>
				(await collectCheckpointPayload(readPort, { projectID, policy: EXPERIMENTAL_COLLECTION_POLICY })).sessions,
			readGloballyVisibleSessionIDs: () =>
				createSessionIdInventory({
					readPort,
					projects: [{ projectID: destProjectID }],
					selectedProjectID: destProjectID,
					policy: { ...EXPERIMENTAL_COLLECTION_POLICY, sessionPageSize: 2 },
				}).readGloballyVisibleSessionIDs(),
			readSession: async (sessionID) => {
				const info = await dependencyPort.getSession(sessionID);
				const messages = await collectSessionMessages(dependencyPort, sessionID, EXPERIMENTAL_COLLECTION_POLICY, 0);
				return { info: info as any, messages: [...messages] };
			},
			readReferenceInventory: createReplacementReferenceInventoryReader(referencePort),
			importer: createSessionImportAdapter(bridge.client),
			deletePortFactory: createReplacementDeletePortFactory(bridge.client),
			resolveRecoveryPath: (options) => resolveRecoveryArtifactPath(options),
			writeEncryptedArtifact,
			idDeriver,
			ui: ui1,
			clock: () => Date.now(),
		});
		const imported1 = bridge.importInputs.slice(importsBefore1);
		const candidate1 = imported1[0];
		const candidate1ID = candidate1?.info["id"];
		const candidate1Read = typeof candidate1ID === "string" ? await (bridge.client as any).session.get({ sessionID: candidate1ID }) as JsonRecord : null;
		const candidate1Messages = typeof candidate1ID === "string" ? await readMessages(bridge, candidate1ID) : [];
		const old1Now = await exists(bridge, old1ID);
		const report1 = reports1[0];
		const recoveryPath = report1?.recoveryPath;
		const recovery1 = typeof recoveryPath === "string" ? await readRecovery(cryptoFactory, EXPERIMENTAL_CRYPTO_POLICY, recoveryPath, passwordBytes) : undefined;
		const recoveryOld = recovery1?.find((record) => record.info["id"] === old1ID);
		const recoveryText = recoveryOld !== undefined ? textOf(recoveryOld.messages) : "";
		checks["case1"] = {
			status: outcome1.status,
			previewHasReplace: previews1.some((preview) => preview.entries.some((entry: any) => entry.action === "replace")),
			replacedOutcome: report1?.entries?.some((entry: any) => entry.outcome === "replaced") === true,
			importCount: imported1.length,
			removeCount: bridge.removeInputs.length - removesBefore1,
			candidateIDDifferent: typeof candidate1ID === "string" && candidate1ID !== old1ID,
			candidateParentless: candidate1Read !== null && (candidate1Read["parentID"] === undefined || candidate1Read["parentID"] === null),
			candidateMessageCount: candidate1Messages.length,
			candidateMessageIDsRederived:
				Array.isArray(candidate1?.messages) &&
				candidate1.messages.every((message: any, index: number) => message.id !== source1.messages[index]?.id),
			sentinelPreserved: textOf(candidate1Messages).includes(SENTINEL),
			oldDeleted: old1Now === false,
			candidateSurvives: typeof candidate1ID === "string" ? await exists(bridge, candidate1ID) : false,
			recoveryPathReported: typeof recoveryPath === "string",
			recoveryExists: typeof recoveryPath === "string",
			recoveryAuthenticated: recovery1 !== undefined,
			recoveryOldMessageCount: recoveryOld?.messages.length ?? 0,
			recoveryExactCurrentOld3:
				recoveryOld !== undefined &&
				recoveryOld.messages.length === old1Baseline.length &&
				recoveryOld.messages.every((message, index) => message["id"] === old1Baseline[index]?.["id"]),
			recoverySentinelPreserved: recoveryText.includes(SENTINEL),
			noToolParts: !hasToolMessage(source1.messages) && !hasToolMessage(candidate1Messages) && !hasToolMessage(recoveryOld?.messages ?? []),
		};

		// Case 2: source fork forces copy and no DELETE; old stays byte-identical.
		const old2 = await seed(
			bridge,
			oldRecord(ids("ses"), "destination old fork target", [
				userMessage(ids("msg"), `${SENTINEL} fork-old-one`, 11),
				assistantMessage(ids("msg"), `${SENTINEL} fork-old-two`, 12),
			]),
			profileDir,
		);
		const old2ID = old2.info["id"] as string;
		const parentID = ids("ses");
		const parentMsgID = ids("msg");
		const parentRecord: SessionRecord = {
			info: {
				id: parentID,
				projectID: destProjectID,
				title: "fork parent",
				cost: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
				time: { created: 20, updated: 21 },
				location: { directory: profileDir },
			},
			messages: [userMessage(parentMsgID, `${SENTINEL} fork-parent`, 20)],
		};
		const childRecord: SessionRecord = {
			info: {
				...old2.info,
				title: "source fork child",
				fork: { sessionID: parentID, boundary: { type: "through", messageID: parentMsgID } },
			},
			messages: old2.messages.map((message) => ({ ...message })),
		};
		const checkpointPath2 = posix.join(profileDir, "checkpoint-case2.sessionport");
		await writeCheckpoint(cryptoFactory, EXPERIMENTAL_CRYPTO_POLICY, checkpointPath2, passwordBytes, [parentRecord, childRecord]);
		const importsBefore2 = bridge.importInputs.length;
		const removesBefore2 = bridge.removeInputs.length;
		const previews2: any[] = [];
		const reports2: any[] = [];
		const ui2: LocalRestoreUiPort = { async confirm(preview) { previews2.push(preview); return true; }, async report(report) { reports2.push(report); } };
		const outcome2 = await runLocalRestore({
			artifactPath: checkpointPath2,
			destinationProjectID: destProjectID,
			targetDirectory: profileDir,
			cryptoFactory,
			cryptoPolicy: EXPERIMENTAL_CRYPTO_POLICY,
			readEncryptedArtifact,
			requestPassword: async () => passwordBytes,
			readDestination: async (projectID) => (await collectCheckpointPayload(readPort, { projectID, policy: EXPERIMENTAL_COLLECTION_POLICY })).sessions,
			readGloballyVisibleSessionIDs: () => createSessionIdInventory({ readPort, projects: [{ projectID: destProjectID }], selectedProjectID: destProjectID, policy: EXPERIMENTAL_COLLECTION_POLICY }).readGloballyVisibleSessionIDs(),
			readSession: async (sessionID) => ({ info: await dependencyPort.getSession(sessionID) as any, messages: [...await collectSessionMessages(dependencyPort, sessionID, EXPERIMENTAL_COLLECTION_POLICY, 0)] }),
			readReferenceInventory: createReplacementReferenceInventoryReader(referencePort),
			importer: createSessionImportAdapter(bridge.client),
			deletePortFactory: createReplacementDeletePortFactory(bridge.client),
			resolveRecoveryPath: (options) => resolveRecoveryArtifactPath(options),
			writeEncryptedArtifact,
			idDeriver,
			ui: ui2,
			clock: () => Date.now(),
		});
		const imported2 = bridge.importInputs.slice(importsBefore2);
		const childImport = imported2.find((record) => record.messages.length === 2);
		const old2Now = await exists(bridge, old2ID);
		const old2MessagesNow = old2Now ? await readMessages(bridge, old2ID) : [];
		checks["case2"] = {
			status: outcome2.status,
			copyOutcome: reports2[0]?.entries?.some((entry: any) => entry.outcome === "copied") === true,
			copyReason: reports2[0]?.entries?.find((entry: any) => entry.sessionID === old2ID)?.reason ?? null,
			importCount: imported2.length,
			removeCount: bridge.removeInputs.length - removesBefore2,
			oldPresent: old2Now,
			oldMessagesUnchanged: old2MessagesNow.length === old2.messages.length && old2MessagesNow.every((message, index) => message["id"] === old2.messages[index]?.["id"]),
			candidateParentless: childImport !== undefined && (childImport.info["parentID"] === undefined || childImport.info["parentID"] === null) && childImport.info["fork"] === undefined && childImport.info["revert"] === undefined,
			candidateMessages: childImport?.messages.length ?? 0,
			recoveryWritten: reports2[0]?.recoveryPath !== undefined,
		};

		// Case 3: real PATCH to the old target between preview and delete.
		const old3 = await seed(
			bridge,
			oldRecord(ids("ses"), "destination old late change", [
				userMessage(ids("msg"), `${SENTINEL} late-old-one`, 31),
				assistantMessage(ids("msg"), `${SENTINEL} late-old-two`, 32),
				userMessage(ids("msg"), `${SENTINEL} late-old-three`, 33),
			]),
			profileDir,
		);
		const old3ID = old3.info["id"] as string;
		const source3 = checkpointSource(old3, "checkpoint late source");
		const checkpointPath3 = posix.join(profileDir, "checkpoint-case3.sessionport");
		await writeCheckpoint(cryptoFactory, EXPERIMENTAL_CRYPTO_POLICY, checkpointPath3, passwordBytes, [source3]);
		let patchApplied = false;
		let patchResponse: unknown = null;
		const removesBefore3 = bridge.removeInputs.length;
		const reports3: any[] = [];
		const ui3: LocalRestoreUiPort = {
			async confirm() {
				patchResponse = await requestRaw(passwordString, "PATCH", `/api/session/${old3ID}`, { title: "late changed title" });
				patchApplied = patchResponse.status === 200;
				return true;
			},
			async report(report) { reports3.push(report); },
		};
		const outcome3 = await runLocalRestore({
			artifactPath: checkpointPath3,
			destinationProjectID: destProjectID,
			targetDirectory: profileDir,
			cryptoFactory,
			cryptoPolicy: EXPERIMENTAL_CRYPTO_POLICY,
			readEncryptedArtifact,
			requestPassword: async () => passwordBytes,
			readDestination: async (projectID) => (await collectCheckpointPayload(readPort, { projectID, policy: EXPERIMENTAL_COLLECTION_POLICY })).sessions,
			readGloballyVisibleSessionIDs: () => createSessionIdInventory({ readPort, projects: [{ projectID: destProjectID }], selectedProjectID: destProjectID, policy: EXPERIMENTAL_COLLECTION_POLICY }).readGloballyVisibleSessionIDs(),
			readSession: async (sessionID) => ({ info: await dependencyPort.getSession(sessionID) as any, messages: [...await collectSessionMessages(dependencyPort, sessionID, EXPERIMENTAL_COLLECTION_POLICY, 0)] }),
			readReferenceInventory: createReplacementReferenceInventoryReader(referencePort),
			importer: createSessionImportAdapter(bridge.client),
			deletePortFactory: createReplacementDeletePortFactory(bridge.client),
			resolveRecoveryPath: (options) => resolveRecoveryArtifactPath(options),
			writeEncryptedArtifact,
			idDeriver,
			ui: ui3,
			clock: () => Date.now(),
		});
		const old3Now = await exists(bridge, old3ID);
		const old3Read = old3Now ? await (bridge.client as any).session.get({ sessionID: old3ID }) as JsonRecord : null;
		checks["case3"] = {
			status: outcome3.status,
			patchApplied,
			patchStatus: patchResponse?.status ?? 0,
			removeCount: bridge.removeInputs.length - removesBefore3,
			oldPresent: old3Now,
			oldTitleChanged: old3Read?.["title"] === "late changed title",
			keptOutcome: reports3[0]?.entries?.some((entry: any) => entry.outcome === "kept") === true,
			reason: reports3[0]?.entries?.find((entry: any) => entry.sessionID === old3ID)?.reason ?? null,
		};

		// Case 4: fault injection omits session.remove after actual capability proof.
		const old4 = await seed(
			bridge,
			oldRecord(ids("ses"), "destination old no remove", [
				userMessage(ids("msg"), `${SENTINEL} noremove-old-one`, 41),
				assistantMessage(ids("msg"), `${SENTINEL} noremove-old-two`, 42),
			]),
			profileDir,
		);
		const old4ID = old4.info["id"] as string;
		const source4 = checkpointSource(old4, "checkpoint no remove source");
		const checkpointPath4 = posix.join(profileDir, "checkpoint-case4.sessionport");
		await writeCheckpoint(cryptoFactory, EXPERIMENTAL_CRYPTO_POLICY, checkpointPath4, passwordBytes, [source4]);
		const noRemoveBridge = makeClient(passwordString, { remove: false });
		const removesBefore4 = bridge.removeInputs.length;
		const reports4: any[] = [];
		const previews4: any[] = [];
		const ui4: LocalRestoreUiPort = { async confirm(preview) { previews4.push(preview); return true; }, async report(report) { reports4.push(report); } };
		const outcome4 = await runLocalRestore({
			artifactPath: checkpointPath4,
			destinationProjectID: destProjectID,
			targetDirectory: profileDir,
			cryptoFactory,
			cryptoPolicy: EXPERIMENTAL_CRYPTO_POLICY,
			readEncryptedArtifact,
			requestPassword: async () => passwordBytes,
			readDestination: async (projectID) => (await collectCheckpointPayload(readPort, { projectID, policy: EXPERIMENTAL_COLLECTION_POLICY })).sessions,
			readGloballyVisibleSessionIDs: () => createSessionIdInventory({ readPort, projects: [{ projectID: destProjectID }], selectedProjectID: destProjectID, policy: EXPERIMENTAL_COLLECTION_POLICY }).readGloballyVisibleSessionIDs(),
			readSession: async (sessionID) => ({ info: await dependencyPort.getSession(sessionID) as any, messages: [...await collectSessionMessages(dependencyPort, sessionID, EXPERIMENTAL_COLLECTION_POLICY, 0)] }),
			readReferenceInventory: createReplacementReferenceInventoryReader(referencePort),
			importer: createSessionImportAdapter(bridge.client),
			deletePortFactory: createReplacementDeletePortFactory(noRemoveBridge.client),
			resolveRecoveryPath: (options) => resolveRecoveryArtifactPath(options),
			writeEncryptedArtifact,
			idDeriver,
			ui: ui4,
			clock: () => Date.now(),
		});
		const old4Now = await exists(bridge, old4ID);
		checks["case4"] = {
			status: outcome4.status,
			previewCopy: previews4[0]?.entries?.some((entry: any) => entry.action === "copy") === true,
			copyReason: reports4[0]?.entries?.find((entry: any) => entry.sessionID === old4ID)?.reason ?? null,
			removeCount: bridge.removeInputs.length - removesBefore4,
			oldPresent: old4Now,
			importCount: bridge.importInputs.length > 0,
		};

		checks["noToolExecution"] =
			!bridge.requests.some((request) => /prompt|shell|tool|command/i.test(request.path)) &&
			!hasToolMessage(old1Baseline) &&
			checks["case1"] && (checks["case1"] as JsonRecord)["noToolParts"] === true;
		return result;
	} finally {
		if (child !== undefined) {
			stopped = await stopHost(child);
			if (stopped) {
				try {
					await rm(profileDir, { recursive: true, force: true });
					profileRemoved = true;
				} catch {
					profileRemoved = false;
				}
			}
		}
		checks["cleanup"] = { hostStopped: stopped, profileRemoved };
		passwordBytes.fill(0);
	}
}

function requiredPass(result: JsonRecord): boolean {
	const c = result["checks"];
	if (!isRecord(c)) return false;
	const case1 = c["case1"] as JsonRecord | undefined;
	const case2 = c["case2"] as JsonRecord | undefined;
	const case3 = c["case3"] as JsonRecord | undefined;
	const case4 = c["case4"] as JsonRecord | undefined;
	return (
		c["sessionRemoveCallable"] === true &&
		c["globalReferenceInventoryUnfiltered"] === true &&
		c["sessionGetCallable"] === true &&
		c["messageListCallable"] === true &&
		c["messageListPaged"] === true &&
		c["noToolExecution"] === true &&
		case1?.["status"] === "completed" &&
		case1?.["previewHasReplace"] === true &&
		case1?.["replacedOutcome"] === true &&
		case1?.["removeCount"] === 1 &&
		case1?.["oldDeleted"] === true &&
		case1?.["candidateSurvives"] === true &&
		case1?.["candidateParentless"] === true &&
		case1?.["candidateMessageCount"] === 2 &&
		case1?.["candidateMessageIDsRederived"] === true &&
		case1?.["recoveryAuthenticated"] === true &&
		case1?.["recoveryOldMessageCount"] === 3 &&
		case1?.["recoveryExactCurrentOld3"] === true &&
		case2?.["copyOutcome"] === true &&
		case2?.["removeCount"] === 0 &&
		case2?.["oldPresent"] === true &&
		case2?.["candidateParentless"] === true &&
		case2?.["oldMessagesUnchanged"] === true &&
		case3?.["patchApplied"] === true &&
		case3?.["removeCount"] === 0 &&
		case3?.["oldPresent"] === true &&
		case3?.["keptOutcome"] === true &&
		case4?.["previewCopy"] === true &&
		case4?.["removeCount"] === 0 &&
		case4?.["oldPresent"] === true &&
		(c["cleanup"] as JsonRecord | undefined)?.["hostStopped"] === true &&
		(c["cleanup"] as JsonRecord | undefined)?.["profileRemoved"] === true
	);
}

const result = await run().catch((error) => ({
	status: "failed",
	errorCode: error instanceof FixedError ? error.code : "E_INTERNAL",
	label: "production-functions-on-public-http-bridge; NOT packaged-TUI; NOT actual-SDK",
}));
(result as JsonRecord)["allRequiredCasesPassed"] = requiredPass(result as JsonRecord);
(result as JsonRecord)["status"] = (result as JsonRecord)["status"] === "failed" ? "failed" : (result as JsonRecord)["allRequiredCasesPassed"] ? "ok" : "failed";
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = (result as JsonRecord)["status"] === "ok" ? 0 : 1;
