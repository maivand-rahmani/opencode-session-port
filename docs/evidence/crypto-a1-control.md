# CRYPTO-01 A1 KDF control — one sanitized observation

Status: **A1 CONTROL OBSERVED ONCE / ONE HOST / SANITIZED EVIDENCE ONLY. CRYPTO-01 REMAINS NOT PASSED. A2–A6 AND CONTAINER SEAL/OPEN WERE NOT RUN.**

Recorded 2026-10-19. Validation owner: orchestrator. This evidence records one
authorized A1-only KDF-control invocation after Oracle attempt 2 GO accepted by
the parent. It is not a full Phase A pass, not a container/per-object/wrapper
measurement, not a product parameter selection, and not a cross-platform,
plugin-runtime, hard-memory, or termination-tree guarantee.

## Exact execution

- Inner command: `C:\Users\PC\.bun\bin\bun.exe scripts/crypto-benchmark/phase-a/phase-a.node.ts --control-a1-only`
- Working directory: `C:\Users\PC\OneDrive\Desktop\projects\opencode-checkpoints`
- Shell: `false`
- Outer wrapper source (project ignored scratch): `.package-verify-work/a1-control-20261019-4f2a1c-outer.mjs`
  - Reused the reviewed bounded A0 outer-wrapper design with only the inner command flag changed.
  - The wrapper's internal summary field still carries the reused design name `a0-bridge-outer-bounded-memory-wrapper`; the executed inner argument was `--control-a1-only`.
- One inner invocation only. No retry, no A0 rerun, no `--help`, no second probe, no A2–A6, no seal/open.
- No raw stdout/stderr files and no report JSON files were written; the wrapper captured output in memory only.

## Outer bounds and result

| Field | Value |
| --- | --- |
| Outer internal timeout | 300,000 ms |
| Outer kill grace | 5,000 ms |
| Combined capture cap | 4,194,304 bytes |
| Per-stream capture cap | 2,097,152 bytes |
| Started | 2026-10-19T18:21:30.803Z |
| Finished | 2026-10-19T18:21:32.064Z |
| Duration | 1,259 ms |
| Inner exit code | 0 |
| Inner signal | none |
| Wrapper exit code | 0 |
| Timed out | false |
| Output overflow | false |
| Killed owned supervisor | false |
| Cleanup uncertain | false |
| stdout / stderr / combined captured | 17,238 / 284 / 17,522 bytes |
| Report parse | ok |

The outer wrapper supervised only the exact owned inner command. No arbitrary PID
kill, global taskkill, or descendant kill was attempted. Cleanup state is
verified for the owned supervisor/child only; there is no hard containment or
descendant-tree termination guarantee.

## Harness result

- Case: A1 (KDF control)
- Mode: `a1-control`
- Planned case IDs: `["A1"]`
- Samples per case: 3
- Max child starts: 3
- Run deadline: 1,800,000 ms
- Status: `completed`
- Run completed: true
- Attempted / completed / failed samples: 3 / 3 / 0
- Failure records: 0
- Child starts: 3
- Coverage: A1 KDF control true; A0 false; A2–A6 false; container seal/open false
- `crypto01Passed`: false
- `profileSelected`: false
- `formatFrozen`: false
- `phaseBExecuted`: false
- Candidate: `sessionport-phase-a-candidate-2ops-128mib-not-selected`, not selected as a production policy
- No container/seal/open operations or round trips were performed.

### Runtime

- Parent: Bun `1.3.10`, Node compat `24.3.0`, `win32`, `x64`
- Child: Bun `1.3.10`, Node compat `24.3.0`, `win32`, `x64`, libsodium `1.0.22`
- A1 child operation: lazy existing `libsodium-wrappers-sumo` load, `sodium.ready`, then one existing `crypto_pwhash` at 2 ops / 128 MiB, 16-byte salt, 32-byte output, synthetic password/salt only.

## KDF control timings

Raw per-sample `crypto_pwhash` intervals:

| Sample | KDF control (ms) |
| --- | ---: |
| 0 | 239.6719 |
| 1 | 245.0369 |
| 2 | 270.5906 |

Min / median / max: **239.6719 / 245.0369 / 270.5906 ms** (n=3).

Three samples are a probe, not a statistical basis. No p95 or production
performance claim is made. No historical comparability or candidate-selection
claim is made; the candidate remains a measurement input only.

## Working-set observations

| Sample | Child PID | Exit | Termination | Baseline WS (bytes) | Incremental WS (bytes) | Polls / span | Lifetime peak WS (bytes) |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| 0 | 7808 | 0 | owned-child-exit-verified | 224,964,608 | 150,609,920 | 15 / 240.8553 ms | 376,557,568 |
| 1 | 21664 | 0 | owned-child-exit-verified | 225,415,168 | 150,568,960 | 15 / 238.3692 ms | 376,963,072 |
| 2 | 3124 | 0 | owned-child-exit-verified | 225,542,144 | 150,421,504 | 17 / 271.6369 ms | 376,942,592 |

Aggregate:

| Label | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Baseline working set | 224,964,608 | 225,415,168 | 225,542,144 |
| Sampled incremental working-set delta | 150,421,504 | 150,568,960 | 150,609,920 |
| Process lifetime peak working set | 376,557,568 | 376,942,592 | 376,963,072 |

Boundary qualification: `sampledIncrementalWorkingSetBytes` is the maximum
sampled/end-of-operation working set minus baseline. A1 did record periodic polls
(15, 15, 17), but parent polling remains best-effort and can miss short peaks.
These labels are physical-residency working-set observations, not private/commit
memory, heap, a product memory budget, or hard containment. Lifetime peak is a
separate process-lifetime label.

### Physical memory and sampler

- Preflight required: 2,147,483,648 bytes
- Stop-below floor: 1,073,741,824 bytes
- Source: `GlobalMemoryStatusEx`
- Observed before run: 18,535,497,728 bytes
- Observed minimum during run: 18,177,236,992 bytes
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
| scripts/crypto-benchmark/phase-a/protocol.ts | 21752 | `807127d552dc1020f2df00b7cdda33ba1e597a054b18d06a76e60216eb47537e` |
| scripts/crypto-benchmark/phase-a/cases.ts | 11195 | `6e580eeb0799b35aa5169ca8fedcfb94f1a64f809006ea8be7cf51feb9830335` |
| scripts/crypto-benchmark/phase-a/child.ts | 17340 | `d401549723b81f077fcccfeda75e8dc8aea391697736a35ad69cb34e2bcca8ce` |
| scripts/crypto-benchmark/phase-a/supervisor.ts | 47077 | `fb2f7100f18aaf386894e19e3d1120b7e5754f408600780c7e48b8e465639ba1` |
| scripts/crypto-benchmark/phase-a/report.ts | 36876 | `7bf538ce8e7db7c1a137037b8758b6372a8f82419760fe09e72b95cc329c0d4b` |
| scripts/crypto-benchmark/phase-a/phase-a.node.ts | 59025 | `a183ee114fbd43666c6119a2d82483bb16cea02dd75f58e0cde20dc3602e7e29` |

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
proof. No historical-baseline comparison or equivalence claim is made.

## Limitations

- One authorized A1 control iteration only; no A0 rerun, no A2–A6, no full Phase A.
- A1 is KDF-control only. No container, per-object wrapper, seal/open, round-trip,
  or host/plugin runtime measurement was performed.
- One Windows x64/Bun 1.3.10 host only. No macOS/Linux, Node-runtime, OpenCode
  plugin-runtime, or cross-platform proof.
- Three samples are a probe, not a statistical basis. No p95 or production
  performance claim.
- Candidate values are measurement inputs, not selected production parameters.
- Working-set labels are physical-residency samples; no private/commit memory,
  heap, product cap, Job Object, or hard containment. Parent polling is
  best-effort and can miss short peaks.
- Process supervision verifies owned-child exit only; no arbitrary-PID kill and no
  reviewed descendant-tree termination guarantee.
- Physical-memory read failures were zero in this run; failure handling was not
  exercised.
- Partial secret-redaction limits remain; no broad redaction guarantee.
- No source, README, status-doc, config, lock, dependency, install, Git, DB, host,
  keychain, network, account, or credential changes were made by this observation.
- The README statement that A1 had never been executed is now a historical/stale
  pre-run statement after this successful observation. Per the bounded scope, the
  README was not edited; the parent/docs lane should reconcile it after review.

## Next review

This observation is one-host A1 KDF-control evidence only. A1 source-gate review
attempt 2 and reconciliation are required before any further A1 execution or any
container/seal/open work. CRYPTO-01 remains not passed.
