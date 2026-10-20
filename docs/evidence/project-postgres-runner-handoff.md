# Project repository PostgreSQL validation runner handoff (2026-10-20)

Status: **PREPARED ONLY — NOT EXECUTED — REVIEW GATE.**

This document prepares one bounded synthetic project/quota validation run against
the existing `session_port_validation` database. No Docker command, build,
container run, database connection, migration, Git action, network request, SSH
action, credential read, or `.env` read was performed while preparing this
handoff. The derived image has **not** been built, and the runner has **not** been
executed. Every server command below is a proposal that requires parent/Oracle
review and explicit owner approval before execution.

The owner lifted the deferral **only** for the original bounded synthetic
project/quota run described here. This is not authorization for the application
database, the main API database, migration `202610200003_protocol_native`, a
deployment, or any other database action.

## 1. Artifact identity

| Item | Value |
| --- | --- |
| Archive | `sessionport-project-validation-20261020.zip` |
| Archive bytes | `17,596` |
| Archive SHA-256 | `33de29d0b63d9a979558844de1811b5d4e514ebbf212f59da511013f278e0bff` |
| Extraction root | `project-validation-20261020/` |
| Base image ID | `sha256:af9d6a1209f9aa6316c47cf0c922556c058fc3fd513cf8d0d156eca26756b294` |
| Derived image | **not built** |

Preparation record:
[`BUILD-RECORD.md`](../../.package-verify-work/project-validation-20261020/BUILD-RECORD.md).
Machine-readable archive verification:
[`archive-verification.json`](../../.package-verify-work/project-validation-20261020/archive-verification.json).

The archive is a closed allowlist of exactly eight regular files, with relative
forward-slash entry names under `project-validation-20261020/` and no directory
symlinks:

| Entry (relative to archive root) | Bytes | SHA-256 |
| --- | ---: | --- |
| `.dockerignore` | 641 | `6045bac0dcd5d8d04d4f346dcb08db3338ac9d5d5a8fadd60b46d811989fc9eb` |
| `Dockerfile.runner` | 1,112 | `c3853a3903f35180d27e35e84541abd9b5b7fbc5d880f7a702db3e18288a8947` |
| `SHA256SUMS` | 709 | `cfdad5f8896bdc8aaa8acfc7b8c88ca3d205b2b8f58ed022d00946aabd24662f` |
| `payload/SHA256SUMS` | 428 | `af190383389d6d36c83fd32499bfba4f1e321c6e7a41dd149c5303a351d5e9aa` |
| `payload/cloud/api/scripts/validate-projects.ts` | 9,987 | `fecb8a6367b672c90177d3db4439c1ee177e0c1fa92961a01c8cd05986e68ca6` |
| `payload/cloud/api/src/database/config.ts` | 4,646 | `e0dd35fdc906f2ee714f8cf79c98a10e5f5e42accfe186fc023a4ff2c140e7f8` |
| `payload/cloud/api/src/projects/repository.ts` | 16,792 | `73c99623571121ae8c83c09f631965f8638cd10ec06b356888271471b2635208` |
| `payload/cloud/api/test-support/projects-postgres-validation.ts` | 18,223 | `b45e4ddc2db01f0f41dbda9ebded2d9ae52f59b09bb03eb03edeb53ad9c72cf7` |

No `.env`, secret, credential, key, generated client, `node_modules`, migration
directory, current `202610200003` migration, log, database dump, or handoff copy
is inside the archive. The handoff is intentionally outside the archive to avoid
a hash self-reference.

The ZIP entries use fixed sorted order, fixed `1980-01-01T00:00:00` timestamps,
and fixed `0644` regular-file permissions. This is deterministic under the
recorded local builder. No cross-tool or cross-platform byte-reproduction claim
is made; the archive SHA-256 above is the transfer identity.

## 2. Scope, authorization, and non-claims

- Scope is the original synthetic project/quota repository validation only:
  `User`, `Project`, and `UserQuota` behavior in `session_port_validation`.
- The run is exactly **one** bounded run. No retry, no second attempt, no
  alternate target.
- The existing database must already have exactly the two finished migrations
  `202610190001_vendor_auth` and `202610190002_project_quota`. Do **not** run
  `db:deploy`: it would also apply `202610200003_protocol_native`.
- Do not create, alter, migrate, reset, drop, or seed any database or role. The
  runner's read-only guard is authoritative; do not substitute a psql command
  that loads or prints a database secret.
- No M2 revision/auth/PostgreSQL implementation or compatibility claim is made.
  The evidence scope is the project/quota repository and its exact runner cases.
- No deployment, production-readiness, security, or full PostgreSQL claim is
  made. All server actions are manual/external and remain unperformed until the
  review gate and owner approval.

## 3. Source identity and import closure

The four payload files are byte-exact copies of the current repository sources:

| Source path | Bytes | SHA-256 |
| --- | ---: | --- |
| `cloud/api/scripts/validate-projects.ts` | 9,987 | `fecb8a6367b672c90177d3db4439c1ee177e0c1fa92961a01c8cd05986e68ca6` |
| `cloud/api/test-support/projects-postgres-validation.ts` | 18,223 | `b45e4ddc2db01f0f41dbda9ebded2d9ae52f59b09bb03eb03edeb53ad9c72cf7` |
| `cloud/api/src/projects/repository.ts` | 16,792 | `73c99623571121ae8c83c09f631965f8638cd10ec06b356888271471b2635208` |
| `cloud/api/src/database/config.ts` | 4,646 | `e0dd35fdc906f2ee714f8cf79c98a10e5f5e42accfe186fc023a4ff2c140e7f8` |

Import closure checked against the four files:

- `validate-projects.ts` imports only `node:path`, `node:url`, the runtime
  database config reader, the runtime test-support driver, the type-only
  `DatabaseConnectionConfig` and `PrismaClient` types, and the type-only
  `ProjectPostgresValidationResult`. The generated-client import and
  `@prisma/adapter-pg` are dynamic imports in the validation attempt.
- `projects-postgres-validation.ts` imports only `node:crypto`, the runtime
  repository, the type-only `PrismaClient`, and the type-only
  `CreateOrLinkResult`.
- `repository.ts` imports only type-only `Prisma` and `PrismaClient` from the
  generated client. It has no runtime import of generated models.
- `config.ts` has no imports.

The image's existing generated client is the old, two-migration client. It
supports the queried `user`, `project`, and `userQuota` delegates and the
`$queryRaw`/`$transaction` operations used by this runner. The repository's
newer `listWithState` branch references `ProjectHead`/`Revision` state and is
**not called** by the runner: the runner uses only `createOrLink` and
`listActive`. All Prisma/model imports in `repository.ts` are type-only and are
erased by `tsx`; no revision or auth call is added. The base image is expected
to provide Node, `tsx`, installed dependencies including `@prisma/adapter-pg`,
and the generated client. That base-image content is owner-reported and is not
re-proven by this preparation.

## 4. Bundle design

`Dockerfile.runner`:

- pins `FROM sha256:af9d6a1209f9aa6316c47cf0c922556c058fc3fd513cf8d0d156eca26756b294`;
- uses `USER node` and `WORKDIR /app`;
- copies exactly the four payload files and `payload/SHA256SUMS` with
  `--chown=node:node`, preserving the `/app/cloud/api/...` tree;
- runs `sha256sum -c /app/SHA256SUMS` offline before switching to
  `WORKDIR /app/cloud/api`;
- has no install, registry, schema, migration, deploy, network, or database step;
- declares no `ENTRYPOINT` of its own; verify any inherited base entrypoint in
  the derived-image inspect output. The default
  `CMD ["node", "--import", "tsx", "scripts/validate-projects.ts"]` has no flags
  and only prints `status=stopped code=validation-run-not-requested` before
  exiting without connecting or writing.

Because arguments after the image replace `CMD`, the authorized run must repeat
the explicit command and add the two flags. Passing only
`--run-validation-only --max-run-ms=90000` after the image would try to execute
the flag as a command and is wrong.

`.dockerignore` is default-deny (`**`) with precise exceptions for
`Dockerfile.runner`, the four payload source paths, their parent directories,
and `payload/SHA256SUMS`. The extracted outer `SHA256SUMS` is not a build input.
No env file or secret is in the context.

`payload/SHA256SUMS` covers the four copied source files. The outer `SHA256SUMS`
covers `Dockerfile.runner`, `.dockerignore`, `payload/SHA256SUMS`, and the four
payload files. It intentionally does not cover itself or the external handoff.

## 5. Server preflight (unexecuted)

Set these placeholders on the server. Do not put a database URL, password, token,
or other secret in any command line, shell variable, log, or transcript.

```sh
ZIP_INPUT='<PATH_TO_TRANSFERRED_ZIP>'
EXTRACT_DIR='<NEW_EMPTY_OWNER_SCOPED_DIRECTORY>'
BASE_IMAGE_ID='sha256:af9d6a1209f9aa6316c47cf0c922556c058fc3fd513cf8d0d156eca26756b294'
ENV_FILE='<SERVER_ONLY_ENV_FILE_OUTSIDE_BUNDLE>'
CONTAINER_NAME='sessionport-project-validation-20261020'
```

1. Verify the transferred archive before extraction:

   ```sh
   test "$(sha256sum "$ZIP_INPUT" | awk '{print $1}')" = \
     "33de29d0b63d9a979558844de1811b5d4e514ebbf212f59da511013f278e0bff"
   ```

   Stop on any mismatch. Do not repair or rebuild the archive on the server.

2. Extract into a new empty owner-scoped directory without overwriting:

   ```sh
   test ! -e "$EXTRACT_DIR"
   mkdir -m 700 "$EXTRACT_DIR"
   unzip -q -n "$ZIP_INPUT" -d "$EXTRACT_DIR"
   cd "$EXTRACT_DIR/project-validation-20261020"
   ```

3. Verify both manifests and the closed file list:

   ```sh
   sha256sum -c SHA256SUMS
   ( cd payload && sha256sum -c SHA256SUMS )
   find . -type f -print | LC_ALL=C sort
   test -z "$(find . -type l -print -quit)"
   ```

   Expected exactly these eight relative file paths, in any order:

   ```text
   .dockerignore
   Dockerfile.runner
   SHA256SUMS
   payload/SHA256SUMS
   payload/cloud/api/scripts/validate-projects.ts
   payload/cloud/api/src/database/config.ts
   payload/cloud/api/src/projects/repository.ts
   payload/cloud/api/test-support/projects-postgres-validation.ts
   ```

4. Confirm the exact base image is already local, without pulling or retagging:

   ```sh
   test "$(docker image inspect --format '{{.Id}}' "$BASE_IMAGE_ID")" = \
     "$BASE_IMAGE_ID"
   docker image inspect --format \
     '{{.Id}} {{.Os}}/{{.Architecture}}' "$BASE_IMAGE_ID"
   ```

   Record the OS/architecture. If the image is absent, if the ID differs, or if
   the Docker daemon is unavailable, stop. Do not pull from a registry and do
   not substitute a tag or another image.

5. Confirm the existing internal network exists; do not create or modify it:

   ```sh
   docker network inspect --format '{{.Name}} {{.Driver}}' session_port_internal
   ```

6. Confirm the existing PostgreSQL container is running, attached to that
   network, and accepting connections. This is a liveness check only; it does
   not authenticate and does not prove migration state:

   ```sh
   docker container inspect --format \
     '{{.Name}} running={{.State.Running}} image={{.Config.Image}}' \
     session-port-postgres
   docker container inspect --format \
     '{{range $name, $value := .NetworkSettings.Networks}}{{$name}} {{end}}' \
     session-port-postgres
   docker exec session-port-postgres pg_isready \
     -h 127.0.0.1 -p 5432 \
     -U sessionport_validation_migrator -d session_port_validation
   ```

   Required: the container is running, `session_port_internal` appears in its
   networks, and `pg_isready` exits 0. Do not use `psql`, `PGPASSWORD`, a URL, or
   any command that loads or prints the database secret here. The runner's
   read-only guard is the authoritative database/identity/migration check.

7. Confirm the fixed owned container name is unused, including stopped
   containers. If it exists, bail; do not delete or reuse it:

   ```sh
   if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
     printf 'preflight_failed=container-name-exists\n'
     exit 1
   fi
   ```

8. Manually verify the server-only env file. It must be outside the extracted
   bundle and outside any build context, readable only by the operator, and
   contain exactly one key:

   ```text
   SESSIONPORT_MIGRATOR_DATABASE_URL
   ```

   Its URL must target host `session-port-postgres`, port 5432 (or an omitted
   explicit port), role `sessionport_validation_migrator`, and database
   `session_port_validation`. Do not `cat`, `source`, `echo`, dump, or pass the
   value on a command line. Use only `--env-file "$ENV_FILE"`. If the file is
   missing or contains any extra key or a different target, stop; do not create
   a new secret or fall back to another database.

## 6. Offline derived-image build (unexecuted)

From the extracted `project-validation-20261020/` directory:

```sh
TAG='sessionport-project-validation:review-20261020'
docker build --pull=false --network=none --no-cache \
  -f Dockerfile.runner \
  -t "$TAG" \
  .
```

This adds only the six build inputs to the exact local base image. It performs
no registry install, schema generation, migration, deploy, or database access.
`--pull=false` and `--network=none` prevent network use; `--no-cache` forces a
clean derived build but is not a security control by itself. If Docker rejects
the bare local image-ID syntax in `FROM`, or cannot resolve the exact ID, stop at
the review gate. Do not edit the Dockerfile to a tag, add a registry reference,
or pull a replacement image without parent review.

Capture the immutable derived image ID and verify its runtime shape without
running the validation:

```sh
IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$TAG")"
docker image inspect --format \
  '{{.Id}} user={{.Config.User}} workdir={{.Config.WorkingDir}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}' \
  "$IMAGE_ID"
```

Use `"$IMAGE_ID"` for the run, never the staging tag. The recorded image ID must
be the immutable content identity. The original base image is not modified.
Required shape: `user=node`, `workdir=/app/cloud/api`, and `cmd` exactly
`["node","--import","tsx","scripts/validate-projects.ts"]`. The entrypoint must
be empty or a reviewed base passthrough; an unexpected entrypoint stops the
handoff for review.

## 7. One bounded run (unexecuted)

Preflight the container name again immediately before the run (including
stopped containers). If it exists, bail; do not delete:

```sh
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  printf 'run_failed=container-name-exists\n'
  exit 1
fi
```

Run with the outer 120-second deadline. The inner runner deadline is 90 seconds.
No ports, host mounts, Docker socket, privileged mode, extra environment, or
additional filesystem policy are used. A read-only root filesystem with a
temporary mount is intentionally **not** added because that operational
restriction is unverified for this CLI.

```sh
set +e
timeout --signal=TERM --kill-after=5s 120s \
  docker run \
    --name "$CONTAINER_NAME" \
    --rm \
    --user node \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --network session_port_internal \
    --env-file "$ENV_FILE" \
    "$IMAGE_ID" \
    node --import tsx scripts/validate-projects.ts \
      --run-validation-only --max-run-ms=90000
rc=$?
set -e
printf 'docker_run_exit_code=%s\n' "$rc"
```

A Docker CLI timeout does not guarantee that the container stopped. On exit code
124 or 137, inspect only the fixed owned name and stop only that container if it
still exists:

```sh
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker stop --time 5 "$CONTAINER_NAME" || true
    docker container inspect --format \
      'container_state={{.State.Status}} container_exit={{.State.ExitCode}}' \
      "$CONTAINER_NAME" || printf 'container_state=absent-or-unavailable\n'
  else
    printf 'container_absent=%s\n' "$CONTAINER_NAME"
  fi
fi
```

Never use a broad kill, `docker ps`-wide stop, `docker rm`, prune, or a database
cleanup. There is no automatic DB cleanup and no retry. If the owned name is
still present after `docker stop`, report its state and stop; do not delete it.

## 8. Success and failure reporting

Success requires **all** of the following, not exit code alone:

```text
docker_run_exit_code=0
status=passed
testPassed=true
cleanupVerified=true
postgresqlMajor=16
migrations=2
fixtureUsers=3
checks=15/15
failedCheck=none
```

The eight bounded case groups must all be recorded (the quota group contributes
two named checks), and `cleanupVerified=true` must be reported. The runner's 15
checks include the guard checks and `cleanup-verified`; do not treat a zero exit
code or a partial line set as success.

Any guard, seed, case, deadline, manifest, build, preflight, or run failure means
stop. Fixtures may remain; `cleanupVerified` must be false. Do not retry, do not
run `db:deploy`, do not run a cleanup psql command, and do not reset or edit the
database. Report only the fixed runner status lines, the immutable image ID, the
exit code, the timeout result, and the owned container state or absence. Do not
report SQL, raw exception text, the database URL, env-file contents, credentials,
or row data. The parent decides any next bounded action.

## 9. Review checklist before server handoff

- Confirm this preparation is reviewed by the parent and Oracle, and that the
  owner authorizes the single bounded server run.
- Confirm the transferred ZIP hash matches `33de29d0...e0bff` and both manifests
  verify after extraction.
- Confirm the base image ID is exactly
  `sha256:af9d6a1209f9aa6316c47cf0c922556c058fc3fd513cf8d0d156eca26756b294`
  and is local.
- Confirm `session_port_internal`, `session-port-postgres`, and the existing
  validation database/role are present, and the two-migration guard is expected.
- Confirm the env file is server-only, outside the bundle, mode-restricted, and
  contains only `SESSIONPORT_MIGRATOR_DATABASE_URL`.
- Confirm no container with the fixed owned name exists before build/run.
- Confirm the derived image is built offline from the exact base ID and the run
  uses the captured immutable derived image ID.
- Confirm one run only, outer 120 s / inner 90 s, no retry, no DB cleanup, and no
  `db:deploy`.

## 10. Preparation non-claims

- Not built, not run, not deployed, not connected. No Docker, Git, network, SSH,
  database, credential, or env-file action was performed in this preparation.
- No compatibility, migration, security, performance, or platform claim is
  backed by an execution here.
- The base image contents and the presence of its generated old client are
  owner-reported prerequisites, not re-verified by this artifact.
- The archive is not claimed to be byte-reproducible by other ZIP tools or
  platforms; only the recorded local archive hash is asserted.
- The handoff is outside the ZIP by design, so its hash is recorded in
  `BUILD-RECORD.md`, not in an archive manifest.
