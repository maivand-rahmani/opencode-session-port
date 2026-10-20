import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NATIVE_AUTH_ENV,
  NATIVE_AUTH_ENV_INVENTORY,
  NativeAuthConfigError,
  NATIVE_VERIFICATION_PATH,
  readNativeAuthConfig,
} from '../../src/native-auth/config.js';

const HUMAN_KEY_ACTIVE = Buffer.alloc(32, 0x11).toString('base64');
const HUMAN_KEY_RETIRING = Buffer.alloc(32, 0x22).toString('base64');
const HUMAN_KEY_OTHER = Buffer.alloc(32, 0x44).toString('base64');
const CSRF_KEY = Buffer.alloc(32, 0x33).toString('base64');
const BA_SECRET = 'synthetic-better-auth-secret-0123456789abcdef';
const RETIRE_AFTER = '2099-01-01T00:00:00.000Z';
const FIXED_MESSAGE = 'NativeAuthConfigError';
const SECRET_SENTINEL = 'synthetic-config-secret-sentinel-9f31';

function policyObject() {
  return {
    ttlSeconds: {
      pendingAuthorization: 600,
      accessToken: 900,
      refreshToken: 86_400,
      grant: 2_592_000,
    },
    polling: {
      intervalSeconds: 5,
      backoffIncrementSeconds: 5,
      maxIntervalSeconds: 60,
    },
    rateLimits: {
      createAuthorization: { windowSeconds: 60, maxRequests: 10 },
      browserVerification: { windowSeconds: 60, maxRequests: 60 },
      browserLookup: { windowSeconds: 60, maxRequests: 30 },
      approveAuthorization: { windowSeconds: 60, maxRequests: 10 },
      denyAuthorization: { windowSeconds: 60, maxRequests: 10 },
      exchangeDeviceCode: { windowSeconds: 60, maxRequests: 60 },
      refreshToken: { windowSeconds: 60, maxRequests: 60 },
      listGrants: { windowSeconds: 60, maxRequests: 60 },
      revokeGrant: { windowSeconds: 60, maxRequests: 20 },
    },
    capacity: {
      maxOutstandingPendingAuthorizationsPerUser: 5,
      maxActiveGrantsPerUser: 10,
      retentionSeconds: {
        pendingAuthorizationRecords: 86_400,
        spentTokenRecords: 2_592_000,
        revokedGrantRecords: 2_592_000,
      },
    },
    authorization: {
      audience: 'synthetic-sessionport-api',
      resource: 'https://api.example.test',
      allowedScopes: ['projects:read', 'projects:write'],
      requiredRouteScopes: {
        'projects.create': ['projects:write'],
        'projects.list': ['projects:read'],
      },
    },
  };
}

function humanKeys(): string {
  return JSON.stringify([
    {
      id: 'active',
      keyBase64: HUMAN_KEY_ACTIVE,
      retireAfter: RETIRE_AFTER,
    },
    {
      id: 'retiring',
      keyBase64: HUMAN_KEY_RETIRING,
    },
  ]);
}

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [NATIVE_AUTH_ENV.publicOrigin]: 'https://api.example.test/',
    [NATIVE_AUTH_ENV.allowLoopbackHttp]: 'false',
    [NATIVE_AUTH_ENV.betterAuthSecret]: BA_SECRET,
    [NATIVE_AUTH_ENV.githubClientID]: 'synthetic-github-client-id',
    [NATIVE_AUTH_ENV.githubClientSecret]: 'synthetic-github-client-secret',
    [NATIVE_AUTH_ENV.humanCodeKeys]: humanKeys(),
    [NATIVE_AUTH_ENV.activeHumanCodeKeyID]: 'active',
    [NATIVE_AUTH_ENV.csrfKey]: CSRF_KEY,
    [NATIVE_AUTH_ENV.policy]: JSON.stringify(policyObject()),
    ...overrides,
  };
}

function assertConfigError(error: unknown): boolean {
  assert.ok(error instanceof NativeAuthConfigError);
  assert.equal(error.name, FIXED_MESSAGE);
  assert.equal(error.code, 'invalid-native-auth-config');
  assert.equal(error.cause, undefined);
  return true;
}

function mutatePolicy(
  mutate: (policy: ReturnType<typeof policyObject>) => void,
): string {
  const policy = policyObject();
  mutate(policy);
  return JSON.stringify(policy);
}

test('reads explicit synthetic values into a canonical frozen configuration', () => {
  const config = readNativeAuthConfig(validEnv());

  assert.equal(config.publicOrigin, 'https://api.example.test');
  assert.equal(
    config.verificationUri,
    `https://api.example.test${NATIVE_VERIFICATION_PATH}`,
  );
  assert.equal(
    config.verificationUri,
    'https://api.example.test/api/native/v1/device-authorizations/verify',
  );
  assert.equal(config.allowLoopbackHttp, false);
  assert.equal(config.betterAuth.secret, BA_SECRET);
  assert.equal(
    config.betterAuth.github.clientID,
    'synthetic-github-client-id',
  );
  assert.equal(
    config.betterAuth.github.clientSecret,
    'synthetic-github-client-secret',
  );
  assert.equal(config.humanCodes.activeKeyID, 'active');
  assert.deepEqual(
    config.humanCodes.keys.map((key) => key.id),
    ['active', 'retiring'],
  );
  assert.deepEqual(config.humanCodes.keys[0].key, Buffer.alloc(32, 0x11));
  assert.equal(
    config.humanCodes.keys[0].retireAfter?.toISOString(),
    RETIRE_AFTER,
  );
  assert.equal(config.humanCodes.keys[1].retireAfter, undefined);
  assert.deepEqual(config.csrfKey, Buffer.alloc(32, 0x33));
  assert.equal(config.policy.ttlSeconds.grant, 2_592_000);
  assert.deepEqual(
    config.policy.authorization.requiredRouteScopes['projects.create'],
    ['projects:write'],
  );

  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.betterAuth), true);
  assert.equal(Object.isFrozen(config.humanCodes), true);
  assert.equal(Object.isFrozen(config.humanCodes.keys), true);
  assert.equal(Object.isFrozen(config.policy), true);
  assert.equal(Object.isFrozen(config.policy.ttlSeconds), true);
  assert.equal(
    Object.isFrozen(config.policy.authorization.requiredRouteScopes),
    true,
  );
});

test('returns a value-free environment inventory report', () => {
  assert.equal(NATIVE_AUTH_ENV_INVENTORY.length, 9);
  assert.equal(
    new Set(NATIVE_AUTH_ENV_INVENTORY.map((entry) => entry.name)).size,
    NATIVE_AUTH_ENV_INVENTORY.length,
  );

  const secretEntries = NATIVE_AUTH_ENV_INVENTORY.filter(
    (entry) => entry.secret,
  ).map((entry) => entry.name);
  assert.deepEqual(secretEntries, [
    NATIVE_AUTH_ENV.betterAuthSecret,
    NATIVE_AUTH_ENV.githubClientSecret,
    NATIVE_AUTH_ENV.humanCodeKeys,
    NATIVE_AUTH_ENV.csrfKey,
  ]);

  const rendered = JSON.stringify(NATIVE_AUTH_ENV_INVENTORY);
  assert.equal(rendered.includes(BA_SECRET), false);
  assert.equal(rendered.includes(HUMAN_KEY_ACTIVE), false);
  assert.equal(rendered.includes(CSRF_KEY), false);
  for (const entry of NATIVE_AUTH_ENV_INVENTORY) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(typeof entry.purpose, 'string');
    assert.ok(entry.purpose.length > 0);
  }
});

test('requires every environment key explicitly', () => {
  const keys = [
    NATIVE_AUTH_ENV.publicOrigin,
    NATIVE_AUTH_ENV.allowLoopbackHttp,
    NATIVE_AUTH_ENV.betterAuthSecret,
    NATIVE_AUTH_ENV.githubClientID,
    NATIVE_AUTH_ENV.githubClientSecret,
    NATIVE_AUTH_ENV.humanCodeKeys,
    NATIVE_AUTH_ENV.activeHumanCodeKeyID,
    NATIVE_AUTH_ENV.csrfKey,
    NATIVE_AUTH_ENV.policy,
  ] as const;

  for (const key of keys) {
    const env = validEnv();
    delete env[key];
    assert.throws(
      () => readNativeAuthConfig(env),
      (error: unknown) => {
        assertConfigError(error);
        assert.ok((error as Error).message.includes(key));
        return true;
      },
    );
    assert.throws(
      () => readNativeAuthConfig(validEnv({ [key]: '' })),
      assertConfigError,
    );
  }
});

test('requires strict true/false loopback flag values', () => {
  for (const value of ['TRUE', 'FALSE', '1', '0', 'yes', ' true', 'true ']) {
    assert.throws(
      () =>
        readNativeAuthConfig(
          validEnv({ [NATIVE_AUTH_ENV.allowLoopbackHttp]: value }),
        ),
      assertConfigError,
    );
  }

  assert.equal(
    readNativeAuthConfig(
      validEnv({ [NATIVE_AUTH_ENV.allowLoopbackHttp]: 'true' }),
    ).allowLoopbackHttp,
    true,
  );
  assert.equal(
    readNativeAuthConfig(
      validEnv({ [NATIVE_AUTH_ENV.allowLoopbackHttp]: 'false' }),
    ).allowLoopbackHttp,
    false,
  );
});

test('accepts HTTPS and explicitly allowed HTTP loopback origins only', () => {
  const accepted = new Map<string, string>([
    ['https://api.example.test', 'https://api.example.test'],
    ['https://api.example.test/', 'https://api.example.test'],
    ['https://api.example.test:8443', 'https://api.example.test:8443'],
    ['https://api.example.test:443', 'https://api.example.test'],
    ['http://127.0.0.1:4321', 'http://127.0.0.1:4321'],
    ['http://localhost:4321/', 'http://localhost:4321'],
    ['http://[::1]:4321', 'http://[::1]:4321'],
  ]);

  for (const [input, expected] of accepted) {
    const config = readNativeAuthConfig(
      validEnv({
        [NATIVE_AUTH_ENV.publicOrigin]: input,
        [NATIVE_AUTH_ENV.allowLoopbackHttp]: input.startsWith('http:')
          ? 'true'
          : 'false',
      }),
    );
    assert.equal(config.publicOrigin, expected);
    assert.equal(config.verificationUri, `${expected}${NATIVE_VERIFICATION_PATH}`);
    assert.equal(config.verificationUri.includes('?'), false);
    assert.equal(config.verificationUri.includes('#'), false);
  }

  const rejected = [
    ['http://api.example.test', 'true'],
    ['http://192.168.1.10:4321', 'true'],
    ['http://localhost:4321', 'false'],
    ['https://user:pass@api.example.test', 'false'],
    ['https://api.example.test/path', 'false'],
    ['https://api.example.test//', 'false'],
    ['https://api.example.test?query=1', 'false'],
    ['https://api.example.test#fragment', 'false'],
    ['ftp://api.example.test', 'false'],
    ['not a url', 'false'],
    [' https://api.example.test', 'false'],
    ['https://*.example.test', 'false'],
    ['https://.example.test', 'false'],
    ['https://example..test', 'false'],
    ['https://exa_mple.test', 'false'],
    ['https://-bad.example.test', 'false'],
  ] as const;

  for (const [origin, allowLoopback] of rejected) {
    assert.throws(
      () =>
        readNativeAuthConfig(
          validEnv({
            [NATIVE_AUTH_ENV.publicOrigin]: origin,
            [NATIVE_AUTH_ENV.allowLoopbackHttp]: allowLoopback,
          }),
        ),
      assertConfigError,
    );
  }
});

test('validates secret presence, minimum bytes, and canonical Base64', () => {
  const cases: Array<[string, string]> = [
    [NATIVE_AUTH_ENV.betterAuthSecret, 'short'],
    [NATIVE_AUTH_ENV.betterAuthSecret, ` ${BA_SECRET}`],
    [NATIVE_AUTH_ENV.betterAuthSecret, `${BA_SECRET}\n`],
    [NATIVE_AUTH_ENV.githubClientID, ' client '],
    [NATIVE_AUTH_ENV.githubClientSecret, ''],
    [NATIVE_AUTH_ENV.csrfKey, 'not-base64'],
    [NATIVE_AUTH_ENV.csrfKey, Buffer.alloc(31, 0x33).toString('base64')],
    [NATIVE_AUTH_ENV.csrfKey, CSRF_KEY.slice(0, -2)],
  ];

  for (const [key, value] of cases) {
    assert.throws(
      () => readNativeAuthConfig(validEnv({ [key]: value })),
      assertConfigError,
    );
  }

  const baSecretAsKey = Buffer.from(BA_SECRET, 'utf8').toString('base64');
  assert.throws(
    () =>
      readNativeAuthConfig(
        validEnv({ [NATIVE_AUTH_ENV.csrfKey]: baSecretAsKey }),
      ),
    (error: unknown) => {
      assertConfigError(error);
      assert.equal(
        (error as Error).message.includes(baSecretAsKey),
        false,
      );
      return true;
    },
  );
});

test('parses active and retiring human-code keys and rejects key ring defects', () => {
  const config = readNativeAuthConfig(validEnv());
  assert.equal(config.humanCodes.keys.length, 2);

  const base = policyObject();
  assert.ok(base.capacity.retentionSeconds.spentTokenRecords > 0);

  const invalidRings: unknown[] = [
    [],
    {},
    [{}],
    [{ id: 'active' }],
    [{ keyBase64: HUMAN_KEY_ACTIVE }],
    [{ id: 'active', keyBase64: HUMAN_KEY_ACTIVE, extra: true }],
    [
      { id: 'same', keyBase64: HUMAN_KEY_ACTIVE },
      { id: 'same', keyBase64: HUMAN_KEY_RETIRING },
    ],
    [
      { id: 'one', keyBase64: HUMAN_KEY_ACTIVE },
      { id: 'two', keyBase64: HUMAN_KEY_ACTIVE },
    ],
    [{ id: 'active', keyBase64: 'not-base64' }],
    [{ id: 'active', keyBase64: Buffer.alloc(31, 0x11).toString('base64') }],
    [{ id: 'active', keyBase64: HUMAN_KEY_ACTIVE, retireAfter: 'tomorrow' }],
    [{ id: 'active', keyBase64: HUMAN_KEY_ACTIVE, retireAfter: '2099-01-01' }],
    [{ id: 'bad id', keyBase64: HUMAN_KEY_ACTIVE }],
  ];

  for (const ring of invalidRings) {
    assert.throws(
      () =>
        readNativeAuthConfig(
          validEnv({
            [NATIVE_AUTH_ENV.humanCodeKeys]: JSON.stringify(ring),
          }),
        ),
      assertConfigError,
    );
  }

  assert.throws(
    () =>
      readNativeAuthConfig(
        validEnv({
          [NATIVE_AUTH_ENV.humanCodeKeys]: '{not-json',
        }),
      ),
    assertConfigError,
  );
  assert.throws(
    () =>
      readNativeAuthConfig(
        validEnv({
          [NATIVE_AUTH_ENV.activeHumanCodeKeyID]: 'miss',
        }),
      ),
    assertConfigError,
  );

  const duplicateCsrfMaterial = JSON.stringify([
    { id: 'active', keyBase64: CSRF_KEY },
  ]);
  assert.throws(
    () =>
      readNativeAuthConfig(
        validEnv({
          [NATIVE_AUTH_ENV.humanCodeKeys]: duplicateCsrfMaterial,
        }),
      ),
    assertConfigError,
  );

  const baSecretMaterial = JSON.stringify([
    {
      id: 'active',
      keyBase64: Buffer.from(BA_SECRET, 'utf8').toString('base64'),
    },
  ]);
  assert.throws(
    () =>
      readNativeAuthConfig(
        validEnv({
          [NATIVE_AUTH_ENV.humanCodeKeys]: baSecretMaterial,
        }),
      ),
    assertConfigError,
  );

  const optionalRetire = JSON.parse(humanKeys()) as Array<Record<string, unknown>>;
  optionalRetire[1].retireAfter = RETIRE_AFTER;
  optionalRetire[1].keyBase64 = HUMAN_KEY_OTHER;
  const withRetiringDate = readNativeAuthConfig(
    validEnv({
      [NATIVE_AUTH_ENV.humanCodeKeys]: JSON.stringify(optionalRetire),
    }),
  );
  assert.equal(
    withRetiringDate.humanCodes.keys[1].retireAfter?.toISOString(),
    RETIRE_AFTER,
  );
});

test('requires the native policy JSON object with exact root properties', () => {
  const invalidValues = [
    '',
    'not-json',
    'null',
    '[]',
    JSON.stringify({ ...policyObject(), extra: true }),
    JSON.stringify({
      ttlSeconds: policyObject().ttlSeconds,
      polling: policyObject().polling,
      rateLimits: policyObject().rateLimits,
      capacity: policyObject().capacity,
    }),
  ];

  for (const policy of invalidValues) {
    assert.throws(
      () =>
        readNativeAuthConfig(
          validEnv({ [NATIVE_AUTH_ENV.policy]: policy }),
        ),
      assertConfigError,
    );
  }
});

test('requires positive safe integer TTLs with access/refresh bounded by grant', () => {
  const invalidPolicies = [
    mutatePolicy((policy) => {
      policy.ttlSeconds.pendingAuthorization = 0;
    }),
    mutatePolicy((policy) => {
      policy.ttlSeconds.accessToken = -1;
    }),
    mutatePolicy((policy) => {
      (policy.ttlSeconds.refreshToken as unknown as string) = '60';
    }),
    mutatePolicy((policy) => {
      policy.ttlSeconds.grant = Number.MAX_SAFE_INTEGER + 1;
    }),
    mutatePolicy((policy) => {
      policy.ttlSeconds.accessToken = policy.ttlSeconds.grant + 1;
    }),
    mutatePolicy((policy) => {
      policy.ttlSeconds.refreshToken = policy.ttlSeconds.grant + 1;
    }),
    mutatePolicy((policy) => {
      delete (policy.ttlSeconds as Partial<typeof policy.ttlSeconds>)
        .pendingAuthorization;
    }),
    mutatePolicy((policy) => {
      (policy.ttlSeconds as Record<string, unknown>).extra = 1;
    }),
  ];

  for (const policy of invalidPolicies) {
    assert.throws(
      () =>
        readNativeAuthConfig(
          validEnv({ [NATIVE_AUTH_ENV.policy]: policy }),
        ),
      assertConfigError,
    );
  }

  const equalBoundary = readNativeAuthConfig(
    validEnv({
      [NATIVE_AUTH_ENV.policy]: mutatePolicy((policy) => {
        policy.ttlSeconds.accessToken = policy.ttlSeconds.grant;
        policy.ttlSeconds.refreshToken = policy.ttlSeconds.grant;
      }),
    }),
  );
  assert.equal(
    equalBoundary.policy.ttlSeconds.accessToken,
    equalBoundary.policy.ttlSeconds.grant,
  );
});

test('requires complete bounded polling and per-operation rate policies', () => {
  const invalidPolicies = [
    mutatePolicy((policy) => {
      policy.polling.maxIntervalSeconds = policy.polling.intervalSeconds - 1;
    }),
    mutatePolicy((policy) => {
      policy.polling.backoffIncrementSeconds =
        policy.polling.maxIntervalSeconds + 1;
    }),
    mutatePolicy((policy) => {
      policy.polling.intervalSeconds = 0;
    }),
    mutatePolicy((policy) => {
      delete (policy.polling as Partial<typeof policy.polling>)
        .backoffIncrementSeconds;
    }),
    mutatePolicy((policy) => {
      delete (policy.rateLimits as Partial<typeof policy.rateLimits>)
        .revokeGrant;
    }),
    mutatePolicy((policy) => {
      policy.rateLimits.approveAuthorization.maxRequests = 0;
    }),
    mutatePolicy((policy) => {
      policy.rateLimits.browserLookup.windowSeconds = 1.5;
    }),
    mutatePolicy((policy) => {
      (policy.rateLimits.browserLookup as Record<string, unknown>).extra = 1;
    }),
  ];

  for (const policy of invalidPolicies) {
    assert.throws(
      () =>
        readNativeAuthConfig(
          validEnv({ [NATIVE_AUTH_ENV.policy]: policy }),
        ),
      assertConfigError,
    );
  }
});

test('requires capacity, retention, audience, resource, and route scope policy', () => {
  const invalidPolicies = [
    mutatePolicy((policy) => {
      policy.capacity.maxActiveGrantsPerUser = 0;
    }),
    mutatePolicy((policy) => {
      delete (policy.capacity.retentionSeconds as Partial<
        typeof policy.capacity.retentionSeconds
      >).spentTokenRecords;
    }),
    mutatePolicy((policy) => {
      policy.capacity.retentionSeconds.revokedGrantRecords = -1;
    }),
    mutatePolicy((policy) => {
      (policy.authorization as Record<string, unknown>).audience = ' ';
    }),
    mutatePolicy((policy) => {
      policy.authorization.resource = '';
    }),
    mutatePolicy((policy) => {
      policy.authorization.allowedScopes = [];
    }),
    mutatePolicy((policy) => {
      policy.authorization.allowedScopes = ['projects:read', 'projects:read'];
    }),
    mutatePolicy((policy) => {
      policy.authorization.allowedScopes = ['bad scope'];
    }),
    mutatePolicy((policy) => {
      (
        policy.authorization as unknown as {
          requiredRouteScopes: Record<string, string[]>;
        }
      ).requiredRouteScopes = {};
    }),
    mutatePolicy((policy) => {
      (
        policy.authorization as unknown as {
          requiredRouteScopes: Record<string, string[]>;
        }
      ).requiredRouteScopes = {
        'Projects.Create': ['projects:write'],
      };
    }),
    mutatePolicy((policy) => {
      (
        policy.authorization as unknown as {
          requiredRouteScopes: Record<string, string[]>;
        }
      ).requiredRouteScopes = {
        'projects.create': ['outside:allowlist'],
      };
    }),
    mutatePolicy((policy) => {
      (
        policy.authorization as unknown as {
          requiredRouteScopes: Record<string, string[]>;
        }
      ).requiredRouteScopes = {
        'projects.create': [],
      };
    }),
  ];

  for (const policy of invalidPolicies) {
    assert.throws(
      () =>
        readNativeAuthConfig(
          validEnv({ [NATIVE_AUTH_ENV.policy]: policy }),
        ),
      assertConfigError,
    );
  }
});

test('errors never echo rejected secrets, key material, origins, or policy values', () => {
  const secretCases: NodeJS.ProcessEnv[] = [
    validEnv({
      [NATIVE_AUTH_ENV.betterAuthSecret]: ` ${SECRET_SENTINEL}`,
    }),
    validEnv({
      [NATIVE_AUTH_ENV.csrfKey]: SECRET_SENTINEL,
    }),
    validEnv({
      [NATIVE_AUTH_ENV.humanCodeKeys]: JSON.stringify([
        { id: 'active', keyBase64: SECRET_SENTINEL },
      ]),
    }),
    validEnv({
      [NATIVE_AUTH_ENV.activeHumanCodeKeyID]: SECRET_SENTINEL,
    }),
    validEnv({
      [NATIVE_AUTH_ENV.publicOrigin]: `https://${SECRET_SENTINEL}.example.test/path`,
    }),
    validEnv({
      [NATIVE_AUTH_ENV.policy]: mutatePolicy((policy) => {
        (policy.ttlSeconds.accessToken as unknown as string) =
          SECRET_SENTINEL;
      }),
    }),
    validEnv({
      [NATIVE_AUTH_ENV.policy]: `{"secret":"${SECRET_SENTINEL}"}`,
    }),
  ];

  for (const env of secretCases) {
    assert.throws(
      () => readNativeAuthConfig(env),
      (error: unknown) => {
        assertConfigError(error);
        const rendered = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
        assert.equal(rendered.includes(SECRET_SENTINEL), false);
        return true;
      },
    );
  }
});

test('reads only the documented environment keys from a guarded environment', () => {
  const base = validEnv();
  const guarded = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property.startsWith('SESSIONPORT_')) {
        const documented = NATIVE_AUTH_ENV_INVENTORY.some(
          (entry) => entry.name === property,
        );
        assert.equal(documented, true);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as NodeJS.ProcessEnv;

  const config = readNativeAuthConfig(guarded);
  assert.equal(config.publicOrigin, 'https://api.example.test');
});
