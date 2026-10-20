# Docker-only Prisma validation handoff (2026-10-20)

Status: **preparation and review only.** No Docker daemon was started, no image was pulled or built, no container was run, and no database, credential, secret, or network endpoint was contacted. Every Docker command below is unexecuted and unverified. Registry digests were researched from the public Docker Hub pages; they are not server-side proof that a manifest is available or matches the server architecture.

This Docker path supersedes the host-tool gate in `docs/evidence/prisma-validation-handoff.md` **only** for the execution mechanism. The previously approved target scope and migration authorization are unchanged. Migrations `202610190001_vendor_auth` and `202610190002_project_quota` were already approved; this updated Docker plan requires parent review before execution. Pull, build, preflight, and deploy each require an owner-approved Docker-only action on the server.

## Supplemental bundle and original bundle

Supplemental bundle: `sessionport-prisma-validation-docker-20261020.zip` in the ignored `.package-verify-work/db-validation-docker-20261020/` directory. It contains only:

- `Dockerfile.validation`
- `.dockerignore`
- `prisma-validation-docker-handoff.md` (byte-exact copy of this document)
- `SHA256SUMS` (covers the three files above, not itself)

The original transfer bundle remains separate: `sessionport-prisma-validation-20261020.zip`, 82,160 bytes, SHA-256 `1DEBE7468DB3A63E310C595B3E21F7538641BBF9CD8C15119E6D0EDE943FCFC4`. It is already uploaded to the server but has not been extracted. Do not merge the supplemental files into that archive. Verify the original hash, extract it fresh, verify its 14-file `SHA256SUMS`, then add only `Dockerfile.validation` and `.dockerignore` (this handoff copy is not a build input).

Assembled build context must be exactly: the 14 original content files, the original `SHA256SUMS`, `Dockerfile.validation`, and `.dockerignore` — 17 files. No overlay, no root project files, no source tree, no prior `node_modules`, no generated client, no `.env`, no secrets. The context assembly is exact by construction; `.dockerignore` is a second, default-deny guard.

## Required server facts before pulling or building

1. Docker daemon is available to the server agent and the agent is authorized to use it. The daemon is root-trusted; anyone who can read its state or control it can access image/container metadata.
2. The server CPU architecture is known and matches one table row below. Do **not** assume `amd64` and do **not** use blind `--platform` emulation. If the architecture is not listed, stop.
3. The existing PostgreSQL container `session-port-postgres` is running, and the existing `session_port_internal` network exists. Do not start, change, or create containers, networks, databases, roles, or credentials. If any prerequisite is absent, stop and report.
4. The target database `session_port_validation` and role `sessionport_validation_migrator` already exist as reported. Never bootstrap a role for this validation or for the API. The application database `session_port` and every other database are out of scope; do not target them.

| Architecture | Node image reference | Bun image reference |
| --- | --- | --- |
| Linux amd64 | `node@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562` | `oven/bun@sha256:b2e30c1564e3e72851df7a78bb8444cd02cca94b3b27275574a97ee99db20c03` |
| Linux arm64 | `node@sha256:b20fe038d9592822dd534600a1ddf467e985178aa3fed60ec441a056c2cc45bd` | `oven/bun@sha256:b62061062f07ba02a7e6828a04d8ce736717315eda00dc101a0a59646ed526a5` |

Select both references from the **same** row. Verify the server architecture first; the provided manifest match is a review input, not a runtime proof. No other tags, retags, or `latest` references are acceptable.

## Image design

`Dockerfile.validation` has two stages: Bun `AS bun` and Node `AS validation`. It takes required global build arguments `NODE_IMAGE` and `BUN_IMAGE` with no defaults, rejects references that are not digest-pinned, copies only `/usr/local/bin/bun` from the Bun stage, and runs `node --version` plus `bun --version` checks. The Node check requires 22.x with minor `>= 22.12`; Bun must report exactly `1.3.10`. The exact Node patch inside the image is unknown until the build and must be recorded, not assumed.

The image:

- installs only `ca-certificates` and `openssl` via Debian apt **inside the temporary build image** (never on the host), then removes apt lists;
- creates a node-owned `/app`, switches to `USER node` before registry install and Prisma scripts, and copies every file with `--chown=node:node`;
- copies exactly the 14 allowlisted files plus `SHA256SUMS`; it contains no application HTTP code, service listener, `EXPOSE`, Docker socket, host mount, or secret;
- runs `sha256sum -c SHA256SUMS` before and after tooling commands;
- runs `bun install --frozen-lockfile --ignore-scripts`, with no database URL, `.env`, build secret, or lifecycle script;
- runs `npm run db:validate` and `npm run db:generate` from `cloud/api` without a datasource URL;
- has no `ENTRYPOINT` and no automatic deploy. The default `CMD` only prints readiness/help and exits. An explicit `npm run db:deploy` container command overrides it.

The build may need public network access for apt, the public package registry, and any Prisma engine fetch required by the pinned tooling. That is build-tooling access only: no database connection, credential, secret, or private source environment is used during the build. No offline claim is made.

## Execution sequence (only after parent review and owner-approved Docker action)

1. Verify the original zip hash `1DEBE7468DB3A63E310C595B3E21F7538641BBF9CD8C15119E6D0EDE943FCFC4`; extract into a new empty directory; run `sha256sum -c SHA256SUMS` and confirm all 14 files pass.
2. Verify the supplemental zip and its manifest; place only `Dockerfile.validation` and `.dockerignore` into the extracted root. Confirm the context has 17 files and no extras.
3. Verify Docker daemon availability and server architecture. Select the matching Node/Bun digest row. If the daemon, architecture, or digest availability does not match, stop; do not retag or emulate.
4. Build with no secrets:

   ```text
   docker build --file Dockerfile.validation \
     --build-arg NODE_IMAGE="node@sha256:<matching row digest>" \
     --build-arg BUN_IMAGE="oven/bun@sha256:<matching row digest>" \
     --tag sessionport-validation:review-20261020 .
   ```

5. Before any credential exposure, capture the immutable image ID and verify the in-image tool versions and architecture:

   ```text
   docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' sessionport-validation:review-20261020
   docker run --rm --network none <imageID> node --version
   docker run --rm --network none <imageID> bun --version
   ```

   The Node result must be 22.x with minor `>= 22.12`; Bun must be exactly `1.3.10`. Record both and the image ID. The staging tag is not used for deployment.

6. Preflight through the existing PostgreSQL container, using its already-installed `psql` (confirm it exists; do not install host tooling). Load `PGUSER=sessionport_validation_migrator`, `PGDATABASE=session_port_validation`, and `PGPASSWORD` from the existing server-only secret mechanism. Pass them to `docker exec` by name only so no password appears in argv. Do not use `set -x`, `echo`, a sourced `.env`, or a database URL in shell history. Connect over loopback inside the database container, not from the host:

   ```text
   docker exec -i -e PGUSER -e PGPASSWORD -e PGDATABASE session-port-postgres \
     psql -X -h 127.0.0.1 -v ON_ERROR_STOP=1 <<'SQL'
   SELECT current_database(), current_user, session_user, version();
   SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
     FROM pg_roles WHERE rolname = current_user;
   SELECT count(*) AS public_objects
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f');
   SELECT to_regclass('public._prisma_migrations') AS migration_history;
   SELECT has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
          has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public,
          has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public;
   SQL
   ```

   Required results: `session_port_validation`, `sessionport_validation_migrator` for both `current_user` and `session_user`, PostgreSQL 16, all role privilege flags false, zero objects in `public`, null migration history, and all three capability checks true. Stop on any mismatch. This is read-only metadata; do not read row content.

7. Run exactly one guarded deploy after the owner approves that action. The env file must be outside the build context, protected with mode 600 and limited ownership, and contain only `SESSIONPORT_MIGRATOR_DATABASE_URL` for the validation database, populated from the existing server-only secret mechanism. It must contain no other secrets. If such a file does not already exist, the server agent may prepare it from existing permitted configuration without inventing a new secret value. Do not print it, source it in a shell, or put the URL in argv. Use the immutable image ID:

   ```text
   docker run --rm --name sessionport-validation-deploy-20261020 \
     --network session_port_internal \
     --user node \
     --cap-drop ALL \
     --security-opt no-new-privileges \
     --env-file <protected server-only env file outside the build context> \
     <imageID> \
     node -e '
const { spawnSync } = require("node:child_process");

const fail = () => {
  console.error("SESSIONPORT_TARGET_GUARD: invalid migrator target or deploy launch failure");
  process.exitCode = 1;
};

try {
  const raw = process.env.SESSIONPORT_MIGRATOR_DATABASE_URL;
  if (!raw || raw !== raw.trim() || raw.includes("#")) throw 0;
  const u = new URL(raw);
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw 0;
  if (u.hostname !== "session-port-postgres") throw 0;
  if (u.port !== "" && u.port !== "5432") throw 0;
  if (decodeURIComponent(u.pathname) !== "/session_port_validation") throw 0;
  if (decodeURIComponent(u.username) !== "sessionport_validation_migrator") throw 0;
  if (decodeURIComponent(u.password).length === 0) throw 0;
  const knownSslModes = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);
  let schemaSeen = false;
  let sslSeen = false;
  for (const [key, value] of u.searchParams) {
    if (key === "schema") {
      if (schemaSeen || value !== "public") throw 0;
      schemaSeen = true;
    } else if (key === "sslmode") {
      if (sslSeen || !knownSslModes.has(value)) throw 0;
      sslSeen = true;
    } else {
      throw 0;
    }
  }
  const result = spawnSync("npm", ["run", "db:deploy"], {
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  if (result.error || result.status === null || typeof result.status !== "number") throw 1;
  process.exitCode = result.status;
} catch {
  fail();
}
'
   ```

   The inline guard reads the actual container environment, validates the target literal (exact scheme, private host, canonical 5432 or omitted port, exact database path, migrator user, nonempty password, no fragment, only optional `schema=public` and explicit known `sslmode`), then spawns `npm run db:deploy` with the unchanged environment, `shell: false`, and inherited stdio. A parse, decode, validation, or launch failure exits 1 without echoing the URL or starting npm. This is a target-value guard only, not metadata attestation from the URL; the psql preflight above remains mandatory. The migration CLI alone reads `SESSIONPORT_MIGRATOR_DATABASE_URL` through `prisma.config.ts`; the role must never be used by a long-running client runtime. No credential is present in the image or build.

   No ports, published host directories, Docker socket, privileged mode, extra environment, runtime URL, or API process. The writable layer may hold build/cache output; no read-only-root claim is made because that is untested.

8. Apply a bounded server-agent timeout to build and deploy. A Docker CLI timeout does not necessarily stop the container: if the command exits ambiguously, do not retry; inspect the named container and stop only that owned container. The database state is retained either way. A stopped/removed container is not a database reset.

## Post-deploy metadata verification

Run read-only checks through the same `docker exec` mechanism after the deploy command exits. Expected exact state:

- Exactly 2 finished rows in `public._prisma_migrations`, names `202610190001_vendor_auth` and `202610190002_project_quota`; zero unfinished and zero rolled-back rows.
- Exactly 15 base tables in `public`, excluding `_prisma_migrations`: 13 vendor tables plus `Project` and `UserQuota`.
- `UserQuota`: primary key, exactly 2 CHECK constraints (`UserQuota_bytes_nonnegative_check`, `UserQuota_usage_within_limit_check`), and one foreign key to `"user"("id")` with `ON DELETE RESTRICT` (`confdeltype = 'r'`).
- `Project` foreign key to `"user"("id")` also restricts deletes.

```sql
SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back
  FROM public._prisma_migrations;
SELECT migration_name FROM public._prisma_migrations ORDER BY started_at;
SELECT count(*) FROM pg_tables
  WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';
SELECT conname, contype, confdeltype, pg_get_constraintdef(oid)
  FROM pg_constraint WHERE conrelid = 'public."UserQuota"'::regclass ORDER BY conname;
SELECT conname, confdeltype FROM pg_constraint
  WHERE conrelid = 'public."Project"'::regclass AND contype = 'f';
```

Report only: PostgreSQL version, Node/Bun versions, architecture, image ID, verified zip and manifest hashes, deploy exit code, migration names and finished counts, table count, and constraint names/types. Never report the database URL, password, env-file content, role secret, row content, or IDs.

## Failure policy

Any prerequisite, architecture, hash, manifest, version, build, preflight, or deploy failure stops the run and retains all state. No retries, no container reuse, no database reset, no `DROP`, no `migrate resolve`, no manual `_prisma_migrations` edits, and no automatic cleanup of database objects. Report the exact failed step, exit code, and permitted metadata; the parent decides the next bounded action.

## Non-claims and blockers

- This is not a deployment and does not authorize production use. Production tables and migration history do not exist; applying even to `session_port_validation` needs owner authorization for that bounded run.
- No Docker pull, build, run, preflight, or migration was performed here. Registry digests are researched inputs, not actual server availability or architecture proof.
- Exact Docker CLI version/flag support, the Bun binary path inside the Bun image, Debian package availability, and Prisma engine-fetch behavior are unverified until the reviewed build. If a path or flag differs, stop at the review gate; do not invent or upgrade tooling.
- No full PostgreSQL, runtime, auth, quota-enforcement, concurrency, or HTTP deployment claim is made.
- Blockers are server-side readiness facts only: Docker daemon, architecture selection, existing `session-port-postgres`, existing `session_port_internal` network, existing validation database/role, secure secret loading, and parent review of this Docker plan. No new approval question is raised here; the Docker preparation itself is approved.
