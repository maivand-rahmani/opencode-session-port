# SessionPort 0.1.7 — authoritative local-release policy and publication receipt (2026-10-26)

**Status: PUBLISHED — `opencode-session-port@0.1.7` is public and is the npm `latest`.** The parent independently downloaded the public npm tarball and verified exact source SHA-256, registry SHA-512 integrity, byte size, and `latest` on 2026-10-26. This is the current local-first release policy. It supersedes only the explicitly named local-release/`/restore` clauses below. It does **not** approve, resume, deploy, or alter the paused cloud/V2 plan, and it does not pass M1/HOST-01.

## Publication receipt (verified 2026-10-26)

- **npm:** `opencode-session-port@0.1.7`; dist-tag `latest` = `0.1.7`.
- **Release run:** [40308068241](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/40308068241) — SUCCESS, head `472261f56051f43785cf110644135c501f79e301`.
- **Source binding:** immutable `v0.1.7` tag peels to `6f491ab8e64add08a9831c144fecdb5648e4e344`; source CI [40212562472](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/40212562472); artifact `12606815301`.
- **Public tarball:** 489817 bytes; SHA-256 `7437e405e60f72ef42018e1ace776fba180598ffd0f48923ffced6a8fab2f71d`; SHA-512 integrity `sha512-VRIjgb9cqfUwJpbSsQ6cBjHyMBIaEg/zAVFtvKV+0Y8zhNjeTLkryUX5hrR+49kBJgVjb2BWE4gfVI0eZZXjSg==`.
- **OIDC:** the 2026-10-26 release job successfully acquired the OIDC token and published via trusted publishing. This records the successful publish; it does **not** claim that diagnostics proved the root cause of the earlier `ENEEDAUTH` attempts. That root cause remains unknown.
- **Manual approval:** the owner explicitly removed the `npm-release` required reviewers. The environment remains named `npm-release` with refs `main`/`v*`; OIDC and the exact artifact/version/tag checks are retained. Current runbook: **no manual approval is required; do not ask the owner to review deployments.**
- **Claim boundary:** the parent verified the public registry receipt. This receipt does not create a new platform, host, cloud, or compatibility claim.

## Release state (honest; 2026-10-25 local snapshot retained as historical)

- `opencode-session-port` **0.1.7** is published and is the current npm `latest`, with the receipt above. The earlier 2026-10-25 unpublished state is historical.
- Registry `latest` is `0.1.7` as verified on 2026-10-26. Do not treat the former `0.1.6` observation as current.
- **Historical (2026-10-25 local-main snapshot):** the then-recorded source snapshot was `main` push `5399bab`, and GitHub Actions run [40208597611](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/40208597611) failed in the source full-test suite (`cloud/auth/state`, `invalid-state-directory`) on the Windows runner. The released artifact instead came from immutable tag source CI `40212562472` on `6f491ab`; do not transfer the earlier failure to the released tag source.
- **Historical local evidence (2026-10-25):** root suite **976 pass / 1 skip / 0 fail** and a passing typecheck on the then-current local tree; local test success is not CI success. This local snapshot is not the released artifact.
- **Historical local pack measurement (2026-10-25):** the corrected r2 package verification measured **85 files**; local tarball SHA-256 `b4d517ba0a2ca0f7ea38a7d154a9c55d1f8103ce4c223447c0866999bfa65103`. That measurement predates the 2026-10-25 README edit and is **not** the published tarball. The published public tarball is 489817 bytes with SHA-256 `7437e405e60f72ef42018e1ace776fba180598ffd0f48923ffced6a8fab2f71d`, as recorded in the receipt above. The earlier **79-file** and **69-file** counts are historical.
- **Bounded runtime PASS (2026-10-25):** the corrected r2 public-HTTP production-function proof passed (`status: "ok"`, `allRequiredCasesPassed: true`) on a stock OpenCode 2.1.3 Linux host. Packaged-TUI behavior remains unverified, as do native-2.1.1 and actual-SDK behavior. This is not a Linux-support or platform claim. Evidence: [docs/evidence/local-release-017-20261025.md](evidence/local-release-017-20261025.md).
- Preserve all cloud code and evidence. Cloud work is **PAUSED/FUTURE** until the host issues are fixed. Existing M3 Windows-bounded evidence (commits `dc4f0bd`, `7f4ec1f`, `50d18ff`, `41fb2d4`) remains historical evidence, not an active published cloud feature.

## Ready / proposed / verification-pending

- **Published:** `opencode-session-port@0.1.7` with the public receipt above; `/checkpoint`, `/restore`, the `.sessionport` directory, the experimental Windows crypto/artifact profile, and the bounded local workflow remain the release policy. The recorded 2026-10-25 85-file local verification and r2 public-HTTP production-function PASS remain local evidence, not the published artifact.
- **Proposed, not implemented here:** future cloud resume under fresh host gates; no cloud behavior is changed or reopened by this document.
- **Verification pending:** packaged-TUI and native-2.1.1/actual-SDK proof, plus any platform claim beyond the recorded Windows-only boundary. Historical local-main snapshot `5399bab` remains a failed hosted run and is not the released tag source. No new compatibility claim is made.

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
- **Historical 2026-10-25 non-claims:** that record made no tag, publication, registry-live, green-CI, or production claim. The 2026-10-26 receipt above supersedes only the publication/registry status; no new compatibility claim is made.
- Local test success is not CI success. The historical 2026-10-25 hosted Windows run for local-main snapshot `5399bab` was failing in an unrelated cloud/auth/state test path; the released tag source CI `40212562472` is separate and succeeded.

## Operator path

See [README.md](../README.md) for install, pinned-host compatibility, examples, warnings, and the exact recovery workflow. See [docs/evidence/local-release-017-20261025.md](evidence/local-release-017-20261025.md) for recorded local evidence, hashes, and claim boundaries. Preserve this document as the authoritative current local-release policy and publication receipt; historical cloud/M3/V2 status text is retained but is not the current direction.
