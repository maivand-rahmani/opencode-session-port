/**
 * Explicit API configuration.
 *
 * Every value is required from the environment. This module intentionally has no
 * defaults, no env-file loading, and no persistence. In particular it does not read
 * database URLs, credentials, provider keys, or any host/account secrets.
 */

export interface ApiConfig {
  /** The API only ever binds to the loopback interface. */
  host: '127.0.0.1';
  port: number;
  publicOrigin: string;
  bodyLimitBytes: number;
  readinessTimeoutMs: number;
  retryAfterSeconds: number;
}

export class ApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiConfigError';
  }
}

const REQUIRED_PORT = 'SESSIONPORT_API_PORT';
const REQUIRED_PUBLIC_ORIGIN = 'SESSIONPORT_PUBLIC_ORIGIN';
const REQUIRED_BODY_LIMIT = 'SESSIONPORT_HTTP_BODY_LIMIT_BYTES';
const REQUIRED_READINESS_TIMEOUT = 'SESSIONPORT_READINESS_TIMEOUT_MS';
const REQUIRED_RETRY_AFTER = 'SESSIONPORT_RETRY_AFTER_SECONDS';

const MAX_PORT = 65_535;
const MAX_TIMER_MS = 2_147_483_647;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

const INVALID_ORIGIN_MESSAGE =
  'SESSIONPORT_PUBLIC_ORIGIN must be an HTTPS origin, or an HTTP loopback origin for local use.';

/**
 * Read and validate the process environment.
 *
 * Error messages are fixed and never include the rejected value. The returned
 * origin is canonicalised to `URL.origin` (no path, query, fragment, or userinfo).
 */
export function readApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const port = readBoundedInteger(env, REQUIRED_PORT, 1, MAX_PORT);
  const publicOrigin = readPublicOrigin(env);
  const bodyLimitBytes = readBoundedInteger(
    env,
    REQUIRED_BODY_LIMIT,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const readinessTimeoutMs = readBoundedInteger(
    env,
    REQUIRED_READINESS_TIMEOUT,
    1,
    MAX_TIMER_MS,
  );
  const retryAfterSeconds = readBoundedInteger(
    env,
    REQUIRED_RETRY_AFTER,
    0,
    Number.MAX_SAFE_INTEGER,
  );

  return {
    host: '127.0.0.1',
    port,
    publicOrigin,
    bodyLimitBytes,
    readinessTimeoutMs,
    retryAfterSeconds,
  };
}

function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiConfigError(`Missing required environment variable ${name}.`);
  }
  return value;
}

function readBoundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = readRequired(env, name);
  if (!DECIMAL_INTEGER.test(raw)) {
    throw new ApiConfigError(
      `${name} must be an explicit decimal integer between ${minimum} and ${maximum}.`,
    );
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiConfigError(
      `${name} must be an explicit decimal integer between ${minimum} and ${maximum}.`,
    );
  }

  return value;
}

function readPublicOrigin(env: NodeJS.ProcessEnv): string {
  const raw = readRequired(env, REQUIRED_PUBLIC_ORIGIN);
  if (raw.trim() !== raw) {
    throw new ApiConfigError(INVALID_ORIGIN_MESSAGE);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiConfigError(INVALID_ORIGIN_MESSAGE);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ApiConfigError(INVALID_ORIGIN_MESSAGE);
  }
  if (!isConcreteHostname(parsed.hostname)) {
    throw new ApiConfigError(INVALID_ORIGIN_MESSAGE);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ApiConfigError(INVALID_ORIGIN_MESSAGE);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new ApiConfigError(INVALID_ORIGIN_MESSAGE);
  }
  if (parsed.pathname !== '/') {
    throw new ApiConfigError(INVALID_ORIGIN_MESSAGE);
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new ApiConfigError(INVALID_ORIGIN_MESSAGE);
  }

  return parsed.origin;
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
