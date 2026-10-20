# PostgreSQL Fixture Harness — Inert Safety Plan and Synthetic Evidence

Status: **INERT / SYNTHETIC ONLY — NOT A SAFETY GO, NOT A DATABASE INTEGRATION PASS.**

Recorded: 2026-10-19. Validation owner: orchestrator. This document describes an
implemented test-support module and its synthetic tests. It does **not** authorize and does
**not** record any operational `initdb`, `pg_ctl`, or `postgres` execution; only read-only
`initdb --help`/`--version` was used to verify options. No PostgreSQL server was
started, no port was bound for a server, no database was created or connected to, and no
existing service, credential, user database, history, or host configuration was read or
changed.

Related paths:

- Harness: [`cloud/api/test-support/postgres-fixture.mjs`](../../cloud/api/test-support/postgres-fixture.mjs)
- Synthetic tests: [`cloud/api/test-support/postgres-fixture.node.mjs`](../../cloud/api/test-support/postgres-fixture.node.mjs)
- Reconciled V2 local context: [`.slim/deepwork/sessionport-v2-local.md`](../../.slim/deepwork/sessionport-v2-local.md)

## 1. Verdict and blocker

**An actual fixture launch remains blocked before process start.** The installed PostgreSQL
is 17.0 (`initdb (PostgreSQL) 17.0`). `initdb --help` on this host lists password options
`--pwfile=FILE` and `-W/--pwprompt`; it lists no stdin password option. The official
PostgreSQL 17 `initdb` documentation likewise documents only:

> `--pwfile=filename`: “Makes `initdb` read the bootstrap superuser's password from a file.
> The first line of the file is taken as the password.”

> `-W`, `--pwprompt`: “Makes `initdb` prompt for a password to give the bootstrap superuser.”

No standard-input password mechanism is documented. Therefore this harness does **not**
silently write a plaintext password file and does **not** fall back to `trust`
authentication. Its default mechanism is the exported
`UNSUPPORTED_INITDB_PASSWORD_MECHANISM`; `start()` fails with
`INITDB_PASSWORD_STDIN_UNSUPPORTED` before creating a directory or invoking a process.

The synthetic tests inject a **test-double** mechanism object that models secret delivery
on stdin. That double is not evidence that real `initdb` supports it. It exists only to
exercise the harness's command/stdin/cleanup plumbing without PostgreSQL.

Subsequent PG17 `REL_17_0` source review confirms `--pwfile` is a literal `fopen` filename
with no `-`/stdin special case, and `-W` takes the interactive terminal-prompt branch. No
reviewed non-interactive password mechanism is available; real integration remains deferred.

Resolving this blocker requires an owner-approved password-delivery decision (for example,
a future review of a protected temporary file with strict ACL and deletion, or a supported
non-interactive mechanism). Until then, the real path stays blocked.

## 2. Scope and non-goals

- Test-support only. No production import, no application startup, no server listener, no
  auth path, no business schema, no vendor code.
- Importing the module has no side effects: no directory creation, no environment mutation,
  no process execution, no secret generation.
- The module bundles **no executor**. `start()` requires an explicitly injected `runner`;
  there is no default `child_process` fallback. A future approved runner must be supplied
  after safety review.
- Explicitly out of scope and untouched: installed PG 16/17 services on port 5432, Docker
  daemon/service, user credentials, `PGPASSFILE`, `.pgpass`, `PGDATA`, user history,
  production/cloud accounts, host configuration.
- Synthetic tests write only under the OS temporary directory; they do not create
  `.package-verify-work`, do not write repository files, and clean their temporary roots.
- Future raw data-directory files are synthetic metadata only. This harness is not a way to
  attach to or copy a native user database.

## 3. API and process contract

`createPostgresFixture(options)` is inert. Options:

- `scratchParent` (required, absolute): existing canonical directory inside the approved
  root.
- `approvedScratchRoot` (default `<repo>/.package-verify-work`): existing canonical root.
  A future approved run must create this root; the harness refuses to invent or broaden it.
- `pgBin` (required, absolute): directory containing fixed executable names only
  (`initdb[.exe]`, `pg_ctl[.exe]`, `postgres[.exe]`).
- `runner` (required): `{ run(command, args, { env, stdin, timeoutMs, maxOutputBytes, signal }) }`
  resolving `{ code, timedOut, aborted, stdout, stderr, stdinStatus, stdinErrorCode }`.
  `stdinStatus` is one of `not-provided`, `completed`, `incomplete`, or `error`; the
  adapter preserves it and normalizes an absent field to `missing`. The runner must
  terminate its child on timeout/abort; this contract is not yet validated against a real
  PostgreSQL process.
  - **Credential gate:** initdb is accepted only when `stdinStatus === 'completed'` and the
    exit code is 0. `error`, `incomplete`, `missing`, or `not-provided` is rejected even
    though the child exited 0; a completed stream proves bytes were written to the OS pipe,
    not that initdb consumed them or that PostgreSQL supports the mechanism.
- `portAllocator`, `portProbe`: injectable; defaults bind `127.0.0.1:0` and probe a
  candidate by binding `127.0.0.1:<port>`.
- `initdbPasswordMechanism`: defaults to the unsupported blocker. A test double may supply
  static `extraArgs` and `secretPlacement: 'stdin'`.
- `timeouts`, `maxOutputBytes`, `maxPortAttempts`: bounded as described in §8.
- `sourceEnv`: injectable parent environment; defaults to `process.env` but is filtered.

Methods:

- `start({ signal })`: prepare, allocate a port, run initdb, write synthetic server config,
  run `pg_ctl start`, verify `pg_ctl status`, return connection fields (caller memory only).
- `stop({ mode, signal })`: `pg_ctl stop -D <exact owned dataDir>` bounded, then
  `pg_ctl status -D <exact owned dataDir>`; cleanup only after status proves not running.
- `getConnectionConfig()` / `getConnectionString()`: only while running; returned to caller
  memory. The string is never written to disk, env, args, logs, markers, or errors.
- `getStatus()`: state, fixture id, canonical paths, port, retained flag; never the secret.

## 4. Exact state ownership

- Each start creates a new `mkdtemp(<scratchParent>/sp-pg-fixture-*)` directory.
- The owned data directory is `<root>/data`; the log is `<root>/postgres.log`.
- An ownership marker `<root>/sessionport-pg-fixture-owner.json` records schema,
  fixture id, random nonce, canonical root/data paths, `pgBin`, creation time, and platform.
  It contains no secret.
- Before any stop or cleanup, the harness verifies: root is a real directory (not a symlink), its
  `realpath` is unchanged, the marker is a bounded regular file, schema/id/nonce match using
  a timing-safe comparison, marker paths match, the data directory is a real directory
  (not a symlink), and its canonical path remains inside the root.
- Cleanup allowlist is exactly the marker, `data`, and `postgres.log`. Any unexpected entry
  refuses cleanup and retains the directory rather than deleting broadly. The final root
  removal is non-recursive (`rmdir`), so foreign entries cannot be swept away.
- `pgBin` is canonicalized, must not be a symlink directory, and each fixed executable must
  be a regular non-symlink file (plus `X_OK` on POSIX). Arbitrary command strings and
  arbitrary data directories are not accepted.
- `scratchParent` and the approved root must exist, be canonical real directories, and the
  scratch parent must be inside the approved root. Symlinked roots/parents are refused.

## 5. Environment and secret handling

- Child environment is constructed from a small allowlist: on Windows
  `PATH`/`Path`, `SystemRoot`, `WINDIR`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP`,
  `SystemDrive`, `NUMBER_OF_PROCESSORS`; on POSIX `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`,
  `TZ`, `TMPDIR`. `HOME`, Windows profile variables, and `NODE_OPTIONS` are omitted.
- Every `PG*` variable is excluded, including `PGPASSWORD`, `PGHOST`, `PGPORT`, `PGDATA`,
  `PGOPTIONS`; `PGSERVICE`, `PGSERVICEFILE`, and `PGPASSFILE` are also excluded.
- Commands are absolute paths in `pgBin`; `-D` always names the exact owned data directory.
  No inherited default cluster or service is addressed.
- The synthetic superuser name is random (`spx_` + random hex). The password is 32 random
  bytes encoded as base64url, generated per start and kept in memory.
- The only secret channel implemented for the future is runner `stdin`; the password is not
  placed in argv, environment, `postgresql.conf`, the ownership marker, the log path, or any
  error message. No plaintext secret file is created.
- Errors and bounded output are redacted for both the raw secret and its URL-encoded form.
  The module never prints credentials or command lines containing secrets.

## 6. Port binding and conflict handling

- Server config always writes `listen_addresses = '127.0.0.1'` and an explicit port.
- On platforms other than Windows, `unix_socket_directories = ''` disables Unix sockets.
  On Windows no Unix-socket setting is emitted.
- Port 5432 is rejected outright; ports below 1024 and invalid values are rejected. There is
  no default-port or fallback-port behavior.
- Allocation is bounded (`maxPortAttempts`, default 5): the allocator/probe may retry only
  while a candidate is reported occupied. Invalid or forbidden candidates fail closed
  immediately, not by silently choosing another port.
- The free-port probe is bind/release on `127.0.0.1`; the start is a separate step. This
  **TOCTOU race is real** and is documented rather than claimed as a reservation. No user
  database is scanned.

## 7. Startup, failure, cancellation, and shutdown

Ordered lifecycle:

1. Fail closed on the password mechanism, then validate `pgBin` and scratch roots.
2. Allocate and probe a bounded non-default loopback port.
3. Create the owned root/data directory and ownership marker.
4. Run initdb with the secret on runner stdin (future mechanism only).
5. Append synthetic `postgresql.conf` (loopback, port, SCRAM, no secrets).
6. Run `pg_ctl start -D <owned dataDir> -l <owned root>/postgres.log -w -t <bounded>`.
7. Verify with `pg_ctl status -D <owned dataDir>` before declaring running.

Failure handling:

- initdb non-zero **after the process exited**: owned paths may be removed only after
  marker/path ownership verification; state becomes `failed-clean`.
- initdb zero-exit but stdin status `error`/`incomplete`/`missing`/`not-provided`: reject
  with `INITDB_STDIN_NOT_COMPLETED`, remove owned paths only after the process exit is
  known, and never start pg_ctl. If the exit is unconfirmed (`code` null), retain instead
  with `INITDB_STDIN_UNCERTAIN`. This closes the dropped-`stdinErrorCode` / zero-exit false
  initialization path.
- initdb timeout or abort: **retain** the data directory because initdb process termination
  is unverified. `stop()` refuses automatic deletion with `RETAINED_MANUAL_REVIEW` because no
  owned postmaster existed to verify.
- start non-zero/timeout: attempt `pg_ctl stop` only with the exact `-D` path, then verify
  `status`. If verification succeeds, owned paths may be removed; if not, state becomes
  `failed-retained` and the path is kept.
- `pg_ctl start` reports success but status is not 0: exact stop is attempted and status
  re-verified; cleanup only if stopped, otherwise retained.
- unexpected runner/preparation failure after directories exist: retain unless an exact
  owned postmaster can be verified stopped before cleanup.
- `stop()` on a retained server-may-exist state retries exact `pg_ctl stop` and status
  verification; cleanup happens only after status returns 3 (“not running”). `pg_ctl status`
  exit 0 is treated as running (success); 4 is inaccessible; any other/error/timeout is
  treated as unverified and retained. The official `pg_ctl` documentation explicitly
  documents 3 (not running) and 4 (inaccessible); only 3 authorizes cleanup here.
- Before any `pg_ctl stop`, ownership (marker/nonce/canonical/symlink checks) is re-verified.
  If it fails, no stop command is issued, because a tampered path could otherwise point
  `pg_ctl` at a foreign postmaster; the state is retained for manual review.
- No `taskkill`, no broad process kill, no PID-based kill, and no global `pg_ctl` command.
  PID reuse is therefore not relied on.

## 8. Bounds and limits

- Timeouts: initdb/start/stop 1–600 s (defaults 60/60/30 s), status 1–120 s (default 10 s).
  `pg_ctl -t` is derived from the same bound; the runner timeout adds a small margin.
- Output: runner stdout/stderr capped at `maxOutputBytes` (1 KiB–1 MiB, default 64 KiB).
  Error detail tails are capped at 2 KiB after redaction.
- Port attempts: 1–10 (default 5). Directory/name lengths are fixed by the generated
  `mkdtemp` prefix and random identifiers.
- No unbounded log reading or recursive scan of arbitrary paths. Only the owned root's
  direct entries are listed during cleanup.
- Connection strings/secrets live only in the caller's memory while running; `stop()` drops
  the reference.

## 9. Synthetic test evidence

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

This fixture file contributes **20** cases: the prior 17 plus the three zero-exit stdin
regression cells. The runner file contributes 15 cases. The combined run is the final
synthetic evidence for this remediation.

Coverage in that file:

| Requirement | Synthetic test |
| --- | --- |
| No import/construction side effects, idle state | “module import and construction are inert…” |
| Allowlisted env; PG*, PGSERVICE, PGPASSFILE, HOME excluded | “child environment is allowlisted…” |
| initdb args/config builders; loopback/Unix-socket behavior; no secret in args | “initdb and server-config builders…” |
| 5432/invalid port refusal, no fallback, bounded attempts | “port validation fails closed…” |
| Bounded fresh-port retry | “bounded fresh-port retry…” |
| Default unsupported mechanism blocks before writes/process | “default unsupported initdb password mechanism…” |
| Abort before start | “aborted start performs no writes…” |
| Secret on stdin only; exact `-D` args; restricted cleanup; sibling preserved | “successful start sends the generated secret on stdin only…” |
| initdb failure cleanup, truncation, redaction | “initdb failure cleans owned paths…” |
| Zero-exit initdb + EPIPE stdin status rejected/cleaned | “zero-exit initdb with EPIPE stdin status…” |
| Zero-exit initdb + incomplete stdin status rejected/cleaned | “zero-exit initdb with incomplete stdin status…” |
| Zero-exit initdb + missing stdin status rejected/cleaned | “zero-exit initdb with missing stdin status…” |
| initdb timeout retention | “initdb timeout retains…” |
| Unexpected runner failure retention | “unexpected runner failure after preparation retains…” |
| Start timeout, uncertain stop retention, later verified recovery | “start timeout with unverifiable stop…” |
| Stop uncertainty retention/recovery | “stop status uncertainty retains…” |
| Marker tamper refuses cleanup | “tampered ownership marker refuses cleanup…” |
| Symlink data directory refuses cleanup; foreign target preserved | “symlinked data directory refuses cleanup…” |
| Unique generated user/password per fixture | “each started fixture generates unique…” |
| Raw and URL-encoded secret redaction | “redaction removes raw and URL-encoded secret forms” |

The tests used fake executables (inert placeholder files), a fake runner, injected
allocator/probe, and injected test-double stdin mechanism. They performed no real PostgreSQL
command and no real database connection. The symlink test passed using a Windows junction;
POSIX symlink behavior was not exercised on this host.

## 10. Safety review context and remaining risks

An independent safety GO for any real run still requires, at minimum:

1. An approved resolution of the initdb password-delivery blocker; no plaintext file or
   trust fallback may be introduced silently.
2. A reviewed real process runner that enforces timeout/abort termination and bounded output
   against actual children, plus independent verification that it leaves no child behind.
3. Creation and ownership review of `.package-verify-work` and the exact run directory.
4. A separate probe plan covering platform claims, connection proof, and concurrency
   evidence. This document is not that pass.

Known risks / honesty notes:

- **Password blocker:** no supported stdin mechanism was found; the test double must not be
  mistaken for real support.
- **Stdin completion is not password support:** `stdinStatus: 'completed'` means bytes were
  handed to the child's OS pipe. It does not prove initdb consumed them, accepted the
  password, or that PostgreSQL supports this delivery. The adapter only uses it as a
  necessary fail-closed gate alongside exit code 0; no stronger claim is made.
- **Port reservation race:** probe-and-release does not reserve the port. A conflict between
  probe and server bind is possible; the harness fails closed but cannot eliminate the race.
- **Filesystem race:** ownership is re-verified immediately before destructive steps, but a
  local attacker could swap a path between verification and deletion. Scope is a local
  test-only disposable directory; no claim of adversarial hardening is made. If ownership
  checks fail while a server may be running, `stop()` deliberately refuses to run
  `pg_ctl stop`; that owned process may remain until manual review.
- **Runner contract:** real spawn semantics, timeout kill behavior, and process-tree
  cleanup are unverified; synthetics only prove the harness's own decisions.
- **Platform coverage:** only Windows was exercised. POSIX executable permissions, Unix
  socket disabling, and symlink behavior remain unverified.
- **No database evidence:** no initdb success, no server start, no SQL, no auth, no
  concurrent transaction, and no connection-string use against PostgreSQL is claimed.

## 11. Provenance of this record

Read-only checks used:

- `C:\Program Files\PostgreSQL\17\bin\initdb.exe --help` and `--version` (PostgreSQL 17.0).
- Official PostgreSQL 17 documentation:
  <https://www.postgresql.org/docs/17/app-initdb.html> and
  <https://www.postgresql.org/docs/17/app-pg-ctl.html>.
- `node --version` (v22.13.1) and the synthetic test command above.

No `initdb`, `pg_ctl`, or `postgres` server command was executed beyond the read-only
`--help`/`--version` shown. No service was contacted or modified.
