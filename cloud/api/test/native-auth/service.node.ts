import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrismaClient } from '../../prisma/generated/client/client.js';
import {
  NATIVE_VERIFICATION_PATH,
  type NativeAuthConfig,
} from '../../src/native-auth/config.js';
import { HumanCodeKeyRing } from '../../src/native-auth/human-codes.js';
import {
  fingerprintCredential,
} from '../../src/native-auth/credentials.js';
import {
  createNativeAuthService,
  NativeAuthServiceError,
  type NativeAuthServiceClient,
  type NativeAuthServiceOptions,
} from '../../src/native-auth/service.js';
import type {
  PendingAuthorizationRow,
} from '../../src/native-auth/repository.js';

/*
 * Focused service tests against a structural Prisma fake.
 *
 * Proven here: response DTOs, raw-token return timing, collision-retry
 * limits, state transitions, quota fail-closed behavior, poll/backoff
 * outcomes, and replay error timing. Not proven: PostgreSQL concurrency,
 * Prisma runtime behavior, HTTP, or browser sessions.
 */

const ORIGIN = 'https://api.example.test';
const USER_ID = 'user_01HTESTVENDOROPAQUE';
const OTHER_USER_ID = 'user_othersecretvalue';
const PENDING_ID = '5d4e8c2a-1b3f-4a6d-9e8c-0f1a2b3c4d5e';
const GRANT_ID = '7c1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const DEVICE_ID = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const ACCESS_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const REFRESH_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const NEW_ACCESS_ID = '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f';
const NEW_REFRESH_ID = '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f80';
const USER_CODE = '0123456789AB';
const OTHER_USER_CODE = '0123456789AC';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const LATER = new Date('2026-10-20T13:00:00.000Z');

const POLICY = {
  ttlSeconds: {
    pendingAuthorization: 300,
    accessToken: 60,
    refreshToken: 600,
    grant: 3_600,
  },
  polling: {
    intervalSeconds: 5,
    backoffIncrementSeconds: 5,
    maxIntervalSeconds: 30,
  },
  rateLimits: {
    createAuthorization: { windowSeconds: 60, maxRequests: 100 },
    browserVerification: { windowSeconds: 60, maxRequests: 100 },
    browserLookup: { windowSeconds: 60, maxRequests: 100 },
    approveAuthorization: { windowSeconds: 60, maxRequests: 100 },
    denyAuthorization: { windowSeconds: 60, maxRequests: 100 },
    exchangeDeviceCode: { windowSeconds: 60, maxRequests: 100 },
    refreshToken: { windowSeconds: 60, maxRequests: 100 },
    listGrants: { windowSeconds: 60, maxRequests: 100 },
    revokeGrant: { windowSeconds: 60, maxRequests: 100 },
  },
  capacity: {
    maxOutstandingPendingAuthorizationsPerUser: 2,
    maxActiveGrantsPerUser: 3,
    retentionSeconds: {
      pendingAuthorizationRecords: 86_400,
      spentTokenRecords: 86_400,
      revokedGrantRecords: 86_400,
    },
  },
  authorization: {
    audience: ORIGIN,
    resource: ORIGIN,
    allowedScopes: ['projects:read', 'projects:write'],
    requiredRouteScopes: {
      'projects.create': ['projects:write'],
    },
  },
} as const;

const CONFIG: NativeAuthConfig = {
  publicOrigin: ORIGIN,
  verificationUri: `${ORIGIN}${NATIVE_VERIFICATION_PATH}`,
  allowLoopbackHttp: false,
  betterAuth: {
    secret: 'synthetic-better-auth-secret-0123456789',
    github: {
      clientID: 'synthetic-github-client-id',
      clientSecret: 'synthetic-github-client-secret',
    },
  },
  humanCodes: {
    keys: [{ id: 'key-1', key: Buffer.alloc(32, 1) }],
    activeKeyID: 'key-1',
  },
  csrfKey: Buffer.alloc(32, 2),
  policy: POLICY,
};

const RING = new HumanCodeKeyRing(CONFIG.humanCodes, {
  pendingAuthorizationTTLSeconds: POLICY.ttlSeconds.pendingAuthorization,
  now: () => NOW,
});

const DIGEST = RING.digestForCreation(USER_CODE, NOW).digest;
const OTHER_DIGEST = RING.digestForCreation(OTHER_USER_CODE, NOW).digest;

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

interface FakeOptions {
  readonly pending?: PendingRow[];
  readonly grants?: GrantRow[];
  readonly devices?: DeviceRow[];
  readonly access?: AccessRow[];
  readonly refresh?: RefreshRow[];
  readonly users?: readonly string[];
  readonly quota?: readonly string[];
  readonly pendingCreateErrors?: unknown[];
  readonly pendingUpdateErrors?: unknown[];
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
  readonly transactionOptions: unknown[] = [];
  readonly pendingCreates: Array<Record<string, unknown>> = [];
  readonly grantCreates: Array<Record<string, unknown>> = [];
  readonly deviceCreates: Array<Record<string, unknown>> = [];
  readonly accessCreates: Array<Record<string, unknown>> = [];
  readonly refreshCreates: Array<Record<string, unknown>> = [];
  readonly pendingUpdates: Array<{ data: Record<string, unknown> }> = [];
  readonly grantUpdates: Array<{ data: Record<string, unknown> }> = [];
  readonly refreshUpdates: Array<{ data: Record<string, unknown> }> = [];
  readonly createErrors: unknown[];
  readonly updateErrors: unknown[];

  readonly tx: Record<string, unknown>;
  readonly nativePendingAuthorization: {
    findUnique(args: unknown): Promise<unknown>;
  };
  readonly nativeRefreshToken: { findUnique(args: unknown): Promise<unknown> };
  readonly nativeDeviceGrant: { findMany(args: unknown): Promise<unknown> };

  constructor(options: FakeOptions = {}) {
    this.pending = options.pending ?? [];
    this.grants = options.grants ?? [];
    this.devices = options.devices ?? [];
    this.access = options.access ?? [];
    this.refresh = options.refresh ?? [];
    this.users = new Set(options.users ?? [USER_ID, OTHER_USER_ID]);
    this.quota = new Set(options.quota ?? [USER_ID, OTHER_USER_ID]);
    this.createErrors = [...(options.pendingCreateErrors ?? [])];
    this.updateErrors = [...(options.pendingUpdateErrors ?? [])];

    const self = this;
    this.tx = {
      nativePendingAuthorization: {
        async count(args: { where?: unknown } = {}) {
          self.order.push('pending.count');
          const where = (args.where ?? {}) as {
            status?: { in?: string[] } | string;
            approvedUserID?: string;
            expiresAt?: { gt?: Date };
          };
          return self.pending.filter((row) => {
            const statusMatches =
              typeof where.status === 'string'
                ? row.status === where.status
                : (where.status?.in ?? ['pending', 'approved']).includes(
                    row.status,
                  );
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
          const error = self.createErrors.shift();
          if (error !== undefined) throw error;
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
        async update(args: { where: { id: string }; data: Record<string, unknown> }) {
          self.order.push('pending.update');
          self.pendingUpdates.push({ data: args.data });
          const updateError = self.updateErrors.shift();
          if (updateError !== undefined) {
            throw updateError;
          }
          const row = self.pending.find((entry) => entry.id === args.where.id);
          if (row === undefined) throw new Error('missing pending row');
          Object.assign(row, args.data);
          return row;
        },
      },
      nativeDeviceGrant: {
        async count(args: {
          where: { userID: string; status: string; expiresAt: { gt: Date } };
        }) {
          self.order.push('grant.count');
          return self.grants.filter(
            (row) =>
              row.userID === args.where.userID &&
              row.status === args.where.status &&
              row.expiresAt.getTime() > args.where.expiresAt.gt.getTime(),
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
          };
          self.grants.push(row);
          return row;
        },
        async update(args: { where: { id: string }; data: Record<string, unknown> }) {
          self.order.push('grant.update');
          self.grantUpdates.push({ data: args.data });
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
        async update(args: { where: { id: string }; data: Record<string, unknown> }) {
          self.order.push('refresh.update');
          self.refreshUpdates.push({ data: args.data });
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
          self.devices.push({
            id: args.data.id as string,
            userID: args.data.userID as string,
            grantID: args.data.grantID as string,
            createdAt: args.data.createdAt as Date,
            lastSeenAt: null,
          });
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

    this.nativePendingAuthorization = (
      this.tx as {
        nativePendingAuthorization: {
          findUnique(args: unknown): Promise<unknown>;
        };
      }
    ).nativePendingAuthorization;

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
  }

  async $transaction<T>(
    operation: (transaction: unknown) => Promise<T>,
    options?: unknown,
  ): Promise<T> {
    this.transactionOptions.push(options);
    this.order.push('transaction.begin');
    const result = await operation(this.tx);
    this.order.push('transaction.commit');
    return result;
  }
}

function serviceOptions(
  overrides: Partial<NativeAuthServiceOptions> = {},
): NativeAuthServiceOptions {
  return {
    config: CONFIG,
    repositoryPolicy: { maxOutstandingPendingAuthorizationsGlobal: 100 },
    now: () => NOW,
    ...overrides,
  };
}

function service(fake: FakePrisma, overrides: Partial<NativeAuthServiceOptions> = {}) {
  return createNativeAuthService(
    fake as unknown as NativeAuthServiceClient,
    serviceOptions(overrides),
  );
}

function pendingRow(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id: PENDING_ID,
    deviceCodeFingerprint: 'a'.repeat(64),
    humanCodeDigest: DIGEST,
    humanCodeKeyID: 'key-1',
    status: 'pending',
    approvedUserID: null,
    audience: ORIGIN,
    resource: ORIGIN,
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
    audience: ORIGIN,
    resource: ORIGIN,
    scopes: ['projects:read', 'projects:write'],
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
    fingerprint: 'c'.repeat(64),
    grantID: GRANT_ID,
    createdAt: NOW,
    expiresAt: LATER,
    spentAt: null,
    successorID: null,
    ...overrides,
  };
}

function credential(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64url');
}

function sequence<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error('test sequence exhausted');
    index += 1;
    return value;
  };
}

function generatedCredentials(
  values: readonly string[],
): (kind: 'device' | 'access' | 'refresh') => string {
  const next = sequence(values);
  return () => next();
}

function generatedIDs(values: readonly string[]): () => string {
  return sequence(values);
}

test('service requires an explicit global pending-cap repository policy', () => {
  assert.throws(
    () =>
      createNativeAuthService(
        new FakePrisma() as unknown as NativeAuthServiceClient,
        {
          config: CONFIG,
        } as never,
      ),
    /Invalid native-auth service options/,
  );
  assert.throws(
    () =>
      createNativeAuthService(
        new FakePrisma() as unknown as NativeAuthServiceClient,
        serviceOptions({
          repositoryPolicy: {
            maxOutstandingPendingAuthorizationsGlobal: 0,
          },
        }),
      ),
    /Invalid native-auth service options/,
  );
});

test('creation returns only approved wire fields, retries generated collisions, and persists digests', async () => {
  const fake = new FakePrisma({
    pendingCreateErrors: [
      Object.assign(new Error('secret'), { code: 'P2002' }),
      Object.assign(new Error('secret'), { code: 'P2002' }),
    ],
  });
  const codes = ['0123456789AB', '0123456789AC', '0123456789AD'];
  const deviceCodes = [credential(11), credential(12), credential(13)];
  const result = await service(fake, {
    generateHumanCode: sequence(codes),
    generateCredential: generatedCredentials(deviceCodes),
    generateID: generatedIDs([
      PENDING_ID,
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]),
  }).createDeviceAuthorization();

  assert.deepEqual(result, {
    deviceCode: deviceCodes[2],
    userCode: codes[2],
    verificationUri: CONFIG.verificationUri,
    expiresIn: 300,
    pollInterval: 5,
  });
  assert.equal(fake.pendingCreates.length, 3);
  assert.equal(
    fake.pendingCreates[2]?.deviceCodeFingerprint,
    fingerprintCredential('device', deviceCodes[2]!),
  );
  assert.equal(
    Buffer.from(
      fake.pendingCreates[2]?.humanCodeDigest as Uint8Array,
    ).toString('hex'),
    Buffer.from(RING.digestForCreation(codes[2]!, NOW).digest).toString('hex'),
  );
  assert.equal(fake.pendingCreates[2]?.audience, ORIGIN);
  assert.deepEqual(fake.pendingCreates[2]?.scopes, ['projects:read', 'projects:write']);
});

test('creation stops after eight collision retries and never retries other failures', async () => {
  const collisionFake = new FakePrisma({
    pendingCreateErrors: Array.from({ length: 9 }, () =>
      Object.assign(new Error('secret'), { code: 'P2002' }),
    ),
  });
  const codes = [
    '0123456789AB',
    '0123456789AC',
    '0123456789AD',
    '0123456789AE',
    '0123456789AF',
    '0123456789AG',
    '0123456789AH',
    '0123456789AJ',
    '0123456789AK',
  ];
  await assert.rejects(
    service(collisionFake, {
      generateHumanCode: sequence(codes),
      generateCredential: generatedCredentials(
        Array.from({ length: 9 }, (_, index) => credential(index + 1)),
      ),
      generateID: generatedIDs(Array.from({ length: 9 }, (_, index) =>
        `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      )),
    }).createDeviceAuthorization(),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'unavailable',
  );
  assert.equal(collisionFake.pendingCreates.length, 9);

  const serializationFake = new FakePrisma({
    pendingCreateErrors: [
      Object.assign(new Error('secret'), { code: 'P2034' }),
    ],
  });
  await assert.rejects(
    service(serializationFake, {
      generateHumanCode: sequence([USER_CODE]),
      generateCredential: generatedCredentials([credential(1)]),
      generateID: generatedIDs([PENDING_ID]),
    }).createDeviceAuthorization(),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'unavailable',
  );
  assert.equal(serializationFake.pendingCreates.length, 1);
});

test('full create -> verify -> approve -> exchange flow commits one grant and consumes the pending row', async () => {
  const fake = new FakePrisma();
  const deviceCode = credential(21);
  const accessToken = credential(22);
  const refreshToken = credential(23);
  const auth = service(fake, {
    generateHumanCode: sequence([USER_CODE]),
    generateCredential: generatedCredentials([
      deviceCode,
      accessToken,
      refreshToken,
    ]),
    generateID: generatedIDs([
      PENDING_ID,
      GRANT_ID,
      DEVICE_ID,
      ACCESS_ID,
      REFRESH_ID,
    ]),
  });

  const authorization = await auth.createDeviceAuthorization();
  assert.equal(authorization.userCode, USER_CODE);
  assert.equal(authorization.deviceCode, deviceCode);
  assert.equal(fake.pending.length, 1);
  assert.equal(fake.pending[0]?.status, 'pending');

  const consent = await auth.verifyUserCode(USER_CODE, {
    id: USER_ID,
    name: 'Test User',
    email: 'test@example.test',
  });
  assert.equal(consent.consent.account.id, USER_ID);
  assert.equal(fake.pending[0]?.status, 'pending');

  assert.deepEqual(await auth.approveUserCode(USER_CODE, USER_ID), {
    status: 'approved',
  });
  assert.equal(fake.pending[0]?.status, 'approved');
  assert.equal(fake.pending[0]?.approvedUserID, USER_ID);

  const tokens = await auth.exchangeDeviceCode(deviceCode);
  assert.equal(tokens.accessToken, accessToken);
  assert.equal(tokens.refreshToken, refreshToken);
  assert.equal(fake.pending[0]?.status, 'consumed');
  assert.equal(fake.grants[0]?.userID, USER_ID);
  assert.equal(fake.devices[0]?.grantID, GRANT_ID);
  assert.equal(
    fake.access[0]?.fingerprint,
    fingerprintCredential('access', accessToken),
  );
  assert.equal(
    fake.refresh[0]?.fingerprint,
    fingerprintCredential('refresh', refreshToken),
  );
});

test('repository failures are sanitized to a retryable service error', async () => {
  const brokenClient = {
    nativePendingAuthorization: {
      findUnique: async () => {
        throw new Error('driver detail with secret');
      },
    },
    nativeAccessToken: {
      findUnique: async () => null,
    },
  };
  const auth = createNativeAuthService(
    brokenClient as unknown as NativeAuthServiceClient,
    serviceOptions(),
  );
  await assert.rejects(
    auth.verifyUserCode(USER_CODE, {
      id: USER_ID,
      name: 'Test User',
      email: 'test@example.test',
    }),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'unavailable' &&
      error.statusCode === 503 &&
      !error.message.includes('secret'),
  );
});

test('verification returns an authoritative consent view only for pending unexpired rows', async () => {
  const fake = new FakePrisma({ pending: [pendingRow()] });
  const result = await service(fake).verifyUserCode(USER_CODE, {
    id: USER_ID,
    name: 'Test User',
    email: 'test@example.test',
  });

  assert.deepEqual(result, {
    consent: {
      account: {
        id: USER_ID,
        name: 'Test User',
        email: 'test@example.test',
      },
      scopes: ['projects:read'],
      expiresAt: LATER.toISOString(),
    },
  });

  await assert.rejects(
    service(fake).verifyUserCode(OTHER_USER_CODE, {
      id: USER_ID,
      name: 'Test User',
      email: 'test@example.test',
    }),
    (error: unknown) =>
      error instanceof NativeAuthServiceError && error.code === 'not-found',
  );

  const expired = new FakePrisma({
    pending: [pendingRow({ expiresAt: NOW })],
  });
  await assert.rejects(
    service(expired).verifyUserCode(USER_CODE, {
      id: USER_ID,
      name: 'Test User',
      email: 'test@example.test',
    }),
    (error: unknown) =>
      error instanceof NativeAuthServiceError && error.code === 'not-found',
  );

  const approved = new FakePrisma({
    pending: [pendingRow({ status: 'approved', approvedUserID: USER_ID })],
  });
  await assert.rejects(
    service(approved).verifyUserCode(USER_CODE, {
      id: USER_ID,
      name: 'Test User',
      email: 'test@example.test',
    }),
    (error: unknown) =>
      error instanceof NativeAuthServiceError && error.code === 'not-found',
  );
});

test('approval binds the supplied browser user once and denial is terminal', async () => {
  const fake = new FakePrisma({ pending: [pendingRow()] });
  const auth = service(fake);

  assert.deepEqual(
    await auth.approveUserCode(USER_CODE, USER_ID),
    { status: 'approved' },
  );
  assert.equal(fake.pending[0]?.approvedUserID, USER_ID);
  await assert.rejects(
    auth.approveUserCode(USER_CODE, OTHER_USER_ID),
    (error: unknown) =>
      error instanceof NativeAuthServiceError && error.code === 'state-conflict',
  );

  const denyFake = new FakePrisma({ pending: [pendingRow()] });
  const denied = await service(denyFake).denyUserCode(USER_CODE);
  assert.deepEqual(denied, { status: 'denied' });
  assert.equal(denyFake.pending[0]?.status, 'denied');
  await assert.rejects(
    service(denyFake).approveUserCode(USER_CODE, USER_ID),
    (error: unknown) =>
      error instanceof NativeAuthServiceError && error.code === 'state-conflict',
  );

  const expiredFake = new FakePrisma({
    pending: [pendingRow({ expiresAt: NOW })],
  });
  await assert.rejects(
    service(expiredFake).approveUserCode(USER_CODE, USER_ID),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'authorization-expired',
  );
});

test('exchange returns tokens for an approved pending row and persists only fingerprints', async () => {
  const deviceCode = credential(30);
  const pending = pendingRow({
    status: 'approved',
    approvedUserID: USER_ID,
    scopes: ['projects:read', 'projects:write'],
    deviceCodeFingerprint: fingerprintCredential('device', deviceCode),
  });
  const fake = new FakePrisma({ pending: [pending] });
  const accessToken = credential(31);
  const refreshToken = credential(32);

  const result = await service(fake, {
    generateCredential: generatedCredentials([accessToken, refreshToken]),
    generateID: generatedIDs([GRANT_ID, DEVICE_ID, ACCESS_ID, REFRESH_ID]),
  }).exchangeDeviceCode(deviceCode);

  assert.deepEqual(result, {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 60,
    refreshToken,
    scope: 'projects:read projects:write',
  });
  assert.equal(fake.grantCreates[0]?.userID, USER_ID);
  assert.deepEqual(fake.grantCreates[0]?.scopes, ['projects:read', 'projects:write']);
  assert.equal(fake.deviceCreates[0]?.grantID, GRANT_ID);
  assert.equal(
    fake.accessCreates[0]?.fingerprint,
    fingerprintCredential('access', accessToken),
  );
  assert.equal(
    fake.refreshCreates[0]?.fingerprint,
    fingerprintCredential('refresh', refreshToken),
  );
  assert.equal(fake.pending[0]?.status, 'consumed');
  assert.equal(fake.pending[0]?.consumedAt?.getTime(), NOW.getTime());
  assert.equal(JSON.stringify(fake.grantCreates).includes(accessToken), false);
  assert.equal(JSON.stringify(fake.refreshCreates).includes(refreshToken), false);
});

test('exchange maps pending, slow-down, denied, expired, consumed, quota, and cap outcomes', async () => {
  const deviceCode = credential(40);
  const fingerprint = fingerprintCredential('device', deviceCode);

  const pendingFake = new FakePrisma({
    pending: [
      pendingRow({ deviceCodeFingerprint: fingerprint, nextPollAt: null }),
    ],
  });
  await assert.rejects(
    service(pendingFake, {
      generateCredential: generatedCredentials([credential(41), credential(42)]),
      generateID: generatedIDs([GRANT_ID, DEVICE_ID, ACCESS_ID, REFRESH_ID]),
    }).exchangeDeviceCode(deviceCode),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'authorization-pending' &&
      error.retryAfterSeconds === 5,
  );
  assert.equal(pendingFake.pending[0]?.nextPollAt?.toISOString(), '2026-10-20T12:00:05.000Z');

  const slowFake = new FakePrisma({
    pending: [
      pendingRow({
        deviceCodeFingerprint: fingerprint,
        nextPollAt: new Date('2026-10-20T12:00:10.000Z'),
      }),
    ],
  });
  await assert.rejects(
    service(slowFake, {
      generateCredential: generatedCredentials([credential(41), credential(42)]),
      generateID: generatedIDs([GRANT_ID, DEVICE_ID, ACCESS_ID, REFRESH_ID]),
    }).exchangeDeviceCode(deviceCode),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'slow-down' &&
      error.retryAfterSeconds === 10,
  );

  for (const [status, code, expiresAt] of [
    ['denied', 'authorization-denied', LATER],
    ['consumed', 'authorization-consumed', NOW],
  ] as const) {
    const fake = new FakePrisma({
      pending: [
        pendingRow({ deviceCodeFingerprint: fingerprint, status, expiresAt }),
      ],
    });
    await assert.rejects(
      service(fake, {
        generateCredential: generatedCredentials([credential(41), credential(42)]),
        generateID: generatedIDs([GRANT_ID, DEVICE_ID, ACCESS_ID, REFRESH_ID]),
      }).exchangeDeviceCode(deviceCode),
      (error: unknown) =>
        error instanceof NativeAuthServiceError && error.code === code,
    );
  }

  const expiredFake = new FakePrisma({
    pending: [
      pendingRow({ deviceCodeFingerprint: fingerprint, expiresAt: NOW }),
    ],
  });
  await assert.rejects(
    service(expiredFake, {
      generateCredential: generatedCredentials([credential(41), credential(42)]),
      generateID: generatedIDs([GRANT_ID, DEVICE_ID, ACCESS_ID, REFRESH_ID]),
    }).exchangeDeviceCode(deviceCode),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'authorization-expired',
  );

  const quotaFake = new FakePrisma({
    pending: [
      pendingRow({
        deviceCodeFingerprint: fingerprint,
        status: 'approved',
        approvedUserID: USER_ID,
      }),
    ],
    quota: [],
  });
  await assert.rejects(
    service(quotaFake, {
      generateCredential: generatedCredentials([credential(41), credential(42)]),
      generateID: generatedIDs([GRANT_ID, DEVICE_ID, ACCESS_ID, REFRESH_ID]),
    }).exchangeDeviceCode(deviceCode),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'quota-not-provisioned',
  );

  const capFake = new FakePrisma({
    pending: [
      pendingRow({
        deviceCodeFingerprint: fingerprint,
        status: 'approved',
        approvedUserID: USER_ID,
      }),
    ],
    grants: [
      grantRow(),
      grantRow({ id: '66666666-6666-4666-8666-666666666666' }),
      grantRow({ id: '77777777-7777-4777-8777-777777777777' }),
    ],
  });
  await assert.rejects(
    service(capFake, {
      generateCredential: generatedCredentials([credential(41), credential(42)]),
      generateID: generatedIDs([GRANT_ID, DEVICE_ID, ACCESS_ID, REFRESH_ID]),
    }).exchangeDeviceCode(deviceCode),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'state-conflict',
  );
});

test('refresh rotates once and a spent-token replay throws only after committed revocation', async () => {
  const oldRefreshToken = credential(51);
  const newAccess = credential(52);
  const newRefresh = credential(53);

  const rotating = new FakePrisma({
    grants: [grantRow()],
    devices: [deviceRow()],
    refresh: [
      refreshRow({ fingerprint: fingerprintCredential('refresh', oldRefreshToken) }),
    ],
  });
  const rotated = await service(rotating, {
    generateCredential: generatedCredentials([newAccess, newRefresh]),
    generateID: generatedIDs([NEW_ACCESS_ID, NEW_REFRESH_ID]),
  }).refreshToken(oldRefreshToken);

  assert.deepEqual(rotated, {
    accessToken: newAccess,
    tokenType: 'Bearer',
    expiresIn: 60,
    refreshToken: newRefresh,
    scope: 'projects:read projects:write',
  });
  assert.equal(rotating.refreshUpdates[0]?.data.successorID, NEW_REFRESH_ID);
  assert.equal(
    (rotating.refreshUpdates[0]?.data.spentAt as Date).getTime(),
    NOW.getTime(),
  );
  assert.equal(rotating.refreshCreates[0]?.id, NEW_REFRESH_ID);

  const replaying = new FakePrisma({
    grants: [grantRow()],
    devices: [deviceRow()],
    refresh: [
      refreshRow({
        fingerprint: fingerprintCredential('refresh', oldRefreshToken),
        spentAt: NOW,
        successorID: NEW_REFRESH_ID,
      }),
    ],
  });
  await assert.rejects(
    service(replaying, {
      generateCredential: generatedCredentials([newAccess, newRefresh]),
      generateID: generatedIDs([NEW_ACCESS_ID, NEW_REFRESH_ID]),
    }).refreshToken(oldRefreshToken),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'refresh-replay',
  );
  assert.equal(replaying.grants[0]?.status, 'revoked');
  assert.equal(replaying.grants[0]?.revokedAt?.getTime(), NOW.getTime());
  assert.deepEqual(replaying.transactionOptions, [
    { isolationLevel: 'ReadCommitted' },
  ]);
  assert.equal(replaying.order.at(-1), 'transaction.commit');
});

test('refresh rejects revoked/expired grants, missing devices, and unknown credentials', async () => {
  const refreshToken = credential(61);
  const fingerprint = fingerprintCredential('refresh', refreshToken);

  for (const grant of [
    grantRow({ status: 'revoked', revokedAt: NOW }),
    grantRow({ expiresAt: NOW }),
  ]) {
    const fake = new FakePrisma({
      grants: [grant],
      devices: [deviceRow()],
      refresh: [refreshRow({ fingerprint })],
    });
    await assert.rejects(
      service(fake, {
        generateCredential: generatedCredentials([credential(62), credential(63)]),
        generateID: generatedIDs([NEW_ACCESS_ID, NEW_REFRESH_ID]),
      }).refreshToken(refreshToken),
      (error: unknown) =>
        error instanceof NativeAuthServiceError &&
        error.code === 'invalid-credential',
    );
  }

  const missingDevice = new FakePrisma({
    grants: [grantRow()],
    devices: [],
    refresh: [refreshRow({ fingerprint })],
  });
  await assert.rejects(
    service(missingDevice, {
      generateCredential: generatedCredentials([credential(62), credential(63)]),
      generateID: generatedIDs([NEW_ACCESS_ID, NEW_REFRESH_ID]),
    }).refreshToken(refreshToken),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'invalid-credential',
  );

  const unknown = new FakePrisma({});
  await assert.rejects(
    service(unknown, {
      generateCredential: generatedCredentials([credential(62), credential(63)]),
      generateID: generatedIDs([NEW_ACCESS_ID, NEW_REFRESH_ID]),
    }).refreshToken(refreshToken),
    (error: unknown) =>
      error instanceof NativeAuthServiceError &&
      error.code === 'invalid-credential',
  );
});

test('list grants maps only non-secret fields and revoke keeps foreign grants indistinguishable', async () => {
  const fake = new FakePrisma({
    grants: [
      grantRow({ revokedAt: NOW, status: 'revoked' }),
      grantRow({
        id: '55555555-5555-4555-8555-555555555555',
        userID: OTHER_USER_ID,
        createdAt: new Date('2026-10-19T00:00:00.000Z'),
      }),
    ],
    devices: [deviceRow()],
  });
  const auth = service(fake);

  const listed = await auth.listGrants(USER_ID);
  assert.deepEqual(listed.grants, [
    {
      id: GRANT_ID,
      deviceID: DEVICE_ID,
      createdAt: NOW.toISOString(),
      expiresAt: LATER.toISOString(),
      lastSeenAt: null,
      revokedAt: NOW.toISOString(),
      status: 'revoked',
    },
  ]);
  assert.equal(JSON.stringify(listed).includes('fingerprint'), false);

  await assert.rejects(
    auth.revokeGrant(USER_ID, '55555555-5555-4555-8555-555555555555'),
    (error: unknown) =>
      error instanceof NativeAuthServiceError && error.code === 'not-found',
  );
  await assert.rejects(
    auth.revokeGrant(USER_ID, 'not-a-uuid'),
    (error: unknown) =>
      error instanceof NativeAuthServiceError && error.code === 'not-found',
  );
  assert.deepEqual(await auth.revokeGrant(USER_ID, GRANT_ID), {
    status: 'revoked',
  });
});

test('bearer authorization is delegated per call with no service-level cache', async () => {
  const fake = new FakePrisma();
  let calls = 0;
  const fakeClient = {
    nativeAccessToken: {
      findUnique: async () => {
        calls += 1;
        return null;
      },
    },
  };
  const auth = createNativeAuthService(
    fakeClient as unknown as NativeAuthServiceClient,
    serviceOptions(),
  );
  const headers = { authorization: `Bearer ${credential(70)}` };
  assert.equal(calls, 0);
  const first = await auth.authorizeBearer(headers, 'projects.create');
  const second = await auth.authorizeBearer(headers, 'projects.create');
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(calls, 2);
  assert.equal(fake.pending.length, 0);
});

test('service enforces the configured per-user pending cap at approval', async () => {
  const fake = new FakePrisma({
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
  const auth = service(fake);

  await assert.rejects(
    auth.approveUserCode(USER_CODE, USER_ID),
    (error: unknown) => {
      assert.ok(error instanceof NativeAuthServiceError);
      assert.equal(error.code, 'rate-limited');
      assert.equal(error.statusCode, 429);
      assert.equal(error.retryable, true);
      assert.equal(
        error.retryAfterSeconds,
        CONFIG.policy.polling.intervalSeconds,
      );
      return true;
    },
  );
  assert.equal(fake.pendingUpdates.length, 0);
  assert.equal(fake.pending[0]?.status, 'pending');
  assert.equal(fake.pending[0]?.approvedUserID, null);

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
  assert.deepEqual(await service(belowCap).approveUserCode(USER_CODE, USER_ID), {
    status: 'approved',
  });
  assert.equal(belowCap.pending[0]?.status, 'approved');
});

test('service maps approval P2034 to retryable 503 without retrying', async () => {
  const fake = new FakePrisma({
    pending: [pendingRow()],
    pendingUpdateErrors: [
      Object.assign(new Error('serialization secret'), { code: 'P2034' }),
    ],
  });

  await assert.rejects(
    service(fake).approveUserCode(USER_CODE, USER_ID),
    (error: unknown) => {
      assert.ok(error instanceof NativeAuthServiceError);
      assert.equal(error.code, 'unavailable');
      assert.equal(error.statusCode, 503);
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes('serialization secret'));
      return true;
    },
  );
  assert.equal(fake.pendingUpdates.length, 1);
  assert.equal(fake.pending[0]?.status, 'pending');
});
