/**
 * SCHEMA-GENERATION-ONLY CONFIGURATION — NOT A RUNTIME AUTH CONFIGURATION.
 *
 * This file is consumed only by the pinned vendor CLI:
 *   auth@1.7.11 generate --config <this-file> --adapter prisma \
 *     --output <isolated-auth.generated.prisma> --yes
 *
 * It deliberately lives outside `src/`, is not imported by the API, does not
 * mount any route, does not open a database connection, and cannot activate
 * authentication at runtime. The API's fail-closed `/api/auth/*` boundary is
 * unrelated to this file.
 *
 * Every URL, scope, resource, and secret-like value below is a synthetic
 * localhost placeholder. None is a validated product default, deployment
 * origin, credential, or approved OAuth policy. Do not import this module in
 * application code.
 *
 * `prismaAdapter` is supplied because the vendor CLI expects a supported
 * database adapter option shape while generating schema. The client object is
 * an empty schema-only placeholder; no query method is implemented and no
 * database connection is created. Do not configure `oauthProvider.resources`
 * here: the pinned plugin seeds configured resources through the adapter at
 * init, which would require a live client. The synthetic resource identifier
 * is recorded in comments for future gate review only.
 */

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { jwt } from "better-auth/plugins/jwt";
import {
  oauthDeviceAuthorization,
  oauthProvider,
} from "@better-auth/oauth-provider";

/** Synthetic origin; not a product/application origin. */
const syntheticOrigin = "http://localhost:47117";

/**
 * Synthetic protected-resource identifier, reserved for a future reviewed
 * runtime configuration. It is intentionally not passed to `oauthProvider`:
 * any configured resource makes plugin init seed an `oauthResource` row via
 * the database adapter, which this schema-generation-only config must not do.
 */
const syntheticResource = `${syntheticOrigin}/api`;

/**
 * Empty, schema-only Prisma client placeholder. `PrismaClient` from the
 * vendor adapter is an empty interface; no client dependency or connection is
 * required for schema generation. No query is expected to run.
 */
const schemaOnlyPrisma = {} as Parameters<typeof prismaAdapter>[0];

export const auth = betterAuth({
  appName: "SessionPort synthetic schema generation (not runtime)",
  baseURL: syntheticOrigin,
  basePath: "/api/auth",
  trustedOrigins: [syntheticOrigin, "http://127.0.0.1:47117"],
  telemetry: { enabled: false },
  database: prismaAdapter(schemaOnlyPrisma, { provider: "postgresql" }),
  plugins: [
    jwt(),
    oauthProvider({
      loginPage: `${syntheticOrigin}/synthetic-login`,
      consentPage: `${syntheticOrigin}/synthetic-consent`,
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "sessionport:synthetic",
      ],
      resources: [],
    }),
    oauthDeviceAuthorization({
      verificationUri: `${syntheticOrigin}/synthetic-device`,
    }),
  ],
});

export default auth;

// Referenced only to keep the documented synthetic placeholder reviewable.
void syntheticResource;
