import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMeRepository,
  MeRepositoryError,
  type MeRepositoryClient,
  type MeRepositoryErrorCode,
} from '../../src/me/repository.js';

/*
 * Focused read-model tests against a tiny structural Prisma fake. They prove
 * tenant scoping, explicit limits, grant-derived device counts, safe BigInt
 * conversion, and fixed error mapping. They do not touch PostgreSQL.
 */

const USER_ID = 'user_01HMEOPAQUE';
const OTHER_USER_ID = 'user_other_me_owner';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const LIMITS = {
  maxCiphertextBytes: 100 * 1024 * 1024,
  maxActiveDevices: 3,
  maxActiveProjects: 10,
} as const;

const EXPECTED: Readonly<
  Record<
    MeRepositoryErrorCode,
    { statusCode: number; retryable: boolean; message: string }
  >
> = {
  'invalid-me-input': {
    statusCode: 422,
    retryable: false,
    message: 'The usage query is invalid.',
  },
  'quota-not-provisioned': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota is not provisioned.',
  },
  'quota-invalid': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota is invalid.',
  },
  'repository-unavailable': {
    statusCode: 503,
    retryable: true,
    message: 'The usage repository is temporarily unavailable.',
  },
};

interface QuotaRow {
  limitBytes: bigint;
  usedBytes: bigint;
  reservedBytes: bigint;
}

interface CountArgs {
  where: Record<string, unknown>;
}

class FakeMePrisma {
  quota: QuotaRow | null = {
    limitBytes: 1_000n,
    usedBytes: 100n,
    reservedBytes: 50n,
  };
  activeProjects = 3;
  activeDevices = 2;

  readonly order: string[] = [];
  readonly quotaCalls: Array<{ where: { userID: string }; select: Record<string, true> }> = [];
  readonly projectCountCalls: CountArgs[] = [];
  readonly grantCountCalls: CountArgs[] = [];

  readonly userQuota = {
    findUnique: async (args: {
      where: { userID: string };
      select: Record<string, true>;
    }): Promise<QuotaRow | null> => {
      this.order.push('quota');
      this.quotaCalls.push(args);
      if (this.quotaError !== undefined) throw this.quotaError;
      return this.quota;
    },
  };

  readonly project = {
    count: async (args: CountArgs): Promise<number> => {
      this.order.push('projects');
      this.projectCountCalls.push(args);
      if (this.projectError !== undefined) throw this.projectError;
      return this.activeProjects;
    },
  };

  readonly nativeDeviceGrant = {
    count: async (args: CountArgs): Promise<number> => {
      this.order.push('grants');
      this.grantCountCalls.push(args);
      if (this.grantError !== undefined) throw this.grantError;
      return this.activeDevices;
    },
  };

  quotaError: unknown = undefined;
  projectError: unknown = undefined;
  grantError: unknown = undefined;
}

function client(fake: FakeMePrisma): MeRepositoryClient {
  return fake as unknown as MeRepositoryClient;
}

function repositoryFor(fake: FakeMePrisma) {
  return createMeRepository(client(fake), {
    ...LIMITS,
    now: () => new Date(NOW),
  });
}

function assertMeError(
  error: unknown,
  code: MeRepositoryErrorCode,
  secrets: readonly string[] = [],
): boolean {
  assert.ok(error instanceof MeRepositoryError);
  assert.equal(error.name, 'MeRepositoryError');
  assert.equal(error.code, code);
  assert.equal(error.statusCode, EXPECTED[code].statusCode);
  assert.equal(error.retryable, EXPECTED[code].retryable);
  assert.equal(error.message, EXPECTED[code].message);
  assert.equal(error.cause, undefined);
  const rendered = `${String(error)} ${error.stack ?? ''} ${JSON.stringify(error)}`;
  for (const secret of secrets) {
    assert.equal(rendered.includes(secret), false);
  }
  return true;
}

test('returns explicit limits, safe byte counters, and tenant-scoped counts', async () => {
  const fake = new FakeMePrisma();
  const result = await repositoryFor(fake).read(USER_ID);

  assert.deepEqual(fake.order, ['quota', 'projects', 'grants']);
  assert.deepEqual(fake.quotaCalls, [
    {
      where: { userID: USER_ID },
      select: {
        limitBytes: true,
        usedBytes: true,
        reservedBytes: true,
      },
    },
  ]);
  assert.deepEqual(fake.projectCountCalls, [
    { where: { userID: USER_ID, state: 'active' } },
  ]);
  assert.deepEqual(fake.grantCountCalls, [
    {
      where: {
        userID: USER_ID,
        status: 'active',
        expiresAt: { gt: NOW },
      },
    },
  ]);

  assert.deepEqual(result, {
    userID: USER_ID,
    limits: {
      storageLimitBytes: 1_000,
      storageUsedBytes: 100,
      storageReservedBytes: 50,
      maxCiphertextBytes: 104_857_600,
      maxActiveDevices: 3,
      maxActiveProjects: 10,
    },
    counts: {
      activeDevices: 2,
      activeProjects: 3,
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.limits), true);
  assert.equal(Object.isFrozen(result.counts), true);
});

test('fails closed with a fixed 500 when the quota row is missing or byte counters are unsafe', async () => {
  const missing = new FakeMePrisma();
  missing.quota = null;
  await assert.rejects(
    repositoryFor(missing).read(USER_ID),
    (error: unknown) => assertMeError(error, 'quota-not-provisioned'),
  );
  assert.deepEqual(missing.order, ['quota']);
  assert.equal(missing.projectCountCalls.length, 0);
  assert.equal(missing.grantCountCalls.length, 0);

  for (const quota of [
    { limitBytes: -1n, usedBytes: 0n, reservedBytes: 0n },
    { limitBytes: MAX_SAFE + 1n, usedBytes: 0n, reservedBytes: 0n },
    { limitBytes: 1_000n, usedBytes: -1n, reservedBytes: 0n },
    { limitBytes: 1_000n, usedBytes: 0n, reservedBytes: MAX_SAFE + 1n },
    { limitBytes: 100n, usedBytes: 100n, reservedBytes: 1n },
  ]) {
    const fake = new FakeMePrisma();
    fake.quota = quota;
    await assert.rejects(
      repositoryFor(fake).read(USER_ID),
      (error: unknown) => assertMeError(error, 'quota-invalid'),
    );
    assert.equal(fake.projectCountCalls.length, 0);
  }
});

test('requires all three explicit limits before touching the client', async () => {
  const invalidOptions: unknown[] = [
    undefined,
    null,
    {},
    [],
    { ...LIMITS, maxCiphertextBytes: 0 },
    { ...LIMITS, maxCiphertextBytes: -1 },
    { ...LIMITS, maxCiphertextBytes: 1.5 },
    { ...LIMITS, maxCiphertextBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...LIMITS, maxCiphertextBytes: '100' },
    { ...LIMITS, maxActiveDevices: 0 },
    { ...LIMITS, maxActiveDevices: undefined },
    { ...LIMITS, maxActiveProjects: 0 },
    { ...LIMITS, maxActiveProjects: null },
  ];

  for (const options of invalidOptions) {
    const fake = new FakeMePrisma();
    assert.throws(
      () =>
        createMeRepository(
          client(fake),
          options as never,
        ),
      (error: unknown) => assertMeError(error, 'invalid-me-input'),
    );
    assert.deepEqual(fake.order, []);
  }

  const invalidNow = new FakeMePrisma();
  assert.throws(
    () =>
      createMeRepository(client(invalidNow), {
        ...LIMITS,
        now: 'now',
      } as never),
    (error: unknown) => assertMeError(error, 'invalid-me-input'),
  );
  assert.deepEqual(invalidNow.order, []);
});

test('rejects malformed trusted user IDs before any client I/O', async () => {
  for (const userID of [
    undefined,
    null,
    '',
    '   ',
    'a'.repeat(1_025),
    `user\u0000secret`,
    7,
    new String(USER_ID),
  ]) {
    const fake = new FakeMePrisma();
    await assert.rejects(
      repositoryFor(fake).read(userID as never),
      (error: unknown) =>
        assertMeError(error, 'invalid-me-input', ['secret', USER_ID]),
    );
    assert.deepEqual(fake.order, []);
  }

  const opaque = new FakeMePrisma();
  const result = await repositoryFor(opaque).read('User_ABC.vendor/opaque:01');
  assert.equal(result.userID, 'User_ABC.vendor/opaque:01');
  assert.equal(opaque.quotaCalls[0]?.where.userID, 'User_ABC.vendor/opaque:01');
});

test('sanitises count and quota failures as a retryable 503 without leaking text or IDs', async () => {
  const secret = 'postgres://secret-user:secret-password@db/internal';

  for (const mutate of [
    (fake: FakeMePrisma) => {
      fake.quotaError = new Error(secret);
    },
    (fake: FakeMePrisma) => {
      fake.projectError = new Error(secret);
    },
    (fake: FakeMePrisma) => {
      fake.grantError = { code: 'XX000', message: secret };
    },
  ]) {
    const fake = new FakeMePrisma();
    mutate(fake);
    await assert.rejects(
      repositoryFor(fake).read(USER_ID),
      (error: unknown) =>
        assertMeError(error, 'repository-unavailable', [
          secret,
          USER_ID,
          OTHER_USER_ID,
        ]),
    );
  }
});

test('uses one injected clock value for the grant expiry filter', async () => {
  const fake = new FakeMePrisma();
  let calls = 0;
  const repository = createMeRepository(client(fake), {
    ...LIMITS,
    now: () => {
      calls += 1;
      return new Date(NOW);
    },
  });

  await repository.read(USER_ID);
  assert.equal(calls, 1);
  const filter = fake.grantCountCalls[0]?.where.expiresAt as {
    gt: Date;
  };
  assert.equal(filter.gt.toISOString(), NOW.toISOString());
});
