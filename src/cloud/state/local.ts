/**
 * Production local-state composition boundary (SECURITY.md 5.1).
 *
 * This factory wires the approved selected state codec and the vault-backed
 * separate state-key provider into the injected `StateStore`. The caller still
 * supplies the explicit private absolute state directory, host-instance scope,
 * and `SecureVault`; there are no OS path defaults, environment lookups, auth
 * credential reuse, namespace overrides, crypto overrides, or unbounded caps.
 *
 * The store acquires its existing cooperative owner lock before reading the
 * snapshot, and the state-key provider's `createIfMissing` is invoked by the
 * store only under that lease and only when the snapshot is absent. An existing
 * snapshot with a missing key is never replaced.
 *
 * Composition does not mean runtime wiring: no auth controller, `/sync`
 * command, network transport, or M4 code invokes this factory yet. The auth
 * controller owns the same lock path and must not be naively stacked on this
 * store; a future sync engine calls this factory only when it owns the
 * appropriate separate lock lifecycle.
 */
import { createAuthenticatedStateCodec, STATE_CODEC_MAX_ENVELOPE_BYTES, validateStateScope } from "../state-codec/index.ts";
import { createVaultStateKeyProvider } from "../state-key/index.ts";
import type { SecureVault } from "../vault/types.ts";
import { StateStore } from "./store.ts";
import { StateStoreError } from "./types.ts";

/** Fixed selected snapshot file name; not caller-overridable. */
export const LOCAL_STATE_SNAPSHOT_FILE_NAME = "state.v1.enc";

/** Fixed snapshot ceiling from the selected state envelope. */
export const LOCAL_STATE_MAX_SNAPSHOT_BYTES = STATE_CODEC_MAX_ENVELOPE_BYTES;

const OPTION_KEYS = ["stateDirectory", "hostScope", "vault"] as const;

/** Explicit production inputs. No optional format, cap, or namespace fields. */
export interface LocalStateOptions {
	/** Explicit absolute private per-user directory outside the repository. */
	readonly stateDirectory: string;
	/** Exact host-instance scope, validated by the selected codec. */
	readonly hostScope: string;
	/** Caller-supplied secure vault; never an auth credential source. */
	readonly vault: SecureVault;
}

function invalid(): never {
	throw new StateStoreError("invalid-input");
}

function isDataRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		// Reject accessor-backed "config" objects; the factory reads plain data.
		if (descriptor === undefined || !("value" in descriptor)) return false;
	}
	return true;
}

function isVault(value: unknown): value is SecureVault {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as SecureVault).read === "function" &&
		typeof (value as SecureVault).write === "function" &&
		typeof (value as SecureVault).remove === "function"
	);
}

function readOptions(value: unknown): LocalStateOptions {
	if (!isDataRecord(value)) invalid();
	const actual = Reflect.ownKeys(value);
	if (
		actual.length !== OPTION_KEYS.length ||
		!actual.every((key): key is string => typeof key === "string") ||
		!OPTION_KEYS.every((key) => Object.hasOwn(value, key)) ||
		typeof value.stateDirectory !== "string" ||
		value.stateDirectory.length === 0 ||
		value.stateDirectory.includes("\0") ||
		typeof value.hostScope !== "string" ||
		!isVault(value.vault)
	) {
		invalid();
	}
	try {
		validateStateScope(value.hostScope);
	} catch {
		invalid();
	}
	return Object.freeze({
		stateDirectory: value.stateDirectory,
		hostScope: value.hostScope,
		vault: value.vault,
	});
}

/**
 * Opens the production-composed local state store. No codec, key namespace,
 * snapshot name, or byte cap is caller-overridable.
 */
export async function openLocalState(options: LocalStateOptions): Promise<StateStore> {
	const selected = readOptions(options);
	let stateKey;
	try {
		stateKey = createVaultStateKeyProvider({
			vault: selected.vault,
			hostScope: selected.hostScope,
		});
	} catch {
		invalid();
	}
	return StateStore.open({
		stateDirectory: selected.stateDirectory,
		snapshotFileName: LOCAL_STATE_SNAPSHOT_FILE_NAME,
		hostScope: selected.hostScope,
		stateKey,
		codec: createAuthenticatedStateCodec(),
		maxSnapshotBytes: LOCAL_STATE_MAX_SNAPSHOT_BYTES,
	});
}
