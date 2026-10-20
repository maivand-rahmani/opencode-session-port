import assert from "node:assert/strict";
import { test } from "node:test";
import {
	allowedAuthPath,
	exactOrigin,
	proxyAuthRequest,
	proxyNativeGet,
	proxyNativePost,
	redirectToCanonicalDevice,
	readServerConfig,
	readServerPolicy,
	type BffPolicy,
	type Fetcher,
	type ServerConfig,
} from "../src/_app/server/index.server.ts";
import { isValidHumanCode, normalizeCodeInput } from "../src/features/device-authorization/index.ts";

const config: ServerConfig = {
	publicOrigin: "https://app.example.test",
	apiOrigin: "http://127.0.0.1:43123",
};
const policy: BffPolicy = {
	maxRequestBytes: 4096,
	maxResponseBytes: 4096,
	upstreamTimeoutMs: 1000,
};
const sessionCookie = "better-auth.session_token=opaque-session-value";
const requestID = "11111111-1111-4111-8111-111111111111";
const grantID = "22222222-2222-4222-8222-222222222222";
const issuedCsrf = Buffer.alloc(32, 3).toString("base64url");
const csrf = issuedCsrf;

test("server configuration requires canonical configured origins and no browser CSRF secret", () => {
	assert.equal(readServerConfig({} as unknown as NodeJS.ProcessEnv), null);
	assert.equal(readServerConfig({
		SESSIONPORT_PUBLIC_ORIGIN: "http://public.example.test",
		SESSIONPORT_INTERNAL_API_ORIGIN: config.apiOrigin,
	} as unknown as NodeJS.ProcessEnv), null);
	assert.equal(readServerConfig({
		SESSIONPORT_PUBLIC_ORIGIN: "https://app.example.test/path",
		SESSIONPORT_INTERNAL_API_ORIGIN: config.apiOrigin,
	} as unknown as NodeJS.ProcessEnv), null);
	assert.deepEqual(readServerConfig({
		SESSIONPORT_PUBLIC_ORIGIN: "https://app.example.test/",
		SESSIONPORT_INTERNAL_API_ORIGIN: "http://127.0.0.1:43123/",
		SESSIONPORT_CSRF_SECRET: "unused-by-the-web-bff",
	} as unknown as NodeJS.ProcessEnv), config);
});

test("web policy is explicit, exact, and safely bounded", () => {
	assert.equal(readServerPolicy({} as unknown as NodeJS.ProcessEnv), null);
	assert.equal(readServerPolicy({ SESSIONPORT_WEB_POLICY_JSON: "not-json" } as unknown as NodeJS.ProcessEnv), null);
	assert.equal(readServerPolicy({
		SESSIONPORT_WEB_POLICY_JSON: JSON.stringify({ ...policy, extra: 1 }),
	} as unknown as NodeJS.ProcessEnv), null);
	assert.equal(readServerPolicy({
		SESSIONPORT_WEB_POLICY_JSON: JSON.stringify({ maxRequestBytes: 1, maxResponseBytes: 1 }),
	} as unknown as NodeJS.ProcessEnv), null);
	for (const invalid of [
		{ ...policy, maxRequestBytes: 0 },
		{ ...policy, maxRequestBytes: -1 },
		{ ...policy, maxRequestBytes: 1.5 },
		{ ...policy, maxResponseBytes: "4096" },
		{ ...policy, upstreamTimeoutMs: 2_147_483_648 },
	]) {
		assert.equal(readServerPolicy({
			SESSIONPORT_WEB_POLICY_JSON: JSON.stringify(invalid),
		} as unknown as NodeJS.ProcessEnv), null);
	}
	assert.deepEqual(readServerPolicy({
		SESSIONPORT_WEB_POLICY_JSON: JSON.stringify(policy),
	} as unknown as NodeJS.ProcessEnv), policy);
});

test("proxy routes fail closed when the explicit policy is missing", async () => {
	let calls = 0;
	const fetcher: Fetcher = async () => {
		calls += 1;
		return Response.json({ grants: [] });
	};
	const getResponse = await proxyNativeGet(new Request(`${config.publicOrigin}/api/native/v1/grants`, {
		headers: { cookie: sessionCookie },
	}), "grants", { config, policy: null, fetcher });
	assert.equal(getResponse.status, 503);
	assert.equal(calls, 0);

	const postResponse = await proxyNativePost(new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/deny`, {
		method: "POST",
		headers: {
			origin: config.publicOrigin,
			"content-type": "application/json",
			cookie: sessionCookie,
			"x-sessionport-csrf": csrf,
		},
		body: JSON.stringify({ userCode: "01ARZ3NDEKTS" }),
	}), "deny", { config, policy: null, fetcher });
	assert.equal(postResponse.status, 503);
	assert.equal(calls, 0);
});

test("auth path matcher allows only named browser operations", () => {	assert.equal(allowedAuthPath("POST", ["sign-in", "social"]), "sign-in/social");
	assert.equal(allowedAuthPath("GET", ["get-session"]), "get-session");
	assert.equal(allowedAuthPath("GET", ["callback", "github"]), "callback/github");
	assert.equal(allowedAuthPath("POST", ["callback", "github"]), null);
	assert.equal(allowedAuthPath("POST", ["native", "v1", "grants"]), null);
	assert.equal(allowedAuthPath("POST", ["anything", "else"]), null);
});

test("fixed verification entry redirects to canonical /device without preserving a query", () => {
	const response = redirectToCanonicalDevice(config);
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("location"), `${config.publicOrigin}/device`);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	const unavailable = redirectToCanonicalDevice(null);
	assert.equal(unavailable.status, 503);
	assert.equal(unavailable.headers.get("location"), null);
});

test("exact origin rejects absent, mismatched, and comma-joined duplicate values", () => {
	assert.equal(exactOrigin(new Request("https://app.example.test/"), config.publicOrigin), false);
	assert.equal(exactOrigin(new Request("https://app.example.test/", { headers: { origin: "https://evil.example" } }), config.publicOrigin), false);
	assert.equal(exactOrigin(new Request("https://app.example.test/", { headers: { origin: `${config.publicOrigin}, ${config.publicOrigin}` } }), config.publicOrigin), false);
	assert.equal(exactOrigin(new Request("https://app.example.test/", { headers: { origin: config.publicOrigin } }), config.publicOrigin), true);
});

test("native GET forwards only the session cookie and the actual single origin, then sanitizes DTOs and headers", async () => {
	let capturedURL = "";
	let capturedInit: RequestInit | undefined;
	const upstreamHeaders = new Headers({ "content-type": "application/json" });
	upstreamHeaders.append("set-cookie", "api-private=one; HttpOnly");
	const fetcher: Fetcher = async (input, init) => {
		capturedURL = String(input);
		capturedInit = init;
		return new Response(JSON.stringify({ grants: [{
			id: grantID,
			deviceID: "device-abcdefghijkl",
			createdAt: "2026-10-01T10:00:00.000Z",
			expiresAt: "2026-11-01T10:00:00.000Z",
			lastSeenAt: null,
			revokedAt: null,
			status: "active",
			accessToken: "must-not-cross-the-boundary",
		}] }), { status: 200, headers: upstreamHeaders });
	};
	const request = new Request(`${config.publicOrigin}/api/native/v1/grants`, {
		headers: {
			cookie: sessionCookie,
			origin: config.publicOrigin,
			authorization: "Bearer attacker-value",
			host: "attacker.example",
			"x-user-id": "forged-user",
			"x-forwarded-host": "attacker.example",
		},
	});
	const response = await proxyNativeGet(request, "grants", { config, policy, fetcher });
	const payload = await response.json();
	const headers = new Headers(capturedInit?.headers);
	assert.equal(response.status, 200);
	assert.equal(capturedURL, `${config.apiOrigin}/api/native/v1/grants`);
	assert.equal(capturedInit?.method, "GET");
	assert.equal(capturedInit?.redirect, "manual");
	assert.equal(capturedInit?.cache, "no-store");
	assert.ok(capturedInit?.signal);
	assert.deepEqual([...headers.keys()].sort(), ["accept", "cookie", "origin"]);
	assert.equal(headers.get("cookie"), sessionCookie);
	assert.equal(headers.get("origin"), config.publicOrigin);
	assert.deepEqual(payload, { grants: [{
		id: grantID,
		deviceID: "device-abcdefghijkl",
		createdAt: "2026-10-01T10:00:00.000Z",
		expiresAt: "2026-11-01T10:00:00.000Z",
		lastSeenAt: null,
		revokedAt: null,
		status: "active",
	}] });
	assert.equal(response.headers.get("set-cookie"), null);
	assert.equal(response.headers.get("cache-control"), "no-store");
});

test("native GET never fabricates an origin that the browser did not send", async () => {
	const seen: RequestInit[] = [];
	const fetcher: Fetcher = async (_input, init) => {
		seen.push(init ?? {});
		return Response.json({ grants: [] });
	};
	const request = new Request(`${config.publicOrigin}/api/native/v1/grants`, {
		headers: { cookie: sessionCookie },
	});
	const response = await proxyNativeGet(request, "grants", { config, policy, fetcher });
	assert.equal(response.status, 200);
	assert.deepEqual([...new Headers(seen[0]?.headers).keys()].sort(), ["accept", "cookie"]);
	assert.equal(new Headers(seen[0]?.headers).get("origin"), null);
});

test("native API redirects are not followed or relayed", async () => {
	let redirectMode: RequestRedirect | undefined;
	const request = new Request(`${config.publicOrigin}/api/native/v1/session`, { headers: { cookie: sessionCookie } });
	const response = await proxyNativeGet(request, "session", {
		config,
		policy,
		fetcher: async (_input, init) => {
			redirectMode = init?.redirect;
			return new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } });
		},
	});
	assert.equal(redirectMode, "manual");
	assert.equal(response.status, 500);
	assert.equal(response.headers.get("location"), null);
});

test("native POST validates origin, CSRF shape, JSON shape, then forwards only approved headers and body", async () => {
	let capturedInit: RequestInit | undefined;
	let capturedURL = "";
	const fetcher: Fetcher = async (input, init) => {
		capturedURL = String(input);
		capturedInit = init;
		return Response.json({ consent: {
			account: { id: "account-1", name: "A Developer", email: "dev@example.test" },
			scopes: ["sessions:transfer"],
			expiresAt: "2026-10-21T12:00:00.000Z",
			accessToken: "must-not-be-returned",
		} });
	};
	const request = new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/verify`, {
		method: "POST",
		headers: {
			origin: config.publicOrigin,
			"content-type": "application/json",
			cookie: sessionCookie,
			"x-sessionport-csrf": csrf,
			authorization: "Bearer attacker-value",
			host: "attacker.example",
			"x-user-id": "forged-user",
		},
		body: JSON.stringify({ userCode: "01ARZ3NDEKTS" }),
	});
	const response = await proxyNativePost(request, "verify", { config, policy, fetcher });
	const headers = new Headers(capturedInit?.headers);
	assert.equal(response.status, 200);
	assert.equal(capturedURL, `${config.apiOrigin}/api/native/v1/device-authorizations/verify`);
	assert.equal(capturedInit?.redirect, "manual");
	assert.deepEqual([...headers.keys()].sort(), ["accept", "content-type", "cookie", "origin", "x-sessionport-csrf"]);
	assert.equal(headers.get("origin"), config.publicOrigin);
	assert.equal(headers.get("x-sessionport-csrf"), csrf);
	assert.deepEqual(JSON.parse(String(capturedInit?.body)), { userCode: "01ARZ3NDEKTS" });
	assert.deepEqual(await response.json(), { consent: {
		account: { id: "account-1", name: "A Developer", email: "dev@example.test" },
		scopes: ["sessions:transfer"],
		expiresAt: "2026-10-21T12:00:00.000Z",
	} });
});

test("native POST fails before fetch for duplicate origin, bad CSRF, wrong code shape, or unknown body fields", async () => {
	let calls = 0;
	const fetcher: Fetcher = async () => {
		calls += 1;
		return Response.json({ consent: {} });
	};
	const base = {
		cookie: sessionCookie,
		"content-type": "application/json",
		"x-sessionport-csrf": csrf,
	};
	const requests = [
		new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/verify`, {
			method: "POST", headers: { ...base, origin: `${config.publicOrigin}, ${config.publicOrigin}` }, body: JSON.stringify({ userCode: "01ARZ3NDEKTS" }),
		}),
		new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/verify`, {
			method: "POST", headers: { ...base, origin: config.publicOrigin, "x-sessionport-csrf": "forged" }, body: JSON.stringify({ userCode: "01ARZ3NDEKTS" }),
		}),
		new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/verify`, {
			method: "POST", headers: { ...base, origin: config.publicOrigin }, body: JSON.stringify({ userCode: "01ARZ3NDEKTS", userID: "forged" }),
		}),
		new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/verify`, {
			method: "POST", headers: { ...base, origin: config.publicOrigin }, body: JSON.stringify({ userCode: "01ARZ3NDEKTI" }),
		}),
	];
	for (const request of requests) {
		const response = await proxyNativePost(request, "verify", { config, policy, fetcher });
		assert.equal(response.status, 400);
		const envelope = await response.json();
		assert.equal(envelope.error.code, "invalid-request");
		assert.equal(typeof envelope.error.requestID, "string");
	}
	assert.equal(calls, 0);
});

test("native POST requires a JSON content type", async () => {
	const request = new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/deny`, {
		method: "POST",
		headers: { origin: config.publicOrigin, cookie: sessionCookie, "x-sessionport-csrf": csrf },
		body: JSON.stringify({ userCode: "01ARZ3NDEKTS" }),
	});
	const response = await proxyNativePost(request, "deny", { config, policy, fetcher: async () => Response.json({ status: "denied" }) });
	assert.equal(response.status, 415);
	assert.equal((await response.json()).error.code, "unsupported-media-type");
});

test("native POST rejects missing, malformed, and comma-collapsed duplicate CSRF headers before fetch", async () => {
	let calls = 0;
	const fetcher: Fetcher = async () => {
		calls += 1;
		return Response.json({ status: "denied" });
	};
	const invalidTokens = [
		undefined,
		`${csrf},${csrf}`,
		csrf.slice(0, 42),
		`${csrf}A`,
		`!${csrf.slice(1)}`,
	];
	for (const token of invalidTokens) {
		const headers: Record<string, string> = {
			origin: config.publicOrigin,
			"content-type": "application/json",
			cookie: sessionCookie,
		};
		if (token !== undefined) headers["x-sessionport-csrf"] = token;
		const request = new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/deny`, {
			method: "POST",
			headers,
			body: JSON.stringify({ userCode: "01ARZ3NDEKTS" }),
		});
		const response = await proxyNativePost(request, "deny", { config, policy, fetcher });
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error.code, "invalid-request");
	}
	assert.equal(calls, 0);

	let forwarded: Headers | undefined;
	const valid = new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/deny`, {
		method: "POST",
		headers: {
			origin: config.publicOrigin,
			"content-type": "application/json",
			cookie: sessionCookie,
			"x-sessionport-csrf": csrf,
		},
		body: JSON.stringify({ userCode: "01ARZ3NDEKTS" }),
	});
	const response = await proxyNativePost(valid, "deny", {
		config,
		policy,
		fetcher: async (_input, init) => {
			forwarded = new Headers(init?.headers);
			return Response.json({ status: "denied" });
		},
	});
	assert.equal(response.status, 200);
	assert.equal(forwarded?.get("x-sessionport-csrf"), csrf);
});

test("a valid-shaped browser CSRF header is not BFF authority; the API rejection is preserved with one upstream call", async () => {
	let calls = 0;
	let forwarded: Headers | undefined;
	const request = new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/verify`, {
		method: "POST",
		headers: {
			origin: config.publicOrigin,
			"content-type": "application/json",
			cookie: sessionCookie,
			"x-sessionport-csrf": csrf,
		},
		body: JSON.stringify({ userCode: "01ARZ3NDEKTS" }),
	});
	const response = await proxyNativePost(request, "verify", {
		config,
		policy,
		fetcher: async (_input, init) => {
			calls += 1;
			forwarded = new Headers(init?.headers);
			return Response.json({
				error: { code: "unauthenticated", message: "Authentication is required.", retryable: false, requestID },
			}, { status: 401 });
		},
	});
	assert.equal(calls, 1);
	assert.equal(forwarded?.get("cookie"), sessionCookie);
	assert.equal(forwarded?.get("x-sessionport-csrf"), csrf);
	assert.equal(response.status, 401);
	const envelope = await response.json();
	assert.equal(envelope.error.code, "unauthenticated");
	assert.equal(envelope.error.requestID, requestID);
});

test("session DTO propagates the API-issued canonical CSRF token unchanged and strips authority fields", async () => {
	const apiToken = Buffer.alloc(32, 9).toString("base64url");
	const payload = {
		user: { id: "user-1", name: "A Developer", email: "dev@example.test", extra: "ignored" },
		csrfToken: apiToken,
		sessionID: "must-not-cross-the-boundary",
		session: { token: "must-not-cross-the-boundary" },
	};
	const fetcher: Fetcher = async () => Response.json(payload);
	const request = new Request(`${config.publicOrigin}/api/native/v1/session`, { headers: { cookie: sessionCookie } });
	const response = await proxyNativeGet(request, "session", { config, policy, fetcher });
	assert.deepEqual(await response.json(), {
		user: { id: "user-1", name: "A Developer", email: "dev@example.test" },
		csrfToken: apiToken,
	});

	const envConfig = readServerConfig({
		SESSIONPORT_PUBLIC_ORIGIN: config.publicOrigin,
		SESSIONPORT_INTERNAL_API_ORIGIN: config.apiOrigin,
		SESSIONPORT_CSRF_SECRET: "bff-must-not-read-this",
		SESSIONPORT_NATIVE_CSRF_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
	} as unknown as NodeJS.ProcessEnv);
	const envPolicy = readServerPolicy({
		SESSIONPORT_WEB_POLICY_JSON: JSON.stringify(policy),
	} as unknown as NodeJS.ProcessEnv);
	const second = await proxyNativeGet(request, "session", { config: envConfig, policy: envPolicy, fetcher });
	assert.deepEqual(await second.json(), {
		user: { id: "user-1", name: "A Developer", email: "dev@example.test" },
		csrfToken: apiToken,
	});

	const malformed = await proxyNativeGet(request, "session", {
		config,
		policy,
		fetcher: async () => Response.json({ ...payload, csrfToken: "B".repeat(43) }),
	});
	assert.equal(malformed.status, 500);
	assert.equal((await malformed.json()).error.code, "internal-error");
});

test("API native error codes are preserved with fixed messages and never relay raw vendor text", async () => {
	const cases = [
		{ status: 429, code: "rate-limited", message: "Too many requests. Try again later." },
		{ status: 409, code: "state-conflict", message: "The authorization state conflicts with the request." },
		{ status: 400, code: "invalid-request", message: "The request is invalid." },
	];
	for (const item of cases) {
		const rawMessage = `vendor detail: userCode=01ARZ3NDEKTS request=${item.code}`;
		const request = new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/verify`, {
			method: "POST",
			headers: {
				origin: config.publicOrigin,
				"content-type": "application/json",
				cookie: sessionCookie,
				"x-sessionport-csrf": csrf,
			},
			body: JSON.stringify({ userCode: "01ARZ3NDEKTS" }),
		});
		const headers = new Headers({ "content-type": "application/json", "retry-after": "7" });
		const response = await proxyNativePost(request, "verify", {
			config,
			policy,
			fetcher: async () => new Response(JSON.stringify({
				error: { code: item.code, message: rawMessage, retryable: true, requestID },
			}), { status: item.status, headers }),
		});
		assert.equal(response.status, item.status);
		assert.equal(response.headers.get("retry-after"), "7");
		const envelope = await response.json();
		assert.equal(envelope.error.code, item.code);
		assert.equal(envelope.error.message, item.message);
		assert.equal(envelope.error.requestID, requestID);
		assert.notEqual(envelope.error.message, rawMessage);
	}

	const unknown = await proxyNativeGet(new Request(`${config.publicOrigin}/api/native/v1/grants`, {
		headers: { cookie: sessionCookie },
	}), "grants", {
		config,
		policy,
		fetcher: async () => Response.json({
			error: { code: "vendor-private-code", message: "raw vendor failure", retryable: false, requestID },
		}, { status: 400 }),
	});
	assert.equal(unknown.status, 500);
	assert.equal((await unknown.json()).error.code, "internal-error");
});

test("bounded request and response bodies fail closed with fixed 413 and 503 envelopes", async () => {
	let calls = 0;
	const tightRequestPolicy: BffPolicy = { ...policy, maxRequestBytes: 8 };
	const request = new Request(`${config.publicOrigin}/api/native/v1/device-authorizations/verify`, {
		method: "POST",
		headers: {
			origin: config.publicOrigin,
			"content-type": "application/json",
			cookie: sessionCookie,
			"x-sessionport-csrf": csrf,
		},
		body: JSON.stringify({ userCode: "01ARZ3NDEKTS" }),
	});
	const tooLarge = await proxyNativePost(request, "verify", {
		config,
		policy: tightRequestPolicy,
		fetcher: async () => {
			calls += 1;
			return Response.json({ consent: {} });
		},
	});
	assert.equal(calls, 0);
	assert.equal(tooLarge.status, 413);
	assert.equal((await tooLarge.json()).error.code, "payload-too-large");

	const tightResponsePolicy: BffPolicy = { ...policy, maxResponseBytes: 8 };
	const response = await proxyNativeGet(new Request(`${config.publicOrigin}/api/native/v1/grants`, {
		headers: { cookie: sessionCookie },
	}), "grants", {
		config,
		policy: tightResponsePolicy,
		fetcher: async () => Response.json({ grants: [] }),
	});
	assert.equal(response.status, 503);
	assert.equal((await response.json()).error.code, "unavailable");
});

test("upstream timeout aborts the fetch and fails closed", async () => {
	let observed: AbortSignal | null = null;
	const timedPolicy: BffPolicy = { ...policy, upstreamTimeoutMs: 25 };
	const response = await proxyNativeGet(new Request(`${config.publicOrigin}/api/native/v1/grants`, {
		headers: { cookie: sessionCookie },
	}), "grants", {
		config,
		policy: timedPolicy,
		fetcher: (_input, init) => {
			observed = init?.signal ?? null;
			return new Promise<Response>((_resolve, reject) => {
				if (!observed) {
					reject(new Error("missing abort signal"));
					return;
				}
				observed.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		},
	});
	assert.equal(isAborted(observed), true);
	assert.equal(response.status, 503);
	assert.equal((await response.json()).error.code, "unavailable");

	const bodyTimeout = await proxyNativeGet(new Request(`${config.publicOrigin}/api/native/v1/grants`, {
		headers: { cookie: sessionCookie },
	}), "grants", {
		config,
		policy: timedPolicy,
		fetcher: async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	});
	assert.equal(bodyTimeout.status, 503);
	assert.equal((await bodyTimeout.json()).error.code, "unavailable");
});

test("sign-in is GitHub-only, fixes its callback, uses manual redirects, and preserves separate cookies", async () => {
	let capturedURL = "";
	let capturedInit: RequestInit | undefined;
	const upstreamHeaders = new Headers({ "content-type": "application/json" });
	upstreamHeaders.append("set-cookie", "oauth-state=one; Path=/; HttpOnly; Secure; SameSite=Lax");
	upstreamHeaders.append("set-cookie", "oauth-nonce=two; Path=/; HttpOnly; Secure; SameSite=Lax");
	const fetcher: Fetcher = async (input, init) => {
		capturedURL = String(input);
		capturedInit = init;
		return new Response(JSON.stringify({ url: "https://github.com/login/oauth/authorize?client_id=example&state=state-value" }), { status: 200, headers: upstreamHeaders });
	};
	const request = new Request(`${config.publicOrigin}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin: config.publicOrigin, "content-type": "application/json", authorization: "Bearer do-not-forward", host: "attacker.example" },
		body: JSON.stringify({ provider: "github" }),
	});
	const response = await proxyAuthRequest(request, ["sign-in", "social"], { config, policy, fetcher });
	const headers = new Headers(capturedInit?.headers);
	assert.equal(response.status, 200);
	assert.equal(capturedURL, `${config.apiOrigin}/api/auth/sign-in/social`);
	assert.equal(capturedInit?.redirect, "manual");
	assert.deepEqual([...headers.keys()].sort(), ["accept", "content-type", "origin"]);
	assert.deepEqual(JSON.parse(String(capturedInit?.body)), { provider: "github", callbackURL: `${config.publicOrigin}/device` });
	assert.deepEqual(await response.json(), { url: "https://github.com/login/oauth/authorize?client_id=example&state=state-value" });
	assert.deepEqual(getSetCookies(response), [
		"oauth-state=one; Path=/; HttpOnly; Secure; SameSite=Lax",
		"oauth-nonce=two; Path=/; HttpOnly; Secure; SameSite=Lax",
	]);
});

test("sign-in rejects provider and callback fields supplied by the browser", async () => {
	let calls = 0;
	const request = new Request(`${config.publicOrigin}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin: config.publicOrigin, "content-type": "application/json" },
		body: JSON.stringify({ provider: "github", callbackURL: "https://evil.example" }),
	});
	const response = await proxyAuthRequest(request, ["sign-in", "social"], {
		config,
		policy,
		fetcher: async () => { calls += 1; return Response.json({}); },
	});
	assert.equal(response.status, 400);
	assert.equal(calls, 0);
});

test("unsafe auth redirects are not followed or relayed", async () => {
	let redirectMode: RequestRedirect | undefined;
	const request = new Request(`${config.publicOrigin}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin: config.publicOrigin, "content-type": "application/json" },
		body: JSON.stringify({ provider: "github" }),
	});
	const response = await proxyAuthRequest(request, ["sign-in", "social"], {
		config,
		policy,
		fetcher: async (_input, init) => {
			redirectMode = init?.redirect;
			return new Response(null, { status: 302, headers: { location: "https://evil.example/login" } });
		},
	});
	assert.equal(redirectMode, "manual");
	assert.equal(response.status, 500);
	assert.equal(response.headers.get("location"), null);
});

test("OAuth callback rejects an off-origin backend destination", async () => {
	for (const location of ["https://evil.example/collect", `${config.publicOrigin}/device?userCode=01ARZ3NDEKTS`]) {
		const request = new Request(`${config.publicOrigin}/api/auth/callback/github?code=oauth-code&state=state-value`);
		const response = await proxyAuthRequest(request, ["callback", "github"], {
			config,
			policy,
			fetcher: async () => new Response(null, { status: 302, headers: { location } }),
		});
		assert.equal(response.status, 500);
		assert.equal(response.headers.get("location"), null);
	}
});

test("get-session removes Better Auth session tokens from the browser DTO", async () => {
	const request = new Request(`${config.publicOrigin}/api/auth/get-session`, { headers: { cookie: sessionCookie } });
	const response = await proxyAuthRequest(request, ["get-session"], {
		config,
		policy,
		fetcher: async () => Response.json({
			session: { id: "session-id", token: "sensitive-session-token" },
			user: { id: "user-1", name: "A Developer", email: "dev@example.test", extra: "ignored" },
		}),
	});
	assert.deepEqual(await response.json(), { user: { id: "user-1", name: "A Developer", email: "dev@example.test" } });
	assert.equal(response.headers.get("cache-control"), "no-store");
});

test("GitHub callback forwards only OAuth query keys and redirects only to the fixed device page", async () => {
	let capturedURL = "";
	let capturedInit: RequestInit | undefined;
	const request = new Request(`${config.publicOrigin}/api/auth/callback/github?code=oauth-code&state=state-value`, {
		headers: { cookie: "oauth-state=opaque", authorization: "Bearer attacker" },
	});
	const response = await proxyAuthRequest(request, ["callback", "github"], {
		config,
		policy,
		fetcher: async (input, init) => {
			capturedURL = String(input);
			capturedInit = init;
			const headers = new Headers({ location: "/device" });
			headers.append("set-cookie", "session-a=one; Path=/; HttpOnly; Secure; SameSite=Lax");
			headers.append("set-cookie", "session-b=two; Path=/; HttpOnly; Secure; SameSite=Lax");
			return new Response(null, { status: 302, headers });
		},
	});
	const forwarded = new Headers(capturedInit?.headers);
	assert.equal(capturedURL, `${config.apiOrigin}/api/auth/callback/github?code=oauth-code&state=state-value`);
	assert.equal(capturedInit?.redirect, "manual");
	assert.deepEqual([...forwarded.keys()].sort(), ["accept", "cookie"]);
	assert.equal(forwarded.get("origin"), null);
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("location"), "/device");
	assert.deepEqual(getSetCookies(response), [
		"session-a=one; Path=/; HttpOnly; Secure; SameSite=Lax",
		"session-b=two; Path=/; HttpOnly; Secure; SameSite=Lax",
	]);
});

test("callback rejects human-code query parameters and duplicate OAuth fields", async () => {
	let calls = 0;
	for (const suffix of ["?userCode=01ARZ3NDEKTS", "?code=a&code=b", "?state=s&next=https%3A%2F%2Fevil.example"]) {
		const request = new Request(`${config.publicOrigin}/api/auth/callback/github${suffix}`);
		const response = await proxyAuthRequest(request, ["callback", "github"], {
			config,
			policy,
			fetcher: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: "/device" } }); },
		});
		assert.equal(response.status, 400);
	}
	assert.equal(calls, 0);
});

test("human code entry uppercases ASCII and strips only the supported separators", () => {
	assert.deepEqual(normalizeCodeInput("01arz-3ndekts"), { code: "01ARZ3NDEKTS", invalidCharacter: false, tooLong: false });
	assert.equal(isValidHumanCode("01ARZ3NDEKTS"), true);
	assert.equal(isValidHumanCode("01ARZ3NDEKTI"), false);
	assert.equal(normalizeCodeInput("01ARZ3NDEKTS🙂").invalidCharacter, true);
	assert.equal(normalizeCodeInput("01ARZ3NDEKTS4").tooLong, true);
});

function getSetCookies(response: Response): string[] {
	const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	return getSetCookie ? getSetCookie.call(response.headers) : [];
}

function isAborted(signal: AbortSignal | null): boolean {
	return signal?.aborted === true;
}
