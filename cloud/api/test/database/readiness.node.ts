import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createDatabaseReadinessCheck,
  type DatabaseReadinessClient,
} from '../../src/database/readiness.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface CapturedStatement {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
}

function fakeClient() {
  const queries: Array<Deferred<unknown>> = [];
  const statements: CapturedStatement[] = [];

  const client: DatabaseReadinessClient = {
    $queryRaw<T = unknown>(
      query: TemplateStringsArray,
      ...values: readonly unknown[]
    ): PromiseLike<T> {
      statements.push({ strings: [...query], values });
      const pending = deferred<unknown>();
      queries.push(pending);
      return pending.promise as Promise<T>;
    },
  };

  return { client, queries, statements };
}

const liveSignal = (): AbortSignal => new AbortController().signal;

test('queries only when invoked and uses a read-only SELECT 1 tag', async () => {
  const { client, queries, statements } = fakeClient();
  const check = createDatabaseReadinessCheck(client);

  assert.equal(statements.length, 0);

  const result = check(liveSignal());
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0]?.strings, ['SELECT 1']);
  assert.deepEqual(statements[0]?.values, []);

  queries[0]?.resolve([{ '?column?': 1 }]);
  assert.equal(await result, true);
});

test('reports false when the query fails or throws synchronously', async () => {
  const failing = fakeClient();
  const failingCheck = createDatabaseReadinessCheck(failing.client);

  const failed = failingCheck(liveSignal());
  failing.queries[0]?.reject(new Error('synthetic database failure'));
  assert.equal(await failed, false);

  const throwingClient: DatabaseReadinessClient = {
    $queryRaw() {
      throw new Error('synthetic synchronous failure');
    },
  };
  assert.equal(await createDatabaseReadinessCheck(throwingClient)(liveSignal()), false);
});

test('reports false without querying when the signal is already aborted', async () => {
  const { client, queries } = fakeClient();
  const check = createDatabaseReadinessCheck(client);
  const controller = new AbortController();
  controller.abort();

  assert.equal(await check(controller.signal), false);
  assert.equal(queries.length, 0);
});

test('reuses one in-flight query until settlement, then queries again', async () => {
  const { client, queries } = fakeClient();
  const check = createDatabaseReadinessCheck(client);

  const first = check(liveSignal());
  const second = check(liveSignal());
  assert.equal(queries.length, 1);

  queries[0]?.resolve([]);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);

  const third = check(liveSignal());
  assert.equal(queries.length, 2);
  queries[1]?.resolve([]);
  assert.equal(await third, true);
});

test('does not start another query while pending after an abort and ignores the late result', async () => {
  const { client, queries } = fakeClient();
  const check = createDatabaseReadinessCheck(client);
  const controller = new AbortController();

  const first = check(controller.signal);
  controller.abort();

  assert.equal(await check(controller.signal), false);
  assert.equal(queries.length, 1);

  queries[0]?.resolve([]);
  assert.equal(await first, false);
  assert.equal(queries.length, 1);

  const later = check(liveSignal());
  assert.equal(queries.length, 2);
  queries[1]?.resolve([]);
  assert.equal(await later, true);
});

test('observes a late rejection after abort without leaking an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    const { client, queries } = fakeClient();
    const check = createDatabaseReadinessCheck(client);
    const controller = new AbortController();

    const result = check(controller.signal);
    controller.abort();
    queries[0]?.reject(new Error('synthetic late database failure'));

    assert.equal(await result, false);
    await delay(20);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
