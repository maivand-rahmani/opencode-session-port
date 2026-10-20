import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNativeAuthRepository,
  NativeAuthRepositoryError,
  type HumanCodeCandidate,
  type NativeAuthRepositoryClient,
  type PendingAuthorizationRow,
} from '../../src/native-auth/repository.js';

/*
 * Focused repository tests against a small structural Prisma fake.
 *
 * They prove query shape, transaction options, lock/insert ordering, state
 * transitions, collision/serialization mapping, and post-commit outcome
 * semantics. They do NOT prove PostgreSQL locking, SERIALIZABLE predicate
 * behavior, FK enforcement, Prisma runtime binding, or concurrent execution.
 */

const USER_ID = 'user_01HTESTVENDOROPAQUE';
const OTHER_USER_ID = 'user_othersecretvalue';
const PENDING_ID = '5d4e8c2a-1b3f-4a6d-9e8c-0f1a2b3c4d5e';
const GRANT_ID = '7c1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const DEVICE_ID = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const ACCESS_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const REFRESH_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const NEW_REFRESH_ID = '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f';
const DIGEST = new Uint8Array(32).fill(7);
const OTHER_DIGEST = new Uint8Array(32).fill(9);
const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);
const NOW = new Date('2026-10-20T12:00:00.000Z');
const LATER = new Date('2026-10-20T13:00:00.000Z');

interface PendingRow extends PendingAuthorizationRow {
  approvedUserID: string | null;
  scopes: string[];
}

interface GrantRow {
  id: string;
  userID: string;
  status: 'active' | 'revoked';
  audience: string;
  resource: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  device?: DeviceRow | null;
}

interface DeviceRow {
  id: string;
  userID: string;
  grantID: string;
  createdAt: Date;
  lastSeenAt: Date | null;
}

interface AccessRow {
  id: string;
  fingerprint: string;
  grantID: string;
  createdAt: Date;
  expiresAt: Date;
}

interface RefreshRow {
  id: string;
  fingerprint: string;
  grantID: string;
  createdAt: Date;
  expiresAt: Date;
  spentAt: Date | null;
  successorID: string | null;
}

interface RawCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface FakeOptions {
  readonly pending?: PendingRow[];
  readonly grants?: GrantRow[];
  readonly devices?: DeviceRow[];
  readonly access?: AccessRow[];
  readonly refresh?: RefreshRow[];
  readonly users?: readonly string[];
  readonly quota?: readonly string[];
  readonly pendingCreateError?: unknown;
  readonly pendingUpdateError?: unknown;
  readonly pendingCount?: number;
  readonly serializeTransactions?: boolean;
}

class FakePrisma {
  readonly pending: PendingRow[];
  readonly grants: GrantRow[];
  readonly devices: DeviceRow[];
  readonly access: AccessRow[];
  readonly refresh: RefreshRow[];
  readonly users: Set<string>;
  readonly quota: Set<string>;
  readonly order: string[] = [];
  readonly rawCalls: RawCall[] = [];
  readonly transactionOptions: unknown[] = [];
  readonly pendingCreates: Array<Record<string, unknown>> = [];
  readonly grantCreates: Array<Record<string, unknown>> = [];
  readonly deviceCreates: Array<Record<string, unknown>> = [];
  readonly accessCreates: Array<Record<string, unknown>> = [];
  readonly refreshCreates: Array<Record<string, unknown>> = [];
  readonly pendingUpdates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  readonly grantUpdates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  readonly refreshUpdates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  readonly pendingCountCalls: unknown[] = [];

  readonly tx: Record<string, unknown>;
  readonly nativeDeviceGrant: { findMany(args: unknown): Promise<unknown> };
  readonly nativeRefreshToken: { findUnique(args: unknown): Promise<unknown> };

  private readonly options: FakeOptions;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: FakeOptions = {}) {
    this.options = options;
    this.pending = options.pending ?? [];
    this.grants = options.grants ?? [];
    this.devices = options.devices ?? [];
    this.access = options.access ?? [];
    this.refresh = options.refresh ?? [];
    this.users = new Set(options.users ?? [USER_ID]);
    this.quota = new Set(options.quota ?? [USER_ID]);

    const self = this;
    this.tx = {
      nativePendingAuthorization: {
        async count(args: { where: unknown }) {
          self.order.push('pending.count');
          self.pendingCountCalls.push(args);
          if (self.options.pendingCount !== undefined) {
            return self.options.pendingCount;
          }
          const where = args.where as {
            status?: { in?: string[] } | string;
            approvedUserID?: string;
            expiresAt?: { gt?: Date };
          };
          return self.pending.filter((row) => {
            const statusMatches =
              typeof where.status === 'string'
                ? row.status === where.status
                : (where.status?.in ?? []).includes(row.status);
            const userMatches =
              where.approvedUserID === undefined ||
              row.approvedUserID === where.approvedUserID;
            return (
              statusMatches &&
              userMatches &&
              (where.expiresAt?.gt === undefined ||
                row.expiresAt.getTime() > where.expiresAt.gt.getTime())
            );
          }).length;
        },
        async create(args: { data: Record<string, unknown> }) {
          self.order.push('pending.create');
          self.pendingCreates.push(args.data);
          if (self.options.pendingCreateError !== undefined) {
            throw self.options.pendingCreateError;
          }
          const row: PendingRow = {
            id: args.data.id as string,
            deviceCodeFingerprint: args.data.deviceCodeFingerprint as string,
            humanCodeDigest: args.data.humanCodeDigest as Uint8Array,
            humanCodeKeyID: args.data.humanCodeKeyID as string,
            status: 'pending',
            approvedUserID: null,
            audience: args.data.audience as string,
            resource: args.data.resource as string,
            scopes: [...(args.data.scopes as string[])],
            createdAt: args.data.createdAt as Date,
            expiresAt: args.data.expiresAt as Date,
            lastPolledAt: null,
            nextPollAt: null,
            pollIntervalSeconds: args.data.pollIntervalSeconds as number,
            consumedAt: null,
          };
          self.pending.push(row);
          return row;
        },
        async findUnique(args: {
          where:
            | {
                humanCodeKeyID_humanCodeDigest?: {
                  humanCodeKeyID: string;
                  humanCodeDigest: Uint8Array;
                };
              }
            | { id: string };
        }) {
          self.order.push('pending.findUnique');
          const id = (args.where as { id?: unknown }).id;
          if (typeof id === 'string') {
            return self.pending.find((row) => row.id === id) ?? null;
          }
          const compound = (
            args.where as {
              humanCodeKeyID_humanCodeDigest?: {
                humanCodeKeyID: string;
                humanCodeDigest: Uint8Array;
              };
            }
          ).humanCodeKeyID_humanCodeDigest;
          if (compound === undefined) return null;
          return (
            self.pending.find(
              (row) =>
                row.humanCodeKeyID === compound.humanCodeKeyID &&
                Buffer.from(row.humanCodeDigest).equals(
                  Buffer.from(compound.humanCodeDigest),
                ),
            ) ?? null
          );
        },
        async update(args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) {
          self.order.push('pending.update');
          self.pendingUpdates.push(args);
          if (self.options.pendingUpdateError !== undefined) {
            throw self.options.pendingUpdateError;
          }
          const row = self.pending.find((entry) => entry.id === args.where.id);
          if (row === undefined) throw new Error('missing pending row');
          Object.assign(row, args.data);
          return row;
        },
      },
      nativeDeviceGrant: {
        async count(args: { where: unknown }) {
          self.order.push('grant.count');
          const where = args.where as {
            userID?: string;
            status?: string;
            expiresAt?: { gt?: Date };
          };
          return self.grants.filter(
            (row) =>
              row.userID === where.userID &&
              row.status === where.status &&
              (where.expiresAt?.gt === undefined ||
                row.expiresAt.getTime() > where.expiresAt.gt.getTime()),
          ).length;
        },
        async create(args: { data: Record<string, unknown> }) {
          self.order.push('grant.create');
          self.grantCreates.push(args.data);
          const row: GrantRow = {
            id: args.data.id as string,
            userID: args.data.userID as string,
            status: 'active',
            audience: args.data.audience as string,
            resource: args.data.resource as string,
            scopes: [...(args.data.scopes as string[])],
            createdAt: args.data.createdAt as Date,
            expiresAt: args.data.expiresAt as Date,
            revokedAt: null,
            device: null,
          };
          self.grants.push(row);
          return row;
        },
        async update(args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) {
          self.order.push('grant.update');
          self.grantUpdates.push(args);
          const row = self.grants.find((entry) => entry.id === args.where.id);
          if (row === undefined) throw new Error('missing grant row');
          Object.assign(row, args.data);
          return row;
        },
      },
      nativeAccessToken: {
        async create(args: { data: Record<string, unknown> }) {
          self.order.push('access.create');
          self.accessCreates.push(args.data);
          self.access.push({
            id: args.data.id as string,
            fingerprint: args.data.fingerprint as string,
            grantID: args.data.grantID as string,
            createdAt: args.data.createdAt as Date,
            expiresAt: args.data.expiresAt as Date,
          });
        },
      },
      nativeRefreshToken: {
        async create(args: { data: Record<string, unknown> }) {
          self.order.push('refresh.create');
          self.refreshCreates.push(args.data);
          self.refresh.push({
            id: args.data.id as string,
            fingerprint: args.data.fingerprint as string,
            grantID: args.data.grantID as string,
            createdAt: args.data.createdAt as Date,
            expiresAt: args.data.expiresAt as Date,
            spentAt: null,
            successorID: null,
          });
        },
        async findUnique(args: { where: { fingerprint: string } }) {
          self.order.push('refresh.findUnique');
          return (
            self.refresh.find(
              (row) => row.fingerprint === args.where.fingerprint,
            ) ?? null
          );
        },
        async update(args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) {
          self.order.push('refresh.update');
          self.refreshUpdates.push(args);
          const row = self.refresh.find((entry) => entry.id === args.where.id);
          if (row === undefined) throw new Error('missing refresh row');
          Object.assign(row, args.data);
          return row;
        },
      },
      device: {
        async create(args: { data: Record<string, unknown> }) {
          self.order.push('device.create');
          self.deviceCreates.push(args.data);
          const row: DeviceRow = {
            id: args.data.id as string,
            userID: args.data.userID as string,
            grantID: args.data.grantID as string,
            createdAt: args.data.createdAt as Date,
            lastSeenAt: null,
          };
          self.devices.push(row);
          return row;
        },
        async findUnique(args: { where: { grantID: string } }) {
          self.order.push('device.findUnique');
          return (
            self.devices.find(
              (row) => row.grantID === args.where.grantID,
            ) ?? null
          );
        },
      },
      user: {
        async findUnique(args: { where: { id: string } }) {
          self.order.push('user.findUnique');
          return self.users.has(args.where.id) ? { id: args.where.id } : null;
        },
      },
      async $queryRaw<T>(
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<T> {
        const sql = strings.join('?');
        self.rawCalls.push({ sql, values });
        if (sql.includes('"NativePendingAuthorization"')) {
          self.order.push('raw.pending-lock');
          const row = sql.includes('"deviceCodeFingerprint"')
            ? self.pending.find(
                (entry) => entry.deviceCodeFingerprint === values[0],
              )
            : self.pending.find((entry) => entry.id === values[0]);
          return (row === undefined ? [] : [row]) as unknown as T;
        }
        if (sql.includes('"UserQuota"')) {
          self.order.push('raw.quota-lock');
          return (self.quota.has(values[0] as string)
            ? [{ userID: values[0] }]
            : []) as unknown as T;
        }
        if (sql.includes('"NativeDeviceGrant"')) {
          self.order.push('raw.grant-lock');
          const row = self.grants.find((entry) => entry.id === values[0]);
          return (row === undefined ? [] : [row]) as unknown as T;
        }
        if (sql.includes('"NativeRefreshToken"')) {
          self.order.push('raw.refresh-lock');
          const row = self.refresh.find(
            (entry) => entry.fingerprint === values[0],
          );
          return (row === undefined ? [] : [row]) as unknown as T;
        }
        throw new Error('unexpected raw SQL');
      },
    };

    this.nativeDeviceGrant = {
      findMany: async (args: unknown) => {
        self.order.push('grant.findMany');
        const where = (args as { where: { userID: string } }).where;
        return self.grants
          .filter((row) => row.userID === where.userID)
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime(),
          )
          .map((row) => ({
            id: row.id,
            status: row.status,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt,
            device:
              self.devices.find((device) => device.grantID === row.id) ?? null,
          }));
      },
    };

    this.nativeRefreshToken = {
      findUnique: async (args: unknown) => {
        self.order.push('refresh.preRead');
        const where = (args as { where: { fingerprint: string } }).where;
        return (
          self.refresh.find((row) => row.fingerprint === where.fingerprint) ??
          null
        );
      },
    };
  }

  async $transaction<T>(
    operation: (transaction: unknown) => Promise<T>,
    options?: unknown,
  ): Promise<T> {
    this.transactionOptions.push(options);
    this.order.push(`transaction.begin:${String((options as { isolationLevel?: string } | undefined)?.isolationLevel)}`);
    if (this.options.serializeTransactions === true) {
      const run = this.chain.then(() => operation(this.tx));
      this.chain = run.then(
        () => undefined,
        () => undefined,
      );
      const result = await run;
      this.order.push('transaction.commit');
      return result;
    }
    const result = await operation(this.tx);
    this.order.push('transaction.commit');
    return result;
  }
}

function repository(
  fake: FakePrisma,
  maxOutstanding = 10,
  maxPerUser = 10,
) {
  return createNativeAuthRepository(
    fake as unknown as NativeAuthRepositoryClient,
    {
      maxOutstandingPendingAuthorizationsGlobal: maxOutstanding,
      maxOutstandingPendingAuthorizationsPerUser: maxPerUser,
    },
  );
}

function candidate(
  keyID = 'key-1',
  digest: Uint8Array = DIGEST,
): HumanCodeCandidate {
  return { keyID, digest };
}

function pendingRow(
  overrides: Partial<PendingRow> = {},
): PendingRow {
  return {
    id: PENDING_ID,
    deviceCodeFingerprint: FINGERPRINT,
    humanCodeDigest: DIGEST,
    humanCodeKeyID: 'key-1',
    status: 'pending',
    approvedUserID: null,
    audience: 'https://api.example.test',
    resource: 'https://api.example.test',
    scopes: ['projects:read'],
    createdAt: NOW,
    expiresAt: LATER,
    lastPolledAt: null,
    nextPollAt: null,
    pollIntervalSeconds: 5,
    consumedAt: null,
    ...overrides,
  };
}

function grantRow(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: GRANT_ID,
    userID: USER_ID,
    status: 'active',
    audience: 'https://api.example.test',
    resource: 'https://api.example.test',
    scopes: ['projects:read'],
    createdAt: NOW,
    expiresAt: LATER,
    revokedAt: null,
    ...overrides,
  };
}

function deviceRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: DEVICE_ID,
    userID: USER_ID,
    grantID: GRANT_ID,
    createdAt: NOW,
    lastSeenAt: null,
    ...overrides,
  };
}

function refreshRow(overrides: Partial<RefreshRow> = {}): RefreshRow {
  return {
    id: REFRESH_ID,
    fingerprint: FINGERPRINT,
    grantID: GRANT_ID,
    createdAt: NOW,
    expiresAt: LATER,
    spentAt: null,
    successorID: null,
    ...overrides,
  };
}

function createInput() {
  return {
    id: PENDING_ID,
    deviceCodeFingerprint: FINGERPRINT,
    humanCodeDigest: DIGEST,
    humanCodeKeyID: 'key-1',
    audience: 'https://api.example.test',
    resource: 'https://api.example.test',
    scopes: ['projects:read'],
    createdAt: NOW,
    expiresAt: LATER,
    pollIntervalSeconds: 5,
  };
}

test('create uses SERIALIZABLE count-before-insert and enforces the explicit global cap', async () => {
  const atCap = new FakePrisma({
    pending: [
      pendingRow({ id: PENDING_ID }),
      pendingRow({ id: '11111111-1111-4111-8111-111111111111' }),
    ],
    pendingCount: 2,
  });
  await assert.rejects(
    repository(atCap, 2).createPendingAuthorization(createInput()),
    (error: unknown) =>
      error instanceof NativeAuthRepositoryError &&
      error.code === 'capacity-reached',
  );
  assert.deepEqual(atCap.transactionOptions, [
    { isolationLevel: 'Serializable' },
  ]);
  assert.deepEqual(
    atCap.order.filter((entry) => entry.startsWith('pending.')),
    ['pending.count'],
  );
  assert.equal(atCap.pendingCreates.length, 0);

  const allowed = new FakePrisma({ pendingCount: 1 });
  const created = await repository(allowed, 2).createPendingAuthorization(
    createInput(),
  );
  assert.equal(created.id, PENDING_ID);
  assert.deepEqual(
    allowed.order.filter((entry) => entry.startsWith('pending.')),
    ['pending.count', 'pending.create'],
  );
  assert.deepEqual(allowed.transactionOptions, [
    { isolationLevel: 'Serializable' },
  ]);
});

test('create maps only P2002 to a unique collision and P2034 to a serialization failure', async () => {
  const collision = new FakePrisma({
    pendingCreateError: Object.assign(new Error('secret driver text'), {
      code: 'P2002',
    }),
  });
  await assert.rejects(
    repository(collision).createPendingAuthorization(createInput()),
    (error: unknown) =>
      error instanceof NativeAuthRepositoryError &&
      error.code === 'unique-collision' &&
      !error.message.includes('secret'),
  );
  assert.equal(collision.pendingCreates.length, 1);

  const serialization = new FakePrisma({
    pendingCreateError: Object.assign(new Error('secret driver text'), {
      code: 'P2034',
    }),
  });
  await assert.rejects(
    repository(serialization).createPendingAuthorization(createInput()),
    (error: unknown) =>
      error instanceof NativeAuthRepositoryError &&
      error.code === 'serialization-failure',
  );
  assert.equal(serialization.pendingCreates.length, 1);
});

test('approve locks only the pending row, binds the supplied user once, and denial is terminal', async () => {
  const fake = new FakePrisma({ pending: [pendingRow()] });
  const repo = repository(fake);

  const approved = await repo.decidePendingAuthorization({
    candidates: [candidate()],
    decision: 'approve',
    userID: USER_ID,
    at: NOW,
  });
  assert.equal(approved.kind, 'approved');
  assert.deepEqual(
    fake.order.filter((entry) => entry.startsWith('raw.')),
    ['raw.pending-lock'],
  );
  assert.equal(fake.pendingUpdates[0]?.data.status, 'approved');
  assert.equal(fake.pendingUpdates[0]?.data.approvedUserID, USER_ID);
  assert.equal(fake.grantCreates.length, 0);
  assert.equal(fake.rawCalls.some((call) => call.sql.includes('UserQuota')), false);

  const second = await repo.decidePendingAuthorization({
    candidates: [candidate()],
    decision: 'approve',
    userID: OTHER_USER_ID,
    at: NOW,
  });
  assert.equal(second.kind, 'state-conflict');

  const deniedFake = new FakePrisma({ pending: [pendingRow()] });
  const denied = await repository(deniedFake).decidePendingAuthorization({
    candidates: [candidate()],
    decision: 'deny',
    at: NOW,
  });
  assert.equal(denied.kind, 'denied');
  assert.equal(deniedFake.pendingUpdates[0]?.data.status, 'denied');

  const terminal = await repository(deniedFake).decidePendingAuthorization({
    candidates: [candidate()],
    decision: 'approve',
    userID: USER_ID,
    at: NOW,
  });
  assert.equal(terminal.kind, 'state-conflict');
});

test('exchange follows pending -> quota -> grant/device/tokens -> consumed and returns tokens only after commit', async () => {
  const fake = new FakePrisma({
    pending: [
      pendingRow({
        status: 'approved',
        approvedUserID: USER_ID,
      }),
    ],
    quota: [USER_ID],
  });
  const repo = repository(fake);

  const outcome = await repo.exchangeDeviceCode({
    deviceCodeFingerprint: FINGERPRINT,
    now: NOW,
    grantID: GRANT_ID,
    deviceID: DEVICE_ID,
    grantExpiresAt: LATER,
    access: {
      id: ACCESS_ID,
      fingerprint: OTHER_FINGERPRINT,
      expiresAt: new Date('2026-10-20T12:10:00.000Z'),
    },
    refresh: {
      id: REFRESH_ID,
      fingerprint: 'c'.repeat(64),
      expiresAt: new Date('2026-10-20T12:30:00.000Z'),
    },
    polling: {
      intervalSeconds: 5,
      backoffIncrementSeconds: 5,
      maxIntervalSeconds: 30,
    },
    maxActiveGrantsPerUser: 3,
  });

  assert.equal(outcome.kind, 'tokens');
  assert.deepEqual(
    fake.order.filter((entry) =>
      [
        'raw.pending-lock',
        'raw.quota-lock',
        'grant.count',
        'grant.create',
        'device.create',
        'access.create',
        'refresh.create',
        'pending.update',
        'transaction.commit',
      ].includes(entry),
    ),
    [
      'raw.pending-lock',
      'raw.quota-lock',
      'grant.count',
      'grant.create',
      'device.create',
      'access.create',
      'refresh.create',
      'pending.update',
      'transaction.commit',
    ],
  );
  assert.equal(fake.transactionOptions[0] && (fake.transactionOptions[0] as { isolationLevel: string }).isolationLevel, 'ReadCommitted');
  assert.equal(fake.grantCreates[0]?.userID, USER_ID);
  assert.deepEqual(fake.grantCreates[0]?.scopes, ['projects:read']);
  assert.equal(fake.deviceCreates[0]?.grantID, GRANT_ID);
  assert.equal(fake.pendingUpdates[0]?.data.status, 'consumed');
  assert.equal(
    (fake.pendingUpdates[0]?.data.consumedAt as Date).getTime(),
    NOW.getTime(),
  );
  assert.equal(fake.pending.find((row) => row.id === PENDING_ID)?.status, 'consumed');
  assert.equal(fake.rawCalls.find((call) => call.sql.includes('UserQuota'))?.values[0], USER_ID);
});

test('exchange fails closed for missing quota and the active-grant cap', async () => {
  const missingQuota = new FakePrisma({
    pending: [pendingRow({ status: 'approved', approvedUserID: USER_ID })],
    quota: [],
  });
  const quotaOutcome = await repository(missingQuota).exchangeDeviceCode({
    deviceCodeFingerprint: FINGERPRINT,
    now: NOW,
    grantID: GRANT_ID,
    deviceID: DEVICE_ID,
    grantExpiresAt: LATER,
    access: { id: ACCESS_ID, fingerprint: OTHER_FINGERPRINT, expiresAt: LATER },
    refresh: { id: REFRESH_ID, fingerprint: 'c'.repeat(64), expiresAt: LATER },
    polling: { intervalSeconds: 5, backoffIncrementSeconds: 5, maxIntervalSeconds: 30 },
    maxActiveGrantsPerUser: 3,
  });
  assert.equal(quotaOutcome.kind, 'quota-not-provisioned');
  assert.equal(missingQuota.grantCreates.length, 0);

  const capped = new FakePrisma({
    pending: [pendingRow({ status: 'approved', approvedUserID: USER_ID })],
    quota: [USER_ID],
    grants: [grantRow()],
  });
  const cappedOutcome = await repository(capped).exchangeDeviceCode({
    deviceCodeFingerprint: FINGERPRINT,
    now: NOW,
    grantID: GRANT_ID,
    deviceID: DEVICE_ID,
    grantExpiresAt: LATER,
    access: { id: ACCESS_ID, fingerprint: OTHER_FINGERPRINT, expiresAt: LATER },
    refresh: { id: REFRESH_ID, fingerprint: 'c'.repeat(64), expiresAt: LATER },
    polling: { intervalSeconds: 5, backoffIncrementSeconds: 5, maxIntervalSeconds: 30 },
    maxActiveGrantsPerUser: 1,
  });
  assert.equal(cappedOutcome.kind, 'active-grant-limit');
  assert.equal(capped.grantCreates.length, 0);
});

test('pending poll commits clock/backoff before returning slow-down', async () => {
  const fake = new FakePrisma({
    pending: [
      pendingRow({
        nextPollAt: new Date('2026-10-20T12:00:10.000Z'),
        pollIntervalSeconds: 10,
      }),
    ],
  });
  const outcome = await repository(fake).exchangeDeviceCode({
    deviceCodeFingerprint: FINGERPRINT,
    now: NOW,
    grantID: GRANT_ID,
    deviceID: DEVICE_ID,
    grantExpiresAt: LATER,
    access: { id: ACCESS_ID, fingerprint: OTHER_FINGERPRINT, expiresAt: LATER },
    refresh: { id: REFRESH_ID, fingerprint: 'c'.repeat(64), expiresAt: LATER },
    polling: { intervalSeconds: 10, backoffIncrementSeconds: 5, maxIntervalSeconds: 30 },
    maxActiveGrantsPerUser: 3,
  });

  assert.deepEqual(outcome, { kind: 'slow-down', retryAfterSeconds: 15 });
  assert.equal(
    (fake.pendingUpdates[0]?.data.lastPolledAt as Date).getTime(),
    NOW.getTime(),
  );
  assert.equal(fake.pendingUpdates[0]?.data.pollIntervalSeconds, 15);
  assert.equal(
    (fake.pendingUpdates[0]?.data.nextPollAt as Date).toISOString(),
    '2026-10-20T12:00:15.000Z',
  );
  assert.equal(fake.order.at(-1), 'transaction.commit');
});

test('refresh replay commits grant revocation and returns replay instead of throwing', async () => {
  const fake = new FakePrisma({
    grants: [grantRow()],
    devices: [deviceRow()],
    refresh: [
      refreshRow({
        spentAt: NOW,
        successorID: NEW_REFRESH_ID,
      }),
    ],
  });

  const outcome = await repository(fake).rotateRefreshToken({
    refreshTokenFingerprint: FINGERPRINT,
    now: NOW,
    access: { id: ACCESS_ID, fingerprint: OTHER_FINGERPRINT },
    refresh: { id: NEW_REFRESH_ID, fingerprint: 'c'.repeat(64) },
    accessTokenTTLSeconds: 60,
    refreshTokenTTLSeconds: 600,
  });

  assert.deepEqual(outcome, { kind: 'replay' });
  assert.equal(fake.grantUpdates[0]?.data.status, 'revoked');
  assert.equal(
    (fake.grantUpdates[0]?.data.revokedAt as Date).getTime(),
    NOW.getTime(),
  );
  assert.equal(fake.grantCreates.length, 0);
  assert.equal(fake.order.at(-1), 'transaction.commit');
});

test('refresh rotation inserts the successor before spending the old row and clamps expiry to the grant', async () => {
  const fake = new FakePrisma({
    grants: [grantRow({ expiresAt: new Date('2026-10-20T12:00:30.000Z') })],
    devices: [deviceRow()],
    refresh: [
      refreshRow({ expiresAt: new Date('2026-10-20T12:00:30.000Z') }),
    ],
  });

  const outcome = await repository(fake).rotateRefreshToken({
    refreshTokenFingerprint: FINGERPRINT,
    now: NOW,
    access: { id: ACCESS_ID, fingerprint: OTHER_FINGERPRINT },
    refresh: { id: NEW_REFRESH_ID, fingerprint: 'c'.repeat(64) },
    accessTokenTTLSeconds: 600,
    refreshTokenTTLSeconds: 600,
  });

  assert.equal(outcome.kind, 'tokens');
  const newIndex = fake.order.indexOf('refresh.create');
  const updateIndex = fake.order.indexOf('refresh.update');
  assert.ok(newIndex >= 0 && updateIndex > newIndex);
  assert.equal(fake.refreshUpdates[0]?.data.successorID, NEW_REFRESH_ID);
  assert.equal(
    (fake.refreshUpdates[0]?.data.spentAt as Date).getTime(),
    NOW.getTime(),
  );
  assert.equal(
    (fake.refreshCreates[0]?.expiresAt as Date).toISOString(),
    '2026-10-20T12:00:30.000Z',
  );
  assert.equal(
    (fake.accessCreates[0]?.expiresAt as Date).toISOString(),
    '2026-10-20T12:00:30.000Z',
  );
  assert.equal(fake.refreshCreates[0]?.id, NEW_REFRESH_ID);
});

test('list and revoke are user-scoped; foreign/unknown grants share the same not-found outcome', async () => {
  const fake = new FakePrisma({
    grants: [
      grantRow(),
      grantRow({ id: '44444444-4444-4444-8444-444444444444', userID: OTHER_USER_ID }),
    ],
    devices: [deviceRow()],
  });
  const repo = repository(fake);

  const grants = await repo.listGrants(USER_ID);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.id, GRANT_ID);
  assert.equal(grants[0]?.deviceID, DEVICE_ID);
  assert.equal(fake.order.includes('grant.findMany'), true);

  const foreign = await repo.revokeGrant(USER_ID, '44444444-4444-4444-8444-444444444444', NOW);
  assert.deepEqual(foreign, { kind: 'not-found' });
  assert.equal(fake.grantUpdates.length, 0);

  const own = await repo.revokeGrant(USER_ID, GRANT_ID, NOW);
  assert.equal(own.kind, 'revoked');
  assert.equal(fake.grantUpdates[0]?.data.status, 'revoked');
  assert.equal(
    (fake.grantUpdates[0]?.data.revokedAt as Date).getTime(),
    NOW.getTime(),
  );
});

test('approval enforces the explicit per-user cap before the status update', async () => {
  const atCap = new FakePrisma({
    pending: [
      pendingRow(),
      pendingRow({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
        approvedUserID: USER_ID,
      }),
      pendingRow({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'approved',
        approvedUserID: USER_ID,
      }),
    ],
  });
  await assert.rejects(
    repository(atCap, 10, 2).decidePendingAuthorization({
      candidates: [candidate()],
      decision: 'approve',
      userID: USER_ID,
      at: NOW,
    }),
    (error: unknown) =>
      error instanceof NativeAuthRepositoryError &&
      error.code === 'capacity-reached',
  );
  assert.equal(atCap.pendingUpdates.length, 0);
  assert.deepEqual(atCap.transactionOptions, [
    { isolationLevel: 'Serializable' },
  ]);
  assert.deepEqual(
    atCap.order.filter((entry) => entry.startsWith('pending.')),
    ['pending.findUnique', 'pending.count'],
  );
  assert.deepEqual(atCap.pendingCountCalls[0], {
    where: {
      status: 'approved',
      approvedUserID: USER_ID,
      expiresAt: { gt: NOW },
    },
  });

  const belowCap = new FakePrisma({
    pending: [
      pendingRow(),
      pendingRow({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
        approvedUserID: USER_ID,
      }),
    ],
  });
  const approved = await repository(belowCap, 10, 2).decidePendingAuthorization({
    candidates: [candidate()],
    decision: 'approve',
    userID: USER_ID,
    at: NOW,
  });
  assert.equal(approved.kind, 'approved');
  assert.deepEqual(
    belowCap.order.filter((entry) => entry.startsWith('pending.')),
    ['pending.findUnique', 'pending.count', 'pending.update'],
  );
  assert.equal(belowCap.pendingUpdates[0]?.data.status, 'approved');
});

test('approval counts only unexpired approved rows for the same authoritative user', async () => {
  const fake = new FakePrisma({
    pending: [
      pendingRow(),
      pendingRow({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
        approvedUserID: USER_ID,
        expiresAt: NOW,
      }),
      pendingRow({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'consumed',
        approvedUserID: USER_ID,
      }),
      pendingRow({
        id: '33333333-3333-4333-8333-333333333333',
        status: 'denied',
        approvedUserID: USER_ID,
      }),
      pendingRow({
        id: '44444444-4444-4444-8444-444444444444',
        status: 'approved',
        approvedUserID: OTHER_USER_ID,
      }),
    ],
  });

  const approved = await repository(fake, 10, 1).decidePendingAuthorization({
    candidates: [candidate()],
    decision: 'approve',
    userID: USER_ID,
    at: NOW,
  });
  assert.equal(approved.kind, 'approved');
  assert.equal(fake.pendingUpdates.length, 1);
});

test('a different user is isolated from another user pending capacity', async () => {
  const fake = new FakePrisma({
    pending: [
      pendingRow(),
      pendingRow({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
        approvedUserID: USER_ID,
      }),
    ],
  });

  const approved = await repository(fake, 10, 1).decidePendingAuthorization({
    candidates: [candidate()],
    decision: 'approve',
    userID: OTHER_USER_ID,
    at: NOW,
  });
  assert.equal(approved.kind, 'approved');
  assert.equal(fake.pendingUpdates[0]?.data.approvedUserID, OTHER_USER_ID);
});

test('approval P2034 is a retryable serialization failure with no automatic retry', async () => {
  const fake = new FakePrisma({
    pending: [pendingRow()],
    pendingUpdateError: Object.assign(new Error('secret P2034 text'), {
      code: 'P2034',
    }),
  });

  await assert.rejects(
    repository(fake).decidePendingAuthorization({
      candidates: [candidate()],
      decision: 'approve',
      userID: USER_ID,
      at: NOW,
    }),
    (error: unknown) =>
      error instanceof NativeAuthRepositoryError &&
      error.code === 'serialization-failure' &&
      !error.message.includes('secret'),
  );
  assert.equal(fake.pendingUpdates.length, 1);
  assert.equal(fake.pending[0]?.status, 'pending');
  assert.deepEqual(fake.transactionOptions, [
    { isolationLevel: 'Serializable' },
  ]);
});

test('denial remains ReadCommitted and has no per-user capacity count', async () => {
  const fake = new FakePrisma({ pending: [pendingRow()] });
  const denied = await repository(fake, 10, 1).decidePendingAuthorization({
    candidates: [candidate()],
    decision: 'deny',
    at: NOW,
  });
  assert.equal(denied.kind, 'denied');
  assert.deepEqual(fake.transactionOptions, [
    { isolationLevel: 'ReadCommitted' },
  ]);
  assert.equal(fake.pendingCountCalls.length, 0);
  assert.equal(fake.pendingUpdates[0]?.data.status, 'denied');
});

test('synthetic concurrent approvals near the cap cannot both commit past the bound', async () => {
  const pendingB = '33333333-3333-4333-8333-333333333333';
  const fake = new FakePrisma({
    serializeTransactions: true,
    pending: [
      pendingRow({ id: PENDING_ID, humanCodeDigest: DIGEST }),
      pendingRow({
        id: pendingB,
        humanCodeKeyID: 'key-2',
        humanCodeDigest: OTHER_DIGEST,
      }),
      pendingRow({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
        approvedUserID: USER_ID,
      }),
    ],
  });
  const repo = repository(fake, 10, 2);

  const results = await Promise.allSettled([
    repo.decidePendingAuthorization({
      candidates: [candidate('key-1', DIGEST)],
      decision: 'approve',
      userID: USER_ID,
      at: NOW,
    }),
    repo.decidePendingAuthorization({
      candidates: [candidate('key-2', OTHER_DIGEST)],
      decision: 'approve',
      userID: USER_ID,
      at: NOW,
    }),
  ]);

  const fulfilled = results.filter(
    (result) => result.status === 'fulfilled',
  );
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]?.status === 'rejected' &&
      rejected[0].reason instanceof NativeAuthRepositoryError &&
      rejected[0].reason.code === 'capacity-reached',
  );

  const approvedCount = fake.pending.filter(
    (row) => row.status === 'approved' && row.approvedUserID === USER_ID,
  ).length;
  assert.ok(approvedCount <= 2, `approved count ${approvedCount}`);
  assert.deepEqual(
    fake.transactionOptions,
    [
      { isolationLevel: 'Serializable' },
      { isolationLevel: 'Serializable' },
    ],
  );
});

test('repository requires both explicit positive pending caps before use', async () => {
  const fake = new FakePrisma();
  for (const options of [
    undefined,
    null,
    {},
    { maxOutstandingPendingAuthorizationsGlobal: 1 },
    { maxOutstandingPendingAuthorizationsPerUser: 1 },
    {
      maxOutstandingPendingAuthorizationsGlobal: 1,
      maxOutstandingPendingAuthorizationsPerUser: 0,
    },
    {
      maxOutstandingPendingAuthorizationsGlobal: 1,
      maxOutstandingPendingAuthorizationsPerUser: 1.5,
    },
  ]) {
    assert.throws(
      () =>
        createNativeAuthRepository(
          fake as unknown as NativeAuthRepositoryClient,
          options as never,
        ),
      (error: unknown) =>
        error instanceof NativeAuthRepositoryError &&
        error.code === 'invalid-input',
    );
  }
  assert.deepEqual(fake.order, []);
});
