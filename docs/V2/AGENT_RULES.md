# SessionPort 0.2.0 — Agent Rules

> **DRAFT — proposed initial V2 working rules; awaiting owner approval.**
> These rules govern how agents read, change, and verify this repository during the V2 (SessionPort
> 0.2.0) documentation and implementation iteration. They are **proposed, not approved**; the
> [ROADMAP.md](ROADMAP.md) is mutable and its status entries change as evidence arrives. The
> standing safety constraints in [`AGENTS.md`](../../AGENTS.md) apply regardless of approval status
> and are not weakened by anything here. If a conflict exists, `AGENTS.md` and the owner's explicit
> instruction win.

Companion documents: [PRODUCT_SPEC.md](PRODUCT_SPEC.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[SYNC_PROTOCOL.md](SYNC_PROTOCOL.md), [SECURITY.md](SECURITY.md), [API_AND_DATA.md](API_AND_DATA.md),
[DEPLOYMENT.md](DEPLOYMENT.md), [ROADMAP.md](ROADMAP.md), [README.md](README.md).

## 1. Language policy

- **Artifacts in English**: documentation, code, comments, commit messages, test names, and
  status/evidence records are written in English.
- **User communication in Russian**: report to the owner in Russian; keep artifacts English.

## 2. Reading discipline

- Read in this order: **`docs/V2/README.md`** → **rules** (`AGENTS.md`, this file) → the **relevant
  section** of the applicable spec (for example [PRODUCT_SPEC.md](PRODUCT_SPEC.md) or
  [ARCHITECTURE.md](ARCHITECTURE.md)) → current **ROADMAP** status → the **task** statement → the
  **code** in the affected area.
- **No repeated entire-document reads.** Read a section once; if the file is unchanged, reuse your
  notes. Re-read only sections that changed or that the current task actually references.
- Read large files with targeted searches (grep/glob) and bounded ranges; never dump whole files
  "just in case". This applies to V1 archive files, decision logs, and deepwork state as well.
- When a task references history, read the relevant decision-log entry, not the whole archive.

## 3. Standard workflow (per task)

1. **Read** `docs/V2/README.md` and the rules (§2 order).
2. **Read the relevant spec** section + the current ROADMAP status + the task statement.
3. **Locate the code** and confirm the exact write scope and ownership.
4. **Implement** the smallest change that satisfies the task (§4).
5. **Verify focused** — apply the testing policy (§5) before and during the change.
6. **Update status** — update the roadmap/document status the task assigns (and only that).
7. **Report** — changed paths, verification performed and results, skips and unverified items,
   next gate (§9).

Do not skip step 2 or step 5; do not expand step 3 into unrequested refactoring. If the task is
docs-only, steps 3–5 operate on documents (consistency, links, claims), not on application code.

## 4. Scope, minimal complexity, and change control

- **Stay inside the assigned path scope.** No drive-by edits, no formatting churn, no unrelated
  refactors. If the task needs a file outside the scope, stop and return the request — do not
  silently widen the scope.
- **Minimal complexity**: prefer the smallest, simplest change that meets the spec. No new
  unplanned dependencies, services, or abstractions without explicit approval; dependencies already
  authorized by the approved task/spec do not require repeated approval.
- **No silent changes to architecture or requirements.** Changing a requirement, an invariant, a
  gate, a quota, a security posture, or the architecture is a *significant change* and requires
  explicit **owner approval**. Propose the change, wait, and record the owner's answer — never
  implement a weakening "for now".
- **Candidates stay candidates.** Quota defaults, crypto parameters, formats, and gates marked
  candidate/proposed are inputs to their gates; they are not promoted to defaults by any agent.
- **The roadmap is mutable** — statuses and next-step ordering may change as evidence arrives; the
  approved spec is not. Editing the roadmap is allowed as the task instructs; rewriting approved
  requirements is not.
- **V2 docs are proposed drafts.** Never describe `docs/V2/` content as approved, decided, or
  implemented unless the owner has explicitly accepted it and evidence exists.

## 5. Verification and evidence policy (mandatory)

1. **Before each command / test run, state**: what changed, what evidence is relevant and expected,
   and which claim the run supports. No blind runs, no speculative reruns.
2. **Use coherent batches.**
   - During implementation: targeted tests for the code being changed.
   - When a module/unit is complete: module tests + type checks.
   - After components are connected: integration tests.
   - Full suite / build / package / end-to-end: only at RC gates, in the authorized automated CI gates (CI-01/CI-02 — one run per relevant commit/job), or when the owner requests them. Coding agents do not repeat an unchanged full suite.
3. **Reuse unchanged passed evidence.** If source, configuration, and dependencies are unchanged
   and nothing relevant changed since a passing run, reuse that evidence instead of rerunning it.
   Reuse applies only while the inputs are unchanged; state the reuse in the report.
4. **No new failures are acceptable.** A run that adds a failure is not "probably flaky" without
   evidence; investigate or report it. Never hide, skip, or silence a failure, and never weaken an
   assertion to make a check pass.
5. **Failure handling: focused fix, focused rerun.** Fix the smallest cause, rerun the focused
   check. Do not loop repeated blind full-suite runs, and do not retry a failing command unchanged.
6. **Security verification is mandatory** wherever the change touches crypto, keys, credentials,
   storage, network, or host interaction: no plaintext fallback, no plaintext temporary files, no
    server root key, no direct writes to OpenCode's internal database, no tool replay. Writes to
    SessionPort's own PostgreSQL metadata database are required and are not prohibited.
7. **Truthful evidence with platform labels.** Every claim records how it was produced: synthetic
   test, host test (named host/version), or unverified; and on which platform (Windows / macOS /
   Linux). A single-host observation never becomes a universal claim. Absence of evidence is
   reported as unverified, not as success.
8. **Docs-only work performs no application tests, installs, or builds.** Verification for a
   docs-only task is consistency checking: links resolve, statements match recorded evidence,
   statuses and qualifiers are honest, scope untouched outside allowed paths.

## 6. Delegation and parallel-work rules

- **Bounded lanes with disjoint write scopes.** Each writer gets an exact allowed path list. Two
  writers must never edit the same file concurrently.
- **Freeze shared interfaces before parallel writers** (names, IDs, formats, doc titles). If an
  interface is unresolved, serialize the dependent work — do not let writers guess.
- **Every lane states**: allowed paths, expected output, and its validation owner. The parent /
  orchestrator owns integration and final verification.
- **No redundant work**: handle small isolated tasks directly; only delegate when the lane is
  genuinely separable. Do not spawn overlapping work.
- **Git rule**: the plugin never runs Git commands. Agents run Git only for repository maintenance
  and only when the owner explicitly requests it. Cloud/service tasks never introduce Git
  automation.
- **Respect evidence boundaries**: never access external systems, private host storage, or user data
  beyond the task's explicit allowance. Public OpenCode source/API inspection for an assigned
  compatibility gate is allowed; direct writes to its internal database remain prohibited.

## 7. Definition of Done

A task is done only when **all** of the following hold for its type:

**Documentation task**

- Content matches the task specification and the current approved direction; nothing is claimed
  that evidence does not support.
- Cross-links use the real, agreed filenames; the V1 archive remains untouched unless explicitly
  in scope.
- Statuses and qualifiers (draft/proposed/unverified, platform labels) are honest.
- Only assigned paths changed; no application tests/builds/installs were run.
- The report lists changed paths and the checks performed.

**Implementation task** (when authorized by the roadmap/gates)

- The relevant spec section is satisfied without changing it silently.
- Focused tests and type checks pass for completed modules; integration evidence exists after
  connections; failures and limits are disclosed truthfully.
- Security verification was performed where applicable; platform labels are recorded.
- Statuses (roadmap/docs) were updated as the task assigns; owner-approval items are flagged, not
  assumed.
- The report states changed paths, evidence, reuse, skips, and unverified areas.

## 8. Gates quick reference

Gate IDs — current final set; live status in [ROADMAP.md](ROADMAP.md), architecture detail in
[ARCHITECTURE.md](ARCHITECTURE.md). Ordering per [ROADMAP.md](ROADMAP.md): **PREP-01** (owner
review of the V2 planning package; non-implementation) first, then the M0 release-CI milestone —
**CI-01** (GitHub PR checks/artifact) and **CI-02** (protected npm release) — before HOST-01 and
cloud work; CI-01/CI-02 are release-infrastructure gates whose workflow details live in
[ROADMAP.md](ROADMAP.md). Then: **HOST-01** (host gate: host behavior, source events, raw
command-argument validation — blocks all cloud native imports/updates until passed;
release-blocking for cloud/automatic continuity, sequenced after M0), **CRYPTO-01** (cloud crypto
policy candidate validation), **REPO-01** (workspace/layout), **AUTH-01** (identity-provider
integration proof), **AUTH-02** (device login/vault), **STORE-01** (object-storage provider
capability), **STORE-02** (quota enforcement), **SYNC-01** (logical identities and encrypted local
state), **SYNC-02** (manual sync protocol), **SYNC-03** (safe native apply), **SYNC-04**
(scheduler/auto-sync). An agent may not declare a gate passed; the validation owner records gate
results with labeled evidence.

## 9. Report format

Every task report answers, briefly and truthfully:

1. What changed (exact paths) and why.
2. Verification performed (commands/checks with the evidence they produced) and results.
3. Skips/limits/unverified areas and the platform labels that apply.
4. The next gate or decision required (for example: PREP-01 owner review, CI-01/CI-02 release-CI
   work, HOST-01 evidence plan).

Reports to the owner are written in Russian (artifacts remain English, §1), concise, and free of
promises the evidence does not support.
