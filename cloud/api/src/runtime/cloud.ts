/**
 * Cloud-runtime composition for the M2/M3 API surface.
 *
 * This factory builds the actual tenant repositories, native-auth service,
 * browser session authority, bounded single-process rate limiter, and the
 * per-route authorizer. It touches no storage provider, upload route, quota
 * provisioning, migration, or database schema. The owned database client is
 * supplied by the caller and disconnected by the caller.
 */

import type { FastifyRequest } from 'fastify';
import type { PrismaClient } from '../../prisma/generated/client/client.js';
import { createMeRepository, type MeRepository } from '../me/repository.js';
import type { MeApiDependencies } from '../me/routes.js';
import {
  createBrowserAuth,
  type BrowserAuthConfig,
  type BrowserSessionAuthority,
} from '../native-auth/browser.js';
import {
  createInMemoryRateLimiter,
  type NativeRateLimiter,
} from '../native-auth/rate-limit.js';
import {
  createNativeAuthService,
  type NativeAuthService,
} from '../native-auth/service.js';
import type { NativeAuthRouteDependencies } from '../native-auth/routes.js';
import {
  RequestAuthorizationError,
  type AuthorizeRequest,
  type RequestPrincipal,
} from '../protocol/principal.js';
import {
  createProjectRepository,
  type ProjectRepositoryWithState,
} from '../projects/repository.js';
import type {
  ProjectListApiDependencies,
  ProjectListRepository,
  ProjectsApiDependencies,
} from '../projects/routes.js';
import {
  createRevisionRepository,
  type RevisionRepository,
} from '../revisions/repository.js';
import type { RevisionApiDependencies } from '../revisions/routes.js';
import type { BrowserAuthBridgeOptions } from './browser-routes.js';
import type { CloudRuntimeConfig } from './config.js';

export type BrowserAuthFactory = (
  config: BrowserAuthConfig,
  client: PrismaClient,
) => Promise<BrowserSessionAuthority>;

/** Focused-test seam only; production uses `createNativeAuthService`. */
export type NativeAuthServiceFactory = (
  client: PrismaClient,
  options: Parameters<typeof createNativeAuthService>[1],
) => NativeAuthService;

export interface CloudRuntimeRepositoryOverrides {
  readonly projects?: ProjectRepositoryWithState;
  readonly projectList?: ProjectListRepository;
  readonly revisions?: RevisionRepository;
  readonly me?: MeRepository;
}

export interface CloudRuntimeDependencies {
  /** Focused-test seam only; production uses `createBrowserAuth`. */
  readonly browserAuthFactory?: BrowserAuthFactory;
  /** Focused-test seam only; production uses `createNativeAuthService`. */
  readonly nativeAuthServiceFactory?: NativeAuthServiceFactory;
  readonly repositories?: CloudRuntimeRepositoryOverrides;
  /** Injected clock for deterministic tests. */
  readonly now?: () => Date;
}

export interface CloudApiOptions {
  readonly projects: ProjectsApiDependencies;
  readonly projectList: ProjectListApiDependencies;
  readonly revisions: RevisionApiDependencies;
  readonly me: Omit<MeApiDependencies, 'retryAfterSeconds'>;
  readonly nativeAuth: Omit<NativeAuthRouteDependencies, 'retryAfterSeconds'>;
  readonly browserAuth: BrowserAuthBridgeOptions;
}

export interface CloudRuntime {
  readonly api: CloudApiOptions;
}

/**
 * Compose the validated cloud modules. Production calls this with the actual
 * Prisma client; tests may inject repository/browser implementations but never
 * receive an allow-all authorizer.
 */
export async function createCloudRuntime(
  client: PrismaClient,
  config: CloudRuntimeConfig,
  dependencies: CloudRuntimeDependencies = {},
): Promise<CloudRuntime> {
  if (typeof client !== 'object' || client === null) {
    throw new TypeError('Invalid cloud runtime client.');
  }
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    Array.isArray(dependencies)
  ) {
    throw new TypeError('Invalid cloud runtime dependencies.');
  }

  const projectsRepository =
    dependencies.repositories?.projects ??
    createProjectRepository(client, {
      maxActiveProjects: config.backend.maxActiveProjects,
    });
  const projectListRepository =
    dependencies.repositories?.projectList ?? {
      listWithState: (input: { readonly userID: string }) =>
        projectsRepository.listWithState(input),
    };
  const revisionsRepository =
    dependencies.repositories?.revisions ??
    createRevisionRepository(client, {
      maxPageSize: config.backend.maxPageSize,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
  const meRepository =
    dependencies.repositories?.me ??
    createMeRepository(client, {
      maxCiphertextBytes: config.backend.maxCiphertextBytes,
      maxActiveDevices: config.backend.maxActiveDevices,
      maxActiveProjects: config.backend.maxActiveProjects,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });

  const browserAuthority = await createBrowserAuthority(
    config,
    client,
    dependencies.browserAuthFactory,
  );

  const nativeAuthOptions: Parameters<typeof createNativeAuthService>[1] = {
    config: config.native,
    repositoryPolicy: {
      maxOutstandingPendingAuthorizationsGlobal:
        config.backend.maxOutstandingPendingAuthorizationsGlobal,
    },
    // fix106 owns NativeAuthServiceOptions/repository forwarding. Until that
    // optional field lands, the service ignores this option, so provisioning
    // stays disabled even when configured; do not add a fallback default here.
    ...(config.backend.initialStorageLimitBytes === undefined
      ? {}
      : {
          initialStorageLimitBytes: BigInt(
            config.backend.initialStorageLimitBytes,
          ),
        }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
  const nativeService =
    dependencies.nativeAuthServiceFactory === undefined
      ? createNativeAuthService(client, nativeAuthOptions)
      : dependencies.nativeAuthServiceFactory(client, nativeAuthOptions);
  const rateLimiter = createInMemoryRateLimiter({
    maxEntries: config.backend.maxRateLimitEntries,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });

  const authorize = createRouteAuthorizer(nativeService, browserAuthority);

  return Object.freeze({
    api: Object.freeze({
      projects: Object.freeze({
        repository: projectsRepository,
        authorize,
      }),
      projectList: Object.freeze({
        repository: projectListRepository,
        authorize,
      }),
      revisions: Object.freeze({
        repository: revisionsRepository,
        authorize,
      }),
      me: Object.freeze({
        repository: meRepository,
        authorize: async (
          request: FastifyRequest,
          _action: 'me.read',
        ) => authorize(request, 'me.read'),
      }),
      nativeAuth: Object.freeze({
        service: nativeService,
        browser: browserAuthority,
        config: config.native,
        rateLimiter,
      }),
      browserAuth: Object.freeze({
        authority: browserAuthority,
        canonicalOrigin: config.native.publicOrigin,
        maxResponseBytes: config.backend.maxAuthResponseBytes,
      }),
    }),
  });
}

async function createBrowserAuthority(
  config: CloudRuntimeConfig,
  client: PrismaClient,
  factory: BrowserAuthFactory | undefined,
): Promise<BrowserSessionAuthority> {
  const browserConfig = {
    publicOrigin: config.native.publicOrigin,
    allowLoopbackHttp: config.native.allowLoopbackHttp,
    betterAuth: {
      secret: config.native.betterAuth.secret,
      github: {
        clientID: config.native.betterAuth.github.clientID,
        clientSecret: config.native.betterAuth.github.clientSecret,
      },
    },
  } as const;

  if (factory !== undefined) {
    return factory(browserConfig, client);
  }

  return createBrowserAuth(browserConfig, client);
}

/**
 * Per-route authority resolver.
 *
 * An Authorization header always selects native bearer handling, even when the
 * value is invalid; there is no cookie fallback. Duplicate Authorization
 * headers are rejected before any database lookup. Without Authorization, a
 * cookie may resolve a browser session for any business route, but the route
 * itself still enforces its device-only policy. No header/body identity is
 * trusted.
 */
export function createRouteAuthorizer(
  service: NativeAuthService,
  browser: BrowserSessionAuthority,
): AuthorizeRequest {
  return async (
    request: FastifyRequest,
    routeID: string,
  ): Promise<RequestPrincipal | null> => {
    const authorization = readHeaderValues(request, 'authorization');
    if (authorization.length > 1) {
      throw new RequestAuthorizationError('unauthenticated');
    }

    if (authorization.length === 1) {
      const result = await service.authorizeBearer(
        { authorization: authorization[0]! },
        routeID,
      );
      if (!result.ok) {
        throw new RequestAuthorizationError(result.code);
      }
      return {
        kind: 'device',
        userID: result.principal.userID,
        deviceID: result.principal.deviceID,
        grantID: result.principal.grantID,
      };
    }

    const cookie = readCookie(request);
    if (cookie === undefined) {
      return null;
    }

    let session;
    try {
      session = await browser.readSession(cookie);
    } catch {
      throw new RequestAuthorizationError('unavailable');
    }
    if (session === null) {
      return null;
    }

    return { kind: 'browser', userID: session.userID };
  };
}

function readHeaderValues(request: FastifyRequest, name: string): string[] {
  const values: string[] = [];
  const raw = request.raw.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (String(raw[index]).toLowerCase() === name) {
      values.push(String(raw[index + 1]));
    }
  }
  if (values.length > 0) {
    return values;
  }

  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return typeof value === 'string' ? [value] : [];
}

function readCookie(request: FastifyRequest): string | undefined {
  const values = readHeaderValues(request, 'cookie');
  return values.length === 0 ? undefined : values.join('; ');
}
