import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import type { ApiConfig } from '../src/config.js';
import { createApi } from '../src/app.js';
import { startApi } from '../src/main.js';
import { createMeRepository } from '../src/me/repository.js';
import {
  MAX_RUN_MS,
  MIN_RUN_MS,
  parseRuntimeValidationRunArgs,
  RUNTIME_RUN_FLAG,
  runRuntimeValidationCli,
} from '../scripts/validate-runtime.js';
import {
  assertRuntimeValidationTargetConnectionString,
  checkAuthenticatedMeResponse,
  cleanupRuntimeValidationFixtures,
  createRuntimeValidationOptions,
  readRuntimeValidationDatabaseConfig,
  runRuntimePostgresValidation,
  RuntimeValidationError,
  RuntimeValidationTargetConfigError,
} from '../test-support/runtime-postgres-validation.js';
import type {
  RuntimeCleanupScope,
  RuntimeValidationResult,
} from '../test-support/runtime-postgres-validation.js';

const RUNTIME_KEY = 'SESSIONPORT_RUNTIME_DATABASE_URL';
const MIGRATOR_KEY = 'SESSIONPORT_MIGRATOR_DATABASE_URL';
const VALID_RUNTIME_URL =
  'postgresql://sessionport_validation_runtime:synth%40tic%3Apass@session-port-postgres:5432/session_port_validation';
const VALID_MIGRATOR_URL =
  'postgresql://sessionport_validation_migrator:synth%40tic%3Apass@session-port-postgres/session_port_validation';
const SYNTHETIC_SECRET = 'synthetic-runtime-secret-value';
const TARGET_MESSAGE = 'Runtime validation target configuration is invalid.';
const TEST_CONFIG: ApiConfig = {
  host: '127.0.0.1',
  port: 43_123,
  publicOrigin: 'http://127.0.0.1:43123',
  bodyLimitBytes: 1_048_576,
  readinessTimeoutMs: 1_000,
  retryAfterSeconds: 7,
};
const SCHEMA_FILE = new URL('../prisma/schema.prisma', import.meta.url);
const MIGRATIONS_DIRECTORY = new URL('../prisma/migrations/', import.meta.url);
const EXPECTED_GUARD_TABLE_MODELS = Object.freeze({
  user: 'User',
  userQuota: 'UserQuota',
  project: 'Project',
  upload: 'Upload',
  device: 'Device',
  grant: 'NativeDeviceGrant',
  accessToken: 'NativeAccessToken',
  refreshToken: 'NativeRefreshToken',
  pending: 'NativePendingAuthorization',
} as const);

function assertTargetError(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RuntimeValidationTargetConfigError);
    assert.equal(error.name, 'RuntimeValidationTargetConfigError');
    assert.equal(error.message, TARGET_MESSAGE);
    assert.equal(String(error).includes(SYNTHETIC_SECRET), false);
    assert.equal((error.stack ?? '').includes(SYNTHETIC_SECRET), false);
    return true;
  });
}

test('accepts exactly the runtime flag and bounded max-run argument', () => {
  assert.deepEqual(
    parseRuntimeValidationRunArgs([RUNTIME_RUN_FLAG, '--max-run-ms=90000']),
    { maxRunMs: 90_000 },
  );
  assert.deepEqual(
    parseRuntimeValidationRunArgs([RUNTIME_RUN_FLAG, '--max-run-ms=1000']),
    { maxRunMs: MIN_RUN_MS },
  );
  assert.deepEqual(
    parseRuntimeValidationRunArgs([
      RUNTIME_RUN_FLAG,
      `--max-run-ms=${MAX_RUN_MS}`,
    ]),
    { maxRunMs: MAX_RUN_MS },
  );
  for (const argv of [
    [],
    [RUNTIME_RUN_FLAG],
    [RUNTIME_RUN_FLAG, '--max-run-ms=999'],
    [RUNTIME_RUN_FLAG, '--max-run-ms=120001'],
    [RUNTIME_RUN_FLAG, '--max-run-ms=090000'],
    ['--other', '--max-run-ms=90000'],
    [RUNTIME_RUN_FLAG, '--max-run-ms=90000', 'extra'],
  ]) {
    assert.equal(parseRuntimeValidationRunArgs(argv), null);
  }
});

test('invalid arguments stop before any environment access', async () => {
  const env = new Proxy(
    {},
    {
      get() {
        throw new Error('environment must not be read');
      },
    },
  ) as NodeJS.ProcessEnv;
  let attempts = 0;
  let output = '';
  const code = await runRuntimeValidationCli([], env, (text) => {
    output += text;
  }, {
    testAttempt: async () => {
      attempts += 1;
      return successResult();
    },
  });
  assert.equal(code, 2);
  assert.equal(attempts, 0);
  assert.equal(
    output,
    'status=stopped code=runtime-validation-not-requested\n',
  );
});

test('target guard accepts the runtime role and migrator role only', () => {
  assert.deepEqual(readRuntimeValidationDatabaseConfig({
    [RUNTIME_KEY]: VALID_RUNTIME_URL,
  }), {
    connectionString: VALID_RUNTIME_URL,
    sourceKey: RUNTIME_KEY,
  });
  assert.deepEqual(readRuntimeValidationDatabaseConfig({
    [MIGRATOR_KEY]: VALID_MIGRATOR_URL,
  }), {
    connectionString: VALID_MIGRATOR_URL,
    sourceKey: MIGRATOR_KEY,
  });
  assert.deepEqual(readRuntimeValidationDatabaseConfig({
    [RUNTIME_KEY]: VALID_RUNTIME_URL,
    [MIGRATOR_KEY]: 'not-a-valid-url',
  }), {
    connectionString: VALID_RUNTIME_URL,
    sourceKey: RUNTIME_KEY,
  });

  for (const raw of [
    'postgresql://sessionport_validation_runtime:synth@localhost:5432/session_port_validation',
    'postgresql://sessionport_validation_runtime:synth@session-port-postgres:5433/session_port_validation',
    'postgresql://sessionport_validation_runtime:synth@session-port-postgres/session_port',
    `postgresql://sessionport_validation_runtime:${SYNTHETIC_SECRET}@session-port-postgres/session_port_validation?user=other`,
    `postgresql://sessionport_validation_migrator2:${SYNTHETIC_SECRET}@session-port-postgres/session_port_validation`,
    `${VALID_RUNTIME_URL}?schema=public&schema=public`,
    `${VALID_RUNTIME_URL}?schema=private`,
    `${VALID_RUNTIME_URL}#fragment`,
  ]) {
    assertTargetError(() => assertRuntimeValidationTargetConnectionString(raw));
  }
  assertTargetError(() => readRuntimeValidationDatabaseConfig({}));
});

test('failure output is fixed and never contains driver text or secrets', async () => {
  let output = '';
  const code = await runRuntimeValidationCli(
    [RUNTIME_RUN_FLAG, '--max-run-ms=1000'],
    {},
    (text) => {
      output += text;
    },
    {
      testAttempt: async () => {
        throw new Error(`raw driver failure ${SYNTHETIC_SECRET}`);
      },
    },
  );
  assert.equal(code, 1);
  assert.equal(output.includes(SYNTHETIC_SECRET), false);
  assert.equal(output.includes('raw driver failure'), false);
  assert.match(output, /status=failed\n/);
  assert.match(output, /failedCheck=validation-unavailable\n/);
  assert.match(output, /retainedFixtureUserIDs=none\n/);
});

test('success output reports bounded counts without credentials', async () => {
  let output = '';
  const code = await runRuntimeValidationCli(
    [RUNTIME_RUN_FLAG, '--max-run-ms=1000'],
    {},
    (text) => {
      output += text;
    },
    { testAttempt: async () => successResult() },
  );
  assert.equal(code, 0);
  assert.match(output, /status=passed\n/);
  assert.match(output, /testPassed=true\n/);
  assert.match(output, /cleanupVerified=true\n/);
  assert.match(output, /checks=16\/16\n/);
  assert.match(output, /failedCheck=none\n/);
  assert.match(output, /retainedFixtureUserIDs=none\n/);
  assert.equal(output.includes('accessToken'), false);
  assert.equal(output.includes('refreshToken'), false);
});

test('driver authenticated-me checks follow the canonical storage DTO', async () => {
  const options = createRuntimeValidationOptions();
  const backend = options.runtimeConfig.backend;
  const userID = 'runtime-validation-offline-user';
  const state = { usedBytes: 400n, reservedBytes: 0n, activeProjects: 0 };
  const repository = createMeRepository(
    {
      userQuota: {
        findUnique: async () => ({
          limitBytes: 1_000n,
          usedBytes: state.usedBytes,
          reservedBytes: state.reservedBytes,
        }),
      },
      project: { count: async () => state.activeProjects },
      nativeDeviceGrant: { count: async () => 1 },
    } as never,
    {
      maxCiphertextBytes: backend.maxCiphertextBytes,
      maxActiveDevices: backend.maxActiveDevices,
      maxActiveProjects: backend.maxActiveProjects,
      now: () => new Date('2026-10-24T00:00:00Z'),
    },
  );
  const httpResponse = (body: unknown) => ({ statusCode: 200, json: () => body });

  const initial = await repository.read(userID);
  assert.deepEqual(initial.limits, {
    storageLimitBytes: 1_000,
    storageUsedBytes: 400,
    storageReservedBytes: 0,
    maxCiphertextBytes: backend.maxCiphertextBytes,
    maxActiveDevices: backend.maxActiveDevices,
    maxActiveProjects: backend.maxActiveProjects,
  });
  assert.deepEqual(initial.counts, { activeDevices: 1, activeProjects: 0 });
  for (const legacy of ['limitBytes', 'usedBytes', 'reservedBytes']) {
    assert.equal(legacy in initial.limits, false);
  }
  assert.equal(
    checkAuthenticatedMeResponse(httpResponse(initial), {
      userID,
      storageLimitBytes: 1_000,
      storageUsedBytes: 400,
      storageReservedBytes: 0,
      maxCiphertextBytesFloor: 500,
      activeDevices: 1,
      activeProjects: 0,
    }),
    true,
  );

  // Mirrors the driver's post-reserve / post-project state.
  state.reservedBytes = 600n;
  state.activeProjects = 1;
  const afterReserve = await repository.read(userID);
  assert.deepEqual(afterReserve.limits, {
    storageLimitBytes: 1_000,
    storageUsedBytes: 400,
    storageReservedBytes: 600,
    maxCiphertextBytes: backend.maxCiphertextBytes,
    maxActiveDevices: backend.maxActiveDevices,
    maxActiveProjects: backend.maxActiveProjects,
  });
  assert.deepEqual(afterReserve.counts, { activeDevices: 1, activeProjects: 1 });
  assert.equal(
    checkAuthenticatedMeResponse(httpResponse(afterReserve), {
      userID,
      storageLimitBytes: 1_000,
      storageUsedBytes: 400,
      storageReservedBytes: 600,
      maxCiphertextBytesFloor: 500,
      activeDevices: 1,
      activeProjects: 1,
    }),
    true,
  );

  // Negative control: the pre-fix field names must not satisfy the driver.
  assert.equal(
    checkAuthenticatedMeResponse(httpResponse({
      ...afterReserve,
      limits: {
        limitBytes: 1_000,
        usedBytes: 400,
        reservedBytes: 600,
        maxCiphertextBytes: backend.maxCiphertextBytes,
      },
    }), {
      userID,
      storageLimitBytes: 1_000,
      storageUsedBytes: 400,
      storageReservedBytes: 600,
      maxCiphertextBytesFloor: 500,
      activeDevices: 1,
      activeProjects: 1,
    }),
    false,
  );
  assert.equal(
    checkAuthenticatedMeResponse({ statusCode: 500, json: () => afterReserve }, {
      userID,
      storageLimitBytes: 1_000,
      storageUsedBytes: 400,
      storageReservedBytes: 600,
      maxCiphertextBytesFloor: 500,
      activeDevices: 1,
      activeProjects: 1,
    }),
    false,
  );
});

test('live is 200 while ready stays 503 with Retry-After and sanitized envelope', async () => {
  const app = await startApi(TEST_CONFIG, {
    readiness: {
      database: async () => false,
      migrations: async () => false,
      storage: async () => false,
    },
    listen: async () => {},
  });
  try {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: 'ok' });

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.headers['retry-after'], '7');
    const body = ready.json() as { error?: { code?: string; message?: string } };
    assert.equal(body.error?.code, 'unavailable');
    assert.equal(body.error?.message, 'The service is not ready.');
  } finally {
    await app.close();
  }
});

test('unauthenticated /v1/me and unconfigured native token fail closed', async () => {
  const app = createApi({
    config: TEST_CONFIG,
    me: {
      repository: {
        read: async () => {
          throw new Error('must not read');
        },
      },
      authorize: async () => null,
    },
  });
  try {
    const me = await app.inject({ method: 'GET', url: '/v1/me' });
    assert.equal(me.statusCode, 401);
    const meBody = me.json() as { error?: { code?: string } };
    assert.equal(meBody.error?.code, 'unauthenticated');

    const token = await app.inject({
      method: 'POST',
      url: '/api/native/v1/token',
      payload: { deviceCode: 'synthetic-device-code' },
    });
    assert.equal(token.statusCode, 503);
    assert.equal(token.headers['retry-after'], '7');
    const tokenBody = token.json() as { error?: { code?: string } };
    assert.equal(tokenBody.error?.code, 'unavailable');
  } finally {
    await app.close();
  }
});

test('cleanup deletes only exact tracked scopes and verifies counters', async () => {
  const calls: string[] = [];
  const scope: RuntimeCleanupScope = {
    userID: 'owned-user',
    projectIDs: ['owned-project'],
    uploadIDs: ['owned-upload-a', 'owned-upload-b'],
    grantIDs: ['owned-grant'],
    deviceIDs: ['owned-device'],
    pendingIDs: ['owned-pending'],
  };
  const tx = fakeTransaction(calls, { projectCount: 1 });
  const client = {
    $transaction: async (callback: (transaction: unknown) => Promise<void>) =>
      callback(tx),
    user: { count: async () => 0 },
    userQuota: { count: async () => 0 },
    project: { count: async () => 0 },
    upload: { count: async () => 0 },
    device: { count: async () => 0 },
    nativeDeviceGrant: { count: async () => 0 },
    nativeAccessToken: { count: async () => 0 },
    nativeRefreshToken: { count: async () => 0 },
    nativePendingAuthorization: { count: async () => 0 },
  };
  const result = await cleanupRuntimeValidationFixtures(
    client as never,
    scope,
  );
  assert.equal(result, true);
  assert.deepEqual(calls, [
    'upload.deleteMany',
    'refresh.updateMany',
    'refresh.deleteMany',
    'access.deleteMany',
    'device.deleteMany',
    'grant.deleteMany',
    'pending.deleteMany',
    'project.deleteMany',
    'quota.deleteMany',
    'user.deleteMany',
  ]);
});

test('cleanup mismatch rolls back and retains the owned user', async () => {
  const calls: string[] = [];
  const scope: RuntimeCleanupScope = {
    userID: 'owned-user',
    projectIDs: ['owned-project'],
    uploadIDs: ['owned-upload'],
    grantIDs: ['owned-grant'],
    deviceIDs: ['owned-device'],
    pendingIDs: ['owned-pending'],
  };
  const tx = fakeTransaction(calls, { projectCount: 2 });
  const client = {
    $transaction: async (callback: (transaction: unknown) => Promise<void>) =>
      callback(tx),
  };
  await assert.rejects(
    cleanupRuntimeValidationFixtures(client as never, scope),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeValidationError);
      assert.equal(error.code, 'cleanup-failed');
      assert.deepEqual(error.retainedFixtureUserIDs, ['owned-user']);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('guard failure retains the generated owner IDs without cleanup', async () => {
  const client = {
    $queryRaw: async () => [
      {
        database: 'session_port',
        currentUser: 'sessionport_validation_runtime',
        sessionUser: 'sessionport_validation_runtime',
        serverVersion: 160015,
      },
    ],
  };
  await assert.rejects(
    runRuntimePostgresValidation(
      client as never,
      createRuntimeValidationOptions(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeValidationError);
      assert.equal(error.code, 'database-identity');
      assert.equal(error.retainedFixtureUserIDs.length, 1);
      assert.ok(error.retainedFixtureIDs.length >= 8);
      return true;
    },
  );
});

test('schema guard probes the mapped lowercase user table from approved migrations', async () => {
  const queries: string[] = [];
  const migrationNames = approvedMigrationNames();
  const schemaRow = Object.fromEntries(
    Object.keys(EXPECTED_GUARD_TABLE_MODELS).map((alias) => [alias, true]),
  );
  const client = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      queries.push(sql);
      if (queries.length === 1) {
        return [{
          database: 'session_port_validation',
          currentUser: 'sessionport_validation_migrator',
          sessionUser: 'sessionport_validation_migrator',
          serverVersion: 160015,
        }];
      }
      if (queries.length === 2) {
        return migrationNames.map((migrationName) => ({
          migrationName,
          finishedAt: new Date('2026-10-21T00:00:00Z'),
          rolledBackAt: null,
        }));
      }
      return [schemaRow];
    },
    user: {
      create: async () => {
        throw new Error('synthetic seed stop after guard');
      },
    },
  };

  await assert.rejects(
    runRuntimePostgresValidation(
      client as never,
      createRuntimeValidationOptions(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeValidationError);
      assert.equal(error.code, 'seed-failed');
      assert.equal(error.retainedFixtureUserIDs.length, 1);
      return true;
    },
  );

  assert.deepEqual(migrationNames, [
    '202610190001_vendor_auth',
    '202610190002_project_quota',
    '202610200003_protocol_native',
  ]);
  assert.equal(queries.length, 3);
  assert.match(queries[0]!, /current_database\(\)/);
  assert.match(queries[1]!, /_prisma_migrations/);
  const guardSql = queries[2]!;
  assert.equal(guardSql.includes('public."User"'), false);
  assert.match(
    guardSql,
    /to_regclass\('public\."user"'\) IS NOT NULL AS "user"/,
  );

  const guardTables: Record<string, string> = {};
  for (const match of guardSql.matchAll(
    /to_regclass\('public\."([^"]+)"'\) IS NOT NULL AS "([^"]+)"/g,
  )) {
    guardTables[match[2]!] = match[1]!;
  }
  const expectedTables = expectedGuardTableMap();
  assert.equal(
    Object.keys(guardTables).length,
    Object.keys(EXPECTED_GUARD_TABLE_MODELS).length,
  );
  assert.deepEqual(guardTables, expectedTables);
  const createdTables = approvedMigrationTables();
  for (const table of Object.values(expectedTables)) {
    assert.equal(
      createdTables.has(table),
      true,
      `migration fixture lacks table ${table}`,
    );
  }
});

function approvedMigrationNames(): readonly string[] {
  return readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function approvedMigrationTables(): ReadonlySet<string> {
  const tables = new Set<string>();
  for (const migrationName of approvedMigrationNames()) {
    const sql = readFileSync(
      new URL(`${migrationName}/migration.sql`, MIGRATIONS_DIRECTORY),
      'utf8',
    );
    for (const match of sql.matchAll(/^CREATE TABLE "([^"]+)"/gm)) {
      tables.add(match[1]!);
    }
  }
  return tables;
}

function expectedGuardTableMap(): Readonly<Record<string, string>> {
  const schema = readFileSync(SCHEMA_FILE, 'utf8');
  const schemaTables: Record<string, string> = {};
  for (const model of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const mapped = /@@map\("([^"]+)"\)/.exec(model[2]!);
    schemaTables[model[1]!] = mapped?.[1] ?? model[1]!;
  }
  return Object.fromEntries(
    Object.entries(EXPECTED_GUARD_TABLE_MODELS).map(([alias, model]) => {
      const table = schemaTables[model];
      assert.ok(table !== undefined, `schema fixture lacks model ${model}`);
      return [alias, table];
    }),
  );
}

function successResult(): RuntimeValidationResult {
  return {
    status: 'passed',
    testPassed: true,
    cleanupVerified: true,
    postgresqlMajor: 16,
    migrationCount: 3,
    fixtureUserCount: 1,
    checkCount: 16,
    passedCheckCount: 16,
    passedChecks: [],
    failedCheck: null,
    retainedFixtureUserIDs: [],
    retainedFixtureIDs: [],
    quota: {
      limitBytes: 1_000,
      usedBytes: 400,
      reservedBefore: 200,
      reservedAfter: 600,
    },
  };
}

function fakeTransaction(
  calls: string[],
  options: { readonly projectCount: number },
): any {
  const deleteMany = (name: string, count: number) => async () => {
    calls.push(`${name}.deleteMany`);
    return { count };
  };
  return {
    user: { count: async () => 1, deleteMany: deleteMany('user', 1) },
    userQuota: {
      count: async () => 1,
      deleteMany: deleteMany('quota', 1),
    },
    project: {
      count: async () => options.projectCount,
      deleteMany: deleteMany('project', 1),
    },
    upload: { count: async () => 2, deleteMany: deleteMany('upload', 2) },
    device: { count: async () => 1, deleteMany: deleteMany('device', 1) },
    nativeDeviceGrant: {
      count: async () => 1,
      deleteMany: deleteMany('grant', 1),
    },
    nativePendingAuthorization: {
      count: async () => 1,
      deleteMany: deleteMany('pending', 1),
    },
    nativeAccessToken: { deleteMany: deleteMany('access', 1) },
    nativeRefreshToken: {
      updateMany: async () => {
        calls.push('refresh.updateMany');
        return { count: 1 };
      },
      deleteMany: deleteMany('refresh', 1),
    },
    revision: { count: async () => 0 },
    projectHead: { count: async () => 0 },
  };
}
