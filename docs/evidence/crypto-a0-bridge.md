# CRYPTO-01 A0-only bridge — one sanitized observation

Status: **A0 BRIDGE OBSERVED ONCE / SANITIZED EVIDENCE ONLY. CRYPTO-01 REMAINS NOT PASSED. A1–A6 REMAIN BLOCKED.**

Recorded 2026-10-19. Validation owner: orchestrator. This evidence records one
authorized A0-only bridge invocation after Oracle attempt 2 GO accepted by the
parent. It is not a full Phase A pass, not a crypto/profile/format/cap decision,
and not a production or cross-platform claim.

## Exact execution

- Inner command: `bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --bridge-a0-only`
- Resolved executable: `C:\Users\PC\.bun\bin\bun.exe`
- Working directory: `C:\Users\PC\OneDrive\Desktop\projects\opencode-checkpoints`
- Shell: `false`
- Outer wrapper: bounded in-memory Node wrapper executed from
  `C:\Users\PC\AppData\Local\Temp\opencode\a0-bridge-20261019-a7f3c9.mjs`
  (scratch source only; no output/report files written). A retained source copy
  is at `.package-verify-work/a0-bridge-20261019-a7f3c9-outer.mjs`.
- No retry, no second probe, no `--help`, no full Phase A, no A1–A6/KDF/seal/open.

### Wrapper permission transport note

After the inner A0 invocation had already launched and completed, the temp-path
permission reply transport failed with `request not found`. This evidence does
not assume that reply reached the host. The one already-launched A0 result is
retained here; the inner invocation was not repeated and the retained source copy
was not executed. No output files were produced.

## Outer bounds and result

| Field | Value |
| --- | --- |
| Outer internal timeout | 300,000 ms |
| Outer kill grace | 5,000 ms |
| Combined capture cap | 4,194,304 bytes |
| Per-stream capture cap | 2,097,152 bytes |
| Started | 2026-10-19T17:50:22.750Z |
| Finished | 2026-10-19T17:50:23.273Z |
| Duration | 521 ms |
| Inner exit code | 0 |
| Inner signal | none |
| Wrapper exit code | 0 |
| Timed out | false |
| Output overflow | false |
| Killed owned supervisor | false |
| Cleanup uncertain | false |
| stdout / stderr / combined captured | 16,113 / 283 / 16,396 bytes |
| Report parse | ok |

The wrapper captured stdout/stderr in memory only. No raw stdout/stderr files,
report JSON files, or shell output redirection were used.

## Harness result

- Mode: `a0-bridge`
- Planned case IDs: `["A0"]`
- Samples per case: 3
- Max child starts: 3
- Run deadline: 1,800,000 ms
- Status: `completed`
- Run completed: true
- Attempted / completed / failed samples: 3 / 3 / 0
- Failure records: 0
- Child starts: 3
- Coverage: A0 true; A1–A6 false; KDF control false; container seal/open false
- `crypto01Passed`: false
- `profileSelected`: false
- `formatFrozen`: false
- `phaseBExecuted`: false
- A0 aggregate seal/open/KDF timings: all `null` (A0 does not time KDF or container operations)

The report's static `harness.label` remains the source-prepared plan label
("A0-only supervised bridge (source prepared, not authorized/executed)"). It is a
plan label, not a claim that this actual observation did not occur; the
authorization/observation record is this evidence file.

### Runtime

- Parent: Bun `1.3.10`, Node compat `24.3.0`, `win32`, `x64`
- Child: Bun `1.3.10`, Node compat `24.3.0`, `win32`, `x64`, libsodium `1.0.22`

### A0 samples and owned exit states

| Sample | Child PID | Exit | Termination | Baseline WS (bytes) | Sampled incremental WS (bytes) | Lifetime peak WS (bytes) | Polls / span |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 26376 | 0 | owned-child-exit-verified | 224,776,192 | 6,139,904 | 231,456,768 | 0 / 0 ms |
| 1 | 14468 | 0 | owned-child-exit-verified | 225,398,784 | 5,677,056 | 232,009,728 | 0 / 0 ms |
| 2 | 19668 | 0 | owned-child-exit-verified | 225,415,168 | 5,632,000 | 231,976,960 | 0 / 0 ms |

A0 memory aggregate:

| Label | Min | Median | Max |
| --- | --- | --- | --- |
| Baseline working set | 224,776,192 | 225,398,784 | 225,415,168 |
| Sampled incremental working-set delta | 5,632,000 | 5,677,056 | 6,139,904 |
| Process lifetime peak working set | 231,456,768 | 231,976,960 | 232,009,728 |

These are working-set labels only. They are not private/commit memory, heap, a
product memory budget, or hard containment. Poll count was zero for A0; the
parent sampling did not observe intermediate peaks during these short baseline
runs.

**Boundary-label clarification (documentation only; no remeasurement, no rerun):**
every A0 sample reported `sampledPollCount: 0`. The numeric
`sampledIncrementalWorkingSetBytes` min/median/max above are therefore
**boundary observations** computed from the baseline and end-of-operation
working-set reads, not sampled time-series peaks. The original measurements,
numeric values, provenance, and the accepted one-run result are unchanged. This
clarification does not claim a rerun or a different observation.

### Physical memory and sampler

- Preflight required: 2,147,483,648 bytes
- Stop-below floor: 1,073,741,824 bytes
- Source: `GlobalMemoryStatusEx`
- Observed before run: 18,466,435,072 bytes
- Observed minimum during run: 18,426,642,432 bytes
- Physical-memory read failures: 0

The harness preflight/soft-stop guard was not independently modified or bypassed.

## Source freshness (SHA-256, read-only bytes)

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| package.json | 1319 | `3d8d6f136661efd25dd7a5f9a38794b194f95fe2cfb25863ae30bc71239fb96c` |
| bun.lock | 120515 | `9d60c971b626f5d53170b5a85db0eae9e71dd2ff5ddd0a2ba830f6bcac1f6e54` |
| src/core/contracts/crypto.ts | 3056 | `1f800760c689773beaf380c22d58ed81e98adc6bbb2fba50757ebe0657b7a6ce` |
| src/core/crypto/container.ts | 28240 | `3a2bd64a98aceb7055233342e4f176b906b20752729b430c3be8c910ab495776` |
| src/core/crypto/envelope.ts | 10349 | `0436b3ff3656c6af016fbd2c6a7a93df0a9dcc92a457e760790b0d2f1e25e2a6` |
| src/core/crypto/index.ts | 655 | `341195d15c8f0e72c1e7b85532bb86ae4df100b1f668cecb2865a3b66cfb395d` |
| src/core/crypto/kdf.ts | 4194 | `266c4b7b65b6b44c1f8c61696dd978c89d5184bea7aed4f008bc3b2fd870a1e2` |
| src/core/crypto/policy.ts | 8346 | `92aeef95177c139a2f3f9f24441152df5bf940a566f2705435975682b7b4f0b6` |
| src/core/crypto/gzip-stream.ts | 14209 | `241b6e05e22eb1aa3e681e2348bf63ef8c618a2c91ee06771809d73fd74c33da` |
| src/core/crypto/zero.ts | 1196 | `786a240b27c84a0f6f2982bdfec91523f0cdf2a255a82c27e7a2d1a2a234541c` |
| scripts/crypto-benchmark/lib/winmem.ts | 4857 | `d9932ae27bb417c470c5247e7f45e846af8a7ffcd7cccde8c5bfdd788cbc2582` |
| scripts/crypto-benchmark/phase-a/protocol.ts | 21214 | `f370b0936f4a0b14dc8f3244fa85817ed437f9a67fd607eee89f957baf12fcc3` |
| scripts/crypto-benchmark/phase-a/cases.ts | 10524 | `b7c4a320c2b7380843e16ad657736b8e648d040f10575b3ce04ebea22e8ce6b8` |
| scripts/crypto-benchmark/phase-a/child.ts | 16550 | `2ca000294fd84c6a823106571eef1f4594f0aa65e985dd3df64ce3270ae5d194` |
| scripts/crypto-benchmark/phase-a/supervisor.ts | 46077 | `4273537c43a177b5b83117f17f2ea3a8f31cf0b2fbcac9dabce5a7e8669d7153` |
| scripts/crypto-benchmark/phase-a/report.ts | 35614 | `05f41806dc7b3aeed71c33ba40feaca5a0589b945860010858f8448f6cad4c3a` |
| scripts/crypto-benchmark/phase-a/phase-a.node.ts | 52030 | `2b3b5aab92002aee9353a6266bcc69b83c33b2b7a1bdb910f8dd8cea2ab7bf02` |

## Installed libsodium metadata evidence

- Package: `libsodium-wrappers-sumo`
- Expected/installed version: `0.8.4`
- Resolved package.json:
  `C:\Users\PC\OneDrive\Desktop\projects\opencode-checkpoints\node_modules\.bun\libsodium-wrappers-sumo@0.8.4\node_modules\libsodium-wrappers-sumo\package.json`
- package.json bytes: 1745
- package.json SHA-256: `090256de7fa9c511bbad8dd8c25ff1ccb7e2cfae039557675d3aa5672a039fb0`
- `bun.lock` entry found: true
- `bun.lock` resolved version: `0.8.4`
- `bun.lock` integrity: `sha512-ql7hcgulKZ3ekfa2DGAogcCKsWU0diA/0nArz1CFzh93WQdb46/Kj18ka/Hifq6uA3Ush34Pc6vU/6HXeRwUkg==`
- Integrity kind: `lock-metadata`
- Installed/extracted bytes verified: **false**
- Version/lock match: true

The integrity value is **bun.lock metadata only**. Installed/extracted package
bytes and archive hashes were not verified. A version string is not an integrity
proof. No historical-baseline comparison is claimed.

## Limitations

- One authorized A0-only bridge iteration only; no full Phase A, no Phase B.
- A0 does not time KDF, seal, or open. No performance or crypto-result claim.
- Three A0 samples are a probe, not a statistical basis.
- No A1–A6 actual entry; A1–A6 remain blocked before crypto import.
- One Windows x64/Bun 1.3.10 host only; no macOS/Linux, Node-runtime, OpenCode
  plugin-runtime, or cross-platform proof.
- Working-set labels are physical-residency samples, not private/commit memory,
  heap, a product cap, or hard memory containment.
- Parent sampling is best-effort; A0 recorded zero sampled polls.
- Process supervision verifies owned-child exit only; no arbitrary-PID kill, no
  Job Object, and no reviewed descendant-tree termination guarantee.
- Physical-memory read failure handling was not exercised in this run; read
  failures: 0.
- Partial secret-redaction limits remain; no broad redaction guarantee is
  claimed.
- No source, README, docs status, config, lock, dependency, install, Git, DB,
  host, keychain, network, or credentials changes were made by this observation.
- No raw stdout/stderr or report JSON file was retained; only this sanitized
  summary and the scratch wrapper source exist.

## Next review

Parent Oracle A0 exact-source attempt 2 review of the observed bridge and the
current source is the next step before any further execution. A1–A6 remain
blocked regardless of this observation.
