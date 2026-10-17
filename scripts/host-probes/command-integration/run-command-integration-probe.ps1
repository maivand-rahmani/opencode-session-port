#Requires -Version 5.1
<#
.SYNOPSIS
    SessionPort command-integration probe runner (Windows only, disposable isolated root).

.DESCRIPTION
    Bounded, synthetic end-to-end probe of the newly wired /checkpoint and /restore
    commands through the actual installed OpenCode v2.0.22 TUI plugin runtime and its
    public client surface. One synthetic /checkpoint -> /restore round trip only.

    The runner:
      1. Without -RunProbe it performs non-executing validation/usage only: it never
         starts OpenCode, never creates a root, and never mutates any environment (it
         only inspects path attributes of the approved temp base, when present, for the
         reparse-point gate below).
      2. With -RunProbe it creates a unique disposable root under the approved temp base
         (prefix sp-command-) only after a conservative physical-path gate: the approved
         base must exist as a directory and no existing ancestor from the drive root
         down (including the base) may be a reparse point. The runner then temporarily
         sets every mutable OpenCode root (XDG_*, OPENCODE_CONFIG_DIR, HOME/USERPROFILE,
         HOMEDRIVE/HOMEPATH, APPDATA/LOCALAPPDATA, TMP/TEMP/TMPDIR) plus an explicit
         inline CLI config value (OPENCODE_CLI_CONFIG_CONTENT: only the three documented
         debug diagnostics set to false) in its own process
         only around each child process creation and restores the original values
         immediately after each child is started, so each child inherits the snapshot at
         creation and a normal invocation does not leave the caller's environment
         changed (E42 mechanics).
      3. Runs 'opencode debug paths' FIRST and aborts before staging, TUI launch, or any
         plugin/client call unless all ten reported paths (home,data,cache,config,state,
         tmp,bin,log,repos,db) resolve inside the unique root. That command's stdout is
         captured in memory only, solely to parse the ten-key path map, under an
         explicit bounded harness-output cap (any byte beyond the cap marks a fixed-safe
         overflow and fails the gate closed while the capture keeps draining and
         discarding); its stderr is drained and discarded; neither stream is written to
         disk. The preflight root
         itself is stopped only through its identity-verified root handle (opened by
         PID once and verified against the returned process object before any descendant
         is attributed). Descendants of that preflight command are stopped only
         through process handles whose identity was proven while the parent each was
         created from was still alive (for first-level descendants, the preflight
         parent itself); a possible descendant that cannot be proven, or a traversal
         that reaches a depth/count bound with a remaining frontier, refuses staging
         and force-retains the root. No process is ever terminated by a bare/stale
         process ID.
      4. Stages only inside the disposable root: a copy of the repository 'src' tree and
         package.json under <root>\repo, a junction <root>\repo\node_modules pointing at
         the developer checkout's node_modules (link lives inside the root; read-only),
         and the embedded probe plugin under the disposable OPENCODE_CONFIG_DIR plugins
         folder. This is staging for the probe, not a packaged/bundled artifact and not a
         packaging-support claim.
      5. Launches the real TUI runtime with --standalone (private server; no shared
         background service reuse) and no other CLI flags; the child's stdout and stderr
         are drained and discarded in memory, so no debug logging or raw child output is
         requested, captured, or persisted by the runner. Every child launch also sets
         the documented inline CLI config variable (OPENCODE_CLI_CONFIG_CONTENT) to the
         explicit JSON constant that sets only the three documented debug diagnostics
         (debug.devtools, debug.timing, debug.turn_tokens) to false, so an inline CLI
         override inherited from the caller's environment cannot enable them; this is an
         explicit documented-config override, not a host-log disable control, and no
         claim is made about host-managed logs. No auto-update or model flags
         are guessed or added, and possible background host auto-update behavior cannot
         be ruled out.
      6. The probe plugin re-verifies isolation (os.homedir(), os.tmpdir(), cwd, every
         configured env root, project/target/artifact/result/repo paths) before its
         first context.client call; if a check fails it records a bounded error and
         performs zero client calls.
      7. The plugin imports the in-root staged repo copy, calls the real
         installSessionPortWiring(ctx, { requestPassword }) with a test-only in-memory
         random password provider, and wraps ui.dialog.select (predeclared
         restore-target candidate), ui.dialog.show (bounded call count only; the
         restore report-dialog completion signal) and ui.toast.show (bounded fact
         capture: a bounded variant token and the message length only; raw toast titles
         are never recorded) for the probe. It also wraps client.session.import in the
         product-wiring context only for sanitized attempt/response facts (capped
         call/resolved/rejected counts, an overflow fact, and in-memory
         shape/ID/project/directory booleans; no IDs, directories, messages, response
         objects, or exception text), while the runner's own seed/read calls keep using
         the original client. It then waits until both registered command
         IDs are reachable in the public keymap surface and invokes each exactly once
         through the public keymap.dispatch(id, input) method (no command.run fallback).
         Dispatch returns void and is asynchronous from the harness perspective, so each
         invocation is followed by a bounded wait for a product completion signal
         through those captures; slash parsing and key input remain untested.
      8. Synthetic round trip: seed exactly one settled session through the public
         session.import (synthetic ses_/msg_ + 64 lowercase hex IDs, synthetic text),
         verify it via session.get/message.list/session.list, invoke /checkpoint with an
         explicit artifact path under the root and wait for its captured completion
         signal, verify the encrypted artifact is nonzero and does not contain the
         synthetic plaintext markers or the password bytes, then derive the expected
         remapped session/message IDs in memory by opening the artifact through the
         product crypto boundary (same explicit experimental policy) and applying the
         product O-22 deriver to the authenticated artifact identity plus the source
         IDs (no payload is retained; best-effort zeroing only), resolve a separate
         explicit restore-target directory (location.get + project.list exact
         ID/canonical pair), invoke /restore with that artifact and wait for its
         captured completion signal, then assert the predeclared dialog selection and
         verify the imported session via session.get/message.list/session.list in the
         target project against those in-memory expected IDs (the source ID is expected
         to be absent from the target list), plus a public readback that the original
         source session/messages are preserved unchanged. The sanitized import audit is
         captured into result.restore.importAudit on every completed probe path,
         including bounded completion/verification failures; neither the import promise
         nor any dialog is success evidence. No retries, no direct database access, no
         user sessions. The result is written only after an in-memory leak guard
         confirms it contains no synthetic/derived IDs, password bytes, or raw probe
         paths.
      9. Stops the process tree: the root and each descendant only through native
         process handles whose identity was verified before use. The root is opened by
         its process ID once, verified against the returned process object (PID,
         creation FILETIME, creator identity as this runner process), and retained; if
         that open or verification fails the tracker is marked ambiguous and the runner
         fails closed with the root retained. Each descendant is stopped only through a
         process handle whose identity (creation time + creator PID) was verified while
         its parent was alive. A descendant that cannot be proven, a survivor whose
         exit cannot be verified, or a traversal bound reached with a remaining
         frontier force-retains the root and fails cleanup (exit 3); the runner never
         terminates a process by a bare/stale PID and has no raw-PID termination path.
         It then re-runs the physical-path gate, removes the staged junction
         link-first, refuses recursive removal if any unexpected reparse point remains
         inside the root, and only then removes the root. Child stdout/stderr are
         drained and discarded in memory and no raw child output is persisted by the
         runner; the sanitized synthetic result stays under the root only, and stdout
         carries only the bounded sanitized summary (plus the resolved executable and
         disposable-root paths).

    Authorized scope (E46/Gate4, ora-33): synthetic, isolated Windows actual-TUI/plugin
    validation only. One Windows host and one installed OpenCode version per run; no
    cross-version/platform/restart/security claim.

.PARAMETER RunProbe
    Required to start OpenCode. Without it the script only validates its own
    preconditions and prints usage (no root, no child process, no environment change).

.PARAMETER KeepRoot
    Diagnostic only and not part of the authorized single run: skip deletion of the
    disposable root (prints the path for inspection of runner mechanics; the caller
    must remove the whole root manually, without reading or copying ordinary host
    logs). Unsafe stop/path/reparse/junction conditions force-retain the root even
    without this switch.

.PARAMETER TimeoutSeconds
    Seconds to wait for the plugin result file before stopping the process tree
    (default 180).

.PARAMETER OpenCodePath
    Optional explicit path to the installed opencode executable; resolved from PATH
    when omitted.

.NOTES
    Exit codes:
      0  validation-only passed, or probe result ok with stop/cleanup verified
      1  preflight/validation failure (no TUI/API calls were made)
      2  TUI launched but no probe result (timeout or early exit)
      3  stop/cleanup verification failed (root kept; do not treat as clean); also
         used when a descendant/process-tree state cannot be proven safe, including
         preflight descendant refusal (no uncertain kill is ever attempted)
      4  unexpected runner error
      5  plugin isolation gate failed (zero client calls)
      6  probe result produced but the round trip/verification was not ok

    The synthetic password is generated in memory inside the plugin (32 random bytes)
    and is never written to disk, stdout/stderr, the result JSON, or logs.
#>
[CmdletBinding()]
param(
    [switch]$RunProbe,
    [switch]$KeepRoot,
    [ValidateRange(30, 900)]
    [int]$TimeoutSeconds = 180,
    [string]$OpenCodePath = ""
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = "Stop"

$ProbeName = "sessionport-command-integration"
$ApprovedTempBase = "C:\Users\PC\AppData\Local\Temp\opencode"
$RootNamePrefix = "sp-command-"
$StagedPluginName = "sp-command-probe"
# Bounded in-memory capture cap for the 'opencode debug paths' stdout (the synthetic
# ten-key path-map diagnostic). Runner-side harness-output guard only - NOT a product
# crypto/payload limit. The ten-key map is normally well under 4 KiB; 64 KiB bounds
# retained runner memory while leaving generous headroom. Any byte beyond the cap
# marks a fixed-safe overflow and fails the preflight gate closed (no truncation).
$PreflightStdoutCaptureCapBytes = 65536
# Explicit inline CLI config for every child launch. OPENCODE_CLI_CONFIG_CONTENT is
# the documented V2 inline CLI-config variable (authoritative while set; nested
# objects merge over any global cli.json). The value sets only the three documented
# debug diagnostics to false, so an inline CLI override inherited from the caller's
# environment cannot enable them in the probe child. This is an explicit
# documented-config override, not a host-log disable control, and it makes no claim
# about host-managed logs.
$ChildCliConfigContentJson = '{"debug":{"devtools":false,"timing":false,"turn_tokens":false}}'
$ExpectedPathKeys = @("home", "data", "cache", "config", "state", "tmp", "bin", "log", "repos", "db")
$ProbeEnvNames = @(
    "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
    "OPENCODE_CONFIG_DIR", "OPENCODE_CLI_CONFIG_CONTENT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR",
    "SP_PROBE_ROOT", "SP_PROBE_RESULT", "SP_PROBE_PROJECT", "SP_PROBE_TARGET",
    "SP_PROBE_ARTIFACT", "SP_PROBE_REPO", "SP_PROBE_SESSION_ID",
    "SP_PROBE_MESSAGE_ID_1", "SP_PROBE_MESSAGE_ID_2"
)

$script:ExitCode = 4
$script:Root = ""
$script:RepoRoot = ""
$script:RootDeleted = $false
$script:KeepRootRequested = [bool]$KeepRoot
$script:KeepRootForced = $false
$script:TuiProcess = $null
$script:TuiTracker = $null
$script:PreflightTracker = $null
$script:TuiStopVerified = $false
$script:ResultJson = $null
$script:EnvBackup = @{}
$script:EnvBackupTaken = $false
$script:OriginalLocation = (Get-Location).Path
$script:ProbeProcessHelperReady = $false

# ---------------------------------------------------------------------------
# Embedded probe plugin (staged verbatim under the disposable config root).
# It imports the in-root staged repo copy via the relative path ../../../repo.
# ---------------------------------------------------------------------------

$PluginSource = @'
// SessionPort command-integration probe plugin (synthetic, isolated, Windows actual-TUI).
// Staged by run-command-integration-probe.ps1 into the disposable OPENCODE_CONFIG_DIR
// plugins folder. Loads the in-root staged repo copy (../../../repo) and Node builtins
// only. No product source edits, no user data, no direct database access, no
// model/prompt/tool/replay calls, no Git. All session/message IDs and content are
// synthetic. The synthetic password is generated in memory at runtime (32 random
// bytes) and is never written to disk, stdout/stderr, the result JSON, or logs.
// Expected remapped session/message IDs are derived in memory from the authenticated
// artifact identity (product crypto boundary + product O-22 deriver, same experimental
// policy) and are never serialized: the result carries only shape/distinctness
// booleans, and the public target/source readbacks compare against those in-memory
// expectations. The product-wiring context's public client.session.import is wrapped
// for sanitized attempt/response facts only (capped call/resolved/rejected counts, an
// overflow fact, and in-memory shape/ID/project/directory booleans, including whether
// the request/response IDs match the independently derived expected IDs; no IDs,
// directories, messages, response objects, or exception text); the runner's own
// seed/read calls stay on the original client. Before the result is written, an
// in-memory leak guard verifies the serialized result contains none of the
// synthetic/derived IDs, password bytes, or probe paths.

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"

const PLUGIN_ID = "sp-command-probe"
const PROBE_NAME = "sessionport-command-integration"
const USER_TEXT = "synthetic sp-command probe user message"
const ASSISTANT_TEXT = "synthetic sp-command probe assistant reply"
const SUPPLIED_PROJECT_ID = "sp-command-probe-supplied-source-project"
const REGISTRATION_TIMEOUT_MS = 30000
// Bounded per-command completion wait. Registration (30s max) + two of these waits
// + verification stay inside the default 180s overall TUI timeout (-TimeoutSeconds).
const COMMAND_COMPLETION_TIMEOUT_MS = 45000
const POLL_INTERVAL_MS = 200
const PROBE_START_DELAY_MS = 500
const MAX_SCAN_BYTES = 1024 * 1024
const MAX_NOTIFICATION_FACTS = 16
// Small fixed cap for the product-wiring session.import audit so the recorded
// counts/facts stay bounded; calls beyond the cap only set the overflow fact.
const MAX_IMPORT_AUDIT_CALLS = 8
// Expected remapped-ID shapes for the owner-selected O-22 scheme (64 lowercase hex).
const DERIVED_SESSION_ID_PATTERN = /^ses_[0-9a-f]{64}$/
const DERIVED_MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{64}$/

let scheduled = false

function readEnv(env, name) {
  return typeof env[name] === "string" ? env[name] : ""
}

function norm(value) {
  return path.resolve(value)
}

function samePath(left, right) {
  return norm(left).toLowerCase() === norm(right).toLowerCase()
}

function isUnder(child, parent) {
  const rel = path.relative(norm(parent), norm(child))
  if (rel === "") return true
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

function sanitizePath(value, root) {
  if (typeof value !== "string" || value.length === 0) return "<empty>"
  if (typeof root !== "string" || root.length === 0) return "<outside-root>"
  if (isUnder(value, root)) {
    const rel = path.relative(norm(root), norm(value))
    return rel === "" ? "<ROOT>" : "<ROOT>\\" + rel.split("/").join("\\")
  }
  return "<outside-root>"
}

function errorInfo(error) {
  let name = "Error"
  if (error && typeof error === "object" && typeof error.name === "string" && error.name.length > 0) {
    name = error.name
  }
  if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(name)) name = "Error"
  return { name: name, category: "threw" }
}

function writeResult(resultPath, data) {
  const tmp = resultPath + ".tmp"
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
  renameSync(tmp, resultPath)
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

function resolveMethod(client, container, method) {
  if (!client || typeof client !== "object") return undefined
  const owner = client[container]
  if (!owner || typeof owner !== "object") return undefined
  const candidate = owner[method]
  if (typeof candidate !== "function") return undefined
  return function (input) { return Reflect.apply(candidate, owner, [input]) }
}

class ProbeStop extends Error {
  constructor(code, stage) {
    super(code)
    this.name = "ProbeStop"
    this.code = code
    this.stage = stage
  }
}

function validateLocationResponse(response, requestedDirectory, expectedProjectID) {
  if (!response || typeof response !== "object") return { ok: false, reason: "response-not-object" }
  if (response.directory !== requestedDirectory) return { ok: false, reason: "response-directory-mismatch" }
  const project = response.project
  if (!project || typeof project !== "object") return { ok: false, reason: "response-project-missing" }
  if (typeof project.id !== "string" || project.id.length === 0) return { ok: false, reason: "response-project-id-missing" }
  if (project.directory !== requestedDirectory) return { ok: false, reason: "response-project-directory-mismatch" }
  if (expectedProjectID !== undefined && project.id !== expectedProjectID) return { ok: false, reason: "response-project-id-mismatch" }
  return { ok: true, projectID: project.id }
}

async function waitForCommands(keymap, expectedIDs, timeoutMs) {
  const found = {}
  const deadline = Date.now() + timeoutMs
  let duplicates = 0
  let lastReadError = null
  while (Date.now() < deadline) {
    let commands = null
    try {
      commands = keymap.commands()
      lastReadError = null
    } catch (error) {
      lastReadError = errorInfo(error)
    }
    if (Array.isArray(commands)) {
      const seen = {}
      for (const command of commands) {
        if (command && typeof command.id === "string") {
          if (seen[command.id]) duplicates += 1
          seen[command.id] = true
        }
      }
      for (const id of expectedIDs) {
        if (seen[id]) found[id] = true
      }
      if (expectedIDs.every(function (id) { return found[id] === true })) break
    }
    await delay(POLL_INTERVAL_MS)
  }
  return {
    registered: expectedIDs.filter(function (id) { return found[id] === true }),
    bothRegistered: expectedIDs.every(function (id) { return found[id] === true }),
    duplicates: duplicates,
    lastReadError: lastReadError
  }
}

function completionMark(state) {
  return { notifications: state.notifications.length, dialogShows: state.dialog.showCalls }
}

async function waitForCommandCompletion(state, mark, timeoutMs, acceptDialogShow) {
  // keymap.dispatch returns void and the host never awaits the command handler, so
  // completion is observed through the probe's bounded UI captures: a new
  // ui.toast.show notification (checkpoint outcome paths and restore failure/empty
  // paths), or for restore a new report-dialog ui.dialog.show (any non-empty execution
  // report, including failed/blocked outcomes; not import-success evidence). Fixed-safe
  // facts only; no message/title text is read.
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    if (state.notifications.length > mark.notifications) {
      return { signal: "notification", waitedMs: Date.now() - started, timedOut: false }
    }
    if (acceptDialogShow && state.dialog.showCalls > mark.dialogShows) {
      return { signal: "dialog-show", waitedMs: Date.now() - started, timedOut: false }
    }
    await delay(POLL_INTERVAL_MS)
  }
  return { signal: null, waitedMs: Date.now() - started, timedOut: true }
}

function scanArtifact(artifactPath, secret) {
  const bytes = readFileSync(artifactPath)
  const truncated = bytes.length > MAX_SCAN_BYTES
  const scan = truncated ? bytes.subarray(0, MAX_SCAN_BYTES) : bytes
  const userMarker = scan.indexOf(Buffer.from(USER_TEXT, "utf8")) !== -1
  const assistantMarker = scan.indexOf(Buffer.from(ASSISTANT_TEXT, "utf8")) !== -1
  const passwordBytes = scan.indexOf(Buffer.from(secret)) !== -1
  return {
    scannedBytes: scan.length,
    truncated: truncated,
    plaintextMarkerAbsent: !userMarker && !assistantMarker,
    passwordBytesAbsent: !passwordBytes
  }
}

function createImportAudit() {
  // Sanitized attempt/response facts for the product-wiring context's public
  // client.session.import only. Counts are capped (overflow fact) and every
  // response fact is an in-memory comparison reduced to a boolean; no IDs,
  // directories, messages, response objects, or exception text are recorded,
  // and no `.data` envelope is unwrapped. Null means the fact was not observed.
  // The derived-expected comparisons use the in-memory expected remapped IDs
  // only; they never serialize those IDs. These facts are diagnostic only and
  // never decide probe success.
  return {
    calls: 0,
    resolved: 0,
    rejected: 0,
    overflow: false,
    responseShapeValid: null,
    returnedIdMatchesRequest: null,
    requestSessionIdMatchesDerivedExpected: null,
    requestMessageIdsMatchDerivedExpected: null,
    returnedIdMatchesDerivedExpected: null,
    returnedProjectIdMatchesPredeclaredTarget: null,
    returnedLocationMatchesPredeclaredDirectory: null
  }
}

function isNonblankString(value) {
  return typeof value === "string" && value.trim().length > 0
}

function noteImportAuditCall(audit) {
  if (audit.calls >= MAX_IMPORT_AUDIT_CALLS) {
    audit.overflow = true
    return false
  }
  audit.calls += 1
  return true
}

function recordImportResponseFacts(audit, response, request, candidate, expected) {
  // Direct unwrapped SessionInfo candidate: non-array object with nonblank id,
  // projectID, and location.directory. Everything here is compared in memory;
  // nothing from the response or request is retained. The `expected` view
  // carries the independently derived remapped IDs (never serialized).
  const responseIsObject = response !== null && typeof response === "object" && !Array.isArray(response)
  audit.responseShapeValid = Boolean(
    responseIsObject &&
    isNonblankString(response.id) &&
    isNonblankString(response.projectID) &&
    response.location !== null && typeof response.location === "object" && !Array.isArray(response.location) &&
    isNonblankString(response.location.directory)
  )
  const requestIsObject = request !== null && typeof request === "object" && !Array.isArray(request)
  const requestInfo = requestIsObject &&
    request.info !== null && typeof request.info === "object" && !Array.isArray(request.info)
    ? request.info
    : null
  if (requestInfo !== null && isNonblankString(requestInfo.id)) {
    audit.returnedIdMatchesRequest = Boolean(responseIsObject && response.id === requestInfo.id)
  } else {
    audit.returnedIdMatchesRequest = null
  }
  const expectedSessionID = expected !== null && typeof expected === "object" && isNonblankString(expected.sessionID)
    ? expected.sessionID
    : null
  if (requestInfo !== null && isNonblankString(requestInfo.id) && expectedSessionID !== null) {
    audit.requestSessionIdMatchesDerivedExpected = Boolean(requestInfo.id === expectedSessionID)
  } else {
    audit.requestSessionIdMatchesDerivedExpected = null
  }
  if (responseIsObject && isNonblankString(response.id) && expectedSessionID !== null) {
    audit.returnedIdMatchesDerivedExpected = Boolean(response.id === expectedSessionID)
  } else {
    audit.returnedIdMatchesDerivedExpected = null
  }
  const expectedMessageIDs = expected !== null && typeof expected === "object" && Array.isArray(expected.messageIDs)
    ? expected.messageIDs
    : null
  const requestMessages = requestIsObject && Array.isArray(request.messages) ? request.messages : null
  if (expectedMessageIDs !== null && requestMessages !== null && expectedMessageIDs.length > 0 && requestMessages.length === expectedMessageIDs.length) {
    let allMatch = true
    for (let index = 0; index < expectedMessageIDs.length; index++) {
      const message = requestMessages[index]
      if (!message || typeof message !== "object" || message.id !== expectedMessageIDs[index]) {
        allMatch = false
        break
      }
    }
    audit.requestMessageIdsMatchDerivedExpected = allMatch
  } else {
    audit.requestMessageIdsMatchDerivedExpected = null
  }
  if (candidate !== null && typeof candidate === "object" && isNonblankString(candidate.projectID) && isNonblankString(candidate.targetDirectory)) {
    audit.returnedProjectIdMatchesPredeclaredTarget = Boolean(responseIsObject && response.projectID === candidate.projectID)
    audit.returnedLocationMatchesPredeclaredDirectory = Boolean(
      responseIsObject && response.location !== null && typeof response.location === "object" && response.location.directory === candidate.targetDirectory
    )
  } else {
    audit.returnedProjectIdMatchesPredeclaredTarget = null
    audit.returnedLocationMatchesPredeclaredDirectory = null
  }
}

function expectedIdView(state) {
  // In-memory view of the independently derived expected remapped IDs. Returns
  // null until the expected-ids stage has completed; the IDs are never
  // serialized into the result.
  if (!isNonblankString(state.expectedSessionID)) return null
  return {
    sessionID: state.expectedSessionID,
    messageIDs: [state.expectedMessageID1, state.expectedMessageID2].filter(function (id) { return isNonblankString(id) })
  }
}

async function computeExpectedRemappedIds(modules, state) {
  // Opens the encrypted artifact in memory through the product crypto boundary
  // (the same explicit experimental policy the product used to seal it), takes
  // the authenticated artifact identity, and derives the deterministic O-22
  // remapped session/message IDs with the product deriver. No payload is
  // retained, serialized, or written: the payload bytes, the password copy, and
  // the identity buffer are all best-effort zeroed before returning. Failure
  // returns a bounded ok=false (no error text is captured).
  const password = Uint8Array.from(state.secret)
  let payloadBytes = null
  let artifactIdentity = null
  try {
    const factory = await modules.crypto.createCheckpointCryptoFactory([modules.profile.EXPERIMENTAL_CRYPTO_POLICY_DEFINITION])
    const crypto = await factory.create(modules.profile.EXPERIMENTAL_CRYPTO_POLICY)
    const artifact = modules.files.readEncryptedArtifact(state.artifactPath)
    const authenticated = await crypto.openAndStage(artifact, password)
    payloadBytes = authenticated.bytes
    artifactIdentity = authenticated.artifactIdentity
    const deriver = await modules.restore.createRemappedIdDeriver()
    return {
      ok: true,
      sessionID: deriver.derive("session", artifactIdentity, state.sessionID),
      messageID1: deriver.derive("message", artifactIdentity, state.messageID1),
      messageID2: deriver.derive("message", artifactIdentity, state.messageID2)
    }
  } catch (error) {
    return { ok: false }
  } finally {
    try { password.fill(0) } catch (error) { }
    if (payloadBytes instanceof Uint8Array) {
      try { payloadBytes.fill(0) } catch (error) { }
    }
    if (artifactIdentity instanceof Uint8Array) {
      try { artifactIdentity.fill(0) } catch (error) { }
    }
  }
}

function buildLeakGuard(result, state) {
  // Bounded pre-write guard: the serialized result must not contain any
  // synthetic or derived session/message ID, the password bytes, or a raw probe
  // path. Returns fixed-safe booleans only (null = the check itself could not
  // run). It runs while the password is still in memory.
  const serialized = JSON.stringify(result)
  const ids = [state.sessionID, state.messageID1, state.messageID2, state.expectedSessionID, state.expectedMessageID1, state.expectedMessageID2]
  let idsAbsent = true
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0 && serialized.indexOf(id) !== -1) {
      idsAbsent = false
      break
    }
  }
  const paths = [state.root, state.projectDir, state.targetDir, state.artifactPath, state.resultPath, state.repoDir]
  let pathsAbsent = true
  for (const candidate of paths) {
    if (typeof candidate === "string" && candidate.length > 0 && serialized.indexOf(candidate) !== -1) {
      pathsAbsent = false
      break
    }
  }
  let passwordBytesAbsent = null
  try {
    passwordBytesAbsent = Buffer.from(serialized, "utf8").indexOf(Buffer.from(state.secret)) === -1
  } catch (error) {
    passwordBytesAbsent = null
  }
  return { checked: true, idsAbsent: idsAbsent, pathsAbsent: pathsAbsent, passwordBytesAbsent: passwordBytesAbsent }
}

function buildWrappedContext(context, state) {
  const dialogWrapper = Object.assign({}, context.ui.dialog, {
    show: function (render, onClose) {
      // Bounded completion fact only: the call count. The original host show is
      // invoked with the original dialog object as `this`; nothing is rendered,
      // read, or recorded from the dialog.
      state.dialog.showCalls += 1
      return Reflect.apply(context.ui.dialog.show, context.ui.dialog, arguments)
    },
    select: async function (options) {
      state.dialog.called += 1
      const list = options && Array.isArray(options.options) ? options.options : []
      state.dialog.lastOptionCount = list.length
      const candidate = state.predeclaredCandidate
      if (!candidate) {
        state.dialog.matches = 0
        state.dialog.matchedPredeclared = false
        return undefined
      }
      const matches = list.filter(function (option) {
        return option && option.value &&
          option.value.projectID === candidate.projectID &&
          option.value.targetDirectory === candidate.targetDirectory
      })
      state.dialog.matches = matches.length
      if (matches.length === 1) {
        state.dialog.matchedPredeclared = true
        return matches[0].value
      }
      state.dialog.matchedPredeclared = false
      return undefined
    }
  })
  const toastWrapper = Object.assign({}, context.ui.toast, {
    show: function (options) {
      if (state.notifications.length < MAX_NOTIFICATION_FACTS) {
        // Fixed-safe facts only: a bounded variant token plus the message length.
        // Raw toast titles (which may embed user data) are never recorded.
        let variant = null
        if (options && typeof options.variant === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(options.variant)) {
          variant = options.variant
        }
        state.notifications.push({
          variant: variant,
          messageLength: options && typeof options.message === "string" ? options.message.length : null
        })
      }
    }
  })
  const uiWrapper = Object.assign({}, context.ui, { dialog: dialogWrapper, toast: toastWrapper })
  // Product-wiring client wrapper: only the public client.session.import of the
  // context handed to installSessionPortWiring is wrapped, for sanitized
  // attempt/response facts. The original session object stays the receiver and
  // the original arguments/return/rejection pass through unchanged (observation
  // never swallows or alters a value). The runner's own seed/read calls keep
  // using the original client.
  let clientWrapper = context.client
  const client = context.client
  const sessionOwner = client !== null && typeof client === "object" ? client.session : undefined
  const importMethod = sessionOwner !== null && typeof sessionOwner === "object" ? sessionOwner.import : undefined
  if (typeof importMethod === "function") {
    const importWrapper = function (input) {
      const counted = noteImportAuditCall(state.importAudit)
      const candidate = state.predeclaredCandidate
      const outcome = Reflect.apply(importMethod, sessionOwner, arguments)
      if (counted) {
        // Observation only: the host's own return value (or promise) is
        // returned unchanged; the observer records facts and never swallows.
        Promise.resolve(outcome).then(
          function (response) {
            try {
              state.importAudit.resolved += 1
              recordImportResponseFacts(state.importAudit, response, input, candidate, expectedIdView(state))
            } catch (error) { }
          },
          function () {
            state.importAudit.rejected += 1
          }
        )
      }
      return outcome
    }
    const sessionWrapper = Object.assign({}, sessionOwner, { import: importWrapper })
    clientWrapper = Object.assign({}, client, { session: sessionWrapper })
  }
  return Object.assign({}, context, { ui: uiWrapper, client: clientWrapper })
}

async function runProbe(state) {
  const result = state.result
  const keymap = state.context.keymap
  const client = state.context.client
  try {
    result.stage = "command-registration"
    const registration = await waitForCommands(keymap, state.expectedIDs, REGISTRATION_TIMEOUT_MS)
    result.commands.registered = registration.registered
    result.commands.bothRegistered = registration.bothRegistered
    result.commands.duplicates = registration.duplicates
    result.commands.lastReadError = registration.lastReadError
    if (!registration.bothRegistered) throw new ProbeStop("commands-not-registered", "command-registration")
    // No command.run fallback: the public keymap dispatch(id, input) surface is the
    // only invocation path, and its absence is a distinct bounded failure.
    if (result.commands.dispatchCallable !== true) {
      throw new ProbeStop("keymap-dispatch-unavailable", "command-dispatch")
    }

    result.stage = "context-location"
    const location = state.context.location
    const locationDirectory = location && typeof location.directory === "string" ? location.directory : ""
    result.context.locationDirectory = sanitizePath(locationDirectory, state.root)
    result.context.locationUnderRoot = locationDirectory.length > 0 ? isUnder(locationDirectory, state.root) : false
    result.context.locationMatchesSource = locationDirectory.length > 0 && samePath(locationDirectory, state.projectDir)
    if (!result.context.locationMatchesSource) throw new ProbeStop("context-location-mismatch", "context-location")

    result.stage = "client-capabilities"
    const locationGet = resolveMethod(client, "location", "get")
    const sessionImport = resolveMethod(client, "session", "import")
    const sessionGet = resolveMethod(client, "session", "get")
    const sessionList = resolveMethod(client, "session", "list")
    const messageList = resolveMethod(client, "message", "list")
    const projectList = resolveMethod(client, "project", "list")
    result.capabilities = {
      locationGet: Boolean(locationGet),
      sessionImport: Boolean(sessionImport),
      sessionGet: Boolean(sessionGet),
      sessionList: Boolean(sessionList),
      messageList: Boolean(messageList),
      projectList: Boolean(projectList)
    }
    if (!locationGet || !sessionImport || !sessionGet || !sessionList || !messageList || !projectList) {
      throw new ProbeStop("client-capabilities-unavailable", "client-capabilities")
    }

    result.stage = "source-location"
    const sourceResponse = await locationGet({ location: { directory: state.projectDir } })
    const sourceValidation = validateLocationResponse(sourceResponse, state.projectDir, undefined)
    result.sourceLocation = { ok: sourceValidation.ok, reason: sourceValidation.reason || null }
    if (!sourceValidation.ok) throw new ProbeStop("source-location-invalid", "source-location")
    const sourceProjectID = sourceValidation.projectID

    result.stage = "seeding"
    const seedNow = Date.now()
    const seedPayload = {
      info: {
        id: state.sessionID,
        projectID: SUPPLIED_PROJECT_ID,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: seedNow - 2000, updated: seedNow - 1000, idle: seedNow - 1000 },
        title: "synthetic sp-command probe session",
        location: { directory: state.projectDir }
      },
      messages: [
        { id: state.messageID1, time: { created: seedNow - 2000 }, type: "user", text: USER_TEXT },
        {
          id: state.messageID2,
          time: { created: seedNow - 1500, completed: seedNow - 1000 },
          type: "assistant",
          agent: "probe",
          model: { id: "probe-model", providerID: "probe-provider" },
          content: [{ type: "text", text: ASSISTANT_TEXT }]
        }
      ],
      location: { directory: state.projectDir }
    }
    result.seeding.importAttempted = true
    const importResponse = await sessionImport(seedPayload)
    result.seeding.importOk = true
    result.seeding.responseIdMatchesRequested = Boolean(importResponse && importResponse.id === state.sessionID)
    result.seeding.responseProjectMatchesSource = Boolean(importResponse && importResponse.projectID === sourceProjectID)
    result.seeding.responseDirectoryMatchesSource = Boolean(importResponse && importResponse.location && importResponse.location.directory === state.projectDir)
    result.seeding.suppliedProjectIDPreserved = Boolean(importResponse && importResponse.projectID === SUPPLIED_PROJECT_ID)
    if (!result.seeding.responseIdMatchesRequested || !result.seeding.responseProjectMatchesSource || !result.seeding.responseDirectoryMatchesSource) {
      throw new ProbeStop("seed-import-readback-mismatch", "seeding")
    }

    const seededGet = await sessionGet({ sessionID: state.sessionID })
    result.seeding.readbackIdMatches = Boolean(seededGet && seededGet.id === state.sessionID)
    result.seeding.readbackProjectMatchesSource = Boolean(seededGet && seededGet.projectID === sourceProjectID)
    result.seeding.readbackDirectoryMatchesSource = Boolean(seededGet && seededGet.location && seededGet.location.directory === state.projectDir)
    if (!result.seeding.readbackIdMatches || !result.seeding.readbackProjectMatchesSource || !result.seeding.readbackDirectoryMatchesSource) {
      throw new ProbeStop("seed-get-mismatch", "seeding")
    }

    const seededMessages = await messageList({ sessionID: state.sessionID, limit: 200, order: "asc" })
    const seededData = seededMessages && Array.isArray(seededMessages.data) ? seededMessages.data : null
    result.seeding.messageCount = seededData ? seededData.length : null
    result.seeding.settled = Boolean(
      seededData && seededData.length === 2 &&
      seededData[0] && seededData[0].type === "user" &&
      seededData[1] && seededData[1].type === "assistant" &&
      seededData[1].time && typeof seededData[1].time.completed === "number"
    )
    if (!result.seeding.settled) throw new ProbeStop("seed-messages-not-settled", "seeding")

    const seededList = await sessionList({ project: sourceProjectID, limit: 50 })
    const seededListData = seededList && Array.isArray(seededList.data) ? seededList.data : null
    result.seeding.listedInSourceProject = Boolean(
      seededListData && seededListData.some(function (item) { return item && item.id === state.sessionID })
    )
    if (!result.seeding.listedInSourceProject) throw new ProbeStop("seed-not-listed", "seeding")

    result.stage = "checkpoint-command"
    const checkpointMark = completionMark(state)
    result.checkpoint.invoked = true
    keymap.dispatch(state.expectedIDs[0], state.artifactPath)
    const checkpointCompletion = await waitForCommandCompletion(state, checkpointMark, COMMAND_COMPLETION_TIMEOUT_MS, false)
    result.checkpoint.completionSignal = checkpointCompletion.signal
    result.checkpoint.completionWaitedMs = checkpointCompletion.waitedMs
    result.checkpoint.completionTimedOut = checkpointCompletion.timedOut
    result.checkpoint.notifications = state.notifications.slice(checkpointMark.notifications, checkpointMark.notifications + MAX_NOTIFICATION_FACTS)
    if (checkpointCompletion.timedOut) throw new ProbeStop("checkpoint-completion-timeout", "checkpoint-command")

    result.stage = "checkpoint-artifact"
    let artifactStat = null
    try { artifactStat = statSync(state.artifactPath) } catch (error) { artifactStat = null }
    result.checkpoint.artifactExists = Boolean(artifactStat && artifactStat.isFile())
    result.checkpoint.artifactBytes = artifactStat && artifactStat.isFile() ? artifactStat.size : null
    if (!result.checkpoint.artifactExists || !(result.checkpoint.artifactBytes > 0)) {
      throw new ProbeStop("artifact-missing-or-empty", "checkpoint-artifact")
    }
    const scan = scanArtifact(state.artifactPath, state.secret)
    result.checkpoint.scan = scan
    if (scan.truncated) throw new ProbeStop("artifact-scan-truncated", "checkpoint-artifact")
    if (!scan.plaintextMarkerAbsent || !scan.passwordBytesAbsent) {
      throw new ProbeStop("artifact-plaintext-detected", "checkpoint-artifact")
    }

    result.stage = "expected-ids"
    // Independent expected-ID derivation: open the checkpoint artifact in memory
    // through the product crypto boundary and derive the deterministic O-22
    // remapped session/message IDs with the product deriver BEFORE the restore
    // is dispatched. The derived values stay in memory; only shape/distinctness
    // booleans are recorded. No import promise, response, or dialog is trusted
    // for success.
    let expectedIdModules = null
    try {
      expectedIdModules = {
        crypto: await import("../../../repo/src/core/crypto/index.ts"),
        restore: await import("../../../repo/src/core/restore/index.ts"),
        profile: await import("../../../repo/src/tui/wiring/experimental-profile.ts"),
        files: await import("../../../repo/src/tui/artifacts/files.ts")
      }
    } catch (error) {
      throw new ProbeStop("expected-id-import-failed", "expected-ids")
    }
    const expected = await computeExpectedRemappedIds(expectedIdModules, state)
    result.expectedIds.artifactOpenedAndAuthenticated = Boolean(expected.ok)
    if (expected.ok) {
      result.expectedIds.sessionDerivedShapeValid = DERIVED_SESSION_ID_PATTERN.test(expected.sessionID)
      result.expectedIds.messageIdsDerivedShapeValid = DERIVED_MESSAGE_ID_PATTERN.test(expected.messageID1) && DERIVED_MESSAGE_ID_PATTERN.test(expected.messageID2)
      result.expectedIds.sessionDiffersFromSource = expected.sessionID !== state.sessionID
      result.expectedIds.messageIdsDifferFromSource = expected.messageID1 !== state.messageID1 && expected.messageID2 !== state.messageID2
      state.expectedSessionID = expected.sessionID
      state.expectedMessageID1 = expected.messageID1
      state.expectedMessageID2 = expected.messageID2
    }
    result.expectedIds.derived = Boolean(
      expected.ok &&
      result.expectedIds.sessionDerivedShapeValid &&
      result.expectedIds.messageIdsDerivedShapeValid &&
      result.expectedIds.sessionDiffersFromSource &&
      result.expectedIds.messageIdsDifferFromSource
    )
    if (!result.expectedIds.derived) {
      throw new ProbeStop("expected-id-derivation-failed", "expected-ids")
    }

    result.stage = "restore-target"
    const targetResponse = await locationGet({ location: { directory: state.targetDir } })
    const targetValidation = validateLocationResponse(targetResponse, state.targetDir, undefined)
    result.restoreTarget.resolved = targetValidation.ok
    result.restoreTarget.reason = targetValidation.reason || null
    if (!targetValidation.ok) throw new ProbeStop("target-location-invalid", "restore-target")
    const targetProjectID = targetValidation.projectID

    const projects = await projectList(undefined)
    const listedTarget = Array.isArray(projects)
      ? projects.find(function (project) { return project && project.id === targetProjectID })
      : undefined
    result.restoreTarget.listedInProjectList = Boolean(listedTarget)
    result.restoreTarget.canonicalMatchesTarget = Boolean(listedTarget && listedTarget.canonical === state.targetDir)
    if (!listedTarget || listedTarget.canonical !== state.targetDir) {
      throw new ProbeStop("target-pair-unresolved", "restore-target")
    }
    state.predeclaredCandidate = { projectID: targetProjectID, targetDirectory: state.targetDir }
    result.restoreTarget.candidateDeclared = true

    result.stage = "restore-command"
    const restoreMark = completionMark(state)
    result.restore.invoked = true
    keymap.dispatch(state.expectedIDs[1], state.artifactPath)
    const restoreCompletion = await waitForCommandCompletion(state, restoreMark, COMMAND_COMPLETION_TIMEOUT_MS, true)
    result.restore.completionSignal = restoreCompletion.signal
    result.restore.completionWaitedMs = restoreCompletion.waitedMs
    result.restore.completionTimedOut = restoreCompletion.timedOut
    result.restore.notifications = state.notifications.slice(restoreMark.notifications, restoreMark.notifications + MAX_NOTIFICATION_FACTS)
    result.restore.dialogSelect = {
      called: state.dialog.called,
      optionCount: state.dialog.lastOptionCount,
      matches: state.dialog.matches,
      matchedPredeclared: state.dialog.matchedPredeclared
    }
    result.restore.dialogShowCalls = state.dialog.showCalls
    if (restoreCompletion.timedOut) throw new ProbeStop("restore-completion-timeout", "restore-command")
    if (state.dialog.matchedPredeclared !== true) throw new ProbeStop("restore-selection-not-confirmed", "restore-command")

    result.stage = "verification"
    // All target/source readbacks compare against the expected remapped IDs that
    // were derived in memory from the authenticated artifact identity before the
    // restore was dispatched; neither the import promise nor any dialog is
    // treated as success evidence. Single call per readback; no retries.
    const targetList = await sessionList({ project: targetProjectID, limit: 50 })
    const targetListData = targetList && Array.isArray(targetList.data) ? targetList.data : null
    if (targetListData === null) throw new ProbeStop("target-list-malformed", "verification")
    const listedExpected = targetListData.find(function (item) { return item && item.id === state.expectedSessionID })
    const listedSource = targetListData.find(function (item) { return item && item.id === state.sessionID })
    result.verification.targetListCount = targetListData.length
    result.verification.listedExpectedSessionIdMatches = Boolean(listedExpected)
    result.verification.listedSourceSessionIdAbsentInTarget = !listedSource
    result.verification.listedProjectMatchesTarget = Boolean(listedExpected && listedExpected.projectID === targetProjectID)
    if (!result.verification.listedExpectedSessionIdMatches || !result.verification.listedProjectMatchesTarget || !result.verification.listedSourceSessionIdAbsentInTarget) {
      throw new ProbeStop("target-expected-id-mismatch", "verification")
    }

    const importedGet = await sessionGet({ sessionID: state.expectedSessionID })
    result.verification.getOk = Boolean(importedGet)
    result.verification.getProjectMatchesTarget = Boolean(importedGet && importedGet.projectID === targetProjectID)
    result.verification.getDirectoryMatchesTarget = Boolean(importedGet && importedGet.location && importedGet.location.directory === state.targetDir)
    if (!result.verification.getOk || !result.verification.getProjectMatchesTarget || !result.verification.getDirectoryMatchesTarget) {
      throw new ProbeStop("target-get-mismatch", "verification")
    }

    const importedMessages = await messageList({ sessionID: state.expectedSessionID, limit: 200, order: "asc" })
    const importedData = importedMessages && Array.isArray(importedMessages.data) ? importedMessages.data : null
    result.verification.messageCount = importedData ? importedData.length : null
    const first = importedData ? importedData[0] : undefined
    const second = importedData ? importedData[1] : undefined
    result.verification.userMessageMatches = Boolean(first && first.type === "user" && first.text === USER_TEXT)
    result.verification.assistantMessageSettled = Boolean(second && second.type === "assistant" && second.time && typeof second.time.completed === "number")
    result.verification.assistantMarkerMatches = Boolean(
      second && Array.isArray(second.content) && second.content.some(function (part) {
        return part && part.type === "text" && part.text === ASSISTANT_TEXT
      })
    )
    result.verification.messageIdsMatchDerivedExpected = Boolean(first && second && first.id === state.expectedMessageID1 && second.id === state.expectedMessageID2)
    result.verification.messageIdsDifferFromSource = Boolean(first && second && first.id !== state.messageID1 && second.id !== state.messageID2)
    if (!(result.verification.messageCount === 2) || !result.verification.userMessageMatches || !result.verification.assistantMessageSettled || !result.verification.assistantMarkerMatches || !result.verification.messageIdsMatchDerivedExpected) {
      throw new ProbeStop("target-message-mismatch", "verification")
    }

    // Original source preserved by public readback (single call per readback;
    // no retries): the seeded source session and its message IDs must be
    // unchanged in the source project after the restore.
    const sourceGet = await sessionGet({ sessionID: state.sessionID })
    result.verification.sourcePreservedGetOk = Boolean(sourceGet && sourceGet.id === state.sessionID)
    result.verification.sourcePreservedProjectMatchesSource = Boolean(sourceGet && sourceGet.projectID === sourceProjectID)
    result.verification.sourcePreservedDirectoryMatchesSource = Boolean(sourceGet && sourceGet.location && sourceGet.location.directory === state.projectDir)
    result.verification.sourcePreservedTitleMatches = Boolean(sourceGet && sourceGet.title === "synthetic sp-command probe session")
    const sourceMessages = await messageList({ sessionID: state.sessionID, limit: 200, order: "asc" })
    const sourceData = sourceMessages && Array.isArray(sourceMessages.data) ? sourceMessages.data : null
    result.verification.sourcePreservedMessageCount = sourceData ? sourceData.length : null
    result.verification.sourcePreservedMessageIdsUnchanged = Boolean(
      sourceData && sourceData.length === 2 &&
      sourceData[0] && sourceData[1] &&
      sourceData[0].id === state.messageID1 &&
      sourceData[1].id === state.messageID2
    )
    result.verification.sourcePreservedUserMessageMatches = Boolean(sourceData && sourceData[0] && sourceData[0].type === "user" && sourceData[0].text === USER_TEXT)
    result.verification.sourcePreservedAssistantSettled = Boolean(sourceData && sourceData[1] && sourceData[1].type === "assistant" && sourceData[1].time && typeof sourceData[1].time.completed === "number")
    result.verification.sourcePreservedAssistantMarkerMatches = Boolean(
      sourceData && sourceData[1] && Array.isArray(sourceData[1].content) && sourceData[1].content.some(function (part) {
        return part && part.type === "text" && part.text === ASSISTANT_TEXT
      })
    )
    const sourceList = await sessionList({ project: sourceProjectID, limit: 50 })
    const sourceListData = sourceList && Array.isArray(sourceList.data) ? sourceList.data : null
    result.verification.sourcePreservedListedInSourceProject = Boolean(
      sourceListData && sourceListData.some(function (item) { return item && item.id === state.sessionID })
    )
    if (
      !result.verification.sourcePreservedGetOk ||
      !result.verification.sourcePreservedProjectMatchesSource ||
      !result.verification.sourcePreservedDirectoryMatchesSource ||
      !result.verification.sourcePreservedTitleMatches ||
      !(result.verification.sourcePreservedMessageCount === 2) ||
      !result.verification.sourcePreservedMessageIdsUnchanged ||
      !result.verification.sourcePreservedUserMessageMatches ||
      !result.verification.sourcePreservedAssistantSettled ||
      !result.verification.sourcePreservedAssistantMarkerMatches ||
      !result.verification.sourcePreservedListedInSourceProject
    ) {
      throw new ProbeStop("source-session-not-preserved", "verification")
    }

    result.stage = "complete"
    result.ok = true
  } catch (error) {
    result.ok = false
    if (error instanceof ProbeStop) {
      result.failure = { class: "probe", code: error.code }
      result.stage = error.stage
    } else {
      result.failure = { class: "probe", code: "unexpected-error", error: errorInfo(error) }
      result.stage = "probe-error"
    }
  } finally {
    // Pre-write leak guard: the serialized result must not contain any synthetic
    // or derived ID, password bytes, or raw probe path. The guard runs while the
    // password is still in memory; the secret is zeroed immediately afterwards.
    let guarded = result
    try {
      const guard = buildLeakGuard(result, state)
      result.leakGuard = guard
      if (guard.idsAbsent !== true || guard.pathsAbsent !== true || guard.passwordBytesAbsent !== true) {
        guarded = {
          probe: PROBE_NAME,
          pluginID: PLUGIN_ID,
          stage: "leak-guard",
          ok: false,
          failure: { class: "probe", code: "result-leak-guard" },
          leakGuard: guard
        }
      }
    } catch (error) {
      guarded = {
        probe: PROBE_NAME,
        pluginID: PLUGIN_ID,
        stage: "leak-guard",
        ok: false,
        failure: { class: "probe", code: "result-leak-guard-unchecked" },
        leakGuard: { checked: false, idsAbsent: null, pathsAbsent: null, passwordBytesAbsent: null }
      }
    }
    try { state.secret.fill(0) } catch (error) { }
    writeResult(state.resultPath, guarded)
  }
}

export default {
  id: PLUGIN_ID,
  async setup(context) {
    if (scheduled) return
    scheduled = true

    const env = process.env
    const root = readEnv(env, "SP_PROBE_ROOT")
    const resultPath = readEnv(env, "SP_PROBE_RESULT")
    const projectDir = readEnv(env, "SP_PROBE_PROJECT")
    const targetDir = readEnv(env, "SP_PROBE_TARGET")
    const artifactPath = readEnv(env, "SP_PROBE_ARTIFACT")
    const repoDir = readEnv(env, "SP_PROBE_REPO")
    const sessionID = readEnv(env, "SP_PROBE_SESSION_ID")
    const messageID1 = readEnv(env, "SP_PROBE_MESSAGE_ID_1")
    const messageID2 = readEnv(env, "SP_PROBE_MESSAGE_ID_2")

    const result = {
      probe: PROBE_NAME,
      pluginID: PLUGIN_ID,
      stage: "isolation-gate",
      ok: false,
      failure: null,
      runtime: {
        bun: typeof Bun !== "undefined" ? Bun.version : null,
        node: process.version,
        platform: process.platform,
        arch: process.arch
      },
      isolation: { rootPresent: false, checks: {}, violations: [], homedir: null, tmpdir: null, cwd: null },
      syntheticIds: { shapeOk: null },
      leakGuard: null,
      hostSurface: {},
      context: { locationDirectory: null, locationUnderRoot: null, locationMatchesSource: null },
      wiring: {
        installed: false,
        disposerCallable: false,
        requestPasswordProvider: "probe-test-in-memory-random-32-bytes",
        cryptoFactory: "product-default",
        idDeriver: "product-default",
        passwordProvider: { calls: 0, modes: [], maxPasswordBytesSeen: null }
      },
      capabilities: {},
      commands: {
        expected: [],
        registered: [],
        bothRegistered: false,
        duplicates: 0,
        lastReadError: null,
        invocationMethod: "public-keymap-dispatch",
        invocationNote: "invokes each registered command ID exactly once through the public keymap dispatch(id, input) surface; dispatch returns void and is asynchronous from the harness perspective, so completion is awaited on the probe's bounded UI captures (a new toast notification, plus a report-dialog show for restore) within a bounded deadline; no command run callback fallback; slash parsing and key input are not exercised",
        dispatchCallable: null,
        completionTimeoutMs: COMMAND_COMPLETION_TIMEOUT_MS
      },
      sourceLocation: { ok: false, reason: null },
      seeding: {
        importAttempted: false,
        importOk: false,
        responseIdMatchesRequested: null,
        responseProjectMatchesSource: null,
        responseDirectoryMatchesSource: null,
        suppliedProjectIDPreserved: null,
        readbackIdMatches: null,
        readbackProjectMatchesSource: null,
        readbackDirectoryMatchesSource: null,
        messageCount: null,
        settled: null,
        listedInSourceProject: null
      },
      checkpoint: {
        invoked: false,
        completionSignal: null,
        completionWaitedMs: null,
        completionTimedOut: null,
        artifactExists: false,
        artifactBytes: null,
        scan: null,
        notifications: []
      },
      expectedIds: {
        derived: false,
        artifactOpenedAndAuthenticated: false,
        sessionDerivedShapeValid: null,
        messageIdsDerivedShapeValid: null,
        sessionDiffersFromSource: null,
        messageIdsDifferFromSource: null
      },
      restoreTarget: { resolved: false, reason: null, listedInProjectList: null, canonicalMatchesTarget: null, candidateDeclared: false },
      restore: {
        invoked: false,
        completionSignal: null,
        completionWaitedMs: null,
        completionTimedOut: null,
        dialogShowCalls: 0,
        dialogSelect: { called: 0, optionCount: null, matches: 0, matchedPredeclared: null },
        importAudit: createImportAudit(),
        notifications: []
      },
      verification: {
        expectedIdSource: "derived-from-authenticated-artifact-in-memory",
        targetListCount: null,
        listedExpectedSessionIdMatches: null,
        listedSourceSessionIdAbsentInTarget: null,
        listedProjectMatchesTarget: null,
        getOk: null,
        getProjectMatchesTarget: null,
        getDirectoryMatchesTarget: null,
        messageCount: null,
        userMessageMatches: null,
        assistantMessageSettled: null,
        assistantMarkerMatches: null,
        messageIdsMatchDerivedExpected: null,
        messageIdsDifferFromSource: null,
        sourcePreservedGetOk: null,
        sourcePreservedProjectMatchesSource: null,
        sourcePreservedDirectoryMatchesSource: null,
        sourcePreservedTitleMatches: null,
        sourcePreservedMessageCount: null,
        sourcePreservedMessageIdsUnchanged: null,
        sourcePreservedUserMessageMatches: null,
        sourcePreservedAssistantSettled: null,
        sourcePreservedAssistantMarkerMatches: null,
        sourcePreservedListedInSourceProject: null
      },
      limits: [
        "one Windows host and one installed OpenCode version per run; no cross-version, cross-platform, or restart claims",
        "commands are invoked model-free through the public keymap dispatch(id, input) surface; dispatch returns void and is asynchronous from the harness perspective, so completion is observed through probe-only UI captures (a new toast notification, plus a report-dialog show for restore) within a bounded deadline; slash parsing and key input are not exercised, and no command run callback is used",
        "the checkpoint/restore password provider is a test-only in-memory random provider, not the real masked modal; the dialog.select adapter is not the real selector modal; the restore report dialog is only counted when the host shows it (no dialog content is read)",
        "explicit location.get calls persist/upsert project state in the disposable isolated store (E42-observed side effect); this is expected and bounded",
        "staged repo source copy + dependency junction live only inside the disposable root; this is not a packaged/bundled artifact and makes no packaging or distribution claim",
        "synthetic runner-generated IDs and messages only; the expected remapped session/message IDs are derived in memory from the authenticated artifact identity through the product crypto boundary and O-22 deriver for this single synthetic session, but general derivation/collision behavior, parent/fork, retry, and partial-failure cases are not validated",
        "the probe opens the checkpoint artifact once more in memory (same explicit experimental policy, local only, no host call) solely to obtain the authenticated artifact identity for expected-ID derivation; the payload bytes, password copy, and identity buffer are best-effort zeroed and never retained, serialized, or written",
        "the serialized result is written only after an in-memory leak guard confirms it contains none of the synthetic/derived IDs, password bytes, or raw probe paths; on any detected leak or an unrunnable guard, a minimal sanitized failure result is written instead",
        "the result.restore.importAudit fields are sanitized attempt/response facts for the product-wiring context's client.session.import only (capped call/resolved/rejected counts, an overflow fact, and in-memory shape/ID/project/directory booleans); they are not report-content capture, not a persistence or success proof, and the runner's own seed/read calls stay on the original client",
        "no direct database access, user/session data, model/prompt/tool/replay calls, or Git; possible background host auto-update behavior is not disabled or ruled out",
        "single synthetic round trip in one run; no concurrency, restart, conflict, or user-session cases"
      ]
    }

    const checks = {}
    const violations = []

    function check(label, value, required) {
      if (typeof value !== "string" || value.length === 0) {
        checks[label] = required ? "missing" : "unset"
        if (required) violations.push(label + ":missing")
        return
      }
      if (isUnder(value, root)) {
        checks[label] = "under-root"
        return
      }
      checks[label] = "outside-root"
      violations.push(label + ":outside-root")
    }

    let homedir = ""
    let tmpdir = ""
    let cwd = ""
    try { homedir = os.homedir() } catch (error) { homedir = "" }
    try { tmpdir = os.tmpdir() } catch (error) { tmpdir = "" }
    try { cwd = process.cwd() } catch (error) { cwd = "" }

    result.isolation.rootPresent = root.length > 0
    if (!result.isolation.rootPresent) {
      violations.push("SP_PROBE_ROOT:missing")
    } else {
      check("homedir", homedir, true)
      check("tmpdir", tmpdir, true)
      check("cwd", cwd, true)
      check("projectDir", projectDir, true)
      check("targetDir", targetDir, true)
      check("artifactPath", artifactPath, true)
      check("resultPath", resultPath, true)
      check("repoDir", repoDir, true)
      check("env.XDG_DATA_HOME", env["XDG_DATA_HOME"], true)
      check("env.XDG_CACHE_HOME", env["XDG_CACHE_HOME"], true)
      check("env.XDG_CONFIG_HOME", env["XDG_CONFIG_HOME"], true)
      check("env.XDG_STATE_HOME", env["XDG_STATE_HOME"], true)
      check("env.OPENCODE_CONFIG_DIR", env["OPENCODE_CONFIG_DIR"], true)
      check("env.HOME", env["HOME"], true)
      check("env.USERPROFILE", env["USERPROFILE"], true)
      check("env.APPDATA", env["APPDATA"], true)
      check("env.LOCALAPPDATA", env["LOCALAPPDATA"], true)
      check("env.TMP", env["TMP"], true)
      check("env.TEMP", env["TEMP"], true)
      check("env.TMPDIR", env["TMPDIR"], true)
      const homeDrive = readEnv(env, "HOMEDRIVE")
      const homePath = readEnv(env, "HOMEPATH")
      if (homeDrive.length > 0 && homePath.length > 0) {
        check("env.HOMEDRIVE+HOMEPATH", homeDrive + homePath, true)
      } else {
        checks["env.HOMEDRIVE+HOMEPATH"] = "unset"
      }
    }

    result.isolation.checks = checks
    result.isolation.violations = violations
    result.isolation.homedir = sanitizePath(homedir, root)
    result.isolation.tmpdir = sanitizePath(tmpdir, root)
    result.isolation.cwd = sanitizePath(cwd, root)

    if (!result.isolation.rootPresent || violations.length > 0) {
      // Bounded failure: zero context.client calls. Write only when the result
      // path itself resolved under the verified root.
      result.stage = "isolation-gate"
      result.failure = { class: "isolation", code: violations.length > 0 ? "violations" : "root-missing" }
      if (result.isolation.rootPresent && checks["resultPath"] === "under-root") {
        writeResult(resultPath, result)
      }
      return
    }

    result.syntheticIds.shapeOk = /^ses_[0-9a-f]{64}$/.test(sessionID) &&
      /^msg_[0-9a-f]{64}$/.test(messageID1) &&
      /^msg_[0-9a-f]{64}$/.test(messageID2)
    if (!result.syntheticIds.shapeOk) {
      result.stage = "synthetic-ids"
      result.failure = { class: "probe", code: "invalid-synthetic-ids" }
      writeResult(resultPath, result)
      return
    }

    const client = context && context.client
    const ui = context && context.ui
    const keymap = context && context.keymap
    result.hostSurface = {
      clientPresent: Boolean(client),
      slotCallable: Boolean(ui && typeof ui.slot === "function"),
      dialogSelectCallable: Boolean(ui && ui.dialog && typeof ui.dialog.select === "function"),
      toastShowCallable: Boolean(ui && ui.toast && typeof ui.toast.show === "function"),
      keymapLayerCallable: Boolean(keymap && typeof keymap.layer === "function"),
      keymapCommandsCallable: Boolean(keymap && typeof keymap.commands === "function")
    }
    const surface = result.hostSurface
    if (!surface.clientPresent || !surface.slotCallable || !surface.dialogSelectCallable || !surface.toastShowCallable || !surface.keymapLayerCallable || !surface.keymapCommandsCallable) {
      result.stage = "host-surface"
      result.failure = { class: "probe", code: "host-surface-unavailable" }
      writeResult(resultPath, result)
      return
    }

    let wiringModule = null
    let commandsModule = null
    try {
      wiringModule = await import("../../../repo/src/tui/wiring/install.ts")
      commandsModule = await import("../../../repo/src/tui/ui/sessionport-commands.tsx")
    } catch (error) {
      result.stage = "repo-import"
      result.failure = { class: "probe", code: "repo-import-failed", error: errorInfo(error) }
      writeResult(resultPath, result)
      return
    }
    if (!wiringModule || typeof wiringModule.installSessionPortWiring !== "function" || !commandsModule || !commandsModule.SESSIONPORT_COMMAND_IDS) {
      result.stage = "repo-import"
      result.failure = { class: "probe", code: "repo-exports-unavailable" }
      writeResult(resultPath, result)
      return
    }

    const secret = randomBytes(32)
    const expectedIDs = [commandsModule.SESSIONPORT_COMMAND_IDS.checkpoint, commandsModule.SESSIONPORT_COMMAND_IDS.restore]
    result.commands.expected = expectedIDs.slice()
    result.commands.dispatchCallable = typeof keymap.dispatch === "function"

    const state = {
      context: context,
      root: root,
      resultPath: resultPath,
      projectDir: projectDir,
      targetDir: targetDir,
      artifactPath: artifactPath,
      sessionID: sessionID,
      messageID1: messageID1,
      messageID2: messageID2,
      repoDir: repoDir,
      secret: secret,
      expectedSessionID: null,
      expectedMessageID1: null,
      expectedMessageID2: null,
      expectedIDs: expectedIDs,
      result: result,
      notifications: [],
      dialog: { called: 0, lastOptionCount: null, matches: 0, matchedPredeclared: null, showCalls: 0 },
      predeclaredCandidate: null,
      // Same object as result.restore.importAudit: the wrapper mutates it live,
      // so every result write (including bounded failure paths) carries the
      // current sanitized import facts.
      importAudit: result.restore.importAudit
    }

    const wrapped = buildWrappedContext(context, state)
    let disposer = null
    try {
      disposer = await wiringModule.installSessionPortWiring(wrapped, {
        requestPassword: async function (mode, maxPasswordBytes) {
          result.wiring.passwordProvider.calls += 1
          if (result.wiring.passwordProvider.modes.length < 4) result.wiring.passwordProvider.modes.push(mode)
          result.wiring.passwordProvider.maxPasswordBytesSeen = typeof maxPasswordBytes === "number" ? maxPasswordBytes : null
          return Uint8Array.from(secret)
        }
      })
    } catch (error) {
      result.stage = "wiring-install"
      result.failure = { class: "probe", code: "wiring-install-failed", error: errorInfo(error) }
      writeResult(resultPath, result)
      return
    }
    result.wiring.installed = true
    result.wiring.disposerCallable = typeof disposer === "function"
    result.stage = "scheduled"

    setTimeout(function () {
      runProbe(state).catch(function (error) {
        result.ok = false
        result.failure = { class: "probe", code: "unexpected-error", error: errorInfo(error) }
        result.stage = "probe-error"
        try { writeResult(resultPath, result) } catch (innerError) { }
      })
    }, PROBE_START_DELAY_MS)
  }
}
'@

# ---------------------------------------------------------------------------
# Handle-bound process identity/termination helper. Compiled on demand in
# -RunProbe mode only (validation-only mode never compiles or executes it).
# Every termination (root and descendants) goes through the same OS handle
# whose identity was read and verified before use; a process ID is never
# trusted on its own, so a reused PID cannot redirect termination to an
# unrelated process.
# ---------------------------------------------------------------------------

$ProcessHelperSource = @'
using System;
using System.Runtime.InteropServices;

namespace SessionPortProbe
{
    // Handle-bound process identity and termination for the probe runner.
    // Open captures the process instance currently holding the ID and reads its
    // immutable identity (creation time) and creator PID from that same handle.
    // IsExited/Terminate operate on that handle only and never re-open by ID, so
    // a reused PID can never change the answer or redirect a termination.
    public sealed class ProbeProcessHandle : IDisposable
    {
        private const uint PROCESS_TERMINATE = 0x0001;
        private const uint PROCESS_QUERY_INFORMATION = 0x0400;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint WAIT_OBJECT_0 = 0;
        private const int ProcessBasicInformation = 0;

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint Low;
            public uint High;
        }

        // IntPtr fields keep the native x86/x64 layout of PROCESS_BASIC_INFORMATION.
        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_BASIC_INFORMATION
        {
            public IntPtr ExitStatus;
            public IntPtr PebBaseAddress;
            public IntPtr AffinityMask;
            public IntPtr BasePriority;
            public IntPtr UniqueProcessId;
            public IntPtr InheritedFromUniqueProcessId;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr handle, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr handle, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref PROCESS_BASIC_INFORMATION info, int infoLength, IntPtr returnLength);

        private IntPtr handle = IntPtr.Zero;
        private bool disposed = false;

        public int ProcessId { get; private set; }
        public long CreationTimeUtcTicks { get; private set; }
        public int ParentProcessId { get; private set; }

        private ProbeProcessHandle()
        {
        }

        // Returns null and sets win32Error (or a negative NTSTATUS) when the process
        // cannot be opened or inspected. win32Error 87 means no process holds the ID.
        public static ProbeProcessHandle Open(int processId, out int win32Error)
        {
            win32Error = 0;
            if (processId <= 0)
            {
                win32Error = 87;
                return null;
            }
            IntPtr opened = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | SYNCHRONIZE, false, processId);
            if (opened == IntPtr.Zero)
            {
                win32Error = Marshal.GetLastWin32Error();
                return null;
            }
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            if (!GetProcessTimes(opened, out creation, out exit, out kernel, out user))
            {
                win32Error = Marshal.GetLastWin32Error();
                CloseHandle(opened);
                return null;
            }
            PROCESS_BASIC_INFORMATION basic = new PROCESS_BASIC_INFORMATION();
            int status = NtQueryInformationProcess(opened, ProcessBasicInformation, ref basic, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), IntPtr.Zero);
            if (status != 0)
            {
                win32Error = status;
                CloseHandle(opened);
                return null;
            }
            ProbeProcessHandle result = new ProbeProcessHandle();
            result.handle = opened;
            result.ProcessId = processId;
            result.CreationTimeUtcTicks = ((long)creation.High << 32) | (long)creation.Low;
            result.ParentProcessId = basic.InheritedFromUniqueProcessId.ToInt32();
            return result;
        }

        // True only when the exact process instance behind this handle has exited.
        public bool IsExited()
        {
            if (disposed || handle == IntPtr.Zero)
            {
                return true;
            }
            return WaitForSingleObject(handle, 0) == WAIT_OBJECT_0;
        }

        // Terminates the exact process instance behind this handle; never re-opens by
        // process ID. Returns true when the process is gone afterwards.
        public bool Terminate()
        {
            if (disposed || handle == IntPtr.Zero)
            {
                return false;
            }
            if (IsExited())
            {
                return true;
            }
            if (TerminateProcess(handle, 1))
            {
                return true;
            }
            return IsExited();
        }

        public void Dispose()
        {
            if (!disposed && handle != IntPtr.Zero)
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
            disposed = true;
        }
    }

    // Bounded in-memory capture for a child stdout stream (runner-side harness-output
    // guard, not a product crypto/payload limit). Reads continuously so the child can
    // never block on a full pipe; retains at most maxCaptureBytes bytes; any byte
    // beyond the cap sets the fixed-safe overflow flag while reading continues and
    // discards the remainder; read errors set the faulted flag and complete the
    // capture. Runs on a dedicated background thread with no PowerShell runspace
    // involvement; the caller polls the bounded completion flag.
    public sealed class BoundedStreamDrain
    {
        private readonly System.IO.Stream stream;
        private readonly int maxCaptureBytes;
        private readonly byte[] buffer;
        private int capturedLength;
        private volatile bool overflow;
        private volatile bool faulted;
        private volatile bool completed;
        private System.Threading.Thread thread;

        public BoundedStreamDrain(System.IO.Stream stream, int maxCaptureBytes)
        {
            if (stream == null)
            {
                throw new System.ArgumentNullException("stream");
            }
            if (maxCaptureBytes < 0)
            {
                throw new System.ArgumentOutOfRangeException("maxCaptureBytes");
            }
            this.stream = stream;
            this.maxCaptureBytes = maxCaptureBytes;
            this.buffer = new byte[maxCaptureBytes];
        }

        public bool Completed
        {
            get { return completed; }
        }

        public bool Faulted
        {
            get { return faulted; }
        }

        public bool Overflow
        {
            get { return overflow; }
        }

        public int CapturedLength
        {
            get { return capturedLength; }
        }

        public void Start()
        {
            if (thread != null)
            {
                throw new System.InvalidOperationException("the capture has already been started");
            }
            thread = new System.Threading.Thread(new System.Threading.ThreadStart(Run));
            thread.IsBackground = true;
            thread.Name = "SessionPortProbeBoundedStreamDrain";
            thread.Start();
        }

        private void Run()
        {
            byte[] chunk = new byte[8192];
            try
            {
                while (true)
                {
                    int read = stream.Read(chunk, 0, chunk.Length);
                    if (read <= 0)
                    {
                        break;
                    }
                    if (!overflow)
                    {
                        int room = maxCaptureBytes - capturedLength;
                        int take = read < room ? read : room;
                        if (take > 0)
                        {
                            System.Array.Copy(chunk, 0, buffer, capturedLength, take);
                            capturedLength += take;
                        }
                        if (read > take)
                        {
                            overflow = true;
                        }
                    }
                    // Bytes beyond the cap (and every byte after an overflow) are
                    // discarded here; the loop keeps reading so the child never blocks.
                }
            }
            catch
            {
                faulted = true;
            }
            finally
            {
                completed = true;
            }
        }

        // UTF-8 decode of the captured bytes; returns empty text unless the capture
        // completed without overflow and without a read fault.
        public string GetCapturedText()
        {
            if (!completed || faulted || overflow)
            {
                return "";
            }
            return System.Text.Encoding.UTF8.GetString(buffer, 0, capturedLength);
        }
    }
}
'@

# ---------------------------------------------------------------------------
# Helpers (E42 isolation/stop/cleanup mechanics)
# ---------------------------------------------------------------------------

function Test-UnderRoot {
    param([string]$Child, [string]$Root)
    try {
        if ([string]::IsNullOrWhiteSpace($Child) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
        if (-not [System.IO.Path]::IsPathRooted($Child)) { return $false }
        $c = [System.IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
        $r = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
        if ($c.Length -lt $r.Length) { return $false }
        if (-not $c.StartsWith($r, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
        if ($c.Length -eq $r.Length) { return $true }
        $next = $c.Substring($r.Length, 1)
        return ($next -eq '\' -or $next -eq '/')
    } catch {
        return $false
    }
}

function New-SyntheticHex64 {
    $a = [guid]::NewGuid().ToString("N")
    $b = [guid]::NewGuid().ToString("N")
    return ($a + $b)
}

function Backup-ProcessEnv {
    $script:EnvBackup = @{}
    foreach ($name in $ProbeEnvNames) {
        $script:EnvBackup[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process")
    }
    $script:EnvBackupTaken = $true
}

function Set-ProcessEnv {
    param([string]$Name, [string]$Value)
    [System.Environment]::SetEnvironmentVariable($Name, $Value, "Process")
}

function Restore-ProcessEnv {
    if (-not $script:EnvBackupTaken) { return }
    foreach ($name in $ProbeEnvNames) {
        $value = $null
        if ($script:EnvBackup.ContainsKey($name)) { $value = $script:EnvBackup[$name] }
        [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

function Get-ReparseGateResult {
    param([string]$Path)
    # Conservative physical-path gate. Any reparse point (junction, symlink, mount
    # point) in the path chain from the drive root down to and including the target
    # could silently redirect later creation/removal outside the approved base, so the
    # only safe answer is refusal; the gate never resolves reparse targets.
    try {
        if ([string]::IsNullOrWhiteSpace($Path)) {
            return [pscustomobject]@{ Ok = $false; Reason = "path is empty" }
        }
        if (-not [System.IO.Path]::IsPathRooted($Path)) {
            return [pscustomobject]@{ Ok = $false; Reason = "path is not rooted" }
        }
        $full = [System.IO.Path]::GetFullPath($Path)
        $rootPrefix = [System.IO.Path]::GetPathRoot($full)
        if ($full.Length -gt $rootPrefix.Length) { $full = $full.TrimEnd('\', '/') }
        $current = $full
        while ($true) {
            try {
                $attributes = [System.IO.File]::GetAttributes($current)
                if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    return [pscustomobject]@{ Ok = $false; Reason = ("reparse point in path chain: " + $current) }
                }
            } catch [System.IO.FileNotFoundException] {
                # Not created yet; a non-existent path cannot be a reparse point.
            } catch [System.IO.DirectoryNotFoundException] {
            } catch {
                return [pscustomobject]@{ Ok = $false; Reason = ("path inspection failed at " + $current) }
            }
            $parent = [System.IO.Directory]::GetParent($current)
            if ($null -eq $parent) { break }
            $current = $parent.FullName
            $currentRoot = [System.IO.Path]::GetPathRoot($current)
            if ($current.Length -gt $currentRoot.Length) { $current = $current.TrimEnd('\', '/') }
        }
        return [pscustomobject]@{ Ok = $true; Reason = "" }
    } catch {
        return [pscustomobject]@{ Ok = $false; Reason = "path gate evaluation failed" }
    }
}

function Get-RemainingReparsePoints {
    param([string]$RootPath)
    # Bounded manual traversal that never descends into a reparse point.
    # PowerShell 5.1 Get-ChildItem -Recurse can follow junctions, so it is not used
    # here: enumerating entries and checking attributes directly cannot traverse a
    # link. Ok=$false means the scan itself could not prove safety (enumeration
    # failure or bound exceeded) and recursive removal must be refused.
    $points = New-Object System.Collections.Generic.List[string]
    try {
        $rootFull = [System.IO.Path]::GetFullPath($RootPath)
    } catch {
        return [pscustomobject]@{ Ok = $false; Points = $points; Reason = "root path could not be normalized for the reparse scan" }
    }
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push($rootFull)
    $visited = 0
    $maxEntries = 20000
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        $visited++
        if ($visited -gt $maxEntries) {
            return [pscustomobject]@{ Ok = $false; Points = $points; Reason = "reparse scan exceeded its entry bound" }
        }
        $entries = $null
        try {
            $entries = @([System.IO.Directory]::EnumerateFileSystemEntries($dir))
        } catch {
            return [pscustomobject]@{ Ok = $false; Points = $points; Reason = ("reparse scan could not enumerate " + $dir) }
        }
        foreach ($entry in $entries) {
            $visited++
            if ($visited -gt $maxEntries) {
                return [pscustomobject]@{ Ok = $false; Points = $points; Reason = "reparse scan exceeded its entry bound" }
            }
            $attributes = $null
            try {
                $attributes = [System.IO.File]::GetAttributes($entry)
            } catch {
                return [pscustomobject]@{ Ok = $false; Points = $points; Reason = ("reparse scan could not inspect " + $entry) }
            }
            if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                $points.Add($entry)
                continue
            }
            if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
                $stack.Push($entry)
            }
        }
    }
    return [pscustomobject]@{ Ok = $true; Points = $points; Reason = "" }
}

function Initialize-ProbeProcessHelper {
    # Compiles the handle-bound identity/termination helper on demand. Called in
    # -RunProbe mode before any child process is created; validation-only mode never
    # compiles anything. If the type is already loaded (for example a second run in
    # the same session), it is reused.
    if ($script:ProbeProcessHelperReady) { return $true }
    try {
        # Two statements on purpose: the chained [PSTypeName]'Name'.Type form does not
        # resolve reliably under Windows PowerShell 5.1. Both helper classes must be
        # present before reuse; a mixed state falls through to a compile that either
        # succeeds for both or fails closed.
        $probeTypeName = [System.Management.Automation.PSTypeName]'SessionPortProbe.ProbeProcessHandle'
        $captureTypeName = [System.Management.Automation.PSTypeName]'SessionPortProbe.BoundedStreamDrain'
        if ($null -ne $probeTypeName.Type -and $null -ne $captureTypeName.Type) {
            $script:ProbeProcessHelperReady = $true
            return $true
        }
    } catch { }
    try {
        Add-Type -TypeDefinition $ProcessHelperSource -Language CSharp -ErrorAction Stop
        $script:ProbeProcessHelperReady = $true
        return $true
    } catch {
        return $false
    }
}

function Get-CimProcessChildrenMap {
    # One system-wide process snapshot per call: parent PID -> child PID list, or $null
    # when the snapshot cannot be taken. This data only nominates candidates; it is
    # never proof of ownership, and callers must treat $null as ambiguous (fail closed).
    try {
        $rows = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    } catch {
        return $null
    }
    $map = @{}
    foreach ($row in $rows) {
        $childPid = 0
        $parentPid = 0
        try {
            $childPid = [int]$row.ProcessId
            $parentPid = [int]$row.ParentProcessId
        } catch {
            continue
        }
        if ($childPid -le 0) { continue }
        if (-not $map.ContainsKey($parentPid)) {
            $map[$parentPid] = New-Object System.Collections.Generic.List[int]
        }
        [void]$map[$parentPid].Add($childPid)
    }
    return $map
}

function Get-ProcessCreationTicks {
    param([System.Diagnostics.Process]$Process)
    # Creation time (FILETIME ticks, UTC) of a process object this runner started.
    # Used only as the expected identity for verifying the retained root
    # handle; liveness/termination never use this object. $null means the root identity
    # cannot be verified and callers must fail closed.
    try {
        if ($null -eq $Process) { return $null }
        $start = $Process.StartTime
        return [long]$start.ToFileTimeUtc()
    } catch {
        return $null
    }
}

function New-DescendantTracker {
    param(
        [System.Diagnostics.Process]$RootProcess,
        [object]$RootCreationTicks
    )
    # Opens the root by its process ID exactly once, verifies the opened instance
    # against the returned process object (PID, creation FILETIME captured from
    # that object, and creator identity as this runner process), and retains the
    # native handle. Every later root liveness/termination decision uses this handle
    # only. If the process cannot be opened or the identity cannot be verified, the
    # tracker is marked ambiguous and all callers fail closed; no PID-based stop is
    # ever attempted.
    $rootPid = 0
    if ($null -ne $RootProcess) {
        try { $rootPid = [int]$RootProcess.Id } catch { $rootPid = 0 }
    }
    $tracker = [pscustomobject]@{
        RootPid = $rootPid
        RootCreationTicks = $RootCreationTicks
        RootHandle = $null
        Records = (New-Object System.Collections.Generic.List[object])
        BoundsExhausted = $false
        AmbiguousReason = ""
    }
    if ($rootPid -le 0) {
        $tracker.AmbiguousReason = "the root process ID is unavailable; the root identity cannot be verified"
        return $tracker
    }
    if ($null -eq $RootCreationTicks) {
        $tracker.AmbiguousReason = "the root creation time is unavailable; the root identity cannot be verified"
        return $tracker
    }
    $openError = 0
    $handle = [SessionPortProbe.ProbeProcessHandle]::Open($rootPid, [ref]$openError)
    if ($null -eq $handle) {
        $tracker.AmbiguousReason = ("the root process could not be opened (error " + [string]$openError + "); the root identity cannot be verified")
        return $tracker
    }
    $identityOk = $false
    try {
        $identityOk = (
            ([int]$handle.ProcessId -eq $rootPid) -and
            ([long]$handle.CreationTimeUtcTicks -eq [long]$RootCreationTicks) -and
            ([int]$handle.ParentProcessId -eq [int]$PID)
        )
    } catch {
        $identityOk = $false
    }
    if (-not $identityOk) {
        $handle.Dispose()
        $tracker.AmbiguousReason = "the opened root process does not match the recorded launch identity; refusing any PID-based fallback"
        return $tracker
    }
    $tracker.RootHandle = $handle
    return $tracker
}

function Test-TrackerNodeAlive {
    param(
        [object]$Tracker,
        [int]$NodePid
    )
    if ($Tracker.RootPid -gt 0 -and $NodePid -eq $Tracker.RootPid) {
        if ($null -eq $Tracker.RootHandle) { return $false }
        try { return (-not $Tracker.RootHandle.IsExited()) } catch { return $false }
    }
    foreach ($record in $Tracker.Records) {
        if ($record.Pid -eq $NodePid) {
            try { return (-not $record.Handle.IsExited()) } catch { return $false }
        }
    }
    return $false
}

function Find-TrackerRecord {
    param(
        [object]$Tracker,
        [int]$RecordPid,
        [object]$RecordTicks
    )
    foreach ($record in $Tracker.Records) {
        if ($record.Pid -ne $RecordPid) { continue }
        if ($null -eq $RecordTicks) { return $record }
        if ([long]$record.Ticks -eq [long]$RecordTicks) { return $record }
    }
    return $null
}

function Update-ProvenDescendants {
    param(
        [object]$Tracker,
        [hashtable]$ChildrenMap
    )
    # Best-effort, never-kill snapshot walk. A process is added to the tracker only
    # when its ownership is proven from a handle: the handle's immutable creator PID
    # equals the parent's PID, the handle's creation time is at/after the parent
    # instance's creation time, and the parent instance is still alive (so its PID
    # cannot have been reused between the child's creation and this observation).
    # Anything else - enumeration failure, an uninspectable candidate, an unavailable
    # parent creation time, a depth/count bound reached with a remaining frontier -
    # marks the tracker incomplete/ambiguous and callers must fail closed.
    if ($Tracker.AmbiguousReason -ne "") { return }
    if ($Tracker.BoundsExhausted) { return }
    if ($null -eq $ChildrenMap) {
        $Tracker.AmbiguousReason = "process enumeration failed"
        return
    }
    $maxDepth = 8
    $maxRecords = 64
    $frontier = New-Object System.Collections.Generic.List[object]
    if (Test-TrackerNodeAlive -Tracker $Tracker -NodePid $Tracker.RootPid) {
        $frontier.Add([pscustomobject]@{ Pid = $Tracker.RootPid; Ticks = $Tracker.RootCreationTicks })
    }
    foreach ($record in $Tracker.Records) {
        $recordAlive = $false
        try { $recordAlive = (-not $record.Handle.IsExited()) } catch { $recordAlive = $false }
        if ($recordAlive) {
            $frontier.Add([pscustomobject]@{ Pid = $record.Pid; Ticks = $record.Ticks })
        }
    }
    $depth = 0
    while ($frontier.Count -gt 0) {
        if ($depth -ge $maxDepth) {
            $Tracker.BoundsExhausted = $true
            return
        }
        $depth++
        $next = New-Object System.Collections.Generic.List[object]
        foreach ($parent in $frontier) {
            if (-not (Test-TrackerNodeAlive -Tracker $Tracker -NodePid $parent.Pid)) { continue }
            $childPids = $null
            if ($ChildrenMap.ContainsKey($parent.Pid)) { $childPids = $ChildrenMap[$parent.Pid] }
            if ($null -eq $childPids) { continue }
            if ($null -eq $parent.Ticks) {
                if ($childPids.Count -gt 0) {
                    $Tracker.AmbiguousReason = "the parent creation time is unavailable; candidates cannot be attributed"
                    return
                }
                continue
            }
            foreach ($childPid in $childPids) {
                if ($childPid -eq $PID) {
                    $Tracker.AmbiguousReason = "a candidate process matches the runner process"
                    return
                }
                $existing = Find-TrackerRecord -Tracker $Tracker -RecordPid $childPid -RecordTicks $null
                if ($null -ne $existing) {
                    $existingAlive = $false
                    try { $existingAlive = (-not $existing.Handle.IsExited()) } catch { $existingAlive = $false }
                    if ($existingAlive) { continue }
                }
                $openError = 0
                $handle = [SessionPortProbe.ProbeProcessHandle]::Open($childPid, [ref]$openError)
                if ($null -eq $handle) {
                    if ($openError -eq 87) { continue }
                    $Tracker.AmbiguousReason = ("process " + [string]$childPid + " could not be inspected (error " + [string]$openError + ")")
                    return
                }
                $proven = $false
                try {
                    if ($handle.ParentProcessId -eq $parent.Pid -and [long]$handle.CreationTimeUtcTicks -ge [long]$parent.Ticks) {
                        $proven = $true
                    }
                } catch {
                    $proven = $false
                }
                if ($proven -and -not (Test-TrackerNodeAlive -Tracker $Tracker -NodePid $parent.Pid)) {
                    # The parent instance exited during verification: the creator PID
                    # can no longer be attributed to it.
                    $proven = $false
                }
                if (-not $proven) {
                    $handle.Dispose()
                    continue
                }
                if ($null -ne (Find-TrackerRecord -Tracker $Tracker -RecordPid $childPid -RecordTicks $handle.CreationTimeUtcTicks)) {
                    $handle.Dispose()
                    continue
                }
                if ($Tracker.Records.Count -ge $maxRecords) {
                    $handle.Dispose()
                    $Tracker.BoundsExhausted = $true
                    return
                }
                $ticks = [long]$handle.CreationTimeUtcTicks
                $Tracker.Records.Add([pscustomobject]@{ Pid = $childPid; Ticks = $ticks; Handle = $handle })
                $next.Add([pscustomobject]@{ Pid = $childPid; Ticks = $ticks })
            }
        }
        $frontier = $next
    }
}

function Wait-HandleExit {
    param(
        [object]$Handle,
        [int]$TimeoutMs
    )
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        try { if ($Handle.IsExited()) { return $true } } catch { return $false }
        Start-Sleep -Milliseconds 100
    }
    try { return $Handle.IsExited() } catch { return $false }
}

function Test-NoUnattributedDescendants {
    param([object]$Tracker)
    # Post-stop attribution is evidence for refusal only, never a kill license. Walks
    # the parent-PID evidence from the (dead) root and from every proven PID, and
    # returns a reason string when any live process reached by that evidence was not
    # proven from a handle while its parent was alive, or when the walk itself is
    # incomplete; otherwise returns "".
    $map = Get-CimProcessChildrenMap
    if ($null -eq $map) { return "post-stop process enumeration failed" }
    $maxDepth = 8
    $maxVisited = 4096
    $walked = @{}
    $checked = @{}
    $frontier = New-Object System.Collections.Generic.List[int]
    # Seed with the root and every proven PID: a dead intermediate process is not
    # listed in the snapshot, so its live children are only reachable by asking for
    # the children of its recorded PID directly. Reaching any live process that is
    # not one of the recorded identities is ambiguous and fails closed.
    if (-not $walked.ContainsKey($Tracker.RootPid)) {
        $walked[$Tracker.RootPid] = $true
        $frontier.Add($Tracker.RootPid)
    }
    foreach ($record in $Tracker.Records) {
        if (-not $walked.ContainsKey($record.Pid)) {
            $walked[$record.Pid] = $true
            $frontier.Add($record.Pid)
        }
    }
    $depth = 0
    while ($frontier.Count -gt 0) {
        if ($depth -ge $maxDepth) {
            return "the post-stop traversal reached its depth bound with a remaining frontier"
        }
        $depth++
        $next = New-Object System.Collections.Generic.List[int]
        foreach ($parentPid in $frontier) {
            $childPids = $null
            if ($map.ContainsKey($parentPid)) { $childPids = $map[$parentPid] }
            if ($null -eq $childPids) { continue }
            foreach ($childPid in $childPids) {
                if ($childPid -eq $PID) { return "the post-stop traversal reached the runner process" }
                if ($checked.ContainsKey($childPid)) { continue }
                if ($checked.Count -ge $maxVisited) {
                    return "the post-stop traversal reached its entry bound with a remaining frontier"
                }
                $checked[$childPid] = $true
                $openError = 0
                $handle = [SessionPortProbe.ProbeProcessHandle]::Open($childPid, [ref]$openError)
                if ($null -eq $handle) {
                    if ($openError -eq 87) { continue }
                    return ("process " + [string]$childPid + " could not be inspected after stop (error " + [string]$openError + ")")
                }
                $recorded = $false
                try {
                    $ticks = [long]$handle.CreationTimeUtcTicks
                    foreach ($record in $Tracker.Records) {
                        if ($record.Pid -eq $childPid -and [long]$record.Ticks -eq $ticks) {
                            $recorded = $true
                            break
                        }
                    }
                } catch {
                    $recorded = $false
                }
                $handle.Dispose()
                if (-not $recorded) {
                    return ("process " + [string]$childPid + " is still reachable from the root but its ownership was never proven while its parent was alive")
                }
                if (-not $walked.ContainsKey($childPid)) {
                    $walked[$childPid] = $true
                    $next.Add($childPid)
                }
            }
        }
        $frontier = $next
    }
    return ""
}

function Stop-ProvenProcessTree {
    param([object]$Tracker)
    # Handle-bound stop. The root is terminated only through the retained native
    # handle whose identity was verified against the recorded launch identity at
    # tracker construction, and each descendant only through the handle whose identity was
    # proven while its parent was alive. No process is ever addressed by a bare PID,
    # and no unproven process is killed. Any uncertainty (missing root handle,
    # incomplete traversal, uninspectable candidate, unverified survivor, root exit
    # that cannot be verified) returns Ok=$false; the caller must retain the root and
    # fail cleanup.
    $result = [pscustomobject]@{ Ok = $false; Survivors = 0; Reason = "" }
    if ($null -eq $Tracker) {
        $result.Reason = "no tracked process tree is available"
        return $result
    }
    if ($null -eq $Tracker.RootHandle) {
        $result.Reason = "the root identity handle is unavailable; refusing any termination"
        return $result
    }

    # Last chance to prove descendants while the root may still be alive (never kills).
    if ($Tracker.AmbiguousReason -eq "" -and -not $Tracker.BoundsExhausted) {
        $childrenMap = Get-CimProcessChildrenMap
        if ($null -eq $childrenMap) {
            $Tracker.AmbiguousReason = "process enumeration failed before stop"
        } else {
            Update-ProvenDescendants -Tracker $Tracker -ChildrenMap $childrenMap
        }
    }

    # Root: termination only through the retained identity-verified native handle.
    $rootExited = $false
    try {
        if ($Tracker.RootHandle.IsExited()) {
            $rootExited = $true
        } else {
            [void]$Tracker.RootHandle.Terminate()
            $rootExited = Wait-HandleExit -Handle $Tracker.RootHandle -TimeoutMs 10000
        }
    } catch {
        $rootExited = $false
    }

    # Descendants: handle-bound termination through verified handles only.
    foreach ($record in $Tracker.Records) {
        try {
            if (-not $record.Handle.IsExited()) {
                [void]$record.Handle.Terminate()
                [void](Wait-HandleExit -Handle $record.Handle -TimeoutMs 10000)
            }
        } catch { }
    }

    $survivors = 0
    foreach ($record in $Tracker.Records) {
        $recordExited = $false
        try { $recordExited = $record.Handle.IsExited() } catch { $recordExited = $false }
        if (-not $recordExited) { $survivors++ }
    }

    # Post-exit attribution is refusal evidence only: any live process still reachable
    # from the root that was not proven while its parent was alive is ambiguous.
    $attribution = Test-NoUnattributedDescendants -Tracker $Tracker
    if ($attribution -ne "" -and $Tracker.AmbiguousReason -eq "") {
        $Tracker.AmbiguousReason = $attribution
    }

    if (-not $rootExited) {
        $result.Reason = "the root process could not be verified as exited"
        $result.Survivors = $survivors + 1
        return $result
    }
    if ($survivors -gt 0) {
        $result.Reason = "one or more verified processes did not exit after termination"
        $result.Survivors = $survivors
        return $result
    }
    if ($Tracker.BoundsExhausted) {
        $result.Reason = "the descendant traversal reached a depth/count bound with a remaining frontier"
        return $result
    }
    if ($Tracker.AmbiguousReason -ne "") {
        $result.Reason = $Tracker.AmbiguousReason
        return $result
    }
    $result.Ok = $true
    return $result
}

function Wait-PreflightProcess {
    param(
        [System.Diagnostics.Process]$Process,
        [object]$Tracker,
        [int]$TimeoutSeconds
    )
    # Waits for the preflight parent while periodically proving descendants from
    # handles (never killing). Root liveness is decided only through the tracker's
    # identity-verified native handle; the Process object is used afterwards only to
    # report the exit code of a process already verified exited. Snapshot cadence is
    # bounded and additive; an enumeration failure marks the tracker ambiguous (fail
    # closed), and a missing root handle fails closed immediately.
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $stopped = $false
    $verifyFailed = ""
    $iteration = 0
    if ($null -eq $Tracker -or $null -eq $Tracker.RootHandle) {
        return [pscustomobject]@{ Stopped = $false; ExitCode = $null; VerifyFailed = "the preflight root identity handle is unavailable; the exit state cannot be verified" }
    }
    while ((Get-Date) -lt $deadline) {
        $iteration++
        if (($iteration % 4) -eq 1 -and $Tracker.AmbiguousReason -eq "" -and -not $Tracker.BoundsExhausted) {
            $childrenMap = Get-CimProcessChildrenMap
            if ($null -eq $childrenMap) {
                $Tracker.AmbiguousReason = "process enumeration failed during the preflight wait"
            } else {
                Update-ProvenDescendants -Tracker $Tracker -ChildrenMap $childrenMap
            }
        }
        try {
            if ($Tracker.RootHandle.IsExited()) { $stopped = $true; break }
        } catch {
            $verifyFailed = "the preflight process exit state could not be verified"
            break
        }
        Start-Sleep -Milliseconds 150
    }
    $exitCode = $null
    if ($stopped) {
        try { $exitCode = $Process.ExitCode } catch { $exitCode = $null }
    }
    return [pscustomobject]@{ Stopped = $stopped; ExitCode = $exitCode; VerifyFailed = $verifyFailed }
}

function Close-DescendantTracker {
    param([object]$Tracker)
    if ($null -eq $Tracker) { return }
    foreach ($record in $Tracker.Records) {
        try { $record.Handle.Dispose() } catch { }
    }
    # Root handle disposal: the retained identity handle is released on every close
    # path (preflight finally and the cleanup safety net); disposal is idempotent.
    try { if ($null -ne $Tracker.RootHandle) { $Tracker.RootHandle.Dispose() } } catch { }
}

function Start-ProbeChildProcess {
    param(
        [hashtable]$EnvMap,
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [switch]$CaptureStdOut
    )
    # Launches a child with UseShellExecute=false (the no-new-window equivalent) and
    # redirected stdio, then drains both streams in memory only: stdout is either
    # captured in memory (preflight path-map parse) or discarded to Stream.Null, and
    # stderr is always discarded to Stream.Null. No raw child output is written to
    # disk and no redirect files exist. Exact environment guarantee: the snapshot is
    # set in the runner process only around process creation (the child receives a
    # private copy at creation time) and the runner's original values are restored in
    # finally immediately after the child is started, on every launch path. A normal
    # invocation does not leave the caller's environment changed.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.WorkingDirectory = $WorkingDirectory
    $quotedArgs = @()
    foreach ($argument in $Arguments) {
        if ($argument -match '[\s"]') { $quotedArgs += ('"' + $argument + '"') } else { $quotedArgs += $argument }
    }
    $extension = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
    if ($extension -eq ".cmd" -or $extension -eq ".bat") {
        $inner = '"' + $FilePath + '"'
        if ($quotedArgs.Count -gt 0) { $inner = $inner + " " + ($quotedArgs -join " ") }
        $psi.FileName = Join-Path $env:SystemRoot "System32\cmd.exe"
        $psi.Arguments = "/d /s /c " + $inner
    } elseif ($extension -eq ".ps1") {
        $psi.FileName = "powershell.exe"
        $psi.Arguments = (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $FilePath) + $quotedArgs) -join " "
    } else {
        $psi.FileName = $FilePath
        $psi.Arguments = $quotedArgs -join " "
    }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    if (-not $script:EnvBackupTaken) { Backup-ProcessEnv }
    try {
        foreach ($name in $EnvMap.Keys) {
            Set-ProcessEnv -Name $name -Value ([string]$EnvMap[$name])
        }
        $started = $process.Start()
    } finally {
        Restore-ProcessEnv
    }
    if (-not $started) {
        throw "the child process could not be started"
    }
    # Continuous in-memory draining (nothing is persisted): the child never blocks on
    # a full pipe. stderr is always discarded to Stream.Null; stdout is either captured
    # by the bounded in-memory helper (preflight path-map parse; fixed harness-output
    # cap, overflow fails the gate closed) or discarded to Stream.Null.
    $stdErrDrain = $process.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)
    if ($CaptureStdOut) {
        $stdOutCapture = [SessionPortProbe.BoundedStreamDrain]::new($process.StandardOutput.BaseStream, $PreflightStdoutCaptureCapBytes)
        $stdOutCapture.Start()
        return [pscustomobject]@{ Process = $process; StdOutDrain = $null; StdOutCapture = $stdOutCapture; StdErrDrain = $stdErrDrain }
    }
    $stdOutDrain = $process.StandardOutput.BaseStream.CopyToAsync([System.IO.Stream]::Null)
    return [pscustomobject]@{ Process = $process; StdOutDrain = $stdOutDrain; StdOutCapture = $null; StdErrDrain = $stdErrDrain }
}

function Parse-DebugPaths {
    param([string]$Text)
    $map = @{}
    if ([string]::IsNullOrWhiteSpace($Text)) { return $map }
    $clean = [System.Text.RegularExpressions.Regex]::Replace($Text, "\x1B\[[0-9;]*[A-Za-z]", "")
    try {
        $json = $clean | ConvertFrom-Json -ErrorAction Stop
        foreach ($key in $ExpectedPathKeys) {
            $value = $null
            $prop = $json.PSObject.Properties[$key]
            if ($null -ne $prop -and $null -ne $prop.Value) {
                $raw = $prop.Value
                if ($raw -is [string]) { $value = $raw }
                else {
                    $innerPath = $raw.PSObject.Properties["path"]
                    if ($null -ne $innerPath -and $innerPath.Value -is [string]) { $value = $innerPath.Value }
                    else {
                        $innerDir = $raw.PSObject.Properties["directory"]
                        if ($null -ne $innerDir -and $innerDir.Value -is [string]) { $value = $innerDir.Value }
                    }
                }
            }
            if (-not [string]::IsNullOrWhiteSpace($value)) { $map[$key] = $value.Trim('"', "'") }
        }
        if ($map.Count -eq $ExpectedPathKeys.Count) { return $map }
    } catch { }
    $map = @{}
    foreach ($line in ($clean -split "`r?`n")) {
        if ($line -match '^\s*[^A-Za-z0-9]*(home|data|cache|config|state|tmp|bin|log|repos|db)\s*[:=]?\s*(\S.*?)\s*$') {
            $key = $matches[1].ToLowerInvariant()
            if (-not $map.ContainsKey($key)) { $map[$key] = $matches[2].Trim('"', "'") }
        }
    }
    return $map
}

function New-DirectoryJunction {
    param([string]$LinkPath, [string]$TargetPath)
    try {
        if (Test-Path -LiteralPath $LinkPath) { return $false }
        if (-not (Test-Path -LiteralPath $TargetPath)) { return $false }
        New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null
        $item = Get-Item -LiteralPath $LinkPath -Force -ErrorAction Stop
        return ((($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0))
    } catch {
        return $false
    }
}

function Remove-ReparsePointLink {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
            # Not a reparse point: refuse to touch it (never delete a real directory here).
            return $false
        }
        $cmdLine = 'rmdir "' + $Path + '"'
        try { & cmd.exe /d /c $cmdLine 2>$null | Out-Null } catch { }
        if (Test-Path -LiteralPath $Path) {
            # Fallback: non-recursive removal only; never traverse into the junction target.
            try { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue } catch { }
        }
        return (-not (Test-Path -LiteralPath $Path))
    } catch {
        return $false
    }
}

function Remove-ProbeRoot {
    # Returns @{ Removed; Reason }. Removed=$false means the root was retained and
    # cleanup must fail; a conservative refusal is preferred over deleting any path
    # that could traverse outside the approved base.
    $result = [pscustomobject]@{ Removed = $false; Reason = "" }
    if ([string]::IsNullOrWhiteSpace($script:Root)) {
        $result.Reason = "no root was recorded"
        return $result
    }
    try {
        $rootFull = [System.IO.Path]::GetFullPath($script:Root)
        $baseFull = [System.IO.Path]::GetFullPath($ApprovedTempBase).TrimEnd('\')
    } catch {
        $result.Reason = "root or base path could not be normalized"
        return $result
    }
    if (-not $rootFull.StartsWith($baseFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $result.Reason = "root is not under the approved base"
        return $result
    }
    if ([System.IO.Path]::GetFileName($rootFull) -notlike ($RootNamePrefix + '*')) {
        $result.Reason = "root name does not match the approved prefix"
        return $result
    }
    if ($rootFull.TrimEnd('\') -eq $baseFull) {
        $result.Reason = "root equals the approved base"
        return $result
    }

    # Determine whether the root still exists; if it is already gone there is nothing
    # to remove and no unsafe removal can occur.
    $attributes = $null
    try {
        $attributes = [System.IO.File]::GetAttributes($rootFull)
    } catch [System.IO.FileNotFoundException] {
    } catch [System.IO.DirectoryNotFoundException] {
    } catch {
        $result.Reason = "root existence could not be determined"
        return $result
    }
    if ($null -eq $attributes) {
        $result.Removed = $true
        return $result
    }
    if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
        $result.Reason = "root exists but is not a directory"
        return $result
    }

    # Repeat the physical/reparse gate before cleanup: every existing ancestor from the
    # drive root through the root itself must be reparse-free; any unsafe path/reparse
    # condition retains the root and fails cleanup.
    $rootGate = Get-ReparseGateResult -Path $rootFull
    if (-not $rootGate.Ok) {
        $result.Reason = $rootGate.Reason
        return $result
    }

    # Safety-critical: remove the staged dependency junction link-first. A recursive
    # delete over a live junction could traverse into the developer checkout's
    # node_modules; if the link cannot be removed, keep the root instead.
    $junction = Join-Path $rootFull ("repo\node_modules")
    if (Test-Path -LiteralPath $junction) {
        if (-not (Remove-ReparsePointLink -Path $junction)) {
            $result.Reason = "the known dependency junction could not be removed link-first"
            return $result
        }
    }

    # Refuse recursive removal if any unexpected reparse point remains inside the root
    # (or if the bounded scan itself cannot prove the root is reparse-free).
    $scan = Get-RemainingReparsePoints -RootPath $rootFull
    if (-not $scan.Ok) {
        $result.Reason = $scan.Reason
        return $result
    }
    if ($scan.Points.Count -gt 0) {
        $result.Reason = "unexpected reparse point(s) remain inside the root"
        return $result
    }

    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            Remove-Item -LiteralPath $rootFull -Recurse -Force -ErrorAction Stop
        } catch {
            Start-Sleep -Milliseconds 500
        }
        if (-not (Test-Path -LiteralPath $rootFull)) {
            $result.Removed = $true
            return $result
        }
    }
    $result.Reason = "recursive removal did not complete"
    return $result
}

function Read-ResultField {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Get-RepoRootPath {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
}

function Get-ValidationFailures {
    $failures = New-Object System.Collections.Generic.List[string]
    if ($env:OS -ne "Windows_NT") { $failures.Add("host is not Windows_NT") }
    if ([string]::IsNullOrWhiteSpace($script:RepoRoot) -or -not (Test-Path -LiteralPath $script:RepoRoot)) {
        $failures.Add("repository root could not be resolved from the script location")
        return $failures
    }
    $required = @(
        "src\tui\wiring\install.ts",
        "src\tui\ui\sessionport-commands.tsx",
        "src\core\crypto\index.ts",
        "src\core\restore\index.ts",
        "src\tui\wiring\experimental-profile.ts",
        "src\tui\artifacts\files.ts",
        "package.json",
        "tsconfig.json",
        "node_modules\libsodium-wrappers-sumo\package.json",
        "node_modules\pako\package.json",
        "node_modules\solid-js\package.json",
        "node_modules\@opentui\solid\package.json"
    )
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot $relative))) {
            $failures.Add("missing repo path: " + $relative)
        }
    }
    $markers = @(
        "installSessionPortWiring",
        "SESSIONPORT_COMMAND_IDS",
        "keymap.commands",
        "keymap.dispatch(state.expectedIDs[",
        "waitForCommandCompletion",
        "checkpoint-completion-timeout",
        "restore-completion-timeout",
        "completionTimedOut",
        "SP_PROBE_ARTIFACT",
        "matchedPredeclared",
        "requestPassword",
        "../../../repo/src/tui/wiring/install.ts",
        "variant",
        "messageLength",
        "createImportAudit",
        "noteImportAuditCall",
        "recordImportResponseFacts",
        "MAX_IMPORT_AUDIT_CALLS",
        "importAudit",
        "result.restore.importAudit",
        "responseShapeValid",
        "returnedIdMatchesRequest",
        "returnedProjectIdMatchesPredeclaredTarget",
        "returnedLocationMatchesPredeclaredDirectory",
        "overflow: false",
        "Reflect.apply(importMethod, sessionOwner, arguments)",
        'resolveMethod(client, "session", "import")',
        "Object.assign({}, client, { session: sessionWrapper })",
        "computeExpectedRemappedIds",
        "expectedIdView",
        "buildLeakGuard",
        "createCheckpointCryptoFactory([modules.profile.EXPERIMENTAL_CRYPTO_POLICY_DEFINITION])",
        "createRemappedIdDeriver()",
        "readEncryptedArtifact(state.artifactPath)",
        "openAndStage(artifact, password)",
        "../../../repo/src/core/crypto/index.ts",
        "../../../repo/src/core/restore/index.ts",
        "../../../repo/src/tui/wiring/experimental-profile.ts",
        "../../../repo/src/tui/artifacts/files.ts",
        "expected-id-import-failed",
        "expected-id-derivation-failed",
        "target-expected-id-mismatch",
        "source-session-not-preserved",
        "listedExpectedSessionIdMatches",
        "messageIdsMatchDerivedExpected",
        "sourcePreservedMessageIdsUnchanged",
        "requestSessionIdMatchesDerivedExpected",
        "requestMessageIdsMatchDerivedExpected",
        "returnedIdMatchesDerivedExpected",
        "leakGuard",
        "idsAbsent",
        "pathsAbsent"
    )
    foreach ($marker in $markers) {
        if ($PluginSource.IndexOf($marker, [System.StringComparison]::Ordinal) -lt 0) {
            $failures.Add("embedded plugin is missing expected marker: " + $marker)
        }
    }
    # Static guard over the embedded plugin: dispatch is the only invocation path
    # (exactly one call site per registered command), and the old command.run
    # callback path must not reappear. Completion is asynchronous from the
    # harness perspective and is awaited on the wrapped UI captures, not on any
    # return value.
    $dispatchCallSites = ([regex]::Matches($PluginSource, [regex]::Escape("keymap.dispatch(state.expectedIDs["))).Count
    if ($dispatchCallSites -ne 2) {
        $failures.Add("embedded plugin must invoke keymap.dispatch exactly once per registered command (found " + [string]$dispatchCallSites + " call site(s))")
    }
    if ($PluginSource.IndexOf(".run(", [System.StringComparison]::Ordinal) -ge 0) {
        $failures.Add("embedded plugin still invokes a registered command run callback")
    }
    if ($PluginSource.IndexOf("SP_PROBE_PASSWORD", [System.StringComparison]::Ordinal) -ge 0) {
        $failures.Add("embedded plugin unexpectedly references a password environment variable")
    }
    if ($PluginSource.IndexOf("options.title", [System.StringComparison]::Ordinal) -ge 0) {
        $failures.Add("embedded plugin unexpectedly captures raw toast titles")
    }
    # Static guard over the import audit: the product-wiring context's
    # client.session.import must be wrapped exactly once with a receiver- and
    # argument-preserving call, the runner's own seed import must stay resolved
    # from the original client, and the wrapper must not unwrap a `.data`
    # envelope (the audit records booleans/counts only; the product adapter lane
    # owns shape/ID validation and this diagnostic never decides success).
    $importWrapSites = ([regex]::Matches($PluginSource, [regex]::Escape("Reflect.apply(importMethod, sessionOwner, arguments)"))).Count
    if ($importWrapSites -ne 1) {
        $failures.Add("embedded plugin must wrap the product-wiring context's session.import exactly once with a receiver/argument-preserving call (found " + [string]$importWrapSites + " site(s))")
    }
    $seedImportSites = ([regex]::Matches($PluginSource, [regex]::Escape('resolveMethod(client, "session", "import")'))).Count
    if ($seedImportSites -ne 1) {
        $failures.Add("embedded plugin must resolve the runner's own seed session.import from the original client exactly once (found " + [string]$seedImportSites + " site(s))")
    }
    if ($PluginSource.IndexOf("response.data", [System.StringComparison]::Ordinal) -ge 0) {
        $failures.Add("embedded plugin import audit unexpectedly unwraps a .data envelope")
    }
    $requiredFunctions = @(
        "Get-ReparseGateResult",
        "Get-RemainingReparsePoints",
        "Initialize-ProbeProcessHelper",
        "Get-CimProcessChildrenMap",
        "Get-ProcessCreationTicks",
        "New-DescendantTracker",
        "Update-ProvenDescendants",
        "Stop-ProvenProcessTree",
        "Test-NoUnattributedDescendants",
        "Wait-PreflightProcess",
        "Close-DescendantTracker",
        "Start-ProbeChildProcess",
        "Remove-ProbeRoot",
        "Remove-ReparsePointLink"
    )
    foreach ($functionName in $requiredFunctions) {
        if ($null -eq (Get-Command -Name $functionName -CommandType Function -ErrorAction SilentlyContinue)) {
            $failures.Add("required safety function is not defined: " + $functionName)
        }
    }
    # Static guard over the runner's own source: the cleanup/stop paths must not
    # contain a raw-PID termination utility call site or a PID-addressed stop cmdlet
    # call site (both are PID-reuse hazards and are not allowed to reappear), no
    # PowerShell process kill call site may exist, every terminate call site must be a
    # verified native handle call, the only raw handle termination form allowed is the
    # C# handle-addressed call, Process-object exit-liveness properties are not used,
    # and the root identity handle is disposed on every completed cleanup path.
    $selfPath = ""
    if (-not [string]::IsNullOrWhiteSpace($PSCommandPath)) { $selfPath = [string]$PSCommandPath }
    if ($selfPath.Length -gt 0) {
        $selfText = ""
        try { $selfText = [System.IO.File]::ReadAllText($selfPath) } catch { $selfText = "" }
        if ($selfText.Length -gt 0) {
            if ($selfText.IndexOf(("task" + "kill"), [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $failures.Add("runner source contains a raw-PID termination utility call site")
            }
            if ($selfText.IndexOf(("Stop-" + "Process"), [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $failures.Add("runner source contains a PID-addressed stop call site")
            }
            if ($selfText.IndexOf((".K" + "ill("), [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $failures.Add("runner source contains a PowerShell process kill call site")
            }
            if ($selfText.IndexOf((".Has" + "Exited"), [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $failures.Add("runner source still uses a Process-object exit-liveness property")
            }
            $terminateToken = ".Termi" + "nate()"
            $handleTerminateToken = "Handle." + "Termi" + "nate()"
            $terminateSites = ([regex]::Matches($selfText, [regex]::Escape($terminateToken))).Count
            $handleTerminateSites = ([regex]::Matches($selfText, [regex]::Escape($handleTerminateToken))).Count
            if ($terminateSites -lt 2 -or $terminateSites -ne $handleTerminateSites) {
                $failures.Add("runner source contains a terminate call site that is not a verified handle call")
            }
            if ($selfText.IndexOf(('$Tracker.Root' + 'Handle.' + 'Termi' + 'nate()'), [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("runner source is missing the root-handle terminate call site")
            }
            $terminateProcessToken = "TerminatePro" + "cess("
            $terminateProcessDeclToken = "TerminatePro" + "cess(IntPtr handle"
            $terminateProcessCallToken = "TerminatePro" + "cess(handle,"
            $tpSites = ([regex]::Matches($selfText, [regex]::Escape($terminateProcessToken))).Count
            $tpDeclSites = ([regex]::Matches($selfText, [regex]::Escape($terminateProcessDeclToken))).Count
            $tpCallSites = ([regex]::Matches($selfText, [regex]::Escape($terminateProcessCallToken))).Count
            if ($tpCallSites -lt 1 -or $tpSites -ne ($tpDeclSites + $tpCallSites)) {
                $failures.Add("runner source contains a TerminateProcess form that is not a handle-addressed C# call")
            }
            if ($selfText.IndexOf(('$Tracker.Root' + 'Handle.Dispose()'), [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("tracker cleanup does not dispose the root identity handle")
            }
            if ($selfText.IndexOf(("Close-Descendant" + "Tracker -Tracker " + '$pfTracker'), [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("the preflight tracker is not closed on every completed preflight path")
            }
            if ($selfText.IndexOf(("Close-Descendant" + "Tracker -Tracker " + '$script:TuiTracker'), [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("the TUI tracker is not closed on the completed cleanup path")
            }
            if ($selfText.IndexOf(("Close-Descendant" + "Tracker -Tracker " + '$script:PreflightTracker'), [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("the preflight tracker is not closed by the cleanup safety net")
            }
            # No-raw-capture guards: no debug log-print or log-level flag may reappear,
            # child output must never be redirected to persistent files (the
            # file-redirecting process launcher must not return), both child streams
            # must be drained in memory, and the outer catch must not print exception
            # messages. Concatenated tokens keep each guard from matching its own text.
            $printLogsToken = "--print" + "-logs"
            if ($selfText.IndexOf($printLogsToken, [System.StringComparison]::Ordinal) -ge 0) {
                $failures.Add("runner source still passes the raw debug log-print flag")
            }
            $logLevelToken = "--log" + "-level"
            if ($selfText.IndexOf($logLevelToken, [System.StringComparison]::Ordinal) -ge 0) {
                $failures.Add("runner source still passes a raw log-level flag")
            }
            $launcherToken = "Start-Proce" + "ss"
            if ($selfText.IndexOf($launcherToken, [System.StringComparison]::Ordinal) -ge 0) {
                $failures.Add("runner source still uses the file-redirecting process launcher")
            }
            $stdoutFileToken = "stdout" + ".txt"
            $stderrFileToken = "stderr" + ".txt"
            if (
                $selfText.IndexOf($stdoutFileToken, [System.StringComparison]::Ordinal) -ge 0 -or
                $selfText.IndexOf($stderrFileToken, [System.StringComparison]::Ordinal) -ge 0
            ) {
                $failures.Add("runner source still redirects child output to raw persistent files")
            }
            $exceptionMessageToken = ".Exception." + "Message"
            if ($selfText.IndexOf($exceptionMessageToken, [System.StringComparison]::Ordinal) -ge 0) {
                $failures.Add("runner source still prints an exception message")
            }
            $nullSinkToken = "[System.IO.Stream]::" + "Null"
            $nullSinkSites = ([regex]::Matches($selfText, [regex]::Escape($nullSinkToken))).Count
            if ($nullSinkSites -ne 2) {
                $failures.Add("both child streams must be drained to the in-memory null sink (found " + [string]$nullSinkSites + " site(s))")
            }
            # Bounded preflight-capture guards: the unbounded stdout read must not
            # return; the bounded in-memory helper class must exist and be used with
            # an explicit fixed cap; overflow must be consulted and fail closed with
            # fixed-safe text; the null-sink drains for the remaining streams stay.
            $unboundedReadToken = "ReadToEnd" + "Async"
            if ($selfText.IndexOf($unboundedReadToken, [System.StringComparison]::Ordinal) -ge 0) {
                $failures.Add("runner source still uses an unbounded stdout read")
            }
            $drainClassToken = "class BoundedStream" + "Drain"
            if ($selfText.IndexOf($drainClassToken, [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("the bounded in-memory stream drain helper class is missing")
            }
            $drainUseToken = "[SessionPortProbe.BoundedStream" + "Drain]::new("
            if ($selfText.IndexOf($drainUseToken, [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("the preflight capture does not use the bounded stream drain helper")
            }
            $captureCapToken = '$PreflightStdoutCaptureCapBytes = ' + '65536'
            if ($selfText.IndexOf($captureCapToken, [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("the bounded preflight capture cap constant is missing")
            }
            $captureOverflowToken = "exceeded the bounded preflight" + " capture cap"
            if ($selfText.IndexOf($captureOverflowToken, [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("the bounded preflight overflow fail-closed path is missing")
            }
            $captureOverflowPropToken = '$preflightCapture.' + 'Overflow'
            if ($selfText.IndexOf($captureOverflowPropToken, [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("the bounded preflight overflow flag is not consulted")
            }
            $redirectOutToken = "RedirectStandardOutput = " + '$true'
            $redirectErrToken = "RedirectStandardError = " + '$true'
            if (
                $selfText.IndexOf($redirectOutToken, [System.StringComparison]::Ordinal) -lt 0 -or
                $selfText.IndexOf($redirectErrToken, [System.StringComparison]::Ordinal) -lt 0
            ) {
                $failures.Add("both child streams must be redirected to in-memory pipes")
            }
            # Inline CLI debug override guard: every child launch must set the
            # documented inline CLI config variable from the explicit JSON constant,
            # so an inline CLI override inherited from the caller's environment cannot
            # enable the documented debug diagnostics. The variable token is
            # concatenated so this guard does not match its own text.
            $inlineConfigVarToken = "OPENCODE_CLI_" + "CONFIG_CONTENT"
            $inlineConfigSiteToken = ('"' + $inlineConfigVarToken + '" = $ChildCliConfigContentJson')
            if ($selfText.IndexOf($inlineConfigSiteToken, [System.StringComparison]::Ordinal) -lt 0) {
                $failures.Add("child environment map does not set the inline CLI config override from the JSON constant")
            }
        }
    }
    # Inline CLI debug override (documented V2 inline config shape): the child value
    # must be valid JSON whose only settings are the three documented debug
    # diagnostics set to boolean false, and the variable must be covered by the
    # environment backup set. This is an explicit documented-config override, not a
    # host-log disable control; no host-log absence is claimed.
    $inlineConfigVarName = "OPENCODE_CLI_" + "CONFIG_CONTENT"
    if ($ProbeEnvNames -notcontains $inlineConfigVarName) {
        $failures.Add("the child inline CLI config variable is not covered by the environment backup set")
    }
    $inlineConfigOk = $false
    try {
        $inlineConfig = $ChildCliConfigContentJson | ConvertFrom-Json -ErrorAction Stop
        $inlineTopNames = @($inlineConfig.PSObject.Properties.Name)
        $inlineDebugProp = $inlineConfig.PSObject.Properties["debug"]
        if ($null -ne $inlineDebugProp -and $null -ne $inlineDebugProp.Value) {
            $debugNames = @($inlineDebugProp.Value.PSObject.Properties.Name)
            $devtoolsProp = $inlineDebugProp.Value.PSObject.Properties["devtools"]
            $timingProp = $inlineDebugProp.Value.PSObject.Properties["timing"]
            $turnTokensProp = $inlineDebugProp.Value.PSObject.Properties["turn_tokens"]
            if (
                $inlineTopNames.Count -eq 1 -and $inlineTopNames[0] -eq "debug" -and
                $debugNames.Count -eq 3 -and
                ($debugNames -contains "devtools") -and
                ($debugNames -contains "timing") -and
                ($debugNames -contains "turn_tokens") -and
                $null -ne $devtoolsProp -and $devtoolsProp.Value -is [bool] -and $devtoolsProp.Value -eq $false -and
                $null -ne $timingProp -and $timingProp.Value -is [bool] -and $timingProp.Value -eq $false -and
                $null -ne $turnTokensProp -and $turnTokensProp.Value -is [bool] -and $turnTokensProp.Value -eq $false
            ) {
                $inlineConfigOk = $true
            }
        }
    } catch {
        $inlineConfigOk = $false
    }
    if (-not $inlineConfigOk) {
        $failures.Add("the child inline CLI config JSON must be valid and set only debug.devtools/debug.timing/debug.turn_tokens to boolean false")
    }
    if ($RootNamePrefix -ne "sp-command-") {
        $failures.Add("root prefix must be sp-command-")
    }
    if ([string]::IsNullOrWhiteSpace($ApprovedTempBase)) {
        $failures.Add("approved temp base is empty")
    }
    if (Test-Path -LiteralPath $ApprovedTempBase) {
        $baseGate = Get-ReparseGateResult -Path $ApprovedTempBase
        if (-not $baseGate.Ok) {
            $failures.Add("approved temp base fails the reparse-point gate: " + $baseGate.Reason)
        }
    }
    return $failures
}

function Invoke-ValidationOnly {
    Write-Host ("probe: " + $ProbeName)
    Write-Host "mode: validation-only (no OpenCode start; pass -RunProbe to execute)"
    $script:RepoRoot = ""
    try { $script:RepoRoot = Get-RepoRootPath } catch { $script:RepoRoot = "" }
    $failures = @(Get-ValidationFailures)
    if ($failures.Count -gt 0) {
        foreach ($failure in $failures) { Write-Host ("validation-failure: " + $failure) }
        Write-Host "VALIDATION-FAILED"
        return 1
    }
    Write-Host ("repo: " + $script:RepoRoot)
    Write-Host ("temp base: " + $ApprovedTempBase)
    if (Test-Path -LiteralPath $ApprovedTempBase) {
        Write-Host "temp base gate: reparse-free (existing base and its ancestor chain)"
    } else {
        Write-Host "temp base gate: base not present yet (ancestor gate runs before creation in -RunProbe mode)"
    }
    Write-Host ("root prefix: " + $RootNamePrefix)
    Write-Host "child inline CLI debug override: debug.devtools=false debug.timing=false debug.turn_tokens=false (explicit documented inline config; not a host-log disable control)"
    $resolved = ""
    if (-not [string]::IsNullOrWhiteSpace($OpenCodePath)) {
        if (Test-Path -LiteralPath $OpenCodePath) { $resolved = (Resolve-Path -LiteralPath $OpenCodePath).Path }
    } else {
        $cmd = @(Get-Command -Name "opencode" -ErrorAction SilentlyContinue) | Select-Object -First 1
        if ($null -ne $cmd) { $resolved = [string]$cmd.Source }
    }
    if ([string]::IsNullOrWhiteSpace($resolved)) {
        Write-Host "opencode: not resolved (informational in validation mode; required with -RunProbe)"
    } else {
        Write-Host ("opencode: " + $resolved)
    }
    Write-Host "would run: unique root under the approved temp base, 'opencode debug paths' preflight, in-root staging (repo src copy + dependency junction + probe plugin), actual TUI with --standalone, one synthetic /checkpoint -> /restore round trip invoked through public keymap dispatch with bounded completion waits (slash parsing/key input untested), stop/cleanup verification."
    Write-Host "VALIDATION-OK"
    return 0
}

# ---------------------------------------------------------------------------
# Main probe flow (requires -RunProbe)
# ---------------------------------------------------------------------------

function Invoke-ProbeMain {
    if ($env:OS -ne "Windows_NT") {
        Write-Host "PREFLIGHT-FAILED: this probe runner is Windows-only."
        return 1
    }

    try { $script:RepoRoot = Get-RepoRootPath } catch { $script:RepoRoot = "" }
    $validationFailures = @(Get-ValidationFailures)
    if ($validationFailures.Count -gt 0) {
        foreach ($failure in $validationFailures) { Write-Host ("PREFLIGHT-FAILED: " + $failure) }
        return 1
    }
    if (-not (Initialize-ProbeProcessHelper)) {
        Write-Host "PREFLIGHT-FAILED: the handle-bound process helper could not be initialized."
        return 1
    }

    # --- approved base: physical gate before creating anything ---
    # Conservative reparse-point gate: the approved base must exist as a real directory
    # and no existing ancestor from the drive root down (including the base itself) may
    # be a reparse point (junction, symlink, mount point). A reparse point in the chain
    # could silently redirect creation or removal outside the approved base, so refusal
    # is preferred to resolving it.
    if (-not (Test-Path -LiteralPath $ApprovedTempBase)) {
        $ancestorGate = Get-ReparseGateResult -Path $ApprovedTempBase
        if (-not $ancestorGate.Ok) {
            Write-Host ("PREFLIGHT-FAILED: approved temp base ancestor chain failed the reparse-point gate: " + $ancestorGate.Reason)
            return 1
        }
        try {
            New-Item -ItemType Directory -Path $ApprovedTempBase -Force -ErrorAction Stop | Out-Null
        } catch {
            Write-Host "PREFLIGHT-FAILED: approved temp base could not be created."
            return 1
        }
    }
    $baseItem = $null
    try { $baseItem = Get-Item -LiteralPath $ApprovedTempBase -Force -ErrorAction Stop } catch { $baseItem = $null }
    if ($null -eq $baseItem -or -not $baseItem.PSIsContainer) {
        Write-Host "PREFLIGHT-FAILED: approved temp base does not exist as a directory."
        return 1
    }
    $baseGate = Get-ReparseGateResult -Path $ApprovedTempBase
    if (-not $baseGate.Ok) {
        Write-Host ("PREFLIGHT-FAILED: approved temp base failed the reparse-point gate: " + $baseGate.Reason)
        return 1
    }

    # --- resolve the installed OpenCode command ---
    $resolved = ""
    if (-not [string]::IsNullOrWhiteSpace($OpenCodePath)) {
        if (-not (Test-Path -LiteralPath $OpenCodePath)) {
            Write-Host "PREFLIGHT-FAILED: -OpenCodePath does not exist."
            return 1
        }
        $resolved = (Resolve-Path -LiteralPath $OpenCodePath).Path
    } else {
        $cmd = @(Get-Command -Name "opencode" -ErrorAction SilentlyContinue) | Select-Object -First 1
        if ($null -eq $cmd) {
            Write-Host "PREFLIGHT-FAILED: 'opencode' not found on PATH; pass -OpenCodePath."
            return 1
        }
        $resolved = [string]$cmd.Source
        if ([string]::IsNullOrWhiteSpace($resolved)) {
            Write-Host "PREFLIGHT-FAILED: could not resolve an executable path for 'opencode'."
            return 1
        }
    }
    Write-Host ("opencode: " + $resolved)
    Write-Host "mode: single synthetic /checkpoint -> /restore round trip"
    Write-Host "invocation: public keymap dispatch(id, input) exactly once per registered command; dispatch returns void (asynchronous from the harness perspective) and completion is awaited on bounded UI captures; slash parsing and key input remain untested."

    # --- unique disposable root (created explicitly, then immediately gated) ---
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $suffix = ([guid]::NewGuid().ToString("N")).Substring(0, 8)
    $script:Root = Join-Path $ApprovedTempBase ($RootNamePrefix + $stamp + "-" + $suffix)
    if (Test-Path -LiteralPath $script:Root) {
        Write-Host "PREFLIGHT-FAILED: generated root already exists."
        return 1
    }
    try {
        New-Item -ItemType Directory -Path $script:Root -ErrorAction Stop | Out-Null
    } catch {
        Write-Host "PREFLIGHT-FAILED: could not create the generated root."
        return 1
    }
    # Immediately after creation, validate the root plus every existing ancestor again;
    # on any reparse condition retain the root (conservative) and abort before staging.
    $rootGate = Get-ReparseGateResult -Path $script:Root
    if (-not $rootGate.Ok) {
        $script:KeepRootForced = $true
        Write-Host ("PREFLIGHT-FAILED: generated root failed the reparse-point gate; root retained: " + $rootGate.Reason)
        return 1
    }
    $subdirs = @(
        "data", "cache", "config", "config\plugins", ("config\plugins\" + $StagedPluginName), "state", "tmp", "bin", "log",
        "repos", "db", "home", "home\AppData\Roaming", "home\AppData\Local",
        "project", "restore-target", "artifacts", "results", "repo"
    )
    foreach ($sub in $subdirs) {
        New-Item -ItemType Directory -Path (Join-Path $script:Root $sub) -Force | Out-Null
    }
    Write-Host ("root: " + $script:Root)

    $projectDir = Join-Path $script:Root "project"
    $targetDir = Join-Path $script:Root "restore-target"
    $artifactPath = Join-Path $script:Root "artifacts\checkpoint-artifact.bin"
    $repoStage = Join-Path $script:Root "repo"
    $resultPath = Join-Path $script:Root "results\probe-result.json"
    # No child-output files exist: the preflight stdout is captured in memory only and
    # the preflight/TUI stderr and TUI stdout are drained and discarded in memory.

    # --- child environment snapshot (applied only around each child creation) ---
    # Every mutable OpenCode root is set in the runner process immediately before each
    # child launch and restored immediately after the child is started; each child
    # inherits a private copy of the snapshot at creation. The caller's environment is
    # not left changed.
    $envMap = @{
        "XDG_DATA_HOME"         = (Join-Path $script:Root "data")
        "XDG_CACHE_HOME"        = (Join-Path $script:Root "cache")
        "XDG_CONFIG_HOME"       = (Join-Path $script:Root "config")
        "XDG_STATE_HOME"        = (Join-Path $script:Root "state")
        "OPENCODE_CONFIG_DIR"   = (Join-Path $script:Root "config")
        "OPENCODE_CLI_CONFIG_CONTENT" = $ChildCliConfigContentJson
        "HOME"                  = (Join-Path $script:Root "home")
        "USERPROFILE"           = (Join-Path $script:Root "home")
        "APPDATA"               = (Join-Path $script:Root "home\AppData\Roaming")
        "LOCALAPPDATA"          = (Join-Path $script:Root "home\AppData\Local")
        "TMP"                   = (Join-Path $script:Root "tmp")
        "TEMP"                  = (Join-Path $script:Root "tmp")
        "TMPDIR"                = (Join-Path $script:Root "tmp")
        "SP_PROBE_ROOT"         = $script:Root
        "SP_PROBE_RESULT"       = $resultPath
        "SP_PROBE_PROJECT"      = $projectDir
        "SP_PROBE_TARGET"       = $targetDir
        "SP_PROBE_ARTIFACT"     = $artifactPath
        "SP_PROBE_REPO"         = $repoStage
        "SP_PROBE_SESSION_ID"   = ("ses_" + (New-SyntheticHex64))
        "SP_PROBE_MESSAGE_ID_1" = ("msg_" + (New-SyntheticHex64))
        "SP_PROBE_MESSAGE_ID_2" = ("msg_" + (New-SyntheticHex64))
    }
    $rootFull = [System.IO.Path]::GetFullPath($script:Root)
    $driveRoot = [System.IO.Path]::GetPathRoot($rootFull)
    $envMap["HOMEDRIVE"] = $driveRoot.TrimEnd('\')
    $envMap["HOMEPATH"] = $rootFull.Substring($driveRoot.Length - 1)
    foreach ($name in $envMap.Keys) {
        if ($ProbeEnvNames -notcontains $name) {
            Write-Host ("PREFLIGHT-FAILED: environment variable is not covered by the backup set: " + $name)
            return 1
        }
    }

    # --- preflight: 'opencode debug paths' must prove all ten paths are inside root ---
    # The child environment snapshot is applied only around process creation and the
    # runner's own environment is restored immediately after the child is started
    # (Start-ProbeChildProcess); the child keeps its own copy of the snapshot. The
    # command's stdout is captured in memory only, solely to parse the ten-key path
    # map, under the bounded harness-output cap (overflow fails the gate closed); its
    # stderr is drained and discarded. Neither stream is written to disk.
    $pfLaunch = Start-ProbeChildProcess -EnvMap $envMap -FilePath $resolved -Arguments @("debug", "paths") -WorkingDirectory $projectDir -CaptureStdOut
    $pfProcess = $pfLaunch.Process
    $pfTicks = Get-ProcessCreationTicks -Process $pfProcess
    $pfTracker = New-DescendantTracker -RootProcess $pfProcess -RootCreationTicks $pfTicks
    $script:PreflightTracker = $pfTracker
    # The preflight tracker owns the identity-verified root handle; the finally below
    # closes it on every preflight path, including every error return, and cleanup
    # closes it again as an idempotent safety net.
    try {
        $pfWait = Wait-PreflightProcess -Process $pfProcess -Tracker $pfTracker -TimeoutSeconds 60
        if ($pfWait.VerifyFailed -ne "") {
            $script:KeepRootForced = $true
            Write-Host ("PREFLIGHT-FAILED: " + $pfWait.VerifyFailed + "; root retained.")
            return 3
        }
        if (-not $pfWait.Stopped) {
            # Stop only what was proven from handles observed while the parent was alive;
            # anything unprovable fails closed with the root retained.
            $pfStop = Stop-ProvenProcessTree -Tracker $pfTracker
            if (-not $pfStop.Ok) {
                $script:KeepRootForced = $true
                Write-Host ("PREFLIGHT-FAILED: 'opencode debug paths' did not exit within 60s and its process tree could not be verified stopped: " + $pfStop.Reason)
                return 3
            }
            Write-Host "PREFLIGHT-FAILED: 'opencode debug paths' did not exit within 60s."
            return 1
        }
        # The preflight parent exited (verified through its retained root handle).
        # Descendants are stopped only through handles whose identity was proven while
        # the parent was alive; a possible descendant that cannot be proven (or a
        # traversal bound reached with a remaining frontier) refuses staging and
        # force-retains the root. Nothing is killed by a bare/stale PID.
        $pfStop = Stop-ProvenProcessTree -Tracker $pfTracker
        if (-not $pfStop.Ok) {
            $script:KeepRootForced = $true
            Write-Host ("PREFLIGHT-FAILED: 'opencode debug paths' descendant state could not be verified/stopped: " + $pfStop.Reason)
            return 3
        }
        if ($pfTracker.Records.Count -gt 0) {
            Write-Host ("preflight: stopped " + [string]$pfTracker.Records.Count + " proven descendant process(es) left by 'opencode debug paths'")
        }
        if ($null -ne $pfWait.ExitCode -and [int]$pfWait.ExitCode -ne 0) {
            Write-Host ("PREFLIGHT-FAILED: 'opencode debug paths' exit code " + [string]$pfWait.ExitCode + ".")
            return 1
        }
    } finally {
        Close-DescendantTracker -Tracker $pfTracker
    }
    # The preflight stdout was captured in memory only (no file exists) by the bounded
    # harness-output guard. Poll for completion within a bounded deadline; the capture
    # thread keeps reading and discarding, so the child can never block on a full pipe
    # even after the cap (overflow) or on a read error. Every failure mode is
    # fixed-safe and fails the gate closed (no truncation into a pass).
    $preflightText = ""
    $preflightCapture = $pfLaunch.StdOutCapture
    $captureStatus = "missing"
    if ($null -ne $preflightCapture) {
        $captureDeadline = (Get-Date).AddSeconds(5)
        while (-not $preflightCapture.Completed -and (Get-Date) -lt $captureDeadline) {
            Start-Sleep -Milliseconds 50
        }
        if ($preflightCapture.Overflow) { $captureStatus = "overflow" }
        elseif (-not $preflightCapture.Completed) { $captureStatus = "incomplete" }
        elseif ($preflightCapture.Faulted) { $captureStatus = "faulted" }
        else {
            $captureStatus = "ok"
            $preflightText = $preflightCapture.GetCapturedText()
        }
    }
    if ($captureStatus -ne "ok") {
        if ($captureStatus -eq "overflow") {
            Write-Host ("PREFLIGHT-FAILED: 'opencode debug paths' output exceeded the bounded preflight capture cap (" + [string]$PreflightStdoutCaptureCapBytes + " bytes; harness-output guard).")
        } elseif ($captureStatus -eq "faulted") {
            Write-Host "PREFLIGHT-FAILED: 'opencode debug paths' stdout capture failed (bounded in-memory capture)."
        } elseif ($captureStatus -eq "incomplete") {
            Write-Host "PREFLIGHT-FAILED: 'opencode debug paths' stdout capture did not complete within its bounded wait."
        } else {
            Write-Host "PREFLIGHT-FAILED: the bounded preflight stdout capture is unavailable."
        }
        return 1
    }
    $pathMap = Parse-DebugPaths -Text $preflightText
    $missingKeys = @($ExpectedPathKeys | Where-Object { -not $pathMap.ContainsKey($_) })
    if ($missingKeys.Count -gt 0) {
        Write-Host ("PREFLIGHT-FAILED: 'opencode debug paths' output missing keys: " + ($missingKeys -join ", "))
        return 1
    }
    $statusParts = @()
    $escapedKeys = @()
    foreach ($key in $ExpectedPathKeys) {
        $value = [string]$pathMap[$key]
        $status = "outside-root"
        if (-not [string]::IsNullOrWhiteSpace($value) -and [System.IO.Path]::IsPathRooted($value)) {
            if (Test-UnderRoot -Child $value -Root $script:Root) { $status = "under-root" }
        }
        $statusParts += ($key + "=" + $status)
        if ($status -ne "under-root") { $escapedKeys += $key }
    }
    Write-Host ("preflight: " + ($statusParts -join " "))
    if ($escapedKeys.Count -gt 0) {
        Write-Host ("PREFLIGHT-FAILED: not all reported paths are inside the isolated root: " + ($escapedKeys -join ", "))
        return 1
    }

    # --- stage the repo source copy, dependency junction, and probe plugin inside the root ---
    try {
        Copy-Item -LiteralPath (Join-Path $script:RepoRoot "src") -Destination $repoStage -Recurse -Force -ErrorAction Stop
        Copy-Item -LiteralPath (Join-Path $script:RepoRoot "package.json") -Destination $repoStage -Force -ErrorAction Stop
        # tsconfig.json carries jsxImportSource=@opentui/solid, which the runtime
        # transpiler needs for the product's .tsx modules in the staged copy.
        Copy-Item -LiteralPath (Join-Path $script:RepoRoot "tsconfig.json") -Destination $repoStage -Force -ErrorAction Stop
    } catch {
        Write-Host "PREFLIGHT-FAILED: repo source staging failed."
        return 1
    }
    $junctionPath = Join-Path $repoStage "node_modules"
    if (-not (New-DirectoryJunction -LinkPath $junctionPath -TargetPath (Join-Path $script:RepoRoot "node_modules"))) {
        Write-Host "PREFLIGHT-FAILED: could not create the in-root dependency junction."
        return 1
    }
    $stagedRequired = @(
        (Join-Path $repoStage "src\tui\wiring\install.ts"),
        (Join-Path $repoStage "src\tui\ui\sessionport-commands.tsx"),
        (Join-Path $repoStage "package.json"),
        (Join-Path $repoStage "tsconfig.json"),
        (Join-Path $repoStage "node_modules\libsodium-wrappers-sumo\package.json"),
        (Join-Path $repoStage "node_modules\pako\package.json"),
        (Join-Path $repoStage "node_modules\solid-js\package.json"),
        (Join-Path $repoStage "node_modules\@opentui\solid\package.json")
    )
    foreach ($stagedPath in $stagedRequired) {
        if (-not (Test-Path -LiteralPath $stagedPath)) {
            Write-Host "PREFLIGHT-FAILED: staged repo layout is incomplete."
            return 1
        }
    }
    Write-Host "staging: repo src copy + package.json + dependency junction under root"

    $pluginDir = Join-Path $script:Root ("config\plugins\" + $StagedPluginName)
    $pluginPath = Join-Path $pluginDir "tui.ts"
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
    [System.IO.File]::WriteAllText($pluginPath, $PluginSource, (New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false))
    $stagedPlugins = @(Get-ChildItem -LiteralPath (Join-Path $script:Root "config\plugins") -Force -ErrorAction Stop)
    if ($stagedPlugins.Count -ne 1 -or $stagedPlugins[0].Name -ne $StagedPluginName -or -not (Test-Path -LiteralPath $pluginPath)) {
        Write-Host "PREFLIGHT-FAILED: plugin staging verification failed."
        return 1
    }
    Write-Host ("plugin: staged (" + $StagedPluginName + "\tui.ts)")

    # --- launch the real TUI runtime (private server; no shared service reuse) ---
    # Same snapshot rule as the preflight launch: applied only around this creation and
    # restored immediately after the child is started. No debug/log flags are passed,
    # and the child's stdout/stderr are drained and discarded in memory (no files), so
    # no raw child output is captured or persisted; the launch and process-identity
    # mechanics are unchanged.
    $tuiArgs = @("--standalone", $projectDir)
    $tuiLaunch = Start-ProbeChildProcess -EnvMap $envMap -FilePath $resolved -Arguments $tuiArgs -WorkingDirectory $projectDir
    $script:TuiProcess = $tuiLaunch.Process
    Write-Host ("tui: started pid=" + [string]$script:TuiProcess.Id)
    $tuiTicks = Get-ProcessCreationTicks -Process $script:TuiProcess
    $script:TuiTracker = New-DescendantTracker -RootProcess $script:TuiProcess -RootCreationTicks $tuiTicks

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $resultSeen = $false
    $exitedEarly = $false
    $loopCount = 0
    while ((Get-Date) -lt $deadline) {
        $loopCount++
        # Periodic never-kill snapshots prove descendants (handles + creation times)
        # while the root is still alive, so they can later be terminated through those
        # same handles. Additive only; an enumeration failure marks the tracker
        # ambiguous and cleanup will fail closed.
        if (($loopCount % 3) -eq 1 -and $script:TuiTracker.AmbiguousReason -eq "" -and -not $script:TuiTracker.BoundsExhausted) {
            $childrenMap = Get-CimProcessChildrenMap
            if ($null -eq $childrenMap) {
                $script:TuiTracker.AmbiguousReason = "process enumeration failed during the TUI wait"
            } else {
                Update-ProvenDescendants -Tracker $script:TuiTracker -ChildrenMap $childrenMap
            }
        }
        if (Test-Path -LiteralPath $resultPath) {
            try {
                $raw = [System.IO.File]::ReadAllText($resultPath)
                $script:ResultJson = $raw | ConvertFrom-Json -ErrorAction Stop
                $resultSeen = $true
                break
            } catch {
                # result file still being finalized; keep polling
            }
        }
        $alive = $true
        try { $alive = (-not $script:TuiTracker.RootHandle.IsExited()) } catch { $alive = $false }
        if (-not $alive) { $exitedEarly = $true; break }
        Start-Sleep -Seconds 1
    }

    # --- stop the process tree (handle-bound, identity-verified) before any cleanup claim ---
    $stopResult = Stop-ProvenProcessTree -Tracker $script:TuiTracker
    if (-not $stopResult.Ok) {
        $script:KeepRootForced = $true
        Write-Host ("STOP-FAILED: " + $stopResult.Reason + " (root kept for safety)")
        return 3
    }
    $script:TuiStopVerified = $true
    Write-Host "stop: verified (process tree exited; root and descendants handle-verified)"

    if (-not $resultSeen) {
        if ($exitedEarly) { Write-Host "RESULT-MISSING: TUI exited before writing the probe result." }
        else { Write-Host ("RESULT-MISSING: no probe result within " + [string]$TimeoutSeconds + "s.") }
        return 2
    }

    $result = $script:ResultJson
    $commands = Read-ResultField $result "commands"
    $checkpoint = Read-ResultField $result "checkpoint"
    $restore = Read-ResultField $result "restore"
    $verification = Read-ResultField $result "verification"
    $failure = Read-ResultField $result "failure"

    if ($null -ne $commands) {
        Write-Host ("commands: bothRegistered=" + [string](Read-ResultField $commands "bothRegistered") + " duplicates=" + [string](Read-ResultField $commands "duplicates") + " dispatch=" + [string](Read-ResultField $commands "dispatchCallable"))
    }
    if ($null -ne $checkpoint) {
        $scan = Read-ResultField $checkpoint "scan"
        Write-Host ("checkpoint: completion=" + [string](Read-ResultField $checkpoint "completionSignal") + " timedOut=" + [string](Read-ResultField $checkpoint "completionTimedOut") + " artifactBytes=" + [string](Read-ResultField $checkpoint "artifactBytes") + " plaintextMarkerAbsent=" + [string](Read-ResultField $scan "plaintextMarkerAbsent") + " passwordBytesAbsent=" + [string](Read-ResultField $scan "passwordBytesAbsent"))
    }
    if ($null -ne $restore) {
        $dialogSelect = Read-ResultField $restore "dialogSelect"
        Write-Host ("restore: completion=" + [string](Read-ResultField $restore "completionSignal") + " timedOut=" + [string](Read-ResultField $restore "completionTimedOut") + " dialogMatchedPredeclared=" + [string](Read-ResultField $dialogSelect "matchedPredeclared"))
        $importAudit = Read-ResultField $restore "importAudit"
        if ($null -ne $importAudit) {
            # Sanitized attempt/response facts only: capped counts and booleans,
            # no IDs, directories, messages, response objects, or exception text.
            Write-Host ("restore-import: calls=" + [string](Read-ResultField $importAudit "calls") + " resolved=" + [string](Read-ResultField $importAudit "resolved") + " rejected=" + [string](Read-ResultField $importAudit "rejected") + " overflow=" + [string](Read-ResultField $importAudit "overflow") + " shapeValid=" + [string](Read-ResultField $importAudit "responseShapeValid") + " idMatchesRequest=" + [string](Read-ResultField $importAudit "returnedIdMatchesRequest") + " projectMatchesTarget=" + [string](Read-ResultField $importAudit "returnedProjectIdMatchesPredeclaredTarget") + " locationMatchesTarget=" + [string](Read-ResultField $importAudit "returnedLocationMatchesPredeclaredDirectory"))
        }
    }
    if ($null -ne $verification) {
        Write-Host ("verification: targetListCount=" + [string](Read-ResultField $verification "targetListCount") + " sessionIdMatches=" + [string](Read-ResultField $verification "listedExpectedSessionIdMatches") + " projectMatches=" + [string](Read-ResultField $verification "listedProjectMatchesTarget") + " directoryMatches=" + [string](Read-ResultField $verification "getDirectoryMatchesTarget") + " messageCount=" + [string](Read-ResultField $verification "messageCount") + " userMarker=" + [string](Read-ResultField $verification "userMessageMatches") + " assistantMarker=" + [string](Read-ResultField $verification "assistantMarkerMatches"))
    }
    if ($null -ne $failure) {
        Write-Host ("failure: class=" + [string](Read-ResultField $failure "class") + " code=" + [string](Read-ResultField $failure "code"))
    }
    $compressed = $result | ConvertTo-Json -Depth 12 -Compress
    Write-Host ("PROBE-RESULT-JSON: " + $compressed)

    if ($result.ok -eq $true) {
        Write-Host "probe: completed (single synthetic /checkpoint -> /restore round trip verified)."
        return 0
    }
    if ($null -ne $failure -and [string](Read-ResultField $failure "class") -eq "isolation") {
        Write-Host "probe: finished with plugin isolation-gate failure (zero client calls)."
        return 5
    }
    Write-Host "probe: finished without a verified round trip (bounded result recorded)."
    return 6
}

# ---------------------------------------------------------------------------
# Cleanup (always runs; root removal only after verified process exit)
# ---------------------------------------------------------------------------

function Invoke-ProbeCleanup {
    param([int]$Code)
    $effective = $Code

    if ($null -ne $script:TuiTracker) {
        $stopResult = Stop-ProvenProcessTree -Tracker $script:TuiTracker
        if (-not $stopResult.Ok) {
            $script:KeepRootForced = $true
            Write-Host ("STOP-FAILED: " + $stopResult.Reason + "; root kept for safety.")
            $effective = 3
        }
    } elseif ($null -ne $script:TuiProcess) {
        # A TUI process object without its tracker cannot be stopped safely; fail
        # closed rather than attempt any unverified termination.
        $script:KeepRootForced = $true
        Write-Host "STOP-FAILED: the tracked TUI process tree is unavailable; root kept for safety."
        $effective = 3
    }
    Close-DescendantTracker -Tracker $script:TuiTracker
    # Safety net only: the preflight tracker is closed on every preflight path; this
    # idempotent close covers any path that did not reach that close.
    Close-DescendantTracker -Tracker $script:PreflightTracker

    # Safety net only: per-launch restores already ran immediately after each
    # child launch; this is a no-op in the normal path.
    Restore-ProcessEnv
    try { Set-Location -LiteralPath $script:OriginalLocation -ErrorAction Stop } catch { }

    if ([string]::IsNullOrWhiteSpace($script:Root)) {
        return $effective
    }
    if ($script:KeepRootRequested -or $script:KeepRootForced) {
        Write-Host ("ROOT-KEPT: " + $script:Root + " (remove manually after inspection)")
        return $effective
    }
    $removal = Remove-ProbeRoot
    if ($removal.Removed) {
        Write-Host "cleanup: root removed"
        return $effective
    }
    Write-Host ("CLEANUP-FAILED: root retained for safety; reason: " + $removal.Reason + " - " + $script:Root)
    return 3
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

$finalCode = 4
try {
    if (-not $RunProbe) {
        $finalCode = Invoke-ValidationOnly
    } else {
        $finalCode = Invoke-ProbeMain
    }
} catch {
    # Fixed-safe reporting only: a bounded category/type token, never the exception
    # message or a stack trace, so no raw error text is printed or persisted.
    $errorCategory = "unexpected-runner-error"
    try {
        $errorTypeName = [string]$_.Exception.GetType().Name
        if ($errorTypeName -match '^[A-Za-z][A-Za-z0-9_.]{0,127}$') { $errorCategory = $errorTypeName }
    } catch { }
    Write-Host ("PROBE-ERROR: " + $errorCategory)
    $finalCode = 4
} finally {
    $finalCode = Invoke-ProbeCleanup -Code $finalCode
}
exit $finalCode
