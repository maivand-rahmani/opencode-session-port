import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { securityProxy } from "../src/_app/security/proxy.ts";

const url = "http://127.0.0.1:43117/login";
const directives = (policy: string) =>
	new Map(policy.split("; ").map((directive) => {
		const [name, ...sources] = directive.split(" ");
		return [name, sources];
	}));

function policyFor(
	runtimeEnvironment?: { NODE_ENV?: string },
	request = new NextRequest(url),
) {
	const response = runtimeEnvironment === undefined
		? securityProxy(request)
		: securityProxy(request, runtimeEnvironment);
	const policy = response.headers.get("content-security-policy");
	assert.ok(policy, "response must include a Content-Security-Policy header");
	return { response, policy, parsed: directives(policy) };
}

test("development is the only runtime environment allowed to use eval", () => {
	const development = policyFor({ NODE_ENV: "development" });
	const scriptSources = development.parsed.get("script-src") ?? [];
	assert.equal(
		scriptSources.filter((source) => source === "'unsafe-eval'").length,
		1,
		"development script-src must include exactly one unsafe-eval source",
	);
	assert.match(
		development.policy,
		/script-src 'self' 'nonce-[^']+' 'unsafe-eval'/,
		"development script-src must keep the nonce before unsafe-eval",
	);
	assert.deepEqual(
		development.parsed.get("connect-src"),
		["'self'", "ws://localhost:*", "ws://127.0.0.1:*"],
		"development connect-src keeps the local websocket allowance",
	);

	for (const runtimeEnvironment of [
		{ NODE_ENV: "production" },
		{ NODE_ENV: "test" },
		{ NODE_ENV: "staging" },
		{ NODE_ENV: "" },
		{},
	]) {
		const { policy, parsed } = policyFor(runtimeEnvironment);
		assert.equal(
			policy.includes("'unsafe-eval'"),
			false,
			`${JSON.stringify(runtimeEnvironment)} must not allow eval`,
		);
		assert.deepEqual(parsed.get("connect-src"), ["'self'"]);
	}
});

test("nonce, directives, and security headers do not change outside development", () => {
	const development = policyFor({ NODE_ENV: "development" });
	const production = policyFor({ NODE_ENV: "production" });
	const developmentNonce = development.policy.match(/'nonce-([^']+)'/)?.[1];
	const productionNonce = production.policy.match(/'nonce-([^']+)'/)?.[1];
	assert.ok(developmentNonce, "development policy must carry a nonce");
	assert.ok(productionNonce, "production policy must carry a nonce");

	const expectedDirectives = [
		"default-src", "style-src", "style-src-attr", "script-src-attr",
		"img-src", "font-src", "frame-src", "base-uri", "object-src",
		"frame-ancestors", "form-action",
	];
	const normalizeNonce = (sources: string[]) =>
		sources.map((source) => source.replace(/^'nonce-.+'$/, "'nonce-<nonce>'"));
	for (const name of expectedDirectives) {
		assert.deepEqual(
			normalizeNonce(production.parsed.get(name) ?? []),
			normalizeNonce(development.parsed.get(name) ?? []),
			`${name} must not vary with NODE_ENV`,
		);
	}
	assert.deepEqual(production.parsed.get("script-src"), [
		"'self'",
		`'nonce-${productionNonce}'`,
	]);

	for (const [name, value] of [
		["cache-control", "no-store"],
		["referrer-policy", "no-referrer"],
		["x-content-type-options", "nosniff"],
		["x-frame-options", "DENY"],
		["permissions-policy", "camera=(), microphone=(), geolocation=()"],
	]) {
		assert.equal(development.response.headers.get(name), value);
		assert.equal(production.response.headers.get(name), value);
	}
});

test("untrusted request data cannot enable eval through the trusted process environment", () => {
	const previous = process.env.NODE_ENV;
	const environment = process.env as Record<string, string | undefined>;
	const request = new NextRequest(`${url}?NODE_ENV=development`, {
		headers: {
			NODE_ENV: "development",
			"x-node-env": "development",
			"x-forwarded-host": "localhost",
		},
	});
	try {
		environment.NODE_ENV = "production";
		assert.equal(policyFor(undefined, request).policy.includes("'unsafe-eval'"), false);
		environment.NODE_ENV = "test";
		assert.equal(policyFor(undefined, request).policy.includes("'unsafe-eval'"), false);
	} finally {
		if (previous === undefined) delete environment.NODE_ENV;
		else environment.NODE_ENV = previous;
	}
});
