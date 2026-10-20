/**
 * Explicit, server-only S3 configuration.
 *
 * This module is a pure reader: it never reads `process.env`, loads env files,
 * constructs a client, performs a request, or logs values. Every value is
 * required and validated exactly as supplied. There are no defaults, aliases,
 * endpoint guesses, bucket guesses, or inferred address styles.
 *
 * The Beget endpoint and region below are examples only, never defaults. Provider
 * behaviour and upload capability are not established by this module.
 */

const ENDPOINT_ENV = 'SESSIONPORT_S3_ENDPOINT';
const REGION_ENV = 'SESSIONPORT_S3_REGION';
const BUCKET_ENV = 'SESSIONPORT_S3_BUCKET';
const ACCESS_KEY_ID_ENV = 'SESSIONPORT_S3_ACCESS_KEY_ID';
const SECRET_ACCESS_KEY_ENV = 'SESSIONPORT_S3_SECRET_ACCESS_KEY';
const FORCE_PATH_STYLE_ENV = 'SESSIONPORT_S3_FORCE_PATH_STYLE';

const INVALID_CONFIG_MESSAGE = 'S3 storage configuration is invalid.';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const REGION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BUCKET_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const IPV4_SHAPE = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;

export interface S3Config {
  /** HTTPS origin only: no userinfo, path, query, or fragment. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

export class S3ConfigError extends Error {
  readonly code = 'invalid-s3-config';

  constructor() {
    super(INVALID_CONFIG_MESSAGE);
    this.name = 'S3ConfigError';
  }
}

/**
 * Read exactly the six explicit S3 environment keys.
 *
 * Values are never trimmed, rewritten, or defaulted. The endpoint is the only
 * value that is canonicalised, to `URL.origin`; all other accepted strings are
 * returned byte-for-byte. Every failure throws the same fixed, redacted error.
 */
export function readS3Config(env: NodeJS.ProcessEnv): S3Config {
  const endpoint = readHttpsEndpoint(env, ENDPOINT_ENV);
  const region = readRegion(env, REGION_ENV);
  const bucket = readBucket(env, BUCKET_ENV);
  const accessKeyId = readCredential(env, ACCESS_KEY_ID_ENV);
  const secretAccessKey = readCredential(env, SECRET_ACCESS_KEY_ENV);
  const forcePathStyle = readForcePathStyle(env, FORCE_PATH_STYLE_ENV);

  return Object.freeze({
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
  });
}

function readRequiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];

  if (typeof value !== 'string' || value.length === 0) {
    throw new S3ConfigError();
  }
  if (value.trim() !== value) {
    throw new S3ConfigError();
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new S3ConfigError();
  }

  return value;
}

function readHttpsEndpoint(env: NodeJS.ProcessEnv, name: string): string {
  const raw = readRequiredString(env, name);
  if (!raw.startsWith('https://')) {
    throw new S3ConfigError();
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new S3ConfigError();
  }

  if (parsed.protocol !== 'https:') {
    throw new S3ConfigError();
  }
  if (!isConcreteHostname(parsed.hostname)) {
    throw new S3ConfigError();
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new S3ConfigError();
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new S3ConfigError();
  }
  if (parsed.pathname !== '/') {
    throw new S3ConfigError();
  }
  if (parsed.port !== '') {
    const port = Number(parsed.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new S3ConfigError();
    }
  }

  return parsed.origin;
}

function readRegion(env: NodeJS.ProcessEnv, name: string): string {
  const raw = readRequiredString(env, name);
  if (!REGION_PATTERN.test(raw)) {
    throw new S3ConfigError();
  }
  return raw;
}

function readBucket(env: NodeJS.ProcessEnv, name: string): string {
  const raw = readRequiredString(env, name);
  if (!isAwsCompatibleBucketName(raw)) {
    throw new S3ConfigError();
  }
  return raw;
}

function readCredential(env: NodeJS.ProcessEnv, name: string): string {
  const raw = readRequiredString(env, name);
  if (raw.length > 1024 || /\s/.test(raw)) {
    throw new S3ConfigError();
  }
  return raw;
}

function readForcePathStyle(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = readRequiredString(env, name);
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new S3ConfigError();
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

function isAwsCompatibleBucketName(bucket: string): boolean {
  if (bucket.length < 3 || bucket.length > 63) {
    return false;
  }
  if (!/^[a-z0-9.-]+$/.test(bucket)) {
    return false;
  }
  if (bucket.includes('..')) {
    return false;
  }
  if (IPV4_SHAPE.test(bucket)) {
    return false;
  }

  return bucket.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      BUCKET_LABEL_PATTERN.test(label),
  );
}
