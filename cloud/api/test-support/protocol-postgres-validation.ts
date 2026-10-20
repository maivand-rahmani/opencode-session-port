/**
 * Protocol PostgreSQL validation driver (test-support, preparation only).
 *
 * Not wired into the server, a migration, or an automatic test. It is a
 * one-off, owner-authorized driver for the dedicated `session_port_validation`
 * database after the original Project/UserQuota fixtures are gone and migration
 * 0003 is applied by its separate owner-approved bundle. It performs no
 * migration apply, Git, network, S3, vault, Docker, or LLM work.
 *
 * Every behavioural case calls the real repositories. Fixtures are synthetic
 * rows created only by this driver. Cleanup runs only after all cases pass and
 * every operation settles, then deletes exactly the tracked scopes in one
 * transaction and verifies those scopes are empty.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { NativeAuthAuthorizationPolicy } from '../src/native-auth/config.js';
import { fingerprintCredential } from '../src/native-auth/credentials.js';
import { createBearerEnforcement } from '../src/native-auth/enforcement.js';
import {
  NativeAuthRepositoryError,
  createNativeAuthRepository,
} from '../src/native-auth/repository.js';
import {
  ProjectRepositoryError,
  createProjectRepository,
} from '../src/projects/repository.js';
import {
  RevisionRepositoryError,
  createRevisionRepository,
} from '../src/revisions/repository.js';
import type { CommitRevisionResult } from '../src/revisions/repository.js';
import {
  UploadRepositoryError,
  createUploadRepository,
} from '../src/uploads/repository.js';
import type { PrismaClient } from '../prisma/generated/client/client.js';

const EXPECTED_MIGRATIONS = [
  '202610190001_vendor_auth',
  '202610190002_project_quota',
  '202610200003_protocol_native',
] as const;
const DATABASE = 'session_port_validation';
const ROLE = 'sessionport_validation_migrator';
const POSTGRESQL_MAJOR = 16;
const USER_PREFIX = 'sessionport-protocol-pg-test-';
const BUDGET = { maxWait: 5_000, timeout: 10_000 } as const;
const UPLOAD_SIZE = 100n;
const QUOTA_LIMIT = 1_000n;
const GENERAL_QUOTA_LIMIT = 1_000_000n;
const AUTH_AUDIENCE = 'https://sessionport.invalid';
const AUTH_RESOURCE = AUTH_AUDIENCE;
const AUTH_SCOPES = ['projects:read', 'projects:write'] as const;
const AUTH_POLICY: NativeAuthAuthorizationPolicy = {
  audience: AUTH_AUDIENCE,
  resource: AUTH_RESOURCE,
  allowedScopes: [...AUTH_SCOPES],
  requiredRouteScopes: { 'projects.create': ['projects:write'] },
};
const POLLING = {
  intervalSeconds: 5,
  backoffIncrementSeconds: 5,
  maxIntervalSeconds: 60,
} as const;

export const PROTOCOL_VALIDATION_CHECK_NAMES = [
  'database-identity',
  'postgresql-major-16',
  'migrations-finished',
  'business-tables-empty',
  'fixture-seed',
  'project-create-cap-tenant-isolation',
  'revision-concurrent-siblings',
  'revision-idempotent-replay',
  'revision-page-upper-bound-live-heads',
  'revision-page-limit-zero-tenant-not-found',
  'quota-reservation-race',
  'pending-exchange-atomic-active-grant-cap',
  'refresh-rotation-concurrent-replay-revokes',
  'pending-approval-per-user-cap-isolation',
  'cleanup-verified',
] as const;

export type ProtocolValidationCheckName =
  (typeof PROTOCOL_VALIDATION_CHECK_NAMES)[number];

export type ProtocolValidationErrorCode =
  | 'database-guard-failed'
  | 'seed-failed'
  | 'cleanup-failed'
  | 'validation-unavailable';

export type ProtocolPostgresValidationClient = Pick<
  PrismaClient,
  | '$queryRaw'
  | '$transaction'
  | 'user'
  | 'userQuota'
  | 'project'
  | 'revision'
  | 'projectHead'
  | 'upload'
  | 'device'
  | 'nativeDeviceGrant'
  | 'nativeAccessToken'
  | 'nativeRefreshToken'
  | 'nativePendingAuthorization'
>;

export interface ProtocolPostgresValidationResult {
  readonly status: 'passed' | 'failed';
  readonly testPassed: boolean;
  readonly cleanupVerified: boolean;
  readonly postgresqlMajor: number;
  readonly migrationCount: number;
  readonly fixtureUserCount: number;
  readonly checkCount: number;
  readonly passedCheckCount: number;
  readonly passedChecks: readonly ProtocolValidationCheckName[];
  readonly failedCheck: ProtocolValidationCheckName | null;
  /** Sanitised synthetic fixture user identifiers for owner review. */
  readonly retainedFixtureUserIDs: readonly string[];
}

export class ProtocolValidationError extends Error {
  readonly code: ProtocolValidationErrorCode;
  readonly retainedFixtureUserIDs: readonly string[];
  constructor(code: ProtocolValidationErrorCode, retained: readonly string[] = []) {
    super('Protocol PostgreSQL validation stopped.');
    this.name = 'ProtocolValidationError';
    this.code = code;
    this.retainedFixtureUserIDs = Object.freeze([...retained]);
  }
}

export interface ProtocolCleanupScope {
  readonly userIDs: readonly string[];
  readonly projectIDs: readonly string[];
  readonly revisionIDs: readonly string[];
  readonly uploadIDs: readonly string[];
  readonly grantIDs: readonly string[];
  readonly pendingIDs: readonly string[];
}

/**
 * The project row lock serializes concurrent commits. The first commit takes
 * seq 2 and sees only its own head without a conflict; the second takes seq 3,
 * sees both sorted heads, and reports the conflict. Results are indexed by seq,
 * not call order, because lock acquisition order is not deterministic.
 */
export function siblingCommitHeadsValid(
  results: readonly CommitRevisionResult[],
  expectedHeads: readonly string[],
): boolean {
  if (results.length !== 2 || expectedHeads.length !== 2) return false;
  const bySeq = new Map(results.map((result) => [result.seq, result] as const));
  if (bySeq.size !== 2) return false;
  const first = bySeq.get('2');
  const second = bySeq.get('3');
  if (!first || !second) return false;
  const expected = expectedHeads.map((id) => id.toLowerCase()).sort();
  const firstHead = first.revisionID.toLowerCase();
  const secondHead = second.revisionID.toLowerCase();
  if (!expected.includes(firstHead) || !expected.includes(secondHead) ||
    firstHead === secondHead) {
    return false;
  }
  return first.headIDs.length === 1 && first.headIDs[0] === firstHead &&
    first.conflict === false &&
    second.headIDs.length === expected.length &&
    second.headIDs.every((id, index) => id === expected[index]) &&
    second.conflict === true;
}

interface PendingFixture {
  readonly id: string;
  readonly deviceCodeFingerprint: string;
  readonly humanCodeDigest: Uint8Array;
  readonly humanCodeKeyID: string;
}
interface FixtureIDs {
  readonly users: {
    readonly project: string; readonly revision: string; readonly pagination: string;
    readonly quota: string; readonly exchange: string; readonly rotation: string;
    readonly approval: string; readonly other: string;
  };
  readonly projects: {
    readonly projectA: string; readonly projectB: string; readonly revision: string;
    readonly pagination: string; readonly quota: string;
  };
  readonly grants: {
    readonly revisionA: string; readonly revisionB: string; readonly pagination: string;
    readonly quota: string; readonly rotation: string; readonly exchangeA: string;
    readonly exchangeB: string;
  };
  readonly devices: {
    readonly revisionA: string; readonly revisionB: string; readonly pagination: string;
    readonly quota: string; readonly rotation: string; readonly exchangeA: string;
    readonly exchangeB: string;
  };
  readonly revisions: {
    readonly parent: string; readonly siblingA: string; readonly siblingB: string;
    readonly pageA: string; readonly pageB: string; readonly pageC: string;
  };
  readonly uploads: {
    readonly parent: string; readonly siblingA: string; readonly siblingB: string;
    readonly replacement: string; readonly pageA: string; readonly pageB: string;
    readonly pageC: string; readonly quotaA: string; readonly quotaB: string;
  };
  readonly access: { readonly rotationOldID: string };
  readonly refresh: { readonly rotationOldID: string };
  readonly pendings: {
    readonly exchangeA: PendingFixture; readonly exchangeB: PendingFixture;
    readonly approvalA: PendingFixture; readonly approvalB: PendingFixture;
    readonly other: PendingFixture;
  };
  readonly digests: { readonly upload: Uint8Array; readonly quota: Uint8Array };
}
interface SeedContext {
  readonly ids: FixtureIDs;
  readonly rotationOldAccessToken: string;
  readonly rotationOldRefreshFingerprint: string;
}
interface IdentityRow {
  readonly database: string; readonly currentUser: string;
  readonly sessionUser: string; readonly serverVersion: number;
}
interface MigrationRow {
  readonly migrationName: string; readonly finishedAt: Date | null;
  readonly rolledBackAt: Date | null;
}
interface QuotaSnapshot {
  readonly limitBytes: bigint; readonly usedBytes: bigint; readonly reservedBytes: bigint;
}
interface RotationDescriptor {
  readonly accessID: string; readonly accessFingerprint: string;
  readonly accessToken: string; readonly refreshID: string;
  readonly refreshFingerprint: string;
}
class CaseFailure extends Error {
  readonly check: ProtocolValidationCheckName;
  constructor(check: ProtocolValidationCheckName) { super('Validation check failed.'); this.check = check; }
}

/** Run guards, fixtures, real-repository cases, and gated cleanup. */
export async function runProtocolPostgresValidation(
  client: ProtocolPostgresValidationClient,
): Promise<ProtocolPostgresValidationResult> {
  const ids = createFixtureIDs();
  try {
    return await execute(client, ids);
  } catch (error) {
    if (error instanceof ProtocolValidationError) throw error;
    throw new ProtocolValidationError('validation-unavailable', userIDs(ids));
  }
}

/**
 * Delete only the tracked fixture scopes. The driver calls this only after all
 * cases pass; the CLI never imports it. A failed transaction rolls back and
 * retains every fixture row for manual review.
 */
export async function cleanupProtocolValidationFixtures(
  client: ProtocolPostgresValidationClient,
  scope: ProtocolCleanupScope,
): Promise<boolean> {
  requireCleanupScope(scope);
  try {
    await client.$transaction(async (tx) => {
    await tx.projectHead.deleteMany({ where: { projectID: { in: [...scope.projectIDs] } } });
    // Break the Upload <-> Revision cycle: child revisions, child uploads,
    // root revisions (whose storageObjectKey points at a root upload), then
    // root uploads. Uploads also reference their parent revision.
    await tx.revision.deleteMany({ where: {
      revisionID: { in: [...scope.revisionIDs] }, parentRevisionID: { not: null },
    } });
    await tx.upload.deleteMany({ where: {
      uploadID: { in: [...scope.uploadIDs] }, parentRevisionID: { not: null },
    } });
    await tx.revision.deleteMany({ where: {
      revisionID: { in: [...scope.revisionIDs] }, parentRevisionID: null,
    } });
    await tx.upload.deleteMany({ where: {
      uploadID: { in: [...scope.uploadIDs] }, parentRevisionID: null,
    } });
    // spentAt and successorID must move together under the CHECK, and clearing
    // the self-FK lets the refresh rows be removed in any order.
    await tx.nativeRefreshToken.updateMany({
      where: { grantID: { in: [...scope.grantIDs] } },
      data: { spentAt: null, successorID: null },
    });
    await tx.nativeRefreshToken.deleteMany({ where: { grantID: { in: [...scope.grantIDs] } } });
    await tx.nativeAccessToken.deleteMany({ where: { grantID: { in: [...scope.grantIDs] } } });
    await tx.device.deleteMany({ where: { userID: { in: [...scope.userIDs] } } });
    await tx.nativeDeviceGrant.deleteMany({ where: { userID: { in: [...scope.userIDs] } } });
    await tx.nativePendingAuthorization.deleteMany({ where: { id: { in: [...scope.pendingIDs] } } });
    await tx.project.deleteMany({ where: { projectID: { in: [...scope.projectIDs] } } });
    await tx.userQuota.deleteMany({ where: { userID: { in: [...scope.userIDs] } } });
    await tx.user.deleteMany({ where: { id: { in: [...scope.userIDs] } } });
    }, BUDGET);
  } catch (error) {
    if (error instanceof ProtocolValidationError) throw error;
    throw new ProtocolValidationError('cleanup-failed', scope.userIDs);
  }

  const counts = await Promise.all([
    client.user.count({ where: { id: { in: [...scope.userIDs] } } }),
    client.userQuota.count({ where: { userID: { in: [...scope.userIDs] } } }),
    client.project.count({ where: { projectID: { in: [...scope.projectIDs] } } }),
    client.revision.count({ where: { revisionID: { in: [...scope.revisionIDs] } } }),
    client.upload.count({ where: { uploadID: { in: [...scope.uploadIDs] } } }),
    client.projectHead.count({ where: { projectID: { in: [...scope.projectIDs] } } }),
    client.device.count({ where: { userID: { in: [...scope.userIDs] } } }),
    client.nativeDeviceGrant.count({ where: { userID: { in: [...scope.userIDs] } } }),
    client.nativeAccessToken.count({ where: { grantID: { in: [...scope.grantIDs] } } }),
    client.nativeRefreshToken.count({ where: { grantID: { in: [...scope.grantIDs] } } }),
    client.nativePendingAuthorization.count({ where: { id: { in: [...scope.pendingIDs] } } }),
  ]);
  return counts.every((count) => count === 0);
}

async function execute(
  client: ProtocolPostgresValidationClient,
  ids: FixtureIDs,
): Promise<ProtocolPostgresValidationResult> {
  const passed: ProtocolValidationCheckName[] = [];
  let failedCheck: ProtocolValidationCheckName | null = null;
  const guard = await runGuard(client);
  passed.push('database-identity', 'postgresql-major-16', 'migrations-finished', 'business-tables-empty');

  let seed: SeedContext;
  try {
    seed = await seedFixtures(client, ids);
    passed.push('fixture-seed');
  } catch (error) {
    if (error instanceof ProtocolValidationError) throw error;
    throw new ProtocolValidationError('seed-failed', userIDs(ids));
  }

  try {
    await runCases(client, seed, (check) => passed.push(check));
  } catch (error) {
    if (error instanceof CaseFailure) failedCheck = error.check;
    else throw new ProtocolValidationError('validation-unavailable', userIDs(ids));
  }

  const retained = userIDs(ids);
  const failed = (): ProtocolPostgresValidationResult => Object.freeze({
    status: 'failed' as const, testPassed: false, cleanupVerified: false,
    postgresqlMajor: guard.postgresqlMajor, migrationCount: guard.migrationCount,
    fixtureUserCount: retained.length, checkCount: PROTOCOL_VALIDATION_CHECK_NAMES.length,
    passedCheckCount: passed.length, passedChecks: Object.freeze([...passed]),
    failedCheck, retainedFixtureUserIDs: retained,
  });
  if (failedCheck !== null) return failed();
  if (passed.length !== PROTOCOL_VALIDATION_CHECK_NAMES.length - 1) {
    throw new ProtocolValidationError('validation-unavailable', retained);
  }

  let cleanupVerified = false;
  try {
    cleanupVerified = await cleanupProtocolValidationFixtures(client, cleanupScope(ids));
  } catch {
    throw new ProtocolValidationError('cleanup-failed', retained);
  }
  if (!cleanupVerified) throw new ProtocolValidationError('cleanup-failed', retained);
  passed.push('cleanup-verified');

  const testPassed = passed.length === PROTOCOL_VALIDATION_CHECK_NAMES.length;
  return Object.freeze({
    status: testPassed ? ('passed' as const) : ('failed' as const), testPassed,
    cleanupVerified, postgresqlMajor: guard.postgresqlMajor,
    migrationCount: guard.migrationCount, fixtureUserCount: retained.length,
    checkCount: PROTOCOL_VALIDATION_CHECK_NAMES.length, passedCheckCount: passed.length,
    passedChecks: Object.freeze([...passed]), failedCheck: null,
    retainedFixtureUserIDs: Object.freeze([]),
  });
}

async function runGuard(client: ProtocolPostgresValidationClient): Promise<{
  postgresqlMajor: number; migrationCount: number;
}> {
  try {
    const identity = await client.$queryRaw<IdentityRow[]>`
      SELECT current_database() AS "database", current_user AS "currentUser",
             session_user AS "sessionUser",
             current_setting('server_version_num')::int AS "serverVersion"`;
    requireGuard(identity.length === 1);
    const row = identity[0]!;
    requireGuard(row.database === DATABASE && row.currentUser === ROLE && row.sessionUser === ROLE);
    const postgresqlMajor = Math.trunc(Number(row.serverVersion) / 10_000);
    requireGuard(postgresqlMajor === POSTGRESQL_MAJOR);

    const migrations = await client.$queryRaw<MigrationRow[]>`
      SELECT "migration_name" AS "migrationName", "finished_at" AS "finishedAt",
             "rolled_back_at" AS "rolledBackAt" FROM "_prisma_migrations"`;
    requireGuard(migrations.length === EXPECTED_MIGRATIONS.length);
    for (const name of EXPECTED_MIGRATIONS) {
      const matches = migrations.filter((entry) => entry.migrationName === name);
      requireGuard(matches.length === 1 && matches[0]!.finishedAt !== null && matches[0]!.rolledBackAt === null);
    }
    // Counts only; pre-existing vendor users and quota rows are allowed and
    // never read or deleted. Protocol fixture tables must start empty so global
    // counts cannot be polluted by an earlier run.
    const counts = await Promise.all([
      client.project.count(), client.revision.count(), client.projectHead.count(),
      client.upload.count(), client.device.count(), client.nativeDeviceGrant.count(),
      client.nativeAccessToken.count(), client.nativeRefreshToken.count(),
      client.nativePendingAuthorization.count(),
    ]);
    requireGuard(counts.every((count) => count === 0));
    return { postgresqlMajor, migrationCount: migrations.length };
  } catch (error) {
    if (error instanceof ProtocolValidationError) throw error;
    throw new ProtocolValidationError('database-guard-failed');
  }
}

async function seedFixtures(
  client: ProtocolPostgresValidationClient,
  ids: FixtureIDs,
): Promise<SeedContext> {
  const now = new Date();
  const future = addSeconds(now, 3_600);
  const oldAccessToken = randomCredential();
  const oldAccessFingerprint = fingerprint('access', oldAccessToken);
  const oldRefreshFingerprint = fingerprint('refresh', randomCredential());
  const sync = {
    userIDs: Object.values(ids.users), projectIDs: [
      ids.projects.revision, ids.projects.pagination, ids.projects.quota,
    ],
    grantIDs: [ids.grants.revisionA, ids.grants.revisionB, ids.grants.pagination,
      ids.grants.quota, ids.grants.rotation],
    /** All ready fixtures are direct ORM rows; the parent commit uses the repo. */
    uploadIDs: [ids.uploads.parent, ids.uploads.siblingA, ids.uploads.siblingB,
      ids.uploads.pageA, ids.uploads.pageB, ids.uploads.pageC],
  };

  try {
    await client.$transaction(async (tx) => {
      await tx.user.createMany({ data: sync.userIDs.map((id) => ({
        id, name: 'SessionPort synthetic protocol validation',
        email: `${randomUUID()}@test.example.invalid`, emailVerified: false,
        createdAt: now, updatedAt: now,
      })) });
      await tx.userQuota.createMany({ data: sync.userIDs.map((userID) => ({
        userID,
        limitBytes: userID === ids.users.quota ? QUOTA_LIMIT : GENERAL_QUOTA_LIMIT,
        usedBytes: userID === ids.users.revision ? UPLOAD_SIZE * 4n
          : userID === ids.users.pagination ? UPLOAD_SIZE * 3n : 0n,
        reservedBytes: 0n, updatedAt: now,
      })) });
      await tx.project.createMany({ data: [
        project(ids.projects.revision, ids.users.revision, 1n, now),
        project(ids.projects.pagination, ids.users.pagination, 9_007_199_254_740_995n, now),
        project(ids.projects.quota, ids.users.quota, 1n, now),
      ] });
      await tx.nativeDeviceGrant.createMany({ data: [
        grant(ids.grants.revisionA, ids.users.revision, now),
        grant(ids.grants.revisionB, ids.users.revision, now),
        grant(ids.grants.pagination, ids.users.pagination, now),
        grant(ids.grants.quota, ids.users.quota, now),
        grant(ids.grants.rotation, ids.users.rotation, now),
      ] });
      await tx.device.createMany({ data: [
        device(ids.devices.revisionA, ids.users.revision, ids.grants.revisionA, now),
        device(ids.devices.revisionB, ids.users.revision, ids.grants.revisionB, now),
        device(ids.devices.pagination, ids.users.pagination, ids.grants.pagination, now),
        device(ids.devices.quota, ids.users.quota, ids.grants.quota, now),
        device(ids.devices.rotation, ids.users.rotation, ids.grants.rotation, now),
      ] });
      await tx.upload.createMany({ data: [
        ready(ids.uploads.parent, ids.users.revision, ids.projects.revision,
          ids.devices.revisionA, ids.revisions.parent, null, ids.digests.upload, now),
        ready(ids.uploads.pageA, ids.users.pagination, ids.projects.pagination,
          ids.devices.pagination, ids.revisions.pageA, null, ids.digests.upload, now),
        ready(ids.uploads.pageB, ids.users.pagination, ids.projects.pagination,
          ids.devices.pagination, ids.revisions.pageB, null, ids.digests.upload, now),
        ready(ids.uploads.pageC, ids.users.pagination, ids.projects.pagination,
          ids.devices.pagination, ids.revisions.pageC, null, ids.digests.upload, now),
      ] });
      await tx.revision.createMany({ data: [
        revisionRow(ids.revisions.pageA, ids.projects.pagination, ids.users.pagination,
          null, 9_007_199_254_740_991n, ids.devices.pagination, ids.uploads.pageA,
          ids.digests.upload, now),
        revisionRow(ids.revisions.pageB, ids.projects.pagination, ids.users.pagination,
          null, 9_007_199_254_740_993n, ids.devices.pagination, ids.uploads.pageB,
          ids.digests.upload, now),
        revisionRow(ids.revisions.pageC, ids.projects.pagination, ids.users.pagination,
          null, 9_007_199_254_740_994n, ids.devices.pagination, ids.uploads.pageC,
          ids.digests.upload, now),
      ] });
      await tx.projectHead.create({ data: {
        projectID: ids.projects.pagination, revisionID: ids.revisions.pageC,
      } });
      await tx.nativeAccessToken.create({ data: {
        id: ids.access.rotationOldID, fingerprint: oldAccessFingerprint,
        grantID: ids.grants.rotation, createdAt: now, expiresAt: addSeconds(now, 600),
      } });
      await tx.nativeRefreshToken.create({ data: {
        id: ids.refresh.rotationOldID, fingerprint: oldRefreshFingerprint,
        grantID: ids.grants.rotation, createdAt: now, expiresAt: addSeconds(now, 1_800),
      } });
    }, BUDGET);

    const parent = await createRevisionRepository(client, { maxPageSize: 10 }).commit({
      userID: ids.users.revision, deviceID: ids.devices.revisionA,
      projectID: ids.projects.revision, revisionID: ids.revisions.parent,
      uploadID: ids.uploads.parent, parentRevisionID: null,
    });
    if (parent.statusCode !== 201 || parent.seq !== '1' ||
      parent.headIDs.length !== 1 || parent.headIDs[0] !== ids.revisions.parent.toLowerCase()) {
      throw new Error('parent commit fixture failed');
    }
    await client.$transaction(async (tx) => {
      await tx.upload.createMany({ data: [
        ready(ids.uploads.siblingA, ids.users.revision, ids.projects.revision,
          ids.devices.revisionA, ids.revisions.siblingA, ids.revisions.parent,
          ids.digests.upload, now),
        ready(ids.uploads.siblingB, ids.users.revision, ids.projects.revision,
          ids.devices.revisionB, ids.revisions.siblingB, ids.revisions.parent,
          ids.digests.upload, now),
      ] });
    }, BUDGET);

    const auth = createNativeAuthRepository(client, {
      maxOutstandingPendingAuthorizationsGlobal: 100,
      maxOutstandingPendingAuthorizationsPerUser: 10,
    });
    for (const pending of Object.values(ids.pendings)) {
      await auth.createPendingAuthorization({
        id: pending.id, deviceCodeFingerprint: pending.deviceCodeFingerprint,
        humanCodeDigest: pending.humanCodeDigest, humanCodeKeyID: pending.humanCodeKeyID,
        audience: AUTH_AUDIENCE, resource: AUTH_RESOURCE, scopes: [...AUTH_SCOPES],
        createdAt: now, expiresAt: future, pollIntervalSeconds: 5,
      });
    }
    for (const pending of [ids.pendings.exchangeA, ids.pendings.exchangeB]) {
      const decision = await auth.decidePendingAuthorization({
        candidates: [{ keyID: pending.humanCodeKeyID, digest: pending.humanCodeDigest }],
        decision: 'approve', userID: ids.users.exchange, at: now,
      });
      if (decision.kind !== 'approved') throw new Error('pending fixture approval failed');
    }

    const expected = [8, 8, 3, 5, 5, 6, 4, 2, 1, 1, 5];
    const actual = await Promise.all([
      client.user.count({ where: { id: { in: sync.userIDs } } }),
      client.userQuota.count({ where: { userID: { in: sync.userIDs } } }),
      client.project.count({ where: { projectID: { in: sync.projectIDs } } }),
      client.nativeDeviceGrant.count({ where: { userID: { in: sync.userIDs } } }),
      client.device.count({ where: { userID: { in: sync.userIDs } } }),
      client.upload.count({ where: { uploadID: { in: sync.uploadIDs } } }),
      client.revision.count({ where: { revisionID: { in: [
        ids.revisions.parent, ids.revisions.pageA, ids.revisions.pageB, ids.revisions.pageC,
      ] } } }),
      client.projectHead.count({ where: { projectID: { in: [
        ids.projects.revision, ids.projects.pagination,
      ] } } }),
      client.nativeAccessToken.count({ where: { grantID: ids.grants.rotation } }),
      client.nativeRefreshToken.count({ where: { grantID: ids.grants.rotation } }),
      client.nativePendingAuthorization.count({ where: { id: { in:
        Object.values(ids.pendings).map((entry) => entry.id) } } }),
    ]);
    if (actual.some((value, index) => value !== expected[index])) {
      throw new Error('seed verification failed');
    }
    return { ids, rotationOldAccessToken: oldAccessToken,
      rotationOldRefreshFingerprint: oldRefreshFingerprint };
  } catch (error) {
    if (error instanceof ProtocolValidationError) throw error;
    throw new ProtocolValidationError('seed-failed', userIDs(ids));
  }
}

async function runCases(
  client: ProtocolPostgresValidationClient,
  seed: SeedContext,
  record: (check: ProtocolValidationCheckName) => void,
): Promise<void> {
  const { ids } = seed;

  const projectCheck = 'project-create-cap-tenant-isolation';
  const projectRepo = createProjectRepository(client, { maxActiveProjects: 1 });
  const projects = await Promise.allSettled([
    projectRepo.createOrLink({ userID: ids.users.project, projectID: ids.projects.projectA }),
    projectRepo.createOrLink({ userID: ids.users.project, projectID: ids.projects.projectB }),
  ]);
  ensure(
    projects.filter((entry) => entry.status === 'fulfilled' &&
      entry.value.outcome === 'created').length === 1 &&
    projects.filter((entry) => entry.status === 'rejected' &&
      entry.reason instanceof ProjectRepositoryError &&
      entry.reason.code === 'active-project-limit-reached').length === 1 &&
    (await client.project.count({ where: {
      userID: ids.users.project, state: 'active',
    } })) === 1 &&
    (await projectRepo.listActive({ userID: ids.users.other })).length === 0,
    projectCheck,
  );
  record(projectCheck);

  const revisionCheck = 'revision-concurrent-siblings';
  const revisionRepo = createRevisionRepository(client, { maxPageSize: 10 });
  const quotaBefore = await readQuota(client, ids.users.revision);
  const commits = await Promise.allSettled([
    revisionRepo.commit({ userID: ids.users.revision, deviceID: ids.devices.revisionA,
      projectID: ids.projects.revision, revisionID: ids.revisions.siblingA,
      uploadID: ids.uploads.siblingA, parentRevisionID: ids.revisions.parent }),
    revisionRepo.commit({ userID: ids.users.revision, deviceID: ids.devices.revisionB,
      projectID: ids.projects.revision, revisionID: ids.revisions.siblingB,
      uploadID: ids.uploads.siblingB, parentRevisionID: ids.revisions.parent }),
  ]);
  const commitResults = commits.filter((entry) => entry.status === 'fulfilled')
    .map((entry) => entry.value);
  const seqs = commitResults.map((entry) => entry.seq).sort();
  const siblings = await client.revision.findMany({ where: { revisionID: { in: [
    ids.revisions.siblingA, ids.revisions.siblingB,
  ] } }, select: { parentRevisionID: true, seq: true } });
  const heads = [ids.revisions.siblingA, ids.revisions.siblingB].map((id) => id.toLowerCase()).sort();
  ensure(
    commitResults.length === 2 && commitResults.every((entry) => entry.statusCode === 201) &&
    commitResults.filter((entry) => entry.conflict).length === 1 &&
    seqs.join(',') === '2,3' &&
    siblingCommitHeadsValid(commitResults, heads) &&
    siblings.length === 2 && siblings.every((entry) =>
      entry.parentRevisionID === ids.revisions.parent && entry.seq > 1n) &&
    (await client.projectHead.count({ where: {
      projectID: ids.projects.revision, revisionID: ids.revisions.parent,
    } })) === 0 &&
    (await client.projectHead.count({ where: { projectID: ids.projects.revision } })) === 2 &&
    (await readNextSeq(client, ids.projects.revision)) === 4n &&
    sameQuota(await readQuota(client, ids.users.revision), quotaBefore),
    revisionCheck,
  );
  record(revisionCheck);

  const replayCheck = 'revision-idempotent-replay';
  const siblingASeq = commitResults.find((entry) =>
    entry.revisionID === ids.revisions.siblingA.toLowerCase())?.seq;
  const same = await revisionRepo.commit({ userID: ids.users.revision,
    deviceID: ids.devices.revisionA, projectID: ids.projects.revision,
    revisionID: ids.revisions.siblingA, uploadID: ids.uploads.siblingA,
    parentRevisionID: ids.revisions.parent });
  ensure(same.statusCode === 200 && same.seq === siblingASeq &&
    same.headIDs.length === 2 && same.headIDs[0] === heads[0] &&
    same.headIDs[1] === heads[1] &&
    (await readNextSeq(client, ids.projects.revision)) === 4n &&
    sameQuota(await readQuota(client, ids.users.revision), quotaBefore), replayCheck);
  await client.upload.update({ where: { uploadID: ids.uploads.siblingA },
    data: { state: 'expired' } });
  await client.upload.create({ data: ready(ids.uploads.replacement, ids.users.revision,
    ids.projects.revision, ids.devices.revisionA, ids.revisions.siblingA,
    ids.revisions.parent, ids.digests.upload, new Date()) });
  const replayed = await revisionRepo.commit({ userID: ids.users.revision,
    deviceID: ids.devices.revisionA, projectID: ids.projects.revision,
    revisionID: ids.revisions.siblingA, uploadID: ids.uploads.replacement,
    parentRevisionID: ids.revisions.parent });
  const original = await client.revision.findUnique({ where: {
    revisionID: ids.revisions.siblingA,
  }, select: { storageObjectKey: true } });
  ensure(replayed.statusCode === 200 && replayed.seq === siblingASeq &&
    replayed.headIDs.length === 2 && replayed.headIDs[0] === heads[0] &&
    replayed.headIDs[1] === heads[1] && same.seq === replayed.seq &&
    `validation/final/${ids.uploads.replacement}` !== original?.storageObjectKey &&
    (await readNextSeq(client, ids.projects.revision)) === 4n &&
    sameQuota(await readQuota(client, ids.users.revision), quotaBefore), replayCheck);
  record(replayCheck);

  const pageCheck = 'revision-page-upper-bound-live-heads';
  const pageArgs = { userID: ids.users.pagination, projectID: ids.projects.pagination };
  const firstPage = await revisionRepo.page({ ...pageArgs, after: '9007199254740990', limit: '3' });
  const boundedPage = await revisionRepo.page({ ...pageArgs, after: '9007199254740990',
    upperBound: '9007199254740991', limit: '1' });
  ensure(firstPage.upperBound === '9007199254740994' &&
    firstPage.revisions.map((entry) => entry.seq).join(',') ===
      '9007199254740991,9007199254740993,9007199254740994' &&
    firstPage.nextAfter === '9007199254740994' && firstPage.hasMore === false &&
    firstPage.currentHeadIDs.length === 1 &&
    firstPage.currentHeadIDs[0] === ids.revisions.pageC.toLowerCase() &&
    boundedPage.upperBound === '9007199254740991' &&
    boundedPage.revisions.length === 1 &&
    boundedPage.revisions[0]!.seq === '9007199254740991' &&
    boundedPage.currentHeadIDs.length === 1 &&
    boundedPage.currentHeadIDs[0] === ids.revisions.pageC.toLowerCase(), pageCheck);
  record(pageCheck);

  const pageZeroCheck = 'revision-page-limit-zero-tenant-not-found';
  const zeroPage = await revisionRepo.page({ ...pageArgs, after: '9007199254740990', limit: '0' });
  const emptyTail = await revisionRepo.page({ ...pageArgs, after: '9007199254740994', limit: '0' });
  let tenantRejected = false;
  try {
    await revisionRepo.page({ userID: ids.users.other, projectID: ids.projects.pagination,
      after: '0', limit: '10' });
  } catch (error) {
    tenantRejected = error instanceof RevisionRepositoryError && error.code === 'project-not-found';
  }
  ensure(zeroPage.revisions.length === 0 && zeroPage.hasMore === true &&
    zeroPage.nextAfter === null && emptyTail.revisions.length === 0 &&
    emptyTail.hasMore === false && tenantRejected, pageZeroCheck);
  record(pageZeroCheck);

  const quotaCheck = 'quota-reservation-race';
  const uploadRepo = createUploadRepository(client, { maxCiphertextBytes: QUOTA_LIMIT,
    reservationTTLSeconds: 300, graceTTLSeconds: 300, leaseTTLSeconds: 60 });
  const reservations = await Promise.allSettled([
    uploadRepo.reserve({ userID: ids.users.quota, deviceID: ids.devices.quota,
      projectID: ids.projects.quota, uploadID: ids.uploads.quotaA, revisionID: randomUUID(),
      keyEpoch: 1, sizeBytes: 600, ciphertextSha256: ids.digests.quota }),
    uploadRepo.reserve({ userID: ids.users.quota, deviceID: ids.devices.quota,
      projectID: ids.projects.quota, uploadID: ids.uploads.quotaB, revisionID: randomUUID(),
      keyEpoch: 1, sizeBytes: 600, ciphertextSha256: ids.digests.quota }),
  ]);
  const accepted = reservations.flatMap((entry) =>
    entry.status === 'fulfilled' && entry.value.idempotent === false ? [entry.value] : []);
  const rejected = reservations.filter((entry) => entry.status === 'rejected' &&
    entry.reason instanceof UploadRepositoryError &&
    entry.reason.code === 'storage-limit-reached' && entry.reason.statusCode === 413);
  const quota = await readQuota(client, ids.users.quota);
  const rows = await client.upload.findMany({ where: { userID: ids.users.quota },
    select: { sizeBytes: true, state: true } });
  ensure(accepted.length === 1 && rejected.length === 1 &&
    accepted[0]!.upload.state === 'uploading' &&
    [ids.uploads.quotaA, ids.uploads.quotaB].includes(accepted[0]!.upload.uploadID) &&
    quota?.limitBytes === QUOTA_LIMIT && quota.usedBytes === 0n &&
    quota.reservedBytes === 600n && rows.length === 1 && rows[0]!.state === 'uploading' &&
    rows[0]!.sizeBytes === quota.reservedBytes &&
    quota.usedBytes + quota.reservedBytes <= quota.limitBytes, quotaCheck);
  record(quotaCheck);

  const exchangeCheck = 'pending-exchange-atomic-active-grant-cap';
  const auth = createNativeAuthRepository(client, { maxOutstandingPendingAuthorizationsGlobal: 100,
    maxOutstandingPendingAuthorizationsPerUser: 10 });
  const exchangeNow = new Date();
  const descriptors = [
    { pending: ids.pendings.exchangeA, grantID: ids.grants.exchangeA,
      deviceID: ids.devices.exchangeA },
    { pending: ids.pendings.exchangeB, grantID: ids.grants.exchangeB,
      deviceID: ids.devices.exchangeB },
  ].map((entry) => ({ ...entry, accessID: randomUUID(), accessFingerprint: randomFingerprint(),
    refreshID: randomUUID(), refreshFingerprint: randomFingerprint() }));
  const exchangeQuota = await readQuota(client, ids.users.exchange);
  const exchanges = await Promise.allSettled(descriptors.map((entry) =>
    auth.exchangeDeviceCode({ deviceCodeFingerprint: entry.pending.deviceCodeFingerprint,
      now: exchangeNow, grantID: entry.grantID, deviceID: entry.deviceID,
      grantExpiresAt: addSeconds(exchangeNow, 3_600),
      access: { id: entry.accessID, fingerprint: entry.accessFingerprint,
        expiresAt: addSeconds(exchangeNow, 300) },
      refresh: { id: entry.refreshID, fingerprint: entry.refreshFingerprint,
        expiresAt: addSeconds(exchangeNow, 600) },
      polling: POLLING, maxActiveGrantsPerUser: 1 })));
  const outcomes = exchanges.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
  const tokenOutcome = outcomes.find((entry) => entry.kind === 'tokens');
  const winner = descriptors.find((entry) =>
    tokenOutcome?.kind === 'tokens' && tokenOutcome.grantID === entry.grantID);
  const pendingRows = await client.nativePendingAuthorization.findMany({ where: { id: { in: [
    ids.pendings.exchangeA.id, ids.pendings.exchangeB.id,
  ] } }, select: { id: true, status: true, approvedUserID: true, consumedAt: true,
    deviceCodeFingerprint: true } });
  const consumed = pendingRows.filter((entry) => entry.status === 'consumed');
  const approved = pendingRows.filter((entry) => entry.status === 'approved');
  ensure(outcomes.length === 2 && tokenOutcome !== undefined &&
    outcomes.some((entry) => entry.kind === 'active-grant-limit') && winner !== undefined &&
    (await client.nativeDeviceGrant.count({ where: { userID: ids.users.exchange } })) === 1 &&
    (await client.device.count({ where: { userID: ids.users.exchange } })) === 1 &&
    (await client.nativeAccessToken.count({ where: { grantID: winner.grantID } })) === 1 &&
    (await client.nativeRefreshToken.count({ where: { grantID: winner.grantID } })) === 1 &&
    (await client.nativeAccessToken.count({ where: { grantID: { in: [
      ids.grants.exchangeA, ids.grants.exchangeB,
    ] } } })) === 1 &&
    (await client.nativeRefreshToken.count({ where: { grantID: { in: [
      ids.grants.exchangeA, ids.grants.exchangeB,
    ] } } })) === 1 &&
    consumed.length === 1 && approved.length === 1 &&
    consumed[0]!.approvedUserID === ids.users.exchange &&
    consumed[0]!.consumedAt instanceof Date &&
    approved[0]!.approvedUserID === ids.users.exchange && approved[0]!.consumedAt === null &&
    sameQuota(await readQuota(client, ids.users.exchange), exchangeQuota), exchangeCheck);
  const retry = await auth.exchangeDeviceCode({
    deviceCodeFingerprint: consumed[0]!.deviceCodeFingerprint, now: exchangeNow,
    grantID: randomUUID(), deviceID: randomUUID(),
    grantExpiresAt: addSeconds(exchangeNow, 3_600),
    access: { id: randomUUID(), fingerprint: randomFingerprint(),
      expiresAt: addSeconds(exchangeNow, 300) },
    refresh: { id: randomUUID(), fingerprint: randomFingerprint(),
      expiresAt: addSeconds(exchangeNow, 600) },
    polling: POLLING, maxActiveGrantsPerUser: 1 });
  ensure(retry.kind === 'authorization-consumed' &&
    (await client.nativeDeviceGrant.count({ where: { userID: ids.users.exchange } })) === 1 &&
    (await client.nativeAccessToken.count({ where: { grantID: winner.grantID } })) === 1,
    exchangeCheck);
  record(exchangeCheck);

  const rotationCheck = 'refresh-rotation-concurrent-replay-revokes';
  const rotationRepo = createNativeAuthRepository(client,
    { maxOutstandingPendingAuthorizationsGlobal: 100,
      maxOutstandingPendingAuthorizationsPerUser: 10 });
  const rotationNow = new Date();
  const rotations: RotationDescriptor[] = [0, 1].map(() => {
    const accessToken = randomCredential();
    return { accessID: randomUUID(), accessFingerprint: fingerprint('access', accessToken),
      accessToken, refreshID: randomUUID(), refreshFingerprint: randomFingerprint() };
  });
  const rotationResults = await Promise.allSettled(rotations.map((entry) =>
    rotationRepo.rotateRefreshToken({ refreshTokenFingerprint: seed.rotationOldRefreshFingerprint,
      now: rotationNow, access: { id: entry.accessID, fingerprint: entry.accessFingerprint },
      refresh: { id: entry.refreshID, fingerprint: entry.refreshFingerprint },
      accessTokenTTLSeconds: 300, refreshTokenTTLSeconds: 600 })));
  const rotationOutcomes = rotationResults.filter((entry) => entry.status === 'fulfilled')
    .map((entry) => entry.value);
  const rotationGrant = await client.nativeDeviceGrant.findUnique({ where: {
    id: ids.grants.rotation,
  }, select: { status: true, expiresAt: true, revokedAt: true } });
  const refreshRows = await client.nativeRefreshToken.findMany({ where: {
    grantID: ids.grants.rotation,
  }, select: { id: true, fingerprint: true, expiresAt: true, spentAt: true, successorID: true } });
  const accessRows = await client.nativeAccessToken.findMany({ where: {
    grantID: ids.grants.rotation,
  }, select: { id: true, fingerprint: true, expiresAt: true } });
  const winning = rotations.find((entry) => refreshRows.some((row) => row.id === entry.refreshID));
  const oldRefresh = refreshRows.find((entry) => entry.id === ids.refresh.rotationOldID);
  const newRefresh = refreshRows.find((entry) => entry.id === winning?.refreshID);
  const oldAccess = accessRows.find((entry) => entry.id === ids.access.rotationOldID);
  const newAccess = accessRows.find((entry) => entry.id === winning?.accessID);
  const enforcement = createBearerEnforcement(client, { policy: AUTH_POLICY,
    now: () => rotationNow });
  let denied = 0;
  for (const raw of [seed.rotationOldAccessToken, rotations[0]!.accessToken,
    rotations[1]!.accessToken]) {
    const result = await enforcement.authorizeBearer({ authorization: `Bearer ${raw}` },
      'projects.create');
    if (!result.ok && result.code === 'unauthenticated') denied += 1;
  }
  ensure(rotationOutcomes.length === 2 &&
    rotationOutcomes.some((entry) => entry.kind === 'tokens') &&
    rotationOutcomes.some((entry) => entry.kind === 'replay') &&
    winning !== undefined && rotationGrant !== null && rotationGrant.status === 'revoked' &&
    rotationGrant.revokedAt instanceof Date && refreshRows.length === 2 &&
    accessRows.length === 2 && oldRefresh?.spentAt instanceof Date &&
    oldRefresh.successorID === winning.refreshID && newRefresh?.spentAt === null &&
    newRefresh.successorID === null && oldAccess !== undefined && newAccess !== undefined &&
    refreshRows.every((entry) => /^[0-9a-f]{64}$/.test(entry.fingerprint) &&
      entry.expiresAt.getTime() <= rotationGrant.expiresAt.getTime()) &&
    accessRows.every((entry) => /^[0-9a-f]{64}$/.test(entry.fingerprint) &&
      entry.expiresAt.getTime() <= rotationGrant.expiresAt.getTime()) && denied === 3,
    rotationCheck);
  record(rotationCheck);

  const approvalCheck = 'pending-approval-per-user-cap-isolation';
  const approvalRepo = createNativeAuthRepository(client,
    { maxOutstandingPendingAuthorizationsGlobal: 100,
      maxOutstandingPendingAuthorizationsPerUser: 1 });
  const approvalNow = new Date();
  const approvals = await Promise.allSettled([ids.pendings.approvalA, ids.pendings.approvalB]
    .map((pending) => approvalRepo.decidePendingAuthorization({
      candidates: [{ keyID: pending.humanCodeKeyID, digest: pending.humanCodeDigest }],
      decision: 'approve', userID: ids.users.approval, at: approvalNow })));
  const capacity = approvals.find((entry) => entry.status === 'rejected' &&
    entry.reason instanceof NativeAuthRepositoryError &&
    (entry.reason.code === 'capacity-reached' || entry.reason.code === 'serialization-failure'));
  const approvedCount = await client.nativePendingAuthorization.count({ where: {
    approvedUserID: ids.users.approval, status: 'approved', expiresAt: { gt: approvalNow },
  } });
  const pendingCount = await client.nativePendingAuthorization.count({ where: {
    approvedUserID: null, id: { in: [ids.pendings.approvalA.id, ids.pendings.approvalB.id] },
  } });
  const otherDecision = await approvalRepo.decidePendingAuthorization({
    candidates: [{ keyID: ids.pendings.other.humanCodeKeyID,
      digest: ids.pendings.other.humanCodeDigest }],
    decision: 'approve', userID: ids.users.other, at: approvalNow });
  const otherApproved = await client.nativePendingAuthorization.count({ where: {
    approvedUserID: ids.users.other, status: 'approved', expiresAt: { gt: approvalNow },
  } });
  const stillApproved = await client.nativePendingAuthorization.count({ where: {
    approvedUserID: ids.users.approval, status: 'approved', expiresAt: { gt: approvalNow },
  } });
  ensure(approvals.some((entry) => entry.status === 'fulfilled' &&
    entry.value.kind === 'approved') && capacity !== undefined &&
    approvedCount === 1 && pendingCount === 1 && otherDecision.kind === 'approved' &&
    otherApproved === 1 && stillApproved === 1, approvalCheck);
  record(approvalCheck);
}

function createFixtureIDs(): FixtureIDs {
  const pending = (): PendingFixture => ({ id: randomUUID(),
    deviceCodeFingerprint: randomFingerprint(), humanCodeDigest: randomBytes(32),
    humanCodeKeyID: 'validation-key' });
  return {
    users: { project: `${USER_PREFIX}project-${randomUUID()}`,
      revision: `${USER_PREFIX}revision-${randomUUID()}`,
      pagination: `${USER_PREFIX}pagination-${randomUUID()}`,
      quota: `${USER_PREFIX}quota-${randomUUID()}`,
      exchange: `${USER_PREFIX}exchange-${randomUUID()}`,
      rotation: `${USER_PREFIX}rotation-${randomUUID()}`,
      approval: `${USER_PREFIX}approval-${randomUUID()}`,
      other: `${USER_PREFIX}other-${randomUUID()}` },
    projects: { projectA: randomUUID(), projectB: randomUUID(),
      revision: randomUUID(), pagination: randomUUID(), quota: randomUUID() },
    grants: { revisionA: randomUUID(), revisionB: randomUUID(),
      pagination: randomUUID(), quota: randomUUID(), rotation: randomUUID(),
      exchangeA: randomUUID(), exchangeB: randomUUID() },
    devices: { revisionA: randomUUID(), revisionB: randomUUID(),
      pagination: randomUUID(), quota: randomUUID(), rotation: randomUUID(),
      exchangeA: randomUUID(), exchangeB: randomUUID() },
    revisions: { parent: randomUUID(), siblingA: randomUUID(), siblingB: randomUUID(),
      pageA: randomUUID(), pageB: randomUUID(), pageC: randomUUID() },
    uploads: { parent: randomUUID(), siblingA: randomUUID(), siblingB: randomUUID(),
      replacement: randomUUID(), pageA: randomUUID(), pageB: randomUUID(),
      pageC: randomUUID(), quotaA: randomUUID(), quotaB: randomUUID() },
    access: { rotationOldID: randomUUID() }, refresh: { rotationOldID: randomUUID() },
    pendings: { exchangeA: pending(), exchangeB: pending(), approvalA: pending(),
      approvalB: pending(), other: pending() },
    digests: { upload: randomBytes(32), quota: randomBytes(32) },
  };
}

function project(projectID: string, userID: string, nextSeq: bigint, now: Date) {
  return { projectID, userID, state: 'active' as const, nextSeq, createdAt: now };
}
function grant(id: string, userID: string, now: Date) {
  return { id, userID, status: 'active' as const, audience: AUTH_AUDIENCE,
    resource: AUTH_RESOURCE, scopes: [...AUTH_SCOPES], createdAt: now,
    expiresAt: addSeconds(now, 3_600) };
}
function device(id: string, userID: string, grantID: string, now: Date) {
  return { id, userID, grantID, createdAt: now };
}
function ready(uploadID: string, userID: string, projectID: string, deviceID: string,
  revisionID: string, parentRevisionID: string | null, digest: Uint8Array, now: Date) {
  return { uploadID, userID, projectID, deviceID, revisionID, parentRevisionID,
    keyEpoch: 1, stagingKey: `validation/staging/${uploadID}/${randomUUID()}`,
    finalKey: `validation/final/${uploadID}`, state: 'ready' as const,
    sizeBytes: UPLOAD_SIZE, ciphertextSha256: new Uint8Array(digest), leaseToken: 1n,
    leaseOwner: null, leaseExpiresAt: null, expiresAt: addSeconds(now, 3_600),
    graceExpiresAt: addSeconds(now, 3_600), createdAt: now, completedAt: now };
}
function revisionRow(revisionID: string, projectID: string, userID: string,
  parentRevisionID: string | null, seq: bigint, deviceID: string, uploadID: string,
  digest: Uint8Array, now: Date) {
  return { revisionID, projectID, userID, parentRevisionID, seq, deviceID, keyEpoch: 1,
    sizeBytes: UPLOAD_SIZE, ciphertextSha256: new Uint8Array(digest),
    storageObjectKey: `validation/final/${uploadID}`, createdAt: now };
}
function randomCredential(): string { return randomBytes(32).toString('base64url'); }
function randomFingerprint(): string { return randomBytes(32).toString('hex'); }
function fingerprint(kind: 'access' | 'refresh', token: string): string {
  return fingerprintCredential(kind, token);
}
function addSeconds(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1_000);
}
function userIDs(ids: FixtureIDs): readonly string[] {
  return Object.freeze(Object.values(ids.users));
}
function cleanupScope(ids: FixtureIDs): ProtocolCleanupScope {
  return Object.freeze({ userIDs: userIDs(ids),
    projectIDs: Object.freeze(Object.values(ids.projects)),
    revisionIDs: Object.freeze(Object.values(ids.revisions)),
    uploadIDs: Object.freeze(Object.values(ids.uploads)),
    grantIDs: Object.freeze(Object.values(ids.grants)),
    pendingIDs: Object.freeze(Object.values(ids.pendings).map((entry) => entry.id)) });
}
function requireCleanupScope(scope: ProtocolCleanupScope): void {
  const arrays = [scope.userIDs, scope.projectIDs, scope.revisionIDs,
    scope.uploadIDs, scope.grantIDs, scope.pendingIDs];
  if (arrays.some((values) => !Array.isArray(values) || values.length === 0 ||
    values.some((value) => typeof value !== 'string' || value.length === 0))) {
    throw new ProtocolValidationError('cleanup-failed', scope.userIDs);
  }
}
async function readQuota(client: ProtocolPostgresValidationClient,
  userID: string): Promise<QuotaSnapshot | null> {
  return client.userQuota.findUnique({ where: { userID },
    select: { limitBytes: true, usedBytes: true, reservedBytes: true } });
}
function sameQuota(current: QuotaSnapshot | null, baseline: QuotaSnapshot | null): boolean {
  return current !== null && baseline !== null && current.limitBytes === baseline.limitBytes &&
    current.usedBytes === baseline.usedBytes && current.reservedBytes === baseline.reservedBytes;
}
async function readNextSeq(client: ProtocolPostgresValidationClient,
  projectID: string): Promise<bigint> {
  const row = await client.project.findUnique({ where: { projectID }, select: { nextSeq: true } });
  if (row === null) throw new Error('project fixture missing');
  return row.nextSeq;
}
function requireGuard(condition: boolean): asserts condition {
  if (!condition) throw new ProtocolValidationError('database-guard-failed');
}
function ensure(condition: boolean, check: ProtocolValidationCheckName): asserts condition {
  if (!condition) throw new CaseFailure(check);
}
