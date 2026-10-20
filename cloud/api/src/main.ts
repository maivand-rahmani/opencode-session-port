import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../prisma/generated/client/client.js';
import { createApi, type CreateApiOptions } from './app.js';
import { readApiConfig, type ApiConfig } from './config.js';
import { createRuntimeDatabaseClient } from './database/client.js';
import {
  createDatabaseReadinessCheck,
  type DatabaseReadinessClient,
} from './database/readiness.js';
import type { ReadinessChecks } from './readiness.js';
import { createCloudRuntime, type CloudRuntime } from './runtime/cloud.js';
import {
  readRuntimeConfig,
  type CloudRuntimeConfig,
} from './runtime/config.js';

const STARTUP_FAILURE_MESSAGE = 'sessionport-api: startup failed\n';

/** The runtime client the bootstrap path owns and must disconnect. */
export interface RuntimeDatabaseClient extends DatabaseReadinessClient {
  $disconnect(): Promise<void>;
}

export interface StartApiOptions {
  /** Explicit readiness checks; omitted keeps the endpoint not-ready. */
  readiness?: ReadinessChecks;
  /** Typed module dependencies excluding config/readiness. */
  modules?: Omit<CreateApiOptions, 'config' | 'readiness'>;
  /** Runs when the Fastify instance closes, including listen-failure cleanup. */
  onClose?: () => void | Promise<void>;
  /** Test seam for listener injection; production uses `app.listen`. */
  listen?: (app: FastifyInstance, config: ApiConfig) => Promise<void>;
}

export interface BootstrapDependencies {
  /** Test seam for the runtime client factory; production reads the env. */
  createDatabaseClient?: (env: NodeJS.ProcessEnv) => RuntimeDatabaseClient;
  /** Test seam for listener injection; production uses `app.listen`. */
  listen?: (app: FastifyInstance, config: ApiConfig) => Promise<void>;
  /** Test seam for the cloud composition factory. */
  createCloudRuntime?: (
    client: PrismaClient,
    config: CloudRuntimeConfig,
  ) => Promise<CloudRuntime>;
}

async function listenOnConfiguredAddress(
  app: FastifyInstance,
  config: ApiConfig,
): Promise<void> {
  await app.listen({ host: config.host, port: config.port });
}

/**
 * Listen on the configured loopback address.
 *
 * Kept separate from module evaluation so imports never open a socket. Callers
 * that need to stop the service can call `app.close()`.
 */
export async function startApi(
  config: ApiConfig,
  options: StartApiOptions = {},
): Promise<FastifyInstance> {
  const app = createApi({
    ...options.modules,
    config,
    readiness: options.readiness,
  });

  if (options.onClose !== undefined) {
    const onClose = options.onClose;
    app.addHook('onClose', async () => {
      await onClose();
    });
  }

  try {
    await (options.listen ?? listenOnConfiguredAddress)(app, config);
  } catch (error) {
    try {
      await app.close();
    } catch {
      // Preserve the original failure; never log raw exception text.
    }
    throw error;
  }

  return app;
}

/**
 * Read explicit configuration, construct the runtime-only database client,
 * listen, and install graceful shutdown handling.
 *
 * The database client is created before listening so invalid runtime
 * configuration fails without opening a socket. Its disconnect runs through the
 * app close hook exactly once, including when listening fails. Migrations are
 * never run here; the migration-only configuration is not read.
 */
export async function bootstrap(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: BootstrapDependencies = {},
): Promise<FastifyInstance> {
  const config = readApiConfig(env);
  // Runtime mode and cloud policy are validated before a client can be built.
  const runtimeConfig = readRuntimeConfig(env, config);
  const createDatabaseClient =
    dependencies.createDatabaseClient ?? createRuntimeDatabaseClient;
  const client = createDatabaseClient(env);

  let disconnected = false;
  const disconnect = async (): Promise<void> => {
    if (disconnected) {
      return;
    }
    disconnected = true;
    await client.$disconnect();
  };

  let app: FastifyInstance;
  try {
    let modules: Omit<CreateApiOptions, 'config' | 'readiness'> | undefined;
    if (runtimeConfig.mode === 'cloud') {
      const cloudFactory =
        dependencies.createCloudRuntime ?? createCloudRuntime;
      // The structural runtime client is validated by the factories it is
      // handed to; the cast is confined to this composition boundary.
      const cloud = await cloudFactory(
        client as unknown as PrismaClient,
        runtimeConfig,
      );
      modules = cloud.api;
    }

    app = await startApi(config, {
      readiness: {
        database: createDatabaseReadinessCheck(client),
        migrations: async () => false,
        storage: async () => false,
      },
      ...(modules === undefined ? {} : { modules }),
      onClose: disconnect,
      listen: dependencies.listen,
    });
  } catch (error) {
    try {
      await disconnect();
    } catch {
      // Preserve the original startup failure; never log raw exception text.
    }
    throw error;
  }

  installShutdownHandlers(app);
  return app;
}

export function installShutdownHandlers(app: FastifyInstance): void {
  let closing = false;

  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);

    void app.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
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
  void bootstrap().catch(() => {
    process.stderr.write(STARTUP_FAILURE_MESSAGE);
    process.exitCode = 1;
  });
}
