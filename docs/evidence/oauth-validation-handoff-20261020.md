# OAuth/native runtime validation handoff (2026-10-20)

Status: **PREPARED HANDOFF AND SOURCE BUNDLE ONLY — NOT STARTED, NOT DEPLOYED, NOT RUNTIME-ACCEPTED.**
No server was contacted, no service was started, no OAuth app was registered, no database role or
privilege was created, no migration was run, and no private environment file was read. This is a
bounded preparation artifact for a later owner-approved execution.

## Artifact identity

| Item | Value |
| --- | --- |
| Runtime source bundle | [`sessionport-oauth-runtime-20261020.zip`](../../.package-verify-work/oauth-validation-20261020/sessionport-oauth-runtime-20261020.zip) |
| Bytes | `290,875` |
| SHA-256 | `063355503649883d773971821a0e93c6f6565c018c9bfbcc94ef565dd1ee3e7a` |
| Entries | `180` |
| Payload manifest | [`source-manifest.txt`](../../.package-verify-work/oauth-validation-20261020/source-manifest.txt) (`sha256sum -c SHA256SUMS` inside the bundle) |
| Handoff README | [`README-RUNTIME.md`](../../.package-verify-work/oauth-validation-20261020/README-RUNTIME.md) |
| Read-only inventory | [`server-inventory.sh`](../../.package-verify-work/oauth-validation-20261020/server-inventory.sh) |
| Pre-start DB guard | [`prestart-db-guard.mjs`](../../.package-verify-work/oauth-validation-20261020/prestart-db-guard.mjs) |
| Role preparation SQL | [`runtime-role-prep.sql`](../../.package-verify-work/oauth-validation-20261020/db/runtime-role-prep.sql) |
| Role review / limitations | [`runtime-role-review.md`](../../.package-verify-work/oauth-validation-20261020/db/runtime-role-review.md) |
| Test-only values | [`test-only-values.json`](../../.package-verify-work/oauth-validation-20261020/config/test-only-values.json) |
| Bundle build script | [`build-bundle.ps1`](../../.package-verify-work/oauth-validation-20261020/build-bundle.ps1) |

The bundle contains the exact closed source allowlist: root workspace manifest and `bun.lock`,
`cloud/api` source/schema/migrations/preparation scripts, and `cloud/web` source/config. It excludes
tests, `.env` files, `node_modules`, the generated Prisma client, `.next`, Git metadata, logs, keys,
and certificates. Prisma generation is an explicit server step; it is not silently performed by an
install lifecycle script.

## Target topology (owner-proposed; not started)

- Linux host `66.151.42.193`; loopback-only services; no public bind.
- API: `127.0.0.1:43118`; `SESSIONPORT_API_PORT=43118`, host fixed to `127.0.0.1` in source.
- Web/Next: `127.0.0.1:43117`; `SESSIONPORT_PUBLIC_ORIGIN=http://127.0.0.1:43117`.
- Canonical public/browser origin: `http://127.0.0.1:43117` (loopback HTTP allowed only explicitly).
- API public origin must also be `http://127.0.0.1:43117`; cloud runtime rejects an origin mismatch.
- Web internal upstream: `SESSIONPORT_INTERNAL_API_ORIGIN=http://127.0.0.1:43118`.
- Browser and server must share network reachability for `127.0.0.1`; run API and web in the same
  host namespace. Separate bridge containers would make API loopback unreachable.
- The existing validation image `822bf...` is a PostgreSQL/driver validation image, not this runtime
  app; it lacks web dependencies. Do not present it as a ready runtime or reuse it as a deploy claim.
- Prefer `next dev` for the bounded test; production build/start is a separate later check, not a
  deployment claim.

## Critical origin blocker (must be resolved before native acceptance)

The current source has two incompatible constraints:

1. The native client sends every request to its configured `origin` and requires the server's
   `verificationUri` to equal exactly `origin + /api/native/v1/device-authorizations/verify`
   ([`src/cloud/auth/client.ts`](../../src/cloud/auth/client.ts), `parseDeviceAuthorization`).
2. The server builds `verificationUri` from `SESSIONPORT_PUBLIC_ORIGIN`, which must be
   `http://127.0.0.1:43117` for the browser/BetterAuth/BFF origin checks. That value is also used
   for the verification-page redirect.

The web BFF allowlist forwards only `GET /api/native/v1/session`, native verify/approve/deny,
`GET /api/native/v1/grants`, grant revoke, and the four `/api/auth/*` bridge routes. It does **not**
forward `POST /api/native/v1/device-authorizations` or `POST /api/native/v1/token`; its catch-all
returns `404` ([`cloud/web/README.md`](../../cloud/web/README.md), route files). It also does not
forward `/v1/*`, including `/v1/me`.

Consequences:

- Native client `origin=http://127.0.0.1:43117`: verification URI matches, but device-authorization
  creation and token exchange hit the web catch-all and return `404`.
- Native client `origin=http://127.0.0.1:43118`: creation/token reach the API, but the API returns a
  `43117` verification URI and the strict client rejects the response as `invalid-response`.
  Switching `SESSIONPORT_PUBLIC_ORIGIN` to `43118` instead breaks the BFF's exact-origin checks and
  the browser GitHub callback/public origin.

This is a source/design gap, not a value to guess. Native acceptance is **BLOCKED** until the parent
chooses one of:

- add BFF proxy routes for native create/token (existing source change, not authorized here);
- run a reviewed artifact gateway on `43117` that routes only those two native paths to `43118` and
  everything else to Next on an internal port (new wrapper, not built here);
- split native client request origin from verification origin (native client source change, not
  authorized here).

Browser-only OAuth/approval may be attempted independently once the API, web, database, and secrets
are ready. `/v1/me` is not part of the current native client flow; if it is exercised, call it
directly against `43118` with a bearer credential and never log the credential. Do not route it
through the current BFF.

## GitHub OAuth App registration (manual; no app exists yet)

Use the owner-selected GitHub identity. Create a **separate validation OAuth App**; do not modify an
existing production app or callback.

1. GitHub → Settings → Developer settings → **OAuth Apps** → **New OAuth App** (not a GitHub App).
2. Application name: e.g. `SessionPort OAuth Validation 20261020` (not a secret).
3. Homepage URL: `http://127.0.0.1:43117`.
4. Authorization callback URL: `http://127.0.0.1:43117/api/auth/callback/github`.
5. Register the app. Record the Client ID (non-secret).
6. Generate one Client Secret. Place it only through the server's approved private secret mechanism
   as `SESSIONPORT_GITHUB_CLIENT_SECRET`; never put it in chat, a repository file, a command line, a
   URL, or logs. Put the Client ID in `SESSIONPORT_GITHUB_CLIENT_ID`.
7. Do not add webhooks, repository permissions, or extra scopes. BetterAuth's GitHub provider requests
   its normal identity scopes; record the scopes shown on the consent screen. Do not broaden them.
8. If GitHub rejects an HTTP loopback callback or requires HTTPS, stop and report; do not substitute
   a public callback or expose the server publicly.
9. The browser machine must keep the `43117` SSH tunnel open while GitHub redirects back to
   `127.0.0.1:43117`. GitHub itself never reaches the server loopback.

## Final config entry now (owner action; no start)

Exact server-only path:

```text
/root/server/session_port_validation/oauth-validation.env
```

Do **not** create a repository, `cloud/api`, or `cloud/web` `.env`; the root `.gitignore` does not
exclude `.env`. The file currently has only the two GitHub values. **Do not overwrite it.** Append
missing keys with an editor, not with shell `echo`/`printf`/`tee`/redirection or a command containing
a secret. Use `vim -n -i NONE` (no swap, backup, or viminfo), append only, then `chmod 600` and
`chown root:root`. Keep the directory `0700`. Do not leave temporary copies.

```sh
install -d -m 0700 /root/server/session_port_validation
test -e /root/server/session_port_validation/oauth-validation.env \
  && echo 'file exists: append only, do not overwrite' \
  || echo 'file absent: create with editor'
vim -n -i NONE /root/server/session_port_validation/oauth-validation.env
chmod 600 /root/server/session_port_validation/oauth-validation.env
chown root:root /root/server/session_port_validation/oauth-validation.env
stat -c '%a %U:%G %n' /root/server/session_port_validation/oauth-validation.env
```

Append these keys (values in single quotes; keep existing GitHub lines). Exact JSON objects are in
[`test-only-values.json`](../../.package-verify-work/oauth-validation-20261020/config/test-only-values.json);
serialize `backendPolicy` / `nativePolicy` as the exact one-line values of
`SESSIONPORT_BACKEND_POLICY_JSON` / `SESSIONPORT_NATIVE_POLICY_JSON`. Do not add, remove, or reorder
fields.

| Key | Value / source |
| --- | --- |
| `SESSIONPORT_API_PORT` | `43118` |
| `SESSIONPORT_PUBLIC_ORIGIN` | `http://127.0.0.1:43117` |
| `SESSIONPORT_HTTP_BODY_LIMIT_BYTES` | `1048576` |
| `SESSIONPORT_READINESS_TIMEOUT_MS` | `1500` |
| `SESSIONPORT_RETRY_AFTER_SECONDS` | `5` |
| `SESSIONPORT_API_MODE` | `cloud` |
| `SESSIONPORT_NATIVE_ALLOW_LOOPBACK_HTTP` | `true` |
| `SESSIONPORT_INTERNAL_API_ORIGIN` | `http://127.0.0.1:43118` |
| `SESSIONPORT_WEB_POLICY_JSON` | `{"maxRequestBytes":4096,"maxResponseBytes":4096,"upstreamTimeoutMs":1000}` |
| `SESSIONPORT_BACKEND_POLICY_JSON` | exact `backendPolicy` object from `test-only-values.json` |
| `SESSIONPORT_NATIVE_POLICY_JSON` | exact `nativePolicy` object from `test-only-values.json` |
| `SESSIONPORT_GITHUB_CLIENT_ID` | existing (non-secret) |
| `SESSIONPORT_GITHUB_CLIENT_SECRET` | existing (secret; do not print) |
| `SESSIONPORT_NATIVE_HUMAN_CODE_ACTIVE_KEY_ID` | `primary` |
| `SESSIONPORT_BETTER_AUTH_SECRET` | secret, >=32 bytes; generate in-editor, e.g. `:read !openssl rand -base64 48` |
| `SESSIONPORT_NATIVE_CSRF_KEY_BASE64` | canonical base64 of 32 bytes; generate in-editor, e.g. `:read !openssl rand -base64 32` |
| `SESSIONPORT_NATIVE_HUMAN_CODE_KEYS_JSON` | `[{"id":"primary","keyBase64":"<32-byte canonical base64>"}]`; generate the key in-editor |
| `SESSIONPORT_RUNTIME_DATABASE_URL` | `postgresql://sessionport_validation_runtime:<DB-password>@<observed-db-host>:<observed-port>/session_port_validation`; URL-encode a password if needed. Use the observed/DBA endpoint, not a guess. |

Load explicitly in each process shell; the API does **not** auto-load dotenv:

```sh
set -a
. /root/server/session_port_validation/oauth-validation.env
set +a
```

Never use `set -x`, `env`, `printenv`, `cat` on that file, or put its contents in argv, a URL,
repository, chat, log, or temp dump. Verify names only:

```sh
awk -F= '/^SESSIONPORT_[A-Z0-9_]+=/ {print $1}' \
  /root/server/session_port_validation/oauth-validation.env | sort
```

The GitHub callback is confirmed unchanged:
`http://127.0.0.1:43117/api/auth/callback/github`. It follows from
`SESSIONPORT_PUBLIC_ORIGIN=http://127.0.0.1:43117` and BetterAuth base path `/api/auth`; do not
configure a different callback. GitHub redirects the browser to the tunneled loopback, so the
browser machine must keep the `43117` tunnel open.

## Readiness/preflight prompt (no start)

After the file is appended and permissions are set, give the server agent this bounded prompt:

```text
Read-only preflight. Do not start API or web, do not install, do not query table rows, do not
create/alter roles, and do not print env values or file contents.
1. stat the config file and directory; require file mode 600, owner root:root, directory 700.
2. list only the SESSIONPORT_* key names from the file; report present/missing names.
3. confirm there is no .env in the repository, cloud/api, or cloud/web.
4. run the artifact's server-inventory.sh and return its stdout.
5. if dependencies are already installed, run the existing config-only validation below; otherwise
   report "install pending" and stop. Do not connect to PostgreSQL.
Return only path/mode/owner, key names present/missing, inventory stdout, and fixed validation
status. Stop on any mismatch.
```

Config-only validation (no network, no DB, no listener; prints no values):

```sh
cd cloud/api
node --import tsx --input-type=module -e '
import { readApiConfig } from "./src/config.ts";
import { readRuntimeConfig } from "./src/runtime/config.ts";
try {
  const api = readApiConfig(process.env);
  const runtime = readRuntimeConfig(process.env, api);
  console.log(`config=ok mode=${runtime.mode}`);
} catch {
  console.log("config=fail");
  process.exitCode = 1;
}
'
```

Do not run `prestart-db-guard.mjs` until the restricted role credential exists and owner/DBA review is
complete. Do not start the API as a preflight step.

## Server read-only inventory prompt

Give the server agent only this bounded prompt, then stop and review its output:

```text
You are performing a read-only inventory for a later SessionPort OAuth validation.
Do not install, start, stop, deploy, migrate, create roles, alter privileges, query table rows,
read private env file contents, or run Git. Do not bind or forward any public interface.
Run only the extracted artifact's `server-inventory.sh` with bash and return its complete stdout.
If a tool is absent, report absent; do not install it. Do not guess ports, database endpoints,
role names, credentials, or package versions. Stop after the inventory.
```

The script checks OS/tool versions, Bun/npm/psql/Docker/buildx presence, existing checkouts and
their `node_modules`/generated Prisma/.next state, presence-only private env file checks, and whether
`43117`/`43118` are already listening. It performs **no** database query, role lookup, install,
network scan, or service action. It prints only presence/set/unset markers, never env values.

## Database role preparation (preparation only; do not execute)

Proposed role: `sessionport_validation_runtime` on the existing isolated
`session_port_validation` database. The role is `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`,
`NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, `NOBYPASSRLS`, connection limit 4. It gets `CONNECT` on
the validation database, `USAGE` on `public`, and `SELECT/INSERT/UPDATE/DELETE` on the 23 current
application tables. `_prisma_migrations` is explicitly excluded. No sequences exist in the reviewed
schema. No DDL, schema ownership, role membership, or grant option is proposed.

Preparation SQL and the full table list are in
[`runtime-role-prep.sql`](../../.package-verify-work/oauth-validation-20261020/db/runtime-role-prep.sql)
and [`runtime-role-review.md`](../../.package-verify-work/oauth-validation-20261020/db/runtime-role-review.md).
The SQL contains no password; a DBA must provision the credential separately via the approved
server secret mechanism.

**Main-database limitation.** `GRANT CONNECT` is not exclusive; PostgreSQL commonly allows `PUBLIC`
to connect to a database. This role may therefore retain the ability to open a connection to the main
database `session_port` even with no table grants there. Do not claim zero main-database access from
the role SQL alone. Resolving it requires a DBA-scoped `pg_hba.conf` reject rule (actual client CIDR
observed on the server, never guessed) or explicit approval for a cluster-level main-database
`PUBLIC CONNECT` change. This preparation does not modify `pg_hba.conf`, `PUBLIC`, or the main
database. The pre-start guard reports this privilege as a warning, not a guarantee.

## Configuration (test-only; owner approval before use)

Exact non-secret test-only values and their source fixtures are in
[`test-only-values.json`](../../.package-verify-work/oauth-validation-20261020/config/test-only-values.json).
They are not production defaults. Required server-side secret names (values never in this handoff):

`SESSIONPORT_BETTER_AUTH_SECRET`, `SESSIONPORT_GITHUB_CLIENT_SECRET`,
`SESSIONPORT_NATIVE_HUMAN_CODE_KEYS_JSON`, `SESSIONPORT_NATIVE_CSRF_KEY_BASE64`,
`SESSIONPORT_RUNTIME_DATABASE_URL`.

Server-side non-secret names include `SESSIONPORT_GITHUB_CLIENT_ID`,
`SESSIONPORT_NATIVE_HUMAN_CODE_ACTIVE_KEY_ID`, `SESSIONPORT_PUBLIC_ORIGIN`, and
`SESSIONPORT_INTERNAL_API_ORIGIN`.

The API reads configuration only from the process environment; it does not load `.env` files. Use
the existing private server secret mechanism. Keep secrets out of argv, shell history, URLs, logs,
chat, and temporary plaintext files. Do not create a new secret dump.

The native client's `origin` remains unresolved by design; see the critical blocker. Do not set it
silently to either port.

## Planned execution sequence (only after owner/security approval)

1. Parent/bounded security review of this handoff; owner approves registry access, the isolated
   database role preparation, and the bounded start.
2. Transfer the bundle; verify `sha256sum` equals
   `063355503649883d773971821a0e93c6f6565c018c9bfbcc94ef565dd1ee3e7a`.
3. Extract into a **new, empty, owner-approved directory**; run `sha256sum -c SHA256SUMS` from the
   extracted root. Stop on any mismatch or extra forbidden file.
4. Run `server-inventory.sh`; review versions, ports, checkouts, and private-secret presence. Stop
   on an unexpected checkout/port/tool mismatch; do not repair automatically.
5. With explicit network approval, run `bun install --frozen-lockfile --ignore-scripts` once at the
   extracted root. Public registry only; no lifecycle scripts; no lockfile changes.
6. From `cloud/api`, run `npm run db:validate` and then `npm run db:generate`. These are offline
   schema checks/generation; they must not connect to PostgreSQL. Re-run `sha256sum -c SHA256SUMS`
   and stop if preparation changed any manifest file.
7. After owner/DBA approval, execute the role preparation SQL; provision the role password by the
   approved secret mechanism. Verify only metadata (role flags, 23 tables, no
   `_prisma_migrations` access). Resolve the main-database `PUBLIC CONNECT` limitation as above.
8. Load the API/web secrets through the approved mechanism in each process shell. Never enable
   `set -x`.
9. From the extracted root, run `node prestart-db-guard.mjs`. It must print
   `PRESTART_DB_GUARD=PASS`, the exact validation database/role, and no secret. It reports
   `MAIN_DB_CONNECT_PRIVILEGE` separately; that is not the same as the guard's target check.
10. Start the API from `cloud/api`: `node --import tsx src/main.ts`. Check
    `GET http://127.0.0.1:43118/health/live` only. `GET /health/ready` is expected to remain `503`
    because migration/storage readiness checks are hard-coded false.
11. Start the web app from `cloud/web`: `npm run dev -- -H 127.0.0.1 -p 43117`. Do not bind
    `0.0.0.0`; do not publish the port.
12. Local browser machine, no public bind:

    ```sh
    ssh -N \
      -L 43117:127.0.0.1:43117 \
      -L 43118:127.0.0.1:43118 \
      root@66.151.42.193
    ```

    Open `http://127.0.0.1:43117/login` locally. Keep the tunnel open through the GitHub callback.
13. Browser-only path: sign in with the selected GitHub identity, observe `/device`, enter the
    human code manually, approve, then inspect `/devices`; revoke only if the owner requests it.
    Do not log cookies, CSRF tokens, OAuth codes, or native credentials.
14. Native path: **do not start** until the origin blocker is resolved. After an approved fix, set
    the native client origin to the approved public base, run the device flow, and exercise
    `/v1/me` only if separately in scope. Record exact request/response status and sanitized error
    codes, never raw credentials or identity content beyond what the owner approved.

## Current blockers

| Blocker | Owner/next action |
| --- | --- |
| Native client origin vs strict `verificationUri` and missing BFF create/token routes | Parent chooses BFF route addition, reviewed gateway, or client origin split. No value guess. |
| No server inventory yet | Run the bounded read-only inventory prompt. |
| No OAuth App yet | Complete the manual registration above; secrets stay server-side. |
| No restricted runtime role/password yet | DBA/owner approval; preparation SQL is unexecuted. |
| Main-database `PUBLIC CONNECT` residual | DBA-scoped pg_hba rule or explicit cluster-level approval; no main-DB mutation here. |
| Runtime tool versions, empty directory, registry approval unknown | Inventory + explicit execution approval. |
| Existing `822bf...` image is not the app | Build/install the source bundle separately; do not claim image reuse. |
| `/health/ready` is 503 by design | Use `/health/live` plus functional observations; do not call it a failed start. |

## Non-claims and boundaries

- Not a deployment, migration, privilege-creation, OAuth-registration, or runtime-acceptance record.
- No production defaults, caps, crypto parameters, or compatibility claims are inferred from the
  V1 archive or from test-only values.
- No existing repository source, docs, config, package manifest, lockfile, Git state, SSH config,
  database, or private environment file was modified. Source/config files were read for this
  handoff; no private environment file contents, database rows, or secrets were read.
- Real OAuth identity/session records in the validation database are limited to the owner-selected
  account and the approved run; no cleanup of identity data is included without a separate plan.
- The bundle is a repository-local ignored scratch artifact; its hash is evidence of bytes prepared
  here, not of server execution.
