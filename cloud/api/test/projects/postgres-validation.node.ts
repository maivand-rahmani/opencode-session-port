import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DatabaseConfigError } from '../../src/database/config.js';
import {
  assertValidationTargetConnectionString,
  parseValidationRunArgs,
  readValidationDatabaseConfig,
  runValidationCli,
  VALIDATION_RUN_FLAG,
  ValidationTargetConfigError,
} from '../../scripts/validate-projects.js';
import {
  cleanupProjectValidationFixtures,
  PROJECT_VALIDATION_CHECK_NAMES,
  ProjectValidationError,
  runProjectPostgresValidation,
} from '../../test-support/projects-postgres-validation.js';
import type { ProjectPostgresValidationClient } from '../../test-support/projects-postgres-validation.js';

/*
 * Offline protocol tests only. They prove URL guards, import safety, the
 * explicit run flag, guard-before-write ordering, and cleanup scope against a
 * tiny structural fake. They do NOT prove PostgreSQL locking, constraint
 * behaviour, migration state, Prisma binding, or concurrency.
 */

const MIGRATOR_KEY = 'SESSIONPORT_MIGRATOR_DATABASE_URL';
const RUNTIME_KEY = 'SESSIONPORT_RUNTIME_DATABASE_URL';
const VALID_URL =
  'postgresql://sessionport_validation_migrator:synth%40tic%3Apass@session-port-postgres/session_port_validation';
const VALID_WITH_PORT = VALID_URL.replace(
  'session-port-postgres/',
  'session-port-postgres:5432/',
);
const VALID_WITH_QUERY = `${VALID_WITH_PORT}?schema=public&sslmode=require`;
const SYNTHETIC_SECRET = 'synthetic-url-secret-value';
const FIXED_TARGET_MESSAGE = 'Validation target configuration is invalid.';

function assertTargetError(error: unknown): boolean {
  assert.ok(error instanceof ValidationTargetConfigError);
  assert.equal(error.name, 'ValidationTargetConfigError');
  assert.equal(error.code, 'invalid-validation-target-config');
  assert.equal(error.message, FIXED_TARGET_MESSAGE);
  assert.equal(error.cause, undefined);
  const rendered = `${String(error)} ${error.stack ?? ''} ${JSON.stringify(error)}`;
  assert.equal(rendered.includes(SYNTHETIC_SECRET), false);
  return true;
}

test('accepts only the exact validation database, role, host, port, and query surface', () => {
  for (const url of [
    VALID_URL,
    VALID_WITH_PORT,
    `${VALID_URL}?schema=public`,
    `${VALID_URL}?sslmode=verify-full`,
    VALID_WITH_QUERY,
  ]) {
    assert.doesNotThrow(() => assertValidationTargetConnectionString(url));
  }

  const invalidUrls = [
    `postgresql://sessionport_validation_migrator:${SYNTHETIC_SECRET}@session-port-postgres/session_port`,
    `postgresql://sessionport_validation_migrator:${SYNTHETIC_SECRET}@session-port-postgres/session_port_validation_extra`,
    `postgresql://sessionport_validation_migrator:${SYNTHETIC_SECRET}@session-port-postgres/session_port_validation/`,
    `postgresql://sessionport_runtime:${SYNTHETIC_SECRET}@session-port-postgres/session_port_validation`,
    `postgresql://sessionport_validation_migrator2:${SYNTHETIC_SECRET}@session-port-postgres/session_port_validation`,
    `postgresql://sessionport_validation_migrator:${SYNTHETIC_SECRET}@localhost/session_port_validation`,
    `postgresql://sessionport_validation_migrator:${SYNTHETIC_SECRET}@session-port-postgres.local/session_port_validation`,
    `postgresql://sessionport_validation_migrator:${SYNTHETIC_SECRET}@session-port-postgres:5433/session_port_validation`,
    `postgresql://sessionport_validation_migrator@session-port-postgres/session_port_validation`,
    `${VALID_URL}#fragment`,
    `${VALID_URL}?host=session-port-postgres`,
    `${VALID_URL}?user=sessionport_validation_migrator`,
    `${VALID_URL}?dbname=session_port_validation`,
    `${VALID_URL}?password=other`,
    `${VALID_URL}?options=-c%20role%3Dpostgres`,
    `${VALID_URL}?application_name=sessionport`,
    `${VALID_URL}?schema=public&schema=public`,
    `${VALID_URL}?schema=other`,
    `${VALID_URL}?sslmode=require&sslmode=disable`,
    `${VALID_URL}?sslmode=require-full`,
    ` ${VALID_URL}`,
    `mysql://sessionport_validation_migrator:${SYNTHETIC_SECRET}@session-port-postgres/session_port_validation`,
  ];

  for (const url of invalidUrls) {
    assert.throws(
      () => assertValidationTargetConnectionString(url),
      assertTargetError,
      url,
    );
  }
});

test('reads only the migrator key and rejects missing or malformed configuration', () => {
  const config = readValidationDatabaseConfig({ [MIGRATOR_KEY]: VALID_URL });
  assert.deepEqual(config, { connectionString: VALID_URL });

  assert.throws(
    () => readValidationDatabaseConfig({}),
    (error: unknown) => error instanceof DatabaseConfigError,
  );
  assert.throws(
    () => readValidationDatabaseConfig({ [RUNTIME_KEY]: VALID_URL }),
    (error: unknown) => error instanceof DatabaseConfigError,
  );

  const guarded = new Proxy(
    { [MIGRATOR_KEY]: VALID_URL },
    {
      get(target, property, receiver) {
        if (property === RUNTIME_KEY) {
          throw new Error('cross-purpose environment access');
        }
        return Reflect.get(target, property, receiver);
      },
    },
  ) as NodeJS.ProcessEnv;
  assert.deepEqual(readValidationDatabaseConfig(guarded), {
    connectionString: VALID_URL,
  });
});

test('requires the exact flag plus bounded max-run argument and stops before any client work otherwise', async () => {
  assert.deepEqual(
    parseValidationRunArgs([VALIDATION_RUN_FLAG, '--max-run-ms=90000']),
    { maxRunMs: 90_000 },
  );
  assert.deepEqual(
    parseValidationRunArgs([VALIDATION_RUN_FLAG, '--max-run-ms=1000']),
    { maxRunMs: 1_000 },
  );
  assert.deepEqual(
    parseValidationRunArgs([VALIDATION_RUN_FLAG, '--max-run-ms=120000']),
    { maxRunMs: 120_000 },
  );

  const invalidArgs: string[][] = [
    [],
    [VALIDATION_RUN_FLAG],
    [VALIDATION_RUN_FLAG, '--max-run-ms='],
    [VALIDATION_RUN_FLAG, '--max-run-ms=090000'],
    [VALIDATION_RUN_FLAG, '--max-run-ms=+90000'],
    [VALIDATION_RUN_FLAG, '--max-run-ms=90000.0'],
    [VALIDATION_RUN_FLAG, '--max-run-ms=1e5'],
    [VALIDATION_RUN_FLAG, '--max-run-ms=abc'],
    [VALIDATION_RUN_FLAG, '--max-run-ms=999'],
    [VALIDATION_RUN_FLAG, '--max-run-ms=120001'],
    [VALIDATION_RUN_FLAG, '--max-run-ms=90000', 'extra'],
    ['--max-run-ms=90000', VALIDATION_RUN_FLAG],
    [`${VALIDATION_RUN_FLAG}=true`, '--max-run-ms=90000'],
  ];
  for (const argv of invalidArgs) {
    assert.equal(parseValidationRunArgs(argv), null, argv.join(' '));
  }

  const guardedEnv = new Proxy({} as NodeJS.ProcessEnv, {
    get() {
      throw new Error('environment must not be read before argument acceptance');
    },
  });
  for (const argv of invalidArgs) {
    const output: string[] = [];
    const code = await runValidationCli(argv, guardedEnv, (text) => output.push(text));
    assert.equal(code, 2);
    assert.deepEqual(output, [
      argv.includes(VALIDATION_RUN_FLAG)
        ? 'status=stopped code=validation-arguments-invalid\n'
        : 'status=stopped code=validation-run-not-requested\n',
    ]);
  }

  const blocked: string[] = [];
  const blockedCode = await runValidationCli(
    [VALIDATION_RUN_FLAG, '--max-run-ms=90000'],
    {
      [MIGRATOR_KEY]: VALID_URL.replace(
        'session_port_validation',
        `other_db_${SYNTHETIC_SECRET}`,
      ),
    },
    (text) => blocked.push(text),
  );
  assert.equal(blockedCode, 1);
  assert.deepEqual(blocked, [
    'status=blocked code=invalid-validation-target-config\n',
  ]);
  assert.equal(blocked.join('').includes(SYNTHETIC_SECRET), false);

  const source = readFileSync(
    new URL('../../scripts/validate-projects.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /parseValidationRunArgs/);
  assert.match(source, /--max-run-ms=/);
  assert.match(source, /status=timeout code=validation-deadline-exceeded cleanupVerified=false/);
  assert.match(source, /process\.exit\(code\)/);
  assert.match(source, /readMigrationDatabaseConfig\(env\)/);
  assert.match(source, /await import\('@prisma\/adapter-pg'\)/);
  assert.match(source, /await client\.\$disconnect\(\)/);
  assert.match(source, /invokedDirectly/);
  assert.equal(source.includes('dotenv'), false);
  assert.equal(source.includes('cleanupProjectValidationFixtures'), false);
  assert.equal((source.match(/new PrismaClient/gu) ?? []).length, 1);
  assert.equal((source.match(/new PrismaPg/gu) ?? []).length, 1);
});

test('hard deadline writes fixed timeout, exits 124, clears timer, and stays distinct from failure', async () => {
  let timerCallback: (() => void) | undefined;
  let clearedHandle: unknown;
  let terminated: number | undefined;
  const output: string[] = [];
  const pending = runValidationCli(
    [VALIDATION_RUN_FLAG, '--max-run-ms=90000'],
    {} as NodeJS.ProcessEnv,
    (text) => output.push(text),
    {
      setTimer: (callback, delayMs) => {
        assert.equal(delayMs, 90_000);
        timerCallback = callback;
        return 'deadline-timer';
      },
      clearTimer: (handle) => {
        clearedHandle = handle;
      },
      terminate: (code) => {
        terminated = code;
      },
      testAttempt: () => new Promise<number>(() => {}),
    },
  );
  assert.ok(timerCallback);
  timerCallback();
  const code = await pending;
  assert.equal(code, 124);
  assert.equal(terminated, 124);
  assert.equal(clearedHandle, 'deadline-timer');
  assert.deepEqual(output, [
    'status=timeout code=validation-deadline-exceeded cleanupVerified=false\n',
  ]);
});

test('clears the timer only after the attempt settles', async () => {
  let cleared = false;
  let attemptFinished = false;
  const code = await runValidationCli(
    [VALIDATION_RUN_FLAG, '--max-run-ms=90000'],
    {} as NodeJS.ProcessEnv,
    () => {},
    {
      setTimer: () => 'normal-timer',
      clearTimer: (handle) => {
        assert.equal(handle, 'normal-timer');
        cleared = true;
      },
      terminate: () => {
        throw new Error('deadline must not fire');
      },
      testAttempt: async () => {
        assert.equal(cleared, false);
        attemptFinished = true;
        return 0;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(attemptFinished, true);
  assert.equal(cleared, true);
});

interface Counts {
  readonly user: number;
  readonly project: number;
  readonly quota: number;
}

class GuardFake {
  rawCalls = 0;
  transactionCalls = 0;
  readonly countCalls: string[] = [];

  constructor(
    private readonly identityRows: ReadonlyArray<Record<string, unknown>>,
    private readonly migrationRows: ReadonlyArray<Record<string, unknown>>,
    private readonly counts: Counts,
  ) {}

  async $queryRaw(strings: TemplateStringsArray): Promise<unknown> {
    this.rawCalls += 1;
    const sql = strings.join('?');
    if (sql.includes('current_database')) return this.identityRows;
    if (sql.includes('_prisma_migrations')) return this.migrationRows;
    throw new Error('unexpected raw query');
  }

  readonly user = {
    count: async (): Promise<number> => {
      this.countCalls.push('user');
      return this.counts.user;
    },
  };

  readonly project = {
    count: async (): Promise<number> => {
      this.countCalls.push('project');
      return this.counts.project;
    },
  };

  readonly userQuota = {
    count: async (): Promise<number> => {
      this.countCalls.push('quota');
      return this.counts.quota;
    },
  };

  async $transaction(): Promise<never> {
    this.transactionCalls += 1;
    throw new Error('write attempted before guard passed');
  }
}

const VALID_IDENTITY = [
  {
    database: 'session_port_validation',
    currentUser: 'sessionport_validation_migrator',
    sessionUser: 'sessionport_validation_migrator',
    serverVersion: 160015,
  },
];
const VALID_MIGRATIONS = [
  {
    migrationName: '202610190001_vendor_auth',
    finishedAt: new Date('2026-10-19T00:00:01.000Z'),
    rolledBackAt: null,
  },
  {
    migrationName: '202610190002_project_quota',
    finishedAt: new Date('2026-10-19T00:00:02.000Z'),
    rolledBackAt: null,
  },
];
const EMPTY_COUNTS: Counts = { user: 0, project: 0, quota: 0 };

async function assertGuardStops(
  identityRows: ReadonlyArray<Record<string, unknown>>,
  migrationRows: ReadonlyArray<Record<string, unknown>>,
  counts: Counts,
): Promise<GuardFake> {
  const fake = new GuardFake(identityRows, migrationRows, counts);
  await assert.rejects(
    runProjectPostgresValidation(
      fake as unknown as ProjectPostgresValidationClient,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProjectValidationError);
      assert.equal(error.code, 'database-guard-failed');
      assert.equal(error.cause, undefined);
      assert.equal(
        `${String(error)} ${error.stack ?? ''} ${JSON.stringify(error)}`.includes(
          SYNTHETIC_SECRET,
        ),
        false,
      );
      return true;
    },
  );
  assert.equal(fake.transactionCalls, 0);
  return fake;
}

test('stops before any write when database identity or PostgreSQL major is unexpected', async () => {
  const wrongDatabase = await assertGuardStops(
    [{ ...VALID_IDENTITY[0], database: 'other_database' }],
    VALID_MIGRATIONS,
    EMPTY_COUNTS,
  );
  assert.equal(wrongDatabase.rawCalls, 1);
  assert.deepEqual(wrongDatabase.countCalls, []);

  const wrongRole = await assertGuardStops(
    [
      {
        ...VALID_IDENTITY[0],
        sessionUser: 'sessionport_runtime',
      },
    ],
    VALID_MIGRATIONS,
    EMPTY_COUNTS,
  );
  assert.equal(wrongRole.rawCalls, 1);
  assert.deepEqual(wrongRole.countCalls, []);

  const wrongMajor = await assertGuardStops(
    [{ ...VALID_IDENTITY[0], serverVersion: 170000 }],
    VALID_MIGRATIONS,
    EMPTY_COUNTS,
  );
  assert.equal(wrongMajor.rawCalls, 1);
  assert.deepEqual(wrongMajor.countCalls, []);
});

test('stops before any write when migrations or initial fixture tables are unexpected', async () => {
  const unfinished = await assertGuardStops(
    VALID_IDENTITY,
    [{ ...VALID_MIGRATIONS[0], finishedAt: null }, VALID_MIGRATIONS[1]],
    EMPTY_COUNTS,
  );
  assert.equal(unfinished.rawCalls, 2);
  assert.deepEqual(unfinished.countCalls, []);

  const rolledBack = await assertGuardStops(
    VALID_IDENTITY,
    [
      VALID_MIGRATIONS[0],
      { ...VALID_MIGRATIONS[1], rolledBackAt: new Date() },
    ],
    EMPTY_COUNTS,
  );
  assert.equal(rolledBack.rawCalls, 2);
  assert.deepEqual(rolledBack.countCalls, []);

  const extraMigration = await assertGuardStops(
    VALID_IDENTITY,
    [
      ...VALID_MIGRATIONS,
      {
        migrationName: '202610190003_unexpected',
        finishedAt: new Date(),
        rolledBackAt: null,
      },
    ],
    EMPTY_COUNTS,
  );
  assert.equal(extraMigration.rawCalls, 2);
  assert.deepEqual(extraMigration.countCalls, []);

  const unexpectedRows = await assertGuardStops(
    VALID_IDENTITY,
    VALID_MIGRATIONS,
    { user: 0, project: 1, quota: 0 },
  );
  assert.equal(unexpectedRows.rawCalls, 2);
  assert.deepEqual(unexpectedRows.countCalls, ['user', 'project', 'quota']);
});

interface SeedTransaction {
  readonly user: { createMany(args: unknown): Promise<{ count: number }> };
  readonly userQuota: { createMany(args: unknown): Promise<{ count: number }> };
}

class FailureFake {
  transactionCalls = 0;
  deleteCalls = 0;
  seeded = false;

  constructor(private readonly failSeed = false) {}

  async $queryRaw(strings: TemplateStringsArray): Promise<unknown> {
    const sql = strings.join('?');
    if (sql.includes('current_database')) return VALID_IDENTITY;
    if (sql.includes('_prisma_migrations')) return VALID_MIGRATIONS;
    throw new Error('unexpected raw query');
  }

  readonly user = {
    count: async (args?: unknown): Promise<number> =>
      args === undefined ? 0 : this.seeded ? 3 : 0,
    deleteMany: async (): Promise<{ count: number }> => {
      this.deleteCalls += 1;
      return { count: 0 };
    },
  };

  readonly project = {
    count: async (): Promise<number> => 0,
    deleteMany: async (): Promise<{ count: number }> => {
      this.deleteCalls += 1;
      return { count: 0 };
    },
  };

  readonly userQuota = {
    count: async (): Promise<number> => 0,
    findMany: async (): Promise<Array<{
      userID: string; limitBytes: bigint; usedBytes: bigint; reservedBytes: bigint;
    }>> => this.seeded ? [
      { userID: 'a', limitBytes: 1_024n, usedBytes: 0n, reservedBytes: 0n },
      { userID: 'b', limitBytes: 1_024n, usedBytes: 0n, reservedBytes: 0n },
    ] : [],
    deleteMany: async (): Promise<{ count: number }> => {
      this.deleteCalls += 1;
      return { count: 0 };
    },
  };

  async $transaction<T>(
    operation: (transaction: SeedTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionCalls += 1;
    if (this.failSeed || this.transactionCalls !== 1) {
      throw new Error('forced failure');
    }
    const transaction: SeedTransaction = {
      user: {
        createMany: async () => {
          this.seeded = true;
          return { count: 3 };
        },
      },
      userQuota: { createMany: async () => ({ count: 2 }) },
    };
    return operation(transaction);
  }
}

test('skips cleanup on case or seed failure and returns cleanupVerified=false', async () => {
  const caseFailure = new FailureFake();
  const result = await runProjectPostgresValidation(
    caseFailure as unknown as ProjectPostgresValidationClient,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.testPassed, false);
  assert.equal(result.cleanupVerified, false);
  assert.equal(
    result.failedCheck,
    'a-concurrent-cap-one-created-one-limited',
  );
  assert.equal(caseFailure.transactionCalls, 3);
  assert.equal(caseFailure.deleteCalls, 0);

  const seedFailure = new FailureFake(true);
  await assert.rejects(
    runProjectPostgresValidation(
      seedFailure as unknown as ProjectPostgresValidationClient,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProjectValidationError);
      assert.equal(error.code, 'seed-failed');
      return true;
    },
  );
  assert.equal(seedFailure.transactionCalls, 1);
  assert.equal(seedFailure.deleteCalls, 0);
});

test('quota DO blocks target only check_violation and exact named constraints', () => {
  const source = readFileSync(
    new URL('../../test-support/projects-postgres-validation.ts', import.meta.url),
    'utf8',
  );
  for (const expected of [
    "WHEN check_violation THEN",
    "GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME",
    "UserQuota_bytes_nonnegative_check",
    "UserQuota_usage_within_limit_check",
    "set_config('sessionport.validation_fixture_user', ${userID}, true)",
    "RAISE EXCEPTION 'expected-check-not-raised'",
    "RAISE EXCEPTION 'unexpected-check-constraint'",
  ]) {
    assert.ok(source.includes(expected), expected);
  }
  assert.deepEqual(source.match(/WHEN\s+[a-z_]+/g), [
    'WHEN check_violation',
    'WHEN check_violation',
  ]);
  assert.equal(source.split('DO $validation$').length - 1, 2);
  assert.equal(source.split('GET STACKED DIAGNOSTICS').length - 1, 2);
  for (const block of source.matchAll(/DO \$validation\$[\s\S]*?\$validation\$/g)) {
    assert.equal(block[0].includes('${'), false);
  }
  assert.equal(source.includes('$executeRawUnsafe'), false);
  assert.equal(source.includes('$queryRawUnsafe'), false);
  assert.equal(source.includes('P2004'), false);
  assert.equal(source.includes('23514'), false);
  // Static source assertions only; PostgreSQL syntax/behaviour is not proven here.
});

test('cleanup is gated after all cases and is absent from the CLI', () => {
  const driverSource = readFileSync(
    new URL('../../test-support/projects-postgres-validation.ts', import.meta.url),
    'utf8',
  );
  const cliSource = readFileSync(
    new URL('../../scripts/validate-projects.ts', import.meta.url),
    'utf8',
  );
  const runCasesIndex = driverSource.indexOf('await runCases');
  const cleanupIndex = driverSource.indexOf(
    'cleanupProjectValidationFixtures(client, [ids.a, ids.b, ids.c])',
  );
  assert.ok(runCasesIndex >= 0 && cleanupIndex > runCasesIndex);
  assert.equal(
    /finally\s*\{[\s\S]{0,500}cleanupProjectValidationFixtures/.test(driverSource),
    false,
  );
  assert.ok(driverSource.includes('cleanupVerified: false'));
  assert.ok(driverSource.includes('if (failedCheck !== null || passed.length !=='));
  assert.ok(driverSource.includes(
    'transaction.project.deleteMany({ where: { userID: { in: ids } } })',
  ));
  assert.ok(driverSource.includes(
    'transaction.userQuota.deleteMany({ where: { userID: { in: ids } } })',
  ));
  assert.ok(driverSource.includes(
    'transaction.user.deleteMany({ where: { id: { in: ids } } })',
  ));
  assert.equal(driverSource.includes('deleteMany({})'), false);
  assert.equal(cliSource.includes('cleanupProjectValidationFixtures'), false);
});

interface FixtureCall {
  readonly target: 'project' | 'userQuota' | 'user';
  readonly args: unknown;
}

interface CleanupTransaction {
  readonly project: {
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  readonly userQuota: {
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  readonly user: {
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

class CleanupFake {
  readonly deleteCalls: FixtureCall[] = [];
  readonly countCalls: FixtureCall[] = [];
  transactionOptions: unknown;
  remaining = { project: 0, quota: 0, user: 0 };

  private readonly transaction: CleanupTransaction = {
    project: {
      deleteMany: async (args: unknown) => {
        this.deleteCalls.push({ target: 'project', args });
        return { count: 1 };
      },
    },
    userQuota: {
      deleteMany: async (args: unknown) => {
        this.deleteCalls.push({ target: 'userQuota', args });
        return { count: 1 };
      },
    },
    user: {
      deleteMany: async (args: unknown) => {
        this.deleteCalls.push({ target: 'user', args });
        return { count: 1 };
      },
    },
  };

  async $transaction<T>(
    operation: (transaction: CleanupTransaction) => Promise<T>,
    options?: unknown,
  ): Promise<T> {
    this.transactionOptions = options;
    return operation(this.transaction);
  }

  readonly project = {
    count: async (args: unknown) => {
      this.countCalls.push({ target: 'project', args });
      return this.remaining.project;
    },
  };

  readonly userQuota = {
    count: async (args: unknown) => {
      this.countCalls.push({ target: 'userQuota', args });
      return this.remaining.quota;
    },
  };

  readonly user = {
    count: async (args: unknown) => {
      this.countCalls.push({ target: 'user', args });
      return this.remaining.user;
    },
  };
}

test('cleanup helper targets only the exact tracked fixture scopes and verifies zero rows', async () => {
  const ids = [
    'sessionport-pg-test-a',
    'sessionport-pg-test-b',
    'sessionport-pg-test-c',
  ];
  const fake = new CleanupFake();

  const verified = await cleanupProjectValidationFixtures(
    fake as unknown as ProjectPostgresValidationClient,
    ids,
  );

  assert.equal(verified, true);
  assert.deepEqual(fake.deleteCalls, [
    { target: 'project', args: { where: { userID: { in: ids } } } },
    { target: 'userQuota', args: { where: { userID: { in: ids } } } },
    { target: 'user', args: { where: { id: { in: ids } } } },
  ]);
  assert.deepEqual(fake.countCalls, [
    { target: 'project', args: { where: { userID: { in: ids } } } },
    { target: 'userQuota', args: { where: { userID: { in: ids } } } },
    { target: 'user', args: { where: { id: { in: ids } } } },
  ]);
  assert.deepEqual(fake.transactionOptions, { maxWait: 5_000, timeout: 10_000 });
  for (const call of fake.deleteCalls) {
    assert.notDeepEqual(call.args, {});
    assert.notDeepEqual(call.args, { where: {} });
  }

  fake.remaining = { project: 1, quota: 0, user: 0 };
  assert.equal(
    await cleanupProjectValidationFixtures(
      fake as unknown as ProjectPostgresValidationClient,
      ids,
    ),
    false,
  );

  const callCount = fake.deleteCalls.length;
  await assert.rejects(
    cleanupProjectValidationFixtures(
      fake as unknown as ProjectPostgresValidationClient,
      [ids[0], ids[0]],
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProjectValidationError);
      assert.equal(error.code, 'cleanup-failed');
      return true;
    },
  );
  assert.equal(fake.deleteCalls.length, callCount);
});

test('exports a fixed, unique check-name protocol without fixture identifiers', () => {
  assert.equal(
    new Set(PROJECT_VALIDATION_CHECK_NAMES).size,
    PROJECT_VALIDATION_CHECK_NAMES.length,
  );
  assert.equal(PROJECT_VALIDATION_CHECK_NAMES.at(-1), 'cleanup-verified');
  for (const name of PROJECT_VALIDATION_CHECK_NAMES) {
    assert.match(name, /^[a-z0-9-]+$/);
  }
});
