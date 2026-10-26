import { describe, expect, test } from "bun:test";
import {
	classifyPublishOutput,
	MAX_CAPTURE_BYTES,
	PUBLISH_ARGS,
	PUBLISH_TIMEOUT_MS,
	runPublishWithDiagnostics,
} from "../../scripts/ci/publish-with-diagnostics.mjs";

/**
 * Synthetic tests for the bounded publish wrapper. No npm invocation, no
 * network, no real credentials. Fake secrets prove the report cannot leak
 * captured output, env values, URLs, or error messages.
 */

const baseEnv = {
	ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid/request?secret=url-secret",
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token-secret",
	NODE_AUTH_TOKEN: "",
	NPM_TOKEN: "",
	NPM_CONFIG_USERCONFIG: "/tmp/empty-npmrc",
} as Record<string, string>;

const fakeJwt = "eyJhbGciOiJSUzI1NiJ9.fake-jwt-secret.signature";
const fakeAuth = "Basic ZmFrZS1hdXRoLXNlY3JldA==";

function reportText(report: unknown): string {
	return JSON.stringify(report);
}

describe("classifyPublishOutput", () => {
	test("maps exact npm 11.5.1 literals to fixed categories", () => {
		const cases: Array<[string, string]> = [
			["Skipped because incorrect permissions for id-token within GitHub workflow", "OIDC_ENV_UNAVAILABLE"],
			["Failed to fetch id_token from GitHub: received an invalid response", "OIDC_GITHUB_FETCH_FAILED"],
			["Failed to fetch id_token from GitHub: missing value", "OIDC_GITHUB_FETCH_FAILED"],
			["Failed token exchange request", "OIDC_EXCHANGE_FAILED"],
			["Failed because token exchange was missing the token in the response body", "OIDC_EXCHANGE_FAILED"],
			["Successfully retrieved and set token", "OIDC_TOKEN_ACQUIRED"],
			["Failure with message: something bad", "OIDC_UNKNOWN_FAILURE"],
			["npm error code ENEEDAUTH", "NPM_ENEEDAUTH"],
		];
		for (const [output, category] of cases) {
			expect(classifyPublishOutput(output)).toContain(category as never);
		}
	});

	test("ignores unrelated and empty output", () => {
		expect(classifyPublishOutput("")).toEqual([]);
		expect(classifyPublishOutput("npm notice publishing")).toEqual([]);
		expect(classifyPublishOutput(null as unknown as string)).toEqual([]);
	});
});

describe("runPublishWithDiagnostics", () => {
	test("success emits only categories and OIDC presence booleans, never raw output", () => {
		let captured: any = null;
		const report = runPublishWithDiagnostics({
			env: { ...baseEnv, UNRELATED_SECRET: fakeJwt },
			cwd: "release-artifact",
			runner: (invocation: any) => {
				captured = invocation;
				return {
					status: 0,
					stdout: [
						"Successfully retrieved and set token",
						`token=${fakeJwt}`,
						`Authorization: ${fakeAuth}`,
						baseEnv.ACTIONS_ID_TOKEN_REQUEST_URL,
					].join("\n"),
					stderr: "npm notice fake server body: private package data",
				};
			},
		});
		const text = reportText(report);
		expect(report.publishDiagnostics).toMatchObject({
			status: "success",
			exitStatus: 0,
			oidcRequestUrlPresent: true,
			oidcRequestTokenPresent: true,
			categories: ["OIDC_TOKEN_ACQUIRED"],
		});
		expect(captured.cwd).toBe("release-artifact");
		for (const secret of [fakeJwt, fakeAuth, baseEnv.ACTIONS_ID_TOKEN_REQUEST_URL, baseEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "private package data"]) {
			expect(text).not.toContain(secret);
		}
		expect(text).not.toContain("Successfully retrieved");
		expect(text).not.toContain("npm notice");
	});

	test("invokes exactly the bounded one-time publish command with log persistence disabled", () => {
		let captured: any = null;
		const report = runPublishWithDiagnostics({
			env: baseEnv,
			cwd: "release-artifact",
			runner: (invocation: any) => {
				captured = invocation;
				return { status: 0, stdout: "", stderr: "" };
			},
		});
		expect(report.publishDiagnostics.status).toBe("success");
		expect(captured.args).toEqual(expect.arrayContaining([...PUBLISH_ARGS]));
		for (const arg of [
			"./exact.tgz",
			"--provenance",
			"--ignore-scripts",
			"--registry=https://registry.npmjs.org",
			"--loglevel=silly",
			"--logs-max=0",
			"--timing=false",
			"--update-notifier=false",
		]) {
			expect(captured.args).toContain(arg);
		}
		expect(captured.stdio).toEqual(["ignore", "pipe", "pipe"]);
		expect(captured.maxBuffer).toBe(MAX_CAPTURE_BYTES);
		expect(captured.timeout).toBe(PUBLISH_TIMEOUT_MS);
		expect(captured.env.NODE_AUTH_TOKEN).toBe("");
		expect(captured.env.NPM_TOKEN).toBe("");
		expect(captured.env.NPM_CONFIG_LOGS_MAX).toBe("0");
		expect(captured.env.NPM_CONFIG_UPDATE_NOTIFIER).toBe("false");
		expect(captured.env.NPM_CONFIG_USERCONFIG).toBe(baseEnv.NPM_CONFIG_USERCONFIG);
		expect(captured.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(baseEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
	});

	test("failure preserves the numeric child status and fixed category", () => {
		const report = runPublishWithDiagnostics({
			env: baseEnv,
			runner: () => ({ status: 1, stdout: "", stderr: "npm error code ENEEDAUTH\nnpm error need auth" }),
		});
		expect(report.publishDiagnostics).toMatchObject({
			status: "failure",
			exitStatus: 1,
			categories: ["NPM_ENEEDAUTH"],
		});
		expect(reportText(report)).not.toContain("need auth");
	});

	test("nonzero output without a known marker emits a fixed failure category", () => {
		const report = runPublishWithDiagnostics({
			env: baseEnv,
			runner: () => ({ status: 2, stdout: "", stderr: "unexpected npm failure text" }),
		});
		expect(report.publishDiagnostics).toMatchObject({
			status: "failure",
			exitStatus: 2,
			categories: ["PUBLISH_FAILED_UNCLASSIFIED"],
		});
		expect(reportText(report)).not.toContain("unexpected npm failure text");
	});

	test("spawn errors and runner exceptions never leak error messages", () => {
		const spawn = runPublishWithDiagnostics({
			env: {},
			runner: () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT", message: "secret spawn path" } }),
		});
		expect(spawn.publishDiagnostics).toMatchObject({
			status: "failure",
			exitStatus: null,
			oidcRequestUrlPresent: false,
			oidcRequestTokenPresent: false,
			categories: ["SPAWN_ERROR"],
		});
		expect(reportText(spawn)).not.toContain("secret spawn path");

		const thrown = runPublishWithDiagnostics({
			env: {},
			runner: () => {
				throw new Error("secret thrown message");
			},
		});
		expect(thrown.publishDiagnostics.categories).toEqual(["SPAWN_ERROR"]);
		expect(reportText(thrown)).not.toContain("secret thrown message");
	});

	test("timeout is bounded and emits only the timeout category", () => {
		const report = runPublishWithDiagnostics({
			env: baseEnv,
			runner: () => ({ status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT", message: "secret timeout detail" } }),
		});
		expect(report.publishDiagnostics).toMatchObject({
			status: "failure",
			exitStatus: null,
			categories: ["PUBLISH_TIMEOUT"],
		});
		expect(reportText(report)).not.toContain("secret timeout detail");
	});

	test("OIDC markers are classified without exposing surrounding output", () => {
		const report = runPublishWithDiagnostics({
			env: baseEnv,
			runner: () => ({
				status: 1,
				stdout: "Failed token exchange request",
				stderr: `Failed because token exchange was missing the token in the response body ${fakeJwt} ${fakeAuth}`,
			}),
		});
		expect(report.publishDiagnostics.categories).toEqual(["OIDC_EXCHANGE_FAILED"]);
		expect(reportText(report)).not.toContain(fakeJwt);
		expect(reportText(report)).not.toContain(fakeAuth);
	});
});
