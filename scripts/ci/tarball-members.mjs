/**
 * Minimal bounded reader for a single member of a gzipped tar archive.
 *
 * Reads `package/package.json` straight from the bytes — no disk extraction,
 * so member path traversal and symlink tricks cannot touch the filesystem.
 * The archive is digest-bound before use (release validation). Member names
 * with traversal shapes, non-regular-file targets, malformed sizes, and
 * decompression bombs (bounded output) are rejected fail-closed.
 */
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const MAX_TAR_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;

function readCString(buffer, offset, length) {
	let end = offset;
	const limit = Math.min(offset + length, buffer.length);
	while (end < limit && buffer[end] !== 0) end += 1;
	return buffer.toString("utf8", offset, end);
}

function isUnsafeMemberName(name) {
	if (name === "") return false;
	if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return true;
	return name.split(/[\\/]/).includes("..");
}

export function readGzippedTarEntry(gzBytes, wantedName) {
	if (gzBytes === null || typeof gzBytes !== "object" || typeof gzBytes.length !== "number") {
		return { ok: false, error: "tarball bytes must be a byte buffer" };
	}
	const buffer = Buffer.isBuffer(gzBytes) ? gzBytes : Buffer.from(gzBytes);
	if (buffer.length < 3 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
		return { ok: false, error: "exact.tgz is not gzip data" };
	}
	let tar;
	try {
		tar = gunzipSync(buffer, { maxOutputLength: MAX_TAR_BYTES });
	} catch (error) {
		return {
			ok: false,
			error: `exact.tgz could not be decompressed within bounds: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	let offset = 0;
	let entries = 0;
	while (true) {
		if (tar.length - offset < BLOCK_SIZE) {
			return { ok: false, error: `tarball ended on a partial header before ${wantedName}` };
		}
		const header = tar.subarray(offset, offset + BLOCK_SIZE);
		if (header.every((byte) => byte === 0)) {
			return { ok: false, error: `tarball ended before ${wantedName}` };
		}
		entries += 1;
		if (entries > MAX_ENTRIES) return { ok: false, error: "tarball has too many members" };
		const name = readCString(header, 0, 100);
		const prefix = readCString(header, 345, 155);
		const fullName = prefix === "" ? name : `${prefix}/${name}`;
		if (isUnsafeMemberName(fullName)) {
			return { ok: false, error: `tarball member has an unsafe path: ${JSON.stringify(fullName)}` };
		}
		const sizeRaw = readCString(header, 124, 12).trim();
		if (sizeRaw === "" || !/^[0-7]+$/.test(sizeRaw)) {
			return { ok: false, error: `tarball member size is malformed for ${JSON.stringify(fullName)}` };
		}
		const size = Number.parseInt(sizeRaw, 8);
		if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TAR_BYTES) {
			return { ok: false, error: `tarball member size is out of bounds for ${JSON.stringify(fullName)}` };
		}
		const dataStart = offset + BLOCK_SIZE;
		const dataEnd = dataStart + size;
		if (dataEnd > tar.length) {
			return { ok: false, error: `tarball is truncated at member ${JSON.stringify(fullName)}` };
		}
		if (fullName === wantedName) {
			const typeflag = header[156];
			const regular = typeflag === 0x30 || typeflag === 0x00 || typeflag === 0x37;
			if (!regular) {
				return {
					ok: false,
					error: `${wantedName} is not a regular file in the tarball (typeflag ${JSON.stringify(String.fromCharCode(typeflag))})`,
				};
			}
			return { ok: true, content: tar.subarray(dataStart, dataEnd) };
		}
		offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
	}
}
