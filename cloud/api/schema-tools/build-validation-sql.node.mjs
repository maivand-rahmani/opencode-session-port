/**
 * Focused offline tests for the pure validation-SQL wrapper builder.
 *
 * Run explicitly:
 *   node --test cloud/api/schema-tools/build-validation-sql.node.mjs
 *
 * These tests use fake SQL strings and in-memory hashes only. They do not
 * connect to PostgreSQL, start a process, read credentials, use the network,
 * write files, or claim PostgreSQL 16 runtime compatibility.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	buildValidationSql,
	ValidationSqlError,
} from "./build-validation-sql.mjs";

const MAX_DRAFT_BYTES = 256 * 1024;
const MINIMAL_DRAFT_SHA256 =
	"9f2eafab72ae5a0aaec7d0688eb11ff9142e5d876427cd22533687becee6f294";

const MINIMAL_DRAFT =
	'CREATE TABLE "user" (\n' +
	'  "id" TEXT NOT NULL,\n' +
	'  CONSTRAINT "user_pkey" PRIMARY KEY ("id")\n' +
	");\n";

const FULL_DRAFT =
	"-- leading comment: COMMIT and ROLLBACK are comments here\n" +
	"/* outer comment\n" +
	"   /* nested comment */\n" +
	"*/\n" +
	"CREATE SCHEMA IF NOT EXISTS public;\n" +
	"CREATE TABLE IF NOT EXISTS \"user\" (\n" +
	'  "id" TEXT NOT NULL,\n' +
	'  "email" TEXT NOT NULL,\n' +
	'  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n' +
	'  "label" TEXT DEFAULT \'a;b\',\n' +
	'  "nickname" TEXT DEFAULT \'x\'::text,\n' +
	'  "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],\n' +
	'  CONSTRAINT "user_pkey" PRIMARY KEY ("id")\n' +
	");\n" +
	'CREATE TABLE "session" (\n' +
	'  "id" TEXT NOT NULL,\n' +
	'  "userId" TEXT NOT NULL,\n' +
	'  CONSTRAINT "session_pkey" PRIMARY KEY ("id"),\n' +
	'  CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId")\n' +
	'    REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE\n' +
	");\n" +
	'CREATE UNIQUE INDEX "user_email_key" ON "user"("email");\n' +
	'CREATE INDEX "session_userId_idx" ON "session"("userId");\n' +
	'ALTER TABLE "session" ADD CONSTRAINT "session_check"\n' +
	'  CHECK (length("id") > 0);\n' +
	'ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey_extra"\n' +
	'  FOREIGN KEY ("userId") REFERENCES "user"("id")\n' +
	'  ON DELETE SET NULL ON UPDATE CASCADE;\n';

function sha256(value) {
	const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
	return createHash("sha256").update(bytes).digest("hex");
}

function build(draftSql = MINIMAL_DRAFT, expectedTables = ["user"], expectedSha256 = sha256(draftSql)) {
	return buildValidationSql({ draftSql, expectedSha256, expectedTables });
}

function expectCode(code, callback) {
	assert.throws(callback, (error) => {
		assert.ok(error instanceof ValidationSqlError, "expected ValidationSqlError");
		assert.equal(error.code, code);
		return true;
	});
}

function expectDraftReject(code, draftSql, expectedTables = ["user"]) {
	expectCode(code, () =>
		buildValidationSql({
			draftSql,
			expectedSha256: sha256(draftSql),
			expectedTables,
		}),
	);
}

test("builds a deterministic rollback-only wrapper around the exact reviewed bytes", () => {
	const wrapper = build(MINIMAL_DRAFT, ["user"], MINIMAL_DRAFT_SHA256);

	assert.equal(sha256(MINIMAL_DRAFT), MINIMAL_DRAFT_SHA256);
	assert.ok(wrapper.includes(MINIMAL_DRAFT), "draft bytes must be embedded exactly");
	assert.equal(wrapper.split(MINIMAL_DRAFT).length - 1, 1);
	assert.equal(wrapper.includes("\\"), false, "generated wrapper must contain no backslash");

	for (const required of [
		"SESSIONPORT DRAFT ROLLBACK VALIDATION - NOT A MIGRATION OR DEPLOYMENT.",
		"BEGIN;",
		"SET LOCAL statement_timeout = '60s';",
		"SET LOCAL lock_timeout = '5s';",
		"SET LOCAL search_path = pg_catalog, public;",
		"SET LOCAL search_path = public;",
		"DO $sessionport_guard$",
		"DO $sessionport_assertions$",
		"SESSIONPORT_DRAFT_ASSERTIONS_OK",
		"ROLLBACK;",
		"BEGIN;",
		"DO $sessionport_empty$",
		"SESSIONPORT_ROLLBACK_VERIFIED",
	]) {
		assert.ok(wrapper.includes(required), `missing ${required}`);
	}

	const firstBegin = wrapper.indexOf("BEGIN;");
	const guard = wrapper.indexOf("DO $sessionport_guard$");
	const draftMarker = wrapper.indexOf("-- BEGIN EXTERNALLY REVIEWED");
	const draftStart = wrapper.indexOf(MINIMAL_DRAFT);
	const assertions = wrapper.indexOf("DO $sessionport_assertions$");
	const successMarker = wrapper.indexOf("SESSIONPORT_DRAFT_ASSERTIONS_OK");
	const firstRollback = wrapper.indexOf("ROLLBACK;");
	const secondBegin = wrapper.indexOf("BEGIN;", firstRollback + 1);
	const empty = wrapper.indexOf("DO $sessionport_empty$");
	const finalRollback = wrapper.indexOf("ROLLBACK;", secondBegin + 1);
	const rollbackMarker = wrapper.indexOf("SESSIONPORT_ROLLBACK_VERIFIED");

	assert.ok(firstBegin >= 0 && firstBegin < guard, "BEGIN before guard");
	assert.ok(guard < draftMarker && draftMarker < draftStart, "guard before draft");
	assert.ok(draftStart < assertions, "draft before assertions");
	assert.ok(assertions < successMarker, "assertions before success marker");
	assert.ok(successMarker < firstRollback, "success marker before first rollback");
	assert.ok(firstRollback < secondBegin, "first rollback before second transaction");
	assert.ok(secondBegin < empty, "second BEGIN before post-rollback empty assertion");
	assert.ok(empty < finalRollback, "empty assertion before final rollback");
	assert.ok(finalRollback < rollbackMarker, "final rollback before rollback-verified marker");

	assert.equal((wrapper.match(/\bBEGIN;/g) ?? []).length, 2);
	assert.equal((wrapper.match(/\bROLLBACK;/g) ?? []).length, 2);
	assert.equal(wrapper.includes("COMMIT;"), false);

	const second = build();
	assert.equal(second, wrapper);
});

test("accepts a complete known-shape Prisma DDL draft", () => {
	const wrapper = build(FULL_DRAFT, ["user", "session"]);
	assert.ok(wrapper.includes(FULL_DRAFT));
	assert.ok(wrapper.includes("IN ('user', 'session')"));
	assert.ok(wrapper.includes("(VALUES ('user'), ('session'))"));
	assert.ok(wrapper.includes("BEGIN EXTERNALLY REVIEWED"));
});

test("accepts Buffer input, uppercase hashes, and mixed-case expected table names", () => {
	const bytes = Buffer.from(MINIMAL_DRAFT, "utf8");
	const uppercaseHash = sha256(bytes).toUpperCase();
	const wrapper = buildValidationSql({
		draftSql: bytes,
		expectedSha256: uppercaseHash,
		expectedTables: ["user"],
	});
	assert.ok(wrapper.includes('"user"'));
	assert.equal(wrapper.includes(uppercaseHash), false, "wrapper must print the normalized lowercase hash");
	assert.ok(wrapper.includes(sha256(bytes)));

	const quotedDraft =
		'CREATE TABLE "user" ("id" TEXT NOT NULL, CONSTRAINT "user_pkey" PRIMARY KEY ("id"));\n' +
		'CREATE TABLE "User" ("id" TEXT NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id"));\n';
	const mixed = build(quotedDraft, ["user", "User"]);
	assert.ok(mixed.includes(quotedDraft));
	assert.ok(mixed.includes("IN ('user', 'User')"));
});

test("accepts exactly 256 KiB and rejects one byte over", () => {
	const paddingLength = MAX_DRAFT_BYTES - Buffer.byteLength(MINIMAL_DRAFT, "utf8");
	const boundaryDraft = MINIMAL_DRAFT + " ".repeat(paddingLength);
	assert.equal(Buffer.byteLength(boundaryDraft, "utf8"), MAX_DRAFT_BYTES);
	const wrapper = build(boundaryDraft);
	assert.ok(wrapper.includes(boundaryDraft));

	const oversizedDraft = `${boundaryDraft} `;
	expectDraftReject("DRAFT_TOO_LARGE", oversizedDraft);
});

test("accepts every supported known Prisma statement shape", () => {
	const draft =
		'CREATE SCHEMA IF NOT EXISTS "public";\n' +
		'CREATE TABLE IF NOT EXISTS "user" (\n' +
		'  "id" TEXT NOT NULL,\n' +
		'  "email" TEXT NOT NULL,\n' +
		'  CONSTRAINT "user_pkey" PRIMARY KEY ("id")\n' +
		");\n" +
		'CREATE TABLE IF NOT EXISTS "session" (\n' +
		'  "id" TEXT NOT NULL,\n' +
		'  "userId" TEXT NOT NULL,\n' +
		'  CONSTRAINT "session_pkey" PRIMARY KEY ("id")\n' +
		");\n" +
		'CREATE UNIQUE INDEX IF NOT EXISTS "user_email_key" ON "user"("email");\n' +
		'CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId" DESC NULLS LAST);\n' +
		'ALTER TABLE "user" ADD CONSTRAINT "user_email_uidx" UNIQUE ("email");\n' +
		'ALTER TABLE "user" ADD CONSTRAINT "user_pkey_alt" PRIMARY KEY ("id");\n' +
		'ALTER TABLE "session" ADD CONSTRAINT "session_user_fk"\n' +
		'  FOREIGN KEY ("userId") REFERENCES "user"("id")\n' +
		'  ON DELETE CASCADE ON UPDATE NO ACTION;\n' +
		'ALTER TABLE "session" ADD CONSTRAINT "session_check" CHECK (length("id") > 0);\n';
	const wrapper = build(draft, ["user", "session"]);
	assert.ok(wrapper.includes(draft));
});

test("rejects malformed hash and expected-table inputs", () => {
	expectCode("DRAFT_INPUT_TYPE", () => buildValidationSql({ draftSql: 42, expectedSha256: sha256(MINIMAL_DRAFT), expectedTables: ["user"] }));
	expectCode("DRAFT_INPUT_TYPE", () => buildValidationSql({ draftSql: {}, expectedSha256: sha256(MINIMAL_DRAFT), expectedTables: ["user"] }));
	expectCode("INPUT_INVALID", () => buildValidationSql(null));
	expectCode("INPUT_INVALID", () => buildValidationSql([]));

	for (const badHash of [
		undefined,
		null,
		"",
		"0".repeat(63),
		"0".repeat(65),
		"g".repeat(64),
		` ${"0".repeat(63)}`,
		`${"0".repeat(63)} `,
		123,
	]) {
		expectCode("EXPECTED_SHA256_INVALID", () =>
			buildValidationSql({
				draftSql: MINIMAL_DRAFT,
				expectedSha256: badHash,
				expectedTables: ["user"],
			}),
		);
	}

	expectCode("DRAFT_SHA256_MISMATCH", () =>
		buildValidationSql({
			draftSql: MINIMAL_DRAFT,
			expectedSha256: "0".repeat(64),
			expectedTables: ["user"],
		}),
	);

	for (const badTables of [
		undefined,
		null,
		"user",
		{},
		[],
		["user", "user"],
		["_prisma_migrations"],
		["1user"],
		["user-name"],
		["user name"],
		["user.name"],
		["user'name"],
		['user"name'],
		["user;name"],
		["user\\name"],
		["üser"],
		[""],
		["a".repeat(64)],
		Array.from({ length: 33 }, (_, index) => `t${index}`),
	]) {
		expectCode("EXPECTED_TABLES_INVALID", () =>
			buildValidationSql({
				draftSql: MINIMAL_DRAFT,
				expectedSha256: sha256(MINIMAL_DRAFT),
				expectedTables: badTables,
			}),
		);
	}

	const thirtyTwo = ["user", ...Array.from({ length: 31 }, (_, index) => `t${index}`)];
	const accepted = build(MINIMAL_DRAFT, thirtyTwo);
	assert.ok(accepted.includes("VALUES ('user'), ('t0'), ('t1')"));
});

test("rejects invalid encodings, BOMs, empty input, and control characters", () => {
	expectDraftReject("DRAFT_EMPTY", "");
	expectDraftReject("DRAFT_EMPTY", "   \n\t");
	expectDraftReject("DRAFT_NO_STATEMENTS", "-- comments only\n/* still only a comment */\n");

	expectCode("DRAFT_UTF8_INVALID", () =>
		buildValidationSql({
			draftSql: Buffer.from([0xff, 0xfe, 0xfd]),
			expectedSha256: "0".repeat(64),
			expectedTables: ["user"],
		}),
	);
	expectCode("DRAFT_UTF8_INVALID", () =>
		buildValidationSql({
			draftSql: "\ud800",
			expectedSha256: "0".repeat(64),
			expectedTables: ["user"],
		}),
	);

	const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MINIMAL_DRAFT, "utf8")]);
	expectCode("DRAFT_BOM_UNSUPPORTED", () =>
		buildValidationSql({
			draftSql: bom,
			expectedSha256: sha256(bom),
			expectedTables: ["user"],
		}),
	);

	expectDraftReject("DRAFT_CONTROL_CHARACTER", MINIMAL_DRAFT.replace("\n", "\u000b"));
	expectDraftReject("DRAFT_BACKSLASH", MINIMAL_DRAFT.replace("TEXT", "TEXT DEFAULT 'a\\b'"));
	expectDraftReject("DRAFT_BACKSLASH", `${MINIMAL_DRAFT}-- \\copy "user" FROM STDIN\n`);
	expectDraftReject("DRAFT_DOLLAR_QUOTE", MINIMAL_DRAFT.replace("TEXT", "$tag$TEXT$tag$"));
	expectDraftReject("DRAFT_PSQL_VARIABLE", MINIMAL_DRAFT.replace("NOT NULL", "DEFAULT :foo"));
	expectDraftReject("DRAFT_PSQL_VARIABLE", MINIMAL_DRAFT.replace("NOT NULL", 'DEFAULT :"foo"'));
	expectDraftReject("DRAFT_UNSUPPORTED_CHARACTER", MINIMAL_DRAFT.replace("NOT NULL", "DEFAULT ü"));
	expectDraftReject("DRAFT_UNTERMINATED_COMMENT", "/* never closed\n");
	expectDraftReject("DRAFT_UNTERMINATED_STRING", 'CREATE TABLE "user" ("id" TEXT DEFAULT \'x);\n');
	expectDraftReject("DRAFT_UNTERMINATED_IDENTIFIER", 'CREATE TABLE "user" ("id" TEXT DEFAULT "x);\n');
	expectDraftReject("DRAFT_UNTERMINATED_STATEMENT", MINIMAL_DRAFT.slice(0, -2));
	expectDraftReject("DRAFT_EMPTY_STATEMENT", ";");
	expectDraftReject("DRAFT_EMPTY_STATEMENT", `${MINIMAL_DRAFT};`);
});

test("terminates a trailing line comment before the wrapper's next statement", () => {
	const draft = `${MINIMAL_DRAFT}-- trailing comment without a newline`;
	const wrapper = build(draft);
	assert.ok(wrapper.includes(`${draft}\n-- END REVIEWED DRAFT`));
	assert.ok(wrapper.includes("-- END REVIEWED DRAFT\nSET LOCAL search_path = pg_catalog, public;"));
});

test("accepts harmless comments, nested block comments, semicolons in strings, and casts", () => {
	const draft =
		"-- COMMIT ROLLBACK are comments, not transaction control\n" +
		"/* outer /* nested */ still comment */\n" +
		'CREATE TABLE "user" (\n' +
		'  "id" TEXT NOT NULL,\n' +
		"  \"label\" TEXT DEFAULT 'a;b',\n" +
		'  "nickname" TEXT DEFAULT \'x\'::text,\n' +
		'  CONSTRAINT "user_pkey" PRIMARY KEY ("id")\n' +
		");\n";
	const wrapper = build(draft);
	assert.ok(wrapper.includes(draft));

	const unicodeStringDraft = MINIMAL_DRAFT.replace(
		'"id" TEXT NOT NULL',
		'"id" TEXT NOT NULL DEFAULT \'ümlaut\'',
	);
	assert.ok(build(unicodeStringDraft).includes(unicodeStringDraft));
});

test("rejects psql, transaction, admin, DDL-extension, and DML statements", () => {
	expectDraftReject("DRAFT_BACKSLASH", "\\i /tmp/included.sql\n");
	expectDraftReject("DRAFT_BACKSLASH", "\\set ON_ERROR_STOP off\n");
	expectDraftReject("DRAFT_TRANSACTION_CONTROL", "BEGIN;\n");
	expectDraftReject("DRAFT_TRANSACTION_CONTROL", `${MINIMAL_DRAFT}COMMIT;\n`);
	expectDraftReject("DRAFT_TRANSACTION_CONTROL", `${MINIMAL_DRAFT}ROLLBACK;\n`);
	expectDraftReject(
		"DRAFT_TRANSACTION_CONTROL",
		'CREATE TABLE "user" ("id" TEXT DEFAULT \'COMMIT\', CONSTRAINT "user_pkey" PRIMARY KEY ("id"));\n',
	);

	for (const statement of [
		"START TRANSACTION;",
		"SAVEPOINT one;",
		"RELEASE SAVEPOINT one;",
		"END;",
		"ABORT;",
	]) {
		expectDraftReject("DRAFT_UNSUPPORTED_STATEMENT", statement);
	}

	for (const statement of [
		'DROP TABLE "user";',
		'TRUNCATE "user";',
		'INSERT INTO "user" VALUES (1);',
		'UPDATE "user" SET "id" = \'x\';',
		'DELETE FROM "user";',
		'MERGE INTO "user" USING "user" ON true WHEN MATCHED THEN DELETE;',
		"SELECT 1;",
		"WITH x AS (SELECT 1) SELECT * FROM x;",
		'COPY "user" FROM STDIN;',
		"CREATE ROLE attacker;",
		"ALTER ROLE attacker;",
		"CREATE DATABASE attacker;",
		'CREATE EXTENSION "x";',
		'GRANT SELECT ON "user" TO attacker;',
		"ALTER SYSTEM SET x = 'y';",
		"SET search_path = public;",
		"RESET ALL;",
		"CALL x();",
		"VACUUM;",
		"ANALYZE;",
		'REINDEX TABLE "user";',
		'CLUSTER "user";',
		'LOCK TABLE "user";',
		'COMMENT ON TABLE "user" IS \'x\';',
		'SECURITY LABEL ON TABLE "user" IS \'x\';',
		"LISTEN x;",
		"NOTIFY x;",
		"LOAD 'x';",
		"CHECKPOINT;",
		"DISCARD ALL;",
		'CREATE TYPE "x" AS ENUM (\'a\');',
		'CREATE VIEW "v" AS SELECT 1;',
		'CREATE SEQUENCE "s";',
		'ALTER TABLE "user" ADD COLUMN "x" TEXT;',
		'ALTER TABLE "user" DROP COLUMN "id";',
		'ALTER TABLE "user" ALTER COLUMN "id" SET NOT NULL;',
		'ALTER TABLE "user" RENAME TO "u";',
		'ALTER TABLE "user" ADD PRIMARY KEY ("id");',
	]) {
		expectDraftReject("DRAFT_UNSUPPORTED_STATEMENT", statement);
	}
});

test("rejects unsupported or ambiguous CREATE TABLE shapes", () => {
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE TABLE "user" AS SELECT 1;\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE TABLE "user" ("id" TEXT) WITH (fillfactor=70);\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE TABLE "user" ("id" TEXT) INHERITS ("user");\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE TABLE "user" ("id" TEXT) PARTITION BY RANGE ("id");\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE TABLE "user" ("id" TEXT) TABLESPACE ts;\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE TABLE public."user" ("id" TEXT);\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE TABLE "user" ("id" TEXT;\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE TABLE "user" ("id" TEXT));\n',
	);
	expectDraftReject(
		"DRAFT_UNSUPPORTED_STATEMENT",
		'CREATE TABLE "user" (LIKE "user");\n',
	);
	expectDraftReject(
		"DRAFT_UNSUPPORTED_STATEMENT",
		'CREATE TABLE "user" ("id" TEXT, EXCLUDE USING gist ("id" WITH =));\n',
	);
	expectDraftReject(
		"DRAFT_UNSUPPORTED_STATEMENT",
		'CREATE TABLE "user" ("id" SERIAL);\n',
	);
	expectDraftReject(
		"DRAFT_UNSUPPORTED_STATEMENT",
		'CREATE TABLE "user" ("id" INTEGER GENERATED ALWAYS AS IDENTITY);\n',
	);
	expectDraftReject(
		"DRAFT_UNSUPPORTED_STATEMENT",
		'CREATE TABLE "user" ("id" TEXT DEFAULT nextval(\'s\'));\n',
	);
	expectDraftReject(
		"DRAFT_TABLE_NOT_EXPECTED",
		'CREATE TABLE "user" ("id" TEXT, CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "other"("id"));\n',
	);
	expectDraftReject(
		"DRAFT_TABLE_NOT_EXPECTED",
		'CREATE TABLE "other" ("id" TEXT NOT NULL);\n',
	);
	expectDraftReject(
		"DRAFT_UNSUPPORTED_IDENTIFIER",
		'CREATE TABLE "user name" ("id" TEXT);\n',
	);
});

test("rejects unsupported CREATE INDEX shapes and unexpected targets", () => {
	expectDraftReject(
		"DRAFT_UNSUPPORTED_STATEMENT",
		'CREATE INDEX CONCURRENTLY "i" ON "user"("id");\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE INDEX "i" ON "user" USING btree ("id");\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE INDEX "i" ON "user"("id") WHERE "id" IS NOT NULL;\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE INDEX "i" ON public."user"("id");\n',
	);
	expectDraftReject(
		"DRAFT_TABLE_NOT_EXPECTED",
		'CREATE INDEX "i" ON "unknown"("id");\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'CREATE UNIQUE TABLE "user" ("id" TEXT);\n',
	);
});

test("rejects unsupported ALTER TABLE shapes and extra actions", () => {
	expectDraftReject(
		"DRAFT_TABLE_NOT_EXPECTED",
		'ALTER TABLE "unknown" ADD CONSTRAINT "pk" PRIMARY KEY ("id");\n',
	);
	expectDraftReject(
		"DRAFT_TABLE_NOT_EXPECTED",
		'ALTER TABLE "user" ADD CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "unknown"("id");\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'ALTER TABLE "user" ADD CONSTRAINT "pk" PRIMARY KEY ("id"), DROP COLUMN "id";\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'ALTER TABLE "user" ADD CONSTRAINT "c" CHECK (true) NOT VALID;\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'ALTER TABLE "user" ADD CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "user"("id") NOT VALID;\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'ALTER TABLE "user" ADD CONSTRAINT "pk" PRIMARY KEY ("id";\n',
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		'ALTER TABLE "user" ADD CONSTRAINT "u" UNIQUE NULLS NOT DISTINCT ("id");\n',
	);
});

test("rejects malformed CREATE SCHEMA statements", () => {
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		"CREATE SCHEMA public;\n",
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		"CREATE SCHEMA IF NOT EXISTS other;\n",
	);
	expectDraftReject(
		"DRAFT_STATEMENT_SHAPE",
		"CREATE SCHEMA IF NOT EXISTS public AUTHORIZATION x;\n",
	);
});

test("renders target, privilege, emptiness, PK, and user.id guards", () => {
	const wrapper = build(FULL_DRAFT, ["user", "session"]);

	for (const guard of [
		"pg_catalog.current_database() <> 'session_port_validation'",
		"current_user <> 'sessionport_validation_migrator'",
		"session_user <> 'sessionport_validation_migrator'",
		"pg_catalog.pg_roles WHERE rolname = session_user",
		"rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls",
		"pg_catalog.current_setting('server_version_num')::integer / 10000 <> 16",
		"pg_catalog.pg_is_in_recovery()",
		"pg_catalog.current_setting('transaction_read_only') <> 'off'",
		"nspname::text NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_temp')",
		"nspname::text !~ '^pg_temp_[0-9]+$'",
		"nspname::text !~ '^pg_toast_temp_[0-9]+$'",
		"relkind IN ('r', 'p', 'v', 'm', 'f', 'S')",
		"typtype IN ('e', 'd', 'c', 'r', 'm')",
		"pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL",
		"relkind NOT IN ('r', 'i')",
		"index is not on an expected public base table",
		"expected table lacks a primary key",
		"primary key count mismatch",
		"pg_catalog.pg_attribute",
		"c.relname = 'user'",
		"a.attname = 'id'",
		"a.atttypid = 'pg_catalog.text'::pg_catalog.regtype",
		"VALUES ('user'), ('session')",
		"c.relname NOT IN ('user', 'session')",
		"SESSIONPORT_DRAFT_ASSERTIONS_OK",
		"SESSIONPORT_ROLLBACK_VERIFIED",
	]) {
		assert.ok(wrapper.includes(guard), `missing guard text: ${guard}`);
	}

	assert.equal(
		wrapper.includes("current_database() <> 'session_port'"),
		false,
		"the application database must not be a target",
	);
	assert.equal(wrapper.includes("foreign_key_count"), false);
	assert.equal(wrapper.includes("unique_constraint_count"), false);
	assert.equal(wrapper.includes("postgres://"), false);
	assert.equal(wrapper.includes("postgresql://"), false);
	assert.equal(wrapper.includes("PGPASSWORD"), false);
	const beforeDraft = wrapper.slice(0, wrapper.indexOf("-- BEGIN EXTERNALLY REVIEWED"));
	assert.equal(beforeDraft.includes("password"), false);
	const successMarkerStart = wrapper.indexOf("'SESSIONPORT_DRAFT_ASSERTIONS_OK'");
	const successMarkerEnd = wrapper.indexOf("ROLLBACK;", successMarkerStart);
	assert.equal(wrapper.slice(successMarkerStart, successMarkerEnd).includes("password"), false);
	assert.equal(wrapper.includes("SESSIONPORT_RUNTIME_DATABASE_URL"), false);
	assert.equal(wrapper.includes("SESSIONPORT_MIGRATOR_DATABASE_URL"), false);
	assert.equal(wrapper.includes("\\i"), false);
});
