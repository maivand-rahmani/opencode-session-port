# M1 sync-anchor manual host prototype PASS — 2026-10-21

Status: **OWNER-OBSERVED MANUAL PASS — BOUNDED TECHNICAL CANDIDATE ONLY**

Validation owner: parent. Evidence source: owner-provided screenshot and console report of a
single manual `-RunProbe -ExpectedVersion 2.1.1` run. No agent executed the host probe for
this record, no raw JSON artifact is retained, and no raw screenshot, terminal byte stream,
transcript ID, message content, or private path is copied here. Earlier failed preflight
attempts are preserved below as harness history, not product sync failures.

## 1. Result observed by the owner

The screenshot showed the runner's sanitized `PROBE-RESULT-JSON` line with these fixed
fields:

```text
probe=sessionport-sync-anchor-public-route-cache
ok=true
stage=complete
failure=null
imports.attempted=3 imports.returned=3
anchor.originalPreserved=true messageCount=2 rootCount=1
anchor.initialRouteObserved=true initialCacheReady=true initialCacheMessageCount=2
children.count=2 retained=true messagesSettled=true
cache.refreshed=true messageCount=2
route.redirects=3 rootSelectionReachedHead=true tabFocusReachedHead=true
tabs.enabled=true tabs.result=passed
renderReadiness.nativeSessionRouteObserved=true messageCacheReady=true
renderReadiness.composerObserved=false ordinaryContinuation=not-tested
expectedVersion=2.1.1
```

The owner console reported `stop: verified=True`, `cleanup-targets: verified=48 within
disposable root; no reparse points`, and that the disposable root was removed. No OS
process exit code was pasted, so no exit-code observation is claimed.

## 2. Cleanup and terminal boundary

- Process stop was verified before deletion; the target set was bounded to the disposable
  root with no reparse points; the root was removed.
- After the forced TUI stop, the owner terminal showed SGR/mouse coordinate sequences and
  the native bottom Subagents pane. The parent advised closing the test PowerShell tab or
  opening a new tab.
- Terminal mode restoration and that terminal roughness are **unverified** and are not part
  of this PASS. The record does not reproduce the raw terminal sequences.
- `composerObserved=false` and `ordinaryContinuation=not-tested` remain explicit result
  facts; they are not inferred from the terminal state.

## 3. What this run establishes

- A fresh isolated 2.1.1 runtime accepted one synthetic root and two synthetic child
  snapshots through the public import surface: three attempts returned three imports.
- The original anchor was preserved; the isolated project reported one root and two
  children with settled messages; the cache refreshed with two messages.
- The native session route selected the head after three redirects; root selection and tab
  focus both reached the head; native tabs were enabled and passed.
- The public native-session route and public message cache were observed, with
  `messageCacheReady=true`.

This is bounded evidence for an **anchored logical conversation with new hidden child IDs**
through the public import/navigation/cache path. It is a technical candidate, not full M1 or
M3 acceptance.

## 4. What this run does not establish

- It does not prove the same native session ID: this was a normal 2.1.1 run with a new
  root. No same-ID overwrite, CAS, new-scope acceptance, or HOST-01 same-native-ID row is
  passed automatically.
- It does not prove actual physical picker pixels or full TUI acceptance. It uses the public
  route/cache as render-readiness proxies: `composerObserved` is false and
  `ordinaryContinuation` is `not-tested`.
- It does not prove history merge or new message tails. The synthetic source messages are
  two common text bodies, not newly appended tails.
- Cross-device sync, cloud apply, conflict handling, crash/restart recovery, full vault
  behavior, OAuth, and model calls were not tested.
- The active actual sync feature is **not implemented**; this is a probe-only prototype.
- Terminal mode restoration, UI roughness, and the native bottom pane observed after forced
  stop are outside the PASS claim.

## 5. Previous failed preflight attempts — retained

Both earlier owner-run attempts failed before the TUI and are harness history only:

1. **FAIL 1 — `build-env`:** the environment builder's local `$home` collided with Windows
   PowerShell's read-only automatic `$HOME`; cleanup verified 17 targets and removed the
   root.
2. **FAIL 2 — debug paths:** the parser expected JSON but the verified 2.0.22 CLI emits a
   plain-text path table; cleanup verified 28 targets and removed the root.

Neither was a product sync failure. The current PASS shows the corrected preflight reached
the TUI and completed the probe.

## 6. Source baseline and validation reuse

- Source baseline: cloned `anomalyco/opencode` v2.0.22 at commit
  `527f0b931d1f9b3ebd34e106c51b31ce5db5b075` (read-only inspection).
- Runtime binary under test: installed OpenCode 2.1.1. The 2.0.22 source analysis is not a
  claim about 2.1.1 internals.
- Focused host-free PowerShell checks: 73/73 passing, including the verified path-table
  fixture, fixed failure diagnostics, environment isolation, and compiler-only helper
  validation.
- Focused route proof: 7/7 tests passing with 21 expectations.
- No source or test changes were required for this record; this document is evidence only.

Files:

- [Probe runner and manual procedure](../../scripts/host-probes/sync-anchor/README.md)
- [Runner](../../scripts/host-probes/sync-anchor/run-sync-anchor-probe.ps1)
- [Focused host-free tests](../../scripts/host-probes/sync-anchor/run-sync-anchor-probe.test.ps1)
- [Route guard tests](../../scripts/host-probes/sync-anchor/route-guard.test.ts)
- [TUI plugin](../../scripts/host-probes/sync-anchor/sync-anchor.tui.tsx)

## 7. Next evidence step

The next step is a fresh approved run that exercises ordinary composer, permission, and form
interaction in the native session view. That is required before any claim about ordinary
continuation. No rerun is requested or authorized by this record, and this PASS does not mark
HOST-01 or the full M1/M3 gate complete.
