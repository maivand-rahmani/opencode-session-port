# M3 runtime acceptance — 2026-10-25 (owner-scoped Windows M3)

**Status: M3 Complete for the explicit owner-approved Windows-only scope (2026-10-25).** AUTH-01, WEB-01, AUTH-02, and AUTH-03 are Complete for that scope. Cross-platform keyring validation and true OS locked-state behavior remain `PLATFORM-FOLLOWUP-01`; `openLocalState` factory wiring belongs to SYNC-01; presigned-URL outstanding behavior belongs to STORE-02/M4. **M1/HOST-01 remains BLOCKED/unchanged; this decision does not loosen M1.**

## Owner decision

On **2026-10-25**, the owner explicitly scoped M3 to **Windows-only** and accepted the existing Windows keyring/tests plus the source-only `openLocalState` factory 62-test evidence (commit `dc4f0bd`), with the final real Windows credential-vault probe closing AUTH-02. This is an explicit requirements-scope change, not a claim that the original cross-platform/true-locked/factory-wired criteria passed.

## Final vault evidence

[`windows-credential-vault-result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/windows-credential-vault-result.json) — **PASS**, exit `0`, SHA-256 **`48E147AFE81A40A71392FC357C9A46D83C4650E04A2A3678A1E57AEA3FFFB625`**.

- **134 pass / 1 skip / 0 fail / 1,193 `expect()` calls across 7 files** (credential probes, `tests/cloud/auth`, keyring).
- Actual Windows x64/Bun 1.3.10, pinned `@napi-rs/keyring@2.1.2`; native SHA-256 `52b16658275b7848f8081a6542fee3448f1b1c5d3a36487107ae0e7cec95ac6f`; all children matched the pin.
- Write child `0`, read child `0`, fault child `0`; all trees stopped; no secret leak.
- Real `CredentialStore` + `CloudAuthController`: A writes synthetic ready credential and verifies exact readback; fault child injects a scoped native-adapter read failure and observes `credential-unavailable` with **no HTTP, retry, write, delete, plaintext fallback, or foreign entry**; fresh child B reads the same entry, reports `signed-in`, local logout yields `signed-out`, direct exact entry absent, and state directory empty after dispose.
- Probe-local `claimLimits` in the result JSON (including its historical "not AUTH-02/M3 completion" line) describe that probe's own boundary; the owner decision above is the current authoritative Windows M3 acceptance.

## Evidence used

| Evidence | Result |
| --- | --- |
| [`windows-credential-vault-result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/windows-credential-vault-result.json) | PASS, 134/134 checks (1 skip), SHA-256 `48E147AFE81A40A71392FC357C9A46D83C4650E04A2A3678A1E57AEA3FFFB625` |
| [`native-client-lifecycle-result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/native-client-lifecycle-result.json) | PASS, 62/62 checks, 14 actual HTTP requests, cleanup zero, SHA-256 `a56428851fa34542335b4adb1156f8f8e9e04859f4cb0c28f4441a655808ea80` |
| [`browser-security-lifecycle-result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/browser-security-lifecycle-result.json) | PASS, 78/78 checks, 29 actual direct-API requests, cleanup zero, SHA-256 `cce1497f01cf01e297f4e71d12bef675c986a674258702928b4c6c27dac74cbd` |
| [`result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/result.json) | quota-provision runtime PASS, 42/42 checks, SHA-256 `0cf94881b102bb78a1ee0863c6009d5760bf547faa61a87792d3621e41f94117` |
| [`refresh-revoke-result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/refresh-revoke-result.json) | refresh/replay/revoke PASS, 40/40 checks, SHA-256 `8f5afb6912ec2b6d4a75871d35bb9f5ba9620fd1ace00f09c9dceeece84b816c` |
| [`vault-restart-result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/vault-restart-result.json) | Windows two-process keyring PASS, SHA-256 `a2aba56e36202033f706ee2d3ab5e091b7e1952e523d8b78d63d2f8d3fa3339e` |
| core source/evidence commit `dc4f0bd` | state/outbox codec/key/factory, 62 focused tests + root typecheck; factory not currently invoked by auth/`/sync` |

## Acceptance matrix

### AUTH-01 — Complete (Windows M3)

Opaque stateful native credentials; no JWT/vendor device-provider plugin; lowercase fingerprints and active grant/expiry/audience/resource/scope checks; immediate revocation; single-flight refresh with fail-closed lost-response behavior; session-bound CSRF/origin; BetterAuth as browser GitHub authority; vendor-owned tables/`Device.grantID`; synthetic plus live PostgreSQL security/concurrency; browser requests as their own principal. Evidence: 62/62, 78/78, 42/42, 40/40, API 425/425.

### WEB-01 — Complete (Windows M3)

Minimal same-origin BFF/approval surface accepted from the prior 31-test web baseline/build; owner-observed Windows OpenCode 2.1.1 actual GitHub browser approval and native sign-in/status-before-logout/logout. The 78/78 browser-security proof is direct API only and is not a new BFF/OAuth replay claim.

### AUTH-02 — Complete (Windows M3)

| Required criterion | Evidence | Verdict |
| --- | --- | --- |
| Device flow end-to-end over the frozen native wire, rotating refresh, bound `NativeDeviceGrant`/`Device.grantID` | Native 62/62; quota 42/42; refresh/revoke 40/40 | Met |
| `@napi-rs/keyring@2.1.2` selected, pinned, Windows-validated | Final vault result; all children pin-matched | Met (Windows only) |
| Real Windows credential-vault write/readback; process-restart persistence | Final vault result: write/readback/re-read, fresh child B | Met (process restart only) |
| Fail closed on controlled store failure | Final vault result fault child: `credential-unavailable`, no HTTP/retry/write/delete/fallback | Met (fault injection; **not** true OS lock) |
| Synthetic approval, refresh rotation, refresh-loss/recovery | Native 62/62; refresh/revoke 40/40 | Met |
| Cross-platform keyring; true OS locked/unavailable-store behavior | Deferred to `PLATFORM-FOLLOWUP-01` at roadmap end | Out of Windows M3 scope |
| `openLocalState` production factory wired into auth/`/sync` | Moved to SYNC-01; 62-test source evidence retained on `dc4f0bd` | Out of AUTH-02 scope; owned by SYNC-01 |

**Historical original AUTH-02 criteria (2026-10-20, preserved as decision note, superseded for Windows M3):** cross-platform keyring validation; secure-vault persistence with fail-closed behavior when the store is unavailable or truly locked; encrypted state/outbox keys and the atomic-replace single-writer state directory covered under AUTH-02; source factory under actual callers. Not deleted: cross-platform/true locked-state moved to `PLATFORM-FOLLOWUP-01`; factory wiring moved to SYNC-01.

### AUTH-03 — Complete (Windows M3)

| Required criterion | Evidence | Verdict |
| --- | --- | --- |
| Every plugin bearer `/v1` request resolves the opaque fingerprint and checks the active bound grant, expiry, audience, resource, scopes | Native 62/62 (`/v1/me` live); API 425/425 source tests; refresh/revoke 40/40 | Met |
| Immediate application revocation | Native 62/62; browser 78/78: revoked bearer `401` | Met |
| Browser requests are their own cookie+CSRF principal; never a device token; BFF cannot assert an arbitrary user header | Browser 78/78; prior BFF source/tests | Met |
| Authorization tests cover revoked-device denial and cross-principal misuse | Browser 78/78; refresh/revoke 40/40 | Met |
| Presigned-URL outstanding behavior / short expiry | Moved to STORE-02/M4 by owner decision 2026-10-25 | **Not part of AUTH-03; cross-referenced in STORE-02** |

Presigned URLs remain a requirement: already-issued URLs expire on their own short clock (≤5-minute candidate; parameters remain unapproved and unchanged), the limit is documented, and outstanding-URL behavior is tested after expiry once M4 mounts the routes. No presigned-URL pass is claimed.

## Limitations

- Windows OpenCode **2.1.1** client / **2.1.3** backend validation only; no cross-platform claim.
- **Process restart only**; no Windows OS reboot, power-loss, or machine-restart durability claim.
- Controlled store failure is **deterministic fault injection** at the scoped native-adapter read seam; it is **not** an actual OS locked/unavailable-store test.
- Synthetic credentials only; no owner account, provider, server grant, SessionPort token, or credential enumeration.
- Local logout only; no server revocation or network proof in the final vault probe.
- Cross-platform keyring/true OS lock: `PLATFORM-FOLLOWUP-01`; factory: SYNC-01; presigned URLs: STORE-02/M4.
- **M1/HOST-01 remains BLOCKED/unchanged** (actual fork/revert-loss/CAS lacking). No M1 loosening is recorded.

## Validation baseline

- Final credential probe/tests: **134 pass / 1 skip / 0 fail / 1,193 expect / 7 files**.
- Root `bun test tests`: **874 pass / 1 skip / 0 fail**, 19,477 `expect()` calls across 875 tests in 61 files.
- Root `bun run typecheck`: exit `0`; API `bun run typecheck`: exit `0`; API `node scripts/test.mjs`: **425/425 pass, 0 fail**; focused helper compile: exit `0`.
- Prior baselines reused, not rerun: web 31 tests/build; state/outbox 62 + typecheck on `dc4f0bd`; package-fix 79 files / 62 package tests.
