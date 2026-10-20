import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUploadRepository,
  UploadRepositoryError,
  type UploadRepositoryClient,
  type UploadRepositoryErrorCode,
  type UploadRepositoryPolicy,
  type VerifiedStorageObject,
} from '../../src/uploads/repository.js';

/*
 * Focused unit tests against a small stateful Prisma fake. They prove query
 * shape, lock order, idempotency, revision-intent reuse, lease fencing, exact
 * accounting updates, and fixed error mapping. The fake serialises interactive
 * transactions, so it can demonstrate a quota overbooking race is rejected; it
 * is NOT PostgreSQL concurrency, row-lock, isolation, or constraint proof.
 */

const USER_ID = 'user_01HUPLOADTESTOPAQUE';
const OTHER_USER_ID = 'user_other_upload_owner';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const UPLOAD_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_UPLOAD_ID = '55555555-5555-4555-8555-555555555555';
const REVISION_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_REVISION_ID = '77777777-7777-4777-8777-777777777777';
const PARENT_ID = '88888888-8888-4888-8888-888888888888';
const NONCE_ID = '99999999-9999-4999-8999-999999999999';
const GENERATED_OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const NOW_ISO = '2026-10-20T12:00:00.000Z';
const HASH = Uint8Array.from({ length: 32 }, (_, index) => index);
const OTHER_HASH = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const OWNER = 'lease-owner-trusted-1';

const POLICY: UploadRepositoryPolicy = {
  maxCiphertextBytes: 1_024,
  reservationTTLSeconds: 300,
  graceTTLSeconds: 86_400,
  leaseTTLSeconds: 60,
};

const EXPECTED: Readonly<
  Record<
    UploadRepositoryErrorCode,
    { statusCode: number; retryable: boolean; message: string }
  >
> = {
  'invalid-upload-input': {
    statusCode: 422,
    retryable: false,
    message: 'Upload repository input is invalid.',
  },
  'device-not-authorized': {
    statusCode: 403,
    retryable: false,
    message: 'The device is not authorized.',
  },
  'project-not-found': {
    statusCode: 404,
    retryable: false,
    message: 'The project was not found.',
  },
  'parent-revision-not-found': {
    statusCode: 422,
    retryable: false,
    message: 'The parent revision was not found.',
  },
  'revision-already-committed': {
    statusCode: 409,
    retryable: false,
    message: 'The revision is already committed.',
  },
  'upload-conflict': {
    statusCode: 409,
    retryable: false,
    message: 'The upload conflicts with an existing upload.',
  },
  'upload-not-found': {
    statusCode: 404,
    retryable: false,
    message: 'The upload was not found.',
  },
  'upload-expired': {
    statusCode: 410,
    retryable: false,
    message: 'The upload reservation has expired.',
  },
  'upload-state-conflict': {
    statusCode: 409,
    retryable: false,
    message: 'The upload is not in a valid state for this operation.',
  },
  'ciphertext-too-large': {
    statusCode: 422,
    retryable: false,
    message: 'The ciphertext size exceeds the configured limit.',
  },
  'storage-limit-reached': {
    statusCode: 413,
    retryable: false,
    message: 'The storage limit has been reached.',
  },
  'quota-not-provisioned': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota is not provisioned.',
  },
  'quota-invalid': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota accounting is invalid.',
  },
  'quota-underflow': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota accounting is inconsistent.',
  },
  'repository-unavailable': {
    statusCode: 503,
    retryable: true,
    message: 'The upload repository is temporarily unavailable.',
  },
};

interface UploadRow {
  uploadID: string;
  userID: string;
  projectID: string;
  deviceID: string;
  revisionID: string;
  parentRevisionID: string | null;
  keyEpoch: number;
  stagingKey: string;
  finalKey: string | null;
  state: 'uploading' | 'finalizing' | 'ready' | 'deleting' | 'deleted' | 'expired';
  sizeBytes: bigint;
  ciphertextSha256: Uint8Array;
  leaseToken: bigint;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  expiresAt: Date;
  graceExpiresAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
}

interface QuotaRow {
  userID: string;
  limitBytes: bigint;
  usedBytes: bigint;
  reservedBytes: bigint;
}

interface DeviceRow {
  id: string;
  userID: string;
  grant: { status: 'active' | 'revoked'; expiresAt: Date };
}

interface ProjectRow {
  projectID: string;
  userID: string;
  state: 'active' | 'purged';
}

interface RevisionRow {
  revisionID: string;
  projectID: string;
  userID: string;
}

interface UploadCreateArgs {
  data: Omit<UploadRow, 'createdAt'>;
  select: Record<string, boolean>;
}

interface UploadUpdateArgs {
  where: { uploadID: string };
  data: Partial<UploadRow>;
  select: Record<string, boolean>;
}

interface QuotaUpdateArgs {
  where: { userID: string };
  data: Record<string, unknown>;
  select: { userID: true };
}

interface FindArgs {
  where: Record<string, unknown>;
  select?: Record<string, boolean>;
}

type MutableUploadRow = UploadRow;

class FakeUploadPrisma {
  uploads = new Map<string, UploadRow>();
  quotaRows = new Map<string, QuotaRow>();
  devices = new Map<string, DeviceRow>();
  projects = new Map<string, ProjectRow>();
  revisions = new Map<string, RevisionRow>();

  readonly order: string[] = [];
  readonly rawCalls: Array<{ strings: string[]; values: unknown[]; sql: string }> = [];
  readonly uploadCreates: UploadCreateArgs[] = [];
  readonly uploadUpdates: UploadUpdateArgs[] = [];
  readonly quotaUpdates: QuotaUpdateArgs[] = [];
  readonly transactionOptions: unknown[] = [];

  createError: unknown = undefined;
  quotaUpdateError: unknown = undefined;

  private chain: Promise<unknown> = Promise.resolve();

  readonly upload = {
    findFirst: async (args: FindArgs): Promise<UploadRow | null> => {
      this.order.push('upload-find');
      return this.findUpload(args.where);
    },
    create: async (args: UploadCreateArgs): Promise<UploadRow> => {
      this.order.push('upload-create');
      this.uploadCreates.push(args);
      if (this.createError !== undefined) {
        throw this.createError;
      }
      const data = args.data;
      if (this.uploads.has(data.uploadID)) {
        throw p2002('duplicate upload id secret');
      }
      const conflict = [...this.uploads.values()].some(
        (row) =>
          row.userID === data.userID &&
          row.projectID === data.projectID &&
          row.revisionID === data.revisionID &&
          row.state !== 'expired' &&
          row.state !== 'deleted',
      );
      if (conflict) {
        throw p2002('duplicate active intent secret');
      }
      const row: UploadRow = {
        ...data,
        ciphertextSha256: new Uint8Array(data.ciphertextSha256),
        createdAt: NOW,
      };
      this.uploads.set(row.uploadID, row);
      return row;
    },
    update: async (args: UploadUpdateArgs): Promise<UploadRow> => {
      this.order.push('upload-update');
      this.uploadUpdates.push(args);
      const row = this.uploads.get(args.where.uploadID);
      if (row === undefined) {
        throw new Error('missing upload row');
      }
      const next: MutableUploadRow = { ...row };
      const data = args.data;
      if (data.state !== undefined) next.state = data.state;
      if (data.finalKey !== undefined) next.finalKey = data.finalKey;
      if (data.leaseToken !== undefined) next.leaseToken = data.leaseToken;
      if (data.leaseOwner !== undefined) next.leaseOwner = data.leaseOwner;
      if (data.leaseExpiresAt !== undefined) {
        next.leaseExpiresAt = data.leaseExpiresAt;
      }
      if (data.graceExpiresAt !== undefined) {
        next.graceExpiresAt = data.graceExpiresAt;
      }
      if (data.completedAt !== undefined) next.completedAt = data.completedAt;
      this.uploads.set(next.uploadID, next);
      return next;
    },
  };

  readonly project = {
    findFirst: async (args: FindArgs): Promise<ProjectRow | null> => {
      this.order.push('project-find');
      const where = args.where;
      const row = this.projects.get(String(where.projectID));
      if (row === undefined) return null;
      if (where.userID !== undefined && row.userID !== where.userID) return null;
      if (where.state !== undefined && row.state !== where.state) return null;
      return row;
    },
  };

  readonly revision = {
    findFirst: async (args: FindArgs): Promise<RevisionRow | null> => {
      this.order.push('revision-find');
      const where = args.where;
      const row = this.revisions.get(String(where.revisionID));
      if (row === undefined) return null;
      if (where.userID !== undefined && row.userID !== where.userID) return null;
      if (where.projectID !== undefined && row.projectID !== where.projectID) {
        return null;
      }
      return row;
    },
  };

  readonly device = {
    findFirst: async (args: FindArgs): Promise<DeviceRow | null> => {
      this.order.push('device-find');
      const where = args.where;
      const row = this.devices.get(String(where.id));
      if (row === undefined) return null;
      if (where.userID !== undefined && row.userID !== where.userID) return null;
      return row;
    },
  };

  readonly userQuota = {
    update: async (args: QuotaUpdateArgs): Promise<{ userID: string }> => {
      this.order.push('quota-update');
      this.quotaUpdates.push(args);
      if (this.quotaUpdateError !== undefined) {
        throw this.quotaUpdateError;
      }
      const row = this.quotaRows.get(args.where.userID);
      if (row === undefined) throw new Error('missing quota');
      const next = { ...row };
      for (const key of ['usedBytes', 'reservedBytes'] as const) {
        const operation = args.data[key] as
          | { increment?: bigint; decrement?: bigint }
          | undefined;
        if (operation?.increment !== undefined) {
          next[key] += operation.increment;
        }
        if (operation?.decrement !== undefined) {
          next[key] -= operation.decrement;
        }
      }
      this.quotaRows.set(args.where.userID, next);
      return { userID: args.where.userID };
    },
  };

  readonly tx = {
    upload: this.upload,
    project: this.project,
    revision: this.revision,
    device: this.device,
    userQuota: this.userQuota,
    $queryRaw: async <T>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T> => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      this.rawCalls.push({ strings: Array.from(strings), values, sql });
      if (sql.includes('"UserQuota"')) {
        this.order.push('quota-lock');
        const row = this.quotaRows.get(String(values[0]));
        return (row === undefined ? [] : [row]) as unknown as T;
      }
      if (sql.includes('"Upload"')) {
        this.order.push('upload-lock');
        const row = this.uploads.get(String(values[0]));
        if (row === undefined || row.userID !== values[1]) {
          return [] as unknown as T;
        }
        return [{ uploadID: row.uploadID }] as unknown as T;
      }
      throw new Error('unexpected raw SQL in fake');
    },
  };

  async $transaction<T>(
    operation: (transaction: typeof this.tx) => Promise<T>,
    options?: unknown,
  ): Promise<T> {
    this.transactionOptions.push(options);
    const run = this.chain.then(async () => {
      const uploadSnapshot = cloneUploads(this.uploads);
      const quotaSnapshot = cloneQuota(this.quotaRows);
      try {
        return await operation(this.tx);
      } catch (error) {
        // Minimal interactive-transaction rollback for the state we mutate.
        this.uploads = uploadSnapshot;
        this.quotaRows = quotaSnapshot;
        throw error;
      }
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private findUpload(where: Record<string, unknown>): UploadRow | null {
    for (const row of this.uploads.values()) {
      if (where.uploadID !== undefined && row.uploadID !== where.uploadID) {
        continue;
      }
      if (where.userID !== undefined && row.userID !== where.userID) continue;
      if (where.projectID !== undefined && row.projectID !== where.projectID) {
        continue;
      }
      if (where.revisionID !== undefined && row.revisionID !== where.revisionID) {
        continue;
      }
      const state = where.state as { in?: readonly string[] } | undefined;
      if (state?.in !== undefined && !state.in.includes(row.state)) continue;
      return row;
    }
    return null;
  }
}

function cloneUploads(source: Map<string, UploadRow>): Map<string, UploadRow> {
  return new Map(
    [...source].map(([key, row]) => [
      key,
      { ...row, ciphertextSha256: new Uint8Array(row.ciphertextSha256) },
    ]),
  );
}

function cloneQuota(source: Map<string, QuotaRow>): Map<string, QuotaRow> {
  return new Map([...source].map(([key, row]) => [key, { ...row }]));
}

function p2002(message: string): { code: string; message: string } {
  return { code: 'P2002', message };
}

function client(fake: FakeUploadPrisma): UploadRepositoryClient {
  return fake as unknown as UploadRepositoryClient;
}

function repositoryFor(
  fake: FakeUploadPrisma,
  policy: UploadRepositoryPolicy = POLICY,
  overrides: { now?: () => Date; createID?: () => string } = {},
) {
  return createUploadRepository(client(fake), policy, {
    now: overrides.now ?? (() => new Date(NOW)),
    createID: overrides.createID ?? (() => NONCE_ID),
  });
}

function seedQuota(
  fake: FakeUploadPrisma,
  overrides: Partial<QuotaRow> = {},
): QuotaRow {
  const row: QuotaRow = {
    userID: USER_ID,
    limitBytes: 1_000n,
    usedBytes: 100n,
    reservedBytes: 50n,
    ...overrides,
  };
  fake.quotaRows.set(row.userID, row);
  return row;
}

function seedDevice(
  fake: FakeUploadPrisma,
  overrides: Partial<Omit<DeviceRow, 'grant'>> & {
    grant?: Partial<DeviceRow['grant']>;
  } = {},
): DeviceRow {
  const { grant, ...rest } = overrides;
  const row: DeviceRow = {
    id: DEVICE_ID,
    userID: USER_ID,
    ...rest,
    grant: {
      status: 'active',
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      ...grant,
    },
  };
  fake.devices.set(row.id, row);
  return row;
}

function seedProject(
  fake: FakeUploadPrisma,
  overrides: Partial<ProjectRow> = {},
): ProjectRow {
  const row: ProjectRow = {
    projectID: PROJECT_ID,
    userID: USER_ID,
    state: 'active',
    ...overrides,
  };
  fake.projects.set(row.projectID, row);
  return row;
}

function seedRevision(
  fake: FakeUploadPrisma,
  overrides: Partial<RevisionRow> = {},
): RevisionRow {
  const row: RevisionRow = {
    revisionID: PARENT_ID,
    projectID: PROJECT_ID,
    userID: USER_ID,
    ...overrides,
  };
  fake.revisions.set(row.revisionID, row);
  return row;
}

function uploadRow(overrides: Partial<UploadRow> = {}): UploadRow {
  return {
    uploadID: UPLOAD_ID,
    userID: USER_ID,
    projectID: PROJECT_ID,
    deviceID: DEVICE_ID,
    revisionID: REVISION_ID,
    parentRevisionID: null,
    keyEpoch: 1,
    stagingKey: stagingKeyFor(USER_ID, UPLOAD_ID, NONCE_ID),
    finalKey: null,
    state: 'uploading',
    sizeBytes: 100n,
    ciphertextSha256: HASH,
    leaseToken: 0n,
    leaseOwner: null,
    leaseExpiresAt: null,
    expiresAt: new Date(NOW.getTime() + 300_000),
    graceExpiresAt: null,
    createdAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

function seedUpload(
  fake: FakeUploadPrisma,
  overrides: Partial<UploadRow> = {},
): UploadRow {
  const row = uploadRow(overrides);
  fake.uploads.set(row.uploadID, row);
  return row;
}

function stagingKeyFor(userID: string, uploadID: string, nonce: string): string {
  return `staging/v1/${Buffer.from(userID, 'utf8').toString('base64url')}/${uploadID}/${nonce}`;
}

function finalKeyFor(
  userID: string,
  uploadID: string,
  leaseToken: bigint,
): string {
  return `final/v1/${Buffer.from(userID, 'utf8').toString('base64url')}/${uploadID}/${leaseToken.toString(10)}`;
}

function verified(
  finalKey: string,
  sizeBytes: number | bigint = 100,
  hash: Uint8Array = HASH,
): VerifiedStorageObject {
  return {
    finalKey,
    sizeBytes,
    ciphertextSha256: hash,
  } as unknown as VerifiedStorageObject;
}

function reserveInput(overrides: Record<string, unknown> = {}) {
  return {
    userID: USER_ID,
    deviceID: DEVICE_ID,
    projectID: PROJECT_ID,
    uploadID: UPLOAD_ID,
    revisionID: REVISION_ID,
    parentRevisionID: null,
    keyEpoch: 1 as const,
    sizeBytes: 100,
    ciphertextSha256: HASH,
    ...overrides,
  };
}

function assertUploadError(
  error: unknown,
  code: UploadRepositoryErrorCode,
  secrets: readonly string[] = [],
): boolean {
  assert.ok(error instanceof UploadRepositoryError);
  assert.equal(error.name, 'UploadRepositoryError');
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

test('requires explicit positive policy TTLs, a safe max size, and valid dependencies', async () => {
  const invalidPolicies: unknown[] = [
    undefined,
    null,
    {},
    [],
    { ...POLICY, maxCiphertextBytes: 0 },
    { ...POLICY, maxCiphertextBytes: -1 },
    { ...POLICY, maxCiphertextBytes: 1.5 },
    { ...POLICY, maxCiphertextBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...POLICY, maxCiphertextBytes: '1024' },
    { ...POLICY, maxCiphertextBytes: 0n },
    { ...POLICY, maxCiphertextBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    { ...POLICY, reservationTTLSeconds: 0 },
    { ...POLICY, reservationTTLSeconds: -1 },
    { ...POLICY, reservationTTLSeconds: 1.5 },
    { ...POLICY, reservationTTLSeconds: Number.NaN },
    { ...POLICY, graceTTLSeconds: 0 },
    { ...POLICY, leaseTTLSeconds: 0 },
    { ...POLICY, leaseTTLSeconds: undefined },
  ];

  for (const policy of invalidPolicies) {
    const fake = new FakeUploadPrisma();
    assert.throws(
      () =>
        createUploadRepository(
          client(fake),
          policy as UploadRepositoryPolicy,
          { now: () => NOW, createID: () => NONCE_ID },
        ),
      (error: unknown) =>
        assertUploadError(error, 'invalid-upload-input', [
          'secret-policy-value',
        ]),
    );
    assert.deepEqual(fake.order, []);
  }

  for (const dependencies of [
    { now: 'now' },
    { createID: 'uuid' },
  ]) {
    const fake = new FakeUploadPrisma();
    assert.throws(
      () =>
        createUploadRepository(
          client(fake),
          POLICY,
          dependencies as never,
        ),
      (error: unknown) => assertUploadError(error, 'invalid-upload-input'),
    );
    assert.deepEqual(fake.order, []);
  }

  const invalidClock = new FakeUploadPrisma();
  seedQuota(invalidClock);
  seedDevice(invalidClock);
  seedProject(invalidClock);
  await assert.rejects(
    repositoryFor(invalidClock, POLICY, {
      now: () => new Date(Number.NaN),
    }).reserve(reserveInput()),
    (error: unknown) => assertUploadError(error, 'repository-unavailable'),
  );

  const valid = new FakeUploadPrisma();
  const repository = repositoryFor(valid);
  assert.equal(typeof repository.reserve, 'function');
  assert.deepEqual(valid.order, []);
});

test('reserves exact bytes, inserts uploading once, and increments reserved once', async () => {
  const fake = new FakeUploadPrisma();
  seedQuota(fake, { limitBytes: 1_000n, usedBytes: 100n, reservedBytes: 50n });
  seedDevice(fake);
  seedProject(fake);
  const repository = repositoryFor(fake);

  const result = await repository.reserve(reserveInput());

  assert.deepEqual(fake.order, [
    'upload-find',
    'quota-lock',
    'upload-find',
    'device-find',
    'project-find',
    'upload-find',
    'revision-find',
    'upload-create',
    'quota-update',
  ]);
  assert.deepEqual(fake.transactionOptions, [
    { isolationLevel: 'ReadCommitted' },
  ]);

  assert.equal(fake.uploadCreates.length, 1);
  const data = fake.uploadCreates[0]?.data;
  assert.ok(data !== undefined);
  assert.deepEqual(Object.keys(data).sort(), [
    'ciphertextSha256',
    'completedAt',
    'deviceID',
    'expiresAt',
    'finalKey',
    'graceExpiresAt',
    'keyEpoch',
    'leaseExpiresAt',
    'leaseOwner',
    'leaseToken',
    'parentRevisionID',
    'projectID',
    'revisionID',
    'sizeBytes',
    'stagingKey',
    'state',
    'uploadID',
    'userID',
  ]);
  for (const forbidden of ['payload', 'plaintext', 'body', 'label']) {
    assert.equal(Object.prototype.hasOwnProperty.call(data, forbidden), false);
  }
  assert.equal(data.uploadID, UPLOAD_ID);
  assert.equal(data.userID, USER_ID);
  assert.equal(data.state, 'uploading');
  assert.equal(data.sizeBytes, 100n);
  assert.equal(data.leaseToken, 0n);
  assert.equal(data.finalKey, null);
  assert.equal(data.leaseOwner, null);
  assert.equal(data.leaseExpiresAt, null);
  assert.equal(data.expiresAt.toISOString(), '2026-10-20T12:05:00.000Z');
  assert.equal(
    data.stagingKey,
    stagingKeyFor(USER_ID, UPLOAD_ID, NONCE_ID),
  );
  assert.notStrictEqual(data.ciphertextSha256, HASH);
  assert.deepEqual(data.ciphertextSha256, HASH);

  assert.deepEqual(fake.quotaUpdates, [
    {
      where: { userID: USER_ID },
      data: { reservedBytes: { increment: 100n } },
      select: { userID: true },
    },
  ]);

  assert.equal(result.idempotent, false);
  assert.equal(result.upload.uploadID, UPLOAD_ID);
  assert.equal(result.upload.state, 'uploading');
  assert.equal(result.upload.sizeBytes, 100n);
  assert.equal(result.upload.leaseToken, 0n);
  assert.equal(result.upload.expiresAt, '2026-10-20T12:05:00.000Z');
  assert.equal(result.upload.createdAt, NOW_ISO);
  assert.notStrictEqual(result.upload.ciphertextSha256, HASH);
  result.upload.ciphertextSha256.fill(0);
  assert.deepEqual(HASH, Uint8Array.from({ length: 32 }, (_, index) => index));
});

test('returns an existing uploadID idempotently before quota and rejects differences', async () => {
  const fake = new FakeUploadPrisma();
  seedUpload(fake);
  const repository = repositoryFor(fake);

  const replay = await repository.reserve(reserveInput());
  assert.equal(replay.idempotent, true);
  assert.equal(replay.upload.state, 'uploading');
  assert.deepEqual(fake.order, ['upload-find']);
  assert.equal(fake.quotaUpdates.length, 0);

  for (const input of [
    reserveInput({ ciphertextSha256: OTHER_HASH }),
    reserveInput({ sizeBytes: 101 }),
    reserveInput({ deviceID: OTHER_UPLOAD_ID }),
    reserveInput({ parentRevisionID: PARENT_ID }),
    reserveInput({ projectID: OTHER_PROJECT_ID }),
  ]) {
    const conflictFake = new FakeUploadPrisma();
    seedUpload(conflictFake);
    await assert.rejects(
      repositoryFor(conflictFake).reserve(input),
      (error: unknown) =>
        assertUploadError(error, 'upload-conflict', [
          USER_ID,
          UPLOAD_ID,
          String(input.ciphertextSha256),
        ]),
    );
    assert.deepEqual(conflictFake.order, ['upload-find']);
    assert.equal(conflictFake.quotaUpdates.length, 0);
  }
});

test('reuses a matching active revision intent without charging twice', async () => {
  const fake = new FakeUploadPrisma();
  seedQuota(fake);
  seedDevice(fake);
  seedProject(fake);
  seedUpload(fake, {
    uploadID: OTHER_UPLOAD_ID,
    state: 'finalizing',
  });
  // A committed revision with a matching reusable upload still replays before
  // the committed-revision conflict check.
  seedRevision(fake, { revisionID: REVISION_ID });
  const repository = repositoryFor(fake);

  const result = await repository.reserve(reserveInput());

  assert.equal(result.idempotent, true);
  assert.equal(result.upload.uploadID, OTHER_UPLOAD_ID);
  assert.equal(result.upload.state, 'finalizing');
  assert.equal(fake.uploadCreates.length, 0);
  assert.equal(fake.quotaUpdates.length, 0);

  const conflictFake = new FakeUploadPrisma();
  seedQuota(conflictFake);
  seedDevice(conflictFake);
  seedProject(conflictFake);
  seedUpload(conflictFake, {
    uploadID: OTHER_UPLOAD_ID,
    sizeBytes: 999n,
  });
  await assert.rejects(
    repositoryFor(conflictFake).reserve(reserveInput()),
    (error: unknown) => assertUploadError(error, 'upload-conflict'),
  );
  assert.equal(conflictFake.uploadCreates.length, 0);
  assert.equal(conflictFake.quotaUpdates.length, 0);
});

test('rejects invalid input before any client I/O', async () => {
  const invalidInputs: unknown[] = [
    undefined,
    null,
    [],
    {},
    reserveInput({ userID: '' }),
    reserveInput({ userID: `user\u0000secret` }),
    reserveInput({ userID: 7 }),
    reserveInput({ userID: 'a'.repeat(1_025) }),
    reserveInput({ deviceID: 'not-a-uuid' }),
    reserveInput({ deviceID: DEVICE_ID.toUpperCase() + '0' }),
    reserveInput({ projectID: 7 }),
    reserveInput({ uploadID: UPLOAD_ID.replaceAll('-', '') }),
    reserveInput({ revisionID: `${REVISION_ID}0` }),
    reserveInput({ parentRevisionID: 'parent' }),
    reserveInput({ keyEpoch: 2 }),
    reserveInput({ keyEpoch: '1' }),
    reserveInput({ sizeBytes: 0 }),
    reserveInput({ sizeBytes: -1 }),
    reserveInput({ sizeBytes: 1.5 }),
    reserveInput({ sizeBytes: Number.MAX_SAFE_INTEGER + 1 }),
    reserveInput({ sizeBytes: '100' }),
    reserveInput({ ciphertextSha256: new Uint8Array(31) }),
    reserveInput({ ciphertextSha256: new ArrayBuffer(32) }),
    reserveInput({ ciphertextSha256: 'base64' }),
  ];

  for (const input of invalidInputs) {
    const fake = new FakeUploadPrisma();
    await assert.rejects(
      repositoryFor(fake).reserve(input as never),
      (error: unknown) =>
        assertUploadError(error, 'invalid-upload-input', [
          'secret',
          DEVICE_ID,
          PROJECT_ID,
        ]),
    );
    assert.deepEqual(fake.order, []);
  }

  const uppercase = new FakeUploadPrisma();
  const letteredUploadID = 'abcdef12-3456-4789-8abc-def012345678';
  const letteredDeviceID = '12345678-9abc-4def-8abc-1234567890ab';
  const letteredProjectID = 'fedcba98-7654-4321-8abc-def012345678';
  const letteredRevisionID = '0abcdef1-2345-4678-9abc-def012345678';
  seedUpload(uppercase, {
    uploadID: letteredUploadID,
    deviceID: letteredDeviceID,
    projectID: letteredProjectID,
    revisionID: letteredRevisionID,
  });
  const replayed = await repositoryFor(uppercase).reserve(
    reserveInput({
      uploadID: letteredUploadID.toUpperCase(),
      deviceID: letteredDeviceID.toUpperCase(),
      projectID: letteredProjectID.toUpperCase(),
      revisionID: letteredRevisionID.toUpperCase(),
    }),
  );
  assert.equal(replayed.idempotent, true);
  assert.equal(replayed.upload.uploadID, letteredUploadID);
  assert.equal(replayed.upload.projectID, letteredProjectID);
});

test('checks quota, device grant, project, parent, and committed revision invariants', async () => {
  const cases: Array<{
    readonly setup: (fake: FakeUploadPrisma) => void;
    readonly code: UploadRepositoryErrorCode;
  }> = [
    {
      setup: () => {},
      code: 'quota-not-provisioned',
    },
    {
      setup: (fake) => {
        seedQuota(fake);
        seedDevice(fake, { grant: { status: 'revoked' } });
        seedProject(fake);
      },
      code: 'device-not-authorized',
    },
    {
      setup: (fake) => {
        seedQuota(fake);
        seedDevice(fake, {
          grant: { expiresAt: new Date(NOW.getTime() - 1) },
        });
        seedProject(fake);
      },
      code: 'device-not-authorized',
    },
    {
      setup: (fake) => {
        seedQuota(fake);
        seedDevice(fake, { userID: OTHER_USER_ID });
        seedProject(fake);
      },
      code: 'device-not-authorized',
    },
    {
      setup: (fake) => {
        seedQuota(fake);
        seedDevice(fake);
        seedProject(fake, { state: 'purged' });
      },
      code: 'project-not-found',
    },
    {
      setup: (fake) => {
        seedQuota(fake);
        seedDevice(fake);
        seedProject(fake, { userID: OTHER_USER_ID });
      },
      code: 'project-not-found',
    },
    {
      setup: (fake) => {
        seedQuota(fake);
        seedDevice(fake);
        seedProject(fake);
      },
      code: 'parent-revision-not-found',
    },
    {
      setup: (fake) => {
        seedQuota(fake);
        seedDevice(fake);
        seedProject(fake);
        seedRevision(fake, { revisionID: REVISION_ID });
      },
      code: 'revision-already-committed',
    },
  ];

  for (const [index, expected] of cases.entries()) {
    const fake = new FakeUploadPrisma();
    expected.setup(fake);
    const input = reserveInput(
      index === 6 ? { parentRevisionID: PARENT_ID } : {},
    );
    await assert.rejects(
      repositoryFor(fake).reserve(input),
      (error: unknown) => assertUploadError(error, expected.code),
    );
    assert.equal(fake.uploadCreates.length, 0);
    assert.equal(fake.quotaUpdates.length, 0);
  }

  const parentFake = new FakeUploadPrisma();
  seedQuota(parentFake);
  seedDevice(parentFake);
  seedProject(parentFake);
  seedRevision(parentFake, { revisionID: PARENT_ID });
  const accepted = await repositoryFor(parentFake).reserve(
    reserveInput({ parentRevisionID: PARENT_ID }),
  );
  assert.equal(accepted.idempotent, false);
  assert.equal(accepted.upload.parentRevisionID, PARENT_ID);
});

test('enforces max ciphertext at 422 and storage total at 413 without writes', async () => {
  const tooLarge = new FakeUploadPrisma();
  seedQuota(tooLarge, { limitBytes: 10_000n });
  seedDevice(tooLarge);
  seedProject(tooLarge);
  await assert.rejects(
    repositoryFor(tooLarge).reserve(reserveInput({ sizeBytes: 1_025 })),
    (error: unknown) => assertUploadError(error, 'ciphertext-too-large'),
  );
  assert.equal(tooLarge.uploadCreates.length, 0);
  assert.equal(tooLarge.quotaUpdates.length, 0);
  assert.equal(tooLarge.quotaRows.get(USER_ID)?.reservedBytes, 50n);

  const overLimit = new FakeUploadPrisma();
  seedQuota(overLimit, {
    limitBytes: 200n,
    usedBytes: 100n,
    reservedBytes: 50n,
  });
  seedDevice(overLimit);
  seedProject(overLimit);
  await assert.rejects(
    repositoryFor(overLimit).reserve(reserveInput({ sizeBytes: 51 })),
    (error: unknown) => assertUploadError(error, 'storage-limit-reached'),
  );
  assert.equal(overLimit.uploadCreates.length, 0);
  assert.equal(overLimit.quotaUpdates.length, 0);

  const exactFit = new FakeUploadPrisma();
  seedQuota(exactFit, {
    limitBytes: 250n,
    usedBytes: 100n,
    reservedBytes: 50n,
  });
  seedDevice(exactFit);
  seedProject(exactFit);
  const result = await repositoryFor(exactFit).reserve(
    reserveInput({ sizeBytes: 100 }),
  );
  assert.equal(result.upload.sizeBytes, 100n);
});

test('maps insert P2002 to a sanitized conflict and rolls back the quota increment', async () => {
  const secret = 'raw-database-detail-should-not-leak';
  const fake = new FakeUploadPrisma();
  seedQuota(fake);
  seedDevice(fake);
  seedProject(fake);
  fake.createError = { code: 'P2002', message: secret };

  await assert.rejects(
    repositoryFor(fake).reserve(reserveInput()),
    (error: unknown) => assertUploadError(error, 'upload-conflict', [secret]),
  );
  assert.equal(fake.uploadCreates.length, 1);
  assert.equal(fake.quotaUpdates.length, 0);
  assert.equal(fake.quotaRows.get(USER_ID)?.reservedBytes, 50n);
  assert.equal(fake.uploads.size, 0);
});

test('acquires a monotonic lease with only the upload lock and preserves live leases', async () => {
  const fake = new FakeUploadPrisma();
  seedUpload(fake, { leaseToken: 4n });
  const repository = repositoryFor(fake, POLICY, {
    createID: () => GENERATED_OWNER,
  });

  const first = await repository.acquireFinalizationLease({
    userID: USER_ID,
    uploadID: UPLOAD_ID,
    leaseOwner: OWNER,
  });

  assert.equal(first.outcome, 'leased');
  assert.equal(first.statusCode, 200);
  assert.equal(first.leaseToken, 5n);
  assert.equal(first.leaseOwner, OWNER);
  assert.equal(first.upload.state, 'finalizing');
  assert.equal(first.leaseExpiresAt, '2026-10-20T12:01:00.000Z');
  assert.equal(
    first.finalKey,
    finalKeyFor(USER_ID, UPLOAD_ID, 5n),
  );
  assert.deepEqual(fake.order, [
    'upload-lock',
    'upload-find',
    'upload-update',
  ]);
  assert.equal(fake.rawCalls.filter((call) => call.sql.includes('UserQuota')).length, 0);
  assert.equal(fake.quotaUpdates.length, 0);

  fake.order.length = 0;
  const live = await repository.acquireFinalizationLease({
    userID: USER_ID,
    uploadID: UPLOAD_ID,
    leaseOwner: 'other-owner',
  });
  assert.equal(live.outcome, 'in-progress');
  assert.equal(live.statusCode, 202);
  assert.equal(live.retryAfterSeconds, 60);
  assert.equal(live.leaseToken, 5n);
  assert.equal(live.finalKey, finalKeyFor(USER_ID, UPLOAD_ID, 5n));
  assert.equal(fake.uploadUpdates.length, 1);
  assert.deepEqual(fake.order, ['upload-lock', 'upload-find']);

  seedUpload(fake, {
    uploadID: OTHER_UPLOAD_ID,
    state: 'finalizing',
    leaseToken: 9n,
    leaseOwner: 'old-owner',
    leaseExpiresAt: new Date(NOW.getTime() - 1),
  });
  const recovery = await repository.acquireFinalizationLease({
    userID: USER_ID,
    uploadID: OTHER_UPLOAD_ID,
  });
  assert.equal(recovery.outcome, 'leased');
  assert.equal(recovery.leaseToken, 10n);
  assert.equal(recovery.leaseOwner, GENERATED_OWNER);
  assert.equal(recovery.upload.state, 'finalizing');
});

test('lease acquisition returns ready metadata and terminal/expired outcomes without writes', async () => {
  const readyFake = new FakeUploadPrisma();
  seedUpload(readyFake, {
    state: 'ready',
    finalKey: finalKeyFor(USER_ID, UPLOAD_ID, 2n),
    leaseToken: 2n,
    leaseOwner: OWNER,
    leaseExpiresAt: new Date(NOW.getTime() + 10_000),
  });
  const ready = await repositoryFor(readyFake).acquireFinalizationLease({
    userID: USER_ID,
    uploadID: UPLOAD_ID,
  });
  assert.equal(ready.outcome, 'ready');
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.leaseToken, 2n);
  assert.equal(ready.finalKey, finalKeyFor(USER_ID, UPLOAD_ID, 2n));
  assert.equal(readyFake.uploadUpdates.length, 0);

  for (const [state, code] of [
    ['expired', 'upload-expired'],
    ['deleting', 'upload-state-conflict'],
    ['deleted', 'upload-state-conflict'],
  ] as const) {
    const fake = new FakeUploadPrisma();
    seedUpload(fake, { state });
    await assert.rejects(
      repositoryFor(fake).acquireFinalizationLease({
        userID: USER_ID,
        uploadID: UPLOAD_ID,
      }),
      (error: unknown) => assertUploadError(error, code),
    );
    assert.equal(fake.uploadUpdates.length, 0);
  }

  const uploadingExpired = new FakeUploadPrisma();
  seedUpload(uploadingExpired, {
    expiresAt: new Date(NOW.getTime() - 1),
  });
  await assert.rejects(
    repositoryFor(uploadingExpired).acquireFinalizationLease({
      userID: USER_ID,
      uploadID: UPLOAD_ID,
    }),
    (error: unknown) => assertUploadError(error, 'upload-expired'),
  );
  assert.equal(uploadingExpired.uploadUpdates.length, 0);

  const missing = new FakeUploadPrisma();
  await assert.rejects(
    repositoryFor(missing).acquireFinalizationLease({
      userID: USER_ID,
      uploadID: UPLOAD_ID,
    }),
    (error: unknown) => assertUploadError(error, 'upload-not-found'),
  );

  const foreign = new FakeUploadPrisma();
  seedUpload(foreign, { userID: OTHER_USER_ID });
  await assert.rejects(
    repositoryFor(foreign).acquireFinalizationLease({
      userID: USER_ID,
      uploadID: UPLOAD_ID,
    }),
    (error: unknown) => assertUploadError(error, 'upload-not-found'),
  );
});

test('attaches a verified object under quota-first locks and charges exactly once', async () => {
  const fake = new FakeUploadPrisma();
  seedQuota(fake, { limitBytes: 1_000n, usedBytes: 10n, reservedBytes: 100n });
  seedProject(fake);
  seedUpload(fake, {
    state: 'finalizing',
    leaseToken: 1n,
    leaseOwner: OWNER,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  });
  const finalKey = finalKeyFor(USER_ID, UPLOAD_ID, 1n);
  const repository = repositoryFor(fake);

  const result = await repository.attachFinalObject({
    userID: USER_ID,
    uploadID: UPLOAD_ID,
    leaseToken: 1n,
    leaseOwner: OWNER,
    verifiedStorageObject: verified(finalKey, 100, HASH),
  });

  assert.equal(result.outcome, 'attached');
  assert.equal(result.charged, true);
  assert.equal(result.upload.state, 'ready');
  assert.equal(result.upload.finalKey, finalKey);
  assert.equal(result.upload.graceExpiresAt, '2026-10-21T12:00:00.000Z');
  assert.equal(result.upload.completedAt, NOW_ISO);
  assert.deepEqual(fake.order, [
    'quota-lock',
    'upload-lock',
    'upload-find',
    'project-find',
    'quota-update',
    'upload-update',
  ]);
  assert.deepEqual(fake.quotaUpdates[0], {
    where: { userID: USER_ID },
    data: {
      reservedBytes: { decrement: 100n },
      usedBytes: { increment: 100n },
    },
    select: { userID: true },
  });
  const updateData = fake.uploadUpdates[0]?.data;
  assert.ok(updateData !== undefined);
  assert.deepEqual(Object.keys(updateData).sort(), [
    'completedAt',
    'finalKey',
    'graceExpiresAt',
    'state',
  ]);
  assert.equal(fake.quotaRows.get(USER_ID)?.usedBytes, 110n);
  assert.equal(fake.quotaRows.get(USER_ID)?.reservedBytes, 0n);

  fake.order.length = 0;
  const replay = await repository.attachFinalObject({
    userID: USER_ID,
    uploadID: UPLOAD_ID,
    leaseToken: 1n,
    leaseOwner: OWNER,
    verifiedStorageObject: verified(finalKey, 100, HASH),
  });
  assert.equal(replay.outcome, 'idempotent');
  assert.equal(replay.charged, false);
  assert.deepEqual(fake.order, ['quota-lock', 'upload-lock', 'upload-find']);
  assert.equal(fake.quotaUpdates.length, 1);
  assert.equal(fake.uploadUpdates.length, 1);
});

test('refuses a different ready key and stale finalizers without any charge or state change', async () => {
  const readyFake = new FakeUploadPrisma();
  seedQuota(readyFake, { reservedBytes: 0n, usedBytes: 100n });
  seedUpload(readyFake, {
    state: 'ready',
    finalKey: finalKeyFor(USER_ID, UPLOAD_ID, 1n),
    leaseToken: 1n,
    leaseOwner: OWNER,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  });
  await assert.rejects(
    repositoryFor(readyFake).attachFinalObject({
      userID: USER_ID,
      uploadID: UPLOAD_ID,
      leaseToken: 1n,
      leaseOwner: OWNER,
      verifiedStorageObject: verified(finalKeyFor(USER_ID, UPLOAD_ID, 2n)),
    }),
    (error: unknown) => assertUploadError(error, 'upload-state-conflict'),
  );
  assert.equal(readyFake.uploadUpdates.length, 0);
  assert.equal(readyFake.quotaUpdates.length, 0);

  const staleCases: Array<Partial<UploadRow>> = [
    { leaseToken: 0n },
    { leaseOwner: 'other-owner' },
    { leaseExpiresAt: new Date(NOW.getTime() - 1) },
  ];
  for (const overrides of staleCases) {
    const fake = new FakeUploadPrisma();
    seedQuota(fake, { reservedBytes: 100n });
    seedUpload(fake, {
      state: 'finalizing',
      leaseToken: 1n,
      leaseOwner: OWNER,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      ...overrides,
    });
    const result = await repositoryFor(fake).attachFinalObject({
      userID: USER_ID,
      uploadID: UPLOAD_ID,
      leaseToken: 1n,
      leaseOwner: OWNER,
      verifiedStorageObject: verified(finalKeyFor(USER_ID, UPLOAD_ID, 1n)),
    });
    assert.equal(result.outcome, 'stale');
    assert.equal(result.charged, false);
    assert.equal(result.upload.state, 'finalizing');
    assert.equal(fake.uploadUpdates.length, 0);
    assert.equal(fake.quotaUpdates.length, 0);
  }
});

test('rejects wrong final keys, metadata mismatches, inactive projects, and underflow', async () => {
  const setup = () => {
    const fake = new FakeUploadPrisma();
    seedQuota(fake, { reservedBytes: 100n });
    seedProject(fake);
    seedUpload(fake, {
      state: 'finalizing',
      leaseToken: 1n,
      leaseOwner: OWNER,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    return fake;
  };

  const wrongKey = setup();
  await assert.rejects(
    repositoryFor(wrongKey).attachFinalObject({
      userID: USER_ID,
      uploadID: UPLOAD_ID,
      leaseToken: 1n,
      leaseOwner: OWNER,
      verifiedStorageObject: verified(
        finalKeyFor(USER_ID, UPLOAD_ID, 2n),
        100,
        HASH,
      ),
    }),
    (error: unknown) => assertUploadError(error, 'upload-conflict'),
  );
  assert.equal(wrongKey.uploadUpdates.length, 0);

  for (const object of [
    verified(finalKeyFor(USER_ID, UPLOAD_ID, 1n), 99, HASH),
    verified(finalKeyFor(USER_ID, UPLOAD_ID, 1n), 100, OTHER_HASH),
  ]) {
    const fake = setup();
    await assert.rejects(
      repositoryFor(fake).attachFinalObject({
        userID: USER_ID,
        uploadID: UPLOAD_ID,
        leaseToken: 1n,
        leaseOwner: OWNER,
        verifiedStorageObject: object,
      }),
      (error: unknown) => assertUploadError(error, 'upload-conflict'),
    );
    assert.equal(fake.uploadUpdates.length, 0);
    assert.equal(fake.quotaUpdates.length, 0);
  }

  const inactiveProject = setup();
  inactiveProject.projects.set(PROJECT_ID, {
    projectID: PROJECT_ID,
    userID: USER_ID,
    state: 'purged',
  });
  await assert.rejects(
    repositoryFor(inactiveProject).attachFinalObject({
      userID: USER_ID,
      uploadID: UPLOAD_ID,
      leaseToken: 1n,
      leaseOwner: OWNER,
      verifiedStorageObject: verified(finalKeyFor(USER_ID, UPLOAD_ID, 1n)),
    }),
    (error: unknown) => assertUploadError(error, 'upload-state-conflict'),
  );

  const underflow = setup();
  const underflowQuota = underflow.quotaRows.get(USER_ID);
  assert.ok(underflowQuota !== undefined);
  underflow.quotaRows.set(USER_ID, { ...underflowQuota, reservedBytes: 99n });
  await assert.rejects(
    repositoryFor(underflow).attachFinalObject({
      userID: USER_ID,
      uploadID: UPLOAD_ID,
      leaseToken: 1n,
      leaseOwner: OWNER,
      verifiedStorageObject: verified(finalKeyFor(USER_ID, UPLOAD_ID, 1n)),
    }),
    (error: unknown) => assertUploadError(error, 'quota-underflow'),
  );
  assert.equal(underflow.uploadUpdates.length, 0);
  assert.equal(underflow.quotaUpdates.length, 0);
  assert.equal(underflow.uploads.get(UPLOAD_ID)?.state, 'finalizing');
});

test('expires only fenced or uploading reservations and releases reserved once', async () => {
  const uploading = new FakeUploadPrisma();
  seedQuota(uploading, { reservedBytes: 100n });
  seedUpload(uploading, {
    expiresAt: new Date(NOW.getTime() - 1),
  });
  const expired = await repositoryFor(uploading).expireReservation({
    userID: USER_ID,
    uploadID: UPLOAD_ID,
  });
  assert.equal(expired.outcome, 'expired');
  assert.equal(expired.released, true);
  assert.equal(expired.upload.state, 'expired');
  assert.deepEqual(uploading.order.slice(0, 2), ['quota-lock', 'upload-lock']);
  assert.deepEqual(uploading.quotaUpdates[0]?.data, {
    reservedBytes: { decrement: 100n },
  });

  const notDue = new FakeUploadPrisma();
  seedQuota(notDue);
  seedUpload(notDue);
  const notExpired = await repositoryFor(notDue).expireReservation({
    userID: USER_ID,
    uploadID: UPLOAD_ID,
  });
  assert.equal(notExpired.outcome, 'not-expired');
  assert.equal(notExpired.released, false);
  assert.equal(notDue.uploadUpdates.length, 0);
  assert.equal(notDue.quotaUpdates.length, 0);

  const finalizing = new FakeUploadPrisma();
  seedQuota(finalizing, { reservedBytes: 100n });
  seedUpload(finalizing, {
    state: 'finalizing',
    leaseToken: 3n,
    leaseOwner: OWNER,
    leaseExpiresAt: new Date(NOW.getTime() - 1),
  });
  const fenced = await repositoryFor(finalizing).expireReservation({
    userID: USER_ID,
    uploadID: UPLOAD_ID,
  });
  assert.equal(fenced.outcome, 'expired');
  assert.equal(fenced.released, true);
  assert.equal(fenced.upload.state, 'expired');
  assert.equal(fenced.upload.leaseToken, 4n);
  assert.equal(finalizing.uploadUpdates.length, 2);
  assert.deepEqual(finalizing.uploadUpdates[0]?.data, {
    leaseToken: 4n,
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  assert.deepEqual(finalizing.order, [
    'quota-lock',
    'upload-lock',
    'upload-find',
    'upload-update',
    'quota-update',
    'upload-update',
  ]);
  assert.equal(finalizing.quotaUpdates.length, 1);

  const live = new FakeUploadPrisma();
  seedQuota(live);
  seedUpload(live, {
    state: 'finalizing',
    leaseToken: 3n,
    leaseOwner: OWNER,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  });
  const liveResult = await repositoryFor(live).expireReservation({
    userID: USER_ID,
    uploadID: UPLOAD_ID,
  });
  assert.equal(liveResult.outcome, 'live-lease');
  assert.equal(liveResult.released, false);
  assert.equal(live.uploadUpdates.length, 0);
  assert.equal(live.quotaUpdates.length, 0);

  for (const state of ['ready', 'deleting', 'deleted', 'expired'] as const) {
    const terminal = new FakeUploadPrisma();
    seedQuota(terminal);
    seedUpload(terminal, { state });
    const result = await repositoryFor(terminal).expireReservation({
      userID: USER_ID,
      uploadID: UPLOAD_ID,
    });
    assert.equal(result.outcome, 'terminal');
    assert.equal(result.released, false);
    assert.equal(terminal.uploadUpdates.length, 0);
    assert.equal(terminal.quotaUpdates.length, 0);
  }
});

test('rolls back an expiry whose reserved counter underflows', async () => {
  const fake = new FakeUploadPrisma();
  seedQuota(fake, { reservedBytes: 0n });
  seedUpload(fake, {
    expiresAt: new Date(NOW.getTime() - 1),
  });

  await assert.rejects(
    repositoryFor(fake).expireReservation({
      userID: USER_ID,
      uploadID: UPLOAD_ID,
    }),
    (error: unknown) => assertUploadError(error, 'quota-underflow'),
  );
  assert.equal(fake.uploads.get(UPLOAD_ID)?.state, 'uploading');
  assert.equal(fake.quotaUpdates.length, 0);
  assert.equal(fake.quotaRows.get(USER_ID)?.reservedBytes, 0n);
});

test('serialises fake interactive transactions so concurrent reservations cannot overbook', async () => {
  const fake = new FakeUploadPrisma();
  seedQuota(fake, {
    limitBytes: 1_000n,
    usedBytes: 0n,
    reservedBytes: 0n,
  });
  seedDevice(fake);
  seedProject(fake);
  const repository = repositoryFor(fake, {
    ...POLICY,
    maxCiphertextBytes: 1_000,
  });

  const [first, second] = await Promise.allSettled([
    repository.reserve(
      reserveInput({
        uploadID: UPLOAD_ID,
        revisionID: REVISION_ID,
        sizeBytes: 600,
      }),
    ),
    repository.reserve(
      reserveInput({
        uploadID: OTHER_UPLOAD_ID,
        revisionID: OTHER_REVISION_ID,
        sizeBytes: 600,
      }),
    ),
  ]);

  const fulfilled = [first, second].filter(
    (result) => result.status === 'fulfilled',
  ) as PromiseFulfilledResult<unknown>[];
  const rejected = [first, second].filter(
    (result) => result.status === 'rejected',
  ) as PromiseRejectedResult[];
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]?.reason instanceof UploadRepositoryError,
    'expected an upload repository error',
  );
  assert.equal(rejected[0]?.reason.code, 'storage-limit-reached');
  assert.equal(fake.quotaRows.get(USER_ID)?.reservedBytes, 600n);
  assert.equal(fake.uploads.size, 1);
  assert.equal(fake.quotaUpdates.length, 1);
});

test('sanitises unexpected accounting failures as a retryable 503 and rolls back', async () => {
  const secret = 'postgres://secret-user:secret-password@db/internal';
  const fake = new FakeUploadPrisma();
  seedQuota(fake);
  seedDevice(fake);
  seedProject(fake);
  fake.quotaUpdateError = new Error(secret);

  await assert.rejects(
    repositoryFor(fake).reserve(reserveInput()),
    (error: unknown) =>
      assertUploadError(error, 'repository-unavailable', [
        secret,
        USER_ID,
        UPLOAD_ID,
      ]),
  );
  assert.equal(fake.uploads.size, 0);
  assert.equal(fake.quotaRows.get(USER_ID)?.reservedBytes, 50n);
});
