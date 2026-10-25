# M3 runtime acceptance — 2026-10-25

**Status: M3 Partial.** AUTH-01 and WEB-01 are Complete for the bounded acceptance below; AUTH-02 and AUTH-03 remain Partial. This record is the authoritative compact matrix for the latest M3 runtime lane. It does not change M1/HOST-01, M4 storage, or production/deployment status.

## Evidence used

| Evidence | Result |
| --- | --- |
| [`native-client-lifecycle-result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/native-client-lifecycle-result.json) | PASS, 62/62 checks, 14 actual HTTP requests, cleanup zero, SHA-256 `a56428851fa34542335b4adb1156f8f8e9e04859f4cb0c28f4441a655808ea80` |
| [`browser-security-lifecycle-result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/browser-security-lifecycle-result.json) | PASS, 78/78 checks, 29 actual direct-API requests, cleanup zero, SHA-256 `cce1497f01cf01e297f4e71d12bef675c986a674258702928b4c6c27dac74cbd` |
| [`result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/result.json) | quota-provision runtime PASS, 42/42 checks, SHA-256 `0cf94881b102bb78a1ee0863c6009d5760bf547faa61a87792d3621e41f94117` |
| [`refresh-revoke-result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/refresh-revoke-result.json) | refresh/replay/revoke PASS, 40/40 checks, SHA-256 `8f5afb6912ec2b6d4a75871d35bb9f5ba9620fd1ace00f09c9dceeece84b816c` |
| [`vault-restart-result.json`](../../.package-verify-work/m3-quota-provision-config-20261024/deployment/vault-restart-result.json) | Windows two-process keyring PASS, SHA-256 `a2aba56e36202033f706ee2d3ab5e091b7e1952e523d8b78d63d2f8d3fa3339e`; not a locked-store or cross-platform proof |
| [`m3-quota-provision-policy-20261024.md`](m3-quota-provision-policy-20261024.md) | policy/runtime deployment record and earlier claim boundaries |

Pinned validation image: `sha256:c8bd046e364822481e038e8a36e4682c793a7175fa63a091afb57fd289c7562c`. Both 2026-10-25 containers were read-only, non-root (`1000:1000`), cap-drop ALL, `no-new-privileges`, bounded (`pids 256`, `memory 768 MiB`, `cpus 1`), internal DB network only, no ports, and exited `0`; the existing app was unchanged.

## Acceptance matrix

### AUTH-01 — Complete (2026-10-25)

| Required criterion | Evidence | Verdict |
| --- | --- | --- |
| SessionPort-owned opaque, stateful native credentials; no JWT or vendor device-provider plugin | Native 62/62; source/tests | Met |
| Lowercase fingerprints; active grant/expiry/audience/resource/scope checks on every bearer request | Native 62/62; API 425/425 source tests | Met |
| Immediate revocation | Native 62/62 and browser 78/78; revoked bearer `401` | Met |
| Single-flight refresh and fail-closed lost-response behavior | Native 62/62: one server refresh, no blind retry, no replay, vault-uncertain fail-closed | Met |
| Session-bound CSRF/origin for browser mutations | Browser 78/78: actual API-issued CSRF; missing/wrong origin, missing/wrong CSRF, cross-session CSRF all rejected | Met |
| BetterAuth 1.7.11 only as browser GitHub authority; vendor tables owned; `Device.grantID` FK | Browser 78/78 real vendor sessions/`getSession`; quota 42/42 and refresh/revoke 40/40 | Met |
| Synthetic integration plus live PostgreSQL security/concurrency matrix | 62/62 + 78/78 + 42/42 + 40/40 on restricted runtime role | Met |
| No standalone `/device/token`; browser requests are their own principal and never carry a device token | Browser 78/78; source/tests | Met |

### WEB-01 — Complete (2026-10-25)

| Required criterion | Evidence | Verdict |
| --- | --- | --- |
| Minimal `cloud/web` same-origin BFF for fixed `/api/auth/*` and native paths | Prior 31 web tests/build and browser QA reused; no changed web source in this lane | Met (prior baseline) |
| GitHub OAuth callback registered; actual browser approval works | Owner-observed Windows OpenCode 2.1.1 actual GitHub browser approval and native sign-in/status-before-logout/logout | Met (owner-observed, not independently replayed here) |
| Approval page can approve a pending device; list/revoke devices | Browser 78/78 proves the API-side approve/list/revoke contract; owner observed approval; web UI source/tests prior valid | Met |
| Same-origin cookies; no open proxy; server-only secrets | Prior 31 web tests/build; source unchanged in this lane | Met (prior baseline) |

The 78/78 browser-security run is **direct API only**. It is not a new BFF or OAuth replay claim; the BFF/OAuth conclusion rests on the owner-observed approval and the prior web baseline.

### AUTH-02 — Partial

| Required criterion | Evidence | Verdict / remaining |
| --- | --- | --- |
| Device flow end-to-end over the frozen native wire, rotating refresh, bound `NativeDeviceGrant`/`Device.grantID` | Native 62/62; quota 42/42; refresh/revoke 40/40 | Met |
| Credential-store dependency selected, pinned, and validated cross-platform | `@napi-rs/keyring@2.1.2` pinned; Windows synthetic and two-process PASS | **Not met**: no cross-platform validation |
| Tokens/key material only in the secure vault; fail closed when unavailable or locked | Synthetic-vault fail-closed in native 62/62; owner Windows sign-in is controller-result only | **Not met**: no independent real-OS-vault readback/restart proof and no true locked-store proof |
| Encrypted state/outbox keys and atomic-replace single-writer state directory covered under actual callers | Source 62 focused tests + typecheck; production factory exists | **Not met**: `openLocalState` is not wired into auth/`/sync` callers |
| Synthetic approval, refresh rotation, and refresh-loss/recovery | Native 62/62; refresh/revoke 40/40 | Met |

Concrete remaining: (1) independent real-OS-vault token persistence readback plus restart/locked-store fail-closed on Windows; (2) cross-platform keyring validation **or** an explicit owner decision scoping M3 to Windows; (3) an owner decision whether the source-only `openLocalState` factory must be wired into actual auth/`/sync` callers before AUTH-02. The roadmap's older statement that state/outbox keys are M5-only conflicts with AUTH-02's acceptance text; that contradiction is recorded, not silently resolved.

### AUTH-03 — Partial

| Required criterion | Evidence | Verdict / remaining |
| --- | --- | --- |
| Every plugin bearer `/v1` request resolves the opaque fingerprint and checks the active bound grant, expiry, audience, resource, and scopes | Native 62/62 (`/v1/me` live); API 425/425 source tests | Met by source + focused live principal proof; route-complete live matrix not rerun |
| Immediate application revocation | Native 62/62, browser 78/78: revoked bearer `401` | Met |
| Browser requests are their own cookie+CSRF principal; never a device token; BFF cannot assert an arbitrary user header | Browser 78/78; prior BFF source/tests | Met |
| Authorization tests cover revoked-device denial and cross-principal misuse | Browser 78/78 and refresh/revoke 40/40 | Met |
| Presigned-URL outstanding behavior and short expiry are proven | Not mounted; M4 storage work | **Not met — explicitly deferred to M4** |

Concrete remaining: the M4 presigned-URL outstanding-URL behavior (short expiry/denial once the upload routes are mounted). No presigned-URL pass is claimed.

## Validation baseline

- Root `bun test tests`: **874 pass / 1 skip / 0 fail**, 19,477 `expect()` calls across 875 tests in 61 files. (PowerShell reported a non-zero pipeline status because Bun writes its summary to stderr; no test failed.)
- Root `bun run typecheck`: exit `0`.
- API `bun run typecheck`: exit `0`.
- API `node scripts/test.mjs` (36 explicit `.node.ts` files): **425 pass / 0 fail**, exit `0`, 6.4 s.
- Focused helper TypeScript compile (both test-support helpers, actual API imports, `--strict`, no `ts-ignore`): exit `0`.
- Prior recorded baselines reused, not rerun: state/outbox **62 pass** on `dc4f0bd` + root typecheck; package-fix measured npm/Bun **79 files** and exact required **62 package tests pass**; web **31 tests**/build.

## Boundaries and deferrals

- **M1/HOST-01 remains blocked/open**: actual fork/revert-loss/CAS behavior is still lacking; this lane does not touch that gate.
- **M4 presigned URLs are explicitly deferred**, not passed; upload routes remain unmounted.
- No production/deployment, main-database, real OAuth replay, cross-platform keyring, true locked-store, native outbox invocation, or public-network claim.
- No product/auth/state/UI/schema/config/dependency/remote/redeploy/secret change was made in this lane.

## Owner decisions (minimal, bounded)

1. Is cross-platform keyring support required for M3, or is Windows-only (with the existing evidence) sufficient?
2. Must `openLocalState` be wired into real auth/`/sync` callers before AUTH-02, or is the source-only factory plus its 62 tests sufficient for M3 given the roadmap's M5-vs-AUTH-02 contradiction?
