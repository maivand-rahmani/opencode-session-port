/**
 * TEST-ONLY RFC 1952 fixture builder for the strict gzip boundary tests.
 *
 * Members are assembled by hand (header + `node:zlib` raw deflate + trailer)
 * so optional header fields, FHCRC, CRC32, and ISIZE can be made valid or
 * deliberately corrupt. The decoder under test is the pako-based strict
 * decoder and never imports this module; fixtures intentionally use an
 * independent runtime path (`node:zlib` + a local CRC-32) so a shared
 * implementation bug cannot make a test vacuously pass.
 *
 * Synthetic in-memory data only; no filesystem, no host state.
 */
import { deflateRawSync } from "node:zlib";

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
	if (crcTable !== undefined) return crcTable;
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	crcTable = table;
	return table;
}

/** CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
	const table = getCrcTable();
	let c = 0xffffffff;
	for (let index = 0; index < bytes.length; index += 1) {
		c = (table[(c ^ bytes[index]!) & 0xff]! ^ (c >>> 8)) >>> 0;
	}
	return (c ^ 0xffffffff) >>> 0;
}

function u16le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff];
}

function u32le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export interface GzipCorruptOptions {
	/** Flip a bit in the stored FHCRC (header CRC16). */
	readonly fhcrc?: boolean;
	/** Flip a bit in the trailer CRC32 of the uncompressed data. */
	readonly crc32?: boolean;
	/** Flip a bit in the trailer ISIZE. */
	readonly isize?: boolean;
	/** Force BTYPE=3 (reserved/invalid) in the first deflate byte. */
	readonly invalidBlockType?: boolean;
	/** XOR mask applied to the first deflate byte. */
	readonly deflateByteXor?: number;
}

export interface GzipMemberOptions {
	readonly data: Uint8Array;
	readonly level?: number;
	readonly mtime?: number;
	readonly xfl?: number;
	readonly os?: number;
	/** FEXTRA payload (FEXTRA flag is set automatically). */
	readonly extra?: Uint8Array;
	/** FNAME string (FNAME flag is set automatically). */
	readonly name?: string;
	/** FCOMMENT string (FCOMMENT flag is set automatically). */
	readonly comment?: string;
	/** Include FHCRC (header CRC16). */
	readonly fhcrc?: boolean;
	readonly corrupt?: GzipCorruptOptions;
}

export interface BuiltGzipMember {
	readonly bytes: Uint8Array;
	/** Header length including optional fields and FHCRC when present. */
	readonly headerLength: number;
	readonly rawDeflateLength: number;
	/** Offset of the trailer CRC32 field. */
	readonly trailerOffset: number;
}

const encoder = new TextEncoder();

/** Builds one complete gzip member, optionally corrupt in controlled ways. */
export function buildGzipMember(options: GzipMemberOptions): BuiltGzipMember {
	const { data } = options;
	const level = options.level ?? 6;
	const mtime = options.mtime ?? 0;
	const xfl = options.xfl ?? 0;
	const os = options.os ?? 255;

	const raw = new Uint8Array(deflateRawSync(Buffer.from(data), { level }));
	if (options.corrupt?.invalidBlockType === true) {
		raw[0] = ((raw[0]! & 0xf8) | 0x07) & 0xff;
	} else if (options.corrupt?.deflateByteXor !== undefined) {
		raw[0] = (raw[0]! ^ options.corrupt.deflateByteXor) & 0xff;
	}

	let flags = 0;
	if (options.extra !== undefined) flags |= 0x04;
	if (options.name !== undefined) flags |= 0x08;
	if (options.comment !== undefined) flags |= 0x10;
	if (options.fhcrc === true) flags |= 0x02;

	const header: number[] = [0x1f, 0x8b, 0x08, flags, ...u32le(mtime), xfl & 0xff, os & 0xff];
	if (options.extra !== undefined) header.push(...u16le(options.extra.length), ...options.extra);
	if (options.name !== undefined) header.push(...encoder.encode(options.name), 0);
	if (options.comment !== undefined) header.push(...encoder.encode(options.comment), 0);

	const headerBytes = new Uint8Array(header);
	const fhcrcBytes = options.fhcrc === true ? 2 : 0;
	const headerLength = headerBytes.length + fhcrcBytes;

	let dataCrc = crc32(data);
	let isize = data.length >>> 0;
	if (options.corrupt?.crc32 === true) dataCrc = (dataCrc ^ 0x00000001) >>> 0;
	if (options.corrupt?.isize === true) isize = (isize ^ 0x00000001) >>> 0;

	const trailer = new Uint8Array(8);
	trailer.set(u32le(dataCrc), 0);
	trailer.set(u32le(isize), 4);

	const out = new Uint8Array(headerLength + raw.length + trailer.length);
	out.set(headerBytes, 0);
	let offset = headerBytes.length;
	if (options.fhcrc === true) {
		let hcrc = crc32(headerBytes) & 0xffff;
		if (options.corrupt?.fhcrc === true) hcrc = (hcrc ^ 0x0001) & 0xffff;
		out[offset] = hcrc & 0xff;
		out[offset + 1] = (hcrc >>> 8) & 0xff;
		offset += 2;
	}
	out.set(raw, offset);
	offset += raw.length;
	out.set(trailer, offset);

	return {
		bytes: out,
		headerLength,
		rawDeflateLength: raw.length,
		trailerOffset: out.length - 8,
	};
}

/** Concatenates gzip members and/or arbitrary suffix bytes into one stream. */
export function gzipStream(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
