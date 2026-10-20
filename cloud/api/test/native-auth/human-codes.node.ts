import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateHumanCode,
  HUMAN_CODE_ALPHABET,
  HUMAN_CODE_BITS,
  HUMAN_CODE_KEY_MIN_BYTES,
  HUMAN_CODE_LENGTH,
  HUMAN_CODE_RAW_BYTES,
  HumanCodeError,
  HumanCodeKeyRing,
  humanCodeDigestsEqual,
  normalizeHumanCode,
} from '../../src/native-auth/human-codes.js';
import type {
  HumanCodeErrorCode,
  HumanCodeKeyRingOptions,
} from '../../src/native-auth/human-codes.js';
import type { NativeHumanCodeKeyRingConfig } from '../../src/native-auth/config.js';

type RandomSource = (requestedBytes: number) => Uint8Array;

const CODE = '0123456789AB';
const CANONICAL_WITH_LETTERS = 'ABCDEFGHJKM1';
const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2099-01-01T00:00:00.000Z');
const TTL_SECONDS = 600;

const CODE_PATTERN = new RegExp(
  `^[${HUMAN_CODE_ALPHABET}]{${HUMAN_CODE_LENGTH}}$`,
);

const DIGEST_A = Buffer.from(
  '7a4e32a45b4c75de80bac5eb0140d470ee33bcdbf2be5a1713179eaf0d963efa',
  'hex',
);
const DIGEST_B = Buffer.from(
  '5c8f2f4108bba7814bb7b348bfbd1b25f405fd98a0e32574fe34d6970c491ae5',
  'hex',
);
const DIGEST_A_LETTERS = Buffer.from(
  '575deb35576b32e80de78c0ff2bfff4dcf3cd893a25464bf891c5a25f8721cdd',
  'hex',
);

function keyRing(
  overrides: Partial<NativeHumanCodeKeyRingConfig> = {},
): NativeHumanCodeKeyRingConfig {
  return {
    keys: [
      { id: 'active', key: Buffer.from(KEY_A), retireAfter: LATER },
      { id: 'retiring', key: Buffer.from(KEY_B) },
    ],
    activeKeyID: 'active',
    ...overrides,
  };
}

function options(
  overrides: Partial<HumanCodeKeyRingOptions> = {},
): HumanCodeKeyRingOptions {
  return {
    pendingAuthorizationTTLSeconds: TTL_SECONDS,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function assertHumanCodeError(
  code: HumanCodeErrorCode,
  message: string,
) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof HumanCodeError);
    assert.equal(error.name, 'HumanCodeError');
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
    return true;
  };
}

const INVALID_CODE = assertHumanCodeError(
  'invalid-human-code',
  'Human code is invalid.',
);
const GENERATION_FAILED = assertHumanCodeError(
  'human-code-generation-failed',
  'Human code generation failed.',
);
const KEY_UNAVAILABLE = assertHumanCodeError(
  'human-code-key-unavailable',
  'No human-code key is currently valid.',
);
const INVALID_RING = assertHumanCodeError(
  'invalid-human-code-key-ring',
  'Human-code key ring is invalid.',
);

test('frozen alphabet and sizes describe a 12-character, 60-bit code', () => {
  assert.equal(HUMAN_CODE_ALPHABET, '0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  assert.equal(HUMAN_CODE_LENGTH, 12);
  assert.equal(HUMAN_CODE_BITS, 60);
  assert.equal(HUMAN_CODE_RAW_BYTES, 12);
  assert.equal(HUMAN_CODE_KEY_MIN_BYTES, 32);
  assert.equal(new Set(HUMAN_CODE_ALPHABET).size, 32);
  assert.equal(HUMAN_CODE_ALPHABET.includes('I'), false);
  assert.equal(HUMAN_CODE_ALPHABET.includes('L'), false);
  assert.equal(HUMAN_CODE_ALPHABET.includes('O'), false);
  assert.equal(HUMAN_CODE_ALPHABET.includes('U'), false);
});

test('generates the independently computed sequence vector from low five bits', () => {
  const requested: number[] = [];
  const code = generateHumanCode((requestedBytes) => {
    requested.push(requestedBytes);
    return Uint8Array.from(
      { length: 12 },
      (_, index) => index,
    );
  });

  assert.equal(code, CODE);
  assert.deepEqual(requested, [12]);
  assert.match(code, CODE_PATTERN);
  assert.equal(code.length, 12);

  assert.equal(
    generateHumanCode(() => Buffer.alloc(12, 0xff)),
    'ZZZZZZZZZZZZ',
  );
  assert.equal(
    generateHumanCode(() => Buffer.alloc(12, 0x00)),
    '000000000000',
  );
});

test('default CSPRNG generation is canonical without frequency claims', () => {
  for (let index = 0; index < 100; index += 1) {
    const code = generateHumanCode();
    assert.equal(code.length, 12);
    assert.match(code, CODE_PATTERN);
    assert.equal(normalizeHumanCode(code), code);
  }
});

test('accepts an exact-size Uint8Array view', () => {
  const backing = new Uint8Array(24);
  backing.set(
    Uint8Array.from({ length: 12 }, (_, index) => index),
    7,
  );
  const view = backing.subarray(7, 19);
  assert.equal(view.byteLength, 12);
  assert.equal(generateHumanCode(() => view), CODE);
});

test('rejects malformed RNG results and sanitizes source failures', () => {
  const invalidResults: unknown[] = [
    new Uint8Array(0),
    new Uint8Array(11),
    new Uint8Array(13),
    Buffer.alloc(11),
    new ArrayBuffer(12),
    new DataView(new ArrayBuffer(12)),
    new Uint16Array(6),
    Array.from({ length: 12 }, () => 0),
    { byteLength: 12 },
    '0123456789AB',
    null,
    undefined,
    12,
    12n,
    true,
  ];

  for (const result of invalidResults) {
    const source = (() => result) as unknown as RandomSource;
    assert.throws(() => generateHumanCode(source), GENERATION_FAILED);
  }

  const secret = 'synthetic-rng-secret-7a2c';
  const sources: RandomSource[] = [
    () => {
      throw new Error(secret);
    },
    () => {
      throw secret;
    },
    () => {
      throw { message: secret, code: 'raw-code' };
    },
  ];

  for (const source of sources) {
    assert.throws(
      () => generateHumanCode(source),
      (error: unknown) => {
        assert.equal(error instanceof HumanCodeError, true);
        const rendered = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
        assert.equal(rendered.includes(secret), false);
        assert.equal(rendered.includes('raw-code'), false);
        return true;
      },
    );
  }

  for (const source of [null, 0, 'rng', {}, [], true] as unknown[]) {
    assert.throws(
      () => generateHumanCode(source as unknown as RandomSource),
      GENERATION_FAILED,
    );
  }
});

test('normalizes only ASCII case and rejects aliases, separators, and Unicode', () => {
  assert.equal(
    normalizeHumanCode(CANONICAL_WITH_LETTERS.toLowerCase()),
    CANONICAL_WITH_LETTERS,
  );
  assert.equal(normalizeHumanCode(CODE), CODE);

  const rejected = [
    'IIIIIIIIIIII',
    'LLLLLLLLLLLL',
    'OOOOOOOOOOOO',
    'UUUUUUUUUUUU',
    'abcdefghjkm0'.replace('0', 'o'),
    'ABCDEFGH-JKM',
    'ABCDEFGH JKM',
    ' ABCDEFGHJKM',
    'ABCDEFGHJKM ',
    'ABCDEFGHJKM\n',
    'ABCDEFGHJKM\u0000',
    'ＡBCDEFGHJKM1',
    'ſbcdefghjkm1',
    'ABCDEFGHJKM',
    'ABCDEFGHJKM12',
    `🔑${'A'.repeat(11)}`,
    '',
  ];

  for (const code of rejected) {
    assert.throws(() => normalizeHumanCode(code), INVALID_CODE);
  }

  for (const value of [
    null,
    undefined,
    0,
    12n,
    {},
    [],
    new String(CODE),
    () => CODE,
  ] as unknown[]) {
    assert.throws(
      () => normalizeHumanCode(value as string),
      INVALID_CODE,
    );
  }
});

test('creation returns independently computed domain-separated HMAC vectors', () => {
  const ring = new HumanCodeKeyRing(keyRing(), options());
  const result = ring.digestForCreation(CODE);

  assert.equal(result.keyID, 'active');
  assert.equal(result.digest.length, 32);
  assert.deepEqual(result.digest, DIGEST_A);
  assert.equal(Object.isFrozen(result), true);

  const lower = ring.digestForCreation(CANONICAL_WITH_LETTERS.toLowerCase());
  assert.equal(lower.keyID, 'active');
  assert.deepEqual(lower.digest, DIGEST_A_LETTERS);

  const secondKey = new HumanCodeKeyRing(
    keyRing({ activeKeyID: 'retiring' }),
    options(),
  );
  assert.deepEqual(secondKey.digestForCreation(CODE).digest, DIGEST_B);
});

test('lookup candidates include active and unexpired retiring keys in order', () => {
  const ring = new HumanCodeKeyRing(keyRing(), options());
  const candidates = ring.digestCandidates(CODE);

  assert.deepEqual(
    candidates.map((candidate) => candidate.keyID),
    ['active', 'retiring'],
  );
  assert.deepEqual(candidates[0].digest, DIGEST_A);
  assert.deepEqual(candidates[1].digest, DIGEST_B);
  assert.equal(Object.isFrozen(candidates), true);
  assert.equal(Object.isFrozen(candidates[0]), true);
});

test('retiring keys remain eligible through the maximum pending lifetime', () => {
  const retireAfter = new Date('2026-01-01T00:00:00.000Z');
  const ring = new HumanCodeKeyRing(
    {
      activeKeyID: 'active',
      keys: [
        { id: 'active', key: Buffer.from(KEY_A) },
        { id: 'retiring', key: Buffer.from(KEY_B), retireAfter },
      ],
    },
    options(),
  );

  const lastMoment = new Date(
    retireAfter.getTime() + TTL_SECONDS * 1000 - 1,
  );
  const firstExpired = new Date(
    retireAfter.getTime() + TTL_SECONDS * 1000,
  );

  assert.deepEqual(
    ring.digestCandidates(CODE, lastMoment).map((entry) => entry.keyID),
    ['active', 'retiring'],
  );
  assert.deepEqual(
    ring.digestCandidates(CODE, firstExpired).map((entry) => entry.keyID),
    ['active'],
  );
});

test('creation fails at active-key retirement and when the pending code would outlive it', () => {
  const activeRetire = new Date('2026-01-01T00:10:00.000Z');
  const ring = new HumanCodeKeyRing(
    {
      activeKeyID: 'active',
      keys: [
        { id: 'active', key: Buffer.from(KEY_A), retireAfter: activeRetire },
      ],
    },
    options({ pendingAuthorizationTTLSeconds: 600 }),
  );

  assert.doesNotThrow(() =>
    ring.digestForCreation(CODE, new Date(activeRetire.getTime() - 600_000)),
  );
  assert.throws(
    () =>
      ring.digestForCreation(
        CODE,
        new Date(activeRetire.getTime() - 600_000 + 1),
      ),
    KEY_UNAVAILABLE,
  );
  assert.throws(
    () => ring.digestForCreation(CODE, activeRetire),
    KEY_UNAVAILABLE,
  );
  assert.throws(
    () =>
      ring.digestForCreation(
        CODE,
        new Date(activeRetire.getTime() + 1),
      ),
    KEY_UNAVAILABLE,
  );
});

test('a key without retireAfter remains usable for creation', () => {
  const ring = new HumanCodeKeyRing(
    {
      activeKeyID: 'active',
      keys: [{ id: 'active', key: Buffer.from(KEY_A) }],
    },
    options({ now: () => LATER }),
  );

  assert.deepEqual(ring.digestForCreation(CODE).digest, DIGEST_A);
  assert.deepEqual(
    ring.digestCandidates(CODE).map((entry) => entry.keyID),
    ['active'],
  );
});

test('lookup fails closed when every configured key is expired', () => {
  const ring = new HumanCodeKeyRing(
    {
      activeKeyID: 'active',
      keys: [
        {
          id: 'active',
          key: Buffer.from(KEY_A),
          retireAfter: new Date('2020-01-01T00:00:00.000Z'),
        },
      ],
    },
    options({ now: () => FIXED_NOW }),
  );

  assert.deepEqual(ring.digestCandidates(CODE), []);
});

test('constructor rejects malformed rings, duplicate IDs/materials, and missing active keys', () => {
  const invalidRings: unknown[] = [
    { keys: [], activeKeyID: 'active' },
    { keys: [{ id: 'other', key: KEY_A }], activeKeyID: 'active' },
    {
      keys: [
        { id: 'same', key: KEY_A },
        { id: 'same', key: KEY_B },
      ],
      activeKeyID: 'same',
    },
    {
      keys: [
        { id: 'one', key: KEY_A },
        { id: 'two', key: KEY_A },
      ],
      activeKeyID: 'one',
    },
    {
      keys: [{ id: 'active', key: Buffer.alloc(31, 0x11) }],
      activeKeyID: 'active',
    },
    {
      keys: [{ id: 'active', key: 'not-bytes' }],
      activeKeyID: 'active',
    },
    {
      keys: [{ id: 'active', key: KEY_A, retireAfter: new Date('invalid') }],
      activeKeyID: 'active',
    },
    {
      keys: [{ id: 'active', key: KEY_A, retireAfter: '2099-01-01' }],
      activeKeyID: 'active',
    },
    { keys: [{ id: 'active', key: KEY_A }], activeKeyID: 'missing' },
  ];

  for (const ring of invalidRings) {
    assert.throws(
      () =>
        new HumanCodeKeyRing(
          ring as NativeHumanCodeKeyRingConfig,
          options(),
        ),
      INVALID_RING,
    );
  }

  for (const ttl of [0, -1, 1.5, Number.NaN, '600'] as unknown[]) {
    assert.throws(
      () =>
        new HumanCodeKeyRing(
          keyRing(),
          options({
            pendingAuthorizationTTLSeconds: ttl as number,
          }),
        ),
      INVALID_RING,
    );
  }

  assert.throws(
    () =>
      new HumanCodeKeyRing(
        keyRing(),
        options({ now: null as unknown as () => Date }),
      ),
    INVALID_RING,
  );
});

test('injected clock failures are fixed key-unavailable errors', () => {
  const invalidClock = new HumanCodeKeyRing(
    keyRing(),
    options({ now: () => new Date('invalid') }),
  );
  assert.throws(
    () => invalidClock.digestForCreation(CODE),
    KEY_UNAVAILABLE,
  );
  assert.throws(
    () => invalidClock.digestCandidates(CODE),
    KEY_UNAVAILABLE,
  );

  const throwingClock = new HumanCodeKeyRing(
    keyRing(),
    options({
      now: () => {
        throw new Error('clock-secret-91fc');
      },
    }),
  );
  assert.throws(
    () => throwingClock.digestForCreation(CODE),
    (error: unknown) => {
      assert.equal(error instanceof HumanCodeError, true);
      const rendered = `${String(error)} ${(error as Error).stack ?? ''}`;
      assert.equal(rendered.includes('clock-secret-91fc'), false);
      return true;
    },
  );
  assert.throws(
    () =>
      throwingClock.digestForCreation(
        CODE,
        new Date('invalid'),
      ),
    KEY_UNAVAILABLE,
  );
});

test('codes, key material, and digests never appear in fixed errors', () => {
  const secretCode = 'SECRETCODE12';
  const ring = new HumanCodeKeyRing(keyRing(), options());
  const cases = [
    () => normalizeHumanCode(secretCode),
    () => ring.digestForCreation('IIIIIIIIIIII'),
    () =>
      ring.digestForCreation(
        CODE,
        new Date('2099-01-01T00:00:00.000Z'),
      ),
  ];

  for (const run of cases) {
    assert.throws(run, (error: unknown) => {
      assert.equal(error instanceof HumanCodeError, true);
      const rendered = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
      assert.equal(rendered.includes(secretCode), false);
      assert.equal(
        rendered.includes(KEY_A.toString('base64')),
        false,
      );
      assert.equal(rendered.includes(DIGEST_A.toString('hex')), false);
      return true;
    });
  }
});

test('constant-time digest comparison rejects wrong lengths and shortened input', () => {
  assert.equal(humanCodeDigestsEqual(DIGEST_A, Buffer.from(DIGEST_A)), true);
  assert.equal(
    humanCodeDigestsEqual(
      DIGEST_A,
      Buffer.from(DIGEST_A.map((byte) => byte ^ 1)),
    ),
    false,
  );
  assert.equal(humanCodeDigestsEqual(DIGEST_A, DIGEST_A.subarray(0, 31)), false);
  assert.equal(
    humanCodeDigestsEqual(
      'not-bytes' as unknown as Uint8Array,
      DIGEST_A,
    ),
    false,
  );
});
