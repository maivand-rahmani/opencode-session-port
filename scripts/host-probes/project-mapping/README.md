# OQ-16 project-mapping probe (`scripts/host-probes/project-mapping`)

Windows-only, disposable, synthetic probe of the installed OpenCode TUI plugin client
surface for the OQ-16 runtime mapping/scoping questions. Public `context.client` APIs
only; built against the pinned `@opencode/plugin@2.0.22` interface shape.

## Files

- `run-project-mapping-probe.ps1` — self-contained runner. The probe plugin is embedded
  as a here-string and staged by the runner under the disposable root at
  `<root>\config\plugins\project-mapping-probe\tui.ts` (no other plugin is staged).

## What the runner does

1. Creates a unique root `C:\Users\PC\AppData\Local\Temp\opencode\sp-projmapping-<stamp>-<rand>`
   and redirects for its child processes only: XDG data/cache/config/state,
   `OPENCODE_CONFIG_DIR`, `HOME`, `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`, `APPDATA`,
   `LOCALAPPDATA`, `TMP`, `TEMP`, `TMPDIR`. The caller's environment is restored on exit.
2. Runs `opencode debug paths` **first**; aborts (exit 1) before plugin staging, TUI
   launch, or any API call unless all ten keys `home,data,cache,config,state,tmp,bin,log,repos,db`
   are present and resolve inside the unique root.
3. Stages only the probe plugin and launches the real runtime:
   `opencode --standalone --print-logs --log-level debug <root>\project`.
   `--standalone` selects the private server so no shared background service is reused.
   Only CLI flags recorded for this host in E32/E33 are used; no auto-update/model flags
   are guessed or added.
4. Plugin isolation gate: before any `ctx.client` access, the plugin verifies
   `os.homedir()`, `os.tmpdir()`, process cwd, every configured env root, and the result
   path resolve under the same `SP_PROBE_ROOT`; on failure it records a bounded result
   and performs **zero** API calls.
5. Probe sequence (all results sanitized; root prefixes become `<ROOT>`):
   capability detection without throwing on absence; `project.list()` before;
   `location.get({location:{directory}})` with an explicit target under root;
   `project.list()` after (state-added diff); omitted-input `location.get()` tested only
   against the known isolated server cwd; `project.list()` once more.
   The report states explicitly that location resolution persists/upserts project state
   in the isolated data store.
6. With `-WithImport`: exactly one synthetic public `session.import` to the same explicit
   target (unique runner-generated `ses_`/`msg_` + 64 lowercase hex IDs, synthetic content,
   no password/artifact), then one `session.get` readback compared to the `location.get`
   project ID and the explicit target. No retry. Import is opt-in and off by default.
7. Stops the process tree, verifies child/server exit, and only then removes the root.
   Raw host logs and the synthetic result stay under the root only; stdout carries only
   the bounded sanitized summary.

## Preconditions

- Windows host; `opencode` available on `PATH` (or pass `-OpenCodePath`).
- The approved temp base `C:\Users\PC\AppData\Local\Temp\opencode` exists (created if missing).

## Run

Baseline (no import):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\project-mapping\run-project-mapping-probe.ps1
```

Opt-in import (only after the baseline isolation gates pass and after review):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\project-mapping\run-project-mapping-probe.ps1 -WithImport
```

Diagnostics (keeps the root; remove it manually afterwards):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\project-mapping\run-project-mapping-probe.ps1 -KeepRoot
```

Optional parameters: `-TimeoutSeconds <30..900>` (default 180), `-OpenCodePath <path>`.

## Inspect

- stdout: `preflight:` per-key status line, `stop:`, `cleanup:`, `location.*`, `import.*`,
  and one `PROBE-RESULT-JSON: {...}` line with the full sanitized result.
- Exit codes: `0` ok; `1` preflight failure (no TUI/API calls were made); `2` TUI launched
  but no probe result; `3` stop/cleanup not verified (root kept); `4` runner error;
  `5` plugin isolation gate failed (zero client calls).
- With `-KeepRoot`, inspect under the printed root:
  - `<root>\results\probe-result.json` — sanitized probe result;
  - `<root>\log\preflight.*` / `<root>\log\tui.*` — raw host logs (never written outside the root);
  - `<root>\config\plugins\project-mapping-probe\tui.ts` — exact staged plugin.

## Evidence boundaries (do not overstate)

- One Windows host and one installed OpenCode version per run; no cross-version,
  cross-platform, or restart claims.
- Synthetic runner-generated IDs only; this does not validate SessionPort's BLAKE2b
  derivation, collision behavior, parent/fork cases, or any product flow.
- No direct database access, user data, model/prompt/tool/replay calls, or Git. Probe
  logic uses only public `context.client` APIs; possible OpenCode auto-update/network
  behavior is not disabled or claimed to be absent.
- `location.get` resolution persists/upserts project state in the isolated data store
  (observed via the `project.list` before/after diff). This is expected and reported
  explicitly; it does not establish a project-ID algorithm or stability.
- Omitted-input `location.get()` is tested only against the known isolated server cwd.
- Auto-update is not disabled because a version-appropriate flag was not verified. Any
  update-check/network behavior is unobserved; the probe does not claim to suppress it.
