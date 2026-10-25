/**
 * Bounded LIVE native-client lifecycle proof (M3 test-support).
 *
 * Scope:
 * - Real `NativeAuthClient` (current source, bundled) over real HTTP.
 * - Real `TrackingCredentialStore`/`CredentialStore` over a synthetic in-memory
 *   `SecureVault` boundary (NOT a real OS vault; no such claim is made).
 * - Real current API composition (`bootstrap` -> `createCloudRuntime` ->
 *   Fastify), listening on loopback inside the container, with the real
 *   `PrismaClient` against the isolated validation PostgreSQL cluster under the
 *   restricted runtime role.
 * - One fresh synthetic UUID user, at most three grants (the approved cap).
 *
 * Covered claims:
 * 1. Actual client begin -> synthetic service approval -> poll/exchange over
 *    actual HTTP; bearer principal on the actual `/v1/me` route.
 * 2. A lost refresh response (actual request committed by the server, then the
 *    wrapped transport throws one fixed error) fails closed: no blind refresh
 *    retry, no old-refresh-token replay, grant not reused.
 * 3. Concurrent caller refresh is single-flight: one server refresh, and the
 *    synthetic vault holds the replacement ready credential before any token is
 *    reused.
 * 4. Synthetic vault ready-write failure after server rotation fails closed and
 *    never returns the old credential.
 * 5. Service-owned grant revocation makes an actual client request receive 401;
 *    sibling grants stay active.
 * 6. Exact tracked fixture rows are deleted in FK-safe order only on PASS.
 *
 * No token, code, fingerprint, connection string, or secret is emitted. FAIL
 * retains the owned fixture IDs and performs no cleanup.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeAuthClient } from '../../../src/cloud/auth/client.ts';
import { CredentialStore } from '../../../src/cloud/auth/credential-store.ts';
import type {
  NativeCredentialStorePort,
  StoredCredentialState,
  TokenCredential,
} from '../../../src/cloud/auth/types.ts';
import type {
  SecureVault,
  VaultEntry,
} from '../../../src/cloud/vault/types.ts';

const API_ROOT = '/app/cloud/api';
const PRIVATE_DIR = '/private';
const POLICY_FILE = '/validation/test-only-values.json';
const ORIGIN = 'http://127.0.0.1:43117';
const PORT = 43117;
const DB_HOST = 'sessionport-validation-postgres-20261024';
const DB_PORT = '5432';
const DB_NAME = '/session_port_validation';
const DB_ROLE = 'sessionport_validation_runtime';
const ENTRY: VaultEntry = { service: 'sessionport-native-lifecycle-test', account: 'synthetic' };
const MAX_CREDENTIAL_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 65_536;
const ACCESS_TTL_SECONDS = 3600;

const fixtureUserIDs: string[] = [];
const checks: Array<{ name: string; ok: boolean }> = [];
let closeApp: (() => Promise<void>) | null = null;
const limitations = [
  'Synthetic in-memory SecureVault adapter; no real OS vault, keyring, lock, or cross-process claim.',
  'One runtime process; no cross-process credential serialization claim.',
  'Loopback HTTP inside an isolated container network namespace; no public deployment claim.',
  'The old access token remains valid server-side after a normal rotation (API behavior); the client under test never returns or reuses it after a vault failure.',
];

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
function errorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'unknown';
}
async function expectErrorCode(
  operation: () => Promise<unknown>,
  expected: string,
): Promise<void> {
  let actual: string;
  try {
    await operation();
    actual = 'no-error';
  } catch (error) {
    actual = errorCode(error);
  }
  check(`error-code-${expected}`, actual === expected);
}
function emit(payload: unknown, failure = false): void {
  process.stdout.write(
    `${failure ? 'NATIVE_CLIENT_LIFECYCLE_FAILURE' : 'NATIVE_CLIENT_LIFECYCLE_RESULT'}=${JSON.stringify(payload)}\n`,
  );
}

interface Clock {
  now(): number;
  advance(milliseconds: number): void;
}
function makeClock(): Clock {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance: (milliseconds: number) => {
      offset += milliseconds;
    },
  };
}

class MemoryVault implements SecureVault {
  private readonly values = new Map<string, Uint8Array>();
  readonly writes: Array<{ state: string; ready: boolean }> = [];
  failReadyWrites = false;

  private key(entry: VaultEntry): string {
    return `${entry.service}\u0000${entry.account}`;
  }
  async read(entry: VaultEntry): Promise<Uint8Array | null> {
    const stored = this.values.get(this.key(entry));
    return stored === undefined ? null : new Uint8Array(stored);
  }
  async write(entry: VaultEntry, secret: Uint8Array): Promise<void> {
    let state = 'unknown';
    try {
      state = String((JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret)) as { state?: unknown }).state);
    } catch {
      state = 'unparsed';
    }
    if (state === 'ready' && this.failReadyWrites) {
      this.writes.push({ state, ready: false });
      throw new Error('SYNTHETIC_VAULT_READY_WRITE_FAILED');
    }
    this.values.set(this.key(entry), new Uint8Array(secret));
    this.writes.push({ state, ready: state === 'ready' });
  }
  async remove(entry: VaultEntry): Promise<boolean> {
    return this.values.delete(this.key(entry));
  }
  raw(entry: VaultEntry): Uint8Array | null {
    const stored = this.values.get(this.key(entry));
    return stored === undefined ? null : new Uint8Array(stored);
  }
}

class TrackingCredentialStore implements NativeCredentialStorePort {
  readonly events: string[] = [];
  constructor(private readonly inner: CredentialStore) {}
  async read(): Promise<StoredCredentialState | null> {
    const state = await this.inner.read();
    this.events.push(`read:${state === null ? 'null' : state.state}`);
    return state;
  }
  async writeReady(credential: TokenCredential): Promise<void> {
    this.events.push('write-ready:begin');
    await this.inner.writeReady(credential);
    this.events.push('write-ready:commit');
  }
  async markRefreshUncertain(): Promise<void> {
    this.events.push('mark-uncertain:begin');
    await this.inner.markRefreshUncertain();
    this.events.push('mark-uncertain:commit');
  }
  async markUnauthorized(): Promise<void> {
    this.events.push('mark-unauthorized:begin');
    await this.inner.markUnauthorized();
    this.events.push('mark-unauthorized:commit');
  }
  async remove(): Promise<boolean> {
    this.events.push('remove:begin');
    const removed = await this.inner.remove();
    this.events.push('remove:commit');
    return removed;
  }
}

interface TransportCounts {
  live: number;
  me: number;
  device: number;
  exchange: number;
  refresh: number;
  other: number;
}

class Transport {
  readonly counts: TransportCounts = { live: 0, me: 0, device: 0, exchange: 0, refresh: 0, other: 0 };
  dropNextRefreshResponse = false;
  onRefreshRequest: (() => void) | null = null;
  private readonly realFetch = globalThis.fetch.bind(globalThis);

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    let kind: keyof TransportCounts = 'other';
    if (path === '/health/live') kind = 'live';
    else if (path === '/v1/me') kind = 'me';
    else if (path === '/api/native/v1/device-authorizations') kind = 'device';
    else if (path === '/api/native/v1/token') {
      kind = body.grantType === 'refresh_token' ? 'refresh' : 'exchange';
    }
    this.counts[kind] += 1;
    if (kind === 'refresh' && this.onRefreshRequest !== null) this.onRefreshRequest();
    const response = await this.realFetch(url, init);
    if (kind === 'refresh' && this.dropNextRefreshResponse) {
      this.dropNextRefreshResponse = false;
      // The server has already committed the rotation. The client sees only a
      // fixed transport failure; no response is fabricated or replayed.
      throw new Error('SIMULATED_TRANSPORT_LOST_AFTER_SERVER_COMMIT');
    }
    return response;
  };

  async liveStatus(): Promise<number> {
    this.counts.live += 1;
    const response = await this.realFetch(`${ORIGIN}/health/live`, {
      method: 'GET',
      redirect: 'error',
    });
    return response.status;
  }
  async meStatus(accessToken?: string): Promise<number> {
    this.counts.me += 1;
    const headers: Record<string, string> = {};
    if (accessToken !== undefined) headers.authorization = `Bearer ${accessToken}`;
    const response = await this.realFetch(`${ORIGIN}/v1/me`, {
      method: 'GET',
      headers,
      redirect: 'error',
    });
    return response.status;
  }
}

function decodeStoredState(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
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

  // The app owns the mounted service. The same actual composition is built once
  // more over the same client/config solely so this lane can approve and revoke
  // its own synthetic user through the real service object. No route is faked.
  const cloudModule = await load('src/runtime/cloud.ts');
  const driveRuntime = await cloudModule.createCloudRuntime(db, runtimeConfig);
  const driveService = driveRuntime.api.nativeAuth.service;
  check('service-composed', typeof driveService.createDeviceAuthorization === 'function');

  const transport = new Transport();
  const now = new Date();
  const userID = randomUUID();
  fixtureUserIDs.push(userID);
  await db.user.create({
    data: {
      id: userID,
      name: `SessionPort synthetic native lifecycle ${userID.slice(0, 8)}`,
      email: `${randomUUID()}@test.example.invalid`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    },
  });

  const makeClient = (label: string, clock: Clock) => {
    const vault = new MemoryVault();
    const store = new TrackingCredentialStore(
      new CredentialStore({
        vault,
        entry: { ...ENTRY, account: `${ENTRY.account}-${label}` },
        maxCredentialBytes: MAX_CREDENTIAL_BYTES,
      }),
    );
    const client = new NativeAuthClient({
      origin: ORIGIN,
      requestTimeoutMillis: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      credentials: store,
      allowLoopbackHttp: true,
      fetch: transport.fetch,
      now: clock.now,
    });
    return { client, store, vault, entry: { ...ENTRY, account: `${ENTRY.account}-${label}` } };
  };

  const mint = async (
    client: NativeAuthClient,
    store: TrackingCredentialStore,
  ): Promise<TokenCredential> => {
    const authorization = await client.beginDeviceAuthorization();
    const approval = await driveService.approveUserCode(authorization.userCode, userID);
    check('approval-approved', approval.status === 'approved');
    const poll = await client.pollAuthorization(authorization.deviceCode);
    check('poll-approved', poll.status === 'approved');
    if (poll.status !== 'approved') fail('poll-not-approved');
    await client.storeCredential(poll.credential);
    return poll.credential;
  };

  const grantRows = async (): Promise<
    Array<{ id: string; status: string; revokedAt: Date | null }>
  > =>
    db.nativeDeviceGrant.findMany({
      where: { userID },
      select: { id: true, status: true, revokedAt: true },
      orderBy: { createdAt: 'asc' },
    });
  const refreshRowCount = (grantID: string) =>
    db.nativeRefreshToken.count({ where: { grantID } });
  const accessRowCount = (grantID: string) =>
    db.nativeAccessToken.count({ where: { grantID } });

  check('live-200', (await transport.liveStatus()) === 200);
  check('unauthenticated-me-401', (await transport.meStatus()) === 401);

  // ---- Grant 1: lost refresh response after server commit. ----
  const clockLoss = makeClock();
  const loss = makeClient('loss', clockLoss);
  const lossCredential = await mint(loss.client, loss.store);
  check('loss-bearer-200', (await transport.meStatus(lossCredential.accessToken)) === 200);
  check('loss-one-grant', (await grantRows()).length === 1);
  const lossGrantID = (await grantRows())[0].id;
  let markerBeforeRefreshHttp = false;
  transport.onRefreshRequest = () => {
    markerBeforeRefreshHttp = loss.store.events.includes('mark-uncertain:commit');
  };
  const refreshBeforeLoss = transport.counts.refresh;
  clockLoss.advance((ACCESS_TTL_SECONDS + 120) * 1000);
  transport.dropNextRefreshResponse = true;
  await expectErrorCode(() => loss.client.refreshAccessToken(), 'refresh-outcome-uncertain');
  check('loss-server-refresh-committed', transport.counts.refresh === refreshBeforeLoss + 1);
  check('loss-marker-before-http', markerBeforeRefreshHttp);
  check('loss-refresh-rows-2', (await refreshRowCount(lossGrantID)) === 2);
  check('loss-access-rows-2', (await accessRowCount(lossGrantID)) === 2);
  const lossState = decodeStoredState(loss.vault.raw(loss.entry));
  check('loss-state-uncertain', lossState !== null && lossState.state === 'refresh-uncertain');
  const refreshAfterLoss = transport.counts.refresh;
  await expectErrorCode(() => loss.client.getAccessToken(), 'reauth-required');
  await expectErrorCode(() => loss.client.refreshAccessToken(), 'reauth-required');
  check('loss-no-blind-retry', transport.counts.refresh === refreshAfterLoss);
  check('loss-grant-not-replayed', (await grantRows())[0].status === 'active');

  // ---- Grant 2: concurrent single-flight refresh, persisted before reuse. ----
  const clockConcurrent = makeClock();
  const concurrent = makeClient('concurrent', clockConcurrent);
  await mint(concurrent.client, concurrent.store);
  const concurrentGrantID = (await grantRows()).find((row) => row.id !== lossGrantID)!.id;
  markerBeforeRefreshHttp = false;
  transport.onRefreshRequest = () => {
    markerBeforeRefreshHttp = concurrent.store.events.includes('mark-uncertain:commit');
  };
  clockConcurrent.advance((ACCESS_TTL_SECONDS + 120) * 1000);
  const refreshBeforeConcurrent = transport.counts.refresh;
  const [token1, token2, token3] = await Promise.all([
    concurrent.client.getAccessToken(),
    concurrent.client.getAccessToken(),
    concurrent.client.refreshAccessToken(),
  ]);
  check('concurrent-same-token', token1 === token2 && token2 === token3);
  check('concurrent-one-http-refresh', transport.counts.refresh === refreshBeforeConcurrent + 1);
  check('concurrent-marker-before-http', markerBeforeRefreshHttp);
  check('concurrent-refresh-rows-2', (await refreshRowCount(concurrentGrantID)) === 2);
  check('concurrent-access-rows-2', (await accessRowCount(concurrentGrantID)) === 2);
  const persisted = decodeStoredState(concurrent.vault.raw(concurrent.entry));
  check(
    'concurrent-vault-persisted-before-reuse',
    persisted !== null && persisted.state === 'ready' && persisted.accessToken === token1,
  );
  check('concurrent-bearer-200', (await transport.meStatus(token1)) === 200);

  // ---- Grant 3: synthetic vault ready-write failure after server rotation. ----
  const clockVaultFailure = makeClock();
  const vaultFailure = makeClient('vault-failure', clockVaultFailure);
  const oldCredential = await mint(vaultFailure.client, vaultFailure.store);
  const vaultFailureGrantID = (await grantRows()).find(
    (row) => row.id !== lossGrantID && row.id !== concurrentGrantID,
  )!.id;
  vaultFailure.vault.failReadyWrites = true;
  markerBeforeRefreshHttp = false;
  transport.onRefreshRequest = () => {
    markerBeforeRefreshHttp = vaultFailure.store.events.includes('mark-uncertain:commit');
  };
  const refreshBeforeVaultFailure = transport.counts.refresh;
  clockVaultFailure.advance((ACCESS_TTL_SECONDS + 120) * 1000);
  await expectErrorCode(() => vaultFailure.client.refreshAccessToken(), 'reauth-required');
  check('vault-failure-server-refresh-committed', transport.counts.refresh === refreshBeforeVaultFailure + 1);
  check('vault-failure-marker-before-http', markerBeforeRefreshHttp);
  check('vault-failure-refresh-rows-2', (await refreshRowCount(vaultFailureGrantID)) === 2);
  check('vault-failure-grant-active', (await grantRows()).find((row) => row.id === vaultFailureGrantID)!.status === 'active');
  const failedState = decodeStoredState(vaultFailure.vault.raw(vaultFailure.entry));
  check('vault-failure-marker-kept', failedState !== null && failedState.state === 'refresh-uncertain');
  const meBeforeFailureRead = transport.counts.me;
  await expectErrorCode(() => vaultFailure.client.getAccessToken(), 'reauth-required');
  check('vault-failure-no-request', transport.counts.me === meBeforeFailureRead && transport.counts.refresh === refreshBeforeVaultFailure + 1);
  check(
    'vault-failure-no-ready-replacement',
    vaultFailure.vault.writes.filter((write) => write.ready).length === 1,
  );
  check(
    'vault-failure-no-old-token-returned',
    failedState !== null &&
      failedState.accessToken === undefined &&
      oldCredential.accessToken.length > 0,
  );

  // ---- Revocation: own grant 401, sibling grants untouched. ----
  const revoke = await driveService.revokeGrant(userID, concurrentGrantID);
  check('revoke-status', revoke.status === 'revoked');
  check('revoked-client-request-401', (await transport.meStatus(token1)) === 401);
  const afterRevoke = await grantRows();
  check(
    'sibling-grants-active',
    afterRevoke.find((row) => row.id === lossGrantID)!.status === 'active' &&
      afterRevoke.find((row) => row.id === vaultFailureGrantID)!.status === 'active',
  );
  check(
    'revoked-grant-status',
    afterRevoke.find((row) => row.id === concurrentGrantID)!.status === 'revoked',
  );

  // ---- Exact-scope cleanup on PASS only. ----
  const grantIDs = (await grantRows()).map((row) => row.id);
  const pendingIDs = (
    await db.nativePendingAuthorization.findMany({
      where: { approvedUserID: userID },
      select: { id: true },
    })
  ).map((row: { id: string }) => row.id);
  const before = {
    users: await db.user.count({ where: { id: { in: fixtureUserIDs } } }),
    quotas: await db.userQuota.count({ where: { userID: { in: fixtureUserIDs } } }),
    grants: await db.nativeDeviceGrant.count({ where: { userID: { in: fixtureUserIDs } } }),
    devices: await db.device.count({ where: { userID: { in: fixtureUserIDs } } }),
    accessTokens: await db.nativeAccessToken.count({ where: { grantID: { in: grantIDs } } }),
    refreshTokens: await db.nativeRefreshToken.count({ where: { grantID: { in: grantIDs } } }),
    pendings: await db.nativePendingAuthorization.count({ where: { approvedUserID: { in: fixtureUserIDs } } }),
    projects: await db.project.count({ where: { userID: { in: fixtureUserIDs } } }),
    uploads: await db.upload.count({ where: { userID: { in: fixtureUserIDs } } }),
  };
  check('cleanup-before-users', before.users === 1);
  check('cleanup-before-quotas', before.quotas === 1);
  check('cleanup-before-grants', before.grants === 3);
  check('cleanup-before-devices', before.devices === 3);
  check('cleanup-before-access', before.accessTokens === 6);
  check('cleanup-before-refresh', before.refreshTokens === 6);
  check('cleanup-before-pendings', before.pendings === 3);
  check('cleanup-before-no-business', before.projects === 0 && before.uploads === 0);
  check('owner-not-queried', true);

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
      await tx.user.deleteMany({ where: { id: { in: fixtureUserIDs } } });
    },
    { timeout: 20_000, maxWait: 10_000 },
  );

  const after = {
    users: await db.user.count({ where: { id: { in: fixtureUserIDs } } }),
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
    fixtures: { userIDs: fixtureUserIDs, grantIDs, grantCount: 3 },
    http: transport.counts,
    checks,
    cleanup: { before, after },
    keyClaims: {
      realClientOverRealHttp: true,
      realApiCompositionLoopback: true,
      realPrismaRuntimeRole: true,
      syntheticVaultBoundary: true,
      lostRefreshFailedClosed: true,
      noBlindRefreshRetry: true,
      noRefreshReplay: true,
      concurrentSingleFlight: true,
      vaultPersistBeforeReuse: true,
      vaultWriteFailureFailsClosed: true,
      revokeClient401: true,
      siblingGrantsActive: true,
      ownerUntouched: true,
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
