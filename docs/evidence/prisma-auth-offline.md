# Prisma auth schema offline assembly and SQL draft evidence

Date: 2026-10-19

Status: offline source and pinned-tool evidence only. **AUTH-01 is not passed**, no PostgreSQL 16 runtime compatibility was proven, the generated SQL draft was not applied, and no server, database, or credential was contacted. Parent independent review is required before any server use.

## Scope and exclusions

Authorized deliverables for this slice:

- `cloud/api/schema-tools/assemble-auth-schema.mjs` (new, pure ESM assembler)
- `cloud/api/schema-tools/assemble-auth-schema.node.mjs` (new, explicit Node tests)
- `cloud/api/prisma/drafts/0001_vendor_auth.sql` (new, offline SQL draft)
- `docs/evidence/prisma-auth-offline.md` (this file)
- `.package-verify-work/prisma-auth-offline-20261019-6f2c9a/` (ignored scratch/tooling)

No vendor artifact, schema-tool config, runtime source, project manifest, lockfile, tsconfig, business model, other documentation, Git state, server, database, or credential was edited. `cloud/api/prisma/auth.generated.prisma` was read only and remained byte-for-byte identical:

- Bytes: 9533
- SHA-256: `092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C`

The generated SQL was not applied. No Prisma client was generated. No database process, migration, `migrate dev`, `migrate deploy`, `db push`, `db pull`, or server access occurred.

## Reviewed vendor input

Source: [`cloud/api/prisma/auth.generated.prisma`](../../cloud/api/prisma/auth.generated.prisma)

- The reviewed initial header is exactly:
  - `generator client` with `provider = "prisma-client"` and no `output`
  - `datasource db` with `provider = "postgresql"` and no URL
- The file contains 13 vendor models: `User`, `Session`, `Account`, `Verification`, `Jwks`, `OauthClient`, `OauthResource`, `OauthClientResource`, `OauthRefreshToken`, `OauthAccessToken`, `OauthConsent`, `OauthClientAssertion`, `DeviceCode`.
- The vendor file has mixed line endings (LF and CRLF in the header and models). The assembler's exact-prefix check intentionally includes those bytes.
- Generation provenance is recorded in [`auth-schema-generation.md`](./auth-schema-generation.md).

## Assembler implementation

Source: [`assemble-auth-schema.mjs`](../../cloud/api/schema-tools/assemble-auth-schema.mjs)

API:

```js
assembleAuthSchema(vendorBytesOrText, clientOutput) -> Buffer
validateClientOutput(clientOutput) -> string
```

Behavior:

- Accepts a string, `Buffer`, or `Uint8Array`; validates UTF-8 with a fatal decoder.
- Requires the exact reviewed initial generator + datasource header bytes, including the `prisma-client` and `postgresql` providers.
- Counts `generator` and `datasource` declarations before accepting the header. Missing or duplicate declarations fail closed, including duplicate wrapper blocks inside model text.
- Replaces only the initial `generator client` block. The replacement keeps the same provider and adds:
  - `output = "<validated relative client output>"`
  - `moduleFormat = "esm"`
  - `importFileExtension = "js"`
- Builds the result as replacement bytes plus the original vendor byte slice starting immediately after the original generator block. The datasource block and every model byte are not decoded/re-encoded on that path.
- Does not parse models, add fields or relations, merge schemas, or infer business tables.
- Does not write files or invoke CLI/tooling. The caller writes the scratch-only derived file.

Fail-closed codes:

`VENDOR_INPUT_TYPE`, `VENDOR_UTF8_INVALID`, `VENDOR_HEADER_DRIFT`, `VENDOR_GENERATOR_MISSING`, `VENDOR_GENERATOR_DUPLICATE`, `VENDOR_DATASOURCE_MISSING`, `VENDOR_DATASOURCE_DUPLICATE`, `CLIENT_OUTPUT_INVALID`.

Client output validation requires a relative forward-slash path with printable ASCII and no empty, `.` or `..` segments. It rejects absolute paths, drive letters, backslashes, quotes, control characters, whitespace, and traversal. The selected scratch-only output is `generated/prisma-client`; it is not a product default.

## Unit tests

Command:

```powershell
node --test cloud/api/schema-tools/assemble-auth-schema.node.mjs
```

Result: **8 tests, 8 passed, 0 failed** (TAP, Node `22.13.1`, Windows x64; ~100 ms). The test file is outside the API `.node.ts` runner and Bun's default test suffix discovery; it must be run explicitly.

Assertions include:

- vendor artifact length and SHA-256 are the reviewed values;
- expected generator block is exact and the derived output has the expected SHA-256 `ADBACD735437417F87232C3BAE1A10A6C89B53FE918E4AA3ABF87D4CFD544BDF` for `generated/prisma-client`;
- datasource + model tail bytes are identical to the vendor tail;
- exactly one generator, one datasource, and 13 models remain; no business model was invented;
- byte, text, `Uint8Array`, and repeated calls are deterministic;
- header/provider drift, leading content, missing/duplicate generator or datasource, invalid input types, invalid UTF-8, and all malicious output paths are rejected.

## Scratch toolchain

Path: `.package-verify-work/prisma-auth-offline-20261019-6f2c9a/` (ignored by the existing `.package-verify-work` rule).

Install command:

```powershell
npm install --prefix .package-verify-work/prisma-auth-offline-20261019-6f2c9a `
  --save-exact --ignore-scripts --no-audit --no-fund `
  --registry=https://registry.npmjs.org/ `
  --userconfig .package-verify-work/prisma-auth-offline-20261019-6f2c9a/npmrc-empty `
  --cache .package-verify-work/prisma-auth-offline-20261019-6f2c9a/npm-cache `
  prisma@7.10.1 @prisma/client@7.10.1
```

Result: exit `0`; 138 packages added in 38 s; top-level `npm ls --depth=0` reported exactly `@prisma/client@7.10.1` and `prisma@7.10.1`.

Scratch hashes:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `package.json` | 83 | `70562560A3B11C45F2E612AA9219F64725F63F0F92E1128F275BA63D383D25A7` |
| `package-lock.json` | 58805 | `91022A8549F6EA0F6436A05CE89670355A59862A6B592432CAA53EA9F3610AAE` |
| `prisma.config.ts` | 750 | `00A2E221B4AEA250402D81659F14352E7ABEC795A5C8855453697BFDBCC904B2` |

Runtime: Node `22.13.1`, npm `11.5.2`, win32 x64. Prisma `7.10.1` engine range is `^20.19 || ^22.12 || >=24.0`.

The pinned `@prisma/engines` package provided a local `schema-engine-windows.exe` (`7.10.1`-era engine version `d1b3f377ca835d73fd50954a5e22128b9ebdd6b8`, 20,791,808 bytes). The CLI used that local executable. No additional schema-engine download message was observed during validate/diff; no engine compatibility claim is made.

No root install, root `package-lock.json`, project dependency, or project lockfile was changed.

## Derived schema (scratch only)

The assembler was invoked with the reviewed vendor bytes and `generated/prisma-client`, and the result was written only to:

- `.package-verify-work/prisma-auth-offline-20261019-6f2c9a/schema/auth.assembled.prisma`
- Bytes: 9624
- SHA-256: `ADBACD735437417F87232C3BAE1A10A6C89B53FE918E4AA3ABF87D4CFD544BDF`

The derived file is not committed and is not a runtime client output directory. No client generation was requested.

## CLI environment

The CLI child received a minimal allowlist of OS variables (`SystemRoot`, `windir`, `SystemDrive`, `PATH`, `PATHEXT`, `TEMP`, `TMP`, `ComSpec`, `PROCESSOR_*`, `NUMBER_OF_PROCESSORS`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `LOCALAPPDATA`, `APPDATA`, `PROGRAMFILES*`, `PROGRAMDATA`, `PROGRAMW6432`, `COMMONPROGRAMFILES`, `PUBLIC`, `USERNAME`, `USERDOMAIN`, `COMPUTERNAME`, `PSModulePath`, `LANG`, `LC_ALL`, `TERM`, `NO_COLOR`). Names matching PG/POSTGRES/DATABASE/SESSIONPORT/GITHUB/AUTH/BETTER_AUTH/TOKEN/SECRET/PASSWORD/_KEY/NPM_/NODE_/PROXY/AWS/S3/SMTP/REDIS/VERCEL/PROD were denied even if allowlisted. Environment values were never printed. No `DATABASE_URL` or real connection URL was supplied.

Prisma 7.10.1's `migrate diff` starts the schema-engine child with `--datasource` and therefore requires a datasource entry even for `--from-empty --to-schema`. A scratch-only config was used with a synthetic, no-password loopback URL:

- `postgresql://synthetic_prisma_diff@127.0.0.1:55432/sessionport_synthetic?schema=public`

This is not a credential, product default, or server address. It is a typed placeholder; `--from-empty --to-schema` is a read-only datamodel diff and did not need a connection. No listener or database was started.

## CLI commands and results

Working directory: `.package-verify-work/prisma-auth-offline-20261019-6f2c9a/`. Schema path is relative to that directory. The config is auto-discovered from the scratch working directory; no project config is involved.

Final validation:

```powershell
node node_modules/prisma/build/index.js validate --schema schema/auth.assembled.prisma
```

- Exit: `0`
- stdout: 57 bytes, `The schema at schema\auth.assembled.prisma is valid`
- stderr: `Loaded Prisma config from prisma.config.ts.` and `Prisma schema loaded from schema\auth.assembled.prisma.`

Final SQL generation:

```powershell
node node_modules/prisma/build/index.js migrate diff `
  --from-empty --to-schema=schema/auth.assembled.prisma --script
```

- Exit: `0`
- stdout: 11,027 bytes of SQL (SHA-256 `61229B920E30CA38F77F19AF6DD39246AEE095E834A8B76B6A8FA020A7709D40`)
- stderr: `Loaded Prisma config from prisma.config.ts.`
- Raw stdout was captured without rewriting; the committed draft prepends only clear `--` header comments.

CLI diagnostic history, recorded for transparency and **not** used as SQL evidence:

- Without a Prisma config, the same `migrate diff` command exited `0` but emitted 0 bytes of stdout/stderr and no output file. `--output` also produced no file.
- A schema-engine probe showed the engine child requires `--datasource <JSON>`; this is why the scratch config was added.
- A debug RPC run confirmed the CLI sent the expected `diff` request with `--from-empty` and the assembled schema bytes, but no SQL was emitted before the config fix.
- This was a bounded config fix; no engine download retry loop occurred.

The final config-backed invocation above is the one whose stdout is the draft. A subsequent unchanged retry is not claimed as additional evidence.

## SQL draft review

Draft: [`cloud/api/prisma/drafts/0001_vendor_auth.sql`](../../cloud/api/prisma/drafts/0001_vendor_auth.sql)

- Bytes: 12154
- SHA-256: `09523E4601DC71D124477EC833861C90FF14F2D4C60BA023C8389DBA61E2A6EA`
- The file begins with `-- DRAFT GENERATED OFFLINE - NOT APPLIED - NOT POSTGRES16_VERIFIED`, source/derived hashes, tool/runtime provenance, and the independent-review requirement.

SQL content:

| Item | Count |
| --- | ---: |
| `CREATE TABLE` (vendor models) | 13 |
| `ALTER TABLE ... ADD CONSTRAINT` foreign keys | 14 |
| `CREATE UNIQUE INDEX` | 9 |
| `CREATE INDEX` | 17 |
| `CREATE SCHEMA IF NOT EXISTS "public"` | 1 |

Vendor tables found: `user`, `session`, `account`, `verification`, `jwks`, `oauthClient`, `oauthResource`, `oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `oauthClientAssertion`, `deviceCode`.

Scan results:

- No `CREATE/DROP DATABASE`, `CREATE/DROP ROLE`, `CREATE/DROP USER`, `CREATE/DROP EXTENSION`, `CREATE TYPE`, `GRANT`, `REVOKE`, `\connect`, `SET ROLE`, or connection command.
- No business table or foreign key: no `Device`, `DeviceGrant`, `Project`, `Revision`, `Upload`, `AccountKeyBundle`, or `UserQuota`.
- `CREATE TABLE "user"` is a quoted table statement, not `CREATE USER`; the distinction is preserved.
- The only non-table/relation/index statement is Prisma's standard `CREATE SCHEMA IF NOT EXISTS "public"` preamble. It is flagged here for review and was not removed from the captured SQL.
- The draft contains schema column names such as `"password"` and `"clientSecret"` but no secret values or connection URLs.

## Checks performed

| Check | Result |
| --- | --- |
| Vendor artifact hash before and after assembly | Passed; `092B8D...0AE5C`, 9533 bytes |
| Assembler explicit Node tests | Passed; 8/8 |
| Assembler datasource/model tail byte identity | Passed |
| Assembler determinism | Passed |
| Expected derived generator block and hash | Passed |
| Drift/duplicate/malicious-output rejection | Passed |
| Scratch exact pins `prisma@7.10.1`, `@prisma/client@7.10.1` | Passed |
| Root project dependency/manifest/lock changes | None |
| `prisma validate` (scratch, offline) | Passed; exit `0` |
| `prisma migrate diff --from-empty --to-schema --script` (scratch, final config-backed) | Passed; exit `0`, 11,027 SQL bytes |
| SQL table/relation/index/prohibited-statement review | Passed; 13 vendor tables only |
| Prisma client generation | Not performed |
| Database or server connection | Not performed |
| Migration application / migration history | Not performed |
| PostgreSQL 16 runtime validation | Not performed |
| AUTH-01 | Not passed |

## Remaining limitations and blockers

- **No PostgreSQL 16 runtime proof.** This only proves offline SQL generation from the assembled schema with the pinned Prisma 7.10.1 CLI/provider. It does not prove PostgreSQL 16 execution, migration history, idempotence, locking, privileges, or production behavior.
- **Draft is not applied.** The SQL is a review artifact only. No `_prisma_migrations` row, database table, role, extension, or server state exists as a result of this work.
- **Parent review required before server use.** The draft and `CREATE SCHEMA IF NOT EXISTS "public"` preamble must be independently reviewed before any migration or deployment action.
- **CLI config requirement.** Prisma 7.10.1 `migrate diff` can exit `0` with empty output when no datasource config is available. The scratch config is required for a meaningful SQL result; future tooling must verify non-empty output, not just exit status.
- **Strict assembler coupling.** The assembler intentionally fails closed on any change to the reviewed mixed-EOL vendor header. A regenerated vendor artifact requires hash/header re-review and a new expected derived hash; it is not silently accepted.
- **Grant binding unresolved.** This work adds no device/user grant mapping, business FK, or business table. AUTH-01's durable per-device grant requirement remains blocked and is not represented in the vendor SQL.
- **No runtime auth.** `/api/auth/*` remains fail-closed and unchanged; no BetterAuth handler, JWT issuance, client generation, or database client was activated.

## Next step

Independent parent review of the assembler, the derived-schema evidence, and `cloud/api/prisma/drafts/0001_vendor_auth.sql` before any server or database use.
