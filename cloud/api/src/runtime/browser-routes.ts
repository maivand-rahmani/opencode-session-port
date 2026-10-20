/**
 * Bounded same-origin bridge for the four browser-auth routes exposed by the
 * frozen M2/M3 API surface. It forwards a manually constructed Fetch Request
 * to the configured BetterAuth browser authority and sanitises the response.
 *
 * The bridge never forwards arbitrary vendor paths, Host/Forwarded identity,
 * Authorization headers, proxy headers, or client identity fields. The URL is
 * always rebuilt from the configured canonical origin. Cookies are preserved
 * as a `Set-Cookie` array; response bodies are bounded and never logged.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { apiErrorEnvelope, type ApiErrorCode } from '../errors.js';
import type { BrowserSessionAuthority } from '../native-auth/browser.js';

export const BROWSER_GET_SESSION_PATH = '/api/auth/get-session';
export const BROWSER_GITHUB_CALLBACK_PATH = '/api/auth/callback/github';
export const BROWSER_SIGN_IN_SOCIAL_PATH = '/api/auth/sign-in/social';
export const BROWSER_SIGN_OUT_PATH = '/api/auth/sign-out';

const INVALID_DEPENDENCY_MESSAGE = 'Invalid browser auth dependency.';
const AUTH_UNAVAILABLE_MESSAGE = 'The authentication service is unavailable.';

export interface BrowserAuthBridgeOptions {
  readonly authority: BrowserSessionAuthority;
  readonly canonicalOrigin: string;
  readonly maxResponseBytes: number;
}

export function readBrowserAuthDependency(
  value: unknown,
): BrowserAuthBridgeOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidDependency();
  }

  const candidate = value as {
    readonly authority?: unknown;
    readonly canonicalOrigin?: unknown;
    readonly maxResponseBytes?: unknown;
  };
  const authority = candidate.authority;
  if (
    typeof authority !== 'object' ||
    authority === null ||
    Array.isArray(authority) ||
    typeof (authority as { readonly readSession?: unknown }).readSession !==
      'function' ||
    typeof (authority as { readonly handle?: unknown }).handle !== 'function'
  ) {
    throw invalidDependency();
  }

  const canonicalOrigin = candidate.canonicalOrigin;
  if (typeof canonicalOrigin !== 'string') {
    throw invalidDependency();
  }
  let parsed: URL;
  try {
    parsed = new URL(canonicalOrigin);
  } catch {
    throw invalidDependency();
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.origin !== canonicalOrigin ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw invalidDependency();
  }

  const maxResponseBytes = candidate.maxResponseBytes;
  if (
    typeof maxResponseBytes !== 'number' ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0
  ) {
    throw invalidDependency();
  }

  return Object.freeze({
    authority: authority as BrowserSessionAuthority,
    canonicalOrigin: parsed.origin,
    maxResponseBytes,
  });
}

export function isBrowserAuthRouteAllowed(
  method: string,
  path: string,
): boolean {
  if (method === 'GET' && path === BROWSER_GET_SESSION_PATH) {
    return true;
  }
  if (method === 'GET' && path === BROWSER_GITHUB_CALLBACK_PATH) {
    return true;
  }
  if (method === 'POST' && path === BROWSER_SIGN_IN_SOCIAL_PATH) {
    return true;
  }
  return method === 'POST' && path === BROWSER_SIGN_OUT_PATH;
}

export function registerBrowserAuthRoutes(
  app: FastifyInstance,
  options: BrowserAuthBridgeOptions,
): void {
  const deps = readBrowserAuthDependency(options);

  app.get(
    BROWSER_GET_SESSION_PATH,
    {
      onRequest: async (request, reply) => {
        rejectUnsafeBrowserRequest(request, reply);
      },
    },
    async (request, reply) => {
      try {
        const query = readNoQuery(request);
        if (query === null) {
          return sendFixed(reply, request.id, 400, 'invalid-request');
        }
        const response = await deps.authority.handle(
          buildRequest(request, deps, BROWSER_GET_SESSION_PATH, 'GET'),
        );
        return await handleGetSession(reply, request.id, response, deps);
      } catch {
        return sendUnavailable(reply, request.id);
      }
    },
  );

  app.get(
    BROWSER_GITHUB_CALLBACK_PATH,
    {
      onRequest: async (request, reply) => {
        rejectUnsafeBrowserRequest(request, reply);
      },
    },
    async (request, reply) => {
      try {
        const query = readCallbackQuery(request);
        if (query === null) {
          return sendFixed(reply, request.id, 400, 'invalid-request');
        }
        const response = await deps.authority.handle(
          buildRequest(
            request,
            deps,
            BROWSER_GITHUB_CALLBACK_PATH,
            'GET',
            query,
          ),
        );
        return await handleCallback(reply, request.id, response, deps);
      } catch {
        return sendUnavailable(reply, request.id);
      }
    },
  );

  app.post(
    BROWSER_SIGN_IN_SOCIAL_PATH,
    {
      onRequest: async (request, reply) => {
        if (!rejectUnsafeBrowserRequest(request, reply)) {
          requirePostOrigin(request, reply, deps.canonicalOrigin);
        }
      },
    },
    async (request, reply) => {
      try {
        const query = readNoQuery(request);
        if (query === null) {
          return sendFixed(reply, request.id, 400, 'invalid-request');
        }
        const body = readSignInBody(request.body, deps.canonicalOrigin);
        if (body === null) {
          return sendFixed(reply, request.id, 400, 'invalid-request');
        }
        const response = await deps.authority.handle(
          buildRequest(
            request,
            deps,
            BROWSER_SIGN_IN_SOCIAL_PATH,
            'POST',
            undefined,
            JSON.stringify(body),
          ),
        );
        return await handleSignIn(reply, request.id, response, deps);
      } catch {
        return sendUnavailable(reply, request.id);
      }
    },
  );

  app.post(
    BROWSER_SIGN_OUT_PATH,
    {
      onRequest: async (request, reply) => {
        if (!rejectUnsafeBrowserRequest(request, reply)) {
          requirePostOrigin(request, reply, deps.canonicalOrigin);
        }
      },
    },
    async (request, reply) => {
      try {
        const query = readNoQuery(request);
        if (query === null) {
          return sendFixed(reply, request.id, 400, 'invalid-request');
        }
        if (!isSignOutBody(request.body)) {
          return sendFixed(reply, request.id, 400, 'invalid-request');
        }
        const response = await deps.authority.handle(
          buildRequest(
            request,
            deps,
            BROWSER_SIGN_OUT_PATH,
            'POST',
            undefined,
            '{}',
          ),
        );
        return await handleSignOut(reply, request.id, response, deps);
      } catch {
        return sendUnavailable(reply, request.id);
      }
    },
  );
}

function rejectUnsafeBrowserRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (readHeaderValues(request, 'authorization').length > 0) {
    void sendFixed(reply, request.id, 401, 'unauthenticated');
    return true;
  }

  const contentType = request.headers['content-type'];
  if (
    request.method !== 'GET' &&
    (typeof contentType !== 'string' ||
      !/^application\/json(?:\s*;|$)/i.test(contentType))
  ) {
    void sendFixed(reply, request.id, 415, 'unsupported-media-type');
    return true;
  }

  return false;
}

function requirePostOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  canonicalOrigin: string,
): boolean {
  const origins = readHeaderValues(request, 'origin');
  if (origins.length !== 1 || origins[0] !== canonicalOrigin) {
    void sendFixed(reply, request.id, 403, 'forbidden');
    return false;
  }
  return true;
}

function readHeaderValues(request: FastifyRequest, name: string): string[] {
  const values: string[] = [];
  const raw = request.raw.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (String(raw[index]).toLowerCase() === name) {
      values.push(String(raw[index + 1]));
    }
  }
  if (values.length > 0) {
    return values;
  }

  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return typeof value === 'string' ? [value] : [];
}

function readCookie(request: FastifyRequest): string | undefined {
  const values = readHeaderValues(request, 'cookie');
  return values.length === 0 ? undefined : values.join('; ');
}

function buildRequest(
  request: FastifyRequest,
  deps: BrowserAuthBridgeOptions,
  path: string,
  method: 'GET' | 'POST',
  query?: URLSearchParams,
  body?: string,
): Request {
  const url = new URL(`${deps.canonicalOrigin}${path}`);
  if (query !== undefined && query.size > 0) {
    url.search = query.toString();
  }

  const headers = new Headers();
  const cookie = readCookie(request);
  if (cookie !== undefined) {
    headers.set('cookie', cookie);
  }
  const accept = request.headers.accept;
  if (typeof accept === 'string') {
    headers.set('accept', accept);
  }
  const userAgent = request.headers['user-agent'];
  if (typeof userAgent === 'string') {
    headers.set('user-agent', userAgent);
  }
  if (method === 'POST') {
    headers.set('origin', deps.canonicalOrigin);
    headers.set('content-type', 'application/json');
  }

  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function readNoQuery(request: FastifyRequest): boolean | null {
  const query = request.query;
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    return null;
  }
  return Object.keys(query).length === 0 ? true : null;
}

function readCallbackQuery(request: FastifyRequest): URLSearchParams | null {
  const query = request.query;
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    return null;
  }

  const allowed = new Set([
    'code',
    'state',
    'error',
    'error_description',
  ]);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== 'string') {
      return null;
    }
    params.set(key, value);
  }
  return params;
}

interface SignInBody {
  readonly provider: 'github';
  readonly callbackURL: string;
}

function readSignInBody(
  body: unknown,
  canonicalOrigin: string,
): SignInBody | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some(
      (key) =>
        key !== 'provider' &&
        key !== 'callbackURL',
    ) ||
    record.provider !== 'github'
  ) {
    return null;
  }

  const callbackURL = `${canonicalOrigin}/device`;
  if (
    record.callbackURL !== undefined &&
    record.callbackURL !== callbackURL
  ) {
    return null;
  }

  return { provider: 'github', callbackURL };
}

function isSignOutBody(body: unknown): boolean {
  if (body === undefined || body === null) {
    return true;
  }
  return (
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as object).length === 0
  );
}

async function handleGetSession(
  reply: FastifyReply,
  requestID: string,
  response: Response,
  deps: BrowserAuthBridgeOptions,
): Promise<FastifyReply> {
  const setCookies = readSetCookies(response);
  if (!response.ok) {
    applySetCookies(reply, setCookies);
    return sendVendorError(reply, requestID, response.status);
  }

  const raw = await readBoundedBody(response, deps.maxResponseBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendUnavailable(reply, requestID);
  }

  const user = parsed !== null && typeof parsed === 'object'
    ? (parsed as { user?: unknown }).user
    : null;
  applySetCookies(reply, setCookies);
  return reply.code(200).send({ user: sanitizeUser(user) });
}

async function handleCallback(
  reply: FastifyReply,
  requestID: string,
  response: Response,
  deps: BrowserAuthBridgeOptions,
): Promise<FastifyReply> {
  const setCookies = readSetCookies(response);
  if (response.status < 300 || response.status >= 400) {
    applySetCookies(reply, setCookies);
    return sendVendorError(reply, requestID, response.status);
  }

  const location = response.headers.get('location');
  if (location === null) {
    return sendUnavailable(reply, requestID);
  }
  let target: URL;
  try {
    target = new URL(location, deps.canonicalOrigin);
  } catch {
    return sendUnavailable(reply, requestID);
  }
  if (
    target.origin !== deps.canonicalOrigin ||
    target.pathname !== '/device'
  ) {
    return sendUnavailable(reply, requestID);
  }

  applySetCookies(reply, setCookies);
  return reply
    .code(response.status)
    .header('location', target.toString())
    .send();
}

async function handleSignIn(
  reply: FastifyReply,
  requestID: string,
  response: Response,
  deps: BrowserAuthBridgeOptions,
): Promise<FastifyReply> {
  const setCookies = readSetCookies(response);
  if (response.status >= 400) {
    applySetCookies(reply, setCookies);
    return sendVendorError(reply, requestID, response.status);
  }

  if (response.status >= 300) {
    const location = response.headers.get('location');
    const redirectURL = location === null
      ? null
      : validateGitHubAuthorizationURL(location);
    if (redirectURL === null) {
      return sendUnavailable(reply, requestID);
    }
    applySetCookies(reply, setCookies);
    return reply
      .code(response.status)
      .header('location', redirectURL)
      .send();
  }

  const raw = await readBoundedBody(response, deps.maxResponseBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendUnavailable(reply, requestID);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return sendUnavailable(reply, requestID);
  }
  const record = parsed as { url?: unknown; redirect?: unknown };
  const candidate =
    typeof record.url === 'string'
      ? record.url
      : typeof record.redirect === 'string'
        ? record.redirect
        : null;
  const redirectURL = candidate === null
    ? null
    : validateGitHubAuthorizationURL(candidate);
  if (redirectURL === null) {
    return sendUnavailable(reply, requestID);
  }

  applySetCookies(reply, setCookies);
  return reply.code(200).send({ redirectURL });
}

async function handleSignOut(
  reply: FastifyReply,
  requestID: string,
  response: Response,
  deps: BrowserAuthBridgeOptions,
): Promise<FastifyReply> {
  const setCookies = readSetCookies(response);
  if (!response.ok) {
    applySetCookies(reply, setCookies);
    return sendVendorError(reply, requestID, response.status);
  }

  // Drain a bounded body but never forward vendor JSON or raw session state.
  await readBoundedBody(response, deps.maxResponseBytes);
  applySetCookies(reply, setCookies);
  return reply.code(200).send({});
}

function validateGitHubAuthorizationURL(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/login/oauth/authorize'
  ) {
    return null;
  }
  return parsed.toString();
}

function sanitizeUser(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const user: Record<string, unknown> = {};
  if (typeof record.id === 'string') {
    user.id = record.id;
  }
  if (typeof record.name === 'string') {
    user.name = record.name;
  }
  if (typeof record.email === 'string') {
    user.email = record.email;
  }
  if (typeof record.image === 'string' || record.image === null) {
    user.image = record.image;
  }
  if (typeof record.emailVerified === 'boolean') {
    user.emailVerified = record.emailVerified;
  }
  return Object.keys(user).length === 0 ? null : user;
}

function readSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  return typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [];
}

function applySetCookies(reply: FastifyReply, cookies: readonly string[]): void {
  if (cookies.length > 0) {
    void reply.header('set-cookie', [...cookies]);
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('response too large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function sendVendorError(
  reply: FastifyReply,
  requestID: string,
  status: number,
): FastifyReply {
  if (status === 400 || status === 422) {
    return sendFixed(reply, requestID, 400, 'invalid-request');
  }
  if (status === 401) {
    return sendFixed(reply, requestID, 401, 'unauthenticated');
  }
  if (status === 403) {
    return sendFixed(reply, requestID, 403, 'forbidden');
  }
  if (status === 404) {
    return sendFixed(reply, requestID, 404, 'not-found');
  }
  if (status === 429) {
    return reply
      .header('Retry-After', '1')
      .code(503)
      .send(
        apiErrorEnvelope(
          'unavailable',
          AUTH_UNAVAILABLE_MESSAGE,
          true,
          requestID,
        ),
      );
  }
  return sendUnavailable(reply, requestID);
}

function sendUnavailable(
  reply: FastifyReply,
  requestID: string,
): FastifyReply {
  return reply
    .header('Retry-After', '1')
    .code(503)
    .send(
      apiErrorEnvelope(
        'unavailable',
        AUTH_UNAVAILABLE_MESSAGE,
        true,
        requestID,
      ),
    );
}

const ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = Object.freeze({
  'invalid-json': 'The request body is not valid JSON.',
  'payload-too-large': 'The request body is too large.',
  'unsupported-media-type': 'The request content type is not supported.',
  'invalid-request': 'The request is invalid.',
  unauthenticated: 'Authentication is required.',
  'not-found': 'The requested resource was not found.',
  unavailable: AUTH_UNAVAILABLE_MESSAGE,
  'internal-error': 'An internal error occurred.',
});

function sendFixed(
  reply: FastifyReply,
  requestID: string,
  status: number,
  code: ApiErrorCode | 'forbidden',
): FastifyReply {
  if (code === 'forbidden') {
    return reply.code(status).send({
      error: {
        code: 'forbidden',
        message: 'The request is not permitted.',
        retryable: false,
        requestID,
      },
    });
  }
  return reply
    .code(status)
    .send(
      apiErrorEnvelope(
        code,
        ERROR_MESSAGES[code],
        code === 'unavailable',
        requestID,
      ),
    );
}

function invalidDependency(): TypeError {
  return new TypeError(INVALID_DEPENDENCY_MESSAGE);
}
