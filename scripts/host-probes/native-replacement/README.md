# Native replacement probe (M1)

Status: implemented and unit-tested only. Not executed against a host.

This lane tests one narrow API claim: a fresh parentless synthetic import can coexist with
an older disposable root while the older root is archived, read back, unarchived, and read
back again. It does not delete sessions, submit messages, call a model, write the OpenCode
database, or launch a new host.

## Files

- `fixtures.ts` builds and validates the bounded synthetic fixture. The old root has two
  messages. The candidate has three new messages, including a distinct tail. Every session
  and message ID is unique and synthetic.
- `state-machine.ts` contains the injected `NativeReplacementAdapter` interface, the
  archive/unarchive state machine, the result record, and the restart-manifest parser.
- `http-adapter.ts` is a standalone HTTP adapter, not executed against a host. It takes an
  injected request function, injected headers, injected port/base URL, and current OpenAPI
  path builders. It has no built-in credentials and no hard-coded endpoint assumptions.
- `native-replacement.test.ts` covers success and the offline failure cases.

## Run

```powershell
bun test scripts/host-probes/native-replacement/native-replacement.test.ts
```

## Adapter contract

`NativeReplacementAdapter` has no delete method. The state machine can only read, import,
list, and call `setArchived`. That is deliberate: "never delete" is enforced by the surface,
not by a runtime check.

`setArchived` reports no success. The state machine calls it and then verifies the
canonical `Session.Info.time.archived` readback. A numeric `time.archived` is archived.
A `time` object with valid required `created` and `updated` and no `archived` property is
active under the documented schema. A missing `time`, missing/invalid required fields,
`null`, or a non-numeric archive value is unknown. A top-level `archived` boolean is not
accepted as proof. A 2xx archive response is not evidence.

If the archive request times out or errors, the probe performs one read-only old-root
readback and classifies the observed state as archived, active, or unknown. It never
retries the archive request and never deletes a root. A timeout that is observed applied
can continue; a timeout with active or unknown readback stops with both roots retained.

The old root must be a pre-existing disposable synthetic root. It must be parentless,
canonically active, and match the supplied project/directory and the two frozen old
messages; otherwise the run is blocked before any import.

Before import, the probe looks up the candidate ID. Only an explicit not-found result
permits import; an existing candidate or any other lookup error blocks import. This does
not claim that a global uniqueness guarantee exists: the 2.1.3 import is create-only and a
409 is not a sole-ownership guard.

`listSessions({ archived })` is also readback-only evidence. The HTTP adapter passes the
query value as the documented `"true"`/`"false"` string. An adapter that does not forward
the filter throws `UnsupportedFeatureError`. If both lists contain the old root, or neither
contains it, the result is `not-filtering` or `unverified`, never a pass. List filtering is
never used to infer what the native picker shows.

The fixture is an exact allowlist: known synthetic text blocks, exact top-level and nested
keys, no extra object properties, no tool parts, and unique synthetic IDs. Import payload
construction copies only the whitelisted fields after that validation. Invalid fixtures are
rejected before any adapter call.

The HTTP adapter caps each response body before JSON parsing and caps message/session list
lengths. These are fixed test limits, not production limits. A bounded stream wrapper is
still a later contract change.

## Result meanings

- `api-verified`: old root canonically active before import, candidate lookup absent,
  parentless readback, exact history, archive readback, unarchive readback, and both
  histories verified. The archived list also filtered as requested.
- `api-verified-partial`: the direct API readbacks passed, but archived list filtering was
  unsupported, unverified, not filtering, or errored. This is not a full pass.
- `blocked`: a required readback or transport was unavailable or contradicted the request.
  Both roots are left in place.
- `failed`: import, history, metadata, late-edit, or optional rearchive verification failed.
- `invalid-fixture`: malformed/duplicate IDs, non-allowlisted text, or extra/missing fixture
  or message fields; no adapter call is made.

`native.picker`, `native.route`, and `native.composer` are always `not-observed` or
`not-tested`. `restartReadback` is `not-tested` in the initial run. Actual stop/relaunch is
a separate gate; `validateRestartReadback` validates an externally captured snapshot
without launching anything.

## TUI entry status

No TUI probe entry was added. The pinned local `@opencode/plugin` 2.0.22 surface does not
expose `archived` on the public session update type, and this lane is not allowed to launch
a host or cast a missing client feature into existence. The host-provided 2.1.3 client may
forward the field at runtime, but that cannot be established offline. The HTTP adapter is
the transport artifact until an independent safety review approves a host run and the
runtime public-client readback is observed.

## Interface notes

- `AdapterSession` carries canonical `time?: { created?, updated?, archived?: number | null }`.
  `archiveState()` derives `active` only when required `created` and `updated` are valid
  numbers and `archived` is absent; it derives `unknown` from missing/invalid required time,
  `null`, or a non-numeric archive value. A top-level boolean is not accepted.
- `NativeReplacementAdapter` keeps the same five methods. Missing sessions must throw
  `NotFoundError`; only that permits the candidate-absent preflight. Archive timeouts should
  surface as `AdapterTimeoutError`; other errors are classified as generic errors.
- The result adds `candidateLookup`, `oldArchiveBefore`, `candidateArchive`,
  `archiveRequest`, and `archiveObserved`.

## Cleanup

The probe leaves both synthetic roots retained. A host-owned disposable fixture cleanup may
remove them after the existing reviewed stop/readback lifecycle is verified; this lane does
not call a public delete or perform filesystem cleanup. Result JSON and the restart manifest
contain bounded synthetic IDs, counts, and fixed status labels, not message text or paths.
