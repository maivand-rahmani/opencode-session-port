import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	readCloudAuthConfig,
	type CloudAuthConfig,
} from "../../../src/cloud/auth/configuration.ts";
import { NativeAuthError } from "../../../src/cloud/auth/types.ts";

const ORIGIN = "https://api.example.test";
const ABSOLUTE_STATE = path.resolve("sessionport-auth-state");

function rawConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		origin: ORIGIN,
		requestTimeoutMillis: 10_000,
		maxResponseBytes: 65_536,
		maxCredentialBytes: 4_096,
		maxSecretBytes: 8_192,
		vaultService: "sessionport-cloud-auth",
		vaultAccount: "native-credential",
		stateDirectory: ABSOLUTE_STATE,
		...overrides,
	};
}

function expectInvalid(value: unknown): void {
	try {
		readCloudAuthConfig(value);
		throw new Error("expected configuration rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(NativeAuthError);
		expect((error as NativeAuthError).code).toBe("invalid-input");
	}
}

describe("cloud auth configuration", () => {
	test("returns null only when the optional runtime value is absent", () => {
		expect(readCloudAuthConfig(undefined)).toBeNull();
		expect(readCloudAuthConfig(null)).toBeNull();
	});

	test("accepts and freezes the exact required shape", () => {
		const raw = rawConfig();
		const config = readCloudAuthConfig(raw);
		expect(config).toEqual(raw);
		expect(Object.isFrozen(config)).toBe(true);
		expect(config).not.toHaveProperty("allowLoopbackHttp");
	});

	test("accepts explicit loopback HTTP only through the flag", () => {
		const config = readCloudAuthConfig(
			rawConfig({
				origin: "http://127.0.0.1:8787",
				allowLoopbackHttp: true,
			}),
		);
		expect(config).toEqual({
			...rawConfig({
				origin: "http://127.0.0.1:8787",
				allowLoopbackHttp: true,
			}),
		});
		expect(config?.allowLoopbackHttp).toBe(true);

		expectInvalid(
			rawConfig({ origin: "http://127.0.0.1:8787" }),
		);
		expectInvalid(
			rawConfig({
				origin: "http://api.example.test",
				allowLoopbackHttp: true,
			}),
		);
	});

	test("rejects non-canonical origins without a fallback", () => {
		for (const origin of [
			"",
			"api.example.test",
			"https://api.example.test/",
			"https://api.example.test/path",
			"https://api.example.test?x=1",
			"https://api.example.test#fragment",
			"https://user:pass@api.example.test",
			"ftp://api.example.test",
			"https://API.example.test",
			" https://api.example.test",
			"https://api.example.test ",
		]) {
			expectInvalid(rawConfig({ origin }));
		}
	});

	test("requires every budget as a positive safe integer with no defaults", () => {
		for (const key of [
			"requestTimeoutMillis",
			"maxResponseBytes",
			"maxCredentialBytes",
			"maxSecretBytes",
		] as const) {
			for (const value of [
				undefined,
				0,
				-1,
				1.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.MAX_SAFE_INTEGER + 1,
				"1024",
			]) {
				expectInvalid(rawConfig({ [key]: value }));
			}
		}
	});

	test("requires the secret budget to cover the credential budget", () => {
		expect(
			readCloudAuthConfig(
				rawConfig({
					maxCredentialBytes: 512,
					maxSecretBytes: 512,
				}),
			),
		).not.toBeNull();
		expectInvalid(
			rawConfig({
				maxCredentialBytes: 513,
				maxSecretBytes: 512,
			}),
		);
	});

	test("rejects unknown, extra, or non-plain fields", () => {
		expectInvalid(rawConfig({ extra: true }));
		expectInvalid({ ...rawConfig(), allowLoopbackHttp: "true" });
		expectInvalid([]);
		expectInvalid("configuration");
		expectInvalid(42);
		for (const key of [
			"origin",
			"requestTimeoutMillis",
			"maxResponseBytes",
			"maxCredentialBytes",
			"maxSecretBytes",
			"vaultService",
			"vaultAccount",
			"stateDirectory",
		]) {
			const missing = rawConfig();
			delete missing[key];
			expectInvalid(missing);
		}
	});

	test("bounds vault names and rejects control/whitespace input", () => {
		for (const value of [
			"",
			" ",
			" leading",
			"trailing ",
			"line\nbreak",
			"nul\u0000byte",
			"x".repeat(513),
		]) {
			expectInvalid(rawConfig({ vaultService: value }));
			expectInvalid(rawConfig({ vaultAccount: value }));
		}
	});

	test("requires an absolute state directory", () => {
		for (const stateDirectory of [
			"",
			"relative/state",
			"./state",
			"../state",
			"state ",
			"state\u0000",
		]) {
			expectInvalid(rawConfig({ stateDirectory }));
		}
		if (process.platform === "win32") {
			expectInvalid(rawConfig({ stateDirectory: "C:relative" }));
		}
	});

	test("does not mutate or normalize accepted input", () => {
		const raw = rawConfig({
			origin: "https://api.example.test",
			stateDirectory: `${ABSOLUTE_STATE}${path.sep}`,
		});
		const before = JSON.stringify(raw);
		const config = readCloudAuthConfig(raw);
		expect(JSON.stringify(raw)).toBe(before);
		expect(config?.stateDirectory).toBe(raw.stateDirectory);
		expect(config?.origin).toBe(raw.origin);
	});

	test("the exported config type is structurally complete", () => {
		const config: CloudAuthConfig = {
			origin: ORIGIN,
			requestTimeoutMillis: 1,
			maxResponseBytes: 1,
			maxCredentialBytes: 1,
			maxSecretBytes: 1,
			vaultService: "service",
			vaultAccount: "account",
			stateDirectory: ABSOLUTE_STATE,
		};
		expect(readCloudAuthConfig(config)).toEqual(config);
	});
});
