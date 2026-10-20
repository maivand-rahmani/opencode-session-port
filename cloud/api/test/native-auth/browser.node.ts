import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrismaClient } from '../../prisma/generated/client/client.js';
import {
  BROWSER_AUTH_BASE_PATH,
  BrowserAuthError,
  createBrowserAuth,
} from '../../src/native-auth/browser.js';
import type {
  BrowserAuthConfig,
  BrowserAuthProvider,
  BrowserAuthProviderFactory,
  BrowserAuthProviderOptions,
} from '../../src/native-auth/browser.js';

const ORIGIN = 'https://api.example.test';
const BA_SECRET = 'synthetic-browser-better-auth-secret-0123456789';
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const FIXED_MESSAGE = 'Browser authentication is unavailable.';
const FAKE_PRISMA = {} as PrismaClient;

function config(overrides: Partial<BrowserAuthConfig> = {}): BrowserAuthConfig {
  return {
    publicOrigin: ORIGIN,
    betterAuth: {
      secret: BA_SECRET,
      github: {
        clientID: 'synthetic-github-client-id',
        clientSecret: 'synthetic-github-client-secret',
      },
    },
    ...overrides,
  };
}

function sessionValue(overrides: {
  session?: Record<string, unknown>;
  user?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    session: {
      id: 'session_synthetic_01',
      userId: 'user_synthetic_01',
      expiresAt: FUTURE,
      ...overrides.session,
    },
    user: {
      id: 'user_synthetic_01',
      name: 'Synthetic User',
      email: 'synthetic@example.test',
      extraUnsafeField: 'ignored',
      ...overrides.user,
    },
  };
}

function assertBrowserError(error: unknown): boolean {
  assert.ok(error instanceof BrowserAuthError);
  assert.equal(error.name, 'BrowserAuthError');
  assert.equal(error.code, 'browser-auth-unavailable');
  assert.equal(error.message, FIXED_MESSAGE);
  assert.equal(error.cause, undefined);
  return true;
}

interface StubHarness {
  readonly factory: BrowserAuthProviderFactory;
  readonly options: () => BrowserAuthProviderOptions | undefined;
  readonly calls: () => number;
}

function stubProvider(
  getSession: (input: {
    readonly headers: Headers;
    readonly query: {
      readonly disableCookieCache: true;
      readonly disableRefresh: true;
    };
  }) => Promise<unknown>,
  handler?: (request: Request) => Promise<Response>,
): StubHarness {
  let seenOptions: BrowserAuthProviderOptions | undefined;
  let calls = 0;

  const factory: BrowserAuthProviderFactory = (options) => {
    seenOptions = options;
    const provider: BrowserAuthProvider = {
      handler:
        handler ??
        (async () => new Response('ok', { status: 200 })),
      api: {
        getSession: async (input) => {
          calls += 1;
          return getSession(input);
        },
      },
    };
    return provider;
  };

  return {
    factory,
    options: () => seenOptions,
    calls: () => calls,
  };
}

async function createWithStub(
  stub: StubHarness,
  overrides: {
    config?: BrowserAuthConfig;
    now?: () => Date;
  } = {},
) {
  return createBrowserAuth(
    overrides.config ?? config(),
    FAKE_PRISMA,
    {
      providerFactory: stub.factory,
      now: overrides.now ?? (() => FIXED_NOW),
    },
  );
}

test('builds the exact GitHub-only browser provider configuration', async () => {
  const stub = stubProvider(async () => sessionValue());
  const authority = await createWithStub(stub);
  const options = stub.options();

  assert.ok(options);
  assert.equal(options.baseURL, ORIGIN);
  assert.equal(options.basePath, BROWSER_AUTH_BASE_PATH);
  assert.equal(options.basePath, '/api/auth');
  assert.equal(options.secret, BA_SECRET);
  assert.deepEqual(options.trustedOrigins, [ORIGIN]);
  assert.equal(options.database, FAKE_PRISMA);
  assert.deepEqual(Object.keys(options.socialProviders), ['github']);
  assert.equal(
    options.socialProviders.github.clientId,
    'synthetic-github-client-id',
  );
  assert.equal(
    options.socialProviders.github.clientSecret,
    'synthetic-github-client-secret',
  );
  assert.deepEqual(options.plugins, []);
  assert.deepEqual(options.emailAndPassword, { enabled: false });
  assert.deepEqual(options.logger, { disabled: true });
  assert.equal(Object.isFrozen(options), true);
  assert.equal(Object.isFrozen(options.trustedOrigins), true);
  assert.equal(Object.isFrozen(options.plugins), true);
  assert.equal(Object.isFrozen(options.socialProviders), true);
  assert.equal(typeof authority.readSession, 'function');
  assert.equal(typeof authority.handle, 'function');
});

test('reads sessions with a fresh Cookie-only Headers object and cache bypass', async () => {
  let suppliedHeaders: Headers | undefined;
  let suppliedQuery: unknown;
  const stub = stubProvider(async (input) => {
    suppliedHeaders = input.headers;
    suppliedQuery = input.query;
    return sessionValue();
  });

  const authority = await createWithStub(stub);
  const cookie = 'better-auth.session_token=synthetic; theme=dark';
  const session = await authority.readSession(cookie);

  assert.deepEqual(suppliedQuery, {
    disableCookieCache: true,
    disableRefresh: true,
  });
  assert.ok(suppliedHeaders instanceof Headers);
  assert.equal(suppliedHeaders.get('cookie'), cookie);
  assert.equal(suppliedHeaders.get('authorization'), null);
  const suppliedHeaderNames: string[] = [];
  suppliedHeaders.forEach((_value, name) => suppliedHeaderNames.push(name));
  assert.deepEqual(suppliedHeaderNames, ['cookie']);

  assert.ok(session);
  assert.equal(session.sessionID, 'session_synthetic_01');
  assert.equal(session.userID, 'user_synthetic_01');
  assert.equal(session.name, 'Synthetic User');
  assert.equal(session.email, 'synthetic@example.test');
  assert.equal(session.expiresAt.toISOString(), FUTURE.toISOString());
  assert.equal(
    Object.prototype.hasOwnProperty.call(session, 'extraUnsafeField'),
    false,
  );
  assert.equal(Object.isFrozen(session), true);
});

test('keeps a genuinely missing session null and unavailable results distinct', async () => {
  const emptyCookieStub = stubProvider(async () => sessionValue());
  const emptyCookieAuthority = await createWithStub(emptyCookieStub);
  assert.equal(await emptyCookieAuthority.readSession(''), null);
  assert.equal(emptyCookieStub.calls(), 0);

  const nullStub = stubProvider(async () => null);
  const nullAuthority = await createWithStub(nullStub);
  assert.equal(
    await nullAuthority.readSession('better-auth.session_token=missing'),
    null,
  );
  assert.equal(nullStub.calls(), 1);

  const undefinedStub = stubProvider(async () => undefined);
  const undefinedAuthority = await createWithStub(undefinedStub);
  await assert.rejects(
    undefinedAuthority.readSession('better-auth.session_token=missing'),
    assertBrowserError,
  );
});

test('expires sessions against an injected clock and rejects malformed expiry', async () => {
  const expiredStub = stubProvider(async () =>
    sessionValue({
      session: { expiresAt: new Date('2026-01-01T00:00:00.000Z') },
    }),
  );
  const expiredAuthority = await createWithStub(expiredStub);
  assert.equal(
    await expiredAuthority.readSession('better-auth.session_token=expired'),
    null,
  );

  for (const expiresAt of [null, undefined, 'not-a-date', 0, {}]) {
    const stub = stubProvider(async () =>
      sessionValue({ session: { expiresAt } }),
    );
    const authority = await createWithStub(stub);
    await assert.rejects(
      authority.readSession('better-auth.session_token=bad-expiry'),
      assertBrowserError,
    );
  }

  const stringExpiryStub = stubProvider(async () =>
    sessionValue({ session: { expiresAt: FUTURE.toISOString() } }),
  );
  const stringExpiryAuthority = await createWithStub(stringExpiryStub);
  const session = await stringExpiryAuthority.readSession(
    'better-auth.session_token=string-expiry',
  );
  assert.equal(session?.expiresAt.toISOString(), FUTURE.toISOString());
});

test('rejects malformed, mismatched, unavailable, and non-cookie session inputs', async () => {
  const malformedValues: unknown[] = [
    {},
    { session: {}, user: {} },
    { session: { id: 's', expiresAt: FUTURE }, user: { id: 'u' } },
    { session: { id: '', userId: 'u', expiresAt: FUTURE }, user: { id: 'u' } },
    { session: { id: 's', userId: '', expiresAt: FUTURE }, user: { id: '' } },
    {
      session: {
        id: 's',
        userId: 'user-one',
        expiresAt: FUTURE,
      },
      user: { id: 'user-two' },
    },
    sessionValue({ session: { id: 1 } }),
    sessionValue({ session: { userId: 1 } }),
    sessionValue({ user: { id: 1 } }),
    [],
    'session',
  ];

  for (const value of malformedValues) {
    const stub = stubProvider(async () => value);
    const authority = await createWithStub(stub);
    await assert.rejects(
      authority.readSession('better-auth.session_token=cookie'),
      assertBrowserError,
    );
  }

  const stub = stubProvider(async () => sessionValue());
  const authority = await createWithStub(stub);
  await assert.rejects(
    authority.readSession('better-auth.session_token=cookie\r\nX: y'),
    assertBrowserError,
  );
  await assert.rejects(
    authority.readSession(undefined as unknown as string),
    assertBrowserError,
  );

  const invalidClockStub = stubProvider(async () => sessionValue());
  const invalidClockAuthority = await createWithStub(invalidClockStub, {
    now: () => new Date('invalid'),
  });
  await assert.rejects(
    invalidClockAuthority.readSession('better-auth.session_token=cookie'),
    assertBrowserError,
  );
});

test('revocation in the fake authoritative store is observed on every read', async () => {
  const cookie = 'better-auth.session_token=revoked-session';
  const store = new Map<string, unknown>([[cookie, sessionValue()]]);
  let calls = 0;
  const queries: unknown[] = [];

  const stub = stubProvider(async (input) => {
    calls += 1;
    queries.push(input.query);
    return store.get(input.headers.get('cookie') ?? '') ?? null;
  });

  const authority = await createWithStub(stub);
  const first = await authority.readSession(cookie);
  assert.equal(first?.sessionID, 'session_synthetic_01');

  store.delete(cookie);
  const second = await authority.readSession(cookie);
  assert.equal(second, null);
  assert.equal(calls, 2);
  assert.deepEqual(queries, [
    { disableCookieCache: true, disableRefresh: true },
    { disableCookieCache: true, disableRefresh: true },
  ]);
});

test('handler forwards to the actual provider handler and sanitizes failures', async () => {
  const request = new Request(
    'https://api.example.test/api/auth/sign-in/social',
    { method: 'POST' },
  );
  const stub = stubProvider(
    async () => sessionValue(),
    async (received) => {
      assert.equal(received, request);
      return new Response('provider-response', {
        status: 201,
        headers: { 'set-cookie': 'synthetic=1' },
      });
    },
  );

  const authority = await createWithStub(stub);
  const response = await authority.handle(request);
  assert.equal(response.status, 201);
  assert.equal(await response.text(), 'provider-response');
  assert.equal(response.headers.get('set-cookie'), 'synthetic=1');

  const secret = 'raw-better-auth-secret-8871';
  const throwingStub = stubProvider(
    async () => sessionValue(),
    async () => {
      throw new Error(secret);
    },
  );
  const throwingAuthority = await createWithStub(throwingStub);
  await assert.rejects(
    throwingAuthority.handle(request),
    (error: unknown) => {
      assertBrowserError(error);
      const rendered = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
      assert.equal(rendered.includes(secret), false);
      return true;
    },
  );

  const nonResponseStub = stubProvider(
    async () => sessionValue(),
    async () => ({}) as Response,
  );
  const nonResponseAuthority = await createWithStub(nonResponseStub);
  await assert.rejects(
    nonResponseAuthority.handle(request),
    assertBrowserError,
  );
  await assert.rejects(
    throwingAuthority.handle({} as Request),
    assertBrowserError,
  );
});

test('provider failures never expose raw BetterAuth details', async () => {
  const secret = 'raw-better-auth-failure-4491';
  const stub = stubProvider(async () => {
    throw new Error(secret);
  });
  const authority = await createWithStub(stub);

  await assert.rejects(
    authority.readSession('better-auth.session_token=cookie'),
    (error: unknown) => {
      assertBrowserError(error);
      const rendered = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
      assert.equal(rendered.includes(secret), false);
      return true;
    },
  );
});

test('rejects malformed browser configuration and factory injection', async () => {
  const invalidConfigs: unknown[] = [
    config({ publicOrigin: `${ORIGIN}/` }),
    config({ publicOrigin: 'http://api.example.test' }),
    config({ publicOrigin: 'https://api.example.test/path' }),
    {
      publicOrigin: ORIGIN,
      betterAuth: { secret: 'short', github: {} },
    },
    {
      publicOrigin: ORIGIN,
      betterAuth: {
        secret: BA_SECRET,
        github: { clientID: '', clientSecret: 'x' },
      },
    },
    {
      publicOrigin: ORIGIN,
      betterAuth: {
        secret: BA_SECRET,
        github: { clientID: 'x', clientSecret: '' },
      },
    },
  ];

  for (const invalid of invalidConfigs) {
    await assert.rejects(
      createBrowserAuth(invalid as BrowserAuthConfig, FAKE_PRISMA, {
        providerFactory: stubProvider(async () => sessionValue()).factory,
        now: () => FIXED_NOW,
      }),
      assertBrowserError,
    );
  }

  await assert.rejects(
    createBrowserAuth(config(), null as unknown as PrismaClient, {
      providerFactory: stubProvider(async () => sessionValue()).factory,
    }),
    assertBrowserError,
  );

  await assert.rejects(
    createBrowserAuth(config(), FAKE_PRISMA, {
      providerFactory: 'not-a-function' as unknown as BrowserAuthProviderFactory,
    }),
    assertBrowserError,
  );
  await assert.rejects(
    createBrowserAuth(
      config(),
      FAKE_PRISMA,
      null as unknown as Record<string, never>,
    ),
    assertBrowserError,
  );

  const malformedProviders: unknown[] = [
    {},
    { handler: () => new Response(), api: {} },
    { handler: async () => new Response(), api: { getSession: 1 } },
    null,
  ];
  for (const provider of malformedProviders) {
    await assert.rejects(
      createBrowserAuth(config(), FAKE_PRISMA, {
        providerFactory: (() => provider) as unknown as BrowserAuthProviderFactory,
        now: () => FIXED_NOW,
      }),
      assertBrowserError,
    );
  }
});

test('safe optional user fields are bounded and do not fail the session', async () => {
  const stub = stubProvider(async () =>
    sessionValue({
      user: {
        name: 'N'.repeat(257),
        email: 'e'.repeat(321),
        ignored: { secret: 'x' },
      },
    }),
  );
  const authority = await createWithStub(stub);
  const session = await authority.readSession(
    'better-auth.session_token=long-fields',
  );

  assert.ok(session);
  assert.equal(session.name, undefined);
  assert.equal(session.email, undefined);
  assert.deepEqual(Object.keys(session).sort(), [
    'expiresAt',
    'sessionID',
    'userID',
  ]);

  const controlStub = stubProvider(async () =>
    sessionValue({
      user: {
        name: 'Ada\nAdmin',
        email: 'ada@example.test',
      },
    }),
  );
  const controlAuthority = await createWithStub(controlStub);
  const controlSession = await controlAuthority.readSession(
    'better-auth.session_token=control-name',
  );
  assert.equal(controlSession?.name, undefined);
  assert.equal(controlSession?.email, 'ada@example.test');
});
