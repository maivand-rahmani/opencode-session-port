/**
 * Runtime database client factory.
 *
 * This module is deliberately narrow: it validates the runtime connection
 * configuration, constructs a PostgreSQL driver adapter and the generated
 * Prisma client, and returns that client. It never connects, runs queries,
 * applies migrations, logs, reads env files, or starts timers/listeners.
 *
 * Both the adapter and the Prisma client construct lazily. The caller owns the
 * client lifecycle, including `$disconnect`.
 */

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../prisma/generated/client/client.js';
import { readRuntimeDatabaseConfig } from './config.js';

const INVALID_CLIENT_MESSAGE = 'Database client initialization failed.';

export class DatabaseClientError extends Error {
  readonly code = 'database-client-initialization-failed';

  constructor() {
    super(INVALID_CLIENT_MESSAGE);
    this.name = 'DatabaseClientError';
  }
}

/**
 * Build the API runtime Prisma client from `SESSIONPORT_RUNTIME_DATABASE_URL`.
 *
 * Configuration failures are surfaced unchanged as `DatabaseConfigError`.
 * Adapter/client construction failures are mapped to a fixed
 * `DatabaseClientError` so URLs, credentials, and driver details never escape.
 */
export function createRuntimeDatabaseClient(
  env: NodeJS.ProcessEnv,
): PrismaClient {
  const { connectionString } = readRuntimeDatabaseConfig(env);

  try {
    const adapter = new PrismaPg({ connectionString });
    return new PrismaClient({ adapter });
  } catch {
    throw new DatabaseClientError();
  }
}
