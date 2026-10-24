# Verified delete adapter (M1 offline lane)

Status: implemented and unit-tested only. No live port, host launch, API call, or real
delete has been executed. The only `removeSession` invocation is against the in-memory test
fake. This is a partial M1 gate, not a safe automatic deletion path.

This lane models one narrow claim: after an old root is read and verified, a fresh candidate
that carries the old ordered history prefix plus one distinct tail is imported, the old root
is deleted once, and the candidate plus recovery payload remain verifiable. Every unsupported
graph or readback is blocked before delete. Manual quiescence of the isolated host is assumed.

## Files

- `contract.ts` defines `RecoveryPort` and the injected `VerifiedDeletePort` surface.
- `fixtures.ts` builds the exact two-root, text-only fixture and its normalized checkpoint
  payload. It also validates the allowlist before any port call.
- `state-machine.ts` runs the offline sequence and returns fixed reason/phase/count metadata.
- `state-machine.test.ts` covers the success path and every offline failure class.
- Recovery implementation (`recovery.ts`) and its tests belong to a separate lane. This lane
  only consumes the structural interface.

## Run

```powershell
bun test scripts/host-probes/native-replacement/verified-delete/state-machine.test.ts
```

## Recovery contract

`RecoveryPort` is structural:

```ts
verify(expected: CheckpointPayload): Promise<boolean>
recover(): Promise<CheckpointPayload>
destroy(): void
```

The implementation receives the old `CheckpointPayload` through its constructor and uses the
existing crypto path. `verify` and `recover` must not accept field truth from an untrusted
caller. This lane supplies the fixture-derived old payload and treats only an exact structural
match from `recover()` as success. A recovery failure after a confirmed delete is reported as
`recovery-failed` or `recovery-mismatch`; it is never presented as an undo of the delete and
this module never restores the old root.

## Supported scope

The fixture is flat, settled, text-only, and bounded to two roots:

- old root: two messages (`user`, `assistant`);
- candidate: the complete old ordered history prefix with fresh global message IDs plus one
  distinct user tail (three messages) and a new native session ID.

The candidate prefix preserves role, text, and timestamps exactly. Only documented native ID
fields may differ on import readback, and the only metadata normalized explicitly is the
server-stamped session `time.created`/`time.updated`; project ID is pinned to the caller's
host-canonical project ID. `time` is still validated for an active session, not ignored as an
entire object.

Children, forks, reverts, unknown references, active/pending or streaming state, tool parts,
extra fields, and any foreign inventory entry are outside the supported scope and fail closed
before delete. The fixture has no destructive cascade to test, so no cascade behavior is
claimed.

## Sequence

1. Validate the frozen fixture IDs, exact allowlist, and old-root readback.
2. `RecoveryPort.verify(oldPayload)`; failure blocks with zero deletes.
3. Confirm the candidate ID is `404`; present or ambiguous blocks.
4. Import the candidate and require the returned ID to equal the fixture ID.
5. Verify the exact candidate prefix/tail, project pin, parentless active state, fresh unique
   IDs, and the bijective old-message-to-prefix mapping.
6. `RecoveryPort.verify(oldPayload)` again.
7. Re-read the old root and public isolated-host inventory; require the exact old+candidate
   session set and fixture message closure, with no foreign IDs.
8. Call `port.removeSession(oldID)` exactly once with the frozen old ID. No other ID is ever
   passed; there is no batch delete, real-history call, model call, or tool replay.
9. Read the old ID back. `404` means deleted; a present session means not deleted; any other
   error means unknown. No blind delete retry and no candidate delete/revert follow.
10. On confirmed deletion, re-read the candidate, then `RecoveryPort.recover()` and compare
    strictly with the old payload.

A remove timeout/error is classified only by the read-only old GET: applied deletion may
continue after readback; not-applied retains both roots; unknown stops. Readback proves
absence at observation time, not atomic attribution of the delete.

## Result metadata

The result contains a fixed `phase`, `completedPhases`, `outcome`, fixed `reason` code,
booleans, and counts (`removeCalls`, inventory session/message counts). It never includes
message text, paths, passwords, or raw errors.

`retained.oldRoot` is true when deletion is not confirmed (including unknown state), not a
claim that the root is readable. `outcome` is `delete-verified`, `blocked`, `failed`, or
`invalid-fixture`. `safety` states `casClaim: false`, `residual: manual-quiescence-required`,
`automaticRestore: false`, and `inventoryScope: isolated-host-exact`.

The pre-delete re-read catches late old-root edits after the second recovery verify, but a
residual race remains between that final read and the remove call. This is a manual-quiescence
boundary only; it is not compare-and-swap protection and is not safe for concurrent hosts.

## Upstream cascade danger

In the inspected `anomalyco/opencode` 2.0.22 source, `Session.remove`
(`packages/core/src/session.ts`, around lines 355-365) interrupts and awaits idle work, closes
the transport, lists children, and recursively removes each child before publishing the
deleted event. A delete of a parent can therefore destroy more than the requested ID.

This lane does not implement graph migration or child/fork handling. It blocks any parent or
child shape in its two-root fixture and never claims that deleting a supported old root is
cascade-free in an arbitrary host. Any future live run needs a separate reviewed inventory
proof and approval.

## Cleanup and limits

The old root is deleted only by the future approved run; the candidate remains. This lane
performs no cleanup, filesystem action, database write, secret/config change, or host run.
The HTTP/live adapter, integration run, and destructive review are separate lanes.
