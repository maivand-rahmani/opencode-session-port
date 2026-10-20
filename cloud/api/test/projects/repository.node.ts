import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProjectRepository,
  ProjectRepositoryError,
} from '../../src/projects/repository.js';
import type {
  ProjectRepositoryClient,
  ProjectRepositoryErrorCode,
  ProjectRepositoryOptions,
} from '../../src/projects/repository.js';

/*
 * These are focused unit tests against a small structural Prisma fake. They
 * prove query shape, call ordering, tagged SQL parameters, error sanitising,
 * and byte-copy semantics only.
 *
 * They do NOT prove PostgreSQL row locking, ReadCommitted isolation, real
 * transaction atomicity, Prisma runtime binding, or concurrent behaviour.
 */

const USER_ID = 'user_01HTESTVENDOROPAQUE';
const OTHER_USER_ID = 'user_othersecretvalue';
const PROJECT_ID = '5d4e8c2a-1b3f-4a6d-9e8c-0f1a2b3c4d5e';
const UPPER_PROJECT_ID = PROJECT_ID.toUpperCase();
const OTHER_PROJECT_ID = '7c1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const HEAD_A = '11111111-1111-4111-8111-111111111111';
const HEAD_B = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = new Date('2026-10-18T12:00:00.000Z');
const CREATED_AT_ISO = '2026-10-18T12:00:00.000Z';
const FIXED_MESSAGE = 'Project repository input is invalid.';

const EXPECTED_MESSAGES: Readonly<Record<ProjectRepositoryErrorCode, string>> = {
  'invalid-project-input': FIXED_MESSAGE,
  'active-project-limit-reached': 'The active project limit has been reached.',
  'quota-not-provisioned': 'The user quota is not provisioned.',
  'project-id-unavailable': 'The project identifier is unavailable.',
  'project-purged': 'The project is not active.',
  'repository-unavailable':
    'The project repository is temporarily unavailable.',
};

const PROJECT_SELECT = {
  projectID: true,
  encryptedLabel: true,
  state: true,
  createdAt: true,
};

const PROJECT_LIST_SELECT = {
  projectID: true,
  encryptedLabel: true,
  createdAt: true,
};

const PROJECT_STATE_SELECT = {
  projectID: true,
  encryptedLabel: true,
  createdAt: true,
  _count: { select: { revisions: true } },
  heads: {
    select: { revisionID: true },
    orderBy: { revisionID: 'asc' },
  },
};

interface ProjectRow {
  projectID: string;
  userID?: string;
  encryptedLabel: Uint8Array | null;
  state: 'active' | 'purged';
  createdAt: Date;
  heads?: Array<{ revisionID: string }>;
  _count?: { revisions: number };
}

interface FakeFindFirstArgs {
  where: { projectID: string; userID: string };
  select: Record<string, boolean>;
}

interface FakeCountArgs {
  where: { userID: string; state: 'active' };
}

interface FakeCreateData {
  projectID: string;
  userID: string;
  encryptedLabel: Uint8Array | null;
  state: 'active';
}

interface FakeCreateArgs {
  data: FakeCreateData;
  select: Record<string, boolean>;
}

interface FakeFindManyArgs {
  where: { userID: string; state: 'active' };
  orderBy: { projectID: 'asc' };
  select: Record<string, boolean>;
}

interface RawCall {
  strings: string[];
  values: unknown[];
  sql: string;
}

interface FakePrismaOptions {
  findFirstResults?: Array<ProjectRow | null>;
  activeCount?: number;
  quotaRows?: Array<{ userID: string }>;
  createResult?: (args: FakeCreateArgs) => ProjectRow;
  createError?: unknown;
  findFirstError?: unknown;
  countError?: unknown;
  quotaError?: unknown;
  findManyRows?: ProjectRow[];
  listError?: unknown;
}

interface FakeTransaction {
  project: {
    findFirst(args: FakeFindFirstArgs): Promise<ProjectRow | null>;
    count(args: FakeCountArgs): Promise<number>;
    create(args: FakeCreateArgs): Promise<ProjectRow>;
  };
  $queryRaw<T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
}

class FakePrisma {
  readonly order: string[] = [];
  readonly findFirstCalls: FakeFindFirstArgs[] = [];
  readonly countCalls: FakeCountArgs[] = [];
  readonly createCalls: FakeCreateArgs[] = [];
  readonly findManyCalls: FakeFindManyArgs[] = [];
  readonly rawCalls: RawCall[] = [];
  readonly transactionOptions: unknown[] = [];

  readonly tx: FakeTransaction;
  readonly project: {
    findMany(args: FakeFindManyArgs): Promise<ProjectRow[]>;
  };

  private readonly options: FakePrismaOptions;
  private readonly findFirstResults: Array<ProjectRow | null>;

  constructor(options: FakePrismaOptions = {}) {
    this.options = options;
    this.findFirstResults = [...(options.findFirstResults ?? [])];

    this.tx = {
      project: {
        findFirst: async (args) => {
          this.order.push(`findFirst:${this.findFirstCalls.length + 1}`);
          this.findFirstCalls.push(args);
          if (this.options.findFirstError !== undefined) {
            throw this.options.findFirstError;
          }
          return this.findFirstResults.shift() ?? null;
        },
        count: async (args) => {
          this.order.push('count');
          this.countCalls.push(args);
          if (this.options.countError !== undefined) {
            throw this.options.countError;
          }
          return this.options.activeCount ?? 0;
        },
        create: async (args) => {
          this.order.push('create');
          this.createCalls.push(args);
          if (this.options.createError !== undefined) {
            throw this.options.createError;
          }
          if (this.options.createResult !== undefined) {
            return this.options.createResult(args);
          }
          return projectRow({
            projectID: args.data.projectID,
            userID: args.data.userID,
            encryptedLabel: args.data.encryptedLabel,
            state: 'active',
            createdAt: CREATED_AT,
          });
        },
      },
      $queryRaw: async <T,>(
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<T> => {
        this.order.push('quota-lock');
        this.rawCalls.push({
          strings: Array.from(strings),
          values,
          sql: normalizeSql(strings),
        });
        if (this.options.quotaError !== undefined) {
          throw this.options.quotaError;
        }
        return (this.options.quotaRows ?? [{ userID: USER_ID }]) as unknown as T;
      },
    };

    this.project = {
      findMany: async (args) => {
        this.order.push('findMany');
        this.findManyCalls.push(args);
        if (this.options.listError !== undefined) {
          throw this.options.listError;
        }
        return this.options.findManyRows ?? [];
      },
    };
  }

  async $transaction<T>(
    operation: (transaction: FakeTransaction) => Promise<T>,
    options?: unknown,
  ): Promise<T> {
    this.transactionOptions.push(options);
    return operation(this.tx);
  }
}

function projectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    projectID: PROJECT_ID,
    userID: USER_ID,
    encryptedLabel: Uint8Array.from([10, 20, 30]),
    state: 'active',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function fakeClient(fake: FakePrisma): ProjectRepositoryClient {
  return fake as unknown as ProjectRepositoryClient;
}

function repositoryFor(fake: FakePrisma, maxActiveProjects = 3) {
  return createProjectRepository(fakeClient(fake), { maxActiveProjects });
}

function normalizeSql(strings: readonly string[]): string {
  return strings.join('?').replace(/\s+/g, ' ').trim();
}

function assertRepositoryError(
  error: unknown,
  code: ProjectRepositoryErrorCode,
  statusCode: number,
  retryable: boolean,
  secrets: readonly string[] = [],
): boolean {
  assert.ok(error instanceof ProjectRepositoryError);
  assert.equal(error.name, 'ProjectRepositoryError');
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

function invalidInput(): (error: unknown) => boolean {
  return (error: unknown) =>
    assertRepositoryError(error, 'invalid-project-input', 422, false);
}

test('requires an explicit positive safe-integer cap and touches no client when invalid', () => {
  const invalidOptions: unknown[] = [
    undefined,
    null,
    {},
    [],
    { maxActiveProjects: 0 },
    { maxActiveProjects: -1 },
    { maxActiveProjects: 1.5 },
    { maxActiveProjects: Number.NaN },
    { maxActiveProjects: Number.POSITIVE_INFINITY },
    { maxActiveProjects: Number.MAX_SAFE_INTEGER + 1 },
    { maxActiveProjects: '10' },
    { maxActiveProjects: 10n },
    { maxActiveProjects: true },
    { maxActiveProjects: undefined },
    { maxActiveProjects: null },
  ];
  const secret = 'secret-max-active-value';

  for (const options of invalidOptions) {
    const fake = new FakePrisma();
    assert.throws(
      () =>
        createProjectRepository(
          fakeClient(fake),
          options as ProjectRepositoryOptions,
        ),
      (error: unknown) => {
        assertRepositoryError(error, 'invalid-project-input', 422, false, [
          secret,
        ]);
        return true;
      },
    );
    assert.deepEqual(fake.order, []);
    assert.deepEqual(fake.findFirstCalls, []);
    assert.deepEqual(fake.rawCalls, []);
  }

  const valid = new FakePrisma();
  const repository = createProjectRepository(fakeClient(valid), {
    maxActiveProjects: 1,
  });
  assert.equal(typeof repository.createOrLink, 'function');
  assert.equal(typeof repository.listActive, 'function');
  assert.deepEqual(valid.order, []);
});

test('creates a project at 201 after locking quota and counting active projects', async () => {
  const fake = new FakePrisma({
    findFirstResults: [null, null],
    activeCount: 0,
    quotaRows: [{ userID: USER_ID }],
  });
  const repository = createProjectRepository(fakeClient(fake), {
    maxActiveProjects: 3,
  });
  const label = Uint8Array.from([1, 2, 3, 255]);

  const result = await repository.createOrLink({
    userID: USER_ID,
    projectID: UPPER_PROJECT_ID,
    encryptedLabel: label,
  });

  assert.deepEqual(fake.order, [
    'findFirst:1',
    'quota-lock',
    'findFirst:2',
    'count',
    'create',
  ]);
  assert.deepEqual(fake.transactionOptions, [
    { isolationLevel: 'ReadCommitted' },
  ]);

  assert.deepEqual(fake.findFirstCalls[0], {
    where: { projectID: PROJECT_ID, userID: USER_ID },
    select: PROJECT_SELECT,
  });
  assert.deepEqual(fake.findFirstCalls[1], {
    where: { projectID: PROJECT_ID, userID: USER_ID },
    select: PROJECT_SELECT,
  });
  assert.deepEqual(fake.countCalls, [
    { where: { userID: USER_ID, state: 'active' } },
  ]);

  assert.equal(fake.rawCalls.length, 1);
  assert.deepEqual(fake.rawCalls[0].values, [USER_ID]);
  assert.equal(fake.rawCalls[0].strings.includes(USER_ID), false);
  assert.equal(
    fake.rawCalls[0].sql,
    'SELECT "userID" FROM "UserQuota" WHERE "userID" = ? FOR UPDATE',
  );

  assert.equal(fake.createCalls.length, 1);
  assert.deepEqual(fake.createCalls[0], {
    data: {
      projectID: PROJECT_ID,
      userID: USER_ID,
      encryptedLabel: label,
      state: 'active',
    },
    select: PROJECT_SELECT,
  });
  assert.notStrictEqual(fake.createCalls[0].data.encryptedLabel, label);
  assert.deepEqual(Object.keys(fake.createCalls[0].data).sort(), [
    'encryptedLabel',
    'projectID',
    'state',
    'userID',
  ]);

  assert.equal(result.outcome, 'created');
  assert.equal(result.statusCode, 201);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.project), true);
  assert.deepEqual(Object.keys(result.project).sort(), [
    'createdAt',
    'encryptedLabel',
    'projectID',
  ]);
  assert.equal(result.project.projectID, PROJECT_ID);
  assert.equal(result.project.createdAt, CREATED_AT_ISO);
  assert.deepEqual(result.project.encryptedLabel, label);
  assert.notStrictEqual(result.project.encryptedLabel, label);
  assert.notStrictEqual(
    result.project.encryptedLabel,
    fake.createCalls[0].data.encryptedLabel,
  );
  assert.equal('headIDs' in result.project, false);
  assert.equal('revisionCount' in result.project, false);
});

test('links an existing active project at 200 without count, quota, or metadata writes', async () => {
  const existing = projectRow({
    encryptedLabel: Uint8Array.from([9, 9, 9]),
  });
  const fake = new FakePrisma({
    findFirstResults: [existing],
    activeCount: 99,
    quotaRows: [],
  });
  const repository = createProjectRepository(fakeClient(fake), {
    maxActiveProjects: 1,
  });

  const result = await repository.createOrLink({
    userID: USER_ID,
    projectID: PROJECT_ID,
    encryptedLabel: Uint8Array.from([1, 1, 1]),
  });

  assert.equal(result.outcome, 'linked');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.project.encryptedLabel, Uint8Array.from([9, 9, 9]));
  assert.deepEqual(fake.order, ['findFirst:1']);
  assert.equal(fake.rawCalls.length, 0);
  assert.equal(fake.countCalls.length, 0);
  assert.equal(fake.createCalls.length, 0);
  assert.equal('update' in fake.tx.project, false);
});

test('rechecks the caller project after the quota lock and links a concurrent create', async () => {
  const existing = projectRow({
    encryptedLabel: Uint8Array.from([7, 8]),
  });
  const fake = new FakePrisma({
    findFirstResults: [null, existing],
    activeCount: 1,
    quotaRows: [{ userID: USER_ID }],
  });
  const repository = createProjectRepository(fakeClient(fake), {
    maxActiveProjects: 1,
  });

  const result = await repository.createOrLink({
    userID: USER_ID,
    projectID: PROJECT_ID,
    encryptedLabel: Uint8Array.from([1, 2]),
  });

  assert.equal(result.outcome, 'linked');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.project.encryptedLabel, Uint8Array.from([7, 8]));
  assert.deepEqual(fake.order, [
    'findFirst:1',
    'quota-lock',
    'findFirst:2',
  ]);
  assert.equal(fake.countCalls.length, 0);
  assert.equal(fake.createCalls.length, 0);
});

test('treats a purged own project as a conflict without locking quota', async () => {
  const fake = new FakePrisma({
    findFirstResults: [projectRow({ state: 'purged' })],
    quotaRows: [{ userID: USER_ID }],
  });
  const repository = repositoryFor(fake);

  await assert.rejects(
    repository.createOrLink({
      userID: USER_ID,
      projectID: PROJECT_ID,
      encryptedLabel: Uint8Array.from([1]),
    }),
    (error: unknown) =>
      assertRepositoryError(error, 'project-purged', 409, false, [
        USER_ID,
        PROJECT_ID,
      ]),
  );

  assert.deepEqual(fake.order, ['findFirst:1']);
  assert.equal(fake.rawCalls.length, 0);
  assert.equal(fake.createCalls.length, 0);
});

test('rejects a purged project found by the post-lock recheck', async () => {
  const fake = new FakePrisma({
    findFirstResults: [null, projectRow({ state: 'purged' })],
    quotaRows: [{ userID: USER_ID }],
  });
  const repository = repositoryFor(fake);

  await assert.rejects(
    repository.createOrLink({
      userID: USER_ID,
      projectID: PROJECT_ID,
    }),
    (error: unknown) =>
      assertRepositoryError(error, 'project-purged', 409, false),
  );

  assert.deepEqual(fake.order, [
    'findFirst:1',
    'quota-lock',
    'findFirst:2',
  ]);
  assert.equal(fake.countCalls.length, 0);
  assert.equal(fake.createCalls.length, 0);
});

test('denies creation at the explicit cap after the locked active count', async () => {
  const fake = new FakePrisma({
    findFirstResults: [null, null],
    activeCount: 1,
    quotaRows: [{ userID: USER_ID }],
  });
  const repository = createProjectRepository(fakeClient(fake), {
    maxActiveProjects: 1,
  });

  await assert.rejects(
    repository.createOrLink({
      userID: USER_ID,
      projectID: PROJECT_ID,
    }),
    (error: unknown) =>
      assertRepositoryError(error, 'active-project-limit-reached', 409, false),
  );

  assert.deepEqual(fake.order, [
    'findFirst:1',
    'quota-lock',
    'findFirst:2',
    'count',
  ]);
  assert.equal(fake.createCalls.length, 0);
});

test('fails closed when the quota row is missing and creates no quota', async () => {
  const fake = new FakePrisma({
    findFirstResults: [null],
    quotaRows: [],
  });
  const repository = repositoryFor(fake);

  await assert.rejects(
    repository.createOrLink({
      userID: USER_ID,
      projectID: PROJECT_ID,
      encryptedLabel: Uint8Array.from([4, 5]),
    }),
    (error: unknown) =>
      assertRepositoryError(error, 'quota-not-provisioned', 500, false, [
        USER_ID,
        PROJECT_ID,
      ]),
  );

  assert.deepEqual(fake.order, ['findFirst:1', 'quota-lock']);
  assert.equal(fake.countCalls.length, 0);
  assert.equal(fake.createCalls.length, 0);
  assert.equal(fake.rawCalls.length, 1);
  assert.equal(
    fake.rawCalls[0].sql,
    'SELECT "userID" FROM "UserQuota" WHERE "userID" = ? FOR UPDATE',
  );
});

test('maps a projectID P2002 collision to a generic conflict without reading the foreign row', async () => {
  const foreignSecret = 'foreign-owner-secret-value';
  const fake = new FakePrisma({
    findFirstResults: [null, null],
    activeCount: 0,
    quotaRows: [{ userID: USER_ID }],
    createError: {
      code: 'P2002',
      message: foreignSecret,
      meta: { modelName: 'Project', target: ['projectID'] },
    },
  });
  const repository = repositoryFor(fake);

  await assert.rejects(
    repository.createOrLink({
      userID: USER_ID,
      projectID: PROJECT_ID,
    }),
    (error: unknown) => {
      assertRepositoryError(error, 'project-id-unavailable', 409, false, [
        foreignSecret,
        USER_ID,
        PROJECT_ID,
      ]);
      assert.equal('project' in (error as object), false);
      return true;
    },
  );

  assert.deepEqual(fake.order, [
    'findFirst:1',
    'quota-lock',
    'findFirst:2',
    'count',
    'create',
  ]);
  assert.equal(fake.findFirstCalls.length, 2);
  assert.equal(fake.rawCalls.length, 1);
});

test('binds userID in the tagged quota SQL and never interpolates SQL text', async () => {
  const injectedUserID = `user_01'; DROP TABLE "UserQuota"; --`;
  const fake = new FakePrisma({
    findFirstResults: [null, null],
    activeCount: 0,
    quotaRows: [{ userID: injectedUserID }],
  });
  const repository = repositoryFor(fake);

  await repository.createOrLink({
    userID: injectedUserID,
    projectID: PROJECT_ID,
  });

  assert.deepEqual(fake.rawCalls[0].values, [injectedUserID]);
  assert.equal(fake.rawCalls[0].strings.includes(injectedUserID), false);
  assert.equal(
    fake.rawCalls[0].sql,
    'SELECT "userID" FROM "UserQuota" WHERE "userID" = ? FOR UPDATE',
  );
  assert.equal(fake.findFirstCalls[0].where.userID, injectedUserID);
});

test('sanitises unexpected create/link and list failures as retryable 503', async () => {
  const databaseSecret = 'postgres://secret-user:secret-password@db';
  const createFake = new FakePrisma({
    findFirstResults: [null],
    findFirstError: new Error(databaseSecret),
  });
  await assert.rejects(
    repositoryFor(createFake).createOrLink({
      userID: USER_ID,
      projectID: PROJECT_ID,
    }),
    (error: unknown) =>
      assertRepositoryError(
        error,
        'repository-unavailable',
        503,
        true,
        [databaseSecret, USER_ID, PROJECT_ID],
      ),
  );

  const listFake = new FakePrisma({
    listError: { code: 'XX000', message: databaseSecret },
  });
  await assert.rejects(
    repositoryFor(listFake).listActive({ userID: USER_ID }),
    (error: unknown) =>
      assertRepositoryError(
        error,
        'repository-unavailable',
        503,
        true,
        [databaseSecret, USER_ID],
      ),
  );
});

test('copies encryptedLabel in both directions and freezes DTOs', async () => {
  const input = Uint8Array.from([1, 2, 3, 4]);
  const createFake = new FakePrisma({
    findFirstResults: [null, null],
    activeCount: 0,
    quotaRows: [{ userID: USER_ID }],
  });
  const created = await repositoryFor(createFake).createOrLink({
    userID: USER_ID,
    projectID: PROJECT_ID,
    encryptedLabel: input,
  });

  const stored = createFake.createCalls[0].data.encryptedLabel;
  assert.ok(stored instanceof Uint8Array);
  assert.notStrictEqual(stored, input);

  input.fill(0);
  assert.deepEqual(stored, Uint8Array.from([1, 2, 3, 4]));

  const returned = created.project.encryptedLabel;
  assert.ok(returned instanceof Uint8Array);
  assert.notStrictEqual(returned, stored);
  returned.fill(9);
  assert.deepEqual(stored, Uint8Array.from([1, 2, 3, 4]));

  const existing = projectRow({
    encryptedLabel: Uint8Array.from([7, 8]),
  });
  const linkFake = new FakePrisma({ findFirstResults: [existing] });
  const linked = await repositoryFor(linkFake).createOrLink({
    userID: USER_ID,
    projectID: PROJECT_ID,
    encryptedLabel: Uint8Array.from([5, 6]),
  });
  assert.ok(linked.project.encryptedLabel instanceof Uint8Array);
  linked.project.encryptedLabel.fill(0);
  assert.deepEqual(existing.encryptedLabel, Uint8Array.from([7, 8]));

  const listFake = new FakePrisma({ findManyRows: [existing] });
  const listed = await repositoryFor(listFake).listActive({
    userID: USER_ID,
  });
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(Object.isFrozen(listed[0]), true);
  assert.ok(listed[0].encryptedLabel instanceof Uint8Array);
  listed[0].encryptedLabel.fill(1);
  assert.deepEqual(existing.encryptedLabel, Uint8Array.from([7, 8]));
});

test('stores null when encryptedLabel is omitted and invents no plaintext fields', async () => {
  const fake = new FakePrisma({
    findFirstResults: [null, null],
    activeCount: 0,
    quotaRows: [{ userID: USER_ID }],
  });

  const result = await repositoryFor(fake).createOrLink({
    userID: USER_ID,
    projectID: PROJECT_ID,
  });

  assert.equal(result.project.encryptedLabel, null);
  assert.equal(fake.createCalls[0].data.encryptedLabel, null);
  const dataKeys = Object.keys(fake.createCalls[0].data).sort();
  assert.deepEqual(dataKeys, [
    'encryptedLabel',
    'projectID',
    'state',
    'userID',
  ]);
  for (const forbidden of ['label', 'name', 'username', 'path', 'plaintext']) {
    assert.equal(dataKeys.includes(forbidden), false);
  }
});

test('lists only the caller active projects ordered by projectID without truncation', async () => {
  const first = projectRow({
    projectID: OTHER_PROJECT_ID,
    encryptedLabel: Uint8Array.from([4, 4]),
  });
  const second = projectRow({
    projectID: PROJECT_ID,
    encryptedLabel: null,
  });
  const fake = new FakePrisma({
    findManyRows: [first, second],
  });

  const result = await repositoryFor(fake).listActive({
    userID: USER_ID,
  });

  assert.deepEqual(fake.findManyCalls, [
    {
      where: { userID: USER_ID, state: 'active' },
      orderBy: { projectID: 'asc' },
      select: PROJECT_LIST_SELECT,
    },
  ]);
  const args = fake.findManyCalls[0];
  assert.deepEqual(Object.keys(args).sort(), ['orderBy', 'select', 'where']);
  assert.equal('take' in args, false);
  assert.equal('skip' in args, false);
  assert.equal('cursor' in args, false);

  assert.deepEqual(
    result.map((project) => project.projectID),
    [OTHER_PROJECT_ID, PROJECT_ID],
  );
  assert.equal(result[0].createdAt, CREATED_AT_ISO);
  assert.deepEqual(result[0].encryptedLabel, Uint8Array.from([4, 4]));
  assert.equal(result[1].encryptedLabel, null);
  for (const project of result) {
    assert.deepEqual(Object.keys(project).sort(), [
      'createdAt',
      'encryptedLabel',
      'projectID',
    ]);
    assert.equal('headIDs' in project, false);
    assert.equal('revisionCount' in project, false);
  }
});

test('lists actual heads and revision counts without changing the listActive DTO', async () => {
  const first = projectRow({
    projectID: OTHER_PROJECT_ID,
    encryptedLabel: Uint8Array.from([4, 4]),
    heads: [{ revisionID: HEAD_B }, { revisionID: HEAD_A }],
    _count: { revisions: 3 },
  });
  const second = projectRow({
    projectID: PROJECT_ID,
    encryptedLabel: null,
    heads: [],
    _count: { revisions: 0 },
  });
  const fake = new FakePrisma({ findManyRows: [first, second] });

  const result = await repositoryFor(fake).listWithState!({
    userID: USER_ID,
  });

  assert.deepEqual(fake.findManyCalls, [
    {
      where: { userID: USER_ID, state: 'active' },
      orderBy: { projectID: 'asc' },
      select: PROJECT_STATE_SELECT,
    },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(Object.keys(result[0] ?? {}).sort(), [
    'createdAt',
    'encryptedLabel',
    'headIDs',
    'projectID',
    'revisionCount',
  ]);
  assert.equal(result[0]?.projectID, OTHER_PROJECT_ID);
  assert.deepEqual(result[0]?.headIDs, [HEAD_A, HEAD_B]);
  assert.equal(result[0]?.revisionCount, 3);
  assert.deepEqual(result[0]?.encryptedLabel, Uint8Array.from([4, 4]));
  assert.deepEqual(result[1]?.headIDs, []);
  assert.equal(result[1]?.revisionCount, 0);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
  assert.equal(Object.isFrozen(result[0]?.headIDs), true);

  // The pre-existing list contract remains exactly three fields, with no
  // synthesised head or count placeholders.
  const legacy = await repositoryFor(fake).listActive({ userID: USER_ID });
  for (const project of legacy) {
    assert.deepEqual(Object.keys(project).sort(), [
      'createdAt',
      'encryptedLabel',
      'projectID',
    ]);
  }
});

test('returns a frozen empty list when the caller has no active projects', async () => {
  const fake = new FakePrisma({ findManyRows: [] });
  const result = await repositoryFor(fake).listActive({ userID: USER_ID });

  assert.deepEqual(result, []);
  assert.equal(Object.isFrozen(result), true);
});

test('rejects malformed create/link inputs through unknown casts without client I/O', async () => {
  const invalidInputs: unknown[] = [
    undefined,
    null,
    0,
    'project',
    [],
    {},
    { userID: '', projectID: PROJECT_ID },
    { userID: '   ', projectID: PROJECT_ID },
    { userID: 'a'.repeat(1_025), projectID: PROJECT_ID },
    { userID: `user\u0000secret`, projectID: PROJECT_ID },
    { userID: 42, projectID: PROJECT_ID },
    { userID: new String(USER_ID), projectID: PROJECT_ID },
    { userID: USER_ID, projectID: '' },
    { userID: USER_ID, projectID: PROJECT_ID.replaceAll('-', '') },
    { userID: USER_ID, projectID: `{${PROJECT_ID}}` },
    { userID: USER_ID, projectID: `urn:uuid:${PROJECT_ID}` },
    { userID: USER_ID, projectID: `${PROJECT_ID}0` },
    { userID: USER_ID, projectID: PROJECT_ID.replace('5d', 'zz') },
    { userID: USER_ID, projectID: 42 },
    { userID: USER_ID, projectID: new String(PROJECT_ID) },
    { userID: USER_ID, projectID: PROJECT_ID, encryptedLabel: null },
    { userID: USER_ID, projectID: PROJECT_ID, encryptedLabel: [] },
    {
      userID: USER_ID,
      projectID: PROJECT_ID,
      encryptedLabel: new ArrayBuffer(3),
    },
    {
      userID: USER_ID,
      projectID: PROJECT_ID,
      encryptedLabel: new DataView(new ArrayBuffer(3)),
    },
    { userID: USER_ID, projectID: PROJECT_ID, encryptedLabel: 'label' },
    {
      userID: USER_ID,
      projectID: PROJECT_ID,
      encryptedLabel: { 0: 1, length: 1 },
    },
  ];

  for (const input of invalidInputs) {
    const fake = new FakePrisma({
      findFirstResults: [null, null],
      quotaRows: [{ userID: USER_ID }],
    });
    const repository = repositoryFor(fake);
    await assert.rejects(
      repository.createOrLink(input as never),
      invalidInput(),
    );
    assert.deepEqual(fake.order, []);
  }
});

test('rejects malformed list inputs through unknown casts without client I/O', async () => {
  const invalidInputs: unknown[] = [
    undefined,
    null,
    0,
    [],
    {},
    { userID: '' },
    { userID: '   ' },
    { userID: 'a'.repeat(1_025) },
    { userID: 'user\u007fsecret' },
    { userID: 7 },
    { userID: new String(USER_ID) },
  ];

  for (const input of invalidInputs) {
    const fake = new FakePrisma();
    const repository = repositoryFor(fake);
    await assert.rejects(
      repository.listActive(input as never),
      invalidInput(),
    );
    assert.deepEqual(fake.order, []);
  }
});

test('accepts opaque non-UUID user IDs without rewriting them', async () => {
  const opaqueUserID = 'User_ABC.vendor/opaque:01';
  const existing = projectRow({ userID: opaqueUserID });
  const fake = new FakePrisma({ findFirstResults: [existing] });
  const result = await repositoryFor(fake).createOrLink({
    userID: opaqueUserID,
    projectID: PROJECT_ID,
  });

  assert.equal(result.outcome, 'linked');
  assert.equal(fake.findFirstCalls[0].where.userID, opaqueUserID);
  assert.equal(fake.findFirstCalls[0].where.projectID, PROJECT_ID);
});

test('fixed input errors never echo rejected identifiers, labels, or options', async () => {
  const secret = 'secret-input-value-5f3c';
  const invalidInputs: unknown[] = [
    { userID: `${secret}\u0000`, projectID: PROJECT_ID },
    { userID: USER_ID, projectID: `${secret}` },
    {
      userID: USER_ID,
      projectID: PROJECT_ID,
      encryptedLabel: secret,
    },
    { userID: secret, projectID: PROJECT_ID, encryptedLabel: [secret] },
  ];

  for (const input of invalidInputs) {
    const fake = new FakePrisma();
    const repository = repositoryFor(fake);
    await assert.rejects(
      repository.createOrLink(input as never),
      (error: unknown) => {
        assertRepositoryError(error, 'invalid-project-input', 422, false, [
          secret,
        ]);
        return true;
      },
    );
    assert.deepEqual(fake.order, []);
  }
});
