/**
 * Child mode of the Windows-only KDF diagnostic harness.
 *
 * Spawned by `supervisor.ts` as the *same source file* in child mode
 * (`bun <repo>/scripts/crypto-benchmark/supervisor.ts --child --ops <n> --memory-mib <n>`);
 * no runtime staging or temp files are involved. One fresh child process runs
 * exactly one synchronous Argon2id `crypto_pwhash` call at the diagnostic
 * candidate settings the supervisor requested (default 2 ops / 64 MiB, which
 * reproduces the earlier recorded diagnostic run). The supervisor captures the
 * child's pre-KDF working-set baseline, sends GO, polls the child's working set
 * while the call blocks this process, then reads the lifetime peak after exit.
 *
 * Protocol (one JSON line per message on stdout; commands as lines on stdin):
 *   child -> supervisor: {"type":"ready", ...}      (after sodium.ready + byte prep)
 *   supervisor -> child: GO
 *   child -> supervisor: {"type":"sample", ...}     (after the timed KDF call)
 *   supervisor -> child: EXIT
 *
 * Safety:
 * - The requested ops/memory are CLI-validated against harness input guards and
 *   echoed in READY; the supervisor fail-closes if they do not match its request.
 * - Synthetic password/salt are generated in memory only, never printed or
 *   persisted, and best-effort zeroed (sodium.memzero). No secure-deletion claim.
 * - No files, no network, no session data, no production crypto parameters.
 * - The ops/memory values are diagnostic candidate inputs, NOT a selected profile.
 *
 * Do not run this module directly; it is invoked by the supervisor in child mode.
 */

import sodium from "libsodium-wrappers-sumo";
import { parseChildSettingsArgs, UsageError } from "./args.ts";
import {
	CHILD_PROTOCOL_VERSION,
	type ChildReadyMessage,
	type ChildSampleMessage,
} from "./protocol.ts";
import {
	KDF_ALGORITHM,
	KDF_FUNCTION,
	KDF_OUTPUT_BYTES,
	KDF_PASSWORD_BYTES,
	LIBSODIUM_PACKAGE_ID,
} from "./settings.ts";

async function writeLine(text: string): Promise<void> {
	// Awaiting the write guarantees the line is flushed before any later exit.
	await Bun.write(Bun.stdout, `${text}\n`);
}

async function* readStdinLines(): AsyncGenerator<string> {
	const reader = Bun.stdin.stream().getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				yield line.trim();
			}
		}
		const rest = buffer.trim();
		if (rest.length > 0) {
			yield rest;
		}
	} finally {
		reader.releaseLock();
	}
}

export async function runChildMode(argv: readonly string[]): Promise<number> {
	let opsLimit: number;
	let memoryLimitBytes: number;
	try {
		const settings = parseChildSettingsArgs(argv);
		opsLimit = settings.opsLimit;
		memoryLimitBytes = settings.memoryLimitMiB * 1024 * 1024;
	} catch (error) {
		if (error instanceof UsageError) {
			try {
				await writeLine(JSON.stringify({ type: "error", message: error.message }));
			} catch {
				// supervisor is gone; nothing left to report to
			}
			return 1;
		}
		throw error;
	}

	await sodium.ready;

	if (sodium.crypto_pwhash_ALG_ARGON2ID13 !== 2) {
		throw new Error(`unexpected crypto_pwhash_ALG_ARGON2ID13: ${sodium.crypto_pwhash_ALG_ARGON2ID13}`);
	}

	const password = sodium.randombytes_buf(KDF_PASSWORD_BYTES);
	const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
	try {
		const ready: ChildReadyMessage = {
			type: "ready",
			protocol: CHILD_PROTOCOL_VERSION,
			pid: process.pid,
			settings: {
				function: KDF_FUNCTION,
				algorithm: KDF_ALGORITHM,
				algorithmId: sodium.crypto_pwhash_ALG_ARGON2ID13,
				opsLimit,
				memoryLimitBytes,
				outputBytes: KDF_OUTPUT_BYTES,
			},
			versions: {
				bun: process.versions.bun ?? "unknown",
				nodeCompat: process.versions.node,
				libsodiumPackage: LIBSODIUM_PACKAGE_ID,
				libsodiumVersionString: sodium.SODIUM_VERSION_STRING,
			},
		};
		await writeLine(JSON.stringify(ready));

		const lines = readStdinLines();
		const go = await lines.next();
		if (go.done || go.value !== "GO") {
			return 2; // supervisor went away before GO; no KDF work was done
		}

		// Timing scope: only the synchronous native call. sodium.ready, byte
		// preparation, and all reporting are outside this interval.
		const started = performance.now();
		const derived = sodium.crypto_pwhash(
			KDF_OUTPUT_BYTES,
			password,
			salt,
			opsLimit,
			memoryLimitBytes,
			sodium.crypto_pwhash_ALG_ARGON2ID13,
		);
		const finished = performance.now();

		if (!(derived instanceof Uint8Array) || derived.length !== KDF_OUTPUT_BYTES) {
			throw new Error("crypto_pwhash returned an unexpected result");
		}
		sodium.memzero(derived); // outside the timed interval

		const sample: ChildSampleMessage = { type: "sample", latencyMs: finished - started };
		await writeLine(JSON.stringify(sample));

		const exit = await lines.next();
		return exit.done || exit.value !== "EXIT" ? 3 : 0;
	} catch (error) {
		try {
			await writeLine(
				JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }),
			);
		} catch {
			// supervisor is gone; nothing left to report to
		}
		return 1;
	} finally {
		// Best-effort zeroing of harness-owned synthetic material (no guarantee claim).
		sodium.memzero(password);
		sodium.memzero(salt);
	}
}
