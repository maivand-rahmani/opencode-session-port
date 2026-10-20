import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiConfigError, readApiConfig } from '../src/config.js';

const REQUIRED_KEYS = [
  'SESSIONPORT_API_PORT',
  'SESSIONPORT_PUBLIC_ORIGIN',
  'SESSIONPORT_HTTP_BODY_LIMIT_BYTES',
  'SESSIONPORT_READINESS_TIMEOUT_MS',
  'SESSIONPORT_RETRY_AFTER_SECONDS',
] as const;

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SESSIONPORT_API_PORT: '43123',
    SESSIONPORT_PUBLIC_ORIGIN: 'https://api.example.test',
    SESSIONPORT_HTTP_BODY_LIMIT_BYTES: '1048576',
    SESSIONPORT_READINESS_TIMEOUT_MS: '1500',
    SESSIONPORT_RETRY_AFTER_SECONDS: '5',
    ...overrides,
  };
}

function configErrorFor(name: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ApiConfigError);
    assert.match(error.message, new RegExp(name));
    return true;
  };
}

test('reads explicit fixture values and fixes the host to loopback', () => {
  const config = readApiConfig(
    validEnv({ SESSIONPORT_API_HOST: '0.0.0.0', SESSIONPORT_PUBLIC_ORIGIN: 'https://api.example.test/' }),
  );

  assert.deepEqual(config, {
    host: '127.0.0.1',
    port: 43123,
    publicOrigin: 'https://api.example.test',
    bodyLimitBytes: 1048576,
    readinessTimeoutMs: 1500,
    retryAfterSeconds: 5,
  });
});

test('requires every environment value explicitly', () => {
  for (const key of REQUIRED_KEYS) {
    const env = validEnv();
    delete env[key];
    assert.throws(() => readApiConfig(env), configErrorFor(key));
  }

  for (const key of REQUIRED_KEYS) {
    assert.throws(() => readApiConfig(validEnv({ [key]: '' })), configErrorFor(key));
  }
});

test('rejects malformed numbers without echoing the rejected value', () => {
  const secret = 'synthetic-number-secret';
  const cases: Array<[string, string]> = [
    ['SESSIONPORT_API_PORT', '0'],
    ['SESSIONPORT_API_PORT', '65536'],
    ['SESSIONPORT_API_PORT', '1.5'],
    ['SESSIONPORT_API_PORT', '01'],
    ['SESSIONPORT_API_PORT', ' 43123'],
    ['SESSIONPORT_API_PORT', '+43123'],
    ['SESSIONPORT_API_PORT', '1e3'],
    ['SESSIONPORT_API_PORT', secret],
    ['SESSIONPORT_HTTP_BODY_LIMIT_BYTES', '0'],
    ['SESSIONPORT_HTTP_BODY_LIMIT_BYTES', '-1'],
    ['SESSIONPORT_HTTP_BODY_LIMIT_BYTES', '999999999999999999999999999'],
    ['SESSIONPORT_READINESS_TIMEOUT_MS', '0'],
    ['SESSIONPORT_READINESS_TIMEOUT_MS', '2147483648'],
    ['SESSIONPORT_RETRY_AFTER_SECONDS', '-1'],
    ['SESSIONPORT_RETRY_AFTER_SECONDS', '2.5'],
  ];

  for (const [key, value] of cases) {
    assert.throws(
      () => readApiConfig(validEnv({ [key]: value })),
      (error: unknown) => {
        assert.ok(error instanceof ApiConfigError);
        assert.ok(error.message.includes(key));
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
  }
});

test('accepts numeric boundaries', () => {
  const config = readApiConfig(
    validEnv({
      SESSIONPORT_API_PORT: '65535',
      SESSIONPORT_RETRY_AFTER_SECONDS: '0',
    }),
  );

  assert.equal(config.port, 65535);
  assert.equal(config.retryAfterSeconds, 0);
});

test('accepts HTTPS origins and HTTP loopback origins only', () => {
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
    assert.equal(
      readApiConfig(validEnv({ SESSIONPORT_PUBLIC_ORIGIN: input })).publicOrigin,
      expected,
    );
  }
});

test('rejects non-origin, insecure remote, and credential-bearing origins', () => {
  const secret = 'synthetic-origin-secret';
  const rejected = [
    'http://api.example.test',
    'http://192.168.1.10:4321',
    'http://0.0.0.0:4321',
    `https://user:${secret}@api.example.test`,
    'https://api.example.test/path',
    'https://api.example.test//',
    'https://api.example.test?query=1',
    'https://api.example.test#fragment',
    'ftp://api.example.test',
    'not a url',
    ' https://api.example.test',
    'https://*.example.test',
    'https://.example.test',
    'https://example..test',
    'https://exa_mple.test',
    'https://-bad.example.test',
  ];

  for (const origin of rejected) {
    assert.throws(
      () => readApiConfig(validEnv({ SESSIONPORT_PUBLIC_ORIGIN: origin })),
      (error: unknown) => {
        assert.ok(error instanceof ApiConfigError);
        assert.ok(!error.message.includes(secret));
        assert.ok(!error.message.includes(origin));
        return true;
      },
    );
  }
});
