#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$RunProbe,
    [switch]$CombinedRestartProbe,
    [switch]$ArchiveProbe,
    [ValidateSet("SyncAnchor", "NativeReplacement")]
    [string]$ProbeMode = "SyncAnchor",
    [ValidateRange(30, 180)]
    [int]$TimeoutSeconds = 180,
    [ValidateRange(0, 90)]
    [int]$InspectSeconds = 20,
    [string]$OpenCodePath = "",
    [string]$ExpectedVersion = "2.0.22"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$ProbeName = "sessionport-sync-anchor-public-route-cache"
$NativeProbeName = "sessionport-native-replacement-tui"
$NativeArchiveProbeName = "sessionport-native-replacement-tui-archive"
$ApprovedTempBase = "C:\Users\PC\AppData\Local\Temp\opencode"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
$PluginFile = Join-Path $PSScriptRoot "sync-anchor.tui.tsx"
$GuardFile = Join-Path $PSScriptRoot "route-guard.ts"
$Phase2File = Join-Path $PSScriptRoot "phase2.ts"
$NativeStageDirectoryName = "native-replacement-probe"
$ExpectedPathKeys = @("home", "data", "cache", "config", "state", "tmp", "bin", "log", "repos", "db")
$SupportedVersions = @("2.0.22", "2.1.1")
$ResultLimitBytes = 16384
$NativeResultLimitBytes = 4096
$ManifestLimitBytes = 4096
$script:SafeToDelete = $true
$script:ExitCode = 4
$script:Root = ""
$script:RootCreated = $false
$script:TuiLaunchAttempted = $false
$script:TuiChild = $null
$script:InspectLaunchAttempted = $false
$script:InspectChild = $null
$script:ProbeStage = "start"
$script:ProbeStages = @(
    "start", "preconditions", "create-root", "compile-helper", "build-env", "version",
    "stage-plugin", "debug-capture", "debug-json", "debug-path-map", "debug-isolation",
    "tui-launch", "result", "observation", "phase1-stop", "inspect-manifest",
    "inspect-launch", "inspect-result", "inspect-stop", "cleanup"
)

$ProcessJobSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SessionPortSyncProbe {
  public sealed class CapturedOutput {
    public string Text { get; private set; }
    public bool Overflow { get; private set; }
    internal CapturedOutput(string text, bool overflow) { Text = text; Overflow = overflow; }
  }

  public sealed class ProcessJob : IDisposable {
    public static bool LastStartCleanupVerified { get; private set; }
    private IntPtr job;
    private IntPtr process;
    private IntPtr thread;
    private IntPtr stdoutRead;
    private Task<CapturedOutput> capture;

    private ProcessJob(IntPtr jobHandle, PROCESS_INFORMATION info, IntPtr readHandle, Task<CapturedOutput> captureTask) {
      job = jobHandle;
      process = info.hProcess;
      thread = info.hThread;
      stdoutRead = readHandle;
      capture = captureTask;
    }

    public static ProcessJob Start(string executable, string[] arguments, string workingDirectory, string environmentBlock, bool captureStdout, int outputCap) {
      LastStartCleanupVerified = true;
      IntPtr jobHandle = IntPtr.Zero;
      IntPtr processHandle = IntPtr.Zero;
      IntPtr threadHandle = IntPtr.Zero;
      IntPtr readPipe = IntPtr.Zero;
      IntPtr writePipe = IntPtr.Zero;
      List<IntPtr> inherited = new List<IntPtr>();
      IntPtr attributeList = IntPtr.Zero;
      bool attributeInitialized = false;
      IntPtr handleList = IntPtr.Zero;
      IntPtr startupPointer = IntPtr.Zero;
      IntPtr environmentPointer = IntPtr.Zero;
      bool processCreated = false;
      bool processAssigned = false;
      try {
        jobHandle = CreateJobObjectW(IntPtr.Zero, null);
        if (jobHandle == IntPtr.Zero) throw new InvalidOperationException("job-create");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE keeps every descendant in this owned job.
        limits.BasicLimitInformation.LimitFlags = 0x00002000;
        if (!SetInformationJobObject(jobHandle, 9, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
          throw new InvalidOperationException("job-configure");

        SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
        security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        security.bInheritHandle = true;
        if (captureStdout) {
          if (!CreatePipe(out readPipe, out writePipe, ref security, 0)) throw new InvalidOperationException("stdout-pipe");
          if (!SetHandleInformation(readPipe, 1, 0)) throw new InvalidOperationException("stdout-handle");
          inherited.Add(OpenNull(0x80000000, ref security));
          inherited.Add(writePipe);
          inherited.Add(OpenNull(0x40000000, ref security));
        } else {
          inherited.Add(DuplicateStandardHandle(-10));
          inherited.Add(DuplicateStandardHandle(-11));
          inherited.Add(DuplicateStandardHandle(-12));
        }
        for (int i = 0; i < inherited.Count; i++) {
          if (inherited[i] == IntPtr.Zero || inherited[i] == new IntPtr(-1)) throw new InvalidOperationException("stdio-handle");
        }

        UIntPtr attributeBytes = UIntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
        attributeList = Marshal.AllocHGlobal(checked((int)attributeBytes.ToUInt64()));
        if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes))
          throw new InvalidOperationException("process-attributes");
        attributeInitialized = true;
        handleList = Marshal.AllocHGlobal(IntPtr.Size * inherited.Count);
        for (int i = 0; i < inherited.Count; i++) Marshal.WriteIntPtr(handleList, i * IntPtr.Size, inherited[i]);
        if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(0x00020002), handleList,
          new IntPtr(IntPtr.Size * inherited.Count), IntPtr.Zero, IntPtr.Zero))
          throw new InvalidOperationException("process-handle-list");

        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.StartupInfo.dwFlags = 0x00000100;
        startup.StartupInfo.hStdInput = inherited[0];
        startup.StartupInfo.hStdOutput = inherited[1];
        startup.StartupInfo.hStdError = inherited[2];
        startup.lpAttributeList = attributeList;
        startupPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(STARTUPINFOEX)));
        Marshal.StructureToPtr(startup, startupPointer, false);

        string command = Quote(executable);
        if (arguments != null) {
          for (int i = 0; i < arguments.Length; i++) command += " " + Quote(arguments[i]);
        }
        StringBuilder commandLine = new StringBuilder(command);
        environmentPointer = Marshal.StringToHGlobalUni(environmentBlock);
        PROCESS_INFORMATION info;
        uint flags = 0x00000004 | 0x00000400 | 0x00080000;
        if (!CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags,
          environmentPointer, workingDirectory, startupPointer, out info))
          throw new InvalidOperationException("process-create");
        processCreated = true;
        processHandle = info.hProcess;
        threadHandle = info.hThread;
        if (!AssignProcessToJobObject(jobHandle, processHandle)) {
          throw new InvalidOperationException("job-assign");
        }
        processAssigned = true;
        uint resumed = ResumeThread(threadHandle);
        if (resumed == 0xFFFFFFFF) {
          TerminateJobObject(jobHandle, 137);
          WaitForSingleObject(processHandle, 10000);
          throw new InvalidOperationException("process-resume");
        }

        if (writePipe != IntPtr.Zero) { CloseHandle(writePipe); writePipe = IntPtr.Zero; }
        for (int i = 0; i < inherited.Count; i++) {
          if (inherited[i] != IntPtr.Zero && inherited[i] != new IntPtr(-1)) CloseHandle(inherited[i]);
        }
        inherited.Clear();
        Task<CapturedOutput> captureTask = null;
        if (captureStdout) {
          IntPtr capturedRead = readPipe;
          captureTask = Task.Factory.StartNew<CapturedOutput>(() => Drain(capturedRead, outputCap));
        }
        ProcessJob result = new ProcessJob(jobHandle, info, readPipe, captureTask);
        jobHandle = IntPtr.Zero;
        processHandle = IntPtr.Zero;
        threadHandle = IntPtr.Zero;
        readPipe = IntPtr.Zero;
        return result;
      } catch {
        if (processCreated && processHandle != IntPtr.Zero) {
          if (processAssigned && jobHandle != IntPtr.Zero) {
            bool terminated = TerminateJobObject(jobHandle, 137);
            bool exited = WaitForSingleObject(processHandle, 10000) == 0;
            uint active = UInt32.MaxValue;
            bool queried = ActiveProcesses(jobHandle, out active);
            LastStartCleanupVerified = terminated && exited && queried && active == 0;
          } else {
            bool terminated = TerminateProcess(processHandle, 137);
            bool exited = WaitForSingleObject(processHandle, 10000) == 0;
            LastStartCleanupVerified = terminated && exited;
          }
        }
        if (readPipe != IntPtr.Zero) CloseHandle(readPipe);
        if (writePipe != IntPtr.Zero) CloseHandle(writePipe);
        for (int i = 0; i < inherited.Count; i++) {
          if (inherited[i] != IntPtr.Zero && inherited[i] != new IntPtr(-1)) CloseHandle(inherited[i]);
        }
        if (threadHandle != IntPtr.Zero) CloseHandle(threadHandle);
        if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
        if (jobHandle != IntPtr.Zero) CloseHandle(jobHandle);
        throw;
      } finally {
        if (environmentPointer != IntPtr.Zero) Marshal.FreeHGlobal(environmentPointer);
        if (startupPointer != IntPtr.Zero) Marshal.FreeHGlobal(startupPointer);
        if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
        if (attributeList != IntPtr.Zero) {
          if (attributeInitialized) DeleteProcThreadAttributeList(attributeList);
          Marshal.FreeHGlobal(attributeList);
        }
      }
    }

    public bool Wait(int milliseconds) {
      if (process == IntPtr.Zero) return false;
      return WaitForSingleObject(process, (uint)milliseconds) == 0;
    }

    public bool HasExited() {
      if (process == IntPtr.Zero) return true;
      return WaitForSingleObject(process, 0) == 0;
    }

    public int ExitCode() {
      uint code;
      if (process == IntPtr.Zero || !GetExitCodeProcess(process, out code)) return -1;
      return unchecked((int)code);
    }

    public CapturedOutput ReadCapture(int milliseconds) {
      if (capture == null || !capture.Wait(milliseconds)) return null;
      return capture.Result;
    }

    public bool StopAndVerify(int timeoutMilliseconds) {
      if (job == IntPtr.Zero || process == IntPtr.Zero) return false;
      uint initialActive;
      if (!ActiveProcesses(job, out initialActive)) return false;
      if (initialActive > 0 && !TerminateJobObject(job, 137)) return false;
      if (WaitForSingleObject(process, (uint)timeoutMilliseconds) != 0) return false;
      DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
      uint active;
      do {
        if (!ActiveProcesses(job, out active)) return false;
        if (active == 0) return true;
        Thread.Sleep(50);
      } while (DateTime.UtcNow < deadline);
      return false;
    }

    public void Dispose() {
      if (capture != null) capture.Wait(1000);
      if (stdoutRead != IntPtr.Zero) { CloseHandle(stdoutRead); stdoutRead = IntPtr.Zero; }
      if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
      if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
      if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    }

    private static CapturedOutput Drain(IntPtr handle, int cap) {
      using (MemoryStream output = new MemoryStream()) {
        byte[] buffer = new byte[4096];
        bool overflow = false;
        while (true) {
          uint read;
          bool ok = ReadFile(handle, buffer, (uint)buffer.Length, out read, IntPtr.Zero);
          if (!ok || read == 0) break;
          int remaining = cap - (int)output.Length;
          if (remaining > 0) output.Write(buffer, 0, (int)Math.Min((uint)remaining, read));
          if (read > (uint)Math.Max(0, remaining)) overflow = true;
        }
        return new CapturedOutput(Encoding.UTF8.GetString(output.ToArray()), overflow);
      }
    }

    private static IntPtr OpenNull(uint access, ref SECURITY_ATTRIBUTES security) {
      return CreateFileW("NUL", access, 3, ref security, 3, 0x00000080, IntPtr.Zero);
    }

    private static IntPtr DuplicateStandardHandle(int which) {
      IntPtr source = GetStdHandle(which);
      if (source == IntPtr.Zero || source == new IntPtr(-1)) return IntPtr.Zero;
      IntPtr duplicate;
      if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out duplicate, 0, true, 2)) return IntPtr.Zero;
      return duplicate;
    }

    private static bool ActiveProcesses(IntPtr jobHandle, out uint active) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
      bool ok = QueryInformationJobObject(jobHandle, 1, ref info,
        (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero);
      active = info.ActiveProcesses;
      return ok;
    }

    private static string Quote(string value) {
      if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
      StringBuilder result = new StringBuilder();
      result.Append('"');
      int slashes = 0;
      for (int i = 0; i < value.Length; i++) {
        char c = value[i];
        if (c == '\\') { slashes++; continue; }
        if (c == '"') {
          result.Append('\\', slashes * 2 + 1);
          result.Append('"');
          slashes = 0;
          continue;
        }
        result.Append('\\', slashes);
        slashes = 0;
        result.Append(c);
      }
      result.Append('\\', slashes * 2);
      result.Append('"');
      return result.ToString();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO { public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle; public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime; public uint TotalPageFaults; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, IntPtr startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ReadFile(IntPtr file, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern void DeleteProcThreadAttributeList(IntPtr list);
  }
}
'@

function Test-UnderRoot {
    param([string]$Child, [string]$Root)
    if ([string]::IsNullOrWhiteSpace($Child) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
    try {
        $childFull = [System.IO.Path]::GetFullPath($Child)
        $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
        if ($childFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        return $childFull.StartsWith(($rootFull + '\'), [System.StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Test-PhysicalDirectoryChain {
    param([string]$Path)
    try {
        $cursor = [System.IO.DirectoryInfo]::new([System.IO.Path]::GetFullPath($Path))
        while ($null -ne $cursor) {
            if (-not $cursor.Exists) { return $false }
            if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            $cursor = $cursor.Parent
        }
        return $true
    } catch { return $false }
}

function Resolve-OpenCodeExe {
    param([string]$RequestedPath)
    $candidate = $RequestedPath
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $commands = @(Get-Command -Name "opencode.exe" -CommandType Application -ErrorAction SilentlyContinue)
        if ($commands.Count -gt 0) { $candidate = [string]$commands[0].Source }
    }
    if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return "" }
    try { $resolved = (Resolve-Path -LiteralPath $candidate).Path } catch { return "" }
    if ([System.IO.Path]::GetExtension($resolved).ToLowerInvariant() -ne ".exe") { return "" }
    return $resolved
}

function Get-ObservedOpenCodeVersion {
    param([string]$Text)
    $clean = [System.Text.RegularExpressions.Regex]::Replace([string]$Text, "\x1B\[[0-9;]*[A-Za-z]", "")
    $found = @([System.Text.RegularExpressions.Regex]::Matches($clean, '(?m)(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)') |
        ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
    if ($found.Count -ne 1) { return "" }
    return [string]$found[0]
}

function New-ProbeEnvironmentBlock {
    param(
        [string]$Root,
        [string]$Executable,
        [string]$Phase = "probe",
        [string]$ResultPath = "",
        [string]$ManifestPath = "",
        [switch]$ArchiveProbe
    )
    $rootFull = [System.IO.Path]::GetFullPath($Root)
    $driveRoot = [System.IO.Path]::GetPathRoot($rootFull)
    $homeDirectory = Join-Path $rootFull "home"
    $systemRoot = [string]$env:SystemRoot
    $exeDirectory = Split-Path -Parent $Executable
    if ([string]::IsNullOrWhiteSpace($ResultPath)) { $ResultPath = Join-Path $rootFull "results\probe-result.json" }
    $values = [ordered]@{
        "APPDATA" = (Join-Path $homeDirectory "AppData\Roaming")
        "COMSPEC" = (Join-Path $systemRoot "System32\cmd.exe")
        "HOMEDRIVE" = $driveRoot.TrimEnd('\')
        "HOMEPATH" = $rootFull.Substring($driveRoot.Length - 1)
        "HOME" = $homeDirectory
        "LOCALAPPDATA" = (Join-Path $homeDirectory "AppData\Local")
        "OPENCODE_CLI_CONFIG_CONTENT" = '{"debug":{"devtools":false,"timing":false,"turn_tokens":false}}'
        "OPENCODE_CONFIG_DIR" = (Join-Path $rootFull "config")
        "PATH" = ((Join-Path $systemRoot "System32") + ";" + $exeDirectory)
        "SP_PROBE_PHASE" = $Phase
        "SP_PROBE_PROJECT" = (Join-Path $rootFull "project")
        "SP_PROBE_RESULT" = $ResultPath
        "SP_PROBE_ROOT" = $rootFull
        "SystemDrive" = $driveRoot.TrimEnd('\')
        "SystemRoot" = $systemRoot
        "TEMP" = (Join-Path $rootFull "tmp")
        "TMP" = (Join-Path $rootFull "tmp")
        "TMPDIR" = (Join-Path $rootFull "tmp")
        "USERPROFILE" = $homeDirectory
        "WINDIR" = $systemRoot
        "XDG_CACHE_HOME" = (Join-Path $rootFull "cache")
        "XDG_CONFIG_HOME" = (Join-Path $rootFull "config")
        "XDG_DATA_HOME" = (Join-Path $rootFull "data")
        "XDG_STATE_HOME" = (Join-Path $rootFull "state")
    }
    if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) { $values["SP_PROBE_MANIFEST"] = $ManifestPath }
    if ($ArchiveProbe) { $values["SP_PROBE_ARCHIVE"] = "1" }
    $entries = New-Object System.Collections.Generic.List[string]
    foreach ($key in @($values.Keys | Sort-Object -CaseSensitive)) {
        $entries.Add(([string]$key + "=" + [string]$values[$key]))
    }
    return (($entries -join [char]0) + [char]0 + [char]0)
}

function Start-ProbeChild {
    param(
        [string]$Executable,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [string]$EnvironmentBlock,
        [switch]$CaptureStdout
    )
    try {
        return [SessionPortSyncProbe.ProcessJob]::Start(
            $Executable,
            $Arguments,
            $WorkingDirectory,
            $EnvironmentBlock,
            [bool]$CaptureStdout,
            65536
        )
    } catch {
        if (-not [SessionPortSyncProbe.ProcessJob]::LastStartCleanupVerified) { $script:SafeToDelete = $false }
        throw
    }
}

function Initialize-ProcessJobHelper {
    $tempNames = @("TEMP", "TMP", "TMPDIR")
    $original = @{}
    foreach ($name in $tempNames) {
        $original[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, (Join-Path $script:Root "tmp"), "Process")
    }
    try {
        $helperType = [System.Management.Automation.PSTypeName]"SessionPortSyncProbe.ProcessJob"
        if ($null -eq $helperType.Type) {
            Add-Type -TypeDefinition $ProcessJobSource -Language CSharp -ErrorAction Stop
        }
    } finally {
        foreach ($name in $tempNames) {
            [Environment]::SetEnvironmentVariable($name, $original[$name], "Process")
        }
    }
}

function Stop-ProbeChild {
    param([object]$Child, [int]$TimeoutMilliseconds = 10000)
    if ($null -eq $Child) { return $true }
    try { return [bool]$Child.StopAndVerify($TimeoutMilliseconds) } catch { return $false }
}

function Invoke-BoundedCapture {
    param(
        [string]$Executable,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [string]$EnvironmentBlock,
        [int]$TimeoutMilliseconds
    )
    $child = $null
    $text = $null
    $code = -1
    try {
        $child = Start-ProbeChild -Executable $Executable -Arguments $Arguments -WorkingDirectory $WorkingDirectory -EnvironmentBlock $EnvironmentBlock -CaptureStdout
        if (-not $child.Wait($TimeoutMilliseconds)) { throw "bounded-child-timeout" }
        $capture = $child.ReadCapture(3000)
        if ($null -eq $capture -or $capture.Overflow) { throw "bounded-child-output-invalid" }
        $text = [string]$capture.Text
        $code = [int]$child.ExitCode()
        if ($code -ne 0) { throw "bounded-child-exit" }
    } finally {
        if (-not (Stop-ProbeChild -Child $child)) { $script:SafeToDelete = $false }
        if ($null -ne $child) { try { $child.Dispose() } catch { $script:SafeToDelete = $false } }
    }
    if (-not $script:SafeToDelete) { throw "bounded-child-stop-unverified" }
    return $text
}

function ConvertFrom-DebugPathsText {
    param([string]$Text)
    $clean = [System.Text.RegularExpressions.Regex]::Replace([string]$Text, "\x1B\[[0-9;]*[A-Za-z]", "")
    $trimmed = $clean.Trim().TrimStart([char]0xFEFF)
    if ([string]::IsNullOrWhiteSpace($trimmed)) { throw "debug-paths-output-empty" }

    if ($trimmed.StartsWith("{")) {
        try { $document = $trimmed | ConvertFrom-Json -ErrorAction Stop } catch { throw "debug-paths-json-invalid" }
        if ($document -isnot [System.Management.Automation.PSCustomObject]) { throw "debug-paths-json-shape" }
        $entries = [ordered]@{}
        foreach ($property in $document.PSObject.Properties) {
            if ($entries.Contains([string]$property.Name)) { throw "debug-paths-json-duplicate" }
            $entries.Add([string]$property.Name, $property.Value)
        }
        return [pscustomobject]@{ Format = "json"; Entries = $entries }
    }
    if ($trimmed.StartsWith("[")) { throw "debug-paths-format-unsupported" }

    # Verified 2.0.22 format: each key is padded to ten characters, followed by one
    # space and the absolute path, one entry per line. Reject anything else.
    $lines = @($clean -split "\r?\n")
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq "") {
        $lines = @($lines | Select-Object -First ($lines.Count - 1))
    }
    if ($lines.Count -eq 0) { throw "debug-paths-output-empty" }
    $entries = [ordered]@{}
    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { throw "debug-paths-table-blank" }
        if ($line.Length -lt 12) { throw "debug-paths-table-short" }
        $field = $line.Substring(0, 10)
        if ($field -notmatch '^[a-z]+ +$') { throw "debug-paths-table-field" }
        if ($line[10] -ne [char]32) { throw "debug-paths-table-separator" }
        $key = $field.TrimEnd()
        $value = $line.Substring(11)
        if ([string]::IsNullOrWhiteSpace($value)) { throw "debug-paths-table-value" }
        if ($value[0] -eq '"' -or $value[0] -eq "'") { throw "debug-paths-table-quoted" }
        if ($entries.Contains($key)) { throw "debug-paths-table-duplicate" }
        $entries.Add($key, $value)
    }
    return [pscustomobject]@{ Format = "table"; Entries = $entries }
}

function Get-DebugPathMap {
    param([object]$Document)
    if ($null -eq $Document -or $null -eq $Document.Entries) { throw "debug-paths-document-invalid" }
    $entries = $Document.Entries
    foreach ($name in @($entries.Keys)) {
        if ([string]$name -notin $ExpectedPathKeys) { throw "debug-paths-key-unknown" }
        $value = $entries[$name]
        if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$value)) { throw "debug-paths-value-invalid" }
    }
    $map = @{}
    foreach ($key in $ExpectedPathKeys) {
        if (-not $entries.Contains($key)) { throw "debug-paths-key-missing" }
        $map[$key] = ([string]$entries[$key]).Trim('"', "'")
    }
    return $map
}

function Get-SafeProbeResult {
    param([object]$Raw, [string]$ExpectedVersion)
    if ($null -eq $Raw -or [string]$Raw.probe -ne $ProbeName) { throw "probe-result-shape-invalid" }
    $stage = [string]$Raw.stage
    if ($stage -notin @("isolation-gate", "capability-gate", "inspection-capability", "inspection-manifest", "inspection-readback", "inspection-cache", "inspection-route", "anchor-import", "initial-anchor-route", "child-imports", "cache-refresh", "root-route-selection", "tabs-route-selection", "complete")) {
        $stage = "unknown"
    }
    $knownFailures = @(
        "isolation-gate-failed", "public-client-capability-missing", "anchor-seed-readback-mismatch", "anchor-cache-not-ready",
        "route-redirect-loop-guard", "initial-anchor-route-not-observed", "public-readback-verification-failed",
        "head-cache-not-ready", "root-route-did-not-reach-head", "tab-focus-did-not-reach-head",
        "tab-home-route-not-observed", "native-session-route-not-ready", "probe-runtime-error",
        "inspection-manifest-invalid", "inspection-readback-mismatch", "inspection-cache-not-ready",
        "inspection-route-not-observed", "inspection-runtime-error"
    )
    $failure = $null
    if ($null -ne $Raw.failure) {
        $failure = if ([string]$Raw.failure -in $knownFailures) { [string]$Raw.failure } else { "unknown" }
    }
    $phase = if ([string]$Raw.phase -in @("probe", "inspect")) { [string]$Raw.phase } else { "probe" }
    $tabResult = [string]$Raw.tabs.result
    if ($tabResult -notin @("passed", "skipped-disabled", "failed", "not-tested")) { $tabResult = "failed" }
    return [pscustomobject]@{
        probe = $ProbeName
        phase = $phase
        ok = ($Raw.ok -is [bool] -and $Raw.ok)
        stage = $stage
        failure = $failure
        imports = [pscustomobject]@{
            attempted = [Math]::Min(3, [Math]::Max(0, [int]$Raw.imports.attempted))
            returned = [Math]::Min(3, [Math]::Max(0, [int]$Raw.imports.returned))
        }
        anchor = [pscustomobject]@{
            originalPreserved = ($Raw.anchor.originalPreserved -is [bool] -and $Raw.anchor.originalPreserved)
            messageCount = $(if ($null -eq $Raw.anchor.messageCount) { $null } else { [Math]::Min(50, [Math]::Max(0, [int]$Raw.anchor.messageCount)) })
            rootCount = $(if ($null -eq $Raw.anchor.rootCount) { $null } else { [Math]::Min(50, [Math]::Max(0, [int]$Raw.anchor.rootCount)) })
            initialRouteObserved = ($Raw.anchor.initialRouteObserved -is [bool] -and $Raw.anchor.initialRouteObserved)
            initialCacheReady = ($Raw.anchor.initialCacheReady -is [bool] -and $Raw.anchor.initialCacheReady)
            initialCacheMessageCount = $(if ($null -eq $Raw.anchor.initialCacheMessageCount) { $null } else { [Math]::Min(50, [Math]::Max(0, [int]$Raw.anchor.initialCacheMessageCount)) })
        }
        children = [pscustomobject]@{
            count = [Math]::Min(2, [Math]::Max(0, [int]$Raw.children.count))
            retained = ($Raw.children.retained -is [bool] -and $Raw.children.retained)
            messagesSettled = ($Raw.children.messagesSettled -is [bool] -and $Raw.children.messagesSettled)
        }
        cache = [pscustomobject]@{
            refreshed = ($Raw.cache.refreshed -is [bool] -and $Raw.cache.refreshed)
            messageCount = $(if ($null -eq $Raw.cache.messageCount) { $null } else { [Math]::Min(50, [Math]::Max(0, [int]$Raw.cache.messageCount)) })
        }
        route = [pscustomobject]@{
            redirects = [Math]::Min(10, [Math]::Max(0, [int]$Raw.route.redirects))
            rootSelectionReachedHead = ($Raw.route.rootSelectionReachedHead -is [bool] -and $Raw.route.rootSelectionReachedHead)
            tabFocusReachedHead = $(if ($null -eq $Raw.route.tabFocusReachedHead) { $null } else { ($Raw.route.tabFocusReachedHead -is [bool] -and $Raw.route.tabFocusReachedHead) })
        }
        tabs = [pscustomobject]@{
            enabled = ($Raw.tabs.enabled -is [bool] -and $Raw.tabs.enabled)
            result = $tabResult
        }
        renderReadiness = [pscustomobject]@{
            nativeSessionRouteObserved = ($Raw.renderReadiness.nativeSessionRouteObserved -is [bool] -and $Raw.renderReadiness.nativeSessionRouteObserved)
            messageCacheReady = ($Raw.renderReadiness.messageCacheReady -is [bool] -and $Raw.renderReadiness.messageCacheReady)
            composerObserved = $false
            ordinaryContinuation = "not-tested"
        }
        expectedVersion = $ExpectedVersion
    }
}

function Get-NativeReplacementStageSet {
    # Fixed native-replacement artifact resolution. Only the reviewed bundle location and
    # the known new-source entry (plus one whitelisted fixture helper) are eligible; no
    # caller-supplied path, glob, or whole-project scan is accepted.
    param([string]$ProjectRoot)
    $bundle = Join-Path $ProjectRoot ".package-verify-work\m1-native-tui-plugin-20261024\tui.tsx"
    $source = Join-Path $ProjectRoot "scripts\host-probes\native-replacement\tui\tui.tsx"
    $fixture = Join-Path $ProjectRoot "scripts\host-probes\native-replacement\tui\fixtures.ts"
    $files = New-Object System.Collections.Generic.List[object]
    $entry = ""
    if (Test-Path -LiteralPath $bundle -PathType Leaf) {
        $entry = $bundle
    } elseif (Test-Path -LiteralPath $source -PathType Leaf) {
        $entry = $source
    }
    if (-not [string]::IsNullOrWhiteSpace($entry)) {
        $files.Add([pscustomobject]@{ Source = $entry; Name = "tui.tsx" })
        if ($entry -eq $source -and (Test-Path -LiteralPath $fixture -PathType Leaf)) {
            $files.Add([pscustomobject]@{ Source = $fixture; Name = "fixtures.ts" })
        }
    }
    return [pscustomobject]@{
        Ready = ($files.Count -ge 1)
        EntrySource = $entry
        Files = $files.ToArray()
    }
}

function Get-SafeNativeProbeResult {
    # Exact native-replacement result allowlist. Unknown stage/reason values are downgraded
    # to fixed failed/internal labels; extra keys, IDs, message content, and arbitrary
    # strings never survive. A pass requires the complete 2/2/3 history plus observed
    # parentless and native-route evidence. Pixels, archive, composer, and picker are never
    # claimed here.
    param([object]$Raw)
    if ($null -eq $Raw -or [string]$Raw.probe -ne $NativeProbeName) { throw "native-probe-result-shape-invalid" }
    if ($null -eq $Raw.version -or [int]$Raw.version -ne 1) { throw "native-probe-result-version-invalid" }
    $stage = [string]$Raw.stage
    if ($stage -notin @("preflight", "import-old", "import-candidate", "verify-history", "navigate", "complete", "failed")) {
        $stage = "failed"
    }
    $reason = [string]$Raw.reason
    if ($reason -notin @("none", "isolation", "capability", "import", "history", "navigation", "internal")) {
        $reason = "internal"
    }
    $imported = if ($null -eq $Raw.importedCount) { 0 } else { [Math]::Min(2, [Math]::Max(0, [int]$Raw.importedCount)) }
    $oldCount = if ($null -eq $Raw.oldMessageCount) { 0 } else { [Math]::Min(3, [Math]::Max(0, [int]$Raw.oldMessageCount)) }
    $candidateCount = if ($null -eq $Raw.candidateMessageCount) { 0 } else { [Math]::Min(4, [Math]::Max(0, [int]$Raw.candidateMessageCount)) }
    $routeObserved = ($Raw.nativeRouteObserved -is [bool] -and $Raw.nativeRouteObserved)
    $parentless = ($Raw.parentlessVerified -is [bool] -and $Raw.parentlessVerified)
    $rawOk = ($Raw.ok -is [bool] -and $Raw.ok)
    $complete = $stage -eq "complete" -and $reason -eq "none" -and $imported -eq 2 -and $oldCount -eq 2 -and
        $candidateCount -eq 3 -and $parentless -and $routeObserved
    return [pscustomobject]@{
        probe = $NativeProbeName
        version = 1
        ok = ($rawOk -and $complete)
        stage = $stage
        reason = $reason
        importedCount = $imported
        oldMessageCount = $oldCount
        candidateMessageCount = $candidateCount
        nativeRouteObserved = $routeObserved
        parentlessVerified = $parentless
        archiveNotTested = $true
        composerNotTested = $true
        pickerNotTested = $true
    }
}

function Get-SafeNativeArchiveProbeResult {
    # Archive-v2 fixed schema. Extra keys, IDs, content, paths, and arbitrary strings
    # never survive. A pass requires archive+recovery evidence, not a 204 response.
    param([object]$Raw)
    if ($null -eq $Raw -or [string]$Raw.probe -ne $NativeArchiveProbeName) { throw "native-archive-result-shape-invalid" }
    if ($null -eq $Raw.version -or [int]$Raw.version -ne 2) { throw "native-archive-result-version-invalid" }
    $stage = [string]$Raw.stage
    if ($stage -notin @("preflight", "import-old", "import-candidate", "verify-history", "archive", "verify-archive", "navigate", "recovery", "verify-recovery", "complete", "failed")) {
        $stage = "failed"
    }
    $reason = [string]$Raw.reason
    if ($reason -notin @("none", "isolation", "capability", "import", "history", "archive", "navigation", "recovery", "internal")) {
        $reason = "internal"
    }
    $imported = if ($null -eq $Raw.importedCount) { 0 } else { [Math]::Min(2, [Math]::Max(0, [int]$Raw.importedCount)) }
    $oldCount = if ($null -eq $Raw.oldMessageCount) { 0 } else { [Math]::Min(3, [Math]::Max(0, [int]$Raw.oldMessageCount)) }
    $candidateCount = if ($null -eq $Raw.candidateMessageCount) { 0 } else { [Math]::Min(4, [Math]::Max(0, [int]$Raw.candidateMessageCount)) }
    $routeObserved = ($Raw.nativeRouteObserved -is [bool] -and $Raw.nativeRouteObserved)
    $parentless = ($Raw.parentlessVerified -is [bool] -and $Raw.parentlessVerified)
    $archiveCall = [string]$Raw.archiveCall
    if ($archiveCall -notin @("not-attempted", "accepted", "error", "unsupported")) { $archiveCall = "not-attempted" }
    $archiveReadback = [string]$Raw.archiveReadback
    if ($archiveReadback -notin @("active", "archived", "unknown", "not-read")) { $archiveReadback = "unknown" }
    $recoveryReadback = [string]$Raw.recoveryReadback
    if ($recoveryReadback -notin @("active", "archived", "unknown", "not-read")) { $recoveryReadback = "unknown" }
    $recoveryVerified = ($Raw.recoveryVerified -is [bool] -and $Raw.recoveryVerified)
    $mutationOldOnly = ($Raw.mutationTargetOldOnly -is [bool] -and $Raw.mutationTargetOldOnly)
    $archiveNotTested = $true
    if ($Raw.archiveNotTested -is [bool] -and $Raw.archiveNotTested -eq $false -and $archiveCall -in @("accepted", "error")) {
        $archiveNotTested = $false
    }
    $rawOk = ($Raw.ok -is [bool] -and $Raw.ok)
    $complete = $stage -eq "complete" -and $reason -eq "none" -and $imported -eq 2 -and $oldCount -eq 2 -and
        $candidateCount -eq 3 -and $parentless -and $routeObserved -and $archiveReadback -eq "archived" -and
        (-not $archiveNotTested) -and $recoveryReadback -eq "active" -and $recoveryVerified -and $mutationOldOnly
    return [pscustomobject]@{
        probe = $NativeArchiveProbeName
        version = 2
        ok = ($rawOk -and $complete)
        stage = $stage
        reason = $reason
        importedCount = $imported
        oldMessageCount = $oldCount
        candidateMessageCount = $candidateCount
        nativeRouteObserved = $routeObserved
        parentlessVerified = $parentless
        archiveNotTested = $archiveNotTested
        composerNotTested = $true
        pickerNotTested = $true
        archiveCall = $archiveCall
        archiveReadback = $archiveReadback
        recoveryReadback = $recoveryReadback
        recoveryVerified = $recoveryVerified
        mutationTargetOldOnly = $mutationOldOnly
    }
}

function Test-RootDeletionSet {
    param([string]$Root)
    if (-not (Test-PhysicalDirectoryChain -Path $Root)) { return [pscustomobject]@{ Ok = $false; Count = 0 } }
    $pending = New-Object System.Collections.Generic.Stack[string]
    $pending.Push([System.IO.Path]::GetFullPath($Root))
    $count = 0
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        try { $items = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) } catch { return [pscustomobject]@{ Ok = $false; Count = $count } }
        foreach ($item in $items) {
            $count++
            if (-not (Test-UnderRoot -Child $item.FullName -Root $Root)) { return [pscustomobject]@{ Ok = $false; Count = $count } }
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return [pscustomobject]@{ Ok = $false; Count = $count } }
            if (($item.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0) { $pending.Push($item.FullName) }
        }
    }
    return [pscustomobject]@{ Ok = $true; Count = $count }
}

function Remove-ProbeRootSafely {
    param([string]$Root)
    $check = Test-RootDeletionSet -Root $Root
    if (-not $check.Ok) { return $false }
    Write-Host ("cleanup-targets: verified=" + [string]$check.Count + " within disposable root; no reparse points")
    try {
        Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction Stop
        return (-not (Test-Path -LiteralPath $Root))
    } catch { return $false }
}

function Get-SafeProbeStage {
    param([string]$Stage)
    try {
        $stages = $script:ProbeStages
        if ($null -ne $stages -and $Stage -in $stages) { return $Stage }
    } catch { }
    return "unknown"
}

function Get-CombinedProbeGate {
    param(
        [bool]$Phase1ResultOk,
        [bool]$Phase1StopVerified,
        [bool]$Phase2Started,
        [bool]$Phase2StopVerified
    )
    return [pscustomobject]@{
        LaunchPhase2 = $Phase1ResultOk -and $Phase1StopVerified
        DeleteRoot = $Phase1StopVerified -and ((-not $Phase2Started) -or $Phase2StopVerified)
        RetryAllowed = $false
    }
}

function Get-SafeFailureCategory {
    param([object]$ErrorRecord)
    try {
        if ($null -eq $ErrorRecord -or $null -eq $ErrorRecord.Exception) { return "no-exception" }
        $exception = $ErrorRecord.Exception
        $typeName = [string]$exception.GetType().Name
        if ($typeName -eq "COMException" -or $typeName -eq "ExternalException") {
            $code = [int64]$exception.HResult -band [int64]4294967295
            return ("hresult-0x" + $code.ToString("X8"))
        }
        if ($typeName -match '^[A-Za-z][A-Za-z0-9]{0,63}$') { return $typeName }
        return "unclassified-exception"
    } catch {
        return "unclassified-exception"
    }
}

function Invoke-NativeReplacementValidationOnly {
    $failures = New-Object System.Collections.Generic.List[string]
    $stageSet = Get-NativeReplacementStageSet -ProjectRoot $ProjectRoot
    if (-not $stageSet.Ready) {
        $failures.Add("native-replacement plugin artifact is missing at the fixed bundle/source path (.package-verify-work/m1-native-tui-plugin-20261024/tui.tsx or scripts/host-probes/native-replacement/tui/tui.tsx)")
    } else {
        foreach ($file in @($stageSet.Files)) {
            $name = [string]$file.Name
            if ($name -notin @("tui.tsx", "fixtures.ts")) { $failures.Add("native-replacement staging name is not allowlisted") }
            if ($name -match '[\\/]') { $failures.Add("native-replacement staging name contains a path separator") }
            $source = [string]$file.Source
            if ([string]::IsNullOrWhiteSpace($source) -or -not (Test-Path -LiteralPath $source -PathType Leaf)) {
                $failures.Add("native-replacement staged source is missing")
                continue
            }
            $item = Get-Item -LiteralPath $source -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                $failures.Add("native-replacement staged source is a reparse point")
            }
            if ($item.Length -le 0) { $failures.Add("native-replacement staged source is empty") }
        }
        $entryText = [System.IO.File]::ReadAllText([string]$stageSet.EntrySource)
        foreach ($marker in @("sessionport-native-replacement-tui", "SP_PROBE_RESULT")) {
            if (-not $entryText.Contains($marker)) { $failures.Add("native-replacement plugin marker missing: " + $marker) }
        }
        if ($ArchiveProbe) {
            foreach ($marker in @("sessionport-native-replacement-tui-archive", "SP_PROBE_ARCHIVE", "archiveNotTested", "recoveryVerified", "mutationTargetOldOnly")) {
                if (-not $entryText.Contains($marker)) { $failures.Add("native-replacement archive marker missing: " + $marker) }
            }
        }
        $scriptText = [System.IO.File]::ReadAllText($PSCommandPath)
        foreach ($marker in @("CreateProcessW", "AssignProcessToJobObject", "TerminateJobObject", "StopAndVerify", "KILL", "SP_PROBE_RESULT")) {
            if (-not $scriptText.Contains($marker)) { $failures.Add("native-replacement process-safety marker missing: " + $marker) }
        }
    }
    if ($failures.Count -gt 0) {
        foreach ($failure in $failures) { Write-Host ("VALIDATION-FAILED: " + $failure) }
        return 1
    }
    Write-Host ("EXPECTED-VERSION: " + $ExpectedVersion)
    Write-Host "VALIDATION-OK"
    Write-Host "RUN-NOT-STARTED: pass -RunProbe only after parent and host-safety review."
    return 0
}

function Invoke-ValidationOnly {
    if ($ProbeMode -eq "NativeReplacement") { return (Invoke-NativeReplacementValidationOnly) }
    $failures = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path -LiteralPath $PluginFile -PathType Leaf)) { $failures.Add("probe plugin is missing") }
    if (-not (Test-Path -LiteralPath $GuardFile -PathType Leaf)) { $failures.Add("route guard module is missing") }
    if (-not (Test-Path -LiteralPath $Phase2File -PathType Leaf)) { $failures.Add("phase2 inspection helper is missing") }
    if ($failures.Count -eq 0) {
        $pluginText = [System.IO.File]::ReadAllText($PluginFile)
        $guardText = [System.IO.File]::ReadAllText($GuardFile)
        $phase2Text = [System.IO.File]::ReadAllText($Phase2File)
        $scriptText = [System.IO.File]::ReadAllText($PSCommandPath)
        foreach ($marker in @("Plugin.define", "context.client.session.import", "context.data.session.message.sync", "context.ui.router.navigate", "context.ui.tabs.focus", "SP_PROBE_PHASE")) {
            if (-not $pluginText.Contains($marker)) { $failures.Add("plugin marker missing: " + $marker) }
        }
        foreach ($marker in @("parseInspectionManifest", "validateInspectionGraph")) {
            if (-not $phase2Text.Contains($marker)) { $failures.Add("phase2 marker missing: " + $marker) }
        }
        foreach ($marker in @("500", "10", "blocked")) {
            if (-not $guardText.Contains($marker)) { $failures.Add("route-guard marker missing: " + $marker) }
        }
        foreach ($marker in @("CreateProcessW", "AssignProcessToJobObject", "TerminateJobObject", "StopAndVerify", "KILL")) {
            if (-not $scriptText.Contains($marker)) { $failures.Add("process-safety marker missing: " + $marker) }
        }
    }
    if ($failures.Count -gt 0) {
        foreach ($failure in $failures) { Write-Host ("VALIDATION-FAILED: " + $failure) }
        return 1
    }
    Write-Host ("EXPECTED-VERSION: " + $ExpectedVersion)
    Write-Host "VALIDATION-OK"
    Write-Host "RUN-NOT-STARTED: pass -RunProbe only after parent and host-safety review."
    return 0
}

function Invoke-Probe {
    $script:SafeToDelete = $true
    $script:ExitCode = 4
    $script:Root = ""
    $script:RootCreated = $false
    $script:TuiLaunchAttempted = $false
    $script:TuiChild = $null
    $script:InspectLaunchAttempted = $false
    $script:InspectChild = $null
    $rootRemoved = $false
    $tuiStopVerified = $false
    $inspectStopVerified = $true
    $inspectStarted = $false
    $result = $null
    $inspectResult = $null
    try {
        $script:ProbeStage = "preconditions"
        if ($env:OS -ne "Windows_NT") { throw "windows-required" }
        if ($ProbeMode -eq "NativeReplacement" -and $CombinedRestartProbe) { throw "combined-restart-probe-not-supported" }
        if ($ArchiveProbe -and $ProbeMode -ne "NativeReplacement") { throw "archive-probe-requires-native-replacement" }
        if ($ArchiveProbe -and $InspectSeconds -lt 90) { throw "archive-observation-window-too-short" }
        if (-not (Test-PhysicalDirectoryChain -Path $ApprovedTempBase)) { throw "approved-temp-base-missing-or-redirected" }
        $executable = Resolve-OpenCodeExe -RequestedPath $OpenCodePath
        if ([string]::IsNullOrWhiteSpace($executable)) { throw "installed-opencode-exe-not-found" }

        $script:ProbeStage = "create-root"
        $suffix = [guid]::NewGuid().ToString("N")
        $rootPrefix = if ($ProbeMode -eq "NativeReplacement") { "native-replacement-" } else { "sync-anchor-" }
        $pluginStageName = if ($ProbeMode -eq "NativeReplacement") { $NativeStageDirectoryName } else { "sync-anchor-probe" }
        $script:Root = Join-Path $ApprovedTempBase ($rootPrefix + $suffix)
        if (Test-Path -LiteralPath $script:Root) { throw "generated-root-already-exists" }
        $directories = @(
            "cache", "config", ("config\plugins\" + $pluginStageName), "data", "db", "home",
            "home\AppData\Local", "home\AppData\Roaming", "log", "project", "repos", "results", "state", "tmp", "bin"
        )
        New-Item -ItemType Directory -Path $script:Root -ErrorAction Stop | Out-Null
        $script:RootCreated = $true
        foreach ($directory in $directories) {
            New-Item -ItemType Directory -Path (Join-Path $script:Root $directory) -ErrorAction Stop | Out-Null
        }
        if (-not (Test-PhysicalDirectoryChain -Path $script:Root)) { throw "created-root-path-gate-failed" }
        $script:ProbeStage = "compile-helper"
        Initialize-ProcessJobHelper

        $script:ProbeStage = "build-env"
        $projectDirectory = Join-Path $script:Root "project"
        $resultFile = Join-Path $script:Root "results\probe-result.json"
        $manifestFile = Join-Path $script:Root "results\probe-manifest.json"
        $inspectResultFile = Join-Path $script:Root "results\probe-inspect-result.json"
        $environmentBlock = New-ProbeEnvironmentBlock -Root $script:Root -Executable $executable -Phase "probe" -ResultPath $resultFile -ManifestPath $(if ($CombinedRestartProbe) { $manifestFile } else { "" }) -ArchiveProbe:$ArchiveProbe

        $script:ProbeStage = "version"
        Write-Host "preflight: isolated process environment created; no inherited provider credential variables"
        $versionText = Invoke-BoundedCapture -Executable $executable -Arguments @("--version") -WorkingDirectory $projectDirectory -EnvironmentBlock $environmentBlock -TimeoutMilliseconds 30000
        $observedVersion = Get-ObservedOpenCodeVersion -Text $versionText
        if ([string]::IsNullOrWhiteSpace($observedVersion) -or $observedVersion -ne $ExpectedVersion) {
            throw "installed-version-does-not-equal-expected"
        }
        Write-Host ("preflight: installed-version=" + $observedVersion + " expected-version=" + $ExpectedVersion)

        $script:ProbeStage = "stage-plugin"
        if ($ProbeMode -eq "NativeReplacement") {
            $stageSet = Get-NativeReplacementStageSet -ProjectRoot $ProjectRoot
            if (-not $stageSet.Ready) { throw "native-replacement-plugin-artifact-missing" }
            $nativeStageTarget = Join-Path $script:Root ("config\plugins\" + $NativeStageDirectoryName)
            foreach ($stageFile in @($stageSet.Files)) {
                $stageName = [string]$stageFile.Name
                if ($stageName -notin @("tui.tsx", "fixtures.ts") -or $stageName -match '[\\/]') { throw "native-replacement-stage-name-invalid" }
                Copy-Item -LiteralPath ([string]$stageFile.Source) -Destination (Join-Path $nativeStageTarget $stageName) -ErrorAction Stop
            }
        } else {
            $pluginTarget = Join-Path $script:Root "config\plugins\sync-anchor-probe\tui.tsx"
            $guardTarget = Join-Path $script:Root "config\plugins\sync-anchor-probe\route-guard.ts"
            $phase2Target = Join-Path $script:Root "config\plugins\sync-anchor-probe\phase2.ts"
            Copy-Item -LiteralPath $PluginFile -Destination $pluginTarget -ErrorAction Stop
            Copy-Item -LiteralPath $GuardFile -Destination $guardTarget -ErrorAction Stop
            Copy-Item -LiteralPath $Phase2File -Destination $phase2Target -ErrorAction Stop
        }

        $script:ProbeStage = "debug-capture"
        $pathText = Invoke-BoundedCapture -Executable $executable -Arguments @("debug", "paths") -WorkingDirectory $projectDirectory -EnvironmentBlock $environmentBlock -TimeoutMilliseconds 30000
        $script:ProbeStage = "debug-json"
        $pathDocument = ConvertFrom-DebugPathsText -Text $pathText
        $script:ProbeStage = "debug-path-map"
        $pathMap = Get-DebugPathMap -Document $pathDocument
        $script:ProbeStage = "debug-isolation"
        $escaped = New-Object System.Collections.Generic.List[string]
        foreach ($key in $ExpectedPathKeys) {
            if (-not $pathMap.ContainsKey($key) -or -not (Test-UnderRoot -Child ([string]$pathMap[$key]) -Root $script:Root)) {
                $escaped.Add($key)
            }
        }
        if ($escaped.Count -gt 0) { throw "debug-paths-isolation-gate-failed" }
        Write-Host "preflight: all ten reported OpenCode paths are inside the disposable root"

        if ($ProbeMode -eq "NativeReplacement") {
            Write-Host "staging: fixed native-replacement TUI probe artifact only; no whole-project copy"
        } else {
            Write-Host "staging: synthetic-only public TUI route/cache probe"
        }
        $script:ProbeStage = "tui-launch"
        $script:TuiLaunchAttempted = $true
        $script:TuiChild = Start-ProbeChild -Executable $executable -Arguments @("--standalone", $projectDirectory) -WorkingDirectory $projectDirectory -EnvironmentBlock $environmentBlock
        $script:ProbeStage = "result"
        $resultLimit = if ($ProbeMode -eq "NativeReplacement") { $NativeResultLimitBytes } else { $ResultLimitBytes }
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-Path -LiteralPath $resultFile -PathType Leaf) {
                $info = Get-Item -LiteralPath $resultFile -ErrorAction Stop
                if (($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not (Test-UnderRoot -Child $info.FullName -Root $script:Root)) { throw "probe-result-path-invalid" }
                if ($info.Length -gt $resultLimit) { throw "probe-result-over-cap" }
                $rawResult = [System.IO.File]::ReadAllText($resultFile) | ConvertFrom-Json -ErrorAction Stop
                if ($ArchiveProbe) {
                    $result = Get-SafeNativeArchiveProbeResult -Raw $rawResult
                } elseif ($ProbeMode -eq "NativeReplacement") {
                    $result = Get-SafeNativeProbeResult -Raw $rawResult
                } else {
                    $result = Get-SafeProbeResult -Raw $rawResult -ExpectedVersion $ExpectedVersion
                }
                break
            }
            if ($script:TuiChild.HasExited()) { break }
            Start-Sleep -Milliseconds 200
        }
        if ($null -eq $result) { throw "probe-result-missing-or-timeout" }
        if ($InspectSeconds -gt 0) {
            $script:ProbeStage = "observation"
            if ($ArchiveProbe) {
                Write-Host ("TUI-ARCHIVE-OBSERVATION-WINDOW: " + [string]$InspectSeconds + " seconds; 0-60s observe archived old in the native picker, then observe recovery; do not submit")
            } else {
                Write-Host ("TUI-OBSERVATION-WINDOW: " + [string]$InspectSeconds + " seconds; inspect the native session view only; do not submit a prompt")
            }
            Start-Sleep -Seconds $InspectSeconds
        }

        if ($ArchiveProbe) {
            # The initial archive result starts the owner window; the plugin writes the final
            # recovery-verified result during it. Re-read only the fixed result path after the
            # window so the runner reports the actual recovery outcome.
            if (Test-Path -LiteralPath $resultFile -PathType Leaf) {
                $finalInfo = Get-Item -LiteralPath $resultFile -ErrorAction Stop
                if (($finalInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not (Test-UnderRoot -Child $finalInfo.FullName -Root $script:Root)) { throw "probe-result-path-invalid" }
                if ($finalInfo.Length -gt $resultLimit) { throw "probe-result-over-cap" }
                $finalRaw = [System.IO.File]::ReadAllText($resultFile) | ConvertFrom-Json -ErrorAction Stop
                $result = Get-SafeNativeArchiveProbeResult -Raw $finalRaw
            }
        }

        if ($CombinedRestartProbe -and $result.ok -eq $true) {
            $script:ProbeStage = "phase1-stop"
            $phase1Stop = Stop-ProbeChild -Child $script:TuiChild -TimeoutMilliseconds 10000
            if (-not $phase1Stop) {
                $script:SafeToDelete = $false
                throw "phase1-stop-unverified"
            }
            try { $script:TuiChild.Dispose() } catch {
                $script:SafeToDelete = $false
                throw "phase1-dispose-unverified"
            }
            $script:TuiChild = $null

            $script:ProbeStage = "inspect-manifest"
            $manifestInfo = Get-Item -LiteralPath $manifestFile -ErrorAction Stop
            if (($manifestInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                -not (Test-UnderRoot -Child $manifestInfo.FullName -Root $script:Root) -or
                $manifestInfo.Length -gt $ManifestLimitBytes) {
                throw "phase1-manifest-invalid"
            }

            $script:ProbeStage = "inspect-launch"
            $inspectEnvironmentBlock = New-ProbeEnvironmentBlock -Root $script:Root -Executable $executable -Phase "inspect" -ResultPath $inspectResultFile -ManifestPath $manifestFile
            $script:InspectLaunchAttempted = $true
            $script:InspectChild = Start-ProbeChild -Executable $executable -Arguments @("--standalone", $projectDirectory) -WorkingDirectory $projectDirectory -EnvironmentBlock $inspectEnvironmentBlock
            $inspectStarted = $true
            $script:ProbeStage = "inspect-result"
            $inspectDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
            while ([DateTime]::UtcNow -lt $inspectDeadline) {
                if (Test-Path -LiteralPath $inspectResultFile -PathType Leaf) {
                    $inspectInfo = Get-Item -LiteralPath $inspectResultFile -ErrorAction Stop
                    if (($inspectInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not (Test-UnderRoot -Child $inspectInfo.FullName -Root $script:Root)) { throw "inspect-result-path-invalid" }
                    if ($inspectInfo.Length -gt $ResultLimitBytes) { throw "inspect-result-over-cap" }
                    $rawInspect = [System.IO.File]::ReadAllText($inspectResultFile) | ConvertFrom-Json -ErrorAction Stop
                    $inspectResult = Get-SafeProbeResult -Raw $rawInspect -ExpectedVersion $ExpectedVersion
                    break
                }
                if ($script:InspectChild.HasExited()) { break }
                Start-Sleep -Milliseconds 200
            }
            if ($null -eq $inspectResult) { throw "inspect-result-missing-or-timeout" }

            $script:ProbeStage = "inspect-stop"
            $inspectStopVerified = Stop-ProbeChild -Child $script:InspectChild -TimeoutMilliseconds 10000
            if (-not $inspectStopVerified) {
                $script:SafeToDelete = $false
                throw "inspect-stop-unverified"
            }
            try { $script:InspectChild.Dispose() } catch {
                $script:SafeToDelete = $false
                throw "inspect-dispose-unverified"
            }
            $script:InspectChild = $null
            $script:ExitCode = if ($inspectResult.ok -eq $true) { 0 } else { 6 }
        } else {
            $script:ExitCode = if ($result.ok -eq $true) { 0 } else { 6 }
        }
    } catch {
        $safeStage = Get-SafeProbeStage -Stage $script:ProbeStage
        $safeCategory = Get-SafeFailureCategory -ErrorRecord $_
        Write-Host ("RUN-FAILED: bounded failure; stage=" + $safeStage + " category=" + $safeCategory + "; raw exception details omitted.")
        if (-not $script:SafeToDelete) { $script:ExitCode = 3 }
        elseif ($script:TuiLaunchAttempted) { $script:ExitCode = 2 }
        else { $script:ExitCode = 1 }
    } finally {
        $script:ProbeStage = "cleanup"
        if ($null -ne $script:TuiChild) {
            $tuiStopVerified = Stop-ProbeChild -Child $script:TuiChild -TimeoutMilliseconds 10000
            if (-not $tuiStopVerified) { $script:SafeToDelete = $false }
            try { $script:TuiChild.Dispose() } catch { $script:SafeToDelete = $false }
            $script:TuiChild = $null
        } else {
            $tuiStopVerified = $true
        }
        if ($null -ne $script:InspectChild) {
            $inspectStopVerified = Stop-ProbeChild -Child $script:InspectChild -TimeoutMilliseconds 10000
            if (-not $inspectStopVerified) { $script:SafeToDelete = $false }
            try { $script:InspectChild.Dispose() } catch { $script:SafeToDelete = $false }
            $script:InspectChild = $null
        } elseif (-not $inspectStarted) {
            $inspectStopVerified = $true
        }
        $gate = Get-CombinedProbeGate -Phase1ResultOk:($null -ne $result -and $result.ok -eq $true) -Phase1StopVerified:$tuiStopVerified -Phase2Started:$inspectStarted -Phase2StopVerified:$inspectStopVerified
        Write-Host ("stop: verified=" + [string]($gate.DeleteRoot -and $script:SafeToDelete))
        if ([string]::IsNullOrWhiteSpace($script:Root) -or -not $script:RootCreated) {
            if ($script:ExitCode -eq 4) { $script:ExitCode = 1 }
            if (-not [string]::IsNullOrWhiteSpace($script:Root)) { Write-Host "cleanup: no owned root was created; no directory removed" }
        } elseif (-not $script:SafeToDelete -or -not $gate.DeleteRoot) {
            Write-Host ("cleanup: FAILED; disposable root retained at " + $script:Root)
            $script:ExitCode = 3
        } else {
            $rootRemoved = Remove-ProbeRootSafely -Root $script:Root
            if ($rootRemoved) {
                Write-Host "cleanup: disposable root removed after verified stop and target-set gate"
            } else {
                Write-Host ("cleanup: FAILED; disposable root retained at " + $script:Root)
                $script:ExitCode = 3
            }
        }
    }

    if ($null -ne $result) {
        if ($ProbeMode -eq "NativeReplacement") {
            $nativeJson = $result | ConvertTo-Json -Depth 4 -Compress
            if ($nativeJson.Length -gt $NativeResultLimitBytes) {
                Write-Host "PROBE-NATIVE-RESULT-OVER-CAP"
                if ($script:ExitCode -eq 0) { $script:ExitCode = 6 }
            } else {
                Write-Host ("PROBE-NATIVE-RESULT-JSON: " + $nativeJson)
            }
        } else {
            $result | ConvertTo-Json -Depth 8 -Compress | ForEach-Object { Write-Host ("PROBE-RESULT-JSON: " + $_) }
        }
    }
    if ($null -ne $inspectResult) {
        $inspectResult | ConvertTo-Json -Depth 8 -Compress | ForEach-Object { Write-Host ("PROBE-INSPECT-JSON: " + $_) }
    }
    if ($script:ExitCode -eq 0 -and (-not $rootRemoved -or -not $gate.DeleteRoot)) { $script:ExitCode = 3 }
    if ($ArchiveProbe -and $ProbeMode -eq "NativeReplacement") {
        Write-Host ("ARCHIVE-RECEIPT: exit=" + [string]$script:ExitCode + " safe=" + [string]$script:SafeToDelete + " stop=" + [string]$tuiStopVerified + " cleanup=" + [string]([bool]$rootRemoved) + " finalOk=" + [string]($null -ne $result -and $result.ok -eq $true))
    }
    return $script:ExitCode
}

if ($SupportedVersions -notcontains $ExpectedVersion) {
    Write-Host "VALIDATION-FAILED: expected-version-not-supported"
    exit 1
}

if ($ProbeMode -eq "NativeReplacement" -and $CombinedRestartProbe) {
    Write-Host "VALIDATION-FAILED: combined-restart-probe-not-supported-in-native-replacement-mode"
    exit 1
}

if ($ArchiveProbe -and $ProbeMode -ne "NativeReplacement") {
    Write-Host "VALIDATION-FAILED: archive-probe-requires-native-replacement"
    exit 1
}

if ($ArchiveProbe -and $CombinedRestartProbe) {
    Write-Host "VALIDATION-FAILED: archive-probe-does-not-support-combined-restart"
    exit 1
}

if (-not $RunProbe) {
    exit (Invoke-ValidationOnly)
}

exit (Invoke-Probe)
