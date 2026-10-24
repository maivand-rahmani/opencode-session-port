# M1 native-replacement API result — 2026-10-24

## Later owner-observed native TUI check (OpenCode 2.1.1)

### Subsequent local archive/picker check

The owner supplied the archive-mode result: `ok:true`, `archiveCall:accepted`,
`archiveReadback:archived`, `recoveryReadback:active`, `recoveryVerified:true`,
and `mutationTargetOldOnly:true`. The receipt reported exit `0`, safe result,
verified stop, verified cleanup, and final success; 45 cleanup targets were
verified within the disposable root, without reparse points, and the root was removed.

The owner separately confirmed that the old root remained visible in the
ordinary session picker from the first seconds of the observation window.
Thus local 2.1.1 API archive/recovery **passed**, while the tested native picker
hiding behavior **failed**. The plugin's `pickerNotTested:true` is unchanged:
the picker result is manual evidence, not an automated plugin assertion.
No claim is made about other versions or picker modes. HOST-01 remains open.

The owner ran the isolated native-replacement TUI wrapper. After a first
preflight isolation failure (zero imports), the corrected run visibly opened
the parentless candidate with all three synthetic messages, including the
distinct tail, and the stock composer. The owner explicitly confirmed typing
an unsent draft in that imported session; no submission was requested or reported.

This establishes native history rendering and manual composer editability on
the owner's 2.1.1 host. It supersedes the earlier unobserved labels only for
those two checks. It does not establish model continuation, picker/archive
visibility, draft retention across replacement, permissions/forms, concurrency,
or full HOST-01 acceptance. The import-only run's final runner/cleanup result
was not supplied; the later archive run's verified receipt is recorded above.
The 2.1.3 API evidence below remains a separate run.

## Status

**Bounded API probe passed on an isolated, private OpenCode 2.1.3 runtime. M1 / HOST-01
remains OPEN.** The run exited `0`, reported `status: "ok"`, `outcome: "api-verified"`, and a
verified six-step post-restart snapshot. The archive/unarchive API claims are now observed
against real 2.1.3, not inferred from the 2.0.22 source clone.

This record does **not** complete M1, HOST-01, or any native-UI gate. Native picker, route,
composer, permissions/forms, ordinary continuation, terminal restore, CAS/quiescence, and
cross-version behavior remain unproven. No M2 or M3 status is changed or claimed here, and no
authentication-UI state is assessed.

The prior design/offline record remains [M1 native replacement plan and evidence](m1-native-replacement-plan-20261024.md)
(32 focused tests, no host run). This record adds the executed result; the plan's failure-case
design and native-UI non-claims remain applicable, while its “no host launched” status is
historical for the pre-run snapshot.

## What the bounded run proved

The run used only two fresh synthetic roots in a fresh disposable profile. It did not touch a
real profile, live host history, a production/main database, or any non-isolated service.

- Old-root import: response ID frozen, candidate lookup explicitly absent, candidate imported
  parentless with a new history.
- History identity: old root `2` messages; candidate `3` messages with a distinct synthetic
  tail; ordered IDs and exact content matched; `distinctTail: true`, `exactIDs: true`.
- Archive: request accepted, canonical numeric `time.archived` observed, readback verified.
- Archived-list API: old root excluded from the active list and present in the archived list
  while archived; `listFiltering: "observed"`.
- Unarchive: canonical active readback verified.
- Final state: **both roots active**, active-list count `2`, archived-list count `0`.
- Retention: both histories still exact; `oldContentRetained: "verified"`,
  `candidateRetained: "verified"`. The probe surface has no delete method,
  `historyDeleteCalls: 0`, and no public delete was used.
- Post-restart snapshot: `snapshotStatus: "verified"` with all six steps `ok` —
  `old-info`, `new-info`, `old-messages` (`2`), `new-messages` (`3`), `active-list` (`2`),
  `archived-list` (`0`). Restart validation requires both roots to report the pinned canonical
  `projectID`, plus parentless state, exact histories, and archive state; the snapshot likewise
  requires the active/archived list placement and counts. The snapshot output reports
  presence/count booleans, not project-ID values.

**Do not overread the archive/list observation.** The API list check proves the archived query
filtered these two synthetic sessions at that moment. It does **not** prove that the native
picker shows exactly one visible root, that a tab/route hides the archived root, or that any UI
filter is correct. After unarchive, both roots are active. Native UI was `not-observed`.

## Canonical project and timestamp normalization

The host owns project metadata and may replace the synthetic import `projectID`. The observed
host behavior forced a contract correction:

- The old import response and the first old-root readback are now required to carry the same
  canonical public `projectID`, matching `^[A-Za-z0-9._:-]{1,128}$`.
- Missing, oversized, invalid, or response/readback-mismatched IDs fail closed with
  `E_PROJECT_ID` before any candidate import. There is no fallback to the synthetic payload
  project ID.
- The candidate import payload uses the pinned canonical ID, and the restart snapshot requires
  both old and candidate roots to keep it.
- Message identity, order, roles, text/content, directory, parentless state, and archive
  predicates are unchanged.

The host also normalizes import timestamps. Observed on the pinned 2.1.3 diagnostic image
`sha256:052f9f37c34362e6d5783691b9ce2cd5a0a57dc3de3f73d76e4777e9e3c85461`:

- `created` is preserved exactly from the import payload.
- `updated` is replaced by the server's import timestamp. It was measured `11 ms` after the
  pre-import `Date.now()` and `8 ms` before the post-import `Date.now()` (same-container clock,
  `19 ms` import window).
- `idle` remains the payload value; the import response `time.updated` equals the first GET.

The earlier strict round-trip assumption (requiring readback `created`/`updated` to equal the
submitted payload) failed with `E_OLD_TIME`. The corrected predicate requires `created` exact
and `updated` finite inside the measured import start/end window; it rejects the payload
`updated` value, out-of-window values, missing values, and non-finite values. No fixed
millisecond allowance is used.

## Provenance and execution isolation

All artifact links in this section and in “Failure history” point at **local ignored
`.package-verify-work/` working evidence; they are not part of the published/archive
repository.** Source paths under `scripts/host-probes/native-replacement/` and the linked plan
document were local working files at this date; this lane performed no Git action, so their
tracking/publication is a separate decision. The durable write from this lane is this result
document.

| Item | Recorded value |
| --- | --- |
| Result record | [`m1-host-project-fix-result-20261024.json`](../../.package-verify-work/m1-host-project-fix-20261024/m1-host-project-fix-result-20261024.json), `7715` bytes, SHA-256 `c6202fb1c29ba7a85ca019916b82370828f9541639565da605b75a82d5d2a99d` |
| Probe result payload | [`remote-result.json`](../../.package-verify-work/m1-host-project-fix-20261024/remote-result.json), `1707` bytes, SHA-256 `1fd335808b3a54459a8d38dcf384fa555dd67e91f9d7b3749dca024546761c4b` |
| Remote evidence | [`remote-evidence.txt`](../../.package-verify-work/m1-host-project-fix-20261024/remote-evidence.txt), `1320` bytes, SHA-256 `7430c4f383a8f22a71c3dd7ffa8bb7b3bf99ee299fc16062a4de20a739862114` |
| Image | Existing image `sha256:118cc62ff6c1b24a9a48a87a5d56f1c8da23df1c791620e81d6ddffb8ef31192`; no rebuild (`npmRebuild: false`) |
| Bundle | [`probe-entry.mjs`](../../.package-verify-work/m1-host-project-fix-20261024/probe-entry.mjs), `79915` bytes, SHA-256 `d743b125ee74e98148ec7fa0b9c367b7fd512758ea441407226c0094e7458156`; readback match verified |
| Build method | Existing image plus exactly one read-only code bind: `probe-entry.mjs` → `/opt/sessionport/probe-entry.mjs`. No image rebuild and no second mount |
| Container | Name `sessionport-m1-host-project-fix-20261024-01`, ID `7cd0009ff60ab0538e7c93b3c4359ae20fcaf1cdebedd7d6c0e92a8798148829`, retained |
| Isolation | `network:none`, read-only rootfs, `cap-drop ALL`, `no-new-privileges`, pids `256`, memory `1073741824`, user `1000:1000`, no ports, no env injection, `--rm` false |
| Result | exit `0`, `1` second, no timeout, stderr `0` bytes, `status: "ok"`, `outcome: "api-verified"` |
| Cleanup | Fresh profile `profile-removed`; owned container retained; no host profile or live session touched |
| Safety counters | `promptToolModelCalls: 0`, `historyDeleteCalls: 0`, `containersDeleted: 0`, `retries: 0`, `probeRuns: 1`, `realProfilesTouched: false`, `liveHostSessionsTouched: false`, `databaseConnections: 0`, `gitCommands: 0` |

Source hashes for the delivered local modules:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `state-machine.ts` | `34141` | `6fa8c61ef04be072de5c3d9f24f2a21636d15963ebe5254995d2fc49e0dd8e4f` |
| `lifecycle/entry.ts` | `19352` | `e2901d2ad76d6b00e94da7053375891c8a6d903a72925c760963dd2477d965be` |
| `lifecycle/entry.test.ts` | `27250` | `ee473624dd2674709166582d1ea39f429bdad50d7c443577ffaffb796a0e9bfc` |
| `native-replacement.test.ts` | `38741` | `596028c91e3e57cc6241de8c994e0b4220ed418b06069108ec3716b64d13f25b` |
| `lifecycle/README.md` | `11415` | `8012edeec7740df54df4f18a2684e68430e9f1cce2f859bf00146364040258fd` |
| `fixtures.ts` | `9943` | `5935da1be5b8870ccdb266f49d6aeaee49dea953f2653b4a22cf7aed345a632d` (unchanged) |

## Focused tests and runtime checks are separate

Recorded, not rerun in this docs lane: **`79` focused tests total** — root `33` pass,
lifecycle entry `23` pass, lifecycle `23` pass; all exit `0`, `0` fail. Bundle Node ESM syntax
check: `0` errors. The six post-restart snapshot steps and the eleven probe phases are
**runtime checks**, not test counts; do not add them to `79`.

The new coverage recorded for the project/timestamp corrections is:

- consistent host project rewrite accepted and candidate payload uses the canonical ID;
- import-response vs first-GET project mismatch blocked before candidate work;
- missing/oversized/invalid project ID blocked before candidate work;
- candidate under another project blocked before archive;
- restart project drift rejected;
- timestamp window, ascending query, blocker sanitizer, first-failure, and stop fail-closed
  retained.

## Restore audit

[`test-restore-audit-20261024.json`](../../.package-verify-work/m1-host-project-fix-20261024/test-restore-audit-20261024.json)
(`SHA-256 95a115a3fe59e260ee49ff63fb3810be04c2f74b4e68139f4825262dceb9679f`) records:

- snapshot tests `32`, current tests `33`, `missingFromCurrent: []`;
- `snapshotHash` = reverted-current hash =
  `30d417265407b562673a7d3ac876695fc77c7c0297459f0dc746cdfd2dc75cff`, so the prior 32 cases
  were preserved exactly;
- one added test: “reports the exact failing predicate subcheck without content”;
- method: earlier local OpenCode snapshot artifact plus test-name comparison only; **no internal
  database read**. This is a known-scope audit, not a claim about the host database or a Git
  history rewrite.

## Failure history preserved

Earlier failures are retained, not erased or relabeled as passes. Each row links its local
ignored result artifact and records its SHA-256.

| Stage | Recorded status | Result artifact (local ignored) | SHA-256 |
| --- | --- | --- | --- |
| Baseline diagnostic | Diagnostic complete; sole failing predicate was `projectIDMatch`; contract fix proposed, not applied | [`m1-baseline-diagnostic-result-20261024.json`](../../.package-verify-work/m1-baseline-diagnostic-20261024/m1-baseline-diagnostic-result-20261024.json) | `0bbceb4dca3292e21ca5d4e1c458d3c4104c6d0f539828a2b2d7046d10614eec` |
| Child-startup diagnostic | Root cause confirmed: `E_CHILD_WRAPPER_POSTINSTALL_PLACEHOLDER` (229-byte non-ELF placeholder; package postinstall skipped) | [`m1-child-startup-diagnostic-result-20261024.json`](../../.package-verify-work/m1-child-startup-diagnostic-20261024/m1-child-startup-diagnostic-result-20261024.json) | `7e919db1220ac4408714408fce77b4ed0c0785b7ac133e724d640d186fecaedf` |
| Real-binary diagnostic | Assertion failure isolated to Dockerfile exact version stdout equality; real platform binary ran and exited `0` | [`m1-real-binary-diagnostic-result-20261024.json`](../../.package-verify-work/m1-real-binary-diagnostic-20261024/m1-real-binary-diagnostic-result-20261024.json) | `b33d55efd281a73c77969b66e52f515b5e6689f3430a8cab3861ca0e065aa446` |
| Binary entrypoint fix | Build failed closed: `E_BUILD_ENTRYPOINT_VALIDATION` at Dockerfile line 29; no retry | [`m1-binary-entrypoint-fix-result-20261024.json`](../../.package-verify-work/m1-binary-entrypoint-fix-20261024/m1-binary-entrypoint-fix-result-20261024.json) | `0b09cc5c91ba7ac73b4954e97bea4a77d1891092bb8d5684e22fb3d348cb85a4` |
| Isolated execution | `RUN_EXIT_1` after `0.178 s`, empty stdout, stderr withheld; probable unconfirmed `0600` bundle EACCES | [`m1-isolated-native-replacement-result-20261024.json`](../../.package-verify-work/m1-isolated-execution-20261024/m1-isolated-native-replacement-result-20261024.json) | `a0ab331cfc59d178f81bfa5b58e672a7de3f5d97f35d8226b922dd2bd235d22d` |
| Readability retry | Permission fix readback passed, then `E_CHILD_EXIT`; child exited before readiness; no logs retrieved | [`m1-isolated-native-replacement-readability-retry-result-20261024.json`](../../.package-verify-work/m1-isolated-execution-20261024/m1-isolated-native-replacement-readability-retry-result-20261024.json) | `b019e82176a8dcd01c90167bb4a4bfd0b712c4ac21b0b44ead1dee540ad57167` |
| Version-gate fix | Failed at replacement probe: `E_OLD_TIME` in old import/readback timestamp round-trip | [`m1-version-gate-fix-result-20261024.json`](../../.package-verify-work/m1-version-gate-fix-20261024/m1-version-gate-fix-result-20261024.json) | `73d695a9030bc25549d6dd993eba48cb3024296a5b82067d0d0586775d4b7d07` |
| Import-time diagnostic | Confirmed `created` preserved / `updated` server-stamped; local timestamp predicate fix applied | [`m1-import-time-diagnostic-result-20261024.json`](../../.package-verify-work/m1-import-time-diagnostic-20261024/m1-import-time-diagnostic-result-20261024.json) | `10fcdac2f7d565aeb63ace13c9074991baecd63de157b92d8c377c14ac615b1e` |
| Timestamp-corrected execution | Failed at replacement snapshot: `E_SNAPSHOT` after old-root import/readback; no retry | [`m1-timestamp-corrected-execution-result-20261024.json`](../../.package-verify-work/m1-timestamp-corrected-execution-20261024/m1-timestamp-corrected-execution-result-20261024.json) | `1a9a7e0bb950f8df7e17ea6b4ba8fd2010ee137709924a1bfb30063d8b9b7723` |
| Stage-evidence fix | Instrumented run failed closed; probe blocked before baseline, snapshot skipped, stop/profile cleanup verified | [`m1-stage-evidence-fix-result-20261024.json`](../../.package-verify-work/m1-stage-evidence-fix-20261024/m1-stage-evidence-fix-result-20261024.json) | `b61830f20edfe8072a58a62366e0c6891bb0ca894bed112e118c13878df3068c` |
| Host-project fix (this run) | Passed; `api-verified`; six-step restart snapshot verified | [`m1-host-project-fix-result-20261024.json`](../../.package-verify-work/m1-host-project-fix-20261024/m1-host-project-fix-result-20261024.json) | `c6202fb1c29ba7a85ca019916b82370828f9541639565da605b75a82d5d2a99d` |

Also preserved: the earlier hidden-child routing attempt was rejected for normal conversation
continuation because the owner observed no native prompt. It is not re-attempted or converted
into evidence for this API result.

## Boundaries and non-claims

- **No CAS claim.** `casClaim: false`; the archive/unarchive observations apply only to the two
  fresh synthetic fixtures. No concurrent-edit safety, atomic replacement, or quiescence
  guarantee is proved. Late-edit detection remains a manual-quiescence residual.
- **No native UI claim.** `nativeUi: "not-observed"`; picker, tab/route, composer, permissions
  forms, and ordinary continuation are `not-tested`.
- **No terminal-restore claim.** A forced owned stop was used. Ctrl+C/graceful restore, crash
  mid-import, and SIGKILL fallback are not tested. The probe-level `restartReadback` field
  remains `not-tested`; the verified restart evidence is the lifecycle second-serve snapshot,
  not a crash or terminal-restore proof.
- **No production/main-history claim.** Only an isolated private 2.1.3 probe container with
  `network:none`, a fresh synthetic profile, and synthetic roots was used. No real credentials,
  pairing URLs, Authorization values, provider keys, or raw message text are recorded.
- **No M2/M3 claim.** This record is M1 evidence only; it does not change M2/M3 status,
  authentication UI state, or any unrelated gate.
- **No durable public archive claim.** The linked `.package-verify-work/` artifacts and local
  source working files are not published. A durable archive would need a separate reviewed
  copy/sanitization decision.

## Source and runtime version boundary

| Surface | Version / status |
| --- | --- |
| Local read-only source clone | `2.0.22` (`@opencode/plugin` surface); does not expose `archived`; not runtime evidence |
| Actual isolated probe runtime | OpenCode **`2.1.3`** only, existing image `sha256:118cc62f...f31192` |
| Archive OpenAPI contract | Observed on 2.1.3: PATCH `archived` boolean, list query enum `"true"`/`"false"`, canonical `time.created`/`time.updated` + optional numeric `archived` |
| Other 2.1.x / 2.0.x runtimes | Untested; no general version-compatibility claim |

The probe checks the live contract before import and fails closed with `E_CONTRACT` or
`E_UNSUPPORTED` if the shape is missing. Passing on 2.1.3 does not establish 2.1.1, 2.1.2,
other builds, or native UI behavior.

## Remaining HOST-01 acceptance checklist

HOST-01 stays **OPEN** until every applicable item is recorded with an independently reviewed
run and explicit boundaries:

1. **Safety review.** Independent review of the lifecycle runner, probe entry, bundle, adapter,
   and the single read-only bind used here.
2. **Native picker.** Manually observe that the candidate is present and the archived old root
   is not offered as a normal conversation root; do not infer this from API list counts.
3. **Native tab/route.** Observe the archived root's tab/route behavior and any UI filtering;
   the API archived-list result is not UI evidence.
4. **Composer/new message.** Observe native composer availability without submitting a draft,
   calling a model, or writing real history.
5. **Permissions/forms.** Record actual permission/form behavior; currently `not-tested`.
6. **Ordinary continuation.** Demonstrate normal conversation continuation with a visible
   native prompt; the earlier hidden-child routing attempt is rejected and does not satisfy
   this.
7. **Restart/readback.** Retain the verified six-step post-restart snapshot as bounded evidence,
   while separately recording crash-mid-import, graceful terminal restore, and stop semantics.
8. **CAS/quiescence.** Explicitly accept or reject the manual-quiescence residual; no CAS or
   concurrent-edit guarantee exists.
9. **Version matrix.** Decide whether any runtime other than 2.1.3 is in scope; do not infer
   support from this run.
10. **Cleanup authority.** The probe retains both synthetic roots; any host-owned disposable-root
    cleanup requires the reviewed stop/readback lifecycle and explicit authorization.

## Evidence index

- [M1 native replacement plan and evidence](m1-native-replacement-plan-20261024.md) — design,
  offline failure cases, and pre-run boundaries.
- [Host-project fix result](../../.package-verify-work/m1-host-project-fix-20261024/m1-host-project-fix-result-20261024.json)
  — this run's bounded result record (local ignored).
- [Remote probe result](../../.package-verify-work/m1-host-project-fix-20261024/remote-result.json)
  — sanitized `api-verified` payload (local ignored).
- [Remote execution evidence](../../.package-verify-work/m1-host-project-fix-20261024/remote-evidence.txt)
  — isolation, bundle, result, and retained-container facts (local ignored).
- [Restore audit](../../.package-verify-work/m1-host-project-fix-20261024/test-restore-audit-20261024.json)
  — 32 preserved plus one added test (local ignored).
- [Lifecycle README](../../scripts/host-probes/native-replacement/lifecycle/README.md) —
  canonical project binding, timestamp contract, and lifecycle limits (local source working
  file).
- [Probe README](../../scripts/host-probes/native-replacement/README.md) — API probe semantics
  and no-delete surface (local source working file).
- Local continuation state: `.slim/deepwork/sessionport-20261024-state.md` (local only, not
  published evidence).
