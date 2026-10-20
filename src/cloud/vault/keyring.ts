/**
 * Injectable @napi-rs/keyring adapter. No native import occurs here: a caller
 * dynamically imports the binding and passes its real `AsyncEntry` constructor.
 * There is no memory/disk/environment fallback.
 *
 * Abort only gates operation start. The inspected evidence does not establish
 * the native AbortSignal placement, so no signal is forwarded. An abort during
 * a native write/delete awaits settlement and one exact readback, then reports
 * `outcome-uncertain` unless the final state is proven. Per adapter instance,
 * one queue serializes each service/account; abort never detaches work.
 */
import { VaultError, validateVaultEntry } from "./types.ts";
import type { SecureVault, VaultEntry, VaultOperationOptions } from "./types.ts";

/** Only the option shape this adapter passes; Linux is always Secret Service. */
export interface KeyringEntryOptions {
	readonly linux?: { readonly store?: "secret-service" | "keyutils" };
}

/** Structural subset of the inspected public `AsyncEntry` surface. */
export interface KeyringAsyncEntry {
	setSecret(secret: Uint8Array): Promise<void>;
	getSecret(): Promise<number[] | null>;
	deleteCredential(): Promise<boolean>;
}

/** Actual binding constructor shape accepted by the production factory. */
export interface KeyringAsyncEntryConstructor {
	new (service: string, account: string, options?: KeyringEntryOptions): KeyringAsyncEntry;
}

export interface KeyringVaultConfig {
	/** Required caller ceiling; no production cap is defined here. */
	readonly maxSecretBytes: number;
	/** Test seam only; production omits this to use `process.platform`. */
	readonly platform?: string;
}

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);
const LINUX_SECRET_SERVICE: KeyringEntryOptions = { linux: { store: "secret-service" } };

/** Production factory; pass the binding's actual `AsyncEntry` constructor. */
export function createKeyringVault(
	AsyncEntry: KeyringAsyncEntryConstructor,
	config: KeyringVaultConfig,
): SecureVault {
	if (typeof AsyncEntry !== "function") throw new VaultError("invalid-input");
	if (config === null || typeof config !== "object") throw new VaultError("invalid-input");
	if (!Number.isSafeInteger(config.maxSecretBytes) || config.maxSecretBytes <= 0) {
		throw new VaultError("invalid-input");
	}
	const platform = config.platform ?? process.platform;
	if (!SUPPORTED_PLATFORMS.has(platform)) throw new VaultError("unsupported-platform");
	return new KeyringVault(AsyncEntry, config.maxSecretBytes, platform);
}

function signalFrom(options: VaultOperationOptions | undefined): AbortSignal | undefined {
	if (options === undefined) return undefined;
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		throw new VaultError("invalid-input");
	}
	const signal = options.signal;
	if (signal === undefined) return undefined;
	if (signal === null || typeof signal !== "object" || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") {
		throw new VaultError("invalid-input");
	}
	return signal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new VaultError("aborted");
}

function decodeSecret(raw: unknown, maxSecretBytes: number): Uint8Array | null {
	if (raw === null) return null;
	if (!Array.isArray(raw)) throw new VaultError("invalid-native-response");
	if (raw.length > maxSecretBytes) throw new VaultError("too-large");
	const bytes = new Uint8Array(raw.length);
	for (let index = 0; index < raw.length; index += 1) {
		const value: unknown = raw[index];
		if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255) {
			throw new VaultError("invalid-native-response");
		}
		bytes[index] = value as number;
	}
	return bytes;
}

class KeyringVault implements SecureVault {
	private readonly tails = new Map<string, Promise<void>>();

	constructor(
		private readonly AsyncEntry: KeyringAsyncEntryConstructor,
		private readonly maxSecretBytes: number,
		private readonly platform: string,
	) {}

	async read(entry: VaultEntry, options?: VaultOperationOptions): Promise<Uint8Array | null> {
		const ref = validateVaultEntry(entry);
		const signal = signalFrom(options);
		throwIfAborted(signal);
		return this.enqueue(ref, async () => {
			throwIfAborted(signal);
			// An in-flight read still settles; reads mutate nothing.
			return this.readNative(ref);
		});
	}

	async write(entry: VaultEntry, secret: Uint8Array, options?: VaultOperationOptions): Promise<void> {
		const ref = validateVaultEntry(entry);
		if (!(secret instanceof Uint8Array)) throw new VaultError("invalid-input");
		if (secret.length > this.maxSecretBytes) throw new VaultError("too-large");
		const signal = signalFrom(options);
		throwIfAborted(signal);
		const copy = new Uint8Array(secret);
		await this.enqueue(ref, async () => {
			throwIfAborted(signal);
			const native = this.createNative(ref);
			throwIfAborted(signal);
			try {
				await native.setSecret(copy);
			} catch {
				if (signal?.aborted) {
					await this.assertWritten(ref, copy);
					// Native failed after a mutation that may have applied.
					throw new VaultError("outcome-uncertain");
				}
				throw new VaultError("unavailable");
			}
			if (signal?.aborted) await this.assertWritten(ref, copy);
		});
	}

	async remove(entry: VaultEntry, options?: VaultOperationOptions): Promise<boolean> {
		const ref = validateVaultEntry(entry);
		const signal = signalFrom(options);
		throwIfAborted(signal);
		return this.enqueue(ref, async () => {
			throwIfAborted(signal);
			const native = this.createNative(ref);
			throwIfAborted(signal);
			let deleted: unknown;
			try {
				deleted = await native.deleteCredential();
			} catch {
				if (signal?.aborted) {
					await this.readAfterDelete(ref);
					throw new VaultError("outcome-uncertain");
				}
				throw new VaultError("unavailable");
			}
			if (typeof deleted !== "boolean") throw new VaultError("outcome-uncertain");
			if (signal?.aborted) {
				const current = await this.readAfterDelete(ref);
				if (deleted && current !== null) throw new VaultError("outcome-uncertain");
			}
			return deleted;
		});
	}

	private enqueue<T>(ref: VaultEntry, operation: () => Promise<T>): Promise<T> {
		const key = JSON.stringify([ref.service, ref.account]);
		const previous = this.tails.get(key) ?? Promise.resolve();
		const current = previous.then(operation);
		const tail = current.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return current;
	}

	private createNative(ref: VaultEntry): KeyringAsyncEntry {
		try {
			return this.platform === "linux"
				? new this.AsyncEntry(ref.service, ref.account, LINUX_SECRET_SERVICE)
				: new this.AsyncEntry(ref.service, ref.account);
		} catch {
			throw new VaultError("unavailable");
		}
	}

	private async readNative(ref: VaultEntry): Promise<Uint8Array | null> {
		const native = this.createNative(ref);
		let raw: unknown;
		try {
			raw = await native.getSecret();
		} catch {
			throw new VaultError("unavailable");
		}
		return decodeSecret(raw, this.maxSecretBytes);
	}

	private async assertWritten(ref: VaultEntry, expected: Uint8Array): Promise<void> {
		let actual: Uint8Array | null;
		try {
			actual = await this.readNative(ref);
		} catch {
			throw new VaultError("outcome-uncertain");
		}
		if (actual === null || actual.length !== expected.length) {
			throw new VaultError("outcome-uncertain");
		}
		if (actual.some((byte, index) => byte !== expected[index])) throw new VaultError("outcome-uncertain");
	}

	private async readAfterDelete(ref: VaultEntry): Promise<Uint8Array | null> {
		try {
			return await this.readNative(ref);
		} catch {
			throw new VaultError("outcome-uncertain");
		}
	}
}
