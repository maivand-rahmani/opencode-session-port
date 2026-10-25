#Requires -Version 5.1
[CmdletBinding()]
param()

# Focused, host-free checks for the sync-anchor runner. This file never passes
# -RunProbe to the runner, never starts OpenCode, and only compiles the helper
# source in a short-lived Windows PowerShell 5.1 child process.

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$RunnerPath = Join-Path $PSScriptRoot "run-sync-anchor-probe.ps1"
$WrapperPath = Join-Path (Split-Path -Parent $PSScriptRoot) "native-replacement\run-tui-probe.ps1"
$NativeProbeName = "sessionport-native-replacement-tui"
$NativeArchiveProbeName = "sessionport-native-replacement-tui-archive"
$ApprovedTempBase = "C:\Users\PC\AppData\Local\Temp\opencode"
$ExpectedPathKeys = @("home", "data", "cache", "config", "state", "tmp", "bin", "log", "repos", "db")
$ProbeName = "sessionport-sync-anchor-public-route-cache"
$script:PassCount = 0
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:CleanupDirectories = New-Object System.Collections.Generic.List[string]
$script:CleanupOk = $true

function Assert-Check {
    param([bool]$Condition, [string]$Name, [string]$Detail = "")
    if ($Condition) {
        $script:PassCount++
        Write-Host ("PASS: " + $Name)
    } else {
        $suffix = if ([string]::IsNullOrWhiteSpace($Detail)) { "" } else { " [" + $Detail + "]" }
        $script:Failures.Add($Name + $suffix)
        Write-Host ("FAIL: " + $Name + $suffix)
    }
}

function Get-RunnerAst {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($RunnerPath, [ref]$tokens, [ref]$errors)
    return [pscustomobject]@{ Ast = $ast; Errors = @($errors) }
}

function Get-RunnerFunctionText {
    param([string]$Name)
    $parsed = Get-RunnerAst
    $node = $parsed.Ast.Find({
        param($candidate)
        $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -eq $Name
    }, $true)
    if ($null -eq $node) { throw ("runner-function-missing: " + $Name) }
    return $node.Extent.Text
}

function Get-RunnerText {
    return [System.IO.File]::ReadAllText($RunnerPath)
}

function New-DebugPathEntries {
    param([string]$Root)
    $entries = [ordered]@{}
    foreach ($key in $ExpectedPathKeys) { $entries[$key] = Join-Path $Root $key }
    return $entries
}

function New-DebugPathTable {
    param([object]$Entries)
    $lines = @($Entries.Keys | ForEach-Object { ([string]$_).PadRight(10) + " " + [string]$Entries[$_] })
    return (($lines -join "`r`n") + "`r`n")
}

function New-DebugPathJson {
    param([object]$Entries)
    $pairs = @($Entries.Keys | ForEach-Object {
        '"' + [string]$_ + '":"' + ([string]$Entries[$_]).Replace('\', '\\') + '"'
    })
    return ("{" + ($pairs -join ",") + "}")
}

function Get-SafeThrownCode {
    param([scriptblock]$Action)
    try {
        & $Action | Out-Null
        return "ACCEPTED"
    } catch {
        $message = [string]$_.Exception.Message
        if ($message -match '^(debug-paths|native-probe-result|native-archive-result)-[a-z-]+$') { return $message }
        return "unsafe-exception"
    }
}

function Invoke-RunnerStatic {
    param([string[]]$ExtraArguments = @())
    $hostExecutable = (Get-Process -Id $PID).Path
    $arguments = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $RunnerPath) + $ExtraArguments
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = @(& $hostExecutable @arguments 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Lines = $lines; Text = ($lines -join "`n") }
}

function Invoke-WrapperStatic {
    param([string[]]$ExtraArguments = @())
    $hostExecutable = (Get-Process -Id $PID).Path
    $arguments = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $WrapperPath) + $ExtraArguments
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = @(& $hostExecutable @arguments 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Lines = $lines; Text = ($lines -join "`n") }
}

function Test-SafeOwnedDirectory {
    param([string]$Path)
    try {
        $full = [System.IO.Path]::GetFullPath($Path)
        $baseFull = [System.IO.Path]::GetFullPath($ApprovedTempBase).TrimEnd('\')
        if (-not $full.StartsWith(($baseFull + '\'), [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
        if (-not ([System.IO.Path]::GetFileName($full)).StartsWith("sync-anchor-helper-check-", [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
        $cursor = [System.IO.DirectoryInfo]::new($full)
        while ($null -ne $cursor) {
            if (-not $cursor.Exists) { return $false }
            if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            $cursor = $cursor.Parent
        }
        return $true
    } catch {
        return $false
    }
}

function Remove-OwnedDirectory {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $true }
    if (-not (Test-SafeOwnedDirectory -Path $Path)) { return $false }
    try {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        return (-not (Test-Path -LiteralPath $Path))
    } catch {
        return $false
    }
}

$parsed = Get-RunnerAst
Assert-Check -Condition ($parsed.Errors.Count -eq 0) -Name "runner parses without AST errors" -Detail ("errors=" + [string]$parsed.Errors.Count)

try {
    $assignments = @($parsed.Ast.FindAll({
        param($candidate)
        $candidate -is [System.Management.Automation.Language.AssignmentStatementAst]
    }, $true))
    $homeAssignments = @($assignments | Where-Object { $_.Left.Extent.Text -match '^\$home$' })
    Assert-Check -Condition ($homeAssignments.Count -eq 0) -Name "runner does not assign the read-only HOME variable"

    $stageNames = New-Object System.Collections.Generic.List[string]
    foreach ($assignment in $assignments) {
        if ($assignment.Left.Extent.Text -ne '$script:ProbeStage') { continue }
        $right = $assignment.Right
        if ($right -is [System.Management.Automation.Language.CommandExpressionAst] -and
            $right.Expression -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $right = $right.Expression
        }
        if ($right -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $stageNames.Add($right.Value)
        }
    }
    foreach ($requiredStage in @("create-root", "compile-helper", "build-env", "version", "stage-plugin", "debug-capture", "debug-json", "debug-path-map", "debug-isolation", "tui-launch", "result", "observation", "phase1-stop", "inspect-manifest", "inspect-launch", "inspect-result", "inspect-stop", "cleanup")) {
        Assert-Check -Condition ($stageNames -contains $requiredStage) -Name ("stage marker present: " + $requiredStage)
    }

    $runnerText = Get-RunnerText
    Assert-Check -Condition ($runnerText.Contains("RUN-FAILED: bounded failure; stage=")) -Name "failure line reports a fixed stage field"
    Assert-Check -Condition ($runnerText.Contains("category=") -and $runnerText.Contains("Get-SafeFailureCategory")) -Name "failure line reports a safe category helper"
    $failureLines = @($runnerText -split "`n" | Where-Object { $_.Contains("RUN-FAILED: bounded failure; stage=") })
    Assert-Check -Condition ($failureLines.Count -eq 1) -Name "failure line is emitted once"
    Assert-Check -Condition ($failureLines.Count -eq 1 -and $failureLines[0] -notmatch '\$_|Exception\.Message|\.ToString\(') -Name "failure line interpolates no raw error object"

    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Get-SafeFailureCategory")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Get-SafeProbeStage")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Get-CombinedProbeGate")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Get-SafeProbeResult")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Get-SafeNativeProbeResult")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Get-SafeNativeArchiveProbeResult")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Get-NativeReplacementStageSet")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "New-ProbeEnvironmentBlock")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "ConvertFrom-DebugPathsText")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Get-DebugPathMap")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Test-UnderRoot")))

    $script:ProbeStages = @(
        "start", "preconditions", "create-root", "compile-helper", "build-env", "version",
        "stage-plugin", "debug-capture", "debug-json", "debug-path-map", "debug-isolation",
        "tui-launch", "result", "observation", "phase1-stop", "inspect-manifest",
        "inspect-launch", "inspect-result", "inspect-stop", "cleanup"
    )
    $canary = "CANARY-" + [guid]::NewGuid().ToString("N")
    $knownStage = [string](Get-SafeProbeStage -Stage "build-env")
    $unknownStage = [string](Get-SafeProbeStage -Stage ([string]("canary-" + $canary)))
    Assert-Check -Condition ($knownStage -eq "build-env") -Name "known stage is preserved"
    Assert-Check -Condition ($unknownStage -eq "unknown") -Name "unlisted stage maps to fixed unknown"
    Assert-Check -Condition (-not $unknownStage.Contains($canary)) -Name "stage output has no canary"

    $gateDefault = Get-CombinedProbeGate -Phase1ResultOk $true -Phase1StopVerified $true -Phase2Started $false -Phase2StopVerified $false
    Assert-Check -Condition ($gateDefault.LaunchPhase2 -and $gateDefault.DeleteRoot -and -not $gateDefault.RetryAllowed) -Name "combined gate allows restart after verified phase1 stop"
    $gateStopFail = Get-CombinedProbeGate -Phase1ResultOk $true -Phase1StopVerified $false -Phase2Started $false -Phase2StopVerified $false
    Assert-Check -Condition (-not $gateStopFail.LaunchPhase2 -and -not $gateStopFail.DeleteRoot) -Name "unverified phase1 stop blocks restart and deletion"
    $gateResultFail = Get-CombinedProbeGate -Phase1ResultOk $false -Phase1StopVerified $true -Phase2Started $false -Phase2StopVerified $false
    Assert-Check -Condition (-not $gateResultFail.LaunchPhase2 -and $gateResultFail.DeleteRoot) -Name "failed phase1 result blocks restart"
    $gateRestartStopFail = Get-CombinedProbeGate -Phase1ResultOk $true -Phase1StopVerified $true -Phase2Started $true -Phase2StopVerified $false
    Assert-Check -Condition (-not $gateRestartStopFail.DeleteRoot) -Name "unverified inspection stop blocks deletion"
    $gateRestartStopOk = Get-CombinedProbeGate -Phase1ResultOk $true -Phase1StopVerified $true -Phase2Started $true -Phase2StopVerified $true
    Assert-Check -Condition $gateRestartStopOk.DeleteRoot -Name "verified inspection stop allows deletion"

    $inspectJson = @'
{"probe":"sessionport-sync-anchor-public-route-cache","phase":"inspect","ok":true,"stage":"complete","failure":null,"imports":{"attempted":0,"returned":0},"anchor":{"originalPreserved":true,"messageCount":2,"rootCount":1,"initialRouteObserved":true,"initialCacheReady":true,"initialCacheMessageCount":2},"children":{"count":2,"retained":true,"messagesSettled":true},"cache":{"refreshed":true,"messageCount":2},"route":{"redirects":3,"rootSelectionReachedHead":true,"tabFocusReachedHead":null},"tabs":{"enabled":true,"result":"not-tested"},"renderReadiness":{"nativeSessionRouteObserved":true,"messageCacheReady":true,"composerObserved":false,"ordinaryContinuation":"not-tested"}}
'@
    $safeInspect = Get-SafeProbeResult -Raw ($inspectJson | ConvertFrom-Json) -ExpectedVersion "2.1.1"
    Assert-Check -Condition ($safeInspect.phase -eq "inspect" -and $safeInspect.ok -and $safeInspect.imports.attempted -eq 0) -Name "inspection result is sanitized with zero imports"
    Assert-Check -Condition ($safeInspect.tabs.result -eq "not-tested" -and $safeInspect.renderReadiness.ordinaryContinuation -eq "not-tested") -Name "inspection result keeps untested readiness explicit"
    $inspectFailJson = $inspectJson.Replace('"failure":null', '"failure":"inspection-readback-mismatch"').Replace('"stage":"complete"', '"stage":"inspection-readback"')
    $safeInspectFail = Get-SafeProbeResult -Raw ($inspectFailJson | ConvertFrom-Json) -ExpectedVersion "2.1.1"
    Assert-Check -Condition ($safeInspectFail.failure -eq "inspection-readback-mismatch" -and $safeInspectFail.stage -eq "inspection-readback") -Name "inspection failure code remains on the fixed allowlist"

    # --- NativeReplacement mode: fixed mode selection, fixed artifact allowlist, exact result schema ---
    $paramNames = @($parsed.Ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    Assert-Check -Condition ($paramNames -contains "ProbeMode") -Name "runner exposes a fixed ProbeMode parameter"
    Assert-Check -Condition (-not ($paramNames -contains "PluginPath") -and -not ($paramNames -contains "PluginFile") -and -not ($paramNames -contains "ArtifactPath")) -Name "runner exposes no arbitrary plugin path parameter"
    $runnerText = Get-RunnerText
    Assert-Check -Condition ($runnerText.Contains('[ValidateSet("SyncAnchor", "NativeReplacement")]')) -Name "ProbeMode is a two-value ValidateSet"
    Assert-Check -Condition ($runnerText.Contains('$ProbeMode = "SyncAnchor"')) -Name "ProbeMode defaults to the unchanged SyncAnchor mode"
    Assert-Check -Condition ($runnerText.Contains('$NativeStageDirectoryName = "native-replacement-probe"')) -Name "native staging directory name is fixed"
    Assert-Check -Condition ($runnerText.Contains('$NativeResultLimitBytes = 4096')) -Name "native result cap is fixed at 4 KiB"
    Assert-Check -Condition ($runnerText.Contains('$NativeBundleFile') -eq $false -and $runnerText.Contains('.package-verify-work\m1-native-tui-plugin-20261024\tui.tsx')) -Name "native bundle path is fixed and not caller supplied"

    $nativeValid = [pscustomobject]@{
        probe = $NativeProbeName; version = 1; ok = $true; stage = "complete"; reason = "none"
        importedCount = 2; oldMessageCount = 2; candidateMessageCount = 3
        nativeRouteObserved = $true; parentlessVerified = $true
        archiveNotTested = $true; composerNotTested = $true; pickerNotTested = $true
    }
    $safeNative = Get-SafeNativeProbeResult -Raw $nativeValid
    $expectedNativeKeys = @("probe", "version", "ok", "stage", "reason", "importedCount", "oldMessageCount", "candidateMessageCount", "nativeRouteObserved", "parentlessVerified", "archiveNotTested", "composerNotTested", "pickerNotTested")
    $actualNativeKeys = @($safeNative.PSObject.Properties | ForEach-Object { $_.Name })
    Assert-Check -Condition (($actualNativeKeys -join ",") -eq ($expectedNativeKeys -join ",")) -Name "native result has exactly the fixed schema keys" -Detail ("keys=" + [string]$actualNativeKeys.Count)
    Assert-Check -Condition ($safeNative.ok -and $safeNative.stage -eq "complete" -and $safeNative.importedCount -eq 2 -and $safeNative.oldMessageCount -eq 2 -and $safeNative.candidateMessageCount -eq 3 -and $safeNative.nativeRouteObserved -and $safeNative.parentlessVerified) -Name "native pass requires complete 2/2/3 history, parentless, and route"
    Assert-Check -Condition ($safeNative.archiveNotTested -and $safeNative.composerNotTested -and $safeNative.pickerNotTested) -Name "native result always records archive/composer/picker as not tested"

    $nativeIncomplete = $nativeValid | Select-Object *
    $nativeIncomplete.candidateMessageCount = 2
    $safeIncomplete = Get-SafeNativeProbeResult -Raw $nativeIncomplete
    Assert-Check -Condition (-not $safeIncomplete.ok) -Name "native result cannot pass with incomplete candidate history"
    $nativeBadReason = $nativeValid | Select-Object *
    $nativeBadReason.reason = "navigation"
    $safeBadReason = Get-SafeNativeProbeResult -Raw $nativeBadReason
    Assert-Check -Condition (-not $safeBadReason.ok) -Name "native complete result cannot pass with a non-none reason"

    $nativeCanary = "CANARY-" + [guid]::NewGuid().ToString("N")
    $nativeBad = [pscustomobject]@{
        probe = $NativeProbeName; version = 1; ok = $true; stage = $nativeCanary; reason = $nativeCanary
        importedCount = 2; oldMessageCount = 2; candidateMessageCount = 3
        nativeRouteObserved = $true; parentlessVerified = $true
        archiveNotTested = $true; composerNotTested = $true; pickerNotTested = $true
        id = $nativeCanary; content = $nativeCanary
    }
    $safeNativeBad = Get-SafeNativeProbeResult -Raw $nativeBad
    $nativeBadJson = $safeNativeBad | ConvertTo-Json -Depth 4 -Compress
    Assert-Check -Condition ($safeNativeBad.stage -eq "failed" -and $safeNativeBad.reason -eq "internal" -and -not $safeNativeBad.ok) -Name "unknown native stage/reason are downgraded and never pass"
    Assert-Check -Condition (-not $nativeBadJson.Contains($nativeCanary)) -Name "native sanitizer drops IDs, content, and canary values"
    Assert-Check -Condition (@($safeNativeBad.PSObject.Properties).Count -eq 13) -Name "native sanitizer drops extra keys"
    Assert-Check -Condition ($nativeBadJson.Length -le 4096) -Name "native result serialization stays within 4 KiB" -Detail ("bytes=" + [string]$nativeBadJson.Length)

    $nativeWrongVersion = $nativeValid | Select-Object *
    $nativeWrongVersion.version = 2
    $code = Get-SafeThrownCode { Get-SafeNativeProbeResult -Raw $nativeWrongVersion }
    Assert-Check -Condition ($code -eq "native-probe-result-version-invalid") -Name "native result version is pinned to 1" -Detail $code
    $code = Get-SafeThrownCode { Get-SafeNativeProbeResult -Raw ([pscustomobject]@{ probe = "other"; version = 1 }) }
    Assert-Check -Condition ($code -eq "native-probe-result-shape-invalid") -Name "foreign probe name is rejected with a fixed code" -Detail $code

    $surfaceDir = Join-Path $ApprovedTempBase ("sync-anchor-helper-check-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $surfaceDir -Force | Out-Null
    $script:CleanupDirectories.Add($surfaceDir)
    $bundleDir = Join-Path $surfaceDir ".package-verify-work\m1-native-tui-plugin-20261024"
    $sourceDir = Join-Path $surfaceDir "scripts\host-probes\native-replacement\tui"
    New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null
    New-Item -ItemType Directory -Path $sourceDir -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $bundleDir "tui.tsx"), "// bundle")
    [System.IO.File]::WriteAllText((Join-Path $bundleDir "unrelated.ts"), "// not allowlisted")
    $bundleSet = Get-NativeReplacementStageSet -ProjectRoot $surfaceDir
    Assert-Check -Condition ($bundleSet.Ready -and @($bundleSet.Files).Count -eq 1) -Name "bundle artifact stages exactly one file"
    Assert-Check -Condition ([string]$bundleSet.Files[0].Name -eq "tui.tsx" -and [string]$bundleSet.Files[0].Source -eq (Join-Path $bundleDir "tui.tsx")) -Name "bundle artifact uses the fixed tui.tsx destination"
    Assert-Check -Condition (@($bundleSet.Files | Where-Object { [string]$_.Name -match '[\\/]' }).Count -eq 0) -Name "staged bundle name has no path separator"

    Remove-Item -LiteralPath (Join-Path $bundleDir "tui.tsx") -Force
    [System.IO.File]::WriteAllText((Join-Path $sourceDir "tui.tsx"), "// source")
    [System.IO.File]::WriteAllText((Join-Path $sourceDir "fixtures.ts"), "// fixture")
    [System.IO.File]::WriteAllText((Join-Path $sourceDir "unrelated.ts"), "// not allowlisted")
    $sourceSet = Get-NativeReplacementStageSet -ProjectRoot $surfaceDir
    $sourceNames = @($sourceSet.Files | ForEach-Object { [string]$_.Name })
    Assert-Check -Condition ($sourceSet.Ready -and $sourceNames.Count -eq 2 -and $sourceNames[0] -eq "tui.tsx" -and $sourceNames[1] -eq "fixtures.ts") -Name "source entry stages only the whitelisted fixture helper" -Detail ("files=" + ($sourceNames -join ","))
    Assert-Check -Condition (@($sourceNames | Where-Object { $_ -match '[\\/]' }).Count -eq 0) -Name "source staging names have no path separators"

    Remove-Item -LiteralPath (Join-Path $sourceDir "tui.tsx") -Force
    $emptySet = Get-NativeReplacementStageSet -ProjectRoot $surfaceDir
    Assert-Check -Condition (-not $emptySet.Ready -and @($emptySet.Files).Count -eq 0) -Name "missing fixed artifact fails closed"

    Assert-Check -Condition (Test-Path -LiteralPath (Join-Path $PSScriptRoot "phase2.ts") -PathType Leaf) -Name "phase2 inspection helper exists"
    Assert-Check -Condition ((Get-RunnerText).Contains("phase1-stop-unverified") -and (Get-RunnerText).Contains("inspect-stop-unverified")) -Name "combined stop failures have fixed codes"
    Assert-Check -Condition ((Get-RunnerText).Contains("Test-PhysicalDirectoryChain") -and (Get-RunnerText).Contains("Test-RootDeletionSet")) -Name "root and reparse guards remain present"

    $fakeRoot = Join-Path $ApprovedTempBase ("sync-anchor-test-" + [guid]::NewGuid().ToString("N"))
    $inspectBlock = [string](New-ProbeEnvironmentBlock -Root $fakeRoot -Executable (Join-Path $fakeRoot "bin\opencode.exe") -Phase "inspect" -ResultPath (Join-Path $fakeRoot "results\probe-inspect-result.json") -ManifestPath (Join-Path $fakeRoot "results\probe-manifest.json"))
    $inspectEntries = @($inspectBlock.Split([char]0) | Where-Object { $_.Length -gt 0 })
    Assert-Check -Condition ($inspectEntries -contains "SP_PROBE_PHASE=inspect") -Name "inspection environment selects inspect phase"
    Assert-Check -Condition ($inspectEntries -contains ("SP_PROBE_MANIFEST=" + (Join-Path $fakeRoot "results\probe-manifest.json"))) -Name "inspection environment carries the manifest path"

    $secretMessage = "secret " + $canary + " at C:\private\operator\path"
    $knownError = [System.Management.Automation.ErrorRecord]::new(
        [System.InvalidOperationException]::new($secretMessage),
        "canary",
        [System.Management.Automation.ErrorCategory]::InvalidOperation,
        $null
    )
    $knownCategory = [string](Get-SafeFailureCategory -ErrorRecord $knownError)
    Assert-Check -Condition ($knownCategory -eq "InvalidOperationException") -Name "known exception maps to type category"
    Assert-Check -Condition (-not $knownCategory.Contains($canary) -and -not $knownCategory.Contains("private")) -Name "category redacts message, path, and canary"
    Assert-Check -Condition ($knownCategory.Length -le 64) -Name "category output is capped"
    Assert-Check -Condition ($knownCategory -match '^[A-Za-z][A-Za-z0-9]{0,63}$') -Name "category uses a safe identifier shape"

    $unknownError = [System.Management.Automation.ErrorRecord]::new(
        [System.Exception]::new($secretMessage),
        "canary",
        [System.Management.Automation.ErrorCategory]::InvalidOperation,
        $null
    )
    $unknownCategory = [string](Get-SafeFailureCategory -ErrorRecord $unknownError)
    Assert-Check -Condition ($unknownCategory -eq "Exception") -Name "unlisted exception type reports a safe type category"
    Assert-Check -Condition ($unknownCategory -match '^[A-Za-z][A-Za-z0-9]{0,63}$') -Name "unlisted type category uses a safe identifier shape"
    Assert-Check -Condition (-not $unknownCategory.Contains($canary)) -Name "unlisted type category has no canary"

    $comError = [System.Management.Automation.ErrorRecord]::new(
        [System.Runtime.InteropServices.COMException]::new($secretMessage, -2147467259),
        "canary",
        [System.Management.Automation.ErrorCategory]::InvalidOperation,
        $null
    )
    $comCategory = [string](Get-SafeFailureCategory -ErrorRecord $comError)
    Assert-Check -Condition ($comCategory -eq "hresult-0x80004005") -Name "COM failure maps to numeric HRESULT category"

    $nullCategory = [string](Get-SafeFailureCategory -ErrorRecord $null)
    Assert-Check -Condition ($nullCategory -eq "no-exception") -Name "missing exception maps to fixed category"

    $homeBefore = [string]$HOME
    $fakeRoot = Join-Path $ApprovedTempBase ("sync-anchor-test-" + [guid]::NewGuid().ToString("N"))
    $envBlock = [string](New-ProbeEnvironmentBlock -Root $fakeRoot -Executable (Join-Path $fakeRoot "bin\opencode.exe"))
    $entries = @($envBlock.Split([char]0) | Where-Object { $_.Length -gt 0 })
    Assert-Check -Condition ($entries.Count -ge 20) -Name "environment block is non-empty" -Detail ("entries=" + [string]$entries.Count)
    Assert-Check -Condition ($entries -contains "SP_PROBE_PHASE=probe") -Name "default environment selects probe phase"
    Assert-Check -Condition (@($entries | Where-Object { $_ -like "SP_PROBE_MANIFEST=*" }).Count -eq 0) -Name "default environment omits the inspection manifest"
    Assert-Check -Condition ($entries -contains ("HOME=" + (Join-Path $fakeRoot "home"))) -Name "environment block isolates HOME"
    Assert-Check -Condition ([string]$HOME -eq $homeBefore) -Name "environment builder leaves caller HOME unchanged"
    Assert-Check -Condition (@($entries | Where-Object { $_ -like "SP_PROBE_ARCHIVE=*" }).Count -eq 0) -Name "default environment omits the archive switch"

    $archiveBlock = [string](New-ProbeEnvironmentBlock -Root $fakeRoot -Executable (Join-Path $fakeRoot "bin\opencode.exe") -ArchiveProbe)
    $archiveEntries = @($archiveBlock.Split([char]0) | Where-Object { $_.Length -gt 0 })
    Assert-Check -Condition ($archiveEntries -contains "SP_PROBE_ARCHIVE=1") -Name "archive environment sets the fixed switch value"

    $fixtureRoot = Join-Path $ApprovedTempBase ("sync-anchor-parser-" + [guid]::NewGuid().ToString("N"))
    $fixtureEntries = New-DebugPathEntries -Root $fixtureRoot
    $fixtureTable = New-DebugPathTable -Entries $fixtureEntries
    $fixtureJson = New-DebugPathJson -Entries $fixtureEntries

    $tableDocument = ConvertFrom-DebugPathsText -Text $fixtureTable
    $tableMap = Get-DebugPathMap -Document $tableDocument
    Assert-Check -Condition ($tableDocument.Format -eq "table") -Name "verified text-table format is recognized"
    Assert-Check -Condition ($tableMap.Count -eq 10) -Name "text-table format yields all ten paths" -Detail ("count=" + [string]$tableMap.Count)
    $missingKeys = @($ExpectedPathKeys | Where-Object { -not $tableMap.ContainsKey($_) })
    Assert-Check -Condition ($missingKeys.Count -eq 0) -Name "text-table format contains every expected key"
    $outsidePaths = @($ExpectedPathKeys | Where-Object { -not (Test-UnderRoot -Child ([string]$tableMap[$_]) -Root $fixtureRoot) })
    Assert-Check -Condition ($outsidePaths.Count -eq 0) -Name "text-table paths pass the root-bound check"

    $jsonDocument = ConvertFrom-DebugPathsText -Text $fixtureJson
    $jsonMap = Get-DebugPathMap -Document $jsonDocument
    Assert-Check -Condition ($jsonDocument.Format -eq "json") -Name "exact JSON object is recognized"
    Assert-Check -Condition ($jsonMap.Count -eq 10) -Name "JSON format yields all ten paths" -Detail ("count=" + [string]$jsonMap.Count)
    $differentValues = @($ExpectedPathKeys | Where-Object { [string]$tableMap[$_] -ne [string]$jsonMap[$_] })
    Assert-Check -Condition ($differentValues.Count -eq 0) -Name "text-table and JSON fixtures decode to the same paths"

    $lfTable = $fixtureTable.Replace("`r`n", "`n")
    $lfDocument = ConvertFrom-DebugPathsText -Text $lfTable
    Assert-Check -Condition ($lfDocument.Format -eq "table" -and $lfDocument.Entries.Count -eq 10) -Name "LF-only text-table output is accepted"

    $ansiReset = ([char]27) + "[0m"
    $ansiTable = ([char]27) + "[31m" + $fixtureTable + $ansiReset
    $ansiTableDocument = ConvertFrom-DebugPathsText -Text $ansiTable
    Assert-Check -Condition ($ansiTableDocument.Format -eq "table" -and $ansiTableDocument.Entries.Count -eq 10) -Name "ANSI-wrapped text-table output is accepted"

    $ansiJson = ([char]27) + "[32m" + $fixtureJson + $ansiReset
    $ansiJsonDocument = ConvertFrom-DebugPathsText -Text $ansiJson
    Assert-Check -Condition ($ansiJsonDocument.Format -eq "json" -and $ansiJsonDocument.Entries.Count -eq 10) -Name "ANSI-wrapped JSON output is accepted"

    $prettyJson = $fixtureJson.Replace(",", ",`r`n  ")
    $prettyDocument = ConvertFrom-DebugPathsText -Text $prettyJson
    Assert-Check -Condition ($prettyDocument.Format -eq "json" -and $prettyDocument.Entries.Count -eq 10) -Name "multiline JSON output is accepted"

    $spaceRoot = Join-Path $ApprovedTempBase "sync-anchor parser fixture"
    $spaceTable = New-DebugPathTable -Entries (New-DebugPathEntries -Root $spaceRoot)
    $spaceMap = Get-DebugPathMap -Document (ConvertFrom-DebugPathsText -Text $spaceTable)
    Assert-Check -Condition ([string]$spaceMap["home"] -eq (Join-Path $spaceRoot "home")) -Name "paths containing spaces are preserved"

    $duplicateTable = $fixtureTable + ("home".PadRight(10) + " C:\x" + "`r`n")
    $code = Get-SafeThrownCode { ConvertFrom-DebugPathsText -Text $duplicateTable }
    Assert-Check -Condition ($code -eq "debug-paths-table-duplicate") -Name "duplicate table key is rejected" -Detail $code

    $missingLines = @(($fixtureTable -split "\r?\n") | Where-Object { $_.Length -gt 0 -and $_ -notmatch '^db\s' })
    $missingTable = (($missingLines -join "`r`n") + "`r`n")
    $code = Get-SafeThrownCode { $document = ConvertFrom-DebugPathsText -Text $missingTable; Get-DebugPathMap -Document $document }
    Assert-Check -Condition ($code -eq "debug-paths-key-missing") -Name "missing table key is rejected at map stage" -Detail $code

    $unknownTable = $fixtureTable + ("extra".PadRight(10) + " C:\x" + "`r`n")
    $code = Get-SafeThrownCode { $document = ConvertFrom-DebugPathsText -Text $unknownTable; Get-DebugPathMap -Document $document }
    Assert-Check -Condition ($code -eq "debug-paths-key-unknown") -Name "unknown table key is rejected at map stage" -Detail $code

    $quotedEntries = New-DebugPathEntries -Root $fixtureRoot
    $quotedEntries["home"] = '"' + [string]$quotedEntries["home"] + '"'
    $quotedTable = New-DebugPathTable -Entries $quotedEntries
    $code = Get-SafeThrownCode { ConvertFrom-DebugPathsText -Text $quotedTable }
    Assert-Check -Condition ($code -eq "debug-paths-table-quoted") -Name "quoted table path is rejected" -Detail $code

    $warningTable = "warning: synthetic host notice`r`n" + $fixtureTable
    $code = Get-SafeThrownCode { ConvertFrom-DebugPathsText -Text $warningTable }
    Assert-Check -Condition ($code -eq "debug-paths-table-field") -Name "table output with a warning prefix is rejected" -Detail $code

    $warningJson = "warning: synthetic host notice`r`n" + $fixtureJson
    $code = Get-SafeThrownCode { ConvertFrom-DebugPathsText -Text $warningJson }
    Assert-Check -Condition ($code -eq "debug-paths-table-field") -Name "JSON output with a warning prefix is rejected" -Detail $code

    $code = Get-SafeThrownCode { ConvertFrom-DebugPathsText -Text "{" }
    Assert-Check -Condition ($code -eq "debug-paths-json-invalid") -Name "invalid JSON is rejected with a fixed code" -Detail $code

    $code = Get-SafeThrownCode { ConvertFrom-DebugPathsText -Text '[{"home":"C:\\x"}]' }
    Assert-Check -Condition ($code -eq "debug-paths-format-unsupported") -Name "JSON array is rejected with a fixed code" -Detail $code

    $nestedJson = [regex]::Replace($fixtureJson, '"home":"[^"]*"', '"home":{"path":"C:\\x"}')
    $code = Get-SafeThrownCode { $document = ConvertFrom-DebugPathsText -Text $nestedJson; Get-DebugPathMap -Document $document }
    Assert-Check -Condition ($code -eq "debug-paths-value-invalid") -Name "non-string path value is rejected" -Detail $code

    $unknownJson = '{' + '"extra":"C:\\x",' + $fixtureJson.Substring(1)
    $code = Get-SafeThrownCode { $document = ConvertFrom-DebugPathsText -Text $unknownJson; Get-DebugPathMap -Document $document }
    Assert-Check -Condition ($code -eq "debug-paths-key-unknown") -Name "unknown JSON key is rejected" -Detail $code

    $code = Get-SafeThrownCode { ConvertFrom-DebugPathsText -Text "" }
    Assert-Check -Condition ($code -eq "debug-paths-output-empty") -Name "empty debug output is rejected" -Detail $code

    $outsideMap = Get-DebugPathMap -Document (ConvertFrom-DebugPathsText -Text $fixtureTable)
    $outsideMap["home"] = "C:\outside\sync-anchor-parser"
    Assert-Check -Condition (-not (Test-UnderRoot -Child ([string]$outsideMap["home"]) -Root $fixtureRoot)) -Name "path outside the disposable root fails isolation"
    Assert-Check -Condition (-not (Test-UnderRoot -Child ($fixtureRoot + "-sibling") -Root $fixtureRoot)) -Name "sibling-prefix path fails isolation"
    Assert-Check -Condition (Test-UnderRoot -Child (Join-Path $fixtureRoot "home\sub") -Root $fixtureRoot) -Name "path inside the disposable root passes isolation"

    $quoteTrim = ([string]('"' + 'C:\fixture' + '"')).Trim('"', "'")
    Assert-Check -Condition ($quoteTrim -eq 'C:\fixture') -Name "PowerShell 5.1 two-character Trim overload works"

    $staticRun = Invoke-RunnerStatic
    Assert-Check -Condition ($staticRun.ExitCode -eq 0) -Name "default static invocation exits 0" -Detail ("exit=" + [string]$staticRun.ExitCode)
    Assert-Check -Condition ($staticRun.Text.Contains("VALIDATION-OK")) -Name "default static invocation reports VALIDATION-OK"
    Assert-Check -Condition ($staticRun.Text.Contains("RUN-NOT-STARTED")) -Name "default static invocation reports RUN-NOT-STARTED"
    Assert-Check -Condition (-not $staticRun.Text.Contains("preflight:") -and -not $staticRun.Text.Contains("RUN-FAILED")) -Name "default static invocation starts no probe stage"

    $static211 = Invoke-RunnerStatic -ExtraArguments @("-ExpectedVersion", "2.1.1")
    Assert-Check -Condition ($static211.ExitCode -eq 0) -Name "2.1.1 static invocation exits 0" -Detail ("exit=" + [string]$static211.ExitCode)
    Assert-Check -Condition ($static211.Text.Contains("VALIDATION-OK") -and $static211.Text.Contains("EXPECTED-VERSION: 2.1.1")) -Name "2.1.1 static invocation reports VALIDATION-OK"
    Assert-Check -Condition (-not $static211.Text.Contains("preflight:") -and -not $static211.Text.Contains("RUN-FAILED")) -Name "2.1.1 static invocation starts no probe stage"

    $invalidRun = Invoke-RunnerStatic -ExtraArguments @("-ExpectedVersion", "9.9.9")
    Assert-Check -Condition ($invalidRun.ExitCode -eq 1) -Name "invalid expected version exits 1" -Detail ("exit=" + [string]$invalidRun.ExitCode)
    Assert-Check -Condition ($invalidRun.Text.Contains("VALIDATION-FAILED: expected-version-not-supported")) -Name "invalid expected version is rejected before any probe stage"
    Assert-Check -Condition (-not $invalidRun.Text.Contains("preflight:") -and -not $invalidRun.Text.Contains("RUN-FAILED")) -Name "invalid expected version starts no probe stage"

    $invalidMode = Invoke-RunnerStatic -ExtraArguments @("-ProbeMode", "Bogus")
    Assert-Check -Condition ($invalidMode.ExitCode -ne 0) -Name "invalid probe mode is rejected" -Detail ("exit=" + [string]$invalidMode.ExitCode)
    Assert-Check -Condition ($invalidMode.Text.Contains("ProbeMode") -and -not $invalidMode.Text.Contains("preflight:") -and -not $invalidMode.Text.Contains("RUN-FAILED")) -Name "invalid probe mode starts no probe stage"

    $nativeRestart = Invoke-RunnerStatic -ExtraArguments @("-ProbeMode", "NativeReplacement", "-CombinedRestartProbe")
    Assert-Check -Condition ($nativeRestart.ExitCode -eq 1) -Name "native mode rejects the combined restart probe" -Detail ("exit=" + [string]$nativeRestart.ExitCode)
    Assert-Check -Condition ($nativeRestart.Text.Contains("combined-restart-probe-not-supported-in-native-replacement-mode")) -Name "native restart rejection uses a fixed code"
    Assert-Check -Condition (-not $nativeRestart.Text.Contains("preflight:") -and -not $nativeRestart.Text.Contains("RUN-FAILED")) -Name "native restart rejection starts no probe stage"

    $explicitSync = Invoke-RunnerStatic -ExtraArguments @("-ProbeMode", "SyncAnchor", "-ExpectedVersion", "2.1.1")
    Assert-Check -Condition ($explicitSync.ExitCode -eq 0 -and $explicitSync.Text.Contains("VALIDATION-OK") -and $explicitSync.Text.Contains("RUN-NOT-STARTED")) -Name "explicit SyncAnchor static mode keeps the old validation path"
    Assert-Check -Condition (-not $explicitSync.Text.Contains("preflight:") -and -not $explicitSync.Text.Contains("RUN-FAILED")) -Name "explicit SyncAnchor static mode starts no probe stage"

    $nativeProjectRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    $nativeBundle = Join-Path $nativeProjectRoot ".package-verify-work\m1-native-tui-plugin-20261024\tui.tsx"
    $nativeSource = Join-Path $nativeProjectRoot "scripts\host-probes\native-replacement\tui\tui.tsx"
    $nativeArtifactPresent = (Test-Path -LiteralPath $nativeBundle -PathType Leaf) -or (Test-Path -LiteralPath $nativeSource -PathType Leaf)
    $nativeStatic = Invoke-RunnerStatic -ExtraArguments @("-ProbeMode", "NativeReplacement", "-ExpectedVersion", "2.1.1")
    if ($nativeArtifactPresent) {
        Assert-Check -Condition ($nativeStatic.ExitCode -eq 0 -and $nativeStatic.Text.Contains("VALIDATION-OK") -and $nativeStatic.Text.Contains("RUN-NOT-STARTED")) -Name "native static mode validates the fixed artifact and stops before launch"
        $realStageSet = Get-NativeReplacementStageSet -ProjectRoot $nativeProjectRoot
        Assert-Check -Condition ($realStageSet.Ready -and @($realStageSet.Files).Count -eq 1 -and [string]$realStageSet.Files[0].Name -eq "tui.tsx") -Name "present bundle resolves to the single fixed tui.tsx staging entry"
    } else {
        Assert-Check -Condition ($nativeStatic.ExitCode -eq 1 -and $nativeStatic.Text.Contains("VALIDATION-FAILED: native-replacement plugin artifact is missing")) -Name "native static mode fails closed until the fixed artifact exists"
    }
    Assert-Check -Condition (-not $nativeStatic.Text.Contains("preflight:") -and -not $nativeStatic.Text.Contains("RUN-FAILED")) -Name "native static mode starts no probe stage"

    Assert-Check -Condition (Test-Path -LiteralPath $WrapperPath -PathType Leaf) -Name "native replacement wrapper exists"
    $wrapperTokens = $null
    $wrapperErrors = $null
    $wrapperAst = [System.Management.Automation.Language.Parser]::ParseFile($WrapperPath, [ref]$wrapperTokens, [ref]$wrapperErrors)
    Assert-Check -Condition (@($wrapperErrors).Count -eq 0) -Name "native replacement wrapper parses without AST errors"
    $wrapperText = [System.IO.File]::ReadAllText($WrapperPath)
    $wrapperParams = @($wrapperAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    Assert-Check -Condition (-not ($wrapperParams -contains "CombinedRestartProbe") -and -not ($wrapperParams -contains "PluginPath") -and -not ($wrapperParams -contains "ExpectedVersion") -and -not ($wrapperParams -contains "ProbeMode")) -Name "wrapper exposes no mode/restart/plugin-path override"
    Assert-Check -Condition ($wrapperText.Contains('[ValidateRange(60, 90)]') -and $wrapperText.Contains('$InspectSeconds = 90')) -Name "wrapper defaults to a 90 second bounded owner window"
    Assert-Check -Condition ($wrapperText.Contains('[ValidateRange(30, 180)]') -and $wrapperText.Contains('$TimeoutSeconds = 180')) -Name "wrapper keeps the bounded 180 second timeout"
    Assert-Check -Condition ($wrapperText.Contains('"-ProbeMode", "NativeReplacement"') -and $wrapperText.Contains('"-ExpectedVersion", "2.1.1"')) -Name "wrapper pins native mode and 2.1.1"
    Assert-Check -Condition ($wrapperText.Contains('if ($RunProbe) { $arguments += "-RunProbe" }')) -Name "wrapper forwards RunProbe only when explicitly supplied"
    $wrapperStatic = Invoke-WrapperStatic
    Assert-Check -Condition (-not $wrapperStatic.Text.Contains("preflight:") -and -not $wrapperStatic.Text.Contains("RUN-FAILED")) -Name "wrapper default invocation starts no probe stage" -Detail ("exit=" + [string]$wrapperStatic.ExitCode)

    $helperDir = Join-Path $ApprovedTempBase ("sync-anchor-helper-check-" + [guid]::NewGuid().ToString("N"))
    $helperTemp = Join-Path $helperDir "tmp"
    New-Item -ItemType Directory -Path $helperTemp -Force | Out-Null
    $script:CleanupDirectories.Add($helperDir)

    $compileChild = @'
param([string]$RunnerPath)
Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($RunnerPath, [ref]$null, [ref]$null)
$node = $ast.Find({
    param($candidate)
    $candidate -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
    $candidate.StringConstantType -eq [System.Management.Automation.Language.StringConstantType]::SingleQuotedHereString -and
    $candidate.Value.Contains("namespace SessionPortSyncProbe")
}, $true)
if ($null -eq $node) { throw "helper-source-not-found" }
Add-Type -TypeDefinition $node.Value -Language CSharp -ErrorAction Stop
$type = [System.Management.Automation.PSTypeName]"SessionPortSyncProbe.ProcessJob"
if ($null -eq $type.Type) { throw "helper-type-not-loaded" }
Write-Output "COMPILE-OK"
'@
    $compileScript = Join-Path $helperDir "compile-helper.ps1"
    [System.IO.File]::WriteAllText($compileScript, $compileChild)

    $originalTemp = @{}
    foreach ($name in @("TEMP", "TMP", "TMPDIR")) {
        $originalTemp[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, $helperTemp, "Process")
    }
    try {
        $compileLines = @(& "powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $compileScript -RunnerPath $RunnerPath 2>&1 | ForEach-Object { [string]$_ })
        $compileExit = $LASTEXITCODE
    } finally {
        foreach ($name in @("TEMP", "TMP", "TMPDIR")) {
            [Environment]::SetEnvironmentVariable($name, $originalTemp[$name], "Process")
        }
    }
    Assert-Check -Condition ($compileExit -eq 0) -Name "helper source compiles in Windows PowerShell 5.1" -Detail ("exit=" + [string]$compileExit)
    Assert-Check -Condition (($compileLines -join "`n").Contains("COMPILE-OK")) -Name "helper compile child reports COMPILE-OK"

    $archiveInitialJson = '{"probe":"sessionport-native-replacement-tui-archive","version":2,"ok":false,"stage":"navigate","reason":"none","importedCount":2,"oldMessageCount":2,"candidateMessageCount":3,"nativeRouteObserved":true,"parentlessVerified":true,"archiveNotTested":false,"composerNotTested":true,"pickerNotTested":true,"archiveCall":"accepted","archiveReadback":"archived","recoveryReadback":"not-read","recoveryVerified":false,"mutationTargetOldOnly":true}'
    $archiveInitial = Get-SafeNativeArchiveProbeResult -Raw ($archiveInitialJson | ConvertFrom-Json)
    Assert-Check -Condition (-not $archiveInitial.ok -and $archiveInitial.archiveCall -eq "accepted" -and $archiveInitial.archiveReadback -eq "archived" -and -not $archiveInitial.archiveNotTested -and $archiveInitial.recoveryReadback -eq "not-read" -and -not $archiveInitial.recoveryVerified -and $archiveInitial.mutationTargetOldOnly) -Name "archive initial result is not a pass and keeps recovery not-read"
    $archiveFinalJson = '{"probe":"sessionport-native-replacement-tui-archive","version":2,"ok":true,"stage":"complete","reason":"none","importedCount":2,"oldMessageCount":2,"candidateMessageCount":3,"nativeRouteObserved":true,"parentlessVerified":true,"archiveNotTested":false,"composerNotTested":true,"pickerNotTested":true,"archiveCall":"accepted","archiveReadback":"archived","recoveryReadback":"active","recoveryVerified":true,"mutationTargetOldOnly":true}'
    $archiveFinal = Get-SafeNativeArchiveProbeResult -Raw ($archiveFinalJson | ConvertFrom-Json)
    Assert-Check -Condition ($archiveFinal.ok -and $archiveFinal.stage -eq "complete" -and $archiveFinal.recoveryReadback -eq "active" -and $archiveFinal.recoveryVerified) -Name "archive final result passes only with strict recovery"
    $archiveErrorFinal = Get-SafeNativeArchiveProbeResult -Raw (($archiveFinalJson.Replace('"archiveCall":"accepted"', '"archiveCall":"error"') | ConvertFrom-Json))
    Assert-Check -Condition ($archiveErrorFinal.ok -and $archiveErrorFinal.archiveCall -eq "error") -Name "archive applied-with-transport-error final can pass"
    $archiveIncomplete = Get-SafeNativeArchiveProbeResult -Raw (($archiveFinalJson.Replace('"recoveryVerified":true', '"recoveryVerified":false') | ConvertFrom-Json))
    Assert-Check -Condition (-not $archiveIncomplete.ok) -Name "archive recovery failure cannot pass"
    $archiveStripped = Get-SafeNativeArchiveProbeResult -Raw (($archiveInitialJson.Replace('"archiveReadback":"archived"', '"archiveReadback":"active"') | ConvertFrom-Json))
    Assert-Check -Condition (-not $archiveStripped.ok -and $archiveStripped.archiveReadback -eq "active") -Name "stripped archive field is non-applied and cannot pass"
    $archiveKeys = @($archiveFinal.PSObject.Properties.Name)
    $expectedArchiveKeys = @("probe", "version", "ok", "stage", "reason", "importedCount", "oldMessageCount", "candidateMessageCount", "nativeRouteObserved", "parentlessVerified", "archiveNotTested", "composerNotTested", "pickerNotTested", "archiveCall", "archiveReadback", "recoveryReadback", "recoveryVerified", "mutationTargetOldOnly")
    Assert-Check -Condition (($archiveKeys -join ",") -eq ($expectedArchiveKeys -join ",")) -Name "archive result has exactly the fixed v2 schema keys"
    $archiveCanary = Get-SafeNativeArchiveProbeResult -Raw (($archiveFinalJson.Replace('"mutationTargetOldOnly":true', '"mutationTargetOldOnly":true,"canary":"secret"') | ConvertFrom-Json))
    Assert-Check -Condition (-not ($archiveCanary | ConvertTo-Json -Compress).Contains("secret")) -Name "archive sanitizer drops extra keys"
    $code = Get-SafeThrownCode { Get-SafeNativeArchiveProbeResult -Raw ([pscustomobject]@{ probe = "sessionport-native-replacement-tui-archive"; version = 1 }) }
    Assert-Check -Condition ($code -eq "native-archive-result-version-invalid") -Name "archive result version is pinned to 2"

    $runnerText = Get-RunnerText
    Assert-Check -Condition ($runnerText.Contains("[switch]`$ArchiveProbe")) -Name "runner exposes a fixed ArchiveProbe switch"
    Assert-Check -Condition ($runnerText.Contains("SP_PROBE_ARCHIVE")) -Name "runner sets the fixed archive env name"
    Assert-Check -Condition ($runnerText.Contains("Get-SafeNativeArchiveProbeResult") -and $runnerText.Contains("archive-probe-requires-native-replacement")) -Name "runner has the archive sanitizer and mode gate"
    $archiveWrongMode = Invoke-RunnerStatic -ExtraArguments @("-ArchiveProbe")
    Assert-Check -Condition ($archiveWrongMode.ExitCode -eq 1 -and $archiveWrongMode.Text.Contains("archive-probe-requires-native-replacement")) -Name "archive probe without native mode is rejected"
    $nativeArchiveStatic = Invoke-RunnerStatic -ExtraArguments @("-ProbeMode", "NativeReplacement", "-ArchiveProbe", "-ExpectedVersion", "2.1.1")
    Assert-Check -Condition ($nativeArchiveStatic.ExitCode -eq 0 -and $nativeArchiveStatic.Text.Contains("VALIDATION-OK") -and $nativeArchiveStatic.Text.Contains("RUN-NOT-STARTED") -and -not $nativeArchiveStatic.Text.Contains("preflight:")) -Name "archive native static mode validates and starts no probe stage"
    $wrapperText = [System.IO.File]::ReadAllText($WrapperPath)
    Assert-Check -Condition ($wrapperText.Contains("[switch]`$ArchiveProbe") -and $wrapperText.Contains('"-ArchiveProbe"')) -Name "archive wrapper exposes and forwards ArchiveProbe"
    $wrapperArchiveStatic = Invoke-WrapperStatic -ExtraArguments @("-ArchiveProbe")
    Assert-Check -Condition ($wrapperArchiveStatic.ExitCode -eq 0 -and $wrapperArchiveStatic.Text.Contains("VALIDATION-OK") -and $wrapperArchiveStatic.Text.Contains("RUN-NOT-STARTED") -and -not $wrapperArchiveStatic.Text.Contains("preflight:")) -Name "archive wrapper static mode validates and starts no probe stage"
} finally {
    foreach ($cleanupDirectory in $script:CleanupDirectories) {
        if (-not (Remove-OwnedDirectory -Path $cleanupDirectory)) { $script:CleanupOk = $false }
    }
    Assert-Check -Condition $script:CleanupOk -Name "owned diagnostic directories removed after verification"
}

if ($script:Failures.Count -eq 0) {
    Write-Host ("TESTS-PASSED: " + [string]$script:PassCount)
    exit 0
}

Write-Host ("TESTS-FAILED: " + [string]$script:Failures.Count + " of " + [string]($script:PassCount + $script:Failures.Count))
exit 1
