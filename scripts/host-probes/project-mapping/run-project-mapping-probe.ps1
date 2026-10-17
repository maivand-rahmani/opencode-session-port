#Requires -Version 5.1
<#
.SYNOPSIS
    SessionPort OQ-16 project-mapping probe runner (Windows only, disposable isolated root).

.DESCRIPTION
    Bounded, synthetic probe of the installed OpenCode TUI plugin client surface for
    OQ-16 runtime mapping/scoping questions, using only public context.client APIs
    (pinned @opencode/plugin@2.0.22 interface shape).

    The runner:
      1. Creates a unique disposable root under the approved temp base and redirects
         every mutable OpenCode root (XDG_*, OPENCODE_CONFIG_DIR, HOME/USERPROFILE,
         HOMEDRIVE/HOMEPATH, APPDATA/LOCALAPPDATA, TMP/TEMP/TMPDIR) for its child
         processes only; the caller's environment is restored on exit.
      2. Runs 'opencode debug paths' FIRST and aborts before any plugin/TUI/API call
         unless all ten reported paths (home,data,cache,config,state,tmp,bin,log,
         repos,db) resolve inside the unique root.
      3. Stages only the embedded probe plugin under the disposable
         OPENCODE_CONFIG_DIR plugins folder and launches the real TUI runtime with
         --standalone (private server; no shared background service reuse).
      4. The plugin re-verifies isolation (os.homedir(), os.tmpdir(), cwd, configured
         env roots, result path) before ANY context.client call; if a check fails it
         records a bounded error and performs zero API calls.
      5. Probe sequence: capability detection without throwing on absence,
         project.list() before/after, location.get({location:{directory}}) with an
         explicit target under root, omitted-input location.get() against the
         isolated server cwd only, and (with -WithImport) exactly one synthetic
         session.import followed by a session.get readback comparison.
      6. Stops the process tree, verifies child/server exit, and removes the unique
         root in cleanup. Raw logs and the synthetic result metadata stay under the
         root only; stdout carries only the bounded sanitized summary.

    Evidence boundaries: one Windows host and one installed OpenCode version per run;
    no cross-version/platform/restart claims; synthetic runner-generated IDs do not
    validate SessionPort's BLAKE2b derivation; no direct database access, user data,
    model/prompt/tool/replay calls, Git, or network use beyond the local OpenCode
    plugin client APIs. CLI flags used are only those recorded for this host in E32/E33
    ('--standalone --print-logs --log-level debug <project>'); no auto-update or model
    flags are guessed or added.

.PARAMETER WithImport
    Opt-in: perform exactly one synthetic public session.import to the same explicit
    target, then one session.get readback. Default run omits import.

.PARAMETER KeepRoot
    Diagnostic only: skip deletion of the disposable root (prints the path for
    inspection; the caller must remove it manually).

.PARAMETER TimeoutSeconds
    Seconds to wait for the plugin result file before stopping the process tree
    (default 180).

.PARAMETER OpenCodePath
    Optional explicit path to the installed opencode executable; resolved from PATH
    when omitted.

.NOTES
    Exit codes:
      0  probe result produced, plugin isolation gate passed, stop/cleanup verified
      1  preflight failure ('opencode debug paths' missing/escaped root, staging or
         resolution failure) - no TUI/API calls were made
      2  TUI launched but no probe result (timeout or early exit)
      3  stop/cleanup verification failed (root kept; do not treat as clean)
      4  unexpected runner error
      5  plugin result produced but the plugin isolation gate failed (zero client calls)
#>
[CmdletBinding()]
param(
    [switch]$WithImport,
    [switch]$KeepRoot,
    [ValidateRange(30, 900)]
    [int]$TimeoutSeconds = 180,
    [string]$OpenCodePath = ""
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = "Stop"

$ProbeName = "sessionport-oq16-project-mapping"
$ApprovedTempBase = "C:\Users\PC\AppData\Local\Temp\opencode"
$ExpectedPathKeys = @("home", "data", "cache", "config", "state", "tmp", "bin", "log", "repos", "db")
$ProbeEnvNames = @(
    "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
    "OPENCODE_CONFIG_DIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR",
    "SP_PROBE_ROOT", "SP_PROBE_RESULT", "SP_PROBE_PROJECT", "SP_PROBE_TARGET",
    "SP_PROBE_SOURCE", "SP_PROBE_MODE", "SP_PROBE_SESSION_ID",
    "SP_PROBE_MESSAGE_ID_1", "SP_PROBE_MESSAGE_ID_2"
)

$script:ExitCode = 4
$script:Root = ""
$script:RootDeleted = $false
$script:KeepRootRequested = [bool]$KeepRoot
$script:KeepRootForced = $false
$script:TuiProcess = $null
$script:TuiStopVerified = $false
$script:PreflightPassed = $false
$script:ResultJson = $null
$script:EnvBackup = @{}
$script:EnvBackupTaken = $false
$script:OriginalLocation = (Get-Location).Path

# ---------------------------------------------------------------------------
# Helpers
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

function Get-DescendantProcessIds {
    param([int]$RootPid)
    $all = New-Object System.Collections.Generic.List[int]
    $frontier = New-Object System.Collections.Generic.List[int]
    $frontier.Add($RootPid)
    $depth = 0
    while ($frontier.Count -gt 0 -and $depth -lt 8) {
        $depth++
        $next = New-Object System.Collections.Generic.List[int]
        foreach ($parentPid in $frontier) {
            try {
                $children = Get-CimInstance -ClassName Win32_Process -Filter ("ParentProcessId=" + $parentPid) -ErrorAction SilentlyContinue
                foreach ($child in $children) {
                    $childPid = [int]$child.ProcessId
                    if (-not $all.Contains($childPid)) {
                        $all.Add($childPid)
                        $next.Add($childPid)
                    }
                }
            } catch { }
        }
        $frontier = $next
    }
    return $all
}

function Stop-ProcessTree {
    param([int]$RootPid)
    $descendants = @(Get-DescendantProcessIds -RootPid $RootPid)
    try { & taskkill.exe /PID $RootPid /T /F 2>$null | Out-Null } catch { }
    Start-Sleep -Milliseconds 700

    $tracked = @($RootPid) + @($descendants)
    $survivors = New-Object System.Collections.Generic.List[int]
    foreach ($procId in $tracked) {
        if ($null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { $survivors.Add([int]$procId) }
    }
    if ($survivors.Count -eq 0) { return @() }

    foreach ($procId in $survivors) {
        try { & taskkill.exe /PID $procId /F 2>$null | Out-Null } catch { }
    }
    Start-Sleep -Milliseconds 700

    $remaining = New-Object System.Collections.Generic.List[int]
    foreach ($procId in $tracked) {
        if ($null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { $remaining.Add([int]$procId) }
    }
    $late = @(Get-DescendantProcessIds -RootPid $RootPid)
    foreach ($procId in $late) {
        if ($null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue) -and -not $remaining.Contains($procId)) {
            $remaining.Add([int]$procId)
        }
    }
    return @($remaining)
}

function Start-ProbeProcess {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [string]$StdOut,
        [string]$StdErr
    )
    $quotedArgs = @()
    foreach ($argument in $Arguments) {
        if ($argument -match '[\s"]') { $quotedArgs += ('"' + $argument + '"') } else { $quotedArgs += $argument }
    }
    $extension = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
    if ($extension -eq ".cmd" -or $extension -eq ".bat") {
        $inner = '"' + $FilePath + '"'
        if ($quotedArgs.Count -gt 0) { $inner = $inner + " " + ($quotedArgs -join " ") }
        return Start-Process -FilePath (Join-Path $env:SystemRoot "System32\cmd.exe") -ArgumentList @("/d", "/s", "/c", $inner) -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr
    }
    if ($extension -eq ".ps1") {
        return Start-Process -FilePath "powershell.exe" -ArgumentList (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $FilePath) + $quotedArgs) -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr
    }
    return Start-Process -FilePath $FilePath -ArgumentList $quotedArgs -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr
}

function Wait-ProbeProcess {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $stopped = $false
    while ((Get-Date) -lt $deadline) {
        try { $Process.Refresh() } catch { }
        if ($Process.HasExited) { $stopped = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $stopped) {
        Stop-ProcessTree -RootPid $Process.Id | Out-Null
        try { $Process.Refresh() } catch { }
        if ($Process.HasExited) { $stopped = $true }
    }
    $exitCode = $null
    if ($stopped) {
        try { $exitCode = $Process.ExitCode } catch { $exitCode = $null }
    }
    return [pscustomobject]@{ Stopped = $stopped; ExitCode = $exitCode }
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

function Remove-ProbeRoot {
    $rootFull = [System.IO.Path]::GetFullPath($script:Root)
    $baseFull = [System.IO.Path]::GetFullPath($ApprovedTempBase).TrimEnd('\')
    if (-not $rootFull.StartsWith($baseFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ([System.IO.Path]::GetFileName($rootFull) -notlike 'sp-projmapping-*') { return $false }
    if ($rootFull.TrimEnd('\') -eq $baseFull) { return $false }
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            Remove-Item -LiteralPath $rootFull -Recurse -Force -ErrorAction Stop
        } catch {
            Start-Sleep -Milliseconds 500
        }
        if (-not (Test-Path -LiteralPath $rootFull)) { return $true }
    }
    return (-not (Test-Path -LiteralPath $rootFull))
}

# ---------------------------------------------------------------------------
# Main probe flow
# ---------------------------------------------------------------------------

function Invoke-ProbeMain {
    if ($env:OS -ne "Windows_NT") {
        Write-Host "PREFLIGHT-FAILED: this probe runner is Windows-only."
        return 1
    }

    if (-not (Test-Path -LiteralPath $ApprovedTempBase)) {
        New-Item -ItemType Directory -Path $ApprovedTempBase -Force | Out-Null
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
    Write-Host ("mode: " + $(if ($WithImport) { "import (single synthetic session.import)" } else { "baseline (no import)" }))

    # --- unique disposable root ---
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $suffix = ([guid]::NewGuid().ToString("N")).Substring(0, 8)
    $script:Root = Join-Path $ApprovedTempBase ("sp-projmapping-" + $stamp + "-" + $suffix)
    if (Test-Path -LiteralPath $script:Root) {
        Write-Host "PREFLIGHT-FAILED: generated root already exists."
        return 1
    }
    $subdirs = @(
        "data", "cache", "config", "config\plugins", "state", "tmp", "bin", "log",
        "repos", "db", "home", "home\AppData\Roaming", "home\AppData\Local",
        "project", "import-target", "results"
    )
    foreach ($sub in $subdirs) {
        New-Item -ItemType Directory -Path (Join-Path $script:Root $sub) -Force | Out-Null
    }
    Write-Host ("root: " + $script:Root)

    $projectDir = Join-Path $script:Root "project"
    $targetDir = Join-Path $script:Root "import-target"
    $sourceDir = $projectDir
    $resultPath = Join-Path $script:Root "results\probe-result.json"
    $preflightOut = Join-Path $script:Root "log\preflight.stdout.txt"
    $preflightErr = Join-Path $script:Root "log\preflight.stderr.txt"
    $tuiOut = Join-Path $script:Root "log\tui.stdout.txt"
    $tuiErr = Join-Path $script:Root "log\tui.stderr.txt"

    # --- redirect every mutable root for this process; children inherit ---
    Backup-ProcessEnv
    $envMap = @{
        "XDG_DATA_HOME"         = (Join-Path $script:Root "data")
        "XDG_CACHE_HOME"        = (Join-Path $script:Root "cache")
        "XDG_CONFIG_HOME"       = (Join-Path $script:Root "config")
        "XDG_STATE_HOME"        = (Join-Path $script:Root "state")
        "OPENCODE_CONFIG_DIR"   = (Join-Path $script:Root "config")
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
        "SP_PROBE_SOURCE"       = $sourceDir
        "SP_PROBE_MODE"         = $(if ($WithImport) { "import" } else { "baseline" })
        "SP_PROBE_SESSION_ID"   = ("ses_" + (New-SyntheticHex64))
        "SP_PROBE_MESSAGE_ID_1" = ("msg_" + (New-SyntheticHex64))
        "SP_PROBE_MESSAGE_ID_2" = ("msg_" + (New-SyntheticHex64))
    }
    $rootFull = [System.IO.Path]::GetFullPath($script:Root)
    $driveRoot = [System.IO.Path]::GetPathRoot($rootFull)
    $envMap["HOMEDRIVE"] = $driveRoot.TrimEnd('\')
    $envMap["HOMEPATH"] = $rootFull.Substring($driveRoot.Length - 1)
    foreach ($name in $envMap.Keys) {
        Set-ProcessEnv -Name $name -Value ([string]$envMap[$name])
    }

    # --- preflight: 'opencode debug paths' must prove all ten paths are inside root ---
    $pfProcess = Start-ProbeProcess -FilePath $resolved -Arguments @("debug", "paths") -WorkingDirectory $projectDir -StdOut $preflightOut -StdErr $preflightErr
    $pfWait = Wait-ProbeProcess -Process $pfProcess -TimeoutSeconds 60
    if (-not $pfWait.Stopped) {
        Write-Host "PREFLIGHT-FAILED: 'opencode debug paths' did not exit within 60s."
        return 1
    }
    if ($null -ne $pfWait.ExitCode -and [int]$pfWait.ExitCode -ne 0) {
        Write-Host ("PREFLIGHT-FAILED: 'opencode debug paths' exit code " + [string]$pfWait.ExitCode + ".")
        return 1
    }
    $preflightText = ""
    if (Test-Path -LiteralPath $preflightOut) {
        $preflightText = [System.IO.File]::ReadAllText($preflightOut)
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
    $script:PreflightPassed = $true

    # --- stage only the probe plugin under the disposable config root ---
    $pluginDir = Join-Path $script:Root "config\plugins\project-mapping-probe"
    $pluginPath = Join-Path $pluginDir "tui.ts"
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
    $pluginSource = @'
// SessionPort OQ-16 project-mapping probe plugin (synthetic, isolated, public API only).
// Built against the pinned @opencode/plugin@2.0.22 TUI context declarations.
// Staged by run-project-mapping-probe.ps1 into the disposable OPENCODE_CONFIG_DIR
// plugins folder. Imports only Node built-ins. No product code, no user data,
// no model/prompt/tool/replay calls, no direct database access.

import { renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const PLUGIN_ID = "project-mapping-probe"
const PROBE_NAME = "sessionport-oq16-project-mapping"

let started = false

function norm(value) {
  return path.resolve(value)
}

function isUnder(child, parent) {
  const rel = path.relative(norm(parent), norm(child))
  if (rel === "") return true
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

function sanitizePath(value, root) {
  if (typeof value !== "string" || value.length === 0) return "<empty>"
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

function readEnv(env, name) {
  return typeof env[name] === "string" ? env[name] : ""
}

async function run(ctx, env) {
  const root = readEnv(env, "SP_PROBE_ROOT")
  const resultPath = readEnv(env, "SP_PROBE_RESULT")
  const projectDir = readEnv(env, "SP_PROBE_PROJECT")
  const targetDir = readEnv(env, "SP_PROBE_TARGET")
  const sourceDir = readEnv(env, "SP_PROBE_SOURCE")
  const mode = readEnv(env, "SP_PROBE_MODE") === "import" ? "import" : "baseline"

  const result = {
    probe: PROBE_NAME,
    pluginID: PLUGIN_ID,
    stage: "isolation-gate",
    ok: false,
    mode: mode,
    runtime: {
      bun: typeof Bun !== "undefined" ? Bun.version : null,
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    isolation: {
      rootPresent: root.length > 0,
      checks: {},
      violations: []
    },
    capabilities: {},
    projects: {
      listCallable: false,
      beforeCount: null,
      afterExplicitCount: null,
      afterOmittedCount: null,
      addedAfterExplicit: [],
      explicitProjectIdPresent: null
    },
    location: {
      explicit: null,
      omitted: null,
      persistenceObserved: null,
      persistenceNote: "location.get resolves/upserts project state in the isolated data store (observed via the project.list before/after diff); no live/user data store was touched."
    },
    import: {
      requested: mode === "import",
      attempted: false,
      ok: null,
      skipped: null
    },
    limits: [
      "one Windows host and one installed OpenCode version per run; no cross-version/platform/restart claims",
      "synthetic runner-generated IDs only; does not validate SessionPort BLAKE2b derivation or collision behavior",
      "no project-ID algorithm, hash, or stability inference",
      "no product behavior or compatibility claim"
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

  if (!result.isolation.rootPresent) {
    violations.push("SP_PROBE_ROOT:missing")
  } else {
    check("homedir", homedir, true)
    check("tmpdir", tmpdir, true)
    check("cwd", cwd, true)
    check("projectDir", projectDir, true)
    check("targetDir", targetDir, true)
    check("sourceDir", sourceDir, true)
    check("resultPath", resultPath, true)
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

  if (violations.length > 0) {
    // Bounded failure: zero context.client calls. Write only when the result
    // path itself resolved under the verified root.
    if (result.isolation.rootPresent && checks["resultPath"] === "under-root") {
      writeResult(resultPath, result)
    }
    return
  }

  result.stage = "client-capability"
  const client = ctx && typeof ctx === "object" ? ctx.client : undefined
  const locationApi = client ? client.location : undefined
  const projectApi = client ? client.project : undefined
  const sessionApi = client ? client.session : undefined

  const caps = {
    clientPresent: Boolean(client),
    locationGet: Boolean(locationApi && typeof locationApi.get === "function"),
    projectList: Boolean(projectApi && typeof projectApi.list === "function"),
    sessionImport: Boolean(sessionApi && typeof sessionApi.import === "function"),
    sessionGet: Boolean(sessionApi && typeof sessionApi.get === "function")
  }
  result.capabilities = caps

  async function listProjects() {
    if (!caps.projectList) return null
    try {
      const list = await projectApi.list()
      const entries = Array.isArray(list) ? list : []
      return {
        ok: true,
        count: entries.length,
        entries: entries.slice(0, 8).map(function (project) {
          return {
            id: project && typeof project.id === "string" ? project.id : null,
            canonical: sanitizePath(project ? project.canonical : "", root),
            name: project && typeof project.name === "string" ? project.name : null
          }
        })
      }
    } catch (error) {
      return { ok: false, count: null, entries: [], error: errorInfo(error) }
    }
  }

  result.stage = "location-probe"
  const before = await listProjects()
  result.projects.listCallable = caps.projectList
  if (before && before.ok) result.projects.beforeCount = before.count

  let explicitProject = null

  if (caps.locationGet) {
    try {
      const explicit = await locationApi.get({ location: { directory: targetDir } })
      explicitProject = explicit && explicit.project ? explicit.project : null
      const explicitDirectory = explicit ? explicit.directory : ""
      result.location.explicit = {
        ok: true,
        directory: sanitizePath(explicitDirectory, root),
        directoryMatchesTarget: typeof explicitDirectory === "string" && norm(explicitDirectory) === norm(targetDir),
        project: explicitProject ? {
          id: typeof explicitProject.id === "string" ? explicitProject.id : null,
          directory: sanitizePath(explicitProject.directory, root),
          canonical: sanitizePath(explicitProject.canonical, root),
          directoryMatchesTarget: typeof explicitProject.directory === "string" && norm(explicitProject.directory) === norm(targetDir),
          canonicalMatchesTarget: typeof explicitProject.canonical === "string" && norm(explicitProject.canonical) === norm(targetDir)
        } : null
      }
    } catch (error) {
      result.location.explicit = { ok: false, error: errorInfo(error) }
    }
  } else {
    result.location.explicit = { ok: false, skipped: "location.get-not-callable" }
  }

  const afterExplicit = await listProjects()
  if (afterExplicit && afterExplicit.ok) {
    result.projects.afterExplicitCount = afterExplicit.count
    if (before && before.ok) {
      const beforeIds = {}
      before.entries.forEach(function (entry) { if (entry.id) beforeIds[entry.id] = true })
      result.projects.addedAfterExplicit = afterExplicit.entries
        .filter(function (entry) { return entry.id && !beforeIds[entry.id] })
        .map(function (entry) { return entry.id })
    }
    if (explicitProject && typeof explicitProject.id === "string") {
      result.projects.explicitProjectIdPresent = afterExplicit.entries.some(function (entry) { return entry.id === explicitProject.id })
    }
  }

  // Omitted-input behavior: only against the known isolated server cwd.
  if (caps.locationGet) {
    try {
      const omitted = await locationApi.get()
      const omittedDirectory = omitted ? omitted.directory : ""
      result.location.omitted = {
        ok: true,
        directory: sanitizePath(omittedDirectory, root),
        projectID: omitted && omitted.project && typeof omitted.project.id === "string" ? omitted.project.id : null,
        matchesServerCwd: typeof omittedDirectory === "string" && norm(omittedDirectory) === norm(cwd),
        matchesProjectDir: typeof omittedDirectory === "string" && norm(omittedDirectory) === norm(projectDir)
      }
    } catch (error) {
      result.location.omitted = { ok: false, error: errorInfo(error) }
    }
  } else {
    result.location.omitted = { ok: false, skipped: "location.get-not-callable" }
  }

  const afterOmitted = await listProjects()
  if (afterOmitted && afterOmitted.ok) result.projects.afterOmittedCount = afterOmitted.count

  result.location.persistenceObserved =
    result.projects.beforeCount !== null &&
    result.projects.afterExplicitCount !== null &&
    result.projects.afterExplicitCount > result.projects.beforeCount
  result.location.persistenceEvidence = {
    beforeCount: result.projects.beforeCount,
    afterExplicitCount: result.projects.afterExplicitCount,
    afterOmittedCount: result.projects.afterOmittedCount,
    addedAfterExplicit: result.projects.addedAfterExplicit
  }

  result.stage = "import-probe"
  if (mode === "import") {
    if (!caps.sessionImport) {
      result.import.skipped = "session.import-not-callable"
    } else if (!caps.locationGet || !explicitProject || typeof explicitProject.id !== "string") {
      result.import.skipped = "explicit-location-resolution-unavailable"
    } else if (readEnv(env, "SP_PROBE_SESSION_ID").length === 0 || readEnv(env, "SP_PROBE_MESSAGE_ID_1").length === 0 || readEnv(env, "SP_PROBE_MESSAGE_ID_2").length === 0) {
      result.import.skipped = "synthetic-ids-missing"
    } else {
      result.import.attempted = true
      const sessionID = readEnv(env, "SP_PROBE_SESSION_ID")
      const messageID1 = readEnv(env, "SP_PROBE_MESSAGE_ID_1")
      const messageID2 = readEnv(env, "SP_PROBE_MESSAGE_ID_2")
      const now = Date.now()
      const payload = {
        info: {
          id: sessionID,
          projectID: "probe-oq16-source-project",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now - 2000, updated: now - 1000, idle: now - 1000 },
          title: "synthetic OQ-16 project-mapping probe session",
          location: { directory: sourceDir }
        },
        messages: [
          {
            id: messageID1,
            time: { created: now - 2000 },
            type: "user",
            text: "synthetic OQ-16 project-mapping probe message"
          },
          {
            id: messageID2,
            time: { created: now - 1500, completed: now - 1000 },
            type: "assistant",
            agent: "probe",
            model: { id: "probe-model", providerID: "probe-provider" },
            content: [{ type: "text", text: "synthetic OQ-16 project-mapping probe reply" }]
          }
        ],
        location: { directory: targetDir }
      }
      result.import.sessionID = sessionID
      try {
        // Exactly one public session.import; no retry.
        const imported = await sessionApi.import(payload)
        const responseDirectory = imported && imported.location ? imported.location.directory : ""
        result.import.ok = true
        result.import.response = {
          sessionID: imported && typeof imported.id === "string" ? imported.id : null,
          idMatchesRequested: Boolean(imported && imported.id === sessionID),
          projectID: imported && typeof imported.projectID === "string" ? imported.projectID : null,
          locationDirectory: sanitizePath(responseDirectory, root),
          directoryEqualsExplicitTarget: typeof responseDirectory === "string" && norm(responseDirectory) === norm(targetDir)
        }
        if (caps.sessionGet) {
          try {
            const readback = await sessionApi.get({ sessionID: sessionID })
            const readbackDirectory = readback && readback.location ? readback.location.directory : ""
            result.import.readback = {
              ok: true,
              sessionID: readback && typeof readback.id === "string" ? readback.id : null,
              idMatchesRequested: Boolean(readback && readback.id === sessionID),
              projectID: readback && typeof readback.projectID === "string" ? readback.projectID : null,
              locationDirectory: sanitizePath(readbackDirectory, root),
              projectIDEqualsLocationGetProject: Boolean(readback && explicitProject && readback.projectID === explicitProject.id),
              projectIDEqualsImportResponse: Boolean(readback && imported && readback.projectID === imported.projectID),
              directoryEqualsExplicitTarget: typeof readbackDirectory === "string" && norm(readbackDirectory) === norm(targetDir)
            }
          } catch (error) {
            result.import.readback = { ok: false, error: errorInfo(error) }
          }
        } else {
          result.import.readback = { ok: false, skipped: "session.get-not-callable" }
        }
      } catch (error) {
        result.import.ok = false
        result.import.error = errorInfo(error)
      }
    }
  }

  result.stage = "complete"
  result.ok = true
  writeResult(resultPath, result)
}

export default {
  id: PLUGIN_ID,
  async setup(context) {
    if (started) return
    started = true
    try {
      await run(context, process.env)
    } catch (error) {
      const resultPath = readEnv(process.env, "SP_PROBE_RESULT")
      const root = readEnv(process.env, "SP_PROBE_ROOT")
      if (resultPath.length > 0 && root.length > 0 && isUnder(resultPath, root)) {
        try {
          writeResult(resultPath, {
            probe: PROBE_NAME,
            pluginID: PLUGIN_ID,
            stage: "plugin-error",
            ok: false,
            error: errorInfo(error)
          })
        } catch (innerError) {
          // bounded failure: nothing further can be recorded safely
        }
      }
    }
  }
}
'@
    [System.IO.File]::WriteAllText($pluginPath, $pluginSource, (New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false))
    $staged = @(Get-ChildItem -LiteralPath (Join-Path $script:Root "config\plugins") -Force -ErrorAction Stop)
    if ($staged.Count -ne 1 -or $staged[0].Name -ne "project-mapping-probe" -or -not (Test-Path -LiteralPath $pluginPath)) {
        Write-Host "PREFLIGHT-FAILED: plugin staging verification failed."
        return 1
    }
    Write-Host "plugin: staged (project-mapping-probe\tui.ts)"

    # --- launch the real TUI runtime (private server; no shared service reuse) ---
    $tuiArgs = @("--standalone", "--print-logs", "--log-level", "debug", $projectDir)
    $script:TuiProcess = Start-ProbeProcess -FilePath $resolved -Arguments $tuiArgs -WorkingDirectory $projectDir -StdOut $tuiOut -StdErr $tuiErr
    Write-Host ("tui: started pid=" + [string]$script:TuiProcess.Id)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $resultSeen = $false
    $exitedEarly = $false
    while ((Get-Date) -lt $deadline) {
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
        $alive = $null -ne (Get-Process -Id $script:TuiProcess.Id -ErrorAction SilentlyContinue)
        if (-not $alive) { $exitedEarly = $true; break }
        Start-Sleep -Seconds 1
    }

    # --- stop the process tree and verify exit before any cleanup claim ---
    $survivors = @(Stop-ProcessTree -RootPid $script:TuiProcess.Id)
    if ($survivors.Count -gt 0) {
        Write-Host ("STOP-FAILED: " + [string]$survivors.Count + " process(es) still alive after stop attempts.")
        return 3
    }
    $script:TuiStopVerified = $true
    Write-Host "stop: verified (process tree exited)"

    if (-not $resultSeen) {
        if ($exitedEarly) { Write-Host "RESULT-MISSING: TUI exited before writing the probe result." }
        else { Write-Host ("RESULT-MISSING: no probe result within " + [string]$TimeoutSeconds + "s.") }
        return 2
    }

    $result = $script:ResultJson
    if ($null -ne $result.PSObject.Properties["capabilities"]) {
        $caps = $result.capabilities
        Write-Host ("capabilities: location.get=" + [string]$caps.locationGet + " project.list=" + [string]$caps.projectList + " session.import=" + [string]$caps.sessionImport + " session.get=" + [string]$caps.sessionGet)
    }
    if ($null -ne $result.PSObject.Properties["location"]) {
        $loc = $result.location
        if ($null -ne $loc -and $null -ne $loc.PSObject.Properties["explicit"] -and $null -ne $loc.explicit) {
            Write-Host ("location.explicit: ok=" + [string]$loc.explicit.ok + " directoryMatchesTarget=" + [string]$loc.explicit.directoryMatchesTarget)
        }
        if ($null -ne $loc -and $null -ne $loc.PSObject.Properties["omitted"] -and $null -ne $loc.omitted) {
            Write-Host ("location.omitted: ok=" + [string]$loc.omitted.ok + " matchesServerCwd=" + [string]$loc.omitted.matchesServerCwd)
        }
        if ($null -ne $loc) {
            Write-Host ("location.persistenceObserved: " + [string]$loc.persistenceObserved)
        }
    }
    if ($null -ne $result.PSObject.Properties["import"]) {
        $imp = $result.import
        if ($null -ne $imp) {
            Write-Host ("import: requested=" + [string]$imp.requested + " attempted=" + [string]$imp.attempted + " ok=" + [string]$imp.ok + " skipped=" + [string]$imp.skipped)
            if ($null -ne $imp.PSObject.Properties["readback"] -and $null -ne $imp.readback) {
                $rb = $imp.readback
                Write-Host ("import.readback: ok=" + [string]$rb.ok + " projectIDEqualsLocationGetProject=" + [string]$rb.projectIDEqualsLocationGetProject + " directoryEqualsExplicitTarget=" + [string]$rb.directoryEqualsExplicitTarget)
            }
        }
    }
    $compressed = $result | ConvertTo-Json -Depth 12 -Compress
    Write-Host ("PROBE-RESULT-JSON: " + $compressed)

    if ($result.ok -ne $true) {
        Write-Host "probe: finished with plugin isolation-gate failure (zero client calls)."
        return 5
    }
    Write-Host "probe: completed."
    return 0
}

# ---------------------------------------------------------------------------
# Cleanup (always runs; root removal only after verified process exit)
# ---------------------------------------------------------------------------

function Invoke-ProbeCleanup {
    param([int]$Code)
    $effective = $Code

    if ($null -ne $script:TuiProcess) {
        $survivors = @(Stop-ProcessTree -RootPid $script:TuiProcess.Id)
        if ($survivors.Count -gt 0) {
            $script:KeepRootForced = $true
            Write-Host ("STOP-FAILED: " + [string]$survivors.Count + " process(es) still alive; root kept for safety.")
            $effective = 3
        }
    }

    Restore-ProcessEnv
    try { Set-Location -LiteralPath $script:OriginalLocation -ErrorAction Stop } catch { }

    if ([string]::IsNullOrWhiteSpace($script:Root)) {
        return $effective
    }
    if ($script:KeepRootRequested -or $script:KeepRootForced) {
        Write-Host ("ROOT-KEPT: " + $script:Root + " (remove manually after inspection)")
        return $effective
    }
    if (Remove-ProbeRoot) {
        Write-Host "cleanup: root removed"
        return $effective
    }
    Write-Host ("CLEANUP-FAILED: could not fully remove " + $script:Root)
    return 3
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

$finalCode = 4
try {
    $finalCode = Invoke-ProbeMain
} catch {
    Write-Host ("PROBE-ERROR: " + $_.Exception.GetType().Name + " - " + $_.Exception.Message)
    $finalCode = 4
} finally {
    $finalCode = Invoke-ProbeCleanup -Code $finalCode
}
exit $finalCode
