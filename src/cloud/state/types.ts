/**
 * Local encrypted state / outbox contracts.
 *
 * Scope (V2 SYNC_PROTOCOL section 8 only):
 * - Caller supplies the private absolute state directory, the host-instance
 *   scope, the snapshot file name, explicit byte limits, a separate state-key
 *   provider, and an authenticated-encryption codec.
 * - This module deliberately defines NO production crypto policy, NO default
 *   state-key namespace, and NO on-disk plaintext format. The persisted format
 *   described here is an internal snapshot envelope only (ciphertext is
 *   produced by the injected codec). The external state-codec and state-key
 *   contracts are owner-approved and live outside this core; this core remains
 *   fully injected and is not claimed to be integrated into a platform build.
 * - The codec must accept the state key returned by the provider plus a safe
 *   context; it is responsible for authenticating that context.
 *
 * Status edges implemented are exactly the documented ones in
 * SYNC_PROTOCOL.md section 8; no acknowledgement/delete semantics are guessed.
 */

/** The only snapshot envelope version understood by this module. */
export const STATE_FORMAT_VERSION = 1;

/**
 * Documented operation statuses. `collected` is transient in-memory collection
 * before sealing; a committed snapshot only ever starts at `encrypted` because
 * ciphertext must exist before any operation is signalled network-ready.
 *
 * Durability boundary: this module targets visibility across normal process
 * exit/restart and simulated pre/post-rename failures. Power-loss durability of
 * rename is NOT established (no directory fsync; Node rename + file fsync has
 * no verified Windows power-loss guarantee). Do not claim it.
 */
export type OperationStatus =
	| "collected"
	| "encrypted"
	| "reserved"
	| "uploaded"
	| "committed"
	| "downloaded"
	| "apply-pending"
	| "applied"
	| "host-update-blocked";

export const OPERATION_STATUSES: readonly OperationStatus[] = Object.freeze([
	"collected",
	"encrypted",
	"reserved",
	"uploaded",
	"committed",
	"downloaded",
	"apply-pending",
	"applied",
	"host-update-blocked",
]);

/**
 * Only the documented edges. Transitions that carry data (reservation,
 * native-apply candidate, native-apply confirmation) are expressed through the
 * dedicated store methods below, never through a generic status jump.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> =
	Object.freeze({
		collected: edges("encrypted"),
		encrypted: edges("reserved"),
		reserved: edges("uploaded"),
		uploaded: edges("committed"),
		committed: edges("downloaded"),
		downloaded: edges("apply-pending", "host-update-blocked"),
		"apply-pending": edges("applied", "host-update-blocked"),
		applied: edges(),
		"host-update-blocked": edges(),
	});

function edges(...values: OperationStatus[]): readonly OperationStatus[] {
	return Object.freeze(values);
}

export type StateStoreErrorCode =
	| "invalid-input"
	| "owner-busy"
	| "owner-unavailable"
	| "state-unavailable"
	| "state-closed"
	| "state-key-unavailable"
	| "state-corrupt"
	| "state-scope-mismatch"
	| "unsupported-version"
	| "state-too-large"
	| "unknown-operation"
	| "duplicate-operation"
	| "duplicate-revision"
	| "missing-ciphertext"
	| "invalid-transition"
	| "native-apply-conflict"
	| "codec-failure"
	| "write-failed"
	| "write-outcome-uncertain";

const ERROR_MESSAGES: Readonly<Record<StateStoreErrorCode, string>> = Object.freeze({
	"invalid-input": "The local state input is invalid.",
	"owner-busy": "Another process holds the local state lock.",
	"owner-unavailable": "The local state lock is unavailable.",
	"state-unavailable": "The local encrypted state is unavailable.",
	"state-closed": "The local state store is closed or fail-closed.",
	"state-key-unavailable": "The separate local state key is unavailable.",
	"state-corrupt": "The local encrypted state is corrupt or failed authentication.",
	"state-scope-mismatch": "The local encrypted state belongs to another host scope.",
	"unsupported-version": "The local encrypted state version is unsupported.",
	"state-too-large": "The local encrypted state exceeds the configured byte limit.",
	"unknown-operation": "The operation is not present in local state.",
	"duplicate-operation": "The operation identifier already exists.",
	"duplicate-revision": "The revision identifier already exists.",
	"missing-ciphertext": "An operation has no persisted ciphertext; it will not be resealed.",
	"invalid-transition": "The requested operation status transition is not documented.",
	"native-apply-conflict": "The native apply journal is not in a state that allows this action.",
	"codec-failure": "The injected state encryption codec failed.",
	"write-failed": "The encrypted state snapshot was not written.",
	"write-outcome-uncertain": "The encrypted state snapshot write outcome is uncertain.",
});

/** Fixed, redacted error: no path, key, ciphertext, payload, or cause is retained. */
export class StateStoreError extends Error {
	readonly code: StateStoreErrorCode;

	constructor(code: StateStoreErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "StateStoreError";
		this.code = code;
	}
}

/**
 * Separate local state-key source. This is intentionally not the auth
 * credential store and the returned key must never be an access token. The
 * caller supplies the vault binding; returning `null` (or throwing) fails
 * closed before any write.
 *
 * The owner-approved external provider contract may additionally expose
 * `createIfMissing`. `StateStore.open` calls it at most once, only while it
 * holds the single-owner lease and only when the snapshot file is absent. The
 * provider must durably persist the created key itself; the returned buffer is
 * caller-owned and is wiped by the store after verification. Load-only
 * providers remain compatible and never trigger creation.
 */
export interface StateKeyProvider {
	load(): Promise<Uint8Array | null>;
	/**
	 * Optional initial-key creation. Never called when a snapshot exists, and
	 * never called again for later load/write failures.
	 */
	createIfMissing?(): Promise<Uint8Array>;
}

/** Exact state-key length documented in SECURITY.md section 2. */
export const STATE_KEY_BYTES = 32;

/** Safe, caller-visible context the injected codec must authenticate. */
export interface StateCodecContext {
	readonly purpose: "sessionport-local-state";
	readonly formatVersion: number;
	readonly hostScope: string;
}

/**
 * Mandatory injected authenticated-encryption codec. The core never
 * implements or selects production crypto; implementations must seal/open
 * arbitrary bytes with the supplied state key and authenticated context.
 */
export interface AuthenticatedStateCodec {
	seal(plaintext: Uint8Array, key: Uint8Array, context: StateCodecContext): Promise<Uint8Array>;
	open(ciphertext: Uint8Array, key: Uint8Array, context: StateCodecContext): Promise<Uint8Array>;
}

/**
 * Test-only seam for simulating an interrupted atomic replace. Not for
 * production wiring.
 */
export interface AtomicWriteTestHooks {
	readonly beforeRename?: (temporaryPath: string) => Promise<void>;
	readonly afterRename?: (finalPath: string) => Promise<void>;
}

export interface StateStoreConfig {
	/** Explicit absolute, private, per-user, outside-repository directory. */
	readonly stateDirectory: string;
	/** Caller-selected bare snapshot file name; no path separators or ADS. */
	readonly snapshotFileName: string;
	/** Caller-supplied host-instance scope stored inside the encrypted state. */
	readonly hostScope: string;
	/** Injected separate state-key provider (caller vault binding). */
	readonly stateKey: StateKeyProvider;
	/** Injected authenticated-encryption codec; no default exists. */
	readonly codec: AuthenticatedStateCodec;
	/** Required caller ceiling for the encrypted snapshot file in bytes. */
	readonly maxSnapshotBytes: number;
	/** Test-only atomic-write interruption seam. */
	readonly testHooks?: AtomicWriteTestHooks;
}

export interface LocalOperationInput {
	readonly operationID: string;
	readonly revisionID: string;
	readonly parentRevisionID: string | null;
	readonly plaintext: Uint8Array;
}

export interface FetchedRevisionInput {
	readonly operationID: string;
	readonly revisionID: string;
	readonly parentRevisionID: string | null;
	/** Downloaded ciphertext exactly as received; persisted without resealing. */
	readonly ciphertext: Uint8Array;
}

export interface CommitFetchedPageInput {
	/** Opaque server sync cursor; committed atomically with the page. */
	readonly cursor: string;
	readonly revisions: readonly FetchedRevisionInput[];
}

export interface OperationView {
	readonly operationID: string;
	readonly revisionID: string;
	readonly parentRevisionID: string | null;
	readonly status: OperationStatus;
	readonly uploadID: string | null;
	/** Persisted ciphertext copy; stable across retries. */
	readonly ciphertext: Uint8Array;
}

export type NativeApplyState = "none" | "candidate" | "confirmed" | "ambiguous";

export interface NativeApplyView {
	readonly state: NativeApplyState;
	readonly operationID: string | null;
	readonly revisionID: string | null;
	/** Opaque caller-serialized candidate payload; never interpreted here. */
	readonly payload: Uint8Array | null;
}

export interface StateView {
	readonly formatVersion: typeof STATE_FORMAT_VERSION;
	readonly hostScope: string;
	readonly cursor: string | null;
	readonly applyWatermark: string | null;
	readonly operations: readonly OperationView[];
	readonly nativeApply: NativeApplyView;
}

/** Returns true only for a documented edge. */
export function isDocumentedTransition(from: OperationStatus, to: OperationStatus): boolean {
	return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertDocumentedTransition(from: OperationStatus, to: OperationStatus): void {
	if (!isDocumentedTransition(from, to)) {
		throw new StateStoreError("invalid-transition");
	}
}
