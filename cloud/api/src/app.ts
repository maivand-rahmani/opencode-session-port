import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiConfig } from './config.js';
import { apiErrorEnvelope, toApiErrorResponse } from './errors.js';
import {
  readMeDependency,
  registerMeRoutes,
  type MeApiDependencies,
} from './me/routes.js';
import {
  readNativeAuthRouteDependencies,
  registerNativeAuthRoutes,
  type NativeAuthRouteDependencies,
} from './native-auth/routes.js';
import {
  readProjectsDependency,
  registerProjectListRoute,
  registerProjectRoutes,
  type ProjectListApiDependencies,
  type ProjectsApiDependencies,
} from './projects/routes.js';
import { evaluateReadiness, type ReadinessChecks } from './readiness.js';
import {
  readRevisionDependency,
  registerRevisionRoutes,
  type RevisionApiDependencies,
} from './revisions/routes.js';
import {
  isBrowserAuthRouteAllowed,
  readBrowserAuthDependency,
  registerBrowserAuthRoutes,
  type BrowserAuthBridgeOptions,
} from './runtime/browser-routes.js';

/**
 * M2 integration option for `GET /v1/me`. The route module owns the complete
 * dependency shape including its retry value; `createApi` supplies the
 * existing config value instead of accepting a second default.
 */
export type MeApiOption = Omit<MeApiDependencies, 'retryAfterSeconds'>;

export interface CreateApiOptions {
  config: ApiConfig;
  readiness?: ReadinessChecks;
  /**
   * Optional authenticated project-create dependency. Omitted keeps the
   * original 401 on every `/v1` path. The legacy shape with `authorizeCreate`
   * remains supported; the shared `authorize` callback may be used instead.
   */
  projects?: ProjectsApiDependencies;
  /**
   * Optional `GET /v1/projects`. This is deliberately separate from
   * `projects`; a repository's `listWithState` method never enables the route
   * implicitly. Omitted keeps the original 401.
   */
  projectList?: ProjectListApiDependencies;
  /** Optional device-only revision list/commit routes. */
  revisions?: RevisionApiDependencies;
  /** Optional browser/device `GET /v1/me` route. */
  me?: MeApiOption;
  /**
   * Optional native-auth route surface. Its retry value is supplied from the
   * existing API config. Omitted keeps every native path at the old 503.
   */
  nativeAuth?: Omit<NativeAuthRouteDependencies, 'retryAfterSeconds'>;
  /** Optional four-route BetterAuth browser bridge. */
  browserAuth?: BrowserAuthBridgeOptions;
}

const UNAUTHENTICATED_MESSAGE = 'Authentication is required.';
const AUTH_UNAVAILABLE_MESSAGE = 'The authentication service is unavailable.';
const NOT_READY_MESSAGE = 'The service is not ready.';
const NOT_FOUND_MESSAGE = 'The requested resource was not found.';
const INVALID_PROJECT_LIST_DEPENDENCY_MESSAGE =
  'Invalid project list API dependency.';
const INVALID_PROJECTS_DEPENDENCY_MESSAGE = 'Invalid projects API dependency.';
const INVALID_REVISIONS_DEPENDENCY_MESSAGE =
  'Invalid revisions API dependency.';
const INVALID_ME_DEPENDENCY_MESSAGE = 'Invalid me API dependency.';
const INVALID_NATIVE_AUTH_DEPENDENCY_MESSAGE =
  'Invalid native auth dependency.';
const INVALID_BROWSER_AUTH_DEPENDENCY_MESSAGE =
  'Invalid browser auth dependency.';

const V1_PATH = /^\/v1(?:\/|$)/i;
const REVISION_PATH =
  /^\/v1\/projects\/([A-Za-z0-9._~-]+)\/revisions$/;
const MAX_REVISION_PROJECT_SEGMENT_LENGTH = 128;

interface MountedRoutes {
  readonly projects: boolean;
  readonly projectList: boolean;
  readonly revisions: boolean;
  readonly me: boolean;
}

/**
 * Build an unlistened Fastify instance.
 *
 * Security posture:
 * - no request logging and no application exception logging;
 * - generated UUID request IDs, never trusted from a request header;
 * - no proxy-header trust;
 * - /v1 and /api/auth are denied in `onRequest`, before body parsing;
 * - the only `/v1` exceptions are exact routes whose explicit dependency was
 *   supplied to `createApi`. A path is allow-listed only when its method,
 *   exact shape, and dependency all agree; every other method/path keeps the
 *   original 401. No prefix-wide allow list and no implicit route enabling.
 */
export function createApi({
  config,
  readiness,
  projects: projectsOption,
  projectList: projectListOption,
  revisions: revisionsOption,
  me: meOption,
  nativeAuth: nativeAuthOption,
  browserAuth: browserAuthOption,
}: CreateApiOptions): FastifyInstance {
  // Validate every supplied module dependency before constructing Fastify so a
  // malformed option can never leave a partially built server or inherit a
  // default. Each reader throws a fixed, sanitised TypeError.
  const projects =
    projectsOption === undefined
      ? undefined
      : readValidatedDependency(
          readProjectsDependency,
          projectsOption,
          INVALID_PROJECTS_DEPENDENCY_MESSAGE,
        );
  const projectList =
    projectListOption === undefined
      ? undefined
      : readValidatedDependency(
          readProjectListOption,
          projectListOption,
          INVALID_PROJECT_LIST_DEPENDENCY_MESSAGE,
        );
  const revisions =
    revisionsOption === undefined
      ? undefined
      : readValidatedDependency(
          readRevisionDependency,
          revisionsOption,
          INVALID_REVISIONS_DEPENDENCY_MESSAGE,
        );
  const me =
    meOption === undefined
      ? undefined
      : readValidatedDependency(
          (value) => readMeOption(value, config.retryAfterSeconds),
          meOption,
          INVALID_ME_DEPENDENCY_MESSAGE,
        );
  const nativeAuth =
    nativeAuthOption === undefined
      ? undefined
      : readValidatedDependency(
          (value) =>
            readNativeAuthOption(value, config.retryAfterSeconds),
          nativeAuthOption,
          INVALID_NATIVE_AUTH_DEPENDENCY_MESSAGE,
        );
  const browserAuth =
    browserAuthOption === undefined
      ? undefined
      : readValidatedDependency(
          readBrowserAuthDependency,
          browserAuthOption,
          INVALID_BROWSER_AUTH_DEPENDENCY_MESSAGE,
        );
  if (
    browserAuth !== undefined &&
    browserAuth.canonicalOrigin !== config.publicOrigin
  ) {
    throw new TypeError(INVALID_BROWSER_AUTH_DEPENDENCY_MESSAGE);
  }

  const mounted: MountedRoutes = Object.freeze({
    projects: projects !== undefined,
    projectList: projectList !== undefined,
    revisions: revisions !== undefined,
    me: me !== undefined,
  });

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: config.bodyLimitBytes,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Fastify defaults to removing extra body properties before validation,
    // which would silently accept forged identity fields. Keep strict rejection
    // for routes that declare `additionalProperties: false`.
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  app.addHook('onRequest', (request, reply, done) => {
    const path = requestPath(request.url);

    if (isProtectedV1Path(path)) {
      if (isMountedRequestAllowed(request.method, path, mounted)) {
        // The selected route's own onRequest verifies the principal before
        // body parsing. No other /v1 traffic reaches a handler.
        done();
        return;
      }

      void reply
        .code(401)
        .send(
          apiErrorEnvelope(
            'unauthenticated',
            UNAUTHENTICATED_MESSAGE,
            false,
            request.id,
          ),
        );
      return;
    }

    if (isProtectedPrefix(path, '/api/native')) {
      if (
        nativeAuth !== undefined &&
        isNativeAuthRouteAllowed(request.method, path)
      ) {
        done();
        return;
      }

      if (nativeAuth === undefined) {
        void reply
          .header('Retry-After', String(config.retryAfterSeconds))
          .code(503)
          .send(
            apiErrorEnvelope(
              'unavailable',
              AUTH_UNAVAILABLE_MESSAGE,
              true,
              request.id,
            ),
          );
        return;
      }

      void reply
        .code(404)
        .send(
          apiErrorEnvelope(
            'not-found',
            NOT_FOUND_MESSAGE,
            false,
            request.id,
          ),
        );
      return;
    }

    if (isProtectedPrefix(path, '/api/auth')) {
      if (
        browserAuth !== undefined &&
        isBrowserAuthRouteAllowed(request.method, path)
      ) {
        done();
        return;
      }

      void reply
        .header('Retry-After', String(config.retryAfterSeconds))
        .code(503)
        .send(
          apiErrorEnvelope(
            'unavailable',
            AUTH_UNAVAILABLE_MESSAGE,
            true,
            request.id,
          ),
        );
      return;
    }

    done();
  });

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (request, reply) => {
    const ready = await evaluateReadiness(readiness, config.readinessTimeoutMs);
    if (!ready) {
      return reply
        .header('Retry-After', String(config.retryAfterSeconds))
        .code(503)
        .send(
          apiErrorEnvelope(
            'unavailable',
            NOT_READY_MESSAGE,
            true,
            request.id,
          ),
        );
    }

    return { status: 'ok' };
  });

  if (projects !== undefined) {
    registerProjectRoutes(app, projects, {
      retryAfterSeconds: config.retryAfterSeconds,
    });
  }

  if (projectList !== undefined) {
    registerProjectListRoute(app, projectList, {
      retryAfterSeconds: config.retryAfterSeconds,
    });
  }

  if (revisions !== undefined) {
    registerRevisionRoutes(app, revisions, {
      retryAfterSeconds: config.retryAfterSeconds,
    });
  }

  if (me !== undefined) {
    registerMeRoutes(app, me);
  }

  if (nativeAuth !== undefined) {
    registerNativeAuthRoutes(app, nativeAuth);
  }

  if (browserAuth !== undefined) {
    registerBrowserAuthRoutes(app, browserAuth);
  }

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(apiErrorEnvelope('not-found', NOT_FOUND_MESSAGE, false, request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toApiErrorResponse(error, request.id);
    if (mapped.statusCode === 503) {
      void reply.header('Retry-After', String(config.retryAfterSeconds));
    }
    void reply.code(mapped.statusCode).send(mapped.envelope);
  });

  return app;
}

/**
 * Validate the optional project list dependency before Fastify is built. The
 * route module does not export its own reader, so this mirrors its exact
 * checks and keeps the failure message fixed and value-free.
 */
function readProjectListOption(value: unknown): ProjectListApiDependencies {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidProjectListDependency();
  }

  const candidate = value as {
    readonly repository?: unknown;
    readonly authorize?: unknown;
  };
  const repository = candidate.repository;
  if (
    typeof repository !== 'object' ||
    repository === null ||
    Array.isArray(repository) ||
    typeof (repository as { readonly listWithState?: unknown }).listWithState !==
      'function' ||
    typeof candidate.authorize !== 'function'
  ) {
    throw invalidProjectListDependency();
  }

  return Object.freeze({
    repository: repository as ProjectListApiDependencies['repository'],
    authorize: candidate.authorize as ProjectListApiDependencies['authorize'],
  });
}

function readMeOption(
  value: unknown,
  retryAfterSeconds: number,
): MeApiDependencies {
  const candidate =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as MeApiOption)
      : {};

  return readMeDependency({
    ...candidate,
    retryAfterSeconds,
  });
}

function readNativeAuthOption(
  value: unknown,
  retryAfterSeconds: number,
): NativeAuthRouteDependencies {
  const candidate =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value
      : {};

  return readNativeAuthRouteDependencies({
    ...candidate,
    retryAfterSeconds,
  });
}

/**
 * Run one module reader and replace any thrown value with a fixed TypeError.
 * This keeps malformed options from leaking getter text, identifiers, or
 * driver/runtime messages and guarantees the failure happens before Fastify is
 * constructed.
 */
function readValidatedDependency<T>(
  reader: (value: unknown) => T,
  value: unknown,
  message: string,
): T {
  try {
    return reader(value);
  } catch {
    throw new TypeError(message);
  }
}

function isMountedRequestAllowed(
  method: string,
  path: string,
  mounted: MountedRoutes,
): boolean {
  if (path === '/v1/projects') {
    if (method === 'POST') {
      return mounted.projects;
    }
    if (method === 'GET') {
      return mounted.projectList;
    }
    return false;
  }

  if (path === '/v1/me') {
    return method === 'GET' && mounted.me;
  }

  const revisionMatch = REVISION_PATH.exec(path);
  if (revisionMatch === null || !mounted.revisions) {
    return false;
  }
  if (method !== 'GET' && method !== 'POST') {
    return false;
  }

  const projectSegment = revisionMatch[1];
  return (
    projectSegment !== undefined &&
    projectSegment !== '.' &&
    projectSegment !== '..' &&
    projectSegment.length <= MAX_REVISION_PROJECT_SEGMENT_LENGTH
  );
}

/**
 * Detect any request target that could be interpreted as `/v1` by the router.
 * Besides the literal prefix, one percent-decoding pass and backslash/leading
 * slash normalisation are checked. Encoded slashes, duplicate slashes, and
 * backslashes therefore stay behind the original 401 gate rather than falling
 * through to a 404.
 */
function isProtectedV1Path(path: string): boolean {
  if (V1_PATH.test(path)) {
    return true;
  }

  const normalized = normalizeGatePath(path);
  return normalized !== path && V1_PATH.test(normalized);
}

function isProtectedPrefix(path: string, prefix: string): boolean {
  if (isPathOrChild(path.toLowerCase(), prefix)) {
    return true;
  }
  const normalized = normalizeGatePath(path).toLowerCase();
  return (
    normalized !== path.toLowerCase() && isPathOrChild(normalized, prefix)
  );
}

const NATIVE_BASE = '/api/native/v1';
const NATIVE_GRANT_REVOKE_PATTERN =
  /^\/api\/native\/v1\/grants\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/revoke$/i;

function isNativeAuthRouteAllowed(method: string, path: string): boolean {
  if (method === 'GET' && path === `${NATIVE_BASE}/session`) {
    return true;
  }
  if (method === 'POST' && path === `${NATIVE_BASE}/device-authorizations`) {
    return true;
  }
  if (
    (method === 'GET' || method === 'POST') &&
    path === `${NATIVE_BASE}/device-authorizations/verify`
  ) {
    return true;
  }
  if (
    method === 'POST' &&
    (path === `${NATIVE_BASE}/device-authorizations/approve` ||
      path === `${NATIVE_BASE}/device-authorizations/deny`)
  ) {
    return true;
  }
  if (method === 'POST' && path === `${NATIVE_BASE}/token`) {
    return true;
  }
  if (method === 'GET' && path === `${NATIVE_BASE}/grants`) {
    return true;
  }
  return method === 'POST' && NATIVE_GRANT_REVOKE_PATTERN.test(path);
}

function normalizeGatePath(path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return path;
  }

  return decoded.replaceAll('\\', '/').replace(/^\/+/, '/');
}

function requestPath(rawUrl: string): string {
  if (rawUrl.startsWith('/')) {
    const separator = rawUrl.search(/[?#]/);
    return separator === -1 ? rawUrl : rawUrl.slice(0, separator);
  }

  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl;
  }
}

function isPathOrChild(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function invalidProjectListDependency(): TypeError {
  return new TypeError(INVALID_PROJECT_LIST_DEPENDENCY_MESSAGE);
}
