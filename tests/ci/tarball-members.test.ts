import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { readGzippedTarEntry } from "../../scripts/ci/tarball-members.mjs";

/**
 * Synthetic tests for the bounded single-member tar reader used to verify the
 * packed package identity without disk extraction. Fixtures are built in
 * memory; no filesystem, no network.
 */

function octal(value: number, width: number): string {
	return value.toString(8).padStart(width - 1, "0") + "\u0000";
}

function tarHeader(name: string, size: number, typeflag: string): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000644\u0000", 100, 8, "utf8");
	header.write(octal(0, 8), 108, 8, "utf8");
	header.write(octal(0, 8), 116, 8, "utf8");
	header.write(octal(size, 12), 124, 12, "utf8");
	header.write(octal(0, 12), 136, 12, "utf8");
	header.write("        ", 148, 8, "utf8");
	header.write(typeflag, 156, 1, "utf8");
	header.write("ustar\u000000", 257, 8, "utf8");
	return header;
}

function buildTar(entries: Array<{ name: string; content?: string; typeflag?: string }>): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const content = Buffer.from(entry.content ?? "", "utf8");
		blocks.push(tarHeader(entry.name, content.length, entry.typeflag ?? "0"));
		if (content.length > 0) {
			blocks.push(content);
			const padding = (512 - (content.length % 512)) % 512;
			if (padding > 0) blocks.push(Buffer.alloc(padding));
		}
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

const packedJson = JSON.stringify({ name: "opencode-session-port", version: "0.1.6" });

describe("readGzippedTarEntry", () => {
	test("reads package/package.json after skipping earlier members", () => {
		const tar = buildTar([
			{ name: "package/tui.ts", content: "export {};" },
			{ name: "package/package.json", content: packedJson },
			{ name: "package/src/tui.ts", content: "export {};" },
		]);
		const result = readGzippedTarEntry(gzipSync(tar), "package/package.json");
		expect(result.ok).toBe(true);
		expect(JSON.parse(result.content.toString("utf8"))).toEqual({ name: "opencode-session-port", version: "0.1.6" });
	});

	test("rejects a symlink standing in for the wanted member", () => {
		const tar = buildTar([{ name: "package/package.json", typeflag: "2" }]);
		const result = readGzippedTarEntry(gzipSync(tar), "package/package.json");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not a regular file");
	});

	test("rejects unsafe member names anywhere in the walk", () => {
		const tar = buildTar([
			{ name: "../evil.txt", content: "x" },
			{ name: "package/package.json", content: packedJson },
		]);
		const result = readGzippedTarEntry(gzipSync(tar), "package/package.json");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unsafe path");
	});

	test("fails when the member is missing", () => {
		const tar = buildTar([{ name: "package/tui.ts", content: "export {};" }]);
		const result = readGzippedTarEntry(gzipSync(tar), "package/package.json");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("ended before");
	});

	test("rejects non-gzip bytes", () => {
		const result = readGzippedTarEntry(Buffer.from("not a gzip stream at all"), "package/package.json");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not gzip data");
	});

	test("rejects gzip data that is not a tar archive", () => {
		const result = readGzippedTarEntry(gzipSync(Buffer.from("hello world")), "package/package.json");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("partial header");
	});

	test("rejects a truncated member body", () => {
		const truncated = Buffer.concat([tarHeader("package/package.json", 100, "0"), Buffer.from("short")]);
		const result = readGzippedTarEntry(gzipSync(truncated), "package/package.json");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("truncated");
	});
});
