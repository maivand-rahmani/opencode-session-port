# Checkpoint weight reduction — subagent retention (2026-11-13)

Status: **owner-directed local change; implementation and verification are
recorded below.** Not a release, compatibility, or production-crypto approval.

## 1. Question

Can SessionPort checkpoints be made smaller, and how? The owner proposed
keeping only the subagent sessions that matter — specifically, subagent
sessions **after compaction** — and then asked for that rule to be
configurable.

## 2. Measured composition (read-only live database)

The active workspace project (`c35c8840…`, OpenCode 2.1.1 database) was read
with `PRAGMA query_only = ON`; nothing was written.

| Measurement | Value |
| --- | --- |
| Project sessions | 248 at first measurement; 252 at final verification (3-4 roots, 245-249 children) |
| Messages | ~19,800 stored (plus closure) |
| Full checkpoint payload (final run) | **247.7 MiB** |
| Full artifact (final run) | **90.29 MiB** |
| Bytes in child/subagent sessions | **87%** of the payload |
| Largest single session | 22.8 MiB root ("Complete M0 in V2 README") |
| External parent pulled by closure | 47.4 MiB, shared by 12 old children |

Compaction markers are real `session_message` rows with `type = "compaction"`
(18 in this project). Their `time.completed`/`time.created` gives the cutoff
used by the new rule.

## 3. Retention options measured

Sizes include the dependency closure (`parentID`/fork references) that the
checkpoint collector adds after seed selection.

Early estimates used a fake client that omitted the host `type` field, so they
slightly over-counted unsettled assistant messages. The final numbers below
come from the corrected fake client and the real checkpoint flow. Session
counts drift as the live workspace grows.

| Retention rule | Kept sessions | Payload | Artifact |
| --- | --- | --- | --- |
| All project sessions (baseline) | 252 (+1 closure) | **247.7 MiB** | **90.29 MiB** |
| Latest 10 child sessions | 13 | 34.2 MiB | ~15.3 MiB |
| Latest 20 child sessions | 23 | 41.1 MiB | ~17.6 MiB |
| Latest 30 child sessions | 33 | 45.8 MiB | ~18.9 MiB |
| Latest 50 child sessions | 53 | 54.6 MiB | ~21.2 MiB |
| **Children created after the latest root compaction** | **7** (3 roots + 4 children) | **27.7 MiB** | **13.59 MiB** |
| Roots only | 3 | 25.2 MiB | ~12.8 MiB |

The since-compaction rule keeps the sessions that belong to the current
post-compaction working epoch and drops history the main session has already
summarized. It is both smaller than "latest 20" and semantically meaningful.

## 4. Implemented policy

Checkpoints now use a configurable wiring-level retention policy
(`EXPERIMENTAL_SUBAGENT_RETENTION` in
`src/tui/wiring/experimental-profile.ts`):

```ts
{ mode: "since-compaction", maxSubagentSessions: null, maxRootSessions: null } // null = no cap
```

- **Every root session is included in `since-compaction`, `latest`, and `all`.**
- `mode: "since-compaction"` (default): page the project's root-session
  messages, find the latest `type: "compaction"` timestamp, and keep every
  child session whose `time.created` is after it. `maxSubagentSessions: null`
  means no cap; a number caps the survivors. If no compaction exists, it falls
  back to `latest`.
- `mode: "latest"`: keep every root plus the `maxSubagentSessions` most recently
  updated child sessions (a number is required).
- `mode: "roots"`: keep the `maxRootSessions` most recently active root sessions
  (`time.updated`, falling back to `time.created`) and every child that descends
  from one of them, direct or nested. Children of older roots, orphan children,
  and children of unknown parents are excluded. A parent cycle or an undated
  root fails closed.
- `mode: "all"`: keep every child session (no weight reduction).
- `maxSubagentSessions: 0` keeps roots only.

The filter is applied by a checkpoint-only read-port wrapper before collection;
the core collector and restore destination snapshots are unchanged. The
checkpoint report states the mode, the kept/excluded counts, and that older
subagent sessions were excluded. Nothing is deleted from the host database.

### 4b. User control (native OpenCode dialogs)

`/checkpoint` now asks the user before collection, using the host's built-in
`dialog.select`/`dialog.prompt` (so it inherits OpenCode's theme and keyboard
behavior):

- **After last compaction (recommended)** — since-compaction, no cap.
- **All sessions** — complete history, no reduction.
- **Last N root sessions…** — prompts for a whole number 1-1000; keeps that many
  most recently active roots plus all of their subagents.
- **Latest subagent sessions…** — prompts for a whole number 1-1000.
- **Root sessions only** — latest with 0.

The chooser first reads root-session dates (project session list only; no
messages) and marks the recommended option: `roots` with the count of roots
active in the last 30 days when older roots exist, otherwise since-compaction.
Canceling the chooser reports "Checkpoint canceled" and performs no message
read, password prompt, crypto call, or write.

The custom password and restore preview/report dialogs no longer carry their
own hex palette. They use the host semantic theme roles: `background.base` /
`background.raised.*`, `border.base`, `text.base` / `text.muted`, feedback
tokens for statuses, action tokens for focused actions, and formfield tokens
for password fields and selection markers. This is what makes the dialogs feel
like part of OpenCode rather than a separate app.

### 4c. Restore import mode

`/restore` asks how existing destination sessions are handled before any
artifact read or password prompt:

- **Keep existing sessions (recommended)** — import alongside existing
  sessions; collisions are copied with new IDs. Nothing is deleted, no delete
  capability is requested, and `recoveryRequired` is false.
- **Replace verified sessions** — the existing behavior: delete only sessions
  the safety checks prove unchanged, after a recovery artifact is created and
  the fresh fingerprint still matches.

Canceling reports "Restore canceled" and changes nothing. The core replacement
policy and safety gates are unchanged; `keep` simply forces the existing
non-destructive copy branch for every existing target.

## 5. Verification

The counts below record the original three-mode implementation. The later
`roots` mode and date-based recommendation extend this suite; their current
counts are recorded in `root-session-retention-20261113.md`.

Focused checks:

- `bun test tests/tui/adapters/session-retention.test.ts` — **23 pass / 0
  fail**, 108 expectations: all three modes, root preservation, paged
  compaction scan, fallback, caps, and fail-closed cases.
- `bun test tests/tui/wiring/reports.test.ts` — **29 pass / 0 fail**, 465
  expectations: exact mode-specific retention copy and the no-retention pin.
- `bun test tests/tui/wiring/composition.test.ts` — the checkpoint command
  uses the retention pre-pass (one project list call) and reports success.
- `bun run typecheck` — clean.

Real-data run through the real checkpoint flow (read-only database, fake host
client, real crypto and artifact writer):

```
retention summary: {"mode":"since-compaction","projectSessionCount":252,
  "keptSessionCount":7,"excludedSessionCount":245,"maxSubagentSessions":null}
OUTCOME (3.6s): {"status":"written","sessionCount":7,
  "encryptedBytes":14255167}
artifact bytes: 14255167 (13.59 MiB)
decrypted payload bytes: 29020343 (27.68 MiB)
decrypted sessions=7 messages=3736
PEAK RSS: 953.10 MiB
outcome sessionCount matches: true
retention kept count matches: true
```

The same project's full checkpoint in the same harness was **90.29 MiB**
(247.7 MiB payload, 253 sessions, peak RSS 2,329.53 MiB, 12.7 s), so the
since-compaction policy produced an **85.0% smaller artifact** (13.59 MiB) and
roughly halved peak RSS.

Full-suite and delivery checks (after the retained UI/configuration work):

- `bun test --max-concurrency 4 --timeout 30000` — **1,374 pass / 1 skipped /
  0 fail**, 30,094 expectations across 90 files.
- `bun run typecheck` — clean (`tsc --noEmit`, exit 0).
- `bun test tests/package` — **65 pass / 0 fail**; packed-file boundary updated
  to 89 for the retention port and the two native UI flows.
- `bun run verify:package` — `ok: true`, no problems.
- `bun run build:tui` — `dist/tui.js` 1,086,402 bytes; it imports as plugin id
  `sessionport` and contains the retention modes, the keep-existing mode, and
  the new UI copy.

The running host must be restarted (or its plugin reloaded) once more to load
this rebuilt bundle. The existing `.sessionport/` checkpoint created by the
live host before this change (88.6 MiB) is evidence that the previous
long-session streaming fix is active in the running TUI.

## 6. Evidence boundaries

- Measurements use a **fake host port over read-only database records**, not a
  live TUI checkpoint; the full-payload gzip figure matches the previously
  recorded real artifact size.
- The live database is a moving target; session counts and sizes drift as work
  continues. Ratios and the order of magnitude are the durable evidence.
- Retention is an explicit completeness trade-off: excluded subagent sessions
  are not in the artifact and would not be restored. Dependency closure can
  still add referenced parent/fork sessions.
- No artifact format, crypto parameter, or cap changed. No macOS/Linux or
  cross-version claim follows.
- The native retention/import-mode choosers and the semantic-theme refactor are
  verified by unit tests, typecheck, and the rebuilt bundle. They have **not**
  been visually exercised in a live TUI after a restart, so no screenshot or
  keyboard-flow acceptance claim is made here.


