import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RevisionRepositoryError,
  type RevisionRepositoryErrorCode,
} from '../../src/revisions/errors.js';
import {
  createRevisionRepository,
  type CommitRevisionInput,
  type RevisionRepositoryClient,
  type RevisionRepositoryOptions,
} from '../../src/revisions/repository.js';

/*
 * Focused unit tests against a small structural Prisma fake. They prove query
 * shape, ordering, locked-SQL parameters, idempotence, sibling-head handling,
 * sequence allocation, page mechanics, and error sanitising only.
 *
 * They do NOT prove PostgreSQL row locking, ReadCommitted/RepeatableRead
 * behaviour, Prisma runtime binding, or live concurrent execution. The fake
 * serialises whole transactions to exercise the repository's conflict logic.
 */

const USER_ID = 'user_01HTESTVENDOROPAQUE';
const OTHER_USER_ID = 'user_othersecretvalue';
const DEVICE_ID = '44aa2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const OTHER_DEVICE_ID = '55bb2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const PROJECT_ID = '5d4e8c2a-1b3f-4a6d-9e8c-0f1a2b3c4d5e';
const OTHER_PROJECT_ID = '7c1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_A_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_B_ID = '44444444-4444-4444-8444-444444444444';
const FORGOTTEN_UPLOAD_ID = '99999999-9999-4999-8999-999999999999';
const UPLOAD_ID = 'aa11bb22-cc33-4d44-8e55-ff66aa77bb88';
const OTHER_UPLOAD_ID = 'bb22cc33-dd44-4e55-8f66-aa77bb88cc99';
const CREATED_AT = new Date('2026-10-18T12:00:00.000Z');
const CREATED_AT_ISO = '2026-10-18T12:00:00.000Z';
const HASH = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const OTHER_HASH = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

const EXPECTED_MESSAGES: Readonly<Record<RevisionRepositoryErrorCode, string>> =
  {
    'invalid-revision-input': 'Revision repository input is invalid.',
    'invalid-cursor': 'The cursor is invalid.',
    'invalid-page-limit': 'The page limit is invalid.',
    'project-not-found': 'The project was not found.',
    'unknown-parent': 'The parent revision was not found.',
    'parent-required': 'A parent revision is required.',
    'upload-not-ready': 'The upload is not ready for commit.',
    'revision-conflict':
      'The revision identifier is unavailable for these fields.',
    'device-not-found': 'The device is not active for this user.',
    'internal-error': 'An internal revision error occurred.',
    'repository-unavailable':
      'The revision service is temporarily unavailable.',
  };

interface FakeProject {
  projectID: string;
  userID: string;
  state: 'active' | 'purged';
  nextSeq: bigint;
}

interface FakeRevision {
  revisionID: string;
  projectID: string;
  userID: string;
  parentRevisionID: string | null;
  seq: bigint;
  deviceID: string;
  keyEpoch: number;
  sizeBytes: bigint;
  ciphertextSha256: Uint8Array;
  storageObjectKey: string;
  createdAt: Date;
}

interface FakeUpload {
  uploadID: string;
  userID: string;
  projectID: string;
  deviceID: string;
  revisionID: string;
  parentRevisionID: string | null;
  keyEpoch: number;
  finalKey: string | null;
  state: 'uploading' | 'finalizing' | 'ready' | 'deleting' | 'deleted' | 'expired';
  sizeBytes: bigint;
  ciphertextSha256: Uint8Array;
}

interface LockedCall {
  values: unknown[];
  sql: string;
}

interface FakePrismaOptions {
  rawError?: unknown;
}

type AnyArgs = Record<string, any>;

class FakeRevisionPrisma {
  readonly projects = new Map<string, FakeProject>();
  readonly revisions = new Map<string, FakeRevision>();
  readonly uploads = new Map<string, FakeUpload>();
  readonly devices = new Map<string, { id: string; userID: string }>();
  readonly heads = new Map<string, Set<string>>();

  readonly order: string[] = [];
  readonly projectLocks: LockedCall[] = [];
  readonly uploadLocks: LockedCall[] = [];
  readonly transactionOptions: unknown[] = [];
  readonly pageFindManyArgs: AnyArgs[] = [];

  private readonly options: FakePrismaOptions;
  private chain: Promise<void> = Promise.resolve();

  readonly tx: AnyArgs;

  constructor(options: FakePrismaOptions = {}) {
    this.options = options;

    const headSet = (projectID: string): Set<string> => {
      let set = this.heads.get(projectID);
      if (set === undefined) {
        set = new Set();
        this.heads.set(projectID, set);
      }
      return set;
    };

    this.tx = {
      $queryRaw: async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<unknown> => {
        if (this.options.rawError !== undefined) {
          throw this.options.rawError;
        }
        const sql = normalizeSql(strings);
        if (sql.includes('FROM "Project"')) {
          this.order.push('lock-project');
          this.projectLocks.push({ values, sql });
          const [projectID, userID] = values as [string, string];
          const project = this.projects.get(projectID);
          if (
            project === undefined ||
            project.userID !== userID ||
            project.state !== 'active'
          ) {
            return [];
          }
          return [
            {
              projectID: project.projectID,
              userID: project.userID,
              nextSeq: project.nextSeq,
            },
          ];
        }
        if (sql.includes('FROM "Upload"')) {
          this.order.push('lock-upload');
          this.uploadLocks.push({ values, sql });
          const [uploadID, userID, projectID, deviceID] = values as [
            string,
            string,
            string,
            string,
          ];
          const upload = this.uploads.get(uploadID);
          if (
            upload === undefined ||
            upload.userID !== userID ||
            upload.projectID !== projectID ||
            upload.deviceID !== deviceID
          ) {
            return [];
          }
          return [{ ...upload }];
        }
        throw new Error('unexpected raw query');
      },
      project: {
        findFirst: async (args: AnyArgs): Promise<unknown> => {
          this.order.push('project:findFirst');
          const where = args.where as {
            projectID?: string;
            userID?: string;
            state?: string;
          };
          const project = this.projects.get(where.projectID ?? '');
          if (
            project === undefined ||
            (where.userID !== undefined && project.userID !== where.userID) ||
            (where.state !== undefined && project.state !== where.state)
          ) {
            return null;
          }
          return { nextSeq: project.nextSeq };
        },
        update: async (args: AnyArgs): Promise<unknown> => {
          this.order.push('project:update');
          const projectID = args.where.projectID as string;
          const project = this.projects.get(projectID);
          if (project === undefined) {
            throw new Error('missing project');
          }
          const increment = args.data?.nextSeq?.increment as bigint | undefined;
          if (increment !== undefined) {
            project.nextSeq += increment;
          }
          return project;
        },
      },
      revision: {
        findFirst: async (args: AnyArgs): Promise<unknown> => {
          this.order.push('revision:findFirst');
          const row = [...this.revisions.values()].find((candidate) =>
            matchesRevisionWhere(candidate, args.where as AnyArgs),
          );
          if (row === undefined) {
            return null;
          }
          return projectRevision(row, args.select as AnyArgs);
        },
        findMany: async (args: AnyArgs): Promise<unknown> => {
          this.order.push('revision:findMany');
          this.pageFindManyArgs.push(args);
          const where = args.where as AnyArgs;
          const rows = [...this.revisions.values()]
            .filter((row) => matchesRevisionWhere(row, where))
            .sort((left, right) =>
              left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0,
            );
          const take =
            typeof args.take === 'number' ? args.take : rows.length;
          return rows.slice(0, take).map((row) => projectRevision(row, args.select));
        },
        create: async (args: AnyArgs): Promise<unknown> => {
          this.order.push('revision:create');
          const data = args.data as FakeRevision;
          if (this.revisions.has(data.revisionID)) {
            throw { code: 'P2002', message: 'foreign revision secret' };
          }
          this.revisions.set(data.revisionID, { ...data });
          return { revisionID: data.revisionID };
        },
      },
      projectHead: {
        findMany: async (args: AnyArgs): Promise<unknown> => {
          this.order.push('projectHead:findMany');
          const projectID = args.where.projectID as string;
          return [...headSet(projectID)]
            .sort()
            .map((revisionID) => ({ revisionID }));
        },
        deleteMany: async (args: AnyArgs): Promise<unknown> => {
          this.order.push('projectHead:deleteMany');
          const projectID = args.where.projectID as string;
          const revisionID = args.where.revisionID as string | undefined;
          const set = headSet(projectID);
          let count = 0;
          if (revisionID !== undefined && set.delete(revisionID)) {
            count = 1;
          }
          return { count };
        },
        create: async (args: AnyArgs): Promise<unknown> => {
          this.order.push('projectHead:create');
          const { projectID, revisionID } = args.data as {
            projectID: string;
            revisionID: string;
          };
          const set = headSet(projectID);
          if (set.has(revisionID)) {
            throw { code: 'P2002' };
          }
          set.add(revisionID);
          return { projectID, revisionID };
        },
      },
      upload: {
        findFirst: async (args: AnyArgs): Promise<unknown> => {
          this.order.push('upload:findFirst');
          const where = args.where as {
            uploadID?: string;
            finalKey?: string;
            userID?: string;
            projectID?: string;
            deviceID?: string;
          };
          const row = [...this.uploads.values()].find(
            (candidate) =>
              (where.uploadID === undefined ||
                candidate.uploadID === where.uploadID) &&
              (where.finalKey === undefined ||
                candidate.finalKey === where.finalKey) &&
              (where.userID === undefined ||
                candidate.userID === where.userID) &&
              (where.projectID === undefined ||
                candidate.projectID === where.projectID) &&
              (where.deviceID === undefined ||
                candidate.deviceID === where.deviceID),
          );
          return row === undefined ? null : { ...row };
        },
      },
      device: {
        findFirst: async (args: AnyArgs): Promise<unknown> => {
          this.order.push('device:findFirst');
          const where = args.where as { id?: string; userID?: string };
          const device = this.devices.get(where.id ?? '');
          if (
            device === undefined ||
            (where.userID !== undefined && device.userID !== where.userID)
          ) {
            return null;
          }
          return { id: device.id };
        },
      },
    };
  }

  async $transaction<T>(
    operation: (transaction: AnyArgs) => Promise<T>,
    options?: unknown,
  ): Promise<T> {
    this.transactionOptions.push(options);
    // Synthetic serialisation only: this models a held project row lock. It is
    // not PostgreSQL concurrency proof.
    const run = this.chain.then(() => operation(this.tx));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  seedProject(overrides: Partial<FakeProject> = {}): FakeProject {
    const project: FakeProject = {
      projectID: PROJECT_ID,
      userID: USER_ID,
      state: 'active',
      nextSeq: 1n,
      ...overrides,
    };
    this.projects.set(project.projectID, project);
    return project;
  }

  seedDevice(id = DEVICE_ID, userID = USER_ID): void {
    this.devices.set(id, { id, userID });
  }

  seedUpload(overrides: Partial<FakeUpload> = {}): FakeUpload {
    const upload: FakeUpload = {
      uploadID: UPLOAD_ID,
      userID: USER_ID,
      projectID: PROJECT_ID,
      deviceID: DEVICE_ID,
      revisionID: REVISION_ID,
      parentRevisionID: null,
      keyEpoch: 1,
      finalKey: `final/${UPLOAD_ID}`,
      state: 'ready',
      sizeBytes: 1_024n,
      ciphertextSha256: new Uint8Array(HASH),
      ...overrides,
    };
    this.uploads.set(upload.uploadID, upload);
    return upload;
  }

  seedRevision(overrides: Partial<FakeRevision> = {}): FakeRevision {
    const revision: FakeRevision = {
      revisionID: PARENT_ID,
      projectID: PROJECT_ID,
      userID: USER_ID,
      parentRevisionID: null,
      seq: 1n,
      deviceID: DEVICE_ID,
      keyEpoch: 1,
      sizeBytes: 1_024n,
      ciphertextSha256: new Uint8Array(HASH),
      storageObjectKey: `final/${PARENT_ID}`,
      createdAt: CREATED_AT,
      ...overrides,
    };
    this.revisions.set(revision.revisionID, revision);
    return revision;
  }

  addHead(revisionID: string, projectID = PROJECT_ID): void {
    let set = this.heads.get(projectID);
    if (set === undefined) {
      set = new Set();
      this.heads.set(projectID, set);
    }
    set.add(revisionID);
  }

  headIDs(projectID = PROJECT_ID): string[] {
    return [...(this.heads.get(projectID) ?? [])].sort();
  }
}

function projectRevision(
  row: FakeRevision,
  select: AnyArgs | undefined,
): unknown {
  if (select !== undefined && select.revisionID === true && Object.keys(select).length === 1) {
    return { revisionID: row.revisionID };
  }
  return { ...row };
}

function matchesRevisionWhere(row: FakeRevision, where: AnyArgs): boolean {
  if (where.revisionID !== undefined && row.revisionID !== where.revisionID) {
    return false;
  }
  if (where.projectID !== undefined && row.projectID !== where.projectID) {
    return false;
  }
  if (where.userID !== undefined && row.userID !== where.userID) {
    return false;
  }
  const seq = where.seq as
    | { gt?: bigint; lte?: bigint }
    | undefined;
  if (seq !== undefined) {
    if (seq.gt !== undefined && row.seq <= seq.gt) {
      return false;
    }
    if (seq.lte !== undefined && row.seq > seq.lte) {
      return false;
    }
  }
  return true;
}

function normalizeSql(strings: readonly string[]): string {
  return strings.join('?').replace(/\s+/g, ' ').trim();
}

function fakeClient(fake: FakeRevisionPrisma): RevisionRepositoryClient {
  return fake as unknown as RevisionRepositoryClient;
}

function repositoryFor(fake: FakeRevisionPrisma, maxPageSize = 10) {
  return createRevisionRepository(fakeClient(fake), { maxPageSize });
}

function commitInput(
  overrides: Partial<CommitRevisionInput> = {},
): CommitRevisionInput {
  return {
    userID: USER_ID,
    deviceID: DEVICE_ID,
    projectID: PROJECT_ID,
    revisionID: REVISION_ID,
    uploadID: UPLOAD_ID,
    parentRevisionID: null,
    ...overrides,
  };
}

function assertRevisionError(
  error: unknown,
  code: RevisionRepositoryErrorCode,
  statusCode: number,
  retryable: boolean,
  secrets: readonly string[] = [],
): boolean {
  assert.ok(error instanceof RevisionRepositoryError);
  assert.equal(error.name, 'RevisionRepositoryError');
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  assert.equal(error.retryable, retryable);
  assert.equal(error.message, EXPECTED_MESSAGES[code]);
  assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
  assert.equal(error.cause, undefined);

  const rendered = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
  for (const secret of secrets) {
    assert.equal(rendered.includes(secret), false);
  }

  return true;
}

test('requires an explicit positive safe-integer page cap and valid clock seam', () => {
  const invalidOptions: unknown[] = [
    undefined,
    null,
    {},
    [],
    { maxPageSize: 0 },
    { maxPageSize: -1 },
    { maxPageSize: 1.5 },
    { maxPageSize: Number.NaN },
    { maxPageSize: Number.POSITIVE_INFINITY },
    { maxPageSize: Number.MAX_SAFE_INTEGER + 1 },
    { maxPageSize: '10' },
    { maxPageSize: 10n },
    { maxPageSize: true },
    { maxPageSize: null },
    { maxPageSize: 5, now: 'clock' },
    { maxPageSize: 5, now: null },
  ];

  for (const options of invalidOptions) {
    const fake = new FakeRevisionPrisma();
    assert.throws(
      () =>
        createRevisionRepository(
          fakeClient(fake),
          options as RevisionRepositoryOptions,
        ),
      (error: unknown) =>
        assertRevisionError(error, 'invalid-revision-input', 422, false),
    );
    assert.deepEqual(fake.order, []);
  }

  const fake = new FakeRevisionPrisma();
  const repository = createRevisionRepository(fakeClient(fake), {
    maxPageSize: 1,
    now: () => CREATED_AT,
  });
  assert.equal(typeof repository.commit, 'function');
  assert.equal(typeof repository.page, 'function');
  assert.deepEqual(fake.order, []);
});

test('commits an initial revision at 201 with project lock before upload lock', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 1n });
  fake.seedDevice();
  fake.seedUpload();

  const result = await repositoryFor(fake).commit(commitInput());

  assert.deepEqual(fake.order, [
    'lock-project',
    'revision:findFirst',
    'device:findFirst',
    'lock-upload',
    'revision:findFirst',
    'revision:create',
    'project:update',
    'projectHead:create',
    'projectHead:findMany',
  ]);
  assert.deepEqual(fake.transactionOptions, [
    { isolationLevel: 'ReadCommitted' },
  ]);

  assert.deepEqual(result, {
    statusCode: 201,
    revisionID: REVISION_ID,
    seq: '1',
    headIDs: [REVISION_ID],
    conflict: false,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.headIDs), true);
  assert.equal(typeof result.seq, 'string');

  assert.equal(fake.projects.get(PROJECT_ID)?.nextSeq, 2n);
  assert.deepEqual(fake.headIDs(), [REVISION_ID]);

  assert.deepEqual(fake.projectLocks[0]?.values, [PROJECT_ID, USER_ID]);
  assert.equal(fake.projectLocks[0]?.sql.includes(USER_ID), false);
  assert.equal(
    fake.projectLocks[0]?.sql,
    'SELECT "projectID", "userID", "nextSeq" FROM "Project" WHERE "projectID" = ? AND "userID" = ? AND "state" = \'active\' FOR UPDATE',
  );
  assert.deepEqual(fake.uploadLocks[0]?.values, [
    UPLOAD_ID,
    USER_ID,
    PROJECT_ID,
    DEVICE_ID,
  ]);
  assert.equal(fake.uploadLocks[0]?.sql.includes(UPLOAD_ID), false);
  assert.equal(
    fake.uploadLocks[0]?.sql,
    'SELECT "uploadID", "userID", "projectID", "deviceID", "revisionID", "parentRevisionID", "keyEpoch", "finalKey", "state", "sizeBytes", "ciphertextSha256" FROM "Upload" WHERE "uploadID" = ? AND "userID" = ? AND "projectID" = ? AND "deviceID" = ? FOR UPDATE',
  );

  const stored = fake.revisions.get(REVISION_ID);
  assert.ok(stored !== undefined);
  assert.deepEqual(
    {
      revisionID: stored.revisionID,
      projectID: stored.projectID,
      userID: stored.userID,
      parentRevisionID: stored.parentRevisionID,
      seq: stored.seq,
      deviceID: stored.deviceID,
      keyEpoch: stored.keyEpoch,
      sizeBytes: stored.sizeBytes,
      storageObjectKey: stored.storageObjectKey,
    },
    {
      revisionID: REVISION_ID,
      projectID: PROJECT_ID,
      userID: USER_ID,
      parentRevisionID: null,
      seq: 1n,
      deviceID: DEVICE_ID,
      keyEpoch: 1,
      sizeBytes: 1_024n,
      storageObjectKey: `final/${UPLOAD_ID}`,
    },
  );
  assert.deepEqual(stored.ciphertextSha256, HASH);
  assert.notStrictEqual(stored.ciphertextSha256, HASH);
  assert.equal(
    fake.projectLocks.some((call) => call.sql.includes('UserQuota')),
    false,
  );
  assert.equal(
    fake.uploadLocks.some((call) => call.sql.includes('UserQuota')),
    false,
  );
});

test('removes only the declared parent head and preserves sibling heads on a race', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 3n });
  fake.seedDevice();
  fake.seedRevision({ revisionID: PARENT_ID, seq: 1n });
  fake.addHead(PARENT_ID);
  fake.seedUpload({
    uploadID: UPLOAD_ID,
    revisionID: CHILD_A_ID,
    parentRevisionID: PARENT_ID,
    finalKey: 'final/a',
  });
  fake.seedUpload({
    uploadID: OTHER_UPLOAD_ID,
    revisionID: CHILD_B_ID,
    parentRevisionID: PARENT_ID,
    finalKey: 'final/b',
  });

  const repository = repositoryFor(fake);
  const first = await repository.commit(
    commitInput({
      revisionID: CHILD_A_ID,
      uploadID: UPLOAD_ID,
      parentRevisionID: PARENT_ID,
    }),
  );

  assert.equal(first.statusCode, 201);
  assert.equal(first.seq, '3');
  assert.equal(first.conflict, false);
  assert.deepEqual(first.headIDs, [CHILD_A_ID]);
  assert.deepEqual(fake.headIDs(), [CHILD_A_ID]);

  const second = await repository.commit(
    commitInput({
      revisionID: CHILD_B_ID,
      uploadID: OTHER_UPLOAD_ID,
      parentRevisionID: PARENT_ID,
    }),
  );

  assert.equal(second.statusCode, 201);
  assert.equal(second.seq, '4');
  assert.equal(second.conflict, true);
  assert.deepEqual(second.headIDs, [CHILD_A_ID, CHILD_B_ID]);
  assert.deepEqual(fake.headIDs(), [CHILD_A_ID, CHILD_B_ID]);
  assert.equal(fake.projects.get(PROJECT_ID)?.nextSeq, 5n);
  assert.equal(fake.revisions.has(PARENT_ID), true);
  assert.equal(fake.revisions.has(CHILD_A_ID), true);
  assert.equal(fake.revisions.has(CHILD_B_ID), true);
});

test('synthetic concurrent sibling commits serialise and both survive', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 3n });
  fake.seedDevice();
  fake.seedRevision({ revisionID: PARENT_ID, seq: 1n });
  fake.addHead(PARENT_ID);
  fake.seedUpload({
    uploadID: UPLOAD_ID,
    revisionID: CHILD_A_ID,
    parentRevisionID: PARENT_ID,
    finalKey: 'final/a',
  });
  fake.seedUpload({
    uploadID: OTHER_UPLOAD_ID,
    revisionID: CHILD_B_ID,
    parentRevisionID: PARENT_ID,
    finalKey: 'final/b',
  });

  const repository = repositoryFor(fake);
  // The fake serialises whole transactions; this proves the repository's
  // sibling logic under an assumed held project lock, not PostgreSQL locking.
  const results = await Promise.all([
    repository.commit(
      commitInput({
        revisionID: CHILD_A_ID,
        uploadID: UPLOAD_ID,
        parentRevisionID: PARENT_ID,
      }),
    ),
    repository.commit(
      commitInput({
        revisionID: CHILD_B_ID,
        uploadID: OTHER_UPLOAD_ID,
        parentRevisionID: PARENT_ID,
      }),
    ),
  ]);

  assert.deepEqual(
    results.map((result) => result.statusCode),
    [201, 201],
  );
  assert.deepEqual(
    results.map((result) => result.conflict).sort(),
    [false, true],
  );
  assert.deepEqual(fake.headIDs(), [CHILD_A_ID, CHILD_B_ID]);
  assert.equal(fake.projects.get(PROJECT_ID)?.nextSeq, 5n);
  assert.equal(fake.revisions.has(PARENT_ID), true);
  assert.equal(fake.revisions.has(CHILD_A_ID), true);
  assert.equal(fake.revisions.has(CHILD_B_ID), true);
});

test('replays a committed revision at 200 without sequence or head mutation', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 2n });
  fake.seedRevision({
    revisionID: REVISION_ID,
    parentRevisionID: null,
    seq: 1n,
    storageObjectKey: `final/${UPLOAD_ID}`,
  });
  fake.addHead(REVISION_ID);
  fake.seedUpload();

  const result = await repositoryFor(fake).commit(commitInput());

  assert.deepEqual(result, {
    statusCode: 200,
    revisionID: REVISION_ID,
    seq: '1',
    headIDs: [REVISION_ID],
    conflict: false,
  });
  assert.deepEqual(fake.order, [
    'lock-project',
    'revision:findFirst',
    'upload:findFirst',
    'projectHead:findMany',
  ]);
  assert.equal(fake.projects.get(PROJECT_ID)?.nextSeq, 2n);
  assert.deepEqual(fake.headIDs(), [REVISION_ID]);
});

test('rejects a repeated revision ID when visible immutable fields differ', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 2n });
  fake.seedRevision({
    revisionID: REVISION_ID,
    seq: 1n,
    storageObjectKey: `final/${UPLOAD_ID}`,
  });
  fake.addHead(REVISION_ID);
  fake.seedUpload({ keyEpoch: 2 });

  await assert.rejects(
    repositoryFor(fake).commit(commitInput()),
    (error: unknown) =>
      assertRevisionError(error, 'revision-conflict', 409, false, [
        USER_ID,
        REVISION_ID,
        UPLOAD_ID,
      ]),
  );

  assert.deepEqual(fake.order, [
    'lock-project',
    'revision:findFirst',
    'upload:findFirst',
  ]);
  assert.equal(fake.projects.get(PROJECT_ID)?.nextSeq, 2n);
  assert.deepEqual(fake.headIDs(), [REVISION_ID]);
  assert.equal(fake.revisions.size, 1);
});

test('replays through the original ready upload when the replacement reservation is missing', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 2n });
  fake.seedRevision({
    revisionID: REVISION_ID,
    seq: 1n,
    storageObjectKey: 'final/original',
  });
  fake.addHead(REVISION_ID);
  fake.seedUpload({
    uploadID: UPLOAD_ID,
    finalKey: 'final/original',
  });

  const result = await repositoryFor(fake).commit(
    commitInput({ uploadID: FORGOTTEN_UPLOAD_ID }),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.seq, '1');

  const expired = fake.uploads.get(UPLOAD_ID);
  assert.ok(expired !== undefined);
  expired.state = 'expired';

  await assert.rejects(
    repositoryFor(fake).commit(
      commitInput({ uploadID: FORGOTTEN_UPLOAD_ID }),
    ),
    (error: unknown) =>
      assertRevisionError(error, 'upload-not-ready', 409, false),
  );
});

test('maps missing projects, devices, uploads, and parent mistakes to fixed errors', async () => {
  const cases: Array<{
    readonly name: string;
    readonly arrange: (fake: FakeRevisionPrisma) => void;
    readonly input?: Partial<CommitRevisionInput>;
    readonly code: RevisionRepositoryErrorCode;
    readonly statusCode: number;
  }> = [
    {
      name: 'missing project',
      arrange: () => undefined,
      code: 'project-not-found',
      statusCode: 404,
    },
    {
      name: 'purged project',
      arrange: (fake) => {
        fake.seedProject({ state: 'purged' });
        fake.seedDevice();
        fake.seedUpload();
      },
      code: 'project-not-found',
      statusCode: 404,
    },
    {
      name: 'foreign project',
      arrange: (fake) => {
        fake.seedProject({ userID: OTHER_USER_ID });
        fake.seedDevice();
        fake.seedUpload();
      },
      code: 'project-not-found',
      statusCode: 404,
    },
    {
      name: 'missing device',
      arrange: (fake) => {
        fake.seedProject();
        fake.seedUpload();
      },
      code: 'device-not-found',
      statusCode: 409,
    },
    {
      name: 'missing upload',
      arrange: (fake) => {
        fake.seedProject();
        fake.seedDevice();
      },
      code: 'upload-not-ready',
      statusCode: 409,
    },
    {
      name: 'uploading upload',
      arrange: (fake) => {
        fake.seedProject();
        fake.seedDevice();
        fake.seedUpload({ state: 'uploading' });
      },
      code: 'upload-not-ready',
      statusCode: 409,
    },
    {
      name: 'expired upload',
      arrange: (fake) => {
        fake.seedProject();
        fake.seedDevice();
        fake.seedUpload({ state: 'expired' });
      },
      code: 'upload-not-ready',
      statusCode: 409,
    },
    {
      name: 'revision intent mismatch',
      arrange: (fake) => {
        fake.seedProject();
        fake.seedDevice();
        fake.seedUpload({ revisionID: CHILD_A_ID });
      },
      code: 'upload-not-ready',
      statusCode: 409,
    },
    {
      name: 'parent intent mismatch',
      arrange: (fake) => {
        fake.seedProject();
        fake.seedDevice();
        fake.seedUpload({ parentRevisionID: PARENT_ID });
      },
      code: 'upload-not-ready',
      statusCode: 409,
    },
    {
      name: 'unknown parent',
      arrange: (fake) => {
        fake.seedProject();
        fake.seedDevice();
        fake.seedUpload({ parentRevisionID: PARENT_ID });
      },
      input: { parentRevisionID: PARENT_ID },
      code: 'unknown-parent',
      statusCode: 422,
    },
    {
      name: 'null parent with history',
      arrange: (fake) => {
        fake.seedProject();
        fake.seedDevice();
        fake.seedRevision({ revisionID: PARENT_ID, seq: 1n });
        fake.seedUpload({ parentRevisionID: null });
      },
      code: 'parent-required',
      statusCode: 422,
    },
  ];

  for (const expected of cases) {
    const fake = new FakeRevisionPrisma();
    expected.arrange(fake);
    await assert.rejects(
      repositoryFor(fake).commit(commitInput(expected.input)),
      (error: unknown) => {
        assertRevisionError(
          error,
          expected.code,
          expected.statusCode,
          false,
          [USER_ID, PROJECT_ID, REVISION_ID, UPLOAD_ID, 'postgres://secret'],
        );
        return true;
      },
      expected.name,
    );
  }
});

test('does not delete an expired upload or create revisions on a failed commit', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject();
  fake.seedDevice();
  fake.seedUpload({ state: 'expired' });

  await assert.rejects(
    repositoryFor(fake).commit(commitInput()),
    (error: unknown) =>
      assertRevisionError(error, 'upload-not-ready', 409, false),
  );

  assert.equal(fake.uploads.get(UPLOAD_ID)?.state, 'expired');
  assert.equal(fake.revisions.size, 0);
  assert.deepEqual(fake.headIDs(), []);
  assert.equal(fake.projects.get(PROJECT_ID)?.nextSeq, 1n);
});

test('reports a foreign revision-ID collision generically without reading its row', async () => {
  const foreignSecret = 'foreign-owner-revision-secret';
  const fake = new FakeRevisionPrisma();
  fake.seedProject();
  fake.seedDevice();
  fake.seedUpload();
  fake.revisions.set(REVISION_ID, {
    revisionID: REVISION_ID,
    projectID: OTHER_PROJECT_ID,
    userID: foreignSecret,
    parentRevisionID: null,
    seq: 9n,
    deviceID: OTHER_DEVICE_ID,
    keyEpoch: 3,
    sizeBytes: 9_999n,
    ciphertextSha256: new Uint8Array(OTHER_HASH),
    storageObjectKey: 'foreign/object',
    createdAt: CREATED_AT,
  });

  await assert.rejects(
    repositoryFor(fake).commit(commitInput()),
    (error: unknown) =>
      assertRevisionError(error, 'revision-conflict', 409, false, [
        foreignSecret,
        OTHER_PROJECT_ID,
        OTHER_DEVICE_ID,
        'foreign/object',
      ]),
  );

  assert.equal(fake.order.includes('revision:findFirst'), true);
  assert.equal(fake.order.includes('revision:create'), true);
  assert.equal(fake.order.includes('project:update'), false);
});

test('sanitises unexpected database failures as retryable 503', async () => {
  const secret = 'postgres://secret-user:secret-password@db';
  const fake = new FakeRevisionPrisma({ rawError: new Error(secret) });
  fake.seedProject();
  fake.seedDevice();
  fake.seedUpload();

  await assert.rejects(
    repositoryFor(fake).commit(commitInput()),
    (error: unknown) =>
      assertRevisionError(
        error,
        'repository-unavailable',
        503,
        true,
        [secret, USER_ID, PROJECT_ID],
      ),
  );
});

function seedPageRevisions(fake: FakeRevisionPrisma): string[] {
  const ids: string[] = [];
  for (let index = 1; index <= 5; index += 1) {
    const revisionID = `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
    ids.push(revisionID);
    fake.seedRevision({
      revisionID,
      seq: BigInt(index),
      parentRevisionID: index === 1 ? null : ids[index - 2] ?? null,
      storageObjectKey: `final/${index}`,
      sizeBytes: BigInt(index) * 1_024n,
      createdAt: new Date(CREATED_AT.getTime() + index * 1_000),
    });
  }
  return ids;
}

test('pages accounted revisions in ascending seq with a frozen upper bound and live heads', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 6n });
  const ids = seedPageRevisions(fake);
  fake.addHead(ids[4]!);
  fake.addHead(ids[2]!);

  const page = await repositoryFor(fake).page({
    userID: USER_ID,
    projectID: PROJECT_ID,
    after: '0',
    limit: '2',
  });

  assert.deepEqual(page.upperBound, '5');
  assert.equal(page.nextAfter, '2');
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.currentHeadIDs, [ids[2], ids[4]]);
  assert.deepEqual(
    page.revisions.map((revision) => revision.seq),
    ['1', '2'],
  );
  assert.equal(page.revisions[0]?.parentRevisionID, null);
  assert.equal(page.revisions[1]?.parentRevisionID, ids[0]);
  assert.equal(page.revisions[0]?.ciphertextSha256, Buffer.from(HASH).toString('base64'));
  assert.equal(page.revisions[0]?.sizeBytes, 1_024);
  assert.equal(page.revisions[0]?.createdAt, '2026-10-18T12:00:01.000Z');
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.currentHeadIDs), true);
  assert.equal(Object.isFrozen(page.revisions), true);
  assert.equal(Object.isFrozen(page.revisions[0]), true);

  assert.deepEqual(fake.pageFindManyArgs[0]?.where, {
    projectID: PROJECT_ID,
    userID: USER_ID,
    seq: { gt: 0n, lte: 5n },
  });
  assert.deepEqual(fake.pageFindManyArgs[0]?.orderBy, { seq: 'asc' });
  assert.equal(fake.pageFindManyArgs[0]?.take, 3);
  assert.doesNotThrow(() => JSON.stringify(page));
  const wire = JSON.parse(JSON.stringify(page)) as Record<string, unknown>;
  assert.equal(typeof wire.upperBound, 'string');
  assert.equal(typeof (wire.revisions as Array<Record<string, unknown>>)[0]?.seq, 'string');
  assert.equal(
    typeof (wire.revisions as Array<Record<string, unknown>>)[0]?.sizeBytes,
    'number',
  );
});

test('accepts leading-zero cursors, normalises the anchor, and enforces bounds', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 6n });
  seedPageRevisions(fake);

  const page = await repositoryFor(fake).page({
    userID: USER_ID,
    projectID: PROJECT_ID,
    after: '0001',
    upperBound: '0004',
    limit: '10',
  });

  assert.equal(page.upperBound, '4');
  assert.equal(page.nextAfter, '4');
  assert.equal(page.hasMore, false);
  assert.deepEqual(
    page.revisions.map((revision) => revision.seq),
    ['2', '3', '4'],
  );

  for (const input of [
    { after: '5', upperBound: '4', limit: '1' },
    { after: '6', upperBound: '5', limit: '1' },
    { after: '0', upperBound: '6', limit: '1' },
    { after: '1a', limit: '1' },
    { after: '-1', limit: '1' },
    { after: '1', upperBound: 'x', limit: '1' },
  ]) {
    await assert.rejects(
      repositoryFor(fake).page({
        userID: USER_ID,
        projectID: PROJECT_ID,
        ...input,
      }),
      (error: unknown) =>
        assertRevisionError(error, 'invalid-cursor', 422, false),
      JSON.stringify(input),
    );
  }
});

test('limit zero returns an empty page with existence-based hasMore', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 6n });
  const ids = seedPageRevisions(fake);
  fake.addHead(ids[0]!);

  const page = await repositoryFor(fake).page({
    userID: USER_ID,
    projectID: PROJECT_ID,
    after: '1',
    limit: '0',
  });

  assert.deepEqual(page, {
    upperBound: '5',
    nextAfter: null,
    hasMore: true,
    currentHeadIDs: [ids[0]],
    revisions: [],
  });
  assert.equal(fake.order.includes('revision:findMany'), false);
  assert.equal(fake.order.includes('revision:findFirst'), true);

  const empty = new FakeRevisionPrisma();
  empty.seedProject({ nextSeq: 1n });
  const emptyPage = await repositoryFor(empty).page({
    userID: USER_ID,
    projectID: PROJECT_ID,
    after: '0',
    limit: '0',
  });
  assert.deepEqual(emptyPage, {
    upperBound: '0',
    nextAfter: null,
    hasMore: false,
    currentHeadIDs: [],
    revisions: [],
  });

  const emptyLimit = await repositoryFor(empty).page({
    userID: USER_ID,
    projectID: PROJECT_ID,
    after: '0',
    limit: '10',
  });
  assert.equal(emptyLimit.nextAfter, null);
  assert.equal(emptyLimit.hasMore, false);
  assert.deepEqual(emptyLimit.revisions, []);
});

test('rejects non-canonical, over-cap, and non-string limits without client I/O', async () => {
  const invalidLimits: unknown[] = [
    undefined,
    1,
    0,
    1.0,
    1.5,
    '01',
    '-1',
    '+1',
    '1.0',
    '1e2',
    ' 1',
    '1 ',
    [],
    ['1'],
    '11',
  ];

  for (const limit of invalidLimits) {
    const fake = new FakeRevisionPrisma();
    await assert.rejects(
      repositoryFor(fake, 10).page({
        userID: USER_ID,
        projectID: PROJECT_ID,
        after: '0',
        limit: limit as never,
      }),
      (error: unknown) =>
        assertRevisionError(error, 'invalid-page-limit', 422, false),
      String(limit),
    );
    assert.deepEqual(fake.order, []);
  }
});

test('reads live heads independently of a smaller event anchor', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 6n });
  const ids = seedPageRevisions(fake);
  fake.addHead(ids[4]!);

  const page = await repositoryFor(fake).page({
    userID: USER_ID,
    projectID: PROJECT_ID,
    after: '0',
    upperBound: '2',
    limit: '10',
  });

  assert.equal(page.upperBound, '2');
  assert.deepEqual(
    page.revisions.map((revision) => revision.seq),
    ['1', '2'],
  );
  // Head 5 is after the anchor but still current.
  assert.deepEqual(page.currentHeadIDs, [ids[4]]);
});

test('fails with a fixed internal error when a stored size cannot be a safe JSON number', async () => {
  const fake = new FakeRevisionPrisma();
  fake.seedProject({ nextSeq: 2n });
  fake.seedRevision({
    revisionID: REVISION_ID,
    seq: 1n,
    sizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  });

  await assert.rejects(
    repositoryFor(fake).page({
      userID: USER_ID,
      projectID: PROJECT_ID,
      after: '0',
      limit: '1',
    }),
    (error: unknown) =>
      assertRevisionError(error, 'internal-error', 500, false, [
        String(Number.MAX_SAFE_INTEGER),
      ]),
  );
});

test('scopes pages to the owning active project and sanitises storage failures', async () => {
  for (const overrides of [
    { userID: OTHER_USER_ID },
    { state: 'purged' as const },
  ]) {
    const fake = new FakeRevisionPrisma();
    fake.seedProject({ nextSeq: 2n, ...overrides });
    await assert.rejects(
      repositoryFor(fake).page({
        userID: USER_ID,
        projectID: PROJECT_ID,
        after: '0',
        limit: '1',
      }),
      (error: unknown) =>
        assertRevisionError(error, 'project-not-found', 404, false, [
          USER_ID,
          PROJECT_ID,
        ]),
    );
  }

  const secret = 'raw-database-secret-value';
  const failing = new FakeRevisionPrisma({ rawError: new Error(secret) });
  // page() uses Prisma reads, not raw SQL; force the read path to fail.
  failing.tx.project.findFirst = async () => {
    throw new Error(secret);
  };

  await assert.rejects(
    repositoryFor(failing).page({
      userID: USER_ID,
      projectID: PROJECT_ID,
      after: '0',
      limit: '1',
    }),
    (error: unknown) =>
      assertRevisionError(
        error,
        'repository-unavailable',
        503,
        true,
        [secret, USER_ID, PROJECT_ID],
      ),
  );
});

test('rejects malformed commit inputs without client I/O', async () => {
  const invalidInputs: unknown[] = [
    undefined,
    null,
    [],
    {},
    { ...commitInput(), userID: '' },
    { ...commitInput(), userID: '   ' },
    { ...commitInput(), userID: 'a'.repeat(1_025) },
    { ...commitInput(), userID: 'user\u0000secret' },
    { ...commitInput(), userID: 42 },
    { ...commitInput(), deviceID: 'not-a-uuid' },
    { ...commitInput(), projectID: 'not-a-uuid' },
    { ...commitInput(), revisionID: 'not-a-uuid' },
    { ...commitInput(), uploadID: 'not-a-uuid' },
    { ...commitInput(), parentRevisionID: 'not-a-uuid' },
    { ...commitInput(), parentRevisionID: undefined },
  ];

  for (const input of invalidInputs) {
    const fake = new FakeRevisionPrisma();
    await assert.rejects(
      repositoryFor(fake).commit(input as never),
      (error: unknown) =>
        assertRevisionError(error, 'invalid-revision-input', 422, false),
    );
    assert.deepEqual(fake.order, []);
  }
});

test('rejects malformed page inputs without client I/O', async () => {
  const invalidInputs: unknown[] = [
    undefined,
    null,
    [],
    {},
    { userID: '', projectID: PROJECT_ID, after: '0', limit: '1' },
    { userID: USER_ID, projectID: 'bad', after: '0', limit: '1' },
    { userID: USER_ID, projectID: PROJECT_ID, after: 0, limit: '1' },
  ];

  for (const input of invalidInputs) {
    const fake = new FakeRevisionPrisma();
    await assert.rejects(
      repositoryFor(fake).page(input as never),
      (error: unknown) => {
        assert.ok(error instanceof RevisionRepositoryError);
        return true;
      },
    );
    assert.deepEqual(fake.order, []);
  }
});
