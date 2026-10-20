import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fingerprintCredential,
  generateCredential,
  NativeCredentialError,
} from '../../src/native-auth/credentials.js';
import type { CredentialKind } from '../../src/native-auth/credentials.js';

type RandomSource = (requestedBytes: number) => Uint8Array;

const KINDS = ['device', 'access', 'refresh'] as const;

const SEQ_BYTES = new Uint8Array(32).map((_, index) => index);
const SEQ_TOKEN = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ZERO_TOKEN = 'A'.repeat(43);
const FF_TOKEN = '__________________________________________8';

// Independently computed with Node SHA-256 and .NET SHA-256 over the exact
// UTF-8 domains `sessionport.native-credential\0v1\0<kind>\0` plus these bytes.
const SEQ_FINGERPRINTS = {
  device: 'f0b282176a968966fd7b27b725381d848270eb8b3e6484c16823025af565428a',
  access: '7678d4cd2df0cc7b18f718a0c84b02b5d7030c4c77abf3d13ccf745866067ef0',
  refresh: '96481b8109b1b6ad8e25325843bdfb800c2ee15480753ab24b1830e66d899c25',
} as const;

const ZERO_FINGERPRINTS = {
  device: '650564782afb37cf7064fd240afb4eee642c263df3efce70bc4bdd93f61a94e8',
  access: 'b05567d8c2c28b748803e7aaf30c2113a6d99fa26b82eaa37c13bfe496c18265',
  refresh: 'd0b2ce6a13bdb7fee63778dd07ff1d18bc43222526a2b43a647dc1f43a570bd2',
} as const;

const FF_DEVICE_FINGERPRINT =
  'e2821180799b42a1f9775108687f99b924b57c11f2b9fca3023b18a3203147ca';
const FIXED_MESSAGE = 'Native credential is invalid.';
const FIXED_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FIXED_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function assertCredentialError(error: unknown): boolean {
  assert.ok(error instanceof NativeCredentialError);
  assert.equal(error.name, 'NativeCredentialError');
  assert.equal(error.code, 'invalid-native-credential');
  assert.equal(error.message, FIXED_MESSAGE);
  assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
  assert.equal(error.cause, undefined);
  return true;
}

function assertCanonicalCredential(token: string): void {
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 43);
  assert.match(token, FIXED_CREDENTIAL_PATTERN);

  const decoded = Buffer.from(token, 'base64url');
  assert.equal(decoded.length, 32);
  assert.equal(decoded.toString('base64url'), token);
}

test('fingerprints match independently computed domain-separated known vectors', () => {
  for (const kind of KINDS) {
    const seqFingerprint = fingerprintCredential(kind, SEQ_TOKEN);
    const zeroFingerprint = fingerprintCredential(kind, ZERO_TOKEN);

    assert.equal(seqFingerprint, SEQ_FINGERPRINTS[kind]);
    assert.equal(zeroFingerprint, ZERO_FINGERPRINTS[kind]);
    assert.match(seqFingerprint, FIXED_FINGERPRINT_PATTERN);
    assert.match(zeroFingerprint, FIXED_FINGERPRINT_PATTERN);
    assert.equal(seqFingerprint, seqFingerprint.toLowerCase());
    assert.equal(zeroFingerprint, zeroFingerprint.toLowerCase());
  }

  assert.equal(
    fingerprintCredential('device', FF_TOKEN),
    FF_DEVICE_FINGERPRINT,
  );
});

test('kind domains separate fingerprints while generation does not encode kind', () => {
  const device = fingerprintCredential('device', SEQ_TOKEN);
  const access = fingerprintCredential('access', SEQ_TOKEN);
  const refresh = fingerprintCredential('refresh', SEQ_TOKEN);

  assert.notEqual(device, access);
  assert.notEqual(device, refresh);
  assert.notEqual(access, refresh);

  const tokens = KINDS.map((kind) =>
    generateCredential(kind, () => Uint8Array.from(SEQ_BYTES)),
  );
  assert.deepEqual(tokens, [SEQ_TOKEN, SEQ_TOKEN, SEQ_TOKEN]);
});

test('generateCredential matches independently computed known vectors', () => {
  const requestedSizes: number[] = [];
  const fromSequence = generateCredential('device', (requestedBytes) => {
    requestedSizes.push(requestedBytes);
    return Buffer.from(SEQ_BYTES);
  });

  assert.equal(fromSequence, SEQ_TOKEN);
  assert.deepEqual(requestedSizes, [32]);
  assertCanonicalCredential(fromSequence);

  assert.equal(
    generateCredential('access', () => new Uint8Array(SEQ_BYTES)),
    SEQ_TOKEN,
  );
  assert.equal(
    generateCredential('refresh', () => Buffer.alloc(32)),
    ZERO_TOKEN,
  );
  assert.equal(
    generateCredential('device', () => Buffer.alloc(32, 0xff)),
    FF_TOKEN,
  );
});

test('honors an exact-size Uint8Array view with a nonzero byte offset', () => {
  const backing = new Uint8Array(64);
  backing.set(SEQ_BYTES, 9);
  const view = backing.subarray(9, 41);

  assert.equal(view.byteLength, 32);
  assert.equal(generateCredential('device', () => view), SEQ_TOKEN);
});

test('default CSPRNG produces canonical credentials without frequency claims', () => {
  for (const kind of KINDS) {
    const token = generateCredential(kind);
    assertCanonicalCredential(token);
    assert.equal(token.length, 43);
  }
});

test('RNG receives exactly 32 requested bytes for every kind', () => {
  for (const kind of KINDS) {
    const requestedSizes: number[] = [];
    const token = generateCredential(kind, (requestedBytes) => {
      requestedSizes.push(requestedBytes);
      return Buffer.alloc(32);
    });

    assert.deepEqual(requestedSizes, [32]);
    assert.equal(token, ZERO_TOKEN);
  }
});

test('rejects wrong-length, non-byte, and non-Uint8Array RNG results', () => {
  const invalidResults: unknown[] = [
    new Uint8Array(0),
    new Uint8Array(31),
    new Uint8Array(33),
    Buffer.alloc(0),
    Buffer.alloc(31),
    Buffer.alloc(33),
    new ArrayBuffer(32),
    new DataView(new ArrayBuffer(32)),
    new Uint16Array(16),
    new BigInt64Array(4),
    Array.from({ length: 32 }, () => 0),
    { byteLength: 32 },
    { length: 32 },
    'A'.repeat(32),
    null,
    undefined,
    0,
    32n,
    true,
  ];

  for (const result of invalidResults) {
    const source = (() => result) as unknown as RandomSource;
    assert.throws(
      () => generateCredential('device', source),
      assertCredentialError,
    );
  }
});

test('rejects invalid RNG dependency types without calling them', () => {
  const invalidSources: unknown[] = [null, 0, 32n, 'randomBytes', {}, [], true];

  for (const source of invalidSources) {
    assert.throws(
      () => generateCredential('device', source as unknown as RandomSource),
      assertCredentialError,
    );
  }
});

test('sanitizes RNG failures without exposing thrown values or causes', () => {
  const secret = 'rng-secret-value-2f6c';
  const sources: RandomSource[] = [
    () => {
      throw new Error(secret);
    },
    () => {
      throw secret;
    },
    () => {
      throw { message: secret, code: 'raw-rng-code' };
    },
  ];

  for (const source of sources) {
    assert.throws(
      () => generateCredential('device', source),
      (error: unknown) => {
        assertCredentialError(error);
        const rendered = `${String(error)} ${(error as Error).stack ?? ''}`;
        assert.equal(rendered.includes(secret), false);
        assert.equal(rendered.includes('raw-rng-code'), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      },
    );
  }
});

test('rejects every invalid kind before invoking the RNG', () => {
  const invalidKinds: unknown[] = [
    undefined,
    null,
    '',
    'device ',
    ' device',
    'Device',
    'DEVICE',
    'access ',
    'ACCESS',
    'refresh\n',
    'refresh\0',
    'admin',
    0,
    1,
    32n,
    true,
    false,
    {},
    [],
    ['device'],
    () => 'device',
    Symbol('device'),
    new String('device'),
  ];

  let calls = 0;
  const source = (): Uint8Array => {
    calls += 1;
    return Buffer.alloc(32);
  };

  for (const kind of invalidKinds) {
    assert.throws(
      () =>
        generateCredential(kind as unknown as CredentialKind, source),
      assertCredentialError,
    );
    assert.throws(
      () =>
        fingerprintCredential(
          kind as unknown as CredentialKind,
          SEQ_TOKEN,
        ),
      assertCredentialError,
    );
  }

  assert.equal(calls, 0);
});

test('rejects padded, spaced, unicode, and wrong-length tokens', () => {
  const invalidTokens: unknown[] = [
    '',
    'A'.repeat(42),
    'A'.repeat(44),
    'A'.repeat(100_000),
    `${SEQ_TOKEN}=`,
    `${SEQ_TOKEN}==`,
    `${SEQ_TOKEN} `,
    ` ${SEQ_TOKEN}`,
    `${SEQ_TOKEN}\n`,
    `${SEQ_TOKEN.slice(0, 20)} ${SEQ_TOKEN.slice(21)}`,
    `${SEQ_TOKEN.slice(0, 20)}\0${SEQ_TOKEN.slice(21)}`,
    `é${'A'.repeat(42)}`,
    `🔑${'A'.repeat(41)}`,
    `sessionport.native-credential`,
    `${SEQ_TOKEN.slice(0, 21)}+${SEQ_TOKEN.slice(22)}`,
    `${SEQ_TOKEN.slice(0, 21)}/${SEQ_TOKEN.slice(22)}`,
    `${SEQ_TOKEN.slice(0, 21)}.${SEQ_TOKEN.slice(22)}`,
  ];

  for (const token of invalidTokens) {
    assert.throws(
      () => fingerprintCredential('device', token as string),
      assertCredentialError,
    );
  }
});

test('rejects noncanonical trailing base64url bits', () => {
  const noncanonicalTokens = [
    `${'A'.repeat(42)}B`,
    `${'A'.repeat(42)}C`,
    `${'A'.repeat(42)}D`,
    `${'A'.repeat(42)}_`,
    `${SEQ_TOKEN.slice(0, 42)}9`,
  ];

  for (const token of noncanonicalTokens) {
    assert.equal(token.length, 43);
    assert.match(token, FIXED_CREDENTIAL_PATTERN);
    assert.equal(
      Buffer.from(token, 'base64url').toString('base64url') === token,
      false,
    );
    assert.throws(
      () => fingerprintCredential('device', token),
      assertCredentialError,
    );
  }
});

test('rejects non-string token values passed through unknown casts', () => {
  const invalidTokens: unknown[] = [
    null,
    undefined,
    0,
    1,
    32n,
    true,
    false,
    {},
    [],
    ['A'.repeat(43)],
    new String(SEQ_TOKEN),
    () => SEQ_TOKEN,
    Symbol('token'),
    new Uint8Array(43),
  ];

  for (const token of invalidTokens) {
    assert.throws(
      () => fingerprintCredential('device', token as string),
      assertCredentialError,
    );
  }
});

test('fixed errors never echo secret tokens, kinds, or RNG details', () => {
  const secretToken = `${SEQ_TOKEN}=`;
  const secretKind = 'secret-kind-value';
  const secretRng = 'secret-rng-value';
  const veryLongSecret = 'x'.repeat(100_000);
  const runs = [
    () => fingerprintCredential('device', secretToken),
    () => fingerprintCredential(secretKind as unknown as CredentialKind, SEQ_TOKEN),
    () => fingerprintCredential('device', veryLongSecret),
    () =>
      generateCredential(
        secretKind as unknown as CredentialKind,
        () => Buffer.alloc(32),
      ),
    () =>
      generateCredential('device', () => {
        throw new Error(secretRng);
      }),
  ];

  for (const run of runs) {
    assert.throws(run, (error: unknown) => {
      assertCredentialError(error);
      const rendered = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
      assert.equal(rendered.includes(secretToken), false);
      assert.equal(rendered.includes(secretKind), false);
      assert.equal(rendered.includes(secretRng), false);
      assert.equal(rendered.includes(veryLongSecret), false);
      assert.equal(rendered.includes('sessionport.native-credential'), false);
      return true;
    });
  }
});
