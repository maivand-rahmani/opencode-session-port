/**
 * Pure runtime-mode and cloud policy configuration.
 *
 * `SESSIONPORT_API_MODE` is optional and defaults to the safe `health-only`
 * mode. Cloud mode requires the complete native-auth environment plus an
 * explicit backend policy document. Nothing here constructs a client, reads a
 * file, connects to a database, performs network I/O, or invents a production
 * default.
 */

import type { ApiConfig } from '../config.js';
import {
  NATIVE_AUTH_ENV_INVENTORY,
  readNativeAuthConfig,
  type NativeAuthConfig,
} from '../native-auth/config.js';

export const API_MODE_ENV = 'SESSIONPORT_API_MODE';
export const BACKEND_POLICY_ENV = 'SESSIONPORT_BACKEND_POLICY_JSON';

export const REQUIRED_NATIVE_ROUTE_IDS = Object.freeze([
  'projects.create',
  'projects.list',
  'revisions.list',
  'revisions.commit',
  'me.read',
] as const);

export type ApiMode = 'health-only' | 'cloud';

export interface BackendPolicy {
  readonly maxActiveProjects: number;
  readonly maxActiveDevices: number;
  readonly maxCiphertextBytes: number;
  readonly maxPageSize: number;
  readonly maxOutstandingPendingAuthorizationsGlobal: number;
  readonly maxRateLimitEntries: number;
  readonly maxAuthResponseBytes: number;
}

export interface HealthOnlyRuntimeConfig {
  readonly mode: 'health-only';
}

export interface CloudRuntimeConfig {
  readonly mode: 'cloud';
  readonly backend: BackendPolicy;
  readonly native: NativeAuthConfig;
}

export type RuntimeConfig = HealthOnlyRuntimeConfig | CloudRuntimeConfig;

export type RuntimeConfigErrorCode =
  | 'invalid-api-mode'
  | 'invalid-backend-policy'
  | 'origin-mismatch'
  | 'capacity-mismatch'
  | 'missing-route-policy';

const ERROR_MESSAGES: Readonly<Record<RuntimeConfigErrorCode, string>> =
  Object.freeze({
    'invalid-api-mode':
      'SESSIONPORT_API_MODE must be exactly "health-only" or "cloud".',
    'invalid-backend-policy': 'SESSIONPORT_BACKEND_POLICY_JSON is invalid.',
    'origin-mismatch':
      'The native-auth public origin must match the API public origin.',
    'capacity-mismatch':
      'Backend maxActiveDevices must equal native maxActiveGrantsPerUser.',
    'missing-route-policy':
      'Native authorization policy is missing a required route ID.',
  });

export class RuntimeConfigError extends Error {
  readonly code: RuntimeConfigErrorCode;

  constructor(code: RuntimeConfigErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'RuntimeConfigError';
    this.code = code;
  }
}

/**
 * Value-free inventory for operators/tests. Names and purposes only; no
 * environment value, secret, path, or connection string is included.
 */
export const RUNTIME_ENV_INVENTORY = Object.freeze([
  Object.freeze({
    name: API_MODE_ENV,
    purpose:
      'Optional runtime mode: "health-only" (safe default when absent) or "cloud".',
    secret: false,
  }),
  Object.freeze({
    name: BACKEND_POLICY_ENV,
    purpose:
      'Required in cloud mode: exact JSON object with the seven positive integer backend bounds.',
    secret: false,
  }),
  ...NATIVE_AUTH_ENV_INVENTORY,
] as const);

const BACKEND_POLICY_KEYS = Object.freeze([
  'maxActiveProjects',
  'maxActiveDevices',
  'maxCiphertextBytes',
  'maxPageSize',
  'maxOutstandingPendingAuthorizationsGlobal',
  'maxRateLimitEntries',
  'maxAuthResponseBytes',
] as const);

/**
 * Read and validate the runtime mode. Cloud mode validates the full native
 * configuration and cross-checks before any client is constructed.
 */
export function readRuntimeConfig(
  env: NodeJS.ProcessEnv,
  apiConfig: ApiConfig,
): RuntimeConfig {
  const rawMode = env[API_MODE_ENV];
  if (rawMode === undefined) {
    return Object.freeze({ mode: 'health-only' as const });
  }
  if (rawMode !== 'health-only' && rawMode !== 'cloud') {
    throw new RuntimeConfigError('invalid-api-mode');
  }

  if (rawMode === 'health-only') {
    return Object.freeze({ mode: 'health-only' as const });
  }

  const backend = readBackendPolicy(env[BACKEND_POLICY_ENV]);
  const native = readNativeAuthConfig(env);

  if (native.publicOrigin !== apiConfig.publicOrigin) {
    throw new RuntimeConfigError('origin-mismatch');
  }
  if (native.policy.capacity.maxActiveGrantsPerUser !== backend.maxActiveDevices) {
    throw new RuntimeConfigError('capacity-mismatch');
  }

  const routeScopes = native.policy.authorization.requiredRouteScopes;
  for (const routeID of REQUIRED_NATIVE_ROUTE_IDS) {
    if (!Object.hasOwn(routeScopes, routeID)) {
      throw new RuntimeConfigError('missing-route-policy');
    }
  }

  return Object.freeze({
    mode: 'cloud' as const,
    backend,
    native,
  });
}

function readBackendPolicy(raw: unknown): BackendPolicy {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > 64_000
  ) {
    throw new RuntimeConfigError('invalid-backend-policy');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RuntimeConfigError('invalid-backend-policy');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RuntimeConfigError('invalid-backend-policy');
  }

  const record = parsed as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  if (
    actualKeys.length !== BACKEND_POLICY_KEYS.length ||
    BACKEND_POLICY_KEYS.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new RuntimeConfigError('invalid-backend-policy');
  }

  const policy = {} as Record<(typeof BACKEND_POLICY_KEYS)[number], number>;
  for (const key of BACKEND_POLICY_KEYS) {
    const value = record[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      throw new RuntimeConfigError('invalid-backend-policy');
    }
    policy[key] = value;
  }

  return Object.freeze({
    maxActiveProjects: policy.maxActiveProjects,
    maxActiveDevices: policy.maxActiveDevices,
    maxCiphertextBytes: policy.maxCiphertextBytes,
    maxPageSize: policy.maxPageSize,
    maxOutstandingPendingAuthorizationsGlobal:
      policy.maxOutstandingPendingAuthorizationsGlobal,
    maxRateLimitEntries: policy.maxRateLimitEntries,
    maxAuthResponseBytes: policy.maxAuthResponseBytes,
  });
}
