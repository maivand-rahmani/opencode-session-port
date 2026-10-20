import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBearerEnforcement,
  type BearerEnforcementClient,
} from '../../src/native-auth/enforcement.js';

/*
 * Focused per-request bearer enforcement tests against a structural Prisma
 * fake. They prove header strictness, state checks, scope/route policy, and
 * no-cache call behavior. They do NOT prove PostgreSQL reads, grants under
 * concurrency, or any network boundary.
 */

const ORIGIN = 'https://api.example.test';
const USER_ID = 'user_01HTESTVENDOROPAQUE';
const DEVICE_ID = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const GRANT_ID = '7c1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const TOKEN = Buffer.alloc(32, 9).toString('base64url');
const OTHER_TOKEN = Buffer.alloc(32, 10).toString('base64url');

const POLICY = {
  audience: ORIGIN,
  resource: ORIGIN,
  allowedScopes: ['projects:read', 'projects:write'],
  requiredRouteScopes: {
    'projects.create': ['projects:write'],
    'projects.list': ['projects:read'],
  },
} as const;

interface FakeGrant {
  id: string;
  userID: string;
  status: 'active' | 'revoked';
  audience: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
  device: { id: string; userID: string } | null;
}

interface FakeAccessRow {
  grantID: string;
  expiresAt: Date;
  grant: FakeGrant;
}

class FakeClient {
  readonly calls: unknown[] = [];
  row: FakeAccessRow | null = null;
  error: unknown = undefined;

  readonly nativeAccessToken = {
    findUnique: async (args: unknown): Promise<FakeAccessRow | null> => {
      this.calls.push(args);
      if (this.error !== undefined) throw this.error;
      return this.row;
    },
  };
}

function validRow(overrides: Partial<FakeAccessRow> = {}): FakeAccessRow {
  return {
    grantID: GRANT_ID,
    expiresAt: new Date('2026-10-20T12:10:00.000Z'),
    grant: {
      id: GRANT_ID,
      userID: USER_ID,
      status: 'active',
      audience: ORIGIN,
      resource: ORIGIN,
      scopes: ['projects:read', 'projects:write'],
      expiresAt: new Date('2026-10-20T13:00:00.000Z'),
      device: { id: DEVICE_ID, userID: USER_ID },
      ...(overrides.grant ?? {}),
    },
    ...overrides,
  };
}

function enforcement(
  client: FakeClient,
  policy = POLICY,
  now: () => Date = () => NOW,
) {
  return createBearerEnforcement(
    client as unknown as BearerEnforcementClient,
    { policy, now },
  );
}

function bearer(token = TOKEN) {
  return { authorization: `Bearer ${token}` };
}

test('accepts exactly one canonical bearer access token with active grant and device', async () => {
  const client = new FakeClient();
  client.row = validRow();
  const result = await enforcement(client).authorizeBearer(
    bearer(),
    'projects.create',
  );

  assert.deepEqual(result, {
    ok: true,
    principal: {
      kind: 'device',
      userID: USER_ID,
      deviceID: DEVICE_ID,
      grantID: GRANT_ID,
    },
  });
  assert.equal(client.calls.length, 1);
});

test('rejects missing, duplicate, non-bearer, wrong-length, and non-canonical credentials without a cookie fallback', async () => {
  const client = new FakeClient();
  client.row = validRow();
  const auth = enforcement(client);

  const cases: unknown[] = [
    {},
    { cookie: 'session=valid' },
    { authorization: '' },
    { authorization: ['Bearer ' + TOKEN, 'Bearer ' + TOKEN] },
    { authorization: `Basic ${TOKEN}` },
    { authorization: `bearer ${TOKEN}` },
    { authorization: `Bearer ${TOKEN} ` },
    { authorization: `Bearer ${TOKEN.slice(0, 42)}` },
    { authorization: `Bearer ${TOKEN}A` },
    { authorization: `Bearer ${'A'.repeat(42)}B` },
    { authorization: `Bearer ${TOKEN}, Bearer ${TOKEN}` },
  ];

  for (const headers of cases) {
    const result = await auth.authorizeBearer(
      headers as never,
      'projects.create',
    );
    assert.deepEqual(result, {
      ok: false,
      code: 'unauthenticated',
      statusCode: 401,
      message: 'Authentication is required.',
      retryable: false,
    });
  }
  assert.equal(client.calls.length, 0);
});

test('rejects unknown, expired, revoked, expired-grant, missing-device, and mismatched-user state uniformly', async () => {
  const cases: Array<FakeAccessRow | null> = [
    null,
    validRow({ expiresAt: NOW }),
    validRow({ grant: { ...validRow().grant, status: 'revoked' } }),
    validRow({ grant: { ...validRow().grant, expiresAt: NOW } }),
    validRow({ grant: { ...validRow().grant, device: null } }),
    validRow({
      grant: {
        ...validRow().grant,
        device: { id: DEVICE_ID, userID: 'user_othersecretvalue' },
      },
    }),
  ];

  for (const row of cases) {
    const client = new FakeClient();
    client.row = row;
    const result = await enforcement(client).authorizeBearer(
      bearer(),
      'projects.create',
    );
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, 'unauthenticated');
    assert.equal(result.statusCode, 401);
  }
});

test('rejects audience/resource mismatch and scopes outside the server allowlist', async () => {
  const mismatches: Array<Partial<FakeAccessRow['grant']>> = [
    { audience: 'https://other.example.test' },
    { resource: 'https://other.example.test' },
    { scopes: ['projects:read', 'unknown:scope'] },
  ];

  for (const mismatch of mismatches) {
    const client = new FakeClient();
    client.row = validRow({
      grant: { ...validRow().grant, ...mismatch },
    });
    const result = await enforcement(client).authorizeBearer(
      bearer(),
      'projects.create',
    );
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, 'unauthenticated');
    assert.equal(result.statusCode, 401);
  }
});

test('requires the route-specific scope and a configured route ID', async () => {
  const readOnly = new FakeClient();
  readOnly.row = validRow({
    grant: { ...validRow().grant, scopes: ['projects:read'] },
  });
  const forbidden = await enforcement(readOnly).authorizeBearer(
    bearer(),
    'projects.create',
  );
  assert.deepEqual(forbidden, {
    ok: false,
    code: 'forbidden',
    statusCode: 403,
    message: 'The request is not permitted.',
    retryable: false,
  });

  const unknownRoute = await enforcement(readOnly).authorizeBearer(
    bearer(),
    'projects.delete',
  );
  assert.equal(unknownRoute.ok, false);
  if (!unknownRoute.ok) {
    assert.equal(unknownRoute.code, 'forbidden');
    assert.equal(unknownRoute.statusCode, 403);
  }

  const readable = new FakeClient();
  readable.row = validRow();
  const allowed = await enforcement(readable).authorizeBearer(
    bearer(),
    'projects.list',
  );
  assert.equal(allowed.ok, true);
});

test('does not cache and fails closed on clock/database errors', async () => {
  const client = new FakeClient();
  client.row = validRow();
  const auth = enforcement(client);
  assert.equal((await auth.authorizeBearer(bearer(), 'projects.create')).ok, true);
  assert.equal((await auth.authorizeBearer(bearer(), 'projects.create')).ok, true);
  assert.equal(client.calls.length, 2);

  const broken = new FakeClient();
  broken.error = new Error('driver detail for token ' + OTHER_TOKEN);
  const unavailable = await enforcement(broken).authorizeBearer(
    bearer(),
    'projects.create',
  );
  assert.deepEqual(unavailable, {
    ok: false,
    code: 'unavailable',
    statusCode: 503,
    message: 'The service is not ready.',
    retryable: true,
  });
  assert.equal(JSON.stringify(unavailable).includes(OTHER_TOKEN), false);

  const badClock = await enforcement(client, POLICY, () => {
    throw new Error('clock detail');
  }).authorizeBearer(bearer(), 'projects.create');
  assert.equal(badClock.ok, false);
  if (!badClock.ok) assert.equal(badClock.code, 'unavailable');
});
