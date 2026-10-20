/**
 * Revision event-page and commit routes.
 *
 * Authorization is performed in each route's `onRequest` phase, before any
 * body parsing. The caller supplies a server-owned `AuthorizeRequest`; this
 * module never reads an identity header, cookie, query value, or body field.
 *
 * Both routes are device-only in this module. The browser dashboard does not
 * receive a revisions GET principal. The project list route (browser + device)
 * lives in the projects module.
 *
 * This module is not mounted by `createApi`; the integration owner wires it
 * after reconciling the API-wide `/v1` gate.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { apiErrorEnvelope } from '../errors.js';
import { requestAuthorizationEnvelope } from '../protocol/principal.js';
import type {
  AuthorizeRequest,
  RequestPrincipal,
} from '../protocol/principal.js';
import {
  RevisionRepositoryError,
  revisionErrorEnvelope,
} from './errors.js';
import type {
  CommitRevisionResult,
  RevisionPage,
  RevisionRepository,
} from './repository.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ASCII_DECIMAL_DIGITS = /^[0-9]+$/;
const CANONICAL_LIMIT = /^(?:0|[1-9][0-9]*)$/;

const AUTHENTICATION_REQUIRED_MESSAGE = 'Authentication is required.';
const AUTH_UNAVAILABLE_MESSAGE = 'The authentication service is unavailable.';
const FORBIDDEN_MESSAGE =
  'This operation is not permitted for this principal.';
const INVALID_REQUEST_MESSAGE = 'The request is invalid.';
const INVALID_DEPENDENCY_MESSAGE = 'Invalid revisions API dependency.';

const REVISION_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['projectID'],
  properties: {
    // Domain validation maps a malformed UUID to a fixed 422.
    projectID: {},
  },
} as const;

const REVISION_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    after: {},
    upperBound: {},
    limit: {},
  },
} as const;

const EMPTY_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const;

const COMMIT_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['revisionID', 'uploadID', 'parentRevisionID'],
  properties: {
    // Domain validation is performed after parsing so malformed UUIDs map to
    // a fixed 422 rather than Ajv diagnostics. `parentRevisionID` is required
    // but may be JSON null for the initial revision.
    revisionID: {},
    uploadID: {},
    parentRevisionID: {},
  },
} as const;

export interface RevisionApiDependencies {
  readonly repository: RevisionRepository;
  readonly authorize: AuthorizeRequest;
}

export interface RevisionRouteOptions {
  readonly retryAfterSeconds: number;
}

interface DevicePrincipal {
  readonly userID: string;
  readonly deviceID: string;
}

/**
 * Validate the dependency at construction time. A missing or malformed
 * dependency fails closed; there is no anonymous or allow-all fallback.
 */
export function readRevisionDependency(
  value: unknown,
): RevisionApiDependencies {
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
    typeof (repository as { readonly commit?: unknown }).commit !== 'function' ||
    typeof (repository as { readonly page?: unknown }).page !== 'function'
  ) {
    throw invalidDependency();
  }
  if (typeof candidate.authorize !== 'function') {
    throw invalidDependency();
  }

  return Object.freeze({
    repository: repository as RevisionRepository,
    authorize: candidate.authorize as AuthorizeRequest,
  });
}

/**
 * Register the revision list and commit routes.
 *
 * The caller is responsible for the API-wide `/v1` gate. This function only
 * registers these two exact routes and performs their per-route authorization
 * before body parsing.
 */
export function registerRevisionRoutes(
  app: FastifyInstance,
  dependencies: RevisionApiDependencies,
  options: RevisionRouteOptions,
): void {
  const { repository, authorize } = readRevisionDependency(dependencies);
  const retryAfterSeconds = readRetryAfterSeconds(options);
  const principals = new WeakMap<FastifyRequest, DevicePrincipal>();

  app.get(
    '/v1/projects/:projectID/revisions',
    {
      schema: {
        params: REVISION_PARAMS_SCHEMA,
        querystring: REVISION_QUERY_SCHEMA,
      },
      onRequest: async (request, reply) => {
        const failure = await authorizeDevice(
          request,
          reply,
          authorize,
          'revisions.list',
          retryAfterSeconds,
          principals,
        );
        if (failure !== null) {
          return failure;
        }
      },
    },
    async (request, reply) => {
      const principal = principals.get(request);
      if (principal === undefined) {
        return sendAuthUnavailable(reply, request.id, retryAfterSeconds);
      }

      try {
        const projectID = readProjectID(request.params);
        if (projectID === null) {
          return sendInvalidRequest(reply, request.id);
        }

        const query = readQuery(request.query);
        if (query === null) {
          return sendInvalidRequest(reply, request.id);
        }

        const page = await repository.page({
          userID: principal.userID,
          projectID,
          ...readPageQuery(query),
        });

        return reply.code(200).send(toPageResponse(page));
      } catch (error) {
        return sendDomainError(
          reply,
          request.id,
          error,
          retryAfterSeconds,
        );
      }
    },
  );

  app.post(
    '/v1/projects/:projectID/revisions',
    {
      schema: {
        params: REVISION_PARAMS_SCHEMA,
        querystring: EMPTY_QUERY_SCHEMA,
        body: COMMIT_BODY_SCHEMA,
      },
      onRequest: async (request, reply) => {
        const failure = await authorizeDevice(
          request,
          reply,
          authorize,
          'revisions.commit',
          retryAfterSeconds,
          principals,
        );
        if (failure !== null) {
          return failure;
        }
      },
    },
    async (request, reply) => {
      const principal = principals.get(request);
      if (principal === undefined) {
        return sendAuthUnavailable(reply, request.id, retryAfterSeconds);
      }

      try {
        const projectID = readProjectID(request.params);
        if (projectID === null) {
          return sendInvalidRequest(reply, request.id);
        }

        const body = readCommitBody(request.body);
        if (body === null) {
          return sendInvalidRequest(reply, request.id);
        }

        const result = await repository.commit({
          userID: principal.userID,
          deviceID: principal.deviceID,
          projectID,
          revisionID: body.revisionID,
          uploadID: body.uploadID,
          parentRevisionID: body.parentRevisionID,
        });

        return reply.code(result.statusCode).send(toCommitResponse(result));
      } catch (error) {
        return sendDomainError(
          reply,
          request.id,
          error,
          retryAfterSeconds,
        );
      }
    },
  );
}

async function authorizeDevice(
  request: FastifyRequest,
  reply: FastifyReply,
  authorize: AuthorizeRequest,
  routeID: string,
  retryAfterSeconds: number,
  principals: WeakMap<FastifyRequest, DevicePrincipal>,
): Promise<FastifyReply | null> {
  let principal: RequestPrincipal | null;
  try {
    principal = await authorize(request, routeID);
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

  principals.set(request, {
    userID: device.userID,
    deviceID: device.deviceID,
  });
  return null;
}

type DevicePrincipalResult =
  | {
      readonly ok: true;
      readonly userID: string;
      readonly deviceID: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'wrong-kind' | 'malformed';
    };

function readDevicePrincipal(value: unknown): DevicePrincipalResult {
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

  const userID = readUserID(principal.userID);
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

interface CommitBody {
  readonly revisionID: string;
  readonly uploadID: string;
  readonly parentRevisionID: string | null;
}

function readCommitBody(value: unknown): CommitBody | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const body = value as {
    readonly revisionID?: unknown;
    readonly uploadID?: unknown;
    readonly parentRevisionID?: unknown;
  };

  if (
    typeof body.revisionID !== 'string' ||
    !UUID_PATTERN.test(body.revisionID) ||
    typeof body.uploadID !== 'string' ||
    !UUID_PATTERN.test(body.uploadID)
  ) {
    return null;
  }

  let parentRevisionID: string | null;
  if (body.parentRevisionID === null) {
    parentRevisionID = null;
  } else if (
    typeof body.parentRevisionID === 'string' &&
    UUID_PATTERN.test(body.parentRevisionID)
  ) {
    parentRevisionID = body.parentRevisionID.toLowerCase();
  } else {
    return null;
  }

  return {
    revisionID: body.revisionID.toLowerCase(),
    uploadID: body.uploadID.toLowerCase(),
    parentRevisionID,
  };
}

function readProjectID(params: unknown): string | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return null;
  }
  const projectID = (params as { readonly projectID?: unknown }).projectID;
  if (typeof projectID !== 'string' || !UUID_PATTERN.test(projectID)) {
    return null;
  }
  return projectID.toLowerCase();
}

function readQuery(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

interface PageQuery {
  readonly after: string;
  readonly upperBound?: string;
  readonly limit: string;
}

function readPageQuery(query: Record<string, unknown>): PageQuery {
  const after = query.after;
  if (typeof after !== 'string' || !ASCII_DECIMAL_DIGITS.test(after)) {
    throw new RevisionRepositoryError('invalid-cursor');
  }

  const upperBound = query.upperBound;
  if (
    upperBound !== undefined &&
    (typeof upperBound !== 'string' ||
      !ASCII_DECIMAL_DIGITS.test(upperBound))
  ) {
    throw new RevisionRepositoryError('invalid-cursor');
  }

  const limit = query.limit;
  if (typeof limit !== 'string' || !CANONICAL_LIMIT.test(limit)) {
    throw new RevisionRepositoryError('invalid-page-limit');
  }

  return {
    after,
    ...(upperBound === undefined ? {} : { upperBound }),
    limit,
  };
}

function toCommitResponse(result: CommitRevisionResult): {
  revisionID: string;
  seq: string;
  headIDs: string[];
  conflict: boolean;
} {
  return {
    revisionID: result.revisionID,
    seq: result.seq,
    headIDs: [...result.headIDs],
    conflict: result.conflict,
  };
}

function toPageResponse(page: RevisionPage): {
  upperBound: string;
  nextAfter: string | null;
  hasMore: boolean;
  currentHeadIDs: string[];
  revisions: Array<{
    revisionID: string;
    parentRevisionID: string | null;
    seq: string;
    deviceID: string;
    keyEpoch: number;
    sizeBytes: number;
    ciphertextSha256: string;
    createdAt: string;
  }>;
} {
  return {
    upperBound: page.upperBound,
    nextAfter: page.nextAfter,
    hasMore: page.hasMore,
    currentHeadIDs: [...page.currentHeadIDs],
    revisions: page.revisions.map((revision) => ({
      revisionID: revision.revisionID,
      parentRevisionID: revision.parentRevisionID,
      seq: revision.seq,
      deviceID: revision.deviceID,
      keyEpoch: revision.keyEpoch,
      sizeBytes: revision.sizeBytes,
      ciphertextSha256: revision.ciphertextSha256,
      createdAt: revision.createdAt,
    })),
  };
}

function readUserID(value: unknown): string | null {
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

function sendInvalidRequest(
  reply: FastifyReply,
  requestID: string,
): FastifyReply {
  return reply
    .code(422)
    .send(
      revisionErrorEnvelope(
        'invalid-request',
        INVALID_REQUEST_MESSAGE,
        false,
        requestID,
      ),
    );
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
  return reply.code(403).send(
    revisionErrorEnvelope(
      'forbidden',
      FORBIDDEN_MESSAGE,
      false,
      requestID,
    ),
  );
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
      revisionErrorEnvelope(
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

const KNOWN_STATUS_CODES = new Set<number>([
  400, 401, 403, 404, 409, 422, 500, 503,
]);

function sendDomainError(
  reply: FastifyReply,
  requestID: string,
  error: unknown,
  retryAfterSeconds: number,
): FastifyReply {
  if (
    error instanceof RevisionRepositoryError &&
    KNOWN_STATUS_CODES.has(error.statusCode)
  ) {
    if (error.statusCode === 503) {
      void reply.header('Retry-After', String(retryAfterSeconds));
    }

    return reply.code(error.statusCode).send(
      revisionErrorEnvelope(
        error.code,
        error.message,
        error.retryable,
        requestID,
      ),
    );
  }

  return reply
    .code(500)
    .send(
      revisionErrorEnvelope(
        'internal-error',
        'An internal revision error occurred.',
        false,
        requestID,
      ),
    );
}

function readRetryAfterSeconds(options: RevisionRouteOptions): number {
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
