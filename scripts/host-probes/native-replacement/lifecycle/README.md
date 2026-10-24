# Isolated lifecycle runner (M1)

Status: offline implementation, entry wiring, and bundle checks only. No container, host,
network, database, Git, install, or credential access was performed by this lane.

This directory is self-contained at runtime, but the parent entry now imports the stable
native-replacement root modules and the lifecycle runner and is bundled into one Node ESM
artifact under `.package-verify-work/m1-isolated-lifecycle-20261024/integration/`.

## Files

- `runner.mjs` — Node-builtin inner lifecycle runner. It starts the pinned foreground binary
  by absolute path, verifies `/api/info` version `2.1.3` and the required OpenAPI paths, then
  exposes a fixture-gated request port to an injected probe callback. It owns one verified
  stop, a second serve on the same fresh profile, a readonly snapshot callback, a second
  verified stop, and profile cleanup.
- `entry.ts` — parent entry wiring. It generates two fresh CSPRNG synthetic IDs, imports the
  old root explicitly, runs the native-replacement state machine, and validates the readonly
  restart snapshot. It is bundled for Node; it never reads auth directly.
- `entry.test.ts` — offline integration tests with a fake guarded port.
- `launch-plan.mjs` — builds and verifies a guarded `docker run` argv. It never executes
  Docker.
- `Dockerfile` — probe image build. `NODE_IMAGE` must be an immutable Node 22 digest supplied
  by the outer launcher; the CLI and platform package are pinned to `2.1.3` with registry
  integrity checks before install. It copies the integration bundle and sets the Node ESM CMD.
- `lifecycle.test.mjs` — offline tests using injected spawn, fetch, fs, and clock doubles.

## Run

```powershell
node --test scripts/host-probes/native-replacement/lifecycle/lifecycle.test.mjs
bun test scripts/host-probes/native-replacement/lifecycle/entry.test.ts
```

## Archive feature gate

`verifyOpenApiArchiveContract` runs before any import. It requires:

- `PATCH /api/session/{sessionID}` request body property `archived` accepting boolean.
- `GET /api/session` query parameter `archived` with string enum `"true"`/`"false"`.
- `Session.Info.time` with required numeric `created`/`updated` and optional numeric
  `archived`.

Only local `#/components/{schemas,parameters,requestBodies,responses}/...` refs are resolved,
with bounded depth. Remote refs fail as `E_CONTRACT`; missing archive features fail as
`E_UNSUPPORTED` before any import.

## Wrapper contract

```js
withIsolatedHost({
  sessionIDs: [ses_a..., ses_b...], // exactly two distinct fresh synthetic IDs
  binaryPath: "/usr/local/bin/opencode",
  profileBase: "/run/sessionport",  // absolute container path
  authEnv: "OPENCODE_PASSWORD",     // or "OPENCODE_SERVER_PASSWORD"
  limits: {},                       // bounded overrides only
  snapshot: async ({ request }) => {}, // optional, readonly port
}, async ({ request, sessionIDs, profileDir, phase }) => {
  // probe entry: import, readbacks, archive/unarchive only
})
```

`request` accepts only:

- `GET /api/info`, `GET /openapi.json`
- `GET /api/session` with bounded list query, including `archived=true|false`
- `GET /api/session/:id` for one of the two fixture IDs
- `GET /api/session/:id/message?order=asc` for one of the two fixture IDs; any other message
  query, including an omitted or descending `order`, is rejected
- `POST /api/experimental/session/import` with `info.id` one of the two fixture IDs
- `PATCH /api/session/:id` with exactly `{ archived: boolean }` for one of the two IDs

A 404 from a scoped GET is surfaced as the fixed `E_NOT_FOUND` code; the entry maps it to the
root `NotFoundError` only for the candidate-absence preflight. Other HTTP failures remain
fixed non-404 codes.

Prompt, command, shell, tool, delete, config, managed-service, and arbitrary paths are
rejected before any fetch. The restart snapshot port is readonly and rejects both import and
PATCH. Bodies and responses are capped; errors are fixed codes and never include the password
or child environment.

The child receives an exact whitelist: `PATH`, fresh `HOME`/XDG directories,
`OPENCODE_CONFIG_DIR`, three disable flags, and one auth variable. It never inherits provider
keys. The 32-byte CSPRNG password is generated in memory and never placed in argv, result JSON,
or a persistent file. Child stdout/stderr are never decoded or retained; only byte counters,
overflow flags, and presence flags are returned.

## Lifecycle and retention

1. Create a fresh profile under `profileBase`.
2. Spawn `opencode serve --hostname 127.0.0.1 --port 4096` with pipes.
3. Wait bounded for `/api/info` and verify version + OpenAPI paths.
4. Call the probe callback on the first serve and retain its sanitized result.
5. SIGTERM the owned child and verify exit.
6. Only if the probe outcome is `api-verified` and a bounded, validated restart manifest is
   present, start a second serve on the same profile and call the readonly snapshot callback;
   otherwise record snapshot `not-run` with a fixed reason and skip the restart.
7. SIGTERM and verify any second exit.
8. Remove only the owned profile directory.

The snapshot callback labels each readonly step (`old-info`, `new-info`, `old-messages`,
`new-messages`, `active-list`, `archived-list`) and returns only counts and field-presence
booleans, never message content, headers, auth, or raw errors. A failed snapshot step returns
the first probe result plus a fixed step/error category instead of replacing it with an opaque
`E_SNAPSHOT`. A not-run or failed snapshot makes the final verification status nonzero. If
either stop cannot be verified, the profile and container are retained, the failure carries the
first-probe and snapshot phase facts, and there is no cleanup. There is no SIGKILL, Ctrl+C, or
manual-kill fallback. The outer launcher owns container removal and must retain the container
on `E_STOP_UNCERTAIN`.

The sanitized probe result exposes the state-machine blocker only through a fixed allowlist
(including `list-archived-filter:` with a known enum suffix); unknown values become `unknown`
and no arbitrary blocker text is emitted. When the old-root baseline blocks, the result also
carries a diagnostic-only `baseline` object with fixed subcheck booleans (`returnedSessionID`,
`parentAbsent`, `titleMatch`, `archiveActive`, `projectIDMatch`, `directoryMatch`,
`messageCountMatch`, `orderedIDsMatch`, `messageRoleMatch`, `userTextMatch`,
`assistantContentMatch`) plus bounded counts, roles, and field-presence flags. It never includes
message text, headers, auth, raw errors, or child output, and it does not change the acceptance
predicate.

## Docker command plan

`buildDockerRunPlan` requires a bare `sha256:<64 hex>` image ID. The outer launcher resolves the
approved immutable Node 22 image from the pending fix75 output and builds with
`NODE_IMAGE=node:22@sha256:de636e50060a9908cf40a20a50d027ed74a99b2e31d2635f3b13e9e4e5e97e74`;
no image ID is guessed here. The Docker build context
is the closed integration `build-context/` directory containing exactly `Dockerfile` and
`entry.bundle.mjs`; the Dockerfile copies the bundle from the context root and sets
`CMD ["node", "/opt/sessionport/lifecycle/entry.bundle.mjs"]`. The run plan uses
`--network none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`,
`--pids-limit`, `--memory`, fresh tmpfs mounts for the profile and `/tmp`, and a non-root UID.
It contains no host port, no host mount, no env injection, no `--rm`, and no `--privileged`.
`verifyDockerRunPlan` rejects any of those additions. Pass
`entry: "/opt/sessionport/lifecycle/entry.bundle.mjs"` when building the plan; do not use the
`entry.mjs` default.

The exact offline bundle/build/run commands and the bundle SHA-256 are in
`.package-verify-work/m1-isolated-lifecycle-20261024/integration/README.md`. The timestamp
fix bundle for the next probe is
`.package-verify-work/m1-import-time-diagnostic-20261024/build-context/entry.bundle.mjs`
(64,658 bytes, SHA-256 `b6f9198ede041e595f380baec118f1b508409394a9c90f8c7747093de2b7ab28`).

## Old-root import timestamp contract

Observed on the pinned 2.1.3 runtime (image
`sha256:052f9f37c34362e6d5783691b9ce2cd5a0a57dc3de3f73d76e4777e9e3c85461`, 2026-10-24
diagnostic: one synthetic root `POST /api/experimental/session/import`, then two
`GET /api/session/{id}`):

- `created` is preserved exactly from the import payload.
- `updated` is replaced with the server's import timestamp. It was measured 11 ms after the
  pre-import `Date.now()` and 8 ms before the post-import `Date.now()` (same-container clock,
  19 ms import window).
- `idle` remains the payload value; the import response `time.updated` equals the first GET,
  and both GETs returned stable `created`/`updated`/`idle` values.

The 2.0.22 source clone preserves `created` and sets `updated` to `importedAt`; the 2.1.3
runtime behavior above is now observed rather than inferred from that source. The old-root
check therefore requires `created` exact and `updated` finite within the measured import
start/end window. It rejects the payload `updated` value, out-of-window values, missing
values, and non-finite values; no fixed millisecond allowance is used because the same
`Date.now` clock produced an in-window stamp with no quantization. The existing adapter only
exposes the import response `id`, so that id is checked against the synthetic root; import
response time is not available through the current interface. The strict new-history and
archive checks are unchanged. Native UI, composer, permissions, and ordinary continuation
remain unobserved.

## Canonical host project binding

The host owns project metadata and may replace the synthetic import `projectID`. After the
old-root import, the entry pins the canonical public project ID from the import response and
requires the first old-root readback to report the identical value. Missing, oversized
(>128 bytes), invalid, or mismatched IDs fail with `E_PROJECT_ID` before any candidate work;
there is no fallback to the original synthetic project ID. The candidate import payload then
uses that canonical ID, and both restart readbacks must still report it. Message identity,
order, roles, text/content, timestamps, directory, parentless, and archive predicates are
unchanged.

## Open contract item for independent review

The strict archive feature gate checks the live 2.1.3 shape before any import: PATCH
request body `archived` accepts boolean, list query `archived` is the string enum
`"true"`/`"false"`, and `Session.Info.time` has required numeric `created`/`updated` plus
optional numeric `archived`. Missing features return `E_UNSUPPORTED`; remote refs return
`E_CONTRACT`. Timestamp readback is now observed as described above; the native UI remains
to be observed in the approved run.

## Minimum wiring remaining

1. The parent entry module and bundle are present. The outer launcher still must validate the
   fix75 Node 22 digest, verify the closed build-context allowlist, build the image with that
   context, generate a fresh container name, run the guarded argv with
   `entry: "/opt/sessionport/lifecycle/entry.bundle.mjs"`, capture only non-secret result
   data, and retain the container on stop uncertainty.
2. Obtain independent safety review before any actual server probe. No actual Docker build,
   host run, API request, or remote transfer is part of this lane.
