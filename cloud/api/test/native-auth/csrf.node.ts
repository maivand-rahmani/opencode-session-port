import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertBrowserMutation,
  assertCsrfToken,
  CSRF_HEADER_NAME,
  CSRF_KEY_MIN_BYTES,
  CSRF_TOKEN_LENGTH,
  CsrfError,
  issueCsrfToken,
} from '../../src/native-auth/csrf.js';
import type {
  BrowserMutationExpectation,
  BrowserMutationRequest,
  CsrfErrorCode,
} from '../../src/native-auth/csrf.js';

const KEY = Buffer.alloc(32, 0x22);
const OTHER_KEY = Buffer.alloc(32, 0x44);
const ORIGIN = 'https://api.example.test';
const SESSION_ID = 'session_synthetic_01';
const TOKEN = 'YKA3tkguxVpt_eol06LHfJWS2b7TrjgicUttJNK5OBE';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function expectation(
  overrides: Partial<BrowserMutationExpectation> = {},
): BrowserMutationExpectation {
  return {
    publicOrigin: ORIGIN,
    sessionID: SESSION_ID,
    csrfKey: KEY,
    ...overrides,
  };
}

function mutation(
  overrides: Partial<BrowserMutationRequest> = {},
): BrowserMutationRequest {
  return {
    method: 'POST',
    rawHeaders: [
      'Host',
      'api.example.test',
      'Origin',
      ORIGIN,
      'Content-Type',
      'application/json',
      CSRF_HEADER_NAME,
      TOKEN,
    ],
    ...overrides,
  };
}

function assertCsrfError(code: CsrfErrorCode, message: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof CsrfError);
    assert.equal(error.name, 'CsrfError');
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
    return true;
  };
}

const KEY_INVALID = assertCsrfError(
  'csrf-key-invalid',
  'CSRF key is invalid.',
);
const SESSION_INVALID = assertCsrfError(
  'csrf-session-invalid',
  'Browser session identifier is invalid.',
);
const ORIGIN_INVALID = assertCsrfError(
  'csrf-origin-invalid',
  'Browser request origin is invalid.',
);
const CONTENT_TYPE_INVALID = assertCsrfError(
  'csrf-content-type-invalid',
  'Browser request content type is invalid.',
);
const TOKEN_INVALID = assertCsrfError(
  'csrf-token-invalid',
  'CSRF token is invalid.',
);
const REQUEST_INVALID = assertCsrfError(
  'csrf-request-invalid',
  'Browser mutation request is invalid.',
);

test('issues an independently computed canonical session-bound token', () => {
  const token = issueCsrfToken(KEY, SESSION_ID);

  assert.equal(token, TOKEN);
  assert.equal(token.length, CSRF_TOKEN_LENGTH);
  assert.match(token, TOKEN_PATTERN);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(
    Buffer.from(token, 'base64url').toString('base64url'),
    token,
  );
  assert.equal(issueCsrfToken(KEY, SESSION_ID), token);
  assert.notEqual(issueCsrfToken(KEY, `${SESSION_ID}_other`), token);
  assert.notEqual(issueCsrfToken(OTHER_KEY, SESSION_ID), token);
  assert.doesNotThrow(() => assertCsrfToken(KEY, SESSION_ID, token));
});

test('rejects malformed, noncanonical, and cross-session tokens', () => {
  const valid = issueCsrfToken(KEY, SESSION_ID);
  const noncanonical = `${valid.slice(0, -1)}F`;
  assert.equal(noncanonical.length, 43);
  assert.equal(
    Buffer.from(noncanonical, 'base64url').toString('base64url') ===
      noncanonical,
    false,
  );

  const invalidTokens = [
    '',
    valid.slice(0, 42),
    `${valid}A`,
    `${valid}=`,
    `${valid}==`,
    `${valid.slice(0, 21)}+${valid.slice(22)}`,
    `${valid.slice(0, 21)}/${valid.slice(22)}`,
    `${valid.slice(0, 21)}.${valid.slice(22)}`,
    noncanonical,
    issueCsrfToken(KEY, `${SESSION_ID}_other`),
    ` ${valid}`,
    `${valid} `,
  ];

  for (const token of invalidTokens) {
    assert.throws(
      () => assertCsrfToken(KEY, SESSION_ID, token),
      TOKEN_INVALID,
    );
  }

  for (const token of [
    null,
    undefined,
    0,
    32n,
    {},
    [],
    new String(valid),
  ] as unknown[]) {
    assert.throws(
      () => assertCsrfToken(KEY, SESSION_ID, token as string),
      TOKEN_INVALID,
    );
  }
});

test('key rotation invalidates outstanding tokens with no overlap', () => {
  const oldToken = issueCsrfToken(KEY, SESSION_ID);
  assert.doesNotThrow(() => assertCsrfToken(KEY, SESSION_ID, oldToken));
  assert.throws(
    () => assertCsrfToken(OTHER_KEY, SESSION_ID, oldToken),
    TOKEN_INVALID,
  );
});

test('rejects invalid CSRF keys and authoritative session identifiers', () => {
  for (const key of [
    Buffer.alloc(CSRF_KEY_MIN_BYTES - 1),
    Buffer.alloc(0),
    new Uint8Array(16),
    'not-bytes',
    null,
    undefined,
  ] as unknown[]) {
    assert.throws(
      () => issueCsrfToken(key as Uint8Array, SESSION_ID),
      KEY_INVALID,
    );
  }

  const invalidSessions = [
    '',
    '\u0000',
    'session\nheader',
    'session\tvalue',
    'x'.repeat(1025),
    '\ud800',
    null,
    undefined,
    0,
    {},
  ];

  for (const session of invalidSessions) {
    assert.throws(
      () => issueCsrfToken(KEY, session as string),
      SESSION_INVALID,
    );
  }
});

test('requires exactly one exact canonical Origin from raw headers', () => {
  assert.doesNotThrow(() => assertBrowserMutation(mutation(), expectation()));

  const acceptedHeaderNames = mutation({
    rawHeaders: [
      'oRiGiN',
      ORIGIN,
      'Content-Type',
      'application/json',
      'X-SessionPort-CSRF',
      TOKEN,
    ],
  });
  assert.doesNotThrow(() =>
    assertBrowserMutation(acceptedHeaderNames, expectation()),
  );

  const invalidOrigins = [
    undefined,
    '',
    'null',
    'https://api.example.test/',
    'HTTPS://API.EXAMPLE.TEST',
    'http://api.example.test',
    'https://api.example.test:443',
    'https://api.example.test/path',
    'not a url',
    `${ORIGIN}, ${ORIGIN}`,
  ];

  for (const origin of invalidOrigins) {
    const headers = mutation().rawHeaders.filter(
      (_, index) => index === 2 || index === 3 ? false : true,
    );
    const rawHeaders = [...headers];
    if (origin !== undefined) {
      rawHeaders.splice(0, 0, 'Origin', origin);
    }
    assert.throws(
      () => assertBrowserMutation(mutation({ rawHeaders }), expectation()),
      ORIGIN_INVALID,
    );
  }

  const duplicateOrigin = mutation({
    rawHeaders: [
      'Origin',
      ORIGIN,
      'Origin',
      ORIGIN,
      'Content-Type',
      'application/json',
      CSRF_HEADER_NAME,
      TOKEN,
    ],
  });
  assert.throws(
    () => assertBrowserMutation(duplicateOrigin, expectation()),
    ORIGIN_INVALID,
  );
});

test('does not read collapsed headers, URL, or body origin values', () => {
  const collapsedOnly = {
    method: 'POST',
    rawHeaders: [
      'Content-Type',
      'application/json',
      CSRF_HEADER_NAME,
      TOKEN,
    ],
    headers: { origin: ORIGIN },
    url: ORIGIN,
    body: { origin: ORIGIN, csrf: TOKEN },
  } as BrowserMutationRequest;
  assert.throws(
    () => assertBrowserMutation(collapsedOnly, expectation()),
    ORIGIN_INVALID,
  );

  const bodyOnlyToken = {
    ...mutation(),
    rawHeaders: [
      'Origin',
      ORIGIN,
      'Content-Type',
      'application/json',
    ],
    body: { csrf: TOKEN },
    url: `/?csrf=${TOKEN}`,
  } as BrowserMutationRequest;
  assert.throws(
    () => assertBrowserMutation(bodyOnlyToken, expectation()),
    TOKEN_INVALID,
  );
});

test('accepts plain and UTF-8 JSON content types only', () => {
  const accepted = [
    'application/json',
    'APPLICATION/JSON',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json;  charset = "utf-8"',
  ];

  for (const contentType of accepted) {
    const request = mutation({
      rawHeaders: [
        'Origin',
        ORIGIN,
        'Content-Type',
        contentType,
        CSRF_HEADER_NAME,
        TOKEN,
      ],
    });
    assert.doesNotThrow(() =>
      assertBrowserMutation(request, expectation()),
    );
  }

  const rejected = [
    '',
    'text/plain',
    'text/json',
    'application/problem+json',
    'application/json; charset=utf8',
    'application/json; charset=utf-16',
    'application/json; boundary=x',
    'application/json; charset=utf-8; boundary=x',
    'application/json, application/json',
    ' application/json',
    'application/json ',
    'application/json\n',
    'application/json; charset=utf-8\u0000',
    `application/json; charset=${'x'.repeat(300)}`,
  ];

  for (const contentType of rejected) {
    const request = mutation({
      rawHeaders: [
        'Origin',
        ORIGIN,
        'Content-Type',
        contentType,
        CSRF_HEADER_NAME,
        TOKEN,
      ],
    });
    assert.throws(
      () => assertBrowserMutation(request, expectation()),
      CONTENT_TYPE_INVALID,
    );
  }

  const duplicate = mutation({
    rawHeaders: [
      'Origin',
      ORIGIN,
      'Content-Type',
      'application/json',
      'content-type',
      'application/json',
      CSRF_HEADER_NAME,
      TOKEN,
    ],
  });
  assert.throws(
    () => assertBrowserMutation(duplicate, expectation()),
    CONTENT_TYPE_INVALID,
  );
});

test('requires exactly one canonical CSRF header on POST mutations', () => {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'post', '']) {
    assert.throws(
      () => assertBrowserMutation(mutation({ method }), expectation()),
      REQUEST_INVALID,
    );
  }

  const missing = mutation({
    rawHeaders: [
      'Origin',
      ORIGIN,
      'Content-Type',
      'application/json',
    ],
  });
  assert.throws(
    () => assertBrowserMutation(missing, expectation()),
    TOKEN_INVALID,
  );

  const duplicate = mutation({
    rawHeaders: [
      'Origin',
      ORIGIN,
      'Content-Type',
      'application/json',
      CSRF_HEADER_NAME,
      TOKEN,
      'x-sessionport-csrf',
      TOKEN,
    ],
  });
  assert.throws(
    () => assertBrowserMutation(duplicate, expectation()),
    TOKEN_INVALID,
  );

  const malformedRawHeaders = [
    mutation({ rawHeaders: ['Origin', ORIGIN, 'Content-Type'] }),
    mutation({ rawHeaders: ['Origin', 1 as unknown as string] }),
    mutation({ rawHeaders: ['bad header', ORIGIN] }),
    mutation({ rawHeaders: [null as unknown as string, ORIGIN] }),
  ];

  for (const request of malformedRawHeaders) {
    assert.throws(
      () => assertBrowserMutation(request, expectation()),
      REQUEST_INVALID,
    );
  }
});

test('rejects malformed origin expectations before reading requests', () => {
  for (const publicOrigin of [
    '',
    'not a url',
    'https://api.example.test/',
    'https://api.example.test/path',
    'ftp://api.example.test',
    null,
    undefined,
  ] as unknown[]) {
    assert.throws(
      () =>
        assertBrowserMutation(
          mutation(),
          expectation({ publicOrigin: publicOrigin as string }),
        ),
      ORIGIN_INVALID,
    );
  }
});

test('fixed errors do not echo origins, tokens, session IDs, or key material', () => {
  const secretOrigin = `https://${'origin-secret-7c2d'}.example.test`;
  const secretToken = 'token-secret-4fe1';
  const secretSession = 'session-secret-88ab';
  const requests = [
    mutation({
      rawHeaders: [
        'Origin',
        secretOrigin,
        'Content-Type',
        'application/json',
        CSRF_HEADER_NAME,
        TOKEN,
      ],
    }),
    mutation({
      rawHeaders: [
        'Origin',
        ORIGIN,
        'Content-Type',
        'application/json',
        CSRF_HEADER_NAME,
        secretToken,
      ],
    }),
  ];

  for (const request of requests) {
    assert.throws(
      () => assertBrowserMutation(request, expectation()),
      (error: unknown) => {
        assert.ok(error instanceof CsrfError);
        const rendered = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
        for (const secret of [
          secretOrigin,
          secretToken,
          secretSession,
          KEY.toString('base64'),
          KEY.toString('hex'),
        ]) {
          assert.equal(rendered.includes(secret), false);
        }
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }

  assert.throws(
    () =>
      assertBrowserMutation(
        mutation(),
        expectation({ sessionID: secretSession }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof CsrfError);
      const rendered = `${String(error)} ${(error as Error).stack ?? ''}`;
      assert.equal(rendered.includes(secretSession), false);
      return true;
    },
  );
});

test('validates a lower-case session ID through the same HMAC binding', () => {
  const lowerOrigin = 'https://api.example.test';
  const request = mutation({
    rawHeaders: [
      'Origin',
      lowerOrigin,
      'Content-Type',
      'application/json',
      CSRF_HEADER_NAME,
      TOKEN,
    ],
  });
  assert.doesNotThrow(() =>
    assertBrowserMutation(request, expectation({ publicOrigin: lowerOrigin })),
  );
});
