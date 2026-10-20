# Project validation runner handoff r2 (2026-10-20)

Status: **PREPARED ONLY — NEW REVIEW GO REQUIRED.** No Docker/DB/SSH/Git/
network/credential/.env action was performed in this revision. Image unbuilt;
server commands remain unapproved until parent/Oracle delta review and a new
owner GO.

This supersedes **only the build procedure** of
[`project-postgres-runner-handoff.md`](./project-postgres-runner-handoff.md).
Source bytes, runner scope, runtime command, timeouts, success gate, and failure
policy are unchanged. The original bundle/handoff remain historical records and
were not edited.

## 1. Confirmed prior failure

Sanitized server log:

```text
#1 [internal] load metadata for docker.io/library/sha256:af9d6a1209f9aa63...
ERROR: failed to solve: docker.io/library/sha256:...: pull access denied
build exit code: 1
```

The bare ID in `FROM` was resolved as a Docker Hub repository reference. The
build stopped before image creation; the runner was not run, no validation
container was present, and the database was untouched. No DB changes.

## 2. Minimal correction

Only the first line of `Dockerfile.runner` changes:

```text
# r1 (failed)
FROM sha256:af9d6a1209f9aa6316c47cf0c922556c058fc3fd513cf8d0d156eca26756b294

# r2 (local tag only)
FROM sessionport-validation-base-local:af9d6a1209f9aa63
```

All remaining Dockerfile bytes, `.dockerignore`, inner manifest, and the four
source payloads are byte-identical to r1. No dependency, model, run command,
test scope, or product source changed.

The local tag is an alias for the expected immutable base:

```text
sha256:af9d6a1209f9aa6316c47cf0c922556c058fc3fd513cf8d0d156eca26756b294
```

Tag creation is allowed only after the exact-ID/Linux-amd64 preflight. The tag
must resolve to that exact ID before and after build. `--pull=false` is **not**
network isolation for `FROM`; no registry login, pull, retag-by-name, or image
substitution is allowed. Any local resolution failure stops the attempt.

## 3. Artifact

| Item | Value |
| --- | --- |
| Archive | `sessionport-project-validation-20261020-r2.zip` |
| Bytes | `17,612` |
| SHA-256 | `1cefbb09756fe2af3722fc480a872377cc093882e127652c2067e7adb1ab9f53` |
| Root | `project-validation-20261020-r2/` |
| Entries | exactly 8 regular files; no symlinks |
| Local base tag | `sessionport-validation-base-local:af9d6a1209f9aa63` |
| Derived tag | `sessionport-project-validation:review-20261020-r2` |
| Derived ID | from `--iidfile`; not yet built |

Closed allowlist:

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

Dockerfile.runner hash:
`a25a4115b8fbaedd591a658e0e2a90b91acb8ac768b5ba140dd951a0c2e2ca42`.

## 4. Sources unchanged

All r2 payloads equal the r1 payloads and current repository sources:

| File | Bytes | Original = r2 = repository SHA-256 |
| --- | ---: | --- |
| `validate-projects.ts` | 9,987 | `fecb8a6367b672c90177d3db4439c1ee177e0c1fa92961a01c8cd05986e68ca6` |
| `projects-postgres-validation.ts` | 18,223 | `b45e4ddc2db01f0f41dbda9ebded2d9ae52f59b09bb03eb03edeb53ad9c72cf7` |
| `repository.ts` | 16,792 | `73c99623571121ae8c83c09f631965f8638cd10ec06b356888271471b2635208` |
| `config.ts` | 4,646 | `e0dd35fdc906f2ee714f8cf79c98a10e5f5e42accfe186fc023a4ff2c140e7f8` |

Import closure, old generated-client assumptions, unused `listWithState`, and
no-0003 behavior are unchanged from r1; no revision/auth call is added.

## 5. Server gates — any failure is STOP

Use placeholders; never put a URL, password, token, or secret in argv or chat.

```sh
ZIP_INPUT='<PATH_TO_R2_ZIP>'
EXTRACT_DIR='<NEW_EMPTY_OWNER_SCOPED_DIR>'
EXPECTED_ID='sha256:af9d6a1209f9aa6316c47cf0c922556c058fc3fd513cf8d0d156eca26756b294'
LOCAL_TAG='sessionport-validation-base-local:af9d6a1209f9aa63'
DERIVED_TAG='sessionport-project-validation:review-20261020-r2'
ENV_FILE='<SERVER_ONLY_ENV_FILE_OUTSIDE_BUNDLE>'
CONTAINER_NAME='sessionport-project-validation-20261020'
```

1. Hash, extract without overwrite, verify both manifests:

   ```sh
   test "$(sha256sum "$ZIP_INPUT" | awk '{print $1}')" = \
     "1cefbb09756fe2af3722fc480a872377cc093882e127652c2067e7adb1ab9f53"
   test ! -e "$EXTRACT_DIR"
   mkdir -m 700 "$EXTRACT_DIR"
   unzip -q -n "$ZIP_INPUT" -d "$EXTRACT_DIR"
   cd "$EXTRACT_DIR/project-validation-20261020-r2"
   sha256sum -c SHA256SUMS
   ( cd payload && sha256sum -c SHA256SUMS )
   ```

2. Exact base image, local only; require `linux/amd64`:

   ```sh
   test "$(docker image inspect --format '{{.Id}}' "$EXPECTED_ID")" = "$EXPECTED_ID"
   docker image inspect --format '{{.Os}}/{{.Architecture}}' "$EXPECTED_ID"
   ```

3. Builder gate: `docker buildx inspect default` must show `Driver: docker` and
   a local endpoint (default/local Unix socket), not remote/container. If absent
   or mismatched, STOP. Do not create, switch, or bootstrap a builder. Complete
   this read-only gate before creating the local tag.

4. Enforce unused tags. If either exists, STOP — never overwrite:

   ```sh
   if docker image inspect "$LOCAL_TAG" >/dev/null 2>&1; then
     printf 'preflight_failed=base-local-tag-exists\n'; exit 1
   fi
   if docker image inspect "$DERIVED_TAG" >/dev/null 2>&1; then
     printf 'preflight_failed=derived-tag-exists\n'; exit 1
   fi
   docker image tag "$EXPECTED_ID" "$LOCAL_TAG"
   test "$(docker image inspect --format '{{.Id}}' "$LOCAL_TAG")" = "$EXPECTED_ID"
   ```

5. Require `session_port_internal`, running `session-port-postgres`, and the
   fixed owned name unused (including stopped containers). `pg_isready` is
   liveness only; the runner guard is authoritative:

   ```sh
   docker network inspect --format '{{.Name}} {{.Driver}}' session_port_internal
   docker container inspect --format \
     '{{.Name}} running={{.State.Running}} image={{.Config.Image}}' \
     session-port-postgres
   docker exec session-port-postgres pg_isready -h 127.0.0.1 -p 5432 \
     -U sessionport_validation_migrator -d session_port_validation
   if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
     printf 'preflight_failed=container-name-exists\n'; exit 1
   fi
   ```

6. Env file: server-only, outside bundle/build context, operator-readable, only
   `SESSIONPORT_MIGRATOR_DATABASE_URL`, target host `session-port-postgres`,
   port 5432 or omitted, role `sessionport_validation_migrator`, DB
   `session_port_validation`. Do not print/source/dump or put its value in argv.
   Missing or different: STOP; do not request a new secret.

## 6. Build — default builder, local tag

From the extracted `project-validation-20261020-r2/` directory:

```sh
IID_FILE='<NEW_EMPTY_IID_FILE_PATH>'
docker buildx build \
  --builder default \
  --load \
  --pull=false \
  --network=none \
  --iidfile "$IID_FILE" \
  -f Dockerfile.runner \
  -t "$DERIVED_TAG" \
  .
```

`--network=none` covers build `RUN` steps only, not `FROM` resolution. The local
tag must resolve from the default docker driver's local store. No `--bootstrap`,
login, pull, or substitution.

Post-build, fail closed unless:

```sh
test "$(docker image inspect --format '{{.Id}}' "$LOCAL_TAG")" = "$EXPECTED_ID"
test "$(docker image inspect --format '{{.Id}}' "$EXPECTED_ID")" = "$EXPECTED_ID"
RAW_IID="$(cat "$IID_FILE")"
case "$RAW_IID" in sha256:*) IMAGE_ID="$RAW_IID" ;; *) IMAGE_ID="sha256:$RAW_IID" ;; esac
test "$(docker image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID"
docker image inspect --format \
  '{{.Id}} user={{.Config.User}} workdir={{.Config.WorkingDir}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}' \
  "$IMAGE_ID"
```

Required shape: `user=node`, `workdir=/app/cloud/api`, command
`["node","--import","tsx","scripts/validate-projects.ts"]`; entrypoint empty or
reviewed base passthrough. Use only `"$IMAGE_ID"` for the run. Do not mutate or
retag the base image.

## 7. One bounded run — same reviewed logic

Run only after the new GO. The default no-flag CMD remains nonmutating; the
authorized invocation supplies the explicit command. The fixed container name
must be absent; never delete/reuse. The user already approved the single DB run,
but the first DB run never occurred, so this corrected build needs a new review
GO; it is not an automatic retry and requests no new secret.

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

No ports, mounts, Docker socket, privileged mode, extra env, or unverified
read-only/tmpfs. Never broad-kill or auto-clean the DB. No `db:deploy`, 0003,
main DB, or physical retry.

## 8. Success and failure

Success requires all fixed lines, not exit code alone:

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

All eight bounded case groups (quota contributes two checks) and
`cleanupVerified=true` are required. Any guard/seed/case/deadline/manifest/
build/preflight failure stops. Fixtures may remain; `cleanupVerified` is false;
no retry and no DB cleanup. Report fixed runner lines, image ID, exit code, and
timeout/container state only; no SQL, exceptions, URLs, env contents,
credentials, or row data.

## 9. Review delta

Confirm archive hash/allowlist/source hashes, only-FROM change, unused local tag
and exact ID, default local driver, env/network/DB/container gates, and the new
owner GO.
