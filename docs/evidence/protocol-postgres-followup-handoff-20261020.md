# Protocol PostgreSQL follow-up handoff (2026-10-20)

Status: **PREPARED ONLY — UNBUILT, UNAPPLIED, READ-ONLY INSPECTION STAGE.**
Owner + Oracle material re-review is required before any server inspection. This
delivery contains no approved cleanup or protocol-rerun command. Migration 0003
is already applied and must not be applied again. No Docker, DB, network,
install, SSH, credential, or `.env` read was performed while preparing this.

The prior archive `777511f78d2280c55fd928dabe9e2a0d135c95fbe9d980be7c8da4520226bbff`
is rejected and must not be shipped or reused. The original failed-run archive
`861717747bee33d1d980c2a427e61032a42619fe3c700dbe14a3f024b0a93ec7` remains
historical only. The eight exact retained user IDs are the owner-provided
original-stdout identities.

## 1. Artifact

| Item | Value |
| --- | --- |
| Archive | `.package-verify-work/protocol-followup-20261020/sessionport-protocol-followup-20261020.zip` |
| Bytes | `32,967` |
| SHA-256 | `6c5eb89639cce3fa224b44bce17cf26ab6645fe742e2defea08d72049033d18b` |
| Root | `protocol-followup-20261020/` |
| Entries | exactly 7 regular files; no symlinks or directory entries |
| Expected base ID | `sha256:822bfdbb939987843635e94c45d8aed8ff4029980c7988790ec2932aa94d6abf` |
| Local base tag | `sessionport-protocol-followup-base-local:822bfdbb93998784` |
| Derived tag | `sessionport-protocol-followup:review-20261020` |
| Derived ID | from `--iidfile`; not yet built |

Payload contains only:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `test-support/protocol-postgres-validation.ts` corrected driver | `50,417` | `7acfc4cf82bdbc0de26bb148d7ff738a5279d89a887527aa30b771021c86fa15` |
| `scripts/cleanup-retained-protocol-fixtures.ts` inspection CLI | `60,864` | `128731abfed17fac6bcb9cb0753cfa73035af4092b1a2e7e3c72a7a72f3a45a1` |

The corrected driver hash is unchanged from the original approved driver. The
inspection CLI reads pending rows only as `id`, `status`, `approvedUserID`; it
does not project or validate any fingerprint, digest, scope, or audience. The
three unlinked IDs are discovery candidates only and are never deletion scope.

The base already contains the 23-model generated client, the unchanged 28-file
product closure, the reviewed 0003 guard, and installed Node `22.23.3` / Prisma
CLI/client/adapter `7.10.1`. The build copies only the two payload files,
verifies `payload/SHA256SUMS`, and runs the existing network-free
`scripts/check-tool-versions.mjs`. It performs no generation, install,
migration, network, or DB action. The default CMD remains the no-flag
`validate-protocol.ts` non-mutating stop.

## 2. Build gates — any failure is STOP

Use placeholders; never put a URL, password, token, or secret in argv/chat.

```sh
ZIP_INPUT='<PATH_TO_FOLLOWUP_ZIP>'
EXTRACT_DIR='<NEW_EMPTY_OWNER_SCOPED_DIR>'
EXPECTED_ZIP_SHA256='6c5eb89639cce3fa224b44bce17cf26ab6645fe742e2defea08d72049033d18b'
EXPECTED_ID='sha256:822bfdbb939987843635e94c45d8aed8ff4029980c7988790ec2932aa94d6abf'
LOCAL_TAG='sessionport-protocol-followup-base-local:822bfdbb93998784'
DERIVED_TAG='sessionport-protocol-followup:review-20261020'
ENV_FILE='<SERVER_ONLY_ENV_FILE_OUTSIDE_BUNDLE>'
IID_FILE='<NEW_EMPTY_IID_FILE_PATH>'
INSPECT_NAME='sessionport-protocol-followup-inspect-20261020'
```

1. Verify checksum, extract without overwrite, verify both manifests:

   ```sh
   test "$(sha256sum "$ZIP_INPUT" | awk '{print $1}')" = "$EXPECTED_ZIP_SHA256"
   test ! -e "$EXTRACT_DIR"
   mkdir -m 700 "$EXTRACT_DIR"
   unzip -q -n "$ZIP_INPUT" -d "$EXTRACT_DIR"
   cd "$EXTRACT_DIR/protocol-followup-20261020"
   sha256sum -c SHA256SUMS
   ( cd payload && sha256sum -c SHA256SUMS )
   ```

2. Exact base image and platform; local store only:

   ```sh
   test "$(docker image inspect --format '{{.Id}}' "$EXPECTED_ID")" = "$EXPECTED_ID"
   docker image inspect --format '{{.Os}}/{{.Architecture}}' "$EXPECTED_ID"
   ```

   Required `linux/amd64`. The base is not pulled and a bare-ID `FROM` is
   forbidden.

3. Builder gate before tag creation: `docker buildx inspect default` must show
   `Driver: docker` and a local endpoint. If absent/mismatched, STOP. Do not
   create, switch, or bootstrap a builder.

4. Both fixed tags must be unused, including stopped images. Never overwrite:

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

5. Network/DB/container gates: `session_port_internal` present, fixed PostgreSQL
   container healthy, and `INSPECT_NAME` absent including stopped containers.
   `pg_isready` is liveness only; the in-image guard is authoritative.

6. Env file: server-only, outside the bundle and build context, owner-readable,
   containing only `SESSIONPORT_MIGRATOR_DATABASE_URL` for host
   `session-port-postgres`, role `sessionport_validation_migrator`, database
   `session_port_validation`, port 5432 or omitted. Do not print, source, dump,
   or pass its value in argv. Missing or different: STOP. Do not request a new
   secret.

## 3. Build — offline, no generation

```sh
docker buildx build \
  --builder default --load --pull=false --network=none \
  --iidfile "$IID_FILE" -f Dockerfile.followup -t "$DERIVED_TAG" .
```

No registry fallback, login, pull, install, retag-by-name, or image
substitution. `--network=none` covers `RUN` only, not `FROM` resolution.

Post-build fail closed unless:

```sh
test "$(docker image inspect --format '{{.Id}}' "$LOCAL_TAG")" = "$EXPECTED_ID"
test "$(docker image inspect --format '{{.Id}}' "$EXPECTED_ID")" = "$EXPECTED_ID"
RAW_IID="$(cat "$IID_FILE")"
case "$RAW_IID" in sha256:*) IMAGE_ID="$RAW_IID" ;; *) IMAGE_ID="sha256:$RAW_IID" ;; esac
test "$(docker image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID"
docker image inspect --format \
  '{{.Id}} user={{.Config.User}} workdir={{.Config.WorkingDir}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}' \
  "$IMAGE_ID"
docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE_ID"
```

Required shape: `linux/amd64`, `user=node`, `workdir=/app/cloud/api`, CMD
`["node","--import","tsx","scripts/validate-protocol.ts"]`, entrypoint empty or
reviewed base passthrough. Use only `"$IMAGE_ID"` for later runs. Do not mutate
or retag the base image.

## 4. Read-only inspect — the only runtime step in this delivery

No ports or mounts. This is a SELECT-only inspection transaction. It performs
identity, exact migration checksum, schema, exact owned-scope, and candidate-cap
guards. It never deletes or updates.

```sh
if docker container inspect "$INSPECT_NAME" >/dev/null 2>&1; then
  printf 'preflight_failed=inspect-container-exists\n'; exit 1
fi
timeout --signal=TERM --kill-after=5s 120s \
  docker run --name "$INSPECT_NAME" --rm --user node \
    --cap-drop ALL --security-opt no-new-privileges \
    --network session_port_internal --env-file "$ENV_FILE" \
    "$IMAGE_ID" node --import tsx scripts/cleanup-retained-protocol-fixtures.ts \
      --inspect-retained-fixtures-only --max-run-ms=90000
```

Required fixed output:

```text
status=inspected
mode=--inspect-retained-fixtures-only
postgresqlMajor=16
migrations=3
migrationChecksums=matched
schema=matched
fixtureUsers=8
fixtureQuotas=8
fixtureProjects=4
fixtureRevisions=<4..6>
fixtureUploads=6
fixtureProjectHeads=<2..3>
fixtureDevices=5
fixtureGrants=5
fixtureAccessTokens=1
fixtureRefreshTokens=1
fixturePendingAuthorizations=2
unlinkedPendingCandidateCount=3
unlinkedPendingCandidateIDs=<three synthetic UUIDs, comma-separated>
unlinkedPendingCandidateStatuses=pending,pending,pending
crossBoundary=clear
cleanupPerformed=false
```

Any other status, count, status value, or line is STOP. Return the exact
`unlinkedPendingCandidateIDs` and statuses to the owner. These IDs are review
candidates only, not ownership proof and not deletion authorization. No
fingerprint, digest, scope, audience, token, hash, or row dump is emitted.

## 5. Cleanup and rerun are NOT approved in this artifact

`--cleanup-retained-fixtures-only` is intentionally disabled and returns
`status=blocked code=cleanup-scope-not-approved` before deadline, environment,
connection, transaction, or any write. The immutable reviewed unlinked-ID
allowlist is empty. Any unlinked candidate blocks the retained delete primitive
before its first delete statement. There is no marker fallback, no partial
cleanup, and no automatic retry.

After the owner reviews the exact three candidate IDs, a **new frozen artifact**
with an explicit immutable ID allowlist and a separately reviewed cleanup entry
is required. This artifact cannot clean up or run the protocol. Do not send or
execute mutating cleanup/rerun commands from this delivery.

## 6. Evidence boundary

This delivery supports preparation for read-only target evidence only: PostgreSQL
16, `session_port_validation`, the exact base/derived image, the already-applied
three-migration schema, and the retained-fixture candidate inventory. It cannot
claim cleanup, protocol runtime acceptance, auth OAuth browser flow,
vault/keyring, TUI, M4, native-host, production, or cross-platform
compatibility. Derived image ID and inspect counts remain unknown until the
owner + Oracle re-review clears this artifact and the server runs the
inspection-only step.
