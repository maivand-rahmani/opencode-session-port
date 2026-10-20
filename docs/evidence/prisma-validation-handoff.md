# Prisma migration validation handoff (2026-10-20)

Status: **prepared transfer bundle only — NOT A DEPLOYMENT.** No server, database, credential, migration history, or network database endpoint was contacted while preparing or verifying this bundle. No production table exists and the API server is not run or deployed by this bundle; it contains migration/schema artifacts and preparation scripts, not application HTTP code. Applying migrations requires explicit **owner authorization** before touching any database, including the validation database.

## Bundle identity

- Path: `.package-verify-work/db-validation-20261020/sessionport-prisma-validation-20261020.zip` (repository-local ignored scratch)
- Bytes: `82,160`
- SHA-256: `1DEBE7468DB3A63E310C595B3E21F7538641BBF9CD8C15119E6D0EDE943FCFC4`
- Entries: 15 (14 allowlisted content files + `SHA256SUMS`), no directory entries, no extra level, no `node_modules`, generated client, `.env`, secrets, tests, or user data.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `package.json` | 1,319 | `3D8D6F136661EFD25DD7A5F9A38794B194F95FE2CFB25863AE30BC71239FB96C` |
| `bun.lock` | 150,162 | `3ABA4CC3F9C35A06795B89185F9BD79B3A4A23615011C2F88C8CB07E98FAC28C` |
| `cloud/web/package.json` | 94 | `3B73A52086582948A307D5B190C8731ECC7A20EE84074908464E3A63BBC7E611` |
| `cloud/api/package.json` | 769 | `BBBF28AB2F3E1D6F2069D094946501D5EDDB56F10FBFF8F9EC4E88FD12F29293` |
| `cloud/api/prisma.config.ts` | 1,186 | `E21F6FB322A1C10A03CB6513F70BA37A45C53CEB6FFA1DE2E98938AC511559B8` |
| `cloud/api/scripts/prepare-schema.mjs` | 14,332 | `8DD5A4446B657C8CF44CF8B77B1EAC90E18E4CCAA3351FC9FE58B90453731D1E` |
| `cloud/api/schema-tools/assemble-auth-schema.mjs` | 7,390 | `FA711F22FF7CFFDFE7F5A8448E2F6FB89410EDD75FFE8920EA396EDE7EB5F37E` |
| `cloud/api/schema-tools/assemble-business-schema.mjs` | 7,448 | `FA46821B347ECAA78D6F111577E53CFDBF7B9769936F4E2D5F21245430FD3EEA` |
| `cloud/api/prisma/auth.generated.prisma` | 9,533 | `092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C` |
| `cloud/api/prisma/schema.prisma` | 10,324 | `1ED6C4B24726F182F2E5778B400373A7A38D525A8562E7364B0DB7A6567630D2` |
| `cloud/api/prisma/drafts/0001_vendor_auth.sql` | 12,154 | `09523E4601DC71D124477EC833861C90FF14F2D4C60BA023C8389DBA61E2A6EA` |
| `cloud/api/prisma/migrations/migration_lock.toml` | 128 | `99836963713B4F5B269AD49AF0ED3D7B0B2E336115C2F92DC9AC683D139D0900` |
| `cloud/api/prisma/migrations/202610190001_vendor_auth/migration.sql` | 12,640 | `EFAB4C8E3CB87EAAC11B98D9613A0A2DC3B20826C22E04E31D2CBC091E6581CD` |
| `cloud/api/prisma/migrations/202610190002_project_quota/migration.sql` | 1,667 | `97C6B494D51CFAF15C9B2CC69B17720653086223510856D838B95211887E4550` |
| `SHA256SUMS` | — | `7AA0B545BFDF8B3927EEA499F38EC9A2AA5EFAB352EC8E692DB89E41976980ED` |

`SHA256SUMS` is a `sha256sum -c` manifest (lowercase hex, two spaces, root-relative POSIX paths, LF, trailing newline) covering all 14 content files and not itself. The root `package.json` is the public plugin manifest with a `prepack` script; every install **must** use `--ignore-scripts`.

Lineage hashes match the reviewed values: vendor `092B...0AE5C`, prepared `0001` `EFAB...581CD`, additive `0002` `97C6...4550`, combined schema `1ED6...30D2`. The root lockfile pins Prisma Client `7.10.1`.

## Evidence performed (archive integrity only)

- Staged files copied with `fs.copyFileSync`; source and staged bytes compared equal, preserving the original mixed EOL bytes.
- GNU `sha256sum -c SHA256SUMS` in the payload: all 14 entries `OK`.
- Archive reopened: exactly 15 expected entries, CRC test passed, every entry byte-identical to the payload; a separate extraction into a fresh directory matched all 14 originals by SHA-256, with the manifest restored as the fifteenth file.
- Archive SHA-256 and size above were recomputed after closing; they match the build report.
- No tracked source, schema, manifest, lockfile, or Git state was edited by this preparation.

These are **archive-byte checks, not runtime or PostgreSQL claims.** Exact server CLI availability is unknown; no dependency install, Prisma command, database connection, or migration was run here.

## Target guard (server agent)

Target is the owner-provided isolated validation database `session_port_validation` and role `sessionport_validation_migrator` on the existing PostgreSQL 16.15 server. The private/container endpoint uses its normal internal port 5432; the earlier blanket 5432 ban applied to the local fixture and does not apply here. Do not guess or substitute any endpoint or database, and do not use any application database (`session_port`) or runtime URL.

Preflight must be read-only, through the existing server-only secret mechanism, and must never print the datasource URL, password, or `.env` contents. Do not source an untrusted `.env` in a shell and do not enable shell tracing. Stop immediately on any mismatch below; do not repair, retry, or reset.

Required preflight, before install or deploy:

1. `current_database()` = `session_port_validation`.
2. `current_user` and `session_user` = `sessionport_validation_migrator`.
3. `version()` reports PostgreSQL 16 (owner states 16.15).
4. Role is nonprivileged: `rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolreplication`, `rolbypassrls` all false.
5. `public` schema is empty: zero tables, views, materialized views, sequences, and foreign tables.
6. `to_regclass('public._prisma_migrations') IS NULL` — no Prisma migration history exists.

Only metadata queries; do not read application content. If `psql` or secure secret loading is unavailable, stop and report the blocker; do not install server tooling by inference.

## Toolchain gate

Required on the server before execution:

- Node `>= 22.12` and compatible with 22 LTS (record exact version).
- Bun `1.3.10` for the root frozen lockfile (record exact version).
- `npm` and `psql` available from the existing installation.

Verify versions; do **not** upgrade, install, or infer tooling. Record versions in the report. A mismatch is a blocker.

## Authorized command sequence (after owner authorization only)

1. Verify bundle hash: `sha256sum <zip>` equals `1DEBE7468DB3A63E310C595B3E21F7538641BBF9CD8C15119E6D0EDE943FCFC4`.
2. Extract into a **new, empty, owner-approved directory** owned by the server agent. Do not extract over an existing tree.
3. From the extracted root, run `sha256sum -c SHA256SUMS`; all 14 must pass. Also confirm 15 files and no extras.
4. Run the read-only preflight above. Stop on any failed target, role, version, privilege, emptiness, or history check.
5. From the extracted root: `bun install --frozen-lockfile --ignore-scripts`. Public registry packages only; no lifecycle scripts, no postinstall, no additions to the lockfile.
6. From `cloud/api`, with `SESSIONPORT_MIGRATOR_DATABASE_URL` unset: `npm run db:validate`, then `npm run db:generate`. These are offline schema checks; generation writes only the ignored `prisma/generated/client`. No runtime URL, no database connection. If either command errors or needs an unapproved download/install, stop.
7. Re-run `sha256sum -c SHA256SUMS` from the extracted root. All 14 must still pass; this proves `db:prepare` did not alter the prepared lineage.
8. Load `SESSIONPORT_MIGRATOR_DATABASE_URL` only through the existing server-only secret mechanism for the single deploy process. Confirm it is non-empty without printing it. Never pass it as a visible command-line argument or log it.
9. Run `npm run db:deploy` **once**, as the explicit guarded operator action. Do not run `migrate dev`, `db push`, `migrate resolve`, retries, or automatic cleanup `DROP`.

## Post-deploy metadata verification (read-only, metadata only)

Expected after the single successful command:

- Exactly 2 rows in `public._prisma_migrations` with `finished_at` set and `rolled_back_at` null: `202610190001_vendor_auth` and `202610190002_project_quota`. Zero unfinished and zero rolled-back rows.
- Exactly 15 base tables in `public` excluding `_prisma_migrations`: 13 vendor tables plus `Project` and `UserQuota`.
- `UserQuota` has its primary key, exactly 2 CHECK constraints (`UserQuota_bytes_nonnegative_check`, `UserQuota_usage_within_limit_check`), and its foreign key to `"user"("id")` with `ON DELETE RESTRICT` (`confdeltype = 'r'`).
- `Project` foreign key to `"user"("id")` is also `ON DELETE RESTRICT`.
- Exact record counts above; no failed or partial state.

Suggested metadata queries (adjust only quoting, never add content reads):

```sql
SELECT current_database(), current_user, session_user, version();
SELECT count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT count(*) FROM pg_tables
  WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';
SELECT migration_name, finished_at IS NOT NULL AS finished,
       rolled_back_at IS NOT NULL AS rolled_back
  FROM public._prisma_migrations ORDER BY started_at;
SELECT conname, contype, confdeltype, pg_get_constraintdef(oid)
  FROM pg_constraint
  WHERE conrelid = 'public."UserQuota"'::regclass ORDER BY conname;
SELECT conname, confdeltype FROM pg_constraint
  WHERE conrelid = 'public."Project"'::regclass AND contype = 'f';
```

Report only: server/PostgreSQL version, CLI versions, migration names and finished counts, table count, constraint names/types, deploy exit code, and archive hash. Do **not** report connection strings, passwords, role secrets, row content, IDs, or `.env` contents.

## Failure policy

Any target, emptiness, hash, version, install, validate, generate, or deploy failure stops the run and retains state. No retry, no `DROP`/reset, no `migrate resolve`, no manual `_prisma_migrations` edits, no cleanup of partially applied objects. Report the exact failing step, exit code, and metadata; the parent decides the next bounded action.

## Non-claims and blockers

- **Not a deployment.** Production tables and migration history do not exist; applying to `session_port_validation` still requires owner authorization.
- No PostgreSQL execution, migration apply, engine run, or server/API deployment was performed here; no HTTP service exists in the bundle.
- This is not a full PostgreSQL, runtime, auth, quota-enforcement, or compatibility proof. `0002` objects and `RESTRICT` behavior remain unexecuted until the guarded run.
- Exact server CLI availability is unknown; Node/Bun/npm/psql presence and versions must be verified, not assumed.
- Open blockers: owner authorization, server-side tool verification, secure secret loading, and an empty approved extraction directory.
