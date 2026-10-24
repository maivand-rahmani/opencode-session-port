# Native replacement TUI probe (M1)

Status: source implemented, focused tests pass, and the single-file TUI bundle was
transpiled and loaded headlessly. The live first attempt failed at `preflight`/`isolation`
before any import or navigation; the root cause and source fix are recorded below. This lane
did not retry the host. The import-only path is unchanged by default; the explicit
`-ArchiveProbe` path adds one archive call, canonical readback, and one 60 second recovery
unarchive. The plugin and its tests did not launch a host, call a live API, open a database,
read credentials, run Git, or edit config. This probe does not close HOST-01 or claim M1
success; composer, picker, manual continuation, and archive UI behavior remain separate gates.

This probe answers one narrow native-UI question: can the ordinary TUI plugin path import two
fresh parentless synthetic roots, verify their public readback and ordered histories, then leave
the native session route visible on the candidate for the runner's observation window? It does
not archive the old root in this first native-UI probe.

## Files

| Path | Purpose |
| --- | --- |
| `entry.tsx` | Ordinary `Plugin.define` TUI entry plus a narrow testable core. |
| `entry.test.ts` | Focused fake-context tests, exact result-schema/writer tests, and a static source guard. |
| `README.md` | This contract and run note. |

The bundled artifact is generated at:

```text
.package-verify-work/m1-native-tui-plugin-20261024/tui.tsx
```

The bundle is one file. `@opencode/plugin/tui`, `@opentui/core`, `@opentui/solid`, and
`solid-js` stay external so the host resolves its own framework copies; `fixtures.ts` is
bundled in. No registry dependency install is performed.

## Expected runner mode

The owner-facing wrapper is fixed-mode and exposes no mode/version/plugin-path override. The
correct owner command is:

```powershell
scripts/host-probes/native-replacement/run-tui-probe.ps1 -RunProbe
```

The wrapper pins `-ProbeMode NativeReplacement`, `-ExpectedVersion 2.1.1`, a 90 second owner
observation window, and a 180 second timeout. The underlying runner command for the runner lane
is:

```powershell
scripts/host-probes/sync-anchor/run-sync-anchor-probe.ps1 `
  -ProbeMode NativeReplacement `
  -ExpectedVersion 2.1.1 `
  -RunProbe
```

The runner must provide exactly:

| Variable | Meaning |
| --- | --- |
| `SP_PROBE_ROOT` | Fresh disposable probe root. |
| `SP_PROBE_PROJECT` | The isolated project directory, under the root. |
| `SP_PROBE_RESULT` | `<root>/results/probe-result.json`, strictly under `<root>/results/`. |

The plugin fails closed before any API call when any variable is missing or non-absolute, the
project is outside the root, the result path is outside `<root>/results/`, the host project
readback is missing/outside the root/unrelated to the isolated project (the raw location
directory is informational and may be a subroot), a required directory is a symlink/non-directory,
or the result path is a symlink/non-file. Results are written to a `wx` temporary file and
renamed atomically; the result is capped at 4 KiB.

The existing runner already resolves the bundle at the artifact path above and stages it as
`tui.tsx`. If the bundle is unavailable, the runner's current source fallback expects
`tui/ui.tsx` plus `tui/fixtures.ts`; this source is `tui/entry.tsx` importing `../fixtures.ts`.
The runner lane must either use the bundle (preferred) or update that fallback. This lane did
not edit runner scripts.

## Isolation fix after the live first attempt

The live result was `stage: "preflight"`, `reason: "isolation"` with zero imports and Home
still visible. The result writer's env-only path gate passed and the result was written under
`results`, so the env root/project/result paths, results directory, and symlink checks were
valid. The only remaining preflight condition was the context location check.

Exact source bug: `checkIsolation` compared the raw `context.location.directory` to
`SP_PROBE_PROJECT` with equality. That raw field is the requested location/cwd and may be a
subroot of the host workdir; the host's resolved project path is
`context.location.project.directory` (or `.canonical`). The fix:

- use the host project readback as the expected project identity; require it to be the isolated
  project, a subroot, or a parent inside the root, and require it under the root;
- ignore the raw `location.directory` for the project guard; it may be a subroot or a different
  runtime cwd;
- wait up to 1000 ms for the host project readback before failing isolation;
- a missing host project readback fails closed; there is no raw-cwd fallback;
- leave the env root/project/result, symlink, and 4 KiB guards unchanged.

The actual runner `New-ProbeEnvironmentBlock` output is exercised by a contract test rather than
a copied env fixture. It supplies `SP_PROBE_ROOT`, `SP_PROBE_PROJECT`, `SP_PROBE_RESULT`, and
`SP_PROBE_PHASE=probe`; it does not set `SP_PROBE_ISOLATED`. The test passes the live
source-verified shape (`location.directory` subroot, `project.directory` equal to the isolated
project) through `validateIsolation`. A raw location outside the project with a correct host
project readback is ignored and passes; missing host project, host project outside, and result
path outside fail. The generated bundle is tested against the same actual env contract.

## Archive probe (`-ArchiveProbe`)

The owner-facing archive command is:

```powershell
scripts/host-probes/native-replacement/run-tui-probe.ps1 -RunProbe -ArchiveProbe
```

`-ArchiveProbe` is valid only with `NativeReplacement`; the runner and wrapper reject other
combinations. The default invocation (no `-ArchiveProbe`) keeps the existing import-only v1
behavior and does not set `SP_PROBE_ARCHIVE`. In archive mode the runner sets the fixed
`SP_PROBE_ARCHIVE=1`; the plugin enables the archive branch only for that exact value.

The archive branch reuses the same two fresh parentless synthetic roots, canonical host
project/time checks, and exact 2/3 history verification. It then:

- requires the old root to be canonically active and the candidate history verified;
- calls only the public `session.update({ sessionID: oldID, archived: true })` through a narrow
  structural adapter. The pinned 2.0.22 type does not expose the field; the runtime 2.1.1 host
  client may. No cast-then-assume-pass is used.
- never updates the candidate, deletes, removes, lists sessions, prompts, calls a model, or
  runs a tool;
- ignores the update response/204 as proof and performs a canonical `session.get` readback.
  `time.created`/`time.updated` must be valid numbers; missing `time.archived` means active;
  a numeric `time.archived` means archived; any other value is unknown.
- unsupported or active readback is non-applied, does not unarchive, leaves both roots active,
  and cannot pass. A transport error triggers one read-only readback; archived is treated as
  applied with `archiveCall:"error"` retained; no blind archive retry.
- when archived is observed, invalidates and syncs the old and candidate public caches, then
  routes to the candidate. The plugin leaves the native route visible.
- writes the initial v2 result with `ok:false`, `recoveryReadback:"not-read"`, and
  `recoveryVerified:false` so the 90 second owner window starts while the old root is archived.
- schedules one bounded 60 second timer (only the two own IDs) to unarchive the old root once,
  then performs a canonical GET and verifies active plus unchanged old history. On success it
  invalidates/syncs the caches and writes the final v2 result atomically. A cleanup handler
  cancels the timer if the plugin unmounts; no foreign mutation is performed.
- keeps `composerNotTested:true` and `pickerNotTested:true`. API list results are never used as
  a picker claim. Manual owner picker observation is separate evidence.

The archive result is the exact 18-key v2 schema: the existing 13 fields plus
`archiveCall` (`not-attempted|accepted|error|unsupported`), `archiveReadback`
(`active|archived|unknown|not-read`), `recoveryReadback`
(`active|archived|unknown|not-read`), `recoveryVerified`, and `mutationTargetOldOnly:true`.
`archiveNotTested` is false only when the update was actually attempted; otherwise true.
`ok:true` requires `complete`, the 2/3 history, parentless, an observed candidate route,
`archiveReadback:"archived"`, `archiveNotTested:false`, `recoveryReadback:"active"`,
`recoveryVerified`, and `mutationTargetOldOnly`. The v1 native sanitizer is untouched; archive
v2 has its own fixed sanitizer and 4 KiB cap.

The runner reads the initial archive result, runs the 90 second observation window, re-reads
the same fixed result file after the window, and uses the final v2 result for its exit code. A
direct runner invocation with `-ArchiveProbe` and fewer than 90 observation seconds fails
closed; use the wrapper. The runner prints one sanitized `ARCHIVE-RECEIPT` console line with
exit/safe/stop/cleanup/final-ok values; no profile path, stdout, transcript, or arbitrary error
text is persisted. No `last-run.json` file is written in this bounded version; the console
receipt plus the printed v2 result JSON are the future-owner handoff.

Owner observation during the 90 second window:

- 0–60 seconds: open the native picker manually and observe whether the archived old root is
  hidden/excluded. Do not infer this from an API list and do not type Enter.
- After about 60 seconds: the plugin unarchives the old root and verifies it active. Observe
  whether the old root is visible again. Do not type Enter.
- The initial result is intentionally `ok:false`; the final file is `ok:true` only if recovery
  verifies. The runner re-reads it after the window.

## Behavior

The plugin claims only `append: "app"` and renders a controller that returns null. It adds no
composer, panel, dialog, or styling.

1. Preflight: exact environment/path gates and a public-context capability check. No API call
   happens before the gates pass.
2. Import old: generate fresh synthetic IDs, build the whitelisted two-message old payload with
   the known old-root title, import it parentless, read it back, and verify:
   - frozen ID, parentless, title, canonical host `projectID`, and project directory;
   - the import response and first readback carry the same canonical host `projectID`;
   - readback `time.created` is the payload value, and `time.updated` is finite, is not the
     payload value, and falls inside the measured import window;
   - exactly two ordered messages with the frozen IDs and exact content.
3. Import candidate: create the candidate fixture with the canonical host `projectID`, import
   the whitelisted three-message parentless payload with the known candidate title, and verify
   the same metadata/time contract plus the three ordered messages and the distinct synthetic
   tail.
4. Verify history again before any route change: both roots are still parentless, retain the
   canonical project, and still have exactly two and three ordered messages.
5. Navigate: call `context.data.session.sync(candidateID)` and
   `context.data.session.message.sync(candidateID)`, then
   `context.ui.router.navigate({ type: "session", sessionID: candidateID })`. Poll the actual
   public `context.ui.router.current()` readback for a bounded 500 ms.
6. The plugin leaves the native route visible and does not exit the process. The runner's
   observation window runs after the result file appears; an observer may manually look at the
   native composer/picker but must not type Enter or submit anything.

The fixture/payload helpers are the existing `../fixtures.ts` whitelist and builders. The old
payload builder is copied from the reviewed lifecycle entry because the existing fixture builder
only emits the candidate title. Both import payloads omit `parentID`, so both roots are
parentless. No child redirect or tab operation is used. The synthetic assistant messages carry
the fixture allowlist's fixed `probe-model`/`probe-provider` metadata only; no provider catalog
is queried.

## Exact result schema

The result file has exactly these keys (values shown are the initial preflight shape):

```json
{
  "probe": "sessionport-native-replacement-tui",
  "version": 1,
  "ok": false,
  "stage": "preflight",
  "reason": "none",
  "importedCount": 0,
  "oldMessageCount": 0,
  "candidateMessageCount": 0,
  "nativeRouteObserved": false,
  "parentlessVerified": false,
  "archiveNotTested": true,
  "composerNotTested": true,
  "pickerNotTested": true
}
```

`stage` is one of `preflight`, `import-old`, `import-candidate`, `verify-history`, `navigate`,
`complete`, `failed`. `reason` is one of `none`, `isolation`, `capability`, `import`, `history`,
`navigation`, `internal`. Counts are bounded to `0..3` for the old root and `0..4` for the
candidate. `ok` is true only for `complete` with imported `2`, old messages `2`, candidate
messages `3`, `parentlessVerified`, and `nativeRouteObserved`.

The result contains no session IDs, message IDs, message text, paths, error text, or arbitrary
strings. The writer also takes the live forbidden values and refuses to write if any appear.

## Not tested in this probe

- `archiveNotTested: true`: the pinned `@opencode/plugin` 2.0.22 public update type does not
  expose the archive field, the transport is unknown, and public auth is not exposed here. This
  probe makes no archive call and does not treat absence as a pass.
- `composerNotTested: true` and `pickerNotTested: true`: these are manual native-UI observations,
  not automatic passes. The synthetic roots are the only history in the isolated profile.
- No input submission, generation, provider catalog, permission/form interaction, tool call,
  database access, Git command, config change, or credential read.

## Validation

Focused tests:

```powershell
bun test scripts/host-probes/native-replacement/tui/entry.test.ts
# 30 pass, 0 fail, 218 expect() calls
```

Runner regression and static validation (host-free; no `-RunProbe`):

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/host-probes/sync-anchor/run-sync-anchor-probe.test.ps1
# TESTS-PASSED: 153

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/host-probes/native-replacement/run-tui-probe.ps1 -ArchiveProbe
# VALIDATION-OK
# RUN-NOT-STARTED

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/host-probes/sync-anchor/run-sync-anchor-probe.ps1 -ProbeMode NativeReplacement -ExpectedVersion 2.1.1
# VALIDATION-OK
# RUN-NOT-STARTED
```

Bundle and load check:

```powershell
bun -e "import solidPlugin from '@opentui/solid/bun-plugin'; const r = await Bun.build({ entrypoints: ['scripts/host-probes/native-replacement/tui/entry.tsx'], outdir: '.package-verify-work/m1-native-tui-plugin-20261024', target: 'bun', format: 'esm', plugins: [solidPlugin], external: ['@opencode/plugin', '@opencode/plugin/*', '@opentui/core', '@opentui/core/*', '@opentui/solid', '@opentui/solid/*', 'solid-js', 'solid-js/*'], naming: { entry: 'tui.tsx' }, sourcemap: 'none' }); if (!r.success) process.exit(1);"
bun -e "const m = await import('./.package-verify-work/m1-native-tui-plugin-20261024/tui.tsx'); console.log(typeof m.default, typeof m.runNativeTuiProbe)"
```

The output is `object function` for the default plugin definition and core export. A headless
fake-context run of the bundle with the live subroot location shape produced `ok: true` with
counts `2/3`, parentless verified, and the candidate route observed, and wrote the exact schema
above. That is a fake-context check, not a host run.

Current bundle: `48,442` bytes, SHA-256
`b630d1828818db6812ecfed36ec61135666ecaa6271764da30f10d6aec864872`.

The first live screenshot showed terminal mouse/escape residue after the forced job stop. Close
the affected terminal before the next owner run; this lane does not fix terminal residue.
