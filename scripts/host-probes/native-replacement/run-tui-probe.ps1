#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$RunProbe,
    [switch]$ArchiveProbe,
    [ValidateRange(30, 180)]
    [int]$TimeoutSeconds = 180,
    [ValidateRange(60, 90)]
    [int]$InspectSeconds = 90,
    [string]$OpenCodePath = "C:\Users\PC\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe"
)

# Thin fixed-mode wrapper for the native-replacement TUI probe lane.
# It never launches anything unless -RunProbe is passed explicitly, and it exposes no
# plugin path, artifact glob, version wildcard, or combined-restart option. The underlying
# runner owns the disposable root, Job Object stop/verify, and isolated environment.

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ($ArchiveProbe -and $InspectSeconds -lt 90) { throw "archive-window-requires-90" }

$RunnerPath = Join-Path $PSScriptRoot "..\sync-anchor\run-sync-anchor-probe.ps1"

$arguments = @(
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $RunnerPath,
    "-ProbeMode", "NativeReplacement",
    "-ExpectedVersion", "2.1.1",
    "-TimeoutSeconds", [string]$TimeoutSeconds,
    "-InspectSeconds", [string]$InspectSeconds,
    "-OpenCodePath", $OpenCodePath
)
if ($RunProbe) { $arguments += "-RunProbe" }
if ($ArchiveProbe) { $arguments += "-ArchiveProbe" }

$hostExecutable = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path -LiteralPath $hostExecutable -PathType Leaf)) { $hostExecutable = "powershell.exe" }
& $hostExecutable @arguments
exit $LASTEXITCODE
