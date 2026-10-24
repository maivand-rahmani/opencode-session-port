# Protocol cap-followup read-only inspection handoff - 2026-10-21

Status: **PREPARED ONLY - REVIEW-READY, NOT GO.** No Docker, DB, network,
install, Git, SSH, credential, `.env`, cleanup, driver, or protocol run was
performed while preparing this. Validation-owner review plus bounded artifact
review is required before any external/server action. Return this artifact and
handoff for review; do not execute until the reviewer returns GO.

This delivery is **inspection only**. It does not clean up fixtures and does not
rerun the protocol driver or assert a live pass. The original corrected-protocol
result remains `13/15`, failed at
`pending-approval-per-user-cap-isolation`, with the eight fixture users below
retained.

## 1. Historical result and evidence boundary

Observed before this preparation:

```text
status=failed
testPassed=false
cleanupVerified=false
postgresqlMajor=16
migrations=3
fixtureUsers=8
checks=13/15
failedCheck=pending-approval-per-user-cap-isolation
```

The protocol command was not retried, did not clean up, and made no schema or
source change. The driver acceptance criteria remain **only**
`capacity-reached` or `serialization-failure`; `unavailable` is not accepted and
must not be broadened. No additional error instrumentation or rerun is part of
this handoff.

The committed source classifier fix `d534ba8` is included in this image, but it
has **not** been exercised by a live PostgreSQL protocol run in this delivery.
The source was parent-reviewed with full API `395/395` and typecheck PASS; those
are source-level results, not runtime PostgreSQL acceptance. No 15/15 or live
pass is claimed.

## 2. Artifact

| Item | Value |
| --- | --- |
| Archive | `.package-verify-work/protocol-cap-followup-20261021/sessionport-protocol-cap-followup-20261021.zip` |
| Bytes | `27,297` |
| SHA-256 | `b52dcfc0afb61ed58f12fcb30e6f979e06cd75caf8128e6db80d6a4e959cc52b` |
| Root | `protocol-cap-followup-20261021/` |
| Entries | exactly `8` regular files; no symlinks or directory entries |
| Expected base ID | `sha256:4a3872cbe680268e685292c381dd2df74398b4b989bd1cb3c03137c2d2904ce0` |
| Local base tag | `sessionport-protocol-cap-followup-base-local:4a3872cbe680` |
| Derived tag | `sessionport-protocol-cap-followup:review-20261021` |
| Derived ID | from `--iidfile`; not yet built |

Payload:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `payload/cloud/api/src/native-auth/repository.ts` | `44,310` | `44dded0f03c50360e117a3c4e403fccc4df9b4aa3d3ffd5536db1efb5026e438` |
| `payload/cloud/api/scripts/inspect-retained-cap-fixtures.ts` | `35,785` | `6b404570ca6ef1b4321a3d3ae2ea770add4f6d329b87c4a4800b0f27b46d9141` |
| `payload/INSPECTION-MANIFEST.json` | `2,874` | `229adff6aa89735671db28c5f10b2b5f0713b8943e160fae0206458ec35b84c6` |
| `checks/check-inspection-guards.ts` (not copied into image) | `19,990` | `7442e32a25f8d4769496cef685cc3444fd4183093041f4e484728742b82e5fe3` |

The Dockerfile checks the corrected driver hash `7acfc4...` inside the base and
does not copy or modify it. It replaces only the committed native-auth source
file and adds the inspection CLI/manifest. No generated client, dependency,
schema, migration, test, or package metadata is copied or changed.

## 3. Exact retained scope

The inspection is scoped to exactly these eight synthetic users, never by
prefix, role query, or wildcard:

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

Derived expected counts from the reviewed seed plus the 13 completed cases:

```text
users=8
quotas=8
projects=4
revisions=6
uploads=8
projectHeads=3
devices=6
grants=6
accessTokens=3
refreshTokens=3
owned pending authorizations=4
unlinked marker candidates=1 (plausible 0..2)
```

These are anomaly-detection expectations, **not** a frozen cleanup scope and
not proof of the winner or thrown exception. The inspection prints the actual
counts. A different actual count within the bounded fixture scope yields
`status=inspected`, `scopeAnomaly=true`, and fixed anomaly codes. It does not
fail before output and does not widen any scope. The next cleanup must be
derived from the actual inspected rows and separately approved by the owner.

## 4. Inspection behavior

The only accepted mode is:

```text
--inspect-retained-cap-fixtures-only
```

No flag exits `2` before environment access. Any cleanup flag, extra flag,
unknown argument, or malformed deadline exits `2` before environment access.
There is no `.env` loading, URL argument, alternate URL key, retry, migration,
cleanup, write, or fallback target.

The target is read only after flag validation through the existing strict
validation-target reader (`SESSIONPORT_MIGRATOR_DATABASE_URL`): host
`session-port-postgres`, role `sessionport_validation_migrator`, database
`session_port_validation`, port `5432` or omitted, optional `schema=public` and
a known `sslmode`. A wrong URL exits before the Prisma/client import or any DB
connection.

The inspection is one **RepeatableRead** transaction with transaction timeout
`90,000 ms`, statement timeout `60,000 ms`, lock timeout `10,000 ms`, query
timeout `65,000 ms`, max wait `5,000 ms`; the CLI deadline is `90,000 ms` and the
Docker outer deadline is `120 s`. Every query is a SELECT or a read-only
`findMany`/`count` delegate. The delivered CLI contains no create/update/delete
delegate, `$executeRaw`, DDL, or mutating SQL.

It reads only non-secret metadata: user ID, quota owner ID, project/device/
grant/parent/successor keys, row status/state, the three migration checksums,
and counts. It never selects fingerprints, human-code digests, token material,
scopes, audience/resource, labels, emails, ciphertext hashes, or object keys.
Cross-boundary checks are counts plus scoped row consistency; no foreign auth
rows are returned. Unlinked marker rows are selected by
`humanCodeKeyID='validation-key'` and `approvedUserID IS NULL`, capped at six
with a hard stop above five. They are candidates only, never ownership proof.

The owned-pending read uses `take: 11` and stops with
`owned-pending-cap-exceeded` above `10`; exactly `10` is reported as the actual
count with `scopeAnomaly=true`. It never reports a truncated count as actual.

## 5. Build gates - any failure is STOP

Use placeholders; never put a URL, password, token, or secret in argv/chat. The
private env file remains server-only and is never printed, sourced, dumped, or
copied into the bundle, build context, or image.

Existing server metadata for the future run (do not print its value):

```text
/root/server/session_port_validation/.validation-deploy-20261020.env
```

That is the validation-migrator env file only. The user OAuth secret file is not
this file and must not be used, read, copied, or substituted.

```sh
ZIP_INPUT='<PATH_TO_INSPECTION_ZIP>'
EXTRACT_DIR='<NEW_EMPTY_OWNER_SCOPED_DIR>'
EXPECTED_ZIP_SHA256='b52dcfc0afb61ed58f12fcb30e6f979e06cd75caf8128e6db80d6a4e959cc52b'
EXPECTED_BYTES='27297'
EXPECTED_ID='sha256:4a3872cbe680268e685292c381dd2df74398b4b989bd1cb3c03137c2d2904ce0'
LOCAL_TAG='sessionport-protocol-cap-followup-base-local:4a3872cbe680'
DERIVED_TAG='sessionport-protocol-cap-followup:review-20261021'
ENV_FILE='<SERVER_ONLY_MIGRATOR_ENV_FILE>'
IID_FILE='<NEW_EMPTY_IID_FILE_PATH>'
INSPECT_NAME='sessionport-protocol-cap-inspect-20261021'
INSPECT_LOG='<SERVER_ONLY_INSPECTION_LOG>'
```

1. Verify exact archive bytes/checksum, extract without overwrite into a new
   empty directory, and verify both manifests:

   ```sh
   test "$(wc -c < "$ZIP_INPUT")" = "$EXPECTED_BYTES"
   test "$(sha256sum "$ZIP_INPUT" | awk '{print $1}')" = "$EXPECTED_ZIP_SHA256"
   test ! -e "$EXTRACT_DIR"
   mkdir -m 700 "$EXTRACT_DIR"
   unzip -q -n "$ZIP_INPUT" -d "$EXTRACT_DIR"
   cd "$EXTRACT_DIR/protocol-cap-followup-20261021"
   sha256sum -c SHA256SUMS
   ( cd payload && sha256sum -c SHA256SUMS )
   test "$(find . -type f | wc -l)" = "8"
   ```

2. Verify the exact base image in the local store and its platform:

   ```sh
   test "$(docker image inspect --format '{{.Id}}' "$EXPECTED_ID")" = "$EXPECTED_ID"
   test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$EXPECTED_ID")" = 'linux/amd64'
   docker image inspect --format '{{.Config.User}} {{.Config.WorkingDir}} {{json .Config.Cmd}}' "$EXPECTED_ID"
   ```

   The base is not pulled. A bare-ID `FROM` is forbidden; the Dockerfile uses
   the new local tag.

3. Builder gate before creating the base tag: `docker buildx inspect default`
   must show `Driver: docker` and a local endpoint. If absent/mismatched, STOP.
   Do not create, switch, or bootstrap a builder.

4. Both fixed image tags must be unused, including stopped images; the
   inspection container name must be absent, including stopped containers.
   Never overwrite or reuse:

   ```sh
   if docker image inspect "$LOCAL_TAG" >/dev/null 2>&1; then
     printf 'preflight_failed=base-local-tag-exists\n'; exit 1
   fi
   if docker image inspect "$DERIVED_TAG" >/dev/null 2>&1; then
     printf 'preflight_failed=derived-tag-exists\n'; exit 1
   fi
   if docker container inspect "$INSPECT_NAME" >/dev/null 2>&1; then
     printf 'preflight_failed=inspection-container-exists\n'; exit 1
   fi
   ```

5. Require the existing fixed `session_port_internal` network and healthy
   `session-port-postgres` container. This is liveness only; the in-image
   identity guard is authoritative.

6. Env file: the existing private validation-migrator env file, server-only,
   outside the bundle and build context, owner-readable. It contains only
   `SESSIONPORT_MIGRATOR_DATABASE_URL` for the exact host/role/database above.
   Do not print, source, dump, or pass its value in argv. Missing or different:
   STOP; do not request or create a new secret. Do not use the user OAuth secret
   file.

7. Create the base tag only after gates 1-6 pass, then verify it:

   ```sh
   docker image tag "$EXPECTED_ID" "$LOCAL_TAG"
   test "$(docker image inspect --format '{{.Id}}' "$LOCAL_TAG")" = "$EXPECTED_ID"
   ```

8. Build offline with the default builder, no pull, no build args, no install,
   no generation, and no migration:

   ```sh
   docker buildx build \
     --builder default --load --pull=false --network=none \
     --iidfile "$IID_FILE" -f Dockerfile.inspect -t "$DERIVED_TAG" .
   ```

   `--network=none` covers `RUN` only, not `FROM` resolution. No registry
   fallback, login, pull, retag-by-name, or image substitution. The context is
   the extracted directory; `.dockerignore` allows only `Dockerfile.inspect`,
   `payload/SHA256SUMS`, `payload/INSPECTION-MANIFEST.json`, the two payload
   files, and their parent directories.

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

   Required: `linux/amd64`, `user=node`, `workdir=/app/cloud/api`, CMD
   `["node","--import","tsx","scripts/inspect-retained-cap-fixtures.ts"]`, and
   an empty entrypoint (or the reviewed base passthrough that still executes the
   requested node script; otherwise STOP). Use only `"$IMAGE_ID"` for the
   inspection run. Do not mutate or retag the base image.

   The build already verified the copied source hash `44dd...` and the base
   driver hash `7acfc4...` inside the image. Do not add a separate container run
   for that check.

## 6. Exactly one read-only inspection

Only after all build gates pass. No ports or mounts; the env file is not a bind
mount. Stop only the exact `$INSPECT_NAME` container on timeout. Never kill or
stop a foreign container.

```sh
set +e
timeout --signal=TERM --kill-after=5s 120s \
  docker run --name "$INSPECT_NAME" --rm --user node \
    --cap-drop ALL --security-opt no-new-privileges \
    --network session_port_internal --env-file "$ENV_FILE" \
    "$IMAGE_ID" node --import tsx scripts/inspect-retained-cap-fixtures.ts \
      --inspect-retained-cap-fixtures-only --max-run-ms=90000 \
  > "$INSPECT_LOG" 2>&1
INSPECT_RC=$?
set -e
if [ "$INSPECT_RC" -ne 0 ]; then
  if docker container inspect "$INSPECT_NAME" >/dev/null 2>&1; then
    docker stop --time 10 "$INSPECT_NAME" >/dev/null 2>&1 || true
  fi
  printf 'inspection_failed=do-not-cleanup-or-rerun\n'
  exit 1
fi
```

Do not run cleanup, the protocol driver, or any old cleanup/protocol command.
Do not retry the inspection. Do not delete fixtures. There is no second
attempt in this handoff.

## 7. Required inspection output

The CLI emits exactly these fields in this order. Any missing line, extra line,
different label, `status` other than `inspected`, or `cleanupPerformed` other
than `false` is STOP. Numeric counts are actual values; the expected baseline
below is used only to set `scopeAnomaly`.

```text
status=inspected
mode=--inspect-retained-cap-fixtures-only
postgresqlMajor=16
migrations=3
migrationChecksums=matched
schema=matched
fixtureUsers=8
fixtureUserIDs=project:<id>,revision:<id>,pagination:<id>,quota:<id>,exchange:<id>,rotation:<id>,approval:<id>,other:<id>
fixtureQuotas=<actual>
fixtureProjects=<actual>
fixtureProjectRoleCounts=project:<n>,revision:<n>,pagination:<n>,quota:<n>,exchange:<n>,rotation:<n>,approval:<n>,other:<n>
fixtureRevisions=<actual>
fixtureRevisionRoleCounts=<fixed role order>
fixtureUploads=<actual>
fixtureUploadRoleCounts=<fixed role order>
fixtureProjectHeads=<actual>
fixtureHeadRoleCounts=<fixed role order>
fixtureDevices=<actual>
fixtureDeviceRoleCounts=<fixed role order>
fixtureGrants=<actual>
fixtureGrantRoleCounts=<fixed role order>
fixtureAccessTokens=<actual>
fixtureRefreshTokens=<actual>
fixtureOwnedPendingAuthorizations=<actual>
fixturePendingRoleCounts=<fixed role order>
approvalUserApprovedPending=<actual 0..2>
otherUserApprovedPending=<actual 0..1>
unlinkedPendingCandidateCount=<actual 0..5>
unlinkedPendingCandidateIDs=<uuid-list-or-none>
unlinkedPendingCandidateStatuses=<status-list-or-none>
unlinkedPendingCandidatesOwnershipProof=false
crossBoundary=<clear-or-blocked>
crossBoundaryCode=<none-or-cross-boundary-reference>
scopeAnomaly=<true-or-false>
scopeAnomalyCodes=<none-or-fixed-comma-list>
cleanupPerformed=false
```

Expected baseline for anomaly detection:

```text
fixtureUsers=8
fixtureQuotas=8
fixtureProjects=4
fixtureRevisions=6
fixtureUploads=8
fixtureProjectHeads=3
fixtureDevices=6
fixtureGrants=6
fixtureAccessTokens=3
fixtureRefreshTokens=3
fixtureOwnedPendingAuthorizations=4
approvalUserApprovedPending=1
otherUserApprovedPending=1
unlinkedPendingCandidateCount=1
unlinkedPendingCandidateStatuses=pending
scopeAnomaly=false
scopeAnomalyCodes=none
```

The approval A/B metadata can instead be `0` approved / `2` unlinked or `2`
approved / `0` unlinked without failing the inspection; that is recorded as
`scopeAnomaly=true` with `approval-cap-shape` (and count drift when applicable).
It is **not** proof of the exact exception thrown and must not be described as
such.

`crossBoundary=blocked` or any `scopeAnomaly=true` is a review stop. Freeze the
actual output; do not infer ownership from the marker, do not use the old
6/15-stage counts, and do not start a cleanup. Any future cleanup requires a
separate owner-approved exact scope. `unlinkedPendingCandidateIDs` and statuses
are the only candidate evidence; their presence is not ownership proof.

## 8. Evidence boundary and next gate

This handoff supports preparation for one read-only inspection only. It cannot
claim a PostgreSQL pass, 15/15, cleanup success, runtime classifier acceptance,
OAuth/browser flow, vault/keyring, TUI, M4, native-host, production, or
cross-platform compatibility. The original 13/15 failure remains unchanged.

After review and execution, return the fixed inspection output (or a sanitized
copy) and the derived image ID. No cleanup or corrected-protocol run is
authorized by this document; both remain separate owner decisions.
