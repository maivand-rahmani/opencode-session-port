/**
 * One-off CLI for the project repository PostgreSQL integration validation.
 *
 * Accepted arguments are exactly `--run-validation-only --max-run-ms=<ms>`, where
 * `<ms>` is canonical decimal within 1000..120000. The hard deadline starts
 * before environment validation and dynamic imports, covers construction, run,
 * cleanup, and disconnect, and exits 124 on expiry. Only
 * `SESSIONPORT_MIGRATOR_DATABASE_URL` is read; there is no .env loading, URL
 * argument, or test environment flag. Importing this module has no side effects.
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DatabaseConfigError,
  readMigrationDatabaseConfig,
} from '../src/database/config.js';
import type { DatabaseConnectionConfig } from '../src/database/config.js';
import type { PrismaClient } from '../prisma/generated/client/client.js';
import {
  ProjectValidationError,
  runProjectPostgresValidation,
} from '../test-support/projects-postgres-validation.js';
import type { ProjectPostgresValidationResult } from '../test-support/projects-postgres-validation.js';

export const VALIDATION_RUN_FLAG = '--run-validation-only';
export const MAX_RUN_MS_ARG = '--max-run-ms=';
export const MIN_RUN_MS = 1_000;
export const MAX_RUN_MS = 120_000;

const VALIDATION_DATABASE = 'session_port_validation';
const VALIDATION_ROLE = 'sessionport_validation_migrator';
const VALIDATION_HOST = 'session-port-postgres';
const KNOWN_SSLMODES = new Set([
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
]);
const INVALID_TARGET_MESSAGE = 'Validation target configuration is invalid.';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const STOP_NOT_REQUESTED = 'status=stopped code=validation-run-not-requested\n';
const STOP_BAD_ARGS = 'status=stopped code=validation-arguments-invalid\n';
const TIMEOUT_LINE = 'status=timeout code=validation-deadline-exceeded cleanupVerified=false\n';

export class ValidationTargetConfigError extends Error {
  readonly code = 'invalid-validation-target-config';

  constructor() {
    super(INVALID_TARGET_MESSAGE);
    this.name = 'ValidationTargetConfigError';
  }
}

export interface ValidationRunArgs {
  readonly maxRunMs: number;
}

/**
 * Test-only function dependencies. Production entry points pass none of these;
 * there is no environment flag or alternate live clock.
 */
export interface ValidationCliDeps {
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly terminate?: (code: number) => void;
  /** Test-only full attempt replacement; the CLI entry point never passes it. */
  readonly testAttempt?: () => Promise<number>;
}

class ValidationDeadlineError extends Error {}

/** Parse the exact two-argument owner invocation; reject everything else. */
export function parseValidationRunArgs(
  argv: readonly string[],
): ValidationRunArgs | null {
  if (
    argv.length !== 2 ||
    argv[0] !== VALIDATION_RUN_FLAG ||
    !argv[1].startsWith(MAX_RUN_MS_ARG)
  ) {
    return null;
  }
  const raw = argv[1].slice(MAX_RUN_MS_ARG.length);
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const maxRunMs = Number(raw);
  if (
    !Number.isSafeInteger(maxRunMs) ||
    maxRunMs < MIN_RUN_MS ||
    maxRunMs > MAX_RUN_MS
  ) {
    return null;
  }
  return { maxRunMs };
}

/**
 * Apply strict, literal URL guards after the existing migration config reader.
 * Optional query parameters are limited to `schema=public` and a known
 * lowercase `sslmode` value; duplicates and every other override are rejected.
 */
export function assertValidationTargetConnectionString(raw: string): void {
  if (
    raw.length === 0 ||
    raw.trim() !== raw ||
    raw.includes('#') ||
    CONTROL_CHARACTERS.test(raw)
  ) {
    throw new ValidationTargetConfigError();
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationTargetConfigError();
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ValidationTargetConfigError();
  }
  if (
    parsed.hash !== '' ||
    parsed.hostname !== VALIDATION_HOST ||
    (parsed.port !== '' && parsed.port !== '5432')
  ) {
    throw new ValidationTargetConfigError();
  }

  const username = decodeComponent(parsed.username);
  const password = decodeComponent(parsed.password);
  const database = decodeComponent(
    parsed.pathname.startsWith('/')
      ? parsed.pathname.slice(1)
      : parsed.pathname,
  );
  if (
    username !== VALIDATION_ROLE ||
    password.length === 0 ||
    database !== VALIDATION_DATABASE
  ) {
    throw new ValidationTargetConfigError();
  }

  const seenKeys = new Set<string>();
  for (const [key, value] of parsed.searchParams) {
    if (seenKeys.has(key)) throw new ValidationTargetConfigError();
    seenKeys.add(key);

    if (key === 'schema') {
      if (value !== 'public') throw new ValidationTargetConfigError();
    } else if (key === 'sslmode') {
      if (!KNOWN_SSLMODES.has(value)) throw new ValidationTargetConfigError();
    } else {
      throw new ValidationTargetConfigError();
    }
  }
}

/**
 * Read the migration key, then enforce the dedicated validation target. The
 * returned connection string is the original accepted value.
 */
export function readValidationDatabaseConfig(
  env: NodeJS.ProcessEnv,
): DatabaseConnectionConfig {
  const config = readMigrationDatabaseConfig(env);
  assertValidationTargetConnectionString(config.connectionString);
  return config;
}

/**
 * Run the CLI protocol. The hard deadline is armed before environment access,
 * dynamic imports, client construction, driver execution, cleanup, or
 * disconnect. On expiry the process is terminated with 124; cleanup is not
 * attempted and no cancellation/rollback is claimed.
 */
export async function runValidationCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (text: string) => void = (text) => process.stdout.write(text),
  deps: ValidationCliDeps = {},
): Promise<number> {
  const args = parseValidationRunArgs(argv);
  if (args === null) {
    write(argv.includes(VALIDATION_RUN_FLAG) ? STOP_BAD_ARGS : STOP_NOT_REQUESTED);
    return 2;
  }

  let deadlineFired = false;
  let timer: unknown;
  const setTimer =
    deps.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const terminate =
    deps.terminate ?? ((code: number) => { process.exit(code); });

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimer(() => {
      deadlineFired = true;
      write(TIMEOUT_LINE);
      terminate(124);
      reject(new ValidationDeadlineError());
    }, args.maxRunMs);
  });

  try {
    const attempt = deps.testAttempt ?? (() => executeValidation(env, write));
    return await Promise.race([attempt(), deadline]);
  } catch (error) {
    if (deadlineFired || error instanceof ValidationDeadlineError) return 124;
    write('status=failed code=validation-failed\n');
    return 1;
  } finally {
    // Kept until the attempt (including disconnect) settles or the deadline
    // fires. A hanging disconnect therefore still reaches the hard deadline.
    clearTimer(timer);
  }
}

async function executeValidation(
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
): Promise<number> {
  try {
    const { connectionString } = readValidationDatabaseConfig(env);
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('../prisma/generated/client/client.js');

    // Test budgets only, not production defaults. pg supports
    // `connectionTimeoutMillis`, `query_timeout`, and `statement_timeout`;
    // Prisma supports transaction `maxWait` and `timeout`.
    const adapter = new PrismaPg({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000,
      statement_timeout: 10_000,
    });
    const client: PrismaClient = new PrismaClient({
      adapter,
      transactionOptions: { maxWait: 5_000, timeout: 10_000 },
    });

    let result: ProjectPostgresValidationResult;
    try {
      result = await runProjectPostgresValidation(client);
    } finally {
      await client.$disconnect();
    }

    return writeResult(result, write);
  } catch (error) {
    if (
      error instanceof ValidationTargetConfigError ||
      error instanceof DatabaseConfigError
    ) {
      write('status=blocked code=invalid-validation-target-config\n');
      return 1;
    }
    if (error instanceof ProjectValidationError) {
      write(`status=failed code=${error.code}\n`);
      return 1;
    }
    write('status=failed code=validation-failed\n');
    return 1;
  }
}

function writeResult(
  result: ProjectPostgresValidationResult,
  write: (text: string) => void,
): number {
  write(
    [
      `status=${result.status}`,
      `testPassed=${result.testPassed}`,
      `cleanupVerified=${result.cleanupVerified}`,
      `postgresqlMajor=${result.postgresqlMajor}`,
      `migrations=${result.migrationCount}`,
      `fixtureUsers=${result.fixtureUserCount}`,
      `checks=${result.passedCheckCount}/${result.checkCount}`,
      `failedCheck=${result.failedCheck ?? 'none'}`,
    ].join('\n') + '\n',
  );
  return result.status === 'passed' ? 0 : 1;
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ValidationTargetConfigError();
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  runValidationCli(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stdout.write('status=failed code=validation-failed\n');
      process.exitCode = 1;
    },
  );
}
