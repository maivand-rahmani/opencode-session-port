# Lossless checkpoint weight analysis (2026-11-13)

Question: can SessionPort checkpoints be made smaller **without dropping any
session or message**? This document answers with measurements only; it does
not change the artifact format. The artifact format/compression id remains a
PROVISIONAL owner decision (O-02) and is not inferred here.

## 1. Dataset

Read-only live database, active workspace project (`c35c8840…`):

- 252 project sessions, 253 with dependency closure, ~22,800 settled messages.
- Exact checkpoint payload: **260,510,617 bytes (248.44 MiB)** after the
  collector's settled-message filter.
- Content is dominated by tool results and reasoning:

| Message content | Bytes |
| --- | --- |
| `tool` items | 130.29 MiB |
| `reasoning` items | 88.12 MiB |
| `text` items | 2.94 MiB |
| Other message fields (`files`, `text`, `recent`, `snapshot`, `time`, `tokens`, `model`, …) | ~27 MiB |

Session info JSON is negligible (0.08 MiB). The payload has no whole-message
duplicates; only 0.01 MiB of content items repeat exactly.

## 2. Compression alternatives (lossless)

One continuous stream over the exact payload, no framing/encryption bytes:

| Codec | Output | Ratio | vs current gzip |
| --- | --- | --- | --- |
| gzip level 1 | 99.27 MiB | 2.50 | +9.7% larger |
| **gzip level 6 (current)** | **90.52 MiB** | **2.74** | baseline |
| gzip level 9 | 90.37 MiB | 2.75 | **0.17% smaller** |
| Brotli quality 9 | 65.55 MiB | 3.79 | **27.6% smaller** |
| Brotli quality 11 | 62.10 MiB | 4.00 | **31.4% smaller** |
| zstd level 3 | 76.04 MiB | 3.27 | 16.0% smaller |
| zstd level 19 | 63.12 MiB | 3.94 | **30.3% smaller** (93.5 s) |

The current artifact is 90.29 MiB for this payload, matching gzip level 6 plus
the small framing overhead. Raising the gzip level buys essentially nothing
because the data is mostly already-compressed-like tool/reasoning text and the
gzip window is only 32 KiB.

zstd level 19 and Brotli quality 11 are the strongest lossless options. zstd 19
took 93.5 s on one core for this payload; Brotli q11 was slower. Both need a
format change (a new compression id) and restore-side support; old gzip
artifacts would still need to be readable.

## 3. Exact-duplicate (dedup) potential

Across the full payload:

- 4,128 duplicate groups of strings ≥256 bytes, 9,463 occurrences.
- Naive duplicate bytes: **17.49 MiB** before compression (7.0% of the
  payload), before any reference/table overhead.
- Whole messages: no duplicates.
- Content items: 0.01 MiB duplicate.

A content-addressed string table could in principle remove up to ~17.5 MiB
before compression, but gzip/brotli already exploit much of the nearby
repetition, so the post-compression saving would be smaller. It also requires a
new payload shape and a restore-time rehydration step, plus exact-byte
verification. This is a format change, not a transparent optimization.

## 4. Conclusion

- **Without losing data, the realistic win is a stronger compressor**:
  zstd 19 or Brotli 11 can reduce the artifact by roughly 30% (90 MiB → ~62–63
  MiB) while preserving every session and message.
- **gzip level 9 is not worth it** (0.17%).
- **Dedup is possible but modest and complex** (≤7% pre-compression, less after
  compression).
- **The 85% reduction already implemented is not lossless**: it drops old
  subagent sessions by the user's chosen retention policy. The new native
  chooser lets the user pick **All sessions** when a full lossless checkpoint
  is required.

Implementing zstd/Brotli requires an owner decision on the provisional
artifact format: a new compression id/format version, seal/open support, and
backward reading of existing gzip artifacts. No such change is made here.

## 5. Evidence boundaries

- One Windows machine, one live project snapshot, read-only database access.
- Compression numbers are single-stream measurements without per-frame
  encryption overhead; the artifact adds a fixed 4-byte length per frame plus
  ~21 bytes of secretstream overhead per frame, negligible at these sizes.
- Brotli/zstd timings are indicative, not a performance claim.
- No cross-platform or host-version compatibility claim follows.
