import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApiConfig } from '../../src/config.js';
import { NativeAuthConfigError } from '../../src/native-auth/config.js';
import {
  API_MODE_ENV,
  BACKEND_POLICY_ENV,
  RUNTIME_ENV_INVENTORY,
  RuntimeConfigError,
  readRuntimeConfig,
} from '../../src/runtime/config.js';

const API_CONFIG: ApiConfig = {
  host: '127.0.0.1',
  port: 43123,
  publicOrigin: 'https://api.example.test',
  bodyLimitBytes: 1_048_576,
  readinessTimeoutMs: 1_500,
  retryAfterSeconds: 5,
};

const KEYS = {
  betterAuthSecret: 'a'.repeat(40),
  githubClientID: 'github-client-id',
  githubClientSecret: 'github-client-secret',
  humanCodeKey: Buffer.alloc(32, 1).toString('base64'),
  csrfKey: Buffer.alloc(32, 2).toString('base64'),
} as const;

const BACKEND_POLICY = {
  maxActiveProjects: 10,
  maxActiveDevices: 3,
  maxCiphertextBytes: 104_857_600,
  maxPageSize: 100,
  maxOutstandingPendingAuthorizationsGlobal: 500,
  maxRateLimitEntries: 10_000,
  maxAuthResponseBytes: 65_536,
} as const;

const NATIVE_POLICY = {
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
  rateLimits: {
    createAuthorization: { windowSeconds: 60, maxRequests: 60 },
    browserVerification: { windowSeconds: 60, maxRequests: 30 },
    browserLookup: { windowSeconds: 60, maxRequests: 60 },
    approveAuthorization: { windowSeconds: 60, maxRequests: 30 },
    denyAuthorization: { windowSeconds: 60, maxRequests: 30 },
    exchangeDeviceCode: { windowSeconds: 60, maxRequests: 60 },
    refreshToken: { windowSeconds: 60, maxRequests: 60 },
    listGrants: { windowSeconds: 60, maxRequests: 60 },
    revokeGrant: { windowSeconds: 60, maxRequests: 30 },
  },
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
  return {
    SESSIONPORT_PUBLIC_ORIGIN: API_CONFIG.publicOrigin,
    SESSIONPORT_NATIVE_ALLOW_LOOPBACK_HTTP: 'false',
    SESSIONPORT_BETTER_AUTH_SECRET: KEYS.betterAuthSecret,
    SESSIONPORT_GITHUB_CLIENT_ID: KEYS.githubClientID,
    SESSIONPORT_GITHUB_CLIENT_SECRET: KEYS.githubClientSecret,
    SESSIONPORT_NATIVE_HUMAN_CODE_KEYS_JSON: JSON.stringify([
      { id: 'primary', keyBase64: KEYS.humanCodeKey },
    ]),
    SESSIONPORT_NATIVE_HUMAN_CODE_ACTIVE_KEY_ID: 'primary',
    SESSIONPORT_NATIVE_CSRF_KEY_BASE64: KEYS.csrfKey,
    SESSIONPORT_NATIVE_POLICY_JSON: JSON.stringify(NATIVE_POLICY),
    [API_MODE_ENV]: 'cloud',
    [BACKEND_POLICY_ENV]: JSON.stringify(BACKEND_POLICY),
    ...overrides,
  };
}

function expectedError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof RuntimeConfigError);
    assert.equal(error.code, code);
    return true;
  };
}

test('missing mode safely selects health-only without reading cloud values', () => {
  const config = readRuntimeConfig({}, API_CONFIG);
  assert.deepEqual(config, { mode: 'health-only' });
});

test('explicit health-only mode ignores cloud policy and native values', () => {
  const config = readRuntimeConfig(
    cloudEnv({ [API_MODE_ENV]: 'health-only', [BACKEND_POLICY_ENV]: 'invalid' }),
    API_CONFIG,
  );
  assert.deepEqual(config, { mode: 'health-only' });
});

test('invalid mode fails fixed before any client work', () => {
  for (const value of ['', 'cloudy', 'CLOUD', ' health-only']) {
    assert.throws(
      () => readRuntimeConfig(cloudEnv({ [API_MODE_ENV]: value }), API_CONFIG),
      expectedError('invalid-api-mode'),
      value,
    );
  }
});

test('cloud mode validates the exact backend policy shape and bounds', () => {
  const invalidPolicies: unknown[] = [
    undefined,
    '',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...BACKEND_POLICY, extra: 1 }),
    JSON.stringify({ ...BACKEND_POLICY, maxActiveProjects: 0 }),
    JSON.stringify({ ...BACKEND_POLICY, maxPageSize: -1 }),
    JSON.stringify({ ...BACKEND_POLICY, maxAuthResponseBytes: 1.5 }),
    '{"maxActiveProjects":1}',
  ];

  for (const value of invalidPolicies) {
    const env = cloudEnv();
    if (value === undefined) {
      delete env[BACKEND_POLICY_ENV];
    } else {
      env[BACKEND_POLICY_ENV] = String(value);
    }
    assert.throws(
      () => readRuntimeConfig(env, API_CONFIG),
      expectedError('invalid-backend-policy'),
    );
  }
});

test('cloud mode requires native auth to match the API origin and device cap', () => {
  assert.throws(
    () =>
      readRuntimeConfig(
        cloudEnv({ SESSIONPORT_PUBLIC_ORIGIN: 'https://other.example.test' }),
        API_CONFIG,
      ),
    expectedError('origin-mismatch'),
  );

  assert.throws(
    () =>
      readRuntimeConfig(
        cloudEnv({
          [BACKEND_POLICY_ENV]: JSON.stringify({
            ...BACKEND_POLICY,
            maxActiveDevices: 4,
          }),
        }),
        API_CONFIG,
      ),
    expectedError('capacity-mismatch'),
  );
});

test('cloud mode requires every frozen route scope entry', () => {
  const policy = JSON.parse(
    JSON.stringify(NATIVE_POLICY),
  ) as {
    authorization: {
      requiredRouteScopes: Record<string, string[]>;
    };
  };
  delete policy.authorization.requiredRouteScopes['me.read'];

  assert.throws(
    () =>
      readRuntimeConfig(
        cloudEnv({
          SESSIONPORT_NATIVE_POLICY_JSON: JSON.stringify(policy),
        }),
        API_CONFIG,
      ),
    expectedError('missing-route-policy'),
  );
});

test('missing native secrets fail closed before a cloud runtime exists', () => {
  const env = cloudEnv();
  delete env.SESSIONPORT_BETTER_AUTH_SECRET;
  assert.throws(
    () => readRuntimeConfig(env, API_CONFIG),
    NativeAuthConfigError,
  );
});

test('valid cloud mode returns frozen backend/native policy with no values inventory', () => {
  const config = readRuntimeConfig(cloudEnv(), API_CONFIG);
  assert.equal(config.mode, 'cloud');
  if (config.mode !== 'cloud') {
    throw new Error('expected cloud mode');
  }

  assert.deepEqual(config.backend, BACKEND_POLICY);
  assert.equal(config.native.publicOrigin, API_CONFIG.publicOrigin);
  assert.equal(
    config.native.policy.capacity.maxActiveGrantsPerUser,
    config.backend.maxActiveDevices,
  );
  assert.equal(
    config.native.policy.authorization.requiredRouteScopes['me.read']?.[0],
    'me:read',
  );
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.backend), true);

  const rendered = JSON.stringify(RUNTIME_ENV_INVENTORY);
  assert.ok(rendered.includes(API_MODE_ENV));
  assert.ok(rendered.includes(BACKEND_POLICY_ENV));
  for (const secret of [
    KEYS.betterAuthSecret,
    KEYS.githubClientSecret,
    KEYS.csrfKey,
    KEYS.humanCodeKey,
  ]) {
    assert.equal(rendered.includes(secret), false);
  }
});
