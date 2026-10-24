# Protocol PostgreSQL cleanup handoff — 2026-10-21

Status: **PREPARED ONLY — REVIEW-READY, NOT GO.** No Docker, DB, network,
install, Git, SSH, credential, `.env`, cleanup, migration, or protocol run was
performed while preparing this. Ora8 material review is required before any
server action. Return this artifact and handoff for review; do not execute until
the reviewer returns GO.

## 1. Approval record

The owner approved, on 2026-10-21, cleanup of the exact eight retained fixture
users below plus exactly three inspected unlinked pending UUIDs. The approval is
for **one cleanup attempt**, followed conditionally by **one corrected protocol
attempt** only after cleanup succeeds and the post-delete zero-owned check is
verified. Validation database only. The main database, migration state, source,
config, and unrelated pending rows are out of scope. The owner also approved the
three UUIDs directly; they are **not** derived from the marker at runtime.

The preceding read-only inspection passed (`status=inspected`) with
`crossBoundary=clear` and `cleanupPerformed=false`, reporting exact retained
counts: users `8`, quotas `8`, projects `4`, revisions `6`, uploads `6`, project
heads `3`, devices `5`, grants `5`, access tokens `1`, refresh tokens `1`, owned
pending authorizations `2`, unlinked candidates `3` with statuses
`pending,pending,pending`. Those counts are the frozen cleanup snapshot; any
drift is a stop. These inspection counts are owner/parent-reported evidence, not
independently observed by this local preparation.

### Exact eight retained users (unchanged)

```text
sessionport-protocol-pg-test-project-44a2382f-8013-48a1-b25a-4bdd65842157
sessionport-protocol-pg-test-revision-99c335c9-7d46-4aa7-be9a-beb53903a2c4
sessionport-protocol-pg-test-pagination-4cd48042-d590-4f9d-9f6e-2c6d35269f8c
sessionport-protocol-pg-test-quota-77dae587-d800-41d3-87fa-8bdcbacbacbb
sessionport-protocol-pg-test-exchange-aa4613a5-432c-4f6f-b8ef-2daa494f4886
sessionport-protocol-pg-test-rotation-2f3136c9-3593-4e15-a8b5-9874e7db8256
sessionport-protocol-pg-test-approval-fb9bd558-732a-406c-955a-b2a80ce618b2
sessionport-protocol-pg-test-other-ee162863-e2a7-40f3-b0a5-1b7d3e3111c7
```

### Exact three owner-approved pending UUIDs

```text
82501de5-33d0-4c94-81c8-50b27d653e0d
8b304e96-fcc3-465d-b827-cb305a2b0540
c772b18c-3a4a-44df-96ad-1feff04a66b8
```

The cleanup query selects these three only by UUID and reads only `id`,
`status`, `approvedUserID`. `humanCodeKeyID='validation-key'` is not queried and
is not ownership proof. No fingerprint, digest, scope, audience, resource, token,
or hash is projected or validated. No unrelated pending row metadata is emitted.

## 2. Artifact

| Item | Value |
| --- | --- |
| Archive | `.package-verify-work/protocol-cleanup-20261021/sessionport-protocol-cleanup-20261021.zip` |
| Bytes | `24,472` |
| SHA-256 | `19af269cd62b4100c7237f8a47eb20c2731d56da22b6ba7ba829aa8699211233` |
| Root | `protocol-cleanup-20261021/` |
| Entries | exactly 6 regular files; no symlinks or directory entries |
| Expected base ID | `sha256:d2570e4e6382465b7dba1bf3850a451b6a5145b76bf688b4cd0250283e7b3bc0` |
| Local base tag | `sessionport-protocol-cleanup-base-local:d2570e4e6382465b` |
| Derived tag | `sessionport-protocol-cleanup:review-20261021` |
| Derived ID | from `--iidfile`; not yet built |

Payload and evidence:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `payload/cloud/api/scripts/cleanup-retained-protocol-fixtures.ts` | `63,585` | `df65d25e0294dcfc22172dc0cc4886e7746a5221606b937605de5735e1dbe1c2` |
| `checks/check-cleanup-guards.ts` (not copied into image) | `31,671` | `66fe792cad0808cc49d4eb9150969065180c992ad2d610fffabc7f583412c8f0` |
| `cloud/api/test-support/protocol-postgres-validation.ts` (verified, not copied) | `50,417` | `7acfc4cf82bdbc0de26bb148d7ff738a5279d89a887527aa30b771021c86fa15` |

The previous inspection archive
`6c5eb89639cce3fa224b44bce17cf26ab6645fe742e2defea08d72049033d18b` remains
frozen and byte-identical. The corrected driver is unchanged and durable; the
original bug test was not weakened. The Dockerfile checks the base driver hash
and does not copy the driver. Only the cleanup CLI and its manifest are copied.

The default image CMD remains the non-mutating
`node --import tsx scripts/validate-protocol.ts`; the cleanup flag is never a
default. Migration `202610200003_protocol_native` is **already applied** and must
never be reapplied by this delivery. The cleanup CLI does not run migrations.

## 3. Cleanup behavior in this artifact

- `--cleanup-retained-fixtures-only` is the only accepted mode. No flag exits
  `2` before environment access. `--inspect-retained-fixtures-only`, extra
  flags, and malformed deadlines exit `2` without environment access.
- The target URL is read only after flag validation, using the existing private
  `SESSIONPORT_MIGRATOR_DATABASE_URL` reader and strict host
  `session-port-postgres`, role `sessionport_validation_migrator`, database
  `session_port_validation`, port `5432` (or omitted). A wrong URL exits before
  the Prisma/client import or any DB connection.
- The whole cleanup is **one** `Serializable` transaction with no automatic
  serialization retry: transaction timeout `80,000 ms`, statement timeout
  `60,000 ms`, lock timeout `10,000 ms`, query timeout `65,000 ms`, max wait
  `5,000 ms`; the CLI deadline is `90,000 ms` and the Docker outer deadline is
  `120 s`.
- Before the first write, guards verify database identity, PostgreSQL 16, all
  three finished/non-rolled-back migration checksums against the local files,
  schema shape, exact eight users, exact counts, exact IDs, all candidate rows,
  and zero cross-boundary references. Any drift throws before a delete/update.
- Deletes and cycle-breaking updates use exact frozen row-ID lists derived from
  the eight users: heads by exact `(projectID, revisionID)` pairs, revisions and
  uploads by exact IDs with child-first ordering, refresh tokens by exact IDs
  after clearing only their `successorID`/`spentAt`, access tokens, devices,
  grants, pending rows, projects, quotas, and users by exact IDs. No
  `deleteMany({})`, no cascade cleanup, no custom reset, no all-model sweep.
- `User` deletion relies on the schema's `RESTRICT` guards for owned children;
  a missed reference hard-fails and rolls back the transaction. Post-delete
  checks require zero remaining exact owned rows, zero exact pending rows, and
  an unchanged all-zero global foreign-reference baseline. Any failure rolls
  back the entire transaction and emits only a fixed status code.
- Output is fixed metadata only. The CLI never prints a URL, env value, row,
  credential, or raw exception. Redirect output to a server-only evidence file;
  do not paste its contents into chat.

Required exact cleanup output (any extra/missing/different line is STOP):

```text
status=passed
mode=--cleanup-retained-fixtures-only
postgresqlMajor=16
migrations=3
migrationChecksums=matched
schema=matched
deletedUsers=8
deletedQuotas=8
deletedProjects=4
deletedRevisions=6
deletedUploads=6
deletedProjectHeads=3
deletedDevices=5
deletedGrants=5
deletedAccessTokens=1
deletedRefreshTokens=1
deletedOwnedPendingAuthorizations=2
deletedApprovedUnlinkedPendingAuthorizations=3
deletedPendingAuthorizations=5
remainingOwnedRows=0
foreignReferences=clear
cleanupVerified=true
```

The five pending deletions are the two owned pending children plus the three
approved unlinked rows. A referenced-head cycle is not expected at these frozen
counts; if clearing a head/revision cycle changes counts, STOP and do not
continue. There is no partial cleanup and no automatic retry.

## 4. Server build gates — any failure is STOP

Use placeholders; never put a URL, password, token, or secret in argv/chat. The
private env file remains server-only and is never printed, sourced, dumped, or
copied into the bundle or build context.

```sh
ZIP_INPUT='<PATH_TO_CLEANUP_ZIP>'
EXTRACT_DIR='<NEW_EMPTY_OWNER_SCOPED_DIR>'
EXPECTED_ZIP_SHA256='19af269cd62b4100c7237f8a47eb20c2731d56da22b6ba7ba829aa8699211233'
EXPECTED_BYTES='24472'
EXPECTED_ID='sha256:d2570e4e6382465b7dba1bf3850a451b6a5145b76bf688b4cd0250283e7b3bc0'
LOCAL_TAG='sessionport-protocol-cleanup-base-local:d2570e4e6382465b'
DERIVED_TAG='sessionport-protocol-cleanup:review-20261021'
ENV_FILE='<SERVER_ONLY_ENV_FILE_OUTSIDE_BUNDLE>'
IID_FILE='<NEW_EMPTY_IID_FILE_PATH>'
CLEANUP_NAME='sessionport-protocol-cleanup-20261021'
PROTOCOL_NAME='sessionport-protocol-cleanup-rerun-20261021'
CLEANUP_LOG='<SERVER_ONLY_CLEANUP_LOG>'
PROTOCOL_LOG='<SERVER_ONLY_PROTOCOL_LOG>'
```

1. Verify exact archive bytes/checksum, extract without overwrite into a new
   empty directory, and verify both manifests:

   ```sh
   test "$(wc -c < "$ZIP_INPUT")" = "$EXPECTED_BYTES"
   test "$(sha256sum "$ZIP_INPUT" | awk '{print $1}')" = "$EXPECTED_ZIP_SHA256"
   test ! -e "$EXTRACT_DIR"
   mkdir -m 700 "$EXTRACT_DIR"
   unzip -q -n "$ZIP_INPUT" -d "$EXTRACT_DIR"
   cd "$EXTRACT_DIR/protocol-cleanup-20261021"
   sha256sum -c SHA256SUMS
   ( cd payload && sha256sum -c SHA256SUMS )
   test "$(find . -type f | wc -l)" = "6"
   ```

2. Verify the exact base image in the local store and its platform:

   ```sh
   test "$(docker image inspect --format '{{.Id}}' "$EXPECTED_ID")" = "$EXPECTED_ID"
   test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$EXPECTED_ID")" = 'linux/amd64'
   ```

   The base is not pulled. A bare-ID `FROM` is forbidden; the Dockerfile uses
   the new local tag.

3. Builder gate before creating the base tag: `docker buildx inspect default`
   must show `Driver: docker` and a local endpoint. If absent/mismatched, STOP.
   Do not create, switch, or bootstrap a builder.

4. Both fixed tags must be unused, including stopped images; both container
   names must be absent, including stopped containers. Never overwrite or reuse:

   ```sh
   if docker image inspect "$LOCAL_TAG" >/dev/null 2>&1; then
     printf 'preflight_failed=base-local-tag-exists\n'; exit 1
   fi
   if docker image inspect "$DERIVED_TAG" >/dev/null 2>&1; then
     printf 'preflight_failed=derived-tag-exists\n'; exit 1
   fi
   if docker container inspect "$CLEANUP_NAME" >/dev/null 2>&1; then
     printf 'preflight_failed=cleanup-container-exists\n'; exit 1
   fi
   if docker container inspect "$PROTOCOL_NAME" >/dev/null 2>&1; then
     printf 'preflight_failed=protocol-container-exists\n'; exit 1
   fi
   ```

5. Require the fixed `session_port_internal` network and the existing
   `session-port-postgres` container healthy. `pg_isready` is liveness only; the
   in-image identity guard is authoritative.

6. Env file: the existing private validation-migrator env file, server-only,
   outside the bundle and build context, owner-readable. It contains only
   `SESSIONPORT_MIGRATOR_DATABASE_URL` for host `session-port-postgres`, role
   `sessionport_validation_migrator`, database `session_port_validation`, port
   5432 or omitted. Do not print, source, dump, or pass its value in argv.
   Missing or different: STOP; do not request a new secret. If a PATH capture is
   required, write only the existing private shell `PATH` to a server-only file
   outside the bundle; do not export or modify `PATH`, and leave the existing
   remote prior context untouched.

7. Create the base tag only after gates 1–6 pass, then verify it:

   ```sh
   docker image tag "$EXPECTED_ID" "$LOCAL_TAG"
   test "$(docker image inspect --format '{{.Id}}' "$LOCAL_TAG")" = "$EXPECTED_ID"
   ```

8. Build offline with the default builder, no pull, no build args, no install,
   no generation, and no migration:

   ```sh
   docker buildx build \
     --builder default --load --pull=false --network=none \
     --iidfile "$IID_FILE" -f Dockerfile.cleanup -t "$DERIVED_TAG" .
   ```

   `--network=none` covers `RUN` only, not `FROM` resolution. No registry
   fallback, login, pull, retag-by-name, or image substitution. The context is
   the extracted directory; `.dockerignore` allows only `Dockerfile.cleanup`,
   `payload/SHA256SUMS`, and the one cleanup CLI.

9. Post-build fail closed unless the base ID is unchanged and the derived image
   has the required shape:

   ```sh
   test "$(docker image inspect --format '{{.Id}}' "$LOCAL_TAG")" = "$EXPECTED_ID"
   test "$(docker image inspect --format '{{.Id}}' "$EXPECTED_ID")" = "$EXPECTED_ID"
   RAW_IID="$(cat "$IID_FILE")"
   case "$RAW_IID" in sha256:*) IMAGE_ID="$RAW_IID" ;; *) IMAGE_ID="sha256:$RAW_IID" ;; esac
   test "$(docker image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID"
   docker image inspect --format \
     '{{.Id}} user={{.Config.User}} workdir={{.Config.WorkingDir}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}' \
     "$IMAGE_ID"
   test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE_ID")" = 'linux/amd64'
   ```

   Required: `linux/amd64`, `user=node`,
   `workdir=/app/cloud/api`, CMD
   `["node","--import","tsx","scripts/validate-protocol.ts"]`, and an empty
   entrypoint (or a reviewed base passthrough that still executes the requested
   node script; otherwise STOP). Use only `"$IMAGE_ID"` for later runs. Do not
   mutate or retag the base image.

## 5. Single cleanup attempt — only after build gates pass

No ports or mounts; the env file is not a bind mount. Stop only the exact
`$CLEANUP_NAME` container on timeout. Never kill or stop a foreign container.

```sh
set +e
timeout --signal=TERM --kill-after=5s 120s \
  docker run --name "$CLEANUP_NAME" --rm --user node \
    --cap-drop ALL --security-opt no-new-privileges \
    --network session_port_internal --env-file "$ENV_FILE" \
    "$IMAGE_ID" node --import tsx scripts/cleanup-retained-protocol-fixtures.ts \
      --cleanup-retained-fixtures-only --max-run-ms=90000 \
  > "$CLEANUP_LOG" 2>&1
CLEANUP_RC=$?
set -e
if [ "$CLEANUP_RC" -ne 0 ]; then
  if docker container inspect "$CLEANUP_NAME" >/dev/null 2>&1; then
    docker stop --time 10 "$CLEANUP_NAME" >/dev/null 2>&1 || true
  fi
  printf 'cleanup_failed=do-not-run-protocol\n'
  exit 1
fi
```

Compare `$CLEANUP_LOG` against the exact required block in section 3. Any extra
line, missing line, different count, status, or `cleanupVerified` value is STOP.
Do not run the protocol after a failed cleanup; do not retry cleanup; do not
auto-clean or reset anything. The transaction has already rolled back on a
failure; fixtures remain as the evidence state.

## 6. One conditional corrected protocol attempt — only after cleanup success

Run once, after the exact cleanup output is verified and
`remainingOwnedRows=0`/`cleanupVerified=true`. Fresh unused container; no ports
or mounts; outer `120 s`; inner `90 s`. Migration `0003` is already applied and
must never be reapplied.

```sh
set +e
timeout --signal=TERM --kill-after=5s 120s \
  docker run --name "$PROTOCOL_NAME" --rm --user node \
    --cap-drop ALL --security-opt no-new-privileges \
    --network session_port_internal --env-file "$ENV_FILE" \
    "$IMAGE_ID" node --import tsx scripts/validate-protocol.ts \
      --run-protocol-validation-only --max-run-ms=90000 \
  > "$PROTOCOL_LOG" 2>&1
PROTOCOL_RC=$?
set -e
if [ "$PROTOCOL_RC" -ne 0 ]; then
  if docker container inspect "$PROTOCOL_NAME" >/dev/null 2>&1; then
    docker stop --time 10 "$PROTOCOL_NAME" >/dev/null 2>&1 || true
  fi
fi
```

Required lines: `status=passed`, `testPassed=true`, `cleanupVerified=true`,
`postgresqlMajor=16`, `migrations=3`, `fixtureUsers=3`, `checks=15/15`,
`failedCheck=none`, exit `0`. Any failure is final: retain the new fixtures, do
not clean up again, do not retry, and do not auto-rerun. Preserve the corrected
driver and its durable assertions unchanged.

## 7. Evidence boundary

This delivery supports preparation for cleanup and one conditional corrected
protocol attempt on PostgreSQL 16 / `session_port_validation` with the exact
base/derived image, already-applied three-migration schema, and frozen fixture
scope. It cannot claim cleanup success, protocol runtime acceptance, OAuth
browser flow, vault/keyring, TUI, M4, native-host, production, or cross-platform
compatibility until the server run is recorded. Derived image ID and live
cleanup/protocol results remain unknown until Ora8 returns GO and the gates
above execute. No confirmed GO is implied by this document.

