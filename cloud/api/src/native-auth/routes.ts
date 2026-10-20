/**
 * Explicit native-auth Fastify routes.
 *
 * This module does not mount itself on the API application. The composition
 * root must pass `registerNativeAuthRoutes` to the chosen Fastify instance
 * after supplying the service, browser session authority, native-auth config,
 * and a required rate limiter.
 *
 * Browser routes and native bearer routes are separate principals. A browser
 * route rejects any Authorization header before reading cookies, and native
 * public endpoints reject Cookie/Authorization headers so credentials cannot
 * be replayed across principal types.
 *
 * Every mutation requires the frozen CSRF boundary: exactly one canonical
 * Origin, JSON content type, and the session-bound `x-sessionport-csrf` header.
 * CSRF/origin checks run before the user code is read from the body. No route
 * logs bodies, credentials, or codes.
 */

import { createHash } from 'node:crypto';

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type {
  BrowserSession,
  BrowserSessionAuthority,
} from './browser.js';
import {
  NATIVE_VERIFICATION_PATH,
  type NativeAuthConfig,
  type NativeAuthPolicy,
} from './config.js';
import { fingerprintCredential } from './credentials.js';
import {
  NativeAuthServiceError,
  type NativeAuthService,
  type NativeBrowserAccount,
} from './service.js';
import {
  assertBrowserMutation,
  issueCsrfToken,
} from './csrf.js';
import {
  NATIVE_RATE_LIMIT_OPERATIONS,
  readNativeRateLimiter,
  type NativeRateLimitDecision,
  type NativeRateLimitOperation,
  type NativeRateLimiter,
} from './rate-limit.js';

const BASE_PATH = '/api/native/v1';
const SESSION_PATH = `${BASE_PATH}/session`;
const DEVICE_AUTHORIZATIONS_PATH = `${BASE_PATH}/device-authorizations`;
const VERIFY_PATH = NATIVE_VERIFICATION_PATH;
const TOKEN_PATH = `${BASE_PATH}/token`;
const GRANTS_PATH = `${BASE_PATH}/grants`;
const REVOKE_PATH = `${BASE_PATH}/grants/:grantID/revoke`;
const GRANT_ID_PARAM = 'grantID';
const VERIFICATION_PAGE_PATH = '/device';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MAX_ORIGIN_LENGTH = 2_048;

export interface NativeAuthRouteDependencies {
  readonly service: NativeAuthService;
  readonly browser: BrowserSessionAuthority;
  readonly config: NativeAuthConfig;
  readonly rateLimiter: NativeRateLimiter;
  /** Retry-After value for fail-closed 503 responses. */
  readonly retryAfterSeconds: number;
}

type RateLimitOutcome =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'denied';
      readonly retryAfterSeconds: number;
    }
  | { readonly kind: 'unavailable' };

const SERVICE_METHODS = [
  'createDeviceAuthorization',
  'verifyUserCode',
  'approveUserCode',
  'denyUserCode',
  'exchangeDeviceCode',
  'refreshToken',
  'listGrants',
  'revokeGrant',
  'authorizeBearer',
] as const;

/**
 * Validate the complete route dependency before registering anything. A
 * missing/malformed limiter fails construction instead of silently creating
 * unlimited routes.
 */
export function readNativeAuthRouteDependencies(
  value: unknown,
): NativeAuthRouteDependencies {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidDependency();
  }

  const candidate = value as {
    readonly service?: unknown;
    readonly browser?: unknown;
    readonly config?: unknown;
    readonly rateLimiter?: unknown;
    readonly retryAfterSeconds?: unknown;
  };

  const service = candidate.service;
  if (typeof service !== 'object' || service === null || Array.isArray(service)) {
    throw invalidDependency();
  }
  for (const method of SERVICE_METHODS) {
    if (typeof (service as Record<string, unknown>)[method] !== 'function') {
      throw invalidDependency();
    }
  }

  const browser = candidate.browser;
  if (
    typeof browser !== 'object' ||
    browser === null ||
    Array.isArray(browser) ||
    typeof (browser as { readonly readSession?: unknown }).readSession !==
      'function'
  ) {
    throw invalidDependency();
  }

  const config = readRouteConfig(candidate.config);
  const rateLimiter = readNativeRateLimiter(candidate.rateLimiter);

  if (
    typeof candidate.retryAfterSeconds !== 'number' ||
    !Number.isSafeInteger(candidate.retryAfterSeconds) ||
    candidate.retryAfterSeconds < 0
  ) {
    throw invalidDependency();
  }

  return Object.freeze({
    service: service as NativeAuthService,
    browser: browser as BrowserSessionAuthority,
    config,
    rateLimiter,
    retryAfterSeconds: candidate.retryAfterSeconds,
  });
}

/**
 * Register the frozen native-auth wire surface on the supplied instance.
 */
export function registerNativeAuthRoutes(
  app: FastifyInstance,
  dependencies: NativeAuthRouteDependencies,
): void {
  const deps = readNativeAuthRouteDependencies(dependencies);

  app.get(SESSION_PATH, async (request, reply) => {
    setNoStore(reply);
    const session = await requireBrowserSession(request, reply, deps);
    if (session === null) return reply;

    const account = accountFromSession(session);
    if (account === null) {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('unavailable'),
        deps,
      );
    }

    let csrfToken: string;
    try {
      csrfToken = issueCsrfToken(deps.config.csrfKey, session.sessionID);
    } catch {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('unavailable'),
        deps,
      );
    }

    return reply.code(200).send({ user: account, csrfToken });
  });

  app.get(VERIFY_PATH, async (request, reply) => {
    setNoStore(reply);
    if (hasAuthorizationHeader(request.headers.authorization)) {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('forbidden'),
        deps,
      );
    }

    const rate = await consumeRateLimit(
      deps,
      'browserVerification',
      hashedIPKey(request),
    );
    const rateReply = sendRateOutcome(reply, request.id, rate, deps);
    if (rateReply !== null) return rateReply;

    return reply
      .code(303)
      .header(
        'Location',
        `${deps.config.publicOrigin}${VERIFICATION_PAGE_PATH}`,
      )
      .send();
  });

  app.post(VERIFY_PATH, async (request, reply) => {
    setNoStore(reply);
    const session = await requireBrowserSession(request, reply, deps);
    if (session === null) return reply;

    const account = accountFromSession(session);
    if (account === null) {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('unavailable'),
        deps,
      );
    }

    const rate = await consumeRateLimit(
      deps,
      'browserLookup',
      browserKey(session.userID),
    );
    const rateReply = sendRateOutcome(reply, request.id, rate, deps);
    if (rateReply !== null) return rateReply;

    if (!assertMutationBoundary(request, reply, session, deps)) {
      return reply;
    }

    const body = readExactBody(request.body, ['userCode']);
    if (body === null || typeof body.userCode !== 'string') {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('invalid-request'),
        deps,
      );
    }

    try {
      const consent = await deps.service.verifyUserCode(body.userCode, account);
      return reply.code(200).send(consent);
    } catch (error) {
      return sendServiceError(reply, request.id, error, deps);
    }
  });

  app.post(`${DEVICE_AUTHORIZATIONS_PATH}/approve`, async (request, reply) => {
    setNoStore(reply);
    const session = await requireBrowserSession(request, reply, deps);
    if (session === null) return reply;

    const rate = await consumeRateLimit(
      deps,
      'approveAuthorization',
      browserKey(session.userID),
    );
    const rateReply = sendRateOutcome(reply, request.id, rate, deps);
    if (rateReply !== null) return rateReply;

    if (!assertMutationBoundary(request, reply, session, deps)) {
      return reply;
    }

    const body = readExactBody(request.body, ['userCode', 'confirm']);
    if (
      body === null ||
      typeof body.userCode !== 'string' ||
      body.confirm !== true
    ) {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('invalid-request'),
        deps,
      );
    }

    try {
      const result = await deps.service.approveUserCode(
        body.userCode,
        session.userID,
      );
      return reply.code(200).send(result);
    } catch (error) {
      return sendServiceError(reply, request.id, error, deps);
    }
  });

  app.post(`${DEVICE_AUTHORIZATIONS_PATH}/deny`, async (request, reply) => {
    setNoStore(reply);
    const session = await requireBrowserSession(request, reply, deps);
    if (session === null) return reply;

    const rate = await consumeRateLimit(
      deps,
      'denyAuthorization',
      browserKey(session.userID),
    );
    const rateReply = sendRateOutcome(reply, request.id, rate, deps);
    if (rateReply !== null) return rateReply;

    if (!assertMutationBoundary(request, reply, session, deps)) {
      return reply;
    }

    const body = readExactBody(request.body, ['userCode']);
    if (body === null || typeof body.userCode !== 'string') {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('invalid-request'),
        deps,
      );
    }

    try {
      const result = await deps.service.denyUserCode(body.userCode);
      return reply.code(200).send(result);
    } catch (error) {
      return sendServiceError(reply, request.id, error, deps);
    }
  });

  app.get(GRANTS_PATH, async (request, reply) => {
    setNoStore(reply);
    const session = await requireBrowserSession(request, reply, deps);
    if (session === null) return reply;

    const rate = await consumeRateLimit(
      deps,
      'listGrants',
      browserKey(session.userID),
    );
    const rateReply = sendRateOutcome(reply, request.id, rate, deps);
    if (rateReply !== null) return rateReply;

    try {
      const grants = await deps.service.listGrants(session.userID);
      return reply.code(200).send(grants);
    } catch (error) {
      return sendServiceError(reply, request.id, error, deps);
    }
  });

  app.post(REVOKE_PATH, async (request, reply) => {
    setNoStore(reply);
    const session = await requireBrowserSession(request, reply, deps);
    if (session === null) return reply;

    const rate = await consumeRateLimit(
      deps,
      'revokeGrant',
      browserKey(session.userID),
    );
    const rateReply = sendRateOutcome(reply, request.id, rate, deps);
    if (rateReply !== null) return rateReply;

    if (!assertMutationBoundary(request, reply, session, deps)) {
      return reply;
    }

    const body = readExactBody(request.body, []);
    if (body === null) {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('invalid-request'),
        deps,
      );
    }

    const grantID = readGrantID(request.params);
    if (grantID === null) {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('not-found'),
        deps,
      );
    }

    try {
      const result = await deps.service.revokeGrant(session.userID, grantID);
      return reply.code(200).send(result);
    } catch (error) {
      return sendServiceError(reply, request.id, error, deps);
    }
  });

  app.post(DEVICE_AUTHORIZATIONS_PATH, async (request, reply) => {
    setNoStore(reply);

    // Public native creation is not a browser route. Reject any credential
    // header so a browser cookie or bearer value cannot be replayed here.
    if (
      hasAuthorizationHeader(request.headers.authorization) ||
      hasCookieHeader(request.headers.cookie)
    ) {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('forbidden'),
        deps,
      );
    }

    const rate = await consumeRateLimit(
      deps,
      'createAuthorization',
      hashedIPKey(request),
    );
    const rateReply = sendRateOutcome(reply, request.id, rate, deps);
    if (rateReply !== null) return rateReply;

    const body = readExactBody(request.body, []);
    if (body === null) {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('invalid-request'),
        deps,
      );
    }

    try {
      const authorization = await deps.service.createDeviceAuthorization();
      return reply.code(200).send(authorization);
    } catch (error) {
      return sendServiceError(reply, request.id, error, deps);
    }
  });

  app.post(TOKEN_PATH, async (request, reply) => {
    setNoStore(reply);

    if (
      hasAuthorizationHeader(request.headers.authorization) ||
      hasCookieHeader(request.headers.cookie)
    ) {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('forbidden'),
        deps,
      );
    }

    const body = readTokenBody(request.body);
    if (body === null) {
      return sendServiceError(
        reply,
        request.id,
        new NativeAuthServiceError('invalid-request'),
        deps,
      );
    }

    const credentialKey = safeRateFingerprint(body.kind, body.token);
    const rate = await consumeTokenRateLimits(
      deps,
      body.kind === 'device' ? 'exchangeDeviceCode' : 'refreshToken',
      request,
      credentialKey,
    );
    const rateReply = sendRateOutcome(reply, request.id, rate, deps);
    if (rateReply !== null) return rateReply;

    try {
      const tokens =
        body.kind === 'device'
          ? await deps.service.exchangeDeviceCode(body.token)
          : await deps.service.refreshToken(body.token);
      return reply.code(200).send(tokens);
    } catch (error) {
      return sendServiceError(reply, request.id, error, deps);
    }
  });
}

interface TokenRequestBody {
  readonly kind: 'device' | 'refresh';
  readonly token: string;
}

function readTokenBody(rawBody: unknown): TokenRequestBody | null {
  if (
    typeof rawBody !== 'object' ||
    rawBody === null ||
    Array.isArray(rawBody)
  ) {
    return null;
  }

  const body = rawBody as Record<string, unknown>;
  const keys = Object.keys(body);
  const allowed = new Set([
    'grantType',
    'deviceCode',
    'device_code',
    'refreshToken',
    'refresh_token',
  ]);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    return null;
  }

  const deviceFields = ['deviceCode', 'device_code'].filter((key) =>
    Object.hasOwn(body, key),
  );
  const refreshFields = ['refreshToken', 'refresh_token'].filter((key) =>
    Object.hasOwn(body, key),
  );
  if (deviceFields.length + refreshFields.length !== 1) {
    return null;
  }

  const kind = deviceFields.length === 1 ? 'device' : 'refresh';
  const field = kind === 'device' ? deviceFields[0] : refreshFields[0];
  const token = body[field];
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }

  if (Object.hasOwn(body, 'grantType')) {
    if (keys.length !== 2) return null;
    const expected = kind === 'device' ? 'device_code' : 'refresh_token';
    if (body.grantType !== expected) return null;
  } else if (keys.length !== 1) {
    return null;
  }

  return { kind, token };
}

function readExactBody(
  rawBody: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (
    typeof rawBody !== 'object' ||
    rawBody === null ||
    Array.isArray(rawBody)
  ) {
    return null;
  }
  const body = rawBody as Record<string, unknown>;
  const keys = Object.keys(body);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(body, key))
  ) {
    return null;
  }
  return body;
}

function readGrantID(params: unknown): string | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return null;
  }
  const value = (params as Record<string, unknown>)[GRANT_ID_PARAM];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

async function requireBrowserSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: NativeAuthRouteDependencies,
): Promise<BrowserSession | null> {
  if (hasAuthorizationHeader(request.headers.authorization)) {
    sendServiceError(
      reply,
      request.id,
      new NativeAuthServiceError('forbidden'),
      deps,
    );
    return null;
  }

  const cookie = readCookieHeader(request.headers.cookie);
  if (cookie === null) {
    sendServiceError(
      reply,
      request.id,
      new NativeAuthServiceError('unauthenticated'),
      deps,
    );
    return null;
  }

  let session: BrowserSession | null;
  try {
    session = await deps.browser.readSession(cookie);
  } catch {
    sendServiceError(
      reply,
      request.id,
      new NativeAuthServiceError('unavailable'),
      deps,
    );
    return null;
  }

  if (session === null) {
    sendServiceError(
      reply,
      request.id,
      new NativeAuthServiceError('unauthenticated'),
      deps,
    );
    return null;
  }
  return session;
}

function assertMutationBoundary(
  request: FastifyRequest,
  reply: FastifyReply,
  session: BrowserSession,
  deps: NativeAuthRouteDependencies,
): boolean {
  try {
    assertBrowserMutation(
      {
        method: request.method,
        rawHeaders: request.raw.rawHeaders,
      },
      {
        publicOrigin: deps.config.publicOrigin,
        sessionID: session.sessionID,
        csrfKey: deps.config.csrfKey,
      },
    );
    return true;
  } catch {
    sendServiceError(
      reply,
      request.id,
      new NativeAuthServiceError('invalid-request'),
      deps,
    );
    return false;
  }
}

async function consumeRateLimit(
  deps: NativeAuthRouteDependencies,
  operation: NativeRateLimitOperation,
  key: string,
): Promise<RateLimitOutcome> {
  const policy = deps.config.policy.rateLimits[operation];
  try {
    const decision: NativeRateLimitDecision = await deps.rateLimiter.consume(
      operation,
      key,
      policy,
    );
    if (
      typeof decision !== 'object' ||
      decision === null ||
      typeof decision.allowed !== 'boolean'
    ) {
      return { kind: 'unavailable' };
    }
    if (decision.allowed) {
      return { kind: 'allowed' };
    }
    return {
      kind: 'denied',
      retryAfterSeconds:
        typeof decision.retryAfterSeconds === 'number' &&
        Number.isSafeInteger(decision.retryAfterSeconds) &&
        decision.retryAfterSeconds > 0
          ? decision.retryAfterSeconds
          : policy.windowSeconds,
    };
  } catch {
    // A limiter that cannot answer denies the request. There is no allow-all
    // fallback.
    return { kind: 'unavailable' };
  }
}

/**
 * Token attempts are limited in two independent dimensions: the source IP and
 * the presented credential fingerprint. Rotating credentials therefore cannot
 * escape the source limit, and a single credential cannot be brute-forced
 * across many sources.
 */
async function consumeTokenRateLimits(
  deps: NativeAuthRouteDependencies,
  operation: NativeRateLimitOperation,
  request: FastifyRequest,
  credentialKey: string,
): Promise<RateLimitOutcome> {
  const source = await consumeRateLimit(deps, operation, hashedIPKey(request));
  if (source.kind !== 'allowed') {
    return source;
  }
  return consumeRateLimit(deps, operation, `fp:${credentialKey}`);
}

function sendRateOutcome(
  reply: FastifyReply,
  requestID: string,
  outcome: RateLimitOutcome,
  deps: NativeAuthRouteDependencies,
): FastifyReply | null {
  if (outcome.kind === 'allowed') {
    return null;
  }
  if (outcome.kind === 'denied') {
    return sendServiceError(
      reply,
      requestID,
      new NativeAuthServiceError('rate-limited', outcome.retryAfterSeconds),
      deps,
    );
  }
  return sendServiceError(
    reply,
    requestID,
    new NativeAuthServiceError('unavailable'),
    deps,
  );
}

function sendServiceError(
  reply: FastifyReply,
  requestID: string,
  error: unknown,
  deps: NativeAuthRouteDependencies,
): FastifyReply {
  const serviceError =
    error instanceof NativeAuthServiceError
      ? error
      : new NativeAuthServiceError('internal-error');

  const retryAfter = resolveRetryAfter(serviceError, deps);
  setNoStore(reply);
  if (retryAfter !== undefined) {
    void reply.header('Retry-After', String(retryAfter));
  }

  return reply.code(serviceError.statusCode).send({
    error: {
      code: serviceError.code,
      message: serviceError.message,
      retryable: serviceError.retryable,
      requestID,
    },
  });
}

function resolveRetryAfter(
  error: NativeAuthServiceError,
  deps: NativeAuthRouteDependencies,
): number | undefined {
  if (error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds;
  }
  if (error.statusCode === 503) {
    return deps.retryAfterSeconds;
  }
  if (error.code === 'rate-limited') {
    return 1;
  }
  return undefined;
}

function setNoStore(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store');
  void reply.header('Referrer-Policy', 'no-referrer');
}

function hasAuthorizationHeader(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function hasCookieHeader(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function readCookieHeader(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

function accountFromSession(
  session: BrowserSession,
): NativeBrowserAccount | null {
  if (
    typeof session.name !== 'string' ||
    session.name.length === 0 ||
    typeof session.email !== 'string' ||
    session.email.length === 0 ||
    typeof session.userID !== 'string' ||
    session.userID.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    id: session.userID,
    name: session.name,
    email: session.email,
  });
}

function hashedIPKey(request: FastifyRequest): string {
  // The host instance must be built with `trustProxy: false` (the API
  // foundation's posture) so request.ip cannot be supplied by a client
  // forwarding header. Only a SHA-256 digest of the address enters the
  // limiter map; raw addresses are never logged or stored here.
  return `ip:${createHash('sha256')
    .update(request.ip, 'utf8')
    .digest('hex')}`;
}

function browserKey(userID: string): string {
  return `user:${createHash('sha256').update(userID, 'utf8').digest('hex')}`;
}

function safeRateFingerprint(
  kind: 'device' | 'refresh',
  token: string,
): string {
  try {
    return fingerprintCredential(kind, token);
  } catch {
    return 'invalid';
  }
}

function readRouteConfig(rawConfig: unknown): NativeAuthConfig {
  if (
    typeof rawConfig !== 'object' ||
    rawConfig === null ||
    Array.isArray(rawConfig)
  ) {
    throw invalidDependency();
  }
  const config = rawConfig as Partial<NativeAuthConfig>;
  const publicOrigin = config.publicOrigin;
  const verificationUri = config.verificationUri;
  const csrfKey = config.csrfKey;
  const policy = config.policy;

  if (
    typeof publicOrigin !== 'string' ||
    !isCanonicalOrigin(publicOrigin) ||
    (typeof config.allowLoopbackHttp !== 'boolean' &&
      config.allowLoopbackHttp !== undefined) ||
    !isAllowedTransport(publicOrigin, config.allowLoopbackHttp === true) ||
    typeof verificationUri !== 'string' ||
    verificationUri !== `${publicOrigin}${NATIVE_VERIFICATION_PATH}` ||
    !(csrfKey instanceof Uint8Array) ||
    csrfKey.byteLength < 32 ||
    typeof policy !== 'object' ||
    policy === null
  ) {
    throw invalidDependency();
  }

  readRoutePolicy(policy);
  return config as NativeAuthConfig;
}

function readRoutePolicy(policy: NativeAuthPolicy): void {
  if (
    typeof policy.rateLimits !== 'object' ||
    policy.rateLimits === null ||
    typeof policy.capacity !== 'object' ||
    policy.capacity === null
  ) {
    throw invalidDependency();
  }

  for (const operation of NATIVE_RATE_LIMIT_OPERATIONS) {
    const value = policy.rateLimits[operation];
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof value.windowSeconds !== 'number' ||
      !Number.isSafeInteger(value.windowSeconds) ||
      value.windowSeconds <= 0 ||
      typeof value.maxRequests !== 'number' ||
      !Number.isSafeInteger(value.maxRequests) ||
      value.maxRequests <= 0
    ) {
      throw invalidDependency();
    }
  }
}

function isCanonicalOrigin(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_ORIGIN_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
    parsed.origin === value &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.pathname === '/'
  );
}

function isAllowedTransport(value: string, allowLoopbackHttp: boolean): boolean {
  const parsed = new URL(value);
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:' || !allowLoopbackHttp) return false;
  if (parsed.hostname === 'localhost' || parsed.hostname === '[::1]') {
    return true;
  }
  const octets = parsed.hostname.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every(
      (octet) => /^[0-9]{1,3}$/.test(octet) && Number(octet) <= 255,
    )
  );
}

function invalidDependency(): TypeError {
  return new TypeError('Invalid native-auth route dependency.');
}
