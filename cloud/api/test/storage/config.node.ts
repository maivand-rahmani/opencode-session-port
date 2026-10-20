import assert from 'node:assert/strict';
import test from 'node:test';
import { S3ConfigError, readS3Config } from '../../src/storage/config.js';

const ENDPOINT_ENV = 'SESSIONPORT_S3_ENDPOINT';
const REGION_ENV = 'SESSIONPORT_S3_REGION';
const BUCKET_ENV = 'SESSIONPORT_S3_BUCKET';
const ACCESS_KEY_ID_ENV = 'SESSIONPORT_S3_ACCESS_KEY_ID';
const SECRET_ACCESS_KEY_ENV = 'SESSIONPORT_S3_SECRET_ACCESS_KEY';
const FORCE_PATH_STYLE_ENV = 'SESSIONPORT_S3_FORCE_PATH_STYLE';

const ALL_KEYS = [
  ENDPOINT_ENV,
  REGION_ENV,
  BUCKET_ENV,
  ACCESS_KEY_ID_ENV,
  SECRET_ACCESS_KEY_ENV,
  FORCE_PATH_STYLE_ENV,
] as const;

const VALID_ENV: Record<(typeof ALL_KEYS)[number], string> = {
  [ENDPOINT_ENV]: 'https://s3.ru1.storage.beget.cloud',
  [REGION_ENV]: 'ru1',
  [BUCKET_ENV]: 'sessionport-test-bucket',
  [ACCESS_KEY_ID_ENV]: 'AKIASYNTHETICFIXTURE0001',
  [SECRET_ACCESS_KEY_ENV]: 'synthetic-fixture-secret',
  [FORCE_PATH_STYLE_ENV]: 'true',
};

const FIXED_MESSAGE = 'S3 storage configuration is invalid.';

function validEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return { ...VALID_ENV, ...overrides };
}

function assertConfigError(error: unknown): boolean {
  assert.ok(error instanceof S3ConfigError);
  assert.equal(error.name, 'S3ConfigError');
  assert.equal(error.code, 'invalid-s3-config');
  assert.equal(error.message, FIXED_MESSAGE);
  assert.equal(error.cause, undefined);
  return true;
}

function assertInvalidEnv(overrides: Record<string, string | undefined>): void {
  assert.throws(() => readS3Config(validEnv(overrides)), assertConfigError);
}

test('returns exactly the six configured values and freezes the result', () => {
  const config = readS3Config(validEnv());

  assert.deepEqual(config, {
    endpoint: 'https://s3.ru1.storage.beget.cloud',
    region: 'ru1',
    bucket: 'sessionport-test-bucket',
    accessKeyId: 'AKIASYNTHETICFIXTURE0001',
    secretAccessKey: 'synthetic-fixture-secret',
    forcePathStyle: true,
  });
  assert.ok(Object.isFrozen(config));
});

test('canonicalises only the accepted endpoint origin', () => {
  assert.equal(
    readS3Config(validEnv({ [ENDPOINT_ENV]: 'https://s3.example.test/' })).endpoint,
    'https://s3.example.test',
  );
  assert.equal(
    readS3Config(
      validEnv({ [ENDPOINT_ENV]: 'https://s3.example.test:8443/' }),
    ).endpoint,
    'https://s3.example.test:8443',
  );
  assert.equal(
    readS3Config(validEnv({ [FORCE_PATH_STYLE_ENV]: 'false' })).forcePathStyle,
    false,
  );
});

test('requires every key with no defaults, aliases, or partial configs', () => {
  for (const key of ALL_KEYS) {
    const env = validEnv();
    delete env[key];
    assert.throws(() => readS3Config(env), assertConfigError, key);
  }

  assert.throws(() => readS3Config({}), assertConfigError);
  assert.throws(
    () =>
      readS3Config({
        AWS_ACCESS_KEY_ID: VALID_ENV[ACCESS_KEY_ID_ENV],
        AWS_SECRET_ACCESS_KEY: VALID_ENV[SECRET_ACCESS_KEY_ENV],
        S3_ENDPOINT: VALID_ENV[ENDPOINT_ENV],
        S3_REGION: VALID_ENV[REGION_ENV],
        S3_BUCKET: VALID_ENV[BUCKET_ENV],
        S3_FORCE_PATH_STYLE: VALID_ENV[FORCE_PATH_STYLE_ENV],
      }),
    assertConfigError,
  );

  assert.throws(
    () =>
      readS3Config({
        ...VALID_ENV,
        [ENDPOINT_ENV]: '',
      }),
    assertConfigError,
  );
  assert.throws(
    () =>
      readS3Config({
        ...VALID_ENV,
        [REGION_ENV]: undefined,
      }),
    assertConfigError,
  );
});

test('reads only the six explicit S3 keys', () => {
  const allowed = new Set<string>(ALL_KEYS);
  const guarded = new Proxy(validEnv(), {
    get(target, property, receiver) {
      if (typeof property === 'string' && !allowed.has(property)) {
        throw new Error('unexpected environment access');
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const config = readS3Config(guarded);
  assert.equal(config.region, 'ru1');
  assert.equal(config.bucket, 'sessionport-test-bucket');
});

test('requires a credential-free HTTPS endpoint origin', () => {
  const invalid = [
    'http://s3.example.test',
    'ftp://s3.example.test',
    's3.example.test',
    'HTTPS://s3.example.test',
    'https://',
    'https://user@s3.example.test',
    'https://user:pass@s3.example.test',
    'https://s3.example.test/bucket',
    'https://s3.example.test//',
    'https://s3.example.test?query=1',
    'https://s3.example.test#fragment',
    'https://s3.example.test:0',
    'https://s3.example.test:65536',
    ' https://s3.example.test',
    'https://s3.example.test ',
    'https://s3.example.test\n',
    'https://s3.example.test\u0000',
  ];

  for (const endpoint of invalid) {
    assertInvalidEnv({ [ENDPOINT_ENV]: endpoint });
  }

  for (const endpoint of [
    'https://s3.ru1.storage.beget.cloud',
    'https://s3.ru1.storage.beget.cloud/',
    'https://s3.example.test:443',
    'https://s3.example.test:8443',
  ]) {
    assert.doesNotThrow(() =>
      readS3Config(validEnv({ [ENDPOINT_ENV]: endpoint })),
    );
  }
});

test('accepts only a bounded, sane region string', () => {
  const invalid = [
    '',
    'RU1',
    'ru 1',
    'ru_1',
    '-ru1',
    'ru1-',
    'ru1\n',
    'ru1\u0000',
    'a'.repeat(64),
  ];

  for (const region of invalid) {
    assertInvalidEnv({ [REGION_ENV]: region });
  }

  for (const region of ['ru1', 'us-east-1', 'eu-central-1', 'a', 'a-b']) {
    assert.equal(
      readS3Config(validEnv({ [REGION_ENV]: region })).region,
      region,
    );
  }
});

test('requires an AWS-compatible DNS bucket name that is not IPv4-shaped', () => {
  const invalid = [
    '',
    'ab',
    'Abc',
    'abc_def',
    '-abc',
    'abc-',
    '.abc',
    'abc.',
    'a..b',
    '192.168.1.1',
    'a'.repeat(64),
    'abc def',
    'abc\n',
  ];

  for (const bucket of invalid) {
    assertInvalidEnv({ [BUCKET_ENV]: bucket });
  }

  for (const bucket of [
    'abc',
    'sessionport-test-bucket',
    'a.b-c',
    'a-b.c',
    '0abc',
  ]) {
    assert.equal(
      readS3Config(validEnv({ [BUCKET_ENV]: bucket })).bucket,
      bucket,
    );
  }
});

test('rejects empty, padded, or whitespace-containing credentials without trimming', () => {
  const invalid = [
    '',
    ' key',
    'key ',
    'key\n',
    'key\tvalue',
    'key value',
    'a'.repeat(1025),
  ];

  for (const credential of invalid) {
    assertInvalidEnv({ [ACCESS_KEY_ID_ENV]: credential });
    assertInvalidEnv({ [SECRET_ACCESS_KEY_ENV]: credential });
  }

  const accessKeyId = 'AKIA+/=SYNTHETIC';
  const secretAccessKey = 'abc+/=DEF';
  const config = readS3Config(
    validEnv({
      [ACCESS_KEY_ID_ENV]: accessKeyId,
      [SECRET_ACCESS_KEY_ENV]: secretAccessKey,
    }),
  );
  assert.equal(config.accessKeyId, accessKeyId);
  assert.equal(config.secretAccessKey, secretAccessKey);
});

test('accepts only the exact lowercase true/false address-style values', () => {
  for (const value of ['TRUE', 'True', '1', '0', 'yes', 'no', '', ' true', 'true ', 'true\n']) {
    assertInvalidEnv({ [FORCE_PATH_STYLE_ENV]: value });
  }

  assert.equal(
    readS3Config(validEnv({ [FORCE_PATH_STYLE_ENV]: 'true' })).forcePathStyle,
    true,
  );
  assert.equal(
    readS3Config(validEnv({ [FORCE_PATH_STYLE_ENV]: 'false' })).forcePathStyle,
    false,
  );
});

test('fixed errors never echo values, key names, endpoints, or credentials', () => {
  const secret = 'synthetic-do-not-echo-secret';
  const invalidEnvs: Record<string, string>[] = [
    { [ENDPOINT_ENV]: `https://user:${secret}@s3.example.test` },
    { [ENDPOINT_ENV]: `http://${secret}.example.test` },
    { [REGION_ENV]: `RU-${secret}` },
    { [BUCKET_ENV]: `Bucket_${secret}` },
    { [ACCESS_KEY_ID_ENV]: `${secret} value` },
    { [SECRET_ACCESS_KEY_ENV]: ` ${secret}` },
    { [FORCE_PATH_STYLE_ENV]: secret },
    { [ENDPOINT_ENV]: `https://s3.example.test/${secret}` },
  ];

  for (const overrides of invalidEnvs) {
    assert.throws(
      () => readS3Config(validEnv(overrides)),
      (error: unknown) => {
        assertConfigError(error);
        const rendered = String(error);
        assert.ok(!rendered.includes(secret));
        assert.ok(!rendered.includes('https://'));
        assert.ok(!rendered.includes('SESSIONPORT_S3_'));
        return true;
      },
    );
  }
});
