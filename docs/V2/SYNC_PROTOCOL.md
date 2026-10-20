# SessionPort 0.2.0 -- Sync Protocol

> **DRAFT -- awaiting owner approval. Architectural reference; local protocol source exists, but no deployment or runtime acceptance is claimed.**
> The protocol below remains proposed. Local source now covers the project/revision repository,
> immutable DAG/head routes, cursor parsing, and quota primitives, with synthetic/fake-client tests
> only; it is not deployed, has no live PostgreSQL proof or upload/download mount, and no sync flow
> has been runtime-accepted. Candidate values (caps, TTLs, windows) remain gate inputs, not defaults
> or promises. Standing safety constraints in `AGENTS.md` remain in force.
> Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md),
> [API_AND_DATA.md](API_AND_DATA.md).

## 1. Project linking and consent

- A cloud project is identified by a **project UUID** chosen client-side, exposed canonically as
  `projectID` (the Project row primary key; there is no second server-side project ID). The user
  explicitly creates or links the project on each checkout/device. There is no path-derived
  identity, no Git-remote identity, and no automatic (auto-)linking.
- Worktrees of the same repository may explicitly link to the same cloud project. Linking is
  per-device and per-checkout; nothing links implicitly.
- Sync scope is **opt-in with visible consent**. The consent dialog must state that the sync unit
  includes the whole settled project bundle **and the cross-project parent/fork dependency
  closure**. Unrelated projects are never scanned.
- Dependency sessions included in the payload are synced as part of the owning project's bundle;
  they are **not** separately auto-uploaded to the project they originate from, and no
  cross-project upload happens without its own explicit link and consent.
- Project purge is an owner-confirmed control plane action only (account deletion/retention);
  routine clients have no server-side delete endpoint in the first release. Omitted endpoints are
  acceptable unless the product requires them (see [API_AND_DATA.md](API_AND_DATA.md)).

## 2. Sync unit, caps, and change detection

- The first-release sync unit is the **whole settled project bundle plus its dependency closure**.
  Rationale: consistent logical references across a device pair and a simple protocol. There is no
  partial/branch-limited sync unit in the first release.
- Changed bundles upload **in full**. No delta encoding and no delta claim.
- Unchanged detection: a **keyed canonical content hash** is stored encrypted on the client. If the
  keyed hash is unchanged for the same project/branch key, the upload is skipped. The server never
  receives this hash (it receives only ciphertext SHA-256 for object integrity; see
  [API_AND_DATA.md](API_AND_DATA.md)).
- Caps:
  - Effective current cap: **66 MiB** (the existing experimental crypto profile's artifact cap)
    applies until the cloud crypto profile is validated. Over-cap bundles **fail explicitly**; no
    truncation, no partial revision.
  - The configurable cloud ceiling is **100 MiB** (`104857600` bytes, `maxCiphertextBytes`). It is
    a ceiling, not a promise that 100 MiB payloads work: server acceptance of that size depends on
    CRYPTO-01 / STORE-01 validation and remains subject to the effective cap.
- Collection remains fail-closed: unsettled messages, missing/malformed dependencies, unresolved
  references, cycles, or cap violations stop the whole collection before encryption or upload.

## 3. Content identity, normalization, and equality

- Content equality is evaluated **locally** on canonical content after replacing native/project IDs
  with stable logical mapping (section 4). The comparison digest is computed locally and stored
  encrypted; it is never exposed to the server.
- The normalization ignore-list is deliberately minimal and must only ever contain:
  - destination location and destination project ID (they legitimately differ per device), and
  - host transient fields validated in the host gate (HOST-01).
- Until normalization parity is verified across devices (SYNC-01), mismatches are **not**
  suppressed: a mismatch is treated as a change. Do not expand the ignore-list by inference.
- Equality results drive only local decisions: skip upload, mark session as already-present
  destination snapshot, or treat as a new/conflicting revision.

## 4. Logical identity and mapping

- Every collected native session gets a stable **UUID `logicalSessionID`**; every native message
  gets a stable logical message ID. IDs are assigned **once** per collected native
  session/message and never reassigned.
- The logical-to-native map is persisted **encrypted**, per host instance, keyed by
  `cloudProject + hostInstance` -- branch lineage is **not** part of the mapping key. Lineage is
  tracked separately as baseline/head bookkeeping. A destination device keeps its own map; maps
  are not shared between host instances in plaintext.
- Schema references are mapped through logical IDs:
  - session references: `parentID`, `fork.sessionID`;
  - message references: `fork.boundary.messageID`, `revert.messageID`.
- The encrypted manifest keeps logical references; original native IDs remain **encrypted
  provenance** inside the bundle and are never exposed to the API.
- A repeated import is skipped only for a **verified exact snapshot** (normalized content
  equality), never on ID match alone.
- Local deterministic ID derivation and collision behavior against pre-existing native IDs/map
  entries are not specified by current evidence; they are part of the HOST-01 gate (safe native
  APIs). Until then, no collision-prone generation is relied upon.
- Cloud apply is fully gated by HOST-01: before the gate passes, **no cloud native import and no
  cloud native update** occurs, and downloaded revisions remain `host-update-blocked` (the existing
  local `/restore` is independent and unchanged). After the gate: import genuinely missing sessions
  first (verified non-replay, safe unique IDs); an existing native session requires a validated
  host-supported atomic conditional update on the same native ID -- intended without ordinary
  duplication. See [ARCHITECTURE.md](ARCHITECTURE.md) section 8.

## 5. Revision DAG and commit protocol

### 5.1 Revision rules

- Revisions are immutable. `parentRevisionID` is nullable.
- The initial revision (no parent) is allowed **only if the project has no committed revisions**
  (no history).
- Every subsequent revision must name a known committed parent belonging to the same project. A
  parent remains a valid parent after it ceases to be a head.
- Multiple heads are a normal state. There is no automatic branch merge and no transcript merge in
  the first release.

### 5.2 Sequence and cursor model

- Each project has a monotonic **sequence** assigned under a project-row lock. `seq` is exposed as
  a **JSON decimal string** (never a JS number) to avoid precision loss.
- Event pages are anchored by an **upper-bound sequence**: a page request resolves against
  `upperBound` and never sees revisions committed after that anchor.
- Cursors are stateless client artifacts. The server retains no cursor table; revisions carry the
  ordering, and **all committed revisions are retained** (section 9), so there is no
  retention-based cursor expiration. The cursor is a per-project decimal sequence string (zero is
  valid) and must be monotonically non-decreasing. A malformed cursor or a cursor beyond the
  established `upperBound` is rejected with `422 INVALID_CURSOR`; a numeric cursor is only a
  position, and scope is defined by the route project plus the device's locally stored projectID. An
  optional `DeviceProject` ack row storing only cursor metadata may be introduced if justified
  later; otherwise there is no cursor table. See [API_AND_DATA.md](API_AND_DATA.md) section 6.

### 5.3 Commit transaction

Commit is transactional. Sibling commits both survive; last-writer-wins is not used.

```text
commit(projectID, userID, {revisionID, uploadID, parentRevisionID}):
  BEGIN
  project = SELECT * FROM Project WHERE id = projectID AND userID = userID FOR UPDATE
  if project missing: 404
  if revisionID already committed:
      # comparison uses only server-visible immutable fields; the server cannot decrypt the manifest
      if stored userID/projectID/parentRevisionID/ciphertextSha256/sizeBytes/keyEpoch (and deviceID
         when the envelope binds it) match the request -> return existing {seq, headIDs, conflict:false}
      else -> 409 same-revision-different-content
  upload = SELECT * FROM Upload WHERE id = uploadID AND projectID = projectID FOR UPDATE
  if upload.state != ready: 409 upload-not-ready
  if parentRevisionID is not null:
      parent = SELECT * FROM Revision WHERE revisionID = parentRevisionID AND projectID = projectID
      if parent missing: 422 unknown-parent
  else:
      if EXISTS(SELECT 1 FROM Revision WHERE projectID = projectID): 422 parent-required
  seq = project.nextSeq  # monotonic; allocated under this row lock
  conflict = false
  if parentRevisionID is not null:
      deleted = DELETE FROM ProjectHead
                WHERE projectID = projectID AND revisionID = parentRevisionID
      conflict = (deleted == 0)   # parent was no longer a head: sibling commit
  INSERT INTO Revision(...)
  INSERT INTO ProjectHead(projectID, revisionID)
  project.nextSeq = seq + 1
  COMMIT
  return {revisionID, seq: str(seq), headIDs: [...], conflict}
```

Observable results:

- A first commit on a clean project creates the initial revision with `seq = 1` and one head.
- Two devices committing from the same parent both succeed; the parent is removed by the first
  commit, the second commit reports `conflict: true`, and the response's `headIDs` contains both
  heads. Both revisions and their artifacts are preserved.
- Commit is idempotent for the same revision; the same revision ID with different visible immutable
  fields is rejected with `409`.

Idempotence note: repeat requests must reuse the **exact persisted ciphertext** for the same
`revisionID` (same `ciphertextSha256`/`sizeBytes`). Re-sealing produces different bytes and cannot
be committed under the same revision ID -- a lost local ciphertext file requires a **new revision
identity**. The `uploadID` may change when a reservation expires, as long as the final revision
fields match. Idempotence is evaluated solely on server-visible immutable fields; the server never
compares manifest content it cannot decrypt.

### 5.4 Head-set concurrency

- The head set is reported on every commit and revision-list response.
- The server never deletes a losing sibling's revision or object.
- Client behavior on reported concurrency: see section 6.

## 6. Branch tracking, divergence, and conflicts

- Clients **auto-follow only a unique descendant** of their baseline when there are no local
  changes. If the remote has exactly one descendant branch and the local state is unmodified, the
  client may advance its baseline automatically.
- Multiple heads, or local-vs-remote divergence, is a **conflict pending explicit user branch
  selection**. Nothing is auto-merged, auto-rebased, or overwritten:
  - all heads, artifacts, and local state are preserved;
  - the user chooses the branch/head to continue from;
  - the local preference expression of branch selection **does not delete** other heads or history.
- A client that keeps local changes commits a **sibling revision based on its own baseline**. It
  must not silently rebase those changes onto another head.
- Resolution UI/reporting is a product surface; this document only fixes the safety semantics.

## 7. Revision envelope and manifest

- Each revision is one encrypted container object (existing container format; see
  [SECURITY.md](SECURITY.md)). The authenticated plaintext envelope binds:

| Field | Meaning |
| --- | --- |
| `protocolVersion` | Fixed `1` for this protocol |
| `userID` | Owning account |
| `projectID` | Cloud project |
| `revisionID` | This revision |
| `parentRevisionID` | Declared parent or null |
| `deviceID` | Committing device |
| `keyEpoch` | Account root key epoch used for wrapping/sealing |
| `scope` | Project scope declaration plus dependency-closure marker |
| `contentDigest` | Keyed canonical content digest (local) |
| `snapshots` | Encrypted session snapshots and logical IDs |
| `logical IDs` | Logical session/message identifier map and references |

- API-visible metadata is limited to opaque IDs (UUIDs), sizes, `keyEpoch`, and the ciphertext
  SHA-256. No plaintext names, paths, or content digests.
- On download, the client verifies the decrypted envelope against the authorized server metadata
  (the "authenticate route compare after decrypt" rule): `userID`, `projectID`, `revisionID`,
  `parentRevisionID`, `deviceID`, and `keyEpoch` must match the commit response/metadata before the
  payload is trusted. A mismatch stops processing; nothing is applied.

## 8. Local state, outbox, and crash recovery

Local state is **per-user, private, outside the repository**, and **host-instance scoped**
(one directory per host instance). It is encrypted; no plaintext temporary file is ever written.
Writes use atomic replace and a single-writer lock.

### 8.1 Operation statuses

```mermaid
stateDiagram-v2
  [*] --> collected
  collected --> encrypted
  encrypted --> reserved
  reserved --> uploaded
  uploaded --> committed
  committed --> downloaded
  downloaded --> apply-pending
  apply-pending --> applied
  apply-pending --> host-update-blocked
  downloaded --> host-update-blocked
```

- The encrypted snapshot is persisted **before** any network call.
- Operation IDs and revision IDs are stable across retries. When a staging reservation expires
  before the upload completes, a retry creates a **new staging reservation (new `uploadID`) for the
  same revision**; the revision identity never changes on retry, and retries reuse the **exact
  persisted ciphertext**, never a re-seal. A lost local ciphertext file requires a new revision
  identity.
- `host-update-blocked` is the staged state for **all** revisions while HOST-01 has not passed (no
  missing-session exception); the revision remains committed remotely and no host call is made.

### 8.2 Cursor and watermarks

- The sync cursor advances **only after a full fetched page is durably encrypted locally** (stable
  pagination anchored by `upperBound`); nothing expires from retention, so an old cursor is never
  invalidated by time.
- The native apply watermark is tracked **separately** from the sync cursor; a fetched revision is
  not marked applied until the native apply result is journaled.

### 8.3 Native apply journal

- Before any import, write the candidate native map entry to the encrypted journal; confirm it
  after the import result is known.
- A crash during import leaves an ambiguous state. Recovery **must inspect the native session by
  exact content and ID** and must not blindly reimport. Ambiguity is resolved conservatively: no
  duplicate native sessions and no overwrite.
- No host snapshot atomicity is assumed. Quiet window plus two matching full reads plus generation
  event checks is best effort only; the HOST-01 gate decides what consistency is sufficient for
  release. Idle periods are not claimed to solve TOCTOU.

## 9. Deletions, retention, and quota

- **No remote deletion propagates to native sessions in 0.2.0.** Missing local records are not
  tombstones; a locally missing session is not evidence of deletion.
- Previously synced records are retained and reused as the baseline inside the next full snapshot.
  True deletion propagation is an explicit future feature, not part of 0.2.0.
- All committed revisions are retained and count against quota. Quota-full **explicitly blocks
  uploads**; local sessions and local encrypted state are unaffected. There is no implicit purge.
- Account deletion / project purge is an owner-confirmed control plane action, not a routine client
  operation.

## 10. Triggers and scheduling

- The event adapter is **source-bound and generic**: exact change/idle event names are
  **undocumented**, so they are not invented here. The event contract is owned by the HOST-01 gate
  (source research: OpenCode V2 plugin docs, `/v2/docs/build/plugins/cli`).
- Events are **live-only**: there is no replay and no reconnect catch-up. After subscription loss
  or process recovery, the client must **re-subscribe and run a reconcile pass**. Event-driven
  triggers are accelerators only; the cursor/watermark model in section 8 stays authoritative.
- Subscription teardown: `data.on`/`listen` return unsubscribe handles, and `ctx.event.subscribe`
  must be aborted on teardown. The exact surface used is fixed by the HOST-01 gate.
- Timer cleanup uses the documented `clearInterval` path at plugin/component teardown.
- Scheduling rules (proposed):
  - Debounce **2 s** after settle; maximum scheduling delay **30 s**.
  - Periodic run every **60 s** while foregrounded, with jitter.
  - Also on project open, on reconnect (with re-subscribe + reconcile, because events are
    live-only), and on manual `/sync now`.
  - **One flight per project** at a time.
  - Bounded exponential backoff from **1 s to 60 s** with jitter; no busy loops.
  - Credential or quota errors **pause** the project's jobs (quota pause until quota recovers;
    credential pause until login is renewed).
- Lifecycle: dispose timers and hooks on plugin teardown. No UI network activity while login is
  absent.

## 11. Commands

- Existing commands keep their semantics: `/checkpoint`, `/restore`.
- New command surface (logical actions, not a claim about subcommand grammar):
  `/sync login | enable | disable | now | status | logout`.
  - `login`: device authorization flow; stores credentials per AUTH-02.
  - `enable` / `disable`: enable or stop sync jobs. Disable **stops jobs but keeps encrypted local
    state and remote data**; re-enable resumes.
  - `now`: run one sync pass for the active project.
  - `status`: show link state, cursor/head facts, and paused reasons.
  - `logout`: revoke the device where possible, wipe local credentials and in-memory keys. The
    encrypted outbox is retained by default -- with an explicit caution about key recovery: if keys
    are gone, retained encrypted outbox content may be unreadable.
- Registration: `slash: { name: "sync", arguments: true }` is documented and may be used for the
  command. Raw input/subcommand parsing is **UNVERIFIED**; the design must not assume a nested
  subcommand grammar.
- Fallback (native action menu): register `/sync` as a **single native command that opens an
  action menu** listing login, enable, disable, now, status, and logout. No nested subcommand
  registration is assumed.
- Argument parsing uses the native raw argument string passed by the repository's existing
  `keymap.layer` command registration (`src/tui/ui/sessionport-commands.tsx`), consistent with the
  existing TUI command seam. Command grammar and quoting must pass the command/argument
  compatibility validation under HOST-01 before release. Source: `/v2/docs/build/plugins/cli`.

## 12. Host gate interplay

- Until HOST-01 passes, downloaded revisions are staged locally with `host-update-blocked`; **no
  cloud native import and no cloud native update runs**, including for sessions that appear missing
  natively. The remote side may keep the revision committed; clients simply do not apply it. The
  existing local `/restore` is unchanged and independent of this gate.
- After HOST-01 passes: genuinely missing sessions import first; an existing native session requires
  a validated host-supported atomic conditional update on the same native ID (intended without
  ordinary duplication). Updates are not prohibited forever.
- Automatic continuity and the 0.2.0 release are not complete until HOST-01 passes. This protocol
  does not replace automatic continuity with a manual restore requirement.

## 13. Failure cases

| Case | Behavior |
| --- | --- |
| Collection finds unsettled messages | Fail before encryption; no revision |
| Bundle over effective cap | Fail explicitly; no truncation; local unaffected |
| Upload interrupted/expired | New staging reservation under a new `uploadID` for the same revision, reusing the same persisted ciphertext |
| Unattached ready upload past grace TTL | Janitor GC; `usedBytes` decremented only after confirmed deletion; committed revisions are never lifecycle-deleted |
| Commit with stale parent | Sibling commit succeeds; `conflict: true`; both heads preserved |
| Two heads or divergence | Conflict pending user branch selection; nothing deleted or merged |
| Client has local changes | Sibling commit from own baseline; no silent rebase |
| Malformed or beyond-upperBound cursor | `422 INVALID_CURSOR`; numeric positions are not origin proofs; no retention-based cursor expiration |
| Envelope does not match server metadata after decrypt | Stop; do not trust or apply the payload |
| Normalization parity unverified | Mismatch treated as change; uploads not suppressed |
| Quota exhausted | Upload blocked explicitly; local state and sessions unaffected |
| Credentials invalid/expired | Pause jobs; re-login required; bounded backoff, no busy loop |
| Event subscription lost / process recovery | Live-only events: re-subscribe and reconcile; never assume event replay |
| Cloud apply requested but HOST-01 not passed | `host-update-blocked`; no cloud imports or updates; local `/restore` unaffected |
| Crash during native apply | Journal + native inspection recovery; never blind reimport |
| Missing local session | Not a deletion; retained baseline reused in the next snapshot |
| Remote head deleted by another client | Impossible in the server model; clients render heads, they never delete them |

## 14. Open items

- SYNC-01 must verify logical-ID stability/mapping scope and normalization/digest parity across two
  devices before mismatch suppression is enabled.
- Logical-ID collision behavior against pre-existing native IDs is unspecified and belongs to the
  HOST-01 gate.
- Trigger event names remain undocumented; the event contract (live-only delivery, no replay,
  re-subscribe + reconcile after recovery) is part of the HOST-01 gate. Source research:
  `/v2/docs/build/plugins/cli`.
- HOST-01 evidence plan and ownership (executed with SYNC-03).
- Whether any `DeviceProject` cursor ack metadata is justified; default is no cursor table.
