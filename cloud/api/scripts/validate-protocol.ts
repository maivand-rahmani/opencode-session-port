/**
 * One-off CLI for the protocol PostgreSQL validation driver.
 *
 * Accepted arguments are exactly `--run-protocol-validation-only
 * --max-run-ms=<ms>`, where `<ms>` is canonical decimal within 1000..120000.
 * The hard deadline starts before environment validation, dynamic client
 * imports, construction, driver execution, cleanup, and disconnect, and exits
 * 124 on expiry. Only `SESSIONPORT_MIGRATOR_DATABASE_URL` is read by the
 * existing strict validation-target reader; there is no .env loading, URL
 * argument, alternate URL key, or runtime-client fallback. Importing this
 * module has no side effects.
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DatabaseConfigError } from '../src/database/config.js';
import {
  ProtocolValidationError,
  runProtocolPostgresValidation,
} from '../test-support/protocol-postgres-validation.js';
import type { ProtocolPostgresValidationResult } from '../test-support/protocol-postgres-validation.js';
import {
  readValidationDatabaseConfig,
  ValidationTargetConfigError,
} from './validate-projects.js';

export const PROTOCOL_RUN_FLAG = '--run-protocol-validation-only';
export const MAX_RUN_MS_ARG = '--max-run-ms=';
export const MIN_RUN_MS = 1_000;
export const MAX_RUN_MS = 120_000;

const STOP_NOT_REQUESTED = 'status=stopped code=protocol-validation-run-not-requested\n';
const STOP_BAD_ARGS = 'status=stopped code=protocol-validation-arguments-invalid\n';
const TIMEOUT_LINE = 'status=timeout code=protocol-validation-deadline-exceeded cleanupVerified=false\n';

export interface ProtocolValidationRunArgs {
  readonly maxRunMs: number;
}

/** Test-only seams. Production entry points pass none of these. */
export interface ProtocolValidationCliDeps {
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly terminate?: (code: number) => void;
  /** Test-only full attempt replacement; the CLI entry point never passes it. */
  readonly testAttempt?: () => Promise<number>;
}

class ProtocolDeadlineError extends Error {}

/** Parse the exact two-argument owner invocation; reject everything else. */
export function parseProtocolValidationRunArgs(
  argv: readonly string[],
): ProtocolValidationRunArgs | null {
  if (
    argv.length !== 2 ||
    argv[0] !== PROTOCOL_RUN_FLAG ||
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
 * Run the CLI protocol. The deadline is armed before environment access,
 * dynamic client imports, construction, driver execution, cleanup, or
 * disconnect. On expiry the process exits 124; cleanup is neither attempted
 * nor claimed.
 */
export async function runProtocolValidationCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (text: string) => void = (text) => process.stdout.write(text),
  deps: ProtocolValidationCliDeps = {},
): Promise<number> {
  const args = parseProtocolValidationRunArgs(argv);
  if (args === null) {
    write(argv.includes(PROTOCOL_RUN_FLAG) ? STOP_BAD_ARGS : STOP_NOT_REQUESTED);
    return 2;
  }

  let deadlineFired = false;
  let timer: unknown;
  const setTimer =
    deps.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const terminate = deps.terminate ?? ((code: number) => { process.exit(code); });

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimer(() => {
      deadlineFired = true;
      write(TIMEOUT_LINE);
      terminate(124);
      reject(new ProtocolDeadlineError());
    }, args.maxRunMs);
  });

  try {
    const attempt = deps.testAttempt ?? (() => executeProtocolValidation(env, write));
    return await Promise.race([attempt(), deadline]);
  } catch (error) {
    if (deadlineFired || error instanceof ProtocolDeadlineError) return 124;
    write('status=failed code=protocol-validation-failed\n');
    return 1;
  } finally {
    clearTimer(timer);
  }
}

async function executeProtocolValidation(
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
): Promise<number> {
  try {
    const { connectionString } = readValidationDatabaseConfig(env);
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('../prisma/generated/client/client.js');

    // Explicit synthetic validation policy, not production limits. pg applies
    // statement/lock timeouts so a blocked case fails instead of reaching the
    // whole-run deadline.
    const adapter = new PrismaPg({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000,
      statement_timeout: 10_000,
      lock_timeout: 5_000,
    }, { schema: 'public' });
    const client = new PrismaClient({ adapter });

    let result: ProtocolPostgresValidationResult;
    try {
      result = await runProtocolPostgresValidation(client);
    } finally {
      await client.$disconnect();
    }
    return writeResult(result, write);
  } catch (error) {
    if (
      error instanceof ValidationTargetConfigError ||
      error instanceof DatabaseConfigError
    ) {
      write('status=blocked code=invalid-protocol-validation-target-config\n');
      return 1;
    }
    if (error instanceof ProtocolValidationError) {
      write(`status=failed code=${error.code}\n`);
      if (error.retainedFixtureUserIDs.length > 0) {
        write(`retainedFixtureUserIDs=${error.retainedFixtureUserIDs.join(',')}\n`);
      }
      return 1;
    }
    write('status=failed code=protocol-validation-failed\n');
    return 1;
  }
}

function writeResult(
  result: ProtocolPostgresValidationResult,
  write: (text: string) => void,
): number {
  write([
    `status=${result.status}`,
    `testPassed=${result.testPassed}`,
    `cleanupVerified=${result.cleanupVerified}`,
    `postgresqlMajor=${result.postgresqlMajor}`,
    `migrations=${result.migrationCount}`,
    `fixtureUsers=${result.fixtureUserCount}`,
    `checks=${result.passedCheckCount}/${result.checkCount}`,
    `failedCheck=${result.failedCheck ?? 'none'}`,
    `retainedFixtureUserIDs=${result.retainedFixtureUserIDs.join(',') || 'none'}`,
  ].join('\n') + '\n');
  return result.status === 'passed' ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  runProtocolValidationCli(process.argv.slice(2), process.env).then(
    (code) => { process.exitCode = code; },
    () => {
      process.stdout.write('status=failed code=protocol-validation-failed\n');
      process.exitCode = 1;
    },
  );
}
