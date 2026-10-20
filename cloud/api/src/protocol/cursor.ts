export type CursorParseResult =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly reason: 'malformed' | 'beyond-upper-bound' };

function isAsciiDecimalDigits(input: string): boolean {
  if (input.length === 0) {
    return false;
  }

  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit < 0x30 || codeUnit > 0x39) {
      return false;
    }
  }

  return true;
}

/**
 * Parses a stateless revision cursor position.
 *
 * Valid wire cursors are nonempty ASCII decimal digit strings. Leading zeros
 * are accepted; no numeric coercion or additional cursor policy is applied.
 * An out-of-range upper bound is a programmer error, not a wire result.
 */
export function parseCursor(input: unknown, upperBound: bigint): CursorParseResult {
  if (typeof (upperBound as unknown) !== 'bigint') {
    throw new TypeError('upperBound must be a bigint');
  }

  if (upperBound < 0n) {
    throw new RangeError('upperBound must be non-negative');
  }

  if (typeof input !== 'string' || !isAsciiDecimalDigits(input)) {
    return { ok: false, reason: 'malformed' };
  }

  const value = BigInt(input);

  if (value > upperBound) {
    return { ok: false, reason: 'beyond-upper-bound' };
  }

  return { ok: true, value };
}
