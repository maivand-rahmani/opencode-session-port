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
- Encryption is mandatory. Never add plaintext fallback or plaintext temporary files. The proposed crypto direction in `docs/archive/v1/` is authorized for implementation/validation, but is not a final design; validate runtime behavior and resolve open parameters before release.
- The owner approved the V1 implementation baseline on 2026-10-09. Before each phase, read `docs/archive/v1/decision-log.md` and `.slim/deepwork/sessionport-v1.md`; resolve OPEN decisions in their gates and do not infer crypto parameters, caps, or compatibility claims.
- V1 documentation is archived at `docs/archive/v1/` (index: `docs/README.md`) and is a historical record, not the active V2 specification. The owner has not supplied V2 design instructions yet; do not infer V2 design, crypto parameters, caps, or compatibility claims from the V1 archive. The safety constraints above (no plugin Git, no LLM calls or historical-tool replay, no direct OpenCode-database writes, mandatory encryption) remain in force until explicitly superseded by owner instructions.
- Treat compatibility, security, and platform support claims as unverified unless backed by recorded tests. Preserve evidence boundaries in documentation.

## Remote server agent (owner-authorized Tailscale connection)

- Owner preference: carry out authorized server work and artifact transfers through this remote agent directly, instead of asking the owner to relay commands or upload files. Verify transferred bytes against local SHA-256 hashes. This does not authorize main-database changes, production deployment, destructive cleanup, or bypassing required safety gates.
- Base URL: `http://100.64.181.58:65535`. Verified OpenCode server version: `2.1.1` on 2026-10-20; this is separate from the local pinned host version.
- Use the existing HTTP API, not a new bridge or session. Discover its current contract with `GET /openapi.json`; server info is `GET /api/info`.
- Authentication: the owner-provided `/auth/connect/<code>` pairing URL exchanges for a token. API requests use HTTP Basic with username `opencode` and that returned token as password. Never put pairing URLs, tokens, or Authorization values in this repository, prompts to the remote agent, logs, or reports. Stop on auth failure; do not guess credentials.
- Default server session: `ses_eaa74d6e0ffei43T7ovM1yBquu`, title `Local session_port system modeled after crazy-commerce`, directory `/root/server`. The owner explicitly permits separate remote sessions for independent parallel tasks, including M3 setup while M2 validation runs. Keep each session's task and write paths bounded, record its ID, and do not interrupt or change the directory of an active session.
- Before sending work, check `GET /api/session/{sessionID}` and `GET /api/session/active`. Do not interrupt active work. List sessions only if recovery is needed: `GET /api/session?order=desc&archived=false&limit=10` returns `{data, cursor}`; confirm the intended session before switching.
- Send one prompt with `POST /api/session/{sessionID}/prompt`, JSON `{"text":"..."}`. Its response acknowledges a user message, not task completion. The discovered optional `delivery` values are `queue` and `steer`; never steer active work without explicit authorization.
- Read replies with `GET /api/session/{sessionID}/message?type=assistant&order=desc&limit=3`, or retrieve a known message with `GET /api/session/{sessionID}/message/{messageID}`. Responses use `{data, cursor}` or `{data}`; assistant text is in `content[]` text entries. Correlate the new reply to the submission; check completion (`finish:"stop"`) and errors rather than mistaking an older reply for success.
- If submission times out, inspect status/messages before considering a resend; never duplicate an uncertain task. Bound requests and waiting, and report unresolved status honestly.
- Verification: one reply-only, no-tools prompt returned exactly `SESSIONPORT_REMOTE_LINK_OK`. The owner subsequently approved Windows DPAPI CurrentUser credential storage outside the repository: `C:\Users\PC\AppData\Local\Temp\opencode\sessionport-remote\credential.dpapi`. Its folder ACL is restricted to the current user, SYSTEM, and Administrators. Decrypt only in memory; never print the credential or persist plaintext. Authenticate with the stored credential before requesting a fresh pairing link.
- Pairing codes are short-lived and single-use; the returned API token has no documented expiry field and was observed working beyond five minutes. Do not claim indefinite validity or restart persistence. DPAPI storage does not extend server-side validity. Stop on authentication failure; request fresh authorized pairing rather than changing authentication settings.
- Verified file transfer: `POST /api/experimental/fs/write?path=<URL-encoded-absolute-path>` accepts raw bytes with `Content-Type: application/octet-stream`; `GET /api/fs/read/*` returns raw bytes (an absolute path produces `/api/fs/read//root/server/...`); `GET /api/fs/list?path=<URL-encoded-absolute-path>` lists entries. Recheck the current OpenAPI contract before use. Write only to authorized new staging paths, reject symlinks/overwrites, and compare readback byte counts and SHA-256 hashes with local files. Never upload credentials or secret files. Eight non-secret inspection/dependency files were staged and hash-verified through these APIs.
- Remote delegation does not expand permissions: keep exact task scope, failure-stop rules, validation-DB-only restrictions, and secret handling. Obtain required approval before installs, cleanup, migrations, role changes, or service starts.

## Cloned Dependency Source

Read-only dependency source repositories are available under `.slim/clonedeps/repos/` for inspection. Do not edit these clones or run their install/build scripts.

- `.slim/clonedeps/repos/anomalyco__opencode/` — `anomalyco/opencode` at verified tag `v2.0.22`, commit `527f0b931d1f9b3ebd34e106c51b31ce5db5b075`; inspect host import/persistence and session routing for a sync integration without a custom host.
