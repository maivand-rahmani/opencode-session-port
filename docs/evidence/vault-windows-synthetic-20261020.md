# Windows synthetic vault probe — 2026-10-20

Status: **Synthetic read/write/delete passed**, with an exit-code instrumentation limitation.

- Runtime: Windows x64, Bun 1.3.10.
- Candidate: `@napi-rs/keyring@2.1.2`, installed script-free in an isolated Temp snapshot.
- Root package integrity matched the previously recorded SHA-512 value; the
  `@napi-rs/keyring-win32-x64-msvc@2.1.2` package and native binding were present.
- Run ID: `64084f26-87f2-47a8-b57d-a4046d46aa52`.
- One UUID-derived synthetic entry; no existing credentials or entry enumeration.
- Observed: precheck absent, write settled, 32-byte readback matched, delete
  settled, final read absent. No retry, timeout, outer kill, or manual cleanup.
- Probe elapsed: 256 ms. Internal deadline: 30 seconds; outer watchdog: 45 seconds.

PowerShell returned a null process `ExitCode` for both installation and the probe.
The structured probe result was `outcome=pass`; exit zero follows from that source
path but was **not directly observed as an OS process exit code**. Installation
was evidenced by its output, lockfile, and installed packages. No rerun was made.

## Evidence location

Sanitized results, integrity checks, and source/snapshot hash comparisons remain at:

```text
C:\Users\PC\AppData\Local\Temp\opencode\sessionport-keyring-probe-64084f26-87f2-47a8-b57d-a4046d46aa52\result.json
```

The orchestrator read this result. Snapshot source bytes matched the reviewed probe
and adapter at execution time. This is not locked-store, restart/persistence,
cross-process, macOS/Linux, production credential-use, or AUTH-02 completion proof.
The separate production adapter mutation-uncertainty fix and TUI integration remain
required; this result alone does not select the production dependency.
