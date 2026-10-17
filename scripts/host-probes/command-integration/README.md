# SessionPort command-integration probe (`scripts/host-probes/command-integration`)

Windows-only, disposable, synthetic end-to-end probe of the newly wired `/checkpoint`
and `/restore` commands through the actual installed OpenCode v2.0.22 TUI plugin runtime
and its public client surface. Exactly one synthetic `/checkpoint` → `/restore` round
trip per run.

Authorized scope (E46/Gate4, `ora-33`): synthetic, isolated Windows actual-TUI/plugin
validation only. This is not a production approval, packaging validation, or
compatibility claim.

Owner log-boundary clarification (2026-10-15): ordinary OpenCode-managed logs inside
this isolated sandbox are permitted. The runner/harness never reads or copies them,
discards raw child output, and removes the sandbox only after verified shutdown and
safe cleanup; if cleanup cannot be verified the sandbox is retained and the test
fails. No claim is made that host-managed logs are absent or securely erased.

## Files

- `run-command-integration-probe.ps1` — self-contained runner. The probe plugin is
  embedded as a here-string and staged by the runner under the disposable root at
  `<root>\config\plugins\sp-command-probe\tui.ts` (no other plugin is staged).

## What the runner does

1. **Default invocation is non-executing.** Without `-RunProbe` it only validates its
   own preconditions (Windows host, repository paths, embedded-plugin markers, required
   safety functions) and prints usage. It creates no root, starts no process, and
   changes no environment; when the approved temp base already exists it also reports
   that base's reparse-gate status.
2. **With `-RunProbe`** it creates a unique root
   `C:\Users\PC\AppData\Local\Temp\opencode\sp-command-<stamp>-<rand>` only after a
   conservative physical-path gate: the approved base must exist as a real directory
   and no existing ancestor from the drive root down (including the base) may be a
   reparse point (junction, symlink, mount point). It then temporarily sets the child
   environment snapshot — XDG data/cache/config/state, `OPENCODE_CONFIG_DIR`,
   `OPENCODE_CLI_CONFIG_CONTENT` (explicit inline debug-diagnostic override; see
   step 5), `HOME`, `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`, `APPDATA`,
   `LOCALAPPDATA`, `TMP`, `TEMP`, `TMPDIR` (E42 mechanics) — in the runner process
   only around each child creation.
   The child inherits a copy at child-creation time; the runner restores the original
   values immediately after each child is started, so a normal invocation does not
   leave the caller's environment changed.
3. Runs `opencode debug paths` **first**; aborts (exit 1) before staging, TUI launch,
   or any plugin/client call unless all ten keys
   `home,data,cache,config,state,tmp,bin,log,repos,db` are present and resolve inside
   the unique root. That command's stdout is captured in memory only, solely to parse
   the ten-key path map, under an explicit bounded harness-output cap (65,536 bytes):
   any byte beyond the cap marks a fixed-safe overflow and fails the gate closed while
   the capture keeps draining and discarding, so the child can never block; its stderr
   is drained and discarded; neither stream is written to disk. The preflight root
   itself is terminated only through a native
   handle opened by its PID once and identity-verified against the returned process
   object (PID, creation FILETIME, creator identity) before any descendant is
   attributed. Descendants of that preflight command are stopped only through process
   handles whose identity (creation time + creator PID) was proven **while the parent
   each was created from was still alive** (for first-level descendants, the preflight
   parent itself); a possible descendant that cannot be proven that way, or a
   traversal that reaches a depth/count bound with a remaining frontier, refuses
   staging and force-retains the root (exit 3). No descendant is ever attributed or
   killed after the parent it was created from exits, and nothing is terminated by a
   bare/stale PID.
4. **Stages only inside the disposable root**: a copy of the repository `src` tree,
   `package.json`, and `tsconfig.json` under `<root>\repo`, a junction
   `<root>\repo\node_modules` pointing at the developer checkout's `node_modules`
   (the link itself lives inside the root; the target is read-only for the probe), and
   the embedded probe plugin under the disposable `OPENCODE_CONFIG_DIR` plugins folder.
   `tsconfig.json` is staged because the product's `.tsx` modules require the
   `jsxImportSource=@opentui/solid` setting at transpile time.
5. Launches the real TUI runtime: `opencode --standalone <root>\project`, with the
   child's stdout and stderr drained and discarded in memory. `--standalone` selects
   the private server so no shared background service is reused. No debug/log flags
   are passed and no raw child output is captured or persisted by the runner (no
   redirect files exist); no auto-update or model flags are guessed or added. Every
   child launch also sets `OPENCODE_CLI_CONFIG_CONTENT` to the explicit valid JSON
   `{"debug":{"devtools":false,"timing":false,"turn_tokens":false}}` — the three
   documented debug diagnostics set to false — so an inline CLI override inherited
   from the caller's environment cannot enable them. This is an explicit
   documented-config override, not a host-log disable control, and it makes no claim
   about host-managed logs. The inline content contains only those three documented
   debug fields, so the isolated config-directory plugin discovery and the other
   isolation settings are unchanged.
6. **Plugin isolation gate**: before its first `ctx.client` call, the plugin verifies
   `os.homedir()`, `os.tmpdir()`, process cwd, every configured env root, and the
   project/target/artifact/result/repo paths resolve under the same `SP_PROBE_ROOT`;
   on failure it records a bounded result and performs **zero** client calls.
7. The plugin dynamically imports the in-root staged repo copy and calls the real
   `installSessionPortWiring(ctx, { requestPassword })` with product-default crypto
   factory and ID deriver. `installSessionPortWiring` exposes no dialog seam, so the
   probe passes a context whose dialog members are wrapped. Four surfaces are
   wrapped for the probe:
   - `ui.dialog.select` — a test-only adapter that chooses only the predeclared
     restore-target candidate `{projectID, targetDirectory}` (exact match, otherwise it
     cancels);
   - `ui.dialog.show` — bounded capture of the call count only (an operation-completion
     proxy for restore; the report dialog can represent failed/blocked outcomes, so this
     is not import-success evidence); the original host
     `show` is invoked unchanged with the original dialog object, and no dialog content
     is read; and
   - `ui.toast.show` — bounded capture of fixed-safe `{variant, messageLength}` facts
     only; raw toast titles are never recorded (notifications are recorded, not
     displayed); and
   - `client.session.import` (product-wiring context only) — a sanitized
     attempt/response observation: capped `calls`/`resolved`/`rejected` counts plus an
     `overflow` fact, and, for the latest resolved host response within the cap,
     in-memory booleans (`responseShapeValid` for a direct unwrapped SessionInfo object
     with nonblank `id`/`projectID`/`location.directory`; `returnedIdMatchesRequest`;
     `requestSessionIdMatchesDerivedExpected` / `requestMessageIdsMatchDerivedExpected`
     / `returnedIdMatchesDerivedExpected` for comparisons against the expected
     remapped IDs derived in memory from the authenticated artifact;
     `returnedProjectIdMatchesPredeclaredTarget`;
     `returnedLocationMatchesPredeclaredDirectory`). The original session object stays
     the receiver, arguments/return/rejection pass through unchanged, no `.data`
     envelope is unwrapped, and no IDs, directories, messages, response objects, or
     exception text are recorded. The runner's own seed/read calls use the original
     client, not this wrapper.
8. **Command invocation is model-free through the public keymap surface.** The probe
   waits until both `sessionport.checkpoint` and `sessionport.restore` are reachable in
   `ctx.keymap.commands()` and then invokes each registered ID exactly once through the
   public `keymap.dispatch(id, input)` method. There is no `command.run` callback
   fallback: if `keymap.dispatch` is missing the probe fails with a distinct bounded
   code before any invocation. This bypasses slash parsing and key input, which remain
   untested. Dispatch returns `void` and is asynchronous from the harness perspective
   (the host attaches rejection handling and reports handled without awaiting the
   command handler, E39), so after each dispatch the probe waits with a fixed bounded
   per-command deadline (45s, inside the default overall TUI timeout) for a product
   completion signal: a new captured `ui.toast.show` notification, or for restore a new
   captured report-dialog `ui.dialog.show`. On timeout the probe records a distinct
   sanitized failure code (`checkpoint-completion-timeout` /
   `restore-completion-timeout`) with the captured call/notification/dialog counters
   preserved, and the runner's existing process-tree cleanup stops the probe.
9. **Synthetic round trip** (no retries, no user sessions, no direct database access):
   - seed exactly one settled session through the public `session.import` with an
     explicit source location and synthetic `ses_`/`msg_` + 64 lowercase hex IDs and
     synthetic text; verify it with `session.get`/`message.list`/`session.list`;
   - invoke `/checkpoint` with an explicit artifact path under the root and wait for its
     captured completion signal; verify the encrypted artifact exists with a plausible
     nonzero size and does not contain the synthetic plaintext markers or the password
     bytes;
   - resolve a separate explicit restore-target directory via one `location.get` and
     verify the exact `project.list` ID/canonical pair before declaring the candidate;
   - invoke `/restore <artifact>` and wait for its captured completion signal (toast
     notification or report-dialog show); the `dialog.select` adapter picks only that
     predeclared pair; the final sanitized import audit is captured into
     `result.restore.importAudit` on every completed probe path, including bounded
     completion/verification failures;
   - verify the imported result in the target project with
     `session.list`/`session.get`/`message.list` (session ID and message IDs compared
     against the independently derived expected remapped IDs, project ID, directory,
     message count/types/content, settled assistant message) and confirm the seeded
     source session is preserved unchanged by public readback.
10. Stops the process tree with identity-verified native handles only: at each launch
    the runner opens the root by its PID once and verifies the opened instance against
    the returned process object (PID, creation FILETIME, creator identity as
    the runner process), retaining that handle for all root liveness, termination, and
    survivor decisions; if that open or verification fails the tracker is ambiguous and
    the run fails closed (no `Process.Kill`, no PID-based stop). Each descendant is
    terminated only through the OS handle whose identity (creation time + creator PID
    read from that same handle) was proven while its parent was alive. It verifies
    root/descendant exit through those handles, walks the post-stop parent-PID evidence
    for any live process that was not proven (refusing, never killing, on any such
    process), re-runs the reparse-point gate on the root/ancestor chain, removes the
    staged junction **link-first**, refuses recursive removal if any unexpected reparse
     point remains inside the root, and only then removes the root. Child stdout/stderr
     are drained and discarded in memory and no raw child output is captured or
     persisted by the runner (no redirect files exist); the only runner-written file
     under the root is the sanitized synthetic result. The host may still write its own
     internal logs under the disposable root at its default level; those are host
     behavior, not harness capture, are permitted by the owner (2026-10-15), and are
     removed with the root only after verified stop and safe cleanup. The runner/harness
     never reads or copies those logs, and no claim is made that they are absent or
     securely erased. Stdout includes the
     bounded summary plus the installed executable and disposable-root paths; do not
     describe or redistribute the full stdout as path-free. The import-audit fields
     themselves contain only capped counts and booleans/nulls, not IDs, directories,
     response data, or exception text.

The synthetic password is generated in memory inside the plugin (32 random bytes per
run) and is never written to disk, stdout/stderr, the result JSON, or logs.

## Preconditions

- Windows host; `opencode` available on `PATH` (or pass `-OpenCodePath`).
- The approved temp base `C:\Users\PC\AppData\Local\Temp\opencode` (created if missing
  in `-RunProbe` mode, after its existing ancestor chain passes the reparse-point
  gate). The base and every existing ancestor from the drive root down must be free of
  reparse points (junction, symlink, mount point); otherwise the runner refuses to
  create a root and exits 1 rather than operating through a redirected path.
- The repository checkout is complete (`src`, `package.json`, `tsconfig.json`,
  `node_modules` with `libsodium-wrappers-sumo`, `pako`, `solid-js`, `@opentui/*`).

## Run

Validation only (default; starts nothing):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\command-integration\run-command-integration-probe.ps1
```

Actual isolated probe (starts the installed TUI; only after review). This default
invocation, with no `-KeepRoot`, is the authorized single-run form:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\command-integration\run-command-integration-probe.ps1 -RunProbe
```

Diagnostics only — not part of the authorized default run (keeps the root; remove it
manually afterwards without reading or copying ordinary host logs):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host-probes\command-integration\run-command-integration-probe.ps1 -RunProbe -KeepRoot
```

Optional parameters: `-TimeoutSeconds <30..900>` (default 180), `-OpenCodePath <path>`.

## Cleanup and retention

- **Ordinary probe failures clean up by default.** Preflight validation, timeout,
  missing-result, isolation, and verification failures that stop cleanly (exit 1/2/5/6)
  remove the disposable root once the process tree is verified stopped and the
  path/junction/reparse checks pass.
- **No raw child output is captured.** Child stdout/stderr are drained and discarded
  in memory: the preflight stdout is captured under an explicit bounded cap (65,536
  bytes, harness-output guard only) and parsed in memory, preflight stderr is
  discarded, and the TUI child's stdout/stderr are both discarded. Output beyond the
  preflight cap fails the gate closed as a fixed-safe overflow (never truncated into a
  pass); no redirect files exist and no raw child-output files are kept for
  inspection. If a root is retained, host-internal logs the host itself writes
  (default level) may remain under `<root>\log`; do not read or copy them; remove them
  together with the root.
- **Process termination is identity-bound.** The runner has no raw-PID termination
  utility or PID-addressed stop path. The root is terminated only through a native
  handle opened by its PID once at launch and verified against the returned process
  object (PID, creation FILETIME, creator identity); if that handle cannot be opened
  or verified, the run fails closed with the root retained. Descendants are terminated
  only through OS handles whose creation time and creator PID were read and verified
  from that same handle while their parent was alive. A descendant whose ownership
  cannot be proven, or any traversal that reaches a depth/count bound with a remaining
  frontier, is never killed and never reported as a clean stop.
- **`-KeepRoot` retains the disposable root (diagnostic only; not part of the
  authorized default run).** It is left in place for manual inspection of runner
  mechanics (sanitized result, staged files); a retained root may also contain
  host-managed logs, which must not be read or copied. Remove the whole root manually
  afterwards.
- **Unsafe conditions force-retain the root.** If the process-tree stop cannot be
  verified, the root/ancestor chain contains a reparse point, the known
  `repo\node_modules` junction cannot be removed link-first, or any unexpected reparse
  point remains inside the root, the runner refuses recursive removal, keeps the root,
  and reports cleanup failure (exit 3) instead of treating the run as clean. If
  cleanup cannot be verified, the sandbox is retained and the test fails; a bounded
  retained-root failure is the preferred outcome over any uncertain termination.

## Inspect

- stdout: `VALIDATION-OK` (or `validation-failure:` lines) in default mode; in
  `-RunProbe` mode `preflight:` per-key status, `staging:`, `plugin:`, `stop:`,
  `commands:`, `checkpoint:`, `restore:`, `restore-import:`, `verification:`,
  `failure:`, and one `PROBE-RESULT-JSON: {...}` line with the full sanitized result.
- Exit codes: `0` ok; `1` validation/preflight failure (no TUI/API calls were made);
  `2` TUI launched but no probe result; `3` stop/cleanup not verified (root kept);
  `4` runner error; `5` plugin isolation gate failed (zero client calls); `6` probe
  result produced but the round trip was not verified.
- With `-KeepRoot`, inspect under the printed root:
  - `<root>\results\probe-result.json` — sanitized probe result (booleans/counts only;
    no paths, IDs, or password material), including the `restore.importAudit`
    attempt/response facts for the product-wiring `client.session.import`;
  - `<root>\log` — possible host-internal logs written by the host itself at its
    default level; they are permitted by the owner (2026-10-15) but the runner/harness
    never reads or copies them, and they are removed with the root (the runner adds no
    debug flags and keeps no raw child-output files; the preflight path map is captured
    under a bounded in-memory cap and never written here);
  - `<root>\artifacts\checkpoint-artifact.bin` — the encrypted checkpoint artifact
    (ciphertext only);
  - `<root>\config\plugins\sp-command-probe\tui.ts` — exact staged plugin;
  - `<root>\repo` — staged source copy + dependency junction.

## Claims and bounds (do not overstate)

- **One Windows host and one installed OpenCode version per run.** Runtime evidence is
  bounded to that host/run; no cross-version, cross-platform, restart, concurrency, or
  general host-behavior claim follows.
- **Component/keymap dispatch, not the slash parser.** The probe invokes each
  registered command exactly once through the public keymap command surface
  (`keymap.commands()` registration check + `keymap.dispatch(id, input)`); no
  `command.run` callback is used. Actual slash parsing, prompt input, and keyboard
  dispatch are not exercised. Dispatch returns `void` and the host does not await the
  command handler (E39 observed programmatic dispatch; the v2.0.22 host attaches
  rejection handling and reports handled without awaiting the returned promise), so
  completion is asynchronous from the harness perspective and is inferred only from
  bounded probe-side UI captures (a new toast notification, or the restore
  report-dialog show) within a fixed per-command deadline — never from a host
  completion handle or a dispatch return value.
- **Test providers, not the real modals.** The password provider is a probe-only
  in-memory random provider (not a product password channel), and `dialog.select` is a
  test adapter that always chooses the predeclared restore-target candidate. The real
  masked password modal and the real project-selection modal are not exercised. The
  restore report dialog is shown by the host unchanged; the probe only counts its show
  call and reads no dialog content.
- **E42 `location.get` persistence side effect.** The explicit `location.get` calls
  (probe verification + product checkpoint/restore resolution) can persist/upsert
  project state in the disposable isolated store. This is expected, bounded, and
  observed via the `project.list` check; it establishes no project-ID algorithm,
  stability, or canonical-path generalization.
- **Import audit = sanitized attempt/response facts, not content or persistence
  proof.** `result.restore.importAudit` records only bounded counters/booleans for
  the product-wiring context's public `client.session.import` calls: capped
  `calls`/`resolved`/`rejected` counts with an `overflow` fact, plus in-memory
  comparisons of the latest resolved host response within the cap (shape validity of a
  direct unwrapped SessionInfo; returned ID vs. the request; returned
   `projectID`/`location.directory` vs. the predeclared restore-target candidate;
   request session/message IDs and returned session ID vs. independently derived
   expected IDs obtained from the authenticated artifact in memory).
  It captures no report content, no IDs, directories, messages, response objects, or
  exception text, and it neither proves persistence nor decides success — the product
  adapter lane owns shape/ID validation, and the probe's own seed/read calls remain on
  the original client.
- **Junction/copy ≠ packaging support.** The probe stages a source copy and a
  dependency junction inside the disposable root. This is not a packaged, bundled, or
  distributable artifact, and it makes no packaging, installation, or distribution
  claim.
- **Conservative refusals, not path resolution.** The reparse-point gate rejects any
  reparse point in the base/root ancestor chain and refuses recursive removal while any
  unexpected reparse point remains inside the root; root and descendant ownership are
  proven from process handles (root: PID + creation FILETIME against the
  returned process object + creator identity; descendants: creation time + creator PID
  read from the same handle, parent alive at observation) and anything unprovable or
  bounded-out fails closed (root retained, exit 3). These refusals retain the root;
  they are not cleanup guarantees beyond the recorded run.
- **No general security claim.** The artifact checks (nonzero size, no synthetic
  plaintext markers or password bytes in the scanned prefix) are sanity facts for this
  synthetic run, not a cryptographic audit. SessionPort's BLAKE2b derivation, collision
  behavior, parent/fork cases, retry/partial-failure semantics, and any
  cross-platform behavior are not validated here.
- **Auto-update cannot be ruled out.** No auto-update flags are used because none were
  verified for this host; possible background host auto-update/network behavior is not
  disabled and is not claimed to be absent.
- **No raw child output is captured.** The runner passes no debug/log flags and
  drains/discards child stdout/stderr in memory (no redirect files). Every child
  launch additionally sets the documented inline CLI config
  (`OPENCODE_CLI_CONFIG_CONTENT`) to valid JSON that sets only the three documented
  debug diagnostics (`debug.devtools`, `debug.timing`, `debug.turn_tokens`) to false,
  so an inline CLI override inherited from the caller's environment cannot enable
  them; this is an explicit documented-config override, not a host-log disable
  control. The preflight
  path-map capture is bounded by a fixed 65,536-byte harness-output cap; the cap is a
  runner-side diagnostic guard, not a product crypto/payload limit, and an overflow
  fails the preflight closed with a fixed-safe marker instead of truncating a pass.
  Ordinary host-managed logs under the disposable sandbox are permitted by the owner
  (2026-10-15 clarification) and are never read or copied by the runner/harness; they
  are removed with the root only after verified shutdown and safe cleanup, and no
  claim is made that they are absent or securely erased. The sanitized result and
  bounded stdout summary are the only runner-emitted diagnostics.
- **No user data, no direct database access, no Git.** Only synthetic IDs/messages and
  public client methods are used; the probe never inspects or writes the host database
  directly, never touches user sessions, and never calls a model, prompt, tool, or
  historical replay.

## Known probe limitations

- The host plugin loader is assumed to resolve the staged plugin's relative import into
  `<root>\repo` (and the dependency junction beneath it). This was validated by static
  path resolution and a bundling dry run against a simulated in-root layout, not by an
  actual host run; a loader that copies or sandboxes plugins differently would fail
  bounded at the `repo-import` stage.
- Child output is discarded: the runner passes no debug flags and captures no child
  stdout/stderr to disk (no redirect files), so host diagnostics beyond the sanitized
  result and the bounded stdout summary are not available from a run; host-internal
  logs under the disposable root are the host's own, are never read or copied by the
  runner/harness, and are removed with the root. The only in-memory capture is
  the bounded preflight path-map read (65,536-byte harness cap); a debug-paths output
  larger than the cap fails the preflight closed rather than being truncated.
- The inline CLI debug override is validated statically only: the default validation
  run asserts that the child inline CLI config value is valid JSON whose only settings
  are the three documented debug diagnostics set to boolean false, that the variable
  is covered by the environment backup set, and that the child environment map wires
  it from the JSON constant. It is an explicit documented-config override; it is not a
  host-log disable control, and it makes no claim that host-managed logs are absent.
- Command completion is inferred, not observed directly: the probe waits on bounded
  probe-side UI captures (a new toast notification, or the restore report-dialog show)
  with a 45s per-command deadline that fits inside the default overall TUI timeout. A
  command that completes without producing any captured signal fails with a distinct
  sanitized timeout code instead of a false success.
- Root and descendant ownership are proven, not assumed: the root is terminated only
  through a native handle opened by its PID once and verified against the
  returned process object (PID, creation FILETIME, creator identity), and a descendant
  only through an OS handle whose creation time and creator PID were read from that
  same handle and verified while its parent was alive, so a reused PID cannot redirect
  termination to an unrelated process. A descendant that cannot be proven that way, or
  a traversal that reaches a depth/count bound with a remaining frontier, is never
  killed and force-retains the root (exit 3) instead of claiming a verified clean
  stop. Residual bound: Windows preserves only the immediate `ParentProcessId`, so a
  process whose parent-PID chain passes through an intermediate that was never
  observed while alive is outside this probe's stop-time evidence; it is never killed,
  and the stop verification covers only processes reachable from the root/proven PIDs
  via parent-PID links at stop time.
- Single synthetic round trip in one run; no retry, conflict, partial-import, or
  teardown/disposer-invocation cases (E39 cleanup ownership remains untested).
- Host project-list variance (for example a malformed record) fails the restore
  fail-closed before any import, by product design; the probe reports that as a bounded
  failure.
- Derived session/message-ID readback is a hard gate, alongside artifact checks,
  target project/directory/content checks, source-ID absence in the target list,
  and preservation of the seeded source title, scope, listing, message IDs,
  message text/types, and settled assistant state through public readback.
- The import audit is observation-only: `null` means the fact was not observed (no
  import call, no resolved response within the bounded cap, or a missing comparison
  reference), and calls beyond the small fixed cap set only the `overflow` fact. A
  product path that never reaches the import (or an import still in flight when the
  result is written) yields absent fields, not a failure code.
