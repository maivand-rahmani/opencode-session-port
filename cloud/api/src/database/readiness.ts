/**
 * Database connectivity probe for readiness.
 *
 * The probe is deliberately small and adapter-agnostic: it only needs a tagged
 * `$queryRaw` implementation. It issues the read-only statement `SELECT 1` via
 * tagged template, so no caller values are ever interpolated.
 *
 * A single check instance keeps at most one query in flight. Concurrent callers
 * share that query until it settles; a query that continues after its signal is
 * aborted is still observed, but its result is never reported as ready.
 *
 * This module does not add timeouts, connection pooling, retries, or log
 * output. The readiness timeout is owned by `evaluateReadiness`; an AbortSignal
 * here only stops the caller from accepting a late result, it does not cancel
 * the database driver's query.
 */

import type { ReadinessCheck } from '../readiness.js';

/**
 * Minimal structural surface used by the probe.
 *
 * Prisma's generated `$queryRaw` satisfies this shape, but the readiness module
 * intentionally does not depend on Prisma types.
 */
export interface DatabaseReadinessClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): PromiseLike<T>;
}

/**
 * Create one single-flight database readiness check.
 *
 * The returned check never queries before it is invoked. Once invoked with a
 * live signal it starts at most one query and reuses that promise for later
 * callers until settlement. Any query error (including insufficient
 * privileges) is reported as `false` without exposing its details.
 */
export function createDatabaseReadinessCheck(
  client: DatabaseReadinessClient,
): ReadinessCheck {
  let pending: Promise<boolean> | undefined;

  return async (signal) => {
    if (signal.aborted) {
      return false;
    }

    let query = pending;
    if (query === undefined) {
      query = observeQuery(client);
      pending = query;
      void query.then(
        () => {
          if (pending === query) {
            pending = undefined;
          }
        },
        () => {
          if (pending === query) {
            pending = undefined;
          }
        },
      );
    }

    const ready = await query;
    return ready && !signal.aborted;
  };
}

function observeQuery(client: DatabaseReadinessClient): Promise<boolean> {
  try {
    return Promise.resolve(client.$queryRaw`SELECT 1`).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}
