# M1 verified-delete decision record — 2026-10-24

## Status

**Admissibility decision only.** No host was launched, no delete was executed, no database or
native history was touched, no network call or model/provider call was made. This is **not** a
HOST-01 pass, not a product-enablement decision, and not a retention-policy decision.

This record admits, conditional on the listed gates, a bounded synthetic investigation; it does
not authorize real-history deletion, production changes, or cloud apply.

**Dated update (appended 2026-10-24):** the bounded r2 probe has since executed within these
conditions and returned `status: "ok"`, `outcome: "api-verified"`, and `phase: "complete"`.
See the [M1 verified-delete result](m1-verified-delete-result-20261024.md). The decision-time
paragraph above is retained as the pre-run record; this outcome does not change the authorized
scope, conditions, or retention parameters.

## Decision

The owner directed investigating replacement of an old native root by a **new parentless root**,
followed by deletion of the old root after full verification, to avoid accumulating one archived
root per sync (ten syncs would otherwise leave ten archived roots). This decision paraphrases the
owner's direction; no credentials, identifiers, or private values are recorded.

- **Admissible, conditional:** a reviewed synthetic probe may investigate "import new parentless
  root → verify everything → public-delete only the known old graph" under the conditions below.
  "No recovery needed" means preservation is verified rather than assumed; the recoverable
  encrypted checkpoint readback remains a precondition, not a fallback restore step.
- **Scope supersession:** this supersedes the prior archive-only, no-delete probe scope
  ([M1 native replacement plan](m1-native-replacement-plan-20261024.md), which retained and
  archived both roots) **only** for this proposed synthetic investigation. It does not erase that
  evidence, authorize real-history deletion, or change remote-object retention.
- **Alternative, not gate pass:** verified delete is an **alternative HOST-01 acceptance
  candidate under investigation**, not a passed gate. The original preferred path — a same-ID
  validated conditional update (or an equivalent proven-safe integration) — remains in place and
  is not erased or silently weakened.

## Admissibility conditions (all must hold before any delete)

1. **New root:** import is parentless (`parentID` absent/null); the frozen candidate ID and the
   complete new ordered tail are read back and match the synthetic fixture.
2. **Complete old preservation:** full old-graph coverage is verified before delete — exact
   ordered message IDs/content, logical references (`parentID`, `fork.sessionID`, revert links)
   resolve within the recorded old graph, and no surviving record depends on the deleted graph.
3. **Recoverable checkpoint readback:** the old root is captured in a recoverable **encrypted**
   local checkpoint through the existing checkpoint path, and readback is verified before delete.
   No plaintext temporary files; if recoverability is not verified, no delete.
4. **Known old graph only, public delete only:** the delete target is exactly the fully enumerated
   old synthetic graph, via the public API. The source-level cascade hazard requires runtime
   validation: if public delete can cascade into children/forks/other records, abort unless that
   full closure is explicitly enumerated and authorized. No direct native-database write.
5. **Reject conditions:** do not delete when any old-graph record is active or pending, when any
   reference is unknown/unresolved, or when a late edit is observed between verification and
   delete.
6. **Ambiguity:** an ambiguous delete outcome is reconciled by readback; it is **not** blindly
   retried.
7. **Concurrency:** no automatic concurrency guarantee is claimed because no public CAS exists.
   The changed-ID replacement path relies on manual quiescence and must not be presented as
   atomic.
8. **Safety:** synthetic fixtures only, in an isolated disposable profile; no real history, no
   model/LLM calls, no historical tool replay, no native-database writes, no plaintext temp, no
   production access.

## Gate and evidence boundary

- **HOST-01 remains OPEN**; cloud native import/update and automatic continuity remain blocked
  until a proven integration and the actual acceptance criteria are satisfied.
- **Existing local `/checkpoint` and `/restore` are unaffected** and remain independent.
- The 2.1.3 API result and the 2.1.1 native-composer observation remain **independent existing
  evidence**. The 2.1.1 picker observation **failed** (the archived old root remained visible);
  that failure is retained, not repaired or relabeled by this decision.
- This is an **M1 feasibility** investigation. It does not decide the release/product future
  (delete vs archive, retention behavior, backup count, caps, crypto/format parameters) and does
  not enable a product path.
- The owner approved this investigation/probe conditionally; the approval does not extend to
  crypto/format parameters, retention policy, or product enablement.

## Dated runtime outcome (2026-10-24, appended)

- The corrected r2 probe executed under the conditions above and passed: exit `0`,
  `status: "ok"`, `outcome: "api-verified"`, `phase: "complete"`. The sanitized result audit is
  [`result-audit.json`](../../NEW.package-verify-work/m1-verified-delete-execution-20261024/r2/result-audit.json),
  `7293` bytes, SHA-256 `8f599bca272b2b73cc6fb0c4b26380edb714ee704fd2c751454d5eba781df1a6`.
- All nine probe checks passed (eight `verified`; `import` reported `created`). Exactly one DELETE
  was issued to the frozen old target only; candidate DELETE calls `0`; blind retries `0`. The
  post-restart snapshot is `verified` with old root absent, candidate `3` messages, inventory `1`
  session, recovery `verified`, payload `strict-equal`, manifest validated, and profile removed.
  Both r2 containers and stage artifacts were retained.
- The positive scope remains synthetic and bounded: flat, parentless, settled, text-only two-root
  fixture in a fresh private profile. Recovery uses the existing experimental crypto policy with
  actual crypto and a parent-memory key only; it survives a child-host restart, not parent/machine
  restart, and is not production durability. Recovery payload, not native restore/import, is
  proven. Children, forks, reverts, reference migration, CAS, concurrent edits, non-replay tools,
  and arbitrary graph safety are not proven. Manual quiescence remains required. This is not a
  general production data-safe delete path.
- This outcome demonstrates bounded M1 feasibility for the admitted root-replacement path only.
  **HOST-01 remains OPEN** and cloud apply remains gated. No retention/archive policy, product
  default, or authorized scope is changed; the same-ID conditional-update alternative remains in
  place. The prior r1 `E_INVENTORY_PAGING` failure with no confirmed delete is preserved, and the
  separate 2.1.1 native composer/history evidence plus archive API pass / picker failure are not
  repaired or relabeled by this 2.1.3 API delete probe.
- The source lane recorded `62` focused tests (`28` lifecycle plus `34` state/recovery/live:
  `17` state, `7` real-crypto recovery, `10` live), all pass. This docs lane did not rerun them.

## Open parameters

**Status note (appended 2026-10-24):** the list below began as the decision-time open set;
the annotations record what the dated outcome resolves or narrows. The public-delete observation now
covers the pinned 2.1.3 API surface and the fixture's recovery readback. Cascade semantics,
other-version applicability, production recoverability criteria, manual-quiescence acceptance,
product retention behavior, and the version/platform matrix remain open. No retention parameter
is changed.

- Public delete API contract, version applicability, and cascade semantics (decision-time
  runtime-unverified; pinned 2.1.3 public API observed by the dated outcome; cascade and other
  versions still open).
- Exact reference-closure verification method and the definition of "complete old coverage".
- Checkpoint recoverability criteria and readback procedure.
- Acceptance or rejection of the manual-quiescence residual for a changed-ID replacement.
- Product retention behavior (archive accumulation vs verified delete) and backup count.
- Version/platform matrix and any production applicability.

## References

- [HOST-01 gate](../V2/ARCHITECTURE.md#8-host-apply-release-gate-host-01)
- [SYNC_PROTOCOL host-gate interplay](../V2/SYNC_PROTOCOL.md#12-host-gate-interplay)
- [HOST-01 evidence plan](host-01.md)
- [M1 native replacement plan](m1-native-replacement-plan-20261024.md)
- [M1 native-replacement API result](m1-native-replacement-api-result-20261024.md)
- [M1 verified-delete result](m1-verified-delete-result-20261024.md)
