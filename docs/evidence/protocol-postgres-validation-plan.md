# Protocol PostgreSQL validation plan (preparation only)

Date: 2026-10-20

Status: **preparation only.** No live database action, migration apply, server start, Docker, Git,
network, S3, vault, or LLM call was performed in this lane. The owner reports the original Project/
UserQuota live PG run passed (15/15 checks, migrations=2, PostgreSQL 16, cleanup verified). The
reviewed 0003 apply and the protocol driver live run remain separate owner-approved actions after
Ora8 safety review.

## Authorized files

- `cloud/api/test-support/protocol-postgres-validation.ts` (new driver)
- `cloud/api/scripts/validate-protocol.ts` (new CLI)
- `cloud/api/test/protocol-postgres-validation.node.ts` (new offline tests)
- `docs/evidence/protocol-postgres-validation-plan.md` (this plan)

No existing source, schema, migration, manifest, lockfile, app/auth/repo, web/client, vault, TUI,
Git, network, or database file is changed by this preparation.

## Target and migration guard

The CLI accepts exactly:

```text
--run-protocol-validation-only --max-run-ms=90000
```

`--max-run-ms` is canonical decimal within 1000..120000. The hard deadline is armed before the
environment read, dynamic client imports, construction, driver run, cleanup, and disconnect. On
expiry it writes one fixed timeout line and exits 124; cleanup is not attempted or claimed.

Only `SESSIONPORT_MIGRATOR_DATABASE_URL` is read, through the existing
`readValidationDatabaseConfig` / `readMigrationDatabaseConfig` path. There is no `.env`, URL
argument, runtime URL fallback, alternate key query, or runtime-client fallback.

The accepted URL must be `session_port_validation` with user/session role
`sessionport_validation_migrator`, host `session-port-postgres`, and absent or 5432 port. Query
parameters remain limited by the reviewed reader to `schema=public` and a known lowercase
`sslmode`.

The driver guard requires PostgreSQL major 16 and exactly three finished, non-rolled-back
migrations:

1. `202610190001_vendor_auth`
2. `202610190002_project_quota`
3. `202610200003_protocol_native`

It requires zero rows in protocol fixture tables (`Project`, `Revision`, `ProjectHead`, `Upload`,
`Device`, `NativeDeviceGrant`, `NativeAccessToken`, `NativeRefreshToken`,
`NativePendingAuthorization`). It uses counts only; pre-existing vendor `User` and `UserQuota` rows
are allowed and are never read, dumped, or deleted. The guard never applies or repairs a migration.

The generated Prisma client is constructed once with `PrismaPg` and an explicit
`schema: 'public'`, using a synthetic validation-only connection policy: 4 connections, 5 s connect,
10 s statement timeout, 5 s lock timeout, 15 s query timeout. These are session-level pg settings,
not transaction-local `SET LOCAL`, because the existing repositories own their `$transaction`
calls and retain their default 5 s transaction timeout. They are test bounds, not product
defaults.

## Fixture policy

Fixtures are synthetic and use eight distinct user IDs with prefix
`sessionport-protocol-pg-test-`. Distinct users isolate project caps, quota counters, grants,
refresh tokens, approval caps, and tenant reads. Fixtures include users, quota rows, projects,
active grants, devices, ready uploads with 32-byte random digests, canonical SHA-256 credential
fingerprints, and pending authorizations. Raw credentials and human codes exist only in memory and
are never persisted, logged, or written to evidence. No S3 object, vault key, key wrapping, or
plaintext ciphertext payload exists.

The seed is built from ORM fixture rows plus real repository calls. The parent revision is committed
through the real revision repository using a ready upload. No arbitrary mutation SQL is used.

Global pending-authorization capacity is not tested because it counts real rows; only the per-user
approval cap is tested. No other user's rows are required to be deleted.

## Implemented case criteria

1. **Project create cap and tenant isolation** — two concurrent `createOrLink` calls with
   `maxActiveProjects=1` on the real project repository: exactly one 201/created and one fixed
   `active-project-limit-reached`; exactly one active owned project; another fixture user sees an
   empty list.
2. **Concurrent sibling revisions** — two different owned devices commit the same parent from two
   ready uploads; both return 201; sequences are 2 and 3; both children remain heads; the parent
   head is removed; exactly one commit reports `conflict=true`.
3. **Idempotent revision replay** — same revision ID, parent, device, and ready upload returns 200
   with the same sequence and heads, no `nextSeq` advance, and no quota mutation. After expiring the
   original ready upload, a replacement ready upload with identical visible fields and a different
   final key also returns 200; the revision keeps its original storage-object key.
4. **Bigint pagination and live heads** — real revision `page` reads sequences above
   `Number.MAX_SAFE_INTEGER`, honors an upper bound, returns the live head set beyond that anchor,
   and treats `limit=0` as existence-only. A foreign user gets the fixed `project-not-found` with no
   row leakage.
5. **Quota reservation race** — two explicit 600-byte reservations against a 1000-byte quota with
   the real upload repository: one is accepted, the other returns fixed 413
   `storage-limit-reached`; reserved bytes equal the single owned upload row; used+reserved does not
   exceed the limit.
6. **Approved pending exchange and active-grant cap** — two approved pending rows for one user,
   two concurrent repository exchanges with `maxActiveGrantsPerUser=1`: one returns tokens and
   creates exactly one grant/device/access/refresh atomically; the other returns
   `active-grant-limit`; one pending is consumed, one stays approved; retry of the consumed pending
   returns `authorization-consumed` without new rows.
7. **Concurrent refresh rotation and replay** — two concurrent rotations of the same old refresh
   token: one returns tokens, the other returns replay; the replay transaction commits grant
   revocation; the old row is spent with a successor; fingerprints are canonical; old and new
   access tokens are denied by the real bearer enforcement after revocation.
8. **Per-user approval cap and isolation** — two concurrent approvals of distinct pendings with
   `maxOutstandingPendingAuthorizationsPerUser=1`: one commits approved, the other returns fixed
   capacity or serialization failure; final unexpired approved count is 1 for that user; another
   user's approval succeeds independently.

Implemented checks are fixed booleans/names. This is n=1 contention evidence, not a broad
compatibility or throughput claim.

Omitted/future: verified-storage lease/attach/idempotent/stale-lease case (M4 not required here);
global pending capacity; multi-instance/load/SLO behaviour; any vendor-user or quota-row deletion.

## Cleanup order and retention

Cleanup is called only after every case passes and every concurrent operation has settled. It runs
in one transaction with `{maxWait:5000, timeout:10000}` and exact tracked IDs:

1. `ProjectHead` by tracked project IDs
2. child `Revision` rows (`parentRevisionID IS NOT NULL`)
3. child `Upload` rows (`parentRevisionID IS NOT NULL`)
4. root `Revision` rows (`parentRevisionID IS NULL`)
5. root `Upload` rows (`parentRevisionID IS NULL`)
6. tracked refresh rows: set `spentAt=NULL, successorID=NULL` together
7. delete tracked refresh tokens by grant ID
8. delete tracked access tokens by grant ID
9. delete devices by tracked user IDs
10. delete native grants by tracked user IDs
11. delete pending authorizations by tracked pending IDs
12. delete projects by tracked project IDs
13. delete quotas by tracked user IDs
14. delete users by tracked user IDs

The child/root split breaks the Upload↔Revision FK cycle without disabling constraints. No empty
`deleteMany({})`, prefix delete, `TRUNCATE`, drop, reset, or automatic retry exists. Success is
verified by exact-scope zero counts. On any failure, guard uncertainty, seed uncertainty, or
deadline the driver performs no cleanup and reports retained synthetic user IDs for manual review.
Cleanup failure is reported as fixed `cleanup-failed` with the same retained IDs; there is no retry
or fallback.

## Error taxonomy

- `database-guard-failed` — identity, role, major, migration set, or initial count mismatch
- `seed-failed` — any fixture or parent-commit failure
- `validation-unavailable` — unexpected driver/repository/serialization failure
- `cleanup-failed` — cleanup transaction or zero-count verification failed
- `validation-failed` — fixed CLI wrapper failure outside the driver taxonomy
- `timeout` / exit 124 — whole-run deadline; no cleanup claim

No SQL, URL, token, digest, raw Prisma error, or stack is printed. Result output is fixed counts,
check names, booleans, and retained synthetic user IDs only.

## Review hash candidates

| File | SHA-256 |
| --- | --- |
| `cloud/api/test-support/protocol-postgres-validation.ts` | `2FDB24B1BB08B12CA1208EDBD6E4F4FC1C128A1248990C6B91D993CB1E3E4BC9` |
| `cloud/api/scripts/validate-protocol.ts` | `276532832EE5A17E4D26C81594BDDBAD0EE313147AFE39416C436A7C242D1D75` |
| `cloud/api/test/protocol-postgres-validation.node.ts` | `13B29B1AB845C64ACC5E51A634E0E31DCD52FDE6CC5BA46737E53774F94652E3` |

## Offline validation in this preparatory lane

| Check | Result |
| --- | --- |
| `node --import tsx --test test/protocol-postgres-validation.node.ts` | Passed, 9/9 |
| `npm run typecheck` in `cloud/api` | Passed, exit 0 |
| Live PostgreSQL / migration apply / server / Docker | **Not run** (out of scope) |
| Full API suite / build / schema generate / install | **Not run** (not required) |

Offline tests prove argument and URL guards, fixed output, hard-deadline lifecycle, guard-before-
write ordering, exact migration names/count, exact cleanup scope/order, cleanup failure handling,
and source wiring to the real repositories. They do **not** prove PostgreSQL locking, SSI,
constraint behaviour, Prisma binding, migration history, concurrency, or any live SQL result.

## Remaining gates before any live run

1. Ora8 safety review of this driver, CLI, tests, fixture scopes, and cleanup order.
2. Owner-provided, separately reviewed 0003 validation-only apply bundle after the original run.
3. Fresh backup/snapshot and owner confirmation of the dedicated validation target.
4. A single reviewed run of the exact two-argument CLI; no automatic retry or migration apply.
