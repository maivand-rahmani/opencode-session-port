# M3 native integration source — 2026-10-20

Status: **FINAL Ora9 native material review2 GO for the source commit boundary; native source committed at `cd3ef6902d7bf3e62faf2b75effc36ece75f4ba0`; runtime milestone acceptance remains open.**

## Implemented

- Native OpenCode host builtins for dialogs and messaging (`alert`/`confirm`/`select`/`toast`,
  dialog frame) plus theme tokens; no private imports or design fork.
- One literal `/sync` command: login, local status, local logout, and a bare native action menu.
  Raw action parsing uses the non-nested command API.
- Optional, explicitly bounded `context.options.sessionportCloud` configuration (HTTPS endpoint,
  owner/state/name fields, explicit budgets). Lazy optional loading does not break `/checkpoint`
  or `/restore`.
- Lazy login controller with server-paced sequential polling, `Retry-After`,
  cancellation, monotonic deadlines, and credential persistence before success.
- Actual-controller release-failure propagation is fixed: a cached rejection is retained,
  no raw error is exposed, no retry occurs, and the owner remains fail-closed. Real-controller
  through-flow and host-install regressions passed; the prior async/dialog teardown defects are
  all closed.
- Cross-process cooperative SessionPort owner lock, plus the process-lifetime lock; no automatic
  stale-lock stealing. Disposal drains pending work before releasing ownership. The cooperative
  lock does not fence non-cooperative actors and has no automatic crash-stale break; existing
  private-ACL/symlink limits remain explicit.
- Cleanup is host-supported (`Plugin.Cleanup` cached awaited promise): it always drains the
  controller before host completion, and UI close exceptions cannot skip dispose.
- Native vault mutation rejection classified as outcome-uncertain, without retry
  or blind cleanup. No plaintext credential fallback.
- Exact external `@napi-rs/keyring@2.1.2` dependency, external to the TUI bundle.
- Owner-approved 69-file pack boundary, including cloud source intentionally
  (`src/cloud/.npmignore` deleted), with no `.node` binary and no plaintext tokens.

## Recorded validation

- Root suite: **842 passed, 1 POSIX-only skip, 0 failures**, 18,877 expectations,
  59 files. Root typecheck passed.
- Focused native/controller checks: **49 passed, 285 assertions**.
- Focused teardown: **30/173 PASS**.
- Windows ownership/vault focused tests: 27 passed, 1 POSIX-only skip; 14 actual
  child-process invocations exercised cooperative locking and crash retention.
- Native-dialog flow tests: 9 passed, 60 assertions.
- npm and Bun dry-run package listings: **69 files**. This intentionally replaces
  the earlier 58-file boundary under explicit owner approval for M3 integration.
- Three clean package consumers: 69 files each, keyring resolves, verifier `ok:true`,
  no problems.
- Verified tarball SHA-256:
  `42fa47ca3e82dc18b012dd569e023a0ec6c8b3712cbe0b83c69c9534547f00ce`
  (scratch `.package-verify-work/mvgp4731-3hcxhx6q`). The earlier `839`-test /
  `408ff7fd...` and `833`-test / `d6a8ee7b...` snapshots are historical only,
  not current.
- Ora9 native material review2: **GO for the source commit boundary**. The native
  source is committed at `cd3ef6902d7bf3e62faf2b75effc36ece75f4ba0`. This is not
  AUTH-02 or milestone acceptance.

## Not established by this evidence

Actual-host UI rendering/focus/Escape, live GitHub OAuth and API login, authoritative
session/CSRF runtime behavior, real host/OAuth/API/vault end-to-end flows, locked and
macOS/Linux vaults, M1 host import, and application-database behavior remain separate
checks. PostgreSQL `0003` validation-only apply/postcheck passed owner/server-reported,
but the single protocol run **failed** (6/15; `revision-concurrent-siblings`) and the
driver-only fix53 correction is committed at `c44ea02f1086c4e10b5c0ac5b190acee06fbb1b0`
after Ora8 source GO (offline 10/10 + API typecheck PASS); it is not live validated
([protocol result](protocol-postgres-validation-result-20261020.md)). A runtime auth
flow has not been run against a server; login still requires server-verified
session/CSRF/native-lifecycle proof. Outbox keys/state are M5 future work and are not
satisfied by a fake backend in M3. The [Windows synthetic vault
result](vault-windows-synthetic-20261020.md) records its process-exit instrumentation
limitation. No repeat probe was performed.

The candidate remains unpublished and untagged. The native source is committed at
`cd3ef6902d7bf3e62faf2b75effc36ece75f4ba0`.
No main-database migration, deployment, provider proof, or M1–M3 milestone completion
is claimed here. No full M1–M3 acceptance or M4 authorization is inferred; the parent
answered that the isolated test API/validation database is sufficient and production
deployment is not required. Source approval is not acceptance: M1–M3 remain Partial until their
own runtime criteria are met.
