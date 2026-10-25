# CRYPTO-01 Phase A — A1 KDF-control and A2 container source with one observation each

**STATUS: A0 + A1 OBSERVATIONS ACCEPTED/CLOSED; A2 CONTAINER OBSERVED ONCE (ONE HOST; REVIEW PENDING).**

This directory contains the inert source for the A0 baseline bridge and the A1/A2
small-case phases. A0 and A1 observations were accepted separately; this document
does not rerun them. One authorized A2 32-byte illustrative round trip has been
executed.

- **CRYPTO-01 remains IN PROGRESS AND NOT PASSED.**
- **No full Phase A authorization exists.** `--run-phase-a` fails closed before
  runtime setup or any child launch; heavy Phase B is unrun.
- **`--control-a1-only` has been executed once under a bounded authorization.**
  That one invocation is consumed and is **not standing permission**; do not rerun
  it. Its observation was accepted/closed only.
- **`--container-a2-only` has been executed once under a bounded authorization.**
  That one invocation is consumed and is **not standing permission**; do not rerun
  it. A2 observation review is active and not yet accepted/closed.
- **A3–A6 and grouped A3–A6 work remain blocked.** The grouped small plan is under
  review only; no implementation or execution is approved.
- `--bridge-a0-only` remains the legacy reviewed A0 mode. Do not rerun it now; its
  accepted A0 observation/runtime path is unchanged.
- Node unit/mock tests do not prove a Bun measurement, a Windows resource result,
  cross-platform behavior, or product readiness. The 45 mock tests and scoped
  typecheck evidence were reported on the pre-actual A2 source; the source is
  unchanged and the checks were not rerun after the A2 actual.
- No Phase B, heavy payload, cap relaxation, format freeze, profile selection, or
  production-memory-budget work is included.

## Actual run modes

| Mode | Behavior |
| --- | --- |
| `--control-a1-only` | **EXECUTED ONCE (2026-10-19); one invocation consumed, no rerun permission; observation accepted/closed**: A1 only, 3 fresh children, max 3 starts, one existing `crypto_pwhash` per child. |
| `--container-a2-only` | **EXECUTED ONCE (2026-10-19); one invocation consumed, no rerun permission; observation review pending**: A2 only, 3 fresh children, max 3 starts, one 32-byte illustrative seal/open round trip per child. |
| `--bridge-a0-only` | Legacy reviewed A0 bridge: 3 fresh A0 children, max 3 starts, report mode `a0-bridge`. Do not rerun in this phase. |
| `--run-phase-a` | **FAILS CLOSED now** (exit 1) before runtime/ports/child setup. Full A0-A6 execution is not authorized. |
| no flag | Usage error; there is no default run. |
| `--child-case A0` | Internal supervisor-spawned child only; requires `a0-bridge` plan mode + nonce/parent-PID context. |
| `--child-case A1` | Internal supervisor-spawned child only; requires `a1-control` plan mode + nonce/parent-PID context. |
| `--child-case A2` | Internal supervisor-spawned child only; requires `a2-container` plan mode + nonce/parent-PID context. |
| `--child-case A3..A6` | Rejected before any crypto import; actual A3-A6 entry is blocked. |

The full A0-A6 definitions and the 21-child full plan remain in source as
planning/mock-test artifacts (`FULL_PHASE_A_PLAN`). They are not an actual
authorization, and the full CLI does not call them.

## Report behavior

An **A0 bridge** report must truthfully identify `harness.mode: "a0-bridge"`,
`harness.caseIds: ["A0"]`, `harness.maxChildStarts: 3`, no A1-A6/KDF/container
coverage, and `crypto01Passed/profileSelected/formatFrozen/phaseBExecuted: false`.

An **A1 control** report must truthfully identify `harness.mode: "a1-control"`,
`harness.caseIds: ["A1"]`, `harness.maxChildStarts: 3`, `coverage.a1ControlExecuted`
from actual A1 samples, `coverage.kdfControlExecuted` from actual A1
`kdfControlMs`, `coverage.a2ToA6Executed: false`, and
`coverage.containerSealOpenExecuted: false`. It must not pretend the A1 control
performed container/seal/open work.

An **A2 container** report must truthfully identify `harness.mode: "a2-container"`,
`harness.caseIds: ["A2"]`, `harness.maxChildStarts: 3`,
`coverage.a2ContainerExecuted`/`containerSealOpenExecuted` from actual A2 samples,
`coverage.kdfControlExecuted: false`, and `coverage.a3ToA6Executed: false`. A2's
seal/open path performs internal KDF passes; `kdfControlExecuted: false` is not a
zero-KDF claim.

The full plan is deliberately retained for mock tests and planning; a full mock
report may show A1-A6/container coverage, but it is not an actual run.

## What the A1 control did once

One authorized A1-only KDF-control invocation ran on 2026-10-19: 3/3 samples, 3
starts, 0 failures, inner/wrapper exit 0, 1,259 ms. Raw KDF intervals were
239.6719 / 245.0369 / 270.5906 ms (n=3, min/median/max only; no p95 and no
historical comparison). Physical-memory read failures were 0 and cleanup
uncertainty was false. The observation is one host only and was accepted/closed
only.

The control performs only A1:

| ID | Case | Child work |
| --- | --- | --- |
| A1 | KDF control | Lazily load existing `libsodium-wrappers-sumo`, await `sodium.ready`, then one existing `crypto_pwhash` at 2 ops / 128 MiB, 16-byte random salt, 32-byte output, synthetic password/salt only |

A1 does **not** import the public container, call `seal`/`openAndStage`, use a
product profile/registry, or add a key cache. A3–A6 actual child entry remains
blocked before crypto import.

## What the A2 container did once

One authorized A2-only 32-byte illustrative-wrapper round trip ran on 2026-10-19:
3/3 samples, 3 starts, 3/3 equality, 0 failures, inner/outer exit 0, 2,004 ms.
Seal was 252.1068 / 252.6067 / 274.2792 ms; open was 221.8906 / 222.7536 /
223.0382 ms (n=3, min/median/max only; no p95 and no historical comparison).
Artifacts were 148 bytes each. Each pair performs two internal KDF passes, so
`kdfControlExecuted: false` is not a zero-KDF claim. The 32-byte payload uses a
synthetic wrapper passphrase and is illustrative only: it is not an object root,
production wrapper format, or JSON field schema. Physical-memory read failures
were 0 and cleanup uncertainty was false. A2 observation review is active, not
accepted or closed. Evidence: [crypto-a2-container.md](../../../docs/evidence/crypto-a2-container.md).

## Candidate boundary

The candidate values are measurement inputs only: ID
`sessionport-phase-a-candidate-2ops-128mib-not-selected`, Argon2id 2 ops /
128 MiB, 16-byte salt, 64 KiB frame candidate, and borrowed experimental limits.
They are **not V2 defaults or a selected production profile**. The 128 MiB value
is an Argon2 memory parameter, not a process memory budget. A1 uses the existing
`crypto_pwhash` call; A2 uses the existing public factory seal/open path. No
production key-wrapper format or JSON metadata schema is implied.

## Supervision launch guard

The parent generates a fresh single-use nonce for each spawned child, passes it
via the child environment together with the supervisor parent PID and parent-owned
plan mode (`a0-bridge` or `a1-control`), and includes the same nonce and plan mode
in the single `start` command.

Before any crypto import, the child:

1. allows only A0 with `a0-bridge`, A1 with `a1-control`, or A2 with `a2-container`; A3–A6 are rejected;
2. requires a valid supervisor nonce in its environment;
3. requires a valid expected parent PID in its environment;
4. requires `process.ppid` to equal that expected parent PID, failing closed if
   the parent PID is unavailable/invalid;
5. later requires the start-command nonce, case, and plan mode to match the
   supervisor context before any work.

A manual bare `--child-case A0` plus a fabricated start command does not satisfy
this context. This is an explicit accidental-invocation guard, **not a security
sandbox or hostile-user proof**. A caller that forges the supervisor environment
is outside its threat model. The nonce is not logged or reported.

## Candidate/full timing and report behavior

- `seal` timing covers awaiting and **fully consuming the returned async byte
  source into memory**. Timing generator creation alone is not accepted.
- `open` timing covers the complete `openAndStage` call.
- A1 records only the synchronous `crypto_pwhash` interval; it does not call the
  public container, seal, or open. Seal/open timing text applies only to future
  A3-A6 container work; A2 has its own seal/open timing and internal KDF passes.
- Seal and open durations are separate; A6 would record two operation records per
  child.
- Round-trip verification is an in-memory **boolean byte-equality** check only.
  Payload bytes, keys, salts, ciphertext, digests, artifact identities, and raw
  vendor error text are never written to stdout/stderr or the report.
- Total artifact byte count is recorded only because it is observable by
  consuming the sealed source. Compressed gzip byte counts and frame counts are
  not exposed by the public contract and are not invented.
- Report statistics are **count / min / median / max** only. Three samples are a
  probe, not a statistical basis; no unsupported percentile, historical
  comparability claim, or production performance claim is made.
- Baseline working set, sampled incremental working-set delta, and process
  lifetime peak are separate labels. `sampledIncrementalWorkingSetBytes` is a
  boundary delta. A0 recorded zero periodic polls; A1 recorded 15/15/17 and A2
  recorded 30/30/32 best-effort polls. Even with polls, the incremental value is
  not a guaranteed continuous time-series peak, and the lifetime peak is a separate
  process-lifetime label. `sampledPollCount` and `samplingSpanMs` are reported to
  make that visible. These are physical-residency working-set values, **not**
  private/commit memory, heap, or a product cap. Parent polling can miss short
  spikes.
- Physical-memory read failures during a monitored interval **stop the run with a
  safe error and are counted**; successful samples do not prove uninterrupted
  monitoring.

## libsodium metadata evidence

The report records:

- the resolved installed `libsodium-wrappers-sumo/package.json` path;
- its version (`0.8.4` expected/pinned);
- the SHA-256 of that metadata file's bytes;
- the matching `bun.lock` entry's resolved version and integrity string;
- `integrityKind: "lock-metadata"`;
- `installedBytesIntegrityVerified: false`;
- an explicit note that lock integrity is metadata only.

A version string is **not** an integrity proof. Installed/extracted package bytes
and archive hashes were not verified, and no historical-baseline comparison is
claimed. No libsodium load/native crypto occurs during metadata collection.

## Operational bounds

| Bound | A0/A1/A2 observations | Full planning/mock |
| --- | --- | --- |
| Per-child deadline | 45 s | 45 s |
| Stop grace | 5 s | 5 s |
| Child starts | **3 max** | 21 max |
| Maximum child envelope | 3 × 50 = 150 s | 21 × 50 = 1,050 s |
| Run-wide deadline | 30 min | 30 min |
| Protocol line | 64 KiB | 64 KiB |
| Retained stdout/stderr | 512 KiB each per child | same |
| Retained output | 4 MiB per run | same |
| Physical-memory preflight | ≥ 2 GiB | same |
| Physical-memory soft stop | < 1 GiB | same |

The physical-memory values are operational safety guards, not a product memory
budget. Available physical memory is read through Windows
`GlobalMemoryStatusEx` when available, with `os.freemem()` as a clearly labeled
physical-free fallback; no unit test performs an OS probe.

No retries, resume, or case escalation exist. Missing/malformed/overflowing/
timed-out/aborted/runtime-mismatched protocol or completion conditions fail
closed and stop the run. A reported seal/open failure would be recorded as a safe
case failure without being silently retried.

## Process supervision and termination caveat

The parent spawns only `phase-a.node.ts --child-case A0` or `--child-case A1` one
at a time and does not use a shell. The child imports no
child-process/external-command API and spawns nothing.

The parent retains the exact child handle and terminates only that owned handle;
it does not kill arbitrary PIDs or assume PID reuse safety. It verifies the owned
child's exit. If exit cannot be verified within the 5 s grace window, the run is
classified as termination-uncertain and stops without success.

This is **not hard containment**, not a Job Object, and not a reviewed
descendant-tree termination proof. The exact termination behavior still requires
independent review before any further execution authorization.

## Output protocol

Child stdout: one bounded JSON object per LF line.

- `ready`: protocol, pid, case ID, runtime identity, candidate, case plan.
- `complete`: protocol, pid, case ID, `ok`. Success carries case-specific
  timings; failure carries only an allowed safe failure code.
- `error`: protocol, case ID, allowed safe failure code.

Parent stdin: exactly one bounded `start` JSON line per child, including the
launch nonce.

The parent validates exact allowed fields/types, finite non-negative numbers,
case-specific operation counts, child runtime identity, `ready` before
`complete`, exactly one completion, output caps, deadline, parent-PID/nonce
context, and start binding. Raw child output is retained only within the caps and
is never echoed into the report.

## Files

- `protocol.ts` — bounded line assembly, exact message parsing, sequence state,
  launch nonce/start command.
- `cases.ts` — A0–A6 definitions, candidate, A0 bridge plan, A1 control plan, full planning plan.
- `child.ts` - lazy-crypto child workload, A0/A1/A2 plan-mode guard, A3-A6 rejection, launch guard.
- `supervisor.ts` — dedicated bounded parent runner with injected ports.
- `report.ts` — pure report/stat/label/coverage/evidence assembly.
- `phase-a.node.ts` — explicit CLI entry and Node mock test suite.
- `README.md` — this document.

Existing core and `scripts/crypto-benchmark/{supervisor.ts, supervisor-lib.ts,
lib/*}` are read-only inputs; only the new Phase A files are written. The older
KDF supervisor is not invoked or reused as this runner.

## Commands

Focused Node mock tests (no actual children, KDF, crypto, or OS measurements):

```text
cd cloud/api
node --import tsx --test ../../scripts/crypto-benchmark/phase-a/phase-a.node.ts
```

A1 control — **EXECUTED ONCE ON 2026-10-19. The one reviewed invocation is consumed;
there is no rerun permission. Do not run**:

```text
bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --control-a1-only
```

A2 container — **EXECUTED ONCE ON 2026-10-19. The one reviewed invocation is
consumed; there is no rerun permission. Observation review is active. Do not run**:

```text
bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --container-a2-only
```

Legacy A0 bridge — **already observed once and accepted separately; do not rerun
in this phase**:

```text
bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --bridge-a0-only
```

Full run — intentionally fail-closed now:

```text
bun scripts/crypto-benchmark/phase-a/phase-a.node.ts --run-phase-a
```

The actual control/bridge modes fail closed unless the runtime is exactly Windows
x64/arm64 with Bun 1.3.10. Actual runs write no files. A report would be a single
JSON object on stdout; progress/safe failures go to stderr. Node tests use only
injected fakes and are not a Bun measurement.

## Explicit non-goals and unresolved real-run gaps

- The A1 control and A2 32-byte round trip were each executed once on 2026-10-19;
  no repeat is authorized. The prior A0 bridge observation was accepted separately
  and is not rerun here.
- Only the one A1 KDF control and one A2 container round trip are actual; no full
  Phase A, A3–A6, heavy Phase B, or new OS memory probe has happened. A1 did not
  call the container/seal/open; A2's seal/open pair includes two internal KDF passes.
- No Phase B, 8 MiB/66 MiB/256 MiB cases, cap-boundary acceptance/rejection, or
  cap relaxation is included.
- No production profile, format freeze, product memory budget, cross-platform
  support, or plugin-runtime claim is made.
- The actual child termination/tree behavior, Windows FFI sampler behavior,
  `process.ppid` behavior, and Bun 1.3.10 runtime path are source-reviewed only
  and still require independent exact-source review before any further execution
  authorization.
- Installed libsodium package integrity and archive hashes remain unverified;
  lock integrity is metadata only. A1/A2 metadata is not a historical benchmark
  freshness proof and does not make a different-version or installed-byte
  equivalence claim. No historical-baseline comparison is made.
- Partial secret-redaction limits remain: the harness does not intentionally emit
  payload/key/salt/ciphertext/digest/error text, but general redaction of
  arbitrary runtime error strings is not proven and no broad guarantee is
  claimed.
- A passing Node mock suite proves only pure logic, mock orchestration, launch
  guards, and fail-closed branches. It does not prove Bun measurement or any
  cryptographic result.
