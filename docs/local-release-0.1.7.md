# SessionPort 0.1.7 — authoritative local-release policy (2026-10-25)

**Status: RELEASE TARGET — not published, not registry-live, not yet proven.** This is the current local-first release policy. It supersedes only the explicitly named local-release/`/restore` clauses below. It does **not** approve, resume, deploy, or alter the paused cloud/V2 plan, and it does not pass M1/HOST-01.

## Release state (honest)

- `opencode-session-port` **0.1.7** is the owner-confirmed local-first release target. No 0.1.7 publication has occurred.
- Bounded registry read: `latest` is **0.1.6**; **0.1.7 is not available**. Do not call 0.1.7 published, released, or registry-live until an actual publication receipt exists.
- The release workflow's GitHub variables were absent at the last check, so the publication gate remains **closed**. Publication may require manual owner approval and OIDC identity verification; no tag/publication/OIDC action is recorded here.
- Pack count measured at the time of this record: **79 files**. Future local source changes will increase it. Do not pin a new count yet; the final verifier is the release-time authority. The old **69-file** count is historical/current pre-local-integration only.
- Preserve all cloud code and evidence. Cloud work is **PAUSED/FUTURE** until the host issues are fixed. Existing M3 Windows-bounded evidence (commits `dc4f0bd`, `7f4ec1f`, `50d18ff`, `41fb2d4`) remains historical evidence, not an active published cloud feature.

## Ready / proposed / verification-pending

- **Ready for local release policy:** `/checkpoint`, `/restore`, the `.sessionport` directory, the experimental Windows crypto/artifact profile, and the bounded local workflow below.
- **Proposed, not implemented here:** future cloud resume under fresh host gates; no cloud behavior is changed or reopened by this document.
- **Verification pending:** packaged 0.1.7 consumer install/load, final release-time pack/verifier count, actual publication/OIDC receipt, and any platform claim beyond the recorded Windows-only boundary.

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
- Windows-only local use; no Linux/macOS or cross-OS compatibility claim.
- No direct OpenCode-database writes, no LLM calls, no historical tool replay, and no Git commands by the plugin.
- Fork/revert copy is a standalone-copy workaround, **not** native graph preservation and **not** automatic tool replay.
- Cloud sync is paused, not advertised as working, and not part of this local release claim.
- No tag, publication, registry-live, or production claim is made here.

## Operator path

See [README.md](../README.md) for install, pinned-host compatibility, examples, warnings, and the exact recovery workflow. Preserve this document as the authoritative current local-release policy; historical cloud/M3/V2 status text is retained but is not the current direction.
