/**
 * Per-request native bearer authorization.
 *
 * The only accepted credential is exactly one `Authorization: Bearer <token>`
 * header whose token is a canonical 43-character unpadded base64url string.
 * Cookies, query values, body fields, client user headers, and redirects are
 * never consulted. Every call performs a primary-database lookup; there is no
 * cache, no memoisation, and no stale-replica fallback.
 *
 * A successful check requires all of:
 * - an existing access-token row for the domain-separated fingerprint;
 * - token expiry later than the injected server clock;
 * - an existing, active, unexpired parent grant;
 * - an extant device whose user matches the grant user;
 * - grant audience/resource equal to server configuration;
 * - every grant scope inside the configured allowlist;
 * - every scope configured for the requested route ID, which must be present.
 *
 * Scope/route failure is `forbidden`; every credential or grant failure is a
 * uniform `unauthenticated` result. Database failure is a retryable
 * `unavailable` result. Raw tokens, fingerprints, SQL, and driver errors are
 * never returned or logged.
 */

import type { PrismaClient } from '../../prisma/generated/client/client.js';
import { fingerprintCredential } from './credentials.js';
import type { NativeAuthAuthorizationPolicy } from './config.js';

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{43})$/;

export interface NativeBearerRequestHeaders {
  readonly authorization?: string | readonly string[] | undefined;
}

export interface NativeDevicePrincipal {
  readonly kind: 'device';
  readonly userID: string;
  readonly deviceID: string;
  readonly grantID: string;
}

export type NativeBearerFailureCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'unavailable';

export interface NativeBearerFailure {
  readonly ok: false;
  readonly code: NativeBearerFailureCode;
  readonly statusCode: 401 | 403 | 503;
  readonly message: string;
  readonly retryable: boolean;
}

export type NativeBearerAuthorizationResult =
  | { readonly ok: true; readonly principal: NativeDevicePrincipal }
  | NativeBearerFailure;

export type AuthorizeNativeBearer = (
  requestHeaders: NativeBearerRequestHeaders,
  routeID: string,
) => Promise<NativeBearerAuthorizationResult>;

export interface BearerEnforcementOptions {
  readonly policy: NativeAuthAuthorizationPolicy;
  /** Injected clock for deterministic expiry checks. */
  readonly now?: () => Date;
}

export interface BearerEnforcement {
  readonly authorizeBearer: AuthorizeNativeBearer;
}

export type BearerEnforcementClient = Pick<
  PrismaClient,
  'nativeAccessToken'
>;

interface AccessTokenLookupRow {
  readonly grantID: string;
  readonly expiresAt: Date;
  readonly grant: {
    readonly id: string;
    readonly userID: string;
    readonly status: 'active' | 'revoked';
    readonly audience: string;
    readonly resource: string;
    readonly scopes: string[];
    readonly expiresAt: Date;
    readonly device: {
      readonly id: string;
      readonly userID: string;
    } | null;
  };
}

/**
 * Build the per-request enforcement closure. The authorization policy is
 * validated before the client is used.
 */
export function createBearerEnforcement(
  client: BearerEnforcementClient,
  options: BearerEnforcementOptions,
): BearerEnforcement {
  const policy = readPolicy(options);
  const now = readClock(options.now);

  return Object.freeze({
    authorizeBearer: (
      requestHeaders: NativeBearerRequestHeaders,
      routeID: string,
    ) => authorizeBearer(client, policy, now, requestHeaders, routeID),
  });
}

async function authorizeBearer(
  client: BearerEnforcementClient,
  policy: NativeAuthAuthorizationPolicy,
  now: () => Date,
  requestHeaders: NativeBearerRequestHeaders,
  routeID: string,
): Promise<NativeBearerAuthorizationResult> {
  const token = readBearerToken(requestHeaders);
  if (token === null) {
    return unauthenticated();
  }

  if (
    typeof policy.requiredRouteScopes !== 'object' ||
    policy.requiredRouteScopes === null ||
    typeof routeID !== 'string' ||
    !Object.hasOwn(policy.requiredRouteScopes, routeID)
  ) {
    return forbidden();
  }

  const requiredScopes = policy.requiredRouteScopes[routeID];
  if (!Array.isArray(requiredScopes) || requiredScopes.length === 0) {
    return forbidden();
  }

  let fingerprint: string;
  try {
    fingerprint = fingerprintCredential('access', token);
  } catch {
    return unauthenticated();
  }

  let currentTime: Date;
  try {
    currentTime = now();
  } catch {
    return unavailable();
  }

  let row: AccessTokenLookupRow | null;
  try {
    row = await client.nativeAccessToken.findUnique({
      where: { fingerprint },
      select: {
        grantID: true,
        expiresAt: true,
        grant: {
          select: {
            id: true,
            userID: true,
            status: true,
            audience: true,
            resource: true,
            scopes: true,
            expiresAt: true,
            device: {
              select: {
                id: true,
                userID: true,
              },
            },
          },
        },
      },
    });
  } catch {
    return unavailable();
  }

  if (row === null) {
    return unauthenticated();
  }
  if (row.grantID !== row.grant.id) {
    return unauthenticated();
  }
  if (row.expiresAt.getTime() <= currentTime.getTime()) {
    return unauthenticated();
  }
  if (row.grant.status !== 'active') {
    return unauthenticated();
  }
  if (row.grant.expiresAt.getTime() <= currentTime.getTime()) {
    return unauthenticated();
  }

  const device = row.grant.device;
  if (
    device === null ||
    typeof device.id !== 'string' ||
    device.id.length === 0 ||
    device.userID !== row.grant.userID
  ) {
    return unauthenticated();
  }

  if (
    row.grant.audience !== policy.audience ||
    row.grant.resource !== policy.resource
  ) {
    return unauthenticated();
  }

  const allowedScopes = new Set(policy.allowedScopes);
  if (row.grant.scopes.some((scope) => !allowedScopes.has(scope))) {
    return unauthenticated();
  }
  if (requiredScopes.some((scope) => !row.grant.scopes.includes(scope))) {
    return forbidden();
  }

  return Object.freeze({
    ok: true as const,
    principal: Object.freeze({
      kind: 'device' as const,
      userID: row.grant.userID,
      deviceID: device.id,
      grantID: row.grant.id,
    }),
  });
}

function readBearerToken(
  requestHeaders: NativeBearerRequestHeaders,
): string | null {
  if (
    typeof requestHeaders !== 'object' ||
    requestHeaders === null ||
    Array.isArray(requestHeaders)
  ) {
    return null;
  }

  const authorization = requestHeaders.authorization;
  if (typeof authorization !== 'string') {
    return null;
  }

  const match = BEARER_PATTERN.exec(authorization);
  if (match === null) {
    return null;
  }

  const token = match[1];
  try {
    // Full canonical decoding/length validation is performed here; a token
    // that merely matches the character class still has to re-encode exactly.
    fingerprintCredential('access', token);
  } catch {
    return null;
  }
  return token;
}

function readPolicy(options: BearerEnforcementOptions): NativeAuthAuthorizationPolicy {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    typeof options.policy !== 'object' ||
    options.policy === null
  ) {
    throw new TypeError('Invalid native bearer enforcement options.');
  }

  const policy = options.policy;
  if (
    typeof policy.audience !== 'string' ||
    policy.audience.length === 0 ||
    typeof policy.resource !== 'string' ||
    policy.resource.length === 0 ||
    !Array.isArray(policy.allowedScopes) ||
    policy.allowedScopes.length === 0 ||
    policy.allowedScopes.some(
      (scope) => typeof scope !== 'string' || scope.length === 0,
    ) ||
    typeof policy.requiredRouteScopes !== 'object' ||
    policy.requiredRouteScopes === null ||
    Array.isArray(policy.requiredRouteScopes)
  ) {
    throw new TypeError('Invalid native bearer enforcement options.');
  }

  for (const scopes of Object.values(policy.requiredRouteScopes)) {
    if (
      !Array.isArray(scopes) ||
      scopes.length === 0 ||
      scopes.some((scope) => typeof scope !== 'string' || scope.length === 0)
    ) {
      throw new TypeError('Invalid native bearer enforcement options.');
    }
  }

  return policy;
}

function readClock(clock: (() => Date) | undefined): () => Date {
  if (clock === undefined) {
    return () => new Date();
  }
  if (typeof clock !== 'function') {
    throw new TypeError('Invalid native bearer enforcement options.');
  }
  return () => {
    let value: unknown;
    try {
      value = clock();
    } catch {
      throw new TypeError('Native bearer clock is unavailable.');
    }
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError('Native bearer clock is unavailable.');
    }
    return new Date(value.getTime());
  };
}

function unauthenticated(): NativeBearerFailure {
  return Object.freeze({
    ok: false as const,
    code: 'unauthenticated' as const,
    statusCode: 401 as const,
    message: 'Authentication is required.',
    retryable: false,
  });
}

function forbidden(): NativeBearerFailure {
  return Object.freeze({
    ok: false as const,
    code: 'forbidden' as const,
    statusCode: 403 as const,
    message: 'The request is not permitted.',
    retryable: false,
  });
}

function unavailable(): NativeBearerFailure {
  return Object.freeze({
    ok: false as const,
    code: 'unavailable' as const,
    statusCode: 503 as const,
    message: 'The service is not ready.',
    retryable: true,
  });
}
