# SessionPort Documentation

> **V1 documentation is archived.** V1 is a historical record, not the active V2 specification. V2 documentation remains a proposed draft (full owner review unrecorded), with local source implementation for bounded M1–M3 slices and no deployment or runtime acceptance.

The workspace [README](../README.md) gives the project summary.

## Current status

- **V1 is archived at [`archive/v1/`](archive/v1/)** and is a historical record only. Original decisions, approval lines, and evidence were retained unchanged; each file carries an archived-record banner.
- **V2 documentation remains a proposed planning package** (see the [V2 navigation](#v2-in-progress--proposed-awaiting-owner-approval)). The owner authorized M0 release-CI implementation and later independent local work; full-package review (PREP-01) remains pending. **M0 status (recorded 2026-10-18): CI-01 completed; CI-02 in progress.** CI-01's hosted Windows CI succeeded on commit `5c1d89e` ([run 39153256919](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/39153256919): frozen install, typecheck, full suite 648 pass/0 fail, package verification, artifact upload; the prior run on `b77e38f` failed on a test-isolation leak and remains a retained historical record). CI-02 local source work is complete (after a bounded builtin-boundary fix, the changed-input verifier recheck and a real stage→validate passed locally, and the final post-remediation review returned GO), and the GitHub protections are applied and read-back verified (protected `npm-release` environment; active `v*` tag ruleset), but the npm trusted-publisher mapping is owner-reported configured (2026-10-19; independently unverified), the release variables were absent at the last check, and there is no hosted release run, OIDC publish, tag, or version bump — CI-01's hosted success is not release proof. M0 is not operationally complete. A local cloud source foundation exists (`cloud/api`, `cloud/web`, and the now-wired native client/vault and `/sync` TUI surface), but there is no deployment, application-database apply, enabled production auth, storage/upload mount, or runtime acceptance; actual host rendering/focus/Esc, live OAuth/API login, authoritative session/CSRF behavior, and real vault/host end-to-end flows remain unverified. The original project/quota PostgreSQL 16 validation passed owner/server-reported (2 migrations, 15/15 checks, 3 users, cleanup true, exit 0), the separately authorized validation-only `0003` apply/postcheck passed (2→3 migrations, 8 protocol tables, 3 enums, 20 checks; [protocol result](evidence/protocol-postgres-validation-result-20261020.md)), but the single protocol run failed 6/15 and no follow-up is automatic. The main database remains untouched. The driver-only correction is committed at `c44ea02f1086c4e10b5c0ac5b190acee06fbb1b0` after Ora8 source GO (offline 10/10 + API typecheck PASS), but the failed live case remains FAIL and is not live validated. The native M3 source has FINAL Ora9 material review2 GO for the source commit boundary and is committed at `cd3ef6902d7bf3e62faf2b75effc36ece75f4ba0`; actual host UI/OAuth/session/CSRF/vault acceptance remains unverified. Do not infer V2 design, crypto parameters, caps, or compatibility claims from the V1 archive or from unratified V2 drafts.
- **V1 safety constraints remain in force** until explicitly superseded by owner instructions: the plugin never runs Git commands, checkpoint/restore makes no LLM calls and never replays historical tools, there are no direct OpenCode-database writes, and encryption is mandatory (no plaintext fallback). See [AGENTS.md](../AGENTS.md).

## Archived V1 index (historical)

| Path | Purpose | Archived status |
| --- | --- | --- |
| [archive/v1/product-spec.md](archive/v1/product-spec.md) | Product goals/non-goals, users, `/checkpoint` and `/restore` UX, defaults, platforms | Archived V1 record |
| [archive/v1/technical-design.md](archive/v1/technical-design.md) | Architecture, checkpoint data flow, artifact envelope direction, restore/import, conflicts, compatibility, OMO Slim | Archived V1 record |
| [archive/v1/security-and-privacy.md](archive/v1/security-and-privacy.md) | Protection scope and non-claims, password handling, crypto requirements vs open choices, untrusted input | Archived V1 record |
| [archive/v1/validation-and-open-questions.md](archive/v1/validation-and-open-questions.md) | Spike baseline, tested evidence, untested areas, open questions | Archived V1 record |
| [archive/v1/decision-log.md](archive/v1/decision-log.md) | Product decisions, proposed technical decisions, open decisions | Archived V1 record (authoritative for V1 only) |

## Archived V1 context (historical)

- The owner approved the V1 implementation baseline on 2026-10-09; documentation was never frozen, and PROPOSED/OPEN items remain unresolved exactly as recorded. Archiving closes nothing.
- Status labels used inside the archived docs: **DECIDED** / **PROPOSED** / **OPEN** / **(CANDIDATE)** / **SUPERSEDED** — preserved as originally recorded.
- Validation baseline as originally recorded: OpenCode **v2.0.22 (2026-10-09)**, Windows only, synthetic data, disposable environment; **not** a universal compatibility promise. Later evidence and platform limits (Linux untested; cross-OS artifact interchange unverified) remain exactly as recorded in the archived documents; archiving preserves evidence and does not upgrade any claim.

## V2 (in progress — proposed, awaiting owner approval)

The `docs/V2/` set describes the proposed SessionPort 0.2.0 cloud/continuity direction. Full-package approval remains pending; the narrow M0 and later local-implementation directions do not approve cloud design, crypto parameters, caps, or compatibility claims. Local source exists for M1–M3 slices, including the wired `/sync` TUI surface, exact external keyring pin, and the owner-approved 69-file experimental pack boundary. No cloud deployment or runtime acceptance exists, no milestone is complete, and HOST-01's eight runtime rows remain PARTIAL/UNVERIFIED.

| Page | Purpose |
| --- | --- |
| [V2/README.md](V2/README.md) | V2 index and navigation |
| [V2/PRODUCT_SPEC.md](V2/PRODUCT_SPEC.md) | Requirements, journeys, features, acceptance criteria |
| [V2/ARCHITECTURE.md](V2/ARCHITECTURE.md) | Architecture, components, gates |
| [V2/SYNC_PROTOCOL.md](V2/SYNC_PROTOCOL.md) | Revision DAG and sync protocol |
| [V2/SECURITY.md](V2/SECURITY.md) | Threat model, E2EE, and auth security |
| [V2/API_AND_DATA.md](V2/API_AND_DATA.md) | API surface, data model, quotas |
| [V2/DEPLOYMENT.md](V2/DEPLOYMENT.md) | Deployment topology and operations |
| [V2/ROADMAP.md](V2/ROADMAP.md) | Gates and mutable status |
| [V2/AGENT_RULES.md](V2/AGENT_RULES.md) | Working rules for this repository |

All nine pages listed above exist. The full planning package remains draft pending owner review; M0 progress (CI-01 completed with hosted Windows evidence; CI-02 in progress) and outstanding external setup are tracked in [V2/ROADMAP.md](V2/ROADMAP.md) and [V2/DEPLOYMENT.md](V2/DEPLOYMENT.md#2-plugin-release-ci-first--plan-only).
