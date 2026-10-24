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
set. No artifact was moved, deleted, or re-created for this record.

| Item | Recorded value |
| --- | --- |
| Authorization | Owner-authorized conditional synthetic delete; one bounded run; no `--rm` |
| Remote run | Session `ses_e909fde83ffeUzzGCevB32ERbd`, directory `/home/deploy/server`, queued prompt, assistant finish `stop` |
| Result audit | [`result-audit.json`](../../NEW.package-verify-work/m1-verified-delete-execution-20261024/r2/result-audit.json), `7293` bytes, SHA-256 `8f599bca272b2b73cc6fb0c4b26380edb714ee704fd2c751454d5eba781df1a6` |
| Parent result | Remote `/home/deploy/sessionport-validation/20261024-m1-verified-delete-r2/parent-result.json`, `1578` bytes, SHA-256 `804b18bb13adced5152d125c6570cfcfd208292d64af1ef53c4e5dbb1c84395c`; sanitized JSON is embedded in the result audit |
| Bundle | [`live-entry.bundle.mjs`](../../NEW.package-verify-work/m1-inventory-paging-fix-20261024/r2/live-entry.bundle.mjs), `794138` bytes, SHA-256 `c5e3dad0b6c7f18e612c5383ed03fde44a85a64a013deed9e0603155d34eb70b`; regular file, not a symlink |
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
  "not-proven"`; `durability: "parent-memory-only"`.
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
  restore path are not proven (`nativeRestore: "not-proven"`;
  `restoreImportMutation: "not-run"`).
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

- [M1 verified-delete result audit](../../NEW.package-verify-work/m1-verified-delete-execution-20261024/r2/result-audit.json)
  — sanitized execution audit (local, untracked).
- [Corrected r2 bundle](../../NEW.package-verify-work/m1-inventory-paging-fix-20261024/r2/live-entry.bundle.mjs)
  — local, untracked probe bundle.
- [r2 source-lane report](../../NEW.package-verify-work/m1-inventory-paging-fix-20261024/r2/report.md)
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
