# SessionPort 0.1.7 — authoritative local-release policy (2026-10-25)

**Status: LOCAL-FIRST RELEASE TARGET — corrected r2 public-HTTP production-function proof PASS; packaged-TUI unverified; no publication receipt or green hosted CI.** This is the current local-first release policy. It supersedes only the explicitly named local-release/`/restore` clauses below. It does **not** approve, resume, deploy, or alter the paused cloud/V2 plan, and it does not pass M1/HOST-01.

## Release state (honest)

- `opencode-session-port` **0.1.7** is the owner-confirmed local-first release target. No publication receipt is recorded here; do not call 0.1.7 published, released, or registry-live without an actual receipt.
- Registry `latest` is whatever npm serves at read time. This document does not pin or promise it; check the [npm package](https://www.npmjs.com/package/opencode-session-port) or `npm view opencode-session-port version`. The former `0.1.6` observation is historical only.
- The recorded source snapshot is `main` push `5399bab`. GitHub Actions run [40208597611](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/40208597611) failed in the source full-test suite (`cloud/auth/state`, `invalid-state-directory`) on the Windows runner; `fix130` was active at record time. No hosted-CI-green claim is made.
- Local source evidence: root suite **976 pass / 1 skip / 0 fail** and a passing typecheck; the source product is unchanged from the oracle-GO state. Local test success is not CI success.
- Pack count measured by the corrected 2026-10-25 r2 package verification: **85 files**; tarball SHA-256 `b4d517ba0a2ca0f7ea38a7d154a9c55d1f8103ce4c223447c0866999bfa65103`. This measurement predates the 2026-10-25 README edit; because README is packed, a rebuild changes the tarball hash and requires a fresh verifier run. The final release-time verifier remains the authority. The earlier **79-file** count and the **69-file** pre-local-integration count are historical.
- **Bounded runtime PASS:** the corrected r2 public-HTTP production-function proof passed (`status: "ok"`, `allRequiredCasesPassed: true`) on a stock OpenCode 2.1.3 Linux host. Packaged-TUI behavior remains unverified, as do native-2.1.1 and actual-SDK behavior. This is not a Linux-support, publication, or CI pass claim. Evidence: [docs/evidence/local-release-017-20261025.md](evidence/local-release-017-20261025.md).
- Preserve all cloud code and evidence. Cloud work is **PAUSED/FUTURE** until the host issues are fixed. Existing M3 Windows-bounded evidence (commits `dc4f0bd`, `7f4ec1f`, `50d18ff`, `41fb2d4`) remains historical evidence, not an active published cloud feature.

## Ready / proposed / verification-pending

- **Ready for local release policy:** `/checkpoint`, `/restore`, the `.sessionport` directory, the experimental Windows crypto/artifact profile, the bounded local workflow below, the recorded 85-file package verification (whose tarball predates the README edit), and the recorded r2 public-HTTP production-function PASS.
- **Proposed, not implemented here:** future cloud resume under fresh host gates; no cloud behavior is changed or reopened by this document.
- **Verification pending:** actual publication/OIDC receipt, hosted-CI green status (`fix130`), fresh package verification after the 2026-10-25 README edit, packaged-TUI and native-2.1.1/actual-SDK proof, final release-time verifier count, and any platform claim beyond the recorded Windows-only boundary.

## Local checkpoint policy

- Default artifact path: **`PROJECT/.sessionport/checkpoint-UTC.sessionport`** (UTC timestamped). The old `.session-port` location is not the default.
- `/checkpoint` produces one encrypted artifact for the current project using the existing experimental Windows profile. The artifact format, crypto parameters, and caps are **unchanged**; this release does not introduce new parameters.
- A checkpoint is an older encrypted payload. It is **not** a backup of the current target until `/restore` creates and verifies one.

## `/restore` preview, backup, and delete policy

1. **Preview first.** Show the exact destination targets, including what will be replaced/deleted, before any mutation.
2. **Explicit confirmation required.** No restore/delete proceeds without the user's explicit confirmation for that preview.
3. **Backup before delete.** The imported candidate must be complete and verified. Before deleting the current old persisted target, create an encrypted backup of that current old target and decrypt-verify it. If backup creation or verification fails, **no delete**.
4. **Delete only confirmed standalone, settled, unchanged targets** with no fork/revert, parent/child links, or incoming references.
5. **Old target absent:** import only; never delete a source on another machine.
6. **Graph/fork/revert encountered:** create a standalone copy, flatten only the known parent/fork/revert metadata, keep the original, and show an explicit warning. This is **not** native graph preservation.
7. **Error/changed/active/unknown references/incomplete inventory:** **NO delete.**
8. **Delete outcome uncertain:** read back and reconcile **once**; no blind retry loop.
9. Manual quiescence is required; this is **not** CAS, not an atomic guarantee, and not a TOCTOU-safety claim.
10. Exact duplicates may be skipped. Skip never deletes.
11. Fresh encrypted recovery is required for the current target; a successful import alone does not authorize deleting the old target.

## Scope and non-claims

- The owner accepts a **limited local mode** for this release. This is **not** M1/HOST-01 full acceptance.
- Windows-only local use; no Linux/macOS or cross-OS compatibility claim. The separate 2.1.3 Linux run is public-HTTP-bridge restore-function evidence only; it is not packaged-TUI, native-2.1.1, or Linux host support.
- No direct OpenCode-database writes, no LLM calls, no historical tool replay, and no Git commands by the plugin.
- Fork/revert copy is a standalone-copy workaround, **not** native graph preservation and **not** automatic tool replay.
- The r2 fixture is synthetic and flat. It does not prove live wrong-password rejection, permission readback, tool-part restore, real history, or production data safety.
- Cloud sync is paused, not advertised as working, and not part of this local release claim.
- No tag, publication, registry-live, green-CI, or production claim is made by this record.
- Local test success is not CI success; at record time, the hosted Windows run was failing in an unrelated cloud/auth/state test path.

## Operator path

See [README.md](../README.md) for install, pinned-host compatibility, examples, warnings, and the exact recovery workflow. See [docs/evidence/local-release-017-20261025.md](evidence/local-release-017-20261025.md) for recorded evidence, hashes, and claim boundaries. Preserve this document as the authoritative current local-release policy; historical cloud/M3/V2 status text is retained but is not the current direction.
