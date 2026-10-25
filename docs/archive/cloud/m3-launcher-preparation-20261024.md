# Archived: M3 launcher preparation (2026-10-24)

> **Historical record - superseded as current direction (2026-10-25).** This file preserves the former root `README.md` section from `## Historical M3 launcher preparation (superseded as current direction)` through end of file, verbatim, including hashes, commands, status, and known historical contradictions exactly as recorded. It is not the current release direction and makes no cloud deployment or active M3 claim. Current policy: [local-release-0.1.7.md](../../local-release-0.1.7.md). Back to [root README](../../../README.md).

## Historical M3 launcher preparation (superseded as current direction)

The original README content below records the 2026-10-24 NEW-server M3 launcher preparation. It is preserved as historical/evidence context; it is not the current release direction and does not claim cloud deployment or active M3 operation.

Status: **artifacts prepared; nothing executed.** No remote connection, PostgreSQL,
Docker, Git, install, service start, secret generation, or OAuth action was performed.
All writes are under `.package-verify-work/new-server-m3-20261024/`.

Owner: M3 preparation lane. M2 (`fix78`) owns the actual migration/grants/test on the new
cluster; M1 (`ora21`) reviews. This lane only supplies the runnable launcher, guards, and
offline evidence. The reviewed values and prior gateway are copied, not re-invented.

## Artifacts

| Path | Purpose |
| --- | --- |
| `m3-launcher.mjs` | `--check`, `--generate-secrets`, `--start` supervisor CLI |
| `check-api-config.mjs` | loads the ACTUAL API config readers with the exact API child env; no listen/DB |
| `lib/topology.mjs` | digest/network/identity/port/DB-URL/node-version guards (pure) |
| `lib/env.mjs` | literal env parsing, private mode checks, 3 child allowlists, fixed system env |
| `lib/secrets.mjs` | CSPRNG BetterAuth/CSRF/human-code keys, atomic 0600 no-overwrite publish |
| `lib/supervisor.mjs` | 3-child start/health/stop, own-direct-children only, bounded shutdown |
| `gateway/gateway.mjs` | reviewed 2-native-POST-route gateway with ONE explicit diff: container listen `0.0.0.0:43117` (upstreams remain loopback) |
| `gateway/gateway-policy.test-only.json` | verbatim copy: API 65536 B / Next 1 MiB / 10 s / 16384 B / 64 |
| `config/topology.json` | non-secret topology pins and container resource proposal |
| `config/test-only-values.json` | verbatim copy of the reviewed TEST-ONLY policy values |
| `config/provenance.json` | copy provenance and hashes |

Gateway provenance: original reviewed source SHA-256 `9a531edc…cb6a`; new copy SHA-256
`db14153b…1117`. The only source diff is the container bind (`CONTAINER_LISTEN_HOST=0.0.0.0`) and
the loopback upstream constant (`UPSTREAM_HOST=127.0.0.1`) plus exported constants/comments. Routes,
fallback, header filters, and all limits remain unchanged.
| `tests/*.test.mjs` | 31 offline `node:test` cases (all passing locally) |

No new dependencies, package manifests, product source, or old helper files were changed.

## Fixed topology

- Image pin: `sha256:1d58734e7250e16d7e07a53031feb739d74e924f6ed357cca0b79394acc2f29e`
  (full app workspace, Node 22.23.4 / Bun 1.3.10 / Prisma 7.10.1 / Next 16.4.2 / deps/generated).
- Network: `sessionport-validation-20261024` (internal, no DB ports).
- DB hostname/DNS: `sessionport-validation-postgres-20261024`, DB `session_port_validation`,
  expected runtime role `sessionport_validation_runtime` (M2 owns grants; no role/DB change here).
- One NEW application container, one NEW internal network only (`sessionport-validation-20261024`).
  No host network mode, no additional legacy network attachment, no legacy project/container attach.
  Inside the container the gateway binds `0.0.0.0:43117` so Docker's host-side
  `127.0.0.1:43117` publication can traverse DNAT to the container eth0 interface. API and Next
  remain loopback-only: `127.0.0.1:43118` and `127.0.0.1:43119`. Launcher health checks still use
  `127.0.0.1:43117`, which is valid because the gateway accepts loopback as well as eth0.
- Host publish is exactly `127.0.0.1:43117:43117`; `--check` rejects `0.0.0.0`, extra mappings,
  hostnames, host-network mode, and any extra network attachment. This is not a public host bind and
  does not add host listeners or paths. There is no claim of three host listeners.
- Public origin: `http://127.0.0.1:43117`; callback `http://127.0.0.1:43117/api/auth/callback/github`.
- No `/etc/hosts`, global DNS, or old numeric DB pin is used. The API URL must use the exact
  DB hostname (numeric IP is rejected). No pin file; no reconnect/rewrite fallback.

## Runtime DB URL query policy (narrow, validation-only)

The reviewed runtime URL guard accepts exactly two shapes for the fixed validation pins
(host `sessionport-validation-postgres-20261024`, database `session_port_validation`, role
`sessionport_validation_runtime`, port `5432`):

1. no query string and no fragment (the original rule), or
2. the single raw suffix `?sslmode=disable`.

Reason: the 2026-10-24 provisioner (actual source `provision.py:153-159`) writes the literal
`?sslmode=disable` into the private `validation.env`, and the verifier binds that exact literal
(`verify.py:163`). The prior blanket query rejection therefore reported a genuine
`DATABASE_URL_OVERRIDE` against the URL the cluster actually provisions. This change matches the
literal, and only the literal.

`noTLS` here is confined to the **existing internal-only, no-host-port validation cluster**: one
dedicated Docker network `sessionport-validation-20261024`, the database publishes no host port,
the config file is private 0600/0700, and only the API role connects. It is **not** a general
deployment recommendation, not a production TLS policy, and not an argument that other services
may disable TLS.

The guard still rejects, by name: any other query value (`sslmode=require`, `ssl=true`), alternate
case (`SSLMODE`, `Disable`), duplicate parameters, a trailing `&`, a trailing empty `?`, raw `#`
including a trailing empty fragment, non-empty parsed fragments, percent-encoded equivalents
(`%64isable`, `%73slmode`, `%3D`), and any authority/connection override (`host`, `user`,
`password`, `port`, `dbname`, `options`) or ssl cert file reads (`sslcert`, `sslkey`,
`sslrootcert`). Raw text is authoritative because WHATWG URL normalizes percent-encoding and drops
a trailing empty `?`/`#`; a URL that does not match literally fails closed with
`DATABASE_URL_OVERRIDE`. The allowance is scoped to the fixed pins above: any caller-supplied
host/name/role/port override removes it.

Nothing is sanitized: the launcher never strips, rewrites, or substitutes the URL. It is parsed for
validation and forwarded unchanged to the API child env (tested byte-for-byte). No URL value is
logged.

## Actual-source verification (2026-10-24)

Read `cloud/api/src/{main,config}.ts`, `runtime/{config,cloud}.ts`, `database/config.ts`,
`native-auth/{config,browser,csrf}.ts`, `cloud/web/src/_app/server/bff.ts`, and the auth routes:

- API bootstrap order is `readApiConfig` → `readRuntimeConfig` → runtime client → listen. It never
  reads the migrator URL. `/health/live` is 200; `/health/ready` is 503 while migration/storage
  checks are hard-coded false, so readiness is not treated as PASS.
- **Container loopback trap (fixed):** Docker publishes host `127.0.0.1:43117` to the container's
  eth0:43117 via DNAT. A gateway bound only to container `127.0.0.1:43117` does not accept that
  packet. The copied gateway now binds `0.0.0.0:43117` inside the dedicated NEW container while all
  upstream calls and the launcher health probe remain `127.0.0.1` (`43118` API, `43119` Next,
  `43117` health). Host publication is still exactly `127.0.0.1:43117:43117`; this change does not
  authorize a public host bind, host network, or extra network attachment.
- The web BFF checks `Origin` exactly against `SESSIONPORT_PUBLIC_ORIGIN` for POST auth/native
  routes and forwards that same Origin to the API. The reviewed gateway preserves `Origin` and
  rewrites only `Host` (plus strips forwarding/hop-by-hop headers), so the exact-origin and
  `x-sessionport-csrf` checks remain intact.
- Auth callbacks and redirects are built from the configured public origin, not the incoming Host.
  `AllowedAuthPath` permits only `get-session`, `callback/github`, `sign-in/social`, `sign-out`;
  `isExactAuthUrl` checks path/query shape only.
- Mutations are client `fetch` calls to same-origin route handlers, not Next Server Actions, so
  Next's Server-Action Origin/Host comparison is not in the path. HMR/WebSocket upgrade remains
  intentionally unsupported by the reviewed gateway (it destroys upgrades); this is not auth
  acceptance evidence.

## Configuration and secrets

The launcher reads only these files, in memory:

1. Private server config, fixed path:
   `/home/deploy/sessionport-validation/20261024-postgres-r1/private/validation.env`
   (mode 0600, parent 0700 on POSIX). It may contain `SESSIONPORT_RUNTIME_DATABASE_URL` and the
   real GitHub client ID/secret. Migrator/admin URL names may be present but are never selected,
   never placed in a child env, and never printed. Numeric DB hosts, an unexpected query (anything
   other than the literal `?sslmode=disable` described above), wrong DB name, or wrong role fail
   closed before any connection.
2. Generated secrets:
   `/home/deploy/sessionport-validation/20261024-postgres-r1/private/m3-generated-secrets.env`
   (created by `--generate-secrets`; mode 0600, atomic exclusive publish, never overwritten).
   It contains exactly four purpose-separated CSPRNG values:
   `SESSIONPORT_BETTER_AUTH_SECRET`, `SESSIONPORT_NATIVE_CSRF_KEY_BASE64`,
   `SESSIONPORT_NATIVE_HUMAN_CODE_KEYS_JSON` (`primary`, 32-byte canonical Base64),
   `SESSIONPORT_NATIVE_HUMAN_CODE_ACTIVE_KEY_ID=primary`.
3. Reviewed non-secret policy values copied verbatim from
   `oauth-validation-20261021/runtime-continuation/plan/test-only-values.json`
   (source SHA-256 `44ba4536e66a8dfe797e92f19aafef009c66e8c19571a7c125db78b0a9a85d27`).
   `--check` deep-compares backend/native/web policy objects and the exact API numeric/origin/mode
   values. The API global body limit remains the reviewed `1048576`; the gateway's native-route
   budget remains `65536`.

Child env allowlists (fixed system env only; no parent inheritance, no shell/source/eval):

- **API (16 keys):** port, public origin, body limit, readiness timeout, retry-after, mode,
  backend policy, loopback flag, native policy, GitHub ID/secret, BetterAuth secret, human-code
  keys/active ID, CSRF key, runtime database URL.
- **Next (3 keys):** public origin, internal API origin, web policy JSON; fixed
  `NODE_ENV=development`. No DB/GitHub/BetterAuth/CSRF/human-code values.
- **Gateway (0 app keys):** system env only.

## Commands

Preparation checks (safe now; expected to report BLOCKED until the inputs below exist):

```sh
node /opt/sessionport-m3/m3-launcher.mjs --check
node /opt/sessionport-m3/m3-launcher.mjs --generate-secrets   # once, before start
node /opt/sessionport-m3/m3-launcher.mjs --start
```

`--check` validates topology pins, published ports, entry paths/dependency link containment, Node
>= 22.12.0, Next/Prisma versions, reviewed policy equality, artifact hashes, private file
mode/owner, container identity attestation, DB URL host/name/role, no Docker socket, and free
loopback ports. It then runs `check-api-config.mjs` with the real API config readers. Output is
names/modes only and never includes values. Missing real GitHub credentials produce
`GITHUB_BLOCKED_SESSIONPORT_GITHUB_CLIENT_ID` / `..._SECRET` and exit 1; there is no fake
placeholder, auth-bypass, or health-only acceptance path.

`--start` reruns the check, requires PASS, probes only the approved writable paths, starts
API → Next → gateway in that order with bounded health checks, and on failure/signal stops only
its own direct children in reverse order (8 s SIGTERM bound, then SIGKILL). It never signals a
process group, PID 1, another container, or an unrelated PID. Child stdout/stderr is suppressed
(`ignore`) so OAuth codes, cookies, or bearer values cannot leak into container logs; the launcher
reports only fixed status codes.

## Container contract (proposed; not executed)

Run as one NEW owned container, DB publishes no ports, no Docker socket, no new privileges,
all capabilities dropped, bounded PIDs/memory/CPU, read-only rootfs, own PID shutdown:

```dockerfile
--name sessionport-validation-app-20261024
--network sessionport-validation-20261024
--publish 127.0.0.1:43117:43117
--user 1000:1000 --init
--read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m
--cap-drop ALL --security-opt no-new-privileges:true
--pids-limit 512 --memory 1536m --cpus 2
--mount type=volume,<owned-volume>,dst=/app/cloud/web/.next
--mount type=bind,<private>/validation.env,dst=<private>/validation.env,ro
--mount type=bind,<private>/m3-generated-secrets.env,dst=<private>/m3-generated-secrets.env,ro
--mount type=bind,<this-dir>,dst=/opt/sessionport-m3,ro
--mount type=bind,<attestation>,dst=/run/sessionport-validation/identity.json,ro
--entrypoint node <pinned-image> /opt/sessionport-m3/m3-launcher.mjs --start
```

Do not add `--network host`, a second `--network`/`--network-alias` attachment, a legacy project
network, or any `0.0.0.0` host publication. The topology guard rejects `hostNetwork:true` and any
`extraNetworks` entry before start. The gateway's container bind does not change the public origin
or the two native routes, and its policy/body/header limits are unchanged.

Exact writable paths (verified from the installed Next 16.4.2 package and this workspace):
`/app/cloud/web/.next` (dev build/cache/lock; mount an owned writable volume over it) and the
launcher scratch `HOME`/`TMPDIR` `/tmp/sessionport-m3` under tmpfs. `cloud/web/tsconfig.json`
already includes `.next/types` and `.next/dev/types`, so Next need not rewrite it.
`next dev` writes `AGENTS.md` only when an agent marker env var is detected; the fixed child env
contains none. `NEXT_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` are fixed. No broad writable
`/app` or `node_modules` mount is used.

No derived image is required for this preparation: the pinned image can read-only mount the NEW
non-secret helpers and the private 0600 config. A later `COPY`-only derived image (network none,
no install) is acceptable if read-only bind mounts are unavailable.

## Identity attestation (integration input)

The launcher cannot query Docker (no socket). Before `--start`, M2/host writes a non-secret
attestation from `docker inspect` at
`/run/sessionport-validation/identity.json`:

```json
{"schema":"sessionport-m3-identity/v1","containerId":"<64 lowercase hex>","imageDigest":"sha256:1d58...","network":"sessionport-validation-20261024","createdAt":"<ISO-8601>"}
```

The running hostname must be the 12-hex container-ID prefix. `--check` rejects wrong digest
(including a different valid digest), wrong network, invalid/full-ID mismatch, hostname mismatch,
or a missing attestation. The attestation is never completion proof for OAuth or DB readiness.

## Offline tests

```sh
node --test .package-verify-work/new-server-m3-20261024/tests/*.test.mjs
```

Local result: **31/31 pass** on Node 22.13.1 (Windows). Covered: container gateway bind
`0.0.0.0:43117` with loopback API/Next upstreams and loopback health reachability, API-only secret
canaries
(migrator/admin/AWS/parent excluded), Next/gateway zero-secret envs, literal parser rejections,
private mode predicate, wrong digest/network/container ID, loopback-only publish, wrong DB
host/name/role/numeric host, every non-literal query/fragment spelling (case, duplicate, percent-encoded,
trailing `&`/`#`, authority and ssl-cert overrides), the one accepted literal `sslmode=disable` plus
byte-for-byte child-env passthrough, reviewed policy equality, missing-GitHub BLOCKED (never PASS),
atomic 0600 no-overwrite/failure cleanup, supervisor reverse-order own-child stop, and live gateway
body/response bounds (413/405/400/502). The actual API readers accept the exact API env and fail
closed when a required secret is removed.

## Remaining human/integration inputs

1. **Real GitHub OAuth credentials** (client ID + secret) for public origin
   `http://127.0.0.1:43117` and callback `/api/auth/callback/github`, placed only in the private
   0600 `validation.env`. Not present/verified on the new server; no other project's env/config is
   scanned. Until then `--check` is BLOCKED by name; parent defers human OAuth until owner returns.
2. **`SESSIONPORT_RUNTIME_DATABASE_URL`** for role `sessionport_validation_runtime` in
   `session_port_validation`, written by M2 after migration/grants. The migrator URL stays in the
   same private file but is never forwarded. The URL may carry no query or the exact literal
   `?sslmode=disable` (see the query policy above); anything else stays blocked. If M2 approves a
   different runtime role/name, update the non-secret `config/topology.json` (and only that) before
   `--check`; do not weaken the guard.
3. **Private directory/file modes** (0700 parent, 0600 files) and ownership `deploy`.
4. **Identity attestation** after the NEW container exists (above).
5. **M2 gates:** migration/grants/test on the new cluster; prestart/role checks if reused;
   no new role/DB/migration is performed by M3.
6. **Owner gates before OAuth:** start approval, browser tunnel, real GitHub sign-in/device flow.
   Health-only mode is intentionally not offered as M3 auth acceptance.

## Integration order to apply later

1. M2 completes migration/grants on `session_port_validation`; records runtime role and URL.
2. Write private `validation.env` (URL + real GitHub ID/secret) with 0700/0600; run
   `--generate-secrets` once.
3. Create the NEW container with the contract above; capture `docker inspect` identity into the
   attestation; confirm only `127.0.0.1:43117` is published and DB has no ports.
4. Run `--check`; require PASS (no bypass). Then `--start`; verify `/health/live` 200,
   gateway `/login`, exact-origin/CSRF rejection cases, and two native POST routes.
5. Owner-present GitHub OAuth and device authorization later; no token/cookie logging.

## Evidence boundaries

- Local Node 22.13.1 Windows tests are source/guard evidence, not Linux-container, PostgreSQL,
  Docker, Next-dev-on-image, or OAuth proof.
- The gateway bind test proves the module accepts `0.0.0.0` and remains reachable over loopback in
  an offline process. It does not prove Docker DNAT/publish behavior; that requires the later
  owner-present browser step. No host-bind claim is made.
- The pinned image digest, writable-path behavior, DB hostname/DNS, grants, and role are declared
  inputs from owner/M2; this preparation did not verify them at runtime.
- No readiness PASS is claimed: `/health/ready` is expected 503 until migration/storage flags
  change; use `/health/live` plus functional checks only.

## Owner-approved dual-network outbound start (2026-10-24)

The owner separately authorized ONE ordinary outbound Docker bridge for the test app only,
knowingly allowing general outbound reachability (not GitHub-only and not private-route-safe).

The topology now pins exactly two attachments:

- `sessionport-validation-20261024` - existing internal DB network, id
  `6f1eb9d34b16d93121234a503873e5da279625fd3788a82096bdd3cfcd60d6a7`;
- `sessionport-validation-egress-20261024-r1` - NEW ordinary bridge, driver `bridge`,
  `Internal=false`, purpose `m3-oauth-egress`, id recorded in `config/topology.json`.

No host network, no third network, no arbitrary extra attachment. The validator accepts only
that exact one-entry `extraNetworks` shape (exact name, driver, purpose, `internal:false`,
64-hex id) and the pinned primary network id. Identity attestation now carries the complete
two-network name/id pairs, the loopback-only `127.0.0.1:43117:43117` binding, and the reviewed
mount read-only flags; the host contract checks real Docker metadata before start. Offline tests
reject missing, duplicate, arbitrary, wrong-id, and public-bind variants. The DB container remains
on the existing internal network only, with no host ports.
## Local-only static-asset response-cap correction (2026-10-24)

The runtime diagnosis proved the login page failed to hydrate because the Next dev React DOM client chunk
is 1,052,413 bytes, over the 1,048,576-byte gateway Next response cap. The gateway returned a fixed
502 for that chunk.

This local-only correction adds one explicit test-only response budget:

- API native: request/response 65,536 B (unchanged);
- Next/auth/BFF/default response: 1 MiB (unchanged);
- **GET concrete Next static asset response: 2 MiB** (`maxResponseBytes.nextStaticAsset = 2097152`).

Eligibility is strict: method GET; pathname starts `/_next/static/`; normal unencoded path with no
fragment, backslash, control character, empty segment, dot segment, or percent-encoding; concrete
`.js` or `.css` suffix. A normal `?cachebust` query is ignored for path classification. POST, native
API, `/api/auth/*`, `/login`, non-static paths, encoded separators and traversal spoofing stay at the
1 MiB cap. Request caps, timeouts, header limits, routes, bindings and CSP/header behavior are
unchanged. Declared `Content-Length` and streaming byte counters use the same selected cap.

2 MiB is an explicit **test validation value** justified by the observed 1.052 MB dev chunk, not a
production cap or recommendation.

Tests: `32/32 pass`, including static JS 1,052,413 B (<2 MiB) passing, static declared/chunked
over-2-MiB rejection, chunked static abort at the bound, auth/non-static over-1-MiB declared and
chunked rejection, POST static not raised, encoded/traversal paths not raised, native API unchanged.

Hashes: new gateway `2fb5c602…708af8`; new policy `75bf087b…b266`. Previous reviewed copies
`db14153b…1117` / `3c097206…94a7` are retained in provenance as history.

### Pre-integration follow-up (reported, not faked)

`m3-launcher.mjs` `loadPolicy()` still expects the previous two-key `maxResponseBytes` object and will
mark the new policy `REVIEWED_POLICY=not-asserted` unless its expected object is updated to include
`nextStaticAsset: 2097152`. That file is outside this task's write scope, so no launcher edit was made.
A local closed stage copy and integration interface are under
`.package-verify-work/m3-static-asset-cap-fix-20261024/`; no remote stage, build, restart or start was
performed.