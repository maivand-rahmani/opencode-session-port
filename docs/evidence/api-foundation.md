# API Foundation — Local Workspace Boundary and Source-Only Health/Transport Evidence

Status: **PARTIAL — LOCAL SOURCE/TEST EVIDENCE ONLY. API-01 IS NOT COMPLETE. NO DEPLOYMENT, DATABASE, ENABLED AUTH, STORAGE, APPLIED MIGRATION, OR M2 COMPLETION IS CLAIMED. THE FINAL COHERENT LOCAL-FOUNDATION REGRESSION PASSED (2026-10-19); REAL DATABASE, AUTH, HOST, AND CI-02 PUBLICATION GATES REMAIN UNPASSED/UNVERIFIED.**

Recorded: 2026-10-19. Validation owner: orchestrator. This record covers the completed
REPO-01 local workspace/package boundary, the accepted L2A source-only Fastify
health/transport slice, the vendor auth-schema generation artifact (provenance only), the
API-02 cursor-parser precursor, and the synthetic-only PostgreSQL fixture/runner evidence.
It does not record an owner review, a technical gate pass beyond the explicit scopes named
below, any runtime deployment, or any real PostgreSQL execution. The documented results were
reported by the implementation lanes and accepted by the validation owner; the documentation
lane did not re-run application tests, builds, installs, or Git commands.

## 1. Verdict and task actuals

| Task | Dated status (2026-10-19) | Scope actually evidenced |
| --- | --- | --- |
| REPO-01 | **Completed** | Local npm workspace/package boundary only: exactly two private workspaces, one Bun lock, frozen root plugin contract. |
| HOST-01 | **In progress** | Source-only evidence plan; all eight runtime matrix rows PARTIAL/UNVERIFIED; no probe; cloud native import/update blocked ([host-01.md](host-01.md)). |
| API-01 | **In progress (partial)** | Fastify configuration/health/transport foundation plus a vendor-generated auth-schema artifact (generation only); no Prisma validate/client, migrations, real database, business tables/FKs, auth mount, storage, or deployment. |
| AUTH-01 | **In progress (investigation blocked)** | Vendor source/registry investigation and a generated vendor schema artifact; durable per-device grant linkage is not established, no auth is enabled, and no vendor/grant schema is applied or invented. |
| PREP-01 | **In progress** | Full-package owner review remains unrecorded; no package approval is claimed. |
| CI-01 / CI-02 | **Completed / In progress** | M0 records unchanged: CI-01 hosted Windows evidence; CI-02 source-complete with protections applied, but no hosted release run, OIDC publication, or publication authorization. |
| API-02 | **In progress (parser precursor only)** | Pure cursor parser with 10 focused native Node tests and API typecheck; no project/revision transaction, DAG, quota, persistence, HTTP route, or durable-database proof. |
| API-03 | **Not started** | No usage/quota accounting implementation; no M2 completion claim. |

The synthetic PostgreSQL fixture/runner is test-support evidence only (35 combined native Node
Windows tests plus four syntax checks); real PostgreSQL integration is deferred and NO-GO. The
final coherent local-foundation regression **PASSED** (2026-10-19): root `bun test` 658 pass /
0 fail / 17,534 expectations across 48 files (17.28 s), and `cloud/api` `npm test` 37/37 across
4 files including the nested cursor suite (Windows, Bun 1.3.10 / Node 22.13.1 / npm 11.5.2).
Evidence: [local-foundation-regression.md](local-foundation-regression.md). This is local test
evidence only; it does not pass a real database, enabled auth, HOST-01 runtime, or CI-02
publication.

Oracle L1 attempt 1 returned **GO** for the workspace boundary only, and Oracle L2A attempt 1
returned **GO** for the health/transport-only API surface. The vendor-schema review returned
**GO for provenance/generation scope only**, and the runner attempt 2 review returned **GO for
the synthetic helper/contract** after a stdin-completion defect was fixed. Independent
structure scans were **CLEAN** for L1 and L2A. None of these verdicts covers a real database,
enabled auth, storage, host apply, or deployment. The accepted health/transport slice does not
depend on the unresolved vendor schema or auth/grant decisions; the remaining API-01
Prisma/business-schema work still does.

## 2. REPO-01 — local workspace/package boundary

- The root manifest declares exactly `cloud/api` and `cloud/web` as npm workspaces. Both
  members are private `0.0.0` ESM packages with independent TypeScript configurations.
  `cloud/web` remains a minimal dependency-free scaffold; `cloud/api` later received the
  L2A dependency boundary described in §3.
- Root plugin identity and contract are preserved: `opencode-session-port` 0.1.7 candidate
  metadata, the existing root scripts, exports, and files allowlist, and the existing
  dependency, peer, and dev pins. The published `latest` and install pins remain 0.1.6; the 0.1.7 candidate
  is unpublished, untagged, and uncommitted. The hosted 648-test baseline belongs to the
  unchanged previous commit `5c1d89e` only, not to the candidate.
- The plugin pack surface remains exactly `tui.ts`, `src/**`, `dist/**`, and `tsconfig.json`
  (58 files in both npm and Bun listings at L1). No `cloud/**` path enters the plugin tarball,
  and the root package exports are unchanged.
- A single Bun 1.3.10 `bun.lock` is retained; no `package-lock.json` exists and no
  package-manager switch occurred.
- L1 lock movement was limited to workspace metadata: semantic entries moved 440 → 442 with
  only the two workspace links added, plus the stale root-name correction. No package
  resolution was removed or changed at L1.
- L1 commands reported by the writer lane: `bun install --ignore-scripts` exited 0 (12.2 s)
  and a frozen install exited 0 (0.2 s) with the same lock hash. The focused
  workspace/manifest/whitelist checks passed 27 tests / 190 expectations / 0 failures (12.2 s).
  Both live pack listings — npm and Bun — contained 58 files despite the present cloud
  workspaces.

## 3. L2A — approved dependency and test boundary

| Item | Exact value |
| --- | --- |
| Runtime dependency | `fastify` **5.12.7** |
| Dev dependencies | `tsx` **4.23.15**, `typescript` **5.9.3**, `@types/node` **24.12.2** |
| Module system | NodeNext / NodeNext, ES2022 target, `"type": "module"`, strict, `noEmit`, `isolatedModules` |
| Source imports | Explicit local `.js` suffixes under NodeNext |
| Typecheck scope | `include: ["src", "test"]` in an independent API tsconfig with no `extends`/`references` |
| Test discovery | Explicit native Node runner over `./test/**/*.node.ts` only |

No BetterAuth, Prisma, PostgreSQL driver, storage SDK, or web runtime dependency was added to
these cloud workspaces. The API workspace remains private with only `typecheck` and `test`
scripts. Root Bun test discovery is unchanged; Bun-style `.test`/`.spec` suffixes and cloud
source files are not picked up by the root suite.

The explicit runner sorts discovered files, rejects an empty set instead of passing, rejects
embedded Bun-style test/spec suffixes, runs the current Node executable with `--import tsx
--test`, caps captured stdout/stderr at 1 MiB, times out at 300 s, and uses a 5 s kill grace.
Its error/signal exit propagation is part of the runner source; no cloud test file relies on
Bun.

## 4. Source modules and test evidence (L2A)

Five flat source modules under `cloud/api/src/`:

| Module | Role |
| --- | --- |
| `config.ts` | Required explicit environment configuration, fixed loopback host, bounded integers, HTTPS or HTTP-loopback canonical origin; no defaults, env-file loading, or secret reads. |
| `errors.ts` | Fixed sanitized API error envelopes and allow-listed Fastify/parser mappings; raw exception text and request data are not copied. |
| `readiness.ts` | Bounded fail-closed readiness over exactly database, migrations, and storage checks with one shared abort signal. |
| `app.ts` | Unlistened Fastify instance, health routes, request gates, generated request IDs, logging off, proxy trust off. |
| `main.ts` | Explicit bootstrap/listen and shutdown handling, separated from module evaluation so imports do not listen. |

At the L2A boundary, three explicit Node suites covered configuration, readiness, and the
app/transport surface; the later cursor suite is recorded in §8. The final writer-reported
checks against the same final source and pinned toolchain were:

| Check | Reported result |
| --- | --- |
| API native Node suite (3 files) | **27 tests / 27 pass / 0 fail** |
| `tsc --noEmit` with the API config | **PASS** |
| Root workspace + manifest package proof | **21 pass / 141 expectations** |
| `bun install --ignore-scripts` | **exit 0 (2.3 s)** |
| `bun install --frozen-lockfile --ignore-scripts` | **exit 0 (0.2 s), lock hash unchanged** |

Platform label: Windows, local Node **22.13.1**. The hosted baseline used Node 22.14.0 and a
different npm patch (11.5.1 vs local 11.5.2); the local result is **not** a parity or support
claim for the hosted runner, other platforms, or production.

## 5. Lock topology exception (L2A)

The L2A dependency addition moved the lock from 442 to 511 semantic entries: 79 new,
10 removed, 1 changed, with 431 pre-existing entries byte-identical. Root direct dependency
pins were unchanged.

The one changed resolution is an accepted semver-topology normalization, not a plugin
consumer change:

- top-level `semver` moved **6.3.1 → 7.8.5** because Fastify requires `^7.6.0`;
- ten stale nested `@npmcli/*` `semver@6.3.1` entries were removed where the parents require
  `^7.3.x`;
- Babel's nested `semver@6.3.1` entries remain for parents that require `^6.3.1`;
- root direct pins remain unchanged and the root lock is unpublished.

Oracle accepted this specific topology change. The correct claim is **not** "zero existing
lock drift at L2A"; the L1 boundary had no resolution drift, while L2A contains the documented
hoist normalization above.

## 6. Implemented behavior (source-only)

- `GET /health/live` returns `200 {"status":"ok"}` without invoking readiness checks.
- `GET /health/ready` returns `200` only when **all three** explicit checks — database,
  migrations, storage — are functions that return exactly `true`. Missing/malformed checks,
  `false`, thrown values, and timeouts return a sanitized `503` with `Retry-After`. No fake
  "ready" default exists, and no real backend is wired.
- Readiness checks share one `AbortSignal`; the overall evaluation is bounded and aborts on
  completion/timeout. A non-cooperative check cannot be forcibly cancelled, so the promise is
  bounded rather than claiming hard cancellation.
- Logging is disabled (`logger: false`, request logging disabled); proxy headers are not
  trusted; request IDs are server-generated UUIDs and client-supplied request-ID headers are
  ignored.
- `/v1` and `/v1/*` are denied with `401` in `onRequest`, before body parsing or auth
  handling. `/api/auth` and `/api/auth/*` return a sanitized `503` with `Retry-After`.
  Auth-shaped headers (`Authorization`, cookies, user-ID headers) do not bypass either gate.
- Unknown routes return a sanitized `404`; parser/validation failures map to fixed
  `400`/`413`/`415`/`500` envelopes without raw messages, paths, bodies, or secrets.
- Importing `main.ts` neither listens nor installs signal handlers; `startApi` is the explicit
  listen path and binds the configured loopback host `127.0.0.1`. All configuration values are
  required explicitly and invalid values are rejected without echoing them.
- Tests use `app.inject`; no listener, real network dependency, database, auth service, or
  storage call is part of this evidence.

## 7. Vendor auth schema generation (provenance only)

- The pinned BetterAuth CLI `auth@1.7.11` (with `better-auth@1.7.11`,
  `@better-auth/oauth-provider@1.7.11`, and a scratch-only `@prisma/client@7.10.1`) generated
  the vendor schema in an isolated, gitignored scratch workspace under
  `.package-verify-work/auth-schema-20261019-v2a1/`; installs used `--ignore-scripts`.
- The generation config lives in `cloud/api/schema-tools/auth-schema.config.ts`, is outside
  the API's `src`/`test` typecheck scope, and is never imported by the app. It uses synthetic
  localhost origins/scopes only and `resources: []` so plugin initialization performs no
  database/client resource seeding. That setting **does not omit** the vendor `OauthResource`
  model; it only skips init-time seeding.
- Output `cloud/api/prisma/auth.generated.prisma` contains **13 vendor models**, is
  **9533 bytes**, and has SHA-256
  `092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C`; a repeat generation
  with the same pinned tool/config was byte-identical. CLI exit was 0.
- `User.id` is `String @id` with no UUID type/default. Generated `DeviceCode`, refresh-token,
  and access-token fields do not establish a durable per-device grant; `refreshId` is a
  vendor token-chain relation and `sessionId` is a browser session. No business foreign key
  or grant link is frozen or invented.
- No `prisma validate`, `prisma generate`, migration, database contact, auth mount, or client
  generation ran. The artifact is not assembled for the Prisma 7 runtime, and Oracle review
  accepted **provenance/generation scope only**. Details:
  [auth-schema-generation.md](auth-schema-generation.md).

## 8. Cursor parser precursor (API-02, partial)

- `cloud/api/src/protocol/cursor.ts` implements a pure, import-light `parseCursor`:
  - wire input is `unknown` and must be a non-empty ASCII decimal digit string; leading
    zeros are accepted as decimal digits, with no undocumented canonicalization rule;
  - comparison uses `bigint` values, so large cursor values are not precision-lossy;
  - the upper bound is a caller-supplied `bigint >= 0` programmer precondition; violations
    throw before wire inspection;
  - malformed input and beyond-bound values return distinct tagged results.
- `cloud/api/test/protocol/cursor.node.ts` adds 10 focused native Node tests; the suite passed
  and the API TypeScript `--noEmit` check passed. The prior 27 API tests were unchanged and
  were not rerun.
- API-02 remains **In progress — parser precursor only**. There is no project/revision
  transaction, revision DAG, quota/accounting, persistence, HTTP route, or durable-database
  proof. No undocumented cap was added; arbitrary-size `BigInt` resource limits remain
  unaddressed policy work.

## 9. PostgreSQL fixture and runner (synthetic only)

- `cloud/api/test-support/postgres-fixture.mjs` (inert harness, no bundled executor) and
  `postgres-runner.mjs` (bounded child-process runner) are test-support only. Their combined
  explicit native Node run passed **35 tests** (20 fixture + 15 runner) on Windows Node
  **22.13.1**, plus four `node --check` syntax checks; there was no real PostgreSQL command,
  server, service, database, network, Docker, or host access.
- Oracle attempt 1 returned GO for the synthetic helper but found a material stdin defect:
  the fixture adapter dropped `stdinErrorCode` and could accept a zero-exit initdb after an
  early stdin close/EPIPE. A bounded remediation made the adapter require explicit
  `stdinStatus === 'completed'` **and** exit code 0; `error`, `incomplete`, `missing`, and
  `not-provided` fail closed, with owned-data retention when process exit is uncertain. Three
  zero-exit stdin regression cases cover EPIPE, incomplete, and missing status. Oracle attempt
  2 returned GO and closed the defect; the 35-test evidence was accepted without a third fix.
- Completion of the stdin write proves only that bytes were handed to the OS pipe — **not**
  that initdb or the application consumed them. It is a necessary fail-closed gate, not proof
  of password support.
- **Real PostgreSQL integration remains DEFERRED (NO-GO).** PostgreSQL 17 `REL_17_0` source
  shows `initdb --pwfile` opens a literal filename with `fopen` (no `-`/stdin case), while
  `-W` takes the interactive terminal branch. No supported non-interactive child-stdin
  mechanism exists. No plaintext password file, `trust` fallback, PTY, named pipe, user
  service, existing database, Docker start, or production access was used.
- Known limits: partial (full-token only) secret redaction, process-tree termination is not
  proof that every descendant is gone, POSIX behavior is unverified, and the harness has no
  first-class `processUncertain`/`outputOverflow` consumption (uncertain termination is
  conservatively mapped to `timedOut` and retains data). Details:
  [postgres-fixture.md](postgres-fixture.md), [postgres-runner.md](postgres-runner.md).

## 10. Final coherent local-foundation regression (PASS, 2026-10-19)

- The final root/API regression over the current dependency graph ran once and **passed** on
  2026-10-19. Results:
  - root `bun test`: **658 pass / 0 fail / 17,534 expectations / 48 files**, Bun-reported suite
    time **17.28 s**;
  - `cloud/api` `npm test`: **37 tests / 37 pass / 0 fail / 0 skipped** across **4 files**
    (including the nested `test/protocol/cursor.node.ts`), runner-reported test time 938.7 ms;
  - platform/toolchain: Windows, Bun **1.3.10**, Node **22.13.1**, npm **11.5.2**.
- The root count is the final repository state's Bun suite and does not include the API's 37
  explicit Node tests. The hosted **648**-test baseline belongs to the unchanged prior commit
  `5c1d89e`, not to this 658-test local run.
- The coherent API run supersedes the earlier separate counts (L2A 27 tests plus cursor 10
  tests) as the terminal API collection; those earlier runs remain historical evidence.
- Evidence: [local-foundation-regression.md](local-foundation-regression.md). This PASS is
  local focused/synthetic evidence only. It does **not** pass a real PostgreSQL run, enabled
  auth, HOST-01 runtime, deployment, or CI-02 publication; those gates remain open.

## 11. Claims explicitly not made

- API-01 is **not complete**; no M2 milestone completion exists.
- No live deployment, real database, Prisma client, migration, business table, business
  foreign key, auth mount, enabled device login, key vault, storage bucket, upload, or
  operational PostgreSQL run is claimed.
- The PostgreSQL harness and runner are inert/synthetic only ([postgres-fixture.md](postgres-fixture.md),
  [postgres-runner.md](postgres-runner.md)); their 35 combined native Node Windows tests plus
  four syntax checks and the Oracle contract GO cover the test-support automation, not a real
  server. A real PostgreSQL 17 launch on Windows remains **deferred (NO-GO)**: PostgreSQL
  `REL_17_0` `initdb` uses `fopen` on a literal `--pwfile` filename or a terminal `--pwprompt`
  branch, with no source-established child-stdin password mechanism. No plaintext password
  file, `trust` fallback, PTY, named pipe, user PostgreSQL service attachment, Docker start,
  database, or production access was used.
- The generated vendor auth schema is a **provenance artifact only** — not validated,
  assembled, migrated, applied, or mounted. AUTH-01 source inspection of
  BetterAuth/@better-auth/oauth-provider **1.7.11** found rotating refresh-token IDs, no
  persisted access-row/jti mapping for JWT access tokens, and `sid` as a browser auth session
  rather than a unique device grant. The generated fields do not resolve this, and no durable
  per-device grant link is established or invented. No auth design is frozen and auth remains
  disabled.
- API-02 is **not** implemented beyond the pure cursor parser: no transaction, DAG, quota,
  persistence, HTTP route, auth, or real database behavior is claimed. API-03 is not started.
- The final coherent local-foundation regression **passed** at 658 root tests and 37 API tests
  ([local-foundation-regression.md](local-foundation-regression.md)); that result does not
  prove a real database, enabled auth, HOST-01 runtime, deployment, or CI-02 publication, and
  no such claim is made.
- HOST-01 runtime behavior, cloud native import/update, platform parity, release publication,
  and owner approval of the planning package are not claimed. HOST-01's eight runtime rows
  remain unverified ([host-01.md](host-01.md)).
- The 0.1.7 candidate is not published, committed, tagged, or covered by a candidate hosted
  run; the 0.1.6 published pins and the previous commit's hosted 648-test record are
  unchanged.

## 12. Provenance and review record

- REPO-01 / L0–L1: the Oracle plan review (L0) and Oracle attempt 1 (L1) returned **GO** for
  the L1 workspace scaffold/boundary only, and an independent structure scan was **CLEAN**.
  Writer evidence included the bounded install/frozen runs, focused 27-test package checks,
  and both 58-file pack listings described in §2.
- L2A: Oracle attempt 1 **GO** for the health/transport foundation only; independent explorer
  structure scan **CLEAN**; no source changes were made after the recorded checks, so the
  evidence was reused rather than re-running unchanged tests for a different validation owner.
- Vendor schema: generation was isolated and byte-reproducible; Oracle accepted
  provenance/generation scope only, with no runtime or database claim ([auth-schema-generation.md](auth-schema-generation.md)).
- API-02 prefix: the pure parser and its focused tests passed, and the API typecheck passed;
  no additional Oracle escalation was required for this small pure-parser scope.
- PostgreSQL runner: Oracle attempt 1 found the stdin-completion defect, the bounded fix was
  applied, and attempt 2 returned GO for the synthetic contract. The 35-test combined run and
  four syntax checks were accepted unchanged.
- Final regression: one bounded root Bun run (658 pass / 0 fail / 17,534 expectations / 48
  files / 17.28 s) and one bounded API explicit Node run (37/37 across 4 files including the
  nested cursor suite) passed on Windows Bun 1.3.10 / Node 22.13.1 / npm 11.5.2, recorded in
  [local-foundation-regression.md](local-foundation-regression.md). No source/config/lock edit,
  install, build, database, auth, host, or publication action was part of that lane.
- Relevant repository paths: [`cloud/api/package.json`](../../cloud/api/package.json),
  [`cloud/api/tsconfig.json`](../../cloud/api/tsconfig.json),
  [`cloud/api/scripts/test.mjs`](../../cloud/api/scripts/test.mjs),
  [`cloud/api/src/`](../../cloud/api/src/),
  [`cloud/api/test/`](../../cloud/api/test/),
  [`cloud/api/prisma/auth.generated.prisma`](../../cloud/api/prisma/auth.generated.prisma),
  [`cloud/api/schema-tools/auth-schema.config.ts`](../../cloud/api/schema-tools/auth-schema.config.ts),
  [`cloud/api/test-support/`](../../cloud/api/test-support/),
  [`cloud/web/package.json`](../../cloud/web/package.json),
  [`package.json`](../../package.json), [`bun.lock`](../../bun.lock), and
  [`tests/package/workspaces.test.ts`](../../tests/package/workspaces.test.ts).
- The reconciled workbook `.slim/deepwork/sessionport-v2-local.md` is gitignored local
  planning state, not committed evidence, and is not used here as proof beyond the accepted
  writer/orchestrator record.

## 13. Current open items

- API-01 remainder: assemble/validate the generated vendor schema for Prisma 7 and add
  business Prisma schema/migrations only after AUTH-01 resolves the durable grant linkage;
  real database integration after an approved PostgreSQL mechanism and safety GO; storage and
  wider business endpoints later.
- HOST-01: separate bounded probe plan and independent safety GO before any host launch;
  all runtime rows remain unverified until then.
- PostgreSQL: an approved non-plaintext password-delivery mechanism and a reviewed real
  process runner are still required before any real `initdb`/server run. Real integration is
  deferred (NO-GO).
- AUTH-01: a supported durable device→grant linkage or an owner-approved architecture change
  is required before auth is enabled; no schema is frozen around the unresolved link.
- API-02: only the pure cursor parser exists; project/revision transaction, DAG, quota,
  persistence, HTTP routes, and integration proof remain unimplemented. API-03 has not started.
- Final regression: local PASS recorded at 658 root tests and 37 API tests
  ([local-foundation-regression.md](local-foundation-regression.md)); real database, enabled
  auth, HOST-01 runtime, deployment, and CI-02 publication remain open.
- AUTH-02, STORE-01/STORE-02, SYNC-01–SYNC-04: not started.
- CI-02/release: owner-only setup/publication steps remain outstanding; no publication is
  authorized; published 0.1.6 remains immutable and candidate 0.1.7 remains local,
  unpublished, uncommitted, and untagged.
- Owner questions remain deferred; none of them blocks the independent local work recorded
  here, and no answer is assumed.
