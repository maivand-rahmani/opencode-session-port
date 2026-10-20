import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';

import { createApi } from '../../src/app.js';
import type { ApiConfig } from '../../src/config.js';
import { toApiErrorResponse } from '../../src/errors.js';
import type {
  AuthorizeRequest,
  RequestPrincipal,
} from '../../src/protocol/principal.js';
import {
  ProjectRepositoryError,
  type CreateOrLinkInput,
  type CreateOrLinkResult,
  type ListWithStateInput,
  type ProjectRepository,
  type ProjectStateDTO,
} from '../../src/projects/repository.js';
import {
  registerProjectListRoute,
  type AuthorizedProjectPrincipal,
  type ProjectListRepository,
} from '../../src/projects/routes.js';

/*
 * Focused route tests against Fastify's inject() with synthetic authorizers and
 * repositories. They do not open a socket, connect to PostgreSQL, implement
 * native authentication, or validate any real bearer token/cookie grant.
 */

const TEST_CONFIG: ApiConfig = {
  host: '127.0.0.1',
  port: 43123,
  publicOrigin: 'https://api.example.test',
  bodyLimitBytes: 1024,
  readinessTimeoutMs: 50,
  retryAfterSeconds: 7,
};

const USER_ID = 'user_01HTRUSTEDAUTHORIZER';
const OTHER_USER_ID = 'user_01HOTHERAUTHORIZER';
const PROJECT_ID = '5d4e8c2a-1b3f-4a6d-9e8c-0f1a2b3c4d5e';
const OTHER_PROJECT_ID = '7c1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const DEVICE_ID = '44aa2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const HEAD_A = '11111111-1111-4111-8111-111111111111';
const HEAD_B = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-10-18T12:00:00.000Z';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ErrorPayload {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestID: string;
  };
}

class FakeProjectRepository implements ProjectRepository {
  readonly calls: CreateOrLinkInput[] = [];
  error: unknown = undefined;
  private readonly resultFactory: (
    input: CreateOrLinkInput,
  ) => CreateOrLinkResult;

  constructor(options: {
    readonly resultFactory?: (input: CreateOrLinkInput) => CreateOrLinkResult;
  } = {}) {
    this.resultFactory = options.resultFactory ?? createdResult;
  }

  async createOrLink(input: CreateOrLinkInput): Promise<CreateOrLinkResult> {
    this.calls.push(input);
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.resultFactory(input);
  }

  async listActive(): Promise<readonly never[]> {
    return [];
  }
}

function createdResult(input: CreateOrLinkInput): CreateOrLinkResult {
  return {
    outcome: 'created',
    statusCode: 201,
    project: {
      projectID: input.projectID,
      encryptedLabel: input.encryptedLabel ?? null,
      createdAt: CREATED_AT,
    },
  };
}

function linkedResult(
  encryptedLabel: Uint8Array | null,
): (input: CreateOrLinkInput) => CreateOrLinkResult {
  return (input) => ({
    outcome: 'linked',
    statusCode: 200,
    project: {
      projectID: input.projectID,
      encryptedLabel,
      createdAt: CREATED_AT,
    },
  });
}

type AuthorizeCreate = (
  request: FastifyRequest,
) => Promise<AuthorizedProjectPrincipal | null>;

interface TestAppOptions {
  readonly repository?: ProjectRepository;
  readonly authorizeCreate?: AuthorizeCreate;
}

function makeApp(t: TestContext, options: TestAppOptions = {}): FastifyInstance {
  const app = createApi({
    config: TEST_CONFIG,
    projects: {
      repository: options.repository ?? new FakeProjectRepository(),
      authorizeCreate:
        options.authorizeCreate ?? (async () => ({ userID: USER_ID })),
    },
  });
  t.after(async () => {
    await app.close();
  });
  return app;
}

function makeDefaultApp(t: TestContext): FastifyInstance {
  const app = createApi({ config: TEST_CONFIG });
  t.after(async () => {
    await app.close();
  });
  return app;
}

class FakeStateProjectRepository implements ProjectRepository {
  readonly stateCalls: ListWithStateInput[] = [];
  rows: readonly ProjectStateDTO[] = [];
  listError: unknown = undefined;

  async createOrLink(): Promise<never> {
    throw new Error('not used');
  }

  async listActive(): Promise<readonly never[]> {
    return [];
  }

  async listWithState(
    input: ListWithStateInput,
  ): Promise<readonly ProjectStateDTO[]> {
    this.stateCalls.push(input);
    if (this.listError !== undefined) {
      throw this.listError;
    }
    return this.rows;
  }
}

interface ListAppOptions {
  readonly repository?: ProjectListRepository;
  readonly authorize?: AuthorizeRequest;
}

function makeListApp(
  t: TestContext,
  options: ListAppOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toApiErrorResponse(error, request.id);
    if (mapped.statusCode === 503) {
      void reply.header('Retry-After', '7');
    }
    void reply.code(mapped.statusCode).send(mapped.envelope);
  });

  registerProjectListRoute(
    app,
    {
      repository: options.repository ?? new FakeStateProjectRepository(),
      authorize:
        options.authorize ?? (async () => browserPrincipal()),
    },
    { retryAfterSeconds: 7 },
  );

  t.after(async () => {
    await app.close();
  });
  return app;
}

function browserPrincipal(userID = USER_ID): RequestPrincipal {
  return { kind: 'browser', userID };
}

function stateProjectRow(
  overrides: Partial<ProjectStateDTO> = {},
): ProjectStateDTO {
  return {
    projectID: PROJECT_ID,
    encryptedLabel: Uint8Array.from([1, 2, 3]),
    createdAt: CREATED_AT,
    headIDs: [HEAD_A, HEAD_B],
    revisionCount: 3,
    ...overrides,
  };
}

function errorPayload(body: string): ErrorPayload {
  return JSON.parse(body) as ErrorPayload;
}

function validBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { projectID: PROJECT_ID, ...overrides };
}

test('rejects malformed projects dependencies at construction', () => {
  const repository = new FakeProjectRepository();
  const fixedMessage = /Invalid projects API dependency\./;

  assert.throws(
    () => createApi({ config: TEST_CONFIG, projects: null as never }),
    fixedMessage,
  );
  assert.throws(
    () => createApi({ config: TEST_CONFIG, projects: {} as never }),
    fixedMessage,
  );
  assert.throws(
    () =>
      createApi({
        config: TEST_CONFIG,
        projects: {
          repository: {},
          authorizeCreate: async () => ({ userID: USER_ID }),
        } as never,
      }),
    fixedMessage,
  );
  assert.throws(
    () =>
      createApi({
        config: TEST_CONFIG,
        projects: {
          repository: {
            createOrLink: repository.createOrLink,
          },
          authorizeCreate: async () => ({ userID: USER_ID }),
        } as never,
      }),
    fixedMessage,
  );
  assert.throws(
    () =>
      createApi({
        config: TEST_CONFIG,
        projects: {
          repository,
          authorizeCreate: null,
        } as never,
      }),
    fixedMessage,
  );
});

test('default app keeps the original 401 gate for POST /v1/projects', async (t) => {
  const app = makeDefaultApp(t);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: {
      authorization: 'Bearer synthetic-device-token',
      cookie: 'session=synthetic-cookie',
      'x-user-id': USER_ID,
      'request-id': 'attacker-supplied',
    },
    payload: validBody({ label: 'AQID', userID: USER_ID }),
  });

  assert.equal(response.statusCode, 401);
  const payload = errorPayload(response.body);
  assert.equal(payload.error.code, 'unauthenticated');
  assert.equal(payload.error.message, 'Authentication is required.');
  assert.equal(payload.error.retryable, false);
  assert.match(payload.error.requestID, UUID_V4);
  assert.ok(!response.body.includes(USER_ID));
  assert.ok(!response.body.includes('attacker-supplied'));
});

test('no environment switch enables the default project gate', async (t) => {
  const key = 'SESSIONPORT_PROJECTS_AUTHORIZE_ALL';
  const saved = process.env[key];
  process.env[key] = '1';

  try {
    const app = makeDefaultApp(t);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: validBody(),
    });

    assert.equal(response.statusCode, 401);
    assert.equal(errorPayload(response.body).error.code, 'unauthenticated');
  } finally {
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
});

test('creates a project with the authorizer principal and base64 label', async (t) => {
  const repository = new FakeProjectRepository();
  const seenRequests: FastifyRequest[] = [];
  const app = makeApp(t, {
    repository,
    authorizeCreate: async (request) => {
      seenRequests.push(request);
      return { userID: USER_ID };
    },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: validBody({ label: 'AQID' }),
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), {
    projectID: PROJECT_ID,
    encryptedLabel: 'AQID',
    createdAt: CREATED_AT,
  });
  assert.ok(!response.body.includes(USER_ID));

  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0]?.method, 'POST');
  assert.equal(seenRequests[0]?.url, '/v1/projects');

  assert.equal(repository.calls.length, 1);
  const call = repository.calls[0];
  assert.equal(call?.userID, USER_ID);
  assert.equal(call?.projectID, PROJECT_ID);
  assert.ok(call?.encryptedLabel instanceof Uint8Array);
  assert.deepEqual(Array.from(call?.encryptedLabel ?? []), [1, 2, 3]);
});

test('maps an idempotent link to 200 without returning repository internals', async (t) => {
  const existingLabel = new Uint8Array([9, 9]);
  const repository = new FakeProjectRepository({
    resultFactory: linkedResult(existingLabel),
  });
  const app = makeApp(t, { repository });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: validBody({ label: 'bmV3' }),
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as Record<string, unknown>;
  assert.deepEqual(body, {
    projectID: PROJECT_ID,
    encryptedLabel: 'CQk=',
    createdAt: CREATED_AT,
  });
  assert.equal('outcome' in body, false);
  assert.equal('statusCode' in body, false);
  assert.equal('state' in body, false);
  assert.equal('headIDs' in body, false);
  assert.equal('revisionCount' in body, false);
});

test('preserves omitted-label and empty-base64 semantics', async (t) => {
  const repository = new FakeProjectRepository();
  const app = makeApp(t, { repository });

  const omitted = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: validBody(),
  });
  assert.equal(omitted.statusCode, 201);
  assert.equal((omitted.json() as { encryptedLabel: unknown }).encryptedLabel, null);
  assert.equal(repository.calls.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      repository.calls[0],
      'encryptedLabel',
    ),
    false,
  );

  const empty = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: validBody({ label: '' }),
  });
  assert.equal(empty.statusCode, 201);
  assert.equal((empty.json() as { encryptedLabel: unknown }).encryptedLabel, '');
  assert.equal(repository.calls.length, 2);
  const emptyLabel = repository.calls[1]?.encryptedLabel;
  assert.ok(emptyLabel instanceof Uint8Array);
  assert.equal(emptyLabel?.length, 0);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      repository.calls[1],
      'encryptedLabel',
    ),
    true,
  );
});

test('rejects forged body identity fields instead of accepting or stripping them', async (t) => {
  const repository = new FakeProjectRepository();
  let authorized = 0;
  const app = makeApp(t, {
    repository,
    authorizeCreate: async () => {
      authorized += 1;
      return { userID: USER_ID };
    },
  });

  const forgedBodies: Array<Record<string, unknown>> = [
    validBody({ label: 'AQID', userID: OTHER_USER_ID }),
    validBody({ projectUUID: OTHER_PROJECT_ID }),
    validBody({ identity: { userID: OTHER_USER_ID } }),
    validBody({ label: 'AQID', extra: true }),
  ];

  for (const payload of forgedBodies) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload,
    });

    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    const error = errorPayload(response.body);
    assert.equal(error.error.code, 'invalid-request');
    assert.equal(error.error.message, 'The request is invalid.');
    assert.equal(error.error.retryable, false);
    assert.match(error.error.requestID, UUID_V4);
    assert.ok(!response.body.includes(OTHER_USER_ID));
    assert.ok(!response.body.includes(OTHER_PROJECT_ID));
    assert.ok(!response.body.includes('projectUUID'));
  }

  assert.equal(authorized, forgedBodies.length);
  assert.equal(repository.calls.length, 0);
});

test('rejects invalid project IDs, labels, nulls, and non-canonical base64 with 422', async (t) => {
  const repository = new FakeProjectRepository();
  const app = makeApp(t, { repository });

  const invalidBodies: Array<Record<string, unknown>> = [
    { projectID: 'not-a-uuid' },
    { projectID: `${PROJECT_ID}0` },
    { projectID: PROJECT_ID, label: 'YQ' },
    { projectID: PROJECT_ID, label: 'YQ=' },
    { projectID: PROJECT_ID, label: 'YQ===' },
    { projectID: PROJECT_ID, label: 'Y Q==' },
    { projectID: PROJECT_ID, label: 'YQ==\n' },
    { projectID: PROJECT_ID, label: 'AB==' },
    { projectID: PROJECT_ID, label: '!!!!' },
    { projectID: PROJECT_ID, label: null },
    { projectID: PROJECT_ID, label: 123 },
  ];

  for (const payload of invalidBodies) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload,
    });

    assert.equal(response.statusCode, 422, JSON.stringify(payload));
    const error = errorPayload(response.body);
    assert.equal(error.error.code, 'invalid-request');
    assert.equal(error.error.message, 'The request is invalid.');
    assert.equal(error.error.retryable, false);
    assert.match(error.error.requestID, UUID_V4);
    assert.ok(!response.body.includes('not-a-uuid'));
    assert.ok(!response.body.includes('Y Q=='));
  }

  assert.equal(repository.calls.length, 0);
});

test('null authorization returns 401 before malformed or oversized body parsing', async (t) => {
  const repository = new FakeProjectRepository();
  const app = makeApp(t, {
    repository,
    authorizeCreate: async () => null,
  });

  const malformed = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { 'content-type': 'application/json' },
    payload: '{"projectID":',
  });
  assert.equal(malformed.statusCode, 401);
  assert.equal(errorPayload(malformed.body).error.code, 'unauthenticated');

  const oversized = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      projectID: PROJECT_ID,
      label: 'x'.repeat(TEST_CONFIG.bodyLimitBytes + 1),
    }),
  });
  assert.equal(oversized.statusCode, 401);
  assert.equal(errorPayload(oversized.body).error.code, 'unauthenticated');

  const valid = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: validBody(),
  });
  assert.equal(valid.statusCode, 401);
  assert.equal(errorPayload(valid.body).error.code, 'unauthenticated');
  assert.equal(repository.calls.length, 0);
});

test('authorizer failures map to a redacted 503 before body parsing', async (t) => {
  const secret = 'synthetic-authorizer-secret';
  const repository = new FakeProjectRepository();
  const app = makeApp(t, {
    repository,
    authorizeCreate: async () => {
      throw new Error(`native auth failed with ${secret} at /internal/path`);
    },
  });

  for (const request of [
    {
      headers: { 'content-type': 'application/json' as const },
      payload: '{"projectID":',
    },
    { payload: validBody() },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      ...request,
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '7');
    const error = errorPayload(response.body);
    assert.equal(error.error.code, 'unavailable');
    assert.equal(
      error.error.message,
      'The authentication service is unavailable.',
    );
    assert.equal(error.error.retryable, true);
    assert.match(error.error.requestID, UUID_V4);
    assert.ok(!response.body.includes(secret));
    assert.ok(!response.body.includes('/internal/path'));
  }

  assert.equal(repository.calls.length, 0);
});

test('keeps every other /v1 method and path behind the original 401 gate', async (t) => {
  let authorized = 0;
  const repository = new FakeProjectRepository();
  const app = makeApp(t, {
    repository,
    authorizeCreate: async () => {
      authorized += 1;
      return { userID: USER_ID };
    },
  });

  for (const method of [
    'GET',
    'HEAD',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
  ] as const) {
    const response = await app.inject({ method, url: '/v1/projects' });
    assert.equal(response.statusCode, 401, `${method} /v1/projects`);
  }

  for (const [method, url] of [
    ['POST', '/v1'],
    ['POST', '/v1/projects/'],
    ['POST', '/v1/projects/extra'],
    ['POST', '/v1/me'],
    ['GET', '/v1/projects'],
  ] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }

  assert.equal(authorized, 0);
  assert.equal(repository.calls.length, 0);
});

test('ignores query parameters on the selected POST path', async (t) => {
  const repository = new FakeProjectRepository();
  const app = makeApp(t, { repository });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects?after=1&unused=true',
    payload: validBody(),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(repository.calls.length, 1);
  assert.equal(repository.calls[0]?.userID, USER_ID);
});

test('maps repository domain errors to fixed envelopes and retry metadata', async (t) => {
  const repository = new FakeProjectRepository();
  const app = makeApp(t, { repository });

  const cases = [
    {
      code: 'invalid-project-input',
      statusCode: 422,
      retryable: false,
      message: 'Project repository input is invalid.',
    },
    {
      code: 'active-project-limit-reached',
      statusCode: 409,
      retryable: false,
      message: 'The active project limit has been reached.',
    },
    {
      code: 'quota-not-provisioned',
      statusCode: 500,
      retryable: false,
      message: 'The user quota is not provisioned.',
    },
    {
      code: 'project-id-unavailable',
      statusCode: 409,
      retryable: false,
      message: 'The project identifier is unavailable.',
    },
    {
      code: 'project-purged',
      statusCode: 409,
      retryable: false,
      message: 'The project is not active.',
    },
    {
      code: 'repository-unavailable',
      statusCode: 503,
      retryable: true,
      message: 'The project repository is temporarily unavailable.',
    },
  ] as const;

  for (const expected of cases) {
    repository.error = new ProjectRepositoryError(expected.code);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: validBody({ label: 'AQID' }),
    });

    assert.equal(response.statusCode, expected.statusCode, expected.code);
    const error = errorPayload(response.body);
    assert.equal(error.error.code, expected.code);
    assert.equal(error.error.message, expected.message);
    assert.equal(error.error.retryable, expected.retryable);
    assert.match(error.error.requestID, UUID_V4);
    assert.equal(response.body.includes(USER_ID), false);
    assert.equal(response.body.includes('AQID'), false);
    assert.equal(response.body.includes(PROJECT_ID), false);

    if (expected.statusCode === 503) {
      assert.equal(response.headers['retry-after'], '7');
    } else {
      assert.equal(response.headers['retry-after'], undefined);
    }
  }

  assert.equal(repository.calls.length, cases.length);
});

test('maps unknown repository failures to a fixed 503 without leaking text or IDs', async (t) => {
  const repository = new FakeProjectRepository();
  const secret = 'synthetic-database-secret';
  repository.error = new Error(
    `raw failure ${secret} for ${USER_ID} project ${PROJECT_ID} at /internal/path`,
  );
  const app = makeApp(t, { repository });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: validBody({ label: 'AQID' }),
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '7');
  const error = errorPayload(response.body);
  assert.equal(error.error.code, 'unavailable');
  assert.equal(
    error.error.message,
    'The project service is temporarily unavailable.',
  );
  assert.equal(error.error.retryable, true);
  assert.match(error.error.requestID, UUID_V4);
  assert.ok(!response.body.includes(secret));
  assert.ok(!response.body.includes(USER_ID));
  assert.ok(!response.body.includes(PROJECT_ID));
  assert.ok(!response.body.includes('AQID'));
  assert.ok(!response.body.includes('/internal/path'));
});

test('ignores client request IDs and generates a server-owned request ID', async (t) => {
  const app = makeApp(t, {
    authorizeCreate: async () => null,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: {
      'request-id': 'attacker-supplied',
      'x-request-id': 'attacker-supplied',
    },
    payload: validBody(),
  });

  assert.equal(response.statusCode, 401);
  const error = errorPayload(response.body);
  assert.match(error.error.requestID, UUID_V4);
  assert.notEqual(error.error.requestID, 'attacker-supplied');
  assert.ok(!response.body.includes('attacker-supplied'));
});

test('resolves a fresh principal for every request without persistence', async (t) => {
  const repository = new FakeProjectRepository();
  let count = 0;
  const app = makeApp(t, {
    repository,
    authorizeCreate: async () => {
      count += 1;
      return { userID: count === 1 ? USER_ID : OTHER_USER_ID };
    },
  });

  const first = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: validBody(),
  });
  const second = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: validBody({ projectID: OTHER_PROJECT_ID }),
  });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.equal(repository.calls[0]?.userID, USER_ID);
  assert.equal(repository.calls[1]?.userID, OTHER_USER_ID);
  assert.equal(count, 2);
});

test('keeps /api/auth at the sanitised 503 when projects are configured', async (t) => {
  const app = makeApp(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in',
    payload: validBody(),
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '7');
  const error = errorPayload(response.body);
  assert.equal(error.error.code, 'unavailable');
  assert.equal(error.error.message, 'The authentication service is unavailable.');
  assert.equal(error.error.retryable, true);
});

test('lists actual project state for a browser principal with route ID projects.list', async (t) => {
  const repository = new FakeStateProjectRepository();
  repository.rows = [
    stateProjectRow(),
    stateProjectRow({
      projectID: OTHER_PROJECT_ID,
      encryptedLabel: null,
      headIDs: [],
      revisionCount: 0,
    }),
  ];
  const seen: string[] = [];
  const app = makeListApp(t, {
    repository,
    authorize: async (_request, routeID) => {
      seen.push(routeID);
      return browserPrincipal();
    },
  });

  const response = await app.inject({ method: 'GET', url: '/v1/projects' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    projects: [
      {
        projectID: PROJECT_ID,
        encryptedLabel: 'AQID',
        createdAt: CREATED_AT,
        headIDs: [HEAD_A, HEAD_B],
        revisionCount: 3,
      },
      {
        projectID: OTHER_PROJECT_ID,
        encryptedLabel: null,
        createdAt: CREATED_AT,
        headIDs: [],
        revisionCount: 0,
      },
    ],
  });
  assert.deepEqual(seen, ['projects.list']);
  assert.deepEqual(repository.stateCalls, [{ userID: USER_ID }]);
  assert.equal(response.body.includes(USER_ID), false);
  assert.equal('statusCode' in response.json(), false);
});

test('allows a device principal to list only its own active projects', async (t) => {
  const repository = new FakeStateProjectRepository();
  repository.rows = [stateProjectRow()];
  const app = makeListApp(t, {
    repository,
    authorize: async () => ({
      kind: 'device',
      userID: USER_ID,
      deviceID: DEVICE_ID,
      grantID: HEAD_A,
    }),
  });

  const response = await app.inject({
    method: 'GET',
    url: '/v1/projects',
    headers: { 'x-user-id': OTHER_USER_ID },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repository.stateCalls, [{ userID: USER_ID }]);
  assert.equal(response.body.includes(OTHER_USER_ID), false);
  assert.equal(response.body.includes(DEVICE_ID), false);
});

test('project list auth failures are fixed, redacted, and pre-handler', async (t) => {
  const repository = new FakeStateProjectRepository();

  const missing = makeListApp(t, {
    repository,
    authorize: async () => null,
  });
  const missingResponse = await missing.inject({
    method: 'GET',
    url: '/v1/projects',
  });
  assert.equal(missingResponse.statusCode, 401);
  assert.equal(
    errorPayload(missingResponse.body).error.code,
    'unauthenticated',
  );

  const malformed = makeListApp(t, {
    repository,
    authorize: async () => ({}) as RequestPrincipal,
  });
  const malformedResponse = await malformed.inject({
    method: 'GET',
    url: '/v1/projects',
  });
  assert.equal(malformedResponse.statusCode, 503);
  assert.equal(malformedResponse.headers['retry-after'], '7');
  assert.equal(errorPayload(malformedResponse.body).error.code, 'unavailable');

  const secret = 'synthetic-project-authorizer-secret';
  const throwing = makeListApp(t, {
    repository,
    authorize: async () => {
      throw new Error(`auth failed ${secret} at /internal/path`);
    },
  });
  const throwingResponse = await throwing.inject({
    method: 'GET',
    url: '/v1/projects',
  });
  assert.equal(throwingResponse.statusCode, 503);
  assert.equal(throwingResponse.headers['retry-after'], '7');
  assert.equal(
    errorPayload(throwingResponse.body).error.code,
    'unavailable',
  );
  assert.ok(!throwingResponse.body.includes(secret));
  assert.ok(!throwingResponse.body.includes('/internal/path'));

  assert.equal(repository.stateCalls.length, 0);
});

test('project list maps repository errors and rejects unknown query properties', async (t) => {
  const repository = new FakeStateProjectRepository();
  const app = makeListApp(t, { repository });

  repository.listError = new ProjectRepositoryError('repository-unavailable');
  const unavailable = await app.inject({
    method: 'GET',
    url: '/v1/projects',
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.headers['retry-after'], '7');
  assert.equal(errorPayload(unavailable.body).error.code, 'repository-unavailable');

  repository.listError = new ProjectRepositoryError('project-purged');
  const conflict = await app.inject({ method: 'GET', url: '/v1/projects' });
  assert.equal(conflict.statusCode, 409);
  assert.equal(errorPayload(conflict.body).error.code, 'project-purged');

  repository.listError = undefined;
  const unknownQuery = await app.inject({
    method: 'GET',
    url: '/v1/projects?userID=forged',
  });
  assert.equal(unknownQuery.statusCode, 400);
  assert.equal(errorPayload(unknownQuery.body).error.code, 'invalid-request');
  assert.ok(!unknownQuery.body.includes('forged'));
});

test('uses the shared device authorizer for project create when supplied', async (t) => {
  const repository = new FakeProjectRepository();
  const seen: string[] = [];
  const app = createApi({
    config: TEST_CONFIG,
    projects: {
      repository,
      authorize: async (_request, routeID) => {
        seen.push(routeID);
        return {
          kind: 'device',
          userID: USER_ID,
          deviceID: DEVICE_ID,
        };
      },
    },
  });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: validBody({ label: 'AQID' }),
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(seen, ['projects.create']);
  assert.equal(repository.calls[0]?.userID, USER_ID);

  const browserApp = createApi({
    config: TEST_CONFIG,
    projects: {
      repository,
      authorize: async () => browserPrincipal(OTHER_USER_ID),
    },
  });
  t.after(async () => {
    await browserApp.close();
  });

  const browser = await browserApp.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { 'content-type': 'application/json' },
    payload: '{"projectID":',
  });
  assert.equal(browser.statusCode, 403);
  const browserError = errorPayload(browser.body);
  assert.equal(browserError.error.code, 'forbidden');
  assert.equal(
    browserError.error.message,
    'This operation is not permitted for this principal.',
  );
  assert.equal(browserError.error.retryable, false);
  assert.match(browserError.error.requestID, UUID_V4);
  assert.equal(repository.calls.length, 1);
});
