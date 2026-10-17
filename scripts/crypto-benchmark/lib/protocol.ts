/**
 * Child/supervisor line protocol for the Windows-only KDF diagnostic harness.
 * Pure parsing/validation only; safe to unit test.
 *
 * Wire format: one JSON object per line on the child's stdout.
 * Commands (supervisor -> child stdin): "GO", then "EXIT".
 */

import { KDF_ALGORITHM, KDF_ALGORITHM_ID, KDF_FUNCTION, KDF_OUTPUT_BYTES } from "./settings.ts";

export const CHILD_PROTOCOL_VERSION = 1;

export interface ChildSettingsReport {
	function: string;
	algorithm: string;
	algorithmId: number;
	opsLimit: number;
	memoryLimitBytes: number;
	outputBytes: number;
}

export interface ChildVersionsReport {
	bun: string;
	/** `process.versions.node` as reported by Bun (Bun's Node-compatibility version, not system Node). */
	nodeCompat: string;
	libsodiumPackage: string;
	libsodiumVersionString: string;
}

export interface ChildReadyMessage {
	type: "ready";
	protocol: number;
	pid: number;
	settings: ChildSettingsReport;
	versions: ChildVersionsReport;
}

export interface ChildSampleMessage {
	type: "sample";
	/** Milliseconds around only the synchronous crypto_pwhash call (performance.now). */
	latencyMs: number;
}

export interface ChildErrorMessage {
	type: "error";
	message: string;
}

export type ChildMessage = ChildReadyMessage | ChildSampleMessage | ChildErrorMessage;

export function parseChildMessage(line: string): ChildMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error("child message is not valid JSON");
	}
	if (!isRecord(parsed) || typeof parsed.type !== "string") {
		throw new Error("child message is missing a string type");
	}
	switch (parsed.type) {
		case "ready": {
			if (typeof parsed.protocol !== "number" || typeof parsed.pid !== "number") {
				throw new Error("child ready message is missing protocol/pid");
			}
			if (!isRecord(parsed.settings) || !isRecord(parsed.versions)) {
				throw new Error("child ready message is missing settings/versions");
			}
			const settings = parsed.settings;
			for (const key of ["function", "algorithm"] as const) {
				if (typeof settings[key] !== "string") {
					throw new Error(`child ready settings.${key} must be a string`);
				}
			}
			for (const key of ["algorithmId", "opsLimit", "memoryLimitBytes", "outputBytes"] as const) {
				if (typeof settings[key] !== "number" || !Number.isFinite(settings[key])) {
					throw new Error(`child ready settings.${key} must be a finite number`);
				}
			}
			const versions = parsed.versions;
			for (const key of ["bun", "nodeCompat", "libsodiumPackage", "libsodiumVersionString"] as const) {
				if (typeof versions[key] !== "string") {
					throw new Error(`child ready versions.${key} must be a string`);
				}
			}
			return {
				type: "ready",
				protocol: parsed.protocol,
				pid: parsed.pid,
				settings: {
					function: settings.function as string,
					algorithm: settings.algorithm as string,
					algorithmId: settings.algorithmId as number,
					opsLimit: settings.opsLimit as number,
					memoryLimitBytes: settings.memoryLimitBytes as number,
					outputBytes: settings.outputBytes as number,
				},
				versions: {
					bun: versions.bun as string,
					nodeCompat: versions.nodeCompat as string,
					libsodiumPackage: versions.libsodiumPackage as string,
					libsodiumVersionString: versions.libsodiumVersionString as string,
				},
			};
		}
		case "sample": {
			if (typeof parsed.latencyMs !== "number" || !Number.isFinite(parsed.latencyMs) || parsed.latencyMs < 0) {
				throw new Error("child sample message latencyMs must be a finite non-negative number");
			}
			return { type: "sample", latencyMs: parsed.latencyMs };
		}
		case "error": {
			if (typeof parsed.message !== "string") {
				throw new Error("child error message must carry a string message");
			}
			return { type: "error", message: parsed.message };
		}
		default:
			throw new Error(`unknown child message type: ${parsed.type}`);
	}
}

/**
 * Fail-closed integrity check: the child must report exactly the diagnostic
 * candidate settings the supervisor requested for this run. A mismatch means
 * the measurement does not correspond to the requested candidate, so the
 * sample must be rejected. (The 2 ops / 64 MiB default remains the setting
 * comparable with the earlier recorded diagnostic run.)
 */
export interface ExpectedKdfSettings {
	opsLimit: number;
	memoryLimitBytes: number;
}

export function assertReadyMatchesRequestedSettings(ready: ChildReadyMessage, expected: ExpectedKdfSettings): void {
	if (ready.protocol !== CHILD_PROTOCOL_VERSION) {
		throw new Error(`child protocol ${ready.protocol} does not match expected ${CHILD_PROTOCOL_VERSION}`);
	}
	const { settings } = ready;
	if (settings.function !== KDF_FUNCTION) {
		throw new Error(`child ran "${settings.function}" instead of "${KDF_FUNCTION}"`);
	}
	if (settings.algorithm !== KDF_ALGORITHM || settings.algorithmId !== KDF_ALGORITHM_ID) {
		throw new Error(`child algorithm "${settings.algorithm}" (id ${settings.algorithmId}) is not the fixed diagnostic algorithm`);
	}
	if (settings.opsLimit !== expected.opsLimit || settings.memoryLimitBytes !== expected.memoryLimitBytes) {
		throw new Error(
			`child settings ${settings.opsLimit} ops / ${settings.memoryLimitBytes} bytes do not match the requested diagnostic settings ` +
				`${expected.opsLimit} ops / ${expected.memoryLimitBytes} bytes`,
		);
	}
	if (settings.outputBytes !== KDF_OUTPUT_BYTES) {
		throw new Error(`child outputBytes ${settings.outputBytes} does not match ${KDF_OUTPUT_BYTES}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
