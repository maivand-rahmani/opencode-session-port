/**
 * Bounded M2 runtime validation CLI (preparation only).
 *
 * Accepted arguments are exactly
 * `--run-runtime-validation-only --max-run-ms=<ms>` with a canonical decimal
 * 1000..120000. Argument parsing happens before any environment or database
 * import. The hard deadline starts before environment validation, dynamic
 * imports, client construction, the driver, cleanup, and disconnect; expiry
 * exits 124. There is no .env loading, URL argument, retry, or automatic
 * cleanup on failure.
 */

import { pathToFileURL } from 'node:url';
import type { RuntimeValidationResult } from '../test-support/runtime-postgres-validation.js';

export const RUNTIME_RUN_FLAG = '--run-runtime-validation-only';
export const MAX_RUN_MS_ARG = '--max-run-ms=';
export const MIN_RUN_MS = 1_000;
export const MAX_RUN_MS = 120_000;

const STOP_NOT_REQUESTED =
  'status=stopped code=runtime-validation-not-requested\n';
const STOP_BAD_ARGS =
  'status=stopped code=runtime-validation-arguments-invalid\n';
const TIMEOUT_LINE =
  'status=timeout code=runtime-validation-deadline-exceeded cleanupVerified=false\n';

export interface RuntimeValidationRunArgs {
  readonly maxRunMs: number;
}

/**
 * Test-only function dependencies. Production entry points pass none of these;
 * there is no environment flag or alternate live clock.
 */
export interface RuntimeValidationCliDeps {
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly terminate?: (code: number) => void;
  /** Test-only full attempt replacement; the entry point never passes it. */
  readonly testAttempt?: () => Promise<RuntimeValidationResult>;
}

class RuntimeValidationDeadlineError extends Error {}

export function parseRuntimeValidationRunArgs(
  argv: readonly string[],
): RuntimeValidationRunArgs | null {
  if (
    argv.length !== 2 ||
    argv[0] !== RUNTIME_RUN_FLAG ||
    !argv[1]!.startsWith(MAX_RUN_MS_ARG)
  ) {
    return null;
  }
  const raw = argv[1]!.slice(MAX_RUN_MS_ARG.length);
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

export async function runRuntimeValidationCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (text: string) => void = (text) => process.stdout.write(text),
  deps: RuntimeValidationCliDeps = {},
): Promise<number> {
  const args = parseRuntimeValidationRunArgs(argv);
  if (args === null) {
    write(argv.includes(RUNTIME_RUN_FLAG) ? STOP_BAD_ARGS : STOP_NOT_REQUESTED);
    return 2;
  }

  let deadlineFired = false;
  let timer: unknown;
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, delayMs: number) =>
      setTimeout(callback, delayMs));
  const clearTimer =
    deps.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const terminate =
    deps.terminate ??
    ((code: number) => {
      process.exit(code);
    });

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimer(() => {
      deadlineFired = true;
      write(TIMEOUT_LINE);
      terminate(124);
      reject(new RuntimeValidationDeadlineError());
    }, args.maxRunMs);
  });

  try {
    const attempt =
      deps.testAttempt ?? (() => executeRuntimeValidation(env));
    const result = await Promise.race([attempt(), deadline]);
    writeResult(write, result);
    return result.testPassed ? 0 : 1;
  } catch (error) {
    if (deadlineFired || error instanceof RuntimeValidationDeadlineError) {
      return 124;
    }
    writeFailure(write, error);
    return 1;
  } finally {
    // Kept until the attempt (including disconnect) settles or the deadline
    // fires. A hanging disconnect therefore still reaches the hard deadline.
    clearTimer(timer);
  }
}

async function executeRuntimeValidation(
  env: NodeJS.ProcessEnv,
): Promise<RuntimeValidationResult> {
  const harness = await import(
    '../test-support/runtime-postgres-validation.js'
  );
  const { connectionString } =
    harness.readRuntimeValidationDatabaseConfig(env);
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { PrismaClient } = await import(
    '../prisma/generated/client/client.js'
  );

  const adapter = new PrismaPg({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 10_000,
  });
  const client = new PrismaClient({
    adapter,
    transactionOptions: { maxWait: 5_000, timeout: 10_000 },
  });

  try {
    return await harness.runRuntimePostgresValidation(
      client,
      harness.createRuntimeValidationOptions(),
    );
  } finally {
    await client.$disconnect();
  }
}

function writeResult(
  write: (text: string) => void,
  result: RuntimeValidationResult,
): void {
  write(`status=${result.testPassed ? 'passed' : 'failed'}\n`);
  write(`testPassed=${result.testPassed}\n`);
  write(`cleanupVerified=${result.cleanupVerified}\n`);
  write(`postgresqlMajor=${result.postgresqlMajor}\n`);
  write(`migrations=${result.migrationCount}\n`);
  write(`fixtureUsers=${result.fixtureUserCount}\n`);
  write(`checks=${result.passedCheckCount}/${result.checkCount}\n`);
  write(`failedCheck=${result.failedCheck ?? 'none'}\n`);
  write(
    `retainedFixtureUserIDs=${
      result.retainedFixtureUserIDs.length === 0
        ? 'none'
        : result.retainedFixtureUserIDs.join(',')
    }\n`,
  );
  write(
    `retainedFixtureIDs=${
      result.retainedFixtureIDs.length === 0
        ? 'none'
        : result.retainedFixtureIDs.join(',')
    }\n`,
  );
}

function writeFailure(write: (text: string) => void, error: unknown): void {
  const failure = readFailure(error);
  write('status=failed\n');
  write('testPassed=false\n');
  write('cleanupVerified=false\n');
  write('postgresqlMajor=unknown\n');
  write('migrations=unknown\n');
  write('fixtureUsers=1\n');
  write('checks=unknown\n');
  write(`failedCheck=${failure.code}\n`);
  write(
    `retainedFixtureUserIDs=${
      failure.userIDs.length === 0 ? 'none' : failure.userIDs.join(',')
    }\n`,
  );
  write(
    `retainedFixtureIDs=${
      failure.ids.length === 0 ? 'none' : failure.ids.join(',')
    }\n`,
  );
}

function readFailure(error: unknown): {
  readonly code: string;
  readonly userIDs: readonly string[];
  readonly ids: readonly string[];
} {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      readonly code?: unknown;
      readonly retainedFixtureUserIDs?: unknown;
      readonly retainedFixtureIDs?: unknown;
    };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        userIDs: readStringArray(candidate.retainedFixtureUserIDs),
        ids: readStringArray(candidate.retainedFixtureIDs),
      };
    }
  }
  return { code: 'validation-unavailable', userIDs: [], ids: [] };
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function isExecutedAsMainModule(): boolean {
  const entryPath = process.argv[1];
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(entryPath).href;
  } catch {
    return false;
  }
}

if (isExecutedAsMainModule()) {
  void runRuntimeValidationCli(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('sessionport-api: runtime validation failed\n');
      process.exitCode = 1;
    },
  );
}
