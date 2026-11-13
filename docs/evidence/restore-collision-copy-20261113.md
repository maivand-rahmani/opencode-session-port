# Restore collision copies (2026-11-13)

Status: **owner-reported restore failure; fixed and synthetically verified.**
No live destructive retest was performed.

## 1. Reported failure

A restore stopped before changing anything with:

> Restore failed — The checkpoint does not match this destination safely; no
> sessions were changed. Reason: a planned message ID collides with existing
> session history (message-id-collision).

The checkpoint had been restored into a destination that already contained a
copy produced by an earlier restore of the same artifact. The local copy had
diverged, so exact-retry and lineage-current detection correctly no longer
matched it, but the planner still rederived the same session/message IDs and
failed closed.

## 2. Cause

The remapped-ID deriver is deterministic per authenticated artifact identity.
Repeated restores of the same artifact therefore propose the same target
session and message IDs. Exact retry detection skips an unchanged copy; when the
copy changed, the planner reached the destination-occupancy collision check and
aborted the whole restore instead of preserving a new copy.

## 3. Fix

The planner now resolves **destination-owned** ID collisions with a bounded,
deterministic copy variant:

1. Exact-retry and lineage reconciliation still run first. Unchanged copies
   remain skips; no duplicate is created.
2. If a planned session target is already in the selected destination, derive
   the next variant session ID (`<source-id>#copy-<n>` as the derivation input).
3. If a planned message target is already owned by the destination (and is not
   a message owned by the same-ID update target), rederive that plan's message
   IDs with the same variant.
4. A same-ID update whose derived message ID belongs to another session keeps
   the update but uses a free message ID; it never deletes an unrelated owner.
5. The first collision-free variant wins; at most 99 variants are tried, then
   the restore still fails closed.
6. Artifact-level coalescing and global-only session-ID occupancy remain
   fail-closed; this change does not silently merge two artifact sessions or
   reuse a session ID occupied outside the selected destination.

The variant derivation is deterministic for the same destination state, but it
is only used after retry/lineage reconciliation. An unchanged variant copy is
recognized by lineage/content on the next restore and skipped.

## 4. Review findings

The resolution order and target-map rebuild were re-reviewed against the
reported failure and the fail-closed invariants:

- A same-ID `updated` plan keeps its existing target; only its message IDs are
  rederived. It never selects or deletes the session that owns a colliding
  message.
- An `imported` or `renamed` plan whose session target is free keeps that target
  when only messages collide.
- Collision variants are checked against skipped-plan targets, destination
  session/message IDs, and global-only session IDs. A variant never coalesces
  with a skip or reuses a globally occupied session ID.
- The bounded failure path still throws `RestorePlanError` with the fixed
  `message-id-collision` code after 99 failed variants.
- `sessionTargets`/`messageTargets` are rebuilt after resolution and before
  final records are built, so parent/fork/revert references follow the variant
  targets.
- Artifact-level coalescing still fails closed in the final invariants.

No functional defect was found in the resolution itself. One unreachable
classification branch (an `updated`/`imported` plan cannot reach a
destination-owned session collision) was removed, and the module policy comment
was updated to describe variant resolution instead of the old "never
regenerated" rule. The main test gap was bounded-failure coverage, which the
earlier draft of this document claimed but did not contain; two tests now pin
both exhaustion paths.

## 5. Files

- `src/core/restore/planner.ts` — destination collision resolution before the
  existing final collision invariants; policy comment updated.
- `tests/core/restore/planner.test.ts` — repeated-copy, message-collision,
  update-message-collision, skipped-session collision, reference rebuild,
  global-only fail-closed, and bounded-failure cases.
- `tests/tui/wiring/local-restore.test.ts` — two end-to-end repeated restores:
  one whose prior copy occupies only message IDs, and one whose prior copy
  occupies the derived session and message IDs.

## 6. Verification

| Check | Result |
| --- | --- |
| `bun test tests/core/restore/planner.test.ts` | **108 pass / 0 fail** (416 expect calls) |
| `bun test tests/tui/wiring/local-restore.test.ts` | **22 pass / 0 fail** (124 expect calls) |
| `bun run typecheck` | clean |

The full `bun test` suite was not rerun in this review pass. The prior baseline
before the added cases was 1,457 pass / 0 fail / 1 skip across 93 files.

## 7. Limits and non-claims

- No live retest of the exact user artifact was performed; the artifact is
  encrypted and its password was not available to the test lane.
- The fix preserves both copies instead of merging them. A repeated restore of
  a changed copy intentionally adds another local copy.
- Global-only session-ID occupancy and artifact-level coalescing still fail
  closed.
- A skipped exact-retry record is an unchanged destination record and is never
  rewritten. If a later variant moves another plan's targets, the skipped
  record's references may continue to point at the prior local copy. This is
  copy preservation, not a merge or delete; the executor performs no write for
  skipped entries.
- At most 99 variants are attempted per colliding plan; exhaustion fails the
  whole restore before any host write.
- No artifact format, crypto parameter, or retention rule changed.

## 8. Parent-preserving child imports (2026-11-13 follow-up)

### Reported scenario

A checkpoint contained one root session R and subagent children whose
`info.parentID` pointed at R. The destination already held an exact duplicate of
R, but not the children. The root was skipped and the children were imported as
top-level roots, so `/sessions` showed 15 roots instead of one root plus 14
children. The host requires `info.parentID` to name an already-existing session,
so parent-before-child import order is mandatory.

### Implementation

- `src/core/restore/replacement.ts` adds `prepareImportRecord(record,
  { keepParentID: true })`. It applies the same schema-reference validation as
  `prepareStandaloneRecord`, always strips `fork`/`revert`, and preserves only a
  valid non-empty string `parentID`. `prepareStandaloneRecord` is unchanged.
- `src/core/restore/index.ts` exports the new helper and its options type.
- `src/tui/orchestration/local-restore.ts` prepares import sources with
  `prepareImportRecord` instead of `prepareStandaloneRecord`, so the second
  `planRestore` pass sees and remaps `parentID`.
- Planner skipped entries now expose an optional `existingSessionID`: the actual
  destination session ID that matched for exact-local, exact-content, or
  lineage-current. `targetSessionID` deliberately stays at the artifact source
  ID so artifact collision checks never coalesce skipped entries. A parentID-only
  artifact reference may be reconciled and resolves to the real local ID; fork
  references and message referrers still block reconciliation, and unchanged
  skipped records are validated against the real local ID.
- The second plan is executed in `flattenedPlan.importOrder` (parent before
  child), followed by skipped entries for reporting. A child may only reference
  an earlier import target or a session already present in the destination;
  anything else fails closed with `dangling-session-reference`.
- A child of a skipped/existing parent is rewired to
  `entry.existingSessionID ?? entry.targetSessionID` only when that ID already
  exists in the destination and is not itself a planned import source. Other
  skipped-parent cases remain fail-closed.
- `verifyImportedRecord` now accepts an expected `parentID` only when the actual
  readback carries the exact same value. Expected `fork`/`revert` are still
  rejected, and any extra actual `fork`/`revert`/`parentID` still fails
  verification.
- `src/tui/orchestration/newreplacement-execution.ts` now prepares
  target-absent imports and non-destructive copies with
  `prepareImportRecord(record, { keepParentID: true })`, allows a resolved
  non-empty string `parentID` through its import-time graph gate, and never
  carries `fork`/`revert` graph metadata into an import. Replace and update
  candidates keep the existing parentless/own-parent contract.
- Before a child import, the executor proves the parent already exists in the
  destination or in an earlier import (`workingTargetRecords`); otherwise the
  entry fails closed with `prepared-record-invalid` and no host import occurs.
  This is a defensive complement to the parent-first plan order, not a
  replacement for it.
- Tests cover `prepareImportRecord`, the exact-duplicate-root scenario in keep
  and replace modes, parent-before-child ordering, end-to-end renamed-parent
  remapping in keep mode, a lineage-current root under a different local ID with
  its child rewired to that ID, a copied child retaining its parent ID,
  executor-level forced-copy and update parentID retention, skipped/existing
  parent resolution, unresolved-parent fail-closed behavior, and parentless
  replace. A parent that is referenced by an artifact child is not eligible for
  in-place lineage update by the planner, so the "updated parent" case cannot
  arise from the planner with a live child; the executor test proves the same
  target mapping is retained if an update entry precedes a child import.

The exact end-to-end assertion
`tests/tui/wiring/local-restore.test.ts > the imported child keeps the
exact-duplicate root as parentID in keep and replace modes` is enabled and
passes in both keep and replace modes.

Replace/update candidates intentionally remain parentless; target-absent
imports and non-destructive copies preserve a resolved parentID. A child that
already exists locally and is replaced keeps the prior root-import behavior
rather than changing the established no-delete/replace contract.

### Verification

| Check | Result |
| --- | --- |
| `bun test tests/core/restore/planner.test.ts` | **110 pass / 0 fail** (431 expect calls) |
| `bun test tests/core/restore/replacement.test.ts` | **32 pass / 0 fail** (110 expect calls) |
| `bun test tests/tui/wiring/local-restore.test.ts` | **30 pass / 0 fail** (170 expect calls) |
| `bun test tests/tui/orchestration/newreplacement-execution.test.ts` | **46 pass / 0 fail** (266 expect calls) |
| Combined four-file run | **218 pass / 0 fail** (977 expect calls) |
| Full `bun test` (final) | **1,486 pass / 0 fail / 1 skip**, 93 files |
| `bun run typecheck` | clean |

These counts supersede the earlier local-restore count in section 6. The fix was
committed as `f5010cc` and released as `v0.1.9`; the release receipt is recorded
in `docs/local-release-0.1.9.md`.
