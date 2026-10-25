# Native `/sync` validation (fixed mode)

This folder holds the fixed native-site inputs for
`run-command-integration-probe.ps1 -NativeSyncValidation`:

- `tui-sync-probe.ts` — staged verbatim as the only plugin under the disposable
  root. It installs the real `installSessionPortWiring` with real product
  defaults, the explicit isolated runtime option (`context.options.sessionportCloud`),
  and bounded observation wrappers for toasts and host alerts. It never
  dispatches `/sync`, never logs in, and never reads dialog content,
  verification URLs, human codes, tokens, or identity. Alert title/message are
  forwarded unread; only a fixed-enum status observation is recorded.
- `cleanup-entry.mjs` — exact-entry vault cleanup guard staged into the
  disposable source copy. It runs only after the verified TUI process-tree stop,
  targets the run-unique `sessionport-m3-<UUID>` / `credential` pair through the
  real pinned `AsyncEntry`, and writes a receipt with `presence`/`removed`
  booleans only. It never enumerates credentials and never writes a secret.
- `validation.test.ts` — host-free tests (fake keyring constructor; static
  staging/config/cleanup guards; validation-only NOT-STARTED checks).

Owner flow (manual, in the native UI): `/sync login` → enter the displayed code
in the browser and approve → `/sync status` → `/sync logout`. `/sync logout`
removes the local credential only; it does **not** revoke the server grant.

The native TUI launch inherits the caller's console (stdin/stdout/stderr are not
redirected, captured, drained, or persisted), so the owner sees and operates the
real UI and only the native UI renders the verification code. Native mode uses
the explicit `@opencode/cli` `.exe` (M1-verified path) and gates its version to
`2.1.1` before launch; `-OpenCodePath` remains an `.exe`-only override. The
preflight `debug paths` command and the default checkpoint/restore probe keep
their bounded in-memory capture/drain.

Do not paste verification codes, URLs, tokens, or identity details into chat or
logs. The runner prints only fixed-safe booleans/counts.

A pre-existing vault entry at preflight stops the plugin before wiring with no
overwrite or delete. If post-stop cleanup cannot prove the run-unique entry
absent/removed, the runner retains the private disposable root and exits 3.

## Terminal outcome instrumentation

The probe uses the documented `installSessionPortWiring` `createCloudAuth` seam
with the REAL controller, REAL cloud-auth flow, and REAL native UI. It records
only fixed enums/booleans/numbers:

- `observations.native.terminalOutcome` — actual controller login/logout result
  (`signed-in`, `cancelled`, `unavailable`, `reauth-required`, `expired`,
  `denied`, `busy`, `unknown`).
- `loginOutcome` — first non-unknown login result; retained after a later logout
  so the pre-logout login evidence remains visible.
- `beginStatus`, `pollLastStatus`, `tokenStatus` — HTTP status codes only.
- `errorCategory` — fixed wire-code name, `omitted-by-wire-allowlist`,
  `unrecognized-error-code`, `transport-error`, or `unknown`; never raw text.
- `beginFields` / `pollLastFields` / `tokenFields` — allowlisted response field
  names only; unknown keys contribute a count, never a name.
- `vaultCommitOutcome` — `not-observed` unless the controller itself returns
  `signed-in` (recorded as `controller-result-signed-in`, not a direct vault
  readback).
- `statusResult` — **command-proven pre-logout** evidence: a `controller.status`
  response made directly inside the owner's explicit `/sync status` dispatch
  before a logout terminal result. Internal login/logout preflights never
  overwrite it. A later post-logout status is recorded separately, so this field
  keeps the last pre-logout observation visible even when the owner checks
  status again after `/sync logout`.
- `preLogoutStatusResult` — snapshot taken when an explicit `/sync logout`
  starts: the current command-proven `statusResult`, or the alert-observation
  fallback when no command-proven value exists.
- `postLogoutStatusResult` — an explicit `/sync status` observed after a
  `signed-out` logout terminal result. It never overwrites `statusResult`.
- `alertStatusResult` — **observation-only**: the latest scalar controller status
  seen when a host alert was triggered. The harness forwards the alert without
  reading its title/message/content; an alert alone does not prove which command
  produced that status.
- `lastStatusResult` — context only: the latest controller status including
  internal preflights. It is not owner evidence.
- `events` — ordered validation-only history of fixed enum tokens (maximum 16),
  for example `sync:status`, `status:owner`, `status:internal:login`,
  `alert:observed`, `logout:terminal`. No raw text, dialog content, URL, code,
  identity, or timestamp is recorded. New events stop at the bound.

Known limitation: a status reached through the bare `/sync` menu is invoked by
the product flow under the `usage` dispatch, so the harness cannot prove it was
an explicit owner status command. Such a result is only visible as
`alertStatusResult` (observation-only), never as `statusResult`; the event
history labels it `status:internal:usage`. The prescribed flow uses `/sync
status`, which is command-proven.

Dispatch note: the host does not serialize awaited slash handlers. The harness
snapshots the dispatch action before awaiting any controller status, so a
pending status cannot be relabelled by a later command. A post-logout status is
recorded in `postLogoutStatusResult`; it cannot erase `statusResult`.

The fetch observer is controller-scoped (no global fetch monkeypatch), never
records bodies/values/tokens/codes/URL queries, and does not affect checkpoint/
restore or host/provider traffic. The runner prints one fixed-safe
`native-outcome: login=... terminal=... status=... begin=... pollLast=...
token=... error=... vaultCommit=...` line and nothing else from this record.
`status` is the command-proven pre-logout `statusResult`; `preLogoutStatusResult`,
`postLogoutStatusResult`, `alertStatusResult`, `lastStatusResult`, and `events`
remain JSON-only.

Owner: keep the code window open until it closes automatically after approval;
do not dismiss it. Watch the terminal toast, then run `/sync status`.
