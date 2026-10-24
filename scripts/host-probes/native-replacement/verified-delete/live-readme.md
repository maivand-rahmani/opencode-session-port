# Live verified-delete entry (M1 parent lane)

Status: **implemented and offline-tested only**. This lane did not launch a host, container, Docker
build, database, API server, Git command, model, tool, or prompt endpoint. No delete has been
executed against a real host. The parent/owner plus one independent destructive review is required
before any actual run.

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
- No archive fallback, no CAS claim, no automatic restore, and no native restore is attempted after
  restart. `nativeRestore` remains `not-proven`.
- This is an isolated fresh-profile probe under manual quiescence, **not a general host safety
  claim**. The host's own recursive child removal is outside this lane's proof.
- The key is parent-process memory only. It survives a child host restart, not a parent process or
  machine restart. No production durability, secure-erasure, or compatibility claim is made.
- Diagnostics contain fixed stages/reasons/counts and digests only. No message text, paths, password,
  key, or raw error is written to stdout or files.

## Tests

```powershell
node --test scripts/host-probes/native-replacement/lifecycle/lifecycle.test.mjs   # 26 pass
bun test scripts/host-probes/native-replacement/verified-delete/live-entry.test.ts # 8 pass
```

The 23 pre-existing lifecycle cases are preserved; 3 delete-capability cases were added. The existing
7 recovery tests are not duplicated. Pagination regressions cover terminal object, terminal null,
continuation/exhaustion, duplicate IDs, repeated cursors, malformed/unknown cursors, and a foreign
session hidden on a second page, all with zero DELETE.
