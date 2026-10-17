/**
 * Best-effort clearing of byte buffers owned by this module.
 *
 * There is NO secure-deletion guarantee (A-07): this only overwrites buffers
 * this module allocated. Caller-owned password material is never modified.
 * libsodium secretstream state objects are released by dropping references;
 * pinned libsodium-wrappers-sumo@0.8.4 exposes no documented generic free
 * helper for them (see Phase 1 evidence / lib-13).
 */
import sodium from "libsodium-wrappers-sumo";

/** Best-effort zero of a module-owned buffer. */
export function bestEffortZero(bytes: Uint8Array): void {
	if (bytes.length > 0) sodium.memzero(bytes);
}

/** Best-effort zero of all module-owned buffers in a list. */
export function bestEffortZeroAll(chunks: readonly Uint8Array[]): void {
	for (const chunk of chunks) bestEffortZero(chunk);
}

/** Concatenates fresh copies into one new buffer owned by the caller. */
export function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
