import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApi } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { toApiErrorResponse } from '../src/errors.js';
import type { ReadinessChecks } from '../src/readiness.js';

const TEST_CONFIG: ApiConfig = {
  host: '127.0.0.1',
  port: 43123,
  publicOrigin: 'https://api.example.test',
  bodyLimitBytes: 1024,
  readinessTimeoutMs: 50,
  retryAfterSeconds: 7,
};

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

function makeApp(
  t: TestContext,
  readiness?: ReadinessChecks,
): FastifyInstance {
  const app = createApi({ config: TEST_CONFIG, readiness });
  t.after(async () => {
    await app.close();
  });
  return app;
}

function healthyChecks(
  overrides: Partial<ReadinessChecks> = {},
): ReadinessChecks {
  return {
    database: async () => true,
    migrations: async () => true,
    storage: async () => true,
    ...overrides,
  };
}

function errorPayload(body: string): ErrorPayload {
  return JSON.parse(body) as ErrorPayload;
}

test('builds an unlistened instance with explicit limits', (t) => {
  const app = makeApp(t);

  assert.equal(app.server.listening, false);
  assert.equal(app.initialConfig.bodyLimit, TEST_CONFIG.bodyLimitBytes);
  assert.equal(app.initialConfig.disableRequestLogging, true);
  assert.equal(app.initialConfig.requestIdHeader, false);
});

test('live probe is 200 without invoking dependency checks', async (t) => {
  let invoked = false;
  const app = makeApp(t, {
    database: async () => {
      invoked = true;
      throw new Error('synthetic dependency failure');
    },
    migrations: async () => {
      invoked = true;
      return false;
    },
    storage: async () => {
      invoked = true;
      return false;
    },
  });

  const response = await app.inject({ method: 'GET', url: '/health/live' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  assert.equal(invoked, false);
});

test('ready probe is 200 only when every check is true', async (t) => {
  const app = makeApp(t, healthyChecks());
  const response = await app.inject({ method: 'GET', url: '/health/ready' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});

test('ready probe defaults to 503 when checks are omitted', async (t) => {
  const app = makeApp(t);
  const response = await app.inject({ method: 'GET', url: '/health/ready' });

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '7');

  const payload = errorPayload(response.body);
  assert.equal(payload.error.code, 'unavailable');
  assert.equal(payload.error.message, 'The service is not ready.');
  assert.equal(payload.error.retryable, true);
  assert.match(payload.error.requestID, UUID_V4);
});

test('ready probe is 503 on false or thrown checks without leaking text', async (t) => {
  const falseApp = makeApp(
    t,
    healthyChecks({ migrations: async () => false }),
  );
  const falseResponse = await falseApp.inject({
    method: 'GET',
    url: '/health/ready',
  });
  assert.equal(falseResponse.statusCode, 503);
  assert.equal(falseResponse.headers['retry-after'], '7');

  const secret = 'synthetic-database-secret';
  const throwApp = makeApp(
    t,
    healthyChecks({
      database: async () => {
        throw new Error(`connection failed with ${secret}`);
      },
    }),
  );
  const throwResponse = await throwApp.inject({
    method: 'GET',
    url: '/health/ready',
  });

  assert.equal(throwResponse.statusCode, 503);
  assert.equal(throwResponse.headers['retry-after'], '7');
  assert.ok(!throwResponse.body.includes(secret));
  assert.equal(errorPayload(throwResponse.body).error.code, 'unavailable');
});

test('ready probe bounds a never-resolving check and aborts it', async (t) => {
  let signal: AbortSignal | undefined;
  const app = makeApp(
    t,
    healthyChecks({
      database: (received) => {
        signal = received;
        return new Promise<boolean>(() => {});
      },
    }),
  );

  const started = Date.now();
  const response = await app.inject({
    method: 'GET',
    url: '/health/ready',
  });
  const elapsed = Date.now() - started;

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '7');
  assert.ok(elapsed >= 25, `returned after ${elapsed}ms`);
  assert.ok(elapsed < 1000, `returned after ${elapsed}ms`);
  assert.equal(signal?.aborted, true);
});

test('denies every method on /v1 and /v1/* before auth handling', async (t) => {
  const app = makeApp(t, healthyChecks());
  const methods = [
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
  ] as const;

  for (const path of ['/v1', '/v1/projects']) {
    for (const method of methods) {
      const response = await app.inject({ method, url: path });
      assert.equal(response.statusCode, 401, `${method} ${path}`);

      if (method !== 'HEAD') {
        const payload = errorPayload(response.body);
        assert.equal(payload.error.code, 'unauthenticated');
        assert.equal(payload.error.message, 'Authentication is required.');
        assert.equal(payload.error.retryable, false);
        assert.match(payload.error.requestID, UUID_V4);
      }
    }
  }
});

test('blocks /api/auth and /api/auth/* with sanitised 503 and Retry-After', async (t) => {
  const app = makeApp(t);
  const methods = [
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
  ] as const;

  for (const path of ['/api/auth', '/api/auth/sign-in']) {
    for (const method of methods) {
      const response = await app.inject({ method, url: path });
      assert.equal(response.statusCode, 503, `${method} ${path}`);
      assert.equal(response.headers['retry-after'], '7');

      if (method !== 'HEAD') {
        const payload = errorPayload(response.body);
        assert.equal(payload.error.code, 'unavailable');
        assert.equal(
          payload.error.message,
          'The authentication service is unavailable.',
        );
        assert.equal(payload.error.retryable, true);
        assert.match(payload.error.requestID, UUID_V4);
      }
    }
  }
});

test('auth-shaped headers do not bypass the gates', async (t) => {
  const app = makeApp(t);
  const headers = {
    authorization: 'Bearer synthetic-device-token',
    cookie: 'session=synthetic-cookie',
    'x-sessionport-user': 'synthetic-user',
    'x-forwarded-user': 'synthetic-user',
    'x-user-id': 'synthetic-user',
  };

  const protectedResponse = await app.inject({
    method: 'GET',
    url: '/v1/me',
    headers,
  });
  assert.equal(protectedResponse.statusCode, 401);

  const authResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in',
    headers,
  });
  assert.equal(authResponse.statusCode, 503);
  assert.equal(authResponse.headers['retry-after'], '7');
});

test('ignores client-supplied request IDs', async (t) => {
  const app = makeApp(t);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: {
      'request-id': 'attacker-supplied',
      'x-request-id': 'attacker-supplied',
    },
  });

  assert.equal(response.statusCode, 401);
  const payload = errorPayload(response.body);
  assert.match(payload.error.requestID, UUID_V4);
  assert.notEqual(payload.error.requestID, 'attacker-supplied');
  assert.ok(!response.body.includes('attacker-supplied'));
});

test('unknown routes return a sanitised 404', async (t) => {
  const app = makeApp(t);
  const response = await app.inject({
    method: 'GET',
    url: '/not-a-route?token=synthetic-query-secret',
  });

  assert.equal(response.statusCode, 404);
  const payload = errorPayload(response.body);
  assert.equal(payload.error.code, 'not-found');
  assert.equal(payload.error.message, 'The requested resource was not found.');
  assert.equal(payload.error.retryable, false);
  assert.match(payload.error.requestID, UUID_V4);
  assert.ok(!response.body.includes('/not-a-route'));
  assert.ok(!response.body.includes('synthetic-query-secret'));
});

test('gates run before body parsing for malformed and oversized bodies', async (t) => {
  const app = makeApp(t);

  const malformed = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { 'content-type': 'application/json' },
    payload: '{"broken":',
  });
  assert.equal(malformed.statusCode, 401);
  assert.equal(errorPayload(malformed.body).error.code, 'unauthenticated');

  const oversized = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ value: 'x'.repeat(TEST_CONFIG.bodyLimitBytes + 1) }),
  });
  assert.equal(oversized.statusCode, 503);
  assert.equal(oversized.headers['retry-after'], '7');
  assert.equal(errorPayload(oversized.body).error.code, 'unavailable');
});

test('maps parser and unknown failures to fixed sanitised envelopes', () => {
  const invalidJson = toApiErrorResponse(
    {
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      statusCode: 400,
      message: 'Unexpected token SECRET in request body',
    },
    'request-1',
  );
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(invalidJson.envelope.error.code, 'invalid-json');
  assert.equal(
    invalidJson.envelope.error.message,
    'The request body is not valid JSON.',
  );
  assert.ok(!JSON.stringify(invalidJson).includes('SECRET'));

  const tooLarge = toApiErrorResponse(
    {
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
      statusCode: 413,
      message: 'Request body is too large: limit 1024 bytes',
    },
    'request-2',
  );
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.envelope.error.code, 'payload-too-large');
  assert.equal(tooLarge.envelope.error.retryable, false);

  const secret = 'synthetic-password-path';
  const unknown = toApiErrorResponse(
    new Error(`database password ${secret} at /synthetic/path`),
    'request-3',
  );
  assert.equal(unknown.statusCode, 500);
  assert.equal(unknown.envelope.error.code, 'internal-error');
  assert.equal(unknown.envelope.error.message, 'An internal error occurred.');
  assert.ok(!JSON.stringify(unknown).includes(secret));
  assert.ok(!JSON.stringify(unknown).includes('/synthetic/path'));
});

test('importing main neither listens nor installs signal handlers', async () => {
  const envKeys = [
    'SESSIONPORT_API_PORT',
    'SESSIONPORT_PUBLIC_ORIGIN',
    'SESSIONPORT_HTTP_BODY_LIMIT_BYTES',
    'SESSIONPORT_READINESS_TIMEOUT_MS',
    'SESSIONPORT_RETRY_AFTER_SECONDS',
  ] as const;
  const saved = new Map<string, string | undefined>();
  for (const key of envKeys) {
    saved.set(key, process.env[key]);
    process.env[key] = 'invalid-import-value';
  }

  const sigintCount = process.listenerCount('SIGINT');
  const sigtermCount = process.listenerCount('SIGTERM');

  try {
    const main = await import('../src/main.js');
    assert.equal(typeof main.bootstrap, 'function');
    assert.equal(typeof main.startApi, 'function');
    assert.equal(process.listenerCount('SIGINT'), sigintCount);
    assert.equal(process.listenerCount('SIGTERM'), sigtermCount);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
