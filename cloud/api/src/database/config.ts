/**
 * Purpose-separated PostgreSQL connection configuration.
 *
 * This module performs format-only validation of explicitly supplied environment
 * values. It never reads process.env, loads env files, connects to a database,
 * logs connection details, or reads the other purpose's URL.
 *
 * The returned `connectionString` is always the original accepted value. It is
 * never trimmed, normalised, re-encoded, or reconstructed.
 */

const RUNTIME_DATABASE_URL_ENV = 'SESSIONPORT_RUNTIME_DATABASE_URL';
const MIGRATION_DATABASE_URL_ENV = 'SESSIONPORT_MIGRATOR_DATABASE_URL';

const INVALID_CONFIG_MESSAGE = 'Database connection configuration is invalid.';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const BAD_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i;
const DECIMAL_PORT = /^[0-9]+$/;

export interface DatabaseConnectionConfig {
  readonly connectionString: string;
}

export class DatabaseConfigError extends Error {
  readonly code = 'invalid-database-config';

  constructor() {
    super(INVALID_CONFIG_MESSAGE);
    this.name = 'DatabaseConfigError';
  }
}

/**
 * Read the API runtime connection URL.
 *
 * Only `SESSIONPORT_RUNTIME_DATABASE_URL` is accessed. Migration credentials are
 * deliberately not required or consulted.
 */
export function readRuntimeDatabaseConfig(
  env: NodeJS.ProcessEnv,
): DatabaseConnectionConfig {
  return readDatabaseConfig(env, RUNTIME_DATABASE_URL_ENV);
}

/**
 * Read the migration connection URL.
 *
 * This is intentionally separate from the runtime reader. Migration bootstrap
 * code must opt in to this function explicitly.
 */
export function readMigrationDatabaseConfig(
  env: NodeJS.ProcessEnv,
): DatabaseConnectionConfig {
  return readDatabaseConfig(env, MIGRATION_DATABASE_URL_ENV);
}

function readDatabaseConfig(
  env: NodeJS.ProcessEnv,
  key: typeof RUNTIME_DATABASE_URL_ENV | typeof MIGRATION_DATABASE_URL_ENV,
): DatabaseConnectionConfig {
  const raw = env[key];

  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DatabaseConfigError();
  }
  if (raw.trim() !== raw) {
    throw new DatabaseConfigError();
  }
  if (CONTROL_CHARACTERS.test(raw) || raw.includes('#')) {
    throw new DatabaseConfigError();
  }
  if (BAD_PERCENT_ESCAPE.test(raw)) {
    throw new DatabaseConfigError();
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DatabaseConfigError();
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new DatabaseConfigError();
  }
  if (parsed.hostname.length === 0) {
    throw new DatabaseConfigError();
  }
  if (!hasValidPort(parsed.port) || hasEmptyExplicitPort(raw)) {
    throw new DatabaseConfigError();
  }
  if (parsed.pathname.length <= 1) {
    throw new DatabaseConfigError();
  }
  if (parsed.username.length === 0 || parsed.password.length === 0) {
    throw new DatabaseConfigError();
  }

  const username = decodeComponent(parsed.username);
  const password = decodeComponent(parsed.password);
  const databasePath = decodeComponent(parsed.pathname);
  if (
    username.length === 0 ||
    password.length === 0 ||
    databasePath.length <= 1 ||
    CONTROL_CHARACTERS.test(username) ||
    CONTROL_CHARACTERS.test(password) ||
    CONTROL_CHARACTERS.test(databasePath)
  ) {
    throw new DatabaseConfigError();
  }

  return Object.freeze({ connectionString: raw });
}

function hasValidPort(port: string): boolean {
  if (port.length === 0) {
    return true;
  }
  if (!DECIMAL_PORT.test(port)) {
    return false;
  }

  const numericPort = Number(port);
  return (
    Number.isSafeInteger(numericPort) && numericPort >= 1 && numericPort <= 65_535
  );
}

function hasEmptyExplicitPort(raw: string): boolean {
  const schemeSeparator = raw.indexOf('://');
  if (schemeSeparator === -1) {
    return true;
  }

  const authorityStart = schemeSeparator + 3;
  const pathStart = raw.indexOf('/', authorityStart);
  const queryStart = raw.indexOf('?', authorityStart);
  const authorityEnd = [pathStart, queryStart]
    .filter((index) => index !== -1)
    .reduce((earliest, index) => Math.min(earliest, index), raw.length);
  const authority = raw.slice(authorityStart, authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);

  if (hostAndPort.startsWith('[')) {
    const closingBracket = hostAndPort.indexOf(']');
    return closingBracket !== -1 && hostAndPort.slice(closingBracket + 1) === ':';
  }

  return hostAndPort.endsWith(':');
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DatabaseConfigError();
  }
}
