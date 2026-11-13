# SessionPort 0.1.9 — local-first release policy (2026-11-13)

**Status: PUBLISHED — `opencode-session-port@0.1.9` is public and is the npm `latest`.** The parent verified the public registry document, tarball bytes, SHA-256, SHA-512 integrity, and `latest` on 2026-11-13. This document does not approve, resume, deploy, or alter the paused cloud/V2 plan, and it does not pass M1/HOST-01.

## Publication receipt (verified 2026-11-13)

- **npm:** `opencode-session-port@0.1.9`; dist-tag `latest` = `0.1.9`.
- **Release run:** [43447730147](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/43447730147) — SUCCESS, dispatched from `main` at `f5010cc1af351fcb66ded64fb0f2a3a84127b9dd`.
- **Source binding:** immutable `v0.1.9` tag peels to `f5010cc1af351fcb66ded64fb0f2a3a84127b9dd`; source CI [43446652229](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/43446652229) — SUCCESS; `package-verify-evidence` artifact `14048896383`.
- **Public tarball:** 549,938 bytes; SHA-256 `63b5e842eb299f4b1b79eb5136e335ad5416e0e9eb9353d83814f77c36f8376d` (identical to the CI artifact); SHA-512 integrity `sha512-dWOx3UKL6ZlrzHJpLHdgDJUkUUfkhRpv5YSkFyajOMfdC77LM5HNL+MKS4+jVuXCLyoFvKJpJURqKwTMMs8YGA==`; 92 packed files; unpacked size 2,150,759 bytes.
- **Registry note:** the version endpoint returned 404 for about two minutes after the publish step; a cache-busted registry read then confirmed `0.1.9` as `latest` and the exact tarball above.

## What 0.1.9 contains

- **Restore collision copies and parent preservation.** Re-restoring the same
  artifact into a destination that already owns the derived session/message IDs
  no longer aborts with `message-id-collision`. Exact retry and lineage-current
  checks still skip unchanged copies; a changed copy is preserved as a new
  deterministic copy. Restore also preserves `parentID` for subagent sessions,
  imports parents before children, and attaches children to an existing root
  when the root itself was skipped as a duplicate. Artifact-level coalescing and
  global-only session-ID occupancy remain fail-closed. See
  `docs/evidence/restore-collision-copy-20261113.md`.
- **Faster CI.** The Windows CI job now caches Bun's install cache and npm's
  cache, installs npm with `--prefer-offline`, skips documentation-only
  pushes/PRs, and cancels superseded pull-request runs without cancelling main
  pushes. The release workflow itself is unchanged and still reuses the exact
  verified CI artifact.
- All 0.1.8 features remain: checkpoint retention modes (including the last N
  root sessions plus all of their subagents), the date-based recommendation,
  long-session streaming, portable lineage/dedup, keep/replace restore,
  optional sidebar actions and native settings, checkpoint cleanup, duplicate
  canonical project resolution, and theme-token dialogs.

## Understanding the roots mode

`Last N root sessions` with `N = 1` keeps **one root session plus every
subagent session that descends from it**. A restore showing 15 sessions is
therefore normally 1 root + 14 subagents, not 15 roots. The root is the
top-level session (no `parentID`); every other entry is a child/subagent. Use
`All sessions` to keep every root, or `Root sessions only` to keep all roots
without subagent history.

Retention is applied **when the checkpoint is created**, not at restore time.
An artifact created with an older build or another mode restores exactly what
it contains; create a new checkpoint with `Last N root sessions` = 1 to get a
one-root artifact.

## Platform support

- **Windows, macOS, and Linux** are supported local targets. The plugin registers
  on all three (`win32`, `darwin`, `linux`).
- Recorded automated verification is Windows-first. macOS/Linux behavior is
  owner-verified in local use; it is not yet recorded as a CI platform matrix.
- Cross-OS artifact interchange (create on one OS, restore on another) is
  owner-reported, not yet backed by recorded automated tests.
- The crypto profile id `sessionport-experimental-win-v1` is a historical name,
  not a Windows-only restriction.

## Safety boundaries

- Local use on Windows, macOS, and Linux. The recorded automated test/CI evidence
  remains Windows-first; no macOS/Linux CI matrix claim is made.
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
- SessionPort does **not** provide a hosted cloud service, and the built-in cloud
  sync (`/sync`) is paused and is not part of this release. The encrypted
  `.sessionport` artifact is a normal file, so you can store it in your own cloud
  drive and restore it on another supported machine; that manual transfer is not
  the paused `/sync` feature. Cross-OS artifact interchange is owner-reported,
  not yet backed by recorded automated tests.

## Verification (local, 2026-11-13)

| Check | Result |
| --- | --- |
| Full `bun test` | **1,486 pass / 0 fail / 1 skip**, 93 files |
| `bun run typecheck` | clean (`tsc --noEmit`) |
| `bun run build:tui` | `dist/tui.js`, **1,155,639 bytes** |
| `bun run verify:package` | `ok: true`, no problems; 92 packed files |

Local test success is not hosted-CI success. The release workflow separately
requires the exact tag commit's successful `ci.yml` push run and its
`package-verify-evidence` artifact.

## Release path

1. Commit and push `main` with `package.json` version `0.1.9`.
2. Create and push the immutable tag `v0.1.9` on that commit.
3. Wait for the `ci.yml` push run for the tag commit to succeed.
4. Set the repository variable `SESSIONPORT_RELEASE_VERSION` to `0.1.9`.
5. Dispatch the `Release` workflow from `main` with tag `v0.1.9`.

The protected `npm-release` environment and npm trusted-publisher mapping are
owner-side prerequisites. No manual approval is currently required per the
0.1.7/0.1.8 receipts.

## Non-claims

- No live two-machine or live-host destructive update/cleanup test was run;
  those paths are covered by synthetic tests.
- No recorded macOS/Linux CI matrix or cross-OS artifact-interchange proof is
  added; owner-reported local use is the basis for the cross-OS support
  statement.
- No packaged-TUI, native-2.1.1/actual-SDK, or cross-platform CI proof is added.
- No artifact format, crypto parameter, or compatibility claim changed.
