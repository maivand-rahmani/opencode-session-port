/**
 * Native-auth lifecycle service.
 *
 * This is the only module that generates raw native credentials and human
 * codes. Raw values are returned in response DTOs after the repository
 * transaction that persisted only their digests/fingerprints has committed.
 * They are never logged, cached, or persisted here.
 *
 * Fixed lifecycle rules:
 * - Creation stores server-owned audience/resource/scopes and ignores any
 *   client identity or metadata.
 * - Pending approval binds the authoritative browser user and is allowed once.
 * - Denial is terminal.
 * - Exchange consumes the pending row and creates the grant, device, access
 *   token, and refresh token in one transaction. Raw tokens are returned only
 *   after that transaction commits.
 * - Replay of a spent refresh token commits grant revocation first; the public
 *   replay error is thrown after the transaction returns.
 * - Revocation is user-scoped and unknown/foreign grants are the same 404.
 *
 * The configured global pending cap applies to public creation. The configured
 * per-user pending cap is enforced during approval, after the authoritative
 * browser user has been bound, using the same SERIALIZABLE transaction that
 * locks the pending row and counts unexpired approved rows for that user.
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../../prisma/generated/client/client.js';
import type {
  NativeAuthConfig,
  NativeAuthPolicy,
  NativePollingPolicy,
} from './config.js';
import {
  generateCredential,
  fingerprintCredential,
  type CredentialKind,
} from './credentials.js';
import {
  HumanCodeError,
  HumanCodeKeyRing,
  type HumanCodeDigest,
  generateHumanCode,
  normalizeHumanCode,
} from './human-codes.js';
import {
  createBearerEnforcement,
  type AuthorizeNativeBearer,
  type NativeBearerAuthorizationResult,
  type NativeBearerRequestHeaders,
} from './enforcement.js';
import {
  NativeAuthRepositoryError,
  createNativeAuthRepository,
  type DecidePendingAuthorizationOutcome,
  type ExchangeDeviceCodeOutcome,
  type GrantListRow,
  type NativeAuthRepository,
  type NativeAuthRepositoryClient,
  type NativeAuthRepositoryOptions,
  type PendingAuthorizationRow,
  type RevokeGrantOutcome,
  type RotateRefreshTokenOutcome,
} from './repository.js';

const MAX_USER_ID_LENGTH = 1_024;
const HUMAN_CODE_COLLISION_RETRIES = 8;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type NativeAuthServiceErrorCode =
  | 'invalid-request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'invalid-credential'
  | 'authorization-pending'
  | 'slow-down'
  | 'authorization-denied'
  | 'authorization-expired'
  | 'authorization-consumed'
  | 'refresh-replay'
  | 'state-conflict'
  | 'rate-limited'
  | 'quota-not-provisioned'
  | 'unavailable'
  | 'internal-error';

interface NativeAuthServiceErrorDefinition {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly message: string;
}

const ERROR_DEFINITIONS: Readonly<
  Record<NativeAuthServiceErrorCode, NativeAuthServiceErrorDefinition>
> = Object.freeze({
  'invalid-request': {
    statusCode: 400,
    retryable: false,
    message: 'The request is invalid.',
  },
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
  'not-found': {
    statusCode: 404,
    retryable: false,
    message: 'The requested resource was not found.',
  },
  'invalid-credential': {
    statusCode: 401,
    retryable: false,
    message: 'The credential is invalid.',
  },
  'authorization-pending': {
    statusCode: 400,
    retryable: true,
    message: 'Authorization is pending.',
  },
  'slow-down': {
    statusCode: 429,
    retryable: true,
    message: 'Polling must slow down.',
  },
  'authorization-denied': {
    statusCode: 403,
    retryable: false,
    message: 'Authorization was denied.',
  },
  'authorization-expired': {
    statusCode: 410,
    retryable: false,
    message: 'Authorization expired.',
  },
  'authorization-consumed': {
    statusCode: 409,
    retryable: false,
    message: 'Authorization was already consumed.',
  },
  'refresh-replay': {
    statusCode: 401,
    retryable: false,
    message: 'The refresh credential was already used.',
  },
  'state-conflict': {
    statusCode: 409,
    retryable: false,
    message: 'The authorization state conflicts with the request.',
  },
  'rate-limited': {
    statusCode: 429,
    retryable: true,
    message: 'Too many requests. Try again later.',
  },
  'quota-not-provisioned': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota is not provisioned.',
  },
  unavailable: {
    statusCode: 503,
    retryable: true,
    message: 'The service is not ready.',
  },
  'internal-error': {
    statusCode: 500,
    retryable: false,
    message: 'An internal error occurred.',
  },
});

export class NativeAuthServiceError extends Error {
  readonly code: NativeAuthServiceErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: NativeAuthServiceErrorCode,
    retryAfterSeconds?: number,
  ) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = 'NativeAuthServiceError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.retryable = definition.retryable;
    this.retryAfterSeconds =
      typeof retryAfterSeconds === 'number' &&
      Number.isSafeInteger(retryAfterSeconds) &&
      retryAfterSeconds >= 0
        ? retryAfterSeconds
        : undefined;
  }
}

export interface NativeBrowserAccount {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface NativeDeviceAuthorizationResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly pollInterval: number;
}

export interface NativeConsentResponse {
  readonly consent: {
    readonly account: NativeBrowserAccount;
    readonly scopes: readonly string[];
    readonly expiresAt: string;
  };
}

export interface NativeTokenResponse {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly scope: string;
}

export interface NativeGrantView {
  readonly id: string;
  readonly deviceID: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
  readonly status: 'active' | 'revoked';
}

export interface NativeGrantsResponse {
  readonly grants: readonly NativeGrantView[];
}

export interface NativeDecisionResponse {
  readonly status: 'approved' | 'denied';
}

export interface NativeRevokeResponse {
  readonly status: 'revoked';
}

export interface NativeAuthServiceOptions {
  readonly config: NativeAuthConfig;
  /** Explicit global pending cap. There is no environment default. */
  readonly repositoryPolicy: Pick<
    NativeAuthRepositoryOptions,
    'maxOutstandingPendingAuthorizationsGlobal'
  >;
  /** Injected clock for deterministic lifecycle tests. */
  readonly now?: () => Date;
  /** Focused-test injection seams; production uses the crypto helpers. */
  readonly generateHumanCode?: () => string;
  readonly generateCredential?: (kind: CredentialKind) => string;
  readonly generateID?: () => string;
}

export interface NativeAuthService {
  createDeviceAuthorization(): Promise<NativeDeviceAuthorizationResponse>;
  verifyUserCode(
    userCode: string,
    account: NativeBrowserAccount,
  ): Promise<NativeConsentResponse>;
  approveUserCode(
    userCode: string,
    userID: string,
  ): Promise<NativeDecisionResponse>;
  denyUserCode(userCode: string): Promise<NativeDecisionResponse>;
  exchangeDeviceCode(deviceCode: string): Promise<NativeTokenResponse>;
  refreshToken(refreshToken: string): Promise<NativeTokenResponse>;
  listGrants(userID: string): Promise<NativeGrantsResponse>;
  revokeGrant(userID: string, grantID: string): Promise<NativeRevokeResponse>;
  authorizeBearer(
    requestHeaders: NativeBearerRequestHeaders,
    routeID: string,
  ): Promise<NativeBearerAuthorizationResult>;
}

export type NativeAuthServiceClient = NativeAuthRepositoryClient;

interface NormalizedConfig {
  readonly config: NativeAuthConfig;
  readonly policy: NativeAuthPolicy;
  readonly polling: NativePollingPolicy;
  readonly humanCodes: HumanCodeKeyRing;
}

/**
 * Build the service. Invalid options fail closed at construction.
 */
export function createNativeAuthService(
  client: NativeAuthServiceClient,
  options: NativeAuthServiceOptions,
): NativeAuthService {
  const normalized = readServiceOptions(options);
  const clock = readClock(options.now);
  const generateHumanCodeValue =
    options.generateHumanCode ?? (() => generateHumanCode());
  const generateCredentialValue =
    options.generateCredential ??
    ((kind: CredentialKind) => generateCredential(kind));
  const generateIDValue = options.generateID ?? (() => randomUUID());

  let repository: NativeAuthRepository;
  try {
    repository = createNativeAuthRepository(client, {
      maxOutstandingPendingAuthorizationsGlobal:
        options.repositoryPolicy.maxOutstandingPendingAuthorizationsGlobal,
      maxOutstandingPendingAuthorizationsPerUser:
        options.config.policy.capacity.maxOutstandingPendingAuthorizationsPerUser,
    });
  } catch {
    throw new TypeError('Invalid native-auth service options.');
  }

  const enforcement = createBearerEnforcement(client as PrismaClient, {
    policy: normalized.policy.authorization,
    now: clock,
  });

  const service: NativeAuthService = {
    createDeviceAuthorization: () =>
      createDeviceAuthorization(
        repository,
        normalized,
        clock,
        generateHumanCodeValue,
        generateCredentialValue,
        generateIDValue,
      ),
    verifyUserCode: (userCode: string, account: NativeBrowserAccount) =>
      verifyUserCode(repository, normalized, clock, userCode, account),
    approveUserCode: (userCode: string, userID: string) =>
      approveUserCode(repository, normalized, clock, userCode, userID),
    denyUserCode: (userCode: string) =>
      denyUserCode(repository, normalized, clock, userCode),
    exchangeDeviceCode: (deviceCode: string) =>
      exchangeDeviceCode(
        repository,
        normalized,
        clock,
        generateCredentialValue,
        generateIDValue,
        deviceCode,
      ),
    refreshToken: (value: string) =>
      refreshToken(
        repository,
        normalized,
        clock,
        generateCredentialValue,
        generateIDValue,
        value,
      ),
    listGrants: (userID: string) => listGrants(repository, userID),
    revokeGrant: (userID: string, grantID: string) =>
      revokeGrant(repository, userID, grantID, clock),
    authorizeBearer: (
      requestHeaders: NativeBearerRequestHeaders,
      routeID: string,
    ) => enforcement.authorizeBearer(requestHeaders, routeID),
  };

  return Object.freeze(service);
}

async function createDeviceAuthorization(
  repository: NativeAuthRepository,
  config: NormalizedConfig,
  clock: () => Date,
  generateHumanCodeValue: () => string,
  generateCredentialValue: (kind: CredentialKind) => string,
  generateIDValue: () => string,
): Promise<NativeDeviceAuthorizationResponse> {
  const now = clock();
  const expiresAt = addSeconds(now, config.policy.ttlSeconds.pendingAuthorization);
  let lastFailure: 'collision' | 'unavailable' = 'collision';

  // Initial attempt plus at most eight P2002 collision retries.
  for (
    let attempt = 0;
    attempt <= HUMAN_CODE_COLLISION_RETRIES;
    attempt += 1
  ) {
    const userCode = readGeneratedHumanCode(generateHumanCodeValue);
    const digest = digestForCreation(config.humanCodes, userCode, now);
    const deviceCode = readGeneratedCredential(
      generateCredentialValue('device'),
    );
    const deviceCodeFingerprint = fingerprintGenerated(
      'device',
      deviceCode,
    );

    try {
      await repository.createPendingAuthorization({
        id: readGeneratedID(generateIDValue),
        deviceCodeFingerprint,
        humanCodeDigest: digest.digest,
        humanCodeKeyID: digest.keyID,
        audience: config.policy.authorization.audience,
        resource: config.policy.authorization.resource,
        scopes: config.policy.authorization.allowedScopes,
        createdAt: now,
        expiresAt,
        pollIntervalSeconds: config.polling.intervalSeconds,
      });

      return Object.freeze({
        deviceCode,
        userCode,
        verificationUri: config.config.verificationUri,
        expiresIn: config.policy.ttlSeconds.pendingAuthorization,
        pollInterval: config.polling.intervalSeconds,
      });
    } catch (error) {
      if (error instanceof NativeAuthRepositoryError) {
        if (error.code === 'unique-collision') {
          lastFailure = 'collision';
          continue;
        }
        if (error.code === 'capacity-reached') {
          throw new NativeAuthServiceError(
            'rate-limited',
            config.polling.intervalSeconds,
          );
        }
        if (error.code === 'invalid-input') {
          throw new NativeAuthServiceError('internal-error');
        }
      }
      lastFailure = 'unavailable';
      break;
    }
  }

  // Only generated pending-row collisions are retried, and only here. A
  // transaction/serialization failure is never retried.
  throw new NativeAuthServiceError(
    'unavailable',
    lastFailure === 'unavailable' ? undefined : config.polling.intervalSeconds,
  );
}

async function verifyUserCode(
  repository: NativeAuthRepository,
  config: NormalizedConfig,
  clock: () => Date,
  rawUserCode: string,
  rawAccount: NativeBrowserAccount,
): Promise<NativeConsentResponse> {
  const account = readAccount(rawAccount);
  const now = clock();
  const candidates = digestCandidates(config.humanCodes, rawUserCode, now);
  let pending: PendingAuthorizationRow | null;
  try {
    pending = await repository.findVerificationPending(candidates, now);
  } catch (error) {
    return throwRepositoryFailure(error);
  }
  if (pending === null) {
    throw new NativeAuthServiceError('not-found');
  }

  return Object.freeze({
    consent: Object.freeze({
      account,
      scopes: Object.freeze([...pending.scopes]),
      expiresAt: pending.expiresAt.toISOString(),
    }),
  });
}

async function approveUserCode(
  repository: NativeAuthRepository,
  config: NormalizedConfig,
  clock: () => Date,
  rawUserCode: string,
  rawUserID: string,
): Promise<NativeDecisionResponse> {
  const userID = readUserID(rawUserID);
  const now = clock();
  const candidates = digestCandidates(config.humanCodes, rawUserCode, now);
  if (candidates.length === 0) {
    throw new NativeAuthServiceError('not-found');
  }
  let outcome: DecidePendingAuthorizationOutcome;
  try {
    outcome = await repository.decidePendingAuthorization({
      candidates,
      decision: 'approve',
      userID,
      at: now,
    });
  } catch (error) {
    return throwRepositoryFailure(error, config.polling.intervalSeconds);
  }

  switch (outcome.kind) {
    case 'approved':
      return Object.freeze({ status: 'approved' as const });
    case 'expired':
      throw new NativeAuthServiceError('authorization-expired');
    case 'not-found':
      throw new NativeAuthServiceError('not-found');
    case 'state-conflict':
    case 'denied':
      throw new NativeAuthServiceError('state-conflict');
    default:
      throw new NativeAuthServiceError('unavailable');
  }
}

async function denyUserCode(
  repository: NativeAuthRepository,
  config: NormalizedConfig,
  clock: () => Date,
  rawUserCode: string,
): Promise<NativeDecisionResponse> {
  const now = clock();
  const candidates = digestCandidates(config.humanCodes, rawUserCode, now);
  if (candidates.length === 0) {
    throw new NativeAuthServiceError('not-found');
  }
  let outcome: DecidePendingAuthorizationOutcome;
  try {
    outcome = await repository.decidePendingAuthorization({
      candidates,
      decision: 'deny',
      at: now,
    });
  } catch (error) {
    return throwRepositoryFailure(error);
  }

  switch (outcome.kind) {
    case 'denied':
      return Object.freeze({ status: 'denied' as const });
    case 'expired':
      throw new NativeAuthServiceError('authorization-expired');
    case 'not-found':
      throw new NativeAuthServiceError('not-found');
    case 'state-conflict':
    case 'approved':
      throw new NativeAuthServiceError('state-conflict');
    default:
      throw new NativeAuthServiceError('unavailable');
  }
}

async function exchangeDeviceCode(
  repository: NativeAuthRepository,
  config: NormalizedConfig,
  clock: () => Date,
  generateCredentialValue: (kind: CredentialKind) => string,
  generateIDValue: () => string,
  rawDeviceCode: string,
): Promise<NativeTokenResponse> {
  const deviceCodeFingerprint = fingerprintInput('device', rawDeviceCode);
  const now = clock();
  const grantExpiresAt = addSeconds(now, config.policy.ttlSeconds.grant);
  const accessExpiresAt = earlierDate(
    addSeconds(now, config.policy.ttlSeconds.accessToken),
    grantExpiresAt,
  );
  const refreshExpiresAt = earlierDate(
    addSeconds(now, config.policy.ttlSeconds.refreshToken),
    grantExpiresAt,
  );

  const accessToken = readGeneratedCredential(
    generateCredentialValue('access'),
  );
  const refreshToken = readGeneratedCredential(
    generateCredentialValue('refresh'),
  );

  let outcome: ExchangeDeviceCodeOutcome;
  try {
    outcome = await repository.exchangeDeviceCode({
      deviceCodeFingerprint,
      now,
      grantID: readGeneratedID(generateIDValue),
      deviceID: readGeneratedID(generateIDValue),
      grantExpiresAt,
      access: {
        id: readGeneratedID(generateIDValue),
        fingerprint: fingerprintGenerated('access', accessToken),
        expiresAt: accessExpiresAt,
      },
      refresh: {
        id: readGeneratedID(generateIDValue),
        fingerprint: fingerprintGenerated('refresh', refreshToken),
        expiresAt: refreshExpiresAt,
      },
      polling: config.polling,
      maxActiveGrantsPerUser:
        config.policy.capacity.maxActiveGrantsPerUser,
    });
  } catch (error) {
    return throwRepositoryFailure(error);
  }

  switch (outcome.kind) {
    case 'tokens':
      return tokenResponse(accessToken, refreshToken, outcome.expiresIn, outcome.scope);
    case 'authorization-pending':
      throw new NativeAuthServiceError(
        'authorization-pending',
        outcome.retryAfterSeconds,
      );
    case 'slow-down':
      throw new NativeAuthServiceError('slow-down', outcome.retryAfterSeconds);
    case 'authorization-denied':
      throw new NativeAuthServiceError('authorization-denied');
    case 'authorization-expired':
      throw new NativeAuthServiceError('authorization-expired');
    case 'authorization-consumed':
      throw new NativeAuthServiceError('authorization-consumed');
    case 'quota-not-provisioned':
      throw new NativeAuthServiceError('quota-not-provisioned');
    case 'invalid-credential':
      throw new NativeAuthServiceError('invalid-credential');
    case 'active-grant-limit':
    case 'state-conflict':
      throw new NativeAuthServiceError('state-conflict');
    default:
      throw new NativeAuthServiceError('unavailable');
  }
}

async function refreshToken(
  repository: NativeAuthRepository,
  config: NormalizedConfig,
  clock: () => Date,
  generateCredentialValue: (kind: CredentialKind) => string,
  generateIDValue: () => string,
  rawRefreshToken: string,
): Promise<NativeTokenResponse> {
  const refreshTokenFingerprint = fingerprintInput(
    'refresh',
    rawRefreshToken,
  );
  const now = clock();
  const accessToken = readGeneratedCredential(
    generateCredentialValue('access'),
  );
  const newRefreshToken = readGeneratedCredential(
    generateCredentialValue('refresh'),
  );

  let outcome: RotateRefreshTokenOutcome;
  try {
    outcome = await repository.rotateRefreshToken({
      refreshTokenFingerprint,
      now,
      access: {
        id: readGeneratedID(generateIDValue),
        fingerprint: fingerprintGenerated('access', accessToken),
      },
      refresh: {
        id: readGeneratedID(generateIDValue),
        fingerprint: fingerprintGenerated('refresh', newRefreshToken),
      },
      accessTokenTTLSeconds: config.policy.ttlSeconds.accessToken,
      refreshTokenTTLSeconds: config.policy.ttlSeconds.refreshToken,
    });
  } catch (error) {
    return throwRepositoryFailure(error);
  }

  switch (outcome.kind) {
    case 'tokens':
      return tokenResponse(
        accessToken,
        newRefreshToken,
        outcome.expiresIn,
        outcome.scope,
      );
    case 'replay':
      // The repository transaction has already committed grant revocation.
      throw new NativeAuthServiceError('refresh-replay');
    case 'invalid-credential':
      throw new NativeAuthServiceError('invalid-credential');
    default:
      throw new NativeAuthServiceError('unavailable');
  }
}

async function listGrants(
  repository: NativeAuthRepository,
  rawUserID: string,
): Promise<NativeGrantsResponse> {
  const userID = readUserID(rawUserID);
  let rows: readonly GrantListRow[];
  try {
    rows = await repository.listGrants(userID);
  } catch (error) {
    return throwRepositoryFailure(error);
  }
  return Object.freeze({
    grants: Object.freeze(rows.map(toGrantView)),
  });
}

async function revokeGrant(
  repository: NativeAuthRepository,
  rawUserID: string,
  rawGrantID: string,
  clock: () => Date,
): Promise<NativeRevokeResponse> {
  const userID = readUserID(rawUserID);
  if (typeof rawGrantID !== 'string' || !UUID_PATTERN.test(rawGrantID)) {
    throw new NativeAuthServiceError('not-found');
  }

  let outcome: RevokeGrantOutcome;
  try {
    outcome = await repository.revokeGrant(
      userID,
      rawGrantID.toLowerCase(),
      clock(),
    );
  } catch (error) {
    return throwRepositoryFailure(error);
  }
  if (outcome.kind === 'not-found') {
    throw new NativeAuthServiceError('not-found');
  }
  return Object.freeze({ status: 'revoked' as const });
}

function toGrantView(row: GrantListRow): NativeGrantView {
  return Object.freeze({
    id: row.id,
    deviceID: row.deviceID,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    status: row.status,
  });
}

function tokenResponse(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string,
): NativeTokenResponse {
  return Object.freeze({
    accessToken,
    tokenType: 'Bearer' as const,
    expiresIn,
    refreshToken,
    scope,
  });
}

function readServiceOptions(
  options: NativeAuthServiceOptions,
): NormalizedConfig {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    typeof options.config !== 'object' ||
    options.config === null
  ) {
    throw new TypeError('Invalid native-auth service options.');
  }

  const config = options.config;
  const policy = config.policy;
  if (
    typeof policy !== 'object' ||
    policy === null ||
    typeof config.verificationUri !== 'string' ||
    config.verificationUri.length === 0 ||
    !isPositiveSafeInteger(policy.ttlSeconds?.pendingAuthorization) ||
    !isPositiveSafeInteger(policy.ttlSeconds?.accessToken) ||
    !isPositiveSafeInteger(policy.ttlSeconds?.refreshToken) ||
    !isPositiveSafeInteger(policy.ttlSeconds?.grant) ||
    policy.ttlSeconds.accessToken > policy.ttlSeconds.grant ||
    policy.ttlSeconds.refreshToken > policy.ttlSeconds.grant ||
    !isPositiveSafeInteger(policy.polling?.intervalSeconds) ||
    !isPositiveSafeInteger(policy.polling?.backoffIncrementSeconds) ||
    !isPositiveSafeInteger(policy.polling?.maxIntervalSeconds) ||
    policy.polling.maxIntervalSeconds < policy.polling.intervalSeconds ||
    policy.polling.backoffIncrementSeconds > policy.polling.maxIntervalSeconds ||
    !isPositiveSafeInteger(policy.capacity?.maxActiveGrantsPerUser) ||
    !isPositiveSafeInteger(
      policy.capacity?.maxOutstandingPendingAuthorizationsPerUser,
    ) ||
    typeof policy.authorization !== 'object' ||
    policy.authorization === null
  ) {
    throw new TypeError('Invalid native-auth service options.');
  }

  if (
    typeof options.repositoryPolicy !== 'object' ||
    options.repositoryPolicy === null ||
    !isPositiveSafeInteger(
      options.repositoryPolicy.maxOutstandingPendingAuthorizationsGlobal,
    )
  ) {
    throw new TypeError('Invalid native-auth service options.');
  }

  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('Invalid native-auth service options.');
  }
  if (
    options.generateHumanCode !== undefined &&
    typeof options.generateHumanCode !== 'function'
  ) {
    throw new TypeError('Invalid native-auth service options.');
  }
  if (
    options.generateCredential !== undefined &&
    typeof options.generateCredential !== 'function'
  ) {
    throw new TypeError('Invalid native-auth service options.');
  }
  if (
    options.generateID !== undefined &&
    typeof options.generateID !== 'function'
  ) {
    throw new TypeError('Invalid native-auth service options.');
  }

  const clock = readClock(options.now);
  let humanCodes: HumanCodeKeyRing;
  try {
    humanCodes = new HumanCodeKeyRing(config.humanCodes, {
      pendingAuthorizationTTLSeconds: policy.ttlSeconds.pendingAuthorization,
      now: clock,
    });
  } catch {
    throw new TypeError('Invalid native-auth service options.');
  }

  return {
    config,
    policy,
    polling: policy.polling,
    humanCodes,
  };
}

function digestCandidates(
  ring: HumanCodeKeyRing,
  rawUserCode: string,
  at: Date,
): readonly HumanCodeDigest[] {
  try {
    return ring.digestCandidates(rawUserCode, at);
  } catch (error) {
    if (error instanceof HumanCodeError) {
      if (error.code === 'invalid-human-code') {
        throw new NativeAuthServiceError('invalid-request');
      }
      throw new NativeAuthServiceError('unavailable');
    }
    throw new NativeAuthServiceError('unavailable');
  }
}

function digestForCreation(
  ring: HumanCodeKeyRing,
  userCode: string,
  at: Date,
): HumanCodeDigest {
  try {
    return ring.digestForCreation(userCode, at);
  } catch (error) {
    if (error instanceof HumanCodeError) {
      throw new NativeAuthServiceError('unavailable');
    }
    throw new NativeAuthServiceError('unavailable');
  }
}

function readGeneratedHumanCode(source: () => string): string {
  let value: unknown;
  try {
    value = source();
  } catch {
    throw new NativeAuthServiceError('unavailable');
  }
  if (typeof value !== 'string') {
    throw new NativeAuthServiceError('unavailable');
  }
  try {
    if (normalizeHumanCode(value) !== value) {
      throw new NativeAuthServiceError('unavailable');
    }
  } catch {
    throw new NativeAuthServiceError('unavailable');
  }
  return value;
}

function readGeneratedCredential(value: string): string {
  try {
    // A generated credential must be canonical before it is ever returned or
    // fingerprinted.
    fingerprintCredential('device', value);
    return value;
  } catch {
    throw new NativeAuthServiceError('unavailable');
  }
}

function fingerprintGenerated(
  kind: CredentialKind,
  token: string,
): string {
  try {
    return fingerprintCredential(kind, token);
  } catch {
    throw new NativeAuthServiceError('unavailable');
  }
}

function fingerprintInput(kind: CredentialKind, token: string): string {
  try {
    return fingerprintCredential(kind, token);
  } catch {
    throw new NativeAuthServiceError('invalid-credential');
  }
}

function readGeneratedID(source: () => string): string {
  let value: unknown;
  try {
    value = source();
  } catch {
    throw new NativeAuthServiceError('unavailable');
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new NativeAuthServiceError('unavailable');
  }
  return value.toLowerCase();
}

function readAccount(rawAccount: NativeBrowserAccount): NativeBrowserAccount {
  if (
    typeof rawAccount !== 'object' ||
    rawAccount === null ||
    Array.isArray(rawAccount)
  ) {
    throw new NativeAuthServiceError('invalid-request');
  }
  const { id, name, email } = rawAccount;
  if (
    !isSafeString(id, MAX_USER_ID_LENGTH) ||
    !isSafeString(name, 256) ||
    !isSafeString(email, 320)
  ) {
    throw new NativeAuthServiceError('invalid-request');
  }
  return Object.freeze({ id, name, email });
}

function readUserID(rawUserID: string): string {
  if (
    typeof rawUserID !== 'string' ||
    rawUserID.length === 0 ||
    rawUserID.length > MAX_USER_ID_LENGTH ||
    rawUserID.trim().length === 0 ||
    CONTROL_CHARACTERS.test(rawUserID)
  ) {
    throw new NativeAuthServiceError('invalid-request');
  }
  return rawUserID;
}

function isSafeString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim().length > 0 &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  );
}

/**
 * Repository failures are not allowed to escape with driver/Prisma details.
 * A fixed 503 is retryable; malformed internal input is a non-retryable 500.
 */
function throwRepositoryFailure(
  error: unknown,
  capacityRetryAfterSeconds?: number,
): never {
  if (
    error instanceof NativeAuthRepositoryError &&
    error.code === 'invalid-input'
  ) {
    throw new NativeAuthServiceError('internal-error');
  }
  if (
    error instanceof NativeAuthRepositoryError &&
    error.code === 'capacity-reached' &&
    capacityRetryAfterSeconds !== undefined
  ) {
    throw new NativeAuthServiceError('rate-limited', capacityRetryAfterSeconds);
  }
  throw new NativeAuthServiceError('unavailable');
}

function readClock(clock: (() => Date) | undefined): () => Date {
  const source = clock ?? (() => new Date());
  return () => {
    let value: unknown;
    try {
      value = source();
    } catch {
      throw new NativeAuthServiceError('unavailable');
    }
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new NativeAuthServiceError('unavailable');
    }
    return new Date(value.getTime());
  };
}

function addSeconds(at: Date, seconds: number): Date {
  const value = at.getTime() + seconds * 1_000;
  if (!Number.isFinite(value)) {
    throw new NativeAuthServiceError('unavailable');
  }
  return new Date(value);
}

function earlierDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime()
    ? new Date(left.getTime())
    : new Date(right.getTime());
}

export type { AuthorizeNativeBearer };
