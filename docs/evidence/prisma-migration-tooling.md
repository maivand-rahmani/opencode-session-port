# Prisma migration tooling and prepared vendor auth migration evidence

Date: 2026-10-19

Status: **PREPARED ARTIFACTS ONLY. THE MIGRATION WAS NOT APPLIED BY THIS WORK. NO MIGRATE DEPLOY/DEV, DB PUSH/PULL, DATABASE CONNECTION, GENERATED CLIENT COMMIT, RUNTIME AUTH, BUSINESS SCHEMA, OR POSTGRESQL 16 PROOF IS CLAIMED BY THIS LANE.** The owner/server-reported reviewed vendor DDL rollback on PostgreSQL 16.15 is recorded below as reported validation, not independently reproduced here. API-01 remains incomplete.

## 1. Scope and authorized writes

Authorized deliverables for this slice:

- `cloud/api/package.json` — exact Prisma pins and explicit preparation/migration scripts
- `bun.lock` — Bun workspace resolution only
- `.gitignore` — one generated-client path entry
- `cloud/api/prisma/schema.prisma` — deterministic derived schema
- `cloud/api/prisma/migrations/migration_lock.toml`
- `cloud/api/prisma/migrations/202610190001_vendor_auth/migration.sql`
- `cloud/api/prisma.config.ts`
- `cloud/api/scripts/prepare-schema.mjs`
- `cloud/api/schema-tools/prepare-schema.node.mjs`
- `docs/evidence/prisma-migration-tooling.md` (this file)
- ignored local output: `cloud/api/prisma/generated/client/**`

No vendor artifact, existing SQL draft, API runtime source, root manifest, root dependency pin, `.env` file, credential, Git state, server, database, or network-to-database path was modified. The independent runtime client factory (`cloud/api/src/database/client.ts` and its test) is owned by another writer and was not edited. Its frozen interface is the generated-client import `../../prisma/generated/client/client.js`, `@prisma/adapter-pg` `PrismaPg({ connectionString })`, and `new PrismaClient({ adapter })`.

## 2. Reviewed inputs remain byte-identical

| Input | Bytes | SHA-256 |
| --- | ---: | --- |
| `cloud/api/prisma/auth.generated.prisma` | 9533 | `092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C` |
| `cloud/api/prisma/drafts/0001_vendor_auth.sql` | 12154 | `09523E4601DC71D124477EC833861C90FF14F2D4C60BA023C8389DBA61E2A6EA` |

The reviewed draft's DDL body (the bytes from its `-- CreateSchema` marker through EOF) is 11,027 bytes with SHA-256 `61229B920E30CA38F77F19AF6DD39246AEE095E834A8B76B6A8FA020A7709D40`, matching the recorded CLI stdout hash. The draft was originally generated from the scratch derived schema with SHA-256 `ADBACD735437417F87232C3BAE1A10A6C89B53FE918E4AA3ABF87D4CFD544BDF`; the prepared schema with SHA-256 `5CF9B275F85B324587255F933ACA4297DDF1DACB4370E0A5D05C5A4DD4252FA2` differs only in the generator output directory, not in the datasource or model bytes, so the reviewed DDL body is unchanged. No vendor or draft bytes were edited.

## 3. Exact pins and Bun lock resolution

Install commands (Bun 1.3.10, normal resolver, lifecycle scripts disabled, public registry downloads only, bounded):

```powershell
bun add --exact --ignore-scripts --cwd cloud/api @prisma/client@7.10.1 @prisma/adapter-pg@7.10.1
# 40 packages installed in 4.23 s

bun add --exact --dev --ignore-scripts --cwd cloud/api prisma@7.10.1
# 222 packages installed in 8.48 s
```

Resulting exact API package pins:

| Field | Package | Version |
| --- | --- | --- |
| `dependencies` | `@prisma/adapter-pg` | `7.10.1` |
| `dependencies` | `@prisma/client` | `7.10.1` |
| `dependencies` | `fastify` (unchanged) | `5.12.7` |
| `devDependencies` | `prisma` | `7.10.1` |
| `devDependencies` | `@types/node` (unchanged) | `24.12.2` |
| `devDependencies` | `tsx` (unchanged) | `4.23.15` |
| `devDependencies` | `typescript` (unchanged) | `5.9.3` |

No direct `pg` dependency was added. `@prisma/adapter-pg@7.10.1` supplies its own internal `pg` dependency (`^8.16.3`); the installed adapter package resolves it.

Lock semantic delta (package entries parsed from `bun.lock`):

- before: 511 entries; after: 644 entries
- added: 133 (Prisma CLI/client/adapter, engine, config, driver-adapter, Studio, and transitive packages)
- changed: 1 existing top-level resolution
- removed: 0

The single changed existing resolution is `env-paths` `2.2.1` → `3.0.0`, caused by the new Prisma transitive `@prisma/streams-local` requiring `^3.0.0`. `node-gyp`'s `^2.2.0` requirement is retained as nested `node-gyp/env-paths@2.2.1`. This is a hoisting adjustment in the new dependency graph, not a broad upgrade; no existing entry was removed.

Root direct dependencies, peer dependencies, dev dependencies, plugin pack allowlist, and package scripts were not changed by this lane. No `package-lock.json` was created and no npm install was used for project dependencies.

Runtime/toolchain: Node `22.13.1`, Bun `1.3.10`, npm `11.5.2`, win32 x64. Prisma CLI `7.10.1` reports its local `@prisma/engines@7.10.1` schema engine hash `d1b3f377ca835d73fd50954a5e22128b9ebdd6b8`; no separate engine download occurred in these commands.

## 4. Derived schema

The new preparation script verifies the exact vendor hash before calling the existing pure assembler:

```js
assembleAuthSchema(vendorBytes, "generated/client")
```

Result:

| Property | Value |
| --- | --- |
| Path | `cloud/api/prisma/schema.prisma` |
| Bytes | 9617 |
| SHA-256 | `5CF9B275F85B324587255F933ACA4297DDF1DACB4370E0A5D05C5A4DD4252FA2` |
| Encoding | UTF-8, no BOM |
| Generator | `prisma-client`, `output = "generated/client"`, `moduleFormat = "esm"`, `importFileExtension = "js"` |
| Models | 13 vendor models |
| Datasource | `postgresql`, no embedded URL |

The assembler replaces only the initial generator block; the datasource block and all vendor model bytes remain identical to the vendor tail. No business model, field, relation, or foreign key was added. The generated-client output path is relative to `cloud/api/prisma/`, so the generated entry point is `cloud/api/prisma/generated/client/client.ts` with ESM `.js` imports.

## 5. Prisma config

`cloud/api/prisma.config.ts`:

- Uses `defineConfig` from `prisma/config`.
- Sets `schema: "prisma/schema.prisma"` and `migrations.path: "prisma/migrations"`.
- Reads only `process.env.SESSIONPORT_MIGRATOR_DATABASE_URL`.
- Imports no dotenv module, loads no env file, defines no alias, reads no runtime URL, and logs no URL or secret.
- Omits `datasource` when the migration URL is absent or empty. Offline `validate`/`generate` therefore work without a URL. Prisma 7.10.1's deployment command config validation requires `datasource.url`; with no datasource the command is rejected before a connection is attempted.

Config-load check with `SESSIONPORT_MIGRATOR_DATABASE_URL` removed printed only structural presence. It reported `schema` and `migrations` present and `datasource` as `undefined`; no URL value was printed. `db:deploy` was not invoked, so the live deploy path is not claimed as exercised.

## 6. Prepared migration artifact

`cloud/api/prisma/migrations/202610190001_vendor_auth/migration.sql` is deterministically derived from the reviewed draft:

- Source draft hash is verified first: `09523E4601DC71D124477EC833861C90FF14F2D4C60BA023C8389DBA61E2A6EA`.
- The DDL body starts at the unique `-- CreateSchema` marker; the body hash is verified as `61229B920E30CA38F77F19AF6DD39246AEE095E834A8B76B6A8FA020A7709D40`.
- The prepared header replaces the old draft header. It records `PREPARED_NOT_APPLIED`, the source hashes, the owner/server-reported PostgreSQL 16.15 rollback result, and the explicit-deploy requirement.
- The reviewed DDL body is appended byte-for-byte after the header. No SQL statement was rewritten, added, or removed.

| Property | Value |
| --- | --- |
| Path | `cloud/api/prisma/migrations/202610190001_vendor_auth/migration.sql` |
| Bytes | 12640 |
| SHA-256 | `EFAB4C8E3CB87EAAC11B98D9613A0A2DC3B20826C22E04E31D2CBC091E6581CD` |
| DDL body bytes | 11027 |
| DDL body SHA-256 | `61229B920E30CA38F77F19AF6DD39246AEE095E834A8B76B6A8FA020A7709D40` |
| Tables | 13 vendor tables |
| Primary keys | 13 |
| Foreign keys | 14 |
| Unique indexes | 9 |
| Non-unique indexes | 17 |

`migration_lock.toml` contains the standard PostgreSQL provider with the standard two comment lines. The existing draft remains unchanged and still carries its historical `DRAFT GENERATED OFFLINE - NOT APPLIED - NOT POSTGRES16_VERIFIED` status token; that historical artifact was not rewritten. The prepared migration header carries the later owner/server-reported PostgreSQL 16.15 rollback result and the `PREPARED_NOT_APPLIED` status.

Reported validation recorded, not reproduced by this lane: the owner/server reported that the reviewed vendor DDL rollback succeeded on PostgreSQL 16.15 with 13 tables and 13 primary keys after DDL, then 0 tables and 0 primary keys after rollback, with psql exit 0. No `_prisma_migrations` row, applied migration, or server state is claimed as a result of preparation.

## 7. Scripts and package commands

`cloud/api/package.json` scripts:

```json
"db:prepare": "node scripts/prepare-schema.mjs",
"db:validate": "npm run db:prepare && prisma validate --config prisma.config.ts",
"db:generate": "npm run db:prepare && prisma generate --config prisma.config.ts",
"db:deploy": "npm run db:prepare && prisma migrate deploy --config prisma.config.ts"
```

`db:deploy` is an explicit operator command only. It is not referenced by application startup, build, test, or package lifecycle. No API `start` script was added.

`cloud/api/scripts/prepare-schema.mjs`:

- Is import-safe; `main` runs only when the file is the process entry point.
- Reads no environment variables and opens no database connection.
- Verifies the vendor hash before assembly, then writes only `prisma/schema.prisma`.
- Verifies the draft hash and DDL body hash before writing the prepared migration.
- Writes only when bytes change and prints only hashes, byte counts, and written/unchanged status.
- Fails closed with stable codes such as `VENDOR_SHA256_DRIFT`, `DRAFT_SHA256_DRIFT`, and `DRAFT_BODY_SHA256_DRIFT`.

## 8. Commands and results

| Check | Command | Result |
| --- | --- | --- |
| Preparation unit tests | `node --test cloud/api/schema-tools/prepare-schema.node.mjs` | **7 tests / 7 pass / 0 fail** |
| Offline validation | `npm run db:validate` (from `cloud/api`, migration URL unset) | exit `0`; `The schema at prisma\schema.prisma is valid` |
| Offline generation | `npm run db:generate` (from `cloud/api`, migration URL unset) | exit `0`; generated Prisma Client `7.10.1` to `.\prisma\generated\client` in 134 ms (final run) |
| Generated entry point | existence check | `cloud/api/prisma/generated/client/client.ts` exists; 21 generated files total; ignored by `.gitignore:22` |
| API typecheck | `npm run typecheck` (from `cloud/api`) | exit `0` |
| Root focused workspace test | `bun test tests/package/workspaces.test.ts` | **9 pass / 1 fail**; the API-boundary test still expects the pre-Prisma manifest, so it fails on the new pins/scripts. That test file was outside this lane's allowed writes and was not edited. |

The preparation tests cover reviewed hashes, exact schema header, vendor tail identity, 13 models, no invented business models, deterministic byte output, temp-owned schema writes, successful migration body identity, import safety/no auto-execution, and fail-closed vendor/draft/body hash drift and body-shape errors. All file writes in the tests are to owner-created temporary directories.

`db:validate` and `db:generate` were each invoked once in their final configuration. They did not connect to a database and did not run `migrate deploy`, `migrate dev`, `db push`, or `db pull`. `db:deploy` was not invoked.

## 9. Checks and claims

| Check | Result |
| --- | --- |
| Exact `prisma@7.10.1` dev pin and `@prisma/client@7.10.1` / `@prisma/adapter-pg@7.10.1` runtime pins | Passed |
| Bun-only lock update, no npm project lock | Passed |
| Existing root direct pins/plugin pack surface untouched by this lane | Passed |
| Vendor schema hash before and after preparation | Passed; unchanged |
| Existing reviewed draft hash before and after preparation | Passed; unchanged |
| Prepared schema hash and 13 vendor models | Passed |
| Vendor datasource/model tail byte identity | Passed |
| Prepared migration source/body hash guards | Passed |
| Prepared migration body byte identity | Passed |
| Migration artifact marked prepared, not applied | Passed |
| Offline `prisma validate` and `prisma generate` | Passed; generated entry point exists |
| API typecheck with the generated client | Passed; no tsconfig override needed |
| Preparation tests | Passed; 7/7 |
| `migrate deploy` / `migrate dev` / `db push` / `db pull` | Not performed |
| Database or server connection | Not performed |
| Migration application or `_prisma_migrations` row | Not performed |
| Independent PostgreSQL 16 runtime proof | Not performed |
| Runtime auth, business schema, storage, deployment | Not performed |

## 10. Limitations and explicit non-claims

- **No migration was applied.** The migration file is prepared, hash-pinned, and marked `PREPARED_NOT_APPLIED`. No `_prisma_migrations` row or database object exists from this work.
- **PostgreSQL 16.15 evidence is owner/server-reported.** This lane did not connect to PostgreSQL, rerun the psql rollback, or independently verify server state. It records the reported result in the artifact header without upgrading it to independent proof.
- **No deploy safety proof.** `db:deploy` was not run. Missing migration URL behavior is fail-closed by omitting `datasource`, but a live deploy path, privileges, migration history, idempotence, locking, and production behavior remain unverified.
- **Generated client is not tracked.** `cloud/api/prisma/generated/client/**` is ignored; only its reproducible entry point and generation command are evidenced. No generated file was added to Git.
- **One root focused test is stale.** `tests/package/workspaces.test.ts` still asserts the old API manifest without Prisma pins/scripts. It failed 1 of 10 tests and was not edited because it is outside this lane's write scope. The validation owner or manifest-test owner must update that expectation.
- **Git line-ending portability is unresolved.** The local repository has `core.autocrlf=true` and no `.gitattributes`. The reviewed vendor/schema artifacts intentionally preserve mixed line endings, and the draft/migration are LF-only. Git's clean/smudge filters would change those bytes on add/checkout: for example, `schema.prisma` is SHA-256 `5CF9B2...52FA2` in the worktree but would be `78E11A...F26E` after the clean filter and `92EE07...4CA2` after a smudged checkout. This lane did not add `.gitattributes` because it is outside the allowed write scope. A byte-preserving attribute (for example `-text`) is required before committing/cloning these artifacts; otherwise the exact-hash guards correctly fail closed. This is a validation-owner action.
- **API-01 is not complete.** No auth runtime, business model, durable grant, storage, host, deployment, or M2 completion is claimed.

## 11. Next step

Independent review of the prepared schema, config, migration artifact, and lock delta. Then update the workspace-boundary test expectation in the owning validation/test lane and run the assigned deploy-gated verification only through an explicit operator action with the real migration URL and approved server procedure.
