# M2 runtime acceptance — 2026-10-24

Status: **M2 / API-01 / API-02 / API-03 `Completed` for the bounded M2 acceptance scope.** The
corrected isolated PostgreSQL 16 runtime run passed **16/16** (exit `0`, cleanup verified), and the
earlier corrected live protocol run passed **15/15** including the two-device sibling race and the
quota reservation race. Every acceptance criterion below has source-side evidence and, where the
criterion is runtime-observable, a recorded live check. This is **not** whole-product, M3, M4,
deployment, production, or platform completion; the exact boundaries are in §6.

## 1. Current runtime run (r2)

Source: [r2 result](../../.package-verify-work/new-server-m2-dto-retry-20261024/r2/m2-runtime-dto-retry-result-20261024.json)
(`sessionport-m2-runtime-dto-retry-r2-result-20261024`, created `2026-10-24T14:39:09Z`).

| Item | Recorded value |
| --- | --- |
| Target | New isolated PostgreSQL 16.15 cluster, database `session_port_validation`, internal container network, no published host ports |
| Runtime command | `node --import tsx scripts/validate-runtime.ts --run-runtime-validation-only --max-run-ms=90000` |
| Result | `status=passed`, `testPassed=true`, `checks=16/16`, `failedCheck=none`, exit `0`, no outer timeout |
| Cleanup | `cleanupVerified=true`; `retainedFixtureUserIDs=none`; `retainedFixtureIDs=none` |
| Preserved old fixture | `runtime-validation-5b8ee25e-753d-418a-aded-f83190a00e4c` present; app rows `7` before and `7` after (delta `0`); not touched or deleted |
| Migrations | `3` finished; all three file checksums matched the approved values |
| Schema | Migration-stage postcheck on this cluster: 23 application tables plus `_prisma_migrations`; 24 primary keys, 34 foreign keys, 20 check constraints, 20 unique indexes; 0 sequences/views. r2's `schema-shape` check passed. |
| Runtime grants | Migration-stage record: DML on 23 application tables; `_prisma_migrations` read denied with SQLSTATE `42501`; schema `USAGE` true / `CREATE` false. r2 postcheck reconfirmed 23 table grants, no migration-history grants, and roles passed. |
| Image provenance | Verified immutable base `sha256:1d58734e7250e16d7e07a53031feb739d74e924f6ed357cca0b79394acc2f29e`; derived image `sha256:01051ef1fc6ff5085db0296b897a2dc51bbf88f5989fe1fbfb2cd4d1b67e05d4` |
| Driver / CLI | Driver `683da50ea8ce93c285844433abde90acfccee6a013bd4e372c4771502c4d78c1`; CLI `bcf77969a933a2de407d3657bff1c70986a677c4eb82f78107c5cb5daa1167cb` |
| Database mutation discipline | `migrationExecutionsThisRun=0`; `grantExecutionsThisRun=0`; `databaseReset=false`; `extraCleanup=false`; `runtimeAttemptsThisRun=1` |
| Scope safety | Main/production database not accessed; no application service started; no host ports published; no Git action; no product-source or DTO edits |

The retry supplied a corrected validation driver (`683da50e...4d78c1`) whose `/v1/me` assertions match the current
`storageLimitBytes`/`storageUsedBytes`/`storageReservedBytes` DTO. The product route/repository were
not edited; the prior integration failure diagnosed the mismatch but did not change product source.

The three migration checksums are the approved values from
[M1–M3 schema contract](m1-m3-schema-contract.md):

- `202610190001_vendor_auth` — `efab4c8e3cb87eaac11b98d9613a0a2dc3b20826c22e04e31d2cbc091e6581cd`
- `202610190002_project_quota` — `97c6b494d51cfaf15c9b2cc69b17720653086223510856d838b95211887e4550`
- `202610200003_protocol_native` — `82c420e972c6f7c50cda9ed8e9c6c0407db7d6dce3ea76058dccd14802ec9c26`

The 16 check names defined by the corrected driver (`683da50e...4d78c1`) are:

```text
database-identity
postgresql-major-16
migrations-finished
schema-shape
health-live-200
health-ready-503
native-pending-flow
native-token-exchange
authenticated-me-initial
project-create-list
quota-initial-reserve-200
quota-reject-500
quota-accept-400
authenticated-me-final
cleanup-exact-scope
cleanup-verified
```

## 2. What the live run actually exercised

The runtime evidence is precise about its seams; none of these substitutes for a deployed service.

- **Fastify `inject`, not a bound network service.** The run builds the real Fastify app with
  `startApi(...)` and a no-op `listen`, then calls `app.inject(...)` for `/health/live`,
  `/health/ready`, `/api/native/v1/token`, `/v1/me`, and `/v1/projects`. No TCP listener, host port,
  reverse proxy, TLS, or deployed process is proven.
- **Synthetic identity fixture, not real OAuth.** The run inserts a synthetic `user` row and
  `UserQuota` row directly, calls the native device-authorization service with synthetic config,
  approves the code for that fixture user, and exchanges a token through the injected route. No
  GitHub/BetterAuth browser login, real user, session, CSRF, or OAuth callback is exercised.
- **Quota primitives, not M4 upload admission.** The quota checks call the upload repository's
  `reserve(...)` directly with a test-only 1,000-byte limit. The upload HTTP routes are not mounted,
  no object storage exists, and no M4 upload/download flow is proven. The rejected reservation check
  returns the repository's `413 storage-limit-reached`, leaves `reservedBytes` unchanged, and inserts
  no upload row.
- **Database cleanup is direct and exact-scope.** Cleanup runs against the generated fixture IDs and
  verifies the tracked scope; it does not clean the pre-existing failed-attempt fixture.
- **Database role.** The driver ran with `SESSIONPORT_MIGRATOR_DATABASE_URL` only
  (`runtimeDatabaseKeyAbsent=true`), as approved. The restricted runtime role was verified separately
  with a read-only connection: DML on the 23 application tables, no `_prisma_migrations` rights, read
  denied with SQLSTATE `42501`. The 16/16 checks do not prove the application operates under the
  runtime role; least-privilege runtime execution remains a deployment boundary.

The rejected-check name `quota-reject-500` refers to the requested 500-byte reservation, not an HTTP
status. The observed repository error is `413`.

## 3. Historical corrected live protocol run (15/15)

Source: [protocol cap validation result](protocol-postgres-cap-validation-result-20261021.md)
(2026-10-21), preceded by the [cleanup handoff](protocol-cap-cleanup-handoff-20261021.md). The
recorded run used the pinned driver `7acfc4cf82bdbc0de26bb148d7ff738a5279d89a887527aa30b771021c86fa15`
and reported:

```text
status=passed
testPassed=true
cleanupVerified=true
postgresqlMajor=16
migrations=3
fixtureUsers=8
checks=15/15
failedCheck=none
retainedFixtureUserIDs=none
```

The 15 check names defined by the pinned driver (`7acfc4cf...86fa15`) are:

```text
database-identity
postgresql-major-16
migrations-finished
business-tables-empty
fixture-seed
project-create-cap-tenant-isolation
revision-concurrent-siblings
revision-idempotent-replay
revision-page-upper-bound-live-heads
revision-page-limit-zero-tenant-not-found
quota-reservation-race
pending-exchange-atomic-active-grant-cap
refresh-rotation-concurrent-replay-revokes
pending-approval-per-user-cap-isolation
cleanup-verified
```

This is live PostgreSQL evidence at the repository/service layer: `revision-concurrent-siblings`
commits from two devices against the same project, and `quota-reservation-race` issues two
concurrent 600-byte reservations under a 1,000-byte limit. It is **not** a bound HTTP service run:
the protocol driver calls repositories/services directly with a real Prisma client. Revision route
status mapping is covered by injected/fake-client route tests. The source record characterizes the
run as one bounded execution, not repeated concurrency, a platform matrix, or a charge/complete
pipeline proof. It is historical evidence recorded 2026-10-21 and was not rerun against the
2026-10-24 runtime image; the current repository tests supply the source-side coverage.

## 4. Acceptance matrix

Legend: **Source** = local test file(s) and recorded source checks; **Live** = recorded run check
name(s); **Boundary** = the limit of that evidence.

### API-01 — Backend foundation

| Criterion | Source evidence | Live evidence | Result / boundary |
| --- | --- | --- | --- |
| Fastify + TypeScript service with configuration plumbing | `cloud/api/test/app.node.ts`, `config.node.ts`, `database/config.node.ts`, `runtime/cloud.node.ts`; Fastify 5.12.7 / TypeScript 5.9.3 pins in `cloud/api/package.json` | `health-live-200`, `health-ready-503` through the built app | Proven at the in-process Fastify level. No bound listener or deployed process. |
| Initial Prisma migration creates the §6 business tables (vendor tables owned by AUTH-01) | `m1-m3-schema-contract.md`; prepared `0003`; `schema-tools/*.node.mjs` 9/9 and 9/9; `db:validate`/`db:generate` recorded | `migrations-finished`, `schema-shape`; schema postcheck 23 app tables, 34 FKs, 20 checks, 20 unique indexes | Proven on the isolated validation database. Vendor tables are present from `0001`; business tables are the `0002`/`0003` additions. No application/production apply. |
| `/health/live` and `/health/ready` per contract | `app.node.ts` (live 200; ready 200 only when every check true; ready defaults 503; false/thrown checks 503); `readiness.node.ts`; `database/readiness.node.ts` | `health-live-200`, `health-ready-503` | Proven. The live run exercises the 503 path with migration/storage checks fixed `false`; the 200 path is source-tested, not live. |
| Focused tests pass against a database | `cloud/api/test/**` source suite (previously recorded `375/375` plus typecheck PASS, not rerun for this record); DB-backed runtime driver in `cloud/api/test-support/runtime-postgres-validation.ts` | 16/16 runtime run against the isolated validation database | Satisfied by the isolated validation-database harness (the non-production database used for this acceptance). No separate development environment or production database is claimed. |
| No auth/storage behavior enabled before its gate | `app.node.ts` (`/v1` and `/api/auth` default-deny; sanitised 503); `uploads/service.node.ts` (disabled factory rejects 503); health-only default | Runtime harness injects test-only native auth and calls quota primitives directly | Proven for product defaults: no deployed auth/storage path is enabled. The harness seams are synthetic test injection, not a production enablement. |

### API-02 — Projects and revision protocol

| Criterion | Source evidence | Live evidence | Result / boundary |
| --- | --- | --- | --- |
| Explicit project create/link by client-chosen UUID, canonical `projectID`, no path/Git linking | `cloud/api/test/projects/repository.node.ts` (create at 201, link at 200, idempotent/concurrent link, cap, tenant scope, label handling); `projects/routes.node.ts` (create 200/201, forged identity fields rejected, 422 input, 401/503 gates) | `project-create-list` (create then list through injected HTTP); protocol `project-create-cap-tenant-isolation` (repository create path via `createOrLink`, cap + tenant isolation) | Proven. Live create/list and repository create; the HTTP link response is source/inject-tested, not live. |
| Event pages anchored by `upperBound`, `nextAfter`/`hasMore`, live `currentHeadIDs`, decimal-string non-decreasing cursors | `revisions/repository.node.ts` (freeze upper bound, live heads, leading-zero cursors, bounds, limit zero, tenant scope); `revisions/routes.node.ts`; `protocol/cursor.node.ts` 10/10 | `revision-page-upper-bound-live-heads`, `revision-page-limit-zero-tenant-not-found` | Proven live at repository level; route-level page behavior is inject/fake-tested. |
| Project row lock + conditional head remove/add, sibling preservation, idempotent retry, documented status semantics, no overwrite/delete/auto-merge | `revisions/repository.node.ts` (lock order, sibling heads, replay at 200, differing replay 409, missing/foreign errors, no deletion on failure); `revisions/routes.node.ts` (fixed lowercase envelopes, 400/422/409/503) | `revision-concurrent-siblings`, `revision-idempotent-replay` | Proven live at repository level: two concurrent sibling commits both survive with one conflict; identical retry does not mutate sequence/head state. No live HTTP commit run. |
| Focused tests include a two-device sibling-commit race | `revisions/repository.node.ts` “synthetic concurrent sibling commits serialise and both survive” | `revision-concurrent-siblings` — devices `revisionA`/`revisionB`, real PostgreSQL | Proven live. The race is repository-level, not through a bound HTTP API. |

### API-03 — Usage accounting and quota enforcement

| Criterion | Source evidence | Live evidence | Result / boundary |
| --- | --- | --- | --- |
| `UserQuota` row lock enforces `used + reserved + new <= limit`; configurable planning values (1 GiB / 3 devices / 10 projects / 100 MiB ceiling) | `quota/accounting.node.ts` (exact fit, oversize, unsafe counters, static tagged lock SQL, move/release underflow); `projects/repository.node.ts` (quota lock + cap); `uploads/repository.node.ts`; documented defaults in `docs/V2/API_AND_DATA.md` §7 | `quota-initial-reserve-200`, `quota-reject-500`, `quota-accept-400`; protocol `quota-reservation-race` | Proven formula/lock and live reserve/reject/accept. The live run used explicit test-only limits/caps (1,000 bytes; 1 active project), not the 1 GiB / 10-project planning values; those remain configurable documented values, not live-proven constants. |
| Active project/device caps enforced under lock with explicit errors; no silent eviction/truncation | `projects/repository.node.ts` (cap after locked count, no partial write, fixed error); `native-auth/*` cap tests; `me/repository.node.ts` | `project-create-cap-tenant-isolation`; `pending-exchange-atomic-active-grant-cap`; `pending-approval-per-user-cap-isolation` | Proven live, including one-of-two create rejection at the cap and approval/grant cap isolation. |
| `/v1/me` reports usage and limits | `me/repository.node.ts` (explicit limits, safe counters, tenant counts, missing/unsafe failure); `me/routes.node.ts` (authorizer principal, forged headers, 401/503) | `authenticated-me-initial`, `authenticated-me-final` (injected HTTP, exact DTO fields `storageLimitBytes`/`storageUsedBytes`/`storageReservedBytes`, counts) | Proven live through Fastify `inject`; no bound HTTP listener. |
| Quota-full blocks uploads explicitly and never touches local state | `uploads/repository.node.ts` (413 at storage total, 422 at ciphertext ceiling, no writes, quota rollback, exactly-once charge) | `quota-reject-500`: `UploadRepositoryError('storage-limit-reached', 413)`, reservation unchanged, zero upload row | Proven at the M2 quota/upload-repository primitive. The M4 upload HTTP admission route, object storage, and client local-state path are not mounted or exercised. |
| Focused tests cover concurrent reservations | `uploads/repository.node.ts` “serialises fake interactive transactions so concurrent reservations cannot overbook” | `quota-reservation-race`: two concurrent 600-byte reservations under 1,000 bytes | Proven in one bounded live run on real PostgreSQL (one accepted, no overbook); source fake-client test covers the serialization path. Not a repeated concurrency matrix. |

## 5. Acceptance decision

The bounded M2 criteria are satisfied by the combination above, not by the 16/16 run alone:

- The r2 runtime record itself deferred M2 acceptance to the parent validation owner and made no
  completion claim; this record performs that acceptance reconciliation from the recorded evidence.
- The 16/16 run closes the previously open API-01 application-service runtime item (health,
  readiness, `/v1/me`, project create/list) and the API-03 live reserve/reject/accept and `/v1/me`
  items. It does **not** exercise revisions.
- The 15/15 corrected protocol run closes the API-02 live repository/concurrency items
  (`revision-concurrent-siblings`, replay, page upper bound/live heads) and the API-03 concurrent
  reservation and cap-isolation items. It was previously recorded as “M2 remains Partial”; this
  record reconciles that earlier recommendation with the later 16/16 runtime result.
- No bounded M2 criterion is left with only an unrun promise. The residual limits are boundary
  limits (in-process HTTP, repository-level protocol, migrator-URL driver with a separately verified
  runtime role, validation database, no real OAuth/storage/deployment); they are recorded as explicit
  boundaries of this acceptance and are not converted into M3, M4, or production claims.

**M2 status: `Completed` (2026-10-24), bounded scope only.** API-01, API-02, and API-03 are
`Completed` on the same boundary. M3, M4, deployment, and production remain unchanged.

## 6. Preserved history and non-claims

Historical attempts are retained, not erased or rewritten:

- **2026-10-20 — protocol `6/15` FAIL**, failed `revision-concurrent-siblings`; diagnosed as a
  driver-only assertion bug; no retry/cleanup; fixtures retained.
  [Result](protocol-postgres-validation-result-20261020.md).
- **2026-10-21 — protocol `13/15` FAIL**, failed `pending-approval-per-user-cap-isolation`; eight
  fixtures retained. [Follow-up handoff](protocol-cap-followup-handoff-20261021.md). A later exact
  cleanup and corrected `15/15` run are separate evidence.
- **2026-10-24 — integration runtime attempt FAIL**, failed `authenticated-me-initial` because the
  driver expected `limits.limitBytes/usedBytes/reservedBytes` while the current `/v1/me` returns
  `limits.storageLimitBytes/storageUsedBytes/storageReservedBytes`; one attempt, no retry, no
  cleanup. [Integration result](../../.package-verify-work/new-server-m2-integration-20261024/RESULT-20261024.json).
- **2026-10-24 — r1 build FAIL** (`BUILD`): BuildKit treated `FROM sha256:<id>` as a registry
  reference; no image, no layer, no database connection. Preserved alongside the r2 success.
- The failed integration attempt left fixture user
  `runtime-validation-5b8ee25e-753d-418a-aded-f83190a00e4c` and related rows; r2 preserved that old
  fixture (app rows `7` → `7`) and cleaned only its own generated IDs.

Not claimed: a bound or deployed Fastify/network service; real GitHub/BetterAuth OAuth, browser
session, CSRF, or vault; M3 host/TUI runtime; M4 upload admission, upload/download routes, object
storage, janitor, or provider capability; application-database migration, main-database access,
production quota behavior, deployment, or a platform matrix. The remote runs are
remote-agent-reported, not independently observed by the local documentation lane. No test, build,
install, database command, or Git action was performed for this reconciliation.

## 7. Evidence index

- [r2 runtime result](../../.package-verify-work/new-server-m2-dto-retry-20261024/r2/m2-runtime-dto-retry-result-20261024.json) — 16/16, cleanup, postcheck, hashes.
- [r2 runtime log](../../.package-verify-work/new-server-m2-dto-retry-20261024/r2/evidence/runtime.log) — sanitized recorded output.
- [integration result](../../.package-verify-work/new-server-m2-integration-20261024/RESULT-20261024.json) — migrations/grants pass and the earlier failed runtime attempt.
- [protocol cap validation result](protocol-postgres-cap-validation-result-20261021.md) — corrected 15/15 live protocol run.
- [M1–M3 schema contract](m1-m3-schema-contract.md) — migration hashes and native/business model contract.
- [V2 roadmap](../V2/ROADMAP.md) — authoritative status block and task statuses.
