# M1 native replacement plan and evidence — 2026-10-24

## Status

Implemented and unit-tested only. No host was launched, no TUI was driven, no database was
written, no network request was made, and no model or provider was called. The runtime
contract below is the parent-supplied authenticated OpenAPI observation for 2.1.3; it was not
independently re-queried in this lane.

Artifacts are new files under `scripts/host-probes/native-replacement/`. No existing runner,
product, UI, manifest, or Git file was edited.

## Runtime contract used

- `PATCH /api/session/{sessionID}` accepts optional `archived: boolean | null` together with
  the existing title/metadata/permissions fields, with `additionalProperties: false`. The
  parent reported this against an authenticated 2.1.3 server.
- The older `@opencode/plugin` 2.0.22 surface in this checkout does not expose `archived`.
  The installed generated client can strip it. An old-client `session.update` cast is not
  evidence and must not be treated as success.
- Public import returns a new root. `parentID` is omitted for a parentless import. The probe
  freezes the candidate root ID and all message IDs, then verifies the returned root and
  ordered history. It does not overwrite an existing session.
- Before importing, the probe looks up the candidate ID. Only an explicit not-found result
  permits import. An existing candidate or any other lookup error blocks import. The 2.1.3
  import is create-only; a 409 is not a sole-ownership guard.
- Canonical session archive state is `Session.Info.time.archived`: `time` has required
  numeric `created` and `updated`; optional numeric `archived` means archived. A valid
  required `time` with `archived` absent means active. Missing/invalid required time,
  `null`, or a non-numeric archive value means unknown. A top-level `archived` boolean is
  not accepted as readback proof.
- The session-list `archived` query is documented as `"true"`/`"false"`. The HTTP adapter
  encodes it explicitly; the state machine still treats list filtering as secondary evidence
  and records `unsupported`, `unverified`, or `not-filtering` when it cannot be proven.
- The 2.0.22 TUI picker does not filter archived sessions. Current 2.1.3 picker behavior is
  unknown. An archived count from a list API is not evidence of what the native picker shows.
- Graceful terminal restore is not proven. No Ctrl+C behavior was tested. A forced owned stop
  is a different claim.

## Delivered artifacts

| Path | Purpose |
| --- | --- |
| `fixtures.ts` | Synthetic two-message old root and three-message candidate with a distinct tail; exact-key/text allowlist validation; whitelist-only parentless import payload builder. |
| `state-machine.ts` | Injected adapter, canonical `time.archived` normalization, ID-lookup preflight, archive timeout/error follow-up readback, archive/unarchive/list state machine, bounded result record, restart-snapshot validator, restart-manifest parser. |
| `http-adapter.ts` | Standalone injected-port HTTP adapter with injected request/headers/path builders, pre-parse response byte cap, list-count caps, and strict 404 mapping. No built-in auth or guessed endpoints. Not executed against a host. |
| `native-replacement.test.ts` | 32 focused Bun tests covering success and the offline failure cases. |
| `README.md` | Short usage and result semantics. |

## State-machine flow

1. Validate the fixture against the exact shape/text allowlist: distinct root IDs, two old
   messages, three candidate messages, one distinct tail, all nested keys exact, no extra
   properties, no tool parts, unique IDs.
2. Read the old root baseline and its two ordered messages. It must be parentless,
   canonically active, and in the supplied project/directory; otherwise the run is blocked
   before import.
3. Look up the candidate ID. Only an explicit not-found result permits import; an existing
   or ambiguous lookup blocks before import.
4. Import the candidate with no `parentID` in `info`, using only whitelisted fields.
5. Read the returned root: exact frozen ID, `parentID` absent/null, exact title, project,
   directory, and three ordered messages.
6. Require the candidate archive state to be canonically active. Unknown is partial and
   refuses archive; archived is failed and refuses archive.
7. Re-read the old root and require its two messages unchanged.
8. Ask the adapter to archive only the old root. On timeout/error, perform one read-only
   old-root readback and classify archived/active/unknown. Never retry the archive request
   and never delete a root.
9. Attempt the archived-list filter with both `archived: false` and `archived: true`. Record
   `observed`, `not-filtering`, `unverified`, `unsupported`, or `error`.
10. Ask the adapter to unarchive only the old root. Require canonical active readback for
    full verification. Unknown yields a partial result.
11. Re-read both histories. Any late old-root edit is a failure with
    `casClaim: false` and `residual: "manual-quiescence-required"`.
12. Optionally rearchive the old root and verify canonical archived again.
13. Stop. A separate `validateRestartReadback` accepts an externally captured post-restart
    snapshot. It never stops or launches a host.

## Exact success criteria

A full `api-verified` result requires all of:

1. Fixture passed the exact allowlist; no adapter call occurred on failure.
2. Old root was canonically active before import; candidate lookup was explicitly absent.
3. Import returned exactly the frozen candidate root ID.
4. Old-root baseline and post-import history were the same two ordered IDs and bodies.
5. Candidate `parentID` is absent or `null`, and the candidate is canonically active.
6. Candidate title, project, and directory match the fixture.
7. Candidate history is exactly three ordered messages with the frozen IDs and the distinct
   synthetic tail.
8. Archive readback observes canonical `time.archived` numeric after the request; a timeout
   that is later observed archived can qualify.
9. Archived list filtering reports `observed`: candidate present in the active list, old root
   excluded from the active list, and old root present in the archived list. Anything else
   cannot be `api-verified`.
10. Unarchive readback observes canonical active.
11. Old history still has exactly the original two messages; candidate history still has
    exactly the original three.
12. No delete call exists or was made; both roots are retained. `retained` means this probe
    issued no delete, not that the host currently reports them readable.

`api-verified-partial` is the honest result when direct archive/unarchive readbacks worked
but list filtering was unsupported, unverified, not filtering, or errored. It is also used
when the candidate archive state is unknown (no archive attempted), or when unarchive
readback is unknown even if both histories survived. Native picker, native route, and
composer remain unobserved in every outcome.

## Version and feature flags

| Flag | Value |
| --- | --- |
| State-machine result version | `1` |
| Restart manifest version | `1` |
| Fixture shape | two old messages, three candidate messages, distinct tail |
| `archivedPatch` | `readback-required` |
| `archivedListFilter` | `readback-required` |
| `archiveReadbackSource` | `session-time-required-plus-optional-archived` |
| `nativePickerArchiveFilter` | `unknown` |
| `nativeRoute` | `unknown` |
| `composer` | `not-tested` |
| `terminalRestore` | `not-proven` |
| `ordinaryContinuation` / `permissionsForms` / `concurrency` | `not-tested` |

## Failure and offline cases

| Case | Expected result |
| --- | --- |
| Same root ID or duplicate message IDs in the fixture | `invalid-fixture`; no adapter call. |
| Extra fixture/message properties, tool parts, or non-allowlisted text | `invalid-fixture` or `message-shape-invalid`; no adapter call. |
| Import throws | `failed`; old root intact; zero archive calls; no delete. |
| Old root is already archived or archive state is unknown | `blocked` before import; no import or mutation. |
| Candidate ID is present or lookup is ambiguous | `blocked` before import; no import. |
| Import returns a different root ID | `failed`; no archive call. |
| Candidate has a parent ID or is archived | `failed`; no archive call. |
| Candidate archive state is unknown/missing `time` | `api-verified-partial`; no archive call. |
| Candidate history is stale/malformed | `failed`; no archive call. |
| Archive response succeeds but readback lacks canonical archived | `blocked`; two roots retained; no unarchive retry, no delete. |
| Archive transport is missing or rejects the field | `blocked`; `archiveReadback: unsupported`; two roots retained; no delete. |
| Archive request times out after applying and follow-up readback observes archived | Continue; `archiveRequest: timeout`, `archiveObserved: archived`. |
| Archive request times out and follow-up readback is unknown | `blocked`; `archiveReadback: unknown`; both roots retained; no retry/delete. |
| Archived list does not filter | `api-verified-partial`; list is `not-filtering`, not a pass. |
| Archived list is unsupported or omits the old root from both lists | `api-verified-partial`; `unsupported`/`unverified`. |
| Unarchive readback remains archived | `failed`; no delete. |
| Unarchive readback is unknown/missing `time` | `api-verified-partial`; old/candidate histories still checked. |
| Old root is edited after archive | `failed`; `lateEditDetected: true`; manual quiescence residual. |
| Optional rearchive readback fails | `failed` or `blocked`; no delete. |
| Restart snapshot has a parented/inactive candidate, wrong archive state, or changed history | `validateRestartReadback` returns a fixed failure code. |
| Native picker/route/composer not observed | Always `not-observed`/`not-tested`; never inferred from list data. |

Import failure does not auto-archive the old root. A readback failure does not trigger a
retry, a second archive attempt, or a delete. No mutation is requested outside the old-root
ID; the candidate is created by import and is never archived or updated.

## Interface changes for rereview

- `AdapterSession` no longer has a top-level `archived` boolean. It carries canonical
  `time?: { created?, updated?, archived?: number | null }`; `archiveState()` requires valid
  numeric `created` and `updated`, treats absent `archived` as active, and returns unknown
  for missing/invalid required time or non-numeric archive values.
- `NativeReplacementAdapter` keeps the same five methods. A missing session must surface as
  `NotFoundError`; only that permits the candidate-absent preflight. Archive timeouts should
  surface as `AdapterTimeoutError`; other errors are generic.
- `NativeReplacementResult.api` adds `candidateLookup`, `oldArchiveBefore`, `candidateArchive`,
  `archiveRequest`, and `archiveObserved`. `archiveReadback`/`unarchiveReadback` use
  `unknown` for unprovable canonical state.
- `HTTP_PROBE_MAX_RESPONSE_BYTES` and `HTTP_PROBE_MAX_LIST_ITEMS` are fixed test limits on the
  HTTP adapter. They are not production bounds; a bounded stream contract is still pending.

## Native UI and restart are separate gates

The state machine deliberately has no native-picker, native-route, or composer observation.
This API-only sequence archives after candidate readback; native tab/route observation is a
separate manual gate and is not a prerequisite in this module. The existing child probe on
2.1.1 showed no prompt; that is not repeated here. Actual native composer observation must
not hardcode a pass and must not submit a draft or call an LLM. Native picker filtering after
archive, native tab/route behavior, and composer visibility remain manual/not-observed until
an independently reviewed host run records them.

An owned stop/relaunch readback is not executed here. `validateRestartReadback` validates a
snapshot captured by the existing reviewed stop/relaunch mechanism later. It is not a crash
mid-import restart claim, not a graceful-terminal-restore claim, and not an atomic
replacement claim. Atomic replacement remains M5/M6 scope.

## TUI entry and runner integration proposal

No TUI probe entry was added. The pinned 2.0.22 public client type does not expose
`archived`, this lane cannot launch a host before independent safety review, and casting a
missing client feature into existence would violate the contract. The specific blocker is:
current host-provided public-client archive transport and readback are unverified offline;
the HTTP adapter is provided instead, but it has not been executed against a host because no
authenticated injected request/port and current OpenAPI path set were supplied to this lane.

After review, a separate new plugin entry can import `runNativeReplacement` and build the
adapter from public `context.client` methods:

- `session.get` and `message.list` for readbacks.
- `session.import` for the parentless candidate.
- `session.update` with `archived` only if the current runtime client actually forwards it;
  then require the separate `session.get` readback. If the field is missing or stripped,
  return `UnsupportedFeatureError`/mismatch, not a pass.
- `session.list` with `archived` only after the current OpenAPI contract confirms the
  parameter; otherwise record unsupported.

Do not use raw auth, private SDK internals, a custom UI, or child redirects. Reuse the
existing reviewed stop/relaunch runner as an opaque mechanism; do not copy its long probe or
edit it in this lane. Native picker/route/composer observation stays manual and separate.

## Safety and cleanup

- The adapter interface has no delete method. The result records `deleteCalls: 0` and
  `publicDeleteUsed: false`.
- Both synthetic roots are retained by the probe. Host-owned disposable-root cleanup may
  happen only after the existing reviewed stop/readback lifecycle is verified; this lane
  performs no public delete and no filesystem cleanup.
- Results and the restart manifest contain bounded synthetic IDs, counts, and fixed status
  labels only. Tests assert that raw message text and the fixture directory do not appear.
- No real credentials, tokens, pairing URLs, or Authorization values are in code or tests.
  HTTP headers are injected by the caller.
- No host launch, database write, network, provider/model call, real history, custom UI, or
  child redirect was performed.

## Validation

```powershell
bun test scripts/host-probes/native-replacement/native-replacement.test.ts
# 32 pass, 0 fail, 200 expect() calls

bun build scripts/host-probes/native-replacement/fixtures.ts `
  scripts/host-probes/native-replacement/state-machine.ts `
  scripts/host-probes/native-replacement/http-adapter.ts `
  --target=bun --outdir $env:TEMP\sp-native-replacement-transpile
# Bundled 3 modules
```

The full test suite, full typecheck, install, host run, and any native UI observation were
not run.

## Remediation map

| Item | Correction |
| --- | --- |
| 1 | Old baseline now requires canonical active before any import; already-archived and unknown states block. |
| 2 | Canonical `time.archived` number/absent normalization requires valid `time.created`/`time.updated`; top-level boolean rejected; candidate unknown is partial and refuses archive. |
| 3 | Exact fixture/message key and text allowlist; no extra props/tool parts; import payload rebuilt from whitelisted fields only. |
| 4 | HTTP response byte cap before JSON parse; message/session list caps; fixed sanitized errors; tests for oversized body/JSON/list. |
| 5 | Candidate-ID lookup before import; only `NotFoundError` permits import; present or ambiguous lookup blocks. |
| 6 | Archive timeout/error follow-up read-only classification; observed archived may continue; active/unknown stop; no retry/delete; both roots retained. |

## Remaining execution gate

1. Independent safety review of this module and the proposed host adapter.
2. Supply the current authenticated OpenAPI path set and an injected request/port. Do not
   guess endpoints or embed credentials.
3. Use a disposable synthetic host root with fresh unique IDs. Do not use real history.
4. Run the API sequence and require canonical `time.archived` readbacks. If the public client
   strips the field, record `UNSUPPORTED`/`unknown`, not success.
5. Observe native picker/tab/route/composer manually in a separate reviewed run. Do not
   submit a draft, call a model, or infer visibility from list counts.
6. After verified forced stop, reuse the existing reviewed runner for any disposable-root
   cleanup. No public delete from this module.
