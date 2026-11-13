# SessionPort 0.1.8 — local-first release policy (2026-11-13)

**Status: PUBLISHED — `opencode-session-port@0.1.8` is public and is the npm `latest`.** The parent verified the public registry document, tarball bytes, SHA-256, SHA-512 integrity, and `latest` on 2026-11-13. This document does not approve, resume, deploy, or alter the paused cloud/V2 plan, and it does not pass M1/HOST-01.

## Publication receipt (verified 2026-11-13)

- **npm:** `opencode-session-port@0.1.8`; dist-tag `latest` = `0.1.8`.
- **Release run:** [43430825156](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/43430825156) — SUCCESS, dispatched from `main` at `b71c177b386bc9e1dae73b2fd9af353180370acc`.
- **Source binding:** immutable `v0.1.8` tag peels to `b71c177b386bc9e1dae73b2fd9af353180370acc`; source CI [43429883852](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/43429883852); artifact `14039747071`.
- **Public tarball:** 544,974 bytes; SHA-256 `bf054430dfd9c464456573bcfca641c8c9133d4ce4427eacbece6742778499b7`; SHA-512 integrity `sha512-VlVxqM77e8wP8uf/Emt6+wjCy81D79FSC2zoXqi7CUFNSb0kIXmQkFHqXOgA+PYu1euyYCayX+tg8k23iziqCw==`; 92 packed files.
- **OIDC:** the release job acquired the OIDC token and published via trusted publishing. No token fallback was used.
- **Registry note:** the registry edge briefly served the cached 0.1.7 document after publish; a cache-busted registry read confirmed `0.1.8` as `latest` and the exact tarball above.

## What 0.1.8 contains

- **Checkpoint size control.** `/checkpoint` offers: after the last compaction
  (default), all sessions, the last N root sessions plus all of their
  subagents, a chosen number of recent subagents, or roots only. The chooser
  reads root-session dates (metadata only), marks the recommended option, and
  shows the 30-day cutoff used for the recommendation.
- **Long-session streaming.** The checkpoint payload is serialized in bounded
  chunks into the existing encrypted seal; format, KDF, and crypto parameters
  are unchanged. Only the experimental size caps were raised.
- **Portable lineage and two-machine dedup.** Imported sessions carry a
  content-neutral lineage stamp; exact-content duplicates are skipped, and a
  strict message-prefix continuation can update the same session ID after the
  required recovery artifact is written and decrypt-verified.
- **Keep/replace restore.** `/restore` lets the user keep existing destination
  sessions (safe copies, nothing deleted) or replace only sessions the safety
  checks prove unchanged.
- **Optional sidebar actions and native settings.** `/sessionport` opens the
  native settings modal; sidebar Checkpoint/Restore actions are opt-in and
  persisted in plugin storage. The same modal can delete older checkpoints in
  the active project's `.sessionport` directory while keeping the newest.
- **Duplicate canonical projects.** Restore destination selection resolves
  duplicate project records read-only through `location.get` and fails closed on
  missing or mismatched responses.
- **Theme-token dialogs.** Password, restore preview, and report dialogs use
  host semantic theme tokens instead of a private palette.

## Safety boundaries

- Windows-only local use. No Linux/macOS or cross-OS compatibility claim.
- No direct OpenCode-database writes, no LLM calls, no historical tool replay,
  and no Git commands by the plugin.
- Encryption remains mandatory; there is no plaintext fallback or plaintext
  temporary file.
- Retention only controls checkpoint content. Excluded sessions remain in the
  host database and are not deleted.
- Same-ID update deletes before import; if the import fails, the decrypt-verified
  recovery artifact is the only restore path. There is no atomicity or CAS
  claim; manual quiescence is required.
- Checkpoint cleanup is scoped to regular `.sessionport` files directly inside
  the active project's `.sessionport` directory; recovery backups, symlinks,
  directories, and outside paths are never deleted. There is no undo.
- Cloud sync is paused and is not part of this release.

## Verification (local, 2026-11-13)

| Check | Result |
| --- | --- |
| Full `bun test` | **1,456 pass / 0 fail / 1 skip**, 93 files |
| `bun run typecheck` | clean (`tsc --noEmit`, exit 0) |
| `bun run build:tui` | `dist/tui.js`, **1,147,477 bytes** |
| `bun run verify:package` | `ok: true`, no problems; 92 packed files |
| Non-cloud focused suite | 984 pass / 0 fail, 66 files |

Local test success is not hosted-CI success. The release workflow separately
requires the exact tag commit's successful `ci.yml` push run and its
`package-verify-evidence` artifact.

## Release path (performed)

1. Committed and pushed `main` with `package.json` version `0.1.8` at `b71c177`.
2. Created and pushed the immutable tag `v0.1.8` on that commit.
3. CI push run [43429883852](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/43429883852) succeeded for the tag commit.
4. Set the repository variable `SESSIONPORT_RELEASE_VERSION` to `0.1.8`.
5. Dispatched the `Release` workflow from `main` with tag `v0.1.8`; run 43430825156 succeeded.

The protected `npm-release` environment and npm trusted-publisher mapping are
owner-side prerequisites. No manual approval was required, matching the 0.1.7
receipt.

## Non-claims

- No live two-machine or live-host destructive update/cleanup test was run;
  those paths are covered by synthetic tests.
- No packaged-TUI, native-2.1.1/actual-SDK, or cross-platform proof is added.
- No artifact format, crypto parameter, or compatibility claim changed.
