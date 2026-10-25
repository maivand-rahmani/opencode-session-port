/**
 * Exact-entry vault cleanup guard for the native `/sync` validation run.
 *
 * This module is staged into the disposable root and executed only AFTER the
 * TUI process tree stop has been verified. It targets exactly one
 * service/account pair (the fresh UUID service generated for this run) and
 * never enumerates credentials, never writes a secret, and never retries.
 *
 * The host-free test seam is the constructor argument: production passes the
 * real `@napi-rs/keyring` AsyncEntry resolved from the staged pinned package,
 * tests pass a fake with the same structural surface.
 *
 * Receipt shape is deliberately tiny and secret-free:
 *   { exactTargetOnly: true, presence: boolean|null, removed: boolean|null }
 * A null means the guard could not prove the state; the runner then retains
 * the private disposable root instead of claiming a clean cleanup.
 */

const MAX_SECRET_BYTES = 8192;

/**
 * @param {new (service: string, account: string) => {
 *   getSecret(): Promise<number[]|null>,
 *   deleteCredential(): Promise<boolean>
 * }} AsyncEntry
 * @param {string} service
 * @param {string} account
 * @returns {Promise<{ exactTargetOnly: true, presence: boolean|null, removed: boolean|null }>}
 */
export async function cleanupExactEntry(AsyncEntry, service, account) {
	const receipt = { exactTargetOnly: true, presence: null, removed: null };
	if (typeof AsyncEntry !== "function") return receipt;
	if (typeof service !== "string" || service.length === 0) return receipt;
	if (typeof account !== "string" || account.length === 0) return receipt;

	let entry;
	try {
		entry = new AsyncEntry(service, account);
	} catch {
		return receipt;
	}

	let current;
	try {
		current = await entry.getSecret();
	} catch {
		return receipt;
	}
	if (current === null) {
		receipt.presence = false;
		receipt.removed = false;
		return receipt;
	}
	if (!Array.isArray(current) || current.length > MAX_SECRET_BYTES) return receipt;
	receipt.presence = true;

	let deleted;
	try {
		deleted = await entry.deleteCredential();
	} catch {
		return receipt;
	}
	if (typeof deleted !== "boolean") return receipt;
	try {
		current = await entry.getSecret();
	} catch {
		return receipt;
	}
	receipt.removed = current === null;
	return receipt;
}

async function main() {
	const service = process.argv[2];
	const account = process.argv[3];
	const receiptPath = process.argv[4];
	if (
		typeof service !== "string" ||
		typeof account !== "string" ||
		typeof receiptPath !== "string" ||
		service.length === 0 ||
		account.length === 0 ||
		receiptPath.length === 0
	) {
		process.exitCode = 2;
		return;
	}
	let receipt = { exactTargetOnly: true, presence: null, removed: null };
	try {
		const loaded = await import("@napi-rs/keyring");
		const AsyncEntry = loaded.AsyncEntry ?? loaded.default?.AsyncEntry;
		receipt = await cleanupExactEntry(AsyncEntry, service, account);
	} catch {
		// Fixed-safe: unproven state stays null and the runner retains the root.
	}
	try {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");
	} catch {
		process.exitCode = 2;
		return;
	}
	process.exitCode = receipt.presence !== null && receipt.removed !== null ? 0 : 2;
}

if (import.meta.main === true || (await import("node:url")).pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
	await main();
}
