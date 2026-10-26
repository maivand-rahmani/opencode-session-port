#!/usr/bin/env node
/**
 * Bounded, fail-closed npm publish wrapper for the release job.
 *
 * The child npm output is captured only in memory and is never forwarded.
 * Only fixed diagnostic categories, OIDC env-presence booleans, and the
 * numeric child exit status are emitted. Raw output, URLs, tokens, bodies,
 * errors, and log text are never printed, uploaded, or teed to a file.
 *
 * npm debug-log persistence is disabled with `--logs-max=0` (plus matching
 * npm config env) and `--timing=false`; the update notifier is disabled.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PUBLISH_ARGS = Object.freeze([
	"publish",
	"./exact.tgz",
	"--provenance",
	"--ignore-scripts",
	"--registry=https://registry.npmjs.org",
	"--loglevel=silly",
	"--logs-max=0",
	"--timing=false",
	"--update-notifier=false",
]);

export const PUBLISH_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export const DIAGNOSTIC_CATEGORIES = Object.freeze([
	"OIDC_ENV_UNAVAILABLE",
	"OIDC_GITHUB_FETCH_FAILED",
	"OIDC_EXCHANGE_FAILED",
	"OIDC_TOKEN_ACQUIRED",
	"OIDC_UNKNOWN_FAILURE",
	"NPM_ENEEDAUTH",
	"SPAWN_ERROR",
	"PUBLISH_TIMEOUT",
	"PUBLISH_FAILED_UNCLASSIFIED",
]);

const OIDC_MARKERS = Object.freeze([
	["OIDC_ENV_UNAVAILABLE", ["Skipped because incorrect permissions for id-token within GitHub workflow"]],
	[
		"OIDC_GITHUB_FETCH_FAILED",
		[
			"Failed to fetch id_token from GitHub: received an invalid response",
			"Failed to fetch id_token from GitHub: missing value",
		],
	],
	[
		"OIDC_EXCHANGE_FAILED",
		[
			"Failed token exchange request",
			"Failed because token exchange was missing the token in the response body",
		],
	],
	["OIDC_TOKEN_ACQUIRED", ["Successfully retrieved and set token"]],
	["OIDC_UNKNOWN_FAILURE", ["Failure with message:"]],
	["NPM_ENEEDAUTH", ["ENEEDAUTH"]],
]);

function orderedCategories(values) {
	const found = new Set(values);
	return DIAGNOSTIC_CATEGORIES.filter((category) => found.has(category));
}

/** Map raw npm output to fixed categories only; the raw text is discarded. */
export function classifyPublishOutput(output) {
	if (typeof output !== "string" || output === "") return [];
	const categories = [];
	for (const [category, markers] of OIDC_MARKERS) {
		if (markers.some((marker) => output.includes(marker))) categories.push(category);
	}
	return orderedCategories(categories);
}

function envPresent(env, key) {
	return typeof env?.[key] === "string" && env[key] !== "";
}

function defaultRunner(invocation) {
	return spawnSync("npm", invocation.args, {
		cwd: invocation.cwd,
		env: invocation.env,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		timeout: invocation.timeout,
		maxBuffer: invocation.maxBuffer,
		windowsHide: true,
	});
}

function reportEnvPresence(env) {
	return {
		oidcRequestUrlPresent: envPresent(env, "ACTIONS_ID_TOKEN_REQUEST_URL"),
		oidcRequestTokenPresent: envPresent(env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
	};
}

/**
 * Run the exact publish command once. Injectable runner for synthetic tests.
 * Returns only the fixed diagnostic report; never the captured output.
 */
export function runPublishWithDiagnostics({ runner = defaultRunner, env = process.env, cwd = process.cwd() } = {}) {
	const childEnv = {
		...env,
		// Never allow a token fallback, and keep npm debug logs off even if a
		// future npm version ignores one of the flags.
		NODE_AUTH_TOKEN: "",
		NPM_TOKEN: "",
		NPM_CONFIG_LOGS_MAX: "0",
		NPM_CONFIG_UPDATE_NOTIFIER: "false",
	};
	const invocation = {
		args: [...PUBLISH_ARGS],
		cwd,
		env: childEnv,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: PUBLISH_TIMEOUT_MS,
		maxBuffer: MAX_CAPTURE_BYTES,
	};
	let result;
	try {
		result = runner(invocation);
	} catch {
		return {
			publishDiagnostics: {
				status: "failure",
				exitStatus: null,
				...reportEnvPresence(env),
				categories: ["SPAWN_ERROR"],
			},
		};
	}
	const status = typeof result?.status === "number" ? result.status : null;
	const output = [result?.stdout, result?.stderr].filter((part) => typeof part === "string").join("\n");
	const categories = classifyPublishOutput(output);
	if (result?.error?.code === "ETIMEDOUT") {
		categories.push("PUBLISH_TIMEOUT");
	} else if (result?.error || status === null) {
		categories.push("SPAWN_ERROR");
	}
	const success = status === 0 && !result?.error;
	if (!success && categories.length === 0) categories.push("PUBLISH_FAILED_UNCLASSIFIED");
	return {
		publishDiagnostics: {
			status: success ? "success" : "failure",
			exitStatus: status,
			...reportEnvPresence(env),
			categories: orderedCategories(categories),
		},
	};
}

function main() {
	const report = runPublishWithDiagnostics();
	console.log(JSON.stringify(report));
	if (report.publishDiagnostics.status !== "success") {
		process.exitCode = 1;
	}
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main();
}
