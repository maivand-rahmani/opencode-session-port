# PostgreSQL Process Runner — Synthetic Evidence and Safety Notes

Status: **IMPLEMENTED / SYNTHETIC NODE PROCESSES ONLY — NOT A POSTGRESQL PASS, NOT A SAFETY GO. REAL DATABASE INTEGRATION IS DEFERRED.**

Recorded: 2026-10-19. Validation owner: orchestrator. This document covers the new
`postgres-runner.mjs` test-support runner and its synthetic tests. It records **no**
`initdb`, `pg_ctl`, postgres server, service, network, Docker, host, history, account, or
real-database operation. The fixture harness itself was not modified.

Related paths:

- Runner: [`cloud/api/test-support/postgres-runner.mjs`](../../cloud/api/test-support/postgres-runner.mjs)
- Synthetic tests: [`cloud/api/test-support/postgres-runner.node.mjs`](../../cloud/api/test-support/postgres-runner.node.mjs)
- Consuming harness (unchanged): [`cloud/api/test-support/postgres-fixture.mjs`](../../cloud/api/test-support/postgres-fixture.mjs)
- Prior fixture evidence: [`docs/evidence/postgres-fixture.md`](./postgres-fixture.md)

## 1. Contract reviewed

The existing harness consumes:

```text
runner.run(command, args, { env, stdin, timeoutMs, maxOutputBytes, signal })
  -> { code, timedOut, aborted, stdout, stderr, stdinStatus, stdinErrorCode }
```

The harness sanitizes/caps stdout/stderr, preserves `stdinStatus`/`stdinErrorCode`, treats
`timedOut`/`aborted` as retention signals for initdb/start uncertainty, and treats a
non-zero/non-numeric `code` as failure. The new runner matches that shape and adds
ignored-by-harness metadata: `termination`, `processTree`, `spawnError`, `outputOverflow`,
`durationMs`.

**Adapter credential gate:** the fixture now accepts initdb only when `stdinStatus ===
'completed'` and the exit code is 0. `error`, `incomplete`, `missing`, or `not-provided` is
rejected even on child exit 0, with owned paths cleaned only after confirmed process exit or
retained if exit is unconfirmed. This closes the Oracle attempt-1 finding where the adapter
dropped `stdinErrorCode` and accepted a zero-exit early stdin close/EPIPE.

**Remaining harness interface gap:** the harness still has no first-class “process tree
uncertain” or “output overflow” field. The runner conservatively maps uncertain termination
and output overflow to `timedOut: true` so the existing harness retains the data directory.
A first-class `processUncertain` field (and harness use of `outputOverflow`) would require
a bounded harness change; it was **not** made in this lane.

### Real integration status — DEFERRED

Recorded upstream source finding: PostgreSQL 17 `REL_17_0` `initdb` opens `--pwfile` with
`fopen` on the literal filename; there is no `-`/stdin special case, and `-W` takes the
interactive terminal-prompt branch. No reviewed non-interactive password mechanism is
available.

Real database integration is therefore **deferred**. This lane did not attempt a plaintext
password file, `trust` authentication, PTY emulation, a named-pipe workaround, or any
`initdb`/`pg_ctl`/`postgres` activation. The runner remains reusable test-support plumbing;
the actual fixture launch stays blocked pending an owner-approved mechanism and a separate
Oracle/safety GO.

## 2. Runner API and bounds

`createNodeProcessRunner(options)` is inert and synchronous. It performs no process launch.

- `allowedExecutables` (required): non-empty absolute-path allowlist. Every `run` command
  must be absolute and exactly present (case-insensitive on Windows); there is no PATH
  lookup or fallback.
- `cwd`: optional absolute working directory. Default is the executable's own directory.
  The child never inherits the parent working directory implicitly.
- `taskkillPath`: optional absolute `...\System32\taskkill.exe`; validated again before use
  (regular non-symlink file, parent directory named `System32`).
- `taskkillEnv`: explicit environment for the taskkill helper; not inherited.
- `terminationGraceMs`: 100–10,000 ms, default 1,500.
- `taskkillTimeoutMs`: 100–5,000 ms, default 1,500.
- Run options:
  - `env`: exact plain object of string values. Default `{}`; `process.env` is never merged.
  - `stdin`: string or Buffer, capped at 64 KiB. Copied internally.
  - `timeoutMs`: 1–600,000 ms, default 30,000.
  - `maxOutputBytes`: 1 byte–1 MiB per stream, default 64 KiB.
  - `signal`: AbortSignal.
- Fixed: `shell: false`, `windowsHide: true`, `detached: false`, piped stdio.

## 3. Secret handling

- Generated fixture secrets are supplied through `stdin`; the runner never puts stdin bytes
  into argv or env.
- The result reports `stdinStatus` as `not-provided`, `completed`, `incomplete`, or `error`,
  plus a safe `stdinErrorCode` such as `EPIPE`. `completed` is set only by the writable
  stream's finish/end completion; an early close or write error leaves `incomplete`/`error`.
  The finished stream proves only that bytes were handed to the OS pipe, not that the child
  consumed them or accepted the password.
- If the same secret text (or its URL-encoded/trailing-newline-trimmed forms) appears in
  `args` or `env`, the run is rejected with `SECRET_IN_ARGUMENTS` / `SECRET_IN_ENV` before
  spawn.
- Child stdout/stderr are captured with a bounded accumulator; on overflow the capture stops
  adding bytes, marks the stream, and terminates the child. It does not accumulate then
  truncate at the end.
- Returned stdout/stderr have the full UTF-8 secret, its trailing-newline-trimmed form, and
  their URL-encoded forms replaced with `[REDACTED]`. No raw command line, environment, stdin,
  or error message is returned.
- Spawn/error metadata is limited to safe `{ code, name }`; no path, env, argv, or secret.
- Limits: a truncated partial secret before overflow cannot be pattern-matched; generated
  fixture credentials are short ASCII, and output is capped. No claim of content-aware
  redaction for arbitrary binary payloads is made.

## 4. Process ownership and termination

- The runner kills only the `ChildProcess` object it spawned in that invocation.
- No global process kill, no PID scan, no arbitrary PID, no `taskkill` outside the owned
  child, and no PID file parsing.
- **Windows tree request (optional):** only when `taskkillPath` is configured and valid, the
  child PID is an integer, and the child is still live, the runner invokes
  `taskkill.exe /PID <ownedPid> /T /F` with `shell:false`, an absolute System32 tool path,
  an explicit tool env, and a bounded timeout. It then directly kills the owned child if it
  is still live. The result is reported as `processTree: 'tree-kill-requested'`, not proof
  that every descendant or daemon was stopped.
- **POSIX:** direct child kill only; no process-group kill is attempted. Descendant state is
  reported uncertain. This path was not exercised on this Windows host.
- **Normal success/non-zero exit:** no descendant kill is attempted. A successful
  `pg_ctl start` may intentionally daemonize a postmaster; the harness owns exact
  `pg_ctl stop -D <owned dataDir>` shutdown. This is deliberate and tested with a synthetic
  detached Node descendant.
- **Timeout/abort/output overflow:** the owned child is terminated with bounded cleanup.
  If close is not observed within the grace period, the outcome is `termination:
  'uncertain'` and `processTree: 'uncertain'` (or `tree-kill-requested`). The harness sees a
  retention signal (`timedOut`/`aborted`), so it must not delete the data directory.
- **Timed-out initdb vs timed-out pg_ctl:** both are treated as uncertain. A timed-out
  pg_ctl may already have spawned/daemonized a postmaster; a timed-out initdb may still have
  a bootstrap process. The runner cannot prove either is gone. The harness must perform its
  exact `pg_ctl stop -D`/status verification or retain. Ordinary synthetic Node timeouts in
  the test suite prove direct child termination only; they do not prove PostgreSQL daemon
  semantics.

## 5. Lifecycle integrity

- Every run settles once via a `settled` guard.
- Timeout timer, AbortSignal listener, and stdin/stdout/stderr handling are torn down on
  settle.
- Pre-aborted signal returns `aborted: true`, `termination: 'not-spawned'`, and spawns
  nothing.
- Spawn failure returns `spawnError` with no PID/command echo.
- stdin `EPIPE`/early child exit is recorded as `stdinStatus: 'error'`/`incomplete` and a
  safe `stdinErrorCode`; it does not reject the runner, but the credential adapter must
  reject the initdb result.
- Output overflow triggers one termination request; further chunks are ignored.
- Abort/timeout/overflow races settle on the first trigger.
- On uncertain settlement the child is `unref()`ed and streams are destroyed so the test
  process can exit; the runner does not pretend the process tree is stopped.

## 6. Synthetic test evidence

Command (final combined explicit native Node run):

```text
node --test ./cloud/api/test-support/postgres-fixture.node.mjs ./cloud/api/test-support/postgres-runner.node.mjs
```

Result on 2026-10-19, Node v22.13.1, Windows:

```text
# tests 35
# pass 35
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2391.5643
```

This runner file contributes **15** cases; the fixture file contributes 20, including the
three zero-exit stdin regression cells (`EPIPE`, `incomplete`, `missing`) that exercise the
adapter end-to-end. The combined run is the final synthetic evidence for this remediation.

Tests spawn only bounded synthetic Node processes via `-e` strings. No JS fixture files,
network, PostgreSQL command, service, or database is used. The Windows taskkill test is the
only OS-tool invocation; it uses the System32 path, a bounded timeout, and exact owned PIDs.

| Area | Test |
| --- | --- |
| Inert import/construction | “module import and runner construction are inert” |
| Success / bounded output | “successful command exits 0 with bounded stdout/stderr…” |
| Non-zero exit | “non-zero command returns its exit code without throwing” |
| Spawn failure | “spawn failure returns safe spawn metadata…” |
| Allowlist / no argv echo | “executable outside the explicit allowlist is rejected…” |
| stdin secret, completion status, no args/env leak | “secret is delivered on stdin only, hashed by the child…” |
| stdin early-exit/EPIPE handling | “stdin EPIPE from an early-exiting child does not reject…” |
| Pre-abort no spawn | “pre-aborted signal spawns nothing…” |
| In-flight abort | “in-flight abort terminates only the owned child…” |
| Timeout / direct child death | “timeout terminates the owned child…” |
| Output overflow bounded | “output overflow stops capture and terminates…” |
| Normal bounded output | “output below the cap stays bounded…” |
| Success does not kill daemon descendant | “successful command is not allowed to blanket-kill…” |
| Foreign PID survives | “timeout of one child does not kill a foreign synthetic process” |
| Bounded Windows taskkill tree | “Windows taskkill is bounded to the owned tree…” |

## 7. Known limits and required follow-ups

- **No PostgreSQL evidence:** no initdb success, no pg_ctl start/stop, no postmaster, no SQL,
  no auth, no connection, no concurrency proof.
- **Missing reviewed password mechanism:** PG17 `REL_17_0` source confirms `--pwfile` is a
  literal `fopen` path with no stdin `-` support, while `-W` prompts the terminal. Real
  integration is deferred; no plaintext file, trust fallback, PTY, or named-pipe workaround
  was attempted in this lane.
- **Stdin completion is not consumption:** `stdinStatus: 'completed'` proves only that bytes
  were handed to the OS pipe. It does not prove initdb read or accepted the password, or that
  PostgreSQL supports this delivery. The adapter uses it only as a necessary fail-closed gate
  with exit code 0.
- **Oracle attempt-1 issue closed:** the adapter now preserves `stdinStatus`/`stdinErrorCode`
  and rejects zero-exit `EPIPE`, `incomplete`, and `missing` cells; the previous dropped-field
  zero-exit acceptance path is covered by adapter integration tests.
- **Windows-only:** Node 22.13.1 on Windows was exercised. POSIX executable permissions,
  signals, process groups, and taskkill do not apply/are unverified.
- **Tree proof:** even a successful Windows taskkill request is not proof that every
  escaped/daemonized descendant is gone. The runner reports `tree-kill-requested` or
  `uncertain`; harness retention remains mandatory.
- **PID reuse race:** taskkill is guarded by an owned live PID/tool-path check, but the
  check-to-call window cannot be made atomic with Node builtins. No claim of eliminating
  this race is made.
- **Harness contract gap:** `outputOverflow` and `processTree` are extra fields the current
  harness ignores. Uncertain termination is mapped to `timedOut: true`; a first-class
  `processUncertain` field would require a bounded harness change. Do not remove the
  conservative mapping before that interface is reviewed.
- **Success daemon behavior:** the synthetic test proves the runner does not kill a detached
  synthetic Node descendant after a successful command. PostgreSQL's exact daemonization
  behavior and the harness's `pg_ctl stop -D` path remain untested.
- **Partial redaction:** full-secret redaction only; a truncated prefix emitted before output
  overflow is not pattern-redacted.
- **Future real run gate:** a separate Oracle/safety GO is still required before any actual
  fixture launch. This runner is an implementation affordance, not authorization, and it
  must not be used to claim database integration.

## 8. Provenance

- Inspected and updated the harness runner consumer contract in
  `cloud/api/test-support/postgres-fixture.mjs` (`#run`, `#startInternal`) to preserve
  `stdinStatus`/`stdinErrorCode` and reject zero-exit stdin failure/incomplete/missing.
- Recorded the PG17 `REL_17_0` password-mechanism finding from the lane handoff; no
  PostgreSQL source checkout was performed in this lane.
- Ran only `node --check` and the explicit synthetic test command above.
- No PostgreSQL binary was executed in this lane; no service, DB, Docker, host config, user
  history, account, Git mutation, or dependency install was touched.
