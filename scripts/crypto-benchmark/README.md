# Windows-only KDF diagnostic harness (`scripts/crypto-benchmark/`)

Diagnostic measurement harness for the pinned `libsodium-wrappers-sumo@0.8.4`
synchronous Argon2id `crypto_pwhash` at a **diagnostic candidate**: the default
**2 ops / 64 MiB** reproduces the earlier recorded diagnostic run (E35 /
`fix-52`) so measurements stay comparable, and `--ops` / `--memory-mib`
parameterize the candidate for small diagnostic comparisons (for example
1/64 MiB, 3/64 MiB, 2/128 MiB).

**This is not a production profile and not a crypto decision.** No profile, cap,
format, or parameter value is selected by this harness; the `--ops` /
`--memory-mib` ranges are CLI input guards only, not a product resource cap or
support claim. O-01/O-03 remain OPEN and the production crypto registry remains
empty. Do not import anything from this directory into product code.

## What it measures

- **Latency**: milliseconds around *only* the synchronous `crypto_pwhash` call,
  timed in the child with `performance.now()`. Process spawn, `sodium.ready` /
  embedded-WASM instantiation, synthetic byte preparation, IPC, and JSON
  reporting are excluded. The interval still includes JS-wrapper-to-WASM
  boundary overhead, so it is not pure native compute time.
  Reported as p50 / p95 / max (plus min / mean / count).
- **Memory**, as two clearly separated labels, in **bytes**:
  - `sampledIncrementalDeltaBytes` — max supervisor-sampled working set during
    the KDF window minus the per-child pre-KDF baseline. Approximate.
  - `processLifetimePeakWorkingSetBytes` — per-child lifetime
    `PeakWorkingSetSize`; includes all pre-KDF work (process startup, sodium
    init, byte prep), so it is not attributable to the KDF alone.

Both labels, the sampling interval/sample counts, runtime/library versions, and
the full limitations list are included in every report.

## Design (why it is shaped this way)

- **Supervisor + child processes, one repo script.** One KDF sample = one fresh
  child, processed strictly sequentially. The supervisor spawns this *same
  source file* in child mode (`bun scripts/crypto-benchmark/supervisor.ts
  --child`); the handshake is stdio-only and no runtime staging/temp files are
  created. The child loads sodium, prepares synthetic password/salt in memory,
  emits `READY`, and waits for `GO`. The supervisor captures the child's current
  working set (baseline), sends `GO`, polls the child's working set while the
  synchronous KDF blocks it, then sends `EXIT` and reads the retained post-exit
  `PeakWorkingSetSize`.
- **Memory is never sampled from the blocked child.** The child's event loop is
  blocked by the synchronous KDF; the separate supervisor does all sampling.
- **Windows process APIs via Bun FFI** (`psapi.dll` `GetProcessMemoryInfo`,
  `PROCESS_MEMORY_COUNTERS`): `WorkingSetSize` / `PeakWorkingSetSize` in bytes.
  Deliberately avoids `Bun.spawn().resourceUsage().maxRSS` (documented Windows
  unit discrepancies) and `process.resourceUsage()` (self-only; blocked child
  cannot sample itself).
- **Byte units verified** on the recorded host (Bun 1.3.10 / Windows 11 x64):
  `WorkingSetSize` matched `process.memoryUsage().rss` within 0.1%. Re-run the
  self-check below after any runtime change.
- **Safety**: synthetic password/salt are generated in child memory only, never
  printed or persisted, and best-effort zeroed (`sodium.memzero`; no
  secure-deletion claim). The harness writes no files (no staging, temp, or
  output files anywhere), makes no network calls, and touches no session data.

## Run

From the repository root (Windows x64, Bun):

```text
# 1) Cheap self-check, no KDF: verifies the memory reader and byte units.
bun run scripts/crypto-benchmark/selfcheck-winmem.ts

# 2) The diagnostic. Default: 100 samples, 10 ms poll interval, 2 ops / 64 MiB.
#    stdout = one JSON report; stderr = progress. No files are written.
bun run scripts/crypto-benchmark/supervisor.ts

#    Smaller/controlled runs, including a diagnostic candidate comparison:
bun run scripts/crypto-benchmark/supervisor.ts --samples 10 --interval-ms 5
bun run scripts/crypto-benchmark/supervisor.ts --samples 30 --ops 1 --memory-mib 64
bun run scripts/crypto-benchmark/supervisor.ts --samples 30 --ops 3 --memory-mib 64
bun run scripts/crypto-benchmark/supervisor.ts --samples 30 --ops 2 --memory-mib 128
```

`--ops` and `--memory-mib` select the diagnostic candidate for this run only;
they do not select a profile or cap, and the measured values are not a
recommendation. The supervisor passes the requested values to the child and
fail-closes if the child's READY report does not match them exactly.

Exit codes: `0` all samples completed; `2` partial (some samples failed; report
still printed); `1` fatal (wrong platform, usage error, or zero samples).

Pure logic tests (do not run the KDF):

```text
bun test tests/runtime/crypto-benchmark.test.ts
```

## Protocol (for maintainers)

Child process command: `<bun> <repo>/scripts/crypto-benchmark/supervisor.ts --child
--ops <n> --memory-mib <n>` (same source file as the supervisor; `--child` is
internal and not part of the user CLI). Child stdout carries one JSON object per
line; supervisor stdin commands are lines.

| Direction | Message |
| --- | --- |
| child → supervisor | `{"type":"ready","protocol":1,"pid":…,"settings":{…},"versions":{…}}` |
| supervisor → child | `GO` |
| child → supervisor | `{"type":"sample","latencyMs":…}` |
| supervisor → child | `EXIT` |

The supervisor fail-closes if the child reports settings that differ from the
diagnostic candidate settings it requested (default 2 ops / 64 MiB).

## Limitations (also embedded in every report)

- Diagnostic only; the measured ops/memory candidate inputs are not a selected
  or approved crypto profile; no profile/cap/format value is chosen (O-01/O-03
  OPEN).
- One Windows test host / runtime only; not a minimum-device floor, not
  macOS/Linux, and not the OpenCode plugin runtime. No support claim.
- Working set is physical residency, not private/commit memory.
- Sampling uses a best-effort JS timer: the requested interval is not
  guaranteed, and short-lived peaks between samples can be missed.
- `sampledIncrementalDeltaBytes` is approximate and not a precise KDF
  memory-cost measurement.
- `processLifetimePeakWorkingSetBytes` includes pre-KDF work and is not
  attributable to the KDF alone.
- Each sample is a fresh, unwarmed child, so every measured call includes any
  per-process first-call costs (e.g., WASM heap growth).
- The synthetic password is fixed-length random bytes, not representative of
  user-entered passphrases.
- Under Bun, `process.versions.node` is Bun's Node-compatibility version, not
  the system Node version; the report labels it `nodeCompat`.
