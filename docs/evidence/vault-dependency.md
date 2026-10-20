# AUTH-02 Vault Dependency — Preparation-Only Candidate Inspection

Status: **IN PROGRESS — CANDIDATE NOW PINNED FOR BOUNDED EXPERIMENTAL M3 SOURCE AFTER A WINDOWS SYNTHETIC PROBE PASS; NO AUTH-02 PASS, CROSS-PLATFORM, LOCKED-STORE, RESTART, OR SUPPORT CLAIM.**

> **Current amendment (2026-10-20):** `@napi-rs/keyring@2.1.2` is now selected and pinned as an
> exact external dependency for the bounded experimental M3 source, after a Windows x64 / Bun
> 1.3.10 synthetic probe passed: one exact UUID-derived entry, precheck absent, 32-byte readback
> matched, delete settled, final read absent, no retry or manual cleanup. PowerShell returned a
> null process `ExitCode` for the probe; the structured source-path result was `outcome=pass`, but
> exit zero was **not directly observed as an OS process exit code**. This is not a general
> AUTH-02 pass, cross-platform or support proof, locked-store/restart/persistence proof, or
> production-credential proof. See [vault-windows-synthetic-20261020.md](vault-windows-synthetic-20261020.md).
> Cross-process cooperating SessionPort owner locking is now implemented and was exercised with 14
> actual Windows child invocations (27 focused tests, 1 POSIX-only skip initially); it does not
> fence non-cooperative actors and has no automatic crash-stale break, and the existing
> private-ACL/symlink limits remain explicit. The dated preparation-only record below is retained
> as historical, not rewritten.

Recorded: 2026-10-19 (preparation-only sections). Current amendment: 2026-10-20. Validation owner: orchestrator. The dated 2026-10-19 record below captures the accepted
read-only, source/metadata inspection of a possible keyring-class dependency for AUTH-02. That
inspection did not record an install, native binding load, OS credential-store query, synthetic
credential write, runtime platform/Bun probe, or end-to-end device-auth flow. The broad
2026-10-19 local-work authorization does not authorize production credentials or actual OS
store access while the owner is away, and it does not turn this preparation into AUTH-02
acceptance.

## 1. Scope and verdict

| Item | Dated status (2026-10-19) |
| --- | --- |
| AUTH-02 | **In progress — preparation only** (dependency candidate inspection) |
| Candidate | `@napi-rs/keyring` **2.1.2** inspected read-only; **not selected or pinned** |
| Provider selection | **Not made** |
| Actual end-to-end dependencies | **AUTH-01 blocked; WEB-01 not started; API-01 partial** — unmet |
| Native binding | Not installed, not loaded |
| OS credential store | Not read, written, listed, or deleted |
| Runtime probes | None (no OS, Bun, persistence, locked/unavailable, size, or cancellation probe) |
| AUTH-02 gate | **Not passed**; original acceptance unchanged |

The original AUTH-02 requirements remain unchanged: a credential-store dependency must still
be selected, pinned, and validated; device authorization must run end-to-end; tokens and
key-wrapping material must persist only in the secure vault; unavailable/locked stores must
fail closed, with memory-only unlock allowed and no plaintext token/key fallback; encrypted
state/outbox keys and the atomic-replace single-writer state directory remain in scope. None
of those requirements is implemented or validated here. Memory-only unlock allowed remains
the recorded fallback status; no memory-only implementation is added by this record.

## 2. Exact candidate and provenance

| Field | Recorded value |
| --- | --- |
| Package | `@napi-rs/keyring` |
| Version | **2.1.2** |
| npm integrity | `sha512-9i1SR6tYeQ3o1beLeVMxhN6Fq513m9TZlTs+46+4JgvSNkaFoW9S4WrpV5MjzE+0CzVoC+dZ4RfZDIgW6+afnQ==` |
| npm `gitHead` | `52184fbebffeef8a061234f60f313c479b954f9f` |
| Verified annotated tag | `v2.1.2` tag object `6700db4ea02a8c83f62ce9b1f98f928caf2c90e2` |
| Release source base | `https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/` |
| Registry record | `https://registry.npmjs.org/%40napi-rs%2Fkeyring/2.1.2` |

The npm `gitHead` matches the verified annotated `v2.1.2` tag object. This establishes release
identity/provenance only. It is **not** runtime proof of the installed package, native binding
compatibility, OS support, Bun compatibility, persistence, or failure behavior. Published
platform artifacts are not an OS-support claim.

## 3. Release source inspection (read-only)

The exact release source was inspected, not installed or executed. Relevant release files:
`src/entry_builder.rs`, `src/options.rs`, `src/entry.rs`, `src/async_entry.rs`,
`src/result.rs`, `Cargo.toml`, and `Cargo.lock`. This record intentionally contains no raw
source capture or quoted implementation code.

### 3.1 Options and Linux backend selection

- `EntryOptions` exposes `{ linux?: { store?: 'secret-service' | 'keyutils' } }`.
- `Entry` and `AsyncEntry` accept the service/account names plus those options; passing
  `{ linux: { store: 'secret-service' } }` pins the Linux backend and fails closed if that
  backend is unavailable.
- The default Linux fallback is `keyutils`, which is **non-persistent across reboot**. The
  released source confirms this default.
- No intentional plaintext fallback was found. The native binding loader throws when the
  binding is missing.
- Dependency versions recorded in `Cargo.lock` include `core` 1.0.1,
  `secretservice-store` 1.0.1, `keyutils-store` 1.0.0, `secret-service` 5.2.0,
  `windows-native` 1.1.0, and `apple-native` 1.0.2. Declared crate features are defined in
  `Cargo.toml`, not in the lockfile; no platform-support conclusion follows from their
  presence.

### 3.2 Sync and async entry points

- `Entry` performs synchronous store calls and blocks the caller.
- `AsyncEntry` returns a Promise and uses the NAPI worker path for the store call.
- This is source-level behavior only. Thread-safety, Bun behavior, and actual NAPI worker
  scheduling were **not** exercised or proven.

### 3.3 Secret API and error surface

- `setSecret` accepts bytes as `Uint8Array`; `getSecret` resolves to
  `Promise<Array<number> | null>`; `deleteCredential` is supported.
- Missing entries return `null` or `false` (get vs delete); other failures throw unstructured
  errors. There is no portable taxonomy distinguishing a locked store from an unavailable
  store or from other operational failures.
- A `ByteSecret` API exists, but no established size cap was found; the supported secret size
  is undocumented in the inspected surface.
- Wrapper layers copy secret bytes (`to_vec` / `getVec`) and expose a JS `Array<number>`.
  **No explicit zeroization guarantee was found.** This record makes no "secure zero memory"
  or secure-clearing claim.

### 3.4 Abort and mutation uncertainty

- The async API accepts an `AbortSignal`, and the worker task uses an optional signal.
- The store calls are computed without an explicit abort check before the mutation. An
  aborted Promise is therefore **not proof that the operation was cancelled**.
- A set or delete whose outcome is not confirmed must be treated as an **uncertain mutation**.
  Reconciliation must use the exact same future unique synthetic entry; credential/entry
  enumeration is not an acceptable recovery mechanism. Actual NAPI-internal cancellation
  behavior remains unresolved.

## 4. Runtime evidence not obtained (dated 2026-10-19; superseded by the current amendment)

The following are intentionally **not** claimed because no runtime probe was performed:

- no native binding install or load;
- no OS credential-store read, write, list, or delete;
- no Windows/macOS/Linux persistence or reboot behavior;
- no locked/unavailable classification behavior;
- no Bun compatibility or thread-safety evidence;
- no secret-size limit behavior;
- no cancellation/abort behavior against a real store;
- no synthetic credential creation or cleanup.

No production credential was requested or used, and no OS credential store was touched while
the owner is away. A published artifact or tag match cannot substitute for these probes.

## 5. Proposed bounded synthetic probe plan (not executed, not authorized here)

This plan is a proposal for a later reviewed probe. It is **not** an AUTH-02 test plan and must
not be run merely because local implementation work is authorized. It requires a separately
reviewed bounded probe plan, explicit authorization, and a safe environment. It must never use
production credentials or enumerate real entries.

### 5.1 Isolation and namespace

- Use a unique, explicit synthetic namespace derived from a fresh run identifier, for example
  service `sessionport-vault-probe-<run-id>` and account `synthetic-<run-id>`.
- One synthetic entry at a time; no wildcard, prefix, or bulk enumeration.
- Never query, list, or delete a production account or any entry outside the exact synthetic
  namespace.
- Record the exact service/account pair before the first mutation so cleanup is deterministic.

### 5.2 Bounded sequence

1. **Precondition check:** confirm the exact namespace is empty using only the exact
   service/account lookup (no enumeration). If it is not empty, fail closed and do not mutate.
2. **Set/readback:** write a small fixed synthetic byte string, read the same exact entry back,
   and compare byte-for-byte. Do not log the bytes in plaintext.
3. **Delete/absence:** delete the exact synthetic entry, then read the same exact entry and
   confirm `null`/absence. A second delete may be used to exercise the missing-return `false`
   path, but only for the exact synthetic entry.
4. **Cleanup:** perform exact-entry cleanup in a `finally` path and verify final absence.
   Unexpected entries or unverified deletion are retained for manual review, never swept
   broadly.
5. **Error paths:** exercise missing get/delete and, only if safely reproducible, a
   locked/unavailable path. Unstructured errors must be reported as unclassified, with
   fail-closed behavior; do not invent a locked-vs-unavailable taxonomy.
6. **Abort/uncertain path:** issue an abort around a set or delete, then treat the mutation as
   outcome-uncertain unless readback proves the exact entry state. Reconcile only the exact
   same synthetic entry and report uncertainty if the state cannot be established.

### 5.3 Observables and verdict boundary

Allowed observables: operation outcome, sanitized error name/text, exact byte equality,
exact-entry presence/absence, bounded latency, and cleanup result. Not allowed: plaintext
secret logging, credential enumeration, production data, raw environment dump, or an OS-wide
store inspection.

A successful bounded probe would establish only synthetic behavior of this candidate in that
environment. It would **not** pass AUTH-02: device authorization, browser approval, token
refresh/revocation, per-request enforcement, encrypted state/outbox keys, and the
atomic-replace single-writer state directory remain separate requirements. A failure or
uncertain outcome is not a probe-auth success and must not be converted into a product claim.

## 6. Open evidence boundaries and decisions

- Candidate selection and exact dependency pinning were not decided on 2026-10-19; the exact
  `2.1.2` pin was selected on 2026-10-20 for the bounded experimental M3 source only (see the
  current amendment above). It is not a general AUTH-02 or cross-platform selection.
- Windows, macOS, Linux, and Bun runtime compatibility are unverified.
- Linux Secret Service persistence/availability versus the non-persistent `keyutils` default
  requires an explicit product decision; no default is promoted here.
- Locked/unavailable error classification, timeout/abort semantics, and mutation reconciliation
  need a reviewed design before client implementation.
- Secret size limits and any zeroization/clearing expectations are unresolved; no secure
  clearing behavior is claimed.
- AUTH-02 end-to-end remains blocked by AUTH-01, WEB-01, and API-01 dependencies, independent
  of this candidate.
- Production credentials and actual OS-store access remain unauthorized under the current
  owner-away direction.

## 7. Provenance

- Accepted lib-5 AUTH-02 research in `.slim/deepwork/sessionport-v2-local.md` (gitignored local
  planning state; not committed evidence).
- npm registry metadata: `https://registry.npmjs.org/%40napi-rs%2Fkeyring/2.1.2`.
- Release source: `https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/`.
- Related status/requirements: [ROADMAP.md](../V2/ROADMAP.md) AUTH-02,
  [README.md](../V2/README.md) AUTH-02, and [SECURITY.md](../V2/SECURITY.md) §6.
- No install, native binding load, OS credential-store query/write, dependency/config/source
  change, Git mutation, or application test occurred. No raw source capture was produced.
