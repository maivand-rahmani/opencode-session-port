/**
 * Bounded-memory streaming serialization of a complete `CheckpointPayload`.
 *
 * Purpose: the eager path (`serializeCheckpointPayload` -> `encodeJson`)
 * materializes a second full payload snapshot, one whole-payload JSON string,
 * and one whole-payload `Uint8Array`. For a large checkpoint that spike is
 * what fails on long sessions. This module emits the exact same bytes as an
 * async sequence so the crypto `seal(ByteSource, ...)` boundary can consume
 * them incrementally.
 *
 * Exactness guarantee: the concatenation of every yielded chunk is
 * byte-for-byte identical to
 * `new TextEncoder().encode(JSON.stringify(snapshotJsonValue(payload)))` (the
 * eager `encodeJson` result). Key order, compact separators, JSON escaping
 * (including lone-surrogate escapes), and number formatting are preserved
 * because each record is snapshotted and stringified with the same canonical
 * helpers, and only code-point-aligned text slices are encoded. If a single
 * code point's UTF-8 encoding is larger than a caller-supplied `chunkBytes`
 * (only possible for very small chunk sizes), its encoded bytes are split
 * across chunks; the byte stream itself is unchanged.
 *
 * Memory bound: the generator never holds the whole payload's JSON text.
 * Each session `info` object, each message object, and each extra envelope
 * value is snapshotted with `snapshotJsonValue` and stringified one at a time.
 * The largest transient is one record snapshot + that record's JSON string +
 * one output chunk (plus the pending text buffer, bounded by `chunkBytes`).
 *
 * Validation is streaming and fail-closed: malformed envelopes and non-JSON
 * values surface as `TypeError` from `snapshotJsonValue` (or the envelope
 * checks) while chunks are being pulled. A consumer that throws away the
 * artifact on generator failure (the seal boundary) therefore never persists
 * partial output.
 *
 * Cross-record note: the collector payload is already a detached snapshot, so
 * records are snapshotted independently here. A shared object appearing in two
 * records is serialized twice, exactly as eager snapshotting would (the eager
 * traversal only rejects cycles along the active path, not aliases). Aliasing
 * between independently snapshotted records is deliberately not treated as a
 * cycle; a self-referential record still rejects inside its own snapshot.
 *
 * Evidence boundary: exactness and chunk bounds are supported by unit tests
 * only. This module makes no container, host, container-memory, or
 * crypto-boundary claim; wiring it to `seal` and measuring RSS on a real
 * checkpoint is separate work.
 */

import { snapshotJsonValue, type CheckpointPayload } from "../contracts/index.ts";
import { isJsonObject } from "./guards.ts";

/** Options for `serializeCheckpointPayloadChunks`. */
export interface SerializeCheckpointPayloadChunksOptions {
	/** Maximum bytes per yielded chunk. Implementation buffer size, not a policy cap. */
	readonly chunkBytes?: number;
}

/** Default output chunk size: 64 KiB. */
const DEFAULT_CHUNK_BYTES = 64 * 1024;

/** Matches a canonical non-negative array index key (no leading zeros). */
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;

/** One own enumerable string-keyed data property of an envelope object. */
type EnvelopeEntry = readonly [key: string, value: unknown];

/**
 * Streams the checkpoint payload as bounded UTF-8 chunks. Validation and
 * serialization are lazy (like any async generator): errors reject the
 * iteration, not the call.
 */
export async function* serializeCheckpointPayloadChunks(
	payload: CheckpointPayload,
	options: SerializeCheckpointPayloadChunksOptions = {},
): AsyncGenerator<Uint8Array> {
	const chunkBytes = options?.chunkBytes ?? DEFAULT_CHUNK_BYTES;
	if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
		throw new TypeError(`chunkBytes must be a positive safe integer, received ${String(chunkBytes)}`);
	}

	const writer = new ChunkWriter(chunkBytes);
	for (const chunk of emitCheckpointPayload(writer, payload)) yield chunk;
	for (const chunk of writer.finish()) yield chunk;
}

/** Emits the top-level payload envelope, preserving own-key order. */
function* emitCheckpointPayload(writer: ChunkWriter, payload: unknown): Generator<Uint8Array> {
	const entries = readEnvelopeEntries(payload, "$", "Checkpoint payload");
	if (!entries.some(([key]) => key === "sessions")) {
		throw new TypeError('Checkpoint payload is missing the required "sessions" array at $.sessions');
	}

	for (const chunk of writer.write("{")) yield chunk;
	for (let index = 0; index < entries.length; index++) {
		if (index > 0) {
			for (const chunk of writer.write(",")) yield chunk;
		}
		const [key, value] = entries[index]!;
		for (const chunk of writer.write(`${JSON.stringify(key)}:`)) yield chunk;

		if (key === "sessions") {
			const sessions = readEnvelopeArray(value, "$.sessions", "Checkpoint sessions");
			for (const chunk of writer.write("[")) yield chunk;
			for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex++) {
				if (sessionIndex > 0) {
					for (const chunk of writer.write(",")) yield chunk;
				}
				for (const chunk of emitSessionRecord(writer, sessions[sessionIndex], `$.sessions[${sessionIndex}]`)) {
					yield chunk;
				}
			}
			for (const chunk of writer.write("]")) yield chunk;
			continue;
		}

		for (const chunk of writer.write(recordJsonText(value, `$[${JSON.stringify(key)}]`))) yield chunk;
	}
	for (const chunk of writer.write("}")) yield chunk;
}

/**
 * Emits one session record envelope. `info` and `messages` are special-cased so
 * each message is snapshotted/stringified independently instead of
 * materializing the whole session; every other own key is still emitted in
 * order, so the bytes stay identical to eager serialization even for records
 * with additional fields or a reordered `info`/`messages` pair.
 */
function* emitSessionRecord(writer: ChunkWriter, session: unknown, path: string): Generator<Uint8Array> {
	const entries = readEnvelopeEntries(session, path, "Session record");
	let hasInfo = false;
	let hasMessages = false;
	for (const [key] of entries) {
		if (key === "info") hasInfo = true;
		else if (key === "messages") hasMessages = true;
	}
	if (!hasInfo) throw new TypeError(`Session record is missing an info object at ${path}.info`);
	if (!hasMessages) throw new TypeError(`Session record is missing a messages array at ${path}.messages`);

	for (const chunk of writer.write("{")) yield chunk;
	for (let index = 0; index < entries.length; index++) {
		if (index > 0) {
			for (const chunk of writer.write(",")) yield chunk;
		}
		const [key, value] = entries[index]!;
		for (const chunk of writer.write(`${JSON.stringify(key)}:`)) yield chunk;

		if (key === "info") {
			if (!isJsonObject(value)) {
				throw new TypeError(`Session info must be a non-array object at ${path}.info`);
			}
			for (const chunk of writer.write(recordJsonText(value, `${path}.info`))) yield chunk;
			continue;
		}

		if (key === "messages") {
			const messages = readEnvelopeArray(value, `${path}.messages`, "Session messages");
			for (const chunk of writer.write("[")) yield chunk;
			for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
				if (messageIndex > 0) {
					for (const chunk of writer.write(",")) yield chunk;
				}
				const message = messages[messageIndex];
				if (!isJsonObject(message)) {
					throw new TypeError(`Message record must be a non-array object at ${path}.messages[${messageIndex}]`);
				}
				for (const chunk of writer.write(recordJsonText(message, `${path}.messages[${messageIndex}]`))) {
					yield chunk;
				}
			}
			for (const chunk of writer.write("]")) yield chunk;
			continue;
		}

		for (const chunk of writer.write(recordJsonText(value, `${path}[${JSON.stringify(key)}]`))) yield chunk;
	}
	for (const chunk of writer.write("}")) yield chunk;
}

/** Snapshots and stringifies one independent record/value, asserting text output. */
function recordJsonText(value: unknown, path: string): string {
	const snapshot = snapshotJsonValue(value, path);
	const text = JSON.stringify(snapshot);
	if (typeof text !== "string") throw new TypeError(`JSON.stringify did not produce text at ${path}`);
	return text;
}

/**
 * Reads an envelope object's own enumerable string data properties in
 * `Reflect.ownKeys` order, mirroring `snapshotJsonValue`'s object rules without
 * copying values (records are snapshotted separately). Only plain and
 * null-prototype objects are accepted, matching eager snapshot behavior.
 */
function readEnvelopeEntries(value: unknown, path: string, label: string): EnvelopeEntry[] {
	if (!isJsonObject(value)) {
		throw new TypeError(`${label} must be a non-array object at ${path}`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`Non-plain object at ${path}`);
	}

	const entries: EnvelopeEntry[] = [];
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") throw new TypeError(`Symbol property at ${path}`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) {
			throw new TypeError(`Non-enumerable or accessor property at ${path}[${JSON.stringify(key)}]`);
		}
		entries.push([key, descriptor.value]);
	}
	return entries;
}

/**
 * Validates an envelope array with `snapshotJsonValue`'s array rules (plain or
 * null-prototype array, dense canonical indexes, no extra properties) and
 * returns it for element-by-element streaming. The elements themselves are
 * snapshotted only when their turn comes.
 */
function readEnvelopeArray(value: unknown, path: string, label: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${label} must be an array at ${path}`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Array.prototype && prototype !== null) {
		throw new TypeError(`Non-plain array at ${path}`);
	}

	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (!Number.isSafeInteger(length) || length < 0) throw new TypeError(`Invalid array length at ${path}`);

	let presentEntries = 0;
	for (const key of Reflect.ownKeys(value)) {
		if (key === "length") continue;
		if (typeof key !== "string" || !ARRAY_INDEX_PATTERN.test(key)) {
			throw new TypeError(`Non-JSON array property at ${path}`);
		}
		const index = Number(key);
		if (!Number.isSafeInteger(index) || index >= length) {
			throw new TypeError(`Unsupported array entry at ${path}[${key}]`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) {
			throw new TypeError(`Accessor or hidden array entry at ${path}[${key}]`);
		}
		presentEntries++;
	}
	if (presentEntries !== length) throw new TypeError(`Sparse array at ${path}`);

	return value;
}

/** True for a high-surrogate UTF-16 code unit. */
function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/** True for a low-surrogate UTF-16 code unit. */
function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Number of UTF-16 code units in the code point at `index` (1 or 2). */
function codePointUnitsAt(text: string, index: number): number {
	return isHighSurrogate(text.charCodeAt(index)) &&
		index + 1 < text.length &&
		isLowSurrogate(text.charCodeAt(index + 1))
		? 2
		: 1;
}

/**
 * Buffers UTF-8 text and yields non-empty chunks of at most `chunkBytes`
 * bytes. Text is only ever cut at code-point boundaries so `TextEncoder` never
 * substitutes U+FFFD at a slice edge; when one encoded code point is bigger
 * than the chunk budget, its encoded bytes are split instead (the stream is
 * still the exact concatenation of the eager encoding).
 */
class ChunkWriter {
	private readonly encoder = new TextEncoder();
	private pending = "";
	private pendingBytes = 0;

	constructor(private readonly chunkBytes: number) {}

	/** Appends text, yielding any chunks completed by it. */
	*write(text: string): Generator<Uint8Array> {
		let index = 0;
		while (index < text.length) {
			const capacity = this.chunkBytes - this.pendingBytes;
			if (capacity === 0) {
				const chunk = this.takePending();
				if (chunk !== undefined) yield chunk;
				continue;
			}

			const fit = this.fitPrefix(text, index, capacity);
			if (fit === undefined) {
				// The next code point does not fit the remaining buffer. Flush first
				// (with a full budget a code point almost always fits), then, only if
				// it still cannot fit, split its encoded bytes.
				if (this.pendingBytes > 0) {
					const chunk = this.takePending();
					if (chunk !== undefined) yield chunk;
					continue;
				}
				const units = codePointUnitsAt(text, index);
				const encoded = this.encoder.encode(text.slice(index, index + units));
				for (let offset = 0; offset < encoded.byteLength; offset += this.chunkBytes) {
					yield encoded.subarray(offset, Math.min(offset + this.chunkBytes, encoded.byteLength));
				}
				index += units;
				continue;
			}

			this.pending += text.slice(index, fit.end);
			this.pendingBytes += fit.encoded.byteLength;
			index = fit.end;
		}
	}

	/** Yields the final buffered chunk, if any. */
	*finish(): Generator<Uint8Array> {
		const chunk = this.takePending();
		if (chunk !== undefined) yield chunk;
	}

	/**
	 * Finds the longest code-point-aligned prefix starting at `start` whose
	 * UTF-8 encoding fits `capacity`, or `undefined` when not even one code
	 * point fits.
	 */
	private fitPrefix(
		text: string,
		start: number,
		capacity: number,
	): { end: number; encoded: Uint8Array } | undefined {
		let end = start + Math.min(text.length - start, capacity);
		if (
			end < text.length &&
			isHighSurrogate(text.charCodeAt(end - 1)) &&
			isLowSurrogate(text.charCodeAt(end))
		) {
			end--;
		}
		if (end > start) {
			const encoded = this.encoder.encode(text.slice(start, end));
			if (encoded.byteLength <= capacity) return { end, encoded };
		}

		if (capacity < 3) return undefined;

		// JSON text has no unescaped lone surrogates (JSON.stringify escapes
		// them) and a valid surrogate pair is 4 bytes for 2 code units, so every
		// code unit contributes at most 3 UTF-8 bytes. This prefix therefore
		// always fits; verify with one encode rather than looping downward.
		let conservativeEnd = start + Math.max(1, Math.floor(capacity / 3));
		if (conservativeEnd > text.length) conservativeEnd = text.length;
		if (
			conservativeEnd < text.length &&
			isHighSurrogate(text.charCodeAt(conservativeEnd - 1)) &&
			isLowSurrogate(text.charCodeAt(conservativeEnd))
		) {
			conservativeEnd--;
		}
		if (conservativeEnd <= start) return undefined;

		const encoded = this.encoder.encode(text.slice(start, conservativeEnd));
		if (encoded.byteLength > capacity) return undefined;
		return { end: conservativeEnd, encoded };
	}

	/** Encodes and clears the pending text; returns `undefined` when empty. */
	private takePending(): Uint8Array | undefined {
		if (this.pending.length === 0) return undefined;
		const bytes = this.encoder.encode(this.pending);
		this.pending = "";
		this.pendingBytes = 0;
		return bytes;
	}
}
