import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DatabaseConfigError } from '../src/database/config.js';
import {
  assertValidationTargetConnectionString,
  readValidationDatabaseConfig,
  ValidationTargetConfigError,
} from '../scripts/validate-projects.js';
import {
  MAX_RUN_MS,
  MIN_RUN_MS,
  parseProtocolValidationRunArgs,
  PROTOCOL_RUN_FLAG,
  runProtocolValidationCli,
} from '../scripts/validate-protocol.js';
import {
  cleanupProtocolValidationFixtures,
  PROTOCOL_VALIDATION_CHECK_NAMES,
  ProtocolValidationError,
  runProtocolPostgresValidation,
  siblingCommitHeadsValid,
} from '../test-support/protocol-postgres-validation.js';
import type {
  ProtocolCleanupScope,
  ProtocolPostgresValidationClient,
} from '../test-support/protocol-postgres-validation.js';
import type { CommitRevisionResult } from '../src/revisions/repository.js';

/*
 * Offline protocol tests only. They prove URL/argument guards, import safety,
 * fixed status output, hard-deadline lifecycle, guard-before-write ordering,
 * exact cleanup scope/order, and source wiring to the real repositories.
 *
 * They do NOT prove PostgreSQL locking, SSI, migration state, Prisma binding,
 * constraint behaviour, concurrency, or any live SQL execution.
 */

const MIGRATOR_KEY = 'SESSIONPORT_MIGRATOR_DATABASE_URL';
const RUNTIME_KEY = 'SESSIONPORT_RUNTIME_DATABASE_URL';
const VALID_URL =
  'postgresql://sessionport_validation_migrator:synth%40tic%3Apass@session-port-postgres/session_port_validation';
const SYNTHETIC_SECRET = 'synthetic-url-secret-value';
const FIXED_DRIVER_MESSAGE = 'Protocol PostgreSQL validation stopped.';
const VALID_IDENTITY = [{
  database: 'session_port_validation',
  currentUser: 'sessionport_validation_migrator',
  sessionUser: 'sessionport_validation_migrator',
  serverVersion: 160015,
}];
const VALID_MIGRATIONS = [
  { migrationName: '202610190001_vendor_auth',
    finishedAt: new Date('2026-10-19T00:00:01.000Z'), rolledBackAt: null },
  { migrationName: '202610190002_project_quota',
    finishedAt: new Date('2026-10-19T00:00:02.000Z'), rolledBackAt: null },
  { migrationName: '202610200003_protocol_native',
    finishedAt: new Date('2026-10-19T00:00:03.000Z'), rolledBackAt: null },
];

function assertDriverError(error: unknown, code: string): boolean {
  assert.ok(error instanceof ProtocolValidationError);
  assert.equal(error.name, 'ProtocolValidationError');
  assert.equal(error.code, code);
  assert.equal(error.message, FIXED_DRIVER_MESSAGE);
  assert.equal(error.cause, undefined);
  const rendered = `${String(error)} ${error.stack ?? ''} ${JSON.stringify(error)}`;
  assert.equal(rendered.includes(SYNTHETIC_SECRET), false);
  return true;
}

test('accepts exactly the protocol run flag and bounded max-run argument', () => {
  assert.deepEqual(
    parseProtocolValidationRunArgs([PROTOCOL_RUN_FLAG, '--max-run-ms=90000']),
    { maxRunMs: 90_000 },
  );
  assert.deepEqual(
    parseProtocolValidationRunArgs([PROTOCOL_RUN_FLAG, '--max-run-ms=1000']),
    { maxRunMs: MIN_RUN_MS },
  );
  assert.deepEqual(
    parseProtocolValidationRunArgs([PROTOCOL_RUN_FLAG, '--max-run-ms=120000']),
    { maxRunMs: MAX_RUN_MS },
  );
  const invalid = [
    [],
    [PROTOCOL_RUN_FLAG],
    [PROTOCOL_RUN_FLAG, '--max-run-ms='],
    [PROTOCOL_RUN_FLAG, '--max-run-ms=090000'],
    [PROTOCOL_RUN_FLAG, '--max-run-ms=+90000'],
    [PROTOCOL_RUN_FLAG, '--max-run-ms=90000.0'],
    [PROTOCOL_RUN_FLAG, '--max-run-ms=1e5'],
    [PROTOCOL_RUN_FLAG, '--max-run-ms=999'],
    [PROTOCOL_RUN_FLAG, '--max-run-ms=120001'],
    [PROTOCOL_RUN_FLAG, '--max-run-ms=90000', 'extra'],
    ['--max-run-ms=90000', PROTOCOL_RUN_FLAG],
  ];
  for (const argv of invalid) {
    assert.equal(parseProtocolValidationRunArgs(argv), null, argv.join(' '));
  }
});

test('stops invalid args before environment access and reads only the migrator key', async () => {
  const guardedEnv = new Proxy({} as NodeJS.ProcessEnv, {
    get() { throw new Error('environment must not be read before argument acceptance'); },
  });
  for (const argv of [[], [PROTOCOL_RUN_FLAG], [PROTOCOL_RUN_FLAG, '--max-run-ms=1']]) {
    const output: string[] = [];
    const code = await runProtocolValidationCli(argv, guardedEnv, (text) => output.push(text));
    assert.equal(code, 2);
    assert.deepEqual(output, [
      argv.includes(PROTOCOL_RUN_FLAG)
        ? 'status=stopped code=protocol-validation-arguments-invalid\n'
        : 'status=stopped code=protocol-validation-run-not-requested\n',
    ]);
  }

  assert.deepEqual(readValidationDatabaseConfig({ [MIGRATOR_KEY]: VALID_URL }), {
    connectionString: VALID_URL,
  });
  assert.throws(
    () => readValidationDatabaseConfig({ [RUNTIME_KEY]: VALID_URL }),
    (error: unknown) => error instanceof DatabaseConfigError,
  );
  assert.throws(
    () => assertValidationTargetConnectionString(
      VALID_URL.replace('session_port_validation', `other_db_${SYNTHETIC_SECRET}`),
    ),
    (error: unknown) => error instanceof ValidationTargetConfigError,
  );

  const blocked: string[] = [];
  const blockedCode = await runProtocolValidationCli(
    [PROTOCOL_RUN_FLAG, '--max-run-ms=90000'],
    { [MIGRATOR_KEY]: VALID_URL.replace('session_port_validation', `other_db_${SYNTHETIC_SECRET}`) },
    (text) => blocked.push(text),
  );
  assert.equal(blockedCode, 1);
  assert.deepEqual(blocked, ['status=blocked code=invalid-protocol-validation-target-config\n']);
  assert.equal(blocked.join('').includes(SYNTHETIC_SECRET), false);
});

test('hard deadline writes fixed timeout, exits 124, and clears the timer', async () => {
  let callback: (() => void) | undefined;
  let cleared: unknown;
  let terminated: number | undefined;
  const output: string[] = [];
  const pending = runProtocolValidationCli(
    [PROTOCOL_RUN_FLAG, '--max-run-ms=90000'],
    {} as NodeJS.ProcessEnv,
    (text) => output.push(text),
    {
      setTimer: (value, delayMs) => {
        assert.equal(delayMs, 90_000);
        callback = value;
        return 'deadline-timer';
      },
      clearTimer: (handle) => { cleared = handle; },
      terminate: (code) => { terminated = code; },
      testAttempt: () => new Promise<number>(() => {}),
    },
  );
  assert.ok(callback);
  callback();
  assert.equal(await pending, 124);
  assert.equal(terminated, 124);
  assert.equal(cleared, 'deadline-timer');
  assert.deepEqual(output, [
    'status=timeout code=protocol-validation-deadline-exceeded cleanupVerified=false\n',
  ]);
});

test('clears the deadline only after the attempt settles', async () => {
  let cleared = false;
  let finished = false;
  const code = await runProtocolValidationCli(
    [PROTOCOL_RUN_FLAG, '--max-run-ms=90000'],
    {} as NodeJS.ProcessEnv,
    () => {},
    {
      setTimer: () => 'normal-timer',
      clearTimer: (handle) => { assert.equal(handle, 'normal-timer'); cleared = true; },
      terminate: () => { throw new Error('deadline must not fire'); },
      testAttempt: async () => { assert.equal(cleared, false); finished = true; return 0; },
    },
  );
  assert.equal(code, 0);
  assert.equal(finished, true);
  assert.equal(cleared, true);
});

type Counts = Record<'project' | 'revision' | 'projectHead' | 'upload' | 'device' |
  'nativeDeviceGrant' | 'nativeAccessToken' | 'nativeRefreshToken' |
  'nativePendingAuthorization', number>;

const EMPTY_COUNTS: Counts = {
  project: 0, revision: 0, projectHead: 0, upload: 0, device: 0,
  nativeDeviceGrant: 0, nativeAccessToken: 0, nativeRefreshToken: 0,
  nativePendingAuthorization: 0,
};

class GuardFake {
  rawCalls = 0;
  transactionCalls = 0;
  constructor(
    private readonly identity = VALID_IDENTITY,
    private readonly migrations = VALID_MIGRATIONS,
    private readonly counts: Counts = EMPTY_COUNTS,
  ) {}
  async $queryRaw(strings: TemplateStringsArray): Promise<unknown> {
    this.rawCalls += 1;
    const sql = strings.join('?');
    if (sql.includes('current_database')) return this.identity;
    if (sql.includes('_prisma_migrations')) return this.migrations;
    throw new Error('unexpected raw query');
  }
  async $transaction(): Promise<never> {
    this.transactionCalls += 1;
    throw new Error('write attempted before guard passed');
  }
  readonly project = { count: async () => this.counts.project };
  readonly revision = { count: async () => this.counts.revision };
  readonly projectHead = { count: async () => this.counts.projectHead };
  readonly upload = { count: async () => this.counts.upload };
  readonly device = { count: async () => this.counts.device };
  readonly nativeDeviceGrant = { count: async () => this.counts.nativeDeviceGrant };
  readonly nativeAccessToken = { count: async () => this.counts.nativeAccessToken };
  readonly nativeRefreshToken = { count: async () => this.counts.nativeRefreshToken };
  readonly nativePendingAuthorization = {
    count: async () => this.counts.nativePendingAuthorization,
  };
}

async function assertGuardStops(
  identity: readonly Record<string, unknown>[] = VALID_IDENTITY,
  migrations: readonly Record<string, unknown>[] = VALID_MIGRATIONS,
  counts: Counts = EMPTY_COUNTS,
): Promise<GuardFake> {
  const fake = new GuardFake(identity as typeof VALID_IDENTITY,
    migrations as typeof VALID_MIGRATIONS, counts);
  await assert.rejects(
    runProtocolPostgresValidation(fake as unknown as ProtocolPostgresValidationClient),
    (error: unknown) => assertDriverError(error, 'database-guard-failed'),
  );
  assert.equal(fake.transactionCalls, 0);
  return fake;
}

test('guard stops before any write on identity, major, migration, or table-count mismatch', async () => {
  await assertGuardStops([{ ...VALID_IDENTITY[0], database: 'other_database' }]);
  await assertGuardStops([{ ...VALID_IDENTITY[0], sessionUser: 'sessionport_runtime' }]);
  await assertGuardStops([{ ...VALID_IDENTITY[0], serverVersion: 170000 }]);
  await assertGuardStops(VALID_IDENTITY, [{ ...VALID_MIGRATIONS[0], finishedAt: null },
    VALID_MIGRATIONS[1], VALID_MIGRATIONS[2]]);
  await assertGuardStops(VALID_IDENTITY, [{ ...VALID_MIGRATIONS[0] },
    { ...VALID_MIGRATIONS[1], rolledBackAt: new Date() }, VALID_MIGRATIONS[2]]);
  await assertGuardStops(VALID_IDENTITY, [VALID_MIGRATIONS[0], VALID_MIGRATIONS[1]]);
  await assertGuardStops(VALID_IDENTITY, [...VALID_MIGRATIONS,
    { migrationName: '202610200004_unexpected', finishedAt: new Date(), rolledBackAt: null }]);
  await assertGuardStops(VALID_IDENTITY, VALID_MIGRATIONS,
    { ...EMPTY_COUNTS, upload: 1 });
});

const CLEANUP_SCOPE: ProtocolCleanupScope = {
  userIDs: ['user-fixture-a'],
  projectIDs: ['project-fixture-a'],
  revisionIDs: ['revision-fixture-a', 'revision-fixture-root'],
  uploadIDs: ['upload-fixture-a', 'upload-fixture-root'],
  grantIDs: ['grant-fixture-a'],
  pendingIDs: ['pending-fixture-a'],
};

class CleanupFake {
  readonly calls: Array<{ target: string; method: string; args: unknown }> = [];
  readonly countCalls: Array<{ target: string; args: unknown }> = [];
  transactionOptions: unknown;
  remaining = 0;
  failTarget: string | null = null;
  private readonly tx: Record<string, Record<string, unknown>>;

  constructor() {
    const record = (target: string, method: string, args: unknown) => {
      this.calls.push({ target, method, args });
      if (this.failTarget === target) throw new Error('forced cleanup failure');
      return { count: 1 };
    };
    this.tx = {
      projectHead: { deleteMany: async (args: unknown) => record('projectHead', 'deleteMany', args) },
      revision: { deleteMany: async (args: unknown) => record('revision', 'deleteMany', args) },
      upload: { deleteMany: async (args: unknown) => record('upload', 'deleteMany', args) },
      nativeRefreshToken: {
        updateMany: async (args: unknown) => record('nativeRefreshToken', 'updateMany', args),
        deleteMany: async (args: unknown) => record('nativeRefreshToken', 'deleteMany', args),
      },
      nativeAccessToken: {
        deleteMany: async (args: unknown) => record('nativeAccessToken', 'deleteMany', args),
      },
      device: { deleteMany: async (args: unknown) => record('device', 'deleteMany', args) },
      nativeDeviceGrant: {
        deleteMany: async (args: unknown) => record('nativeDeviceGrant', 'deleteMany', args),
      },
      nativePendingAuthorization: {
        deleteMany: async (args: unknown) =>
          record('nativePendingAuthorization', 'deleteMany', args),
      },
      project: { deleteMany: async (args: unknown) => record('project', 'deleteMany', args) },
      userQuota: { deleteMany: async (args: unknown) => record('userQuota', 'deleteMany', args) },
      user: { deleteMany: async (args: unknown) => record('user', 'deleteMany', args) },
    };
  }

  async $transaction<T>(operation: (tx: unknown) => Promise<T>, options?: unknown): Promise<T> {
    this.transactionOptions = options;
    return operation(this.tx);
  }

  private count(target: string, args: unknown): number {
    this.countCalls.push({ target, args });
    return this.remaining;
  }
  readonly user = { count: async (args: unknown) => this.count('user', args) };
  readonly userQuota = { count: async (args: unknown) => this.count('userQuota', args) };
  readonly project = { count: async (args: unknown) => this.count('project', args) };
  readonly revision = { count: async (args: unknown) => this.count('revision', args) };
  readonly upload = { count: async (args: unknown) => this.count('upload', args) };
  readonly projectHead = { count: async (args: unknown) => this.count('projectHead', args) };
  readonly device = { count: async (args: unknown) => this.count('device', args) };
  readonly nativeDeviceGrant = {
    count: async (args: unknown) => this.count('nativeDeviceGrant', args),
  };
  readonly nativeAccessToken = {
    count: async (args: unknown) => this.count('nativeAccessToken', args),
  };
  readonly nativeRefreshToken = {
    count: async (args: unknown) => this.count('nativeRefreshToken', args),
  };
  readonly nativePendingAuthorization = {
    count: async (args: unknown) => this.count('nativePendingAuthorization', args),
  };
}

test('cleanup targets exact tracked scopes in RESTRICT order and verifies zero rows', async () => {
  const fake = new CleanupFake();
  assert.equal(await cleanupProtocolValidationFixtures(
    fake as unknown as ProtocolPostgresValidationClient,
    CLEANUP_SCOPE,
  ), true);
  assert.deepEqual(fake.transactionOptions, { maxWait: 5_000, timeout: 10_000 });
  assert.deepEqual(fake.calls.map((call) => `${call.target}.${call.method}`), [
    'projectHead.deleteMany',
    'revision.deleteMany',
    'upload.deleteMany',
    'revision.deleteMany',
    'upload.deleteMany',
    'nativeRefreshToken.updateMany',
    'nativeRefreshToken.deleteMany',
    'nativeAccessToken.deleteMany',
    'device.deleteMany',
    'nativeDeviceGrant.deleteMany',
    'nativePendingAuthorization.deleteMany',
    'project.deleteMany',
    'userQuota.deleteMany',
    'user.deleteMany',
  ]);
  assert.deepEqual(fake.calls.find((call) =>
    call.target === 'nativeRefreshToken' && call.method === 'updateMany')?.args, {
    where: { grantID: { in: CLEANUP_SCOPE.grantIDs } },
    data: { spentAt: null, successorID: null },
  });
  for (const call of fake.calls) {
    assert.notDeepEqual(call.args, {});
    assert.notDeepEqual(call.args, { where: {} });
    assert.equal(JSON.stringify(call.args).includes('deleteMany()'), false);
  }
  fake.remaining = 1;
  assert.equal(await cleanupProtocolValidationFixtures(
    fake as unknown as ProtocolPostgresValidationClient,
    CLEANUP_SCOPE,
  ), false);

  const failing = new CleanupFake();
  failing.failTarget = 'user';
  await assert.rejects(
    cleanupProtocolValidationFixtures(
      failing as unknown as ProtocolPostgresValidationClient,
      CLEANUP_SCOPE,
    ),
    (error: unknown) => assertDriverError(error, 'cleanup-failed'),
  );
  assert.equal(failing.countCalls.length, 0);
});

test('cleanup refuses empty or invalid scope before opening a transaction', async () => {
  const fake = new CleanupFake();
  await assert.rejects(
    cleanupProtocolValidationFixtures(
      fake as unknown as ProtocolPostgresValidationClient,
      { ...CLEANUP_SCOPE, userIDs: [] },
    ),
    (error: unknown) => assertDriverError(error, 'cleanup-failed'),
  );
  assert.equal(fake.countCalls.length, 0);
});

test('exports a unique fixed check protocol with cleanup last', () => {
  assert.equal(new Set(PROTOCOL_VALIDATION_CHECK_NAMES).size,
    PROTOCOL_VALIDATION_CHECK_NAMES.length);
  assert.equal(PROTOCOL_VALIDATION_CHECK_NAMES.at(-1), 'cleanup-verified');
  for (const name of PROTOCOL_VALIDATION_CHECK_NAMES) {
    assert.match(name, /^[a-z0-9-]+$/);
  }
});

test('source wires real repositories and contains no live-run or unsafe SQL path', () => {
  const driver = readFileSync(
    new URL('../test-support/protocol-postgres-validation.ts', import.meta.url),
    'utf8',
  );
  const cli = readFileSync(
    new URL('../scripts/validate-protocol.ts', import.meta.url),
    'utf8',
  );
  for (const expected of [
    'createProjectRepository', 'createRevisionRepository', 'createUploadRepository',
    'createNativeAuthRepository', 'createBearerEnforcement', 'Promise.allSettled',
    '202610190001_vendor_auth', '202610190002_project_quota',
    '202610200003_protocol_native',
  ]) {
    assert.ok(driver.includes(expected), expected);
  }
  for (const forbidden of [
    '$executeRawUnsafe', '$queryRawUnsafe', 'TRUNCATE', 'migrate deploy',
    'DROP TABLE', 'setTimeout', 'deleteMany({})',
  ]) {
    assert.equal(driver.includes(forbidden), false, forbidden);
  }
  for (const expected of [
    'PROTOCOL_RUN_FLAG', '--max-run-ms=',
    'status=timeout code=protocol-validation-deadline-exceeded cleanupVerified=false',
    'process.exit(code)', 'readValidationDatabaseConfig(env)',
    "await import('@prisma/adapter-pg')",
    "await import('../prisma/generated/client/client.js')",
    "schema: 'public'", 'await client.$disconnect()', 'invokedDirectly',
  ]) {
    assert.ok(cli.includes(expected), expected);
  }
  assert.equal(cli.includes('dotenv'), false);
  assert.equal(cli.includes(`'${MIGRATOR_KEY}'`), false);
  assert.equal(cli.includes(`'${RUNTIME_KEY}'`), false);
  assert.equal(cli.includes('cleanupProtocolValidationFixtures'), false);
  assert.equal((cli.match(/new PrismaClient/gu) ?? []).length, 1);
  assert.equal((cli.match(/new PrismaPg/gu) ?? []).length, 1);
});

test('sibling commit predicate requires serialized first head and conflicted second head set', () => {
  const siblingA = '11111111-1111-4111-8111-111111111111';
  const siblingB = '22222222-2222-4222-8222-222222222222';
  // Incoming expected IDs are deliberately unordered and mixed-case; the
  // predicate must normalize only the expectation, never the actual head order.
  const expected = [siblingB.toUpperCase(), siblingA];
  const commit = (seq: string, revisionID: string, headIDs: readonly string[],
    conflict: boolean): CommitRevisionResult => ({
    statusCode: 201, revisionID, seq, headIDs, conflict,
  });
  const first = commit('2', siblingA, [siblingA], false);
  const second = commit('3', siblingB, [siblingA, siblingB], true);

  assert.equal(siblingCommitHeadsValid([first, second], expected), true);
  assert.equal(siblingCommitHeadsValid([second, first], expected), true);

  // Both results reporting both heads is the original driver bug.
  assert.equal(siblingCommitHeadsValid(
    [commit('2', siblingA, [siblingA, siblingB], false), second], expected), false);
  // Seq 2 must report only its own head.
  assert.equal(siblingCommitHeadsValid(
    [commit('2', siblingA, [siblingB], false), second], expected), false);
  // Seq 3 must report the complete sorted head set.
  assert.equal(siblingCommitHeadsValid(
    [first, commit('3', siblingB, [siblingA], true)], expected), false);
  // Actual head order is meaningful and must not be sorted by the predicate.
  assert.equal(siblingCommitHeadsValid(
    [first, commit('3', siblingB, [siblingB, siblingA], true)], expected), false);
  // Inverted conflict flags fail.
  assert.equal(siblingCommitHeadsValid(
    [commit('2', siblingA, [siblingA], true),
      commit('3', siblingB, [siblingA, siblingB], false)], expected), false);
  // Duplicate or missing seq values fail.
  assert.equal(siblingCommitHeadsValid(
    [first, commit('2', siblingB, [siblingA, siblingB], true)], expected), false);
  assert.equal(siblingCommitHeadsValid(
    [first, commit('4', siblingB, [siblingA, siblingB], true)], expected), false);
  assert.equal(siblingCommitHeadsValid([first], expected), false);
});
