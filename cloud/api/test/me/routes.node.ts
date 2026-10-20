import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import {
  MeRepositoryError,
  type MeDTO,
  type MeRepository,
} from '../../src/me/repository.js';
import {
  registerMeRoutes,
  type AuthorizeMeRead,
  type MeRequestPrincipal,
} from '../../src/me/routes.js';

/*
 * Focused route tests against Fastify inject() with synthetic authorizers and
 * repositories. They prove the fixed action, trusted-principal use, local error
 * envelopes, and redaction. They do not implement native auth or mount the
 * route into createApi.
 */

const USER_ID = 'user_01HMEROUTETRUSTED';
const OTHER_USER_ID = 'user_other_route_value';
const REQUEST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RETRY_AFTER = 9;

interface ErrorPayload {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestID: string;
  };
}

const RESULT: MeDTO = {
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
    activeProjects: 4,
  },
};

class FakeMeRepository implements MeRepository {
  readonly calls: string[] = [];
  error: unknown = undefined;
  result: MeDTO = RESULT;

  async read(userID: string): Promise<MeDTO> {
    this.calls.push(userID);
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.result;
  }
}

function makeApp(
  t: TestContext,
  options: {
    readonly repository?: MeRepository;
    readonly authorize?: AuthorizeMeRead;
    readonly retryAfterSeconds?: number;
  } = {},
): FastifyInstance {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    requestIdHeader: false,
    genReqId: () => REQUEST_ID,
  });
  registerMeRoutes(app, {
    repository: options.repository ?? new FakeMeRepository(),
    authorize:
      options.authorize ?? (async () => ({ userID: USER_ID })),
    retryAfterSeconds: options.retryAfterSeconds ?? RETRY_AFTER,
  });
  t.after(async () => {
    await app.close();
  });
  return app;
}

function errorPayload(body: string): ErrorPayload {
  return JSON.parse(body) as ErrorPayload;
}

test('rejects malformed dependencies at registration with a fixed message', () => {
  const repository = new FakeMeRepository();
  const fixed = /Invalid me API dependency\./;

  for (const dependencies of [
    undefined,
    null,
    {},
    [],
    { repository: {}, authorize: async () => null, retryAfterSeconds: 1 },
    { repository, authorize: null, retryAfterSeconds: 1 },
    { repository, authorize: async () => null, retryAfterSeconds: -1 },
    { repository, authorize: async () => null, retryAfterSeconds: 1.5 },
    { repository, authorize: async () => null, retryAfterSeconds: '1' },
    { repository, authorize: async () => null },
  ]) {
    assert.throws(
      () => registerMeRoutes(Fastify({ logger: false }), dependencies as never),
      fixed,
    );
  }
});

test('returns usage for the authorizer principal and ignores forged identity headers', async (t) => {
  const repository = new FakeMeRepository();
  const seenActions: string[] = [];
  const seenRequests: FastifyRequest[] = [];
  const app = makeApp(t, {
    repository,
    authorize: async (request, action) => {
      seenActions.push(action);
      seenRequests.push(request);
      return { userID: USER_ID };
    },
  });

  const response = await app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: {
      'x-user-id': OTHER_USER_ID,
      'x-userid': OTHER_USER_ID,
      authorization: 'Bearer synthetic-forged-token',
      cookie: `session=synthetic-forged-cookie; userID=${OTHER_USER_ID}`,
      'request-id': 'attacker-supplied',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), RESULT);
  assert.deepEqual(seenActions, ['me.read']);
  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0]?.method, 'GET');
  assert.equal(seenRequests[0]?.url, '/v1/me');
  assert.deepEqual(repository.calls, [USER_ID]);
  assert.equal(response.body.includes(OTHER_USER_ID), false);
  assert.equal(response.body.includes('attacker-supplied'), false);

  const payload = response.json() as Record<string, unknown>;
  assert.equal('requestID' in payload, false);
  assert.equal('userID' in payload, true);
});

test('null principal returns 401 before the repository and never reads trusted headers', async (t) => {
  const repository = new FakeMeRepository();
  const app = makeApp(t, {
    repository,
    authorize: async () => null,
  });

  const response = await app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: {
      'x-user-id': USER_ID,
      authorization: 'Bearer synthetic-token',
      cookie: `session=synthetic-cookie`,
    },
  });

  assert.equal(response.statusCode, 401);
  const payload = errorPayload(response.body);
  assert.equal(payload.error.code, 'unauthenticated');
  assert.equal(payload.error.message, 'Authentication is required.');
  assert.equal(payload.error.retryable, false);
  assert.equal(payload.error.requestID, REQUEST_ID);
  assert.equal(response.body.includes(USER_ID), false);
  assert.equal(repository.calls.length, 0);
});

test('authorizer failures and malformed principals map to a redacted 503 with Retry-After', async (t) => {
  const secret = 'native-auth-secret-and-/internal/path';
  const cases: AuthorizeMeRead[] = [
    async () => {
      throw new Error(secret);
    },
    async () => ({ userID: '' }),
    async () => ({ userID: `user\u0000secret` }),
    async () => ({ userID: 7 } as never),
    async () => null as never,
  ];

  for (const authorize of cases.slice(0, 4)) {
    const repository = new FakeMeRepository();
    const app = makeApp(t, { repository, authorize });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { 'x-user-id': USER_ID },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], String(RETRY_AFTER));
    const payload = errorPayload(response.body);
    assert.equal(payload.error.code, 'unavailable');
    assert.equal(
      payload.error.message,
      'The authentication service is unavailable.',
    );
    assert.equal(payload.error.retryable, true);
    assert.equal(payload.error.requestID, REQUEST_ID);
    assert.equal(response.body.includes(secret), false);
    assert.equal(response.body.includes(USER_ID), false);
    assert.equal(repository.calls.length, 0);
  }

  // A trusted object missing `userID` is malformed, not an anonymous request.
  const repository = new FakeMeRepository();
  const app = makeApp(t, {
    repository,
    authorize: async () => ({}) as MeRequestPrincipal,
  });
  const response = await app.inject({ method: 'GET', url: '/v1/me' });
  assert.equal(response.statusCode, 503);
  assert.equal(
    errorPayload(response.body).error.code,
    'unavailable',
  );
  assert.equal(repository.calls.length, 0);
});

test('maps repository domain errors to their fixed local envelope', async (t) => {
  const cases = [
    {
      code: 'quota-not-provisioned' as const,
      statusCode: 500,
      retryable: false,
      message: 'The user quota is not provisioned.',
      retryAfter: undefined,
    },
    {
      code: 'quota-invalid' as const,
      statusCode: 500,
      retryable: false,
      message: 'The user quota is invalid.',
      retryAfter: undefined,
    },
    {
      code: 'repository-unavailable' as const,
      statusCode: 503,
      retryable: true,
      message: 'The usage repository is temporarily unavailable.',
      retryAfter: String(RETRY_AFTER),
    },
  ];

  for (const expected of cases) {
    const repository = new FakeMeRepository();
    repository.error = new MeRepositoryError(expected.code);
    const app = makeApp(t, { repository });
    const response = await app.inject({ method: 'GET', url: '/v1/me' });

    assert.equal(response.statusCode, expected.statusCode);
    assert.equal(response.headers['retry-after'], expected.retryAfter);
    const payload = errorPayload(response.body);
    assert.equal(payload.error.code, expected.code);
    assert.equal(payload.error.message, expected.message);
    assert.equal(payload.error.retryable, expected.retryable);
    assert.equal(payload.error.requestID, REQUEST_ID);
    assert.equal(response.body.includes(USER_ID), false);
    assert.equal(repository.calls.length, 1);
  }
});

test('unknown repository failures become a fixed 503 without leaking secrets or IDs', async (t) => {
  const secret = 'postgres://secret-user:secret-password@db/internal';
  const repository = new FakeMeRepository();
  repository.error = new Error(`${secret} for ${USER_ID} at /internal/path`);
  const app = makeApp(t, { repository });

  const response = await app.inject({ method: 'GET', url: '/v1/me' });

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], String(RETRY_AFTER));
  const payload = errorPayload(response.body);
  assert.equal(payload.error.code, 'unavailable');
  assert.equal(
    payload.error.message,
    'The usage service is temporarily unavailable.',
  );
  assert.equal(payload.error.retryable, true);
  assert.equal(payload.error.requestID, REQUEST_ID);
  for (const value of [secret, USER_ID, '/internal/path']) {
    assert.equal(response.body.includes(value), false);
  }
});

test('keeps unauthenticated responses before any repository call even with query and body-like input', async (t) => {
  const repository = new FakeMeRepository();
  const app = makeApp(t, {
    repository,
    authorize: async () => null,
  });

  for (const url of [
    '/v1/me?userID=user_forged',
    '/v1/me?requestID=attacker-supplied',
  ]) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 401);
    assert.equal(errorPayload(response.body).error.requestID, REQUEST_ID);
    assert.equal(response.body.includes('user_forged'), false);
  }
  assert.equal(repository.calls.length, 0);
});
