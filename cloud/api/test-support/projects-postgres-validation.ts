/**
 * One-off PostgreSQL validation driver for the project repository (test-support).
 * Read-only guards run first; three synthetic users are seeded atomically; bounded
 * cases run; only exact tracked fixture rows are removed after every case passes and
 * all queries settle. No cleanup runs on failure or deadline. No sleeps, lock
 * signals, retries, product hooks, or raw mutation SQL. Cleanup is a proposed test
 * mutation requiring owner authorisation. Concurrency is n=1 evidence only.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../prisma/generated/client/client.js';
import { createProjectRepository, ProjectRepositoryError } from '../src/projects/repository.js';
import type { CreateOrLinkResult } from '../src/projects/repository.js';

const EXPECTED_MIGRATIONS = ['202610190001_vendor_auth', '202610190002_project_quota'] as const;
const DATABASE = 'session_port_validation';
const ROLE = 'sessionport_validation_migrator';
const USER_PREFIX = 'sessionport-pg-test-';
const USER_NAME = 'SessionPort synthetic PostgreSQL validation';
const QUOTA_LIMIT = 1_024n;
const LABEL = Uint8Array.from([1, 2, 3]);
const BUDGET = { maxWait: 5_000, timeout: 10_000 } as const;

export const PROJECT_VALIDATION_CHECK_NAMES = [
  'database-identity', 'postgresql-major-16', 'migrations-finished', 'fixture-tables-empty',
  'fixture-seed', 'a-concurrent-cap-one-created-one-limited', 'a-link-at-cap-no-duplicate',
  'b-concurrent-same-id-one-created-one-linked', 'tenant-scoped-list',
  'foreign-project-id-unavailable', 'missing-quota-fails-closed',
  'quota-negative-used-rejected', 'quota-over-limit-rejected',
  'vendor-user-delete-restricted', 'cleanup-verified',
] as const;
export type ProjectValidationCheckName = (typeof PROJECT_VALIDATION_CHECK_NAMES)[number];
export type ProjectValidationErrorCode =
  | 'database-guard-failed' | 'seed-failed' | 'cleanup-failed' | 'validation-unavailable';
export type ProjectPostgresValidationClient = Pick<
  PrismaClient, '$queryRaw' | '$transaction' | 'user' | 'project' | 'userQuota'
>;
export interface ProjectPostgresValidationResult {
  readonly status: 'passed' | 'failed'; readonly testPassed: boolean;
  readonly cleanupVerified: boolean; readonly postgresqlMajor: number;
  readonly migrationCount: number; readonly fixtureUserCount: number;
  readonly checkCount: number; readonly passedCheckCount: number;
  readonly passedChecks: readonly ProjectValidationCheckName[];
  readonly failedCheck: ProjectValidationCheckName | null;
}
export class ProjectValidationError extends Error {
  readonly code: ProjectValidationErrorCode;
  constructor(code: ProjectValidationErrorCode) {
    super('Project PostgreSQL validation stopped.');
    this.name = 'ProjectValidationError';
    this.code = code;
  }
}

type FixtureIDs = { a: string; b: string; c: string; projectA1: string; projectA2: string; projectB: string; projectC: string };
type IdentityRow = { database: string; currentUser: string; sessionUser: string; serverVersion: number };
type MigrationRow = { migrationName: string; finishedAt: Date | null; rolledBackAt: Date | null };
type QuotaSnapshot = { limitBytes: bigint; usedBytes: bigint; reservedBytes: bigint };
class CaseFailure extends Error {
  readonly check: ProjectValidationCheckName;
  constructor(check: ProjectValidationCheckName) {
    super('Validation check failed.');
    this.check = check;
  }
}

/** Guard failures stop before any write and never enter cleanup. */
export async function runProjectPostgresValidation(
  client: ProjectPostgresValidationClient,
): Promise<ProjectPostgresValidationResult> {
  try {
    return await execute(client);
  } catch (error) {
    if (error instanceof ProjectValidationError) throw error;
    throw new ProjectValidationError('validation-unavailable');
  }
}

/**
 * Delete only exact tracked fixture scopes, then verify those three counts.
 * The driver calls this only after all cases pass; the CLI never imports it.
 */
export async function cleanupProjectValidationFixtures(
  client: ProjectPostgresValidationClient,
  userIDs: readonly string[],
): Promise<boolean> {
  const ids = [...new Set(userIDs)];
  if (ids.length === 0 || ids.length !== userIDs.length) {
    throw new ProjectValidationError('cleanup-failed');
  }
  await client.$transaction(async (transaction) => {
    await transaction.project.deleteMany({ where: { userID: { in: ids } } });
    await transaction.userQuota.deleteMany({ where: { userID: { in: ids } } });
    await transaction.user.deleteMany({ where: { id: { in: ids } } });
  }, BUDGET);
  const counts = await Promise.all([
    client.project.count({ where: { userID: { in: ids } } }),
    client.userQuota.count({ where: { userID: { in: ids } } }),
    client.user.count({ where: { id: { in: ids } } }),
  ]);
  return counts.every((count) => count === 0);
}

async function execute(client: ProjectPostgresValidationClient): Promise<ProjectPostgresValidationResult> {
  const ids = createFixtureIDs();
  const passed: ProjectValidationCheckName[] = [];
  let postgresqlMajor = 0, migrationCount = 0;
  let failedCheck: ProjectValidationCheckName | null = null;

  const guard = await runGuard(client);
  postgresqlMajor = guard.postgresqlMajor;
  migrationCount = guard.migrationCount;
  passed.push('database-identity', 'postgresql-major-16', 'migrations-finished', 'fixture-tables-empty');

  try {
    await seedFixtures(client, ids);
    passed.push('fixture-seed');
  } catch (error) {
    if (error instanceof CaseFailure) failedCheck = error.check;
    else throw new ProjectValidationError('seed-failed');
  }
  if (failedCheck === null) {
    try {
      await runCases(client, ids, (check) => passed.push(check));
    } catch (error) {
      if (error instanceof CaseFailure) failedCheck = error.check;
      else throw error;
    }
  }

  const failedResult = (): ProjectPostgresValidationResult => Object.freeze({
    status: 'failed' as const, testPassed: false, cleanupVerified: false,
    postgresqlMajor, migrationCount, fixtureUserCount: 3,
    checkCount: PROJECT_VALIDATION_CHECK_NAMES.length,
    passedCheckCount: passed.length, passedChecks: Object.freeze([...passed]),
    failedCheck,
  });
  // Cleanup runs only after all eight cases recorded and no failure was seen.
  if (failedCheck !== null || passed.length !== PROJECT_VALIDATION_CHECK_NAMES.length - 1) {
    return failedResult();
  }

  let cleanupVerified = false;
  try {
    cleanupVerified = await cleanupProjectValidationFixtures(client, [ids.a, ids.b, ids.c]);
  } catch {
    throw new ProjectValidationError('cleanup-failed');
  }
  if (!cleanupVerified) throw new ProjectValidationError('cleanup-failed');
  passed.push('cleanup-verified');

  const testPassed = passed.length === PROJECT_VALIDATION_CHECK_NAMES.length;
  return Object.freeze({
    status: testPassed ? ('passed' as const) : ('failed' as const),
    testPassed, cleanupVerified, postgresqlMajor, migrationCount,
    fixtureUserCount: 3, checkCount: PROJECT_VALIDATION_CHECK_NAMES.length,
    passedCheckCount: passed.length, passedChecks: Object.freeze([...passed]),
    failedCheck: null,
  });
}

async function runGuard(client: ProjectPostgresValidationClient): Promise<{ postgresqlMajor: number; migrationCount: number }> {
  try {
    const rows = await client.$queryRaw<IdentityRow[]>`
      SELECT current_database() AS "database", current_user AS "currentUser",
             session_user AS "sessionUser", current_setting('server_version_num')::int AS "serverVersion"`;
    requireGuard(rows.length === 1);
    const id = rows[0];
    requireGuard(id.database === DATABASE && id.currentUser === ROLE && id.sessionUser === ROLE);
    const postgresqlMajor = Math.trunc(Number(id.serverVersion) / 10_000);
    requireGuard(postgresqlMajor === 16);
    const migrations = await client.$queryRaw<MigrationRow[]>`
      SELECT "migration_name" AS "migrationName", "finished_at" AS "finishedAt",
             "rolled_back_at" AS "rolledBackAt" FROM "_prisma_migrations"`;
    requireGuard(migrations.length === EXPECTED_MIGRATIONS.length);
    for (const name of EXPECTED_MIGRATIONS) {
      const match = migrations.filter((row) => row.migrationName === name);
      requireGuard(match.length === 1 && match[0].finishedAt !== null && match[0].rolledBackAt === null);
    }
    const counts = await Promise.all([client.user.count(), client.project.count(), client.userQuota.count()]);
    requireGuard(counts.every((count) => count === 0));
    return { postgresqlMajor, migrationCount: migrations.length };
  } catch (error) {
    if (error instanceof ProjectValidationError) throw error;
    throw new ProjectValidationError('database-guard-failed');
  }
}

async function seedFixtures(client: ProjectPostgresValidationClient, ids: FixtureIDs): Promise<void> {
  const now = new Date();
  const users = [ids.a, ids.b, ids.c].map((id) => ({
    id, name: USER_NAME, email: `${randomUUID()}@test.example.invalid`,
    createdAt: now, updatedAt: now,
  }));
  const quotas = [ids.a, ids.b].map((userID) => ({
    userID, limitBytes: QUOTA_LIMIT, usedBytes: 0n, reservedBytes: 0n, updatedAt: now,
  }));
  await client.$transaction(async (transaction) => {
    await transaction.user.createMany({ data: users });
    await transaction.userQuota.createMany({ data: quotas });
  }, BUDGET);
  const [userCount, storedQuotas, cQuota] = await Promise.all([
    client.user.count({ where: { id: { in: [ids.a, ids.b, ids.c] } } }),
    client.userQuota.findMany({ where: { userID: { in: [ids.a, ids.b] } } }),
    client.userQuota.count({ where: { userID: ids.c } }),
  ]);
  ensure(
    userCount === 3 && storedQuotas.length === 2 && cQuota === 0 &&
      storedQuotas.every((quota) => quota.limitBytes === QUOTA_LIMIT &&
        quota.usedBytes === 0n && quota.reservedBytes === 0n),
    'fixture-seed',
  );
}

async function runCases(
  client: ProjectPostgresValidationClient,
  ids: FixtureIDs,
  record: (check: ProjectValidationCheckName) => void,
): Promise<void> {
  const a1 = createProjectRepository(client, { maxActiveProjects: 1 });
  const a200 = createProjectRepository(client, { maxActiveProjects: 200 });
  const b1 = createProjectRepository(client, { maxActiveProjects: 1 });
  const b2 = createProjectRepository(client, { maxActiveProjects: 2 });

  const c1 = 'a-concurrent-cap-one-created-one-limited';
  const settledA = await Promise.allSettled([
    a1.createOrLink({ userID: ids.a, projectID: ids.projectA1, encryptedLabel: LABEL }),
    a1.createOrLink({ userID: ids.a, projectID: ids.projectA2, encryptedLabel: LABEL }),
  ]);
  const createdA = settledA.filter((e) => e.status === 'fulfilled') as
    PromiseFulfilledResult<CreateOrLinkResult>[];
  const codesA = settledA.map((entry) => entry.status === 'fulfilled'
    ? `${entry.value.outcome}:${entry.value.statusCode}`
    : isRepositoryError(entry.reason, 'active-project-limit-reached') ? 'limit' : 'unexpected').sort();
  ensure(createdA.length === 1 && codesA[0] === 'created:201' && codesA[1] === 'limit', c1);
  const projectA = createdA[0].value.project.projectID;
  ensure((await activeCount(client, ids.a)) === 1, c1);
  record(c1);

  const c2 = 'a-link-at-cap-no-duplicate';
  const linked = await a200.createOrLink({ userID: ids.a, projectID: projectA });
  ensure(linked.outcome === 'linked' && linked.statusCode === 200, c2);
  ensure(bytesEqual(linked.project.encryptedLabel, LABEL), c2);
  ensure((await activeCount(client, ids.a)) === 1, c2);
  record(c2);

  const c3 = 'b-concurrent-same-id-one-created-one-linked';
  const settledB = await Promise.allSettled([
    b1.createOrLink({ userID: ids.b, projectID: ids.projectB }),
    b1.createOrLink({ userID: ids.b, projectID: ids.projectB }),
  ]);
  const statusesB = settledB.map((entry) =>
    entry.status === 'fulfilled' ? entry.value.statusCode : -1).sort();
  ensure(statusesB.length === 2 && statusesB[0] === 200 && statusesB[1] === 201, c3);
  ensure((await activeCount(client, ids.b)) === 1, c3);
  record(c3);

  const c4 = 'tenant-scoped-list';
  const [listA, listB, listC] = await Promise.all([
    a1.listActive({ userID: ids.a }), b1.listActive({ userID: ids.b }), a1.listActive({ userID: ids.c }),
  ]);
  ensure(
    sameProjectIDs(listA, [projectA]) && sameProjectIDs(listB, [ids.projectB]) &&
      sameProjectIDs(listC, []),
    c4,
  );
  record(c4);

  const c5 = 'foreign-project-id-unavailable';
  const projectsBefore = await client.project.count();
  await expectRepositoryError(b2.createOrLink({ userID: ids.b, projectID: projectA }), 'project-id-unavailable', c5);
  ensure((await client.project.count()) === projectsBefore, c5);
  record(c5);

  const c6 = 'missing-quota-fails-closed';
  await expectRepositoryError(a1.createOrLink({ userID: ids.c, projectID: ids.projectC }), 'quota-not-provisioned', c6);
  ensure((await activeCount(client, ids.c)) === 0, c6);
  record(c6);

  const c7a = 'quota-negative-used-rejected';
  const c7b = 'quota-over-limit-rejected';
  const baseline = await readQuota(client, ids.a);
  ensure(
    baseline !== null && baseline.limitBytes === QUOTA_LIMIT &&
      baseline.usedBytes === 0n && baseline.reservedBytes === 0n,
    c7a,
  );
  await expectQuotaCheck(client, ids.a, 'negative', c7a);
  ensure(sameQuota(await readQuota(client, ids.a), baseline), c7a);
  record(c7a);
  await expectQuotaCheck(client, ids.a, 'usage', c7b);
  ensure(sameQuota(await readQuota(client, ids.a), baseline), c7b);
  record(c7b);

  const c8 = 'vendor-user-delete-restricted';
  await expectForeignKeyRejected(client.user.delete({ where: { id: ids.a } }), c8);
  ensure((await client.user.count({ where: { id: ids.a } })) === 1, c8);
  record(c8);
}

function createFixtureIDs(): FixtureIDs {
  return {
    a: `${USER_PREFIX}${randomUUID()}`, b: `${USER_PREFIX}${randomUUID()}`,
    c: `${USER_PREFIX}${randomUUID()}`, projectA1: randomUUID(),
    projectA2: randomUUID(), projectB: randomUUID(), projectC: randomUUID(),
  };
}
function requireGuard(condition: boolean): asserts condition {
  if (!condition) throw new ProjectValidationError('database-guard-failed');
}
function ensure(condition: boolean, check: ProjectValidationCheckName): asserts condition {
  if (!condition) throw new CaseFailure(check);
}
function isRepositoryError(error: unknown, code: string): boolean {
  return error instanceof ProjectRepositoryError && error.code === code;
}
async function expectRepositoryError(
  operation: Promise<unknown>, code: string, check: ProjectValidationCheckName,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    ensure(isRepositoryError(error, code), check);
    return;
  }
  throw new CaseFailure(check);
}
async function expectQuotaCheck(
  client: ProjectPostgresValidationClient,
  userID: string,
  kind: 'negative' | 'usage',
  check: ProjectValidationCheckName,
): Promise<void> {
  try {
    await client.$transaction(async (transaction) => {
      // Fixture ID crosses into the DO block only through a transaction-local
      // setting, never through SQL text interpolation.
      await transaction.$queryRaw`
        SELECT set_config('sessionport.validation_fixture_user', ${userID}, true)`;
      if (kind === 'negative') {
        await transaction.$executeRaw`
DO $validation$
DECLARE
  v_user_id text := pg_catalog.current_setting('sessionport.validation_fixture_user');
  v_constraint text;
BEGIN
  UPDATE "UserQuota" SET "usedBytes" = -1 WHERE "userID" = v_user_id;
  RAISE EXCEPTION 'expected-check-not-raised';
EXCEPTION
  WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'UserQuota_bytes_nonnegative_check' THEN
      RAISE EXCEPTION 'unexpected-check-constraint';
    END IF;
END
$validation$`;
      } else {
        await transaction.$executeRaw`
DO $validation$
DECLARE
  v_user_id text := pg_catalog.current_setting('sessionport.validation_fixture_user');
  v_constraint text;
BEGIN
  UPDATE "UserQuota" SET "usedBytes" = "limitBytes" + 1 WHERE "userID" = v_user_id;
  RAISE EXCEPTION 'expected-check-not-raised';
EXCEPTION
  WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'UserQuota_usage_within_limit_check' THEN
      RAISE EXCEPTION 'unexpected-check-constraint';
    END IF;
END
$validation$`;
      }
    }, BUDGET);
  } catch {
    // Any unexpected error fails the case; it is never treated as the expected
    // constraint. Only normal completion of the DO block is a pass.
    throw new CaseFailure(check);
  }
}
async function expectForeignKeyRejected(
  operation: Promise<unknown>, check: ProjectValidationCheckName,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    ensure(
      typeof error === 'object' && error !== null &&
        (error as { code?: unknown }).code === 'P2003',
      check,
    );
    return;
  }
  throw new CaseFailure(check); // no raw driver text is read or reported
}
function activeCount(client: ProjectPostgresValidationClient, userID: string): Promise<number> {
  return client.project.count({ where: { userID, state: 'active' } });
}
function readQuota(client: ProjectPostgresValidationClient, userID: string): Promise<QuotaSnapshot | null> {
  return client.userQuota.findUnique({
    where: { userID }, select: { limitBytes: true, usedBytes: true, reservedBytes: true },
  });
}
function sameQuota(current: QuotaSnapshot | null, baseline: QuotaSnapshot): boolean {
  return current !== null && current.limitBytes === baseline.limitBytes &&
    current.usedBytes === baseline.usedBytes && current.reservedBytes === baseline.reservedBytes;
}
function sameProjectIDs(projects: readonly { projectID: string }[], expected: readonly string[]): boolean {
  const actual = projects.map((project) => project.projectID).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((projectID, index) => projectID === wanted[index]);
}
function bytesEqual(actual: Uint8Array | null, expected: Uint8Array): boolean {
  return actual !== null && actual.length === expected.length &&
    actual.every((byte, index) => byte === expected[index]);
}
