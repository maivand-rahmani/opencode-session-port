import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDisabledUploadService,
  UploadServiceUnavailableError,
} from '../../src/uploads/service.js';

/*
 * The disabled service is a fail-closed boundary for M4. These tests prove it
 * takes no dependencies, reads no environment switch, and rejects before any
 * repository, database, or S3 call is possible. They do not test uploads.
 */

function assertUnavailable(error: unknown): boolean {
  assert.ok(error instanceof UploadServiceUnavailableError);
  assert.equal(error.name, 'UploadServiceUnavailableError');
  assert.equal(error.code, 'upload-service-unavailable');
  assert.equal(error.statusCode, 503);
  assert.equal(error.retryable, true);
  assert.equal(error.message, 'The upload service is unavailable.');
  assert.equal(error.cause, undefined);
  return true;
}

test('disabled factory accepts no dependencies and exposes only reserve/complete', () => {
  assert.equal(createDisabledUploadService.length, 0);
  const service = createDisabledUploadService();
  assert.deepEqual(Object.keys(service).sort(), ['complete', 'reserve']);
  assert.equal(typeof service.reserve, 'function');
  assert.equal(typeof service.complete, 'function');
  assert.equal(Object.isFrozen(service), true);
  assert.equal('repository' in service, false);
  assert.equal('client' in service, false);
  assert.equal('storage' in service, false);
});

test('both operations reject 503 upload-service-unavailable before any input inspection', async () => {
  const service = createDisabledUploadService();

  for (const input of [
    undefined,
    null,
    {},
    { userID: 'forged', uploadID: 'forged' },
    { enable: true, provider: 's3', repository: {} },
  ]) {
    await assert.rejects(
      service.reserve(input),
      (error: unknown) => assertUnavailable(error),
    );
    await assert.rejects(
      service.complete(input),
      (error: unknown) => assertUnavailable(error),
    );
  }
});

test('no environment switch or extra argument enables the disabled service', async () => {
  const keys = [
    'SESSIONPORT_UPLOADS_ENABLED',
    'SESSIONPORT_UPLOAD_PROVIDER',
    'UPLOADS_ENABLED',
  ];
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
    process.env[key] = 'true';
  }

  try {
    const factory = createDisabledUploadService as unknown as (
      ...args: unknown[]
    ) => ReturnType<typeof createDisabledUploadService>;
    const service = factory(
      { repository: {}, s3: {}, provider: true },
      true,
    );
    assert.equal(Object.keys(service).sort().join(','), 'complete,reserve');
    await assert.rejects(
      service.reserve({ enable: true }),
      (error: unknown) => assertUnavailable(error),
    );
    await assert.rejects(
      service.complete({ enable: true }),
      (error: unknown) => assertUnavailable(error),
    );
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
