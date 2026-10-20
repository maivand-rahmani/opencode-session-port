import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CopyObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3Config } from '../../src/storage/config.js';
import {
  S3StorageError,
  createS3Storage,
  type CreateDownloadUrlInput,
  type CreateUploadPolicyInput,
  type S3StorageErrorCode,
} from '../../src/storage/s3.js';

const CHECKSUM_SHA256 = Buffer.alloc(32, 0x2a).toString('base64');
const INVALID_31_BYTE_CHECKSUM = Buffer.alloc(31, 0x2a).toString('base64');

const KEY = 'staging/5d4e/lease-1';
const DESTINATION_KEY = 'final/5d4e/1';

const MESSAGES: Record<S3StorageErrorCode, string> = {
  'invalid-input': 'S3 request input is invalid.',
  'unsupported-integrity':
    'S3 object integrity metadata is unavailable or invalid.',
  'precondition-failed': 'S3 object precondition failed.',
  'not-found': 'S3 object was not found.',
  unavailable: 'S3 operation failed.',
};

function makeConfig(overrides: Partial<S3Config> = {}): S3Config {
  return Object.freeze({
    endpoint: 'https://s3.ru1.storage.beget.cloud',
    region: 'ru1',
    bucket: 'sessionport-test-bucket',
    accessKeyId: 'AKIASYNTHETICFIXTURE0001',
    secretAccessKey: 'synthetic-fixture-secret',
    forcePathStyle: true,
    ...overrides,
  });
}

function fakeClient(handler: (command: unknown) => Promise<unknown>): {
  client: S3Client;
  commands: unknown[];
} {
  const commands: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      commands.push(command);
      return handler(command);
    },
  } as unknown as S3Client;

  return { client, commands };
}

async function expectStorageError(
  promise: Promise<unknown>,
  code: S3StorageErrorCode,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof S3StorageError);
    assert.equal(error.name, 'S3StorageError');
    assert.equal(error.code, code);
    assert.equal(error.message, MESSAGES[code]);
    assert.equal(error.cause, undefined);
    return true;
  });
}

function basePolicyInput(): CreateUploadPolicyInput {
  return {
    key: KEY,
    sizeBytes: 1_048_576,
    checksumSha256: CHECKSUM_SHA256,
    expiresInSeconds: 900,
  };
}

test('generates a POST policy with exact key, size, checksum, and explicit TTL', async () => {
  const storage = createS3Storage(makeConfig());
  const before = Date.now();
  const policy = await storage.createUploadPolicy(basePolicyInput());
  const after = Date.now();

  assert.equal(typeof policy.url, 'string');
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.fields));

  const { url, fields } = policy;
  assert.equal(fields.key, KEY);
  assert.equal(fields.bucket, 'sessionport-test-bucket');
  assert.equal(fields['x-amz-checksum-algorithm'], 'SHA256');
  assert.equal(fields['x-amz-checksum-sha256'], CHECKSUM_SHA256);
  assert.equal(typeof fields.Policy, 'string');
  assert.equal(typeof fields['X-Amz-Signature'], 'string');

  const decoded = Buffer.from(fields.Policy, 'base64').toString('utf8');
  const payload = JSON.parse(decoded) as {
    expiration: string;
    conditions: unknown[];
  };

  assert.match(payload.expiration, /Z$/);
  const expirationMs = Date.parse(payload.expiration);
  assert.ok(Number.isFinite(expirationMs));
  assert.ok(expirationMs >= before + 900_000 - 2_000);
  assert.ok(expirationMs <= after + 900_000 + 2_000);

  const serializedConditions = payload.conditions.map((condition) =>
    JSON.stringify(condition),
  );
  for (const expected of [
    ['eq', '$key', KEY],
    ['content-length-range', 1_048_576, 1_048_576],
    ['eq', '$x-amz-checksum-algorithm', 'SHA256'],
    ['eq', '$x-amz-checksum-sha256', CHECKSUM_SHA256],
  ]) {
    assert.ok(
      serializedConditions.includes(JSON.stringify(expected)),
      'missing exact POST condition',
    );
  }

  for (const condition of payload.conditions) {
    if (Array.isArray(condition)) {
      assert.ok(
        condition[0] === 'eq' || condition[0] === 'content-length-range',
        'policy must not contain a wildcard or starts-with condition',
      );
      if (condition[0] === 'eq') {
        assert.ok(
          ['$key', '$x-amz-checksum-algorithm', '$x-amz-checksum-sha256'].includes(
            String(condition[1]),
          ),
        );
      }
    }
  }
  assert.ok(
    !serializedConditions.some((condition) =>
      condition.includes('starts-with'),
    ),
  );
  assert.ok(!decoded.includes('${filename}'));

  const parsedUrl = new URL(url);
  assert.equal(parsedUrl.protocol, 'https:');
  assert.equal(parsedUrl.pathname, '/sessionport-test-bucket');
});

test('honours the explicit forcePathStyle address style without provider claims', async () => {
  const pathStyle = await createS3Storage(
    makeConfig({ forcePathStyle: true }),
  ).createUploadPolicy(basePolicyInput());
  const virtualStyle = await createS3Storage(
    makeConfig({ forcePathStyle: false }),
  ).createUploadPolicy(basePolicyInput());

  const pathUrl = new URL(pathStyle.url);
  assert.equal(pathUrl.hostname, 's3.ru1.storage.beget.cloud');
  assert.equal(pathUrl.pathname, '/sessionport-test-bucket');

  const virtualUrl = new URL(virtualStyle.url);
  assert.equal(
    virtualUrl.hostname,
    'sessionport-test-bucket.s3.ru1.storage.beget.cloud',
  );
});

test('accepts the maximum explicit POST TTL and rejects non-explicit or out-of-range TTLs', async () => {
  const storage = createS3Storage(makeConfig());
  await assert.doesNotReject(
    storage.createUploadPolicy({
      ...basePolicyInput(),
      expiresInSeconds: 604_800,
    }),
  );

  for (const expiresInSeconds of [
    0,
    -1,
    1.5,
    604_801,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '900',
  ]) {
    await expectStorageError(
      storage.createUploadPolicy({
        ...basePolicyInput(),
        expiresInSeconds,
      } as unknown as CreateUploadPolicyInput),
      'invalid-input',
    );
  }

  await expectStorageError(
    storage.createUploadPolicy({
      key: KEY,
      sizeBytes: 1,
      checksumSha256: CHECKSUM_SHA256,
    } as unknown as CreateUploadPolicyInput),
    'invalid-input',
  );
});

test('rejects non-exact byte sizes and invalid base64 SHA-256 values', async () => {
  const storage = createS3Storage(makeConfig());

  for (const sizeBytes of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '1048576',
  ]) {
    await expectStorageError(
      storage.createUploadPolicy({
        ...basePolicyInput(),
        sizeBytes,
      } as unknown as CreateUploadPolicyInput),
      'invalid-input',
    );
  }

  const invalidChecksums = [
    '',
    CHECKSUM_SHA256.replace(/=$/, ''),
    `${CHECKSUM_SHA256.slice(0, 10)}-${CHECKSUM_SHA256.slice(11)}`,
    `${CHECKSUM_SHA256.slice(0, 10)}_${CHECKSUM_SHA256.slice(11)}`,
    INVALID_31_BYTE_CHECKSUM,
    `${CHECKSUM_SHA256}\n`,
    'not-base64',
  ];
  for (const checksumSha256 of invalidChecksums) {
    await expectStorageError(
      storage.createUploadPolicy({
        ...basePolicyInput(),
        checksumSha256,
      }),
      'invalid-input',
    );
  }
});

test('bounds object keys to 1024 UTF-8 bytes and rejects controls and policy placeholders', async () => {
  const storage = createS3Storage(makeConfig());

  await assert.doesNotReject(
    storage.createUploadPolicy({
      ...basePolicyInput(),
      key: 'a'.repeat(1024),
    }),
  );
  await assert.doesNotReject(
    storage.createUploadPolicy({
      ...basePolicyInput(),
      key: 'é'.repeat(512),
    }),
  );

  for (const key of [
    '',
    '   ',
    'a'.repeat(1025),
    'é'.repeat(513),
    'staging/\nkey',
    'staging/\u0000key',
    'staging/\u007fkey',
    'staging/\u2028key',
    'staging/${filename}',
  ]) {
    await expectStorageError(
      storage.createUploadPolicy({ ...basePolicyInput(), key }),
      'invalid-input',
    );
  }
});

test('HEAD requires enabled checksums, nonnegative integer length, and opaque ETag', async () => {
  const { client, commands } = fakeClient(async () => ({
    ContentLength: 1_048_576,
    ChecksumSHA256: CHECKSUM_SHA256,
    ETag: '"etag-1"',
    Metadata: { ignored: 'not part of the returned metadata' },
  }));
  const storage = createS3Storage(makeConfig(), client);

  const metadata = await storage.headObject({ key: KEY });
  assert.deepEqual(metadata, {
    key: KEY,
    sizeBytes: 1_048_576,
    checksumSha256: CHECKSUM_SHA256,
    etag: '"etag-1"',
  });
  assert.ok(Object.isFrozen(metadata));
  assert.deepEqual(Object.keys(metadata), [
    'key',
    'sizeBytes',
    'checksumSha256',
    'etag',
  ]);

  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof HeadObjectCommand);
  assert.deepEqual(commands[0].input, {
    Bucket: 'sessionport-test-bucket',
    Key: KEY,
    ChecksumMode: 'ENABLED',
  });
});

test('HEAD fails closed when the checksum is missing or malformed without ETag fallback', async () => {
  for (const response of [
    {
      ContentLength: 10,
      ETag: '"etag-1"',
      Metadata: { 'x-amz-checksum-sha256': CHECKSUM_SHA256 },
    },
    { ContentLength: 10, ETag: '"etag-1"' },
    {
      ContentLength: 10,
      ETag: '"etag-1"',
      ChecksumSHA256: INVALID_31_BYTE_CHECKSUM,
    },
    {
      ContentLength: 10,
      ETag: '"etag-1"',
      ChecksumSHA256: CHECKSUM_SHA256.replace(/=$/, ''),
    },
  ]) {
    const { client } = fakeClient(async () => response);
    const storage = createS3Storage(makeConfig(), client);
    await expectStorageError(
      storage.headObject({ key: KEY }),
      'unsupported-integrity',
    );
  }
});

test('HEAD rejects malformed length or ETag responses as unavailable', async () => {
  for (const response of [
    { ChecksumSHA256: CHECKSUM_SHA256, ETag: '"etag-1"' },
    { ContentLength: -1, ChecksumSHA256: CHECKSUM_SHA256, ETag: '"etag-1"' },
    { ContentLength: 1.5, ChecksumSHA256: CHECKSUM_SHA256, ETag: '"etag-1"' },
    { ContentLength: '10', ChecksumSHA256: CHECKSUM_SHA256, ETag: '"etag-1"' },
    { ContentLength: 10, ChecksumSHA256: CHECKSUM_SHA256 },
    { ContentLength: 10, ChecksumSHA256: CHECKSUM_SHA256, ETag: '' },
    { ContentLength: 10, ChecksumSHA256: CHECKSUM_SHA256, ETag: ' etag ' },
  ]) {
    const { client } = fakeClient(async () => response);
    const storage = createS3Storage(makeConfig(), client);
    await expectStorageError(storage.headObject({ key: KEY }), 'unavailable');
  }
});

test('COPY uses a conditioned same-bucket copy with URL-encoded source segments and SHA256', async () => {
  const { client, commands } = fakeClient(async () => ({}));
  const storage = createS3Storage(makeConfig(), client);
  const sourceKey = "staging/a b+c/é'(!)*.txt";

  await storage.copyObject({
    sourceKey,
    destinationKey: DESTINATION_KEY,
    sourceETag: '"etag-source"',
  });

  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof CopyObjectCommand);
  const input = commands[0].input;
  assert.equal(input.Bucket, 'sessionport-test-bucket');
  assert.equal(input.Key, DESTINATION_KEY);
  assert.equal(
    input.CopySource,
    '/sessionport-test-bucket/staging/a%20b%2Bc/%C3%A9%27%28%21%29%2A.txt',
  );
  assert.equal(input.CopySourceIfMatch, '"etag-source"');
  assert.equal(input.ChecksumAlgorithm, 'SHA256');
});

test('COPY rejects equal keys and missing ETags before sending a command', async () => {
  const { client, commands } = fakeClient(async () => ({}));
  const storage = createS3Storage(makeConfig(), client);

  await expectStorageError(
    storage.copyObject({
      sourceKey: KEY,
      destinationKey: KEY,
      sourceETag: '"etag"',
    }),
    'invalid-input',
  );
  for (const sourceETag of ['', '   ', 'etag\n', undefined]) {
    await expectStorageError(
      storage.copyObject({
        sourceKey: KEY,
        destinationKey: DESTINATION_KEY,
        sourceETag,
      } as unknown as {
        sourceKey: string;
        destinationKey: string;
        sourceETag: string;
      }),
      'invalid-input',
    );
  }

  assert.equal(commands.length, 0);
});

test('maps service failures to fixed codes without leaking raw SDK errors', async () => {
  const secret = 'synthetic-raw-secret';
  const rawMessage = `https://s3.example.test/${KEY}?X-Amz-Signature=${secret}`;

  const cases: Array<[unknown, S3StorageErrorCode]> = [
    [{ $metadata: { httpStatusCode: 412 }, name: 'PreconditionFailed' }, 'precondition-failed'],
    [{ $metadata: { httpStatusCode: 404 }, name: 'NotFound' }, 'not-found'],
    [{ $metadata: { httpStatusCode: 500 }, name: 'InternalError' }, 'unavailable'],
    [new Error(rawMessage), 'unavailable'],
    ['raw non-error rejection', 'unavailable'],
  ];

  for (const [thrown, code] of cases) {
    const { client } = fakeClient(async () => {
      throw thrown;
    });
    const storage = createS3Storage(makeConfig(), client);

    await assert.rejects(
      storage.headObject({ key: KEY }),
      (error: unknown) => {
        assert.ok(error instanceof S3StorageError);
        assert.equal(error.code, code);
        assert.equal(error.message, MESSAGES[code]);
        assert.equal(error.cause, undefined);
        const rendered = String(error);
        assert.ok(!rendered.includes(secret));
        assert.ok(!rendered.includes(KEY));
        assert.ok(!rendered.includes('s3.example.test'));
        return true;
      },
    );
  }
});

test('COPY maps HTTP 412 to a fixed precondition error', async () => {
  const { client } = fakeClient(async () => {
    throw { $metadata: { httpStatusCode: 412 }, name: 'PreconditionFailed' };
  });
  const storage = createS3Storage(makeConfig(), client);

  await expectStorageError(
    storage.copyObject({
      sourceKey: KEY,
      destinationKey: DESTINATION_KEY,
      sourceETag: '"etag-source"',
    }),
    'precondition-failed',
  );
});

test('signs GET downloads locally with an explicit TTL and does not log', async () => {
  const storage = createS3Storage(makeConfig());
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  let logCalls = 0;

  console.log = (() => {
    logCalls += 1;
  }) as typeof console.log;
  console.warn = (() => {
    logCalls += 1;
  }) as typeof console.warn;
  console.error = (() => {
    logCalls += 1;
  }) as typeof console.error;

  try {
    const url = await storage.createDownloadUrl({
      key: DESTINATION_KEY,
      expiresInSeconds: 300,
    });

    assert.equal(typeof url, 'string');
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.searchParams.get('X-Amz-Expires'), '300');
    assert.ok((parsed.searchParams.get('X-Amz-Signature') ?? '').length > 0);
    assert.ok((parsed.searchParams.get('X-Amz-Credential') ?? '').length > 0);
    assert.equal(parsed.pathname, `/sessionport-test-bucket/${DESTINATION_KEY}`);
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  assert.equal(logCalls, 0);
});

test('download signing rejects missing, fractional, or excessive TTLs and invalid keys', async () => {
  const storage = createS3Storage(makeConfig());

  for (const expiresInSeconds of [
    0,
    -1,
    1.5,
    604_801,
    Number.NaN,
    '300',
  ]) {
    await expectStorageError(
      storage.createDownloadUrl({
        key: DESTINATION_KEY,
        expiresInSeconds,
      } as unknown as CreateDownloadUrlInput),
      'invalid-input',
    );
  }

  await expectStorageError(
    storage.createDownloadUrl({
      key: DESTINATION_KEY,
    } as unknown as CreateDownloadUrlInput),
    'invalid-input',
  );
  await expectStorageError(
    storage.createDownloadUrl({
      key: 'final/\nkey',
      expiresInSeconds: 300,
    }),
    'invalid-input',
  );
});

test('rejects non-object method inputs without leaking TypeError details', async () => {
  const storage = createS3Storage(makeConfig());
  const methods = [
    storage.createUploadPolicy,
    storage.headObject,
    storage.copyObject,
    storage.createDownloadUrl,
  ] as Array<(input: unknown) => Promise<unknown>>;

  for (const method of methods) {
    for (const input of [undefined, null, [], 'input', 42]) {
      await expectStorageError(method(input), 'invalid-input');
    }
  }
});
