# SessionPort

**Encrypted session checkpoints for OpenCode.**

SessionPort is a local plugin for the OpenCode TUI. It captures the sessions of your current project into a single password-encrypted artifact and restores them in another checkout, worktree, or machine. Artifacts travel with Git or any other channel you choose — SessionPort never runs Git commands itself.

> **Status: experimental pre-release (0.1.6).** SessionPort completed one bounded synthetic checkpoint/restore round trip on Windows with OpenCode v2.0.22. That test used test-only password and project-selector seams and staged source, not the npm tarball. On one real Windows OpenCode v2.0.22 host, a bounded diagnostic observed both commands registered (`commands=yes`) but hidden from the command palette and slash list until the keymap layer opted into global mode; 0.1.2 applies that global-mode registration fix, with focused command-registration tests and the TUI build passing. 0.1.3 additionally enables the commands on macOS and Linux through an explicit platform allowlist (`win32`/`darwin`/`linux`). 0.1.2 through 0.1.6 are published to npm (0.1.6 latest, per a read-only registry check on 2026-10-18, which also observed the published 0.1.6 tarball's SHA-1 matching the local 0.1.6 candidate); the published package itself has not been host-tested. 0.1.4 was a diagnostics/copy patch: a failed checkpoint collection appends a fixed sanitized reason and the known machine code (`Reason: <fixed reason> (<code>).`) for the current collection codes; unknown codes keep the generic text and raw host/exception text is never shown. 0.1.5 adds a bare `/restore` default that uses the newest checkpoint in the current project's `.sessionport/` directory (newest file modification time; no fallback to an older artifact on a corrupt file, wrong password, or read failure) and extends the same fixed-reason diagnostics to known restore plan/collection error codes. Collector behavior is unchanged, and no root cause is established for an earlier Windows collection failure; the concrete code behind an earlier restore rejection is likewise still pending a user runtime observation, and no planner correctness fix is claimed. macOS has one user-reported successful checkpoint only; Linux is untested; restore and cross-OS artifact interchange remain unestablished. End-to-end execution from the packed package has not been host-tested. Real modal interactions and loading the packed package in OpenCode have not been verified. The checkpoint format may change; no compatibility, security, or platform-support guarantee is made. **0.1.6 (published, observed 2026-10-18):** checkpoint collection now also includes sessions referenced through the collected sessions' schema-defined `parentID`/`fork.sessionID` links — even referenced sessions outside the current project — with each referenced session's full message history; a referenced session that cannot be captured fails the checkpoint instead of being dropped. This change shipped in the published 0.1.6 (observed 2026-10-18) but has synthetic verification only — no host run against the packed package; an independent source review returned GO scoped to source correctness (sole blocker fixed; no material remainder).

## Commands

- **`/checkpoint [artifact-path]`** — collects the current project's sessions as returned by the host (child/subagent and archived sessions included when the host returns them) and recursively includes only the sessions those records reference through `parentID`/`fork.sessionID` — including referenced sessions outside the current project — with each referenced session's full message history; it never scans unrelated projects. It fails cleanly, with no artifact, when the set is empty, a session (including a referenced dependency) cannot be captured completely, or the output file already exists. The dependency-closure inclusion shipped in the published 0.1.6 (observed 2026-10-18); it has synthetic verification only, with no host run against the packed package.
- **`/restore [artifact-path]`** — decrypts and validates the artifact before session imports, then restores it into an existing project you select. Without a path, `/restore` uses the newest checkpoint in the current project's `.sessionport/` directory (newest file modification time; an exact tie is broken deterministically by filename). Restore does not overwrite existing sessions: exact destination matches are skipped, conflicting IDs are remapped deterministically, and parents are imported before children.

Both commands are registered by the plugin as `sessionport.checkpoint` and `sessionport.restore`, and appear in the slash-command list and the command palette.

## Requirements

- OpenCode with the v2 TUI plugin API (exercised with OpenCode v2.0.22).
- Windows, macOS, or Linux. The build enables the commands on all three through an explicit platform allowlist (`win32`/`darwin`/`linux`); other platforms are not enabled. Windows has the bounded host evidence above; macOS and Linux are enabled but NOT host-tested, and cross-OS artifact interchange is UNVERIFIED.

## Install

Add the plugin to the `plugins` array in your global CLI-only config (`cli.json`):

```json
{
  "plugins": ["opencode-session-port@0.1.6"]
}
```

Or install the package plugin with the OpenCode CLI:

```sh
opencode plugin add opencode-session-port@0.1.6
```

`cli.json` is the documented OpenCode v2 config for CLI-only plugins: they run locally in the terminal and remain active when the CLI connects to a remote server. The npm registry shows 0.1.2 through 0.1.6 published (0.1.6 latest; read-only registry check on 2026-10-18, which also observed the published 0.1.6 tarball's SHA-1 matching the local 0.1.6 candidate); no published artifact has been loaded by OpenCode here, and no local package-verification record exists for the published tarballs. The 0.1.1 tarball passed npm consumer checks, but a direct Bun package-manager install timed out in the verification environment, so that install path remains unverified. The 0.1.2 tarball passed manifest/allowlist and packed-entry checks only. The 0.1.4 and 0.1.5 candidate tarballs passed the same local manifest/allowlist and packed-entry checks (0.1.5 including the bare-restore latest-checkpoint resolver and the restore reason-copy allowlists). The 0.1.6 tarball passed the same checks, including the checkpoint dependency-closure source modules; it is published, but execution from the packed package has not been host-tested.

## Usage

### Checkpoint

```text
/checkpoint [artifact-path]
```

Without an argument, the artifact is written to `.sessionport/checkpoint-<UTC timestamp>.sessionport` inside the current project. An argument overrides the location (absolute, or relative to the project). An existing file is never overwritten — a collision fails the checkpoint.

Checkpoint prompts for a password twice in a masked input (paste is allowed); both entries must match. Strength guidance is advisory — weak passwords are not rejected.

### Restore

```text
/restore [artifact-path]
```

Without an argument, `/restore` picks the newest checkpoint in the current project's `.sessionport/` directory (newest file modification time wins; an exact tie is broken deterministically by filename, descending). If the project has no active directory or no checkpoint is found, nothing is changed. Restore never falls back to an older checkpoint: a corrupt file, wrong password, or read failure stops the command with an error instead of trying another artifact.

Restore first asks which existing project to import into, then prompts for the password (up to three attempts). The artifact is fully checked before the first session import. Project resolution may still update bounded host project metadata through OpenCode's public `location.get` API. Imports run parents-first, one session at a time: independent branches continue after a failure, descendants of a failed parent are blocked, and outcomes are reported per session. There is no atomic rollback. A later manual rerun may skip exact matching records, but exact retry behavior on a real host has not been established. Imported sessions are not opened or navigated to automatically.

### Moving artifacts

Move the artifact with Git (commit it, stash it, or sync it your own way) or any other channel. SessionPort never runs Git commands, and the password is never stored with the artifact or in the repository — if you lose it, the artifact cannot be recovered. A checkpoint cannot be repaired after the fact: if a restore rejects an artifact because it references a session the artifact does not contain (a dangling session reference), make a new checkpoint on the source machine and transfer it — old artifacts are never fixed automatically.

## Security notes

- Encryption is mandatory: no plaintext fallback, no plaintext temporary file.
- Payloads are compressed, then encrypted with an Argon2id-derived key and XChaCha20-Poly1305 secretstream; truncated or tampered artifacts are rejected.
- Password input is masked and capped at 4 KiB of UTF-8. SessionPort does not intentionally log it, write it to disk, or copy it to the clipboard. JavaScript strings cannot be reliably zeroed; no secure-erasure claim is made.
- Protection applies to the artifact at rest only. Git history and metadata, a compromised machine, and secrets copied into session content are outside SessionPort's protection; no secure-deletion promise is made.
- SessionPort makes no model/LLM calls and never replays historical tool calls.

## Development status

**SessionPort 0.1.6** — local encrypted checkpoint/restore implementation completed for the next planning phase and published to npm; experimental, with the verification limits above.

**SessionPort 0.1.7 (candidate, unpublished)** — repository metadata is prepared locally as version 0.1.7 for a future release; no tag, release, or npm publish has been performed, 0.1.7 is not on npm, and the published install pins above remain 0.1.6 until publication is separately approved.

**SessionPort 0.2.0** — active development of optional cloud accounts, encrypted remote storage, and cross-device continuity. Local M1–M3 source slices now exist: a Fastify/Prisma API, SessionPort-owned native device credentials, BetterAuth 1.7.11 browser sign-in, and a minimal Feature-Sliced Design Next.js web surface for login, device approval, and connected devices (no dashboard). Nothing cloud-side is deployed or runtime-accepted: the application database is untouched, auth is not enabled, storage/upload endpoints are not mounted, and HOST-01 remains open. Architecture, specifications, roadmap, and [M1–M3 status](docs/V2/README.md) are in [`docs/V2/`](docs/V2/README.md); full-package owner review remains unrecorded.

Release CI remains the first release priority for the existing plugin; independent local M1–M3 source work proceeded in parallel. M0 status: **CI-01 completed** — a hosted Windows CI run on commit `5c1d89e` passed the frozen install, typecheck, full test suite (648 passing, 0 failing), package verification, and artifact upload, and the uploaded evidence was downloaded and checked locally. **CI-02 in progress** — local source work is complete (real verifier stage→validate passed locally; final post-remediation review GO) and the GitHub protections are applied and read-back verified (protected `npm-release` environment; active `v*` tag ruleset), while the npm trusted-publisher mapping is owner-reported configured (2026-10-19; independently unverified), the release variables were absent at the last check, and no hosted release run, tag, or OIDC publish has occurred; no version bump or publish authorized. Statuses: [roadmap](docs/V2/ROADMAP.md); owner setup runbook: [deployment plan](docs/V2/DEPLOYMENT.md) §2.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run verify:package   # host-free package verification
```

Design and validation records live under `docs/` in this repository; they are not part of the published package.

## License

MIT © 2026 Maivand Rahmani
