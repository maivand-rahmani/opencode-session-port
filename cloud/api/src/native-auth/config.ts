/**
 * Explicit native-auth configuration.
 *
 * This module is pure: it reads only the supplied environment object, performs
 * no import-time work, reads no files, and has no production defaults. Every
 * secret, lifetime, rate limit, capacity bound, scope, audience, and resource
 * must be supplied by the operator.
 *
 * Secret material is returned only to the caller. Error messages never include
 * a rejected environment value, key material, or JSON document.
 */

export const NATIVE_VERIFICATION_PATH =
  '/api/native/v1/device-authorizations/verify';

export const NATIVE_AUTH_ENV_INVENTORY = Object.freeze([
  Object.freeze({
    name: 'SESSIONPORT_PUBLIC_ORIGIN',
    purpose: 'Canonical public API origin shared with the base API configuration.',
    secret: false,
  }),
  Object.freeze({
    name: 'SESSIONPORT_NATIVE_ALLOW_LOOPBACK_HTTP',
    purpose: 'Explicit true/false flag allowing HTTP only for loopback origins.',
    secret: false,
  }),
  Object.freeze({
    name: 'SESSIONPORT_BETTER_AUTH_SECRET',
    purpose: 'Server-only BetterAuth session secret.',
    secret: true,
  }),
  Object.freeze({
    name: 'SESSIONPORT_GITHUB_CLIENT_ID',
    purpose: 'Server-only GitHub OAuth client identifier.',
    secret: false,
  }),
  Object.freeze({
    name: 'SESSIONPORT_GITHUB_CLIENT_SECRET',
    purpose: 'Server-only GitHub OAuth client secret.',
    secret: true,
  }),
  Object.freeze({
    name: 'SESSIONPORT_NATIVE_HUMAN_CODE_KEYS_JSON',
    purpose:
      'JSON array of human-code HMAC keys: [{ id, keyBase64, retireAfter? }].',
    secret: true,
  }),
  Object.freeze({
    name: 'SESSIONPORT_NATIVE_HUMAN_CODE_ACTIVE_KEY_ID',
    purpose: 'ID of the one active human-code HMAC key.',
    secret: false,
  }),
  Object.freeze({
    name: 'SESSIONPORT_NATIVE_CSRF_KEY_BASE64',
    purpose: 'Canonical Base64 CSRF HMAC key of at least 32 bytes.',
    secret: true,
  }),
  Object.freeze({
    name: 'SESSIONPORT_NATIVE_POLICY_JSON',
    purpose:
      'JSON object containing the exact TTL, polling, rate, capacity, retention, audience, resource, and scope policy.',
    secret: false,
  }),
] as const);

export type NativeAuthEnvironmentName =
  (typeof NATIVE_AUTH_ENV_INVENTORY)[number]['name'];

const ENV = Object.freeze({
  publicOrigin: 'SESSIONPORT_PUBLIC_ORIGIN',
  allowLoopbackHttp: 'SESSIONPORT_NATIVE_ALLOW_LOOPBACK_HTTP',
  betterAuthSecret: 'SESSIONPORT_BETTER_AUTH_SECRET',
  githubClientID: 'SESSIONPORT_GITHUB_CLIENT_ID',
  githubClientSecret: 'SESSIONPORT_GITHUB_CLIENT_SECRET',
  humanCodeKeys: 'SESSIONPORT_NATIVE_HUMAN_CODE_KEYS_JSON',
  activeHumanCodeKeyID:
    'SESSIONPORT_NATIVE_HUMAN_CODE_ACTIVE_KEY_ID',
  csrfKey: 'SESSIONPORT_NATIVE_CSRF_KEY_BASE64',
  policy: 'SESSIONPORT_NATIVE_POLICY_JSON',
} as const);

/** The value accepted from the environment; kept available for callers/tests. */
export const NATIVE_AUTH_ENV = ENV;

const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4096;
const MAX_ORIGIN_LENGTH = 2048;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_SCOPE_LENGTH = 128;
const MAX_HUMAN_CODE_KEY_COUNT = 128;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROUTE_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const RETIRE_AFTER_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface NativeHumanCodeKeyConfig {
  readonly id: string;
  readonly key: Buffer;
  readonly retireAfter?: Date;
}

export interface NativeHumanCodeKeyRingConfig {
  readonly keys: readonly NativeHumanCodeKeyConfig[];
  readonly activeKeyID: string;
}

export interface NativeBetterAuthConfig {
  readonly secret: string;
  readonly github: {
    readonly clientID: string;
    readonly clientSecret: string;
  };
}

export interface NativeRateLimitPolicy {
  readonly windowSeconds: number;
  readonly maxRequests: number;
}

export interface NativeAuthTTLPolicy {
  readonly pendingAuthorization: number;
  readonly accessToken: number;
  readonly refreshToken: number;
  readonly grant: number;
}

export interface NativePollingPolicy {
  readonly intervalSeconds: number;
  readonly backoffIncrementSeconds: number;
  readonly maxIntervalSeconds: number;
}

export interface NativeAuthRateLimitPolicy {
  readonly createAuthorization: NativeRateLimitPolicy;
  readonly browserVerification: NativeRateLimitPolicy;
  readonly browserLookup: NativeRateLimitPolicy;
  readonly approveAuthorization: NativeRateLimitPolicy;
  readonly denyAuthorization: NativeRateLimitPolicy;
  readonly exchangeDeviceCode: NativeRateLimitPolicy;
  readonly refreshToken: NativeRateLimitPolicy;
  readonly listGrants: NativeRateLimitPolicy;
  readonly revokeGrant: NativeRateLimitPolicy;
}

export interface NativeAuthRetentionPolicy {
  readonly pendingAuthorizationRecords: number;
  readonly spentTokenRecords: number;
  readonly revokedGrantRecords: number;
}

export interface NativeAuthCapacityPolicy {
  readonly maxOutstandingPendingAuthorizationsPerUser: number;
  readonly maxActiveGrantsPerUser: number;
  readonly retentionSeconds: NativeAuthRetentionPolicy;
}

export interface NativeAuthAuthorizationPolicy {
  readonly audience: string;
  readonly resource: string;
  readonly allowedScopes: readonly string[];
  /**
   * Server-owned route IDs mapped to scopes required by that route. Route IDs
   * are opaque to this module (for example `projects.create`); routes must
   * fail closed when their ID is absent.
   */
  readonly requiredRouteScopes: Readonly<Record<string, readonly string[]>>;
}

export interface NativeAuthPolicy {
  readonly ttlSeconds: NativeAuthTTLPolicy;
  readonly polling: NativePollingPolicy;
  readonly rateLimits: NativeAuthRateLimitPolicy;
  readonly capacity: NativeAuthCapacityPolicy;
  readonly authorization: NativeAuthAuthorizationPolicy;
}

export interface NativeAuthConfig {
  readonly publicOrigin: string;
  readonly verificationUri: string;
  readonly allowLoopbackHttp: boolean;
  readonly betterAuth: NativeBetterAuthConfig;
  readonly humanCodes: NativeHumanCodeKeyRingConfig;
  readonly csrfKey: Buffer;
  readonly policy: NativeAuthPolicy;
}

export class NativeAuthConfigError extends Error {
  readonly code = 'invalid-native-auth-config';

  constructor(message: string) {
    super(message);
    this.name = 'NativeAuthConfigError';
  }
}

/**
 * Read and validate the complete native-auth configuration.
 *
 * The returned object is frozen as far as JavaScript object freezing applies.
 * Buffers are returned as copies; callers must treat them as server-only.
 */
export function readNativeAuthConfig(
  env: NodeJS.ProcessEnv,
): NativeAuthConfig {
  const allowLoopbackHttp = readBoolean(env, ENV.allowLoopbackHttp);
  const publicOrigin = readPublicOrigin(env, allowLoopbackHttp);

  const betterAuthSecret = readSecret(env, ENV.betterAuthSecret);
  const githubClientID = readSecret(env, ENV.githubClientID, 1);
  const githubClientSecret = readSecret(env, ENV.githubClientSecret, 1);

  const csrfKey = readCanonicalKey(env, ENV.csrfKey);
  const betterAuthSecretBytes = Buffer.from(betterAuthSecret, 'utf8');

  if (csrfKey.equals(betterAuthSecretBytes)) {
    fail(
      `${ENV.csrfKey} must not reuse BetterAuth secret material.`,
    );
  }

  const humanCodes = readHumanCodeKeyRing(
    env,
    csrfKey,
    betterAuthSecretBytes,
  );
  const policy = readPolicy(env[ENV.policy]);

  return Object.freeze({
    publicOrigin,
    verificationUri: `${publicOrigin}${NATIVE_VERIFICATION_PATH}`,
    allowLoopbackHttp,
    betterAuth: Object.freeze({
      secret: betterAuthSecret,
      github: Object.freeze({
        clientID: githubClientID,
        clientSecret: githubClientSecret,
      }),
    }),
    humanCodes,
    csrfKey,
    policy,
  });
}

function fail(message: string): never {
  throw new NativeAuthConfigError(message);
}

function readRequired(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`Missing required environment variable ${name}.`);
  }
  return value;
}

function readBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean {
  const raw = readRequired(env, name);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be exactly "true" or "false".`);
}

function readSecret(
  env: NodeJS.ProcessEnv,
  name: string,
  minimumBytes = MIN_SECRET_BYTES,
): string {
  const raw = readRequired(env, name);
  if (
    raw.trim() !== raw ||
    CONTROL_CHARACTERS.test(raw) ||
    Buffer.byteLength(raw, 'utf8') < minimumBytes ||
    Buffer.byteLength(raw, 'utf8') > MAX_SECRET_BYTES
  ) {
    fail(`${name} is invalid.`);
  }
  return raw;
}

function readPublicOrigin(
  env: NodeJS.ProcessEnv,
  allowLoopbackHttp: boolean,
): string {
  const raw = readRequired(env, ENV.publicOrigin);
  if (
    raw.trim() !== raw ||
    raw.length > MAX_ORIGIN_LENGTH ||
    CONTROL_CHARACTERS.test(raw)
  ) {
    fail(originMessage());
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(originMessage());
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail(originMessage());
  }
  if (!isConcreteHostname(parsed.hostname)) {
    fail(originMessage());
  }
  if (parsed.username !== '' || parsed.password !== '') {
    fail(originMessage());
  }
  if (parsed.search !== '' || parsed.hash !== '' || parsed.pathname !== '/') {
    fail(originMessage());
  }
  if (
    parsed.protocol === 'http:' &&
    (!allowLoopbackHttp || !isLoopbackHostname(parsed.hostname))
  ) {
    fail(originMessage());
  }
  if (parsed.origin.length > MAX_ORIGIN_LENGTH) {
    fail(originMessage());
  }

  return parsed.origin;
}

function originMessage(): string {
  return `${ENV.publicOrigin} must be a canonical HTTPS origin, or an HTTP loopback origin when explicitly allowed.`;
}

function isConcreteHostname(hostname: string): boolean {
  if (hostname.startsWith('[')) {
    return /^\[[0-9a-f:.]+\]$/i.test(hostname);
  }

  const withoutTrailingDot = hostname.endsWith('.')
    ? hostname.slice(0, -1)
    : hostname;
  if (withoutTrailingDot.length === 0 || withoutTrailingDot.length > 253) {
    return false;
  }

  return withoutTrailingDot.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9-]+$/i.test(label) &&
      !label.startsWith('-') &&
      !label.endsWith('-'),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') {
    return true;
  }

  const octets = hostname.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every(
      (octet) => /^[0-9]{1,3}$/.test(octet) && Number(octet) <= 255,
    )
  );
}

function readCanonicalKey(
  env: NodeJS.ProcessEnv,
  name: string,
): Buffer {
  return decodeCanonicalBase64(readRequired(env, name), name);
}

function decodeCanonicalBase64(value: string, name: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(MAX_SECRET_BYTES / 3) * 4 ||
    !BASE64_PATTERN.test(value)
  ) {
    fail(`${name} is not canonical Base64.`);
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    fail(`${name} is not canonical Base64.`);
  }

  if (
    decoded.length < MIN_SECRET_BYTES ||
    decoded.length > MAX_SECRET_BYTES ||
    decoded.toString('base64') !== value
  ) {
    fail(`${name} must decode to at least ${MIN_SECRET_BYTES} bytes of canonical Base64.`);
  }

  return decoded;
}

function readHumanCodeKeyRing(
  env: NodeJS.ProcessEnv,
  csrfKey: Buffer,
  betterAuthSecretBytes: Buffer,
): NativeHumanCodeKeyRingConfig {
  const raw = readRequired(env, ENV.humanCodeKeys);
  if (raw.length > 1_000_000) {
    fail(`${ENV.humanCodeKeys} is invalid.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${ENV.humanCodeKeys} must be a JSON array.`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail(`${ENV.humanCodeKeys} must be a non-empty JSON array.`);
  }
  if (parsed.length > MAX_HUMAN_CODE_KEY_COUNT) {
    fail(`${ENV.humanCodeKeys} contains too many keys.`);
  }

  const ids = new Set<string>();
  const keyMaterials: Buffer[] = [];
  const keys: NativeHumanCodeKeyConfig[] = [];

  for (const entry of parsed) {
    const record = asObject(entry, ENV.humanCodeKeys);
    const entryKeys = Object.keys(record);
    if (
      !entryKeys.includes('id') ||
      !entryKeys.includes('keyBase64') ||
      entryKeys.some(
        (key) => key !== 'id' && key !== 'keyBase64' && key !== 'retireAfter',
      )
    ) {
      fail(`${ENV.humanCodeKeys} contains a malformed key entry.`);
    }

    const id = record.id;
    if (
      typeof id !== 'string' ||
      id.length > 64 ||
      !KEY_ID_PATTERN.test(id) ||
      ids.has(id)
    ) {
      fail(`${ENV.humanCodeKeys} contains an invalid or duplicate key ID.`);
    }

    const keyBase64 = record.keyBase64;
    if (typeof keyBase64 !== 'string') {
      fail(`${ENV.humanCodeKeys} contains an invalid key.`);
    }
    const key = decodeCanonicalBase64(
      keyBase64,
      `${ENV.humanCodeKeys} key material`,
    );

    if (key.equals(csrfKey) || key.equals(betterAuthSecretBytes)) {
      fail(
        `${ENV.humanCodeKeys} must not reuse CSRF or BetterAuth secret material.`,
      );
    }
    if (keyMaterials.some((existing) => existing.equals(key))) {
      fail(`${ENV.humanCodeKeys} contains duplicate key material.`);
    }

    let retireAfter: Date | undefined;
    if (Object.hasOwn(record, 'retireAfter')) {
      const retireAfterRaw = record.retireAfter;
      if (
        typeof retireAfterRaw !== 'string' ||
        !RETIRE_AFTER_PATTERN.test(retireAfterRaw)
      ) {
        fail(`${ENV.humanCodeKeys} contains an invalid retireAfter value.`);
      }
      retireAfter = new Date(retireAfterRaw);
      if (!Number.isFinite(retireAfter.getTime())) {
        fail(`${ENV.humanCodeKeys} contains an invalid retireAfter value.`);
      }
    }

    ids.add(id);
    keyMaterials.push(key);
    keys.push(
      Object.freeze({
        id,
        key: Buffer.from(key),
        ...(retireAfter === undefined ? {} : { retireAfter }),
      }),
    );
  }

  const activeKeyID = readRequired(env, ENV.activeHumanCodeKeyID);
  if (
    activeKeyID.length > 64 ||
    !KEY_ID_PATTERN.test(activeKeyID) ||
    !ids.has(activeKeyID)
  ) {
    fail(
      `${ENV.activeHumanCodeKeyID} must identify exactly one configured key.`,
    );
  }

  return Object.freeze({
    keys: Object.freeze(keys),
    activeKeyID,
  });
}

function readPolicy(value: unknown): NativeAuthPolicy {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`Missing required environment variable ${ENV.policy}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(`${ENV.policy} must be valid JSON.`);
  }

  const root = asObject(parsed, ENV.policy);
  requireExactKeys(
    root,
    ['ttlSeconds', 'polling', 'rateLimits', 'capacity', 'authorization'],
    ENV.policy,
  );

  const ttlSeconds = readTTLPolicy(root.ttlSeconds);
  const polling = readPollingPolicy(root.polling);
  const rateLimits = readRateLimitPolicy(root.rateLimits);
  const capacity = readCapacityPolicy(root.capacity);
  const authorization = readAuthorizationPolicy(root.authorization);

  return deepFreeze({
    ttlSeconds,
    polling,
    rateLimits,
    capacity,
    authorization,
  });
}

function readTTLPolicy(value: unknown): NativeAuthTTLPolicy {
  const label = `${ENV.policy}.ttlSeconds`;
  const record = asObject(value, label);
  requireExactKeys(
    record,
    ['pendingAuthorization', 'accessToken', 'refreshToken', 'grant'],
    label,
  );

  const ttl = {
    pendingAuthorization: readPositiveInteger(
      record.pendingAuthorization,
      `${label}.pendingAuthorization`,
    ),
    accessToken: readPositiveInteger(
      record.accessToken,
      `${label}.accessToken`,
    ),
    refreshToken: readPositiveInteger(
      record.refreshToken,
      `${label}.refreshToken`,
    ),
    grant: readPositiveInteger(record.grant, `${label}.grant`),
  };

  if (ttl.accessToken > ttl.grant || ttl.refreshToken > ttl.grant) {
    fail(
      `${label} accessToken and refreshToken values must not exceed grant.`,
    );
  }

  return ttl;
}

function readPollingPolicy(value: unknown): NativePollingPolicy {
  const label = `${ENV.policy}.polling`;
  const record = asObject(value, label);
  requireExactKeys(
    record,
    [
      'intervalSeconds',
      'backoffIncrementSeconds',
      'maxIntervalSeconds',
    ],
    label,
  );

  const polling = {
    intervalSeconds: readPositiveInteger(
      record.intervalSeconds,
      `${label}.intervalSeconds`,
    ),
    backoffIncrementSeconds: readPositiveInteger(
      record.backoffIncrementSeconds,
      `${label}.backoffIncrementSeconds`,
    ),
    maxIntervalSeconds: readPositiveInteger(
      record.maxIntervalSeconds,
      `${label}.maxIntervalSeconds`,
    ),
  };

  if (polling.maxIntervalSeconds < polling.intervalSeconds) {
    fail(
      `${label}.maxIntervalSeconds must be at least intervalSeconds.`,
    );
  }
  if (polling.backoffIncrementSeconds > polling.maxIntervalSeconds) {
    fail(
      `${label}.backoffIncrementSeconds must not exceed maxIntervalSeconds.`,
    );
  }

  return polling;
}

function readRateLimitPolicy(
  value: unknown,
): NativeAuthRateLimitPolicy {
  const label = `${ENV.policy}.rateLimits`;
  const record = asObject(value, label);
  const operations = [
    'createAuthorization',
    'browserVerification',
    'browserLookup',
    'approveAuthorization',
    'denyAuthorization',
    'exchangeDeviceCode',
    'refreshToken',
    'listGrants',
    'revokeGrant',
  ] as const;

  requireExactKeys(record, operations, label);

  const result = {} as Record<
    (typeof operations)[number],
    NativeRateLimitPolicy
  >;
  for (const operation of operations) {
    const operationLabel = `${label}.${operation}`;
    const operationRecord = asObject(record[operation], operationLabel);
    requireExactKeys(
      operationRecord,
      ['windowSeconds', 'maxRequests'],
      operationLabel,
    );
    result[operation] = Object.freeze({
      windowSeconds: readPositiveInteger(
        operationRecord.windowSeconds,
        `${operationLabel}.windowSeconds`,
      ),
      maxRequests: readPositiveInteger(
        operationRecord.maxRequests,
        `${operationLabel}.maxRequests`,
      ),
    });
  }

  return Object.freeze(result);
}

function readCapacityPolicy(value: unknown): NativeAuthCapacityPolicy {
  const label = `${ENV.policy}.capacity`;
  const record = asObject(value, label);
  requireExactKeys(
    record,
    [
      'maxOutstandingPendingAuthorizationsPerUser',
      'maxActiveGrantsPerUser',
      'retentionSeconds',
    ],
    label,
  );

  const retentionLabel = `${label}.retentionSeconds`;
  const retentionRecord = asObject(record.retentionSeconds, retentionLabel);
  requireExactKeys(
    retentionRecord,
    [
      'pendingAuthorizationRecords',
      'spentTokenRecords',
      'revokedGrantRecords',
    ],
    retentionLabel,
  );

  return Object.freeze({
    maxOutstandingPendingAuthorizationsPerUser: readPositiveInteger(
      record.maxOutstandingPendingAuthorizationsPerUser,
      `${label}.maxOutstandingPendingAuthorizationsPerUser`,
    ),
    maxActiveGrantsPerUser: readPositiveInteger(
      record.maxActiveGrantsPerUser,
      `${label}.maxActiveGrantsPerUser`,
    ),
    retentionSeconds: Object.freeze({
      pendingAuthorizationRecords: readPositiveInteger(
        retentionRecord.pendingAuthorizationRecords,
        `${retentionLabel}.pendingAuthorizationRecords`,
      ),
      spentTokenRecords: readPositiveInteger(
        retentionRecord.spentTokenRecords,
        `${retentionLabel}.spentTokenRecords`,
      ),
      revokedGrantRecords: readPositiveInteger(
        retentionRecord.revokedGrantRecords,
        `${retentionLabel}.revokedGrantRecords`,
      ),
    }),
  });
}

function readAuthorizationPolicy(
  value: unknown,
): NativeAuthAuthorizationPolicy {
  const label = `${ENV.policy}.authorization`;
  const record = asObject(value, label);
  requireExactKeys(
    record,
    ['audience', 'resource', 'allowedScopes', 'requiredRouteScopes'],
    label,
  );

  const audience = readIdentifier(record.audience, `${label}.audience`);
  const resource = readIdentifier(record.resource, `${label}.resource`);
  const allowedScopes = readScopeList(
    record.allowedScopes,
    `${label}.allowedScopes`,
  );
  const requiredRouteScopes = readRequiredRouteScopes(
    record.requiredRouteScopes,
    allowedScopes,
  );

  return deepFreeze({
    audience,
    resource,
    allowedScopes,
    requiredRouteScopes,
  });
}

function readIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value)
  ) {
    fail(`${label} must be a non-empty identifier.`);
  }
  return value;
}

function readScopeList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array.`);
  }

  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const scope of value) {
    if (
      typeof scope !== 'string' ||
      scope.length > MAX_SCOPE_LENGTH ||
      !SCOPE_PATTERN.test(scope) ||
      seen.has(scope)
    ) {
      fail(`${label} contains an invalid or duplicate scope.`);
    }
    seen.add(scope);
    scopes.push(scope);
  }
  return Object.freeze(scopes);
}

function readRequiredRouteScopes(
  value: unknown,
  allowedScopes: readonly string[],
): Readonly<Record<string, readonly string[]>> {
  const label = `${ENV.policy}.authorization.requiredRouteScopes`;
  const record = asObject(value, label);
  const routeIDs = Object.keys(record);
  if (routeIDs.length === 0) {
    fail(`${label} must contain at least one route.`);
  }

  const allowed = new Set(allowedScopes);
  const entries: Array<[string, readonly string[]]> = [];

  for (const routeID of routeIDs) {
    if (routeID.length > MAX_SCOPE_LENGTH || !ROUTE_ID_PATTERN.test(routeID)) {
      fail(`${label} contains an invalid route ID.`);
    }

    const routeScopes = readScopeList(
      record[routeID],
      `${label}.${routeID}`,
    );
    if (routeScopes.some((scope) => !allowed.has(scope))) {
      fail(`${label}.${routeID} requires a scope outside allowedScopes.`);
    }
    entries.push([routeID, routeScopes]);
  }

  return deepFreeze(Object.fromEntries(entries));
}

function readPositiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    fail(`${label} must be a positive safe integer.`);
  }
  return value;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record);
  if (
    actual.length !== required.length ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    fail(`${label} must contain exactly: ${required.join(', ')}.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Date)
  ) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  return value;
}
