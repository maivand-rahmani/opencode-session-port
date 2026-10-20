# CRYPTO-01 A2 container — one sanitized observation

Status: **A2 CONTAINER OBSERVED ONCE / ONE HOST / SYNTHETIC VALIDATION ONLY. CRYPTO-01 REMAINS NOT PASSED. A0/A1 WERE NOT RERRUN; A3–A6 AND FULL PHASE A WERE NOT RUN.**

Recorded 2026-10-19. Validation owner: orchestrator. This evidence records one
authorized A2-only diagnostic after Oracle A2 source attempt 1 GO accepted by the
parent. It is not a production seal, not a full Phase A pass, not a format
freeze, and not a product parameter/profile/cap selection.

## Exact execution

- Inner command: `C:\Users\PC\.bun\bin\bun.exe scripts/crypto-benchmark/phase-a/phase-a.node.ts --container-a2-only`
- Working directory: `C:\Users\PC\OneDrive\Desktop\projects\opencode-checkpoints`
- Shell: `false`
- Outer wrapper source (project ignored scratch):
  `.package-verify-work/a2-container-20261019-9d7e2b-outer.mjs`
  - Reused the reviewed bounded A1/A0 outer-wrapper design with only the inner command flag changed.
  - The wrapper’s internal summary field still carries the reused design name
    `a0-bridge-outer-bounded-memory-wrapper`; the executed inner argument was
    `--container-a2-only`.
- One inner invocation only. No retry, no A0/A1 rerun, no A3–A6, no full Phase A,
  no `--help`, no heavy/production crypto.
- No raw stdout/stderr files and no report JSON files were written; output was
  captured in memory only.

## Outer bounds and result

| Field | Value |
| --- | --- |
| Outer internal timeout | 300,000 ms |
| Outer kill grace | 5,000 ms |
| Combined capture cap | 4,194,304 bytes |
| Per-stream capture cap | 2,097,152 bytes |
| Started | 2026-10-19T18:33:09.137Z |
| Finished | 2026-10-19T18:33:11.143Z |
| Duration | 2,004 ms |
| Inner exit code | 0 |
| Inner signal | none |
| Wrapper exit code | 0 |
| Timed out | false |
| Output overflow | false |
| Killed owned supervisor | false |
| Cleanup uncertain | false |
| stdout / stderr / combined captured | 18,725 / 286 / 19,011 bytes |
| Report parse | ok |

The outer wrapper supervised only the exact owned inner command. No arbitrary PID
kill, global taskkill, or descendant kill was attempted. Cleanup state is verified
for the owned supervisor/child only; there is no hard containment or
descendant-tree termination guarantee.

## Harness result

- Case: A2 (container round trip)
- Mode: `a2-container`
- Planned case IDs: `["A2"]`
- Samples per case: 3
- Max child starts: 3
- Run deadline: 1,800,000 ms
- Status: `completed`
- Run completed: true
- Attempted / completed / failed samples: 3 / 3 / 0
- Failure records: 0
- Child starts: 3
- Round-trip matched operations: 3 / 3
- Coverage: `a2ContainerExecuted: true`, `containerSealOpenExecuted: true`,
  `a1ControlExecuted: false`, `a3ToA6Executed: false`,
  `kdfControlExecuted: false`.
- `a2ToA6Executed` is true because A2 itself is in the A2–A6 range; A3–A6 are
  false.
- `crypto01Passed`: false
- `profileSelected`: false
- `formatFrozen`: false
- `phaseBExecuted`: false
- Candidate: `sessionport-phase-a-candidate-2ops-128mib-not-selected`; not
  selected as a production policy.

Important interpretation: `kdfControlExecuted: false` means the direct A1
KDF-control case was not run. It does **not** mean zero KDF happened: A2 seal and
open each derive internally through the existing container (two internal KDF
passes per child). Those are container costs, not the direct A1 control
measurement.

## A2 semantics

- Synthetic 32-byte plaintext payload, synthetic wrapper passphrase, illustrative
  wrapper case (`wrapperIllustrative: true`).
- One `seal` then one `openAndStage` per fresh child through the existing public
  factory.
- Local explicit candidate: 2 Argon2id ops / 128 MiB, 16-byte salt, 64 KiB frame;
  borrowed limits; not a production profile.
- `seal` timing includes awaiting and fully consuming the async artifact in memory.
- `openAndStage` consumes the complete in-memory artifact.
- Round-trip check is boolean byte equality only. No payload/root/passphrase/salt/
  digest/ciphertext bytes were logged or persisted.
- Best-effort owned-buffer clearing only; no secure-deletion or zeroization claim.
- No production wrapper format or JSON metadata schema was invented.

## Raw per-sample observations

| Sample | Child PID | Exit | Seal (ms) | Open (ms) | Artifact bytes | Round trip | Baseline WS (bytes) | Incremental WS (bytes) | Polls / span | Lifetime peak WS (bytes) |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: |
| 0 | 5560 | 0 | 252.1068 | 223.0382 | 148 | true | 228,331,520 | 160,681,984 | 30 / 463.1779 ms | 389,013,504 |
| 1 | 1448 | 0 | 252.6067 | 221.8906 | 148 | true | 227,229,696 | 162,349,056 | 30 / 472.5336 ms | 389,578,752 |
| 2 | 25680 | 0 | 274.2792 | 222.7536 | 148 | true | 227,246,080 | 162,160,640 | 32 / 493.2429 ms | 389,406,720 |

Seal min / median / max: **252.1068 / 252.6067 / 274.2792 ms** (n=3).
Open min / median / max: **221.8906 / 222.7536 / 223.0382 ms** (n=3).
Artifact size min / median / max: **148 / 148 / 148 bytes** (n=3).

Three samples are a probe, not a statistical basis. No p95 or production
performance claim is made. No historical comparability claim is made. Artifact
size is the only size metric exposed; compressed gzip bytes and frame counts are
not reported because the public contract does not expose them.

## Working-set observations

| Label | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Baseline working set | 227,229,696 | 227,246,080 | 228,331,520 |
| Sampled incremental working-set delta | 160,681,984 | 162,160,640 | 162,349,056 |
| Process lifetime peak working set | 389,013,504 | 389,406,720 | 389,578,752 |

Boundary qualification: `sampledIncrementalWorkingSetBytes` is a boundary delta
(maximum sampled/end-of-operation working set minus baseline). A2 recorded
periodic polls (30, 30, 32), but parent polling remains best-effort and can miss
short peaks. These labels are physical-residency working-set observations, not
private/commit memory, heap, a product memory budget, or hard containment.
Lifetime peak is a separate process-lifetime label.

### Physical memory and sampler

- Preflight required: 2,147,483,648 bytes
- Stop-below floor: 1,073,741,824 bytes
- Source: `GlobalMemoryStatusEx`
- Observed before run: 18,341,859,328 bytes
- Observed minimum during run: 17,943,621,632 bytes
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
| scripts/crypto-benchmark/phase-a/protocol.ts | 21768 | `02e3b23d5c87dc4998393b465a0dd0a98210b7eec1874012277e6bc8d5a94b5a` |
| scripts/crypto-benchmark/phase-a/cases.ts | 11989 | `fc1460a0b60b6696894f0f031cc7a7d0a0a848cb0682c55072d604d88bc6cd94` |
| scripts/crypto-benchmark/phase-a/child.ts | 17470 | `e8d7442243555595c04f95b1fa2de2085ea101d9f3884d57b64088f01c5d3fdd` |
| scripts/crypto-benchmark/phase-a/supervisor.ts | 47621 | `b4422321c1ac13f001bd00b1e1ae3283284eda6b8d670e2a4573a2a996a92001` |
| scripts/crypto-benchmark/phase-a/report.ts | 37756 | `338cc4020863f09c100f315951207b731b9f8d594b2e982d175ecab10260a616` |
| scripts/crypto-benchmark/phase-a/phase-a.node.ts | 65008 | `fb61e63ee73252954666facbfca4b974c071ad14dc2be4c5f2dcfb2716eba2e8` |

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
proof. No historical-baseline freshness/equivalence claim is made.

## Limitations

- One authorized A2 diagnostic only. No A0/A1 rerun, no A3–A6, no full Phase A,
  no heavy/production crypto, no format freeze.
- A2 is one synthetic 32-byte illustrative wrapper round trip per child through
  the existing public factory. It does not establish a production wrapper format,
  per-object production performance, or a cap/profile decision.
- Two internal KDF derivations occur inside the A2 seal/open path. They are not
  the direct A1 KDF-control measurement.
- One Windows x64/Bun 1.3.10 host only. No macOS/Linux, Node-runtime, OpenCode
  plugin-runtime, or cross-platform proof.
- Three samples are a probe, not a statistical basis. No p95 or production
  performance claim.
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
- The current README A2 planning copy is stale after this result. Per bounded
  scope it was not edited; the parent/docs lane should reconcile after review.

## Next review

This is one-host synthetic A2 diagnostic evidence only. A2 source/observation
review and reconciliation are required before any further A2 execution, production
sealing, format freeze, or CRYPTO-01 gate claim. CRYPTO-01 remains not passed.
