# M3 quota-provision policy — 2026-10-24

**Status:** local source/config evidence only. No deployment, live database, or
quota-provision proof is claimed.

## Owner decision

The owner approved one narrow explicit opt-in for the approved device exchange:
cloud composition may create a `UserQuota` row for an approved account that has
none, only when the operator explicitly configures the optional backend policy
field `initialStorageLimitBytes`. This is not an auto-provision default, not a
billing/admin approval, and not a production-deployment approval.

- Existing limits and counters are **never** overwritten. The core repository
  implementation (fix106, parent-owned) enforces create-if-missing only.
- Omitting the field preserves legacy behavior: exchange returns
  `quota-not-provisioned`; no default quota is invented.
- The 1 GiB value used by the test policy is a **test-only** reviewed value. The
  1 GiB planning default remains planning documentation outside this validation
  policy.
- No schema change, migration, or OpenCode-database write is part of this work.

## Implemented local changes

- `cloud/api/src/runtime/config.ts`: `BackendPolicy` gains optional readonly
  `initialStorageLimitBytes?: number`. `readBackendPolicy` still requires the
  exact seven legacy positive safe-integer bounds, additionally accepts only the
  optional positive safe-integer `initialStorageLimitBytes`, and rejects unknown
  keys plus `0`, negative, fractional, unsafe, string, `null`, boolean, array, or
  object values. Absence produces no policy property.
- `cloud/api/src/runtime/cloud.ts`: adds a focused `nativeAuthServiceFactory`
  test seam. Cloud composition passes `initialStorageLimitBytes` to
  `createNativeAuthService` only when configured, converted with `BigInt` at
  that boundary; existing cap mappings, readiness, identity, native config, and
  health-only behavior are unchanged.
- `cloud/api/test/runtime/{config,cloud}.node.ts`: focused config/composition
  coverage.

## Validation evidence

- Focused runtime tests: `node --import tsx --test test/runtime/config.node.ts
  test/runtime/cloud.node.ts` — 18 tests passed, 0 failed.
- Config cases: legacy seven-field policy accepted with no quota field; explicit
  `1073741824` accepted and preserved; invalid/unknown values fail closed;
  health-only still ignores malformed backend policy.
- Composition cases: factory receives `1073741824n` only for the explicit
  policy; legacy config passes no own `initialStorageLimitBytes` property.
- Typecheck (`npm run typecheck` in `cloud/api`): the only errors are four
  pre-existing/core-owned `FakePrisma.options` errors in
  `test/native-auth/service.node.ts`. No error was reported in
  `src/runtime/config.ts`, `src/runtime/cloud.ts`, or the focused runtime tests.
  Final terminal typecheck is coordinated by the parent with fix106.

## Test-policy snapshot

`.package-verify-work/m3-quota-provision-config-20261024/` is a new non-secret
snapshot. Its `config/test-only-values.json` is a byte-level copy of the
historical reviewed snapshot plus exactly:

```text
    "initialStorageLimitBytes": 1073741824,
```

- Historical source hash `44ba4536...` is preserved unchanged in the historical
  snapshot/provenance; the new copy hash is `a8781b75ca9b89c1b805f5e394d0d54e1ccca10b7bb91ff101f5ef224792ee97`.
- Removing that exact line reconstructs the `44ba...` bytes; provenance records
  the field-only delta rather than claiming the old hash still applies.
- A future local stage must copy these exact bytes/provenance and load this path;
  hash mismatch or missing files are blockers, never a fake pass.

## Boundaries and blockers

- Core `NativeAuthServiceOptions` did not include `initialStorageLimitBytes` at
  this lane's implementation time; fix106 owns that file and its tests. The
  composition option is wired for that interface. No core file was edited.
- Remote deployment/control remains blocked by an observed HTTP 401. No retry,
  credential guess, Git command, remote API call, database/vault access, or
  private-file read/write was performed.
- No runtime artifact or historical snapshot file was overwritten.

## 2026-10-25 addendum — live isolated PG proof and deployment (supersedes the 2026-10-24 "no deployment / 401 blocked" status for this bounded lane only)

- Result: [result.json](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/result.json) (`5462` bytes, SHA-256 `0cf94881b102bb78a1ee0863c6009d5760bf547faa61a87792d3621e41f94117`). New isolated image `sha256:c8bd046e364822481e038e8a36e4682c793a7175fa63a091afb57fd289c7562c`, built once from base `sha256:07a2d59b...f2ca79` with `--pull=false --network none`; policy `a8781b75...ee97` (historical `44ba...` preserved); launcher artifacts manifest `8c02a74d...170b`.
- Source-hash proof on the actual image: the four COPY files match `69812cff...` (repository), `1fd2cb5a...` (service), `43071c10...` (config), `8c2d8960...` (cloud) with `1000:1000:444`; unchanged BFF/CSP/browser-routes/next-config compare equal base-vs-new, gateway HMR artifact `f65e9f94...` unchanged.
- Live PostgreSQL proof: **42/42** checks true on the actual new image against the existing isolated validation cluster under the restricted runtime role. A fresh account without a quota row provisioned exactly `limitBytes=1073741824`, `usedBytes=0`, `reservedBytes=0`; an existing quota (`2048/17/5`) was preserved exactly; 1 active grant plus 3 concurrent approved exchanges produced 2 fulfilled and 1 bounded `state-conflict` refusal with active grants `3`, never exceeded; exact tracked fixtures were deleted in FK-safe order and scoped counts returned to zero (`2/2/4/4/4/4/5 -> 0` each).
- Deployment is isolated validation only: old app `c56325eb...` stopped and preserved; `--check` container `a939fa07...` exit `0` with `M3_CHECK=PASS` and `REVIEWED_POLICY=exact`; new START container `9e5416f1...` running with the exact new image, the two approved networks, four approved mounts, uid `1000`, read-only rootfs, cap-drop ALL, no-new-privileges, pids `512`, memory `1536 MiB`, cpu `2`, restart `no`, and `127.0.0.1:43117` only. Probes: live `200`, ready `503` with `Retry-After: 5`, login `200` with dev CSP nonce + `'unsafe-eval'`, static `200`, HMR `101`.
- No main database, owner account, OAuth login/callback replay, production surface, or non-isolated environment was touched. The earlier no-deployment/401 statements above remain historical for that local lane; this addendum does not assert production readiness.

## 2026-10-25 addendum — owner-reported native Windows OpenCode 2.1.1 run (owner-provided, not independently verified here)

- Owner report: commands `3/3`, `stopVerified=true`; exchange sequence `login=signed-in`, `terminal=signed-out`, `status=signed-out`, begin `200`, pollLast `200`, token `200`, error `none`, `vaultCommit=controller-result-signed-in`.
- Vault: `preflightAbsent=true`, `bindingLoaded=true`. Commit evidence is **controller-result only**; no independent vault readback, post-commit value read, or restart persistence is claimed.
- Cleanup: `attempted=true`, `presence=false`, `removed=false`, `cleanupVerified=true`, `rootRemoved=true`.
- A browser screenshot (owner-provided) shows a native signed-in dialog and an active server device. No identity, email, deviceID, credential, or screenshot content is transcribed or stored in this repository.
- Claim boundary: the recorded status is `signed-out` and its order relative to the exchange is ambiguous, so **no pre-logout `signed-in` status is claimed**. Local logout is recorded as intentionally not revoking the server grant.
- **M3 remains `Partial`.** Still open: explicit pre-logout status, restart/locked-store persistence, refresh, revoke, and session/CSRF acceptance.
- Documentation only: no new tests, source changes, artifacts, files, remote actions, or Git operations were performed for this addendum.

## 2026-10-25 addendum — encrypted local state/outbox implementation (M3 remains Partial)

- Implemented the approved local state/outbox core and production composition boundary `openLocalState`: fixed `state.v1.enc`, fixed `67,108,909`-byte envelope cap, selected SPST codec, and vault-backed separate 32-byte state key. Whole-snapshot mutations are FIFO-serialized; `close` drains accepted work before one lease release. State-key creation occurs only under the existing owner lock and absent snapshot; an existing snapshot with missing/corrupt/tampered state fails closed without key replacement or file overwrite.
- Validation: `bun run typecheck` passed; `bun test tests/cloud/state tests/cloud/state-codec tests/cloud/state-key` = **62 pass / 0 fail / 555 assertions / 4 files**. The generic injected `StateStore.open` remains for tests.
- Cross-lane evidence reused without rerun: [refresh/revoke result](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/refresh-revoke-result.json) (40/40) and [vault restart result](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/vault-restart-result.json) (two-process PASS).
- Limitations: the production factory is not yet invoked by auth or `/sync`; Windows power-loss durability remains unproven (file fsync + rename, no directory fsync), so only process-restart recovery is claimed. **M3 remains `Partial`.**
