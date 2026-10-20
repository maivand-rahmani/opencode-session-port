import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInMemoryRateLimiter,
  readNativeRateLimiter,
  type NativeRateLimiter,
} from '../../src/native-auth/rate-limit.js';

const POLICY = { windowSeconds: 10, maxRequests: 2 } as const;

function clock(start = '2026-10-20T12:00:00.000Z') {
  let current = new Date(start);
  return {
    now: () => current,
    advance(seconds: number) {
      current = new Date(current.getTime() + seconds * 1_000);
    },
  };
}

test('fixed window allows the configured maximum and denies with Retry-After', async () => {
  const time = clock();
  const limiter = createInMemoryRateLimiter({
    maxEntries: 10,
    now: time.now,
  });

  assert.deepEqual(
    await limiter.consume('createAuthorization', 'ip:one', POLICY),
    { allowed: true, retryAfterSeconds: 0 },
  );
  assert.deepEqual(
    await limiter.consume('createAuthorization', 'ip:one', POLICY),
    { allowed: true, retryAfterSeconds: 0 },
  );
  const denied = await limiter.consume(
    'createAuthorization',
    'ip:one',
    POLICY,
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 10);

  time.advance(10);
  assert.equal(
    (await limiter.consume('createAuthorization', 'ip:one', POLICY)).allowed,
    true,
  );
});

test('operations and keys are independent', async () => {
  const time = clock();
  const limiter = createInMemoryRateLimiter({
    maxEntries: 10,
    now: time.now,
  });

  await limiter.consume('createAuthorization', 'ip:one', POLICY);
  await limiter.consume('createAuthorization', 'ip:one', POLICY);
  assert.equal(
    (await limiter.consume('createAuthorization', 'ip:one', POLICY)).allowed,
    false,
  );
  assert.equal(
    (await limiter.consume('refreshToken', 'ip:one', POLICY)).allowed,
    true,
  );
  assert.equal(
    (await limiter.consume('createAuthorization', 'ip:two', POLICY)).allowed,
    true,
  );
});

test('at maxEntries new keys are rejected instead of evicting live entries', async () => {
  const time = clock();
  const limiter = createInMemoryRateLimiter({
    maxEntries: 2,
    now: time.now,
  });

  assert.equal(
    (await limiter.consume('createAuthorization', 'ip:one', POLICY)).allowed,
    true,
  );
  assert.equal(
    (await limiter.consume('createAuthorization', 'ip:two', POLICY)).allowed,
    true,
  );
  const rejected = await limiter.consume(
    'createAuthorization',
    'ip:three',
    POLICY,
  );
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterSeconds, 10);

  // The existing live keys remain usable; no eviction occurred.
  assert.equal(
    (await limiter.consume('createAuthorization', 'ip:one', POLICY)).allowed,
    true,
  );
});

test('expired entries may be pruned at capacity without granting an unexpired bypass', async () => {
  const time = clock();
  const limiter = createInMemoryRateLimiter({
    maxEntries: 2,
    now: time.now,
  });

  await limiter.consume('createAuthorization', 'ip:one', POLICY);
  await limiter.consume('createAuthorization', 'ip:two', POLICY);
  time.advance(11);

  assert.equal(
    (await limiter.consume('createAuthorization', 'ip:three', POLICY)).allowed,
    true,
  );
});

test('deadline and clock failures deny fail-closed', async () => {
  const time = clock();
  const limiter = createInMemoryRateLimiter({
    maxEntries: 5,
    now: time.now,
  });

  const deadline = await limiter.consume(
    'createAuthorization',
    'ip:one',
    POLICY,
    { deadline: time.now().getTime() - 1 },
  );
  assert.equal(deadline.allowed, false);

  const broken = createInMemoryRateLimiter({
    maxEntries: 5,
    now: () => {
      throw new Error('clock detail');
    },
  });
  const unavailable = await broken.consume(
    'createAuthorization',
    'ip:one',
    POLICY,
  );
  assert.equal(unavailable.allowed, false);
  assert.equal(JSON.stringify(unavailable).includes('clock detail'), false);
});

test('invalid policy, key, operation, options, or dependency deny instead of allowing', async () => {
  const limiter = createInMemoryRateLimiter({
    maxEntries: 5,
    now: () => new Date('2026-10-20T12:00:00.000Z'),
  });

  assert.equal(
    (await limiter.consume('createAuthorization', '', POLICY)).allowed,
    false,
  );
  assert.equal(
    (await limiter.consume(
      'createAuthorization',
      'ip:one',
      { windowSeconds: 0, maxRequests: 1 } as never,
    )).allowed,
    false,
  );
  assert.equal(
    (await limiter.consume('unknown' as never, 'ip:one', POLICY)).allowed,
    false,
  );
  assert.equal(
    (await limiter.consume('createAuthorization', 'ip:one', POLICY, {
      deadline: 'soon',
    } as never)).allowed,
    false,
  );

  assert.throws(
    () => createInMemoryRateLimiter({ maxEntries: 0 }),
    /Invalid in-memory rate limiter options/,
  );
  assert.throws(
    () => readNativeRateLimiter(null),
    /Invalid native-auth rate limiter/,
  );
  assert.throws(
    () => readNativeRateLimiter({ consume: 'nope' }),
    /Invalid native-auth rate limiter/,
  );

  const valid: NativeRateLimiter = limiter;
  assert.equal(typeof valid.consume, 'function');
});
