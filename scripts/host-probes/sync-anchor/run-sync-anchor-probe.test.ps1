#Requires -Version 5.1
[CmdletBinding()]
param()

# Focused, host-free checks for the sync-anchor runner. This file never passes
# -RunProbe to the runner, never starts OpenCode, and only compiles the helper
# source in a short-lived Windows PowerShell 5.1 child process.

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$RunnerPath = Join-Path $PSScriptRoot "run-sync-anchor-probe.ps1"
$ApprovedTempBase = "C:\Users\PC\AppData\Local\Temp\opencode"
$ExpectedPathKeys = @("home", "data", "cache", "config", "state", "tmp", "bin", "log", "repos", "db")
$script:PassCount = 0
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:CleanupDirectory = ""
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
        if ($message -match '^debug-paths-[a-z-]+$') { return $message }
        return "unsafe-exception"
    }
}

function Invoke-RunnerStatic {
    param([string[]]$ExtraArguments = @())
    $hostExecutable = (Get-Process -Id $PID).Path
    $arguments = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $RunnerPath) + $ExtraArguments
    $lines = @(& $hostExecutable @arguments 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = $LASTEXITCODE
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
    foreach ($requiredStage in @("create-root", "compile-helper", "build-env", "version", "stage-plugin", "debug-capture", "debug-json", "debug-path-map", "debug-isolation", "tui-launch", "result", "cleanup")) {
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
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "New-ProbeEnvironmentBlock")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "ConvertFrom-DebugPathsText")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Get-DebugPathMap")))
    . ([scriptblock]::Create((Get-RunnerFunctionText -Name "Test-UnderRoot")))

    $script:ProbeStages = @(
        "start", "preconditions", "create-root", "compile-helper", "build-env", "version",
        "stage-plugin", "debug-capture", "debug-json", "debug-path-map", "debug-isolation",
        "tui-launch", "result", "observation", "cleanup"
    )
    $canary = "CANARY-" + [guid]::NewGuid().ToString("N")
    $knownStage = [string](Get-SafeProbeStage -Stage "build-env")
    $unknownStage = [string](Get-SafeProbeStage -Stage ([string]("canary-" + $canary)))
    Assert-Check -Condition ($knownStage -eq "build-env") -Name "known stage is preserved"
    Assert-Check -Condition ($unknownStage -eq "unknown") -Name "unlisted stage maps to fixed unknown"
    Assert-Check -Condition (-not $unknownStage.Contains($canary)) -Name "stage output has no canary"

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
    Assert-Check -Condition ($entries -contains ("HOME=" + (Join-Path $fakeRoot "home"))) -Name "environment block isolates HOME"
    Assert-Check -Condition ([string]$HOME -eq $homeBefore) -Name "environment builder leaves caller HOME unchanged"

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

    $helperDir = Join-Path $ApprovedTempBase ("sync-anchor-helper-check-" + [guid]::NewGuid().ToString("N"))
    $helperTemp = Join-Path $helperDir "tmp"
    New-Item -ItemType Directory -Path $helperTemp -Force | Out-Null
    $script:CleanupDirectory = $helperDir

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
} finally {
    if (-not [string]::IsNullOrWhiteSpace($script:CleanupDirectory)) {
        $script:CleanupOk = Remove-OwnedDirectory -Path $script:CleanupDirectory
    }
    Assert-Check -Condition $script:CleanupOk -Name "owned compiler diagnostic directory removed after verification"
}

if ($script:Failures.Count -eq 0) {
    Write-Host ("TESTS-PASSED: " + [string]$script:PassCount)
    exit 0
}

Write-Host ("TESTS-FAILED: " + [string]$script:Failures.Count + " of " + [string]($script:PassCount + $script:Failures.Count))
exit 1
