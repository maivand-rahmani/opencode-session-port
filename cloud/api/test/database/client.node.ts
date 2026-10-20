import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PrismaClient } from '../../prisma/generated/client/client.js';
import {
  createRuntimeDatabaseClient,
  DatabaseClientError,
} from '../../src/database/client.js';
import { DatabaseConfigError } from '../../src/database/config.js';

const RUNTIME_KEY = 'SESSIONPORT_RUNTIME_DATABASE_URL';
const MIGRATION_KEY = 'SESSIONPORT_MIGRATOR_DATABASE_URL';

// Synthetic credentials only. The nonstandard loopback port is deliberately
// not a real service; these tests construct clients but never query or connect.
const RUNTIME_URL =
  'postgresql://sessionport_runtime:synth%40tic%3Apass%2Fword@127.0.0.1:55432/session_port_test?sslmode=disable&connect_timeout=1&application_name=sessionport-api-test';

const FIXED_CONFIG_MESSAGE = 'Database connection configuration is invalid.';
const FIXED_CLIENT_MESSAGE = 'Database client initialization failed.';

function assertConfigError(error: unknown): boolean {
  assert.ok(error instanceof DatabaseConfigError);
  assert.equal(error.name, 'DatabaseConfigError');
  assert.equal(error.code, 'invalid-database-config');
  assert.equal(error.message, FIXED_CONFIG_MESSAGE);
  return true;
}

function assertSanitizedClientError(error: unknown): boolean {
  assert.ok(error instanceof DatabaseClientError);
  assert.equal(error.name, 'DatabaseClientError');
  assert.equal(error.code, 'database-client-initialization-failed');
  assert.equal(error.message, FIXED_CLIENT_MESSAGE);
  assert.equal(error.cause, undefined);
  return true;
}

function assertGeneratedPrismaClient(client: PrismaClient): void {
  // Regression note: Prisma 7.10.1 constructs the raw client and then returns
  // an extension proxy (`Ht(this)` in @prisma/client/runtime/client.mjs). That
  // proxy's `getPrototypeOf` trap is `Object.prototype`, so the conventional
  // `client instanceof PrismaClient` check is false by design. The proxy still
  // delegates to the same generated class: `constructor` resolves through the
  // raw instance, and the public methods and schema delegates are present.
  assert.equal(Object.prototype.toString.call(client), '[object PrismaClient]');
  assert.equal(client[Symbol.toStringTag], 'PrismaClient');
  assert.equal(client.constructor, PrismaClient);
  assert.equal(typeof client.$disconnect, 'function');
  assert.equal(typeof client.$transaction, 'function');
  assert.equal(typeof client.$on, 'function');
  assert.equal(typeof client.$extends, 'function');
  assert.equal(typeof client.user?.findMany, 'function');
  assert.equal(typeof client.user?.findUnique, 'function');
}

async function assertLazyPrismaClient(client: PrismaClient): Promise<void> {
  try {
    assertGeneratedPrismaClient(client);
  } finally {
    // Prisma's engine starts disconnected and `$disconnect` only stops an
    // engine that was started, so this performs no query or database I/O.
    await client.$disconnect();
  }
}

test('creates the generated Prisma client from a valid runtime URL without querying', async () => {
  const client = createRuntimeDatabaseClient({ [RUNTIME_KEY]: RUNTIME_URL });
  await assertLazyPrismaClient(client);
});

test('preserves DatabaseConfigError and its code for missing or malformed runtime configuration', () => {
  const invalidEnvs: NodeJS.ProcessEnv[] = [
    {},
    { [RUNTIME_KEY]: '' },
    { [RUNTIME_KEY]: '   ' },
    { [RUNTIME_KEY]: 'not a url' },
    { [RUNTIME_KEY]: 'postgres://sessionport_runtime:secret@127.0.0.1:55432' },
    { [RUNTIME_KEY]: 42 } as unknown as NodeJS.ProcessEnv,
    { [MIGRATION_KEY]: RUNTIME_URL },
    { DATABASE_URL: RUNTIME_URL },
  ];

  for (const env of invalidEnvs) {
    assert.throws(() => createRuntimeDatabaseClient(env), assertConfigError);
  }
});

test('reads only the runtime environment key when other keys throw on access', async () => {
  const guarded = new Proxy(
    { [RUNTIME_KEY]: RUNTIME_URL },
    {
      get(target, property, receiver) {
        if (
          property === MIGRATION_KEY ||
          property === 'DATABASE_URL' ||
          property === 'SESSIONPORT_DATABASE_URL'
        ) {
          throw new Error('cross-purpose environment access');
        }
        return Reflect.get(target, property, receiver);
      },
    },
  ) as NodeJS.ProcessEnv;

  const client = createRuntimeDatabaseClient(guarded);
  await assertLazyPrismaClient(client);
});

test('surfaced errors never echo runtime URLs, credentials, or environment keys', () => {
  const secret = 'synthetic-client-super-secret-password';
  const secretUrl = `postgresql://sessionport_runtime:${secret}@127.0.0.1:55432/session_port_test#fragment`;

  assert.throws(
    () => createRuntimeDatabaseClient({ [RUNTIME_KEY]: secretUrl }),
    (error: unknown) => {
      assertConfigError(error);
      const rendered = String(error);
      assert.ok(!rendered.includes(secretUrl));
      assert.ok(!rendered.includes(secret));
      assert.ok(!rendered.includes('postgresql://'));
      assert.ok(!rendered.includes('sessionport_runtime'));
      assert.ok(!rendered.includes('127.0.0.1'));
      assert.ok(!rendered.includes(RUNTIME_KEY));
      return true;
    },
  );

  assertSanitizedClientError(new DatabaseClientError());
});

test('module imports only runtime configuration, the adapter, and the generated client', () => {
  const source = readFileSync(
    new URL('../../src/database/client.ts', import.meta.url),
    'utf8',
  );
  const importSources = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );

  assert.deepEqual(importSources, [
    '@prisma/adapter-pg',
    '../../prisma/generated/client/client.js',
    './config.js',
  ]);
  for (const importSource of importSources) {
    assert.ok(!importSource.includes('prisma.config'));
    assert.ok(!importSource.includes('migrat'));
    assert.ok(!importSource.includes('bootstrap'));
  }

  assert.match(
    source,
    /import\s+\{\s*PrismaClient\s*\}\s+from\s+'\.\.\/\.\.\/prisma\/generated\/client\/client\.js'/,
  );
  assert.match(source, /new PrismaPg\(\{\s*connectionString\s*\}\)/);
  assert.match(source, /new PrismaClient\(\{\s*adapter\s*\}\)/);
  assert.ok(source.includes('readRuntimeDatabaseConfig'));
  assert.ok(!source.includes('readMigrationDatabaseConfig'));
  assert.ok(!source.includes('$connect'));
  assert.ok(!source.includes('$queryRaw'));
  assert.ok(!source.includes('process.env'));
  assert.ok(!/\bconsole\s*\./.test(source));
  assert.ok(!/\bset(?:Timeout|Interval|Immediate)\s*\(/.test(source));
});
