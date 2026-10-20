/**
 * Explicit `POST /v1/projects` create/link route.
 *
 * This module deliberately does not implement native authentication. It accepts
 * a server-owned `authorizeCreate` callback that receives only the Fastify
 * request and returns the already-verified native principal. The callback is
 * invoked in the route's `onRequest` phase, before body parsing; a body or
 * header value can never supply the principal.
 *
 * The dependency is validated before the route is registered. Omitting it leaves
 * the existing API-wide `/v1` denial untouched. There is no allow-all default,
 * test mode, environment flag, bearer fallback, or cookie fallback.
 *
 * The callback is responsible for checking the active device grant and scopes.
 * That implementation is not supplied here; until a verified native-auth
 * integration is wired into the API bootstrap, the production route is absent.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { apiErrorEnvelope } from '../errors.js';
import { requestAuthorizationEnvelope } from '../protocol/principal.js';
import type {
  AuthorizeRequest,
  RequestPrincipal,
} from '../protocol/principal.js';
import {
  ProjectRepositoryError,
  type ListWithStateInput,
  type ProjectRepository,
  type ProjectStateDTO,
} from './repository.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Standard padded base64 with no whitespace, only final padding, and a length
// divisible by four. The decode/encode round trip below additionally rejects
// non-zero pad bits so only canonical base64 is accepted.
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const AUTHENTICATION_REQUIRED_MESSAGE = 'Authentication is required.';
const AUTH_UNAVAILABLE_MESSAGE = 'The authentication service is unavailable.';
const FORBIDDEN_MESSAGE =
  'This operation is not permitted for this principal.';
const INVALID_REQUEST_MESSAGE = 'The request is invalid.';
const PROJECT_UNAVAILABLE_MESSAGE =
  'The project service is temporarily unavailable.';
const INVALID_DEPENDENCY_MESSAGE = 'Invalid projects API dependency.';

const CREATE_PROJECT_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['projectID'],
  properties: {
    // Domain validation is performed after parsing so invalid UUID/base64
    // values map to a fixed 422 instead of Ajv's schema diagnostics.
    projectID: {},
    label: {},
  },
} as const;

const PROJECT_LIST_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const;

export interface AuthorizedProjectPrincipal {
  readonly userID: string;
}

/**
 * Server-owned principal resolver. It is called with the request only; callers
 * of the route can never pass a user identifier into it.
 */
export type AuthorizeProjectCreate = (
  request: FastifyRequest,
) => Promise<AuthorizedProjectPrincipal | null>;

export interface ProjectsApiDependencies {
  readonly repository: ProjectRepository;
  /** Legacy create-only resolver retained for existing callers/tests. */
  readonly authorizeCreate?: AuthorizeProjectCreate;
  /** Unified resolver; when present it is used for `projects.create`. */
  readonly authorize?: AuthorizeRequest;
}

export interface ProjectRouteOptions {
  readonly retryAfterSeconds: number;
}

/**
 * Dependency for the shared browser/device project list route. It is a
 * separate registration function so the existing create/link bootstrap and
 * tests remain unchanged until the integrator unifies mounts.
 */
/**
 * Minimal repository surface for the shared project list route.
 */
export interface ProjectListRepository {
  listWithState(
    input: ListWithStateInput,
  ): Promise<readonly ProjectStateDTO[]>;
}

export interface ProjectListApiDependencies {
  readonly repository: ProjectListRepository;
  readonly authorize: AuthorizeRequest;
}

/**
 * Validate the optional dependency at construction time. A missing dependency
 * means the route is not registered; a malformed one fails closed instead of
 * silently creating an unauthenticated route.
 */
export function readProjectsDependency(
  value: unknown,
): ProjectsApiDependencies {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidDependency();
  }

  const candidate = value as {
    readonly repository?: unknown;
    readonly authorizeCreate?: unknown;
    readonly authorize?: unknown;
  };
  const repository = candidate.repository;
  if (
    typeof repository !== 'object' ||
    repository === null ||
    Array.isArray(repository) ||
    typeof (repository as { readonly createOrLink?: unknown }).createOrLink !==
      'function' ||
    typeof (repository as { readonly listActive?: unknown }).listActive !==
      'function'
  ) {
    throw invalidDependency();
  }

  const authorizeCreate = candidate.authorizeCreate;
  if (authorizeCreate !== undefined && typeof authorizeCreate !== 'function') {
    throw invalidDependency();
  }
  const authorize = candidate.authorize;
  if (authorize !== undefined && typeof authorize !== 'function') {
    throw invalidDependency();
  }
  if (authorizeCreate === undefined && authorize === undefined) {
    throw invalidDependency();
  }

  return Object.freeze({
    repository: repository as ProjectRepository,
    ...(authorizeCreate === undefined
      ? {}
      : { authorizeCreate: authorizeCreate as AuthorizeProjectCreate }),
    ...(authorize === undefined
      ? {}
      : { authorize: authorize as AuthorizeRequest }),
  });
}

/**
 * Register the single authenticated project-create/link route.
 *
 * The app-level `/v1` gate must let only the exact `POST /v1/projects` request
 * reach this function's `onRequest`; every other method and path remains denied
 * before body parsing by the caller.
 */
export function registerProjectRoutes(
  app: FastifyInstance,
  dependencies: ProjectsApiDependencies,
  options: ProjectRouteOptions,
): void {
  const projects = readProjectsDependency(dependencies);
  const retryAfterSeconds = readRetryAfterSeconds(options);
  // Per-request storage for the verified principal. Weak keys avoid retaining
  // requests; this is not process-wide authentication state.
  const principals = new WeakMap<FastifyRequest, string>();

  app.post(
    '/v1/projects',
    {
      schema: { body: CREATE_PROJECT_BODY_SCHEMA },
      onRequest: async (request, reply) => {
        const unified = projects.authorize;
        if (unified !== undefined) {
          let principal: RequestPrincipal | null;
          try {
            principal = await unified(request, 'projects.create');
          } catch (error) {
            return sendAuthorizationFailure(
              reply,
              request.id,
              error,
              retryAfterSeconds,
            );
          }

          if (principal === null) {
            return sendUnauthenticated(reply, request.id);
          }

          const device = readDevicePrincipal(principal);
          if (!device.ok) {
            return device.reason === 'wrong-kind'
              ? sendForbidden(reply, request.id)
              : sendAuthUnavailable(reply, request.id, retryAfterSeconds);
          }

          principals.set(request, device.userID);
          return;
        }

        const legacy = projects.authorizeCreate;
        if (legacy === undefined) {
          return sendAuthUnavailable(reply, request.id, retryAfterSeconds);
        }

        let principal: unknown;
        try {
          principal = await legacy(request);
        } catch (error) {
          return sendAuthorizationFailure(
            reply,
            request.id,
            error,
            retryAfterSeconds,
          );
        }

        if (principal === null) {
          return sendUnauthenticated(reply, request.id);
        }

        const userID = readPrincipalUserID(principal);
        if (userID === null) {
          return sendAuthUnavailable(reply, request.id, retryAfterSeconds);
        }

        principals.set(request, userID);
      },
    },
    async (request, reply) => {
      const userID = principals.get(request);
      if (userID === undefined) {
        return sendAuthUnavailable(reply, request.id, retryAfterSeconds);
      }

      const body = readCreateProjectBody(request.body);
      if (body === null) {
        return reply
          .code(422)
          .send(
            apiErrorEnvelope(
              'invalid-request',
              INVALID_REQUEST_MESSAGE,
              false,
              request.id,
            ),
          );
      }

      try {
        const result = await projects.repository.createOrLink({
          userID,
          projectID: body.projectID,
          ...(body.encryptedLabel === null
            ? {}
            : { encryptedLabel: body.encryptedLabel }),
        });

        return reply.code(result.statusCode).send({
          projectID: result.project.projectID,
          encryptedLabel:
            result.project.encryptedLabel === null
              ? null
              : Buffer.from(result.project.encryptedLabel).toString('base64'),
          createdAt: result.project.createdAt,
        });
      } catch (error) {
        return sendRepositoryError(
          reply,
          request.id,
          error,
          retryAfterSeconds,
        );
      }
    },
  );
}

/**
 * Register `GET /v1/projects` with the shared typed principal resolver.
 * Both browser and device principals may read their own active project list.
 * This function is not mounted by `createApi`; the integration owner wires it
 * after reconciling the API-wide `/v1` gate.
 */
export function registerProjectListRoute(
  app: FastifyInstance,
  dependencies: ProjectListApiDependencies,
  options: ProjectRouteOptions,
): void {
  const { repository, authorize } = readProjectListDependency(dependencies);
  const listWithState = repository.listWithState;
  const retryAfterSeconds = readRetryAfterSeconds(options);
  const principals = new WeakMap<FastifyRequest, string>();

  app.get(
    '/v1/projects',
    {
      schema: { querystring: PROJECT_LIST_QUERY_SCHEMA },
      onRequest: async (request, reply) => {
        let principal: RequestPrincipal | null;
        try {
          principal = await authorize(request, 'projects.list');
        } catch (error) {
          return sendAuthorizationFailure(
            reply,
            request.id,
            error,
            retryAfterSeconds,
          );
        }

        if (principal === null) {
          return sendUnauthenticated(reply, request.id);
        }

        const readable = readProjectListPrincipal(principal);
        if (!readable.ok) {
          return readable.reason === 'wrong-kind'
            ? sendForbidden(reply, request.id)
            : sendAuthUnavailable(reply, request.id, retryAfterSeconds);
        }

        principals.set(request, readable.userID);
      },
    },
    async (request, reply) => {
      const userID = principals.get(request);
      if (userID === undefined) {
        return sendAuthUnavailable(reply, request.id, retryAfterSeconds);
      }

      try {
        const projects = await listWithState.call(repository, { userID });

        return reply.code(200).send({
          projects: projects.map((project) => ({
            projectID: project.projectID,
            encryptedLabel:
              project.encryptedLabel === null
                ? null
                : Buffer.from(project.encryptedLabel).toString('base64'),
            createdAt: project.createdAt,
            headIDs: [...project.headIDs],
            revisionCount: project.revisionCount,
          })),
        });
      } catch (error) {
        return sendRepositoryError(
          reply,
          request.id,
          error,
          retryAfterSeconds,
        );
      }
    },
  );
}

function readProjectListDependency(value: unknown): ProjectListApiDependencies {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidDependency();
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
      'function'
  ) {
    throw invalidDependency();
  }
  if (typeof candidate.authorize !== 'function') {
    throw invalidDependency();
  }

  return Object.freeze({
    repository: repository as ProjectListRepository,
    authorize: candidate.authorize as AuthorizeRequest,
  });
}

interface CreateProjectBody {
  readonly projectID: string;
  readonly encryptedLabel: Uint8Array | null;
}

function readPrincipalUserID(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const userID = (value as { readonly userID?: unknown }).userID;
  if (
    typeof userID !== 'string' ||
    userID.length === 0 ||
    userID.trim().length === 0 ||
    CONTROL_CHARACTERS.test(userID)
  ) {
    return null;
  }

  return userID;
}

type PrincipalReadResult =
  | {
      readonly ok: true;
      readonly userID: string;
      readonly deviceID: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'wrong-kind' | 'malformed';
    };

type ProjectListPrincipalResult =
  | { readonly ok: true; readonly userID: string }
  | { readonly ok: false; readonly reason: 'wrong-kind' | 'malformed' };

function readDevicePrincipal(value: unknown): PrincipalReadResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'malformed' };
  }

  const principal = value as {
    readonly kind?: unknown;
    readonly userID?: unknown;
    readonly deviceID?: unknown;
    readonly grantID?: unknown;
  };

  if (principal.kind === 'browser') {
    return { ok: false, reason: 'wrong-kind' };
  }
  if (principal.kind !== 'device') {
    return { ok: false, reason: 'malformed' };
  }

  const userID = readProtocolUserID(principal.userID);
  if (
    userID === null ||
    typeof principal.deviceID !== 'string' ||
    !UUID_PATTERN.test(principal.deviceID)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (
    principal.grantID !== undefined &&
    (typeof principal.grantID !== 'string' ||
      principal.grantID.length === 0 ||
      CONTROL_CHARACTERS.test(principal.grantID))
  ) {
    return { ok: false, reason: 'malformed' };
  }

  return {
    ok: true,
    userID,
    deviceID: principal.deviceID.toLowerCase(),
  };
}

function readProjectListPrincipal(
  value: unknown,
): ProjectListPrincipalResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'malformed' };
  }

  const kind = (value as { readonly kind?: unknown }).kind;
  if (kind === 'browser') {
    const userID = readProtocolUserID(
      (value as { readonly userID?: unknown }).userID,
    );
    return userID === null
      ? { ok: false, reason: 'malformed' }
      : { ok: true, userID };
  }
  if (kind === 'device') {
    const device = readDevicePrincipal(value);
    return device.ok
      ? { ok: true, userID: device.userID }
      : { ok: false, reason: device.reason };
  }

  return { ok: false, reason: 'malformed' };
}

function readProtocolUserID(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.trim().length === 0 ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return null;
  }

  return value;
}

function readCreateProjectBody(rawBody: unknown): CreateProjectBody | null {
  if (
    typeof rawBody !== 'object' ||
    rawBody === null ||
    Array.isArray(rawBody)
  ) {
    return null;
  }

  const body = rawBody as {
    readonly projectID?: unknown;
    readonly label?: unknown;
  };

  if (
    typeof body.projectID !== 'string' ||
    !UUID_PATTERN.test(body.projectID)
  ) {
    return null;
  }

  if (body.label === undefined) {
    return {
      projectID: body.projectID.toLowerCase(),
      encryptedLabel: null,
    };
  }

  // The contract marks `label` optional, not nullable. An empty string is
  // canonical base64 and maps to zero encrypted bytes; JSON null is rejected.
  if (typeof body.label !== 'string') {
    return null;
  }

  const encryptedLabel = decodeCanonicalBase64(body.label);
  if (encryptedLabel === null) {
    return null;
  }

  return {
    projectID: body.projectID.toLowerCase(),
    encryptedLabel,
  };
}

function decodeCanonicalBase64(value: string): Uint8Array | null {
  if (!BASE64_PATTERN.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    return null;
  }

  return new Uint8Array(decoded);
}

function sendUnauthenticated(
  reply: FastifyReply,
  requestID: string,
): FastifyReply {
  return reply
    .code(401)
    .send(
      apiErrorEnvelope(
        'unauthenticated',
        AUTHENTICATION_REQUIRED_MESSAGE,
        false,
        requestID,
      ),
    );
}

function sendForbidden(
  reply: FastifyReply,
  requestID: string,
): FastifyReply {
  return reply.code(403).send({
    error: {
      code: 'forbidden',
      message: FORBIDDEN_MESSAGE,
      retryable: false,
      requestID,
    },
  });
}

function sendAuthUnavailable(
  reply: FastifyReply,
  requestID: string,
  retryAfterSeconds: number,
): FastifyReply {
  return reply
    .header('Retry-After', String(retryAfterSeconds))
    .code(503)
    .send(
      apiErrorEnvelope(
        'unavailable',
        AUTH_UNAVAILABLE_MESSAGE,
        true,
        requestID,
      ),
    );
}

function sendAuthorizationFailure(
  reply: FastifyReply,
  requestID: string,
  error: unknown,
  retryAfterSeconds: number,
): FastifyReply {
  const { failure, envelope } = requestAuthorizationEnvelope(
    error,
    requestID,
  );
  if (failure.statusCode === 503) {
    void reply.header('Retry-After', String(retryAfterSeconds));
  }
  return reply.code(failure.statusCode).send(envelope);
}

function sendRepositoryError(
  reply: FastifyReply,
  requestID: string,
  error: unknown,
  retryAfterSeconds: number,
): FastifyReply {
  if (
    error instanceof ProjectRepositoryError &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
  ) {
    if (error.statusCode === 503) {
      void reply.header('Retry-After', String(retryAfterSeconds));
    }

    // Repository codes and messages are fixed, public-safe constants. They are
    // intentionally not merged with framework error text or request values.
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        requestID,
      },
    });
  }

  return reply
    .header('Retry-After', String(retryAfterSeconds))
    .code(503)
    .send(
      apiErrorEnvelope(
        'unavailable',
        PROJECT_UNAVAILABLE_MESSAGE,
        true,
        requestID,
      ),
    );
}

function readRetryAfterSeconds(options: ProjectRouteOptions): number {
  if (
    typeof options !== 'object' ||
    options === null ||
    !Number.isSafeInteger(options.retryAfterSeconds) ||
    options.retryAfterSeconds < 0
  ) {
    throw invalidDependency();
  }

  return options.retryAfterSeconds;
}

function invalidDependency(): TypeError {
  return new TypeError(INVALID_DEPENDENCY_MESSAGE);
}
