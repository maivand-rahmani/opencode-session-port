# Project + UserQuota additive schema slice evidence

Date: 2026-10-20

Status: offline schema, preparation, and pinned-tool generation evidence only. **This slice is not a PostgreSQL execution proof and is not approved for server use.** No database, server, credential, migration history, or network database endpoint was contacted. Parent review of the new migration is required before any server use.

## Scope and exclusions

Authorized files in this slice:

- `cloud/api/schema-tools/assemble-business-schema.mjs` (new, pure additive transform)
- `cloud/api/schema-tools/assemble-business-schema.node.mjs` (new, explicit Node tests)
- `cloud/api/scripts/prepare-schema.mjs` (modified preparation contract)
- `cloud/api/schema-tools/prepare-schema.node.mjs` (modified focused tests)
- `cloud/api/prisma/schema.prisma` (derived combined schema)
- `cloud/api/prisma/migrations/202610190002_project_quota/migration.sql` (new, reviewed offline artifact)
- `docs/evidence/project-quota-schema.md` (this file)
- `cloud/api/.package-verify-work/project-quota-20261019-9d4f1a/` (ignored scratch)
- `cloud/api/prisma/generated/client/**` (ignored derived client output)

No vendor artifact, initial migration draft, assembler original, `prisma.config.ts`, package manifest, lockfile, `.gitattributes`, runtime source, API test, other documentation, Git state, server, database, or credential was edited. No `migrate dev`, `migrate deploy`, `db push`, or `db pull` was run.

## Preserved inputs and historical hashes

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `cloud/api/prisma/auth.generated.prisma` (unchanged vendor input) | 9,533 | `092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C` |
| Prepared vendor-baseline schema for `generated/client` (historical) | 9,617 | `5CF9B275F85B324587255F933ACA4297DDF1DACB4370E0A5D05C5A4DD4252FA2` |
| `202610190001_vendor_auth/migration.sql` (unchanged) | 12,640 | `EFAB4C8E3CB87EAAC11B98D9613A0A2DC3B20826C22E04E31D2CBC091E6581CD` |
| `prisma/drafts/0001_vendor_auth.sql` (unchanged) | 12,154 | `09523E4601DC71D124477EC833861C90FF14F2D4C60BA023C8389DBA61E2A6EA` |

The initial migration was derived again by preparation and remained byte-identical. Its prepared header still records the historical vendor-baseline schema hash `5CF9...2FA2`; it was **not** rewritten to the combined business-schema hash. `PREPARED_SCHEMA_SHA256` remains a backward-compatible alias for `VENDOR_BASELINE_SCHEMA_SHA256`.

## Additive transform

Source: [`assemble-business-schema.mjs`](../../cloud/api/schema-tools/assemble-business-schema.mjs)

The transform runs only after the unchanged pure `assembleAuthSchema(vendorBytes, "generated/client")` result. It:

- verifies one exact, unique vendor `User` model end anchor, including its mixed CRLF/LF bytes, against the pinned anchor hash;
- inserts only two Prisma virtual inverse relation fields in the derived `User` model:
  - `projects Project[]`
  - `quota UserQuota?`
- appends only the fixed `ProjectState` enum, `Project` model, and `UserQuota` model;
- fails closed on a missing, duplicate, or already-present anchor/field/declaration, invalid input, invalid UTF-8, input hash drift, or baseline tail drift.

Anchor SHA-256: `4AE82B00796D7146E7F94495D345EE5839BEEEE317BC751B3DC0C421C8FBD794`.

Combined schema:

- Bytes: 10,324
- SHA-256: `1ED6C4B24726F182F2E5778B400373A7A38D525A8562E7364B0DB7A6567630D2`
- Declarations: 15 models (13 vendor + `Project` + `UserQuota`), 1 enum (`ProjectState`)
- Vendor models after `User`, the datasource block, and the generator header remain byte-identical to the vendor-baseline schema.
- Removing the two inserted field lines and the fixed appended section reproduces the 9,617-byte baseline exactly.

Generated lineage:

```text
vendor schema 092B...0AE5C
  -> assembleAuthSchema (generated/client) -> vendor baseline 5CF9...2FA2
  -> transformBusinessSchema            -> combined schema 1ED6...30D2
  -> prisma migrate diff (7.10.1)       -> raw diff  DDA7...D85E
  -> append explicit CHECK constraints  -> final SQL 97C6...4550
```

The initial `202610190001_vendor_auth` artifact remains on its original lineage (`draft 0952...A6EA`, body `6122...9D40`, prepared `EFAB...81CD`) and is not part of the combined-schema lineage.

The appended business declarations add no cap/configuration fields, no `Revision`, `Upload`, `Device`, `DeviceGrant`, `AccountKeyBundle`, and no authentication route or production parameter selection:

```prisma
enum ProjectState {
  active
  purged
}

model Project {
  projectID      String       @id @db.Uuid
  userID         String
  user           User         @relation(fields: [userID], references: [id], onDelete: Restrict)
  encryptedLabel Bytes?
  state          ProjectState @default(active)
  createdAt      DateTime     @default(now())

  @@index([userID, state])
}

model UserQuota {
  userID        String   @id
  user          User     @relation(fields: [userID], references: [id], onDelete: Restrict)
  limitBytes    BigInt
  usedBytes     BigInt   @default(0)
  reservedBytes BigInt   @default(0)
  updatedAt     DateTime @updatedAt
}
```

`projectID` has no client-side UUID default; the client must choose it. `limitBytes` is required with no default. `onUpdate: Cascade` is Prisma's default and is acceptable for this slice. Default table names are `"Project"` and `"UserQuota"`.

## Preparation contract

`prepareSchemaBytes` now returns the fully combined schema:

- `sha256` / `bytes`: combined business schema (`1ED6...30D2`, 10,324 bytes)
- `baselineSha256`: historical vendor-baseline schema (`5CF9...2FA2`)
- `vendorSha256`: reviewed vendor input (`092B...0AE5C`)

The preparation script writes only `prisma/schema.prisma` and the initial `202610190001_vendor_auth` artifact. It does **not** reference, generate, or overwrite `202610190002_project_quota`; the new migration is separately tracked.

## Offline migration generation

Tool: pinned `prisma` `7.10.1` from `cloud/api/node_modules`; no install occurred.

Flag verification (scratch config, minimal child environment):

```powershell
node <cloud/api>/node_modules/prisma/build/index.js migrate diff `
  --config prisma.config.ts --help
```

- Exit `0`; 2,993 bytes of help stdout; stderr only `Loaded Prisma config from prisma.config.ts.`
- The pinned CLI documents `--from-schema` and `--to-schema` (datamodel sources) and `--script`. It does **not** expose `--from-schema-datamodel` / `--to-schema-datamodel` in this version.
- Prisma 7.10.1 requires a datasource entry for `migrate diff`, so a scratch-only config used the synthetic, no-password loopback placeholder:

- `postgresql://synthetic_prisma_diff@127.0.0.1:55432/sessionport_synthetic?schema=public`

This is not a credential, product default, or server address. It was not contacted. The CLI child received a minimal environment allowlist; no project `.env`, real database URL, or credential was read. The diff itself is schema-to-schema and read-only. The scratch config was required because Prisma 7.10.1 can exit `0` with empty stdout when no datasource config is available; the runner asserted a non-empty stdout instead of trusting the exit status alone.

Exact command (scratch working directory, config auto-loaded explicitly):

```powershell
node <cloud/api>/node_modules/prisma/build/index.js migrate diff `
  --config prisma.config.ts `
  --from-schema schema/vendor-baseline.prisma `
  --to-schema schema/combined.prisma `
  --script
```

Results:

- Exit `0`; stderr only `Loaded Prisma config from prisma.config.ts.`
- Raw stdout: 1,089 bytes, SHA-256 `DDA7C86FDC5C4BA3DAFE02FB6FABEF823AD0EFF05A1ECD6436A711D13844D85E`
- One determinism repeat produced the identical 1,089-byte stdout hash. No loop or additional repeat was performed.
- Raw stdout was preserved without rewriting. The final artifact appends the explicit CHECK constraints below.

Final artifact:

- `cloud/api/prisma/migrations/202610190002_project_quota/migration.sql`
- Bytes: 1,667
- SHA-256: `97C6B494D51CFAF15C9B2CC69B17720653086223510856D838B95211887E4550`

Generated/reviewed SQL contents:

| Item | Count |
| --- | ---: |
| `CREATE TYPE "ProjectState"` | 1 |
| `CREATE TABLE` (`"Project"`, `"UserQuota"`) | 2 |
| `CREATE INDEX` (`Project_userID_state_idx`) | 1 |
| Foreign keys | 2 |
| Explicit CHECK constraints | 2 |
| `CREATE SCHEMA`, `DROP`, role/user/extension/admin statements | 0 |

Both foreign keys reference the vendor `"user"("id")` from the new tables only and use `ON DELETE RESTRICT ON UPDATE CASCADE`, so retained business data cannot be implicitly purged. No vendor table or vendor column is altered.

The pinned diff does not render CHECK constraints. Appended explicitly after the captured SQL:

```sql
ALTER TABLE "UserQuota" ADD CONSTRAINT "UserQuota_bytes_nonnegative_check" CHECK ("limitBytes" >= 0 AND "usedBytes" >= 0 AND "reservedBytes" >= 0);
ALTER TABLE "UserQuota" ADD CONSTRAINT "UserQuota_usage_within_limit_check" CHECK ("usedBytes"::numeric + "reservedBytes"::numeric <= "limitBytes"::numeric);
```

The first constraint is one combined non-negativity check. The second casts to `numeric` before addition to avoid `BIGINT` overflow in the sum.

## Validation performed

| Check | Result |
| --- | --- |
| New additive transform tests: `node --test cloud/api/schema-tools/assemble-business-schema.node.mjs` | Passed, 7/7 |
| Preparation tests: `node --test cloud/api/schema-tools/prepare-schema.node.mjs` | Passed, 9/9 |
| Original assembler regression: `node --test cloud/api/schema-tools/assemble-auth-schema.node.mjs` | Passed, 8/8, unchanged |
| `npm run db:validate` (offline, no `.env`) | Passed; schema valid; artifacts unchanged |
| `npm run db:generate` (offline, no `.env`) | Passed; Prisma Client 7.10.1 generated to ignored `prisma/generated/client` |
| `npm run typecheck` | Passed |
| Vendor artifact hash | Unchanged, `092B...0AE5C` |
| Initial migration hash | Unchanged, `EFAB...581CD` |
| `0002` overwrite during preparation | Not performed; test asserts byte identity around `prepareArtifacts` |
| PostgreSQL execution / migration apply | Not performed |
| Server, database, credentials, network database endpoint | Not contacted |

The tests cover malformed input, missing/duplicate anchors, pre-existing business fields/declarations, input hash drift, baseline tail drift, deterministic output, temp-owned safe output paths, model-byte identity, reversibility, and the fixed declaration set. No full API test suite, root package test suite, migration deployment, or PostgreSQL run was performed in this slice.

## Remaining limitations and blockers

- **No PostgreSQL execution proof.** The CHECK expressions, enum creation, table/index/foreign-key DDL, and `ON DELETE RESTRICT` behavior have not been executed against PostgreSQL.
- **No migration-history proof.** No `_prisma_migrations` row, database, role, schema, or server state exists as a result of this work.
- **Offline client generation only.** The generated Prisma client is derived output and does not prove runtime integration, query behavior, quota enforcement, or transaction semantics.
- **Parent review required.** The new migration must be reviewed before any server use. The quarantined CHECK constraints and `RESTRICT` choice are part of that review.
- **No production parameter selection.** No quota cap, configuration field, future auth binding, or guessed compatibility claim was added.

## Next step

Parent review of the new migration, transform, preparation changes, and this evidence before any server or database use.
