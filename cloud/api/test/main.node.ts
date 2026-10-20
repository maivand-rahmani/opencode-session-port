import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ApiConfig } from '../src/config.js';
import { DatabaseConfigError } from '../src/database/config.js';
import type { RuntimeDatabaseClient } from '../src/main.js';
import { bootstrap, startApi } from '../src/main.js';

const TEST_CONFIG: ApiConfig = {
  host: '127.0.0.1',
  port: 43123,
  publicOrigin: 'https://api.example.test',
  bodyLimitBytes: 1048576,
  readinessTimeoutMs: 1500,
  retryAfterSeconds: 5,
};

function apiEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SESSIONPORT_API_PORT: String(TEST_CONFIG.port),
    SESSIONPORT_PUBLIC_ORIGIN: TEST_CONFIG.publicOrigin,
    SESSIONPORT_HTTP_BODY_LIMIT_BYTES: String(TEST_CONFIG.bodyLimitBytes),
    SESSIONPORT_READINESS_TIMEOUT_MS: String(TEST_CONFIG.readinessTimeoutMs),
    SESSIONPORT_RETRY_AFTER_SECONDS: String(TEST_CONFIG.retryAfterSeconds),
    ...overrides,
  };
}

function fakeDatabaseClient(outcome: 'success' | 'failure' = 'success') {
  let queryCount = 0;
  let disconnectCount = 0;

  const client: RuntimeDatabaseClient = {
    $queryRaw<T = unknown>(): PromiseLike<T> {
      queryCount += 1;
      return outcome === 'success'
        ? Promise.resolve([{ '?column?': 1 }] as unknown as T)
        : Promise.reject(new Error('synthetic database failure'));
    },
    async $disconnect(): Promise<void> {
      disconnectCount += 1;
    },
  };

  return {
    client,
    queryCount: () => queryCount,
    disconnectCount: () => disconnectCount,
  };
}

function signalSnapshot(): {
  sigint: Set<Function>;
  sigterm: Set<Function>;
} {
  return {
    sigint: new Set(process.listeners('SIGINT')),
    sigterm: new Set(process.listeners('SIGTERM')),
  };
}

function removeAddedSignalListeners(before: {
  sigint: Set<Function>;
  sigterm: Set<Function>;
}): void {
  for (const listener of process.listeners('SIGINT')) {
    if (!before.sigint.has(listener)) {
      process.off('SIGINT', listener);
    }
  }
  for (const listener of process.listeners('SIGTERM')) {
    if (!before.sigterm.has(listener)) {
      process.off('SIGTERM', listener);
    }
  }
}

function assertNoAddedSignalListeners(before: {
  sigint: Set<Function>;
  sigterm: Set<Function>;
}): void {
  assert.deepEqual(new Set(process.listeners('SIGINT')), before.sigint);
  assert.deepEqual(new Set(process.listeners('SIGTERM')), before.sigterm);
}

test('startApi stays health-only and not-ready without explicit checks', async () => {
  const app = await startApi(TEST_CONFIG, { listen: async () => {} });
  try {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(live.statusCode, 200);

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.headers['retry-after'], '5');
  } finally {
    await app.close();
  }
});

test('bootstrap wires the database probe and disconnects once on close', async () => {
  const before = signalSnapshot();
  const fake = fakeDatabaseClient('success');
  let listenCount = 0;

  const app = await bootstrap(apiEnv(), {
    createDatabaseClient: () => fake.client,
    listen: async () => {
      listenCount += 1;
    },
  });

  try {
    assert.equal(listenCount, 1);
    assert.equal(fake.queryCount(), 0);
    assert.equal(fake.disconnectCount(), 0);

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.headers['retry-after'], '5');
    assert.equal(fake.queryCount(), 1);
    assert.ok(!ready.body.includes('synthetic'));

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(live.statusCode, 200);
    assert.equal(fake.queryCount(), 1);
  } finally {
    try {
      await app.close();
    } finally {
      removeAddedSignalListeners(before);
    }
  }

  assert.equal(fake.disconnectCount(), 1);
});

test('bootstrap disconnects exactly once when listening fails', async () => {
  const before = signalSnapshot();
  const fake = fakeDatabaseClient();

  await assert.rejects(
    bootstrap(apiEnv(), {
      createDatabaseClient: () => fake.client,
      listen: async () => {
        throw new Error('synthetic listen failure');
      },
    }),
    /synthetic listen failure/,
  );

  assert.equal(fake.disconnectCount(), 1);
  assertNoAddedSignalListeners(before);
});

test('bootstrap rejects invalid or missing runtime configuration before listening', async () => {
  const before = signalSnapshot();

  for (const url of [undefined, 'not a database url']) {
    let listenCalled = false;
    const env = apiEnv();
    if (url === undefined) {
      delete env.SESSIONPORT_RUNTIME_DATABASE_URL;
    } else {
      env.SESSIONPORT_RUNTIME_DATABASE_URL = url;
    }

    await assert.rejects(
      bootstrap(env, {
        listen: async () => {
          listenCalled = true;
        },
      }),
      DatabaseConfigError,
    );
    assert.equal(listenCalled, false);
  }

  assertNoAddedSignalListeners(before);
});

test('importing main performs no listening or runtime database construction', () => {
  const script = [
    "const before = { sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') };",
    `await import(${JSON.stringify(new URL('../src/main.ts', import.meta.url).href)});`,
    "const after = { sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') };",
    'process.stdout.write(JSON.stringify({ before, after }));',
  ].join('\n');

  const env = { ...process.env, ...apiEnv() };
  delete env.SESSIONPORT_RUNTIME_DATABASE_URL;
  delete env.SESSIONPORT_MIGRATOR_DATABASE_URL;

  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );

  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');

  const result = JSON.parse(child.stdout.trim()) as {
    before: { sigint: number; sigterm: number };
    after: { sigint: number; sigterm: number };
  };
  assert.deepEqual(result.after, result.before);
});

const CLOUD_BACKEND_POLICY = {
  maxActiveProjects: 10,
  maxActiveDevices: 3,
  maxCiphertextBytes: 104_857_600,
  maxPageSize: 100,
  maxOutstandingPendingAuthorizationsGlobal: 500,
  maxRateLimitEntries: 10_000,
  maxAuthResponseBytes: 65_536,
} as const;

const CLOUD_NATIVE_POLICY = {
  ttlSeconds: {
    pendingAuthorization: 600,
    accessToken: 3_600,
    refreshToken: 86_400,
    grant: 604_800,
  },
  polling: {
    intervalSeconds: 5,
    backoffIncrementSeconds: 5,
    maxIntervalSeconds: 30,
  },
  rateLimits: Object.fromEntries(
    [
      'createAuthorization',
      'browserVerification',
      'browserLookup',
      'approveAuthorization',
      'denyAuthorization',
      'exchangeDeviceCode',
      'refreshToken',
      'listGrants',
      'revokeGrant',
    ].map((operation) => [operation, { windowSeconds: 60, maxRequests: 60 }]),
  ),
  capacity: {
    maxOutstandingPendingAuthorizationsPerUser: 10,
    maxActiveGrantsPerUser: 3,
    retentionSeconds: {
      pendingAuthorizationRecords: 86_400,
      spentTokenRecords: 2_592_000,
      revokedGrantRecords: 7_776_000,
    },
  },
  authorization: {
    audience: 'sessionport-api',
    resource: 'sessionport',
    allowedScopes: [
      'projects:read',
      'projects:write',
      'revisions:read',
      'revisions:write',
      'me:read',
    ],
    requiredRouteScopes: {
      'projects.create': ['projects:write'],
      'projects.list': ['projects:read'],
      'revisions.list': ['revisions:read'],
      'revisions.commit': ['revisions:write'],
      'me.read': ['me:read'],
    },
  },
} as const;

function cloudEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return apiEnv({
    SESSIONPORT_API_MODE: 'cloud',
    SESSIONPORT_BACKEND_POLICY_JSON: JSON.stringify(CLOUD_BACKEND_POLICY),
    SESSIONPORT_NATIVE_ALLOW_LOOPBACK_HTTP: 'false',
    SESSIONPORT_BETTER_AUTH_SECRET: 'a'.repeat(40),
    SESSIONPORT_GITHUB_CLIENT_ID: 'github-client-id',
    SESSIONPORT_GITHUB_CLIENT_SECRET: 'github-client-secret',
    SESSIONPORT_NATIVE_HUMAN_CODE_KEYS_JSON: JSON.stringify([
      { id: 'primary', keyBase64: Buffer.alloc(32, 1).toString('base64') },
    ]),
    SESSIONPORT_NATIVE_HUMAN_CODE_ACTIVE_KEY_ID: 'primary',
    SESSIONPORT_NATIVE_CSRF_KEY_BASE64: Buffer.alloc(32, 2).toString('base64'),
    SESSIONPORT_NATIVE_POLICY_JSON: JSON.stringify(CLOUD_NATIVE_POLICY),
    ...overrides,
  });
}

function fakeCloudRuntime(config: {
  readonly native: { readonly publicOrigin: string };
}): unknown {
  const authorize = async () => ({
    kind: 'device' as const,
    userID: 'user-device',
    deviceID: '44aa2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
  });
  const browser = {
    async readSession() {
      return null;
    },
    async handle() {
      return new Response(
        JSON.stringify({ user: { id: 'user-browser' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  };
  const rate = { windowSeconds: 60, maxRequests: 60 };
  return {
    api: {
      projects: {
        repository: {
          async createOrLink() {
            throw new Error('unused');
          },
          async listActive() {
            return [];
          },
          async listWithState() {
            return [];
          },
        },
        authorize,
      },
      projectList: {
        repository: { async listWithState() { return []; } },
        authorize,
      },
      revisions: {
        repository: {
          async commit() {
            throw new Error('unused');
          },
          async page() {
            throw new Error('unused');
          },
        },
        authorize,
      },
      me: {
        repository: {
          async read() {
            throw new Error('unused');
          },
        },
        authorize,
      },
      nativeAuth: {
        service: Object.fromEntries(
          [
            'createDeviceAuthorization',
            'verifyUserCode',
            'approveUserCode',
            'denyUserCode',
            'exchangeDeviceCode',
            'refreshToken',
            'listGrants',
            'revokeGrant',
            'authorizeBearer',
          ].map((method) => [
            method,
            async () => {
              throw new Error('unused');
            },
          ]),
        ),
        browser,
        config: {
          publicOrigin: config.native.publicOrigin,
          verificationUri: `${config.native.publicOrigin}/api/native/v1/device-authorizations/verify`,
          allowLoopbackHttp: false,
          csrfKey: new Uint8Array(32),
          policy: {
            rateLimits: Object.fromEntries(
              [
                'createAuthorization',
                'browserVerification',
                'browserLookup',
                'approveAuthorization',
                'denyAuthorization',
                'exchangeDeviceCode',
                'refreshToken',
                'listGrants',
                'revokeGrant',
              ].map((operation) => [operation, rate]),
            ),
            capacity: {
              maxOutstandingPendingAuthorizationsPerUser: 10,
              maxActiveGrantsPerUser: 3,
              retentionSeconds: {
                pendingAuthorizationRecords: 1,
                spentTokenRecords: 1,
                revokedGrantRecords: 1,
              },
            },
          },
        },
        rateLimiter: {
          async consume() {
            return { kind: 'allowed' };
          },
        },
      },
      browserAuth: {
        authority: browser,
        canonicalOrigin: config.native.publicOrigin,
        maxResponseBytes: 65_536,
      },
    },
  };
}

test('cloud bootstrap composes modules before listen and disconnects once', async () => {
  const before = signalSnapshot();
  const fake = fakeDatabaseClient('success');
  let listenCount = 0;
  let factoryCount = 0;

  const app = await bootstrap(cloudEnv(), {
    createDatabaseClient: () => fake.client,
    createCloudRuntime: async (_client, config) => {
      factoryCount += 1;
      assert.equal(config.mode, 'cloud');
      return fakeCloudRuntime(config) as never;
    },
    listen: async () => {
      listenCount += 1;
    },
  });

  try {
    assert.equal(factoryCount, 1);
    assert.equal(listenCount, 1);
    assert.equal(fake.disconnectCount(), 0);

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(live.statusCode, 200);

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 503);

    const nativeSession = await app.inject({
      method: 'GET',
      url: '/api/native/v1/session',
    });
    assert.equal(nativeSession.statusCode, 401);

    const browserSession = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
    });
    assert.equal(browserSession.statusCode, 200);
    assert.deepEqual(browserSession.json(), {
      user: { id: 'user-browser' },
    });
  } finally {
    try {
      await app.close();
    } finally {
      removeAddedSignalListeners(before);
    }
  }

  assert.equal(fake.disconnectCount(), 1);
});

test('cloud bootstrap validates runtime policy before client construction', async () => {
  const before = signalSnapshot();
  let clientCount = 0;
  let listenCount = 0;
  const env = cloudEnv();
  delete env.SESSIONPORT_BACKEND_POLICY_JSON;

  await assert.rejects(
    bootstrap(env, {
      createDatabaseClient: () => {
        clientCount += 1;
        return fakeDatabaseClient().client;
      },
      listen: async () => {
        listenCount += 1;
      },
    }),
  );

  assert.equal(clientCount, 0);
  assert.equal(listenCount, 0);
  assertNoAddedSignalListeners(before);
});

test('cloud factory failure disconnects the owned client once without listening', async () => {
  const before = signalSnapshot();
  const fake = fakeDatabaseClient();
  let listenCount = 0;

  await assert.rejects(
    bootstrap(cloudEnv(), {
      createDatabaseClient: () => fake.client,
      createCloudRuntime: async () => {
        throw new Error('synthetic cloud factory failure');
      },
      listen: async () => {
        listenCount += 1;
      },
    }),
    /synthetic cloud factory failure/,
  );

  assert.equal(listenCount, 0);
  assert.equal(fake.disconnectCount(), 1);
  assertNoAddedSignalListeners(before);
});
