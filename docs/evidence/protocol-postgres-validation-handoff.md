# Protocol PostgreSQL validation handoff (2026-10-20)

Status: **PREPARED ONLY — UNBUILT, UNAPPLIED. ORACLE DELIVERY GATE PENDING
BEFORE ANY EXTERNAL ACTION.**

The owner already approved the bounded scope below (0003 only on
`session_port_validation`, then the protocol/native/quota driver) after the
original project quota run passed 15/15 on the cleaned PG16 image
`f68f40395acf58fe65fe3a894466fff35b6abf24702e625ffd259d041b4434ef`.
This is a delivery handoff, not a request to repeat that approval. No Docker,
DB, Git, network, install, SSH, secret, or `.env` read was performed while
preparing it. The image is unbuilt; migration 0003 is not applied. Both
material findings are fixed in this archive: raw Prisma tool output is never
stored or forwarded (fixed metadata only), and the build now asserts the actual
installed Node/Prisma versions before schema operations.

Supersedes no prior file. The r2 project-runner handoff remains a historical
record.

Historical handoff for completed migration/failed protocol run; do not rerun or
reapply. Corrected driver source is committed separately; no new cleanup or run
is authorized.

## 1. Artifact

| Item | Value |
| --- | --- |
| Archive | `.package-verify-work/protocol-validation-20261020/sessionport-protocol-validation-20261020.zip` |
| Bytes | `117,969` |
| SHA-256 | `861717747bee33d1d980c2a427e61032a42619fe3c700dbe14a3f024b0a93ec7` |
| Root | `protocol-validation-20261020/` |
| Entries | exactly 38 regular files; no symlinks or directory entries |
| Expected base ID | `sha256:f68f40395acf58fe65fe3a894466fff35b6abf24702e625ffd259d041b4434ef` |
| Local base tag | `sessionport-protocol-base-local:f68f40395acf58fe6` |
| Derived tag | `sessionport-protocol-validation:review-20261020` |
| Derived ID | from `--iidfile`; not yet built |

`archive-verification.json` in the work directory records every entry hash,
the 28 byte-identical product sources, the four artifact-only scripts, and the
two artifact-only checks. The ZIP contains closed `SHA256SUMS` manifests, not a
generated client, `node_modules`, `.env`, whole source tree, or handoff copy.
The `checks/` files are not copied into the image; they are local evidence only.

### Source closure (28 product files, byte-identical)

```text
package.json
prisma.config.ts
prisma/schema.prisma
prisma/auth.generated.prisma
prisma/drafts/0001_vendor_auth.sql
prisma/migrations/migration_lock.toml
prisma/migrations/202610190001_vendor_auth/migration.sql
prisma/migrations/202610190002_project_quota/migration.sql
prisma/migrations/202610200003_protocol_native/migration.sql
scripts/prepare-schema.mjs
scripts/validate-protocol.ts
scripts/validate-projects.ts
schema-tools/assemble-auth-schema.mjs
schema-tools/assemble-business-schema.mjs
test-support/protocol-postgres-validation.ts
test-support/projects-postgres-validation.ts
src/database/config.ts
src/native-auth/config.ts
src/native-auth/credentials.ts
src/native-auth/enforcement.ts
src/native-auth/repository.ts
src/native-auth/human-codes.ts
src/projects/repository.ts
src/revisions/repository.ts
src/revisions/errors.ts
src/protocol/cursor.ts
src/uploads/repository.ts
src/quota/accounting.ts
```

Pinned inputs: current 23-model schema
`33161bc5c59388974652d9e562e0cb5a558b2dc91c2971ad50997daaf856fbfa`;
protocol migration 0003
`82c420e972c6f7c50cda9ed8e9c6c0407db7d6dce3ea76058dccd14802ec9c26`;
migration 0001/0002 and the auth draft unchanged from the reviewed bytes.
`validate-protocol.ts` imports the projects validation module through
`validate-projects.ts`, so that module and its project-repository closure are
included. Generated client files are not shipped; the build regenerates them
from the current schema.

### New artifact-only scripts (no product edits)

| File | Bytes | SHA-256 | Review scope |
| --- | ---: | --- | --- |
| `scripts/preflight-protocol.ts` | 3,185 | `621a6a6369d97b4e90d39cdc4d8579bbe34fce1892a62c15a770474bc047e33e` | exact one-flag CLI; strict target reader; SELECT-only preflight; fixed sanitized output |
| `scripts/protocol-preflight-lib.ts` | 12,591 | `0ccfa7d658e2d7cfc673b6ce042f810a68ec41c99378242d9ecab5b0e3a3b39b` | read-only identity/migration/object/business-count checks and postcheck; no writes |
| `scripts/apply-validation-protocol.ts` | 13,237 | `4c12341589e26e83a4bdce67a4392441fb7a5b3d4038a2692a01fba56dfbc3d9` | exact one-flag guard→prepare→single pinned `migrate deploy`→postcheck; raw streams discarded; fixed metadata only |
| `scripts/check-tool-versions.mjs` | 3,503 | `ebd79858968013d594d8b48798947df534049e0b7dc1f5121a3ab809e6df5367` | network-free actual Node/Prisma CLI/client/adapter assertions before schema operations |

The three runtime CLI scripts are `--noflag` non-mutating and exit 2 before
environment access. `check-tool-versions.mjs` is build-only and prints only
`tool-version-check=passed` or `tool-version-check=failed`. Local verification:
TypeScript 5.9.3 typecheck passed against the API `tsconfig` settings and local
generated-client types; `tsx` no-flag runs printed `status=stopped` with no
target variable present. No DB connection was made.

### Artifact-only checks (not copied to the image)

| File | Bytes | SHA-256 | Purpose |
| --- | ---: | --- | --- |
| `checks/check-apply-metadata.ts` | 4,574 | `a7426dc6d2691d3b36ded5d48b30095c66b24ec31fa7e322ed9626866ee82f56` | fake-stream canary test: no URL/password/stdout/stderr in metadata; success/fail/overflow/timeout/spawn-error/stream-error |
| `checks/check-tool-versions.mjs` | 1,167 | `656798f52dacc1e115fca3a39b1f58f2ada08e755deef59710c691388a95aefc` | injected-metadata tests for accepted, wrong-Node, wrong/missing Prisma versions |

## 2. Build gates — any failure is STOP

Use placeholders; never put a URL, password, token, or secret in argv/chat.

```sh
ZIP_INPUT='<PATH_TO_PROTOCOL_ZIP>'
EXTRACT_DIR='<NEW_EMPTY_OWNER_SCOPED_DIR>'
EXPECTED_ZIP_SHA256='861717747bee33d1d980c2a427e61032a42619fe3c700dbe14a3f024b0a93ec7'
EXPECTED_ID='sha256:f68f40395acf58fe65fe3a894466fff35b6abf24702e625ffd259d041b4434ef'
LOCAL_TAG='sessionport-protocol-base-local:f68f40395acf58fe6'
DERIVED_TAG='sessionport-protocol-validation:review-20261020'
ENV_FILE='<SERVER_ONLY_ENV_FILE_OUTSIDE_BUNDLE>'
IID_FILE='<NEW_EMPTY_IID_FILE_PATH>'
PREFLIGHT_NAME='sessionport-protocol-preflight-20261020'
MIGRATION_NAME='sessionport-protocol-migrator-20261020'
VALIDATION_NAME='sessionport-protocol-validation-20261020'
```

1. Verify checksum, extract without overwrite, verify both manifests:

   ```sh
   test "$(sha256sum "$ZIP_INPUT" | awk '{print $1}')" = "$EXPECTED_ZIP_SHA256"
   test ! -e "$EXTRACT_DIR"
   mkdir -m 700 "$EXTRACT_DIR"
   unzip -q -n "$ZIP_INPUT" -d "$EXTRACT_DIR"
   cd "$EXTRACT_DIR/protocol-validation-20261020"
   sha256sum -c SHA256SUMS
   ( cd payload && sha256sum -c SHA256SUMS )
   ```

2. Exact base image and platform; local store only:

   ```sh
   test "$(docker image inspect --format '{{.Id}}' "$EXPECTED_ID")" = "$EXPECTED_ID"
   docker image inspect --format '{{.Os}}/{{.Architecture}}' "$EXPECTED_ID"
   ```

   Required `linux/amd64`. The base is the exact successful r2 image and
   already contains the pinned Prisma 7.10.1 / tsx / Node 22.23 / Bun install.
   It is **not** pulled; a bare-ID `FROM` is forbidden (it previously resolved
   as a Docker Hub repository and failed with pull access denied).

3. Builder gate before tag creation: `docker buildx inspect default` must show
   `Driver: docker` and a local endpoint (default/local Unix socket), not a
   remote or container driver. If absent/mismatched, STOP. Do not create,
   switch, or bootstrap a builder.

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

5. Network/DB/container gates: `session_port_internal` present, the fixed
   PostgreSQL container healthy, and `PREFLIGHT_NAME`, `MIGRATION_NAME`,
   `VALIDATION_NAME` all absent including stopped containers. `pg_isready` is
   liveness only; the in-image guard is authoritative.

6. Env file: server-only, outside the bundle and build context, owner-readable,
   containing only `SESSIONPORT_MIGRATOR_DATABASE_URL` for host
   `session-port-postgres`, role `sessionport_validation_migrator`, database
   `session_port_validation`, port 5432 or omitted. Do not print, source, dump,
   or pass its value in argv. Missing or different: STOP. Do not request a new
   secret.

## 3. Build — offline generation only

From the extracted `protocol-validation-20261020/` directory:

```sh
docker buildx build \
  --builder default --load --pull=false --network=none \
  --iidfile "$IID_FILE" -f Dockerfile.runner -t "$DERIVED_TAG" .
```

No registry fallback, login, pull, install, retag-by-name, or image
substitution. `--network=none` covers `RUN` only, not `FROM` resolution. The
Dockerfile copies only the exact allowlisted files and verifies
`payload/SHA256SUMS`. Before any schema operation it runs the network-free
`scripts/check-tool-versions.mjs`, which must print
`tool-version-check=passed` for exactly Node `v22.23.3`, Prisma CLI `7.10.1`,
`@prisma/client` `7.10.1`, and `@prisma/adapter-pg` `7.10.1` as actually
installed (trusted package metadata; no npx/npm query/install/pull/remote
version check). Only then does it run `npm run db:validate && npm run
db:generate` against the current 23-model schema. No database URL is present in
the build environment; no migrate/deploy command runs during build. Build-time
generation runs as root only to replace the older generated client; the final
image sets `USER node`.

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

## 4. Pre-apply guard — read-only, inside the new image

Run once in a fixed, unused container. No ports, mounts, or extra env.

```sh
if docker container inspect "$PREFLIGHT_NAME" >/dev/null 2>&1; then
  printf 'preflight_failed=preflight-container-exists\n'; exit 1
fi
timeout --signal=TERM --kill-after=5s 120s \
  docker run --name "$PREFLIGHT_NAME" --rm --user node \
    --cap-drop ALL --security-opt no-new-privileges \
    --network session_port_internal --env-file "$ENV_FILE" \
    "$IMAGE_ID" node --import tsx scripts/preflight-protocol.ts \
      --preflight-protocol-only
```

Required fixed output; anything else is STOP:

```text
status=passed
phase=preflight
postgresqlMajor=16
migrationCount=2
protocolObjectsAbsent=true
projectRows=0
userQuotaRows=0
vendorUsers=empty|present
```

The guard issues only SELECTs. It requires exact database/role/session role,
PostgreSQL 16, exactly the two prior finished/non-rolled-back migrations, no
0003 tables/enums/`Project.nextSeq`/partial index, and zero `Project` and
`UserQuota` rows. Pre-existing vendor `User` rows may be reported `present` and
are never read as row data or deleted. Nonzero business rows or any 0003 object
is STOP; no broad reset. No `_prisma_migrations` row is written by this step.

## 5. One-time apply — guarded wrapper only

Do **not** run `npm run db:deploy` or `prisma migrate deploy` directly; that
bypasses the fixed target guard. Run the single guarded wrapper in its own
fixed, unused container (including stopped), with a 120 s outer timeout:

```sh
if docker container inspect "$MIGRATION_NAME" >/dev/null 2>&1; then
  printf 'preflight_failed=migration-container-exists\n'; exit 1
fi
timeout --signal=TERM --kill-after=5s 120s \
  docker run --name "$MIGRATION_NAME" --rm --user node \
    --cap-drop ALL --security-opt no-new-privileges \
    --network session_port_internal --env-file "$ENV_FILE" \
    "$IMAGE_ID" node --import tsx scripts/apply-validation-protocol.ts \
      --apply-protocol-migration-only
```

Fixed order inside the wrapper: exact flag, strict validated target, read-only
preflight, offline `prepare-schema.mjs`, resolve the pinned Prisma CLI from the
base install, one `migrate deploy` child with the same validated process
environment, then a read-only postcheck. Child stdout/stderr are consumed only
to count bytes and enforce a 1 MiB budget; every chunk is discarded and never
stored, forwarded, decoded, or included in the metadata. The private file
`/tmp/sessionport-protocol-migration-20261020.json` (mode 0600) contains only
fixed fields: schema tag, tool, executable class, started/completed, exit code,
allowlisted signal, stdout/stderr byte counts, overflow/stream-error flags, and
outcome. It contains no URL, password, token, environment, arguments, child
messages, or stream bytes. Stdout carries fixed status lines only. The wrapper
refuses a second attempt in the same container if that metadata file exists.

One attempt only. On any migration failure: STOP. No retry, rollback, reset,
downgrade, manual SQL, fixture tests, or container reuse. Migration 0003 may be
unknown/partial; the owner inspects it separately. Never point the URL at the
main database. On timeout, stop only the owned `$MIGRATION_NAME` container if
present. The wrapper and this procedure assume exclusive deployment
ownership; no concurrent admin/migration operation is allowed. The pre-apply
guard is not claimed to make 0003 apply atomic against such concurrent work.

Expected success output:

```text
status=passed
phase=apply-and-postcheck
preflight=passed migrationsBefore=2
migrationExitCode=0
newMigration=202610200003_protocol_native
migrationCount=3
protocolTables=8
protocolEnums=3
checkConstraints=20
partialUniqueIndexes=1
nextSeqColumns=1
migrationMetadata=/tmp/sessionport-protocol-migration-20261020.json
```

The postcheck is SELECT-only: exact three finished/non-rolled-back migrations,
the eight new tables, three enums, twenty CHECK constraints, the partial
`Upload_active_revision_intent_key` index, and `Project.nextSeq`. Inspect only
the fixed sanitized metadata; do not paste URLs, env contents, credentials, SQL
rows, or raw exceptions into chat.

## 6. Protocol/native/quota driver — only after apply postcheck passes

Run once in a separate fixed, unused container (including stopped). No ports or
mounts; the env file is not a bind mount.

```sh
if docker container inspect "$VALIDATION_NAME" >/dev/null 2>&1; then
  printf 'preflight_failed=validation-container-exists\n'; exit 1
fi
timeout --signal=TERM --kill-after=5s 120s \
  docker run --name "$VALIDATION_NAME" --rm --user node \
    --cap-drop ALL --security-opt no-new-privileges \
    --network session_port_internal --env-file "$ENV_FILE" \
    "$IMAGE_ID" node --import tsx scripts/validate-protocol.ts \
      --run-protocol-validation-only --max-run-ms=90000
```

Required result lines: `status=passed`, `testPassed=true`,
`cleanupVerified=true`, `postgresqlMajor=16`, `migrations=3`,
`fixtureUsers=3`, `checks=15/15`, `failedCheck=none`, exit code 0. All eight
bounded case groups are required. On deadline, stop only this owned container.
On any failure, fixtures may remain, `cleanupVerified` is false, and there is no
automatic retry or cleanup. The driver performs no migration, Git, network, S3,
vault, Docker, or LLM work.

## 7. Evidence boundary

This delivery supports target-only evidence for PostgreSQL 16,
`session_port_validation`, the exact base/derived image, three migrations, the
protocol/native/quota cases, and cleanup. It cannot claim auth OAuth browser
flow, vault/keyring, TUI, M4, native-host, production, or cross-platform
compatibility. Derived image ID, build result, apply result, and driver result
remain unknown until the Oracle delivery gate clears and the server runs the
gates above. Root workspace pins, dependency declarations, TUI, and native-host
source are untouched and are not part of this bundle.
