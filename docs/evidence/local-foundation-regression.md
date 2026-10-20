# Local Foundation — Final Coherent Regression Evidence

Status: **PASS — FINAL LOCAL COHERENT REGRESSION ON THE FROZEN ROOT GRAPH. OPEN RUNTIME AND PUBLICATION GATES REMAIN. NO REAL DATABASE, AUTH, HOST, DEPLOYMENT, OR PUBLICATION CLAIM.**

Recorded: 2026-10-19. Validation owner: orchestrator. Executor: final regression
validation lane. This record covers one bounded execution of the root Bun suite and one
bounded execution of the API explicit Node suite against the already-installed, frozen
dependency graph described in §2. It records no source/config/manifest/lock edit, no install,
no build, no database or host activation, no account action, and no Git mutation. The
validation lane did not review or change application source; source acceptance remains with
the prior Oracle and structure-scan records summarized in §7.

## 1. Scope and verdict

The final coherent local-foundation boundary was exercised as two commands:

| Command | Working directory | Result | Wall clock |
| --- | --- | --- | --- |
| `bun test` | repository root | **exit 0 — 658 pass / 0 fail / 17,534 `expect()` calls / 48 files** | 17,378 ms (Bun-reported suite time 17.28 s) |
| `npm test` | `cloud/api` | **exit 0 — 37 tests / 37 pass / 0 fail / 0 skipped** | 1,608 ms (runner-reported test time 938.7 ms) |

No failing, cancelled, or skipped test was reported by either command. The root run is the
first full root Bun suite on the final root graph, which includes the API workspace links and
the accepted Fastify/semver hoist normalization. The API run validates the explicit Node
runner's recursive discovery: it executed **4** files, including the nested
`test/protocol/cursor.node.ts`, for **37** tests rather than the earlier 27-test collection.

## 2. Frozen graph at execution

- Root package: `opencode-session-port` 0.1.7 candidate, `private: false`, workspaces exactly
  `cloud/api` and `cloud/web`, existing scripts/exports/files allowlist and dependency pins
  unchanged by this lane.
- API workspace: private `@sessionport/api` 0.0.0, runtime `fastify` **5.12.7**; dev
  `tsx` **4.23.15**, `typescript` **5.9.3**, `@types/node` **24.12.2**; `test` script is
  `node scripts/test.mjs`.
- Lock: one `bun.lock`; no `package-lock.json`. The L2A semver-topology normalization
  (top-level `semver` 6.3.1 → 7.8.5, stale nested `@npmcli/*` 6.3.1 entries removed, Babel
  nested 6.3.1 retained) remains the accepted Oracle-reviewed exception recorded in
  [api-foundation.md](./api-foundation.md) §5. This record does **not** claim zero existing
  lock drift.
- Observed at record time:
  - `bun.lock` SHA-256
    `9D60C971B626F5D53170B5A85DB0EAE9E71DD2FF5DDD0A2BA830F6BCAC1F6E54`
  - root `package.json` SHA-256
    `3D8D6F136661EFD25DD7A5F9A38794B194F95FE2CFB25863AE30BC71239FB96C`
  - `cloud/api/package.json` SHA-256
    `06302259E3D7A1B23C8260A5BA672BDDFAD5EE9EAC7E7E92437C82FEB79025CF`
- Toolchain used: Bun **1.3.10**, Node **22.13.1**, npm **11.5.2**, Windows (`win32`).
  This is the local toolchain label; the hosted baseline used Node 22.14.0 and npm 11.5.1,
  and no parity or platform-support claim is made.

No `bun install`, `npm install`, frozen-install check, typecheck, build, package verifier,
consumer install, or full CI command was run in this lane. The exact graph was already
installed and frozen by the preceding accepted work.

## 3. Command evidence

### 3.1 Root `bun test`

- Invocation: `bun test`, repository root, bounded to 300,000 ms by the validation harness.
- Exit code **0**.
- Bun summary: `658 pass`, `0 fail`, `17534 expect() calls`,
  `Ran 658 tests across 48 files. [17.28s]`.
- The 48 files are the root `tests/**` Bun-suffixed suite. Cloud `*.node.ts` files are not
  Bun test suffixes and are not part of this collection; they were covered separately by the
  explicit Node runner in §3.2. The root count therefore does not include the API's 37 tests.
- The 658-test count belongs to this final repository state and graph. It is distinct from
  the hosted **648**-test record on commit `5c1d89e`, which remains the unchanged prior
  baseline and is not re-claimed here.

### 3.2 API `npm test` (explicit Node runner)

- Invocation: `npm test` in `cloud/api`, bounded to 300,000 ms by the validation harness.
- Exit code **0**.
- Runner output:
  - `[api-test] running 4 explicit Node test file(s)`
  - `test\app.node.ts`, `test\config.node.ts`, `test\protocol\cursor.node.ts`,
    `test\readiness.node.ts`
  - TAP summary: `1..37`, `# tests 37`, `# pass 37`, `# fail 0`, `# cancelled 0`,
    `# skipped 0`, `# todo 0`, `# duration_ms 938.7233`.
- This confirms recursive `./test/**/*.node.ts` discovery and execution of the nested
  cursor suite, validating the actual runner behavior rather than a manually enumerated set.

### 3.3 Harness note (no test outcome involved)

An initial attempt to redirect `npm test` output used a relative log directory while the
working directory was `cloud/api`. PowerShell failed to open the output file under the
nonexistent `cloud/api/.package-verify-work/...` path before any test output was produced
(136 ms, no test totals, no log file, no exit code from npm). The single actual `npm test`
execution was then run with the absolute log path and is the result recorded in §3.2. The
failed wrapper produced no test outcome and is not counted as a run.

## 4. Non-failing observations

- The root Bun log contains a PowerShell `NativeCommandError` wrapper around Bun's stderr
  progress emission. It is a redirection artifact, not a test failure: Bun exited 0 and
  reported 658 pass / 0 fail. No failure line is present.
- The API log contains Fastify `FSTDEP023` deprecation warnings for the top-level
  `disableRequestLogging` option (removal targeted for Fastify 6). They are warnings from the
  accepted source surface, not test failures; the suite exited 0 and no source change was
  made in this lane.
- No test emitted a skip or todo entry. The API runner reported explicit zeroes; Bun prints
  no skip/todo summary when none occur.

## 5. Evidence artifacts (local, gitignored)

Directory: `.package-verify-work/regression-20261019-192524/`

- `bun-test-root.log` — root Bun suite output and summary.
- `bun-test-root.meta.txt` — command, working directory, exit code, duration, platform,
  Bun/Node versions.
- `npm-test-cloud-api.log` — API runner file list, TAP output, and summary.
- `npm-test-cloud-api.meta.txt` — command, working directory, exit code, duration, platform,
  Node/npm versions.

These files are local ignored artifacts, not committed evidence. They contain command output
only; no environment dump, credentials, tokens, raw request data, or account data was
captured.

## 6. Not re-run / retained evidence

Per the final regression boundary, the following were intentionally not repeated because
their source and evidence were unchanged and already accepted:

- The **35** synthetic fixture/runner Node tests (20 fixture + 15 runner) and their four
  syntax checks; the runner/harness files were not modified by this lane. See
  [postgres-runner.md](./postgres-runner.md) and [postgres-fixture.md](./postgres-fixture.md).
- API and root typechecks. The API `tsc --noEmit` result for the unchanged final source was
  accepted in the prior lane; no typecheck was run here.
- The focused workspace/manifest/whitelist checks, the 58-file npm/Bun pack listings, the
  cloud exclusion proof, installs, builds, package verifier, consumer install, and full CI.
  Prior accepted evidence is retained in [api-foundation.md](./api-foundation.md).
- Real PostgreSQL, migrations, auth, host/API launch, and any listener or network activation.
  No PostgreSQL service, Docker daemon, existing database, host fixture, or user credential
  was touched.
- The existing full root Bun suite may internally invoke prepack/build test fixtures; that is
  expected test-internal behavior and is not an external build or publication performed by
  this lane.

## 7. Claims explicitly not made and remaining gate limitations

- **API-01 remains in progress/partial.** No real database, Prisma client generation,
  migration, business table/FK, auth mount, storage, or deployment exists. The cursor parser
  remains an API-02 precursor only; no transaction/DAG/quota implementation is claimed.
- **AUTH-01 remains blocked** on durable per-device grant linkage. No auth is enabled and no
  vendor/business schema is frozen around an invented link.
- **HOST-01 remains source-only.** No host probe, cloud native import/update, or runtime
  compatibility was exercised. All eight runtime matrix rows remain unverified.
- **CI-02/publication remains deferred.** The 0.1.7 candidate is unpublished, untagged, and
  uncommitted. No tag, release, OIDC publication, registry upload, or production/Vercel/
  bucket access occurred.
- **No actual database/auth/publication/deployment claim** follows from these two test exits.
  Passing source-level tests cannot stand in for a real PostgreSQL run, a runtime auth gate,
  a host probe, or a publication approval.
- The unrelated dirty working tree present before this lane was preserved. No Git command
  changed the index, branch, tags, or history; no source, config, manifest, lock, or other
  documentation file was edited. This lane's only writes are this new evidence document and
  the ignored log directory named in §5.
- Oracle/Owner reviews beyond the scopes already recorded remain outstanding. This document
  is validation evidence for the orchestrator, not an owner review or a release approval.

## 8. Prior accepted source/review context

- REPO-01 is complete for the local workspace/package boundary; L1 Oracle **GO** and
  structure scan **CLEAN**.
- The L2A Fastify health/transport foundation is accepted; Oracle **GO** for that scope only,
  with independent structure scan **CLEAN**. API-01 stays partial.
- Vendor-schema generation provenance is accepted as generation-only; it is not an assembled
  Prisma 7 runtime, migration, or auth gate pass.
- The fixture/runner synthetic contract is accepted by Oracle attempts 1–2; the prior stdin
  early-close defect is closed. Real PostgreSQL remains **NO-GO** pending a supported
  non-plaintext password-delivery mechanism and a separate exact real-run safety review.
- Status detail remains in [api-foundation.md](./api-foundation.md),
  [auth-schema-generation.md](./auth-schema-generation.md),
  [postgres-fixture.md](./postgres-fixture.md), and
  [postgres-runner.md](./postgres-runner.md). Documentation status files are outside this
  lane's write scope and were not edited.
