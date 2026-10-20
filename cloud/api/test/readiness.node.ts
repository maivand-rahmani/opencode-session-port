import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  evaluateReadiness,
  type ReadinessChecks,
} from '../src/readiness.js';

function healthyChecks(
  overrides: Partial<ReadinessChecks> = {},
): ReadinessChecks {
  return {
    database: async () => true,
    migrations: async () => true,
    storage: async () => true,
    ...overrides,
  };
}

test('is not ready when checks are omitted', async () => {
  assert.equal(await evaluateReadiness(undefined, 25), false);
});

test('is not ready when any check is missing or malformed', async () => {
  let invoked = false;
  const partial = {
    database: async () => {
      invoked = true;
      return true;
    },
  } as unknown as ReadinessChecks;

  assert.equal(await evaluateReadiness(partial, 25), false);
  assert.equal(invoked, false);
});

test('is ready only when all three checks return true', async () => {
  assert.equal(await evaluateReadiness(healthyChecks(), 250), true);

  const truthyButNotTrue = {
    database: async () => 1,
    migrations: async () => true,
    storage: async () => true,
  } as unknown as ReadinessChecks;
  assert.equal(await evaluateReadiness(truthyButNotTrue, 250), false);
});

test('is not ready when a check returns false or throws', async () => {
  assert.equal(
    await evaluateReadiness(
      healthyChecks({ storage: async () => false }),
      250,
    ),
    false,
  );

  assert.equal(
    await evaluateReadiness(
      healthyChecks({
        database: async () => {
          throw new Error('synthetic database failure');
        },
      }),
      250,
    ),
    false,
  );

  assert.equal(
    await evaluateReadiness(
      healthyChecks({
        migrations: () => {
          throw new Error('synthetic synchronous failure');
        },
      }),
      250,
    ),
    false,
  );
});

test('passes one shared signal and aborts it in finally', async () => {
  const signals: AbortSignal[] = [];
  const checks: ReadinessChecks = {
    database: async (signal) => {
      signals.push(signal);
      return true;
    },
    migrations: async (signal) => {
      signals.push(signal);
      return true;
    },
    storage: async (signal) => {
      signals.push(signal);
      return true;
    },
  };

  assert.equal(await evaluateReadiness(checks, 250), true);
  assert.equal(signals.length, 3);
  assert.equal(new Set(signals).size, 1);
  assert.ok(signals.every((signal) => signal.aborted));
});

test('bounds a non-cooperative check and aborts its signal', async () => {
  let signal: AbortSignal | undefined;
  const checks = healthyChecks({
    database: (received) => {
      signal = received;
      return new Promise<boolean>(() => {});
    },
  });

  const started = Date.now();
  const result = await evaluateReadiness(checks, 40);
  const elapsed = Date.now() - started;

  assert.equal(result, false);
  assert.ok(elapsed >= 25, `returned after ${elapsed}ms`);
  assert.ok(elapsed < 1000, `returned after ${elapsed}ms`);
  assert.equal(signal?.aborted, true);
});

test('observes a late rejection after the overall timeout', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    const checks = healthyChecks({
      database: () => new Promise<boolean>(() => {}),
      migrations: async () => {
        await delay(70);
        throw new Error('late synthetic rejection');
      },
    });

    assert.equal(await evaluateReadiness(checks, 20), false);
    await delay(120);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
