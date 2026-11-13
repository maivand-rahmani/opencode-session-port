# Last-N root sessions and date-based retention recommendation (2026-11-13)

Status: **owner-directed local change; implementation and synthetic verification
are recorded below.** Not a release, compatibility, or production-crypto
approval. No live destructive test was run.

## 1. Question

The owner asked for one more checkpoint-size option: keep only the **last N
root sessions together with all of their subagent sessions**, because a root
session from a week or a month ago is usually no longer needed. The owner also
asked for a flexible configuration and for SessionPort to read root-session
dates and recommend an option.

## 2. Implemented option

`SubagentRetentionMode` now includes `"roots"`:

```ts
{ mode: "roots", maxSubagentSessions: null, maxRootSessions: N }
```

- Rank every root session by finite `time.updated`, falling back to
  `time.created`; equal timestamps break by ascending session ID.
- Keep the `N` most recently active roots.
- Keep every child session whose parent chain reaches one of those roots,
  including nested grandchildren. Original project-list order is preserved.
- Exclude children of older roots, children whose parent is absent from the
  project list, and children of an unknown parent.
- Fail closed on a root without a finite timestamp or on a parent-ID cycle.
- No message is read in `roots` mode; it does not scan compaction markers.

`N` is a positive safe integer (1–1000 in the native prompt). `maxRootSessions`
is optional for the other modes and is ignored there after validation.

## 3. Date-based recommendation

Before the chooser renders, `readCheckpointRetentionInsights` enumerates the
project session list once (metadata only; no messages, no writes) and computes:

- total root and child sessions;
- each root's last activity (`time.updated`, fallback `time.created`);
- roots active in the last 7 / 30 / 90 days;
- newest and oldest root activity.

The recommendation uses an explicit 30-day window
(`EXPERIMENTAL_RETENTION_RECOMMENDATION_WINDOW_DAYS`):

- **Older roots exist** (some roots inside the window, some outside): recommend
  `roots` with `N = roots active inside the window`, at least 1.
- **Every root is recent, or the project has no roots**: recommend
  `since-compaction` (it keeps every root and still filters old subagents).
- **Every root is older than the window**: recommend `roots` with `N = 1`, so
  the newest root and its subagents survive.

The native chooser marks the recommended option with `(recommended)` and shows
the actual root/child counts. The roots description names `N` and the window
start date (`YYYY-MM-DD`, UTC). Choosing the roots option prompts for the count
with the recommended value as the placeholder; invalid input alerts and
cancels without collecting anything.

Canceling the chooser now performs one metadata-only project list read (for the
insights) but still reads no messages, requests no password, performs no crypto
call, and writes nothing. When a checkpoint proceeds, the retention port
enumerates the list again to build the kept set; this is two metadata passes,
not a second artifact read.

## 4. Files

- `src/tui/adapters/session-retention.ts` — `"roots"` selection,
  descendant/cycle handling, `maxRootSessions`, summary fields, and
  `readCheckpointRetentionInsights`.
- `src/tui/ui/checkpoint-retention-flow.ts` — native option, dynamic
  recommendation marker, root-count prompt, date/count copy.
- `src/tui/wiring/composition.ts` — loads insights before the chooser and passes
  `maxRootSessions` to the retention port.
- `src/tui/wiring/install.ts` — forwards insights into the chooser.
- `src/tui/wiring/experimental-profile.ts` — mode union, default fields, and the
  30-day recommendation window constant.
- `src/tui/wiring/reports.ts` — roots-mode report sentence and summary fields.
- `tests/tui/adapters/session-retention.test.ts` — roots selection, descendants,
  orphan exclusion, cycle/undated failures, insights/recommendation.
- `tests/tui/ui/checkpoint-retention-flow.test.ts` — option copy, dynamic
  recommendation, root prompt, validation.
- `tests/tui/wiring/composition.test.ts` — insights handoff and roots-mode
  collection.
- `tests/tui/wiring/reports.test.ts` — exact roots-mode report copy.

## 5. Verification

| Check | Result |
| --- | --- |
| `tests/tui/adapters/session-retention.test.ts` | **33 pass / 0 fail** |
| `tests/tui/ui/checkpoint-retention-flow.test.ts` | **7 pass / 0 fail** |
| `tests/tui/wiring/reports.test.ts` | **31 pass / 0 fail** |
| Focused four-file run | **109 pass / 0 fail** |
| Non-cloud full suite | **984 pass / 0 fail**, 66 files |
| `bun run typecheck` | clean (`tsc --noEmit`, exit 0) |
| `bun run build:tui` | `dist/tui.js`, **1,147,477 bytes** |
| `bun run verify:package` | `ok: true`, no problems; 92 packed files |
| `tests/package` | **65 pass / 0 fail** |

The rebuilt bundle contains the new option and recommendation copy; the running
OpenCode host must be restarted to load it.

## 6. Limits and non-claims

- **No live host checkpoint used `roots` mode.** Verification is synthetic
  fake-port/unit/integration testing; no live TUI visual or keyboard acceptance
  is claimed.
- **No live artifact-size measurement for roots mode.** The existing measured
  sizes in `checkpoint-retention-20261113.md` are for the other modes.
- **The recommendation is advisory.** It reads root activity only; it does not
  inspect message content or subagent usefulness. The user can choose any mode.
- **Undated roots fail closed in `roots` mode.** The insights read is advisory:
  it lists an undated root with `lastActiveAt: null`, excludes it from activity
  counts, and recommends `since-compaction` so the chooser never recommends a
  mode that would fail. A malformed session list still stops the pass.
- **Dependency closure can still add sessions** after retention. A referenced
  parent or fork session may appear in the artifact even when its root was not
  selected; this is existing collector behavior, not a retention bug.
- **Excluded sessions are not deleted** from the host database. Retention only
  controls checkpoint content.
- No artifact format, crypto parameter, cap, or restore rule changed.
