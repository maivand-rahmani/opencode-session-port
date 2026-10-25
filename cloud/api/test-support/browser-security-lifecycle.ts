/**
 * Bounded LIVE browser-security lifecycle proof (M3 test-support).
 *
 * Direct current API only (no Next BFF). Actual Fastify loopback listener,
 * actual BetterAuth 1.7.11 browser authority, actual native-auth browser
 * routes/CSRF, actual PostgreSQL runtime role.
 *
 * Real vendor browser sessions are seeded for two fresh synthetic users through
 * BetterAuth's internal adapter (`createUser` + `createSession`) and the
 * installed BetterAuth cookie-signing format (HMAC-SHA256 over the session
 * token, `token.signature`, URI-encoded). The signed cookie is kept in memory,
 * never serialized, logged, or emitted. There is no OAuth replay, no provider
 * use, no password login, no injected browser authority, and no fake
 * `getSession`/principal. The vendor `getSession` API and the actual HTTP route
 * both verify the cookie.
 *
 * PASS only: exact tracked fixture rows are deleted in FK-safe order and scoped
 * counts must be zero. FAIL: no cleanup, no retry, owned IDs retained.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fingerprintCredential } from '../src/native-auth/credentials.ts';

const API_ROOT = '/app/cloud/api';
const PRIVATE_DIR = '/private';
const POLICY_FILE = '/validation/test-only-values.json';
const ORIGIN = 'http://127.0.0.1:43117';
const WRONG_ORIGIN = 'http://127.0.0.1:43118';
const PORT = 43117;
const DB_HOST = 'sessionport-validation-postgres-20261024';
const DB_PORT = '5432';
const DB_NAME = '/session_port_validation';
const DB_ROLE = 'sessionport_validation_runtime';

const fixtureUserIDs: string[] = [];
const checks: Array<{ name: string; ok: boolean }> = [];
const limitations = [
  'Synthetic users/sessions are seeded through the real BetterAuth internal adapter and signed with the installed vendor cookie format; this is not an OAuth or provider-login claim.',
  'The signed cookie and raw session token stay in memory only; no value is logged, serialized, or written.',
  'Direct API proof only; the Next BFF is intentionally out of scope.',
  'Loopback HTTP inside an isolated container network namespace; no public deployment claim.',
  'The seeded session is a test fixture for this lane only and is removed with the exact fixture users.',
];
let closeApp: (() => Promise<void>) | null = null;

function fail(code: string): never {
  const error = new Error(code);
  (error as { lifecycleCode?: string }).lifecycleCode = code;
  throw error;
}
function check(name: string, condition: boolean): void {
  checks.push({ name, ok: condition === true });
  if (condition !== true) fail(name);
}
function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      const quote = value[0];
      if (value.endsWith(quote)) value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
function readPrivateEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const entries = readdirSync(PRIVATE_DIR).sort();
  if (entries.length !== 2) fail('private-file-count');
  for (const name of entries) {
    Object.assign(env, parseEnvText(readFileSync(join(PRIVATE_DIR, name), 'utf8')));
  }
  return env;
}
function emit(payload: unknown, failure = false): void {
  process.stdout.write(
    `${failure ? 'BROWSER_SECURITY_LIFECYCLE_FAILURE' : 'BROWSER_SECURITY_LIFECYCLE_RESULT'}=${JSON.stringify(payload)}\n`,
  );
}

const counts = {
  live: 0,
  sessionGet: 0,
  begin: 0,
  approveNegative: 0,
  approvePositive: 0,
  list: 0,
  revoke: 0,
  exchange: 0,
  me: 0,
  other: 0,
};
const realFetch = globalThis.fetch.bind(globalThis);

interface HttpResult {
  status: number;
  json: Record<string, unknown> | null;
  text: string;
}
interface HttpOptions {
  method?: 'GET' | 'POST';
  cookie?: string;
  csrf?: string;
  origin?: string | null;
  body?: unknown;
  bearer?: string;
  count?: keyof typeof counts;
}
async function httpJson(path: string, options: HttpOptions = {}): Promise<HttpResult> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.csrf !== undefined) headers['x-sessionport-csrf'] = options.csrf;
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (options.count !== undefined) counts[options.count] += 1;
  else counts.other += 1;
  const response = await realFetch(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'error',
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}
function errorCode(result: HttpResult): string {
  const error = result.json?.error;
  if (error !== null && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

async function main(): Promise<Record<string, unknown>> {
  const testValues = JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as {
    api: Record<string, unknown>;
    backendPolicy: Record<string, unknown>;
    nativePolicy: Record<string, unknown>;
  };
  const privateEnv = readPrivateEnv();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...privateEnv,
    SESSIONPORT_API_PORT: String(PORT),
    SESSIONPORT_PUBLIC_ORIGIN: ORIGIN,
    SESSIONPORT_API_MODE: 'cloud',
    SESSIONPORT_NATIVE_ALLOW_LOOPBACK_HTTP: 'true',
    SESSIONPORT_HTTP_BODY_LIMIT_BYTES: String(testValues.api.SESSIONPORT_HTTP_BODY_LIMIT_BYTES),
    SESSIONPORT_READINESS_TIMEOUT_MS: String(testValues.api.SESSIONPORT_READINESS_TIMEOUT_MS),
    SESSIONPORT_RETRY_AFTER_SECONDS: String(testValues.api.SESSIONPORT_RETRY_AFTER_SECONDS),
    SESSIONPORT_BACKEND_POLICY_JSON: JSON.stringify(testValues.backendPolicy),
    SESSIONPORT_NATIVE_POLICY_JSON: JSON.stringify(testValues.nativePolicy),
  };

  const dynamicImport = new Function('specifier', 'return import(specifier);') as (
    specifier: string,
  ) => Promise<Record<string, any>>;
  const load = (specifier: string) =>
    dynamicImport(pathToFileURL(join(API_ROOT, specifier)).href);

  const [configModule, runtimeConfigModule, databaseConfigModule, databaseClientModule, mainModule] =
    await Promise.all([
      load('src/config.ts'),
      load('src/runtime/config.ts'),
      load('src/database/config.ts'),
      load('src/database/client.ts'),
      load('src/main.ts'),
    ]);

  const apiConfig = configModule.readApiConfig(env);
  check('api-config-port', apiConfig.port === PORT && apiConfig.host === '127.0.0.1');
  check('api-config-origin', apiConfig.publicOrigin === ORIGIN);
  const runtimeConfig = runtimeConfigModule.readRuntimeConfig(env, apiConfig);
  check('runtime-mode-cloud', runtimeConfig.mode === 'cloud');
  const databaseConfig = databaseConfigModule.readRuntimeDatabaseConfig(env);
  const parsed = new URL(databaseConfig.connectionString);
  check('db-host', parsed.hostname === DB_HOST);
  check('db-port', parsed.port === DB_PORT);
  check('db-name', parsed.pathname === DB_NAME);
  check('db-role', decodeURIComponent(parsed.username) === DB_ROLE);
  check('db-credential-present', parsed.password.length > 0);

  let db: any;
  const app = await mainModule.bootstrap(env, {
    createDatabaseClient: (factoryEnv: NodeJS.ProcessEnv) => {
      db = databaseClientModule.createRuntimeDatabaseClient(factoryEnv);
      return db;
    },
  });
  closeApp = async () => {
    await app.close();
  };
  check('api-listening', app.server.listening === true);
  const address = app.server.address();
  check('api-listening-port', typeof address === 'object' && address !== null && address.port === PORT);
  check('live-200', (await httpJson('/health/live', { count: 'live' })).status === 200);

  // Actual BetterAuth vendor instance over the same database/secret. This is
  // used only to seed the lane's own synthetic users/sessions through the real
  // internal adapter; the mounted API has its own equivalent instance. Package
  // resolution is anchored to the API root so the bundle can live outside it.
  const apiRequire = createRequire(join(API_ROOT, 'package.json'));
  const betterAuthModule = await import(pathToFileURL(apiRequire.resolve('better-auth')).href);
  const prismaAdapterModule = await import(
    pathToFileURL(apiRequire.resolve('@better-auth/prisma-adapter')).href
  );
  const betterAuth =
    betterAuthModule.betterAuth ??
    (betterAuthModule.default as Record<string, any> | undefined)?.betterAuth;
  const prismaAdapter =
    prismaAdapterModule.prismaAdapter ??
    (prismaAdapterModule.default as Record<string, any> | undefined)?.prismaAdapter;
  check('vendor-modules', typeof betterAuth === 'function' && typeof prismaAdapter === 'function');

  let vendorCookieSigner:
    | ((name: string, value: string, secret: string, options: Record<string, unknown>) => Promise<string>)
    | null = null;
  try {
    const betterCallRequire = createRequire(apiRequire.resolve('better-auth'));
    const betterCall = betterCallRequire('better-call') as Record<string, unknown>;
    if (typeof betterCall.serializeSignedCookie === 'function') {
      vendorCookieSigner = betterCall.serializeSignedCookie as (
        name: string,
        value: string,
        secret: string,
        options: Record<string, unknown>,
      ) => Promise<string>;
    }
  } catch {
    vendorCookieSigner = null;
  }
  check('vendor-cookie-helper', vendorCookieSigner !== null);

  const vendorDatabase = await prismaAdapter(db, { provider: 'postgresql' });
  const vendorAuth = betterAuth({
    baseURL: ORIGIN,
    basePath: '/api/auth',
    secret: privateEnv.SESSIONPORT_BETTER_AUTH_SECRET,
    trustedOrigins: [ORIGIN],
    database: vendorDatabase,
    socialProviders: {
      github: {
        clientId: privateEnv.SESSIONPORT_GITHUB_CLIENT_ID,
        clientSecret: privateEnv.SESSIONPORT_GITHUB_CLIENT_SECRET,
      },
    },
    plugins: [],
    emailAndPassword: { enabled: false },
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
  const vendorContext = await vendorAuth.$context;
  check('vendor-context', vendorContext !== null && typeof vendorContext === 'object');
  check('vendor-internal-adapter', typeof vendorContext.internalAdapter?.createSession === 'function');
  const cookieName = vendorContext.authCookies?.sessionToken?.name;
  const signingSecret = vendorContext.secret;
  check('vendor-cookie-name', typeof cookieName === 'string' && cookieName.length > 0);
  check('vendor-secret-present', typeof signingSecret === 'string' && signingSecret.length >= 32);

  const makeCookieHeader = async (token: string): Promise<string> => {
    // Real installed better-call helper used by BetterAuth itself. The cookie is
    // kept as an in-memory request header only.
    const serialized = await vendorCookieSigner!(
      cookieName as string,
      token,
      signingSecret as string,
      { httpOnly: true, path: '/', sameSite: 'lax', secure: false },
    );
    const end = serialized.indexOf(';');
    return end === -1 ? serialized : serialized.slice(0, end);
  };

  const seed = async (label: string) => {
    const requestedID = randomUUID();
    const created = await vendorContext.internalAdapter.createUser({
      id: requestedID,
      name: `SessionPort synthetic browser ${label}`,
      email: `${randomUUID()}@test.example.invalid`,
      emailVerified: true,
    });
    const userID =
      created !== null && typeof created === 'object' && typeof created.id === 'string'
        ? created.id
        : requestedID;
    fixtureUserIDs.push(userID);
    await vendorContext.internalAdapter.createSession(userID, false);
    const sessionRow = await db.session.findFirst({
      where: { userId: userID },
      select: { id: true, token: true },
      orderBy: { createdAt: 'desc' },
    });
    check('seed-session-row', sessionRow !== null && typeof sessionRow.token === 'string');
    const cookie = await makeCookieHeader(sessionRow.token as string);
    const vendorSession = await vendorAuth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    check(
      'vendor-get-session',
      vendorSession !== null &&
        typeof vendorSession === 'object' &&
        (vendorSession as { user?: { id?: unknown } }).user?.id === userID,
    );
    return { userID, cookie, sessionID: sessionRow.id as string };
  };

  const userA = await seed('A');
  const userB = await seed('B');
  check('two-fixture-users', fixtureUserIDs.length === 2);

  // ---- Positive browser session principal + actual CSRF issuance. ----
  const sessionA = await httpJson('/api/native/v1/session', { cookie: userA.cookie, count: 'sessionGet' });
  check('session-a-200', sessionA.status === 200);
  const sessionAUser = sessionA.json?.user as Record<string, unknown> | undefined;
  check('session-a-principal', sessionAUser?.id === userA.userID);
  const csrfA = sessionA.json?.csrfToken;
  check('csrf-a-issued', typeof csrfA === 'string' && csrfA.length === 43);
  const sessionB = await httpJson('/api/native/v1/session', { cookie: userB.cookie, count: 'sessionGet' });
  check('session-b-200', sessionB.status === 200);
  const sessionBUser = sessionB.json?.user as Record<string, unknown> | undefined;
  check('session-b-principal', sessionBUser?.id === userB.userID);
  const csrfB = sessionB.json?.csrfToken;
  check('csrf-b-issued', typeof csrfB === 'string' && csrfB.length === 43);
  check('csrf-distinct-per-session', csrfA !== csrfB);
  const sessionMissing = await httpJson('/api/native/v1/session', { count: 'sessionGet' });
  check('session-missing-401', sessionMissing.status === 401 && errorCode(sessionMissing) === 'unauthenticated');

  // ---- Create synthetic pending A1 through the actual public API. ----
  const beginA1 = await httpJson('/api/native/v1/device-authorizations', {
    method: 'POST',
    body: {},
    count: 'begin',
  });
  check('begin-a1-200', beginA1.status === 200);
  const userCodeA1 = beginA1.json?.userCode;
  const deviceCodeA1 = beginA1.json?.deviceCode;
  check('begin-a1-shape', typeof userCodeA1 === 'string' && typeof deviceCodeA1 === 'string');
  await vendorAuth.api.getSession({
    headers: new Headers({ cookie: userA.cookie }),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  const pendingBefore = await db.nativePendingAuthorization.findUnique({
    where: { deviceCodeFingerprint: fingerprintCredential('device', deviceCodeA1 as string) },
    select: { id: true, status: true },
  });
  check('pending-exists', pendingBefore !== null && pendingBefore.status === 'pending');

  // ---- Negative browser mutations; none may mutate the pending. ----
  const approveBody = { userCode: userCodeA1, confirm: true };
  const negMissingOrigin = await httpJson('/api/native/v1/device-authorizations/approve', {
    method: 'POST',
    cookie: userA.cookie,
    csrf: csrfA as string,
    origin: null,
    body: approveBody,
    count: 'approveNegative',
  });
  check(
    'neg-missing-origin',
    negMissingOrigin.status === 400 && errorCode(negMissingOrigin) === 'invalid-request',
  );
  const negWrongOrigin = await httpJson('/api/native/v1/device-authorizations/approve', {
    method: 'POST',
    cookie: userA.cookie,
    csrf: csrfA as string,
    origin: WRONG_ORIGIN,
    body: approveBody,
    count: 'approveNegative',
  });
  check(
    'neg-wrong-origin',
    negWrongOrigin.status === 400 && errorCode(negWrongOrigin) === 'invalid-request',
  );
  const negMissingCsrf = await httpJson('/api/native/v1/device-authorizations/approve', {
    method: 'POST',
    cookie: userA.cookie,
    origin: ORIGIN,
    body: approveBody,
    count: 'approveNegative',
  });
  check(
    'neg-missing-csrf',
    negMissingCsrf.status === 400 && errorCode(negMissingCsrf) === 'invalid-request',
  );
  const negWrongCsrf = await httpJson('/api/native/v1/device-authorizations/approve', {
    method: 'POST',
    cookie: userA.cookie,
    csrf: 'A'.repeat(43),
    origin: ORIGIN,
    body: approveBody,
    count: 'approveNegative',
  });
  check(
    'neg-wrong-csrf',
    negWrongCsrf.status === 400 && errorCode(negWrongCsrf) === 'invalid-request',
  );
  const negCrossCsrfA = await httpJson('/api/native/v1/device-authorizations/approve', {
    method: 'POST',
    cookie: userA.cookie,
    csrf: csrfB as string,
    origin: ORIGIN,
    body: approveBody,
    count: 'approveNegative',
  });
  check(
    'neg-session-b-csrf-on-a',
    negCrossCsrfA.status === 400 && errorCode(negCrossCsrfA) === 'invalid-request',
  );
  const negCrossCsrfB = await httpJson('/api/native/v1/device-authorizations/approve', {
    method: 'POST',
    cookie: userB.cookie,
    csrf: csrfA as string,
    origin: ORIGIN,
    body: approveBody,
    count: 'approveNegative',
  });
  check(
    'neg-session-a-csrf-on-b',
    negCrossCsrfB.status === 400 && errorCode(negCrossCsrfB) === 'invalid-request',
  );
  const negMissingCookie = await httpJson('/api/native/v1/device-authorizations/approve', {
    method: 'POST',
    origin: ORIGIN,
    csrf: csrfA as string,
    body: approveBody,
    count: 'approveNegative',
  });
  check(
    'neg-missing-cookie',
    negMissingCookie.status === 401 && errorCode(negMissingCookie) === 'unauthenticated',
  );
  const pendingAfterNegatives = await db.nativePendingAuthorization.findUnique({
    where: { id: pendingBefore.id },
    select: { status: true },
  });
  check('negative-no-mutation', pendingAfterNegatives?.status === 'pending');

  const approveA1 = await httpJson('/api/native/v1/device-authorizations/approve', {
    method: 'POST',
    cookie: userA.cookie,
    csrf: csrfA as string,
    origin: ORIGIN,
    body: approveBody,
    count: 'approvePositive',
  });
  check('approve-a1-200', approveA1.status === 200 && approveA1.json?.status === 'approved');
  const exchangeA1 = await httpJson('/api/native/v1/token', {
    method: 'POST',
    body: { grantType: 'device_code', deviceCode: deviceCodeA1 },
    count: 'exchange',
  });
  check('exchange-a1-200', exchangeA1.status === 200);
  const tokenA1 = exchangeA1.json?.accessToken;
  check('exchange-a1-token', typeof tokenA1 === 'string' && tokenA1.length > 0);
  const meA1 = await httpJson('/v1/me', { bearer: tokenA1 as string, count: 'me' });
  check('bearer-a1-200', meA1.status === 200);
  const grantRows = await db.nativeDeviceGrant.findMany({
    where: { userID: { in: fixtureUserIDs } },
    select: { id: true, userID: true, status: true },
    orderBy: { createdAt: 'asc' },
  });
  check('grant-a1-exists', grantRows.length === 1 && grantRows[0].userID === userA.userID);
  const grantA1 = grantRows[0].id;

  const listA1 = await httpJson('/api/native/v1/grants', { cookie: userA.cookie, count: 'list' });
  check('list-a1-200', listA1.status === 200);
  const listA1IDs = Array.isArray(listA1.json?.grants)
    ? (listA1.json.grants as Array<Record<string, unknown>>).map((grant) => grant.id)
    : [];
  check('list-a1-own', listA1IDs.includes(grantA1));

  // ---- Sibling grant A2. ----
  const beginA2 = await httpJson('/api/native/v1/device-authorizations', {
    method: 'POST',
    body: {},
    count: 'begin',
  });
  check(
    'begin-a2-200',
    beginA2.status === 200 &&
      typeof beginA2.json?.userCode === 'string' &&
      typeof beginA2.json?.deviceCode === 'string',
  );
  const approveA2 = await httpJson('/api/native/v1/device-authorizations/approve', {
    method: 'POST',
    cookie: userA.cookie,
    csrf: csrfA as string,
    origin: ORIGIN,
    body: { userCode: beginA2.json?.userCode, confirm: true },
    count: 'approvePositive',
  });
  check('approve-a2-200', approveA2.status === 200 && approveA2.json?.status === 'approved');
  const exchangeA2 = await httpJson('/api/native/v1/token', {
    method: 'POST',
    body: { grantType: 'device_code', deviceCode: beginA2.json?.deviceCode },
    count: 'exchange',
  });
  const tokenA2 = exchangeA2.json?.accessToken;
  check('exchange-a2-200', exchangeA2.status === 200 && typeof tokenA2 === 'string');
  const grantA2Row = await db.nativeDeviceGrant.findFirst({
    where: { userID: userA.userID, id: { not: grantA1 } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  check('grant-a2-exists', grantA2Row !== null);
  const grantA2 = grantA2Row.id;

  // ---- Synthetic user B grant for cross-user list/revoke. ----
  const beginB1 = await httpJson('/api/native/v1/device-authorizations', {
    method: 'POST',
    body: {},
    count: 'begin',
  });
  check(
    'begin-b1-200',
    beginB1.status === 200 &&
      typeof beginB1.json?.userCode === 'string' &&
      typeof beginB1.json?.deviceCode === 'string',
  );
  const approveB1 = await httpJson('/api/native/v1/device-authorizations/approve', {
    method: 'POST',
    cookie: userB.cookie,
    csrf: csrfB as string,
    origin: ORIGIN,
    body: { userCode: beginB1.json?.userCode, confirm: true },
    count: 'approvePositive',
  });
  check('approve-b1-200', approveB1.status === 200 && approveB1.json?.status === 'approved');
  const exchangeB1 = await httpJson('/api/native/v1/token', {
    method: 'POST',
    body: { grantType: 'device_code', deviceCode: beginB1.json?.deviceCode },
    count: 'exchange',
  });
  const tokenB1 = exchangeB1.json?.accessToken;
  check('exchange-b1-200', exchangeB1.status === 200 && typeof tokenB1 === 'string');
  const grantB1Row = await db.nativeDeviceGrant.findFirst({
    where: { userID: userB.userID },
    select: { id: true },
  });
  check('grant-b1-exists', grantB1Row !== null);
  const grantB1 = grantB1Row.id;

  // ---- Cross-user list must not reveal A; cross-user revoke must not touch A2. ----
  const listB = await httpJson('/api/native/v1/grants', { cookie: userB.cookie, count: 'list' });
  check('list-b-200', listB.status === 200);
  const listBIDs = Array.isArray(listB.json?.grants)
    ? (listB.json.grants as Array<Record<string, unknown>>).map((grant) => grant.id)
    : [];
  check('list-b-own-only', listBIDs.includes(grantB1) && !listBIDs.includes(grantA1) && !listBIDs.includes(grantA2));
  const crossRevoke = await httpJson(`/api/native/v1/grants/${grantA2}/revoke`, {
    method: 'POST',
    cookie: userB.cookie,
    csrf: csrfB as string,
    origin: ORIGIN,
    body: {},
    count: 'revoke',
  });
  check('cross-user-revoke-404', crossRevoke.status === 404 && errorCode(crossRevoke) === 'not-found');
  const siblingAfterCross = await httpJson('/v1/me', { bearer: tokenA2 as string, count: 'me' });
  check('cross-user-no-mutation', siblingAfterCross.status === 200);
  check('cross-user-grant-active', (await db.nativeDeviceGrant.findUnique({ where: { id: grantA2 }, select: { status: true } }))?.status === 'active');

  // ---- Own-grant revoke via browser route; immediate bearer 401. ----
  const ownRevoke = await httpJson(`/api/native/v1/grants/${grantA1}/revoke`, {
    method: 'POST',
    cookie: userA.cookie,
    csrf: csrfA as string,
    origin: ORIGIN,
    body: {},
    count: 'revoke',
  });
  check('own-revoke-200', ownRevoke.status === 200 && ownRevoke.json?.status === 'revoked');
  const revokedMe = await httpJson('/v1/me', { bearer: tokenA1 as string, count: 'me' });
  check('revoked-bearer-401', revokedMe.status === 401 && errorCode(revokedMe) === 'unauthenticated');
  const siblingMe = await httpJson('/v1/me', { bearer: tokenA2 as string, count: 'me' });
  check('sibling-bearer-200', siblingMe.status === 200);
  const otherUserMe = await httpJson('/v1/me', { bearer: tokenB1 as string, count: 'me' });
  check('other-user-bearer-200', otherUserMe.status === 200);
  const finalGrants: Array<{ id: string; userID: string; status: string }> =
    await db.nativeDeviceGrant.findMany({
      where: { userID: { in: fixtureUserIDs } },
      select: { id: true, userID: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
  check('final-grant-statuses', finalGrants.find((row) => row.id === grantA1)?.status === 'revoked');
  check(
    'sibling-and-other-active',
    finalGrants.find((row) => row.id === grantA2)?.status === 'active' &&
      finalGrants.find((row) => row.id === grantB1)?.status === 'active',
  );

  // ---- Exact-scope cleanup on PASS only. ----
  const grantIDs = finalGrants.map((row) => row.id);
  const pendingIDs = (
    await db.nativePendingAuthorization.findMany({
      where: { approvedUserID: { in: fixtureUserIDs } },
      select: { id: true },
    })
  ).map((row: { id: string }) => row.id);
  const before = {
    users: await db.user.count({ where: { id: { in: fixtureUserIDs } } }),
    sessions: await db.session.count({ where: { userId: { in: fixtureUserIDs } } }),
    accounts: await db.account.count({ where: { userId: { in: fixtureUserIDs } } }),
    quotas: await db.userQuota.count({ where: { userID: { in: fixtureUserIDs } } }),
    grants: await db.nativeDeviceGrant.count({ where: { userID: { in: fixtureUserIDs } } }),
    devices: await db.device.count({ where: { userID: { in: fixtureUserIDs } } }),
    accessTokens: await db.nativeAccessToken.count({ where: { grantID: { in: grantIDs } } }),
    refreshTokens: await db.nativeRefreshToken.count({ where: { grantID: { in: grantIDs } } }),
    pendings: await db.nativePendingAuthorization.count({ where: { approvedUserID: { in: fixtureUserIDs } } }),
    projects: await db.project.count({ where: { userID: { in: fixtureUserIDs } } }),
    uploads: await db.upload.count({ where: { userID: { in: fixtureUserIDs } } }),
  };
  check('cleanup-before-users', before.users === 2);
  check('cleanup-before-sessions', before.sessions === 2);
  check('cleanup-before-accounts', before.accounts === 0);
  check('cleanup-before-quotas', before.quotas === 2);
  check('cleanup-before-grants', before.grants === 3);
  check('cleanup-before-devices', before.devices === 3);
  check('cleanup-before-access', before.accessTokens === 3);
  check('cleanup-before-refresh', before.refreshTokens === 3);
  check('cleanup-before-pendings', before.pendings === 3);
  check('cleanup-before-no-business', before.projects === 0 && before.uploads === 0);

  await db.$transaction(
    async (tx: any) => {
      await tx.nativeRefreshToken.updateMany({
        where: { grantID: { in: grantIDs } },
        data: { spentAt: null, successorID: null },
      });
      await tx.nativeRefreshToken.deleteMany({ where: { grantID: { in: grantIDs } } });
      await tx.nativeAccessToken.deleteMany({ where: { grantID: { in: grantIDs } } });
      await tx.device.deleteMany({ where: { userID: { in: fixtureUserIDs } } });
      await tx.nativeDeviceGrant.deleteMany({ where: { userID: { in: fixtureUserIDs } } });
      await tx.nativePendingAuthorization.deleteMany({ where: { id: { in: pendingIDs } } });
      await tx.userQuota.deleteMany({ where: { userID: { in: fixtureUserIDs } } });
      await tx.account.deleteMany({ where: { userId: { in: fixtureUserIDs } } });
      await tx.session.deleteMany({ where: { userId: { in: fixtureUserIDs } } });
      await tx.user.deleteMany({ where: { id: { in: fixtureUserIDs } } });
    },
    { timeout: 20_000, maxWait: 10_000 },
  );

  const after = {
    users: await db.user.count({ where: { id: { in: fixtureUserIDs } } }),
    sessions: await db.session.count({ where: { userId: { in: fixtureUserIDs } } }),
    accounts: await db.account.count({ where: { userId: { in: fixtureUserIDs } } }),
    quotas: await db.userQuota.count({ where: { userID: { in: fixtureUserIDs } } }),
    grants: await db.nativeDeviceGrant.count({ where: { userID: { in: fixtureUserIDs } } }),
    devices: await db.device.count({ where: { userID: { in: fixtureUserIDs } } }),
    accessTokens: await db.nativeAccessToken.count({ where: { grantID: { in: grantIDs } } }),
    refreshTokens: await db.nativeRefreshToken.count({ where: { grantID: { in: grantIDs } } }),
    pendings: await db.nativePendingAuthorization.count({ where: { approvedUserID: { in: fixtureUserIDs } } }),
  };
  check('cleanup-after-zero', Object.values(after).every((count) => count === 0));

  await app.close();
  closeApp = null;

  return {
    ok: true,
    profile: 'direct-current-api-loopback',
    transport: 'actual-http',
    fixtures: {
      userIDs: fixtureUserIDs,
      grantIDs,
      grantCount: 3,
      sessionRows: 2,
    },
    http: counts,
    checks,
    schemaCounts: { before, after },
    keyClaims: {
      directApiNotNextBff: true,
      realBetterAuthGetSession: true,
      signedVendorSessionCookieInMemoryOnly: true,
      actualBrowserSessionPrincipal: true,
      actualApiIssuedCsrf: true,
      actualBrowserApprove: true,
      actualBrowserListOwn: true,
      actualBrowserRevoke: true,
      immediateBearer401AfterRevoke: true,
      siblingAndOtherUserActive: true,
      crossUserCannotListOthers: true,
      crossUserCannotRevokeOthers: true,
      negativeOriginCsrfCookieChecks: true,
      noInjectedPrincipalOrFakeAuthority: true,
      noOAuthReplay: true,
      exactCleanupZero: true,
    },
    limitations,
  };
}

main()
  .then((result) => {
    emit(result);
    process.exitCode = 0;
  })
  .catch(async (error: unknown) => {
    if (closeApp !== null) {
      try {
        await closeApp();
      } catch {
        // Preserve the original failure.
      }
      closeApp = null;
    }
    emit(
      {
        ok: false,
        code:
          error !== null && typeof error === 'object' && typeof (error as { lifecycleCode?: unknown }).lifecycleCode === 'string'
            ? (error as { lifecycleCode: string }).lifecycleCode
            : 'unexpected',
        fixtureUserIDs,
        retained: true,
        checks,
        limitations,
      },
      true,
    );
    process.exitCode = 1;
  });
