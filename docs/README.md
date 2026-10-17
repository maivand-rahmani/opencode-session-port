# SessionPort Docs — V1 Implementation Baseline

> **APPROVED FOR IMPLEMENTATION — NOT FROZEN.**

The owner approved the V1 implementation baseline on 2026-10-09. The workspace [README](../README.md) gives the project summary; this page indexes the set and records approval/freeze status. PROPOSED and OPEN technical decisions remain subject to their implementation-phase gates.

## Index

| Path | Purpose | Status |
| --- | --- | --- |
| [v1/product-spec.md](v1/product-spec.md) | Product goals/non-goals, users, `/checkpoint` and `/restore` UX, defaults, platforms | Approved baseline |
| [v1/technical-design.md](v1/technical-design.md) | Architecture, checkpoint data flow, artifact envelope direction, restore/import, conflicts, compatibility, OMO Slim | Approved baseline; details gated |
| [v1/security-and-privacy.md](v1/security-and-privacy.md) | Protection scope and non-claims, password handling, crypto requirements vs open choices, untrusted input | Approved baseline; crypto OPEN |
| [v1/validation-and-open-questions.md](v1/validation-and-open-questions.md) | Spike baseline, tested evidence, untested areas, open questions | Approved evidence baseline |
| [v1/decision-log.md](v1/decision-log.md) | Product decisions, proposed technical decisions, open decisions | Authoritative status |

## Approval and freeze status

- V1 scope is **approved for implementation** as of 2026-10-09.
- Documentation is **not frozen**; implementation-phase decisions remain PROPOSED/OPEN and must be validated before dependent behavior is finalized.
- Final documentation freeze remains a separate gate after implementation evidence and OPEN decisions are reconciled.

### Proposed freeze criteria (PROPOSED — also draft content)

1. Every OPEN item in [v1/validation-and-open-questions.md](v1/validation-and-open-questions.md) is resolved before freeze. This draft defines no DEFERRED status or exception path; postponing an item does not change its OPEN status or satisfy this gate.
2. Security/format choices (algorithms, KDF parameters, header layout, version policy, limits, password UX) are decided and consistent across documents.
3. A cross-platform implementation/testing plan exists (currently missing).
4. Owner sign-off is recorded for each document.

## Status labels

- **DECIDED** — owner-approved V1 scope/direction; not a substitute for unresolved implementation details.
- **PROPOSED** — recommended, not agreed.
- **OPEN** — unresolved; do not infer an answer. Resolve before the dependent behavior is finalized/released; unrelated lanes may proceed.
- **(CANDIDATE)** — research-only reference; not selected, not validated.
- **SUPERSEDED** — retained for provenance; replaced by a later decision-log entry; not a current direction.

## Validation baseline

OpenCode **v2.0.22 (2026-10-09)**, Windows only, synthetic data, disposable environment. Evidence is summarized in [v1/validation-and-open-questions.md](v1/validation-and-open-questions.md) and is **not** a universal compatibility promise. Source references in these docs are pinned to the OpenCode repository tag `v2.0.22` where noted.

## Boundaries of authority

- These documents authorize implementation within the owner-approved V1 scope; they do not authorize automatic Git operations or silently settle PROPOSED/OPEN technical choices.
- Anything not labeled DECIDED or explicitly listed in [v1/decision-log.md](v1/decision-log.md) remains open for discussion.
- Decision status is authoritative in [v1/decision-log.md](v1/decision-log.md); other documents defer to it.
