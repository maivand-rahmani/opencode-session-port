# Live verified-delete entry (M1 parent lane)

Status: **implemented and offline-tested only**. This lane did not launch a host, container, Docker
build, database, API server, Git command, model, tool, or prompt endpoint. No delete has been
executed against a real host. The parent/owner plus one independent destructive review is required
before any actual run. The remote agent API was unavailable (auth `401`) during this lane, so no
remote host contact was attempted.

## Native restore proof (second fresh host)

After the first isolated run and its restart snapshot both verify, the same parent process starts a
**second, separate fresh isolated host** through the existing `withIsolatedHost` runner. No second
restart is requested: the restore callback returns `status: "verified"`,
`outcome: "native-restore-verified"`, so the runner records its snapshot as `not-run` and the
combined finalizer requires the explicit restore proof rather than trusting runner `status: "ok"`.

In that second host:

- The recovery key is opened from parent memory (`verify` + `recover`), the recovered payload is
  strict-equal to the old checkpoint, and the flat history is validated before import. Injected
  refs, tool fields, parts, or unknown keys fail with `E_RESTORE_SHAPE`.
- The fresh profile inventory must be empty before import. Exactly **one** create-only POST import
  is allowed, with the frozen old session ID and the exact two old message IDs. The second allowed
  dummy session ID is never used.
- A scoped wrapper rejects `DELETE`, `PATCH`, and every non-GET verb before any host call, and
  rejects a second import. The lifecycle config for the second host has no `syntheticDeleteTarget`.
- After import, the probe reads the session, both messages, and the inventory back. It requires the
  exact old message IDs/content/roles/order/timestamps, the recovered session creation time, title,
  parentless root, no fork/revert/archive refs, a canonical project, and zero ID collisions.
- The recovered `projectID` is only a hint: the check compares the import response project with the
  GET project in the fresh host, never the original host project ID. The location is retargeted to
  the fresh profile working directory (a recorded normalization); `time.updated` is host-assigned.
- The parent-memory key is destroyed only after both isolated hosts have stopped and cleaned their
  private profiles. Any first-run failure skips the restore host, import, and all retries.

## What this lane adds

- `live-entry.ts` wires the existing `withIsolatedHost` runner, the existing verified-delete state
  machine, and the existing real experimental crypto/recovery factory. It contains no mock crypto.
- The old root is seeded explicitly with a POST import, then read back and normalized. The recovery
  payload is built from the confirmed old readback, not from requested fixture values.
- The candidate keeps the complete old ordered text prefix with fresh CSPRNG global message IDs plus
  one distinct tail.
- `lifecycle/runner.mjs` gains one narrow optional capability: `syntheticDeleteTarget`, accepted only
  when it exactly equals `sessionIDs[0]`. A first-phase request may then issue exactly
  `DELETE /api/session/<that frozen old ID>` with no query, no body, and no other verb/path/header
  access. There is no generic HTTP surface.
- Readonly restart ports deny `DELETE` with `E_READONLY` even when the flag is supplied.
- `live-entry.test.ts` uses a fake guarded port with host-like canonical project assignment and
  server-stamped session `time.updated`. It exercises the real in-process crypto/recovery port.

## Pagination contract (pinned 2.1.3)

The first isolated run failed `E_INVENTORY_PAGING` before any DELETE because the adapter treated a
non-null `cursor.next` as unexpected. The public 2.1.3 contract shows both list endpoints return
`{data, cursor:{previous?, next?}}`, and the server sets `next` from the last item of **every
non-empty page**, including the final item. A non-empty page is therefore not terminal. Only an
empty page has both positions absent; `cursor` itself is the same response object (`{}` when empty)
and is not a continuation token.

The fix follows only the documented `next` position, using a continuation request without `order`
(the cursor carries it) and without accumulating `previous`. It stops on the empty page. Session and
message pages have separate follow loops. The fixed probe control is at most 8 pages, 8 sessions, and
8 messages for the two-root/three-message fixture; this is a test-only bound, not a product client
limit. Duplicate IDs, repeated cursors, cap overflow, malformed/unknown cursor objects, extra pages,
and foreign entries stop before DELETE. A null terminal cursor is accepted only on an empty page.

## Sequence

1. GET the pinned host's OpenAPI and require the delete-capable session surface.
2. Seed the frozen two-message old root through the public import endpoint.
3. Confirm canonical project assignment and require the host-stamped `time.updated` to fall inside
   the measured import window while `time.created` is preserved. The normalized old payload uses the
   actual readback values.
4. Build the old `CheckpointPayload`, seal it once through the existing experimental crypto factory,
   and hold the CSPRNG key only in parent memory.
5. Run the existing pure `runVerifiedDelete`: old baseline, recovery verify, candidate 404, candidate
   import, strict prefix/tail readback, recovery verify, old unchanged, exact two-session inventory,
   one frozen-old DELETE, readback, candidate unchanged, recovery recover.
6. Only `delete-verified` produces the marker `outcome: "api-verified"` and
   `restartManifestReady: true`, backed by a validated internal manifest:
   `{oldID, newID, canonicalProject, oldPayloadDigest, newPayloadDigest, expectedCounts}`.
7. The runner restarts the same profile and invokes the readonly snapshot: old GET is 404, candidate
   history/project/prefix/tail are still strict, inventory is candidate-only, and recovery
   `verify`/`recover` match the expected old payload exactly.
8. Exit `0` only when the probe is API-verified, the manifest is valid, the snapshot is verified, and
   both owned stops are verified. A blocked or failed probe skips restart and preserves its fixed
   reason. An ambiguous delete is reconciled read-only, never retried, and never reported as success.

## Scope and limits

- The fixture is flat, parentless, settled, text-only, and bounded to exactly two sessions: old (2
  messages) and candidate (3 messages). Any extra root, child, fork, revert, non-text part, foreign
  inventory entry, paging cursor, or unsettled message blocks with zero DELETE.
- No archive fallback, no CAS claim, and no automatic restore in the first host. The native restore
  is the separate second-fresh-host proof described above; it is not a first-host snapshot action.
- This is an isolated fresh-profile probe under manual quiescence, **not a general host safety
  claim**. The host's own recursive child removal is outside this lane's proof. Candidate
  preservation is only the private profile lifetime; no production retention or durability is
  claimed.
- The key is parent-process memory only. It survives a child host restart, not a parent process or
  machine restart; parent death loses the key and the ciphertext is unrecoverable. No production
  durability, secure-erasure, or compatibility claim is made.
- Diagnostics contain fixed stages/reasons/counts and booleans only. No message text, paths,
  password, key, or raw error is written to stdout or files.

## Tests

```powershell
node --test scripts/host-probes/native-replacement/lifecycle/lifecycle.test.mjs   # 28 pass
bun test scripts/host-probes/native-replacement/verified-delete/live-entry.test.ts `
  scripts/host-probes/native-replacement/verified-delete/state-machine.test.ts `
  scripts/host-probes/native-replacement/verified-delete/recovery.test.ts          # 39 pass
```

The 17 state-machine and 7 real-crypto recovery tests are preserved; 15 live tests include the
fresh-host native restore, wrapper rejection, injected-tool/ref blocking, first-failure skip, and
restore-drift non-zero cases. The 28 lifecycle cases are preserved.

## Current bundle

- Path: `.package-verify-work/m1-encrypted-recovery-20261024/live-entry.bundle.mjs`
- Bytes: `807620`
- SHA-256: `35cd5bab32de17a7e81ee3c905edca4f293bfbed8df35e1659e36badd2985fa0`
- Node ESM, single file, libsodium WASM inlined, latest `live-entry.ts` plus runner.
- `node --check`: pass. Import: pass with no auto-execution.

Prepared but **not run** (remote auth unavailable; no `--rm`, container/profile retained):

```sh
docker run --name sessionport-m1-native-restore-r1 --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user 1000:1000 --pids-limit 256 --memory 1g \
  --tmpfs /run/sessionport:rw,noexec,nosuid,nodev,size=64m,mode=700,uid=1000,gid=1000 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=700,uid=1000,gid=1000 \
  --mount type=bind,src=/srv/sessionport-artifacts/live-entry-native-restore-r1.bundle.mjs,dst=/app/live-entry.bundle.mjs,readonly \
  node /app/live-entry.bundle.mjs
```
