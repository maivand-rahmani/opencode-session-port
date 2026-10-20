/**
 * Shared, transport-neutral principal and authorization typing.
 *
 * This module deliberately contains types only. It has no resolver
 * implementation, no header/body parsing, and no allow-all default. The
 * server-owned resolver is responsible for verifying the native device grant
 * or browser session and for enforcing the scope policy for each route ID.
 *
 * `RequestPrincipal` is the only identity shape route handlers may rely on.
 * Client-supplied headers, cookies, query strings, and bodies are never
 * authoritative and must not be converted into one of these values inside a
 * route.
 */

import type { FastifyRequest } from 'fastify';

export type RequestPrincipal =
  | {
      readonly kind: 'device';
      readonly userID: string;
      readonly deviceID: string;
      readonly grantID?: string;
    }
  | {
      readonly kind: 'browser';
      readonly userID: string;
    };

/**
 * Route IDs passed to the server-owned resolver. Scope policy lives with the
 * resolver; the route modules only declare which ID they are exercising.
 */
export type AuthorizeRouteID =
  | 'projects.create'
  | 'projects.list'
  | 'revisions.list'
  | 'revisions.commit'
  | 'me.read';

/**
 * Server-owned authorization callback. It receives the Fastify request and
 * the exact route ID being authorized; it must never trust a header, query
 * value, or body field as a principal source.
 */
export type AuthorizeRequest = (
  request: FastifyRequest,
  routeID: string,
) => Promise<RequestPrincipal | null>;

export type RequestAuthorizationFailureCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'unavailable';

interface RequestAuthorizationFailureDefinition {
  readonly statusCode: 401 | 403 | 503;
  readonly retryable: boolean;
  readonly message: string;
}

const AUTHORIZATION_FAILURES: Readonly<
  Record<RequestAuthorizationFailureCode, RequestAuthorizationFailureDefinition>
> = Object.freeze({
  unauthenticated: {
    statusCode: 401,
    retryable: false,
    message: 'Authentication is required.',
  },
  forbidden: {
    statusCode: 403,
    retryable: false,
    message: 'The request is not permitted.',
  },
  unavailable: {
    statusCode: 503,
    retryable: true,
    message: 'The authentication service is unavailable.',
  },
});

/**
 * Fixed authorization failure shared by all route resolvers. Only these three
 * codes and statuses are accepted; arbitrary thrown status values and vendor
 * error text are never propagated.
 */
export class RequestAuthorizationError extends Error {
  readonly code: RequestAuthorizationFailureCode;
  readonly statusCode: 401 | 403 | 503;
  readonly retryable: boolean;

  constructor(code: RequestAuthorizationFailureCode) {
    const definition = AUTHORIZATION_FAILURES[code];
    super(definition.message);
    this.name = 'RequestAuthorizationError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.retryable = definition.retryable;
  }
}

/**
 * Map any authorizer-thrown value to the fixed failure catalogue. Unknown
 * throws stay retryable 503; arbitrary `statusCode` properties are ignored.
 */
export function toRequestAuthorizationFailure(
  error: unknown,
): RequestAuthorizationError {
  return error instanceof RequestAuthorizationError
    ? error
    : new RequestAuthorizationError('unavailable');
}

export interface RequestAuthorizationEnvelope {
  readonly error: {
    readonly code: RequestAuthorizationFailureCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly requestID: string;
  };
}

export function requestAuthorizationEnvelope(
  error: unknown,
  requestID: string,
): { readonly failure: RequestAuthorizationError; readonly envelope: RequestAuthorizationEnvelope } {
  const failure = toRequestAuthorizationFailure(error);
  return {
    failure,
    envelope: {
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        requestID,
      },
    },
  };
}
