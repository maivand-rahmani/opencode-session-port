/**
 * Required native-auth rate limiting.
 *
 * Routes require an explicit `NativeRateLimiter`; there is no allow-all or
 * missing-limiter mode. A limiter failure is treated by the route as a
 * fail-closed denial (503), never as permission.
 *
 * `createInMemoryRateLimiter` is a bounded fixed-window implementation for
 * focused tests and single-process development. It is deliberately not a
 * distributed or multi-instance proof:
 * - entries are capped by an explicit `maxEntries`;
 * - at capacity, new keys are rejected instead of evicting live windows;
 * - expired entries may be pruned, which never grants an unexpired request;
 * - an optional per-call deadline and an injected clock are supported;
 * - keys are supplied by the route already hashed (IP/user/fingerprint); this
 *   module never logs or persists them;
 * - process restart loses all state.
 *
 * Production composition must supply a limiter with the same contract and
 * deployment-appropriate shared state.
 */

import type { NativeRateLimitPolicy } from './config.js';

export const NATIVE_RATE_LIMIT_OPERATIONS = Object.freeze([
  'createAuthorization',
  'browserVerification',
  'browserLookup',
  'approveAuthorization',
  'denyAuthorization',
  'exchangeDeviceCode',
  'refreshToken',
  'listGrants',
  'revokeGrant',
] as const);

export type NativeRateLimitOperation =
  (typeof NATIVE_RATE_LIMIT_OPERATIONS)[number];

export interface NativeRateLimitDecision {
  readonly allowed: boolean;
  /** Seconds the caller should wait before retrying. */
  readonly retryAfterSeconds?: number;
}

export interface NativeRateLimitConsumeOptions {
  /** Absolute wall-clock deadline in milliseconds. Past it, deny. */
  readonly deadline?: number;
}

export interface NativeRateLimiter {
  consume(
    operation: NativeRateLimitOperation,
    key: string,
    policy: NativeRateLimitPolicy,
    options?: NativeRateLimitConsumeOptions,
  ): Promise<NativeRateLimitDecision>;
}

export interface InMemoryRateLimiterOptions {
  /** Explicit positive bound. No default. */
  readonly maxEntries: number;
  /** Injected clock; defaults to the wall clock. */
  readonly now?: () => Date;
}

interface WindowEntry {
  windowStart: number;
  windowMilliseconds: number;
  count: number;
}

const MAX_KEY_LENGTH = 1_024;

/**
 * Validate a required limiter dependency at route construction time.
 */
export function readNativeRateLimiter(value: unknown): NativeRateLimiter {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { readonly consume?: unknown }).consume !== 'function'
  ) {
    throw new TypeError('Invalid native-auth rate limiter.');
  }
  return value as NativeRateLimiter;
}

/**
 * Build the bounded single-process limiter. `maxEntries` is validated before
 * any state is created.
 */
export function createInMemoryRateLimiter(
  options: InMemoryRateLimiterOptions,
): NativeRateLimiter {
  const maxEntries = readMaxEntries(options);
  const now = readClock(options.now);
  const windows = new Map<string, WindowEntry>();

  return Object.freeze({
    consume: async (
      operation: NativeRateLimitOperation,
      key: string,
      policy: NativeRateLimitPolicy,
      consumeOptions?: NativeRateLimitConsumeOptions,
    ): Promise<NativeRateLimitDecision> => {
      if (!isOperation(operation) || !isKey(key) || !isPolicy(policy)) {
        return deny(policy);
      }
      if (consumeOptions !== undefined) {
        if (
          typeof consumeOptions !== 'object' ||
          consumeOptions === null ||
          Array.isArray(consumeOptions) ||
          (consumeOptions.deadline !== undefined &&
            (typeof consumeOptions.deadline !== 'number' ||
              !Number.isFinite(consumeOptions.deadline)))
        ) {
          return deny(policy);
        }
      }

      let current: number;
      try {
        current = now().getTime();
      } catch {
        return deny(policy);
      }
      if (!Number.isFinite(current)) {
        return deny(policy);
      }
      if (
        consumeOptions?.deadline !== undefined &&
        current >= consumeOptions.deadline
      ) {
        return deny(policy);
      }

      const windowMilliseconds = policy.windowSeconds * 1_000;
      const mapKey = `${operation}\u0000${key}`;
      let entry = windows.get(mapKey);

      if (entry !== undefined) {
        if (entry.windowStart + entry.windowMilliseconds <= current) {
          entry.windowStart = current;
          entry.windowMilliseconds = windowMilliseconds;
          entry.count = 0;
        }
      } else {
        if (windows.size >= maxEntries) {
          pruneExpired(windows, current);
        }
        if (windows.size >= maxEntries) {
          return deny(policy);
        }
        entry = { windowStart: current, windowMilliseconds, count: 0 };
        windows.set(mapKey, entry);
      }

      if (entry.count >= policy.maxRequests) {
        return deny(policy, entry.windowStart + windowMilliseconds - current);
      }

      entry.count += 1;
      return Object.freeze({ allowed: true, retryAfterSeconds: 0 });
    },
  });
}

function pruneExpired(
  windows: Map<string, WindowEntry>,
  current: number,
): void {
  for (const [key, entry] of windows) {
    // Each entry carries the window of the operation that created it. Only
    // entries whose own window has elapsed are removed; a live window is
    // never evicted to make room.
    if (entry.windowStart + entry.windowMilliseconds <= current) {
      windows.delete(key);
    }
  }
}

function readMaxEntries(options: InMemoryRateLimiterOptions): number {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError('Invalid in-memory rate limiter options.');
  }
  const value = options.maxEntries;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Invalid in-memory rate limiter options.');
  }
  return value;
}

function readClock(clock: (() => Date) | undefined): () => Date {
  if (clock === undefined) {
    return () => new Date();
  }
  if (typeof clock !== 'function') {
    throw new TypeError('Invalid in-memory rate limiter options.');
  }
  return () => {
    const value = clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError('In-memory rate limiter clock is unavailable.');
    }
    return new Date(value.getTime());
  };
}

function isOperation(value: unknown): value is NativeRateLimitOperation {
  return (
    typeof value === 'string' &&
    (NATIVE_RATE_LIMIT_OPERATIONS as readonly string[]).includes(value)
  );
}

function isKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_KEY_LENGTH
  );
}

function isPolicy(value: unknown): value is NativeRateLimitPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const policy = value as {
    readonly windowSeconds?: unknown;
    readonly maxRequests?: unknown;
  };
  return (
    typeof policy.windowSeconds === 'number' &&
    Number.isSafeInteger(policy.windowSeconds) &&
    policy.windowSeconds > 0 &&
    typeof policy.maxRequests === 'number' &&
    Number.isSafeInteger(policy.maxRequests) &&
    policy.maxRequests > 0
  );
}

function deny(
  policy: NativeRateLimitPolicy,
  remainingMilliseconds?: number,
): NativeRateLimitDecision {
  const fallbackSeconds =
    isPolicy(policy) && policy.windowSeconds > 0 ? policy.windowSeconds : 1;
  const seconds =
    remainingMilliseconds === undefined
      ? fallbackSeconds
      : Math.max(1, Math.ceil(remainingMilliseconds / 1_000));
  return Object.freeze({
    allowed: false,
    retryAfterSeconds: seconds,
  });
}
