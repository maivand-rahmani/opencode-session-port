# SessionPort 0.2.0 — Product Specification

> **LOCAL-RELEASE QUALIFIER (owner decision 2026-10-25).** The current authoritative local policy is [docs/local-release-0.1.7.md](../local-release-0.1.7.md). Its explicit `/restore` backup-before-delete and confirmed-standalone deletion rules supersede the absolute “never delete native history” / “local artifact semantics unchanged” wording **only for local restore under that policy**. Cloud/native apply remains unchanged: no destructive overwrite of divergent histories and no cloud apply is authorized. Cloud is PAUSED/FUTURE.


> **DRAFT — awaiting owner approval. Proposed requirements only; no cloud implementation exists.**
> SessionPort 0.2.0 is a proposed, opt-in cloud continuity layer on top of the existing local
> checkpoint/restore engine. The local plugin (0.1.6) exists in this repository; **no cloud code has
> been written, tested, or released**, and no requirement in this document is approved until the
> owner accepts it. Values marked candidate/proposed are inputs to their gates, not defaults or
> promises. Standing safety constraints in [`AGENTS.md`](../../AGENTS.md) remain in force.
> Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md), [SYNC_PROTOCOL.md](SYNC_PROTOCOL.md),
> [SECURITY.md](SECURITY.md), [API_AND_DATA.md](API_AND_DATA.md), [DEPLOYMENT.md](DEPLOYMENT.md),
> [ROADMAP.md](ROADMAP.md), [README.md](README.md), [AGENT_RULES.md](AGENT_RULES.md).

## 1. Product identity and naming

- The product name stays **SessionPort**; the package stays `opencode-session-port`. "V2" is only
  the documentation-iteration label for the 0.2.0 direction. It is **not** a rename, a fork, or a
  new product line, and it does not imply that the existing local plugin is replaced.
- 0.2.0 = the existing local engine **plus** an optional cloud sync/continuity component. The local
  commands and artifacts remain the primary product; the cloud layer is additive and opt-in.

## 2. Current state (honest baseline, observed 2026-10-18)

This section records what actually exists versus what is proposed. Nothing in this section is a
promise about future behavior.

**Local engine — `opencode-session-port` 0.1.6**

- `/checkpoint` collects the current project's sessions as returned by the host and recursively
  includes only sessions referenced through schema-defined `parentID`/`fork.sessionID` links
  (including referenced sessions outside the selected project), each with full message history.
  Exceeding any collector bound, an unsettled message, or an unavailable/referenced dependency
  fails the whole checkpoint before encryption and write; old artifacts are never repaired.
- `/restore` decrypts and fully validates before the first import, never overwrites existing
  history: exact matches skip, divergent session-ID conflicts are remapped deterministically with
  parent rewrite, and independent branches continue after isolated failures with no atomic-rollback
  claim.
- Verification limits: the dependency closure and the planner conflict remapping are implemented
  and covered by **synthetic tests only** — not universally verified. One bounded synthetic
  checkpoint/restore round trip ran on Windows with OpenCode v2.0.22 using test-only password and
  project-selector seams and staged source, **not the packed npm package**. macOS has one
  user-reported checkpoint only; Linux is untested; cross-OS artifact interchange is unverified.
  End-to-end execution from the packed package has not been host-tested.
- Registry state: the last published version is **0.1.6** (read-only registry observation
  2026-10-18; latest dist-tag). The published 0.1.6 tarball's SHA-1 was observed to match the local
  0.1.6 candidate in that observation. No published artifact has been loaded by OpenCode on this
  machine, and no local package-verification record exists for the published tarballs. None of this
  is a compatibility, security, or platform-support claim.

**Cloud component (0.2.0) — proposed, not implemented**

- No 0.2.0 cloud code, API, schema, or infrastructure exists. All cloud statements in this
  repository are design drafts awaiting owner review, implementation gates, and evidence
  ([ROADMAP.md](ROADMAP.md); [ARCHITECTURE.md](ARCHITECTURE.md) §9).

## 3. Goals for 0.2.0

- **G-1 Local behavior unchanged.** `/checkpoint` and `/restore` keep their current semantics,
  format, and caps (see [ARCHITECTURE.md](ARCHITECTURE.md) §3).
- **G-2 Opt-in project cloud.** A user can explicitly enroll a device and link a project to the
  cloud; nothing is uploaded without visible consent.
- **G-3 Cross-device continuity (intended, gated).** A linked project's settled session state can
  travel between the user's devices through end-to-end-encrypted bundles. Automatic continuity is
  intended but **blocked on the host gate HOST-01** (see §6.5).
- **G-4 Divergence is preserved.** Concurrent edits produce sibling revisions; all histories
  survive; conflicts surface for explicit user branch selection. There is **no automatic merge and
  no head deletion** (see §6.4).
- **G-5 Offline-first.** Devices keep working offline; encrypted uploads/downloads resume when
  connectivity returns; local state is never destroyed by quota or sync failures.
- **G-6 User-held keys.** End-to-end encryption with no server-side root key and no plaintext
  credentials (see §7).

## 4. Non-goals and explicit exclusions

Out of scope for 0.2.0 — do not design, implement, or promise any of these unless the owner
explicitly changes this spec:

- Billing, payments, plans/tiers, or any monetization surface.
- Teams, organizations, roles, sharing, or collaboration features.
- Remote agents / remote execution, cloud-hosted models, or any LLM capability.
- Automatic Git operations of any kind (the plugin and the service never run Git; transport is the
  user's choice).
- Redis, queues, Kubernetes, additional infrastructure tiers, WebSockets, or push channels
  ([ARCHITECTURE.md](ARCHITECTURE.md) §3).
- Delta/partial sync in the first release: the sync unit is the whole settled project bundle; the
  only optimization is skipping a byte-identical unchanged digest (§6.2).
- Remote deletion propagation, tombstones, or overwrite of native history.
- Direct writes to OpenCode's internal database, tool replay, or model calls — permanently and
  regardless of the cloud layer (§5).
- OMO Slim-specific transfer beyond what the archived V1 record already resolved (no-op for V1;
  reconsider only with a documented public API).
- Any compatibility, security-audit, or platform-support claim not backed by recorded evidence.

## 5. Safety invariants (non-negotiable)

These invariants hold for the local engine and the proposed cloud layer alike:

- **No Git**: neither the plugin nor the service runs Git commands.
- **No LLM calls, no tool replay**: checkpoint/restore/sync never call a model and never replay
  historical tools.
- **No direct database writes**: OpenCode's internal database is never written; host interactions
  use documented client APIs only, with capability detection and fail-safe behavior. The cloud
  service's own PostgreSQL metadata database is required and is not OpenCode's database.
- **Mandatory E2EE**: no plaintext fallback and no plaintext temporary files anywhere on the cloud
  path; the server never sees session content, paths, or keys.
- **Never overwrite or delete native history**: divergent histories are preserved side by side.
- **Opt-in with visible consent**: no hidden scanning of unrelated projects or projects the user
  did not link.
- **Local artifact semantics unchanged**: the 0.1.6 artifact and command behavior is not altered
  by the presence of the cloud layer.

## 6. Cloud product model (proposed)

### 6.1 Opt-in project cloud

- Enrollment is explicit per device and per project; each linked project is a first-class cloud
  entity. Linking is explicit on each checkout/device — there is no path-derived, Git-derived, or
  automatic linking ([ARCHITECTURE.md](ARCHITECTURE.md) §7).
- Consent copy must state that sync includes the cross-project parent/fork dependency closure of
  the linked project (referenced sessions outside the project may be included), and that unrelated
  projects are never scanned.
- A user can leave a project or disable the cloud; disabling stops network activity and never
  damages local files.

### 6.2 Sync content model

- The sync unit is the **whole settled project bundle plus its recursive dependency closure**, with
  full message histories. The first release has **no deltas and no partial sync**.
- The only optimization is an unchanged-digest skip: if the locally computed keyed canonical
  content digest equals the last committed digest for the same logical key, no upload occurs; a
  changed bundle uploads in full ([ARCHITECTURE.md](ARCHITECTURE.md) §4.1). No delta behavior is
  claimed.
- Bundles are sealed client-side with the existing container; the API receives opaque IDs, sizes,
  and ciphertext hashes only ([ARCHITECTURE.md](ARCHITECTURE.md) §2; [API_AND_DATA.md](API_AND_DATA.md)).

### 6.3 Stable logical identity and native map

- Sessions and messages carry **stable logical IDs** that are independent of host-native IDs. The
  **native map** (client-side, encrypted) is scoped **per cloud project + host instance** — one map
  per (project, host instance) pair, not per branch lineage — and records the correspondence
  between logical IDs and the native IDs observed on that host instance.
- Source native IDs and references live inside the encrypted bundle; branch lineage (revision
  parentage) exists only as the revision baseline reference and does not define identity
  namespaces.
- Identity is used to detect "same content" (skip), "missing natively" (import candidate after the
  gate), and "existing but changed" (conditional update candidate after the gate). No native import
  or update of either kind occurs before HOST-01 passes (§6.5). The map is never used for
  destructive overwrite or force-replace ([SYNC_PROTOCOL.md](SYNC_PROTOCOL.md)).
- Deterministic remap behavior of the existing restore planner (conflict remapping, parent rewrite)
  remains the reference for any import the host gate eventually allows.

### 6.4 Immutable revisions, multi-head DAG, no automatic merge

- Revisions are **immutable** and form a **single-parent DAG**; `parentRevisionID` may be empty for
  a root revision. Multiple heads are a normal, supported state ([SYNC_PROTOCOL.md](SYNC_PROTOCOL.md);
  [ARCHITECTURE.md](ARCHITECTURE.md) §5).
- Concurrent commits create sibling revisions. Both survive; there is no last-writer-wins and **no
  automatic conversation merge**.
- Divergence surfaces as a conflict pending **explicit user branch selection**. Selection never
  deletes other heads, artifacts, or local state; preserved heads remain retrievable.
- All committed revisions are retained and count against quota.

### 6.5 Auto sync intent and the HOST-01 honesty gate

- "Auto sync" means background transfer (upload/download) plus the **intended** application of
  revisions to native sessions. Automatic continuity is intended and is a release-gated capability:
  it is blocked until HOST-01 proves a safe host integration.
- **HOST-01 blocks all cloud native imports and updates** until a safe, host-supported atomic
  conditional update (or equivalent proven-safe integration) is validated. Before the gate, the
  cloud path performs **no native imports and no native updates** — sessions missing natively are
  not an exception ([ARCHITECTURE.md](ARCHITECTURE.md) §8). The existing local `/checkpoint` and
  `/restore` flows are unaffected by this cloud gate.
- After the gate passes, the cloud path may (a) import sessions missing natively with verified
  non-replay and safe unique IDs, and (b) conditionally update the same mapped native session —
  never a destructive overwrite of divergent histories, which are always preserved (§6.4).
- "Read-idle-before-write" and quiet windows are **not** accepted as proof of safety; no TOCTOU
  guarantee is claimed.
- Until the gate passes, a downloaded revision that would require any native write (missing-session
  import or existing-session change) is recorded with staged status `host-update-blocked`; the
  revision stays committed remotely, local state is preserved, and the UI/report must surface the
  blocked update.
- The product **does not promise automatic native apply** before HOST-01; this requirement is not
  silently reduced to a manual restore workaround, and passing HOST-01 does not authorize direct
  writes to OpenCode's internal database or force-replace behavior.

### 6.6 Offline behavior

- All sync metadata and the outbox live in local **encrypted** state; no plaintext fallback when
  the OS credential store or keyring is unavailable (fail closed; memory-only unlock allowed)
  ([ARCHITECTURE.md](ARCHITECTURE.md) §11).
- Offline edits simply produce a new pending revision; uploads retry with bounded backoff when
  connectivity returns. Quota or scheduler errors pause the project's sync jobs; they never touch
  local files.
- No UI network activity while the user is not logged in.

## 7. Authentication and E2EE requirements (proposed)

- **Auth:** BetterAuth with the OAuth Provider and Device integration on the single Fastify API
  (not a standalone custom session-token flow). GitHub is the initial identity provider. Refresh
  handling and device-grant checks are part of the integration; server-side active-device/grant
  lookup and revocation must work ([ARCHITECTURE.md](ARCHITECTURE.md) §9, gate AUTH-01).
- **E2EE:** session content is encrypted client-side using the existing crypto container with a
  policy candidate explicitly validated under **CRYPTO-01**. A **separate sync passphrase wraps a
  random account root key**; the server never receives the root key, the passphrase, or any
  plaintext credential. Any server-stored key material is opaque ciphertext.
- **No server root**: the service cannot decrypt bundles; operator access to the database/object
  store does not reveal session content ([SECURITY.md](SECURITY.md)).
- Password/passphrase handling follows the existing local rules: masked input, no logs, no
  persistence, no clipboard use, no plaintext temporary files.

## 8. Service stack requirements (proposed)

The simplest arrangement that satisfies the design — no additional infrastructure:

- **One API service**: Fastify + Prisma/PostgreSQL on the **existing VPS**, using a **separate
  database and database user** for SessionPort; migrations via Prisma; BetterAuth owns its own auth
  tables in that database ([DEPLOYMENT.md](DEPLOYMENT.md)).
- **One web app**: Next.js on **Vercel** as a thin same-origin BFF (GitHub OAuth callback target;
  `/api/auth/*` proxied with the trusted canonical issuer); no independent business logic.
- **Object storage**: private S3-compatible bucket; large payloads go directly between client and
  provider (post policy + conditional copy); provider capability is a release-blocking gate
  (STORE-01) ([API_AND_DATA.md](API_AND_DATA.md)).
- **Workspaces**: `cloud/api` and `cloud/web` as npm workspace members while Bun remains the root
  plugin toolchain; the plugin's published pack allowlist must be preserved and cloud code excluded
  from the plugin tarball ([ARCHITECTURE.md](ARCHITECTURE.md) §3).
- **No extra infra**: no Redis, no queue/worker tier, no Kubernetes, no WebSockets; janitor and
  finalization run in the API process with database locks.

## 9. Quotas and limits (planning defaults, configurable)

These are **planning defaults** for the cloud service, not final product values: they must be
configurable server-side, are subject to owner approval, and are documented/validated in
[API_AND_DATA.md](API_AND_DATA.md) and [DEPLOYMENT.md](DEPLOYMENT.md). All units are binary (KiB =
1,024 bytes; MiB = 1,048,576 bytes; GiB = 1,073,741,824 bytes).

| Limit | Planning default | Notes |
| --- | --- | --- |
| Storage per user | 1 GiB | Aggregate of committed ciphertext objects; revisions count. |
| Devices per user | 3 | Active devices; revocation allowed; enforcement is server-side. |
| Projects per user | 10 | Linked projects; explicit linking per device. |
| Ciphertext object ceiling | 100 MiB | Configurable ceiling per uploaded bundle object; enforced at reservation/upload. |
| Local encrypted artifact (current effective crypto cap) | 66 MiB | The local engine's current effective encrypted artifact cap (experimental profile). **Not automatically relaxed** by the cloud ceiling; changing it requires an owner-approved CRYPTO-01 decision. |

- Quota exhaustion blocks new uploads explicitly and never modifies or deletes local state; all
  committed revisions are retained and count against quota ([ARCHITECTURE.md](ARCHITECTURE.md) §7).
- No "unlimited" claim; no hidden cap increases; any limit change is a visible, owner-approved
  configuration change.

## 10. Journeys, features, and acceptance criteria

Document pointers mark where each criterion is specified in more detail. Gate IDs follow
[ROADMAP.md](ROADMAP.md) (architecture detail in [ARCHITECTURE.md](ARCHITECTURE.md)).

### J-01 — First-device setup and opt-in (F-01, F-02, F-03, F-12)

A user installs the plugin, runs the native `/sync` action menu, logs in with GitHub through the
web BFF, sets a sync passphrase (wrapping a random root key), and explicitly links one project.

- **AC-01.1** With cloud not configured, `/checkpoint` and `/restore` continue to work exactly as
  in 0.1.6, with no cloud network activity (PRODUCT_SPEC §5; [ARCHITECTURE.md](ARCHITECTURE.md) §3).
- **AC-01.2** `/sync` is a single native action-menu command by design (login/logout/status and
  related actions); optional convenience forms such as `/sync login ...` are explicitly unverified
  — the library documentation establishes only that raw `arguments: true` input is available, and
  validating raw argument forms belongs to HOST-01 ([SYNC_PROTOCOL.md](SYNC_PROTOCOL.md)).
- **AC-01.3** Login uses the BetterAuth OAuth Provider + Device integration; browser sessions use
  same-origin cookies; no wildcard CORS; the server stores no plaintext credentials
  ([SECURITY.md](SECURITY.md); gate AUTH-01).
- **AC-01.4** Project linking is explicit, per device, with visible consent naming the dependency
  closure; no path-derived or Git-derived linking ([ARCHITECTURE.md](ARCHITECTURE.md) §7).

### J-02 — Second-device continuity (F-04, F-05, F-09)

On device B, the user logs in, unlocks with the sync passphrase, links the same project, and
downloads the latest revision.

- **AC-02.1** Only whole settled bundles with full dependency closure are downloaded; envelope,
  manifest, and ciphertext are fully validated before any host interaction
  ([ARCHITECTURE.md](ARCHITECTURE.md) §4.2; [SYNC_PROTOCOL.md](SYNC_PROTOCOL.md)).
- **AC-02.2** Logical IDs resolve through the per-project, per-host-instance native map. Before
  HOST-01 passes the cloud path writes nothing to native sessions — no imports and no updates,
  sessions missing natively included. After the gate: verified non-replay imports with safe unique
  IDs and conditional same-session updates only, never a destructive overwrite of divergent
  histories ([ARCHITECTURE.md](ARCHITECTURE.md) §8).
- **AC-02.3** If applying would require any native write before HOST-01 passes, the local record
  shows staged status `host-update-blocked`, no native write occurs, and the blocked state is
  reported to the user (PRODUCT_SPEC §6.5).
- **AC-02.4** A quiet/idle window alone is never treated as safe evidence; no TOCTOU guarantee is
  claimed ([ARCHITECTURE.md](ARCHITECTURE.md) §8).

### J-03 — Offline work and catch-up upload (F-04, F-08)

A device works offline, then reconnects and uploads the new state.

- **AC-03.1** Offline edits produce a pending revision in the encrypted outbox; no network calls
  occur until connectivity and login exist ([ARCHITECTURE.md](ARCHITECTURE.md) §11).
- **AC-03.2** Uploads are retried with bounded backoff; scheduler/quota errors pause the project's
  sync jobs without a busy loop and without touching local files ([ARCHITECTURE.md](ARCHITECTURE.md) §11).
- **AC-03.3** An unchanged keyed canonical digest skips upload; a changed bundle uploads in full;
  no delta claim is made ([ARCHITECTURE.md](ARCHITECTURE.md) §4.1; [SYNC_PROTOCOL.md](SYNC_PROTOCOL.md)).

### J-04 — Divergent histories and branch selection (F-06, F-07)

Two devices each commit from the same parent, creating sibling revisions.

- **AC-04.1** Both commits survive as immutable heads; no last-writer-wins, no automatic merge
  ([SYNC_PROTOCOL.md](SYNC_PROTOCOL.md); [ARCHITECTURE.md](ARCHITECTURE.md) §5).
- **AC-04.2** The conflict surfaces for explicit user branch selection; selection preserves all
  heads/history and deletes nothing ([SYNC_PROTOCOL.md](SYNC_PROTOCOL.md)).
- **AC-04.3** No path deletes a head as a side effect of sync, quota enforcement, or device
  changes ([ARCHITECTURE.md](ARCHITECTURE.md) §7).

### J-05 — Device lifecycle and revocation (F-02, F-10)

A user adds a third device, then revokes a lost device.

- **AC-05.1** The active-device cap (planning default 3) is enforced server-side with an explicit
  error; adding beyond the cap does not silently evict a device ([API_AND_DATA.md](API_AND_DATA.md)).
- **AC-05.2** Revocation invalidates the device's tokens/grants server-side; subsequent API calls
  from that device are refused (gate AUTH-01; [SECURITY.md](SECURITY.md)).
- **AC-05.3** Revocation never deletes revisions or local state; the remaining devices can still
  retrieve all committed history.

### J-06 — Quota pressure (F-11)

A user approaches the storage quota.

- **AC-06.1** Status shows current usage against configurable limits (1 GiB / 3 devices / 10
  projects / 100 MiB object, planning defaults) in binary units (PRODUCT_SPEC §9).
- **AC-06.2** Quota exhaustion blocks the upload explicitly and leaves local state intact; no
  silent deletion or truncation occurs ([ARCHITECTURE.md](ARCHITECTURE.md) §7; [API_AND_DATA.md](API_AND_DATA.md)).
- **AC-06.3** The local 66 MiB artifact cap is not auto-relaxed by cloud defaults; changes require
  an owner-approved CRYPTO-01 decision (PRODUCT_SPEC §9).

### J-07 — Local-only workflow (F-01)

A user never enables the cloud.

- **AC-07.1** All local commands, formats, caps, and failure semantics match the 0.1.6 behavior;
  installing the 0.2.0 plugin does not add mandatory network dependency or telemetry
  ([ARCHITECTURE.md](ARCHITECTURE.md) §3).
- **AC-07.2** No cloud UI state leaks into local-only operation; the `/sync` menu reports
  "not configured" without side effects.

### Feature index

| ID | Feature | Key requirement | Primary docs |
| --- | --- | --- | --- |
| F-01 | Local engine unchanged | `/checkpoint`/`/restore` semantics, format, caps stay as in 0.1.6 | [ARCHITECTURE.md](ARCHITECTURE.md) §3 |
| F-02 | Cloud enrollment and `/sync` menu | Explicit device login/logout/status; native action menu baseline | [SYNC_PROTOCOL.md](SYNC_PROTOCOL.md) |
| F-03 | Explicit project linking | Per-device explicit linking with consent; no automatic linking | [ARCHITECTURE.md](ARCHITECTURE.md) §7 |
| F-04 | Whole-bundle upload/download | Settled project bundle + dependency closure; unchanged-digest skip; no deltas | [ARCHITECTURE.md](ARCHITECTURE.md) §4 |
| F-05 | Logical identity + native map | Stable logical IDs; encrypted client-side native map; no overwrite | [SYNC_PROTOCOL.md](SYNC_PROTOCOL.md) |
| F-06 | Immutable revision DAG | Single-parent immutable revisions; multi-head support | [SYNC_PROTOCOL.md](SYNC_PROTOCOL.md) |
| F-07 | Branch selection, no merge | Explicit user selection; no auto merge; no head deletion | [SYNC_PROTOCOL.md](SYNC_PROTOCOL.md) |
| F-08 | Offline outbox and retries | Encrypted local state; bounded backoff; fail-closed credential store | [ARCHITECTURE.md](ARCHITECTURE.md) §11 |
| F-09 | HOST-01-gated host apply | All cloud native imports/updates blocked until the gate; after it: verified missing-ID imports plus conditional same-session updates, never destructive overwrite | [ARCHITECTURE.md](ARCHITECTURE.md) §8 |
| F-10 | Device management and revocation | Device cap; server-side revocation; no history deletion | [SECURITY.md](SECURITY.md) |
| F-11 | Quotas and usage status | Configurable binary-unit limits; explicit blocking; local state untouched | [API_AND_DATA.md](API_AND_DATA.md) |
| F-12 | E2EE key handling | Separate sync passphrase wraps random root key; no server root/plaintext | [SECURITY.md](SECURITY.md) |

## 11. Gates and next steps

- **Owner review first (PREP-01)**: this initial V2 documentation draft (all `docs/V2/` pages) is
  proposed and requires explicit owner approval (a non-implementation review). Nothing here may be
  quoted as an approved requirement, and no cloud implementation may start on the strength of these
  drafts alone.
- **Release CI comes first (M0)**. Per owner direction and [ROADMAP.md](ROADMAP.md), GitHub release
  CI is the first implementation milestone, before host/cloud work: **CI-01** (PR checks/artifact)
  then **CI-02** (protected npm release). This is the delivery mechanism for shipping releases —
  repository/release infrastructure that adds no cloud product scope; workflow details live in
  [ROADMAP.md](ROADMAP.md). The existing local engine is unchanged by this milestone (no version
  bump and no publication implied).
- **Then HOST-01 and the cloud gates** (defined in [ROADMAP.md](ROADMAP.md); architecture detail
  in [ARCHITECTURE.md](ARCHITECTURE.md)): **HOST-01** — host gate (host behavior, source events,
  raw command-argument validation), which blocks all cloud native imports/updates and the 0.2.0
  release; component gates **CRYPTO-01** (cloud crypto policy candidate validation), **REPO-01**
  (workspace/layout), **AUTH-01** (identity-provider integration proof), **AUTH-02** (device
  login/vault), **STORE-01** (object-storage provider capability), **STORE-02** (quota
  enforcement), **SYNC-01** (logical identities and encrypted local state), **SYNC-02** (manual
  sync protocol), **SYNC-03** (safe native apply), **SYNC-04** (scheduler/auto-sync).
- **Status upkeep**: update [README.md](README.md) and [ROADMAP.md](ROADMAP.md) status only as
  evidence changes; never mark a draft as approved without the owner's acceptance.

## 12. Claims policy

- Every statement about behavior must be tagged as implemented (with evidence), synthetic-only,
  host-tested (per platform), or unverified. Single-host evidence never becomes a universal claim.
- No compatibility, security, or platform-support promise is made from these documents; see the
  archived V1 evidence record for the current local baseline and its limits.
- If a proposed simplification would weaken a requirement (for example, replacing HOST-01-gated
  automatic apply with a manual workaround), that is a requirement change requiring owner
  approval — not an implementation detail.
