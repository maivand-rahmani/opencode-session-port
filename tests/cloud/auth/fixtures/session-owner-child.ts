/**
 * Actual-child-process fixture for the session-owner tests.
 *
 * Synthetic test directories only. The fixture never touches a real vault,
 * credential, host session, or product state path. It prints fixed status
 * tokens only; raw errors and paths are never emitted.
 */
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	acquireSessionOwner,
	SessionOwnerError,
	type SessionOwner,
} from "../../../../src/cloud/auth/session-owner.ts";

type Mode = "hold" | "hold-forever" | "corrupt-nonce" | "extra-file";

function readArgument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1 || index + 1 >= process.argv.length) return undefined;
	return process.argv[index + 1];
}

function writeLine(line: string): void {
	process.stdout.write(`${line}\n`);
}

function errorCode(error: unknown): string {
	return error instanceof SessionOwnerError ? error.code : "unexpected";
}

async function waitForStdinEnd(): Promise<void> {
	process.stdin.resume();
	await new Promise<void>((resolvePromise) => {
		process.stdin.once("end", resolvePromise);
	});
}

async function findLockDirectory(stateDirectory: string): Promise<string> {
	const entries = await readdir(stateDirectory, { withFileTypes: true });
	const directories = entries.filter((entry) => entry.isDirectory());
	if (directories.length !== 1) throw new Error("unexpected lock directory count");
	return join(stateDirectory, directories[0]!.name);
}

async function findNonceFile(lockDirectory: string): Promise<string> {
	const entries = await readdir(lockDirectory);
	if (entries.length !== 1) throw new Error("unexpected lock contents");
	return join(lockDirectory, entries[0]!);
}

async function run(): Promise<number> {
	const stateDirectory = readArgument("--state-directory");
	const mode = (readArgument("--mode") ?? "hold") as Mode;
	if (stateDirectory === undefined) {
		writeLine("ERROR:missing-state-directory");
		return 2;
	}

	let owner: SessionOwner;
	try {
		owner = await acquireSessionOwner({ stateDirectory });
	} catch (error) {
		writeLine(`ERROR:${errorCode(error)}`);
		return 2;
	}
	const stdinEnd = mode === "hold" ? waitForStdinEnd() : Promise.resolve();
	writeLine("ACQUIRED");

	if (mode === "hold-forever") {
		setInterval(() => undefined, 1_000);
		await new Promise<void>(() => undefined);
		return 0;
	}

	if (mode === "corrupt-nonce") {
		const lockDirectory = await findLockDirectory(stateDirectory);
		const nonceFile = await findNonceFile(lockDirectory);
		await writeFile(nonceFile, "f".repeat(64), { mode: 0o600 });
	}

	if (mode === "extra-file") {
		const lockDirectory = await findLockDirectory(stateDirectory);
		await writeFile(join(lockDirectory, "unexpected-entry"), "x", { mode: 0o600 });
	}

	if (mode === "corrupt-nonce" || mode === "extra-file") {
		try {
			await owner.release();
			writeLine("RELEASE-SUCCESS");
		} catch (error) {
			writeLine(`RELEASE-ERROR:${errorCode(error)}`);
		}
		return 0;
	}

	await stdinEnd;
	try {
		await owner.release();
		writeLine("RELEASED");
	} catch (error) {
		writeLine(`RELEASE-ERROR:${errorCode(error)}`);
		return 3;
	}
	try {
		await owner.release();
		writeLine("SECOND-RELEASE-OK");
	} catch (error) {
		writeLine(`RELEASE-ERROR:${errorCode(error)}`);
		return 3;
	}
	return 0;
}

run().then(
	(code) => {
		process.exitCode = code;
	},
	(error) => {
		writeLine(`ERROR:${errorCode(error)}`);
		process.exitCode = 3;
	},
);
