/**
 * Bounded readiness evaluation.
 *
 * Readiness is fail-closed: without an explicit set of checks the service is not
 * ready. A check must return exactly `true`; `false`, a thrown value, a malformed
 * check, or a timeout all produce `false`.
 *
 * Checks receive one shared AbortSignal and must stop promptly when it aborts.
 * Non-cooperative checks cannot be forcibly cancelled, but the overall promise is
 * bounded and late settlements/rejections are observed rather than left unhandled.
 */

export type ReadinessCheck = (signal: AbortSignal) => Promise<boolean>;

export interface ReadinessChecks {
  database: ReadinessCheck;
  migrations: ReadinessCheck;
  storage: ReadinessCheck;
}

const CHECK_NAMES = ['database', 'migrations', 'storage'] as const;

export async function evaluateReadiness(
  checks: ReadinessChecks | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!checks) {
    return false;
  }

  const candidate = checks as unknown as Record<string, unknown>;
  const functions = CHECK_NAMES.map((name) => candidate[name]);
  if (!functions.every((fn): fn is ReadinessCheck => typeof fn === 'function')) {
    return false;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
  });

  const checksDone = Promise.allSettled(
    functions.map((check) =>
      Promise.resolve().then(() => check(controller.signal)),
    ),
  ).then(
    (results) =>
      results.every(
        (result) => result.status === 'fulfilled' && result.value === true,
      ),
    () => false,
  );

  try {
    return await Promise.race([checksDone, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }
}
