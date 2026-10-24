/**
 * Encrypted local state / outbox store (SYNC_PROTOCOL.md section 8).
 *
 * Boundaries:
 * - One caller-supplied private absolute directory and one caller-named
 *   snapshot file. The existing cooperative `acquireSessionOwner` lock is
 *   required for the store lifetime; contention fails closed with no stale
 *   recovery or fencing claims, and this module never modifies the lock.
 * - Every committed snapshot is sealed by the mandatory injected codec with a
 *   key from the separate injected provider. Unlock/vault binding is caller
 *   work: a missing key refuses all writes; there is no plaintext fallback and
 *   no access-token reuse.
 * - The snapshot contains operation records whose ciphertext is retained
 *   byte-for-byte. There is no re-seal/retry API: reservation retries only
 *   replace the upload ID, and a missing persisted ciphertext fails closed.
 * - A fetched page and its cursor are committed in one encrypted snapshot.
 *   The apply watermark is separate and advances only after the native apply
 *   result is recorded in a committed snapshot.
 * - Writes go through one unique temporary ciphertext file, fsync, and one
 *   rename. The previous snapshot is retained on a pre-rename failure; a
 *   post-rename failure marks the store fail-closed.
 * - No network, host apply/import, M4 transport, acknowledgement, deletion,
 *   retention, quota, or production crypto policy/namespace is implemented.
 *
 * Durability boundary: this module guarantees coherent state across normal
 * process exit/restart and simulated pre/post-rename failure paths. It does
 * NOT claim power-loss durability; see `atomic.ts` (no directory fsync,
 * unverified Windows rename power-loss behavior). No native bridge, new
 * dependency, or speculative durability rewrite is part of this contract.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
	acquireSessionOwner,
	SessionOwnerError,
	type SessionOwner,
} from "../auth/session-owner.ts";
import { bestEffortZero } from "../../core/crypto/zero.ts";
import {
	AtomicWriteUncertainError,
	writeCiphertextAtomically,
} from "./atomic.ts";
import {
	type AuthenticatedStateCodec,
	type CommitFetchedPageInput,
	type FetchedRevisionInput,
	type LocalOperationInput,
	type NativeApplyState,
	type NativeApplyView,
	type OperationStatus,
	type OperationView,
	OPERATION_STATUSES,
	STATE_FORMAT_VERSION,
	STATE_KEY_BYTES,
	StateStoreError,
	type StateStoreConfig,
	type StateView,
	assertDocumentedTransition,
	isDocumentedTransition,
} from "./types.ts";

const SNAPSHOT_KEYS = [
	"formatVersion",
	"hostScope",
	"cursor",
	"applyWatermark",
	"operations",
	"nativeApply",
] as const;
const OPERATION_KEYS = [
	"operationID",
	"revisionID",
	"parentRevisionID",
	"status",
	"uploadID",
	"ciphertext",
] as const;
const NATIVE_APPLY_KEYS = ["state", "operationID", "revisionID", "payload"] as const;
const LOCK_DIRECTORY_NAME = "session-owner.lock";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface PersistedOperation {
	readonly operationID: string;
	readonly revisionID: string;
	readonly parentRevisionID: string | null;
	readonly status: OperationStatus;
	readonly uploadID: string | null;
	readonly ciphertextBase64: string;
}

interface PersistedNativeApply {
	readonly state: NativeApplyState;
	readonly operationID: string | null;
	readonly revisionID: string | null;
	readonly payloadBase64: string | null;
}

interface PersistedState {
	readonly formatVersion: typeof STATE_FORMAT_VERSION;
	readonly hostScope: string;
	readonly cursor: string | null;
	readonly applyWatermark: string | null;
	readonly operations: readonly PersistedOperation[];
	readonly nativeApply: PersistedNativeApply;
}

interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly birthtimeMs: bigint;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(record);
	return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function requireIdentifier(value: unknown, code: "invalid-input" | "state-corrupt"): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new StateStoreError(code);
	}
	return value;
}

function requireNullableIdentifier(value: unknown, code: "invalid-input" | "state-corrupt"): string | null {
	if (value === null) return null;
	return requireIdentifier(value, code);
}

function isOperationStatus(value: unknown): value is OperationStatus {
	return typeof value === "string" && (OPERATION_STATUSES as readonly string[]).includes(value);
}

function isNativeApplyState(value: unknown): value is NativeApplyState {
	return value === "none" || value === "candidate" || value === "confirmed" || value === "ambiguous";
}

function encodeBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function decodeBase64(value: unknown, allowEmpty: boolean, code: "state-corrupt" | "missing-ciphertext"): Uint8Array {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new StateStoreError(code);
	}
	if (
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		throw new StateStoreError(code);
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) throw new StateStoreError(code);
	return new Uint8Array(decoded);
}

function identityFrom(stats: {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly birthtimeMs: bigint;
}): FileIdentity {
	return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs };
}

function sameIdentity(
	expected: FileIdentity,
	actual: { readonly dev: bigint; readonly ino: bigint; readonly birthtimeMs: bigint },
): boolean {
	return (
		actual.ino !== 0n &&
		expected.dev === actual.dev &&
		expected.ino === actual.ino &&
		expected.birthtimeMs === actual.birthtimeMs
	);
}

function emptyState(hostScope: string): PersistedState {
	return Object.freeze({
		formatVersion: STATE_FORMAT_VERSION,
		hostScope,
		cursor: null,
		applyWatermark: null,
		operations: Object.freeze([]),
		nativeApply: Object.freeze({
			state: "none",
			operationID: null,
			revisionID: null,
			payloadBase64: null,
		}),
	});
}

function validateConfig(config: StateStoreConfig): {
	readonly stateDirectory: string;
	readonly snapshotFileName: string;
	readonly hostScope: string;
	readonly maxSnapshotBytes: number;
} {
	if (!isPlainRecord(config)) throw new StateStoreError("invalid-input");
	if (typeof config.stateDirectory !== "string" || config.stateDirectory.length === 0) {
		throw new StateStoreError("invalid-input");
	}
	const fileName = config.snapshotFileName;
	if (
		typeof fileName !== "string" ||
		fileName.length === 0 ||
		fileName.includes("\0") ||
		fileName.includes("/") ||
		fileName.includes("\\") ||
		fileName.includes(":") ||
		fileName === "." ||
		fileName === ".." ||
		fileName === LOCK_DIRECTORY_NAME
	) {
		throw new StateStoreError("invalid-input");
	}
	const hostScope = requireIdentifier(config.hostScope, "invalid-input");
	if (
		!isPlainRecord(config.stateKey) ||
		typeof config.stateKey.load !== "function" ||
		!isPlainRecord(config.codec) ||
		typeof config.codec.seal !== "function" ||
		typeof config.codec.open !== "function"
	) {
		throw new StateStoreError("invalid-input");
	}
	if (
		typeof config.maxSnapshotBytes !== "number" ||
		!Number.isSafeInteger(config.maxSnapshotBytes) ||
		config.maxSnapshotBytes <= 0
	) {
		throw new StateStoreError("invalid-input");
	}
	return {
		stateDirectory: config.stateDirectory,
		snapshotFileName: fileName,
		hostScope,
		maxSnapshotBytes: config.maxSnapshotBytes,
	};
}

export class StateStore {
	readonly #stateDirectory: string;
	readonly #snapshotFileName: string;
	readonly #snapshotPath: string;
	readonly #hostScope: string;
	readonly #maxSnapshotBytes: number;
	readonly #stateKey: StateStoreConfig["stateKey"];
	readonly #codec: AuthenticatedStateCodec;
	readonly #testHooks: StateStoreConfig["testHooks"];
	readonly #lease: SessionOwner;
	#state: PersistedState;
	#closed = false;
	#failed = false;
	#closing = false;
	#leaseReleased = false;
	#releasePromise: Promise<void> | undefined;
	#mutationTail: Promise<void> = Promise.resolve();

	private constructor(config: StateStoreConfig, lease: SessionOwner) {
		const normalized = validateConfig(config);
		this.#stateDirectory = normalized.stateDirectory;
		this.#snapshotFileName = normalized.snapshotFileName;
		this.#snapshotPath = join(normalized.stateDirectory, normalized.snapshotFileName);
		this.#hostScope = normalized.hostScope;
		this.#maxSnapshotBytes = normalized.maxSnapshotBytes;
		this.#stateKey = config.stateKey;
		this.#codec = config.codec;
		this.#testHooks = config.testHooks;
		this.#lease = lease;
		this.#state = emptyState(normalized.hostScope);
	}

	/**
	 * Acquires the single-owner lock, then loads and authenticates any existing
	 * snapshot. A journal left in `candidate` by a previous process becomes
	 * `ambiguous` before the store is returned, so recovery never auto-reimports.
	 */
	static async open(config: StateStoreConfig): Promise<StateStore> {
		validateConfig(config);
		let lease: SessionOwner;
		try {
			lease = await acquireSessionOwner({ stateDirectory: config.stateDirectory });
		} catch (error) {
			if (error instanceof SessionOwnerError) {
				throw new StateStoreError(error.code === "owner-busy" ? "owner-busy" : "owner-unavailable");
			}
			throw new StateStoreError("owner-unavailable");
		}

		let store: StateStore | undefined;
		try {
			store = new StateStore(config, lease);
			await store.#initialize();
			return store;
		} catch (error) {
			await lease.release().catch(() => undefined);
			throw error;
		}
	}

	get closed(): boolean {
		return this.#closed || this.#failed;
	}

	/** Exact caller-supplied host-instance scope used by this store. */
	get hostScope(): string {
		return this.#hostScope;
	}

	/** Exact caller-supplied ciphertext snapshot ceiling. */
	get maxSnapshotBytes(): number {
		return this.#maxSnapshotBytes;
	}

	/** Exact caller-supplied bare snapshot file name. */
	get snapshotFileName(): string {
		return this.#snapshotFileName;
	}

	/** Read-only view of the authenticated state; ciphertext/payload are copies. */
	snapshot(): StateView {
		this.#assertUsable();
		return {
			formatVersion: this.#state.formatVersion,
			hostScope: this.#state.hostScope,
			cursor: this.#state.cursor,
			applyWatermark: this.#state.applyWatermark,
			operations: this.#state.operations.map(toOperationView),
			nativeApply: toNativeApplyView(this.#state.nativeApply),
		};
	}

	getOperation(operationID: string): OperationView {
		this.#assertUsable();
		return toOperationView(this.#requireOperation(requireIdentifier(operationID, "invalid-input")));
	}

	/**
	 * Collects, seals, and persists a new local operation. Returns only after
	 * the encrypted snapshot commit completes for process-restart visibility
	 * (power-loss durability unproven), before any network-ready signal.
	 * Queued whole-snapshot mutations make concurrent creates serialize.
	 */
	createLocalOperation(input: LocalOperationInput): Promise<OperationView> {
		return this.#enqueue(() => this.#createLocalOperation(input));
	}

	async #createLocalOperation(input: LocalOperationInput): Promise<OperationView> {
		this.#assertUsable();
		if (!isPlainRecord(input)) throw new StateStoreError("invalid-input");
		const operationID = requireIdentifier(input.operationID, "invalid-input");
		const revisionID = requireIdentifier(input.revisionID, "invalid-input");
		const parentRevisionID = requireNullableIdentifier(input.parentRevisionID, "invalid-input");
		if (!(input.plaintext instanceof Uint8Array)) throw new StateStoreError("invalid-input");
		this.#rejectDuplicate(operationID, revisionID);

		let ciphertext: Uint8Array;
		try {
			ciphertext = await this.#seal(input.plaintext);
		} catch (error) {
			if (error instanceof StateStoreError) throw error;
			throw new StateStoreError("codec-failure");
		}
		if (ciphertext.length === 0) throw new StateStoreError("codec-failure");

		const operation: PersistedOperation = Object.freeze({
			operationID,
			revisionID,
			parentRevisionID,
			status: "encrypted",
			uploadID: null,
			ciphertextBase64: encodeBase64(ciphertext),
		});
		await this.#persist({
			...this.#state,
			operations: Object.freeze([...this.#state.operations, operation]),
		});
		return toOperationView(operation);
	}

	/**
	 * Records a staging reservation. A retry after reservation expiry may
	 * replace `uploadID` only; the persisted ciphertext and revision identity
	 * are never changed.
	 */
	recordStagingReservation(operationID: string, uploadID: string): Promise<void> {
		return this.#enqueue(() => this.#recordStagingReservation(operationID, uploadID));
	}

	async #recordStagingReservation(operationID: string, uploadID: string): Promise<void> {
		this.#assertUsable();
		const id = requireIdentifier(operationID, "invalid-input");
		const nextUploadID = requireIdentifier(uploadID, "invalid-input");
		const operation = this.#requireOperation(id);
		if (operation.status !== "encrypted" && operation.status !== "reserved") {
			throw new StateStoreError("invalid-transition");
		}
		await this.#persist({
			...this.#state,
			operations: this.#replaceOperation({
				...operation,
				status: "reserved",
				uploadID: nextUploadID,
			}),
		});
	}

	/**
	 * Advances along one documented edge that carries no payload. Reservation,
	 * native-apply candidate, and confirmation use their dedicated methods.
	 */
	transition(operationID: string, to: OperationStatus): Promise<void> {
		return this.#enqueue(() => this.#transition(operationID, to));
	}

	async #transition(operationID: string, to: OperationStatus): Promise<void> {
		this.#assertUsable();
		if (!isOperationStatus(to)) throw new StateStoreError("invalid-transition");
		const operation = this.#requireOperation(requireIdentifier(operationID, "invalid-input"));
		if (
			to === "reserved" ||
			to === "apply-pending" ||
			to === "applied" ||
			(operation.status === "apply-pending" && to === "host-update-blocked")
		) {
			throw new StateStoreError("invalid-transition");
		}
		assertDocumentedTransition(operation.status, to);
		await this.#persist({
			...this.#state,
			operations: this.#replaceOperation({ ...operation, status: to }),
		});
	}

	/**
	 * Commits a fetched page and the new cursor in one encrypted snapshot.
	 * Every revision must include ciphertext; nothing is downloaded or resealed
	 * here, and the apply watermark is untouched.
	 */
	commitFetchedPage(input: CommitFetchedPageInput): Promise<void> {
		return this.#enqueue(() => this.#commitFetchedPage(input));
	}

	async #commitFetchedPage(input: CommitFetchedPageInput): Promise<void> {
		this.#assertUsable();
		if (!isPlainRecord(input)) throw new StateStoreError("invalid-input");
		const cursor = requireIdentifier(input.cursor, "invalid-input");
		if (!Array.isArray(input.revisions)) throw new StateStoreError("invalid-input");

		const seenOperations = new Set<string>();
		const seenRevisions = new Set<string>();
		const committed: PersistedOperation[] = [];
		for (const raw of input.revisions) {
			if (!isPlainRecord(raw)) throw new StateStoreError("invalid-input");
			const revision = raw as unknown as FetchedRevisionInput;
			const operationID = requireIdentifier(revision.operationID, "invalid-input");
			const revisionID = requireIdentifier(revision.revisionID, "invalid-input");
			const parentRevisionID = requireNullableIdentifier(revision.parentRevisionID, "invalid-input");
			if (!(revision.ciphertext instanceof Uint8Array) || revision.ciphertext.length === 0) {
				throw new StateStoreError("missing-ciphertext");
			}
			if (seenOperations.has(operationID) || seenRevisions.has(revisionID)) {
				throw new StateStoreError("duplicate-operation");
			}
			for (const existing of this.#state.operations) {
				if (existing.operationID === operationID) throw new StateStoreError("duplicate-operation");
				if (existing.revisionID === revisionID) throw new StateStoreError("duplicate-revision");
			}
			seenOperations.add(operationID);
			seenRevisions.add(revisionID);
			committed.push(
				Object.freeze({
					operationID,
					revisionID,
					parentRevisionID,
					status: "downloaded",
					uploadID: null,
					ciphertextBase64: encodeBase64(revision.ciphertext),
				}),
			);
		}

		await this.#persist({
			...this.#state,
			cursor,
			operations: Object.freeze([...this.#state.operations, ...committed]),
		});
	}

	/**
	 * Persists the candidate native-map entry before any import. The caller
	 * supplies the serialized opaque payload; this module never interprets it.
	 */
	beginNativeApply(operationID: string, payload: Uint8Array): Promise<void> {
		return this.#enqueue(() => this.#beginNativeApply(operationID, payload));
	}

	async #beginNativeApply(operationID: string, payload: Uint8Array): Promise<void> {
		this.#assertUsable();
		const id = requireIdentifier(operationID, "invalid-input");
		if (!(payload instanceof Uint8Array)) throw new StateStoreError("invalid-input");
		const operation = this.#requireOperation(id);
		if (operation.status !== "downloaded") throw new StateStoreError("invalid-transition");
		if (this.#state.nativeApply.state === "candidate" || this.#state.nativeApply.state === "ambiguous") {
			throw new StateStoreError("native-apply-conflict");
		}
		await this.#persist({
			...this.#state,
			operations: this.#replaceOperation({ ...operation, status: "apply-pending" }),
			nativeApply: Object.freeze({
				state: "candidate",
				operationID: id,
				revisionID: operation.revisionID,
				payloadBase64: encodeBase64(payload),
			}),
		});
	}

	/**
	 * Confirms the apply result after it is known. This is the only place the
	 * apply watermark advances (to the applied revision), and it happens in the
	 * same encrypted snapshot as the status change.
	 */
	confirmNativeApply(operationID: string): Promise<void> {
		return this.#enqueue(() => this.#confirmNativeApply(operationID));
	}

	async #confirmNativeApply(operationID: string): Promise<void> {
		this.#assertUsable();
		const id = requireIdentifier(operationID, "invalid-input");
		const operation = this.#requireOperation(id);
		const journal = this.#state.nativeApply;
		if (
			operation.status !== "apply-pending" ||
			journal.state !== "candidate" ||
			journal.operationID !== id
		) {
			throw new StateStoreError("native-apply-conflict");
		}
		await this.#persist({
			...this.#state,
			applyWatermark: operation.revisionID,
			operations: this.#replaceOperation({ ...operation, status: "applied" }),
			nativeApply: Object.freeze({ ...journal, state: "confirmed" }),
		});
	}

	/**
	 * Resolves a crash-ambiguous journal only with an explicit caller outcome
	 * after native inspection. No automatic reimport or overwrite is offered.
	 */
	resolveAmbiguousNativeApply(
		operationID: string,
		outcome: "applied" | "host-update-blocked",
	): Promise<void> {
		return this.#enqueue(() => this.#resolveAmbiguousNativeApply(operationID, outcome));
	}

	async #resolveAmbiguousNativeApply(
		operationID: string,
		outcome: "applied" | "host-update-blocked",
	): Promise<void> {
		this.#assertUsable();
		const id = requireIdentifier(operationID, "invalid-input");
		const operation = this.#requireOperation(id);
		const journal = this.#state.nativeApply;
		if (
			operation.status !== "apply-pending" ||
			journal.state !== "ambiguous" ||
			journal.operationID !== id
		) {
			throw new StateStoreError("native-apply-conflict");
		}
		await this.#persist({
			...this.#state,
			applyWatermark: outcome === "applied" ? operation.revisionID : this.#state.applyWatermark,
			operations: this.#replaceOperation({
				...operation,
				status: outcome === "applied" ? "applied" : "host-update-blocked",
			}),
			nativeApply: Object.freeze({ ...journal, state: "confirmed" }),
		});
	}

	/** Records HOST-01 blocking without any host call or watermark change. */
	blockHostUpdate(operationID: string): Promise<void> {
		return this.#enqueue(() => this.#blockHostUpdate(operationID));
	}

	async #blockHostUpdate(operationID: string): Promise<void> {
		this.#assertUsable();
		const operation = this.#requireOperation(requireIdentifier(operationID, "invalid-input"));
		if (operation.status === "apply-pending") throw new StateStoreError("invalid-transition");
		assertDocumentedTransition(operation.status, "host-update-blocked");
		await this.#persist({
			...this.#state,
			operations: this.#replaceOperation({ ...operation, status: "host-update-blocked" }),
		});
	}

	/**
	 * Stops accepting new mutations, waits for every already-accepted queued
	 * mutation (including failures), then releases the single-owner lease once.
	 */
	close(): Promise<void> {
		if (this.#releasePromise !== undefined) return this.#releasePromise;
		this.#closing = true;
		const release = this.#mutationTail.then(
			() => this.#releaseLease(),
			() => this.#releaseLease(),
		);
		this.#releasePromise = release;
		return release;
	}

	async #releaseLease(): Promise<void> {
		if (this.#leaseReleased) return;
		this.#leaseReleased = true;
		this.#closed = true;
		await this.#lease.release();
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#closed || this.#closing) {
			return Promise.reject(new StateStoreError("state-closed"));
		}
		const result = this.#mutationTail.then(operation, operation);
		// Keep the queue alive after a rejected job; only a real uncertainty
		// failure sets `#failed`, which makes later queued jobs fail closed.
		this.#mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #initialize(): Promise<void> {
		const bytes = await this.#readSnapshotFile();
		if (bytes === null) {
			// Key creation is allowed only here: under the held lease and only
			// when this open observed an absent snapshot. It never runs from a
			// later load/write failure or when a snapshot exists.
			await this.#ensureInitialStateKey();
			this.#state = emptyState(this.#hostScope);
			return;
		}
		const loaded = await this.#decodeSnapshot(bytes);
		if (loaded.hostScope !== this.#hostScope) {
			throw new StateStoreError("state-scope-mismatch");
		}
		this.#state = loaded;

		// A candidate journal can only survive here from a previous process
		// that did not confirm. Mark it ambiguous in the committed snapshot
		// before use so no caller can interpret recovery as permission to
		// import.
		if (loaded.nativeApply.state === "candidate") {
			await this.#persist({
				...loaded,
				nativeApply: Object.freeze({ ...loaded.nativeApply, state: "ambiguous" }),
			});
		}
	}

	/**
	 * Optional initial-key creation, called only for an absent snapshot while
	 * the lease is held. The created key must be readable back as exactly 32
	 * bytes and match the returned bytes; the returned buffer is wiped and is
	 * never retained. Load-only providers keep the prior empty-open behavior
	 * and simply fail later writes if no key is available.
	 */
	async #ensureInitialStateKey(): Promise<void> {
		const createIfMissing = this.#stateKey.createIfMissing;
		if (typeof createIfMissing !== "function") return;

		let created: unknown;
		try {
			created = await createIfMissing.call(this.#stateKey);
		} catch {
			throw new StateStoreError("state-key-unavailable");
		}
		if (!(created instanceof Uint8Array)) {
			throw new StateStoreError("state-key-unavailable");
		}
		const createdCopy = created.slice();
		try {
			if (createdCopy.length !== STATE_KEY_BYTES) {
				throw new StateStoreError("state-key-unavailable");
			}
			let readback: unknown;
			try {
				readback = await this.#stateKey.load();
			} catch {
				throw new StateStoreError("state-key-unavailable");
			}
			if (
				!(readback instanceof Uint8Array) ||
				readback.length !== STATE_KEY_BYTES ||
				!Buffer.from(readback).equals(Buffer.from(createdCopy))
			) {
				throw new StateStoreError("state-key-unavailable");
			}
		} finally {
			// The provider-owned creation buffer is wiped regardless of
			// verification outcome; a vault-backed provider must persist its
			// own copy before returning.
			bestEffortZero(created);
			bestEffortZero(createdCopy);
		}
	}

	async #readSnapshotFile(): Promise<Uint8Array | null> {
		let linkStats;
		try {
			linkStats = await lstat(this.#snapshotPath, { bigint: true });
		} catch (error) {
			if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
			throw new StateStoreError("state-unavailable");
		}
		if (!linkStats.isFile() || linkStats.isSymbolicLink() || linkStats.nlink !== 1n) {
			throw new StateStoreError("state-corrupt");
		}
		const expectedIdentity = identityFrom(linkStats);

		let handle;
		try {
			handle = await open(this.#snapshotPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		} catch {
			throw new StateStoreError("state-unavailable");
		}

		try {
			const openedStats = await handle.stat({ bigint: true });
			if (
				!openedStats.isFile() ||
				openedStats.nlink !== 1n ||
				!sameIdentity(expectedIdentity, openedStats)
			) {
				throw new StateStoreError("state-corrupt");
			}
			if (process.platform !== "win32") {
				const getuid = process.getuid;
				if (
					typeof getuid !== "function" ||
					openedStats.uid !== BigInt(getuid()) ||
					(openedStats.mode & 0o077n) !== 0n
				) {
					throw new StateStoreError("state-corrupt");
				}
			}
			if (openedStats.size > BigInt(this.#maxSnapshotBytes)) {
				throw new StateStoreError("state-too-large");
			}
			if (openedStats.size === 0n) throw new StateStoreError("state-corrupt");

			const sized = new Uint8Array(Number(openedStats.size));
			let filled = 0;
			while (filled < sized.length) {
				const { bytesRead } = await handle.read(sized, filled, sized.length - filled, filled);
				if (bytesRead === 0) throw new StateStoreError("state-corrupt");
				filled += bytesRead;
			}
			const extra = new Uint8Array(1);
			const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, sized.length);
			if (extraBytes !== 0) throw new StateStoreError("state-too-large");

			const afterStats = await handle.stat({ bigint: true });
			if (!sameIdentity(expectedIdentity, afterStats) || afterStats.size !== BigInt(sized.length)) {
				throw new StateStoreError("state-corrupt");
			}
			return sized;
		} finally {
			await handle.close();
		}
	}

	async #decodeSnapshot(ciphertext: Uint8Array): Promise<PersistedState> {
		const key = await this.#loadKey();
		let plaintext: Uint8Array;
		try {
			plaintext = await this.#codec.open(ciphertext, key, {
				purpose: "sessionport-local-state",
				formatVersion: STATE_FORMAT_VERSION,
				hostScope: this.#hostScope,
			});
		} catch {
			throw new StateStoreError("state-corrupt");
		} finally {
			bestEffortZero(key);
		}
		if (!(plaintext instanceof Uint8Array)) throw new StateStoreError("codec-failure");

		let text: string;
		try {
			text = UTF8_DECODER.decode(plaintext);
		} catch {
			throw new StateStoreError("state-corrupt");
		} finally {
			bestEffortZero(plaintext);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new StateStoreError("state-corrupt");
		}
		return parsePersistedState(parsed, this.#hostScope);
	}

	async #seal(plaintext: Uint8Array): Promise<Uint8Array> {
		const key = await this.#loadKey();
		try {
			const ciphertext = await this.#codec.seal(plaintext, key, {
				purpose: "sessionport-local-state",
				formatVersion: STATE_FORMAT_VERSION,
				hostScope: this.#hostScope,
			});
			if (!(ciphertext instanceof Uint8Array)) throw new StateStoreError("codec-failure");
			return ciphertext;
		} catch (error) {
			if (error instanceof StateStoreError) throw error;
			throw new StateStoreError("codec-failure");
		} finally {
			bestEffortZero(key);
		}
	}

	async #loadKey(): Promise<Uint8Array> {
		let loaded: Uint8Array | null;
		try {
			loaded = await this.#stateKey.load();
		} catch {
			throw new StateStoreError("state-key-unavailable");
		}
		if (!(loaded instanceof Uint8Array) || loaded.length !== STATE_KEY_BYTES) {
			throw new StateStoreError("state-key-unavailable");
		}
		// Work on a module-owned copy so codec/zeroing never mutates the
		// caller's vault-backed material.
		return loaded.slice();
	}

	async #persist(next: PersistedState): Promise<void> {
		this.#assertUsable();
		let serialized: Uint8Array;
		try {
			serialized = new TextEncoder().encode(JSON.stringify(serializePersistedState(next)));
		} catch {
			throw new StateStoreError("state-corrupt");
		}

		let ciphertext: Uint8Array;
		try {
			ciphertext = await this.#seal(serialized);
		} finally {
			bestEffortZero(serialized);
		}
		if (ciphertext.length > this.#maxSnapshotBytes) {
			throw new StateStoreError("state-too-large");
		}

		try {
			await writeCiphertextAtomically(this.#snapshotPath, ciphertext, this.#testHooks);
		} catch (error) {
			if (error instanceof AtomicWriteUncertainError) {
				this.#failed = true;
				throw new StateStoreError("write-outcome-uncertain");
			}
			throw new StateStoreError("write-failed");
		}
		this.#state = next;
	}

	#assertUsable(): void {
		if (this.#closed || this.#failed) throw new StateStoreError("state-closed");
	}

	#requireOperation(operationID: string): PersistedOperation {
		const operation = this.#state.operations.find((entry) => entry.operationID === operationID);
		if (operation === undefined) throw new StateStoreError("unknown-operation");
		return operation;
	}

	#rejectDuplicate(operationID: string, revisionID: string): void {
		for (const existing of this.#state.operations) {
			if (existing.operationID === operationID) throw new StateStoreError("duplicate-operation");
			if (existing.revisionID === revisionID) throw new StateStoreError("duplicate-revision");
		}
	}

	#replaceOperation(next: PersistedOperation): readonly PersistedOperation[] {
		return Object.freeze(
			this.#state.operations.map((entry) => (entry.operationID === next.operationID ? next : entry)),
		);
	}
}

function serializePersistedState(state: PersistedState): unknown {
	return {
		formatVersion: state.formatVersion,
		hostScope: state.hostScope,
		cursor: state.cursor,
		applyWatermark: state.applyWatermark,
		operations: state.operations.map((operation) => ({
			operationID: operation.operationID,
			revisionID: operation.revisionID,
			parentRevisionID: operation.parentRevisionID,
			status: operation.status,
			uploadID: operation.uploadID,
			ciphertext: operation.ciphertextBase64,
		})),
		nativeApply: {
			state: state.nativeApply.state,
			operationID: state.nativeApply.operationID,
			revisionID: state.nativeApply.revisionID,
			payload: state.nativeApply.payloadBase64,
		},
	};
}

function toOperationView(operation: PersistedOperation): OperationView {	return {
		operationID: operation.operationID,
		revisionID: operation.revisionID,
		parentRevisionID: operation.parentRevisionID,
		status: operation.status,
		uploadID: operation.uploadID,
		ciphertext: decodeBase64(operation.ciphertextBase64, false, "missing-ciphertext"),
	};
}

function toNativeApplyView(journal: PersistedNativeApply): NativeApplyView {
	return {
		state: journal.state,
		operationID: journal.operationID,
		revisionID: journal.revisionID,
		payload:
			journal.payloadBase64 === null
				? null
				: decodeBase64(journal.payloadBase64, true, "state-corrupt"),
	};
}

function parsePersistedState(value: unknown, expectedHostScope: string): PersistedState {
	if (!isPlainRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
		throw new StateStoreError("state-corrupt");
	}
	if (typeof value.formatVersion !== "number" || !Number.isSafeInteger(value.formatVersion)) {
		throw new StateStoreError("state-corrupt");
	}
	if (value.formatVersion !== STATE_FORMAT_VERSION) {
		throw new StateStoreError("unsupported-version");
	}
	if (typeof value.hostScope !== "string" || value.hostScope.length === 0) {
		throw new StateStoreError("state-corrupt");
	}
	if (value.hostScope !== expectedHostScope) throw new StateStoreError("state-scope-mismatch");
	const cursor = requireNullableIdentifier(value.cursor, "state-corrupt");
	const applyWatermark = requireNullableIdentifier(value.applyWatermark, "state-corrupt");

	if (!Array.isArray(value.operations)) throw new StateStoreError("state-corrupt");
	const operations: PersistedOperation[] = [];
	const operationIDs = new Set<string>();
	const revisionIDs = new Set<string>();
	for (const raw of value.operations) {
		if (!isPlainRecord(raw) || !hasExactKeys(raw, OPERATION_KEYS)) {
			throw new StateStoreError("state-corrupt");
		}
		const operationID = requireIdentifier(raw.operationID, "state-corrupt");
		const revisionID = requireIdentifier(raw.revisionID, "state-corrupt");
		if (operationIDs.has(operationID) || revisionIDs.has(revisionID)) {
			throw new StateStoreError("state-corrupt");
		}
		operationIDs.add(operationID);
		revisionIDs.add(revisionID);
		if (!isOperationStatus(raw.status) || raw.status === "collected") {
			throw new StateStoreError("state-corrupt");
		}
		const uploadID = raw.uploadID === null ? null : requireIdentifier(raw.uploadID, "state-corrupt");
		if (raw.status === "encrypted" && uploadID !== null) throw new StateStoreError("state-corrupt");
		if (raw.status === "reserved" && uploadID === null) throw new StateStoreError("state-corrupt");
		// Validate base64 now, but keep the exact persisted string.
		const ciphertextBase64 = raw.ciphertext;
		if (typeof ciphertextBase64 !== "string") throw new StateStoreError("state-corrupt");
		decodeBase64(ciphertextBase64, false, "missing-ciphertext");
		operations.push(
			Object.freeze({
				operationID,
				revisionID,
				parentRevisionID: requireNullableIdentifier(raw.parentRevisionID, "state-corrupt"),
				status: raw.status,
				uploadID,
				ciphertextBase64,
			}),
		);
	}

	if (!isPlainRecord(value.nativeApply) || !hasExactKeys(value.nativeApply, NATIVE_APPLY_KEYS)) {
		throw new StateStoreError("state-corrupt");
	}
	const journal = value.nativeApply;
	if (!isNativeApplyState(journal.state)) throw new StateStoreError("state-corrupt");
	let nativeApply: PersistedNativeApply;
	if (journal.state === "none") {
		if (journal.operationID !== null || journal.revisionID !== null || journal.payload !== null) {
			throw new StateStoreError("state-corrupt");
		}
		nativeApply = Object.freeze({
			state: "none",
			operationID: null,
			revisionID: null,
			payloadBase64: null,
		});
	} else {
		const operationID = requireIdentifier(journal.operationID, "state-corrupt");
		const revisionID = requireIdentifier(journal.revisionID, "state-corrupt");
		const payloadBase64 = journal.payload;
		if (typeof payloadBase64 !== "string") throw new StateStoreError("state-corrupt");
		const referenced = operations.find((entry) => entry.operationID === operationID);
		if (referenced === undefined || referenced.revisionID !== revisionID) {
			throw new StateStoreError("state-corrupt");
		}
		if (journal.state === "candidate" || journal.state === "ambiguous") {
			if (referenced.status !== "apply-pending") throw new StateStoreError("state-corrupt");
		} else if (referenced.status !== "applied" && referenced.status !== "host-update-blocked") {
			throw new StateStoreError("state-corrupt");
		}
		decodeBase64(payloadBase64, true, "state-corrupt");
		nativeApply = Object.freeze({
			state: journal.state,
			operationID,
			revisionID,
			payloadBase64,
		});
	}

	return Object.freeze({
		formatVersion: STATE_FORMAT_VERSION,
		hostScope: value.hostScope,
		cursor,
		applyWatermark,
		operations: Object.freeze(operations),
		nativeApply,
	});
}

/** Re-exported so callers can assert documented edges without importing internals. */
export { isDocumentedTransition };
