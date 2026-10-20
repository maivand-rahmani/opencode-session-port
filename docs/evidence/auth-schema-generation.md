# Auth vendor schema generation evidence

Date: 2026-10-19
Status: vendor schema generated with pinned tooling; provenance only. **AUTH-01 is not passed**, no database migration/client/runtime auth was exercised.

## Scope and exclusions

Authorized deliverables for this slice:

- `cloud/api/prisma/auth.generated.prisma` (new, generated output)
- `cloud/api/schema-tools/auth-schema.config.ts` (new, schema-generation-only config)
- `docs/evidence/auth-schema-generation.md` (this file)
- `.package-verify-work/auth-schema-20261019-v2a1/` (ignored scratch/tooling)

No root/API/web manifest, lock, tsconfig, source, runtime-auth, test, or business-schema file was edited. No database was created or contacted, no migration or client generation ran, no Prisma client was generated, no listener/service/container was started, no credential was used, and no Git mutation or publication was performed. The API remains fail-closed for `/api/auth/*`.

The config is deliberately outside `src/` and is not imported by the API. It cannot mount routes or enable runtime authentication by itself.

## Inputs reviewed

- `.slim/deepwork/sessionport-v2-local.md`, accepted auth research and Oracle scope notes.
- `docs/V2/SECURITY.md` §6, including vendor-owned auth tables, public native client, device bearer claims, and the unresolved active device/grant requirement.
- `docs/V2/API_AND_DATA.md` §6, business tables and the prohibition on describing/inventing vendor tables.
- `docs/V2/ARCHITECTURE.md` deployment boundary: BetterAuth owns its auth tables; vendor schemas are never hand-rolled or inferred.

## Exact toolchain

Local runtime:

- Node `22.13.1`
- npm `11.5.2`

Pinned registry packages installed into the ignored scratch workspace:

| Package | Version | Registry integrity |
| --- | --- | --- |
| `auth` (Better Auth CLI) | `1.7.11` | `sha512-7whAqIarzgqnlyMQlIFzMe5MLUF/2BvQ5CPFBqbvrkIvnuq65yaqarbOFHgEyMo3IIYENZ/NIbKWhM+mrYypOA==` |
| `better-auth` | `1.7.11` | `sha512-V4OMDdoFvOuAGbOb/mjNzX/iFJoC3hEF1rpL8vdI5eTR24dMJr7AWJuuhr6dE1ib/CBECzegt64ehS3/ngKYpQ==` |
| `@better-auth/oauth-provider` | `1.7.11` | `sha512-4B40t14iKEicI1jvZ916T27guzOYZzuMQ5zq16RxQ9zcVpZLtKLMBh3HsND7/0xjLRHDQ0wkXRkK6vFGE8CNIA==` |
| `@prisma/client` | `7.10.1` | `sha512-5tgAbFGh//zVOC6WPNVgziOErJHYkUE+wmqCwbIyq6IrTXUYtv9y2iBFGh/Owo99Mx0+cr0j1FOrxkYBMuyhaQ==` |

`auth@1.7.11` is the current documented CLI package (bins `auth` and `better-auth`), not the older `@better-auth/cli`; its published engine is `>=22.12.0`, satisfied by Node 22.13.1. The `@prisma/client@7.10.1` dependency is scratch-only: the CLI reads the scratch package's Prisma version to emit the Prisma 7 `prisma-client` generator shape. It is not a project dependency, and no Prisma client was generated.

Scratch workspace:

- Path: `.package-verify-work/auth-schema-20261019-v2a1/` (covered by `.gitignore` entry `.package-verify-work`)
- Scratch `package.json` SHA-256: `5A72AE239117980324BEA080F95C5BA922CE7E9C28BF94A5BE280716716A271C`
- Scratch `package-lock.json` SHA-256: `48748CAF1329DA432AA42E003D9FA9D71CB9CEB998F06C5EBA5C99CAB6659E6A`

Install commands (registry access bounded; lifecycle scripts disabled):

```powershell
npm install --prefix .package-verify-work/auth-schema-20261019-v2a1 --save-exact `
  --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ `
  auth@1.7.11 better-auth@1.7.11 "@better-auth/oauth-provider@1.7.11"
# added 126 packages in 37s

npm install --prefix .package-verify-work/auth-schema-20261019-v2a1 --save-exact `
  --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ `
  "@prisma/client@7.10.1"
# added 2 packages in 4s
```

`npm ls --depth=0` in the scratch prefix reported exactly `auth@1.7.11`, `better-auth@1.7.11`, `@better-auth/oauth-provider@1.7.11`, and `@prisma/client@7.10.1`.

## Config provenance

Deliverable config:

- Path: `cloud/api/schema-tools/auth-schema.config.ts`
- SHA-256: `C1B2D8488E8152AFC1B6B88D4A021FB43D5B5BBBCD9BABF4671220086D537A40`
- Bytes: 3196

Generation used an exact byte copy at:

- `.package-verify-work/auth-schema-20261019-v2a1/auth-schema.config.ts`
- SHA-256: `C1B2D8488E8152AFC1B6B88D4A021FB43D5B5BBBCD9BABF4671220086D537A40`
- Hash equality with the deliverable was checked before generation.

The config explicitly marks itself schema-generation-only and not a runtime auth config. It uses:

- Synthetic localhost origin: `http://localhost:47117`
- Synthetic trusted origin: `http://127.0.0.1:47117`
- Synthetic login/consent paths and device verification URI on that origin
- Explicit synthetic scope list including `sessionport:synthetic`
- `resources: []` deliberately: the pinned oauth-provider seeds configured resources through the adapter at init, and this schema-only config must not perform database/client calls. The intended synthetic resource identifier `http://localhost:47117/api` is recorded in the config comment but is not passed as an active resource.
- Empty schema-only Prisma client placeholder passed to the supported `prismaAdapter(..., { provider: "postgresql" })` API; no query method and no connection.
- No secret, GitHub/social provider, credential, production origin, or validated product default.
- `telemetry: { enabled: false }`; generation also ran with `BETTER_AUTH_TELEMETRY=0` and `DO_NOT_TRACK=1`.

The config cannot activate authentication at runtime because it is not imported by the app, mounts no route, and contains no usable credential or product origin.

## Generation command and environment

Command (from the scratch workspace, using the pinned local CLI entrypoint):

```powershell
node .\node_modules\auth\dist\index.mjs generate `
  --config .\auth-schema.config.ts `
  --adapter prisma `
  --output .\auth.generated.prisma `
  --yes
```

This is the explicit generation command; equivalent CLI form: `auth generate --config <config> --adapter prisma --output <isolated-auth.generated.prisma> --yes`. No `prisma generate`, `prisma migrate`, migration, database, or application runtime command was run.

Before generation, environment variables matching DB/PG/POSTGRES, GITHUB/GH, AUTH/BETTER_AUTH/SESSIONPORT, VERCEL/AWS/S3/SMTP/REDIS, NPM/AUTH token, SECRET/TOKEN/PASSWORD/_KEY, PROD, and NODE_ENV patterns were removed from the child environment. Only synthetic config values were used; no environment dump is included.

Sanitized CLI result:

- Exit code: `0`
- Output: `preparing schema...` then `Schema was generated successfully!`
- No database, credential, config-load, or generator error text.
- PowerShell 5.1 wrapped Node's progress/stderr as a `NativeCommandError` display artifact; the process exit code was still `0` and generation completed. This is a wrapper artifact, not a CLI failure.

## Generated output provenance

Deliverable:

- Path: `cloud/api/prisma/auth.generated.prisma`
- Bytes: 9533
- SHA-256: `092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C`
- Copied byte-for-byte from the scratch output; source and target SHA-256 and byte length matched.

Determinism check: a second generation with the same pinned tool and same config produced the identical 9533-byte file and SHA-256.

Generated vendor models (13):

`User`, `Session`, `Account`, `Verification`, `Jwks`, `OauthClient`, `OauthResource`, `OauthClientResource`, `OauthRefreshToken`, `OauthAccessToken`, `OauthConsent`, `OauthClientAssertion`, `DeviceCode`.

Relevant observed fields (no manual edits):

- `User.id` is Prisma `String @id`; vendor `userId` fields are `String`/`String?`. There is no UUID type/default.
- `DeviceCode` has `deviceCode`, `userCode`, optional `userId`, `expiresAt`, `status`, `lastPolledAt`, optional `pollingInterval`, optional `clientId`, optional `scope`, `resources`, optional `oauthClientId`. It has no device-grant identifier or device FK.
- `OauthRefreshToken` has `id`, `token`, `clientId`, optional `sessionId`, `userId`, optional `referenceId`, optional `authorizationCodeId`, `resources`, `requestedUserInfoClaims`, `expiresAt`, `createdAt`, optional `revoked`/`rotatedAt`/rotation-replay fields, optional `authTime`, optional `confirmation`, and `scopes`. It has no device-code/device-grant field.
- `OauthAccessToken.refreshId` optionally relates to `OauthRefreshToken.id`. This is a vendor token-chain relation; it is **not** a durable device/grant binding.
- `sessionId` on refresh/access tokens relates to the browser auth `Session`, not to a unique device grant.
- Only vendor-intra-schema relations are present. There is no generated `Device`, `DeviceGrant`, `Project`, `Revision`, `Upload`, `AccountKeyBundle`, or `UserQuota` table and no FK to those business tables. The generated `User` is the vendor auth user, not a business model.

## Checks actually performed

| Check | Result |
| --- | --- |
| Exact scratch pins installed with `--ignore-scripts --no-audit --no-fund` | Passed; versions listed above |
| Scratch `npm ls --depth=0` | Passed; exact four packages |
| Deliverable/scratch config byte hash equality | Passed; `C1B2D...37A40` both |
| CLI generation exit | Passed; exit `0` |
| Generated output exists and byte count | Passed; 9533 bytes |
| Deliverable/scratch generated byte hash equality | Passed; `092B8D...0AE5C` both |
| Repeat deterministic generation | Passed; same bytes and SHA-256 |
| Vendor model/field inspection | Passed; 13 models, listed observations |
| No business-table FK inspection | Passed; no business model or business FK found in generated text |
| Database/network service lifecycle | Not performed |
| Prisma validate / prisma generate / migrate | Not performed |
| Runtime auth mount or request test | Not performed |

## Remaining limitations

- **AUTH-01 remains unpassed.** This evidence proves only that the pinned vendor CLI generated a vendor schema from the authorized config. It does not validate JWT issuance, issuer/audience, revocation, refresh rotation, device authorization flow, or per-request active-grant enforcement.
- **Grant binding is unresolved.** The generated `DeviceCode`, refresh-token, access-token, and session fields do not establish a durable per-device grant identifier or FK. No business `Device`/`DeviceGrant` FK was invented or added.
- **No database or migration evidence.** The schema was not applied or introspected against PostgreSQL; no migration was generated/executed; no database credentials or existing services were touched.
- **No Prisma client validation.** `@prisma/client@7.10.1` exists only in the scratch tool workspace so the CLI emits the Prisma 7 generator shape. No client was generated, no query was run, and no project dependency was added.
- **Project schema assembly is pending.** The vendor output is a standalone schema with `generator client { provider = "prisma-client" }` and a PostgreSQL datasource without a URL. A later reviewed step must decide how vendor and business schemas are combined, including Prisma 7 generator output placement and migration ownership.
- **Synthetic config is not product configuration.** The localhost origin, paths, scopes, and resource placeholder are not validated product defaults and must not be promoted. The config is schema-generation-only and never imported by the API.
- **No runtime auth state changed.** `/api/auth/*` remains fail-closed; no BetterAuth handler is mounted and no auth route was exercised.
