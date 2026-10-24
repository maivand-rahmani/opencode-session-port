# Protocol cap-followup cleanup handoff - 2026-10-21

Status: **PREPARED ONLY - REVIEW-READY, NOT GO.** No Docker, DB, network,
install, Git, SSH, credential, `.env`, cleanup, driver, or protocol run was
performed while preparing this. Ora15 material review is required before any
server action. The owner has already approved the exact scope below; do not ask
a new scope question. This is the technical gate before execution.

The owner approved, after the actual read-only inspection:
- cleanup of the latest eight retained fixture users and exactly one unlinked
  pending UUID, followed conditionally by one corrected protocol attempt, only
  after cleanup passes;
- validation database `session_port_validation` only; never the main database;
- no migration reapply, no role creation, no OAuth start, no API start.

The historical protocol result remains `13/15`, failed at
`pending-approval-per-user-cap-isolation`. This handoff does not claim a live
protocol pass, cleanup success, or completion of M1/M3.

## 1. Artifact

| Item | Value |
| --- | --- |
| Archive | `.package-verify-work/protocol-cap-cleanup-20261021/sessionport-protocol-cap-cleanup-20261021.zip` |
| Bytes | `25,396` |
| SHA-256 | `9b69f1be98bf6599ae1f55523e1d12fdec08e34aac04a475fa18e3b36d274ded` |
| Root | `protocol-cap-cleanup-20261021/` |
| Entries | exactly `6` regular files; no symlinks or directory entries |
| Expected base ID | `sha256:88b1cb8163ca50e5ea2af1b398fd0f6efd0d1920cd6024877758645ac44c1279` |
| Local base tag | `sessionport-protocol-cap-cleanup-base-local:88b1cb8163ca` |
| Derived tag | `sessionport-protocol-cap-cleanup:review-20261021` |
| Derived ID | from `--iidfile`; not yet built |

Payload:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `payload/cloud/api/scripts/cleanup-retained-cap-fixtures.ts` | `66,252` | `36759cf874526b2bcc19b21962a7b6b811ca16b874cb5b7db78f99739fd00cdf` |
| `checks/check-cleanup-guards.ts` (not copied into image) | `33,816` | `8c781c7a70b51d93d28a01b60f2b5669d781461d544a302e855b1d103600f3f8` |

The base image `88b1cb...` contains the committed source fix
`44dded0f03c50360e117a3c4e403fccc4df9b4aa3d3ffd5536db1efb5026e438` and the
corrected driver
`7acfc4cf82bdbc0de26bb148d7ff738a5279d89a887527aa30b771021c86fa15`.
The Dockerfile checks both hashes inside the base; neither is copied or changed.
Only the cleanup CLI and its payload checksum are copied. No schema, generated
client, dependency, source, test, or migration is changed.

The prior reviewed cleanup archive remains byte-identical at
`19af269cd62b4100c7237f8a47eb20c2731d56da22b6ba7ba829aa8699211233` and is not
modified by this delivery.

## 2. Exact scope and frozen state

Eight retained users from the actual inspection; exact IDs only, never prefix
or wildcard:

```text
sessionport-protocol-pg-test-project-76d3c435-4e65-45a9-a435-ab9faa13573c
sessionport-protocol-pg-test-revision-44add360-d538-4086-913a-cb5540ac27a7
sessionport-protocol-pg-test-pagination-bb9bd6f8-c9ab-4a3d-a697-e02e4d6921c0
sessionport-protocol-pg-test-quota-81567300-f265-474c-ae82-953d5981e3e6
sessionport-protocol-pg-test-exchange-f172c716-dc47-4d57-8861-b16d00999799
sessionport-protocol-pg-test-rotation-3fcdadbc-9737-41b0-b2d7-9c4aa1cad62e
sessionport-protocol-pg-test-approval-e9272eb4-8244-48b4-94d7-274f61169f6a
sessionport-protocol-pg-test-other-20317af1-7a78-4508-a46b-cb8b371f3ab1
```

One owner-approved unlinked pending row:

```text
15ee131e-3f4c-49b7-a6e6-37da8c7bc65d
```

It is selected by this immutable UUID, not by `humanCodeKeyID`, marker, prefix,
or status discovery. Its row must be `status=pending`, `approvedUserID=null`.

Frozen actual totals:

```text
users=8 quotas=8 projects=4 revisions=6 uploads=8 projectHeads=3
devices=6 grants=6 accessTokens=3 refreshTokens=3
ownedPendingAuthorizations=4 approvedUnlinkedPending=1 pendingAuthorizations=5
```

Expected state details from the completed 13 cases:
- project roles: project/revision/pagination/quota one each;
- revision rows: revision 3, pagination 3; heads revision 2, pagination 1;
- grants/devices: revision 2, pagination 1, quota 1, exchange 1, rotation 1;
- rotation grant is `revoked`; exchange grant/device is active;
- access/refresh: rotation 2+2 (old spent successor + new unspent), exchange
  1+1; exactly one spent refresh and two unspent;
- uploads: revision 4 (one expired sibling, one replacement), pagination 3,
  quota 1 `uploading` with no final key; quota reserved bytes `600`;
- pending: exchange consumed+approved, approval approved, other approved,
  plus the one pending/null-owner candidate above.

Any actual drift is STOP. The cleanup does not use old-stage assumptions,
ranges, active-only token filters, or an unbounded predicate. It includes all
owned rows regardless of token expiry.

## 3. Cleanup behavior and delete order

The only accepted mode is `--cleanup-retained-fixtures-only`. No flag exits `2`
before environment access; any other flag or malformed deadline exits `2`
before environment access. The target is read only after flag validation
through the existing strict validation reader (`SESSIONPORT_MIGRATOR_DATABASE_URL`):
host `session-port-postgres`, role `sessionport_validation_migrator`, database
`session_port_validation`, port `5432` or omitted. A wrong URL exits before the
Prisma/client import or connection.

One bounded `Serializable` transaction:
- transaction timeout `80,000 ms`, statement `60,000 ms`, lock `10,000 ms`,
  query `65,000 ms`, max wait `5,000 ms`;
- CLI deadline `90,000 ms`, outer Docker deadline `120 s`;
- one attempt, no serialization retry, no automatic fallback or repair.

Guards run before the first write: database identity/current role, PG16,
three finished/non-rolled-back migration checksums, schema shape, exact eight
users, quotas, projects, grants/devices, revisions/uploads/heads, access/refresh,
owned pending roles/statuses, exact candidate UUID, and zero cross-boundary
references for all FK/auth/cascade/restrict families. All reads are scoped to
the exact eight user IDs/FK-derived IDs or the one candidate UUID. No auth
fingerprint, digest, ciphertext, scope, audience, resource, token, or label is
read or output.

Reviewed delete order, exact IDs only:
1. `ProjectHead` rows first;
2. child `Revision` rows (parentRevisionID not null);
3. child `Upload` rows (parentRevisionID not null);
4. root `Revision` rows;
5. root `Upload` rows (after revision storage-FK release);
6. clear `spentAt`/`successorID` on exactly the three owned `NativeRefreshToken`
   rows, then delete those exact rows;
7. exact access tokens, devices, grants, pending rows (four owned + one
   candidate), projects, quotas, users.

`Upload.revisionID` is a scalar and is not used as an FK/cycle. The depth-1
parent guard remains for `Upload.parentRevisionID` and
`Revision.storageObjectKey`; no new relationship cycle is invented.
`Device` precedes `NativeDeviceGrant`; pending precedes `User`. Post-delete
zero-owned-scope, zero pending scope, and unchanged zero foreign baseline are
verified inside the same transaction; any failure rolls back before commit.

Fixed cleanup output must match exactly:

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
deletedUploads=8
deletedProjectHeads=3
deletedDevices=6
deletedGrants=6
deletedAccessTokens=3
deletedRefreshTokens=3
deletedOwnedPendingAuthorizations=4
deletedApprovedUnlinkedPendingAuthorizations=1
deletedPendingAuthorizations=5
remainingOwnedRows=0
foreignReferences=clear
cleanupVerified=true
```

No extra/missing/different line; no manual counter substitution when actual
delete counts differ. Any failure rolls back; retain fixtures; do not retry.

## 4. Build gates - any failure is STOP

Use placeholders; never put a URL, password, token, or secret in argv/chat. The
private env file remains server-only and is never printed, sourced, dumped, or
copied into the bundle/context/image.

```sh
ZIP_INPUT='<PATH_TO_CAP_CLEANUP_ZIP>'
EXTRACT_DIR='<NEW_EMPTY_OWNER_SCOPED_DIR>'
EXPECTED_ZIP_SHA256='9b69f1be98bf6599ae1f55523e1d12fdec08e34aac04a475fa18e3b36d274ded'
EXPECTED_BYTES='25396'
EXPECTED_ID='sha256:88b1cb8163ca50e5ea2af1b398fd0f6efd0d1920cd6024877758645ac44c1279'
LOCAL_TAG='sessionport-protocol-cap-cleanup-base-local:88b1cb8163ca'
DERIVED_TAG='sessionport-protocol-cap-cleanup:review-20261021'
ENV_FILE='<SERVER_ONLY_MIGRATOR_ENV_FILE>'
IID_FILE='<NEW_EMPTY_IID_FILE_PATH>'
CLEANUP_NAME='sessionport-protocol-cap-cleanup-20261021'
PROTOCOL_NAME='sessionport-protocol-cap-rerun-20261021'
CLEANUP_LOG='<SERVER_ONLY_CLEANUP_LOG>'
PROTOCOL_LOG='<SERVER_ONLY_PROTOCOL_LOG>'
```

1. Verify exact archive bytes/checksum, extract without overwrite into a new
   empty directory, and verify root/payload manifests; exactly 6 files:

   ```sh
   test "$(wc -c < "$ZIP_INPUT")" = "$EXPECTED_BYTES"
   test "$(sha256sum "$ZIP_INPUT" | awk '{print $1}')" = "$EXPECTED_ZIP_SHA256"
   test ! -e "$EXTRACT_DIR"
   mkdir -m 700 "$EXTRACT_DIR"
   unzip -q -n "$ZIP_INPUT" -d "$EXTRACT_DIR"
   cd "$EXTRACT_DIR/protocol-cap-cleanup-20261021"
   sha256sum -c SHA256SUMS
   ( cd payload && sha256sum -c SHA256SUMS )
   test "$(find . -type f | wc -l)" = "6"
   ```

2. Verify exact base image in local store and platform:

   ```sh
   test "$(docker image inspect --format '{{.Id}}' "$EXPECTED_ID")" = "$EXPECTED_ID"
   test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$EXPECTED_ID")" = 'linux/amd64'
   ```

   No pull; no bare-ID `FROM`; no mutable-tag substitution. The Dockerfile
   checks source `44dd...` and driver `7acf...` inside the base and runs only
   the existing `scripts/check-tool-versions.mjs`; no ad-hoc resolver/checker.

3. Default builder gate: `docker buildx inspect default` must show
   `Driver: docker` and a local endpoint. Do not create/switch/bootstrap.

4. Both fixed tags and both container names must be unused, including stopped:

   ```sh
   if docker image inspect "$LOCAL_TAG" >/dev/null 2>&1; then printf 'preflight_failed=base-local-tag-exists\n'; exit 1; fi
   if docker image inspect "$DERIVED_TAG" >/dev/null 2>&1; then printf 'preflight_failed=derived-tag-exists\n'; exit 1; fi
   if docker container inspect "$CLEANUP_NAME" >/dev/null 2>&1; then printf 'preflight_failed=cleanup-container-exists\n'; exit 1; fi
   if docker container inspect "$PROTOCOL_NAME" >/dev/null 2>&1; then printf 'preflight_failed=protocol-container-exists\n'; exit 1; fi
   ```

5. Require existing `session_port_internal` network and healthy
   `session-port-postgres` container. Liveness only; in-image identity guard is
   authoritative.

6. Env file: existing private validation-migrator path
   `/root/server/session_port_validation/.validation-deploy-20261020.env`,
   server-only, mode `600`, owner root, outside bundle/context. Verify key NAME
   `SESSIONPORT_MIGRATOR_DATABASE_URL` only; never source, print, dump, or pass
   the value. Missing/different: STOP; do not request/create a new secret. Do
   not use the user OAuth secret file.

7. Create local base tag only after gates 1-6, then verify:

   ```sh
   docker image tag "$EXPECTED_ID" "$LOCAL_TAG"
   test "$(docker image inspect --format '{{.Id}}' "$LOCAL_TAG")" = "$EXPECTED_ID"
   ```

8. One offline build attempt only:

   ```sh
   docker buildx build \
     --builder default --load --pull=false --network=none \
     --iidfile "$IID_FILE" -f Dockerfile.cleanup -t "$DERIVED_TAG" .
   ```

   No pull/install/generation/migration/retry. Context is the extracted
   directory; `.dockerignore` allows only `Dockerfile.cleanup`,
   `payload/SHA256SUMS`, and the one cleanup CLI.

9. Post-build fail closed unless base ID unchanged and shape is correct:

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

   Required: linux/amd64, user `node`, workdir `/app/cloud/api`, CMD
   `["node","--import","tsx","scripts/validate-protocol.ts"]`, empty entrypoint
   or reviewed base passthrough. Do not mutate/retag base.

## 5. One cleanup attempt, then one conditional protocol attempt

Only after Ora15 Technical GO and all build gates pass. No ports or mounts; env
file is not a bind mount; fresh container names; stop only the exact owned
container on timeout.

```sh
set +e
timeout --signal=TERM --kill-after=5s 120s \
  docker run --name "$CLEANUP_NAME" --rm --user node \
    --cap-drop ALL --security-opt no-new-privileges \
    --network session_port_internal --env-file "$ENV_FILE" \
    "$IMAGE_ID" node --import tsx scripts/cleanup-retained-cap-fixtures.ts \
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

Compare the fixed block in section 3 exactly. If it does not pass, STOP; do not
run the protocol, do not retry cleanup, do not clean/reset anything.

Only after exact cleanup PASS (`remainingOwnedRows=0`, `cleanupVerified=true`),
run one corrected protocol attempt with the fixed source/driver already in the
image. Migration `0003` is applied and must not be reapplied.

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

Required protocol output if it passes:

```text
status=passed
testPassed=true
cleanupVerified=true
postgresqlMajor=16
migrations=3
fixtureUsers=8
checks=15/15
failedCheck=none
```

Driver acceptance remains only `capacity-reached` or `serialization-failure`;
`unavailable` is not accepted and must not be broadened. On any protocol failure,
retain the NEW fixture IDs and return the result; do not run another cleanup,
retry, fallback, schema change, or auto-repair. This handoff contains one
cleanup attempt and one conditional protocol attempt only.

## 6. Evidence boundary

This is preparation for a conditional cleanup and protocol attempt. It cannot
claim cleanup success, 15/15, live classifier acceptance, M1/M3 completion, API
startup, OAuth/browser flow, vault/keyring, TUI, native-host, production, or
cross-platform compatibility until the server records the exact outputs.
The original `13/15` failure remains unchanged. No confirmed GO is implied by
this document.
