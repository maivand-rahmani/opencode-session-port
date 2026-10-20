# PostgreSQL validation migrations — persistent apply (owner/server-reported)

Date: 2026-10-20

Status: **OWNER/SERVER-REPORTED APPLY TO THE ISOLATED VALIDATION DATABASE ONLY. NO INDEPENDENT AGENT CONNECTION TO, INSPECTION OF, OR QUERY AGAINST THE SERVER, DOCKER DAEMON, BUILT IMAGE, OR DATABASE EXISTS. THIS IS NOT AN APPLICATION/PRODUCTION MIGRATION, API DEPLOYMENT, RUNTIME DATABASE-QUERY PROOF, GENERAL POSTGRESQL COMPATIBILITY CLAIM, AUTH/STORAGE/CRYPTO CHANGE, OR M2 COMPLETION.**

Validation owner: orchestrator. This record compiles the owner/server report and the already-recorded local artifact evidence; the documentation lane performed no fresh tests, database connection, Docker command, install, build, or Git operation. Links were the only check.

## 1. Provenance and execution environment

| Item | Reported value | Boundary |
| --- | --- | --- |
| Source | Owner/server report relayed to the parent/orchestrator | Not independently observed by this documentation lane |
| Platform | Linux amd64 | Reported only |
| Docker | 29.7.2 | Reported only |
| Node | 22.23.3 | Reported only |
| Bun | 1.3.10 | Reported only |
| PostgreSQL / psql | 16.15 | Reported only |
| Target database | `session_port_validation` only | Never `session_port` or another application/production database |
| Migrator role | `sessionport_validation_migrator` | Existing role; no role bootstrap/change reported |
| Built immutable image | `sha256:af9d6a1209f9aa6316c47cf0c922556c058fc3fd513cf8d0d156eca26756b294` | Image ID reported by the server lane; this agent did not inspect it |

The earlier host-tool gate had stopped without changes; the execution plan was updated to the Docker-only path with **no host install**. A context-directory assertion then stopped the run before deploy because it did not accept normal parent-directory entries; a bounded correction allowed exactly the 17 expected regular files plus normal parents. That correction addressed context assembly, **not a failed migration**; no migration retry occurred.

## 2. Input verification (reported)

| Input | Reported hash | Manifest |
| --- | --- | --- |
| Original bundle `sessionport-prisma-validation-20261020.zip` | `1DEBE7468DB3A63E310C595B3E21F7538641BBF9CD8C15119E6D0EDE943FCFC4` | 14-file `SHA256SUMS` passed |
| Supplemental bundle `sessionport-prisma-validation-docker-20261020.zip` | `EEBF63BF28520D6CC8C930120263252C734393655050BC4587A11CE157D6E039` | Supplemental `SHA256SUMS` passed |

Both hash comparisons matched and both supplied manifests passed, as reported by the server lane. These are archive-integrity results, not database proof. Preparation details remain in [prisma-validation-handoff.md](prisma-validation-handoff.md) and [prisma-validation-docker-handoff.md](prisma-validation-docker-handoff.md).

## 3. Persistent apply result (owner/server-reported)

- The guarded `npm run db:deploy` / `prisma migrate deploy` invocation exited **0**.
- `public._prisma_migrations` contains exactly **two finished** rows — `202610190001_vendor_auth` and `202610190002_project_quota` — with **zero unfinished** and **zero rolled-back** rows.
- `public` contains **15 base tables** excluding `_prisma_migrations` (13 vendor tables plus `Project` and `UserQuota`), **16 tables total** including migration history.
- `UserQuota` has its **primary key**, `UserQuota_bytes_nonnegative_check`, and `UserQuota_usage_within_limit_check`.
- `Project_userID_fkey` and `UserQuota_userID_fkey` both reference `"user"("id")` with `ON DELETE RESTRICT`.
- The target was `session_port_validation` only; `session_port` and the API were unchanged.

These are metadata assertions from the reported post-deploy verification. No row content, connection string, password, role secret, or environment file is recorded here.

## 4. Local schema and repository follow-on (fake tests only)

- The additive `Project` + `UserQuota` schema and `202610190002_project_quota` migration (the local `fix-28` ProjectQuota slice) are recorded in [project-quota-schema.md](project-quota-schema.md). The reviewed vendor schema (`092B...0AE5C`), draft (`0952...A6EA`), and prepared `0001` migration (`EFAB...81CD`) remained byte-unchanged; the combined schema is `1ED6...30D2` and `0002` is `97C6...4550`.
- The prepared migration headers were **not edited** and still carry the historical `PREPARED_NOT_APPLIED` comments. This record supersedes only the **target status** for `session_port_validation`; it does not rewrite the artifacts.
- `cloud/api/src/projects/repository.ts` implements tenant-scoped project create/link/list with a `UserQuota` row lock, an explicit positive active-project cap, idempotent own-project linking, and fixed sanitized errors.
- Recorded checks: **19 fake-client native Node tests** and API typecheck **PASS**. The planned quota/tenant concurrency tests against actual PostgreSQL have **not yet been run**.
- The prior coherent API **76/76 across 9 files** gate precedes these 19 tests. A combined **95**-test suite or any new full-suite pass is **not** claimed.

## 5. Non-claims and limits

- This agent did not connect to, query, or inspect the server, Docker daemon, built image, PostgreSQL instance, `_prisma_migrations`, or table constraints.
- No application/production database migration was performed or observed; `session_port` remains outside this apply.
- No API deployment, authenticated HTTP route, runtime application DB query, revision/DAG, quota accounting/enforcement, uploader, storage, or enabled auth exists.
- HOST-01, storage, and cloud-crypto status are unchanged and out of scope for this record.
- AUTH full routes, native grant lifecycle, and CSRF remain off/unapproved; the 14 focused credential tests are within the prior 76-test API scope, not evidence for this apply.
- No general PostgreSQL 16 compatibility claim, production readiness claim, or M2 completion claim is made.
- No fresh tests, installs, builds, Docker commands, or Git operations were performed for this record; links were checked only.
- The migration apply is migration-CLI evidence only; it is not proof of application repository behavior or quota concurrency.

## 6. Next validation steps

1. After review and owner authorization, run the planned quota/tenant concurrency scenarios against actual PostgreSQL through the real generated Prisma client/repository — not fake clients.
2. Then implement/verify the remaining API-02 authenticated HTTP/revision-DAG behavior and API-03 reservation/charge enforcement, `/v1/me`, and quota-full upload blocking.
3. Keep application/production migration and API deployment out of scope until their explicit owner gates.

## 7. Sources

- [database-foundation-integration.md](database-foundation-integration.md) — 2026-10-19 prepared-artifact and runtime-wiring record.
- [prisma-migration-tooling.md](prisma-migration-tooling.md) — prepared migration/tooling evidence.
- [prisma-validation-handoff.md](prisma-validation-handoff.md) — original bundle hash, target guard, expected post-deploy state.
- [prisma-validation-docker-handoff.md](prisma-validation-docker-handoff.md) — Docker-only plan, image design, immutable-image and context requirements.
- [project-quota-schema.md](project-quota-schema.md) — additive schema/migration hashes and offline checks.
- [repository.ts](../../cloud/api/src/projects/repository.ts) — fake-tested tenant-scoped project repository.
- [ROADMAP.md](../V2/ROADMAP.md) — current task statuses and non-claims.
