/**
 * Bytes-only secure-vault contract. Entry names are non-secret caller input;
 * payloads stay in operation arguments. There is no enumeration API and no
 * native/fallback-store dependency here.
 */

/** Exact caller-supplied location of one vault item. */
export interface VaultEntry {
	readonly service: string;
	readonly account: string;
}

/** Abort is a pre-start gate, not in-flight native cancellation; see keyring.ts. */
export interface VaultOperationOptions {
	readonly signal?: AbortSignal;
}

/** Bytes-only vault. */
export interface SecureVault {
	read(entry: VaultEntry, options?: VaultOperationOptions): Promise<Uint8Array | null>;
	write(entry: VaultEntry, secret: Uint8Array, options?: VaultOperationOptions): Promise<void>;
	/** True when deleted, false when already absent. */
	remove(entry: VaultEntry, options?: VaultOperationOptions): Promise<boolean>;
}

/**
 * Fixed failure taxonomy. `unavailable` does not distinguish locked from
 * unavailable stores: the inspected binding has no portable taxonomy.
 */
export type VaultErrorCode = "invalid-input" | "too-large" | "unsupported-platform" | "unavailable" | "aborted" | "invalid-native-response" | "outcome-uncertain";

const MESSAGES: Readonly<Record<VaultErrorCode, string>> = {
	"invalid-input": "Vault input is invalid.",
	"too-large": "The vault secret exceeds the configured byte limit.",
	"unsupported-platform": "The vault platform is unsupported.",
	unavailable: "The vault is unavailable.",
	aborted: "The vault operation was aborted before it started.",
	"invalid-native-response": "The vault binding returned an invalid secret.",
	"outcome-uncertain": "The vault mutation outcome could not be verified.",
};

/** Fixed, redacted error: no caller names, bytes, native text, or cause. */
export class VaultError extends Error {
	readonly code: VaultErrorCode;

	constructor(code: VaultErrorCode) {
		super(MESSAGES[code]);
		this.name = "VaultError";
		this.code = code;
	}
}

/** Validates an untrusted entry reference without rewriting either name. */
export function validateVaultEntry(entry: unknown): VaultEntry {
	if (
		entry === null ||
		typeof entry !== "object" ||
		Array.isArray(entry) ||
		typeof (entry as VaultEntry).service !== "string" ||
		(entry as VaultEntry).service.length === 0 ||
		typeof (entry as VaultEntry).account !== "string" ||
		(entry as VaultEntry).account.length === 0
	) {
		throw new VaultError("invalid-input");
	}
	return entry as VaultEntry;
}
