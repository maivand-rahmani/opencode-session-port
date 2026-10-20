/**
 * Explicit `GET /v1/me` route.
 *
 * This module does not implement native authentication and is not mounted in
 * the API bootstrap. It accepts a server-owned `authorize` callback that is
 * invoked in `onRequest`, before any body parsing, with the fixed action
 * `me.read`. The callback may return a device or browser principal; both are
 * represented by the trusted `userID` field only.
 *
 * No header, cookie, bearer token, query parameter, or body value is used as a
 * principal. The callback is responsible for validating the real credential.
 * Omitting the dependency leaves the API-wide `/v1` denial untouched.
 *
 * Error envelopes are local and fixed. Domain codes such as
 * `quota-not-provisioned` are allowed without editing the shared `ApiErrorCode`
 * union used by transport-level errors.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requestAuthorizationEnvelope } from '../protocol/principal.js';
import { MeRepositoryError, type MeRepository } from './repository.js';

const AUTHENTICATION_REQUIRED_MESSAGE = 'Authentication is required.';
const AUTH_UNAVAILABLE_MESSAGE = 'The authentication service is unavailable.';
const ME_UNAVAILABLE_MESSAGE = 'The usage service is temporarily unavailable.';
const INVALID_DEPENDENCY_MESSAGE = 'Invalid me API dependency.';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const READ_ACTION = 'me.read' as const;

export interface MeRequestPrincipal {
  readonly userID: string;
}

/**
 * Server-owned principal resolver. It receives the Fastify request and the
 * fixed action only; no caller-controlled identity value is passed.
 */
export type AuthorizeMeRead = (
  request: FastifyRequest,
  action: typeof READ_ACTION,
) => Promise<MeRequestPrincipal | null>;

export interface MeApiDependencies {
  readonly repository: MeRepository;
  readonly authorize: AuthorizeMeRead;
  readonly retryAfterSeconds: number;
}

interface LocalErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly requestID: string;
  };
}

/**
 * Validate dependencies at registration time. A malformed dependency fails
 * closed instead of producing an unauthenticated or malformed route.
 */
export function readMeDependency(value: unknown): MeApiDependencies {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidDependency();
  }

  const candidate = value as {
    readonly repository?: unknown;
    readonly authorize?: unknown;
    readonly retryAfterSeconds?: unknown;
  };

  const repository = candidate.repository;
  if (
    typeof repository !== 'object' ||
    repository === null ||
    Array.isArray(repository) ||
    typeof (repository as { readonly read?: unknown }).read !== 'function'
  ) {
    throw invalidDependency();
  }
  if (typeof candidate.authorize !== 'function') {
    throw invalidDependency();
  }
  if (
    typeof candidate.retryAfterSeconds !== 'number' ||
    !Number.isSafeInteger(candidate.retryAfterSeconds) ||
    candidate.retryAfterSeconds < 0
  ) {
    throw invalidDependency();
  }

  return Object.freeze({
    repository: repository as MeRepository,
    authorize: candidate.authorize as AuthorizeMeRead,
    retryAfterSeconds: candidate.retryAfterSeconds,
  });
}

/**
 * Register the single authenticated `GET /v1/me` route. The caller owns app
 * mounting; this function does not add the route to `createApi`.
 */
export function registerMeRoutes(
  app: FastifyInstance,
  dependencies: MeApiDependencies,
): void {
  const me = readMeDependency(dependencies);
  // Per-request principal storage; no process-wide authentication state.
  const principals = new WeakMap<FastifyRequest, string>();

  app.get(
    '/v1/me',
    {
      onRequest: async (request, reply) => {
        let principal: unknown;
        try {
          principal = await me.authorize(request, READ_ACTION);
        } catch (error) {
          return sendAuthorizationFailure(
            reply,
            request.id,
            error,
            me.retryAfterSeconds,
          );
        }

        if (principal === null) {
          return sendUnauthenticated(reply, request.id);
        }

        const userID = readPrincipalUserID(principal);
        if (userID === null) {
          return sendAuthUnavailable(reply, request.id, me.retryAfterSeconds);
        }

        principals.set(request, userID);
      },
    },
    async (request, reply) => {
      const userID = principals.get(request);
      if (userID === undefined) {
        return sendAuthUnavailable(reply, request.id, me.retryAfterSeconds);
      }

      try {
        const result = await me.repository.read(userID);
        return reply.code(200).send(result);
      } catch (error) {
        return sendRepositoryError(
          reply,
          request.id,
          error,
          me.retryAfterSeconds,
        );
      }
    },
  );
}

function readPrincipalUserID(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const userID = (value as { readonly userID?: unknown }).userID;
  if (
    typeof userID !== 'string' ||
    userID.length === 0 ||
    userID.length > 1_024 ||
    userID.trim().length === 0 ||
    CONTROL_CHARACTERS.test(userID)
  ) {
    return null;
  }

  return userID;
}

function sendUnauthenticated(
  reply: FastifyReply,
  requestID: string,
): FastifyReply {
  return reply
    .code(401)
    .send(
      envelope(
        'unauthenticated',
        AUTHENTICATION_REQUIRED_MESSAGE,
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
      envelope(
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
  const { failure, envelope: failureEnvelope } =
    requestAuthorizationEnvelope(error, requestID);
  if (failure.statusCode === 503) {
    void reply.header('Retry-After', String(retryAfterSeconds));
  }
  return reply.code(failure.statusCode).send(failureEnvelope);
}

function sendRepositoryError(
  reply: FastifyReply,
  requestID: string,
  error: unknown,
  retryAfterSeconds: number,
): FastifyReply {
  if (
    error instanceof MeRepositoryError &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
  ) {
    if (error.statusCode === 503) {
      void reply.header('Retry-After', String(retryAfterSeconds));
    }

    return reply
      .code(error.statusCode)
      .send(
        envelope(error.code, error.message, error.retryable, requestID),
      );
  }

  return reply
    .header('Retry-After', String(retryAfterSeconds))
    .code(503)
    .send(
      envelope('unavailable', ME_UNAVAILABLE_MESSAGE, true, requestID),
    );
}

function envelope(
  code: string,
  message: string,
  retryable: boolean,
  requestID: string,
): LocalErrorEnvelope {
  return { error: { code, message, retryable, requestID } };
}

function invalidDependency(): TypeError {
  return new TypeError(INVALID_DEPENDENCY_MESSAGE);
}
