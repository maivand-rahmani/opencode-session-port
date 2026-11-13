# Duplicate canonical project records — restore fix (2026-11-13)

## Symptom

Pressing the sidebar **Restore** action reported:

> Restore failed — The host project list could not be read; no sessions were changed.

The failure occurred before any artifact read, password prompt, import, or
delete.

## Root cause

The project-destinations adapter treated any repeated `Project.canonical`
directory as an ambiguous pair and rejected the whole listing. The live local
host (OpenCode 2.2.3) returned 16 project records with 4 canonical directories
shared by multiple project IDs:

| Diagnostic | Value |
| --- | --- |
| `project.list` records | 16 |
| Duplicate canonical groups | 4 |
| Duplicate-ID groups | 0 |
| First conflicting record | 8 of 16 |

These are historical project records for the same checkout, not malformed
records. Rejecting the list made restore unusable for this host.

## Fix

`mapProjectListResponse` now keeps multiple project IDs that share one canonical
directory and still fails closed on a repeated project ID with a different
canonical or label. `createProjectDestinationsAdapter().listDestinations()`
then:

1. Groups candidates by canonical directory.
2. For each group with more than one ID, calls the public read-only
   `location.get({ location: { directory } })` once.
3. Keeps the project ID the host resolves for that directory; a missing
   `location.get`, malformed response, non-matching directory, or an ID outside
   the group fails the listing closed.
4. Preserves host order and exact-duplicate deduplication.

No import, delete, database write, or plaintext file is involved.

## Verification

| Check | Result |
| --- | --- |
| `tests/tui/adapters/project-destinations.test.ts` | 19 pass / 0 fail (5 new duplicate-resolution cases) |
| Non-cloud full suite | 970 pass / 0 fail, 66 files |
| `bun run typecheck` | clean |
| `bun run build:tui` | `dist/tui.js`, 1,137,291 bytes |
| `bun run verify:package` | `ok: true`, no problems; 92 packed files |

Live read-only check against the local OpenCode 2.2.3 HTTP API (no credentials
or paths recorded):

- 16 `project.list` records produced **10 candidates with 10 unique canonical
  directories**.
- `createLocationResolver().resolveSelectedProject()` validated **9 of 10**
  candidates.
- The single mismatch is a **unique** canonical record whose `location.get`
  resolves to a different project ID; it is not the active project. Selecting
  it still fails closed with the existing location-mismatch report.
- No artifact was opened, no password was requested, and no session was
  imported or deleted.

## Limits and non-claims

- **No full restore or destructive test was run.** The live check only listed
  projects and resolved locations through read-only API calls.
- The host contract was inspected at pinned v2.0.22 and exercised on the
  installed 2.2.3 host; this is not a cross-version compatibility claim.
- A stale unique canonical record whose resolved project ID differs remains
  visible in the selector and fails at the existing location-validation step.
  Filtering it would require one `location.get` per candidate and is not part of
  this fix.
- Duplicate project IDs can carry sessions under more than one ID. The adapter
  keeps the host-resolved ID for the directory; sessions under historical
  duplicate IDs are not merged into the destination snapshot.
