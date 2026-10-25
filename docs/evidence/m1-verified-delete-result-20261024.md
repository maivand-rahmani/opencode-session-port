# M1 verified-delete bounded r2 result — 2026-10-24

## Status

**Bounded synthetic API probe passed. M1 / HOST-01 remains OPEN.** The corrected r2 run
exited `0` with `status: "ok"`, `outcome: "api-verified"`, and `phase: "complete"`. It
deleted exactly one frozen old synthetic root only after verification, retained the
candidate, and verified the read-only post-restart snapshot. This is bounded M1 feasibility
evidence for the root-replacement path, **not** a general production data-safety claim, a
HOST-01 pass, or whole-M1 completion.

The run was executed under the conditions in the
[M1 verified-delete decision record](m1-verified-delete-decision-20261024.md). This result
record adds the dated runtime outcome; it does not change the decision's authorized scope,
retention parameters, gates, or non-claims.

## Recorded provenance

All `NEW.*` artifact paths below are literal local working paths. `NEW.package-verify-work/`
is untracked, non-published local evidence, not part of the published repository evidence
set. No artifact was moved, deleted, or re-created for this record at capture time. A later
2026-10-24 cleanup relocated `NEW.package-verify-work/` to
`.package-verify-work/root-spill-20261024/NEW.package-verify-work/`; the links below target
the relocated paths, and `.package-verify-work/root-spill-20261024/MOVE-MANIFEST.json` maps
every original recorded path to its current path.

| Item | Recorded value |
| --- | --- |
| Authorization | Owner-authorized conditional synthetic delete; one bounded run; no `--rm` |
| Remote run | Session `ses_e909fde83ffeUzzGCevB32ERbd`, directory `/home/deploy/server`, queued prompt, assistant finish `stop` |
| Result audit | [`result-audit.json`](../../.package-verify-work/root-spill-20261024/NEW.package-verify-work/m1-verified-delete-execution-20261024/r2/result-audit.json), `7293` bytes, SHA-256 `8f599bca272b2b73cc6fb0c4b26380edb714ee704fd2c751454d5eba781df1a6` |
| Parent result | Remote `/home/deploy/sessionport-validation/20261024-m1-verified-delete-r2/parent-result.json`, `1578` bytes, SHA-256 `804b18bb13adced5152d125c6570cfcfd208292d64af1ef53c4e5dbb1c84395c`; sanitized JSON is embedded in the result audit |
| Bundle | [`live-entry.bundle.mjs`](../../.package-verify-work/root-spill-20261024/NEW.package-verify-work/m1-inventory-paging-fix-20261024/r2/live-entry.bundle.mjs), `794138` bytes, SHA-256 `c5e3dad0b6c7f18e612c5383ed03fde44a85a64a013deed9e0603155d34eb70b`; regular file, not a symlink |
| Remote bundle stage | `/home/deploy/sessionport-validation/20261024-m1-verified-delete-r2/live-entry.bundle.mjs`, `deploy:deploy`, mode `0444`, `794138` bytes, matching SHA-256; upload exit `0`; readback HTTP `200` with matching bytes/hash |
| Image | Existing image `sha256:118cc62ff6c1b24a9a48a87a5d56f1c8da23df1c791620e81d6ddffb8ef31192`; `linux` / `amd64`; source version `2.1.3` from the existing pinned image; not re-derived from parent JSON; no build or install |
| Preflight container | `ab69c5e29cc9c776f92d643c4525a2149d195067bf2d43d312bb1025780da9a0`; `node --check` exit `0`; `network: none`; user `1000:1000`; `--rm` false; retained |
| Execution container | `a9ee60fb1cfda166e28fc136ef518497bb40d515b3715dbbda0ae84fb9b428f8`; retained |
| Isolation | `exit 0`, `2` seconds, no timeout; `network: none`; read-only rootfs; `cap-drop ALL`; `no-new-privileges`; user `1000:1000`; pids `256`; memory `1g`; no ports; no environment; one read-only bundle bind |
| Cleanup | Fresh disposable profile `profile-removed`; candidate retained; both r2 containers and stage artifacts preserved |

The parent-result bytes were checked by extracting the audit's embedded sanitized
`parentResult.json`, serializing that object as compact JSON plus a trailing LF, and comparing
the result: exactly `1578` bytes and SHA-256 `804b18bb...c84395c`. This verifies the audit's
embedded copy is byte-consistent with the recorded remote artifact. The raw remote file was
not independently downloaded in this docs lane.

## Verified outcome

- Probe phases completed, in order: `old-verified`, `candidate-absent`, `imported`,
  `candidate-verified`, `predelete-verified`, `delete-requested`, `delete-readback`,
  `recovered`, `complete` — all `9/9`.
- Probe checks passed: `oldBaseline`, `recoveryBeforeImport`, `candidateAbsent`,
  `candidateReadback`, `recoveryBeforeDelete`, `oldUnchanged`, `inventory`, and
  `recoveryAfterDelete` report `verified`; `import` reports `created`. The audit's
  `allProbeChecksVerified` value is `true`.
- Counts: old root `2` messages; candidate `3` messages; inventory `2` sessions / `5`
  messages before delete; `removeCalls: 1`.
- Delete: requested `true`; state `deleted`; remove outcome `resolved`; exactly one DELETE,
  frozen old target only; candidate DELETE calls `0`; blind retries `0`.
- Retention during the probe: old root not retained (`false`); candidate retained (`true`).
- Post-restart snapshot: `status: "verified"`; steps `old-absent`, `candidate-verify`
  (`count: 3`), `inventory` (`sessions: 1`), `recovery-verify`, and `recovery-payload` all
  `ok`; `oldAbsent: true`; `candidateMessages: 3`; `inventorySessions: 1`;
  `recoveryVerify: "verified"`; `recoveryPayload: "strict-equal"`;
  `manifestValidated: true`; `restoreImportMutation: "not-run"`; `nativeRestore:
  "not-proven"` (historical for this 2026-10-24 r2 snapshot; see the 2026-10-25
  native-restore addendum below); `durability: "parent-memory-only"`.
- Cleanup: `profile-removed`.
- Preservation: both r2 containers retained; stage artifacts preserved; the prior r1 stage
  and containers are untouched. The prior r1 failure, `E_INVENTORY_PAGING` before any
  confirmed delete, remains preserved and is not relabeled as a pass. It is recorded in the
  r2 source-lane report and the existing live entry notes; no r1 result JSON was downloaded or
  re-created for this docs record.

## Claim scope

The positive result is limited to this fixture and observation window:

- Synthetic only: **flat, parentless, settled, text-only** history; exactly two fresh roots
  in a fresh private disposable profile. No real profile, real history, production host, or
  non-isolated service was used.
- Candidate composition: the complete old ordered history prefix with fresh CSPRNG global
  message IDs plus one distinct tail. The old root's ordered content and the candidate
  prefix/tail were read back and checked before delete.
- No foreign writers are part of the fixture scope; the exact isolated inventory is checked at
  the recorded observation points. Manual quiescence is still a residual, not a proven absence
  of concurrent writers.
- Recovery: the old payload is sealed once through the existing experimental checkpoint
  crypto policy using actual crypto (no mock), and the recovery payload is built from the
  confirmed old readback. No plaintext temporary checkpoint file is part of the recorded path.
  The CSPRNG key is held only in parent-process memory. It survives
  a child-host restart within the run, **not** parent-process or machine restart, and is not a
  production-durability or secure-erasure claim.
- Recovery readback proves payload recovery only. Native restore/import and the host's own
  restore path are not proven in this 2026-10-24 probe (`nativeRestore: "not-proven"`;
  `restoreImportMutation: "not-run"`); the later 2026-10-25 addendum below records the
  separate native-restore lane.
- Delete readback proves absence at the observation time. It does not provide atomic
  attribution, CAS, protection against concurrent edits, or a late-edit guarantee between
  the final read and the remove call. `casClaim: false`; residual:
  `manual-quiescence-required`.
- The fixture has no destructive cascade. Children, forks, reverts, reference migration,
  arbitrary graph shapes, and the host's recursive child-removal behavior are outside this
  probe's proof and are not claimed safe.
- No non-replay/historical-tool proof is claimed. The run did not replay historical tools
  and did not establish a general non-replay property.
- The probe used the public host APIs only. It did not write directly to OpenCode's internal
  database, run Git, call an LLM/model, replay historical tools, or touch real history. No
  archive fallback was used.
- No compatibility claim beyond the pinned existing `linux/amd64` OpenCode `2.1.3` image.
  Other builds, platforms, and versions are untested.
- No M2 or M3 status change is claimed; the independent M3 fix-101 source polling diagnostic
  is outside this record.
- **Not a general production data-safe delete path.** This is practical, bounded M1
  feasibility evidence for replacing a root by a fresh candidate and then deleting the old
  root under the recorded conditions. It must not be generalized to real history, concurrent
  hosts, arbitrary session graphs, or production retention behavior.

## Relationship to existing evidence

- The [M1 verified-delete decision](m1-verified-delete-decision-20261024.md) admitted this
  conditional synthetic investigation. The dated outcome is appended there; its authorized
  scope, conditions, and retention parameters are unchanged. Only the pinned-2.1.3 public-delete
  and fixture-recovery observations are covered; cascade semantics, other-version applicability,
  production criteria, and product retention remain open.
- The [M1 native-replacement API result](m1-native-replacement-api-result-20261024.md)
  remains the separate 2.1.3 archive/unarchive and restart record. This delete probe does not
  duplicate, replace, or re-interpret it.
- The owner-observed **2.1.1 native parentless TUI** composer/history evidence and the
  separate **2.1.1 archive API pass / native picker fail** remain independent records. This
  2.1.3 API delete probe does not fix the picker failure or turn it into a pass.
- **Full HOST-01 remains OPEN.** Cloud native import/update/apply remains gated by the source
  criteria already documented; no cloud apply, native UI gate, or production retention
  decision is authorized or claimed here.
- `M1` overall remains **Partial**. This result does not mark the whole milestone complete.
- The r2 source-lane report records `62` focused tests: `28` lifecycle plus `34`
  state/recovery/live (`17` state + `7` real-crypto recovery + `10` live), all pass. This
  docs lane did **not** rerun those tests or the source preflight, and the runtime snapshot
  steps are checks, not test counts.

## Validation and coverage limits in this docs lane

- Re-read the result audit as JSON and re-computed its length and SHA-256: matched `7293` /
  `8f599bca272b2b73cc6fb0c4b26380edb714ee704fd2c751454d5eba781df1a6`.
- Cross-checked the audit's `actualSchemaChecks` against the embedded parent JSON: consistent
  (`true`).
- Reconstructed the embedded parent JSON as compact JSON plus LF: matched the recorded
  `1578` bytes / `804b18bb13adced5152d125c6570cfcfd208292d64af1ef53c4e5dbb1c84395c`.
- Re-read the local bundle and re-computed its length and SHA-256: matched `794138` /
  `c5e3dad0b6c7f18e612c5383ed03fde44a85a64a013deed9e0603155d34eb70b`; confirmed it is a
  regular file, not a symlink.
- Did **not** rerun the tests, the `node --check` preflight, or the container run. The local
  Docker engine was unavailable for an independent image inspection, so the image identity
  and platform are recorded from the audit and the earlier API evidence, not re-inspected
  here.
- No secret file, credential, token, key, ciphertext, payload content, or real profile was
  read. No direct internal database write, Git repository change, model/LLM call,
  historical-tool replay, or real-history access was performed by this docs lane.

## Evidence index

- [M1 verified-delete result audit](../../.package-verify-work/root-spill-20261024/NEW.package-verify-work/m1-verified-delete-execution-20261024/r2/result-audit.json)
  — sanitized execution audit (local, untracked).
- [Corrected r2 bundle](../../.package-verify-work/root-spill-20261024/NEW.package-verify-work/m1-inventory-paging-fix-20261024/r2/live-entry.bundle.mjs)
  — local, untracked probe bundle.
- [r2 source-lane report](../../.package-verify-work/root-spill-20261024/NEW.package-verify-work/m1-inventory-paging-fix-20261024/r2/report.md)
  — pagination fix, bundle provenance, and `62`-test record (local, untracked).
- [Verified-delete live notes](../../scripts/host-probes/native-replacement/verified-delete/live-readme.md)
  — sequence, pagination contract, and scope limits (local source working note, not published
  evidence).
- [M1 verified-delete decision](m1-verified-delete-decision-20261024.md) — admissibility
  conditions and dated outcome.
- [M1 native-replacement API result](m1-native-replacement-api-result-20261024.md) — separate
  archive/unarchive API evidence.
- [M1 native replacement plan](m1-native-replacement-plan-20261024.md) — original plan and
  boundaries.
- [HOST-01 evidence plan](host-01.md) — gate criteria and known gaps.
- Local continuation state: [`.slim/deepwork/sessionport-20261024-state.md`](../../.slim/deepwork/sessionport-20261024-state.md)
  (local only, not published evidence).

## Native-restore live addendum — 2026-10-25

**Bounded extension passed; M1 / HOST-01 remains OPEN and M1 remains Partial.** This addendum
does not replace the 2026-10-24 verified-delete result above. It records a separate
owner-authorized live run of the already-built encrypted-recovery bundle on the same pinned
image: the delete/snapshot probe ran first in one fresh profile, then a second, distinct fresh
profile in the same parent process performed the create-only native restore.

- Artifacts: [result.json](../../.package-verify-work/m1-encrypted-recovery-20261024/result.json)
  (`10593` bytes, SHA-256 `150c97d4fabf58fe481ca912a4497d8e7a62324fe4cdbf646ca2c24badcd4da1`)
  and [NATIVE-RESTORE-MANIFEST.json](../../.package-verify-work/m1-encrypted-recovery-20261024/NATIVE-RESTORE-MANIFEST.json)
  (`3437` bytes, SHA-256 `9a9a460464073a740f78a282f0ce56dbecd83b72b52f54d5f224c9a0ec416351`).
  Bundle `live-entry.bundle.mjs`: `807620` bytes, SHA-256
  `35cd5bab32de17a7e81ee3c905edca4f293bfbed8df35e1659e36badd2985fa0`.
- Image: existing pinned `linux/amd64` OpenCode `2.1.3`
  `sha256:118cc62ff6c1b24a9a48a87a5d56f1c8da23df1c791620e81d6ddffb8ef31192`; no build,
  pull, or install.
- Execution: preflight container
  `3ba60904a2c97cdd117c8dd8f33a7c489e7c34707052873cfd6976f96396d7ea` (`node --check`
  exit `0`) and run container
  `2613eb915fe2d8870103a4f6d9c819cc74f7d96ad7339e6adf0b5bde6ab920f6` (exit `0`, `4`
  seconds); both retained; `network: none`, read-only rootfs, cap-drop `ALL`,
  `no-new-privileges`, user `1000:1000`, pids `256`, memory `1g`, no ports/environment/
  `--rm`, one read-only bundle bind.
- First profile (delete/snapshot): old root `2` messages and candidate `3`; all `9/9` phases
  completed; old unchanged and recovery verified; exactly one DELETE of the frozen old root
  (`deleteCalls: 1`, `candidateDeleteCalls: 0`, `blindRetries: 0`); read-only restart
  snapshot `verified` with old absent, candidate `3`, inventory `1` session, recovery
  `verified`, payload `strict-equal`. This snapshot is **not** the native-restore proof.
- Second profile (native restore): distinct fresh profile, empty before import; exactly one
  create-only import (`importPosts: 1`) of the recovered old session ID and both old message
  IDs; readback `messageCount: 2`, `sessionIDMatch: true`, `messageIDMatch: true`,
  role/order/timestamps/created/title preserved, parentless root, references absent,
  canonical project match, location retargeted; `cryptoOpen: "verified"`,
  `profileDistinct: true`, `nativeRestore: "verified"`,
  `restoreImportMutation: "once"`. There was no synthetic delete target in the second host
  and no DELETE/PATCH was issued. This second host was **not restarted** after restore.
- Final schema: `status: "ok"`, `cleanup: "both-profiles-removed"` after both owned stops;
  the key is destroyed after those stops. The result was read from the actual final schema,
  not inferred from exit `0`.
- Tests: the bundle's focused evidence was already recorded and was **not rerun** here:
  `67` total (`39` verified-delete focused: `17` state-machine + `7` real-crypto recovery +
  `15` live-entry; plus `28` lifecycle), all pass.
- Limits: synthetic flat, parentless, settled, text-only history only; **no references,
  children, forks, reverts, graph shapes, or reference migration**; manual quiescence
  remains required; **no CAS claim**; the key is parent-process memory only and survives
  child stops, **not parent death or OS restart**; no production durability or secure-erasure
  claim; no compatibility claim beyond the pinned image. **M1 / HOST-01 remains OPEN; M1
  remains Partial.** The earlier `nativeRestore: "not-proven"` statements are historical for
  the 2026-10-24 r2 snapshot and are preserved, not erased. No M3 status or evidence change
   is recorded here.

## 2026-10-25 — rich graph import/readback: gate failed

The separate, nondestructive [graph result](../../.package-verify-work/m1-encrypted-recovery-20261024/graph-readback-result.json)
records one run on the same pinned 2.1.3 image: `graph-partial`, exit `1`.
Four imports created four synthetic sessions and eight messages. Parent-chain,
completed/error tool parts, payload hashes and metadata checks passed; the
non-replay sentinel remained absent. Fork and revert references were absent on
readback despite being accepted by the import schema. No DELETE/PATCH was issued;
the owned profile was removed, while the container and staging evidence remain.

A subsequent read-only `/openapi.json` inspection of the remote 2.1.3 control
server confirmed that `Session.Info` exposes `fork` and `revert`, both GET and
import responses reference it, and session PATCH accepts only `title`, `metadata`,
`permissions`, and `archived`. Fork creation accepts only `before`; revert staging
accepts `messageID` and `files`. These schemas do not establish an exact-reference
restore workaround. This schema check is control-server evidence, not inspection
of the isolated container's source. The 2.0.22 source clone suggests import omission
but is not proof of 2.1.3 internals. M1/HOST-01 remains open; the rich graph test
must not be reported as passing or used to relax the flat verified-delete guards.
