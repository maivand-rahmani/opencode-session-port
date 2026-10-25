import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';

import type {
  BrowserSession,
  BrowserSessionAuthority,
} from '../../src/native-auth/browser.js';
import {
  NATIVE_VERIFICATION_PATH,
  type NativeAuthConfig,
} from '../../src/native-auth/config.js';
import { issueCsrfToken } from '../../src/native-auth/csrf.js';
import {
  registerNativeAuthRoutes,
  type NativeAuthRouteDependencies,
} from '../../src/native-auth/routes.js';
import {
  NativeAuthServiceError,
  type NativeAuthService,
  type NativeBrowserAccount,
  type NativeConsentResponse,
  type NativeDecisionResponse,
  type NativeDeviceAuthorizationResponse,
  type NativeGrantView,
  type NativeGrantsResponse,
  type NativeRevokeResponse,
  type NativeTokenResponse,
} from '../../src/native-auth/service.js';
import type {
  NativeRateLimitDecision,
  NativeRateLimiter,
} from '../../src/native-auth/rate-limit.js';

/*
 * Focused route tests with Fastify inject(), a synthetic service, browser
 * authority, and rate limiter. They prove the local HTTP boundary and raw
 * header checks. They do NOT prove BetterAuth, CSRF key deployment, PostgreSQL,
 * real rate-limit sharing, network behavior, or production composition.
 */

const ORIGIN = 'https://api.example.test';
const USER_ID = 'user_01HTESTVENDOROPAQUE';
const SESSION_ID = 'session_synthetic_01';
const USER_CODE = '0123456789AB';
const DEVICE_CODE = Buffer.alloc(32, 4).toString('base64url');
const ACCESS_TOKEN = Buffer.alloc(32, 5).toString('base64url');
const REFRESH_TOKEN = Buffer.alloc(32, 6).toString('base64url');
const GRANT_ID = '7c1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';

const POLICY = {
  ttlSeconds: {
    pendingAuthorization: 300,
    accessToken: 60,
    refreshToken: 600,
    grant: 3_600,
  },
  polling: {
    intervalSeconds: 5,
    backoffIncrementSeconds: 5,
    maxIntervalSeconds: 30,
  },
  rateLimits: {
    createAuthorization: { windowSeconds: 60, maxRequests: 100 },
    browserVerification: { windowSeconds: 60, maxRequests: 100 },
    browserLookup: { windowSeconds: 60, maxRequests: 100 },
    approveAuthorization: { windowSeconds: 60, maxRequests: 100 },
    denyAuthorization: { windowSeconds: 60, maxRequests: 100 },
    exchangeDeviceCode: { windowSeconds: 60, maxRequests: 100 },
    refreshToken: { windowSeconds: 60, maxRequests: 100 },
    listGrants: { windowSeconds: 60, maxRequests: 100 },
    revokeGrant: { windowSeconds: 60, maxRequests: 100 },
  },
  capacity: {
    maxOutstandingPendingAuthorizationsPerUser: 10,
    maxActiveGrantsPerUser: 3,
    retentionSeconds: {
      pendingAuthorizationRecords: 86_400,
      spentTokenRecords: 86_400,
      revokedGrantRecords: 86_400,
    },
  },
  authorization: {
    audience: ORIGIN,
    resource: ORIGIN,
    allowedScopes: ['projects:read', 'projects:write'],
    requiredRouteScopes: { 'projects.create': ['projects:write'] },
  },
} as const;

const CONFIG: NativeAuthConfig = {
  publicOrigin: ORIGIN,
  verificationUri: `${ORIGIN}${NATIVE_VERIFICATION_PATH}`,
  allowLoopbackHttp: false,
  betterAuth: {
    secret: 'synthetic-better-auth-secret-0123456789',
    github: {
      clientID: 'synthetic-github-client-id',
      clientSecret: 'synthetic-github-client-secret',
    },
  },
  humanCodes: {
    keys: [{ id: 'key-1', key: Buffer.alloc(32, 1) }],
    activeKeyID: 'key-1',
  },
  csrfKey: Buffer.alloc(32, 2),
  policy: POLICY,
};

const SESSION: BrowserSession = Object.freeze({
  sessionID: SESSION_ID,
  userID: USER_ID,
  name: 'Synthetic User',
  email: 'synthetic@example.test',
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
});

const ACCOUNT: NativeBrowserAccount = Object.freeze({
  id: USER_ID,
  name: SESSION.name as string,
  email: SESSION.email as string,
});

const CSRF = issueCsrfToken(CONFIG.csrfKey, SESSION_ID);

interface FakeServiceOptions {
  readonly create?: () => Promise<NativeDeviceAuthorizationResponse>;
  readonly verify?: (
    userCode: string,
    account: NativeBrowserAccount,
  ) => Promise<NativeConsentResponse>;
  readonly approve?: (
    userCode: string,
    userID: string,
  ) => Promise<NativeDecisionResponse>;
  readonly deny?: (userCode: string) => Promise<NativeDecisionResponse>;
  readonly exchange?: (deviceCode: string) => Promise<NativeTokenResponse>;
  readonly refresh?: (refreshToken: string) => Promise<NativeTokenResponse>;
  readonly list?: (userID: string) => Promise<NativeGrantsResponse>;
  readonly revoke?: (
    userID: string,
    grantID: string,
  ) => Promise<NativeRevokeResponse>;
}

class FakeService implements NativeAuthService {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  error: unknown = undefined;
  readonly options: FakeServiceOptions;

  constructor(options: FakeServiceOptions = {}) {
    this.options = options;
  }

  async createDeviceAuthorization(): Promise<NativeDeviceAuthorizationResponse> {
    this.calls.push({ method: 'create', args: [] });
    this.throwIfSet();
    if (this.options.create) return this.options.create();
    return {
      deviceCode: DEVICE_CODE,
      userCode: USER_CODE,
      verificationUri: CONFIG.verificationUri,
      expiresIn: 300,
      pollInterval: 5,
    };
  }

  async verifyUserCode(
    userCode: string,
    account: NativeBrowserAccount,
  ): Promise<NativeConsentResponse> {
    this.calls.push({ method: 'verify', args: [userCode, account] });
    this.throwIfSet();
    if (this.options.verify) return this.options.verify(userCode, account);
    return {
      consent: {
        account,
        scopes: ['projects:read'],
        expiresAt: '2026-10-20T13:00:00.000Z',
      },
    };
  }

  async approveUserCode(
    userCode: string,
    userID: string,
  ): Promise<NativeDecisionResponse> {
    this.calls.push({ method: 'approve', args: [userCode, userID] });
    this.throwIfSet();
    if (this.options.approve) return this.options.approve(userCode, userID);
    return { status: 'approved' };
  }

  async denyUserCode(userCode: string): Promise<NativeDecisionResponse> {
    this.calls.push({ method: 'deny', args: [userCode] });
    this.throwIfSet();
    if (this.options.deny) return this.options.deny(userCode);
    return { status: 'denied' };
  }

  async exchangeDeviceCode(deviceCode: string): Promise<NativeTokenResponse> {
    this.calls.push({ method: 'exchange', args: [deviceCode] });
    this.throwIfSet();
    if (this.options.exchange) return this.options.exchange(deviceCode);
    return {
      accessToken: ACCESS_TOKEN,
      tokenType: 'Bearer',
      expiresIn: 60,
      refreshToken: REFRESH_TOKEN,
      scope: 'projects:read',
    };
  }

  async refreshToken(refreshToken: string): Promise<NativeTokenResponse> {
    this.calls.push({ method: 'refresh', args: [refreshToken] });
    this.throwIfSet();
    if (this.options.refresh) return this.options.refresh(refreshToken);
    return {
      accessToken: ACCESS_TOKEN,
      tokenType: 'Bearer',
      expiresIn: 60,
      refreshToken: REFRESH_TOKEN,
      scope: 'projects:read',
    };
  }

  async listGrants(userID: string): Promise<NativeGrantsResponse> {
    this.calls.push({ method: 'list', args: [userID] });
    this.throwIfSet();
    if (this.options.list) return this.options.list(userID);
    const grant: NativeGrantView = {
      id: GRANT_ID,
      deviceID: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      createdAt: '2026-10-20T12:00:00.000Z',
      expiresAt: '2026-10-20T13:00:00.000Z',
      lastSeenAt: null,
      revokedAt: null,
      status: 'active',
    };
    return { grants: [grant] };
  }

  async revokeGrant(
    userID: string,
    grantID: string,
  ): Promise<NativeRevokeResponse> {
    this.calls.push({ method: 'revoke', args: [userID, grantID] });
    this.throwIfSet();
    if (this.options.revoke) return this.options.revoke(userID, grantID);
    return { status: 'revoked' };
  }

  async authorizeBearer(): Promise<never> {
    throw new Error('not used');
  }

  private throwIfSet(): void {
    if (this.error !== undefined) throw this.error;
  }
}

class FakeBrowser implements BrowserSessionAuthority {
  calls = 0;
  error: unknown = undefined;

  async readSession(cookie: string): Promise<BrowserSession | null> {
    this.calls += 1;
    if (this.error !== undefined) throw this.error;
    return cookie.includes('session=valid') ? SESSION : null;
  }

  async handle(): Promise<Response> {
    return new Response('ok');
  }
}

class FakeRateLimiter implements NativeRateLimiter {
  readonly calls: Array<{
    operation: string;
    key: string;
    policy: unknown;
  }> = [];
  error: unknown = undefined;
  decision: NativeRateLimitDecision = { allowed: true };

  async consume(
    operation: string,
    key: string,
    policy: unknown,
  ): Promise<NativeRateLimitDecision> {
    this.calls.push({ operation, key, policy });
    if (this.error !== undefined) throw this.error;
    return this.decision;
  }
}

function validHeaders(overrides: Record<string, unknown> = {}) {
  return {
    cookie: 'session=valid',
    origin: ORIGIN,
    'content-type': 'application/json',
    'x-sessionport-csrf': CSRF,
    ...overrides,
  };
}

function makeApp(
  t: TestContext,
  options: {
    readonly service?: FakeService;
    readonly browser?: FakeBrowser;
    readonly limiter?: FakeRateLimiter;
    readonly config?: NativeAuthConfig;
    readonly retryAfterSeconds?: number;
  } = {},
): {
  readonly app: FastifyInstance;
  readonly service: FakeService;
  readonly browser: FakeBrowser;
  readonly limiter: FakeRateLimiter;
} {
  const service = options.service ?? new FakeService();
  const browser = options.browser ?? new FakeBrowser();
  const limiter = options.limiter ?? new FakeRateLimiter();
  const app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: false,
  });
  const dependencies: NativeAuthRouteDependencies = {
    service,
    browser,
    config: options.config ?? CONFIG,
    rateLimiter: limiter,
    retryAfterSeconds: options.retryAfterSeconds ?? 7,
  };
  registerNativeAuthRoutes(app, dependencies);
  t.after(async () => {
    await app.close();
  });
  return { app, service, browser, limiter };
}

function json(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function errorCode(response: { body: string }): string | null {
  const body = json(response);
  const error = body.error;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

test('route dependencies require every service method, browser authority, config, limiter, and retry value', () => {
  const service = new FakeService();
  const browser = new FakeBrowser();
  const base = {
    service,
    browser,
    config: CONFIG,
    rateLimiter: new FakeRateLimiter(),
    retryAfterSeconds: 7,
  };
  assert.throws(
    () => registerNativeAuthRoutes(Fastify(), { ...base, rateLimiter: undefined } as never),
    /Invalid native-auth/,
  );
  assert.throws(
    () =>
      registerNativeAuthRoutes(Fastify(), {
        ...base,
        service: { ...service, verifyUserCode: undefined },
      } as never),
    /Invalid native-auth route dependency/,
  );
  assert.throws(
    () =>
      registerNativeAuthRoutes(Fastify(), {
        ...base,
        config: { ...CONFIG, csrfKey: Buffer.alloc(4) },
      } as never),
    /Invalid native-auth route dependency/,
  );
});

test('GET /session returns the authoritative user and a session-bound CSRF token', async (t) => {
  const { app, browser } = makeApp(t);
  const response = await app.inject({
    method: 'GET',
    url: '/api/native/v1/session',
    headers: { cookie: 'session=valid' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.deepEqual(json(response), {
    user: ACCOUNT,
    csrfToken: CSRF,
  });
  assert.equal(browser.calls, 1);
});

test('browser routes reject any Authorization header before reading cookies', async (t) => {
  const { app, browser, service } = makeApp(t);
  const response = await app.inject({
    method: 'GET',
    url: '/api/native/v1/session',
    headers: {
      cookie: 'session=valid',
      authorization: `Bearer ${ACCESS_TOKEN}`,
    },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(errorCode(response), 'forbidden');
  assert.equal(browser.calls, 0);
  assert.equal(service.calls.length, 0);
});

test('POST /verify requires session, rate limit, raw CSRF/origin, then exact body', async (t) => {
  const { app, service, limiter } = makeApp(t);
  const valid = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations/verify',
    headers: validHeaders(),
    payload: JSON.stringify({ userCode: USER_CODE }),
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(json(valid), {
    consent: {
      account: ACCOUNT,
      scopes: ['projects:read'],
      expiresAt: '2026-10-20T13:00:00.000Z',
    },
  });
  assert.deepEqual(service.calls[0], {
    method: 'verify',
    args: [USER_CODE, ACCOUNT],
  });
  assert.equal(limiter.calls[0]?.operation, 'browserLookup');
  assert.equal(String(limiter.calls[0]?.key).includes(USER_ID), false);

  service.calls.length = 0;
  const extra = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations/verify',
    headers: validHeaders(),
    payload: JSON.stringify({ userCode: USER_CODE, userID: USER_ID }),
  });
  assert.equal(extra.statusCode, 400);
  assert.equal(service.calls.length, 0);

  const duplicateOrigin = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations/verify',
    headers: validHeaders({ origin: [ORIGIN, ORIGIN] }),
    payload: JSON.stringify({ userCode: USER_CODE }),
  });
  assert.equal(duplicateOrigin.statusCode, 400);
  assert.equal(service.calls.length, 0);

  const withoutCsrf = validHeaders();
  delete (withoutCsrf as Record<string, unknown>)['x-sessionport-csrf'];
  const missingCsrf = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations/verify',
    headers: withoutCsrf,
    payload: JSON.stringify({ userCode: USER_CODE }),
  });
  assert.equal(missingCsrf.statusCode, 400);
  assert.equal(service.calls.length, 0);

  const duplicateCsrf = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations/verify',
    headers: validHeaders({ 'x-sessionport-csrf': [CSRF, CSRF] }),
    payload: JSON.stringify({ userCode: USER_CODE }),
  });
  assert.equal(duplicateCsrf.statusCode, 400);
  assert.equal(service.calls.length, 0);
});

test('approve requires confirm:true and binds the session user, never a body user', async (t) => {
  const { app, service } = makeApp(t);
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations/approve',
    headers: validHeaders(),
    payload: JSON.stringify({ userCode: USER_CODE, confirm: false }),
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(service.calls.length, 0);

  const forged = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations/approve',
    headers: validHeaders(),
    payload: JSON.stringify({
      userCode: USER_CODE,
      confirm: true,
      userID: 'user_forged',
    }),
  });
  assert.equal(forged.statusCode, 400);
  assert.equal(service.calls.length, 0);

  const valid = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations/approve',
    headers: validHeaders(),
    payload: JSON.stringify({ userCode: USER_CODE, confirm: true }),
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(json(valid), { status: 'approved' });
  assert.deepEqual(service.calls[0], {
    method: 'approve',
    args: [USER_CODE, USER_ID],
  });
});

test('GET /grants and revoke use only the session user and return non-secret fields', async (t) => {
  const { app, service, limiter } = makeApp(t);
  const listed = await app.inject({
    method: 'GET',
    url: '/api/native/v1/grants',
    headers: { cookie: 'session=valid' },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(service.calls[0], { method: 'list', args: [USER_ID] });
  const grant = (json(listed).grants as Array<Record<string, unknown>>)[0];
  assert.equal(grant?.status, 'active');
  assert.equal(grant?.expiresAt, '2026-10-20T13:00:00.000Z');
  assert.equal(Object.hasOwn(grant ?? {}, 'fingerprint'), false);

  const revoke = await app.inject({
    method: 'POST',
    url: `/api/native/v1/grants/${GRANT_ID}/revoke`,
    headers: validHeaders(),
    payload: '{}',
  });
  assert.equal(revoke.statusCode, 200);
  assert.deepEqual(json(revoke), { status: 'revoked' });
  assert.deepEqual(service.calls[1], {
    method: 'revoke',
    args: [USER_ID, GRANT_ID],
  });
  assert.equal(limiter.calls[1]?.operation, 'revokeGrant');

  const extra = await app.inject({
    method: 'POST',
    url: `/api/native/v1/grants/${GRANT_ID}/revoke`,
    headers: validHeaders(),
    payload: JSON.stringify({ userID: USER_ID }),
  });
  assert.equal(extra.statusCode, 400);
});

test('public creation rejects credential headers, requires an empty body, and returns exact wire fields', async (t) => {
  const { app, service, limiter } = makeApp(t);

  const withCookie = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations',
    headers: { cookie: 'session=valid', 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(withCookie.statusCode, 403);
  assert.equal(limiter.calls.length, 0);

  const withBearer = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations',
    headers: {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      'content-type': 'application/json',
    },
    payload: '{}',
  });
  assert.equal(withBearer.statusCode, 403);

  const extra = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ userID: USER_ID }),
  });
  assert.equal(extra.statusCode, 400);
  assert.equal(service.calls.length, 0);

  const valid = await app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations',
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(json(valid), {
    deviceCode: DEVICE_CODE,
    userCode: USER_CODE,
    verificationUri: CONFIG.verificationUri,
    expiresIn: 300,
    pollInterval: 5,
  });
  assert.equal(limiter.calls[0]?.operation, 'createAuthorization');
  assert.equal(String(limiter.calls[0]?.key).startsWith('ip:'), true);
  assert.equal(String(limiter.calls[0]?.key).includes('127.0.0.1'), false);
});

test('token endpoint accepts only the explicit device/refresh union and redacts credential keys', async (t) => {
  const { app, service, limiter } = makeApp(t);

  const device = await app.inject({
    method: 'POST',
    url: '/api/native/v1/token',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ grantType: 'device_code', deviceCode: DEVICE_CODE }),
  });
  assert.equal(device.statusCode, 200);
  assert.deepEqual(json(device), {
    accessToken: ACCESS_TOKEN,
    tokenType: 'Bearer',
    expiresIn: 60,
    refreshToken: REFRESH_TOKEN,
    scope: 'projects:read',
  });
  assert.deepEqual(service.calls[0], { method: 'exchange', args: [DEVICE_CODE] });
  assert.deepEqual(
    limiter.calls.slice(0, 2).map((call) => call.operation),
    ['exchangeDeviceCode', 'exchangeDeviceCode'],
  );
  assert.equal(String(limiter.calls[0]?.key).startsWith('ip:'), true);
  assert.equal(String(limiter.calls[1]?.key).startsWith('fp:'), true);
  assert.equal(String(limiter.calls[1]?.key).includes(DEVICE_CODE), false);

  const snake = await app.inject({
    method: 'POST',
    url: '/api/native/v1/token',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ device_code: DEVICE_CODE }),
  });
  assert.equal(snake.statusCode, 200);

  const refresh = await app.inject({
    method: 'POST',
    url: '/api/native/v1/token',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ grantType: 'refresh_token', refreshToken: REFRESH_TOKEN }),
  });
  assert.equal(refresh.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), {
    method: 'refresh',
    args: [REFRESH_TOKEN],
  });
  assert.equal(limiter.calls.at(-1)?.operation, 'refreshToken');

  for (const payload of [
    { deviceCode: DEVICE_CODE, refreshToken: REFRESH_TOKEN },
    { grantType: 'refresh_token', deviceCode: DEVICE_CODE },
    { deviceCode: DEVICE_CODE, userID: USER_ID },
    { grantType: 'device_code' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/native/v1/token',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    assert.equal(response.statusCode, 400);
  }

  const withCookie = await app.inject({
    method: 'POST',
    url: '/api/native/v1/token',
    headers: { cookie: 'session=valid', 'content-type': 'application/json' },
    payload: JSON.stringify({ deviceCode: DEVICE_CODE }),
  });
  assert.equal(withCookie.statusCode, 403);
});

test('GET /verify redirects to the fixed /device page without a code or query', async (t) => {
  const { app } = makeApp(t);
  const response = await app.inject({
    method: 'GET',
    url: `${NATIVE_VERIFICATION_PATH}?userCode=${USER_CODE}`,
  });
  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, `${ORIGIN}/device`);
  assert.equal(String(response.headers.location).includes(USER_CODE), false);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('rate-limit denial and limiter failure fail closed with Retry-After', async (t) => {
  const deniedLimiter = new FakeRateLimiter();
  deniedLimiter.decision = { allowed: false, retryAfterSeconds: 9 };
  const denied = makeApp(t, { limiter: deniedLimiter });
  const deniedResponse = await denied.app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations',
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(deniedResponse.statusCode, 429);
  assert.equal(deniedResponse.headers['retry-after'], '9');
  assert.equal(errorCode(deniedResponse), 'rate-limited');
  assert.equal(denied.service.calls.length, 0);

  const brokenLimiter = new FakeRateLimiter();
  brokenLimiter.error = new Error('limiter secret');
  const broken = makeApp(t, { limiter: brokenLimiter });
  const brokenResponse = await broken.app.inject({
    method: 'POST',
    url: '/api/native/v1/device-authorizations',
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(brokenResponse.statusCode, 503);
  assert.equal(brokenResponse.headers['retry-after'], '7');
  assert.equal(errorCode(brokenResponse), 'unavailable');
  assert.equal(brokenResponse.body.includes('limiter secret'), false);
});

test('poll errors carry Retry-After and unknown service errors are redacted', async (t) => {
  const pendingService = new FakeService({
    exchange: async () => {
      throw new NativeAuthServiceError('authorization-pending', 4);
    },
  });
  const poll = makeApp(t, { service: pendingService });
  const pollResponse = await poll.app.inject({
    method: 'POST',
    url: '/api/native/v1/token',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ deviceCode: DEVICE_CODE }),
  });
  assert.equal(pollResponse.statusCode, 400);
  assert.equal(pollResponse.headers['retry-after'], '4');
  assert.equal(errorCode(pollResponse), 'authorization-pending');
  assert.equal(pollResponse.body.includes(DEVICE_CODE), false);

  const brokenService = new FakeService();
  brokenService.error = new Error(`vendor detail token=${DEVICE_CODE}`);
  const broken = makeApp(t, { service: brokenService });
  const brokenResponse = await broken.app.inject({
    method: 'POST',
    url: '/api/native/v1/token',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ deviceCode: DEVICE_CODE }),
  });
  assert.equal(brokenResponse.statusCode, 500);
  assert.equal(errorCode(brokenResponse), 'internal-error');
  assert.equal(brokenResponse.body.includes(DEVICE_CODE), false);
  assert.equal(brokenResponse.body.includes('vendor detail'), false);
  assert.equal(brokenResponse.headers['cache-control'], 'no-store');
  assert.equal(brokenResponse.headers['referrer-policy'], 'no-referrer');
});

test('legacy unprovisioned quota exchanges stay a redacted 500 until opt-in is configured', async (t) => {
  const quotaService = new FakeService({
    exchange: async () => {
      throw new NativeAuthServiceError('quota-not-provisioned');
    },
  });
  const quota = makeApp(t, { service: quotaService });
  const response = await quota.app.inject({
    method: 'POST',
    url: '/api/native/v1/token',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ deviceCode: DEVICE_CODE }),
  });

  assert.equal(response.statusCode, 500);
  assert.equal(errorCode(response), 'quota-not-provisioned');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.body.includes(DEVICE_CODE), false);
});
