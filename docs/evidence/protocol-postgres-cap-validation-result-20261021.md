# Protocol PostgreSQL cap cleanup and corrected validation — 2026-10-21

Status: **Cleanup PASS; corrected protocol PASS 15/15. M2 remains Partial.**
This records one approved-scope cleanup and one conditional corrected protocol
run against the isolated `session_port_validation` database only. It is not
whole-M2 acceptance, an application-database apply, a deployment, or a
production/OAuth/vault/storage claim.

## 1. Scope and authorization

The owner approved the exact retained-fixture cleanup and one conditional
corrected protocol attempt after the prior 13/15 failure. Ora15 returned the
Technical GO for the handoff; the handoff is
[`protocol-cap-cleanup-handoff-20261021.md`](protocol-cap-cleanup-handoff-20261021.md).
The run used the isolated validation database only. The main `session_port`
database, migration reapply, role changes, service/API starts, OAuth, storage,
and the M3 session/workcopy/engine stage were out of scope and are not claimed.

The cleanup removed the exact eight retained fixture users and exactly the one
owner-approved unlinked pending UUID frozen by the prior inspection:
`15ee131e-3f4c-49b7-a6e6-37da8c7bc65d`. It did not discover rows by prefix,
marker, status, or wildcard.

## 2. Artifact and image provenance

| Item | Value |
| --- | --- |
| Cleanup ZIP | `25,396` bytes, SHA-256 `9b69f1be98bf6599ae1f55523e1d12fdec08e34aac04a475fa18e3b36d274ded` |
| Handoff | `15,507` bytes, SHA-256 `dc6ef900c044435c6a584ebdf030461727cbe190c75b3a1065b37d7f803b5c66` |
| Base image | `sha256:88b1cb8163ca50e5ea2af1b398fd0f6efd0d1920cd6024877758645ac44c1279` (`linux/amd64`) |
| Derived image | `sha256:4cff51fbf55b108da0b49ac8e42690885a2fe981af07b45a50750c980e42f1eb` (`linux/amd64`) |
| Pinned source fix | `44dded0f03c50360e117a3c4e403fccc4df9b4aa3d3ffd5536db1efb5026e438` |
| Pinned driver | `7acfc4cf82bdbc0de26bb148d7ff738a5279d89a887527aa30b771021c86fa15` |
| Sanitized local result record | `m2-protocol-cap-cleanup-and-run-result-20261021.json`, `13,323` bytes, SHA-256 `a89e192d6ed328b12d69ed8e4668b7b6d9d376e144d06c309be0adf7c1f9aea9` |

The ZIP and handoff were transferred as raw bytes to a fresh remote staging
directory and verified byte-for-byte by API readback before execution. The base
image already contained the pinned source and driver; the one offline build
only copied the cleanup CLI and its payload checksum. No dependency install,
generation, pull, migration, or schema change was performed.

## 3. Build

One offline build attempt, exit `0`, default Docker builder (`Driver: docker`,
local endpoint), `--load --pull=false --network=none`. The base image ID was
unchanged. Inspect fields: user `node`, workdir `/app/cloud/api`, command
`["node","--import","tsx","scripts/validate-protocol.ts"]`, entrypoint
`["docker-entrypoint.sh"]` (reviewed base passthrough), platform
`linux/amd64`. The derived image ID above matched the `--iidfile` value.

## 4. Cleanup

One cleanup attempt, exit `0`, timeout `false`. The fixed output matched exactly
(22 lines):

```text
status=passed
mode=--cleanup-retained-fixtures-only
postgresqlMajor=16
migrations=3
migrationChecksums=matched
schema=matched
deletedUsers=8
deletedQuotas=8
deletedProjects=4
deletedRevisions=6
deletedUploads=8
deletedProjectHeads=3
deletedDevices=6
deletedGrants=6
deletedAccessTokens=3
deletedRefreshTokens=3
deletedOwnedPendingAuthorizations=4
deletedApprovedUnlinkedPendingAuthorizations=1
deletedPendingAuthorizations=5
remainingOwnedRows=0
foreignReferences=clear
cleanupVerified=true
```

`cleanup.log` is `491` bytes, SHA-256
`255aa74a770f8036924b1843727b4976a8e96b361de74845e724ae967cc71ad8`. The
deleted pending total is `5` = four owned pending rows plus the one approved
unlinked candidate. No extra cleanup, repair, or retry followed.

## 5. Corrected protocol

One conditional protocol attempt, exit `0`, timeout `false`, with the fixed
source/driver already in the image. Migration `0003` was already applied and was
not reapplied.

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

`protocol.log` is `156` bytes, SHA-256
`8944916612d09982ccce176705adbd6f5a583efc84e2bc08d581ec85b8ab6f37`. No
fixtures from this run were retained. This is one bounded run, not repeated
concurrency or platform-matrix evidence.

## 6. Provenance and evidence boundary

Locally verified through the authenticated host API (raw readback hashes and
sanitized log content): ZIP/handoff byte counts and SHA-256 readback; staging
directory contains exactly two regular files; the `image.iid` value; the
cleanup and protocol log bytes, hashes, and parsed fields; and the remote
session outcome plus user/assistant message correlation (`finish=stop`, no
error, session idle before and after).

Remote-agent-reported, not independently observed locally: staging ownership,
modes, realpath, and symlink count; archive extraction, six-file count, and
manifest checks; Docker builder, base image, tag, container, network, and
PostgreSQL preflight results; build exit and image inspect fields; cleanup and
protocol exit/timeout values; and the no-retry/no-extra-cleanup/no-migration/
no-main-DB state assertions. Parent reconciliation remains required, as with
prior server-run evidence.

No env content, database URL, token, credential, digest, or ciphertext is
included. The existing private validation env file was used only as documented;
its key NAME was checked, never its value.

## 7. Acceptance reconciliation — M2 criteria

This run is strong protocol/repository/quota-harness evidence. It does not by
itself close API-01, API-02, or API-03.

| Item | Current evidence | Remaining gap |
| --- | --- | --- |
| **API-01** service/config/health | Fastify/Prisma source and configuration plumbing exist; prior API `375/375` plus typecheck PASS (source-only). Migrations `0001`–`0003` are applied on the isolated validation database (owner/server-reported); `/health/live` and `/health/ready` are source-tested. | No live Fastify service against a development/validation database; no application-database migration or `_prisma_migrations` claim; readiness remains fixed `false`; no deployment. |
| **API-01** no auth/storage before gates | Auth/storage behavior remains disabled/fail-closed in source. | None added by this run; no runtime auth/storage proof. |
| **API-02** project/revision protocol | Source covers client-chosen UUIDs, cursor pages, project row lock, conditional head move, sibling preservation, idempotence, and status semantics with focused tests. The corrected PG16 protocol run now passes all 15 checks, including `revision-concurrent-siblings`, providing actual live repository-level concurrency sibling-race evidence for the corrected driver. | No authenticated HTTP end-to-end run and no two-device race through the mounted API; no uploader. The validation owner must accept the live protocol harness as satisfying the “focused tests include a two-device sibling-commit race” criterion; source-only status should not be silently upgraded to whole-API runtime acceptance. |
| **API-03** quota accounting | Source includes quota primitives, locked quota-row read, active device/project caps, and the `/v1/me` usage/limits DTO; the original two-migration project/quota live validation passed `15/15` owner/server-reported. This run’s `15/15` includes its quota fixtures and cleanup but is not a dedicated quota-concurrency proof. | No accepted live reservation/charge transaction, actual-PostgreSQL concurrent-reservation test, quota-full upload flow, upload route mount, or runtime `/v1/me` proof. |

## 8. Whole-M2 closure and recommendation

The roadmap states that M2 source acceptance is not blocked by M4/storage/
deployment, and M4–M6 remain backlog. M2 can therefore be evaluated
independently of M3 and M4 in principle, but “independent” does not mean this
run closes it. The remaining API-01 application-service runtime, API-02
authenticated HTTP/API-level race, and API-03 quota runtime/upload criteria are
still open.

Recommendation: keep M2 **Partial**. Record this run as the protocol runtime
PASS for the corrected cap/cleanup bundle. A bounded next step would be an
isolated-validation-database application-service acceptance covering
health/readiness, project/revision HTTP behavior with a non-production
test-only auth seam, `/v1/me`, and quota-full rejection; the validation owner
should also decide whether the live protocol harness satisfies the API-02
sibling-race criterion. Do not infer production deployment, enabled OAuth,
vault, storage, or M4 work from this result. Whole-M2 acceptance remains a
separate, explicit decision.

## 9. Historical records preserved

The earlier failures remain unchanged and are not rewritten by this run:

- `6/15` on 2026-10-20, `failedCheck=revision-concurrent-siblings` — see
  [`protocol-postgres-validation-result-20261020.md`](protocol-postgres-validation-result-20261020.md);
- `13/15`, `failedCheck=pending-approval-per-user-cap-isolation` — prior
  2026-10-21 record, with the eight new fixtures retained at that time.

The 13/15 retained fixtures were the exact eight users cleaned in this run. The
new 15/15 result is a new run; it does not retroactively pass either historical
record.

## 10. Not claimed

No application-database apply, main-database write, migration reapply,
deployment, enabled auth, OAuth/browser flow, session/CSRF runtime, vault/
keyring, storage/upload, M3 host/TUI runtime, production, or cross-platform
compatibility is claimed. No whole-M2, M1, or M3 completion is claimed.

Evidence anchors: [M1–M3 schema contract](m1-m3-schema-contract.md),
[database foundation integration](database-foundation-integration.md),
[validation migrations](postgres-validation-migrations.md),
[project/quota validation](project-postgres-validation-result-20261020.md),
[V2 roadmap](../V2/ROADMAP.md).
