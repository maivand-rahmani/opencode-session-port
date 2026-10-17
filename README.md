# SessionPort

**Encrypted session checkpoints for OpenCode.**

SessionPort is a local plugin for the OpenCode TUI. It captures the sessions of your current project into a single password-encrypted artifact and restores them in another checkout, worktree, or machine. Artifacts travel with Git or any other channel you choose — SessionPort never runs Git commands itself.

> **Status: experimental pre-release (0.1.4).** SessionPort completed one bounded synthetic checkpoint/restore round trip on Windows with OpenCode v2.0.22. That test used test-only password and project-selector seams and staged source, not the npm tarball. On one real Windows OpenCode v2.0.22 host, a bounded diagnostic observed both commands registered (`commands=yes`) but hidden from the command palette and slash list until the keymap layer opted into global mode; 0.1.2 applies that global-mode registration fix, with focused command-registration tests and the TUI build passing. 0.1.3 additionally enables the commands on macOS and Linux through an explicit platform allowlist (`win32`/`darwin`/`linux`). 0.1.2 and 0.1.3 are published to npm (0.1.3 latest, per a read-only registry check); 0.1.4 is the current local candidate. 0.1.4 is a diagnostics/copy patch only: a failed checkpoint collection now appends a fixed sanitized reason and the known machine code (`Reason: <fixed reason> (<code>).`) for the 17 current collection codes; unknown codes keep the generic text and raw host/exception text is never shown. Collector behavior is unchanged, and no root cause is established for an earlier Windows collection failure; a user later reported a local checkpoint succeeding from the repository checkout, which is not attributed to this patch. macOS has one user-reported successful checkpoint only; Linux is untested; restore and cross-OS artifact interchange remain unestablished. End-to-end execution from the packed package has not been host-tested. Real modal interactions and loading the packed package in OpenCode have not been verified. The checkpoint format may change; no compatibility, security, or platform-support guarantee is made.

## Commands

- **`/checkpoint [artifact-path]`** — collects the current project's sessions as returned by the host (child/subagent and archived sessions included when the host returns them) and writes one encrypted artifact. It fails cleanly, with no artifact, when the set is empty, a session cannot be captured completely, or the output file already exists.
- **`/restore <artifact-path>`** — decrypts and validates the artifact before session imports, then restores it into an existing project you select. Restore does not overwrite existing sessions: exact destination matches are skipped, conflicting IDs are remapped deterministically, and parents are imported before children.

Both commands are registered by the plugin as `sessionport.checkpoint` and `sessionport.restore`, and appear in the slash-command list and the command palette.

## Requirements

- OpenCode with the v2 TUI plugin API (exercised with OpenCode v2.0.22).
- Windows, macOS, or Linux. The build enables the commands on all three through an explicit platform allowlist (`win32`/`darwin`/`linux`); other platforms are not enabled. Windows has the bounded host evidence above; macOS and Linux are enabled but NOT host-tested, and cross-OS artifact interchange is UNVERIFIED.

## Install

Add the plugin to the `plugins` array in your global CLI-only config (`cli.json`):

```json
{
  "plugins": ["opencode-session-port@0.1.4"]
}
```

Or install the package plugin with the OpenCode CLI:

```sh
opencode plugin add opencode-session-port@0.1.4
```

`cli.json` is the documented OpenCode v2 config for CLI-only plugins: they run locally in the terminal and remain active when the CLI connects to a remote server. The npm registry shows 0.1.2 and 0.1.3 published (0.1.3 latest; read-only registry check); no published artifact has been loaded by OpenCode here, and no local package-verification record exists for the published 0.1.3 tarball. The 0.1.1 tarball passed npm consumer checks, but a direct Bun package-manager install timed out in the verification environment, so that install path remains unverified. The 0.1.2 tarball passed manifest/allowlist and packed-entry checks only. The 0.1.4 candidate tarball passed the same local manifest/allowlist and packed-entry checks (including the sanitized collection-failure copy); it is not published.

## Usage

### Checkpoint

```text
/checkpoint [artifact-path]
```

Without an argument, the artifact is written to `.sessionport/checkpoint-<UTC timestamp>.sessionport` inside the current project. An argument overrides the location (absolute, or relative to the project). An existing file is never overwritten — a collision fails the checkpoint.

Checkpoint prompts for a password twice in a masked input (paste is allowed); both entries must match. Strength guidance is advisory — weak passwords are not rejected.

### Restore

```text
/restore <artifact-path>
```

Restore first asks which existing project to import into, then prompts for the password (up to three attempts). The artifact is fully checked before the first session import. Project resolution may still update bounded host project metadata through OpenCode's public `location.get` API. Imports run parents-first, one session at a time: independent branches continue after a failure, descendants of a failed parent are blocked, and outcomes are reported per session. There is no atomic rollback. A later manual rerun may skip exact matching records, but exact retry behavior on a real host has not been established. Imported sessions are not opened or navigated to automatically.

### Moving artifacts

Move the artifact with Git (commit it, stash it, or sync it your own way) or any other channel. SessionPort never runs Git commands, and the password is never stored with the artifact or in the repository — if you lose it, the artifact cannot be recovered.

## Security notes

- Encryption is mandatory: no plaintext fallback, no plaintext temporary file.
- Payloads are compressed, then encrypted with an Argon2id-derived key and XChaCha20-Poly1305 secretstream; truncated or tampered artifacts are rejected.
- Password input is masked and capped at 4 KiB of UTF-8. SessionPort does not intentionally log it, write it to disk, or copy it to the clipboard. JavaScript strings cannot be reliably zeroed; no secure-erasure claim is made.
- Protection applies to the artifact at rest only. Git history and metadata, a compromised machine, and secrets copied into session content are outside SessionPort's protection; no secure-deletion promise is made.
- SessionPort makes no model/LLM calls and never replays historical tool calls.

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
