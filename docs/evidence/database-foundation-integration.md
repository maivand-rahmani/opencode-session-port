# Database Foundation Integration — Prepared Prisma Artifacts, Runtime Wiring, and Reported DDL Validation

Date: 2026-10-19

Status: **PARTIAL — PREPARED, NOT APPLIED (2026-10-19 HISTORICAL SLICE; see the 2026-10-20 supersession note below). THIS 2026-10-19 RECORD DOES NOT CLAIM AN APPLIED MIGRATION, A REAL RUNTIME DATABASE QUERY, ENABLED AUTH, SERVER DEPLOYMENT, GENERAL POSTGRESQL 16 COMPATIBILITY, OR M2 COMPLETION. NO FRESH DATABASE, NETWORK, AUTH, BUILD, OR TEST RUN WAS PERFORMED FOR THIS DOCUMENTATION RECORD; THE RESULTS BELOW ARE ATTRIBUTED TO THE LANES THAT REPORTED THEM.**

> **2026-10-20 supersession note (validation-database scope only).** This record's prepared-only status remains the historical 2026-10-19 state and still holds for the application/production database. The owner/server later reported a successful persistent `prisma migrate deploy` (exit 0) to the isolated `session_port_validation` database of `202610190001_vendor_auth` and `202610190002_project_quota`; see [postgres-validation-migrations.md](postgres-validation-migrations.md). This agent did not independently connect to or inspect that server, image, or database, and the prepared migration headers remain historical `PREPARED_NOT_APPLIED` comments. The `Project` + `UserQuota` schema is also no longer proposal-only: it is implemented locally with a separate additive migration ([project-quota-schema.md](project-quota-schema.md)) and a `src/projects/repository.ts` create/link/list precursor with **19 fake-client tests only**; actual PostgreSQL quota/tenant concurrency tests have not been run. All other non-claims (no application/production apply, API deployment, runtime query proof, enabled auth, storage, crypto, or M2 completion) remain.

Validation owner: orchestrator. This evidence document consolidates the later 2026-10-19 database-foundation integration work so the roadmap does not promote prepared artifacts into a deployment. The documentation lane only read the targeted documents/source and re-derived local SHA-256 values offline; it did not connect to a database or server, run `psql`, run application tests, install/build, or change Git state.

## 1. Provenance and attribution

| Class | What is recorded | Evidence boundary |
| --- | --- | --- |
| Owner/server report | Isolated PostgreSQL validation on `session_port_validation` as `sessionport_validation_migrator`, PostgreSQL 16.15: initial SHA mismatch refusal, the psql exit-0 DDL/rollback result, and the later 2026-10-20 persistent `prisma migrate deploy` (exit 0; two finished migrations) | Reported to the parent; not independently reproduced by a local server, image, or database connection. The final server-side hash was not explicitly returned for the DDL-rollback attempt. |
| Implementation/parent-lane report | Exact Prisma pins, deterministic assembly, prepared migration, generated ignored client, runtime factory/bootstrap/readiness wiring, proxy-client test, current API/root focused test counts | Reported by the owning lanes and accepted by the orchestrator; this lane did not rerun them. |
| Local artifact inspection | SHA-256/byte values for the reviewed vendor schema, SQL draft, prepared migration, and generated validation wrapper | Re-derived locally from the worktree files and the pure wrapper builder. This is artifact identity only, not database proof. |

## 2. Reviewed local artifacts

| Artifact | Bytes | SHA-256 | Status |
| --- | ---: | --- | --- |
| `cloud/api/prisma/auth.generated.prisma` | 9533 | `092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C` | Reviewed vendor schema; unchanged |
| `cloud/api/prisma/drafts/0001_vendor_auth.sql` | 12154 | `09523E4601DC71D124477EC833861C90FF14F2D4C60BA023C8389DBA61E2A6EA` | Reviewed draft; unchanged |
| `cloud/api/prisma/migrations/202610190001_vendor_auth/migration.sql` | 12640 | `EFAB4C8E3CB87EAAC11B98D9613A0A2DC3B20826C22E04E31D2CBC091E6581CD` | Prepared artifact marked `PREPARED_NOT_APPLIED` (hash as recorded in [prisma-migration-tooling.md](prisma-migration-tooling.md)) |
| Generated rollback-validation SQL for the reviewed draft | 23949 | `8802D46A66C5D501845D570EBAD2E9CB152821E3C4B22714FD93CFEDC300C53F` | Wrapper produced by the pure `buildValidationSql` path; rollback only; not a migration and not committed |

The generated wrapper hash was recomputed from the reviewed draft with its 13 expected tables: `user`, `session`, `account`, `verification`, `jwks`, `oauthClient`, `oauthResource`, `oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `oauthClientAssertion`, `deviceCode`. The wrapper is the fail-closed psql text that guards the database/role/major version, applies the pinned draft in a transaction, asserts 13 tables/13 primary keys, rolls back, and asserts emptiness. It is validation tooling, not a Prisma migration.

## 3. Prepared Prisma tooling and offline checks

Implemented artifacts:

- Exact API pins: `@prisma/client@7.10.1`, `@prisma/adapter-pg@7.10.1`, and dev `prisma@7.10.1`; existing Fastify/tsx/TypeScript/`@types/node` pins unchanged.
- `cloud/api/schema-tools/**`: deterministic assembly of the reviewed vendor schema; the prepared `0001` migration is derived from the reviewed draft with its source/body hash guards.
- `cloud/api/prisma.config.ts`: migration CLI reads only `SESSIONPORT_MIGRATOR_DATABASE_URL`; no dotenv/env-file load, no runtime-URL alias, no URL logging. With the variable absent, `validate`/`generate` run offline and database commands fail closed.
- `cloud/api/prisma/migrations/migration_lock.toml` and prepared `202610190001_vendor_auth/migration.sql`.
- `cloud/api/prisma/generated/client/**`: ignored ESM generated client (`prisma-client`, `moduleFormat = "esm"`, `importFileExtension = "js"`). No generated file is tracked.

Reported checks (commands as recorded or supplied; not rerun here):

| Check | Command / scope | Reported result |
| --- | --- | --- |
| Preparation tests | `node --test cloud/api/schema-tools/prepare-schema.node.mjs` | **7/7 pass** |
| Assembler tests | `node --test cloud/api/schema-tools/assemble-auth-schema.node.mjs` | **8/8 pass** |
| Wrapper tests | `node --test cloud/api/schema-tools/build-validation-sql.node.mjs` | **15/15 pass** |
| Offline validation | `npm run db:validate` from `cloud/api` with the migration URL unset | exit 0; schema valid |
| Offline generation | `npm run db:generate` from `cloud/api` with the migration URL unset | exit 0; generated Prisma Client 7.10.1; entry point exists |
| API typecheck | `npm run typecheck` from `cloud/api` | PASS (Node 22.13.1, Windows) |
| Current API suite | `npm test` from `cloud/api` | **76/76 pass across 9 files**, 1999.1376 ms (reported) |
| Root focused workspace check | `bun test tests/package/workspaces.test.ts` | **10/10 pass, 78 assertions**, after the exact expectation update (reported) |

The API suite count in this 2026-10-19 slice is `76/76`; the later 2026-10-20 repository slice records 19 additional fake-client tests separately, and the two results are not combined into a 95-test claim. The earlier **37/37 across 4 files** result belongs to the historical pre-database-integration slice. No new root full suite was run: the prior **658 pass / 17,534 expectations / 48 files** root result remains the last recorded full root run and is not a current claim for this later API state. The root plugin pack boundary assertions still cover 58 files; no new consumer pack install ran in this slice.

Recorded non-blocking observation: Fastify `FSTDEP023` warns that the top-level `disableRequestLogging` option is deprecated (removal targeted for Fastify 6). It is recorded, not fixed here; it was not a safety or test failure.

## 4. Isolated PostgreSQL DDL validation (owner/server-reported)

Target facts: database **`session_port_validation`**, role **`sessionport_validation_migrator`**, PostgreSQL **16.15**. This is a validation database, not the application `session_port` database.

1. An initial transfer was rejected by the server agent's SHA-256 check before `psql` was run. No DDL was applied by that attempt.
2. The owner/server later reported `psql` exit **0** with the fixed markers: after the reviewed DDL, **13 tables and 13 primary keys**; after rollback, **0 tables and 0 primary keys**. The wrapper also fails closed unless the target database, role, PostgreSQL major version, read-write state, and initial emptiness match.
3. The final server-side hash was not explicitly returned. No independent local server connection or server-state inspection exists in the recorded evidence.

**2026-10-20 update (validation database only):** the owner/server later reported a persistent `prisma migrate deploy` (exit 0) to `session_port_validation`, with both `202610190001_vendor_auth` and `202610190002_project_quota` finished, 15 base tables plus `_prisma_migrations` (16 total), both named `UserQuota` CHECK constraints, and both `Project`/`UserQuota` foreign keys to `user.id` `ON DELETE RESTRICT`. See [postgres-validation-migrations.md](postgres-validation-migrations.md). This remains **validation-database state only**, not `session_port` or another application/production database; the migration headers were not edited and remain historical `PREPARED_NOT_APPLIED` comments.

This earlier section is **DDL rollback validation only**. It is not `prisma migrate deploy`, not an applied migration, not a `_prisma_migrations` row, not application-database state, and not a general PostgreSQL 16 compatibility claim. The application database `session_port` (private Docker) is still believed to contain **0 application tables**, because no committed migration has been applied there; the later validation-database apply does not change that.

## 5. Runtime database lifecycle and readiness

- Purpose-separated configuration: the API runtime factory reads only `SESSIONPORT_RUNTIME_DATABASE_URL`; migration CLI configuration reads only `SESSIONPORT_MIGRATOR_DATABASE_URL`. There is no `.env` auto-read, no URL alias, no secret logging, and no mutation of the original URL.
- `bootstrap` reads the API config, creates the runtime Prisma client before listening, installs a once-only disconnect through the app close hook, and also disconnects on startup/listen failure. Migrations are never started by application startup; the migration configuration is not read on this path.
- `/health/ready` invokes a database `SELECT 1` probe only on a specific readiness request. The probe is single-flight: concurrent callers share one query until settlement, and a late/aborted result is never reported ready.
- Migration and storage readiness checks are fixed `false` in this slice, so `/health/ready` remains **503** even if the database probe succeeds.
- In this 2026-10-19 slice, all business, auth-enabled, storage, and deployment gates remain off/unchanged.

## 6. Prisma extension-proxy client identity

The initial client-identity test reported **3 pass / 2 fail** because Prisma 7.10.1 returns an extension proxy whose `getPrototypeOf` trap is `Object.prototype`; the conventional `client instanceof PrismaClient` check is false by design. The proxy contract was diagnosed from the public generated client runtime, and the test was adapted to assert the public constructor, `Symbol.toStringTag`, and schema delegates with source proof. The final client test is **5/5 PASS**.

This does not establish a real database query, a connection, or constructor-laziness behavior. Client construction and `$disconnect` are exercised without querying; no actual DB query was performed.

## 7. Auth redesign boundary

- The owner approved the native own-flow redesign direction, and the website BetterAuth flow remains unchanged.
- [NATIVE_AUTH_DESIGN.md](../V2/NATIVE_AUTH_DESIGN.md) remains a **PROPOSAL**, not active specification or an approved implementation. The independent initial review was **REVISE**; the material GO covers **isolated high-entropy credential primitives only**.
- The credential primitives have **14 focused tests PASS** and are included in the 76-test API suite of this 2026-10-19 slice.
- Unapproved/unimplemented: full auth routes, native auth schema, grant lifecycle, short-code/HMAC key management, CSRF design/proof, secure vault, and auth enablement.
- BetterAuth 1.7.11 source supports `getSession({ disableCookieCache: true, disableRefresh: true })`; this is source support only, not a runtime proof. A custom Fastify CSRF mechanism is not automatic and remains undesigned/unproven.
- **AUTH-01 is pending and is not declared passed.** The provider built-in durable device-grant gap remains real. The redesign proposal records that gap without silently rewriting the original AUTH-01 acceptance criteria; the old acceptance text remains historical, and any formal supersession needs an explicit freeze/owner action.
- No business `Device` table, grant foreign key, or invented linkage is added.

## 8. Next business schema (historical proposal; implemented locally 2026-10-20)

The next business-schema slice was defined read-only (the active `ora7` review) as **`Project` + `UserQuota` only**, following the proposed shapes in [API_AND_DATA.md](../V2/API_AND_DATA.md) §6. **2026-10-20 update:** this is no longer proposal-only. The additive schema and `202610190002_project_quota` migration are implemented locally with recorded hashes in [project-quota-schema.md](project-quota-schema.md); the reviewed vendor schema and `0001` migration remain byte-unchanged. `cloud/api/src/projects/repository.ts` implements tenant-scoped create/link/list with **19 fake-client tests** and an API typecheck pass only — the owner-provided quota/tenant concurrency tests against actual PostgreSQL are **not yet run**. The two migrations are owner/server-reported applied on `session_port_validation` only (see [postgres-validation-migrations.md](postgres-validation-migrations.md)); no application/production apply exists. No `Device`/grant linkage is invented. API-03 is **In progress (schema foundation only)** — quota accounting/enforcement, uploader, `/v1/me`, and real concurrency tests remain unimplemented; API-01 remains **In progress**.

## 9. Explicit non-claims and limits

- In this 2026-10-19 slice, no `prisma migrate deploy`, `migrate dev`, `db push`, or `db pull` was run and no `_prisma_migrations` row existed. The only later recorded persistent apply is the **owner/server-reported 2026-10-20 validation-database run** in [postgres-validation-migrations.md](postgres-validation-migrations.md); no application/production `_prisma_migrations` state is known, and the prepared migration headers were not edited.
- For the earlier DDL-rollback attempt, no final server-side hash was returned, and there is no independent local connection to the validation server or PostgreSQL. The later 2026-10-20 apply is likewise owner/server-reported and was not independently observed by this lane.
- No real Prisma client query, connection, transaction, or business-table access was exercised; the later `src/projects/repository.ts` slice is fake-client tested only, and the actual PostgreSQL repository/concurrency tests have not been run.
- No application database tables are known to exist in `session_port`; the DDL rollback is not deployment evidence, and the 2026-10-20 validation database (reported 15 base tables plus `_prisma_migrations`) is validation-only evidence, not application/production deployment.
- No auth is enabled; no route/schema/lifecycle/CSRF/vault/key-management approval exists; no AUTH-01 pass is claimed.
- No PostgreSQL 16.15 compatibility generalization, server deployment, storage, M2 completion, publication, or full-package review is claimed.
- No new root full suite or consumer pack install was run; the 58-file pack surface is preserved only by prior focused assertions.
- `.gitattributes` adds `-text` for the four hash-pinned artifact scopes to preserve exact bytes, but no Git checkout/commit/push proof exists, and this lane made no Git mutation.
- Crypto status is unchanged and out of scope for this record.
- The lock delta is recorded as **+133 / -0** with `env-paths` 2.2.1 → 3.0.0 hoisted; the old nested `node-gyp` entry requiring 2.2.1 is retained. This is a report, not a broad-upgrade approval.

## 10. Sources

- [prisma-migration-tooling.md](prisma-migration-tooling.md) — source artifacts, exact commands, prepared migration, offline validate/generate, original non-claims.
- [postgres-validation-migrations.md](postgres-validation-migrations.md) — 2026-10-20 owner/server-reported persistent validation-database apply and its boundaries.
- [project-quota-schema.md](project-quota-schema.md) — additive `Project` + `UserQuota` schema/migration, preserved hashes, offline evidence.
- [prisma-validation-handoff.md](prisma-validation-handoff.md) / [prisma-validation-docker-handoff.md](prisma-validation-docker-handoff.md) — bundle hashes and Docker execution plan.
- [repository.ts](../../cloud/api/src/projects/repository.ts) — tenant-scoped project create/link/list precursor (fake-client tests only).
- [api-foundation.md](api-foundation.md) — workspace boundary, health/transport source, historical API test evidence.
- [auth-schema-generation.md](auth-schema-generation.md) — vendor schema provenance and generation-only boundary.
- [local-foundation-regression.md](local-foundation-regression.md) — earlier 658-root / 37-API coherent regression (historical for the API count).
- [NATIVE_AUTH_DESIGN.md](../V2/NATIVE_AUTH_DESIGN.md) — proposed native auth redesign and its unresolved gates.
