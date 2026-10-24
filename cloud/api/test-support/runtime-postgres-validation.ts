/**
 * Bounded M2 runtime PostgreSQL validation driver (test-support, preparation).
 *
 * Exercises the real runtime composition (`createCloudRuntime` + `startApi`)
 * with a real Prisma client, native device-authorization/token flow, `/v1/me`,
 * project routes, upload reservation repository, and readiness. It creates one
 * synthetic user and cleans only its exact IDs after every check passes.
 * No migration, DDL, network, storage, OAuth, vault, Docker, Git, or LLM work.
 * Failure retains the owned IDs and performs no cleanup.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../prisma/generated/client/client.js';
import type { ApiConfig } from '../src/config.js';
import {
  DatabaseConfigError,
  readMigrationDatabaseConfig,
  readRuntimeDatabaseConfig,
} from '../src/database/config.js';
import { createDatabaseReadinessCheck } from '../src/database/readiness.js';
import { startApi } from '../src/main.js';
import type {
  MeCountsDTO,
  MeDTO,
  MeLimitsDTO,
} from '../src/me/repository.js';
import type { NativeAuthConfig } from '../src/native-auth/config.js';
import { fingerprintCredential } from '../src/native-auth/credentials.js';
import { createCloudRuntime } from '../src/runtime/cloud.js';
import type { BackendPolicy, CloudRuntimeConfig } from '../src/runtime/config.js';
import {
  createUploadRepository,
  UploadRepositoryError,
  type UploadRepository,
} from '../src/uploads/repository.js';

const DB = 'session_port_validation';
const HOST = 'session-port-postgres';
const PORT = '5432';
const RUNTIME_ROLE = 'sessionport_validation_runtime';
const MIGRATOR_ROLE = 'sessionport_validation_migrator';
const ROLES = new Set([RUNTIME_ROLE, MIGRATOR_ROLE]);
const MIGRATIONS = [
  '202610190001_vendor_auth',
  '202610190002_project_quota',
  '202610200003_protocol_native',
] as const;
const PG_MAJOR = 16;
const LIMIT = 1_000n;
const USED = 400n;
const INITIAL = 200;
const REJECT = 500;
const ACCEPT = 400;
const RESERVED_INITIAL = 200;
const RESERVED_FINAL = 600;
const MAX_CIPHERTEXT = 1_000;
const BUDGET = { maxWait: 5_000, timeout: 10_000 } as const;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const TARGET_MESSAGE = 'Runtime validation target configuration is invalid.';
const DRIVER_MESSAGE = 'Runtime PostgreSQL validation stopped.';

export const RUNTIME_VALIDATION_DATABASE_ENV = 'SESSIONPORT_RUNTIME_DATABASE_URL';
export const MIGRATOR_VALIDATION_DATABASE_ENV =
  'SESSIONPORT_MIGRATOR_DATABASE_URL';

export const RUNTIME_VALIDATION_CHECK_NAMES = [
  'database-identity',
  'postgresql-major-16',
  'migrations-finished',
  'schema-shape',
  'health-live-200',
  'health-ready-503',
  'native-pending-flow',
  'native-token-exchange',
  'authenticated-me-initial',
  'project-create-list',
  'quota-initial-reserve-200',
  'quota-reject-500',
  'quota-accept-400',
  'authenticated-me-final',
  'cleanup-exact-scope',
  'cleanup-verified',
] as const;

export type RuntimeValidationCheckName =
  (typeof RUNTIME_VALIDATION_CHECK_NAMES)[number];
export type RuntimeValidationErrorCode =
  | RuntimeValidationCheckName
  | 'database-guard-failed'
  | 'seed-failed'
  | 'cleanup-failed'
  | 'cleanup-verification-failed'
  | 'validation-unavailable';

export interface RuntimeValidationResult {
  readonly status: 'passed' | 'failed';
  readonly testPassed: boolean;
  readonly cleanupVerified: boolean;
  readonly postgresqlMajor: number;
  readonly migrationCount: number;
  readonly fixtureUserCount: number;
  readonly checkCount: number;
  readonly passedCheckCount: number;
  readonly passedChecks: readonly RuntimeValidationCheckName[];
  readonly failedCheck: RuntimeValidationCheckName | null;
  readonly retainedFixtureUserIDs: readonly string[];
  readonly retainedFixtureIDs: readonly string[];
  readonly quota: {
    readonly limitBytes: number;
    readonly usedBytes: number;
    readonly reservedBefore: number;
    readonly reservedAfter: number;
  };
}

export class RuntimeValidationTargetConfigError extends Error {
  readonly code = 'invalid-runtime-validation-target-config';
  constructor() {
    super(TARGET_MESSAGE);
    this.name = 'RuntimeValidationTargetConfigError';
  }
}

export class RuntimeValidationError extends Error {
  readonly code: RuntimeValidationErrorCode;
  readonly retainedFixtureUserIDs: readonly string[];
  readonly retainedFixtureIDs: readonly string[];
  constructor(
    code: RuntimeValidationErrorCode,
    users: readonly string[] = [],
    ids: readonly string[] = [],
  ) {
    super(DRIVER_MESSAGE);
    this.name = 'RuntimeValidationError';
    this.code = code;
    this.retainedFixtureUserIDs = Object.freeze([...users]);
    this.retainedFixtureIDs = Object.freeze([...ids]);
  }
}

export interface RuntimeCleanupScope {
  readonly userID: string;
  readonly projectIDs: readonly string[];
  readonly uploadIDs: readonly string[];
  readonly grantIDs: readonly string[];
  readonly deviceIDs: readonly string[];
  readonly pendingIDs: readonly string[];
}

interface IDs {
  readonly userID: string;
  readonly projectID: string;
  readonly revisionInitial: string;
  readonly revisionRejected: string;
  readonly revisionAccepted: string;
  readonly uploadInitial: string;
  readonly uploadRejected: string;
  readonly uploadAccepted: string;
  grantID?: string;
  deviceID?: string;
  pendingID?: string;
}

export interface RuntimeValidationOptions {
  readonly apiConfig: ApiConfig;
  readonly runtimeConfig: CloudRuntimeConfig;
}

export function readRuntimeValidationDatabaseConfig(
  env: NodeJS.ProcessEnv,
): { readonly connectionString: string; readonly sourceKey: string } {
  const sourceKey =
    env[RUNTIME_VALIDATION_DATABASE_ENV] !== undefined
      ? RUNTIME_VALIDATION_DATABASE_ENV
      : MIGRATOR_VALIDATION_DATABASE_ENV;
  let config;
  try {
    config =
      sourceKey === RUNTIME_VALIDATION_DATABASE_ENV
        ? readRuntimeDatabaseConfig(env)
        : readMigrationDatabaseConfig(env);
  } catch (error) {
    if (error instanceof DatabaseConfigError) {
      throw new RuntimeValidationTargetConfigError();
    }
    throw error;
  }
  assertRuntimeValidationTargetConnectionString(config.connectionString);
  return { connectionString: config.connectionString, sourceKey };
}

export function assertRuntimeValidationTargetConnectionString(raw: string): void {
  if (
    raw.length === 0 ||
    raw.trim() !== raw ||
    raw.includes('#') ||
    CONTROL.test(raw)
  ) {
    throw new RuntimeValidationTargetConfigError();
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RuntimeValidationTargetConfigError();
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.hash !== '' ||
    parsed.hostname !== HOST ||
    (parsed.port !== '' && parsed.port !== PORT)
  ) {
    throw new RuntimeValidationTargetConfigError();
  }
  const user = decode(parsed.username);
  const password = decode(parsed.password);
  const database = decode(
    parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname,
  );
  if (!ROLES.has(user) || password.length === 0 || database !== DB) {
    throw new RuntimeValidationTargetConfigError();
  }
  const seen = new Set<string>();
  for (const [key, value] of parsed.searchParams) {
    if (seen.has(key)) throw new RuntimeValidationTargetConfigError();
    seen.add(key);
    if (key === 'schema' ? value !== 'public' : key === 'sslmode' ? ![
      'disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full',
    ].includes(value) : true) {
      throw new RuntimeValidationTargetConfigError();
    }
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RuntimeValidationTargetConfigError();
  }
}

/** Explicit test-only runtime values; none is a production default. */
export function createRuntimeValidationOptions(): RuntimeValidationOptions {
  const publicOrigin = 'http://127.0.0.1:43123';
  const backend: BackendPolicy = Object.freeze({
    maxActiveProjects: 1,
    maxActiveDevices: 3,
    maxCiphertextBytes: MAX_CIPHERTEXT,
    maxPageSize: 10,
    maxOutstandingPendingAuthorizationsGlobal: 100,
    maxRateLimitEntries: 1_000,
    maxAuthResponseBytes: 65_536,
  });
  const rate = () => Object.freeze({ windowSeconds: 60, maxRequests: 100 });
  const native: NativeAuthConfig = Object.freeze({
    publicOrigin,
    verificationUri: `${publicOrigin}/api/native/v1/device-authorizations/verify`,
    allowLoopbackHttp: true,
    betterAuth: Object.freeze({
      secret: 'synthetic-runtime-validation-better-auth-secret-0001',
      github: Object.freeze({
        clientID: 'synthetic-runtime-validation-client',
        clientSecret: 'synthetic-runtime-validation-client-secret',
      }),
    }),
    humanCodes: Object.freeze({
      keys: Object.freeze([
        Object.freeze({ id: 'validation-key', key: Buffer.alloc(32, 0x21) }),
      ]),
      activeKeyID: 'validation-key',
    }),
    csrfKey: Buffer.alloc(32, 0x42),
    policy: Object.freeze({
      ttlSeconds: Object.freeze({
        pendingAuthorization: 600,
        accessToken: 600,
        refreshToken: 1_800,
        grant: 3_600,
      }),
      polling: Object.freeze({
        intervalSeconds: 1,
        backoffIncrementSeconds: 1,
        maxIntervalSeconds: 5,
      }),
      rateLimits: Object.freeze({
        createAuthorization: rate(),
        browserVerification: rate(),
        browserLookup: rate(),
        approveAuthorization: rate(),
        denyAuthorization: rate(),
        exchangeDeviceCode: rate(),
        refreshToken: rate(),
        listGrants: rate(),
        revokeGrant: rate(),
      }),
      capacity: Object.freeze({
        maxOutstandingPendingAuthorizationsPerUser: 10,
        maxActiveGrantsPerUser: 3,
        retentionSeconds: Object.freeze({
          pendingAuthorizationRecords: 3_600,
          spentTokenRecords: 3_600,
          revokedGrantRecords: 3_600,
        }),
      }),
      authorization: Object.freeze({
        audience: 'https://sessionport.invalid',
        resource: 'https://sessionport.invalid',
        allowedScopes: Object.freeze([
          'projects:read',
          'projects:write',
          'me.read',
        ]),
        requiredRouteScopes: Object.freeze({
          'projects.create': Object.freeze(['projects:write']),
          'projects.list': Object.freeze(['projects:read']),
          'revisions.list': Object.freeze(['projects:read']),
          'revisions.commit': Object.freeze(['projects:write']),
          'me.read': Object.freeze(['me.read']),
        }),
      }),
    }),
  });
  return Object.freeze({
    apiConfig: Object.freeze({
      host: '127.0.0.1' as const,
      port: 43_123,
      publicOrigin,
      bodyLimitBytes: 1_048_576,
      readinessTimeoutMs: 2_000,
      retryAfterSeconds: 7,
    }),
    runtimeConfig: Object.freeze({ mode: 'cloud' as const, backend, native }),
  });
}

export async function runRuntimePostgresValidation(
  client: PrismaClient,
  options: RuntimeValidationOptions,
): Promise<RuntimeValidationResult> {
  const ids = createIDs();
  try {
    return await execute(client, options, ids);
  } catch (error) {
    throw new RuntimeValidationError(
      error instanceof RuntimeValidationError
        ? error.code
        : 'validation-unavailable',
      [ids.userID],
      allIDs(ids),
    );
  }
}

async function execute(
  client: PrismaClient,
  options: RuntimeValidationOptions,
  ids: IDs,
): Promise<RuntimeValidationResult> {
  const passed: RuntimeValidationCheckName[] = [];
  const record = (name: RuntimeValidationCheckName): void => {
    passed.push(name);
  };
  const fail = (name: RuntimeValidationErrorCode): never => {
    throw new RuntimeValidationError(name, [ids.userID], allIDs(ids));
  };
  const ensure = (condition: boolean, name: RuntimeValidationCheckName): void => {
    if (!condition) fail(name);
  };
  const guard = await guardDatabase(client);
  record('database-identity');
  record('postgresql-major-16');
  record('migrations-finished');
  record('schema-shape');

  const now = new Date();
  try {
    await client.user.create({
      data: {
        id: ids.userID,
        name: 'SessionPort synthetic runtime validation',
        email: `${randomUUID()}@test.example.invalid`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    await client.userQuota.create({
      data: {
        userID: ids.userID,
        limitBytes: LIMIT,
        usedBytes: USED,
        reservedBytes: 0n,
        updatedAt: now,
      },
    });
  } catch {
    fail('seed-failed');
  }

  let app: FastifyInstance | undefined;
  try {
    const runtime = await createCloudRuntime(client, options.runtimeConfig);
    app = await startApi(options.apiConfig, {
      readiness: {
        database: createDatabaseReadinessCheck(client),
        migrations: async () => false,
        storage: async () => false,
      },
      modules: runtime.api,
      listen: async () => {},
    });

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    ensure(live.statusCode === 200, 'health-live-200');
    record('health-live-200');
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    const readyBody = ready.json() as { error?: { code?: string } };
    ensure(
      ready.statusCode === 503 &&
        ready.headers['retry-after'] ===
          String(options.apiConfig.retryAfterSeconds) &&
        readyBody.error?.code === 'unavailable',
      'health-ready-503',
    );
    record('health-ready-503');

    const service = runtime.api.nativeAuth.service;
    const authorization = await service.createDeviceAuthorization();
    const pending = await client.nativePendingAuthorization.findUnique({
      where: {
        deviceCodeFingerprint: fingerprintCredential(
          'device',
          authorization.deviceCode,
        ),
      },
      select: { id: true, status: true, approvedUserID: true },
    });
    if (
      pending === null ||
      pending.status !== 'pending' ||
      pending.approvedUserID !== null
    ) {
      fail('native-pending-flow');
    }
    ids.pendingID = pending!.id;
    const approval = await service.approveUserCode(
      authorization.userCode,
      ids.userID,
    );
    ensure(approval.status === 'approved', 'native-pending-flow');
    record('native-pending-flow');

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/native/v1/token',
      payload: { deviceCode: authorization.deviceCode },
    });
    const tokens = tokenResponse.json() as {
      accessToken?: string;
      refreshToken?: string;
    };
    ensure(
      tokenResponse.statusCode === 200 &&
        typeof tokens.accessToken === 'string' &&
        tokens.accessToken.length > 0 &&
        typeof tokens.refreshToken === 'string' &&
        tokens.refreshToken.length > 0,
      'native-token-exchange',
    );
    record('native-token-exchange');

    const grants = await client.nativeDeviceGrant.findMany({
      where: { userID: ids.userID },
      select: { id: true, status: true, expiresAt: true },
    });
    const devices = await client.device.findMany({
      where: { userID: ids.userID },
      select: { id: true, grantID: true },
    });
    ensure(
      grants.length === 1 &&
        grants[0]!.status === 'active' &&
        grants[0]!.expiresAt.getTime() > Date.now() &&
        devices.length === 1 &&
        devices[0]!.grantID === grants[0]!.id,
      'native-token-exchange',
    );
    ids.grantID = grants[0]!.id;
    ids.deviceID = devices[0]!.id;

    const headers = { authorization: `Bearer ${tokens.accessToken}` };
    const meBefore = await app.inject({ method: 'GET', url: '/v1/me', headers });
    ensure(
      checkAuthenticatedMeResponse(meBefore, {
        userID: ids.userID,
        storageLimitBytes: Number(LIMIT),
        storageUsedBytes: Number(USED),
        storageReservedBytes: 0,
        maxCiphertextBytesFloor: 500,
        activeDevices: 1,
        activeProjects: 0,
      }),
      'authenticated-me-initial',
    );
    record('authenticated-me-initial');

    const createProject = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { projectID: ids.projectID },
    });
    const projectBody = createProject.json() as { projectID?: string };
    ensure(
      (createProject.statusCode === 200 || createProject.statusCode === 201) &&
        projectBody.projectID === ids.projectID,
      'project-create-list',
    );
    const listProjects = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers,
    });
    const listBody = listProjects.json() as {
      projects?: Array<{ projectID?: string }>;
    };
    ensure(
      listProjects.statusCode === 200 &&
        Array.isArray(listBody.projects) &&
        listBody.projects.some((p) => p.projectID === ids.projectID),
      'project-create-list',
    );
    record('project-create-list');

    const uploads = createUploadRepository(client, {
      maxCiphertextBytes: MAX_CIPHERTEXT,
      reservationTTLSeconds: 60,
      graceTTLSeconds: 60,
      leaseTTLSeconds: 60,
    });
    await reserve(uploads, ids, ids.uploadInitial, ids.revisionInitial, INITIAL);
    const afterInitial = await readQuota(client, ids.userID);
    ensure(
      afterInitial.usedBytes === 400 &&
        afterInitial.reservedBytes === RESERVED_INITIAL,
      'quota-initial-reserve-200',
    );
    record('quota-initial-reserve-200');

    let rejected = false;
    try {
      await reserve(uploads, ids, ids.uploadRejected, ids.revisionRejected, REJECT);
    } catch (error) {
      rejected =
        error instanceof UploadRepositoryError &&
        error.code === 'storage-limit-reached' &&
        error.statusCode === 413;
    }
    const afterRejected = await readQuota(client, ids.userID);
    const rejectedCount = await client.upload.count({
      where: { uploadID: ids.uploadRejected },
    });
    ensure(
      rejected &&
        afterRejected.reservedBytes === RESERVED_INITIAL &&
        rejectedCount === 0,
      'quota-reject-500',
    );
    record('quota-reject-500');

    await reserve(uploads, ids, ids.uploadAccepted, ids.revisionAccepted, ACCEPT);
    const afterAccepted = await readQuota(client, ids.userID);
    ensure(
      afterAccepted.usedBytes === 400 &&
        afterAccepted.reservedBytes === RESERVED_FINAL,
      'quota-accept-400',
    );
    record('quota-accept-400');

    const meAfter = await app.inject({ method: 'GET', url: '/v1/me', headers });
    ensure(
      checkAuthenticatedMeResponse(meAfter, {
        userID: ids.userID,
        storageLimitBytes: Number(LIMIT),
        storageUsedBytes: Number(USED),
        storageReservedBytes: RESERVED_FINAL,
        maxCiphertextBytesFloor: 500,
        activeDevices: 1,
        activeProjects: 1,
      }),
      'authenticated-me-final',
    );
    record('authenticated-me-final');
  } finally {
    if (app !== undefined) await app.close();
  }

  const cleaned = await cleanupRuntimeValidationFixtures(client, cleanupScope(ids));
  if (!cleaned) {
    fail('cleanup-verification-failed');
  }
  record('cleanup-exact-scope');
  record('cleanup-verified');
  return Object.freeze({
    status: passed.length === RUNTIME_VALIDATION_CHECK_NAMES.length
      ? ('passed' as const)
      : ('failed' as const),
    testPassed: passed.length === RUNTIME_VALIDATION_CHECK_NAMES.length,
    cleanupVerified: true,
    postgresqlMajor: guard.postgresqlMajor,
    migrationCount: guard.migrationCount,
    fixtureUserCount: 1,
    checkCount: RUNTIME_VALIDATION_CHECK_NAMES.length,
    passedCheckCount: passed.length,
    passedChecks: Object.freeze([...passed]),
    failedCheck: null,
    retainedFixtureUserIDs: Object.freeze([]),
    retainedFixtureIDs: Object.freeze([]),
    quota: Object.freeze({
      limitBytes: Number(LIMIT),
      usedBytes: Number(USED),
      reservedBefore: RESERVED_INITIAL,
      reservedAfter: RESERVED_FINAL,
    }),
  });
}

async function guardDatabase(
  client: PrismaClient,
): Promise<{ readonly postgresqlMajor: number; readonly migrationCount: number }> {
  try {
    const identity = await client.$queryRaw<Array<{
      database: string;
      currentUser: string;
      sessionUser: string;
      serverVersion: number;
    }>>`
      SELECT current_database() AS "database", current_user AS "currentUser",
             session_user AS "sessionUser",
             current_setting('server_version_num')::int AS "serverVersion"
    `;
    if (
      identity.length !== 1 ||
      identity[0]!.database !== DB ||
      !ROLES.has(identity[0]!.currentUser) ||
      !ROLES.has(identity[0]!.sessionUser)
    ) {
      throw new RuntimeValidationError('database-identity');
    }
    const postgresqlMajor = Math.trunc(Number(identity[0]!.serverVersion) / 10_000);
    if (postgresqlMajor !== PG_MAJOR) {
      throw new RuntimeValidationError('postgresql-major-16');
    }
    const migrations = await client.$queryRaw<Array<{
      migrationName: string;
      finishedAt: Date | null;
      rolledBackAt: Date | null;
    }>>`
      SELECT "migration_name" AS "migrationName", "finished_at" AS "finishedAt",
             "rolled_back_at" AS "rolledBackAt" FROM "_prisma_migrations"
    `;
    if (
      migrations.length !== MIGRATIONS.length ||
      MIGRATIONS.some((name) => {
        const matches = migrations.filter((row) => row.migrationName === name);
        return matches.length !== 1 ||
          matches[0]!.finishedAt === null ||
          matches[0]!.rolledBackAt !== null;
      })
    ) {
      throw new RuntimeValidationError('migrations-finished');
    }
    const rows = await client.$queryRaw<Array<Record<string, boolean>>>`
      SELECT to_regclass('public."user"') IS NOT NULL AS "user",
             to_regclass('public."UserQuota"') IS NOT NULL AS "userQuota",
             to_regclass('public."Project"') IS NOT NULL AS "project",
             to_regclass('public."Upload"') IS NOT NULL AS "upload",
             to_regclass('public."Device"') IS NOT NULL AS "device",
             to_regclass('public."NativeDeviceGrant"') IS NOT NULL AS "grant",
             to_regclass('public."NativeAccessToken"') IS NOT NULL AS "accessToken",
             to_regclass('public."NativeRefreshToken"') IS NOT NULL AS "refreshToken",
             to_regclass('public."NativePendingAuthorization"') IS NOT NULL AS "pending"
    `;
    if (rows.length !== 1 || Object.values(rows[0]!).some((v) => v !== true)) {
      throw new RuntimeValidationError('schema-shape');
    }
    return { postgresqlMajor, migrationCount: migrations.length };
  } catch (error) {
    if (error instanceof RuntimeValidationError) throw error;
    throw new RuntimeValidationError('database-guard-failed');
  }
}

/**
 * Canonical `GET /v1/me` expectations. Field names mirror `MeLimitsDTO` and
 * `MeCountsDTO` in `src/me/repository.ts`; the driver must follow the route,
 * not define its own contract.
 */
export interface MeCheckExpectation {
  readonly userID: string;
  readonly storageLimitBytes: number;
  readonly storageUsedBytes: number;
  readonly storageReservedBytes: number;
  /** Preserved lower-bound policy check; the ceiling itself is configured. */
  readonly maxCiphertextBytesFloor: number;
  readonly activeDevices: number;
  readonly activeProjects: number;
}

export interface MeHttpResponse {
  readonly statusCode: number;
  json(): unknown;
}

/**
 * Shared driver assertion path. Also exported so the offline contract test can
 * execute the same logic against a real `createMeRepository` DTO delivered
 * through a synthetic HTTP 200 response.
 */
export function checkAuthenticatedMeResponse(
  response: MeHttpResponse,
  expected: MeCheckExpectation,
): boolean {
  if (response.statusCode !== 200) return false;
  let body: Partial<MeDTO>;
  try {
    body = response.json() as Partial<MeDTO>;
  } catch {
    return false;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false;
  }
  const limits = body.limits as Partial<MeLimitsDTO> | undefined;
  const counts = body.counts as Partial<MeCountsDTO> | undefined;
  if (
    typeof limits !== 'object' ||
    limits === null ||
    Array.isArray(limits) ||
    typeof counts !== 'object' ||
    counts === null ||
    Array.isArray(counts)
  ) {
    return false;
  }
  return (
    body.userID === expected.userID &&
    limits.storageLimitBytes === expected.storageLimitBytes &&
    limits.storageUsedBytes === expected.storageUsedBytes &&
    limits.storageReservedBytes === expected.storageReservedBytes &&
    typeof limits.maxCiphertextBytes === 'number' &&
    limits.maxCiphertextBytes >= expected.maxCiphertextBytesFloor &&
    counts.activeDevices === expected.activeDevices &&
    counts.activeProjects === expected.activeProjects
  );
}

async function readQuota(
  client: PrismaClient,
  userID: string,
): Promise<{ readonly usedBytes: number; readonly reservedBytes: number }> {
  const quota = await client.userQuota.findUnique({
    where: { userID },
    select: { usedBytes: true, reservedBytes: true },
  });
  if (quota === null) throw new RuntimeValidationError('validation-unavailable');
  return {
    usedBytes: Number(quota.usedBytes),
    reservedBytes: Number(quota.reservedBytes),
  };
}

async function reserve(
  repository: UploadRepository,
  ids: IDs,
  uploadID: string,
  revisionID: string,
  sizeBytes: number,
): Promise<void> {
  if (ids.deviceID === undefined) {
    throw new RuntimeValidationError('seed-failed', [ids.userID], allIDs(ids));
  }
  await repository.reserve({
    userID: ids.userID,
    deviceID: ids.deviceID,
    projectID: ids.projectID,
    uploadID,
    revisionID,
    keyEpoch: 1,
    sizeBytes,
    ciphertextSha256: randomBytes(32),
  });
}

/** Delete only exact tracked rows; pre/post counts gate the transaction. */
export async function cleanupRuntimeValidationFixtures(
  client: PrismaClient,
  scope: RuntimeCleanupScope,
): Promise<boolean> {
  requireScope(scope);
  try {
    await client.$transaction(async (tx) => {
      const [users, quotas, projects, uploads, grants, devices, pendings,
        revisions, heads] = await Promise.all([
        tx.user.count({ where: { id: scope.userID } }),
        tx.userQuota.count({ where: { userID: scope.userID } }),
        tx.project.count({ where: { userID: scope.userID } }),
        tx.upload.count({ where: { userID: scope.userID } }),
        tx.nativeDeviceGrant.count({ where: { userID: scope.userID } }),
        tx.device.count({ where: { userID: scope.userID } }),
        tx.nativePendingAuthorization.count({
          where: { approvedUserID: scope.userID },
        }),
        tx.revision.count({ where: { projectID: { in: [...scope.projectIDs] } } }),
        tx.projectHead.count({ where: { projectID: { in: [...scope.projectIDs] } } }),
      ]);
      if (
        users !== 1 ||
        quotas !== 1 ||
        projects !== scope.projectIDs.length ||
        uploads !== scope.uploadIDs.length ||
        grants !== scope.grantIDs.length ||
        devices !== scope.deviceIDs.length ||
        pendings !== scope.pendingIDs.length ||
        revisions !== 0 ||
        heads !== 0
      ) {
        throw new RuntimeValidationError('cleanup-failed', [scope.userID]);
      }
      const exactPending = await tx.nativePendingAuthorization.count({
        where: {
          id: { in: [...scope.pendingIDs] },
          approvedUserID: scope.userID,
        },
      });
      if (exactPending !== scope.pendingIDs.length) {
        throw new RuntimeValidationError('cleanup-failed', [scope.userID]);
      }
      const deletedUploads = await tx.upload.deleteMany({
        where: {
          uploadID: { in: [...scope.uploadIDs] },
          userID: scope.userID,
        },
      });
      if (deletedUploads.count !== scope.uploadIDs.length) {
        throw new RuntimeValidationError('cleanup-failed', [scope.userID]);
      }
      await tx.nativeRefreshToken.updateMany({
        where: { grantID: { in: [...scope.grantIDs] } },
        data: { spentAt: null, successorID: null },
      });
      await tx.nativeRefreshToken.deleteMany({
        where: { grantID: { in: [...scope.grantIDs] } },
      });
      await tx.nativeAccessToken.deleteMany({
        where: { grantID: { in: [...scope.grantIDs] } },
      });
      await tx.device.deleteMany({ where: { userID: scope.userID } });
      await tx.nativeDeviceGrant.deleteMany({ where: { userID: scope.userID } });
      await tx.nativePendingAuthorization.deleteMany({
        where: {
          id: { in: [...scope.pendingIDs] },
          approvedUserID: scope.userID,
        },
      });
      await tx.project.deleteMany({
        where: {
          projectID: { in: [...scope.projectIDs] },
          userID: scope.userID,
        },
      });
      await tx.userQuota.deleteMany({ where: { userID: scope.userID } });
      await tx.user.deleteMany({ where: { id: scope.userID } });
    }, BUDGET);
  } catch (error) {
    if (error instanceof RuntimeValidationError) throw error;
    throw new RuntimeValidationError('cleanup-failed', [scope.userID]);
  }
  const counts = await Promise.all([
    client.user.count({ where: { id: scope.userID } }),
    client.userQuota.count({ where: { userID: scope.userID } }),
    client.project.count({ where: { projectID: { in: [...scope.projectIDs] } } }),
    client.upload.count({ where: { uploadID: { in: [...scope.uploadIDs] } } }),
    client.device.count({ where: { userID: scope.userID } }),
    client.nativeDeviceGrant.count({ where: { userID: scope.userID } }),
    client.nativeAccessToken.count({
      where: { grantID: { in: [...scope.grantIDs] } },
    }),
    client.nativeRefreshToken.count({
      where: { grantID: { in: [...scope.grantIDs] } },
    }),
    client.nativePendingAuthorization.count({
      where: { id: { in: [...scope.pendingIDs] } },
    }),
  ]);
  return counts.every((count) => count === 0);
}

function requireScope(scope: RuntimeCleanupScope): void {
  const arrays = [
    scope.projectIDs,
    scope.uploadIDs,
    scope.grantIDs,
    scope.deviceIDs,
    scope.pendingIDs,
  ];
  if (
    typeof scope.userID !== 'string' ||
    scope.userID.length === 0 ||
    arrays.some(
      (values) =>
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((value) => typeof value !== 'string' || value.length === 0),
    )
  ) {
    throw new RuntimeValidationError('cleanup-failed', [scope.userID]);
  }
}

function cleanupScope(ids: IDs): RuntimeCleanupScope {
  if (
    ids.grantID === undefined ||
    ids.deviceID === undefined ||
    ids.pendingID === undefined
  ) {
    throw new RuntimeValidationError('cleanup-failed', [ids.userID], allIDs(ids));
  }
  return Object.freeze({
    userID: ids.userID,
    projectIDs: Object.freeze([ids.projectID]),
    uploadIDs: Object.freeze([ids.uploadInitial, ids.uploadAccepted]),
    grantIDs: Object.freeze([ids.grantID]),
    deviceIDs: Object.freeze([ids.deviceID]),
    pendingIDs: Object.freeze([ids.pendingID]),
  });
}

function createIDs(): IDs {
  return {
    userID: `runtime-validation-${randomUUID()}`,
    projectID: randomUUID(),
    revisionInitial: randomUUID(),
    revisionRejected: randomUUID(),
    revisionAccepted: randomUUID(),
    uploadInitial: randomUUID(),
    uploadRejected: randomUUID(),
    uploadAccepted: randomUUID(),
  };
}

function allIDs(ids: IDs): readonly string[] {
  return Object.freeze([
    ids.userID,
    ids.projectID,
    ids.revisionInitial,
    ids.revisionRejected,
    ids.revisionAccepted,
    ids.uploadInitial,
    ids.uploadRejected,
    ids.uploadAccepted,
    ...(ids.grantID === undefined ? [] : [ids.grantID]),
    ...(ids.deviceID === undefined ? [] : [ids.deviceID]),
    ...(ids.pendingID === undefined ? [] : [ids.pendingID]),
  ]);
}
