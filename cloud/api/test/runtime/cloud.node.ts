import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';

import type { ApiConfig } from '../../src/config.js';
import type { BrowserSessionAuthority } from '../../src/native-auth/browser.js';
import type { NativeAuthService } from '../../src/native-auth/service.js';
import {
  RequestAuthorizationError,
  type RequestPrincipal,
} from '../../src/protocol/principal.js';
import type { ProjectRepositoryWithState } from '../../src/projects/repository.js';
import type { ProjectListRepository } from '../../src/projects/routes.js';
import type { RevisionRepository } from '../../src/revisions/repository.js';
import type { MeRepository } from '../../src/me/repository.js';
import {
  createCloudRuntime,
  createRouteAuthorizer,
  type CloudRuntimeDependencies,
  type NativeAuthServiceFactory,
} from '../../src/runtime/cloud.js';
import {
  readRuntimeConfig,
  type CloudRuntimeConfig,
} from '../../src/runtime/config.js';

const API_CONFIG: ApiConfig = {
  host: '127.0.0.1',
  port: 43123,
  publicOrigin: 'https://api.example.test',
  bodyLimitBytes: 1_048_576,
  readinessTimeoutMs: 1_500,
  retryAfterSeconds: 5,
};

const BACKEND_POLICY = {
  maxActiveProjects: 10,
  maxActiveDevices: 3,
  maxCiphertextBytes: 104_857_600,
  maxPageSize: 100,
  maxOutstandingPendingAuthorizationsGlobal: 500,
  maxRateLimitEntries: 10_000,
  maxAuthResponseBytes: 65_536,
} as const;

const NATIVE_POLICY = {
  ttlSeconds: {
    pendingAuthorization: 600,
    accessToken: 3_600,
    refreshToken: 86_400,
    grant: 604_800,
  },
  polling: {
    intervalSeconds: 5,
    backoffIncrementSeconds: 5,
    maxIntervalSeconds: 30,
  },
  rateLimits: Object.fromEntries(
    [
      'createAuthorization',
      'browserVerification',
      'browserLookup',
      'approveAuthorization',
      'denyAuthorization',
      'exchangeDeviceCode',
      'refreshToken',
      'listGrants',
      'revokeGrant',
    ].map((operation) => [
      operation,
      { windowSeconds: 60, maxRequests: 60 },
    ]),
  ),
  capacity: {
    maxOutstandingPendingAuthorizationsPerUser: 10,
    maxActiveGrantsPerUser: 3,
    retentionSeconds: {
      pendingAuthorizationRecords: 86_400,
      spentTokenRecords: 2_592_000,
      revokedGrantRecords: 7_776_000,
    },
  },
  authorization: {
    audience: 'sessionport-api',
    resource: 'sessionport',
    allowedScopes: [
      'projects:read',
      'projects:write',
      'revisions:read',
      'revisions:write',
      'me:read',
    ],
    requiredRouteScopes: {
      'projects.create': ['projects:write'],
      'projects.list': ['projects:read'],
      'revisions.list': ['revisions:read'],
      'revisions.commit': ['revisions:write'],
      'me.read': ['me:read'],
    },
  },
} as const;

function cloudConfig(
  backendOverrides: Readonly<Record<string, unknown>> = {},
): CloudRuntimeConfig {
  const env: NodeJS.ProcessEnv = {
    SESSIONPORT_PUBLIC_ORIGIN: API_CONFIG.publicOrigin,
    SESSIONPORT_NATIVE_ALLOW_LOOPBACK_HTTP: 'false',
    SESSIONPORT_BETTER_AUTH_SECRET: 'a'.repeat(40),
    SESSIONPORT_GITHUB_CLIENT_ID: 'github-client-id',
    SESSIONPORT_GITHUB_CLIENT_SECRET: 'github-client-secret',
    SESSIONPORT_NATIVE_HUMAN_CODE_KEYS_JSON: JSON.stringify([
      { id: 'primary', keyBase64: Buffer.alloc(32, 1).toString('base64') },
    ]),
    SESSIONPORT_NATIVE_HUMAN_CODE_ACTIVE_KEY_ID: 'primary',
    SESSIONPORT_NATIVE_CSRF_KEY_BASE64: Buffer.alloc(32, 2).toString('base64'),
    SESSIONPORT_NATIVE_POLICY_JSON: JSON.stringify(NATIVE_POLICY),
    SESSIONPORT_API_MODE: 'cloud',
    SESSIONPORT_BACKEND_POLICY_JSON: JSON.stringify({
      ...BACKEND_POLICY,
      ...backendOverrides,
    }),
  };
  const config = readRuntimeConfig(env, API_CONFIG);
  if (config.mode !== 'cloud') {
    throw new Error('expected cloud config');
  }
  return config;
}

class FakeBrowserAuthority implements BrowserSessionAuthority {
  readonly session = {
    sessionID: 'session-1',
    userID: 'user-browser',
    expiresAt: new Date('2026-10-21T00:00:00.000Z'),
  };
  handleCalls = 0;

  async readSession(cookie: string) {
    return cookie.includes('session=') ? this.session : null;
  }

  async handle(): Promise<Response> {
    this.handleCalls += 1;
    return new Response('{}', { status: 200 });
  }
}

function fakeRequest(
  headers: Record<string, string | string[]>,
  rawHeaders?: string[],
): FastifyRequest {
  return {
    headers,
    raw: {
      rawHeaders:
        rawHeaders ??
        Object.entries(headers).flatMap(([key, value]) =>
          Array.isArray(value)
            ? value.flatMap((item) => [key, item])
            : [[key, value]].flat(),
        ),
    },
  } as unknown as FastifyRequest;
}

function fakeService(
  result: Awaited<ReturnType<NativeAuthService['authorizeBearer']>>,
) {
  const calls: Array<{ headers: unknown; routeID: string }> = [];
  const service = {
    async authorizeBearer(headers: unknown, routeID: string) {
      calls.push({ headers, routeID });
      return result;
    },
  } as unknown as NativeAuthService;
  return { service, calls };
}

test('createRouteAuthorizer prefers a bearer and never falls back to cookies', async () => {
  const device: RequestPrincipal = {
    kind: 'device',
    userID: 'user-device',
    deviceID: '44aa2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
    grantID: '11111111-1111-4111-8111-111111111111',
  };
  const { service, calls } = fakeService({
    ok: true,
    principal: {
      kind: 'device',
      userID: 'user-device',
      deviceID: '44aa2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
      grantID: '11111111-1111-4111-8111-111111111111',
    },
  });
  const browser = new FakeBrowserAuthority();
  const authorize = createRouteAuthorizer(service, browser);

  const principal = await authorize(
    fakeRequest({
      authorization: 'Bearer valid',
      cookie: 'session=abc',
    }),
    'revisions.list',
  );
  assert.deepEqual(principal, device);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.routeID, 'revisions.list');
});

test('createRouteAuthorizer rejects duplicate Authorization before lookup', async () => {
  const { service, calls } = fakeService({
    ok: false,
    code: 'unauthenticated',
    statusCode: 401,
    message: 'Authentication is required.',
    retryable: false,
  });
  const authorize = createRouteAuthorizer(service, new FakeBrowserAuthority());
  const request = fakeRequest(
    {
      authorization: ['Bearer a', 'Bearer b'],
      cookie: 'session=abc',
    },
    ['authorization', 'Bearer a', 'authorization', 'Bearer b'],
  );

  await assert.rejects(
    authorize(request, 'projects.create'),
    (error: unknown) => {
      assert.ok(error instanceof RequestAuthorizationError);
      assert.equal(error.code, 'unauthenticated');
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('createRouteAuthorizer preserves native forbidden/unavailable failures and invalid bearer', async () => {
  const forbidden = fakeService({
    ok: false,
    code: 'forbidden',
    statusCode: 403,
    message: 'The request is not permitted.',
    retryable: false,
  });
  const forbiddenAuthorize = createRouteAuthorizer(
    forbidden.service,
    new FakeBrowserAuthority(),
  );
  await assert.rejects(
    forbiddenAuthorize(
      fakeRequest({ authorization: 'Bearer valid', cookie: 'session=abc' }),
      'revisions.commit',
    ),
    (error: unknown) => {
      assert.ok(error instanceof RequestAuthorizationError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'forbidden');
      return true;
    },
  );
  assert.equal(forbidden.calls.length, 1);

  const invalid = fakeService({
    ok: false,
    code: 'unauthenticated',
    statusCode: 401,
    message: 'Authentication is required.',
    retryable: false,
  });
  const invalidAuthorize = createRouteAuthorizer(
    invalid.service,
    new FakeBrowserAuthority(),
  );
  await assert.rejects(
    invalidAuthorize(
      fakeRequest({ authorization: 'Bearer invalid', cookie: 'session=abc' }),
      'projects.create',
    ),
    (error: unknown) =>
      error instanceof RequestAuthorizationError &&
      error.statusCode === 401,
  );
  assert.equal(invalid.calls.length, 1);
});

test('createRouteAuthorizer resolves a browser only without Authorization', async () => {
  const { service, calls } = fakeService({
    ok: false,
    code: 'unauthenticated',
    statusCode: 401,
    message: 'Authentication is required.',
    retryable: false,
  });
  const browser = new FakeBrowserAuthority();
  const authorize = createRouteAuthorizer(service, browser);

  const principal = await authorize(
    fakeRequest({ cookie: 'session=abc' }),
    'me.read',
  );
  assert.deepEqual(principal, {
    kind: 'browser',
    userID: 'user-browser',
  });
  assert.equal(calls.length, 0);

  const noCookie = await authorize(fakeRequest({}), 'projects.list');
  assert.equal(noCookie, null);
});

test('createCloudRuntime wires actual repos, native auth, limiter, and browser bridge', async () => {
  const browser = new FakeBrowserAuthority();
  const projectsRepository = {
    listWithState: async () => [],
  } as unknown as ProjectRepositoryWithState;
  const projectListRepository = {
    listWithState: async () => [],
  } as unknown as ProjectListRepository;
  const revisionsRepository = {
    commit: async () => {
      throw new Error('unused');
    },
    page: async () => {
      throw new Error('unused');
    },
  } as unknown as RevisionRepository;
  const meRepository = {
    read: async () => {
      throw new Error('unused');
    },
  } as unknown as MeRepository;

  const dependencies: CloudRuntimeDependencies = {
    browserAuthFactory: async () => browser,
    repositories: {
      projects: projectsRepository,
      projectList: projectListRepository,
      revisions: revisionsRepository,
      me: meRepository,
    },
  };

  const runtime = await createCloudRuntime(
    {} as never,
    cloudConfig(),
    dependencies,
  );

  assert.equal(runtime.api.projects.repository, projectsRepository);
  assert.equal(runtime.api.projectList.repository, projectListRepository);
  assert.equal(runtime.api.revisions.repository, revisionsRepository);
  assert.equal(runtime.api.me.repository, meRepository);
  assert.equal(runtime.api.nativeAuth.browser, browser);
  assert.equal(
    runtime.api.nativeAuth.config.publicOrigin,
    API_CONFIG.publicOrigin,
  );
  assert.equal(
    runtime.api.browserAuth.canonicalOrigin,
    API_CONFIG.publicOrigin,
  );
  assert.equal(
    runtime.api.browserAuth.maxResponseBytes,
    BACKEND_POLICY.maxAuthResponseBytes,
  );
  assert.equal(typeof runtime.api.nativeAuth.rateLimiter.consume, 'function');
  assert.equal(typeof runtime.api.projects.authorize, 'function');
  assert.equal(typeof runtime.api.me.authorize, 'function');
  assert.equal(Object.isFrozen(runtime.api), true);
  assert.equal(Object.isFrozen(runtime.api.nativeAuth), true);
});

test('cloud runtime passes an explicit quota limit to native auth as bigint only when configured', async () => {
  const captured: Array<Parameters<NativeAuthServiceFactory>[1]> = [];
  const factory: NativeAuthServiceFactory = (_client, options) => {
    captured.push(options);
    return {} as NativeAuthService;
  };
  const dependencies = (): CloudRuntimeDependencies => ({
    browserAuthFactory: async () => new FakeBrowserAuthority(),
    nativeAuthServiceFactory: factory,
  });

  await createCloudRuntime({} as never, cloudConfig(), dependencies());
  await createCloudRuntime(
    {} as never,
    cloudConfig({ initialStorageLimitBytes: 1_073_741_824 }),
    dependencies(),
  );

  assert.equal(captured.length, 2);
  assert.equal(Object.hasOwn(captured[0]!, 'initialStorageLimitBytes'), false);
  assert.equal(
    captured[0]!.repositoryPolicy.maxOutstandingPendingAuthorizationsGlobal,
    BACKEND_POLICY.maxOutstandingPendingAuthorizationsGlobal,
  );

  const explicit = captured[1] as {
    readonly initialStorageLimitBytes?: unknown;
  };
  assert.equal(typeof explicit.initialStorageLimitBytes, 'bigint');
  assert.equal(explicit.initialStorageLimitBytes, 1_073_741_824n);
});

