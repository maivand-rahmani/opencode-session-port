import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { toApiErrorResponse } from '../../src/errors.js';
import type {
  AuthorizeRequest,
  RequestPrincipal,
} from '../../src/protocol/principal.js';
import {
  RevisionRepositoryError,
  type RevisionRepositoryErrorCode,
} from '../../src/revisions/errors.js';
import {
  readRevisionDependency,
  registerRevisionRoutes,
} from '../../src/revisions/routes.js';
import type {
  CommitRevisionInput,
  CommitRevisionResult,
  RevisionPage,
  RevisionPageInput,
  RevisionRepository,
} from '../../src/revisions/repository.js';

/*
 * Focused route tests against Fastify inject() with synthetic authorizers and
 * repositories. They prove ordering of authorization vs body parsing, route
 * IDs, principal-kind enforcement, schema/domain mapping, and response shape.
 * They do not implement native auth, open a socket, or prove PostgreSQL.
 */

const USER_ID = 'user_01HTRUSTEDAUTHORIZER';
const OTHER_USER_ID = 'user_01HOTHERAUTHORIZER';
const DEVICE_ID = '44aa2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const PROJECT_ID = '5d4e8c2a-1b3f-4a6d-9e8c-0f1a2b3c4d5e';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const UPLOAD_ID = 'aa11bb22-cc33-4d44-8e55-ff66aa77bb88';
const CREATED_AT = '2026-10-18T12:00:00.000Z';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

interface ErrorPayload {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestID: string;
  };
}

class FakeRevisionRepository implements RevisionRepository {
  readonly commitCalls: CommitRevisionInput[] = [];
  readonly pageCalls: RevisionPageInput[] = [];
  commitResult: CommitRevisionResult = {
    statusCode: 201,
    revisionID: REVISION_ID,
    seq: '42',
    headIDs: [REVISION_ID],
    conflict: false,
  };
  pageResult: RevisionPage = {
    upperBound: '42',
    nextAfter: '41',
    hasMore: false,
    currentHeadIDs: [REVISION_ID],
    revisions: [
      {
        revisionID: REVISION_ID,
        parentRevisionID: null,
        seq: '41',
        deviceID: DEVICE_ID,
        keyEpoch: 1,
        sizeBytes: 1_024,
        ciphertextSha256: 'AQID',
        createdAt: CREATED_AT,
      },
    ],
  };
  commitError: unknown = undefined;
  pageError: unknown = undefined;

  async commit(input: CommitRevisionInput): Promise<CommitRevisionResult> {
    this.commitCalls.push(input);
    if (this.commitError !== undefined) {
      throw this.commitError;
    }
    return this.commitResult;
  }

  async page(input: RevisionPageInput): Promise<RevisionPage> {
    this.pageCalls.push(input);
    if (this.pageError !== undefined) {
      throw this.pageError;
    }
    return this.pageResult;
  }
}

interface TestAppOptions {
  readonly repository?: RevisionRepository;
  readonly authorize?: AuthorizeRequest;
}

function makeApp(
  t: TestContext,
  options: TestAppOptions = {},
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

  registerRevisionRoutes(
    app,
    {
      repository: options.repository ?? new FakeRevisionRepository(),
      authorize:
        options.authorize ?? (async () => devicePrincipal(USER_ID, DEVICE_ID)),
    },
    { retryAfterSeconds: 7 },
  );

  t.after(async () => {
    await app.close();
  });
  return app;
}

function devicePrincipal(
  userID = USER_ID,
  deviceID = DEVICE_ID,
): RequestPrincipal {
  return { kind: 'device', userID, deviceID };
}

function browserPrincipal(userID = USER_ID): RequestPrincipal {
  return { kind: 'browser', userID };
}

function errorPayload(body: string): ErrorPayload {
  return JSON.parse(body) as ErrorPayload;
}

function validBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    revisionID: REVISION_ID,
    uploadID: UPLOAD_ID,
    parentRevisionID: null,
    ...overrides,
  };
}

function assertFixedError(
  response: { statusCode: number; body: string },
  code: string,
  message: string,
  statusCode: number,
  retryable: boolean,
): void {
  assert.equal(response.statusCode, statusCode, code);
  const payload = errorPayload(response.body);
  assert.equal(payload.error.code, code);
  assert.equal(payload.error.message, message);
  assert.equal(payload.error.retryable, retryable);
  assert.match(payload.error.requestID, UUID_V4);
}

test('rejects malformed revision dependencies at construction', () => {
  const repository = new FakeRevisionRepository();
  const fixed = /Invalid revisions API dependency\./;

  assert.throws(() => readRevisionDependency(null), fixed);
  assert.throws(() => readRevisionDependency({}), fixed);
  assert.throws(
    () => readRevisionDependency({ repository: {}, authorize: async () => null }),
    fixed,
  );
  assert.throws(
    () =>
      readRevisionDependency({
        repository: { commit: repository.commit },
        authorize: async () => null,
      }),
    fixed,
  );
  assert.throws(
    () =>
      readRevisionDependency({
        repository,
        authorize: null,
      }),
    fixed,
  );
});

test('missing authorization returns 401 before malformed body parsing', async (t) => {
  const repository = new FakeRevisionRepository();
  const seen: Array<{ request: FastifyRequest; routeID: string }> = [];
  const app = makeApp(t, {
    repository,
    authorize: async (request, routeID) => {
      seen.push({ request, routeID });
      return null;
    },
  });

  const malformed = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer synthetic-device-token',
      'x-user-id': USER_ID,
      'request-id': 'attacker-supplied',
    },
    payload: '{"revisionID":',
  });
  assert.equal(malformed.statusCode, 401);
  assert.equal(errorPayload(malformed.body).error.code, 'unauthenticated');
  assert.match(errorPayload(malformed.body).error.requestID, UUID_V4);
  assert.ok(!malformed.body.includes('attacker-supplied'));

  const valid = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    payload: validBody({ userID: OTHER_USER_ID }),
  });
  assert.equal(valid.statusCode, 401);

  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.routeID, 'revisions.commit');
  assert.equal(seen[0]?.request.method, 'POST');
  assert.equal(repository.commitCalls.length, 0);
});

test('browser principals are forbidden from commit and list before parsing', async (t) => {
  const repository = new FakeRevisionRepository();
  const app = makeApp(t, {
    repository,
    authorize: async () => browserPrincipal(),
  });

  const malformed = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    headers: { 'content-type': 'application/json' },
    payload: '{"revisionID":',
  });
  assertFixedError(
    malformed,
    'forbidden',
    'This operation is not permitted for this principal.',
    403,
    false,
  );

  const get = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_ID}/revisions?after=0&limit=1`,
  });
  assertFixedError(
    get,
    'forbidden',
    'This operation is not permitted for this principal.',
    403,
    false,
  );

  assert.equal(repository.commitCalls.length, 0);
  assert.equal(repository.pageCalls.length, 0);
});

test('malformed resolved principals fail closed as 503, not anonymous access', async (t) => {
  const repository = new FakeRevisionRepository();
  const malformedPrincipals: unknown[] = [
    {},
    { kind: 'device', userID: USER_ID },
    { kind: 'device', userID: USER_ID, deviceID: 'not-a-uuid' },
    { kind: 'device', userID: '', deviceID: DEVICE_ID },
    { kind: 'other', userID: USER_ID },
    { kind: 'device', userID: USER_ID, deviceID: DEVICE_ID, grantID: 7 },
  ];

  for (const principal of malformedPrincipals) {
    const app = makeApp(t, {
      repository,
      authorize: async () => principal as RequestPrincipal,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/revisions`,
      payload: validBody(),
    });
    assert.equal(response.statusCode, 503, JSON.stringify(principal));
    assert.equal(response.headers['retry-after'], '7');
    assert.equal(errorPayload(response.body).error.code, 'unavailable');
  }

  assert.equal(repository.commitCalls.length, 0);
});

test('authorizer failures map to a redacted 503 with Retry-After', async (t) => {
  const secret = 'synthetic-authorizer-secret';
  const repository = new FakeRevisionRepository();
  const app = makeApp(t, {
    repository,
    authorize: async () => {
      throw new Error(`native auth failed with ${secret} at /internal/path`);
    },
  });

  for (const request of [
    {
      method: 'POST' as const,
      url: `/v1/projects/${PROJECT_ID}/revisions`,
      headers: { 'content-type': 'application/json' as const },
      payload: '{"revisionID":',
    },
    {
      method: 'GET' as const,
      url: `/v1/projects/${PROJECT_ID}/revisions?after=0&limit=1`,
    },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '7');
    const payload = errorPayload(response.body);
    assert.equal(payload.error.code, 'unavailable');
    assert.equal(
      payload.error.message,
      'The authentication service is unavailable.',
    );
    assert.equal(payload.error.retryable, true);
    assert.ok(!response.body.includes(secret));
    assert.ok(!response.body.includes('/internal/path'));
  }

  assert.equal(repository.commitCalls.length, 0);
  assert.equal(repository.pageCalls.length, 0);
});

test('commits with the server-owned device principal and exact response shape', async (t) => {
  const repository = new FakeRevisionRepository();
  repository.commitResult = {
    statusCode: 201,
    revisionID: REVISION_ID,
    seq: '42',
    headIDs: [REVISION_ID, PARENT_ID],
    conflict: true,
  };
  const seen: string[] = [];
  const app = makeApp(t, {
    repository,
    authorize: async (_request, routeID) => {
      seen.push(routeID);
      return devicePrincipal();
    },
  });

  const response = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    headers: { 'x-user-id': OTHER_USER_ID },
    payload: validBody({
      revisionID: REVISION_ID.toUpperCase(),
      uploadID: UPLOAD_ID.toUpperCase(),
    }),
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), {
    revisionID: REVISION_ID,
    seq: '42',
    headIDs: [REVISION_ID, PARENT_ID],
    conflict: true,
  });
  assert.equal(response.body.includes(USER_ID), false);
  assert.equal(response.body.includes(OTHER_USER_ID), false);

  assert.deepEqual(seen, ['revisions.commit']);
  assert.deepEqual(repository.commitCalls, [
    {
      userID: USER_ID,
      deviceID: DEVICE_ID,
      projectID: PROJECT_ID,
      revisionID: REVISION_ID,
      uploadID: UPLOAD_ID,
      parentRevisionID: null,
    },
  ]);
});

test('maps an idempotent commit to 200 with the same wire shape', async (t) => {
  const repository = new FakeRevisionRepository();
  repository.commitResult = {
    statusCode: 200,
    revisionID: REVISION_ID,
    seq: '7',
    headIDs: [REVISION_ID],
    conflict: false,
  };
  const app = makeApp(t, { repository });

  const response = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    payload: validBody({ parentRevisionID: PARENT_ID }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    revisionID: REVISION_ID,
    seq: '7',
    headIDs: [REVISION_ID],
    conflict: false,
  });
  assert.equal(repository.commitCalls[0]?.parentRevisionID, PARENT_ID);
});

test('rejects forged extra body fields with 400 and malformed IDs with 422', async (t) => {
  const repository = new FakeRevisionRepository();
  const app = makeApp(t, { repository });

  for (const payload of [
    validBody({ userID: OTHER_USER_ID }),
    validBody({ deviceID: DEVICE_ID }),
    validBody({ keyEpoch: 1 }),
    validBody({ extra: true }),
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/revisions`,
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(errorPayload(response.body).error.code, 'invalid-request');
    assert.ok(!response.body.includes(OTHER_USER_ID));
    assert.ok(!response.body.includes('extra'));
  }

  for (const payload of [
    validBody({ revisionID: 'not-a-uuid' }),
    validBody({ uploadID: 'not-a-uuid' }),
    validBody({ parentRevisionID: 'not-a-uuid' }),
    validBody({ parentRevisionID: 123 }),
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/revisions`,
      payload,
    });
    assert.equal(response.statusCode, 422, JSON.stringify(payload));
    assertFixedError(
      response,
      'invalid-request',
      'The request is invalid.',
      422,
      false,
    );
    assert.ok(!response.body.includes('not-a-uuid'));
  }

  assert.equal(repository.commitCalls.length, 0);
});

test('maps revision domain errors to fixed lowercase envelopes and retry metadata', async (t) => {
  const repository = new FakeRevisionRepository();
  const app = makeApp(t, { repository });

  const cases: RevisionRepositoryErrorCode[] = [
    'invalid-revision-input',
    'invalid-cursor',
    'invalid-page-limit',
    'project-not-found',
    'unknown-parent',
    'parent-required',
    'upload-not-ready',
    'revision-conflict',
    'device-not-found',
    'internal-error',
    'repository-unavailable',
  ];

  for (const code of cases) {
    const domainError = new RevisionRepositoryError(code);
    repository.commitError = domainError;
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/revisions`,
      payload: validBody(),
    });

    assertFixedError(
      response,
      code,
      EXPECTED_MESSAGES[code],
      domainError.statusCode,
      domainError.retryable,
    );
    if (domainError.statusCode === 503) {
      assert.equal(response.headers['retry-after'], '7');
    } else {
      assert.equal(response.headers['retry-after'], undefined);
    }
  }
});

test('redacts unknown repository failures as fixed internal errors', async (t) => {
  const repository = new FakeRevisionRepository();
  const secret = 'synthetic-database-secret';
  repository.commitError = new Error(
    `raw failure ${secret} for ${USER_ID} project ${PROJECT_ID} at /internal/path`,
  );
  const app = makeApp(t, { repository });

  const response = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    payload: validBody(),
  });

  assertFixedError(
    response,
    'internal-error',
    'An internal revision error occurred.',
    500,
    false,
  );
  assert.ok(!response.body.includes(secret));
  assert.ok(!response.body.includes(USER_ID));
  assert.ok(!response.body.includes(PROJECT_ID));
  assert.ok(!response.body.includes('/internal/path'));
});

test('lists revision pages with raw query strings and a device principal', async (t) => {
  const repository = new FakeRevisionRepository();
  const seen: string[] = [];
  const app = makeApp(t, {
    repository,
    authorize: async (_request, routeID) => {
      seen.push(routeID);
      return devicePrincipal();
    },
  });

  const response = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_ID}/revisions?after=0001&upperBound=0005&limit=2`,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    upperBound: '42',
    nextAfter: '41',
    hasMore: false,
    currentHeadIDs: [REVISION_ID],
    revisions: [
      {
        revisionID: REVISION_ID,
        parentRevisionID: null,
        seq: '41',
        deviceID: DEVICE_ID,
        keyEpoch: 1,
        sizeBytes: 1_024,
        ciphertextSha256: 'AQID',
        createdAt: CREATED_AT,
      },
    ],
  });
  assert.equal(response.body.includes(USER_ID), false);

  assert.deepEqual(seen, ['revisions.list']);
  assert.deepEqual(repository.pageCalls, [
    {
      userID: USER_ID,
      projectID: PROJECT_ID,
      after: '0001',
      upperBound: '0005',
      limit: '2',
    },
  ]);
});

test('maps page cursor, limit, project, and query failures to fixed errors', async (t) => {
  const repository = new FakeRevisionRepository();
  const app = makeApp(t, { repository });

  const invalidProject = await app.inject({
    method: 'GET',
    url: '/v1/projects/not-a-uuid/revisions?after=0&limit=1',
  });
  assertFixedError(
    invalidProject,
    'invalid-request',
    'The request is invalid.',
    422,
    false,
  );

  for (const [query, code] of [
    ['after=x&limit=1', 'invalid-cursor'],
    ['after=0&upperBound=x&limit=1', 'invalid-cursor'],
    ['after=0&limit=01', 'invalid-page-limit'],
    ['after=0&limit=-1', 'invalid-page-limit'],
    ['after=0&limit=1.0', 'invalid-page-limit'],
    ['after=0&limit=%201', 'invalid-page-limit'],
  ] as const) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${PROJECT_ID}/revisions?${query}`,
    });
    assert.equal(
      response.statusCode,
      422,
      `${query} -> ${response.statusCode}`,
    );
    const payload = errorPayload(response.body);
    assert.equal(payload.error.code, code, query);
    assert.match(payload.error.requestID, UUID_V4);
  }

  repository.pageError = new RevisionRepositoryError('invalid-cursor');
  const beyond = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_ID}/revisions?after=5&upperBound=4&limit=1`,
  });
  assertFixedError(
    beyond,
    'invalid-cursor',
    'The cursor is invalid.',
    422,
    false,
  );

  repository.pageError = new RevisionRepositoryError('project-not-found');
  const missing = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_ID}/revisions?after=0&limit=1`,
  });
  assertFixedError(
    missing,
    'project-not-found',
    'The project was not found.',
    404,
    false,
  );

  repository.pageError = new RevisionRepositoryError('repository-unavailable');
  const unavailable = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_ID}/revisions?after=0&limit=1`,
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.headers['retry-after'], '7');

  assert.equal(
    repository.pageCalls.some((call) => call.after === 'x'),
    false,
  );
});

test('rejects unknown query properties on GET and POST with 400', async (t) => {
  const repository = new FakeRevisionRepository();
  const app = makeApp(t, { repository });

  const get = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_ID}/revisions?after=0&limit=1&unexpected=true`,
  });
  assert.equal(get.statusCode, 400);
  assert.equal(errorPayload(get.body).error.code, 'invalid-request');

  const post = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions?after=0`,
    payload: validBody(),
  });
  assert.equal(post.statusCode, 400);
  assert.equal(errorPayload(post.body).error.code, 'invalid-request');

  assert.equal(repository.commitCalls.length, 0);
  assert.equal(repository.pageCalls.length, 0);
});

test('requires both after and limit; missing cursors are domain errors', async (t) => {
  const repository = new FakeRevisionRepository();
  const app = makeApp(t, { repository });

  const missingAfter = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_ID}/revisions?limit=1`,
  });
  assertFixedError(
    missingAfter,
    'invalid-cursor',
    'The cursor is invalid.',
    422,
    false,
  );

  const missingLimit = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_ID}/revisions?after=0`,
  });
  assertFixedError(
    missingLimit,
    'invalid-page-limit',
    'The page limit is invalid.',
    422,
    false,
  );

  assert.equal(repository.pageCalls.length, 0);
});

test('resolves a fresh principal per request and never persists identity', async (t) => {
  const repository = new FakeRevisionRepository();
  let count = 0;
  const app = makeApp(t, {
    repository,
    authorize: async () => {
      count += 1;
      return devicePrincipal(count === 1 ? USER_ID : OTHER_USER_ID);
    },
  });

  const first = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_ID}/revisions?after=0&limit=1`,
  });
  const second = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    payload: validBody(),
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 201);
  assert.equal(repository.pageCalls[0]?.userID, USER_ID);
  assert.equal(repository.commitCalls[0]?.userID, OTHER_USER_ID);
  assert.equal(count, 2);
});
