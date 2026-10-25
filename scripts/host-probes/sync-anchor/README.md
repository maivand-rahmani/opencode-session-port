# Sync-anchor route/cache probe

Small Windows-only preparation for an isolated OpenCode TUI proof. The probe plugin and
its public API shape were prepared against OpenCode 2.0.22 source. The runner accepts an
explicit expected version: the historical `2.0.22` baseline or the current `2.1.1`
runtime compatibility trial. A `2.1.1` run exercises the pinned 2.0.22-shaped public SDK
surface on the newer runtime; it is not evidence that the 2.0.22 source analysis
describes 2.1.1 behavior. The probe checks whether two synthetic child snapshots can be
imported under one synthetic root and whether public route/cache APIs can take the native
session view from that root to the latest child. It adds no SessionPort product behavior
and is **not** a host-run approval.

## Files and default

- `sync-anchor.tui.tsx` — public TUI plugin. Its app slot renders no custom content; it
  imports and observes only synthetic data, then uses the host's native session route.
- `route-guard.ts` and `route-guard.test.ts` — pure bounded redirect state and focused
  tests.
- `run-sync-anchor-probe.ps1` — opt-in isolated runner.
- `run-sync-anchor-probe.test.ps1` — host-free focused checks for runner parsing, fixed
  failure diagnostics, debug-paths format fixtures, environment isolation, and
  compiler-only helper validation.

Default invocation is static validation only. It reads these probe files, starts no
process, creates no folder, and does not inspect OpenCode profiles, configuration,
services, or databases:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\sync-anchor\run-sync-anchor-probe.ps1
```

An actual run is **blocked until the parent and host-safety reviewer approve it**. The
single-run form, if separately approved, is:

```powershell
# Original baseline:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\sync-anchor\run-sync-anchor-probe.ps1 -RunProbe -ExpectedVersion 2.0.22

# Explicit current-runtime compatibility trial:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\sync-anchor\run-sync-anchor-probe.ps1 -RunProbe -ExpectedVersion 2.1.1 -OpenCodePath "C:\Users\PC\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe"
```

`-ExpectedVersion` is an exact allowlist, not a wildcard: `2.0.22` (default; original
preparation baseline) or `2.1.1` (explicit current-runtime compatibility trial). The
runner requires the parsed `opencode --version` to equal it exactly before starting the
TUI, includes `expectedVersion` in the sanitized SyncAnchor runtime result, and rejects
any other value during static validation before host side effects. The runner does not install,
upgrade, or downgrade OpenCode; `-OpenCodePath` must point at an already-installed `.exe`.

Optional bounds: `-TimeoutSeconds` (30–180, default 180), `-InspectSeconds` (0–90,
default 20), and `-OpenCodePath` (an installed `.exe`; otherwise `opencode.exe` must be
on `PATH`). There is deliberately no `-KeepRoot` option. Do not retry an actual run
without a new review.

## Probe modes

`-ProbeMode` is a fixed two-value switch. `SyncAnchor` (default) is the original probe
above and its validation path is unchanged. `NativeReplacement` selects the fixed
native-replacement TUI lane added on 2026-10-24.

Native mode never accepts a caller-supplied plugin file, directory, or glob. It resolves
exactly two reviewed locations from the repository root:

1. `.package-verify-work/m1-native-tui-plugin-20261024/tui.tsx` (preferred single-file
   bundle from the plugin lane), or
2. `scripts/host-probes/native-replacement/tui/tui.tsx` (known new-source entry), plus
   `scripts/host-probes/native-replacement/tui/fixtures.ts` only when the source entry is
   used.

The staged plugin directory is the fixed `config/plugins/native-replacement-probe`; only
the allowlisted destination names `tui.tsx` and `fixtures.ts` are copied. No unrelated
project file is read or staged. If neither fixed entry exists, static validation fails
closed with `VALIDATION-FAILED: native-replacement plugin artifact is missing`; that is
the remaining plugin-integration gate for this lane.

Native mode reuses the same disposable root, version/debug-paths preflight, isolated
environment allowlist, Job Object stop/verify, inspection window, cleanup, and exit
codes. Its result is a separate exact schema, capped at 4 KiB and printed once as
`PROBE-NATIVE-RESULT-JSON`:

```json
{"probe":"sessionport-native-replacement-tui","version":1,"ok":false,"stage":"preflight","reason":"none","importedCount":0,"oldMessageCount":0,"candidateMessageCount":0,"nativeRouteObserved":false,"parentlessVerified":false,"archiveNotTested":true,"composerNotTested":true,"pickerNotTested":true}
```

`stage` is one of `preflight`, `import-old`, `import-candidate`, `verify-history`,
`navigate`, `complete`, `failed`; `reason` is one of `none`, `isolation`, `capability`,
`import`, `history`, `navigation`, `internal`. Counts are clamped (`importedCount` 0–2,
`oldMessageCount` 0–3, `candidateMessageCount` 0–4). Unknown values, extra keys, IDs,
message text, and arbitrary strings are dropped or mapped to fixed labels. `ok` is true
only for `stage=complete` with two imports, old/candidate history counts 2/3,
`parentlessVerified=true`, and `nativeRouteObserved=true`. The archive, composer, and
picker fields are always recorded as `true` (not tested); this probe claims no pixels.

`-CombinedRestartProbe` is rejected in native mode before any host side effect. The
separate API restart readback already showed it is not evidence about the current UI;
the first native UI lane stays single-launch. Do not add archive or restart coverage
here.

## Native replacement wrapper

`scripts/host-probes/native-replacement/run-tui-probe.ps1` is a thin fixed wrapper: native
mode, expected version `2.1.1`, the observed installed
`C:\Users\PC\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe`, timeout 180
seconds (max 180), and inspection window 90 seconds (range 60–90). It exposes no mode,
version, plugin-path, or combined-restart override, and it starts nothing unless
`-RunProbe` is passed explicitly.

From the project root, static validation only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\native-replacement\run-tui-probe.ps1
```

A later owner-approved single run, only after the parent/host-safety review and after the
fixed plugin artifact exists:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\native-replacement\run-tui-probe.ps1 -RunProbe
```

During the owner window, the native TUI is visible for 60–90 seconds; type only an
UNSENT draft and press no Enter. This lane does not claim that terminal residue or mode
restoration is fixed.

## Failure diagnostics and focused checks

The runner tracks a fixed preflight stage: `preconditions`, `create-root`,
`compile-helper`, `build-env`, `version`, `stage-plugin`, `debug-capture`, `debug-json`,
`debug-path-map`, `debug-isolation`, `tui-launch`, `result`, `observation`, or `cleanup`.
An unexpected runner failure prints only a fixed code and class:

```text
RUN-FAILED: bounded failure; stage=<fixed-stage> category=<fixed-category>; raw exception details omitted.
```

The category is the exception type name when it is a plain identifier,
`hresult-0x<8 hex digits>` for COM/external exceptions, or `unclassified-exception`.
Exception messages, stacks, paths, environment content, and host output are not printed.
A stage that is not on the fixed list is reported as `unknown`.

One owner-approved preflight attempt failed after creating the disposable root and before
the version check. Compiler-only reproduction under Windows PowerShell 5.1 showed that the
embedded C# process helper compiled successfully and loaded the expected type. The failing
step was the environment block builder: its local `$home` variable collided with Windows
PowerShell's read-only automatic `$HOME`, raising `VariableNotWritable`
(`SessionStateUnauthorizedAccessException`). The local is now named `$homeDirectory`.
The user-observed cleanup evidence (17 verified targets, no reparse points, disposable
root removed) remains valid. No OpenCode host/TUI process started and no probe result was
produced by that attempt.

A second owner-approved preflight attempt printed the isolated-environment and exact
`2.1.1` version lines, then failed at the debug-paths preflight with
`stage=debug-paths category=ArgumentException`; its verified cleanup removed 28 targets
and the disposable root. The retained child stdout is gone. The runner had required
`opencode debug paths` output to be JSON, but the verified 2.0.22 CLI source writes a
plain-text table (`name` padded to ten characters, one space, absolute path). Feeding that
table to the old parser raises `System.ArgumentException` from `ConvertFrom-Json`, which
matches the observed category exactly. Whether the installed 2.1.1 stdout used that table
or another non-JSON shape cannot be re-examined without the deleted bytes. The parser now
accepts the exact table and one exact JSON object, and rejects arrays, warnings, mixed
text, duplicate table keys, missing/unknown keys, non-string values, and quoted table
values with fixed codes. All ten root-bound checks are unchanged.

Run the focused host-free checks with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\sync-anchor\run-sync-anchor-probe.test.ps1
```

The checks run no actual probe, start no OpenCode process, and create only a
`sync-anchor-helper-check-<guid>` folder under the approved temp base for the one
compiler-only Windows PowerShell 5.1 child; that folder is removed after a verified path
and reparse-point check.

## Opt-in combined restart readback

`-CombinedRestartProbe` is off by default, so the existing single-phase run is unchanged.
When enabled, one invocation runs the normal import/cache/route phase, opens the manual
observation window (focus and draft only; never submit), then stops the phase-1 job and
verifies zero active processes before starting anything else. Only after that verification
does it relaunch the same isolated root in `SP_PROBE_PHASE=inspect`.

Phase 2 is read-only: it reads one bounded manifest of synthetic session/message IDs and
fixed counts, checks the public sessions/messages/cache/route by exact IDs, and writes a
separate `PROBE-INSPECT-JSON` result with `phase:"inspect"` and zero imports. It does not
import, update, delete, replay history, submit a message, or call a model. The root is
removed only after both jobs are verified stopped; no root is retained across invocations
and there is no `-KeepRoot` option. A phase-1 stop failure blocks phase 2 and deletion; a
phase-2 stop failure blocks deletion.

This proves a clean stop/relaunch readback only. It does not close crash-mid-import restart
ambiguity, ordinary continuation, permissions/forms, concurrency, same-ID update, or
history-merge/new-tail evidence.

## Probe and observable result

The plugin checks `os.homedir()`, `os.tmpdir()`, the process working directory, the
TUI's location, and all configured profile/config/temp roots against the disposable
root before its first `context.client` access. It then feature-detects the public client
methods and makes exactly three public `session.import` calls, with no retry:

1. One parentless root with two settled synthetic text messages.
2. Two physical child snapshots with the same two message bodies/timestamps and fresh,
   globally distinct synthetic session/message IDs. Both children name the root as
   `parentID`.

The probe checks public `session.get`, `session.list`, and `message.list` readbacks. It
requires the root to remain unchanged after each child import, the isolated project's
public list to retain exactly one parentless root throughout and both children, and all
messages to remain settled. Each child snapshot is also checked against the anchor's
synthetic message bodies/timestamps while its IDs differ. It refreshes
the selected head with `context.data.session.sync(headID)` and
`context.data.session.message.sync(headID)`, then reads the public TUI cache and requires
its ordered message IDs to match the imported root/head IDs as well as the settled-message
checks. This binds the cache observation to the expected synthetic session snapshot.

It refreshes and verifies the root's two-message cache, then routes to the root as the
initial head. After both children are imported, it
programmatically selects the root via `ui.router.navigate`; a Solid app-slot effect
observes the public current route and redirects it to the latest child. If native tabs
are enabled, it moves to Home, then opens/focuses the root tab and checks the same route result; when tabs
are disabled the report says `skipped-disabled`, never `passed`. More than ten redirects
inside 500 ms trips a permanent fail-closed guard. The public route and cached messages
are the only render-readiness proxies: `composerObserved` is always false and
`ordinaryContinuation` is always `not-tested`.

This does **not** inspect a private native picker, prove what pixels were rendered, or
establish ordinary continuation permissions/forms/provider behavior. The runner leaves
the TUI visible for the bounded inspection window so a later approved human observer
can inspect the native session view without submitting a prompt. No prompt, model,
agent, tool, command, historical replay, private component, or direct database call is
made. The plugin does not use persistent plugin storage; its in-memory map contains only
synthetic IDs. The result file contains fixed probe name, stage/failure codes, bounded
counts, and booleans only; it excludes IDs, message content, paths, exceptions, and
credentials.

## Isolation and cleanup

An approved `-RunProbe` uses only a fresh
`C:\Users\PC\AppData\Local\Temp\opencode\sync-anchor-<guid>` root (native mode uses the
same base with `native-replacement-<guid>`). The runner refuses
missing/reparse-point ancestors, stages only this plugin and its pure guard (native mode
stages only the fixed allowlist above), and uses
an environment allowlist with isolated HOME/XDG/OpenCode roots. Provider-credential
environment variables and inherited OpenCode service/config overrides are not passed
to children. The documented inline CLI config sets only `debug.devtools`, `debug.timing`,
and `debug.turn_tokens` to false. No auto-update, network, model, or logging-disable
flags are guessed; possible host update/network behavior is not ruled out. No provider
login/config is staged and the probe never calls a model.

The native process helper is compiled only after the disposable root exists; the runner
temporarily redirects its own `TEMP`/`TMP`/`TMPDIR` to that root's `tmp` folder during
helper compilation, then restores the caller's values.

The runner checks `opencode --version` and requires the parsed version to equal the
explicit `-ExpectedVersion` exactly (`2.0.22` or `2.1.1`), then runs `opencode debug paths`
inside the sandbox and requires all ten paths (`home,data,cache,config,state,tmp,bin,
log,repos,db`) to resolve beneath it before starting the TUI as
`opencode --standalone <project>`. The debug-paths parser accepts exactly two shapes after
ANSI removal: the verified 2.0.22 plain-text table (each key padded to ten characters,
one space, absolute path) or one exact JSON object with all ten string values. It requires
all ten keys, rejects extra/duplicate/missing keys and non-string values, and never strips
a path prefix to make it pass. Preflight stdout is drained into a 64 KiB in-memory
cap; overflow fails closed. TUI output is attached to the current console so the native
view can be inspected; the runner does not capture it or write it to files. The host may
write its own ordinary logs under the disposable root; the runner never reads or copies
them.

Every child is created suspended, assigned to a newly created Windows Job Object, and
only then resumed. The job is configured to stop its members on handle close, and child
stdio inheritance is restricted to explicit handles. Cleanup terminates and verifies
zero active processes in the owned job before enumerating the disposable root's deletion
set. It refuses recursive removal if the process stop, physical-path check, target-set
check, or reparse-point check is uncertain; it retains the root and exits `3` instead.
Do not inspect a retained root's host-managed logs; report retention to the parent.

Exit codes: `0` static preflight passed or approved run passed and cleaned; `1` runner
precondition failed before TUI launch; `2` bounded launch/probe failure with cleanup
verified; `3` cleanup not verified (root retained); `6` a sanitized probe result was
produced but did not pass.

## Evidence limits

Public OpenCode 2.0.22 declarations/source informed this prototype. They are not runtime
evidence for the installed binary. The explicit 2.1.1 trial runs the same pinned
2.0.22-shaped public plugin/SDK code against the 2.1.1 runtime; it does not establish
that 2.0.22 source analysis applies to 2.1.1 or broaden any compatibility claim. No
OpenCode host/TUI run of this probe has been performed for either expected version; two
preflight attempts failed before the host started, both with verified cleanup, and neither
produced a probe result. No plugin-loader, import, route, tab, cache, display, cleanup,
compatibility, or continuation result is claimed for it. A later approved single run is
one machine/version only and does not establish product behavior or support. Session IDs
and message bodies are synthetic; the host's normal TUI route/render behavior and cache
are the subject of the probe, not customized UI.

## Current manual PASS (2026-10-21)

This supplements, and does not rewrite, the two failed preflight attempts recorded above.
An owner-observed manual 2.1.1 run reached `stage=complete` with `ok=true`, three of three
imports returned, one preserved root and two settled children, a refreshed two-message
cache, three redirects to the head, `tabs.result=passed`, and
`renderReadiness.nativeSessionRouteObserved=true` / `messageCacheReady=true`. The owner
console reported verified stop, 48 cleanup targets inside the root with no reparse points,
and root removal. No OS exit code was pasted, so none is claimed.

The run remains a bounded technical candidate: `composerObserved=false`,
`ordinaryContinuation=not-tested`, no same-native-ID/HOST-01 claim, and no full M1/M3
acceptance. The synthetic messages are two common text bodies, not new tails. After the
forced TUI stop the terminal showed SGR/mouse coordinate sequences and the native bottom
Subagents pane; terminal mode restoration and that roughness are unverified and outside
the PASS. The earlier "no host/TUI run" limit applied to the failed preflights and is
superseded only for this manual run. See the
[manual PASS record](../../../docs/evidence/m1-sync-anchor-probe-20261021.md).
