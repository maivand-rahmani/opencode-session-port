import { randomUUID } from "node:crypto";

export type ServerConfig = {
	publicOrigin: string;
	apiOrigin: string;
};

export type BffPolicy = {
	maxRequestBytes: number;
	maxResponseBytes: number;
	upstreamTimeoutMs: number;
};

export type Fetcher = (input: URL | string, init?: RequestInit) => Promise<Response>;

type ApiErrorCode =
	| "invalid-json"
	| "payload-too-large"
	| "unsupported-media-type"
	| "invalid-request"
	| "unauthenticated"
	| "not-found"
	| "unavailable"
	| "internal-error"
	| "authorization-pending"
	| "slow-down"
	| "authorization-denied"
	| "authorization-expired"
	| "authorization-consumed"
	| "invalid-credential"
	| "refresh-replay"
	| "state-conflict"
	| "rate-limited";

const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
	"invalid-json": "The request body is not valid JSON.",
	"payload-too-large": "The request body is too large.",
	"unsupported-media-type": "The request content type is not supported.",
	"invalid-request": "The request is invalid.",
	unauthenticated: "Authentication is required.",
	"not-found": "The requested resource was not found.",
	unavailable: "The service is not ready.",
	"internal-error": "An internal error occurred.",
	"authorization-pending": "Authorization is pending.",
	"slow-down": "Polling must slow down.",
	"authorization-denied": "Authorization was denied.",
	"authorization-expired": "Authorization expired.",
	"authorization-consumed": "Authorization was already consumed.",
	"invalid-credential": "The credential is invalid.",
	"refresh-replay": "The refresh credential was already used.",
	"state-conflict": "The authorization state conflicts with the request.",
	"rate-limited": "Too many requests. Try again later.",
};

const ERROR_CODES = new Set<ApiErrorCode>(Object.keys(ERROR_MESSAGES) as ApiErrorCode[]);
const API_ERROR_STATUSES = new Set([400, 401, 403, 404, 409, 410, 413, 415, 429, 500, 503]);
const CROCKFORD_CODE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TIMER_MS = 2_147_483_647;

const PUBLIC_ORIGIN_ENV = "SESSIONPORT_PUBLIC_ORIGIN";
const API_ORIGIN_ENV = "SESSIONPORT_INTERNAL_API_ORIGIN";
const WEB_POLICY_ENV = "SESSIONPORT_WEB_POLICY_JSON";

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig | null {
	const publicOrigin = readOrigin(env[PUBLIC_ORIGIN_ENV]);
	const apiOrigin = readOrigin(env[API_ORIGIN_ENV]);

	if (!publicOrigin || !apiOrigin) return null;
	return { publicOrigin, apiOrigin };
}

export function readServerPolicy(env: NodeJS.ProcessEnv = process.env): BffPolicy | null {
	const raw = env[WEB_POLICY_ENV];
	if (typeof raw !== "string" || raw.length === 0 || raw.trim() !== raw) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isPlainRecord(parsed)) return null;

	const keys = Object.keys(parsed);
	if (
		keys.length !== 3 ||
		!Object.hasOwn(parsed, "maxRequestBytes") ||
		!Object.hasOwn(parsed, "maxResponseBytes") ||
		!Object.hasOwn(parsed, "upstreamTimeoutMs")
	) {
		return null;
	}

	const maxRequestBytes = parsed.maxRequestBytes;
	const maxResponseBytes = parsed.maxResponseBytes;
	const upstreamTimeoutMs = parsed.upstreamTimeoutMs;
	if (
		!isPositiveSafeInteger(maxRequestBytes) ||
		!isPositiveSafeInteger(maxResponseBytes) ||
		!isPositiveSafeInteger(upstreamTimeoutMs) ||
		upstreamTimeoutMs > MAX_TIMER_MS
	) {
		return null;
	}

	return { maxRequestBytes, maxResponseBytes, upstreamTimeoutMs };
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readOrigin(raw: string | undefined): string | null {
	if (typeof raw !== "string" || raw.length === 0 || raw.trim() !== raw) return null;
	try {
		const parsed = new URL(raw);
		if (
			(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
			parsed.username !== "" ||
			parsed.password !== "" ||
			parsed.pathname !== "/" ||
			parsed.search !== "" ||
			parsed.hash !== "" ||
			!isConcreteHostname(parsed.hostname)
		) {
			return null;
		}
		if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) return null;
		return parsed.origin;
	} catch {
		return null;
	}
}

function isConcreteHostname(hostname: string): boolean {
	if (hostname.startsWith("[")) return /^\[[0-9a-f:.]+\]$/i.test(hostname);
	const withoutTrailingDot = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
	if (withoutTrailingDot.length === 0 || withoutTrailingDot.length > 253) return false;
	return withoutTrailingDot.split(".").every((label) =>
		label.length > 0 &&
		label.length <= 63 &&
		/^[a-z0-9-]+$/i.test(label) &&
		!label.startsWith("-") &&
		!label.endsWith("-"),
	);
}

function isLoopback(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return (
		parts.length === 4 &&
		parts[0] === "127" &&
		parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
	);
}

export function apiErrorResponse(
	status: 400 | 401 | 404 | 409 | 410 | 413 | 415 | 429 | 500 | 503,
	code: ApiErrorCode,
	setCookies: readonly string[] = [],
): Response {
	return jsonResponse(
		{
			error: {
				code,
				message: ERROR_MESSAGES[code],
				retryable: code === "unavailable" || code === "rate-limited",
				requestID: randomUUID(),
			},
		},
		status,
		undefined,
		setCookies,
	);
}

export function exactOrigin(request: Request, publicOrigin: string): boolean {
	const origin = request.headers.get("origin");
	return origin !== null && !origin.includes(",") && origin === publicOrigin;
}

export function isJsonContentType(request: Request): boolean {
	const contentType = request.headers.get("content-type");
	if (contentType === null || contentType.includes(",")) return false;
	return /^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/i.test(contentType.trim());
}

export function allowedAuthPath(method: string, segments: readonly string[]): string | null {
	const path = segments.join("/");
	if (method === "GET" && (path === "get-session" || path === "callback/github")) return path;
	if (method === "POST" && (path === "sign-in/social" || path === "sign-out")) return path;
	return null;
}

export function isSafeGitHubAuthorizationUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.origin === "https://github.com" &&
			url.pathname === "/login/oauth/authorize" &&
			url.username === "" &&
			url.password === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

export function redirectToCanonicalDevice(config: ServerConfig | null = readServerConfig()): Response {
	if (!config) return apiErrorResponse(503, "unavailable");
	const headers = noStoreHeaders();
	headers.set("location", `${config.publicOrigin}/device`);
	return new Response(null, { status: 303, headers });
}

export async function proxyNativeGet(
	request: Request,
	path: "session" | "grants",
	options: { config?: ServerConfig | null; policy?: BffPolicy | null; fetcher?: Fetcher } = {},
): Promise<Response> {
	const config = options.config === undefined ? readServerConfig() : options.config;
	const policy = options.policy === undefined ? readServerPolicy() : options.policy;
	if (!config || !policy) return apiErrorResponse(503, "unavailable");
	if (!isExactNativeUrl(request, `/api/native/v1/${path}`)) return apiErrorResponse(400, "invalid-request");

	const cookie = request.headers.get("cookie");
	if (!cookie) return apiErrorResponse(401, "unauthenticated");

	const headers = new Headers({
		accept: "application/json",
		cookie,
	});
	const origin = request.headers.get("origin");
	if (origin !== null && !origin.includes(",")) headers.set("origin", origin);
	return fetchNative(config, policy, `/api/native/v1/${path}`, "GET", headers, undefined, path, options.fetcher);
}

export async function proxyNativePost(
	request: Request,
	endpoint: "verify" | "approve" | "deny" | "revoke",
	options: {
		config?: ServerConfig | null;
		policy?: BffPolicy | null;
		fetcher?: Fetcher;
		grantID?: string;
	} = {},
): Promise<Response> {
	const config = options.config === undefined ? readServerConfig() : options.config;
	const policy = options.policy === undefined ? readServerPolicy() : options.policy;
	if (!config || !policy) return apiErrorResponse(503, "unavailable");
	if (request.method !== "POST") return apiErrorResponse(404, "not-found");
	if (!exactOrigin(request, config.publicOrigin)) return apiErrorResponse(400, "invalid-request");
	if (!isJsonContentType(request)) return apiErrorResponse(415, "unsupported-media-type");

	const cookie = request.headers.get("cookie");
	if (!cookie) return apiErrorResponse(401, "unauthenticated");
	const csrfToken = request.headers.get("x-sessionport-csrf");
	if (csrfToken === null || csrfToken.includes(",") || !isCanonicalCsrfToken(csrfToken)) {
		return apiErrorResponse(400, "invalid-request");
	}

	const input = await readBoundedJson(request, policy.maxRequestBytes);
	if (input.kind === "too-large") return apiErrorResponse(413, "payload-too-large");
	if (input.kind === "invalid") return apiErrorResponse(400, "invalid-json");

	const body = nativeRequestBody(endpoint, input.value);
	if (!body) return apiErrorResponse(400, "invalid-request");

	const path = nativePostPath(endpoint, options.grantID);
	if (!path) return apiErrorResponse(400, "invalid-request");
	if (!isExactNativeUrl(request, path)) return apiErrorResponse(400, "invalid-request");

	const headers = new Headers({
		accept: "application/json",
		"content-type": "application/json",
		cookie,
		origin: request.headers.get("origin")!,
		"x-sessionport-csrf": csrfToken,
	});
	return fetchNative(config, policy, path, "POST", headers, JSON.stringify(body), endpoint, options.fetcher);
}

export async function proxyAuthRequest(
	request: Request,
	segments: readonly string[],
	options: { config?: ServerConfig | null; policy?: BffPolicy | null; fetcher?: Fetcher } = {},
): Promise<Response> {
	const config = options.config === undefined ? readServerConfig() : options.config;
	const policy = options.policy === undefined ? readServerPolicy() : options.policy;
	if (!config || !policy) return apiErrorResponse(503, "unavailable");
	const path = allowedAuthPath(request.method, segments);
	if (!path || !isExactAuthUrl(request, `/api/auth/${path}`, path === "callback/github")) {
		return apiErrorResponse(404, "not-found");
	}

	const fetcher = options.fetcher ?? fetch;
	const cookie = request.headers.get("cookie");
	const upstreamPath = `/api/auth/${path}`;
	const upstreamUrl = new URL(upstreamPath, `${config.apiOrigin}/`);
	const headers = new Headers({ accept: "application/json" });
	if (cookie) headers.set("cookie", cookie);
	const origin = request.headers.get("origin");
	if (origin !== null && !origin.includes(",")) headers.set("origin", origin);

	let body: string | undefined;
	if (request.method === "POST") {
		if (!exactOrigin(request, config.publicOrigin)) return apiErrorResponse(400, "invalid-request");
		if (!isJsonContentType(request)) return apiErrorResponse(415, "unsupported-media-type");
		const input = await readBoundedJson(request, policy.maxRequestBytes);
		if (input.kind === "too-large") return apiErrorResponse(413, "payload-too-large");
		if (input.kind === "invalid") return apiErrorResponse(400, "invalid-json");
		if (path === "sign-in/social") {
			if (!isExactObject(input.value, ["provider"]) || input.value.provider !== "github") {
				return apiErrorResponse(400, "invalid-request");
			}
			body = JSON.stringify({
				provider: "github",
				callbackURL: `${config.publicOrigin}/device`,
			});
		} else {
			if (!isExactObject(input.value, [])) return apiErrorResponse(400, "invalid-request");
			body = "{}";
		}
		headers.set("content-type", "application/json");
	}

	if (path === "callback/github") {
		const query = safeOAuthCallbackQuery(request);
		if (query === null) return apiErrorResponse(400, "invalid-request");
		upstreamUrl.search = query;
	}

	const upstreamResult = await fetchUpstream(fetcher, upstreamUrl, {
		method: request.method,
		headers,
		body,
	}, policy);
	if (upstreamResult.kind === "overflow") return apiErrorResponse(503, "unavailable");
	if (upstreamResult.kind === "failure") return apiErrorResponse(503, "unavailable");

	const upstream = upstreamResult.response;
	const setCookies = readSetCookieHeaders(upstream.headers);
	if (setCookies === null) return apiErrorResponse(503, "unavailable");

	if (path === "sign-in/social") {
		const redirectUrl = upstream.headers.get("location");
		if (upstream.status >= 300 && upstream.status < 400) {
			if (!redirectUrl || !isSafeGitHubAuthorizationUrl(redirectUrl)) {
				return apiErrorResponse(500, "internal-error", setCookies);
			}
			return jsonResponse({ url: redirectUrl }, 200, undefined, setCookies);
		}
		if (!upstream.ok) return apiErrorResponse(upstream.status === 401 ? 401 : 503, upstream.status === 401 ? "unauthenticated" : "unavailable", setCookies);
		const parsed = parseJson(upstreamResult.text);
		if (!parsed.ok) return apiErrorResponse(500, "internal-error", setCookies);
		const url = isPlainRecord(parsed.value) ? parsed.value.url : undefined;
		if (!isSafeGitHubAuthorizationUrl(url)) return apiErrorResponse(500, "internal-error", setCookies);
		return jsonResponse({ url }, 200, undefined, setCookies);
	}

	if (path === "callback/github") {
		if (upstream.status >= 300 && upstream.status < 400) {
			const location = upstream.headers.get("location");
			if (!location || !isSafeCallbackLocation(location, config.publicOrigin)) {
				return apiErrorResponse(500, "internal-error", setCookies);
			}
			return redirectResponse("/device", setCookies);
		}
		return redirectResponse("/login", setCookies);
	}

	if (!upstream.ok) return apiErrorResponse(upstream.status === 401 ? 401 : 503, upstream.status === 401 ? "unauthenticated" : "unavailable", setCookies);

	if (path === "get-session") {
		const parsed = parseJson(upstreamResult.text);
		if (!parsed.ok) return apiErrorResponse(503, "unavailable", setCookies);
		const user = safeUserFromAuthSession(parsed.value);
		return jsonResponse(user ? { user } : { user: null }, 200, undefined, setCookies);
	}

	return jsonResponse({ success: true }, 200, undefined, setCookies);
}

function nativePostPath(endpoint: "verify" | "approve" | "deny" | "revoke", grantID?: string): string | null {
	if (endpoint === "verify") return "/api/native/v1/device-authorizations/verify";
	if (endpoint === "approve") return "/api/native/v1/device-authorizations/approve";
	if (endpoint === "deny") return "/api/native/v1/device-authorizations/deny";
	if (endpoint === "revoke" && grantID && UUID.test(grantID)) {
		return `/api/native/v1/grants/${grantID}/revoke`;
	}
	return null;
}

function nativeRequestBody(
	endpoint: "verify" | "approve" | "deny" | "revoke",
	input: unknown,
): Record<string, unknown> | null {
	if (endpoint === "revoke") {
		return isExactObject(input, []) ? {} : null;
	}
	if (endpoint === "approve") {
		if (!isExactObject(input, ["userCode", "confirm"]) || input.confirm !== true || !isCrockfordCode(input.userCode)) {
			return null;
		}
		return { userCode: input.userCode, confirm: true };
	}
	if (!isExactObject(input, ["userCode"]) || !isCrockfordCode(input.userCode)) return null;
	return { userCode: input.userCode };
}

function isCrockfordCode(value: unknown): value is string {
	return typeof value === "string" && CROCKFORD_CODE.test(value);
}

async function fetchNative(
	config: ServerConfig,
	policy: BffPolicy,
	path: string,
	method: "GET" | "POST",
	headers: Headers,
	body: string | undefined,
	shape: "session" | "grants" | "verify" | "approve" | "deny" | "revoke",
	fetcher: Fetcher | undefined,
): Promise<Response> {
	const upstreamResult = await fetchUpstream(fetcher ?? fetch, new URL(path, `${config.apiOrigin}/`), {
		method,
		headers,
		body,
	}, policy);
	if (upstreamResult.kind === "overflow") return apiErrorResponse(503, "unavailable");
	if (upstreamResult.kind === "failure") return apiErrorResponse(503, "unavailable");

	const upstream = upstreamResult.response;
	if (upstream.status >= 300 && upstream.status < 400) return apiErrorResponse(500, "internal-error");
	const parsed = parseJson(upstreamResult.text);
	if (!parsed.ok) return apiErrorResponse(503, "unavailable");

	if (!upstream.ok) {
		const safeError = sanitizeApiError(parsed.value);
		if (!safeError) return apiErrorResponse(500, "internal-error");
		const status = isApiStatus(upstream.status) ? upstream.status : 500;
		return jsonResponse(
			isApiStatus(upstream.status) ? safeError : apiErrorPayload("internal-error"),
			status,
			retryHeaders(upstream.headers),
		);
	}

	const sanitized = sanitizeNativeSuccess(shape, parsed.value);
	if (!sanitized) return apiErrorResponse(500, "internal-error");
	return jsonResponse(sanitized, upstream.status, retryHeaders(upstream.headers));
}

function sanitizeNativeSuccess(
	shape: "session" | "grants" | "verify" | "approve" | "deny" | "revoke",
	payload: unknown,
): unknown | null {
	if (!isPlainRecord(payload)) return null;
	if (shape === "session") {
		const user = safeUser(payload.user);
		const csrfToken = payload.csrfToken;
		if (!user || !isCanonicalCsrfToken(csrfToken)) return null;
		return { user, csrfToken };
	}
	if (shape === "grants") {
		if (!Array.isArray(payload.grants)) return null;
		const grants = payload.grants.map(safeGrant);
		if (grants.some((grant) => grant === null)) return null;
		return { grants };
	}
	if (shape === "verify") {
		const consent = payload.consent;
		if (!isPlainRecord(consent)) return null;
		const account = safeUser(consent.account);
		const scopes = consent.scopes;
		if (
			!account ||
			!Array.isArray(scopes) ||
			!scopes.every((scope) => typeof scope === "string" && scope.trim().length > 0) ||
			typeof consent.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(consent.expiresAt))
		) {
			return null;
		}
		return { consent: { account, scopes, expiresAt: consent.expiresAt } };
	}
	const expectedStatus = shape === "approve" ? "approved" : shape === "deny" ? "denied" : "revoked";
	return payload.status === expectedStatus ? { status: expectedStatus } : null;
}

function isCanonicalCsrfToken(value: unknown): value is string {
	if (typeof value !== "string" || !CSRF_TOKEN.test(value)) return false;
	const bytes = Buffer.from(value, "base64url");
	return bytes.length === 32 && bytes.toString("base64url") === value;
}

function safeUser(value: unknown): { id: string; name: string; email: string } | null {
	if (!isPlainRecord(value)) return null;
	if (
		typeof value.id !== "string" ||
		value.id.trim().length === 0 ||
		typeof value.name !== "string" ||
		value.name.trim().length === 0 ||
		typeof value.email !== "string" ||
		value.email.trim().length === 0
	) return null;
	return { id: value.id, name: value.name, email: value.email };
}

function safeUserFromAuthSession(value: unknown): { id: string; name: string; email: string } | null {
	if (!isPlainRecord(value)) return null;
	return safeUser(value.user);
}

function safeGrant(value: unknown): Record<string, unknown> | null {
	if (!isPlainRecord(value)) return null;
	if (
		typeof value.id !== "string" ||
		!UUID.test(value.id) ||
		typeof value.deviceID !== "string" ||
		value.deviceID.length === 0 ||
		typeof value.createdAt !== "string" ||
		!Number.isFinite(Date.parse(value.createdAt)) ||
		typeof value.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(value.expiresAt)) ||
		!(value.lastSeenAt === null || (typeof value.lastSeenAt === "string" && Number.isFinite(Date.parse(value.lastSeenAt)))) ||
		!(value.revokedAt === null || (typeof value.revokedAt === "string" && Number.isFinite(Date.parse(value.revokedAt)))) ||
		(value.status !== "active" && value.status !== "revoked")
	) {
		return null;
	}
	return {
		id: value.id,
		deviceID: value.deviceID,
		createdAt: value.createdAt,
		expiresAt: value.expiresAt,
		lastSeenAt: value.lastSeenAt,
		revokedAt: value.revokedAt,
		status: value.status,
	};
}

function sanitizeApiError(value: unknown): unknown | null {
	if (!isPlainRecord(value) || !isPlainRecord(value.error)) return null;
	const error = value.error;
	if (
		typeof error.code !== "string" ||
		!ERROR_CODES.has(error.code as ApiErrorCode) ||
		typeof error.message !== "string" ||
		typeof error.retryable !== "boolean" ||
		typeof error.requestID !== "string" ||
		!UUID.test(error.requestID)
	) {
		return null;
	}
	const code = error.code as ApiErrorCode;
	return {
		error: {
			code,
			message: ERROR_MESSAGES[code],
			retryable: error.retryable,
			requestID: error.requestID,
		},
	};
}

function apiErrorPayload(code: ApiErrorCode): unknown {
	return {
		error: {
			code,
			message: ERROR_MESSAGES[code],
			retryable: code === "unavailable" || code === "rate-limited",
			requestID: randomUUID(),
		},
	};
}

function isApiStatus(status: number): boolean {
	return API_ERROR_STATUSES.has(status);
}

function retryHeaders(headers: Headers): Headers {
	const result = new Headers();
	const retryAfter = headers.get("retry-after");
	if (retryAfter && /^\d+$/.test(retryAfter)) result.set("retry-after", retryAfter);
	return result;
}

function isExactNativeUrl(request: Request, path: string): boolean {
	try {
		const url = new URL(request.url);
		return url.pathname === path && url.search === "" && url.hash === "";
	} catch {
		return false;
	}
}

function isExactAuthUrl(request: Request, path: string, allowQuery: boolean): boolean {
	try {
		const url = new URL(request.url);
		return url.pathname === path && (allowQuery || url.search === "") && url.hash === "";
	} catch {
		return false;
	}
}

function safeOAuthCallbackQuery(request: Request): string | null {
	const allowed = new Set(["code", "state", "error", "error_description"]);
	try {
		const url = new URL(request.url);
		const out = new URLSearchParams();
		for (const [key, value] of url.searchParams) {
			if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
			out.append(key, value);
		}
		return out.toString();
	} catch {
		return null;
	}
}

function isSafeCallbackLocation(location: string, publicOrigin: string): boolean {
	try {
		const url = new URL(location, `${publicOrigin}/`);
		return (
			url.origin === publicOrigin &&
			url.pathname === "/device" &&
			url.search === "" &&
			url.hash === "" &&
			url.username === "" &&
			url.password === ""
		);
	} catch {
		return false;
	}
}

function readSetCookieHeaders(headers: Headers): string[] | null {
	const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	if (typeof getSetCookie !== "function") {
		return headers.has("set-cookie") ? null : [];
	}
	return getSetCookie.call(headers);
}

function redirectResponse(path: "/device" | "/login", setCookies: readonly string[]): Response {
	const headers = noStoreHeaders();
	headers.set("location", path);
	appendSetCookies(headers, setCookies);
	return new Response(null, { status: 303, headers });
}

function jsonResponse(
	value: unknown,
	status: number,
	extraHeaders?: HeadersInit,
	setCookies: readonly string[] = [],
): Response {
	const headers = noStoreHeaders();
	headers.set("content-type", "application/json; charset=utf-8");
	if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
	appendSetCookies(headers, setCookies);
	return new Response(JSON.stringify(value) ?? "null", { status, headers });
}

function appendSetCookies(headers: Headers, cookies: readonly string[]): void {
	for (const cookie of cookies) headers.append("set-cookie", cookie);
}

function noStoreHeaders(): Headers {
	return new Headers({
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	});
}

type BoundedJsonBody =
	| { kind: "value"; value: unknown }
	| { kind: "too-large" }
	| { kind: "invalid" };

async function readBoundedJson(request: Request, maxBytes: number): Promise<BoundedJsonBody> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null && /^[0-9]+$/.test(contentLength)) {
		const length = Number(contentLength);
		if (!Number.isSafeInteger(length) || length > maxBytes) return { kind: "too-large" };
	}
	if (request.body === null) return { kind: "invalid" };

	const read = await readBoundedStream(request.body, maxBytes);
	if (read.kind === "overflow") return { kind: "too-large" };
	if (read.kind === "failure") return { kind: "invalid" };

	try {
		return { kind: "value", value: JSON.parse(read.text) };
	} catch {
		return { kind: "invalid" };
	}
}

type BoundedText =
	| { kind: "text"; text: string }
	| { kind: "overflow" }
	| { kind: "failure" };

async function readBoundedStream(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<BoundedText> {
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = stream.getReader();
	} catch {
		return { kind: "failure" };
	}

	let abortListener: (() => void) | undefined;
	const aborted = signal
		? new Promise<never>((_resolve, reject) => {
			abortListener = () => reject(new Error("aborted"));
			if (signal.aborted) {
				abortListener();
			} else {
				signal.addEventListener("abort", abortListener, { once: true });
			}
		})
		: null;

	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const chunk = aborted ? await Promise.race([reader.read(), aborted]) : await reader.read();
			if (chunk.done) break;
			if (!(chunk.value instanceof Uint8Array)) return { kind: "failure" };
			total += chunk.value.byteLength;
			if (total > maxBytes) {
				try {
					await reader.cancel();
				} catch {
					// The overflow failure is fixed below regardless of cancellation.
				}
				return { kind: "overflow" };
			}
			chunks.push(chunk.value);
		}
	} catch {
		try {
			await reader.cancel();
		} catch {
			// The read failure is fixed below regardless of cancellation.
		}
		return { kind: "failure" };
	} finally {
		if (signal && abortListener) signal.removeEventListener("abort", abortListener);
		try {
			reader.releaseLock();
		} catch {
			// Releasing a cancelled reader is best-effort.
		}
	}

	return { kind: "text", text: Buffer.concat(chunks).toString("utf8") };
}

type UpstreamResult =
	| { kind: "response"; response: Response; text: string }
	| { kind: "overflow" }
	| { kind: "failure" };

async function fetchUpstream(
	fetcher: Fetcher,
	url: URL,
	init: RequestInit,
	policy: BffPolicy,
): Promise<UpstreamResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), policy.upstreamTimeoutMs);
	try {
		const response = await fetcher(url, {
			...init,
			redirect: "manual",
			cache: "no-store",
			signal: controller.signal,
		});
		if (!(response instanceof Response)) return { kind: "failure" };
		if (response.body === null) return { kind: "response", response, text: "" };

		const read = await readBoundedStream(response.body, policy.maxResponseBytes, controller.signal);
		if (read.kind === "overflow") return { kind: "overflow" };
		if (read.kind === "failure") return { kind: "failure" };
		return { kind: "response", response, text: read.text };
	} catch {
		return { kind: "failure" };
	} finally {
		clearTimeout(timer);
	}
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (!isPlainRecord(value)) return false;
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
