# Repository Agent Instructions

## Delegation and parallel work

- For non-trivial implementation work, identify separable lanes before editing and delegate each bounded lane to an appropriate specialist.
- For independent lanes, prefer fresh specialist sessions; do not repeatedly reuse one subagent for unrelated work. Reuse a session when it is a direct continuation and its context materially helps.
- Maximize safe parallelism: launch independent lanes concurrently, and state dependencies explicitly. Do not parallelize work with overlapping write scopes or unresolved shared interfaces.
- Give every writer an exact allowed path scope, expected output, and validation owner. Keep integration and final verification coordinated.
- Do not spawn redundant work. Handle a small, isolated task directly when delegation overhead would exceed the work.
- After launching independent background work, continue only on non-overlapping tasks; reconcile results when completion notifications arrive rather than polling repeatedly.

## SessionPort project constraints

- SessionPort is a local OpenCode session-transfer tool. The plugin itself must never run Git commands. Coding agents may run Git commands for repository maintenance when explicitly requested by the owner.
- Checkpoint/restore operations must make no LLM calls and must never replay historical tools.
- Never write directly to OpenCode's internal database. The approved baseline uses the host client's experimental import API; feature detection and failure-safe behavior are required.
- Encryption is mandatory. Never add plaintext fallback or plaintext temporary files. The proposed crypto direction in `docs/v1/` is authorized for implementation/validation, but is not a final design; validate runtime behavior and resolve open parameters before release.
- The owner approved the V1 implementation baseline on 2026-10-09. Before each phase, read `docs/v1/decision-log.md` and `.slim/deepwork/sessionport-v1.md`; resolve OPEN decisions in their gates and do not infer crypto parameters, caps, or compatibility claims.
- Treat compatibility, security, and platform support claims as unverified unless backed by recorded tests. Preserve evidence boundaries in documentation.
