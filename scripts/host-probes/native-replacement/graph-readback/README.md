# Graph import/readback probe (nondestructive M1 lane)

Status: **built and offline-tested only.** This lane did not launch a host, container,
Docker, database, API server, Git command, model, provider, tool, or network request. The
future live run is parent-gated on the exact pinned 2.1.3 schema.

## Scope

One bounded synthetic graph: `root -> child -> grandchild`, plus an optional fork session
whose `info.fork` references the root and a `through` boundary at the root assistant
message. The grandchild optionally carries a `revert` reference. Assistant messages carry
one text part and, when its exact schema is detected, one completed tool part on the root
and one error tool part on the child. Maximum four sessions and eight messages. No
delete, patch, archive, fork endpoint, prompt, tool execution, model call, config, or
database access.

The fixture is static and explicit. Native import bodies use the observed public schema
fields `parentID`, `fork: {sessionID, boundary}`, and `revert: {messageID}`. There is no
invented `forkID` property and no generic migration or fixture framework.

## Lifecycle and request surface

- The existing `withIsolatedHost` lifecycle starts one fresh isolated profile on the
  pinned host. The probe supplies its generated password explicitly so the existing
  `createRequestPort` can be instantiated for the second frozen two-ID group.
- No snapshot callback is configured, so no restart is requested. The runner reports
  `snapshot: {status: "not-run"}` with its expected `probe-not-verified` reason because this
  probe deliberately never claims `outcome: "api-verified"` or a restart manifest.
- The outer guard allows only:
  - `GET /openapi.json`
  - `GET /api/session?limit=...&order=...` (and cursor continuation)
  - `GET /api/session/<frozen-id>`
  - `GET /api/session/<frozen-id>/message?order=asc&limit=...` (and cursor continuation)
  - exactly one `POST /api/experimental/session/import` per frozen session ID.
- `DELETE`, `PATCH`, `PUT`, foreign paths/IDs, and every other mutation are rejected
  before the underlying port is called. The lifecycle ports are not modified.
- Final success requires runner `status: "ok"`, `cleanup: "profile-removed"`, the explicit
  probe outcome `graph-verified`, `verified: true`, absent side-effect sentinel, no probe
  failure, and the expected no-restart snapshot state (`not-run`). Runner exit `0` alone is
  never accepted.

## Runtime schema detection

The probe fetches the actual public `/openapi.json` first and resolves only local
`#/components/...` references. It records structural booleans for:

- import endpoint and `info.parentID`;
- `info.fork.sessionID` and a boundary union containing `before`/`through` with
  `messageID`;
- `info.revert.messageID`;
- user and assistant text message variants;
- assistant tool part with completed and error states and text tool content.

If the import endpoint, parent chain, or user/assistant text shape is absent, the probe
performs **zero** imports and returns `graph-unsupported`. If an optional fork, revert, or
tool shape is absent, that component is `not-supported` and the outcome is `graph-partial`,
never success. A host rejection or an unconfirmed persistence shape is reported as
`unsupported`/failure, not as verified.

## Readback checks

After all imports, the probe enumerates the full isolated inventory and reads every
session and every message in ascending order.

- Exact root/child/grandchild/fork session IDs and count; no foreign session.
- Exact user/assistant message IDs, types, order, text, `time.created`, and assistant
  `time.completed`; exact content arrays including tool part IDs, names, state input,
  completed content, error payload, and part timestamps.
- Canonical host-assigned project must be identical across imported response, session
  readback, and every graph session.
- `time.created` is preserved exactly. `time.updated` is host-assigned and must fall
  inside the measured per-import window. The location is retargeted to the fresh profile
  directory (recorded normalization).
- Parent, fork-source, fork-boundary, and revert references must resolve inside the
  observed graph and inside the owning session's ordered messages. Unknown or dangling
  references fail closed.
- Per-session message payload digests and parts payload equality are checked; output is
  counts/booleans only, never raw message text, tool input, IDs, or hashes.

Accepted normalizations are limited to host `projectID`, host `time.updated`, and the
fresh-profile `location`. No other host rewrite is silently accepted.

## Non-replay sentinel

The completed and error tool parts contain inert tool input that would `touch` a unique
sentinel file inside the fresh profile if any machinery replayed historical tools. The
probe checks the sentinel is absent before import and after readback. The live command is
planned with `--network none`; the probe itself executes no shell command, tool, provider,
or network client. No historical tool is replayed, and no general non-replay property is
claimed.

## Negative coverage

Duplicate IDs, dangling parent/fork/revert references, unknown references, projection
mismatches, dropped fork persistence, project mismatch, and blocked mutation requests are
unit-tested offline. No live duplicate or dangling mutation is performed without a
separately proven atomicity contract.

## Runtime matrix (planned, not executed)

| Case | Required detected schema | Success evidence |
| --- | --- | --- |
| root -> child -> grandchild | import + `info.parentID` + user/assistant text | exact IDs, parent refs, messages, roles, order, project, timestamps, location |
| fork | `info.fork.sessionID` + `boundary` `before`/`through` + `messageID` | fork session imports, readback fork ref exact and boundary resolves |
| revert | `info.revert.messageID` | grandchild readback revert exact and message resolves in-session |
| completed tool part | assistant tool content + `completed` state `input`/`content` | exact part payload digest and sentinel absent |
| error tool part | assistant tool content + `error` state `input`/`error` | exact part payload digest and sentinel absent |
| absent optional shape | any of the above missing from actual OpenAPI | `not-supported` / `graph-partial`, never success |
| dropped ref | import accepted but readback omits fork/revert | `unsupported` / `graph-partial`, never success |
| host rejection | import/readback contract violation | fail closed with a fixed code |

## Focused tests

```powershell
bun test scripts/host-probes/native-replacement/graph-readback/entry.test.ts   # 20 pass
node --test scripts/host-probes/native-replacement/lifecycle/lifecycle.test.mjs # 28 pass (unchanged)
```

The new suite covers actual `createRequestPort` readonly DELETE/PATCH/import denial, the
outer guard scope and one-import cap, exact projection and payload/parts hashes, reference
closure, duplicate/dangling/unknown refs, schema unsupported classification, dropped fork
persistence, combined status/cleanup gate, and wire parsing.

## Future hardened command (not executed)

```sh
docker run --name sessionport-m1-graph-readback-r1 \
  --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user 1000:1000 \
  --pids-limit 256 --memory 1g --workdir /run/sessionport \
  --tmpfs /run/sessionport:rw,noexec,nosuid,nodev,size=64m,mode=700,uid=1000,gid=1000 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=700,uid=1000,gid=1000 \
  --mount type=bind,src=/srv/sessionport-artifacts/graph-readback.bundle.mjs,dst=/app/graph-readback.bundle.mjs,readonly \
  /usr/local/bin/node /app/graph-readback.bundle.mjs
```

Parent must first verify the pinned image (`sha256:118cc62f...f31192`, OpenCode `2.1.3`),
stage the bundle hash, and gate the run on the actual 2.1.3 schema matrix above. No `--rm`;
any container/profile remains parent-owned for inspection.
