# Checkpoint cleanup from SessionPort settings (2026-11-13)

## Scope

The owner asked for a command that deletes every checkpoint in the project's
`.sessionport` directory except the latest. It is exposed as the **Delete older
checkpoints** action inside the native SessionPort settings modal
(`/sessionport` or the command palette), not as a separate config or slash
command.

## Behavior

1. Resolve the active project directory from `context.location.directory`.
2. Scan `<project>/.sessionport` non-recursively.
3. Treat only regular files with the exact `.sessionport` suffix as checkpoint
   candidates; exclude the `recovery-` prefix, non-matching names, directories,
   and symlinks. Each candidate is re-checked with `lstat`.
4. Keep the newest candidate by `mtimeMs`; an exact tie breaks by filename
   descending UTF-16 code-unit order, matching bare `/restore`.
5. Ask for explicit host confirmation with the number of files to delete.
6. Delete exactly the planned older files. A file that disappears is skipped;
   every other filesystem error propagates to sanitized failure reporting.
7. Report `Deleted N older checkpoints. The newest checkpoint was kept.` or
   `No older checkpoints to delete.`

The scan is metadata-only. It never opens or decrypts an artifact, never
creates a temp file, and never deletes a recovery backup, a non-checkpoint
file, a directory, a symlink, or anything outside the active project's
`.sessionport` directory.

## Files

- `src/tui/artifacts/files.ts` — `planCheckpointCleanup` (read-only preview) and
  `deleteCheckpointArtifacts` (exact-file deletion with path/type guards).
- `src/tui/ui/settings-dialog.tsx` — two selectable rows; the cleanup row closes
  the modal before the host confirmation.
- `src/tui/wiring/install.ts` — active-directory lookup, confirmation copy,
  deletion, and toast reporting.

## Verification

| Check | Result |
| --- | --- |
| `tests/tui/artifacts/files.test.ts` | 24 pass / 0 fail (5 cleanup cases) |
| `tests/tui/ui/settings-dialog.test.tsx` | 4 pass / 0 fail (selection, toggle, cleanup callback, Esc) |
| Focused cleanup run | 49 pass / 0 fail, 5 files |
| Non-cloud full suite | 970 pass / 0 fail, 66 files |
| `bun run typecheck` | clean |
| `bun run build:tui` | `dist/tui.js`, 1,137,291 bytes |
| `bun run verify:package` | `ok: true`, no problems; 92 packed files |

## Limits and non-claims

- **No live destructive cleanup was run.** Tests use synthetic temp directories;
  the live host was not asked to delete real checkpoints.
- **Latest is by `mtimeMs`, not filename.** A copied or touched older artifact
  with a newer mtime is treated as the newest; this matches bare `/restore`.
- **Explicit checkpoints outside `.sessionport` are not touched.** The action is
  intentionally scoped to the default project directory.
- **Recovery artifacts are preserved.** They are restore backups, not user
  checkpoints.
- **No undo.** Deletion is permanent; the confirmation names the count and the
  directory scope.
- The active project directory must be available; otherwise the action reports
  `Open a project session first.` and changes nothing.
