/**
 * Native credential generation and fingerprint primitives.
 *
 * A credential is exactly 32 random bytes encoded as unpadded base64url. A
 * fingerprint is SHA-256 over a fixed, kind-separated UTF-8 domain followed by
 * the decoded credential bytes.
 *
 * The credential kind is not encoded in the wire token, and domain separation
 * does not authenticate the kind. Downstream storage must type-check credentials
 * against their intended use. This module returns generated credentials only to
 * its caller; it does not log, persist, or serialize them, and it makes no
 * zeroization or secure-memory claims.
 */

import { createHash, randomBytes } from 'node:crypto';

export type CredentialKind = 'device' | 'access' | 'refresh';

const CREDENTIAL_BYTES = 32;
const CREDENTIAL_LENGTH = 43;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DOMAIN_PREFIX = 'sessionport.native-credential\0v1\0';
const INVALID_MESSAGE = 'Native credential is invalid.';

export class NativeCredentialError extends Error {
  readonly code = 'invalid-native-credential';

  constructor() {
    super(INVALID_MESSAGE);
    this.name = 'NativeCredentialError';
  }
}

/**
 * Generate a raw credential for the caller.
 *
 * Validation of the kind happens before the random source is consulted. A
 * supplied source must be a function that returns exactly 32 bytes as a
 * `Uint8Array` or `Buffer`; failures are replaced by the fixed module error so
 * that raw randomness errors and input details are never exposed.
 */
export function generateCredential(
  kind: CredentialKind,
  randomByteSource: (requestedBytes: number) => Uint8Array = randomBytes,
): string {
  assertCredentialKind(kind);

  if (typeof randomByteSource !== 'function') {
    throw new NativeCredentialError();
  }

  let generated: Uint8Array;
  try {
    generated = randomByteSource(CREDENTIAL_BYTES);
  } catch {
    throw new NativeCredentialError();
  }

  try {
    if (
      !(generated instanceof Uint8Array) ||
      generated.byteLength !== CREDENTIAL_BYTES
    ) {
      throw new NativeCredentialError();
    }

    return Buffer.from(generated).toString('base64url');
  } catch (error) {
    if (error instanceof NativeCredentialError) {
      throw error;
    }
    throw new NativeCredentialError();
  }
}

/**
 * Return the lowercase SHA-256 hex fingerprint of a credential.
 *
 * The token must be exactly 43 unpadded base64url characters that decode to 32
 * bytes and re-encode to the identical input. The fixed domain is selected only
 * from the validated kind.
 */
export function fingerprintCredential(
  kind: CredentialKind,
  token: string,
): string {
  assertCredentialKind(kind);
  const credential = decodeCredential(token);

  return createHash('sha256')
    .update(`${DOMAIN_PREFIX}${kind}\0`, 'utf8')
    .update(credential)
    .digest('hex');
}

function assertCredentialKind(kind: unknown): asserts kind is CredentialKind {
  if (kind !== 'device' && kind !== 'access' && kind !== 'refresh') {
    throw new NativeCredentialError();
  }
}

function decodeCredential(token: string): Buffer {
  if (typeof token !== 'string' || token.length !== CREDENTIAL_LENGTH) {
    throw new NativeCredentialError();
  }
  if (!CREDENTIAL_PATTERN.test(token)) {
    throw new NativeCredentialError();
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(token, 'base64url');
  } catch {
    throw new NativeCredentialError();
  }

  if (
    decoded.length !== CREDENTIAL_BYTES ||
    decoded.toString('base64url') !== token
  ) {
    throw new NativeCredentialError();
  }

  return decoded;
}
