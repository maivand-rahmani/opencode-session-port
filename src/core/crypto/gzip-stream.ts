/**
 * In-memory gzip streaming helpers.
 *
 * Compression still streams through `node:zlib` (fresh output buffers only).
 * Decompression is implemented over pako 3.0.2's public low-level inflate API
 * (`ZStream` with gzip-only `windowBits` 31 and the public `input`/`next_in`/
 * `avail_in`/`output`/`next_out`/`avail_out` fields; no private state, no deep
 * import, no magic-byte scanning) so member boundaries come from exact
 * consumed-input positions:
 *
 * - one or more complete RFC 1952 members are accepted;
 * - every byte after the final member rejects, including zero padding
 *   (owner-decided RFC 1952 §2.2 boundary policy);
 * - clean EOF is accepted only after at least one complete member;
 * - the decrypted gzip input is never materialized or copied: at most the
 *   current borrowed `ByteSource` chunk is retained, and it is released
 *   before the next chunk is pulled, so a producer (e.g. `decryptFrames`)
 *   may zero it as soon as the consumer advances;
 * - compressed bytes are counted and checked against `maxCompressedBytes`
 *   before each chunk is accepted/processed; output is checked against
 *   `maxDecompressedBytes` while decoding (a 1-byte probe at the cap
 *   boundary lets an exact fit still reach `Z_STREAM_END`);
 * - output stays private until every member/trailer, exact EOF and all caps
 *   pass; any failure returns nothing, and a success reports both the decoded
 *   bytes and the total compressed gzip byte count (the same counter the
 *   compressed cap is enforced against) so callers can apply expansion-ratio
 *   accounting over decrypted gzip bytes rather than envelope bytes;
 * - every initialized inflater is ended with a checked `zlibInflateEnd`; a
 *   teardown failure is surfaced only when no primary failure exists;
 * - a no-progress guard aborts instead of hanging.
 *
 * Ownership: borrowed source chunks are never mutated. Module-owned output
 * chunks and the inflater scratch buffer are best-effort zeroed on success
 * and failure; on success the concatenated result is owned by the caller.
 * This is not secure deletion (A-07).
 */
/// <reference types="node" />
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
	Z_BUF_ERROR,
	Z_DATA_ERROR,
	Z_MEM_ERROR,
	Z_NEED_DICT,
	Z_NO_FLUSH,
	Z_OK,
	Z_STREAM_END,
	Z_STREAM_ERROR,
	ZStream,
	zlibInflate,
	zlibInflateEnd,
	zlibInflateInit2,
} from "pako";
import type { ByteSource } from "../contracts/crypto.ts";
import { asCryptoContainerError, CryptoContainerError } from "./errors.ts";
import { bestEffortZero, bestEffortZeroAll, concatChunks } from "./zero.ts";

/**
 * Streams `source` through gzip and yields fresh output chunks. The producer
 * yields copies so callers may retain them per the borrowed-chunk contract.
 */
export async function* compressStream(
	source: ByteSource,
	level: number | undefined,
): AsyncGenerator<Uint8Array> {
	const gzip = level === undefined ? createGzip() : createGzip({ level });
	const input = Readable.from(source);
	const finished = pipeline(input, gzip);
	// Attach a handler immediately so an early consumer exit can never surface
	// as an unhandled rejection; the error is re-surfaced below when relevant.
	finished.catch(() => {});
	try {
		for await (const chunk of gzip) {
			yield Uint8Array.from(chunk as Uint8Array);
		}
		await finished;
	} finally {
		input.destroy();
		gzip.destroy();
		await finished.catch(() => {});
	}
}

function waitForDrain(stream: Writable): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			stream.off("drain", onDrain);
			stream.off("error", onError);
			stream.off("close", onClose);
		};
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onClose = () => {
			cleanup();
			reject(new CryptoContainerError("gzip-error", "gzip stream closed before it could drain"));
		};
		stream.on("drain", onDrain);
		stream.on("error", onError);
		stream.on("close", onClose);
	});
}

/** windowBits = 15 + 16 selects the gzip wrapper (RFC 1952) only. */
const GZIP_WINDOW_BITS = 31;

/** Upper bound for the inflater output scratch; smaller caps shrink it. */
const GUNZIP_OUTPUT_SCRATCH_BYTES = 64 * 1024;

/**
 * @internal TEST-ONLY seams for the strict gzip decoder. NOT part of the
 * public crypto contract; production callers must not pass them. The
 * `inflateEnd` override exists because `zlibInflateEnd` cannot naturally fail
 * for a validly initialized inflater, so teardown classification is
 * otherwise untestable.
 */
export interface GunzipDecoderTestSeams {
	readonly inflateEnd?: (strm: ZStream) => number;
}

function gzipStatusError(status: number, zlibMessage: string): CryptoContainerError {
	const detail = zlibMessage.length > 0 ? ` (${zlibMessage})` : "";
	if (status === Z_DATA_ERROR) {
		return new CryptoContainerError("gzip-error", `malformed gzip data (zlib status ${status}${detail})`);
	}
	if (status === Z_NEED_DICT) {
		return new CryptoContainerError(
			"gzip-error",
			`gzip stream requires an unsupported preset dictionary (zlib status ${status}${detail})`,
		);
	}
	if (status === Z_STREAM_ERROR) {
		return new CryptoContainerError("gzip-error", `gzip inflater state error (zlib status ${status}${detail})`);
	}
	if (status === Z_MEM_ERROR) {
		return new CryptoContainerError("gzip-error", `gzip inflater ran out of memory (zlib status ${status}${detail})`);
	}
	return new CryptoContainerError("gzip-error", `gzip inflater failed (zlib status ${status}${detail})`);
}

/**
 * Success result of a strict bounded gunzip decode. On failure nothing is
 * returned at all.
 */
export interface GunzipBoundedResult {
	/** Decoded payload bytes; ownership transfers to the caller on success. */
	readonly bytes: Uint8Array;
	/**
	 * Total decrypted compressed gzip bytes consumed across every member,
	 * counted with the same accumulator the `maxCompressedBytes` cap is
	 * enforced against. This is the correct denominator for expansion-ratio
	 * accounting (never total envelope bytes).
	 */
	readonly compressedBytes: number;
}

/**
 * Strictly decodes one or more complete gzip members from decrypted plaintext.
 *
 * Failure semantics: malformed/truncated members, any byte after the final
 * member (including zero padding), a missing member, a compressed-input cap
 * violation, a decompressed-output cap violation, an inflater teardown
 * failure, and any source error all reject; nothing is returned. The staged
 * output is best-effort zeroed on every path.
 *
 * Caps: `maxCompressedBytes` is a required positive safe integer checked
 * against every pulled chunk before it is accepted/processed (later chunks
 * are never pulled after a violation). `maxDecompressedBytes` is a
 * non-negative safe integer checked during decode across all members.
 *
 * @internal Exported for the crypto tests; NOT part of the public contract.
 */
export async function collectGunzipBounded(
	source: ByteSource,
	maxCompressedBytes: number,
	maxDecompressedBytes: number,
	seams?: GunzipDecoderTestSeams,
): Promise<GunzipBoundedResult> {
	if (!Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes < 1) {
		throw new CryptoContainerError("invalid-policy-definition", "maxCompressedBytes must be a positive safe integer");
	}
	if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes < 0) {
		throw new CryptoContainerError(
			"invalid-policy-definition",
			"maxDecompressedBytes must be a non-negative safe integer",
		);
	}

	const candidate: unknown = source;
	if (
		candidate === null ||
		typeof candidate !== "object" ||
		typeof (candidate as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function"
	) {
		throw new CryptoContainerError(
			"invalid-artifact-source",
			"compressed input must be an async iterable of byte chunks",
		);
	}
	const iterator = (candidate as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
	const inflateEnd = seams?.inflateEnd ?? zlibInflateEnd;

	const output: Uint8Array[] = [];
	// Bounded inflater scratch. It shrinks for small decompressed caps so the
	// cap is enforced by the buffer size where possible; at/over the cap a
	// 1-byte probe detects overflow without producing unbounded output.
	const scratch = new Uint8Array(Math.min(GUNZIP_OUTPUT_SCRATCH_BYTES, Math.max(1, maxDecompressedBytes)));

	// The current borrowed chunk and the offset of its first unconsumed byte.
	// `current` is the only compressed input retained; it is dropped before
	// the next pull so the producer may zero it as soon as it is advanced.
	let current: Uint8Array | undefined;
	let currentOffset = 0;
	let compressedBytes = 0;
	let decompressedBytes = 0;
	let sawMember = false;
	let sourceExhausted = false;

	const releaseCurrent = (): void => {
		current = undefined;
		currentOffset = 0;
	};

	/** Pulls one non-empty chunk; enforces the compressed cap before accepting it. */
	const pullChunk = async (): Promise<boolean> => {
		while (true) {
			const step = await iterator.next();
			if (step.done === true) {
				sourceExhausted = true;
				return false;
			}
			const value: unknown = step.value;
			if (!(value instanceof Uint8Array)) {
				throw new CryptoContainerError("gzip-error", "compressed source yielded a non-byte chunk");
			}
			if (value.length === 0) continue;
			const seen = compressedBytes + value.length;
			if (seen > maxCompressedBytes) {
				compressedBytes = seen;
				throw new CryptoContainerError(
					"compressed-limit-exceeded",
					"compressed gzip input exceeds the policy limit",
				);
			}
			compressedBytes = seen;
			current = value;
			currentOffset = 0;
			return true;
		}
	};

	/** Makes at least one unconsumed input byte available for a new member. */
	const prepareMemberInput = async (): Promise<boolean> => {
		if (current !== undefined && currentOffset < current.length) return true;
		releaseCurrent();
		return pullChunk();
	};

	/**
	 * Decodes exactly one member starting at the current position. Member end
	 * is the exact consumed-input position (`next_in` at `Z_STREAM_END`); any
	 * unconsumed suffix stays in the borrowed chunk for the next member or the
	 * trailing-byte check.
	 */
	const inflateMember = async (): Promise<void> => {
		const strm = new ZStream();
		let initialized = false;
		let memberComplete = false;
		let primaryFailure: unknown;

		try {
			const initStatus = zlibInflateInit2(strm, GZIP_WINDOW_BITS);
			if (initStatus !== Z_OK) {
				throw new CryptoContainerError(
					"gzip-error",
					`gzip inflater initialization failed (zlib status ${initStatus})`,
				);
			}
			initialized = true;
			strm.input = current!;
			strm.next_in = currentOffset;
			strm.avail_in = current!.length - currentOffset;

			while (true) {
				if (strm.avail_in === 0) {
					// The borrowed chunk is fully consumed; release it before
					// advancing so the producer may zero it.
					releaseCurrent();
					if (!(await pullChunk())) {
						throw new CryptoContainerError("gzip-error", "gzip stream ended inside a member");
					}
					strm.input = current!;
					strm.next_in = 0;
					strm.avail_in = current!.length;
				}

				const remainingOutput = maxDecompressedBytes - decompressedBytes;
				// At/over the cap, decode into a 1-byte probe: any produced byte
				// is an overflow; zero produced with Z_STREAM_END is an exact fit.
				const outSize = remainingOutput <= 0 ? 1 : Math.min(scratch.length, remainingOutput);
				strm.output = scratch;
				strm.next_out = 0;
				strm.avail_out = outSize;

				const availBefore = strm.avail_in;
				const status = zlibInflate(strm, Z_NO_FLUSH);
				const consumed = availBefore - strm.avail_in;
				const produced = outSize - strm.avail_out;

				if (produced > 0) {
					if (remainingOutput <= 0) {
						throw new CryptoContainerError(
							"decompressed-limit-exceeded",
							"decompressed payload exceeds the policy limit",
						);
					}
					decompressedBytes += produced;
					output.push(Uint8Array.from(scratch.subarray(0, produced)));
				}

				if (status === Z_STREAM_END) {
					currentOffset = strm.next_in;
					memberComplete = true;
					// `break` (not `return`) so the checked teardown below still
					// runs before this member is reported as complete.
					break;
				}
				if (status !== Z_OK && status !== Z_BUF_ERROR) {
					throw gzipStatusError(status, strm.msg);
				}
				if (consumed === 0 && produced === 0 && strm.avail_in > 0) {
					throw new CryptoContainerError(
						"gzip-error",
						`gzip inflater made no progress (zlib status ${status}); aborting to avoid a hang`,
					);
				}
			}
		} catch (error) {
			primaryFailure = error;
		} finally {
			if (initialized) {
				const endStatus = inflateEnd(strm);
				if (endStatus !== Z_OK && primaryFailure === undefined) {
					primaryFailure = new CryptoContainerError(
						"gzip-error",
						`gzip inflater teardown failed (zlib status ${endStatus})`,
					);
				}
			}
		}
		if (primaryFailure !== undefined) throw primaryFailure;
		if (!memberComplete) {
			// Defensive: the loop only exits via `break` at Z_STREAM_END.
			throw new CryptoContainerError("gzip-error", "gzip inflater did not reach the end of the member");
		}
	};

	try {
		while (true) {
			if (!(await prepareMemberInput())) break;
			await inflateMember();
			sawMember = true;
		}
		if (!sawMember) {
			throw new CryptoContainerError("gzip-error", "compressed input contains no complete gzip member");
		}
		return { bytes: concatChunks(output), compressedBytes };
	} catch (error) {
		throw asCryptoContainerError(error, "gzip-error", "gzip decompression failed");
	} finally {
		// Best-effort clear of every module-owned buffer on success and failure:
		// staged plaintext output and the inflater scratch. Borrowed chunks are
		// never cleared here.
		bestEffortZero(scratch);
		bestEffortZeroAll(output);
		if (!sourceExhausted && typeof iterator.return === "function") {
			// Aborted before EOF: let the producer close and release/zero the
			// borrowed chunk that may still be outstanding.
			await iterator.return(undefined).catch(() => {});
		}
	}
}
