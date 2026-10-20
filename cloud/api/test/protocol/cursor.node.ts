import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCursor } from '../../src/protocol/cursor.js';

test('accepts zero and the inclusive upper bound', () => {
  assert.deepEqual(parseCursor('0', 0n), { ok: true, value: 0n });
  assert.deepEqual(parseCursor('0', 42n), { ok: true, value: 0n });
  assert.deepEqual(parseCursor('41', 41n), { ok: true, value: 41n });
  assert.deepEqual(parseCursor('42', 42n), { ok: true, value: 42n });
});

test('accepts leading zeros as valid decimal positions', () => {
  assert.deepEqual(parseCursor('000', 0n), { ok: true, value: 0n });
  assert.deepEqual(parseCursor('00042', 42n), { ok: true, value: 42n });
  assert.deepEqual(parseCursor('0000000000000000000000000000000000000000000042', 42n), {
    ok: true,
    value: 42n,
  });
});

test('preserves integers above Number.MAX_SAFE_INTEGER exactly', () => {
  assert.deepEqual(parseCursor('9007199254740992', 9007199254740992n), {
    ok: true,
    value: 9007199254740992n,
  });
  assert.deepEqual(parseCursor('9007199254740993', 9007199254740993n), {
    ok: true,
    value: 9007199254740993n,
  });
  assert.deepEqual(parseCursor('123456789012345678901234567890', 123456789012345678901234567890n), {
    ok: true,
    value: 123456789012345678901234567890n,
  });
});

test('accepts signed 64-bit boundaries without an int64 cap', () => {
  assert.deepEqual(parseCursor('9223372036854775807', 9223372036854775807n), {
    ok: true,
    value: 9223372036854775807n,
  });
  assert.deepEqual(parseCursor('9223372036854775808', 9223372036854775808n), {
    ok: true,
    value: 9223372036854775808n,
  });
  assert.deepEqual(parseCursor('18446744073709551616', 18446744073709551616n), {
    ok: true,
    value: 18446744073709551616n,
  });
});

test('reports values beyond the established upper bound distinctly', () => {
  assert.deepEqual(parseCursor('1', 0n), { ok: false, reason: 'beyond-upper-bound' });
  assert.deepEqual(parseCursor('42', 41n), { ok: false, reason: 'beyond-upper-bound' });
  assert.deepEqual(parseCursor('00042', 41n), { ok: false, reason: 'beyond-upper-bound' });
  assert.deepEqual(parseCursor('9007199254740993', 9007199254740992n), {
    ok: false,
    reason: 'beyond-upper-bound',
  });
  assert.deepEqual(parseCursor('9223372036854775808', 9223372036854775807n), {
    ok: false,
    reason: 'beyond-upper-bound',
  });
});

test('rejects non-string wire values as malformed', () => {
  const values: unknown[] = [
    null,
    undefined,
    0,
    42,
    Number.NaN,
    1n,
    true,
    false,
    {},
    [],
    ['1'],
    new String('1'),
    () => '1',
    Symbol('1'),
  ];

  for (const value of values) {
    assert.deepEqual(parseCursor(value, 42n), { ok: false, reason: 'malformed' });
  }
});

test('rejects non-decimal string forms as malformed', () => {
  const values = [
    '',
    ' ',
    ' 1',
    '1 ',
    '\t1',
    '1\t',
    '-1',
    '-0',
    '+1',
    '+0',
    '1.0',
    '.5',
    '1.',
    '1e3',
    '1E3',
    '0x10',
    '0X1f',
    '0b101',
    '0o7',
    '1_000',
    '1,000',
    'Infinity',
    'NaN',
    'null',
    'undefined',
    '١٢',
    '１２',
    '१२',
    '1٢',
    '\u00a01',
    '1\u00a0',
    '1\u2028',
    '1\u2029',
  ];

  for (const value of values) {
    assert.deepEqual(parseCursor(value, 42n), { ok: false, reason: 'malformed' });
  }
});

test('rejects control characters including trailing newlines and carriage returns', () => {
  const values = [
    '\n',
    '\r',
    '1\n',
    '1\n\n',
    '1\r\n',
    '\n1',
    '\r1',
    '1\r',
    '1\u0000',
    '\u00000',
    '0\u001f',
    '\u007f0',
    '1 2',
  ];

  for (const value of values) {
    assert.deepEqual(parseCursor(value, 42n), { ok: false, reason: 'malformed' });
  }
});

test('throws TypeError for non-bigint bounds and RangeError for negative bounds', () => {
  const invalidBounds: Array<[unknown, typeof TypeError | typeof RangeError]> = [
    [-1n, RangeError],
    [1, TypeError],
    [-1, TypeError],
    [1.5, TypeError],
    ['1', TypeError],
    [null, TypeError],
    [undefined, TypeError],
    [true, TypeError],
    [{}, TypeError],
    [[1n], TypeError],
  ];

  for (const [upperBound, expectedError] of invalidBounds) {
    assert.throws(() => parseCursor('1', upperBound as bigint), expectedError);
  }
});

test('validates programmer bounds before inspecting cursor input', () => {
  assert.throws(() => parseCursor('not-a-cursor', -1n), RangeError);
  assert.throws(() => parseCursor('not-a-cursor', '41' as unknown as bigint), TypeError);
});
