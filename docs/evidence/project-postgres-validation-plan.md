# Project PostgreSQL Integration Validation Plan

Status: **prepared, not executed**. Live database access, fixture writes, and cleanup
require explicit owner authorization and an owner-scoped run. This document does not
claim any PostgreSQL result, deployment, privilege proof, or production compatibility.

## Purpose and scope

Validate the actual `createProjectRepository` implementation against the migrated
PostgreSQL validation database using the generated Prisma client and `PrismaPg`. This
is a one-off fixture validation with the migrator credential; it is **not** a
long-running API-runtime, privilege-separation, or production-cap proof.

Target database: `session_port_validation` on `session-port-postgres:5432`, role
`sessionport_validation_migrator`. The owner reports this database is migrated by
migrations `202610190001_vendor_auth` and `202610190002_project_quota` (15 tables,
PostgreSQL 16.15, Docker image
`sha256:af9d6a1209f9aa6316c47cf0c922556c058fc3fd513cf8d0d156eca26756b294`).
Those claims remain owner/server-reported until this validation is run.

## Target URL guard

The CLI reads only `SESSIONPORT_MIGRATOR_DATABASE_URL` via the existing
`readMigrationDatabaseConfig`; it does not load `.env`, accept a URL argument, or
read the runtime URL key. Before any client construction it additionally requires:

- decoded database exactly `session_port_validation`;
- decoded username exactly `sessionport_validation_migrator`, non-empty password;
- host exactly `session-port-postgres`, port omitted (default 5432) or `5432`;
- no fragment, no duplicate query keys, no query overrides;
- only optional `schema=public` and lowercase `sslmode` in
  `disable|allow|prefer|require|verify-ca|verify-full`.

## Pre-write guards (read-only)

The driver runs these authoritative reads before the first write. Any mismatch stops
the run with `database-guard-failed` and **does not enter cleanup**:

1. `current_database()`, `current_user`, and `session_user` equal the validation
   target and role.
2. PostgreSQL major version is 16.
3. `_prisma_migrations` contains exactly the two expected migration names, each
   finished with no rollback.
4. `user`, `Project`, and `UserQuota` counts are all zero.

## Synthetic fixtures

IDs are generated in memory with `node:crypto` `randomUUID` before writes. Users use
the `sessionport-pg-test-` prefix, fixed synthetic name, and random
`@test.example.invalid` email. No passwords, tokens, sessions, or keys are created.
User A and B receive quota `limitBytes=1024`, `usedBytes=0`, `reservedBytes=0`; user C
has no quota. These are test values only, not inferred product caps. The only label
bytes are opaque synthetic `Uint8Array([1,2,3])`; this is a storage test, not a claim
of cloud-crypto or ciphertext validity. Seeding is one atomic Prisma interactive
transaction.

## Cases

1. A, cap 1: two concurrent different-UUID creates; exactly one 201 and one
   `active-project-limit-reached`; A has one row.
2. A, cap 200: link the existing project without a replacement label; 200, no
   duplicate, stored label remains unchanged.
3. B, cap 1: two concurrent same-UUID calls; one 201 and one 200; exactly one row.
4. Scoped lists: A and B see only their own project IDs; C sees none.
5. B, explicit cap 2, attempts A's project UUID; `project-id-unavailable`, no foreign
   row read by the repository, no new row.
6. C without a quota row: `quota-not-provisioned`, no project created.
7. Each quota check runs in its own awaited transaction: a tagged
   `set_config('sessionport.validation_fixture_user', <fixture userID>, true)` puts
   the ID into a transaction-local setting, then a static PL/pgSQL `DO` block updates
   that fixture row. The block catches `ONLY check_violation`, reads
   `CONSTRAINT_NAME`, and returns normally only for the exact expected name. If the
   update succeeds it raises `expected-check-not-raised`; a wrong constraint name
   raises `unexpected-check-constraint`. The exception handler's subtransaction rolls
   back the bad update, the outer transaction commits, and a separate unchanged quota
   snapshot confirms the result. The two blocks expect
   `UserQuota_bytes_nonnegative_check` (`usedBytes=-1`) and
   `UserQuota_usage_within_limit_check` (`usedBytes=limit+1`, nonnegative).
   Unexpected errors, timeouts, and connection failures fail the case; they are never
   accepted as the expected constraint. Constraint names are evidence only if a live
   run passes; offline tests inspect the static block text and do not prove PL/pgSQL
   syntax or server behaviour.
8. Deleting user A while project/quota rows exist is `RESTRICT`ed; user remains. The
   run verifies rejection and persistence but does not print driver meta or attribute
   which foreign-key constraint fired.

No sleeps, lock signals, product test hooks, retries, or arbitrary SQL are used.
Promise concurrency is single-run evidence (n=1), not a proof over all interleavings.

## Cleanup and mutations

Cleanup is a **proposed test mutation** requiring review and explicit owner
authorization before live execution. It runs only after all eight cases have
completed and every query has settled without any failure. One explicit transaction
deletes projects, quotas, and users using only the exact tracked fixture user-ID
arrays; no `deleteMany({})`, prefix delete, truncate, drop, or reset is permitted.
Afterwards zero tracked fixture rows must remain. This is user-scoped cleanup of the
exact tracked fixture user IDs, not a claim that every dependent row was deleted by
row ID.

Any guard, seed, case, unexpected-rejection, or deadline path skips cleanup and
reports `cleanupVerified=false` where a result is produced. A failed seed is treated
as uncertain even though its transaction is atomic. No automatic retry or cleanup is
attempted. If cleanup itself fails, the driver reports fixed `cleanup-failed` and
stops; no retry is attempted. Retained fixture rows for a later read-only owner
follow-up require a separate reviewed disposal step. The CLI does not import or call
the cleanup helper.

## Timeouts, deadline, and lifecycle

The owner invocation is exactly
`node --import tsx scripts/validate-projects.ts --run-validation-only --max-run-ms=90000`
from `cloud/api`. Both arguments are required; `--max-run-ms` is canonical decimal
within 1000..120000 ms. These are test budget bounds, not product parameters. The
timer is armed after valid arguments but before environment validation, dynamic
imports, client construction, driver execution, cleanup, and disconnect.

On expiry the CLI writes exactly
`status=timeout code=validation-deadline-exceeded cleanupVerified=false` and hard
terminates with exit 124. It does not claim query cancellation, rollback, or cleanup.
The timer remains armed through a hanging disconnect and is cleared only in the
control `finally` after disconnect completes or the deadline fires. Normal failure
remains exit 1.

Because the process deadline can leave database work ambiguous, for the proposed
90-second run the operator should use an outer Docker stop around 120 seconds,
greater than that test budget. After a timeout, inspect and stop only the
owner-scoped container; do not automatically retry or run database cleanup. These
values are proposed explicit operator choices.

Per-query test budgets remain `max=4`, `connectionTimeoutMillis=5000`,
`query_timeout=15000`, `statement_timeout=10000`, and Prisma transaction
`maxWait=5000`, `timeout=10000`; they do not replace the hard overall deadline. On
normal completion the CLI disconnects its created client before writing the result.

## Offline tests now; live execution pending

`test/projects/postgres-validation.node.ts` covers URL accept/reject cases, the
migrator-key-only reader, exact argument/range gating before environment access,
fake-clock hard deadline output/exit 124/timer clearing, guard-before-write,
quota-DO static checks for `check_violation`/constraint names/parameterised
`set_config`, cleanup-only-after-full-pass source gating, and exact cleanup scope.
These offline tests do not prove PostgreSQL locking, constraints, migrations,
PL/pgSQL syntax, Prisma binding, or concurrency.

## Later dependency bundle (not built now)

For a later owner-run Docker image based on the existing image ID above, the expected
added source files are:

- `cloud/api/src/projects/repository.ts`
- `cloud/api/src/database/config.ts`
- `cloud/api/test-support/projects-postgres-validation.ts`
- `cloud/api/scripts/validate-projects.ts`

No bundle, image build, server start, Docker command, migration, or database run is
performed by this preparation.
