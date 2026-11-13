# Two-machine restore deduplication — phase 1 evidence (2026-11-13)

> Phase 2 (portable lineage) and phase 3 (same-ID update) were approved and
> implemented later on 2026-11-13. See
> [two-machine-lineage-update-20261113.md](two-machine-lineage-update-20261113.md).
> The phase 1 behavior described below remains active and takes precedence for
> unchanged content.

## Problem

OpenCode's supported import API rejects an existing session ID (`ImportConflictError`, 409).
SessionPort therefore imports a colliding session under a deterministic derived ID (and
rederives its message IDs). The host also rewrites `projectID`, `time.updated`, and message
sequence on import.

The restore planner previously skipped only when the destination held the **same session ID**
and the **complete canonical record** was equal. That comparison includes IDs and the fields
the host rewrites, so after the first A→B→A round-trip the same logical session no longer
matched. Repeated transfers could keep adding copies or re-importing unchanged records.

## Implemented (phase 1)

- `fingerprintSessionContent` (`src/core/restore/replacement.ts`) hashes one session's
  normalized content. It ignores only identity/volatile fields the supported import/copy
  paths transform:
  - `info`: `id`, `projectID`, `parentID`, `fork`, `revert`, `slug`, `version`,
    `location`, `directory`, `path`, `time.updated`
  - every message `id`
  - all other values, message order, and absent-vs-null distinctions remain significant.
- `planRestore` indexes that fingerprint across every destination session ID and emits
  `skipped` with `skipReason: "exact-content-duplicate"` when the content already exists.
  - Exact same-ID canonical equality (`exact-local-duplicate`) and exact deterministic
    retry (`exact-planned-retry`) keep precedence.
  - Phase 1 is restricted to standalone, unreferenced records in the unflattened pass so a
    parent/fork/revert rewrite can never point at a session that was not imported.
  - The local-restore flattened pass covers standalone copies, which is where prior
    derived-ID copies are recognized.
  - A content match **only skips an import**. It never deletes, overwrites, merges,
    rewrites references, or stamps metadata.
- Local restore reports these skips through the existing `skip` / `exact-duplicate`
  preview and report path; no import or delete is attempted.
- `exact-content-duplicate` is accepted by the restore-execution skip-reason validation.

## Verification

| Check | Result |
| --- | --- |
| `tests/core/restore/planner.test.ts` | 88 pass / 0 fail |
| Restore orchestration/wiring subset (planner, local restore, replacement, execution) | 72 pass / 0 fail |
| `tests/tui/wiring/local-restore.test.ts` (includes new derived-ID and host-rewritten-field skips) | 18 pass / 0 fail |
| Non-cloud full suite (`tests/core`, `tests/tui`, `tests/package`, `tests/integrations`, `tests/runtime`, `tests/helpers`, `tests/ci`) | 910 pass / 0 fail, 63 files |
| `bun run typecheck` | clean |
| `bun run build:tui` | `dist/tui.js`, 1,088,831 bytes |
| `bun run verify:package` | `ok: true`, no problems |

The new wiring tests prove (a) a destination copy with derived session/message IDs,
destination `projectID`, and a different `time.updated` is skipped with zero imports,
zero removes, and a `skipped` report entry, and (b) the same session ID with only
host-rewritten volatile fields is also skipped instead of being renamed and replaced.

**Evidence boundary.** This is synthetic local verification only. No live two-machine
transfer was performed for this record. The cloud subprocess ACL/lock suite was not green
on this run: several tests exceeded the 5 s timeout and Bun 1.3.10 crashed in
`tests/cloud/auth/session-owner.test.ts`. Those files are outside this change; the
910-test non-cloud suite is the regression evidence for this phase.

## What this fixes and what it does not

Fixed:

- Re-importing an unchanged checkpoint (including sessions already copied under derived
  IDs) no longer creates another copy.
- `keep` and `replace` modes still apply only to records that are actually imported;
  content-skipped records are untouched.
- Retention remains export-side only: a session omitted from an artifact is never treated
  as a deletion signal.

Phase 2/3 status (implemented later on 2026-11-13): sessions continued on the other
machine are recognized by the portable lineage stamp and can update their existing local
copy under the same session ID after the phase 3 recovery/delete/import gates. Divergence
is preserved as a copy, never merged. See the lineage update evidence linked above. The
limits documented there still apply (no live destructive-host acceptance, no concurrency
guard, linked sessions are copied rather than updated).

**Known false-match risk.** Content-only matching cannot distinguish two separately
created sessions with identical content. That is why a match may only skip an import and
never authorize deletion, overwrite, or merge.
