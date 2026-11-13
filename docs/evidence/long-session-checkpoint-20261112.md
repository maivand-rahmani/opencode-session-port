# Long-session checkpoint failure — diagnosis and fix (2026-11-12)

Status: **owner-directed local fix; verified by focused tests and a read-only
real-data reproduction.** This is not a release, host-compatibility, or
production-crypto approval.

## 1. Reported symptom

Running `/checkpoint` in a long-session workspace showed the generic error
notification after the password prompt:

```
Checkpoint failed
Checkpoint failed; no artifact was written.
```

That exact copy is the sanitized **unknown-category** fallback in
`src/tui/wiring/reports.ts`. It carries no cause, so the report could not
distinguish a size-cap rejection, memory exhaustion, or a filesystem error.

## 2. Evidence collected (read-only)

The local OpenCode database was inspected **read-only** (`PRAGMA query_only`),
never written. For the active workspace project (246 sessions, 19,616 messages
at inspection time):

| Measurement | Value |
| --- | --- |
| Stored message JSON (`session_message.data`) | 195.2 MiB |
| Checkpoint payload after collection/serialization | **244.1 MiB** |
| Gzip output of that payload | **65.04 MiB** (ratio 3.01) |
| Previous `maxCompressedBytes` | 64 MiB |
| Previous `maxArtifactBytes` | 66 MiB |
| Previous `maxDecompressedBytes` | 256 MiB |

The full checkpoint pipeline was then run over those real records through a
fake host port (dependency closure included: 247 sessions, 22,279 messages)
with the real crypto container. Results before the fix:

```
[mem] after collection:                 rss=1373.8 MiB heapUsed=341.0 MiB
[mem] after eager serialization:        rss=2491.8 MiB heapUsed=444.1 MiB
   serialized bytes: 244.1 MiB in 1.1s
[mem] after seal:                       rss=2090.1 MiB heapUsed=709.9 MiB
ERROR after 5.8s
  name=CryptoContainerError code=compressed-limit-exceeded
  message=compressed gzip output exceeds the policy limit
```

Two independent defects are visible:

1. **Eager serialization memory spike.** `encodeJson` took the already-detached
   payload, produced a second full JSON snapshot, then one ~244 MiB JavaScript
   string, then one ~244 MiB byte array. RSS rose by ~1.1 GiB in one step
   (1.37 GiB → 2.49 GiB) and the host process also holds its own session state.
   On a long session this can fail with a catchable `RangeError`/out-of-memory
   error, which the reporter classified as `unknown`. That is the most plausible
   route to the observed generic toast: the reproduced cap failure instead
   raises `CryptoContainerError`, which would have shown the (now more specific)
   crypto copy, not the generic text in the screenshot.
2. **Size caps below real project size.** Even when memory survived, the
   65.04 MiB gzip output exceeded the 64 MiB compressed cap, and the artifact
   would have approached the 66 MiB artifact cap. The previous cap pair made
   that project permanently uncheckpointable.

A third, smaller defect: raw filesystem write errors (`ENOSPC`, `EACCES`,
`EPERM`, `EBUSY`) and `RangeError` both fell through to the same generic copy,
so the user could not tell what to do.

## 3. Change set

- **Bounded-memory streaming serialization**:
  `serializeCheckpointPayloadChunks` emits the exact same JSON bytes as
  `serializeCheckpointPayload`, record by record, in chunks no larger than the
  configured buffer (default 64 KiB). The checkpoint flow now hands this stream
  directly to `crypto.seal`, so the KDF completes before serialization starts
  and no whole-payload string/byte-array copy is ever materialized. Largest
  transient allocation is one session-info/message snapshot plus one record JSON
  string plus one output chunk.
- **Experimental size bounds raised** (owner-directed, format unchanged):
  artifact 560 MiB, compressed 512 MiB, decompressed 512 MiB. Profile code 1,
  Argon2id costs, 64-KiB framing, and the 128 expansion ratio are unchanged.
  The measured 244.1 MiB / 65.04 MiB project now fits with more than 2× headroom.
  A project whose serialized payload exceeds 512 MiB fails closed with a fixed
  size-limit reason and no artifact; nothing is truncated.
- **Actionable sanitized failures**:
  - Crypto container codes now append a fixed human reason and the exact
    allowlisted code (e.g. `compressed-limit-exceeded`,
    `decompressed-limit-exceeded`, `artifact-too-large`) to the existing
    crypto copy. Raw exception text is still never interpolated.
  - `RangeError` gets a dedicated resource-exhaustion copy instead of the
    generic fallback.
  - Raw filesystem error codes are classified through a fixed allowlist
    (`ENOSPC`, `EACCES`/`EPERM`/`EROFS`, `EBUSY`/`ETXTBSY`/`EMFILE`/`ENFILE`
    on write; `ENOENT`, `EACCES`/`EPERM`, `EISDIR`/`ENOTDIR` on read) with
    fixed copy. The code string itself is never echoed.

## 4. Verification

Focused tests:

- `bun test tests/core/sessions/serialize-stream.test.ts` — **24 pass / 0 fail**,
  7,996 expectations: eager byte-equality, chunk bounds (1, 7, 4,096, default),
  unicode/lone-surrogate escaping, null-prototype records, and fail-closed
  validation.
- `bun test tests/tui/orchestration/checkpoint-flow.test.ts` — **15 pass /
  0 fail**, 87 expectations: the flow seals the payload as multiple chunks no
  larger than 64 KiB and the concatenated bytes equal the eager serialization.
- `bun test tests/tui/wiring/reports.test.ts` — **24 pass / 0 fail**, 453
  expectations: every crypto code, resource copy, filesystem allowlists, and
  forged/unknown-code fallbacks.
- `bun test tests/core/crypto` — **112 pass / 0 fail**, 14,580 expectations.
- `bun test tests/package` — **65 pass / 0 fail** after updating the measured
  packed-file boundary from 85 to **86** (`src/core/sessions/serialize-stream.ts`
  is now a required packed path); both live `npm pack --dry-run --json` and
  `bun pm pack --dry-run` listings agree.
- `bun test --max-concurrency 4 --timeout 30000` — **1,330 pass / 1 skipped /
  0 fail**, 29,879 expectations across 87 files.
- `bun run typecheck` — clean (`tsc --noEmit`, exit 0).

A first default-concurrency full-suite run hit Windows ACL/private-directory
timeouts and a Bun `panic: integer overflow` in unrelated cloud/package tests;
the bounded-concurrency rerun above passed cleanly. That flakiness is an
environment observation, not a SessionPort code path changed here.

Real-data verification after the fix (same read-only project, now 248 seed
sessions; dependency closure included):

```
OUTCOME (7.8s): {"status":"written", sessionCount:249, encryptedBytes:93911024}
artifact file bytes: 93911024 (89.6 MiB)
streamed plaintext: 256797618 bytes (244.9 MiB), chunks=3919, largest=65536
sha256 expected=d8526766295181d5eef02bd6315923a3c1ca884e49cde6459d8e9e321f3198b2
sha256 actual  =d8526766295181d5eef02bd6315923a3c1ca884e49cde6459d8e9e321f3198b2
BYTE-IDENTICAL: true
parsed sessions=249 messages=22351
PEAK RSS (checkpoint flow): 1368.0 MiB
```

Before the fix the same class of payload peaked at **2,491.8 MiB** during eager
serialization and then failed on the 64 MiB compressed cap. After the fix the
checkpoint flow peaks at **1,368.0 MiB** (no serialization spike), streams
3,919 bounded chunks, writes an 89.6 MiB authenticated artifact, and an
independent re-serialization hashes exactly to the decrypted plaintext. The
higher peak later in the harness run (3,043 MiB) is the verification script
holding the host data, a second collection, the decrypted bytes, and the parsed
JSON simultaneously; it is not the checkpoint flow.

### Delivery to the running host

The host loads the configured local directory plugin through `tui.ts` →
`dist/tui.js`, so `bun run build:tui` was rerun after the final source change:
`build:tui ok: dist/tui.js (1,063,647 bytes)`. The rebuilt bundle contains
`serializeCheckpointPayloadChunks`, the new `560/512/512 MiB` bounds, and the
new fixed diagnostic copy. The global `cli.json` lists this local directory
before the cached `opencode-session-port@0.1.7` package; the host supervisor
deduplicates by plugin id (`sessionport`) and keeps the first configured
entry, so the rebuilt local bundle is the one that activates. A host restart or
the supervisor's plugin reload is required before the running TUI picks up the
new bundle.

## 5. Evidence boundaries

- The real-data reproduction used a **fake host port over read-only database
  records**, not the packed plugin inside a live TUI; message records were
  served in the host's settled shape (one unfinished assistant message was
  skipped so the post-password path could be exercised).
- The duplicate-plugin ordering/dedupe statement comes from the pinned
  OpenCode v2.0.22 clone in `.slim/clonedeps/repos/`; the running host is
  **2.1.1** and its loader was not instrumented. A host restart is the
  guaranteed way to load the rebuilt `dist/tui.js`.
- One Windows machine, one host database snapshot. No macOS/Linux, low-memory,
  or cross-version host claim follows.
- The cap revision is an experimental local bound, not a production crypto
  profile approval or a format freeze (O-01/O-02/O-03 remain OPEN).
- Restore of artifacts between 256 MiB and the new caps was not exercised
  end-to-end on a live host; the container round-trip tests and full suite are
  the recorded evidence. Restore still stages the whole authenticated payload
  in memory, so very large artifacts remain a bounded-memory concern.
