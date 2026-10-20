# M1-M3 schema contract handoff

Date: 2026-10-20

Status: offline schema, migration, dependency, and generated-client evidence only. **No database,
migration history, runtime route, auth flow, web build, or production behavior is proven.** This
slice is additive to the reviewed vendor and Project/UserQuota baselines and is not approved for
server use. Ora9 Phase 1 authorizes the source baseline, not a live database or runtime deployment.

## Preserved baselines

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `cloud/api/prisma/auth.generated.prisma` (vendor input, unchanged) | 9,533 | `092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C` |
| `cloud/api/prisma/migrations/202610190001_vendor_auth/migration.sql` (unchanged) | 12,640 | `EFAB4C8E3CB87EAAC11B98D9613A0A2DC3B20826C22E04E31D2CBC091E6581CD` |
| `cloud/api/prisma/migrations/202610190002_project_quota/migration.sql` (unchanged) | 1,667 | `97C6B494D51CFAF15C9B2CC69B17720653086223510856D838B95211887E4550` |
| `cloud/api/prisma/drafts/0001_vendor_auth.sql` (unchanged) | 12,154 | `09523E4601DC71D124477EC833861C90FF14F2D4C60BA023C8389DBA61E2A6EA` |

Preparation was re-run and reproduced the initial migration byte-for-byte. The history header in
`0001` still records the historical vendor-baseline schema hash `5CF9B275F85B324587255F933ACA4297DDF1DACB4370E0A5D05C5A4DD4252FA2`.

## Prepared schema

- Path: `cloud/api/prisma/schema.prisma`
- Bytes: 16,632
- SHA-256: `33161BC5C59388974652D9E562E0CB5A558B2DC91C2971AD50997DAAF856FBFA`
- Declarations: 23 models (13 vendor + 10 business/protocol), 4 enums
- Derived only by `assembleAuthSchema(vendorBytes, "generated/client")` followed by
  `transformBusinessSchema`; `scripts/prepare-schema.mjs` writes only this schema and the initial
  vendor migration. `0002` and `0003` are separately tracked and are never rendered by preparation.
- The vendor datasource block and all 13 vendor models remain byte-identical. The only vendor-model
  change is seven virtual relation fields inserted at the reviewed `User` end anchor. No vendor
  column, table, enum, or index is added.

The `User` inverse fields are relation metadata only:

```prisma
projects                     Project[]
quota                        UserQuota?
devices                      Device[]
revisions                    Revision[]
uploads                      Upload[]
nativeDeviceGrants           NativeDeviceGrant[]
nativePendingAuthorizations  NativePendingAuthorization[] @relation("NativePendingApprovedUser")
```

## Migration 0003

- Path: `cloud/api/prisma/migrations/202610200003_protocol_native/migration.sql`
- Bytes: 14,039
- SHA-256: `82C420E972C6F7C50CDA9ED8E9C6C0407DB7D6DCE3EA76058DCCD14802EC9C26`
- Generated with pinned Prisma `7.10.1` `migrate diff --from-schema <0002-combined> --to-schema
  <0003-combined> --script` using a synthetic, never-contacted loopback datasource placeholder.
  Output was normalized to LF; the generated DDL body was not otherwise rewritten.
- The pinned diff does not render CHECK constraints or partial indexes. They were appended
  explicitly. No `CREATE SCHEMA`, `DROP`, database/role/extension, vendor-table alteration, or
  data-migration statement is present.
- Not applied. `_prisma_migrations` was not written. No `.env`, deploy, `db push`, `migrate dev`, or
  database endpoint was used.

## Exact native-auth model contract

All identifiers are PostgreSQL `UUID`; Prisma supplies **no UUID defaults**. Callers generate IDs.
All direct `User` foreign keys use `ON DELETE RESTRICT`. Persisted credential fingerprints are
canonical **lowercase SHA-256 hex, 64 characters**, matching
`cloud/api/src/native-auth/credentials.ts`.

### Enums

- `NativeGrantState`: `active`, `revoked`
- `NativeAuthorizationState`: `pending`, `approved`, `denied`, `consumed`
- `UploadState`: `uploading`, `finalizing`, `ready`, `deleting`, `deleted`, `expired`
- `ProjectState`: `active`, `purged` (pre-existing)

### `NativeDeviceGrant` (the "NativeGrant" shorthand in the phase brief)

Actual Prisma model name is `NativeDeviceGrant`; the device FK points to `NativeDeviceGrant.id`.

Fields: `id` UUID PK, `userID` String FK User RESTRICT, `status` NativeGrantState default
`active`, `audience` String, `resource` String, `scopes` String[], `createdAt` DateTime default
`now()`, `expiresAt` DateTime, `revokedAt` DateTime?. Relations: `user`, `device Device?`,
`accessTokens NativeAccessToken[]`, `refreshTokens NativeRefreshToken[]`. Indexes:
`(userID, status)`, `(status, expiresAt)`. No browser session token is stored in the grant.

SQL CHECK: `status = 'active'` requires `revokedAt IS NULL`; `status = 'revoked'` requires
`revokedAt IS NOT NULL`.

### `Device`

Fields: `id` UUID PK, `userID` String FK User RESTRICT, `grantID` UUID **required and unique** FK
`NativeDeviceGrant.id` RESTRICT, `createdAt` DateTime default `now()`, `lastSeenAt` DateTime?.
Relations: `user`, `grant`, `revisions Revision[]`, `uploads Upload[]`. Index: `(userID)`.

There is deliberately **no device status/name/revokedAt column**. Active state is derived from the
grant's committed `status` and `expiresAt`. One device per grant is expected by the service, but
Prisma exposes the inverse as optional (`NativeDeviceGrant.device Device?`); atomic grant+device
creation is a service rule, not a database requirement.

### `NativePendingAuthorization`

Fields: `id` UUID PK, `deviceCodeFingerprint` String unique, `humanCodeDigest` Bytes (32 bytes),
`humanCodeKeyID` String, `status` NativeAuthorizationState default `pending`, `approvedUserID`
String? FK User RESTRICT (relation name `NativePendingApprovedUser`), `audience` String, `resource`
String, `scopes` String[], `createdAt` DateTime default `now()`, `expiresAt` DateTime,
`lastPolledAt` DateTime?, `nextPollAt` DateTime?, `pollIntervalSeconds` Int, `consumedAt` DateTime?.
Unique `(humanCodeKeyID, humanCodeDigest)`; indexes `(status, expiresAt)` and `(expiresAt)`.

`expiresAt` is the authoritative expiry; there is no `expired` enum value. `nextPollAt` is
**nullable by decision**: null means no persisted next-poll constraint yet; the service sets it
when it records a poll. No raw device code or human code is stored. SQL CHECKs require:
`pending` with no approved user and no consumed time; `approved` with an approved user and no
consumed time; `denied` with no approved user and no consumed time; `consumed` with an approved
user and a consumed time. Fingerprint and 32-byte digest checks also apply.

### `NativeAccessToken`

Fields: `id` UUID PK, `fingerprint` String unique, `grantID` UUID FK `NativeDeviceGrant.id`
RESTRICT, `createdAt` DateTime default `now()`, `expiresAt` DateTime. Indexes: `(grantID)`,
`(expiresAt)`. No token state column: validity is expiry plus the grant's committed state.

### `NativeRefreshToken`

Fields: `id` UUID PK, `fingerprint` String unique, `grantID` UUID FK `NativeDeviceGrant.id`
RESTRICT, `createdAt` DateTime default `now()`, `expiresAt` DateTime, `spentAt` DateTime?,
`successorID` UUID? **unique** self-FK `NativeRefreshToken.id` RESTRICT, with
`successor NativeRefreshToken?` and `predecessor NativeRefreshToken?`. Indexes: `(grantID)`,
`(expiresAt)`.

The rotation link is required by this contract: `spentAt` and `successorID` are set together, and
a SQL CHECK enforces `(spentAt IS NULL) = (successorID IS NULL)`. Spent records are retained while
the grant can still be used; final archival/cleanup remains a service policy. A token's
`expiresAt <= grant.expiresAt` is a transaction invariant, not a SQL CHECK (cross-row).

## Exact project/event/upload model contract

### `Project` additions

`nextSeq BigInt @default(1)` with SQL CHECK `nextSeq >= 1`; relations `revisions Revision[]`,
`heads ProjectHead[]`, `uploads Upload[]`. Existing `encryptedLabel`, `state`, `createdAt`, and
`(userID, state)` index are unchanged.

### `Revision`

Fields: `revisionID` UUID PK, `projectID` UUID FK Project RESTRICT, `userID` String FK User
RESTRICT, `parentRevisionID` UUID? self-FK `Revision.revisionID` RESTRICT, `seq` BigInt,
`deviceID` UUID FK Device RESTRICT, `keyEpoch` Int, `sizeBytes` BigInt, `ciphertextSha256` Bytes,
`storageObjectKey` String unique, `createdAt` DateTime default `now()`. Relations include
`parentRevision`/`childRevisions` (relation `RevisionParent`), `heads ProjectHead[]`, and
`dependentUploads Upload[]` (relation `UploadParentRevision`).

Unique `(projectID, seq)`; indexes `(parentRevisionID)`, `(userID)`, `(deviceID)`. SQL CHECKs require
`seq > 0`, `keyEpoch > 0`, `sizeBytes > 0`, and a 32-byte ciphertext digest. Parent-belongs-to-the-
same-project is enforced by the commit transaction, not by a CHECK.

`storageObjectKey` has a real FK to `Upload.finalKey` (nullable unique) with RESTRICT, relation
`RevisionStorageObject`; `Upload.committedRevision Revision?` is the inverse. Consequence: the
ready upload row and its final key must exist before the revision row is inserted. There is no
circular insertion requirement: an upload may reference an earlier parent revision, then the new
revision references that upload's final key. A single-transaction commit is still required.

### `ProjectHead`

Composite PK `(projectID, revisionID)`; both FKs RESTRICT (`Project.projectID`,
`Revision.revisionID`); index `(revisionID)`. The `(projectID, revisionID)` tenant/head consistency
is service-enforced.

### `Upload`

Fields: `uploadID` UUID PK, `userID` String FK User RESTRICT, `projectID` UUID FK Project RESTRICT,
`deviceID` UUID FK Device RESTRICT, `revisionID` UUID **intent with no FK**, `parentRevisionID`
UUID? FK Revision RESTRICT, `keyEpoch` Int, `stagingKey` String unique, `finalKey` String? unique,
`state` UploadState default `uploading`, `sizeBytes` BigInt, `ciphertextSha256` Bytes,
`leaseToken` BigInt default 0, `leaseOwner` String?, `leaseExpiresAt` DateTime?, `expiresAt`
DateTime, `graceExpiresAt` DateTime?, `createdAt` DateTime default `now()`, `completedAt`
DateTime?. Indexes: `(userID, state)`, `(projectID, revisionID)`, `(state, expiresAt)`,
`(state, leaseExpiresAt)`.

SQL CHECKs require `keyEpoch > 0`, `sizeBytes > 0`, `leaseToken >= 0`, a 32-byte ciphertext
digest, and `state = 'ready'` implies `finalKey IS NOT NULL`. A partial unique index
`Upload_active_revision_intent_key` covers `(userID, projectID, revisionID)` where `state IN
('uploading','finalizing','ready','deleting')`. Lease fencing, quota accounting, and grace-TTL
cleanup remain transaction/service rules.

## Tenant and deletion behavior

- Project, revision, upload, and device rows carry `userID` directly; grant token rows inherit the
  tenant through their required grant, and a pending authorization carries the approving user only
  after approval. `ProjectHead` inherits the tenant through `Project`. All reads must stay
  user-scoped.
- Every native/business FK to vendor `"user"("id")` is `ON DELETE RESTRICT`. There is no account
  disable field and no cascade. Deleting a user therefore requires a later privileged cleanup
  decision; this schema does not invent it.
- Cross-row invariants not expressible as SQL CHECKs: token expiry `<=` grant expiry, parent
  revision in the same project, head membership, lease ownership/token/expiry fencing, and exact
  quota accounting. The service owner must enforce them in the documented lock order.

## Auth repository interface assumptions

Dependent writers can rely on these names and shapes:

- Prisma accessors: `nativeDeviceGrant`, `device`, `nativePendingAuthorization`,
  `nativeAccessToken`, `nativeRefreshToken`, `project`, `revision`, `projectHead`, `upload`.
- Grant creation and device creation are one service transaction: insert the grant, then the
  device with the unique `grantID`. Do not create a device before its grant.
- Device "active" checks must join/load the grant and evaluate `status` + `expiresAt`; no device
  status column exists to update.
- Pending approval sets `status = approved` and `approvedUserID`; exchange sets
  `status = consumed` and `consumedAt`. Denial sets `denied`. Expiry is evaluated from `expiresAt`.
- Credential storage writes only the lowercase 64-hex fingerprint returned by
  `fingerprintCredential(kind, token)`. The human-code digest is a 32-byte HMAC digest plus
  `humanCodeKeyID`; no raw code or key is persisted.
- Refresh rotation sets the old row's `spentAt` and `successorID` and inserts the replacement in
  one transaction. A replay must commit grant revocation outside the error path as designed.
- Project sequence allocation increments `Project.nextSeq` under the same transaction as commit;
  `Revision.seq` is the allocated value and `(projectID, seq)` is unique.
- Commit inserts `Revision.storageObjectKey` only from an already-ready upload's `finalKey`, then
  attaches the head rows.

## Dependency and workspace handoff

Registry metadata was verified before install; all requested versions exist.

| Workspace | Exact pins | Metadata / engines |
| --- | --- | --- |
| `cloud/api` | `better-auth@1.7.11`, `@better-auth/prisma-adapter@1.7.11` added; all existing pins retained | Better Auth peers accept Prisma `^7.0.0`; adapter peers accept `@prisma/client`/`prisma` `^7.0.0` |
| `cloud/web` | `next@16.4.2`, `react@19.3.1`, `react-dom@19.3.1`; dev `@types/react@19.3.0`, `@types/react-dom@19.3.0`, `typescript@5.9.3`, `@types/node@24.12.2` | Next engines `node >=20.9.0`; React engines `node >=0.10.0`; local verification Node `22.13.1` |

- Installed once at the repository root with Bun `1.3.10` and `--ignore-scripts`; no lifecycle
  scripts ran. The frozen check `bun install --ignore-scripts --frozen-lockfile` then reported
  `673 packages`, `no changes`, exit `0`.
- `bun.lock` is the only lockfile; no root or workspace `package-lock.json` exists. Root
  `package.json`, plugin pins, files allowlist, exports, and scripts are unchanged.
- `cloud/web/package.json` currently has `dev`, `build`, `start`, and `typecheck`. The UI owner owns
  the test source/runner; no invented web test script or extra test dependency was added.
- `@napi-rs/keyring` was not installed; the host/vault lane remains independent.

## Allowed target paths in this lane

- `cloud/api/schema-tools/**`
- `cloud/api/scripts/prepare-schema.mjs`
- `cloud/api/prisma/schema.prisma`
- `cloud/api/prisma/migrations/202610200003_protocol_native/migration.sql`
- `cloud/api/prisma/generated/client/**` (ignored derived output)
- `cloud/api/package.json`
- `cloud/web/package.json`
- `bun.lock`
- `tests/package/workspaces.test.ts`
- `docs/evidence/m1-m3-schema-contract.md`

No vendor artifact, `0001`/`0002`, `prisma.config.ts`, app/main/config/errors/routes/auth source,
web UI, root manifest, other docs, Git state, database, server, vault, or host probe was modified.

## Validation performed

| Check | Result |
| --- | --- |
| `node --test cloud/api/schema-tools/assemble-business-schema.node.mjs` | Passed, 9/9 |
| `node --test cloud/api/schema-tools/prepare-schema.node.mjs` | Passed, 9/9 |
| `npm run db:validate` (offline, no `.env`) | Passed; schema valid; artifacts unchanged |
| `npm run db:generate` (offline) | Passed; Prisma Client 7.10.1 generated to ignored output |
| `npm run typecheck` in `cloud/api` | Passed, exit 0 |
| `bun test tests/package/workspaces.test.ts` | Passed, 10/10 |
| Frozen lock consistency | Passed; no changes |
| `0001`/`0002`/vendor hashes | Unchanged |
| Full API suite (149 tests), PostgreSQL apply/history, web build/typecheck, live DB/runtime | **Not run** (integration owner) |

## Remaining limitations

- No PostgreSQL execution proof: enum creation, CHECK expressions, the partial unique index,
  FK cycles, and `RESTRICT` behavior are syntactically reviewed but not executed.
- No migration-history, deployment, runtime-route, CSRF, token-exchange, refresh-replay, or
  revocation proof. Generated Prisma Client output is derived and ignored.
- The token `expiresAt <= grant.expiresAt`, spent-refresh retention, parent/project/tenant
  consistency, head consistency, quota accounting, and lease fencing are service invariants, not
  SQL-enforced rules.
- `NativeDeviceGrant.device` is optional in Prisma; the one-device-per-grant rule is enforced by
  atomic service creation.
- The web test runner remains with the UI lane; no web test script is claimed here.
