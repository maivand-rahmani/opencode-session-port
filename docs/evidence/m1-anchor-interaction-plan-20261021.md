# M1 anchor interaction/restart-readback plan — 2026-10-21

Status: **PREPARATION ONLY — ORACLE NO-GO REMEDIATION, NOT AUTHORIZED, NOT EXECUTED**

Validation owner: parent. Independent safety re-review is required before any host run. This
plan prepares the smallest bounded combined probe after the prior P1 exit-chord recommendation
was rejected as unsafe. It does not authorize a host launch, TUI invocation, model/provider
call, real profile/history access, remote API, DB, network, credential, or vault operation.
It does not mark M1, HOST-01, or any gate complete.

Baseline evidence: [manual prototype PASS](m1-sync-anchor-probe-20261021.md),
[HOST-01 source plan](host-01.md), [ARCHITECTURE.md §8](../V2/ARCHITECTURE.md#8-host-apply-release-gate-host-01),
[ROADMAP.md M1](../V2/ROADMAP.md#m1--architecture-feasibility-and-preparation).

## 1. Exact HOST-01 status after the manual PASS

| HOST-01 row | Evidence now held | Label |
| --- | --- | --- |
| Same-ID import semantics | New synthetic root/child IDs were imported; no existing-ID re-import or differing-content conflict. | UNVERIFIED |
| Failed/partial writes | Three imports returned; no invalid-later-message or partial-state case. | UNVERIFIED |
| Concurrent tool activity | Single probe sequence; no concurrent public-client mutation. | UNVERIFIED |
| Restart ambiguity | One run; root removed. The combined phase-2 readback below is stop/relaunch readback only, not a crash-mid-import case. | UNVERIFIED |
| Reference mapping | Root plus two children read back with `parentID`; no fork, revert, deeper descendant, or collision. | PARTIAL (synthetic parent-child only) |
| Command/argument compatibility | No `/sync` command or raw-argument dispatch. | UNVERIFIED (source only) |
| Event/trigger contract | Route/cache polling only; no change/idle subscription or teardown. | UNVERIFIED (source only) |
| Platform matrix | One Windows 2.1.1 observation; macOS/Linux untested. | PARTIAL (Windows only) |
| Non-replay | No historical tool/model sentinel was present. | UNVERIFIED |
| Consistent collection | One readback/cache sequence; no two full reads, generation check, or quiet-window claim. | UNVERIFIED |

Same-native-ID acceptance, CAS, overwrite, or new-scope behavior remain outside this PASS.
The two common synthetic message bodies are not new tails, so no history-merge claim follows.

## 2. Combined opt-in probe: phase-1 interaction + phase-2 read-only readback

The runner gains `-CombinedRestartProbe` (default off). Default `-RunProbe` behavior is
unchanged. When enabled, one invocation performs both phases in the same disposable 2.1.1
root; the root is never retained across separate invocations and there is no `-KeepRoot`.

### 2.1 Phase 1 — existing import/cache/nav plus owner observation

- Fresh isolated root and environment from the reviewed runner; no inherited credentials,
  real profiles, histories, sessions, config, or plugins.
- Existing plugin imports the synthetic root and two children, verifies the public
  readback/cache, and performs the existing route/tab checks. No new message tail is added.
- During the bounded 45-second observation window the owner may focus the head/composer,
  type a synthetic draft, navigate root/head, and focus tabs. **Never press Enter or submit.**
  No keyboard exit-chord instruction is used; the runner owns the stop.
- After the window, the runner stops the phase-1 TUI, verifies the job has zero active
  processes, and only then may start phase 2. If that stop is uncertain, phase 2 is not
  launched and the root is not deleted.

### 2.2 Phase 2 — same root, read-only public inspection

- Same isolated environment/root; new process/job lifetime. `SP_PROBE_PHASE=inspect` selects
  a separate inspection path before the normal probe hook. The inspection path does not call
  `session.import`, `session.update`, `session.delete`, or any other mutation.
- The phase-1 plugin writes one ephemeral manifest inside the owned root containing only
  synthetic session/message IDs and fixed counts: anchor ID, two child IDs, four child
  message IDs, two anchor message IDs, and expected root/child/message counts. It contains
  no message bodies, credentials, file paths, or persistent SessionPort plaintext dump.
- Phase 2 reads the manifest, requires exact schema/ID length/depth/order/counts, and fails
  closed on missing, extra, duplicate, malformed, or oversized data.
- Read-only public checks: anchor session identity/title/directory, one root, exactly two
  children parented to the anchor, two settled messages per session, exact ordered IDs, then
  cache/route reroute to the head with exact IDs/counts. No import, history replay, message
  submit, or provider/model call.
- Phase 2 stops its own job and verifies zero active processes. The existing strict cleanup
  runs only after both phase stops are verified. A phase-2 stop failure prevents deletion.
- Both result files are sanitized; phase 1 prints `PROBE-RESULT-JSON`, phase 2 prints
  `PROBE-INSPECT-JSON` with `phase:"inspect"`, `imports.attempted=0`, and
  `ordinaryContinuation`/`permissionsForms`/`concurrency` still `not-tested`.

### 2.3 Bounded command (only after parent review and safety GO)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\sync-anchor\run-sync-anchor-probe.ps1 -RunProbe -CombinedRestartProbe -ExpectedVersion 2.1.1 -InspectSeconds 45 -OpenCodePath "<installed-opencode.exe>"
```

The current runner's stop is an owned job-object termination, not a graceful application
shutdown. Terminal restoration is observed only as a separate `terminalRestored` field; SGR/
mouse residue or a fallback stop is `failed`/`unverified`, never PASS.

### 2.4 PASS / FAIL / INCONCLUSIVE

- **PASS (bounded combined probe):** phase 1 completes with the existing import/cache/route
  result; phase 2 reads back the same anchor/two children/two settled messages with exact
  IDs and fixed counts; both owned stops are verified; cleanup removes the root. This proves
  stop/relaunch readback, not crash-mid-import recovery or ordinary continuation.
- **FAIL:** phase 1 result fails; phase 2 manifest/readback/cache/route mismatches; either
  stop is unverified; a non-owned kill is needed; or any mutation/import is attempted in
  phase 2.
- **INCONCLUSIVE:** terminal rendering is ambiguous or the owner cannot observe the window.
  `terminalRestored` stays `unverified`; it is never inferred from a job kill.
- No automatic retry for either result wait; timeout is reported and the owned stop/cleanup
  path runs conservatively.

## 3. What this does not prove

- Phase 2 is a clean stop/relaunch readback, not a crash or termination mid-import. Restart
  ambiguity remains UNVERIFIED.
- It does not prove ordinary composer send, permissions/forms, model continuation, or
  history merge/new tails. The draft is never submitted.
- It does not prove same-native-ID update/CAS, concurrent mutation, failed/partial writes,
  fork/revert reference survival, command/argument parsing, event delivery, non-replay, or
  platform coverage.
- If a visible UI/layout/interaction change would be needed, implementation stops for a
  bounded designer handoff. No such change is proposed here.

## 4. Implementation surface and offline validation

- Runner: opt-in `-CombinedRestartProbe`, phase-1 stop gate before phase 2, phase-2 manifest
  path/size gate, separate `InspectChild` lifetime, `Get-CombinedProbeGate` fail-closed
  decisions, and existing cleanup extended to require both verified stops. No root retention
  across invocations.
- Plugin: explicit `SP_PROBE_PHASE=inspect` branch before the normal probe hook; bounded
  manifest writer in phase 1; read-only inspection using public `session.get/list` and
  `message.list`, then public cache/route checks. No import/mutation in the inspection path.
- Pure helper `phase2.ts`: exact manifest parser and graph validator with fixed error codes.
- Offline tests: PowerShell AST/static + fixture tests for phase gating, stop/delete rules,
  environment phase/manifest, phase-2 result sanitization, default static regressions, and
  root/reparse guard presence; Bun tests for manifest/ID/depth/order/count failures and a
  static assertion that the inspection branch contains no import/mutation calls.
- No actual OpenCode launch is used by these tests.

## 5. Gates before any actual action

1. **Parent review** of the combined-probe diff and tests.
2. **Independent safety re-review (oracle14 required)** of the bounded combined probe,
   including phase-1 stop gate, no root retention, manifest content, and phase-2 no-mutation
   path.
3. **Owner manual action** only after that GO: one bounded combined attempt, no Enter/submit,
   no exit-chord instruction; owner records only fixed observation labels.
4. **Separate gate** for crash-mid-import/restart ambiguity, permissions/forms or synthetic
   transport, concurrency, same-ID, partial-write, reference-map, command/event, non-replay,
   and platform expansion.
5. **PREP-01 remains open:** the owner's review of the nine `docs/V2/` documents is still
   unrecorded; this plan does not imply package approval.

## 6. Current validation reuse

- Prior host-free PowerShell suite: 73/73 passing.
- Prior route proof: 7/7 tests, 21 expectations.
- Remediation adds host-free checks: the expanded PowerShell suite is 94/94 passing;
  phase2/observation Bun tests are 17/17 passing with 54 expectations; route proof remains
  7/7 and 21 expectations. No duplicate host run, model/provider call, or new host evidence
  is claimed.
