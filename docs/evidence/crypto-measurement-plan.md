# CRYPTO-01 Measurement Evidence Plan — Small-Only Phase A

Status: **IN PROGRESS — PREPARATION + A0/A1/A2 DIAGNOSTICS ONLY. NOT A GATE PASS,
PROFILE/PARAMETER SELECTION, OR A3–A6/GROUPED EXECUTION AUTHORIZATION.** Recorded
2026-10-19; updated 2026-10-19. Validation owner: orchestrator.

The plan and harness reported 45 Node mock tests plus scoped TypeScript `noEmit` PASS on
the pre-actual A2 source. The source is unchanged and checks were not rerun after the A2
actual. One authorized A0-only bridge invocation ran: 3/3 children exit 0, accepted and
closed. One authorized A1-only KDF-control invocation ran: 3/3 samples, 0 failures,
1,259 ms; raw KDF 239.6719 / 245.0369 / 270.5906 ms (n=3, min/median/max only), accepted
and closed only. One authorized A2-only 32-byte illustrative-wrapper round trip then ran:
3/3 samples, 3 starts, 3/3 equality, 0 failures, inner/outer exit 0, 2,004 ms. Seal was
252.1068 / 252.6067 / 274.2792 ms; open was 221.8906 / 222.7536 / 223.0382 ms
(min/median/max, n=3); artifacts were 148 bytes each. No p95 or historical comparison is
claimed. Runtime was Bun 1.3.10 win32/x64, Node compat 24.3, libsodium 1.0.22. The A2
observation review is active, not accepted or closed.

- CRYPTO-01 remains **In progress and not passed**. Candidate crypto values are gate
  inputs, not defaults ([SECURITY.md §3](../V2/SECURITY.md#3-cloud-crypto-policy-crypto-01),
  [ROADMAP.md CRYPTO-01](../V2/ROADMAP.md#m5--manual-sync-crypto-identity-revisions)).
- A0 measured no KDF, seal, or open and recorded zero periodic working-set polls; its
  numeric deltas remain boundary observations, not periodic peaks. Evidence:
  [crypto-a0-bridge.md](crypto-a0-bridge.md).
- A1 was KDF-control only and recorded 15/15/17 best-effort polls; its incremental deltas
  remain boundary observations, not periodic peaks. Lifetime peak is separate. Evidence:
  [crypto-a1-control.md](crypto-a1-control.md).
- A2 is one synthetic 32-byte illustrative wrapper with a wrapper passphrase, not an
  object root, production wrapper format, or JSON field schema. Its pair performs two
  internal KDF passes; `kdfControlExecuted: false` does not mean zero KDF. A2 recorded
  30/30/32 best-effort polls; its incremental deltas are boundary observations, not
  continuous peaks, and there is no hard memory cap. Physical-memory read failures were
  0 and cleanup uncertainty was false. Evidence:
  [crypto-a2-container.md](crypto-a2-container.md).
- Source and package hashes in the A0/A1/A2 records are metadata only; installed archive
  integrity is unverified and no historical-comparability claim is made.
- A3–A6 remain blocked. A grouped small A3–A6 plan is under review only; no
  implementation or execution is approved. The full `--run-phase-a` path remains
  fail-closed and heavy Phase B is unrun. One A2 invocation is consumed; it is not
  standing rerun permission. A0/A1 were not rerun.
- This document does not self-approve any gate and does not request a human decision.
  The owner's broad local-work authorization permits preparation and review, not
  production sealing or global crypto parameter selection.
- The V1 archive is a **historical record, not the V2 specification**. Its recorded
  values, caps, and resource results are reused only as bounded historical evidence
  with the qualifications in §3.

## 1. Question this plan answers

The future CRYPTO-01 evidence needs to establish, for the existing container rather
than a new cipher core:

1. the per-object Argon2id cost when each cloud object is sealed and opened separately,
   including small key-wrapper payloads where KDF overhead dominates;
2. whether the existing container's measured time/working-set behavior is compatible
   with an owner-approved memory budget and UX expectation; and
3. whether the effective 66 MiB artifact cap remains the working cap rather than being
   relaxed toward the 100 MiB cloud ceiling by assertion.

This plan deliberately does **not** answer product memory budget, format freeze,
per-object KDF acceptance, cross-platform support, or production performance. Those
remain owner/gate decisions (§7).

## 2. Existing seams and constraints (read-only map)

| Seam | Source location | Planning consequence |
| --- | --- | --- |
| Public factory | `createCheckpointCryptoFactory` in `src/core/crypto/container.ts:122-143` | Future probe must pass an explicit allow-list definition. Unknown policy IDs fail before crypto work. No registry or product-profile change is needed. |
| Seal derivation | `seal` in `container.ts:154-198`; Argon2 call at `:183` | One fresh salt and one `crypto_pwhash` per object. There is no key cache or derived-key reuse. |
| Open derivation | `openAndStage` in `container.ts:604-675`; Argon2 call at `:644` | One derivation per opened object after header/profile/cap checks. Seal and open each pay a full KDF pass. |
| KDF | `sodiumArgon2idDerivation` in `src/core/crypto/kdf.ts:90-100` | Synchronous `crypto_pwhash` with the definition's `opsLimit`/`memLimit`. Promise wrapping does not make it nonblocking. |
| Policy factory / probes | `CryptoFactoryTestSeams` in `container.ts:109-116`; `createCheckpointCryptoFactory` in `:122-143` | Only derivation injection is exposed as a test seam. Container cases must use the public `seal`/`openAndStage` boundaries; the KDF-only control may use the existing diagnostic `crypto_pwhash` path or a reviewed equivalent timer. No new core instrumentation is authorized. |
| Streaming gzip open | `src/core/crypto/gzip-stream.ts:364-373` | Decrypted output is staged as chunks and concatenated into one payload. Open peak may approach ~2× decompressed bytes plus inflater scratch/runtime; **this is an estimate, not a measurement**. |
| Candidate profile | `src/tui/wiring/experimental-profile.ts:49-69` | Candidate values: Argon2id 2 ops / 128 MiB, 16-byte salt, 64 KiB frames, 66 MiB artifact cap, 64 MiB compressed cap, 256 MiB decompressed cap, ratio 128. All of these parameters — ops, memory, salt, frames, and caps — are unselected candidates, not V2 production defaults. |
| Cap tests | `tests/core/crypto/test-only-support.ts:7,45-69`; `tests/core/crypto/fail-closed.test.ts:280-370` | Tiny test-only caps prove parsing/fail-closed logic only. They do **not** prove resource fit for a 66 MiB artifact or 256 MiB decompressed payload. |

Container cases use only the existing factory and public crypto boundaries; the KDF-only
control uses the existing diagnostic path or a reviewed equivalent. `src/core/**` is
read-only for this work and must not be modified without the Gate 3 process. No policy
registry, experimental-profile, product source, config, lockfile, test, or host state
changes are part of this plan.

## 3. Historical evidence baseline (bounded, KDF-only)

The accepted historical result for the 2 ops / 128 MiB candidate is:

| Metric | Historical value |
| --- | --- |
| KDF samples | 30 fresh child processes, sequential, zero failures |
| p50 / p95 / max KDF latency | 247.58 / 267.55 / 269.83 ms |
| Sampled incremental working-set max | 143.21 MiB |
| Process lifetime peak working-set max | 376.66 MiB |
| Host/runtime | Windows 11 x64, i5-12400F, 31.84 GiB RAM, Bun 1.3.10, libsodium-wrappers-sumo 0.8.4 / libsodium 1.0.22 |

Sources: V1 deepwork state lines 383-386; archived
[validation E43](../archive/v1/validation-and-open-questions.md#2-tested-evidence-what-was-observed)
(line 81); archived
[decision log 2026-10-11](../archive/v1/decision-log.md#f-change-control) (line 153).

Boundaries of this evidence:

- It is **KDF-only**. It does not measure the container, gzip staging, the plugin
  runtime, seal/open of real wrapper payloads, or UI responsiveness.
- It is **one Windows host/runtime**. No macOS, Linux, Node-runtime, or Bun/Node parity
  claim follows.
- The 128 MiB value is the Argon2 **memory parameter**, not a process budget. The
  recorded lifetime peak (376.66 MiB) already exceeds it.
- Working-set sampling is approximate; brief peaks may be missed. It is not private or
  commit memory.
- Before any reuse, record and verify source freshness: repository/benchmark source
  hashes and the pinned libsodium package/version/integrity actually used. If they do
  not match the historical baseline, label results as a new baseline rather than
  silently comparing them.
- The existing 658-test root regression is behavioral evidence, not resource evidence.

## 4. Measurement rules for the future probe

- **Per-object KDF:** every sealed object pays one Argon2 pass; every opened object pays
  another. There is no key cache. Small wrappers still pay the full pass. The sequential
  two-wrapper case exists specifically to expose repeated per-object overhead.
- **Separate operations:** time `seal` and `openAndStage` separately for every container
  case. Record end-to-end operation time; do not collapse both directions into one
  number. The KDF control case measures the KDF-only interval.
- **Samples:** Phase A proposes **3 fresh child samples per case**, not 3 repetitions in
  one child. Three samples are a probe proposal, not a statistical basis. **Do not
  report p95 or make a production performance claim from 3 samples.** Report every
  sample plus n, min, median, and max.
- **Round-trip:** compare the opened payload with the original synthetic plaintext in
  memory by byte equality (a digest may be computed in memory only, and only a boolean
  match may be reported). Never persist plaintext, keys, ciphertext, raw byte dumps, or
  digest values. Server-side metrics are never produced or persisted; the API/server is
  not involved.
- **Data handling:** synthetic root/password/salt/payload bytes are generated in child
  memory. Ciphertext stays in memory where practical. No plaintext or key temporary
  files, no session/native host data, no DB, no OS credential store, no account/cloud
  access, and no product logs.
- **Memory labels:** keep baseline working set, sampled incremental working-set delta,
  and process lifetime peak distinct. Do not call any of them a product cap. No private
  commit measurement is available from the existing Windows sampler.
- **No hidden repetitions:** no discarded samples, no retries, and no pooling of
  unrelated cases.

## 5. Proposed Phase A cases (small only)

These are **proposals for review**, not an execution list. All cases use the existing
public factory with an explicit candidate definition; no registry or product-profile
change. All payloads are synthetic and incompressible where stated.

| ID | Case | Payload / operation | Purpose |
| --- | --- | --- | --- |
| A0 | No-KDF baseline | Process start + `sodium.ready`; no `crypto_pwhash` | Separate runtime/WASM baseline from KDF cost. |
| A1 | KDF control | Argon2id 2 ops / 128 MiB; synthetic password + 16-byte salt | Compare against historical KDF-only evidence on the current source/runtime. |
| A2 | Illustrative wrapper | Seal then open a 32-byte synthetic payload with a wrapper passphrase; illustrative only, not an object root or frozen format | Smallest wrapper-shaped container case; full per-object KDF. |
| A3 | Illustrative wrapper | Seal then open ~256 random bytes | Illustrative wrapper-size case. **Not a frozen V2 wrapper format** and not a format claim. |
| A4 | Small object | Seal then open 1 KiB incompressible payload | Small cloud object. |
| A5 | Frame-boundary object | Seal then open 64 KiB incompressible payload | One full plaintext frame; still small relative to caps. |
| A6 | Sequential wrappers | Two seal+open pairs in one child (two fresh salts) | Repeated per-object KDF with no key cache; measures within-process repetition. |

Timing for A2-A6 records seal and open separately and also records the KDF window if
the reviewed harness can isolate it without modifying core. A1 remains the KDF-only
control. A0 is not included in KDF latency summaries.

Execution state (2026-10-19):

- **UNRUN:** A3–A6 and the full 7 cases × 3 = 21 child starts. There is no full Phase A
  run.
- **Executed once each:** A0-only (3 starts), A1-only KDF control (3 samples / 0
  failures), and A2-only 32-byte illustrative wrapper (3 samples / 3/3 equality / 0
  failures).
- **A2 observation review active:** not accepted or closed. A2 is not a production
  wrapper, object root, or JSON format.
- **Grouped A3–A6 small plan under review only:** no implementation or execution is
  approved.
- **Blocked:** A3–A6 actual work, the full `--run-phase-a` path, and any A0/A1/A2 rerun
  or automatic promotion. `--run-phase-a` fails closed; the one reviewed A2 invocation
  is consumed and is not standing permission.

Proposed full-run envelope: **7 cases × 3 fresh children = 21 child starts maximum**,
strictly sequential. This is a run-wide cap, not a product cap. A0, A1, and A2 used 3
starts each. A failed `seal`/`open` is reported; safety/hang failures stop the run. No
automatic retry, resume, or case escalation.

Even small wrapper cases can allocate large memory because the KDF/WASM work is
independent of payload size. Small ciphertext does **not** imply small process usage.

## 6. Operational safety plan (numeric bounds proposed for review)

These are proposed **operational safety bounds**, not product memory budgets or crypto
parameters. They remain subject to safety review for further execution; the A0/A1/A2
observations do not authorize A3–A6 or any rerun. They are not inferred from the
historical 128 MiB KDF memory parameter.

- **Concurrency:** exactly one child process at a time.
- **Parent deadline:** per-child wall deadline **45 s** covering startup, seal, open,
  and reporting; **5 s** termination grace after deadline. Run-wide deadline **30 min**
  and the 21-child cap above. On expiry: terminate the owned child, mark the sample
  failed, and stop the run; no retry. The maximum child envelope is
  21 × (45 + 5) = 1,050 s (17.5 min), below the run-wide deadline; the remaining
  time is for bounded preflight, sampling, and reporting. These are operational
  guards, not a product latency budget or execution authorization.
- **Owned-child termination:** record the child PID and only terminate children created
  by this run. The future runner must implement and prove termination of the owned
  process tree, including descendants, without relying on PID reuse assumptions. The
  existing benchmark's direct `proc.kill()` is not a reviewed tree-termination proof.
- **Output caps:** per child, retain at most **512 KiB** each for stdout/stderr; per run,
  at most **4 MiB** total retained output. Discard excess, mark overflow, and fail closed
  rather than buffering without bound. Output contains only synthetic case IDs, timings,
  sizes, and status; no payload bytes, keys, salts, or digests.
- **Preflight:** require at least **2 GiB free physical memory** before the run and stop
  if it falls below **1 GiB**; do not run alongside another benchmark or probe.
- **Memory measurement:** reuse Windows `GetProcessMemoryInfo` working-set sampling and
  lifetime peak where applicable. This is sampling only. It is **not** hard memory
  containment, not private/commit measurement, and not a Job Object claim. No
  `--max-old-space-size` or similar flag covers WASM/native allocation.
- **Failure behavior:** a timeout, termination uncertainty, output overflow, unexpected
  runtime/version mismatch, or missing child completion is a failed probe. Retain only
  bounded diagnostics; do not guess success.

The executed A0, A1, and A2 observations each used the parent-fixed 45 s + 5 s per-child
bound (3 starts = 150 s envelope), a 300 s outer deadline, and a 4 MiB combined
in-memory capture cap, with no output files. Their best-effort polls (A0 zero, A1
15/15/17, A2 30/30/32) leave incremental working-set labels as boundary observations,
not time-series peaks. Any grouped A3–A6 planning must reuse the same operational bounds;
no new execution is authorized.

The exact runner source, monitor behavior, and the numeric bounds above require
independent source review before any further process launch. This plan does not approve
an existing script as the container probe; the existing benchmark harness measures KDF
only and has no run-wide deadline, no retained-output cap, and no reviewed process-tree
termination.

## 7. Deferred Phase B and open gate inputs

Deferred to a separate plan, safety review, and explicit owner parameter decisions:

- 8 MiB payload, near-66 MiB artifact, and 256 MiB decompressed/expansion boundary
  cases, including exact cap-boundary acceptance/rejection.
- 66 MiB effective cap versus the 100 MiB cloud ceiling. The effective cap is **not**
  relaxed by assertion.
- Node/Bun parity, real OpenCode plugin runtime, macOS/Linux, CPU/UI event-loop
  responsiveness, and concurrent operations.
- Any per-object KDF acceptance decision, derived-key optimization, or production
  profile/format selection.

There is no automatic escalation from Phase A to Phase B, no retry, and no re-use of a
Phase A authorization for heavier work.

Open gate unknowns that this plan cannot close:

1. Owner-approved product memory budget; none exists (128 MiB is a KDF parameter).
2. Container/header format freeze and wrapper layout (O-02; provisional only).
3. Per-object KDF acceptance for small wrappers and cloud-object frequency.
4. Source freshness of historical evidence (hash/version verification).
5. Synchronous KDF CPU/UI blocking and the execution strategy (worker/threads unproven).
6. Node/Bun and package-runtime parity.
7. Real OpenCode plugin runtime behavior.
8. Unmeasured operating systems and platforms.

## 8. Authorization sequence

1. A0-only bridge observation accepted and closed only.
2. A1-only KDF control observation accepted and closed only; not a CRYPTO gate pass.
3. A2-only illustrative wrapper observed once. Its observation review is active, not
   accepted or closed; this is not a production/format approval.
4. Grouped A3–A6 small-case planning is under review only; no implementation or
   execution is approved.
5. A3–A6, the full `--run-phase-a` path, and any A0/A1/A2 rerun remain blocked. The one
   reviewed A2 invocation is consumed and is not standing permission.
6. Separate review and explicit authorization are required before any further crypto
   execution, Phase B, or production crypto decision.

Until such review, **no further A1/A2 KDF or container/seal/open work occurs**; A3–A6
remain blocked; no production sealing is enabled. CRYPTO-01 and AUTH-01 remain
unpassed. This document does not self-approve any gate and does not request a human
decision now.

## 9. Source anchors

- [SECURITY.md §2-§4](../V2/SECURITY.md#2-key-hierarchy), [§10](../V2/SECURITY.md#10-gates-and-research-evidence)
- [ROADMAP.md CRYPTO-01](../V2/ROADMAP.md#m5--manual-sync-crypto-identity-revisions)
- [ARCHITECTURE.md §10 evidence map](../V2/ARCHITECTURE.md#10-evidence-map-existing--proposed--host-gate)
- `src/core/crypto/container.ts` (`createCheckpointCryptoFactory` 122-143; `seal` 154-198; `openAndStage` 604-675)
- `src/core/crypto/kdf.ts` (synchronous `crypto_pwhash` 90-100)
- `src/core/crypto/gzip-stream.ts` (staged output + concat 364-373)
- `src/tui/wiring/experimental-profile.ts` (candidate values 49-69)
- `tests/core/crypto/test-only-support.ts`, `tests/core/crypto/fail-closed.test.ts` (test-only caps)
- `scripts/crypto-benchmark/README.md`, `supervisor-lib.ts`, `lib/winmem.ts`, `lib/report.ts`
  (Windows working-set sampler; no hard memory cap)
- Current sanitized observations: [crypto-a0-bridge.md](crypto-a0-bridge.md),
  [crypto-a1-control.md](crypto-a1-control.md), [crypto-a2-container.md](crypto-a2-container.md)
- Archived history: [validation E43](../archive/v1/validation-and-open-questions.md#2-tested-evidence-what-was-observed),
  [decision log 2026-10-11](../archive/v1/decision-log.md#f-change-control),
  V1 deepwork state lines 383-386.
