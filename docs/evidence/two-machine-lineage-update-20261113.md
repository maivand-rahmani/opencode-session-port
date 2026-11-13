# Two-machine lineage and in-place update — phase 2/3 evidence (2026-11-13)

## Approval and scope

The owner approved phase 2 (portable lineage metadata) and phase 3 (same-ID update)
on 2026-11-13, conditioned on a polished implementation. This record documents the
working-tree implementation; nothing is committed, deployed, or claimed as live-host
acceptance.

Phase 1 (normalized content duplicate skip) is recorded in
[two-machine-dedup-20261113.md](two-machine-dedup-20261113.md).

## Why lineage is needed

OpenCode's supported import API rejects an existing session ID. A copied session may
therefore live under a derived ID, and the host rewrites `projectID`, `time.updated`,
`slug`, and `version` while preserving `info.metadata`, `time.created`, message IDs,
message content, and message order.

Content equality alone cannot recognize a session that was continued on the other
machine. Portable lineage is the link:

```
info.metadata.sessionport = { version: 1, lineageID: "<stable id>" }
```

- A valid stamp is preserved; unrelated metadata is never rewritten.
- An unstamped record belongs to its own session ID, so the first import and the
  original on the other machine share a lineage without a host-database write.
- Malformed metadata is left untouched and treated as "no lineage".
- The stamp is identity metadata, not content: `fingerprintSessionContent` excludes
  it, and stamped/unstamped equivalents still match.
- Lineage is stamped in memory on the standalone import candidate before the host
  import. The plugin never writes OpenCode's database directly.

## Reconciliation matrix

For a standalone artifact record with no session/message references from other
artifact sessions, after exact-local, exact-retry, and exact-content precedence:

| Destination vs incoming | Result |
| --- | --- |
| Same normalized content under any ID | `skipped` / `exact-content-duplicate` |
| Same messages and same meaningful info | `skipped` / `lineage-current` |
| Destination messages are a strict prefix, info matches | `updated` under the existing destination ID |
| Incoming messages are a strict prefix | `skipped` / `lineage-current` (keep the newer local copy) |
| Both sides added or changed content | forced copy, `lineage-conflict`; nothing deleted |
| More than one local copy or artifact copy of the lineage | forced copy, `lineage-ambiguous` |
| Destination child/fork/revert reference | forced copy, `lineage-linked` |

"Meaningful info" includes title, agent, model, permissions, metadata other than
lineage, `time.created`, and unknown info fields. Usage counters (`cost`, `tokens`),
`time.updated`, host-rewritten identity fields, and graph references are ignored for
continuation detection. A message-only prefix with a different title is a conflict,
not a silent metadata overwrite.

A divergence at the same destination session ID keeps the owner-selected
`replace`/`keep` policy; a divergence that matched a different local ID is always a
preserving copy.

## Same-ID update gates

The executor adds an `update` preview action and an `updated` report outcome. Before
any delete it requires:

1. A frozen preview with the exact old target, title, action, and full-record
   fingerprint.
2. A structurally valid standalone candidate whose `info.id` is exactly the old
   target ID.
3. A fresh target read whose full-record fingerprint equals the preview baseline.
4. A fresh target with no parent/fork/revert metadata.
5. A fresh complete reference inventory; `classifyLineageUpdate` proves the target and
   source are settled, have no running tools, and no inventory entry references the
   target session or its message IDs through parent/fork/boundary/revert.
6. An encrypted recovery artifact of the current destination baseline, written and
   decrypt-verified **before** deletion.
7. Exactly one delete attempt and a readback proving absence. A refused, failed, or
   unreadable absence check never imports.
8. Exactly one same-ID import, full readback, and the existing strict
   `verifyImportedRecord` projection.

There is no retry, rollback, atomicity, or CAS/TOCTOU claim. If the same-ID import
fails after deletion, the session is gone from the live store and the reported
recovery file is the only restore path. The UI states this before confirmation.

The update record keeps its lineage stamp and uses planner-derived message IDs. That
avoids reusing message IDs owned by another session, at the cost of changing message
IDs across updates; message content and order are preserved.

## Verification

| Check | Result |
| --- | --- |
| `tests/core/restore` (planner, replacement, lineage, closure) | 148 pass / 0 fail |
| `tests/core/restore/lineage.test.ts` | 9 pass / 0 fail |
| `tests/core/restore/planner.test.ts` | 99 pass / 0 fail |
| `tests/tui/orchestration/newreplacement-execution.test.ts` | 41 pass / 0 fail |
| `tests/tui/wiring/local-restore.test.ts` | 20 pass / 0 fail |
| Non-cloud full suite | 970 pass / 0 fail, 66 files |
| `bun run typecheck` | clean |
| `bun run build:tui` | `dist/tui.js`, 1,137,291 bytes |
| `bun run verify:package` | `ok: true`, no problems; 92 packed files |

The local-restore tests prove end to end (synthetic host) that:

- a continued lineage deletes the existing target once and imports the continuation
  under the same destination ID;
- the updated record keeps the lineage stamp and does not create a second session on
  a later restore of the same artifact;
- a diverged lineage performs zero deletes and preserves both versions;
- a content-identical derived-ID copy is skipped with zero imports and zero deletes.

The executor tests prove the destructive gates: target changed after preview, recovery
unverified, refused delete, unverifiable delete absence, import failure after deletion,
fresh incoming reference, and absent old target.

## Limits and non-claims

- **No live two-machine or live-host destructive update test was performed.** Synthetic
  local tests only. The pinned host contract was inspected in the cloned v2.0.22 source;
  the running TUI still requires a restart to load the rebuilt bundle.
- **No concurrency guard.** The host has no CAS/conditional delete. The existing manual
  quiescence rule applies; a target can change between the fresh read and DELETE.
- **Global message-ID collision residual risk.** The planner checks destination message
  IDs and uses artifact-derived IDs, but no complete global message-ID inventory exists.
  A collision would surface as a failed same-ID import after deletion; recovery is the
  documented fallback.
- **Linked sessions are never updated in place.** A destination child, fork, revert, or
  incoming message reference downgrades the entry to a preserving copy. Parents with
  attached subagent sessions therefore remain copies rather than in-place updates.
- **No merge.** Both diverged versions are kept; the user must resolve them manually.
- **Retention is export-side only.** A session omitted from an artifact is never a
  deletion signal.
- **No plaintext fallback.** The stamp lives inside the existing encrypted artifact and
  the host record; no temporary plaintext is introduced.

## Follow-up owner decisions

The remaining risks are runtime acceptance, not design placeholders:

1. Run a bounded live-host update test (staging session only) against the actual running
   TUI version, covering delete-then-import failure and recovery restore.
2. Decide whether linked-session graph updates are worth the additional complexity or
   whether preserving copies is the intended permanent behavior.
