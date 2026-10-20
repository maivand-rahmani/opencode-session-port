/**
 * Prisma CLI configuration for the prepared vendor auth schema and migration.
 *
 * The migration connection URL is read only from
 * `SESSIONPORT_MIGRATOR_DATABASE_URL` in the process environment. This file
 * deliberately does not import dotenv, load environment files, read the runtime
 * URL, define URL aliases, or print connection values.
 *
 * When the variable is absent or empty, no datasource URL is supplied. Prisma
 * `validate` and `generate` can then run offline against the derived schema,
 * while database commands such as `migrate deploy` fail closed because they
 * require a datasource URL. A deployment must be an explicit operator action;
 * it is never started by application startup or by these preparation scripts.
 */

import { defineConfig } from "prisma/config";

const MIGRATOR_DATABASE_URL_ENV = "SESSIONPORT_MIGRATOR_DATABASE_URL";

const migratorDatabaseUrl = process.env[MIGRATOR_DATABASE_URL_ENV];

export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
	},
	...(migratorDatabaseUrl === undefined || migratorDatabaseUrl.length === 0
		? {}
		: { datasource: { url: migratorDatabaseUrl } }),
});
