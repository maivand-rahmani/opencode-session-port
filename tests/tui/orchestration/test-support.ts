/**
 * Shared test-only fakes for the Phase 4 orchestration lane (`fix-57`).
 *
 * Everything here is synthetic: fake session ports, fake public clients, fake
 * crypto factories (no Argon2, no secretstream, no sodium), fake IDs, and a
 * fake deterministic deriver. No real host call, filesystem access, KDF, or
 * import is performed. Policy values are clearly test-only and select no
 * production numeric policy, format, or cap (O-01/O-02/O-03 stay OPEN).
 */

import {
	encodeJson,
	type ArtifactIdentity,
	type AuthenticatedPayload,
	type ByteSource,
	type CheckpointCrypto,
	type CheckpointCryptoFactory,
	type CryptoPolicy,
	type JsonObject,
	type JsonValue,
	type SessionRecord,
} from "../../../src/core/contracts/index.ts";
import type {
	MessageListPageRequest,
	SessionCollectionPolicy,
	SessionDependencyReadPort,
	SessionListPageRequest,
} from "../../../src/core/sessions/index.ts";
import type { RemappedIdDeriver } from "../../../src/core/restore/index.ts";

/* ------------------------------------------------------------------ */
/* Event log                                                           */
/* ------------------------------------------------------------------ */

export interface EventLog {
	readonly events: string[];
	record(event: string): void;
}

export function createEventLog(): EventLog {
	const events: string[] = [];
	return {
		events,
		record(event) {
			events.push(event);
		},
	};
}

/* ------------------------------------------------------------------ */
/* Test-only policy values                                             */
/* ------------------------------------------------------------------ */

/** Synthetic collection bounds only; no production cap is chosen (O-03 OPEN). */
export const TEST_COLLECTION_POLICY: SessionCollectionPolicy = {
	sessionPageSize: 10,
	messagePageSize: 10,
	maxSessions: 5,
	maxMessagesPerSession: 5,
	maxTotalMessages: 20,
};

/** Test-only policy id; the fake factory accepts it and no production profile exists (O-01 OPEN). */
export const TEST_CRYPTO_POLICY: CryptoPolicy = { id: "test-only-no-production-profile" };

/** Synthetic 16-byte artifact identity; not derived from any real artifact. */
export const TEST_ARTIFACT_IDENTITY: ArtifactIdentity = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

/* ------------------------------------------------------------------ */
/* Synthetic session records and fake read port                        */
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
	projectID = "proj_test",
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
 * Single-page fake `SessionDependencyReadPort`; messages and `getSession`
 * resolve from the supplied seed records plus optional external dependency
 * records (referenced sessions outside the seed project). `getSession`
 * returns the record's `info` object directly (the pinned public client
 * already unwraps the protocol envelope) and throws a synthetic host-style
 * error for an unknown ID; the seed-list collection itself never reads a
 * dependency.
 */
export function createFakeSessionPort(
	sessions: readonly SessionRecord[],
	events?: EventLog,
	dependencySessions: readonly SessionRecord[] = [],
): SessionDependencyReadPort {
	const allSessions = [...sessions, ...dependencySessions];
	return {
		async listSessions(_request: SessionListPageRequest): Promise<unknown> {
			events?.record("collect:sessions");
			return { data: sessions.map((session) => session.info), cursor: null };
		},
		async listMessages(request: MessageListPageRequest): Promise<unknown> {
			events?.record("collect:messages");
			const record = allSessions.find((session) => session.info["id"] === request.sessionID);
			if (record === undefined) throw new Error(`fake port has no session ${request.sessionID}`);
			return { data: [...record.messages], cursor: null };
		},
		async getSession(sessionID: string): Promise<unknown> {
			events?.record(`collect:get:${sessionID}`);
			const record = allSessions.find((session) => session.info["id"] === sessionID);
			if (record === undefined) {
				throw Object.assign(new Error(`fake port has no session ${sessionID}`), { name: "HostApiError", status: 404 });
			}
			return { ...record.info };
		},
	};
}

/* ------------------------------------------------------------------ */
/* Fake crypto factory (no real crypto)                                */
/* ------------------------------------------------------------------ */

export interface FakeCryptoFactoryOptions {
	readonly sealChunks?: readonly Uint8Array[];
	readonly seal?: (plaintext: ByteSource, password: Uint8Array) => Promise<ByteSource>;
	readonly authenticatedBytes?: Uint8Array;
	readonly artifactIdentity?: ArtifactIdentity;
	readonly openAndStage?: (artifact: ByteSource, password: Uint8Array) => Promise<AuthenticatedPayload>;
}

export interface FakeCryptoFactoryHandle {
	readonly factory: CheckpointCryptoFactory;
	readonly createPolicies: CryptoPolicy[];
	readonly sealPasswords: Uint8Array[];
	/** Recorded when the sealed source is iterated: whether the password was still non-zero. */
	readonly sealIterations: Array<{ readonly passwordIntact: boolean; readonly plaintextText: string }>;
	readonly openAndStagePasswords: Uint8Array[];
	/** Total ciphertext bytes the fake `openAndStage` consumed from the artifact source. */
	readonly authenticatedArtifactBytes: number;
}

/**
 * Fake `CheckpointCryptoFactory`. `seal` is a lazy async generator that only
 * records/consumes the plaintext when the consumer iterates, mirroring the
 * real container's lazy KDF/framing behavior; `openAndStage` consumes the
 * artifact source and returns configured authenticated bytes.
 */
export function createFakeCryptoFactory(
	options: FakeCryptoFactoryOptions = {},
	events: EventLog = createEventLog(),
): FakeCryptoFactoryHandle {
	const createPolicies: CryptoPolicy[] = [];
	const sealPasswords: Uint8Array[] = [];
	const sealIterations: Array<{ passwordIntact: boolean; plaintextText: string }> = [];
	const openAndStagePasswords: Uint8Array[] = [];
	let authenticatedArtifactBytes = 0;
	const sealChunks = options.sealChunks ?? [Uint8Array.of(10, 20, 30), Uint8Array.of(40, 50)];

	const crypto: CheckpointCrypto = {
		async seal(plaintext, password) {
			events.record("crypto:seal");
			sealPasswords.push(password);
			if (options.seal !== undefined) return options.seal(plaintext, password);
			return (async function* fakeSeal() {
				events.record("crypto:seal-iterate");
				const decoder = new TextDecoder();
				let text = "";
				for await (const chunk of plaintext) text += decoder.decode(chunk, { stream: true });
				text += decoder.decode();
				sealIterations.push({ passwordIntact: password.some((byte) => byte !== 0), plaintextText: text });
				for (const chunk of sealChunks) yield chunk;
			})();
		},
		async openAndStage(artifact, password) {
			events.record("crypto:openAndStage");
			openAndStagePasswords.push(password);
			if (options.openAndStage !== undefined) return options.openAndStage(artifact, password);
			let total = 0;
			for await (const chunk of artifact) total += chunk.byteLength;
			authenticatedArtifactBytes += total;
			return {
				bytes: options.authenticatedBytes ?? encodeJson({ sessions: [] }),
				artifactIdentity: options.artifactIdentity ?? TEST_ARTIFACT_IDENTITY,
			};
		},
	};

	const factory: CheckpointCryptoFactory = {
		async create(policy) {
			events.record("crypto:create");
			createPolicies.push(policy);
			return crypto;
		},
	};

	return {
		factory,
		createPolicies,
		sealPasswords,
		sealIterations,
		openAndStagePasswords,
		get authenticatedArtifactBytes(): number {
			return authenticatedArtifactBytes;
		},
	};
}

/* ------------------------------------------------------------------ */
/* Fake public client (capability probe / never-invoked import spy)    */
/* ------------------------------------------------------------------ */

export interface FakePublicClientOptions {
	/** When false, `session.import` is present but not callable (O-12 absence). */
	readonly withImport?: boolean;
}

export interface FakePublicClientHandle {
	readonly client: unknown;
	readonly importCalls: unknown[];
	/** True once any code inspected `client.session` (the capability probe is the first). */
	probeObserved(): boolean;
}

/** Fixture target project ID for fake import responses; the adapter enforces no project-ID equality. */
export const TEST_IMPORT_PROJECT_ID = "proj_imported";

/**
 * One well-formed `session.import` response derived from the request payload:
 * the request's session ID, a nonblank fixture project ID, and the explicit
 * target directory. This matches the adapter's response-validation contract.
 */
export function sessionImportResponse(input: unknown): unknown {
	const call = input as { readonly info: { readonly id: string }; readonly location: { readonly directory: string } };
	return { id: call.info.id, projectID: TEST_IMPORT_PROJECT_ID, location: { directory: call.location.directory } };
}

/**
 * Fake public TUI client. `session.import` is a getter so tests can observe
 * exactly when the capability probe touched the client, and any actual import
 * invocation is recorded in `importCalls` (expected to stay empty: this lane
 * never imports). A well-formed derived response is returned if it ever is
 * invoked, matching the adapter's response-validation contract.
 */
export function createFakePublicClient(options: FakePublicClientOptions = {}): FakePublicClientHandle {
	const importCalls: unknown[] = [];
	let observed = false;
	const session: Record<string, unknown> = {};
	Object.defineProperty(session, "import", {
		enumerable: true,
		configurable: true,
		get() {
			observed = true;
			if (options.withImport === false) return undefined;
			return async (input: unknown) => {
				importCalls.push(input);
				return sessionImportResponse(input);
			};
		},
	});
	return {
		client: { session },
		importCalls,
		probeObserved: () => observed,
	};
}

/* ------------------------------------------------------------------ */
/* Fake deterministic ID deriver                                       */
/* ------------------------------------------------------------------ */

function toHex(value: string): string {
	let out = "";
	for (const byte of new TextEncoder().encode(value)) out += byte.toString(16).padStart(2, "0");
	return out;
}

/** Deterministic test deriver with valid `ses_`/`msg_` + 64 lowercase hex outputs. */
export function createFakeIdDeriver(): RemappedIdDeriver {
	return {
		derive(namespace, _artifactIdentity, originalID) {
			const prefix = namespace === "session" ? "ses_" : "msg_";
			const digest = toHex(`${namespace}:${originalID}`).padEnd(64, "0").slice(0, 64);
			return prefix + digest;
		},
	};
}
