/**
 * Native human-code generation, normalization, and domain-separated HMAC keys.
 *
 * A human code is exactly 12 characters from the frozen Crockford alphabet
 * `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (60 bits). Generation maps 12 CSPRNG
 * bytes through `byte & 31`; 256 is divisible by 32, so every alphabet symbol is
 * uniform without rejection sampling.
 *
 * Only ASCII case normalization is permitted. There are no aliases for I, L, O,
 * or U, no separators, no whitespace tolerance, and no Unicode normalization.
 * Raw codes are never logged, persisted, or included in errors by this module.
 */

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import type {
  NativeHumanCodeKeyConfig,
  NativeHumanCodeKeyRingConfig,
} from './config.js';

export const HUMAN_CODE_ALPHABET =
  '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const HUMAN_CODE_LENGTH = 12;
export const HUMAN_CODE_BITS = 60;
export const HUMAN_CODE_RAW_BYTES = 12;
export const HUMAN_CODE_KEY_MIN_BYTES = 32;
export const HUMAN_CODE_DIGEST_BYTES = 32;

const HUMAN_CODE_DOMAIN = 'sessionport.native-human-code\0v1\0';
const ASCII_CODE_INPUT = /^[0-9A-Za-z]{12}$/;
const CANONICAL_CODE = new RegExp(
  `^[${HUMAN_CODE_ALPHABET}]{${HUMAN_CODE_LENGTH}}$`,
);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type HumanCodeErrorCode =
  | 'invalid-human-code'
  | 'human-code-generation-failed'
  | 'human-code-key-unavailable'
  | 'invalid-human-code-key-ring';

const HUMAN_CODE_ERROR_MESSAGES: Readonly<
  Record<HumanCodeErrorCode, string>
> = Object.freeze({
  'invalid-human-code': 'Human code is invalid.',
  'human-code-generation-failed':
    'Human code generation failed.',
  'human-code-key-unavailable':
    'No human-code key is currently valid.',
  'invalid-human-code-key-ring':
    'Human-code key ring is invalid.',
});

export class HumanCodeError extends Error {
  readonly code: HumanCodeErrorCode;

  constructor(code: HumanCodeErrorCode) {
    super(HUMAN_CODE_ERROR_MESSAGES[code]);
    this.name = 'HumanCodeError';
    this.code = code;
  }
}

export interface HumanCodeDigest {
  readonly digest: Buffer;
  readonly keyID: string;
}

export interface HumanCodeKeyRingOptions {
  /**
   * Maximum pending-authorization lifetime. A key remains usable for lookup
   * until `retireAfter + this lifetime`, so a code created just before
   * retirement cannot outlive its verification key.
   */
  readonly pendingAuthorizationTTLSeconds: number;
  /** Injected clock; defaults to the current time. */
  readonly now?: () => Date;
}

/**
 * Generate a 12-character canonical human code.
 *
 * The supplied source must return exactly 12 bytes as a `Uint8Array` or
 * `Buffer`. Source failures and malformed results are replaced by a fixed
 * error so random-provider details never escape.
 */
export function generateHumanCode(
  randomByteSource: (requestedBytes: number) => Uint8Array = randomBytes,
): string {
  if (typeof randomByteSource !== 'function') {
    fail('human-code-generation-failed');
  }

  let generated: Uint8Array;
  try {
    generated = randomByteSource(HUMAN_CODE_RAW_BYTES);
  } catch {
    fail('human-code-generation-failed');
  }

  if (
    !(generated instanceof Uint8Array) ||
    generated.byteLength !== HUMAN_CODE_RAW_BYTES
  ) {
    fail('human-code-generation-failed');
  }

  let code = '';
  for (let index = 0; index < HUMAN_CODE_RAW_BYTES; index += 1) {
    code += HUMAN_CODE_ALPHABET[generated[index] & 31];
  }
  return code;
}

/**
 * Normalize only ASCII letter case, then enforce the exact alphabet and length.
 *
 * Unicode case folding is deliberately avoided: the ASCII gate runs before
 * `toUpperCase()`, so characters such as the long s cannot become an ASCII
 * alphabet symbol.
 */
export function normalizeHumanCode(code: string): string {
  if (
    typeof code !== 'string' ||
    code.length !== HUMAN_CODE_LENGTH ||
    !ASCII_CODE_INPUT.test(code)
  ) {
    fail('invalid-human-code');
  }

  const canonical = code.toUpperCase();
  if (!CANONICAL_CODE.test(canonical)) {
    fail('invalid-human-code');
  }
  return canonical;
}

/**
 * Dedicated human-code key ring.
 *
 * The constructor validates structure only. Clock-dependent retirement checks
 * run at creation and lookup so tests and callers can inject a deterministic
 * clock. There is no default key and no fallback when the active key is gone.
 */
export class HumanCodeKeyRing {
  readonly #keys: readonly NativeHumanCodeKeyConfig[];
  readonly #activeKeyID: string;
  readonly #pendingAuthorizationTTLSeconds: number;
  readonly #now: () => Date;

  constructor(
    ring: NativeHumanCodeKeyRingConfig,
    options: HumanCodeKeyRingOptions,
  ) {
    if (
      typeof ring !== 'object' ||
      ring === null ||
      !Array.isArray(ring.keys) ||
      ring.keys.length === 0 ||
      typeof ring.activeKeyID !== 'string'
    ) {
      fail('invalid-human-code-key-ring');
    }
    if (
      typeof options !== 'object' ||
      options === null ||
      !Number.isSafeInteger(options.pendingAuthorizationTTLSeconds) ||
      options.pendingAuthorizationTTLSeconds <= 0
    ) {
      fail('invalid-human-code-key-ring');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      fail('invalid-human-code-key-ring');
    }

    const ids = new Set<string>();
    const material: Buffer[] = [];
    const keys: NativeHumanCodeKeyConfig[] = [];

    for (const key of ring.keys) {
      if (
        typeof key !== 'object' ||
        key === null ||
        typeof key.id !== 'string' ||
        key.id.length === 0 ||
        CONTROL_CHARACTERS.test(key.id) ||
        ids.has(key.id) ||
        !(key.key instanceof Uint8Array) ||
        key.key.byteLength < HUMAN_CODE_KEY_MIN_BYTES ||
        (key.retireAfter !== undefined &&
          (!(key.retireAfter instanceof Date) ||
            !Number.isFinite(key.retireAfter.getTime())))
      ) {
        fail('invalid-human-code-key-ring');
      }

      const keyBytes = Buffer.from(key.key);
      if (material.some((existing) => existing.equals(keyBytes))) {
        fail('invalid-human-code-key-ring');
      }

      ids.add(key.id);
      material.push(keyBytes);
      keys.push(
        Object.freeze({
          id: key.id,
          key: keyBytes,
          ...(key.retireAfter === undefined
            ? {}
            : { retireAfter: new Date(key.retireAfter.getTime()) }),
        }),
      );
    }

    if (!ids.has(ring.activeKeyID)) {
      fail('invalid-human-code-key-ring');
    }

    this.#keys = Object.freeze(keys);
    this.#activeKeyID = ring.activeKeyID;
    this.#pendingAuthorizationTTLSeconds =
      options.pendingAuthorizationTTLSeconds;
    this.#now = options.now ?? (() => new Date());
  }

  get activeKeyID(): string {
    return this.#activeKeyID;
  }

  /**
   * Produce the digest and key ID for a newly created pending authorization.
   *
   * The active key must not have retired, and the code's full pending lifetime
   * must fit before the active key's `retireAfter` (when finite).
   */
  digestForCreation(code: string, at?: Date): HumanCodeDigest {
    const canonical = normalizeHumanCode(code);
    const now = readClock(at, this.#now);
    const active = this.#activeKey();
    const retireAfter = active.retireAfter?.getTime();

    if (retireAfter !== undefined && now.getTime() >= retireAfter) {
      fail('human-code-key-unavailable');
    }

    const lifetimeMs = this.#pendingAuthorizationTTLSeconds * 1000;
    const expiresAt = now.getTime() + lifetimeMs;
    if (
      !Number.isSafeInteger(expiresAt) ||
      (retireAfter !== undefined && expiresAt > retireAfter)
    ) {
      fail('human-code-key-unavailable');
    }

    return Object.freeze({
      digest: digestHumanCode(active.key, canonical),
      keyID: active.id,
    });
  }

  /**
   * Return digests for every key that may still verify a pending code.
   *
   * A key remains eligible until `retireAfter + pendingAuthorizationTTL`.
   * Keys without `retireAfter` never expire. The active key is listed first,
   * followed by the remaining configured order.
   */
  digestCandidates(code: string, at?: Date): readonly HumanCodeDigest[] {
    const canonical = normalizeHumanCode(code);
    const now = readClock(at, this.#now);
    const lifetimeMs = this.#pendingAuthorizationTTLSeconds * 1000;

    const ordered = [
      this.#activeKey(),
      ...this.#keys.filter((key) => key.id !== this.#activeKeyID),
    ];

    const candidates: HumanCodeDigest[] = [];
    for (const key of ordered) {
      if (key.retireAfter !== undefined) {
        const deadline = key.retireAfter.getTime() + lifetimeMs;
        if (!Number.isFinite(deadline) || now.getTime() >= deadline) {
          continue;
        }
      }
      candidates.push(
        Object.freeze({
          digest: digestHumanCode(key.key, canonical),
          keyID: key.id,
        }),
      );
    }

    return Object.freeze(candidates);
  }

  #activeKey(): NativeHumanCodeKeyConfig {
    const active = this.#keys.find((key) => key.id === this.#activeKeyID);
    if (active === undefined) {
      fail('invalid-human-code-key-ring');
    }
    return active;
  }
}

/**
 * Compare a stored digest to a candidate digest in constant time.
 *
 * This is a convenience for callers that materialize candidates before a
 * repository lookup; it is not persistence or collision handling.
 */
export function humanCodeDigestsEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (
    !(left instanceof Uint8Array) ||
    !(right instanceof Uint8Array) ||
    left.byteLength !== HUMAN_CODE_DIGEST_BYTES ||
    right.byteLength !== HUMAN_CODE_DIGEST_BYTES
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function digestHumanCode(key: Uint8Array, canonicalCode: string): Buffer {
  return createHmac('sha256', key)
    .update(HUMAN_CODE_DOMAIN, 'ascii')
    .update(canonicalCode, 'ascii')
    .digest();
}

function readClock(at: Date | undefined, now: () => Date): Date {
  if (at !== undefined) {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
      fail('human-code-key-unavailable');
    }
    return new Date(at.getTime());
  }

  let value: unknown;
  try {
    value = now();
  } catch {
    fail('human-code-key-unavailable');
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('human-code-key-unavailable');
  }
  return new Date(value.getTime());
}

function fail(code: HumanCodeErrorCode): never {
  throw new HumanCodeError(code);
}
