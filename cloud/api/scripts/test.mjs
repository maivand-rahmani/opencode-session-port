#!/usr/bin/env node
/**
 * Minimal explicit Node test runner for the API workspace.
 *
 * Discovery is intentionally narrow: only files ending in `.node.ts` below
 * `./test/` are executed, recursively, in sorted order. Bun-style `.test` /
 * `.spec` suffixes and every other extension are ignored so the root Bun test
 * script never picks cloud/API tests up implicitly. An empty discovery set is
 * a failure, never a silent pass. The child is run with the current Node
 * executable plus `--import tsx --test`; stdout/stderr are capped and the run
 * is time-bounded. No environment variables are mutated.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.join(API_ROOT, "test");
const TEST_TIMEOUT_MS = 300_000;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 5_000;

const compareNames = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export function isNodeTestFile(filePath) {
	const base = filePath.replaceAll("\\", "/").split("/").pop() ?? "";
	if (!base.endsWith(".node.ts")) return false;
	const stem = base.slice(0, -".node.ts".length);
	if (stem.length === 0) return false;
	// Reject embedded Bun-style `.test` / `.spec` suffixes such as
	// `health.test.node.ts` while accepting names like `health.node.ts`.
	return !/(^|[._-])(?:test|spec)(?=$|[._-])/i.test(stem);
}

export function collectNodeTestFiles(directory) {
	const files = [];
	const walk = (current) => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		entries.sort((left, right) => compareNames(left.name, right.name));
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile() && isNodeTestFile(entry.name)) {
				files.push(fullPath);
			}
		}
	};
	walk(directory);
	return files.sort(compareNames);
}

function createBoundedOutput(stream) {
	const chunks = [];
	let size = 0;
	let truncated = false;
	return {
		write(chunk) {
			if (truncated) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const remaining = OUTPUT_LIMIT_BYTES - size;
			if (buffer.length > remaining) {
				if (remaining > 0) {
					chunks.push(buffer.subarray(0, remaining));
					size += remaining;
				}
				truncated = true;
				return;
			}
			chunks.push(buffer);
			size += buffer.length;
		},
		flush() {
			if (size > 0) stream.write(Buffer.concat(chunks, size));
			if (truncated) stream.write(`\n[api-test] output truncated at ${OUTPUT_LIMIT_BYTES} bytes\n`);
		},
	};
}

function main() {
	const files = collectNodeTestFiles(TEST_ROOT);
	if (files.length === 0) {
		process.stderr.write(
			`[api-test] no ./test/**/*.node.ts files found under ${TEST_ROOT}; failing instead of passing an empty suite\n`,
		);
		process.exitCode = 1;
		return;
	}

	process.stdout.write(`[api-test] running ${files.length} explicit Node test file(s)\n`);
	for (const file of files) {
		process.stdout.write(`[api-test]   ${path.relative(API_ROOT, file)}\n`);
	}

	const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
		cwd: API_ROOT,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const stdout = createBoundedOutput(process.stdout);
	const stderr = createBoundedOutput(process.stderr);
	let settled = false;
	let timedOut = false;
	let deadline;
	let killTimer;

	const finalize = (code, signal) => {
		if (settled) return;
		settled = true;
		if (deadline !== undefined) clearTimeout(deadline);
		if (killTimer !== undefined) clearTimeout(killTimer);
		stdout.flush();
		stderr.flush();
		if (timedOut) {
			process.stderr.write(`[api-test] timed out after ${TEST_TIMEOUT_MS}ms; child terminated\n`);
			process.exitCode = 1;
			return;
		}
		if (signal) {
			process.stderr.write(`[api-test] test process ended by signal ${signal}\n`);
			process.exitCode = 1;
			return;
		}
		if (typeof code === "number" && code !== 0) {
			process.stderr.write(`[api-test] test process exited with code ${code}\n`);
		}
		process.exitCode = typeof code === "number" ? code : 1;
	};

	child.stdout.on("data", (chunk) => stdout.write(chunk));
	child.stderr.on("data", (chunk) => stderr.write(chunk));
	child.on("error", (error) => {
		if (settled) return;
		process.stderr.write(`[api-test] failed to start child process: ${error.message}\n`);
		finalize(null, null);
	});
	child.on("close", (code, signal) => finalize(code, signal));

	deadline = setTimeout(() => {
		timedOut = true;
		process.stderr.write(`[api-test] timeout after ${TEST_TIMEOUT_MS}ms; terminating child\n`);
		child.kill("SIGKILL");
		killTimer = setTimeout(() => {
			process.stderr.write(`[api-test] child did not exit within ${KILL_GRACE_MS}ms; exiting\n`);
			process.exit(1);
		}, KILL_GRACE_MS);
	}, TEST_TIMEOUT_MS);
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedDirectly) main();
