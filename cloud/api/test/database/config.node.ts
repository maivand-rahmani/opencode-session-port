import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DatabaseConfigError,
  readMigrationDatabaseConfig,
  readRuntimeDatabaseConfig,
} from '../../src/database/config.js';

const RUNTIME_KEY = 'SESSIONPORT_RUNTIME_DATABASE_URL';
const MIGRATION_KEY = 'SESSIONPORT_MIGRATOR_DATABASE_URL';

const RUNTIME_URL =
  'postgresql://sessionport_runtime:synth%40tic%3Apass%2Fword%23%25@session-port-postgres:5432/session_port?sslmode=disable&connect_timeout=5&application_name=sessionport-api';
const MIGRATION_URL =
  'postgres://sessionport_migrator:synth%3Amigration%40pass@session-port-postgres:5432/session_port?sslmode=disable&unknown_parameter=preserved';

const READERS = [
  { key: RUNTIME_KEY, read: readRuntimeDatabaseConfig },
  { key: MIGRATION_KEY, read: readMigrationDatabaseConfig },
] as const;

const FIXED_MESSAGE = 'Database connection configuration is invalid.';

function assertConfigError(error: unknown): boolean {
  assert.ok(error instanceof DatabaseConfigError);
  assert.equal(error.name, 'DatabaseConfigError');
  assert.equal(error.code, 'invalid-database-config');
  assert.equal(error.message, FIXED_MESSAGE);
  return true;
}

function guardedEnv(
  exposedKey: string,
  exposedValue: string,
  forbiddenKeys: readonly string[],
): NodeJS.ProcessEnv {
  return new Proxy(
    { [exposedKey]: exposedValue },
    {
      get(target, property, receiver) {
        if (typeof property === 'string' && forbiddenKeys.includes(property)) {
          throw new Error('cross-purpose environment access');
        }
        return Reflect.get(target, property, receiver);
      },
    },
  ) as NodeJS.ProcessEnv;
}

test('runtime and migration readers return the exact configured URL', () => {
  const runtime = readRuntimeDatabaseConfig({ [RUNTIME_KEY]: RUNTIME_URL });
  const migration = readMigrationDatabaseConfig({
    [MIGRATION_KEY]: MIGRATION_URL,
  });

  assert.deepEqual(runtime, { connectionString: RUNTIME_URL });
  assert.deepEqual(migration, { connectionString: MIGRATION_URL });
  assert.equal(runtime.connectionString, RUNTIME_URL);
  assert.equal(migration.connectionString, MIGRATION_URL);
  assert.ok(Object.isFrozen(runtime));
  assert.ok(Object.isFrozen(migration));
});

test('each reader requires only its own non-empty string environment key', () => {
  for (const { key, read } of READERS) {
    assert.throws(() => read({}), assertConfigError);
    assert.throws(() => read({ [key]: '' }), assertConfigError);
    assert.throws(() => read({ [key]: '   ' }), assertConfigError);
    assert.throws(
      () => read({ [key]: 42 } as unknown as NodeJS.ProcessEnv),
      assertConfigError,
    );
    assert.throws(
      () => read({ [key]: null } as unknown as NodeJS.ProcessEnv),
      assertConfigError,
    );
  }
});

test('each reader ignores the other purpose and legacy alias keys', () => {
  assert.equal(
    readRuntimeDatabaseConfig(
      guardedEnv(RUNTIME_KEY, RUNTIME_URL, [MIGRATION_KEY, 'DATABASE_URL']),
    ).connectionString,
    RUNTIME_URL,
  );
  assert.equal(
    readMigrationDatabaseConfig(
      guardedEnv(MIGRATION_KEY, MIGRATION_URL, [RUNTIME_KEY, 'DATABASE_URL']),
    ).connectionString,
    MIGRATION_URL,
  );

  assert.throws(
    () => readRuntimeDatabaseConfig({ [MIGRATION_KEY]: MIGRATION_URL }),
    assertConfigError,
  );
  assert.throws(
    () => readMigrationDatabaseConfig({ [RUNTIME_KEY]: RUNTIME_URL }),
    assertConfigError,
  );
  assert.throws(
    () => readRuntimeDatabaseConfig({ DATABASE_URL: RUNTIME_URL }),
    assertConfigError,
  );
  assert.throws(
    () => readMigrationDatabaseConfig({ DATABASE_URL: MIGRATION_URL }),
    assertConfigError,
  );
});

test('readers reject unsupported schemes, absent hosts, and invalid ports', () => {
  const invalid = [
    'mysql://user:pass@host:5432/db',
    'postgres+ssl://user:pass@host:5432/db',
    'postgres:/user:pass@host/db',
    'postgres:user:pass@host/db',
    'postgres://user:pass@/db',
    'postgres://user:pass@host:0/db',
    'postgres://user:pass@host:65536/db',
    'postgres://user:pass@host:not-a-port/db',
    'postgres://user:pass@host:/db',
    'postgres://user:pass@[::1]:/db',
    'not a url',
    'postgres://user:pass@host/db#',
    'postgres://user:pass@host/db#fragment',
  ];

  for (const value of invalid) {
    assert.throws(
      () => readRuntimeDatabaseConfig({ [RUNTIME_KEY]: value }),
      assertConfigError,
      value,
    );
  }
});

test('readers accept valid ports, schemes, and optional ports', () => {
  const valid = [
    'postgres://user:pass@host/db',
    'postgresql://user:pass@host/db',
    'postgres://user:pass@host:1/db',
    'postgresql://user:pass@host:65535/db',
    'postgres://user:pass@[::1]:5432/db',
  ];

  for (const value of valid) {
    assert.equal(
      readRuntimeDatabaseConfig({ [RUNTIME_KEY]: value }).connectionString,
      value,
    );
  }
});

test('readers reject missing database paths and credentials', () => {
  const invalid = [
    'postgres://host/db',
    'postgres://user@host/db',
    'postgres://:pass@host/db',
    'postgres://user:@host/db',
    'postgres://user:pass@host',
    'postgres://user:pass@host/',
    'postgres://user:pass@host?sslmode=disable',
    'postgres://user:pass@host?sslmode=disable#fragment',
  ];

  for (const value of invalid) {
    assert.throws(
      () => readMigrationDatabaseConfig({ [MIGRATION_KEY]: value }),
      assertConfigError,
      value,
    );
  }
});

test('readers reject malformed escaping, controls, fragments, and surrounding whitespace', () => {
  const invalid = [
    'postgres://user:pa%ZZss@host/db',
    'postgres://user:pa%ss@host/db',
    'postgres://user:pass@host/db%',
    'postgres://user:pass@host/db?sslmode=require&x=%G1',
    'postgres://user:pa%C3%28ss@host/db',
    'postgres://user:pa\nss@host/db',
    'postgres://user:pass@host/db\u0000',
    'postgres://user:pass@host/db\t',
    'postgres://user:pass@host/db\u007f',
    'postgres://user:pass@host/db#fragment',
    'postgres://user:pass@host/db#',
    ` ${RUNTIME_URL}`,
    `${RUNTIME_URL} `,
    `${RUNTIME_URL}\n`,
  ];

  for (const value of invalid) {
    assert.throws(
      () => readRuntimeDatabaseConfig({ [RUNTIME_KEY]: value }),
      assertConfigError,
    );
  }
});

test('readers accept Docker URLs with encoded credentials and preserve unknown query parameters', () => {
  const values = [RUNTIME_URL, MIGRATION_URL];

  for (const value of values) {
    const config = readRuntimeDatabaseConfig({ [RUNTIME_KEY]: value });
    assert.equal(config.connectionString, value);
    assert.ok(config.connectionString.includes('sslmode=disable'));
    assert.ok(config.connectionString.includes('%40'));
  }

  assert.ok(RUNTIME_URL.includes('application_name=sessionport-api'));
  assert.ok(MIGRATION_URL.includes('unknown_parameter=preserved'));
  assert.ok(MIGRATION_URL.includes('%3A'));
  assert.ok(MIGRATION_URL.includes('%40'));
});

test('fixed errors never echo URLs, credentials, environment values, or raw parser errors', () => {
  const secret = 'synthetic-super-secret-password';
  const values = [
    `postgres://user:${secret}@host/db#fragment`,
    `postgres://user:${secret}@host:0/db`,
    `postgres://user:${secret}%ZZ@host/db`,
    ` postgres://user:${secret}@host/db`,
  ];

  for (const value of values) {
    assert.throws(
      () => readRuntimeDatabaseConfig({ [RUNTIME_KEY]: value }),
      (error: unknown) => {
        assertConfigError(error);
        const rendered = String(error);
        assert.ok(!rendered.includes(value));
        assert.ok(!rendered.includes(secret));
        assert.ok(!rendered.includes('postgres://'));
        assert.ok(!rendered.includes(RUNTIME_KEY));
        return true;
      },
    );
  }
});
