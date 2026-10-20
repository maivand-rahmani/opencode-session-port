import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';

import { toApiErrorResponse } from '../../src/errors.js';
import type { BrowserSessionAuthority } from '../../src/native-auth/browser.js';
import {
  registerBrowserAuthRoutes,
  type BrowserAuthBridgeOptions,
} from '../../src/runtime/browser-routes.js';

const ORIGIN = 'https://api.example.test';
const MAX_RESPONSE = 1_024;

class FakeAuthority implements BrowserSessionAuthority {
  readonly calls: Request[] = [];
  response: Response | (() => Response) = new Response('{}', { status: 200 });

  async readSession(): Promise<null> {
    return null;
  }

  async handle(request: Request): Promise<Response> {
    this.calls.push(request);
    return typeof this.response === 'function'
      ? this.response()
      : this.response;
  }
}

function makeApp(
  t: TestContext,
  options: Partial<BrowserAuthBridgeOptions> = {},
): { app: FastifyInstance; authority: FakeAuthority } {
  const authority = new FakeAuthority();
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });
  app.setErrorHandler((error, request, reply) => {
    const mapped = toApiErrorResponse(error, request.id);
    void reply.code(mapped.statusCode).send(mapped.envelope);
  });
  registerBrowserAuthRoutes(app, {
    authority,
    canonicalOrigin: ORIGIN,
    maxResponseBytes: MAX_RESPONSE,
    ...options,
  });
  t.after(async () => {
    await app.close();
  });
  return { app, authority };
}

function errorBody(body: string): {
  error: { code: string; message: string; retryable: boolean; requestID: string };
} {
  return JSON.parse(body);
}

test('get-session reduces the vendor session to a public user and preserves multiple Set-Cookie values', async (t) => {
  const { app, authority } = makeApp(t);
  authority.response = new Response(
    JSON.stringify({
      session: { id: 's1', token: 'raw-session-token' },
      user: {
        id: 'user-1',
        name: 'User',
        email: 'user@example.test',
        image: null,
        emailVerified: true,
        rawSecret: 'must-not-leak',
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
  authority.response.headers.append(
    'set-cookie',
    'session=abc; Path=/; HttpOnly; SameSite=Lax',
  );
  authority.response.headers.append(
    'set-cookie',
    'theme=dark; Path=/; SameSite=Lax',
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/get-session',
    headers: {
      cookie: 'session=abc',
      accept: 'application/json',
      host: 'evil.example.test',
      'x-forwarded-host': 'evil.example.test',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    user: {
      id: 'user-1',
      name: 'User',
      email: 'user@example.test',
      image: null,
      emailVerified: true,
    },
  });
  assert.ok(!response.body.includes('raw-session-token'));
  assert.ok(!response.body.includes('must-not-leak'));
  const cookies = response.headers['set-cookie'];
  assert.ok(Array.isArray(cookies), String(cookies));
  assert.equal(cookies.length, 2);
  assert.ok(cookies[0]?.includes('session=abc'));
  assert.ok(cookies[1]?.includes('theme=dark'));

  assert.equal(authority.calls.length, 1);
  const forwarded = authority.calls[0]!;
  assert.equal(
    forwarded.url,
    'https://api.example.test/api/auth/get-session',
  );
  assert.equal(forwarded.method, 'GET');
  assert.equal(forwarded.headers.get('cookie'), 'session=abc');
  assert.equal(forwarded.headers.get('authorization'), null);
  assert.equal(forwarded.headers.get('x-forwarded-host'), null);
});

test('Authorization is rejected before the browser authority is called', async (t) => {
  const { app, authority } = makeApp(t);
  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/get-session',
    headers: {
      authorization: 'Bearer synthetic',
      cookie: 'session=abc',
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(errorBody(response.body).error.code, 'unauthenticated');
  assert.equal(authority.calls.length, 0);
});

test('callback query is allowlisted and redirects stay on the configured origin', async (t) => {
  const { app, authority } = makeApp(t);
  authority.response = new Response(null, {
    status: 302,
    headers: [
      ['location', `${ORIGIN}/device?linked=1`],
      ['set-cookie', 'session=new; Path=/; HttpOnly; SameSite=Lax'],
    ],
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/callback/github?code=abc&state=xyz',
  });

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, `${ORIGIN}/device?linked=1`);
  assert.ok(
    String(response.headers['set-cookie']).includes('session=new'),
  );
  assert.equal(authority.calls.length, 1);
  assert.equal(
    authority.calls[0]?.url,
    'https://api.example.test/api/auth/callback/github?code=abc&state=xyz',
  );

  const unknown = await app.inject({
    method: 'GET',
    url: '/api/auth/callback/github?code=abc&unexpected=1',
  });
  assert.equal(unknown.statusCode, 400);
  assert.equal(errorBody(unknown.body).error.code, 'invalid-request');
  assert.equal(authority.calls.length, 1);
});

test('callback rejects an external redirect location without forwarding it', async (t) => {
  const { app, authority } = makeApp(t);
  authority.response = new Response(null, {
    status: 302,
    headers: { location: 'https://evil.example.test/steal' },
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/callback/github?code=abc',
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers.location, undefined);
  assert.equal(errorBody(response.body).error.code, 'unavailable');
  assert.ok(!response.body.includes('evil.example.test'));
});

test('sign-in social requires the configured Origin and a GitHub-only body', async (t) => {
  const { app, authority } = makeApp(t);

  for (const request of [
    {
      headers: {},
      payload: { provider: 'github' },
    },
    {
      headers: { origin: 'https://evil.example.test' },
      payload: { provider: 'github' },
    },
    {
      headers: { origin: ORIGIN },
      payload: { provider: 'google' },
    },
    {
      headers: { origin: ORIGIN },
      payload: { provider: 'github', identity: { userID: 'forged' } },
    },
    {
      headers: { origin: ORIGIN },
      payload: { provider: 'github', callbackURL: 'https://evil.example.test/cb' },
    },
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: { 'content-type': 'application/json', ...request.headers },
      payload: request.payload,
    });
    assert.ok(
      response.statusCode === 400 || response.statusCode === 403,
      `${response.statusCode} ${response.body}`,
    );
  }
  assert.equal(authority.calls.length, 0);

  authority.response = new Response(
    JSON.stringify({
      url: 'https://github.com/login/oauth/authorize?client_id=abc',
      redirect: true,
      secret: 'must-not-leak',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  const success = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    payload: { provider: 'github' },
  });
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.json(), {
    redirectURL: 'https://github.com/login/oauth/authorize?client_id=abc',
  });
  assert.ok(!success.body.includes('must-not-leak'));
  assert.equal(authority.calls.length, 1);
  assert.equal(
    authority.calls[0]?.url,
    'https://api.example.test/api/auth/sign-in/social',
  );
  assert.equal(authority.calls[0]?.headers.get('origin'), ORIGIN);
  assert.equal(
    await authority.calls[0]?.text(),
    JSON.stringify({
      provider: 'github',
      callbackURL: `${ORIGIN}/device`,
    }),
  );
});

test('sign-in rejects a non-GitHub authorization URL', async (t) => {
  const { app, authority } = makeApp(t);
  authority.response = new Response(
    JSON.stringify({ url: 'https://evil.example.test/login' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    payload: { provider: 'github' },
  });
  assert.equal(response.statusCode, 503);
  assert.ok(!response.body.includes('evil.example.test'));
});

test('sign-out requires Origin, bounds the body, and preserves clearing cookies', async (t) => {
  const { app, authority } = makeApp(t);
  authority.response = new Response('{' + 'x'.repeat(MAX_RESPONSE) + '}', {
    status: 200,
    headers: [
      ['set-cookie', 'session=; Max-Age=0; Path=/; HttpOnly'],
      ['set-cookie', 'theme=; Max-Age=0; Path=/'],
    ],
  });

  const missingOrigin = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    headers: { 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(missingOrigin.statusCode, 403);
  assert.equal(authority.calls.length, 0);

  const oversized = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(oversized.statusCode, 503);
  assert.equal(errorBody(oversized.body).error.code, 'unavailable');

  authority.response = new Response('{}', {
    status: 200,
    headers: [
      ['set-cookie', 'session=; Max-Age=0; Path=/; HttpOnly'],
      ['set-cookie', 'theme=; Max-Age=0; Path=/'],
    ],
  });
  const success = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.json(), {});
  const cookies = success.headers['set-cookie'];
  assert.ok(Array.isArray(cookies));
  assert.equal(cookies.length, 2);
});

test('vendor error bodies are sanitised while clearing cookies are kept', async (t) => {
  const secret = 'vendor-client-secret';
  const { app, authority } = makeApp(t);
  authority.response = new Response(
    JSON.stringify({ error: 'invalid', clientSecret: secret }),
    {
      status: 500,
      headers: [
        ['content-type', 'application/json'],
        ['set-cookie', 'session=; Max-Age=0; Path=/'],
      ],
    },
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/get-session',
  });
  assert.equal(response.statusCode, 503);
  assert.equal(errorBody(response.body).error.code, 'unavailable');
  assert.ok(!response.body.includes(secret));
  assert.ok(String(response.headers['set-cookie']).includes('Max-Age=0'));
});

test('POST origin is checked before malformed or oversized body parsing', async (t) => {
  const { app, authority } = makeApp(t);

  const malformed = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: { origin: 'https://evil.example.test', 'content-type': 'application/json' },
    payload: '{"provider":',
  });
  assert.equal(malformed.statusCode, 403);
  assert.equal(errorBody(malformed.body).error.code, 'forbidden');

  const oversized = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: { origin: 'https://evil.example.test', 'content-type': 'application/json' },
    payload: 'x'.repeat(MAX_RESPONSE + 1),
  });
  assert.equal(oversized.statusCode, 403);
  assert.equal(authority.calls.length, 0);
});
