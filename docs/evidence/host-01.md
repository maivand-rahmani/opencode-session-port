# HOST-01 Evidence Plan — Source-Only Draft

Status: **PARTIAL / UNVERIFIED** (source research only; no probe executed).

Recorded: 2026-10-19. Validation owner: orchestrator. This document is a plan, not an
execution authorization and not a safety GO. A separate bounded probe plan plus an
independent safety GO is required before any host/API launch. No host, service, config,
user-history, database, log, or credential access was used to produce it.

## 1. Verdict and gate effect

- **HOST-01 is technically not passed.** Source research narrows the open questions but
  cannot close any runtime evidence row in
  [ARCHITECTURE.md §8](../V2/ARCHITECTURE.md#8-host-apply-release-gate-host-01).
- **All cloud native imports and updates remain blocked.** There is **no missing-session
  exception**: a downloaded revision is staged locally as `host-update-blocked`; the host is
  not called for cloud apply.
- **Local `/checkpoint` and `/restore` are unchanged and independent** of this gate
  ([ARCHITECTURE.md §8](../V2/ARCHITECTURE.md#8-host-apply-release-gate-host-01);
  [SYNC_PROTOCOL.md §12](../V2/SYNC_PROTOCOL.md#12-host-gate-interplay)).
- **No safe existing-session update path was found in the documented public contract.**
  The documented `PATCH` surface is properties-only, and no conditional/CAS transcript
  update or atomic snapshot/revision token is documented. Until a probe-backed path exists,
  preserving the blocked state is the correct behavior while unrelated backend work
  continues.
- **No broad impossibility claim is made.** This is bounded public-contract absence, not
  proof that no solution exists. Installed declaration/source internals were not inspected,
  and live host compatibility is unverified.

## 2. Baseline and provenance

| Item | Accepted baseline |
| --- | --- |
| Plugin/client | `@opencode/plugin` / client **2.0.22** |
| Upstream tag | **v2.0.22**, commit `815de9950b205cd734c9962c4629b07d3b83ee07` (verified by librarian in accepted lib-3 research) |
| Runtime claim | None. Installed declaration/source internals were not inspected; this is source/doc research, not live host compatibility. |

Accepted sources (checked 2026-10-18/19 in the reconciled research note):

- OpenCode V2 API documentation: <https://opencode.ai/v2/docs/api/>
- OpenCode V2 plugin CLI documentation: <https://opencode.ai/v2/docs/build/plugins/cli>
- OpenCode V2 build/client documentation: <https://opencode.ai/v2/docs/build/client>
- Reconciled research baseline and gate matrix:
  [`.slim/deepwork/sessionport-v2-local.md`](../../.slim/deepwork/sessionport-v2-local.md)
  (§Accepted HOST-01),
  [ARCHITECTURE.md §8](../V2/ARCHITECTURE.md#8-host-apply-release-gate-host-01) (lines
  224–269),
  [SYNC_PROTOCOL.md §10](../V2/SYNC_PROTOCOL.md#10-triggers-and-scheduling) and
  [§12](../V2/SYNC_PROTOCOL.md#12-host-gate-interplay).
- Historical, single-host context only (not V2 support evidence):
  [V1 validation E27/E28/E33/E37/E39](../archive/v1/validation-and-open-questions.md#2-tested-evidence-what-was-observed).

## 3. What source research establishes (and what it cannot)

| HOST-01 area | Source-established facts | Source gap / runtime row |
| --- | --- | --- |
| Same-ID import semantics | Public import documents `200/400/401/404/409` outcomes; 409 is the only observed conflict signal. | Existing-ID semantics are undocumented: what is compared, whether a conflict is atomic, and what happens to messages under a conflicting session ID. Row remains unverified. |
| Failed/partial writes | No documented import transaction, atomicity, or partial-write outcome. | Whether a failed import can leave a partial session/message graph is unknown. Row remains unverified. |
| Concurrent tool activity | No documented lock, CAS, transaction, or snapshot isolation covering transcript replacement. | What can mutate a session during read/import is unknown; no TOCTOU claim is made. Row remains unverified. |
| Restart ambiguity | No documented crash journal, apply recovery, atomic snapshot, or revision token. | Undetectable partial state after a mid-apply crash is unknown. Row remains unverified. |
| Reference mapping | Parent-first import ordering is documented/observed; `parentID` and `fork.sessionID` links are schema-defined. | Parent/child/fork/revert reference survival through import/apply is not established for V2. Row remains unverified. |
| Command/argument compatibility | `slash: { name: "sync", arguments: true }` is documented; the callback receives a raw argument string. | Nested subcommand grammar, tokenization, quoting, and raw-input behavior are unverified; a single-command action-menu fallback remains required. Row open. |
| Event/trigger contract | Client subscriptions are live-only: no replay, no automatic reconnect; re-subscribe plus reconcile is required; unsubscribe/abort teardown is described. | Exact change/idle event names and scheduler trigger names are undocumented. Row open. |
| Platform matrix | Historical V1 observations are Windows-only and bounded. | macOS and Linux are untested; no platform cell is closed by source research. Per-platform rows remain unverified, and no broad support claim follows. |

`PATCH session.update` is documented as **properties-only**: it is not a documented
transcript conditional update and provides no CAS/atomic replacement path.

## 4. Probe plan (planned — not authorized, not executed)

### 4.1 Preconditions

Execute only after a separate bounded probe plan receives an **independent safety GO**.
Every attempt is one bounded run of a disposable, isolated host profile:

- New unique profile/root per attempt; no inherited real config, history, credentials,
  plugins, sessions, or database. Verify debug/data/cache/config/state/tmp/log/db paths and
  home redirects under the disposable root before any client call; abort on any violation.
- Synthetic data only, generated in memory and delivered through the public API. No real
  user history, no plaintext session files created by the probe, no raw log or payload
  capture. Evidence records bounded structural facts (IDs, counts, hashes, booleans,
  status codes), not raw message text.
- No Git, no model/LLM calls, no historical tool replay, no direct database reads or
  writes, no credential access.
- Bounded wall clock, output size, attempt count, and process tree; deterministic stop
  conditions; no automatic retries. Cleanup verifies process-tree stop and deletes the
  exact disposable root.

### 4.2 Fixtures

Generate per-run unique synthetic IDs and a graph containing:

- a root session with settled user/assistant messages;
- a child session via `parentID` (and a deeper descendant);
- a fork session via `fork.sessionID`;
- revert/edit message references as represented by the projected public export;
- a valid message-ID set that can be deliberately collided in a separate case;
- a sentinel historical tool marker that must produce **no** execution side effect.

Use the fixture graph for every applicable case; never reuse IDs across runs.

### 4.3 Observation method

Use only public client surfaces. Capture a **bounded projected public export before and
after** each operation: session IDs, `parentID`, `fork.sessionID`, message IDs and order,
message role, settled/completion presence, reference fields, and in-memory text hashes.
Compare projections structurally. Do **not** treat a quiet window or two matching idle
reads as atomicity proof; they are best effort only
([ARCHITECTURE.md §8](../V2/ARCHITECTURE.md#8-host-apply-release-gate-host-01);
[SYNC_PROTOCOL.md §8.3](../V2/SYNC_PROTOCOL.md#83-native-apply-journal)).

### 4.4 Cases and expected observables

Each row must be labeled PASS, FAIL, or INCONCLUSIVE. A PASS requires the stated
observable; absence of evidence is INCONCLUSIVE, never PASS.

| Case | Operation | PASS | FAIL | INCONCLUSIVE |
| --- | --- | --- | --- | --- |
| Existing session ID | Import graph; re-import the same session ID identically, then with differing content. | Conflict is explicitly reported (409 or a documented equivalent); existing session/messages are unchanged; no duplicate. | Overwrite, duplicate session, or success status with changed state. | No observable conflict signal, or readback cannot distinguish states. |
| Existing message ID | Reuse a message ID within the same session and in a second session. | Explicit rejection; target session/messages show no partial state. | Silent overwrite, duplication, or unreported partial state. | Opaque error with unreadable/ambiguous state. |
| Failed/partial write | Import a valid prefix with an invalid later message or reference. | Rejection; projected export shows zero target session/messages (or a documented all-or-nothing result). | Any partial session/message persisted after rejection. | Rejection observable but state cannot be classified. |
| Concurrent mutation | During read/import, issue a second public-client mutation on the same session; the mutator is selected only from documented methods. | Outcome is a detectable conflict or a well-defined post-state; no silent lost update. | Undetected mixed/partial state or silent lost update. | No documented mutator exists for the fixture, or timing is not controlled. |
| Restart ambiguity | Terminate the isolated host process at a recorded point mid-import; restart; inspect by exact content/ID. | Post-restart state is the complete fixture or no trace, and exact inspection can classify it; no blind reimport needed. | Undetectable partial/divergent state that exact inspection cannot distinguish. | Crash point unverified, restart reinitializes state opaquely, or readback is ambiguous. |
| Reference mapping | Import the parent/child/fork/revert graph; compare projections. | All reference edges preserved and resolvable exactly once, in the designed order. | Dangling, remapped-to-wrong, or duplicated references. | Host rewrites/hides reference fields, or export is incomplete. |
| Non-replay | Import the sentinel fixture with no credentials/providers configured. | Zero sentinel effects and zero model/historical-tool execution. | Any historical tool/model execution or sentinel side effect. | Sentinel or execution boundary not observable. |
| Raw command | Register `/sync` with `arguments: true`; dispatch exact raw strings: `now`, ` now `, `now extra`, `"now"`, empty, unknown. | Callback receives the exact raw string; product-side parsing decides the action; no nested grammar assumed. | No callback, transformed/truncated argument, or host-side grammar not matching the raw contract. | Command/dispatch surface unavailable in the isolated TUI. |
| Event names/contract | Perform synthetic create/update/settle operations while subscribed. | Exact change/idle event names observed and stable across the bounded run. | No event or a contract contradicting live-only delivery. | Event surface or names unobtainable. |
| Event loss | Drop event delivery, then mutate a fixture session. | No replay is delivered; the design correctly requires reconcile. | Replay occurs (documented contract contradicted) or loss is silently treated as no change. | Delivery cannot be dropped/observed deterministically. |
| Re-subscribe + reconcile | Re-subscribe after loss and run a full-read reconcile pass. | The missed mutation is detected; no duplicate apply; result remains staged while HOST-01 is unpassed. | Missed change or duplicate application. | Reconcile cannot be distinguished from event delivery. |
| Unsubscribe/abort | Invoke the returned unsubscribe handle and abort the subscription during teardown. | No callbacks after teardown; no leaked timers/processes after bounded cleanup. | Callbacks continue or cleanup leaks. | Handle/abort effect not observable. |
| Platform cells | Repeat the bounded cases per platform. | Each cell is labeled with its own host evidence. | A cell contradicts the designed behavior. | Untested platform: record UNVERIFIED and state release impact. |

## 5. Safety constraints (hard)

- Independent safety GO before any launch; this document does not grant it. One attempt per
  case or a small pre-approved bound; **no automatic retries**.
- Disposable isolated profile only; no inherited real config/history/credentials; no real
  user data; no host/API/service probing outside the disposable loopback host.
- No raw logs, payload capture, database access/writes, Git, LLM calls, or historical-tool
  replay. No plaintext session files created by the probe; synthetic fixtures stay in
  memory and the disposable host fixture.
- Bounded runtime/output/process cleanup with verified process-tree stop and exact root
  deletion. Stop and clean up on any isolation violation.
- Per-platform cells remain UNVERIFIED until their own evidence exists; do not generalize a
  Windows result to macOS/Linux or to other versions.

## 6. Scoped deferred owner questions

Recorded, not asked while the owner is away; none blocks local backend work:

1. Approve a future bounded HOST-01 probe plan and name the independent safety reviewer
   (Windows first; platform scope to be decided).
2. Approve a separate read-only inspection of installed declaration/source internals to
   reduce the source gap (no runtime launch).
3. If the public docs remain silent on existing-ID/atomic-update semantics, decide whether
   a probe-validated conditional strategy is acceptable or whether HOST-01 stays blocked.
4. Decide the 0.2.0 platform closure requirement: close macOS/Linux with host evidence or
   retain those cells as explicitly unverified with stated release impact.

## 7. Boundaries

No probe result, implementation, approval, or compatibility claim is recorded here.
Source-only findings cannot close runtime rows; this plan defines what would close them
without asserting the outcome in advance.
