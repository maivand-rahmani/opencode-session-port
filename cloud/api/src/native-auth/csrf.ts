/**
 * Stateless browser CSRF for native-auth browser routes.
 *
 * The token is an HMAC-SHA256 of a fixed versioned domain plus a length-prefixed
 * authoritative BetterAuth session ID. It is not bound to a raw cookie. Callers
 * must first read the session through the cookie-only authoritative session
 * reader, then issue the token to the browser. Cookie/session expiry therefore
 * controls token usefulness; rotating the single configured key invalidates all
 * outstanding tokens with no overlap window.
 *
 * Mutations are accepted only from the single `x-sessionport-csrf` header on a
 * POST request. Token values in URLs, query strings, or body fields are never
 * read. Origin is read from Node's raw header pairs, not collapsed header
 * values, and must equal the configured canonical origin exactly.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const CSRF_HEADER_NAME = 'x-sessionport-csrf';
export const CSRF_TOKEN_LENGTH = 43;
export const CSRF_KEY_MIN_BYTES = 32;

const CSRF_KEY_MAX_BYTES = 4096;
const CSRF_SESSION_MAX_BYTES = 1024;
const CSRF_DOMAIN = 'sessionport.native-browser-csrf\0v1\0';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_ORIGIN_LENGTH = 2048;
const MAX_CONTENT_TYPE_LENGTH = 256;

export type CsrfErrorCode =
  | 'csrf-key-invalid'
  | 'csrf-session-invalid'
  | 'csrf-origin-invalid'
  | 'csrf-content-type-invalid'
  | 'csrf-token-invalid'
  | 'csrf-request-invalid';

const CSRF_ERROR_MESSAGES: Readonly<Record<CsrfErrorCode, string>> =
  Object.freeze({
    'csrf-key-invalid': 'CSRF key is invalid.',
    'csrf-session-invalid': 'Browser session identifier is invalid.',
    'csrf-origin-invalid': 'Browser request origin is invalid.',
    'csrf-content-type-invalid':
      'Browser request content type is invalid.',
    'csrf-token-invalid': 'CSRF token is invalid.',
    'csrf-request-invalid': 'Browser mutation request is invalid.',
  });

export class CsrfError extends Error {
  readonly code: CsrfErrorCode;

  constructor(code: CsrfErrorCode) {
    super(CSRF_ERROR_MESSAGES[code]);
    this.name = 'CsrfError';
    this.code = code;
  }
}

/**
 * The minimum request shape needed for browser mutation validation. Only
 * `method` and Node's `rawHeaders` pairs are consulted. URL, body, parsed
 * header maps, and forwarded headers are intentionally absent.
 */
export interface BrowserMutationRequest {
  readonly method: string;
  readonly rawHeaders: readonly string[];
}

export interface BrowserMutationExpectation {
  readonly publicOrigin: string;
  readonly sessionID: string;
  readonly csrfKey: Uint8Array;
}

/**
 * Issue a canonical 43-character base64url token for an authoritative session.
 *
 * This function cannot itself prove that the session was authoritative; route
 * code must call the cookie-only session authority first and must not issue a
 * token for a missing, expired, or unavailable session.
 */
export function issueCsrfToken(
  csrfKey: Uint8Array,
  sessionID: string,
): string {
  const key = readCsrfKey(csrfKey);
  const sessionBytes = readSessionBytes(sessionID);

  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(sessionBytes.length, 0);

  return createHmac('sha256', key)
    .update(CSRF_DOMAIN, 'ascii')
    .update(lengthPrefix)
    .update(sessionBytes)
    .digest()
    .toString('base64url');
}

/**
 * Validate a token against the current key and authoritative session ID.
 *
 * The token must be canonical: 43 base64url characters decoding to exactly 32
 * bytes with no non-zero trailing bits. Comparison uses `timingSafeEqual`.
 */
export function assertCsrfToken(
  csrfKey: Uint8Array,
  sessionID: string,
  token: string,
): void {
  const expected = Buffer.from(
    issueCsrfToken(csrfKey, sessionID),
    'base64url',
  );
  const supplied = decodeCsrfToken(token);
  if (!timingSafeEqual(expected, supplied)) {
    fail('csrf-token-invalid');
  }
}

/**
 * Validate the complete native browser mutation boundary:
 *
 * - exactly one Origin raw-header pair, equal to the canonical configured origin;
 * - exactly one JSON Content-Type, with only an optional UTF-8 charset;
 * - exactly one canonical CSRF header value valid for this session.
 *
 * This helper is for state-changing POSTs and the read-only human-code lookup
 * POST. Do not invent a CSRF gate for safe GET pages; GET handlers only require
 * an authoritative session.
 */
export function assertBrowserMutation(
  request: BrowserMutationRequest,
  expectation: BrowserMutationExpectation,
): void {
  if (
    typeof request !== 'object' ||
    request === null ||
    request.method !== 'POST'
  ) {
    fail('csrf-request-invalid');
  }

  if (
    typeof expectation !== 'object' ||
    expectation === null ||
    typeof expectation.publicOrigin !== 'string' ||
    !isCanonicalOrigin(expectation.publicOrigin)
  ) {
    fail('csrf-origin-invalid');
  }

  const pairs = readRawHeaderPairs(request.rawHeaders);
  const origin = readExactlyOneHeader(pairs, 'origin', 'csrf-origin-invalid');
  if (origin !== expectation.publicOrigin) {
    fail('csrf-origin-invalid');
  }

  const contentType = readExactlyOneHeader(
    pairs,
    'content-type',
    'csrf-content-type-invalid',
  );
  assertJsonContentType(contentType);

  const token = readExactlyOneHeader(
    pairs,
    CSRF_HEADER_NAME,
    'csrf-token-invalid',
  );
  assertCsrfToken(
    expectation.csrfKey,
    expectation.sessionID,
    token,
  );
}

function readCsrfKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array)) {
    fail('csrf-key-invalid');
  }
  const key = Buffer.from(value);
  if (
    key.length < CSRF_KEY_MIN_BYTES ||
    key.length > CSRF_KEY_MAX_BYTES
  ) {
    fail('csrf-key-invalid');
  }
  return key;
}

function readSessionBytes(sessionID: string): Buffer {
  if (
    typeof sessionID !== 'string' ||
    sessionID.length === 0 ||
    CONTROL_CHARACTERS.test(sessionID)
  ) {
    fail('csrf-session-invalid');
  }

  const bytes = Buffer.from(sessionID, 'utf8');
  if (
    bytes.length === 0 ||
    bytes.length > CSRF_SESSION_MAX_BYTES ||
    bytes.toString('utf8') !== sessionID
  ) {
    fail('csrf-session-invalid');
  }
  return bytes;
}

function decodeCsrfToken(token: string): Buffer {
  if (
    typeof token !== 'string' ||
    token.length !== CSRF_TOKEN_LENGTH ||
    !BASE64URL_PATTERN.test(token)
  ) {
    fail('csrf-token-invalid');
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(token, 'base64url');
  } catch {
    fail('csrf-token-invalid');
  }

  if (
    decoded.length !== 32 ||
    decoded.toString('base64url') !== token
  ) {
    fail('csrf-token-invalid');
  }
  return decoded;
}

function readRawHeaderPairs(
  rawHeaders: readonly string[],
): ReadonlyArray<readonly [string, string]> {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    fail('csrf-request-invalid');
  }

  const pairs: Array<readonly [string, string]> = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      !HEADER_NAME_PATTERN.test(name) ||
      typeof value !== 'string'
    ) {
      fail('csrf-request-invalid');
    }
    pairs.push([name.toLowerCase(), value]);
  }
  return pairs;
}

function readExactlyOneHeader(
  pairs: ReadonlyArray<readonly [string, string]>,
  name: string,
  failure: CsrfErrorCode,
): string {
  let found: string | undefined;
  for (const [headerName, headerValue] of pairs) {
    if (headerName !== name) continue;
    if (found !== undefined) {
      fail(failure);
    }
    found = headerValue;
  }
  if (found === undefined) {
    fail(failure);
  }
  return found;
}

function assertJsonContentType(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_CONTENT_TYPE_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    fail('csrf-content-type-invalid');
  }

  const parts = value.split(';');
  if (parts.length > 2) {
    fail('csrf-content-type-invalid');
  }
  if (parts[0].toLowerCase() !== 'application/json') {
    fail('csrf-content-type-invalid');
  }

  if (parts.length === 2) {
    const parameter = parts[1].trim();
    if (!/^charset\s*=\s*(?:"utf-8"|utf-8)$/i.test(parameter)) {
      fail('csrf-content-type-invalid');
    }
  }
}

function isCanonicalOrigin(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_ORIGIN_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
    parsed.origin === value &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.pathname === '/'
  );
}

function fail(code: CsrfErrorCode): never {
  throw new CsrfError(code);
}
