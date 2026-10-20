/**
 * Focused offline tests for the deterministic Prisma preparation script.
 *
 * Run explicitly:
 *   node --test cloud/api/schema-tools/prepare-schema.node.mjs
 *
 * These tests read the reviewed vendor/draft/artifact files. Normal output
 * tests write only to owner-created temporary directories. One preparation
 * contract test invokes the default preparation path and asserts that both
 * tracked outputs are unchanged and the separately reviewed 0002 migration is
 * untouched. The tests do not read environment variables, connect to
 * PostgreSQL, invoke Prisma, or generate a client.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CLIENT_OUTPUT,
	COMBINED_SCHEMA_SHA256,
	PREPARED_MIGRATION_PATH,
	PREPARED_MIGRATION_SHA256,
	PREPARED_SCHEMA_PATH,
	PREPARED_SCHEMA_SHA256,
	PROJECT_QUOTA_MIGRATION_PATH,
	PROTOCOL_MIGRATION_PATH,
	PROTOCOL_MIGRATION_SHA256,
	REVIEWED_DRAFT_BODY_SHA256,
	REVIEWED_DRAFT_PATH,
	REVIEWED_DRAFT_SHA256,
	SchemaPreparationError,
	VENDOR_BASELINE_SCHEMA_SHA256,
	VENDOR_SCHEMA_PATH,
	VENDOR_SCHEMA_SHA256,
	prepareArtifacts,
	prepareMigrationBytes,
	prepareMigrationFile,
	prepareSchemaBytes,
	prepareSchemaFile,
} from "../scripts/prepare-schema.mjs";
import { BusinessSchemaAssemblyError } from "./assemble-business-schema.mjs";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREPARE_SCRIPT_PATH = path.join(API_ROOT, "scripts", "prepare-schema.mjs");

const VENDOR_BYTES = readFileSync(VENDOR_SCHEMA_PATH);
const DRAFT_BYTES = readFileSync(REVIEWED_DRAFT_PATH);
const DRAFT_BODY_START = DRAFT_BYTES.indexOf(Buffer.from("-- CreateSchema\n"));
const DRAFT_BODY = DRAFT_BYTES.subarray(DRAFT_BODY_START);

const COMBINED_BYTES_LENGTH = 16632;
const PROJECT_QUOTA_MIGRATION_SHA256 =
	"97C6B494D51CFAF15C9B2CC69B17720653086223510856D838B95211887E4550";
const DATASOURCE_MARKER = Buffer.from("\r\ndatasource db {");
const MODEL_MARKER = Buffer.from("\nmodel User {");

const SYNTHETIC_VENDOR = Buffer.from(
	'\ngenerator client {\n  provider = "prisma-client"\n}\r\n' +
		'\r\ndatasource db {\n  provider = "postgresql"\n}\r\n\n' +
		'model SyntheticThing {\n  id String @id\n}\n',
	"utf8",
);

const SYNTHETIC_DRAFT = Buffer.from(
	"-- synthetic test draft\n" +
		"-- This header is not the reviewed product draft.\n\n" +
		'-- CreateSchema\nCREATE SCHEMA IF NOT EXISTS "public";\n\n' +
		'-- CreateTable\nCREATE TABLE "user" (\n' +
		'  "id" TEXT NOT NULL,\n' +
		'  CONSTRAINT "user_pkey" PRIMARY KEY ("id")\n);\n',
	"utf8",
);
const SYNTHETIC_DRAFT_BODY_START = SYNTHETIC_DRAFT.indexOf(
	Buffer.from("-- CreateSchema\n"),
);
const SYNTHETIC_DRAFT_BODY = SYNTHETIC_DRAFT.subarray(
	SYNTHETIC_DRAFT_BODY_START,
);

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function tempDirectory(t) {
	const directory = mkdtempSync(
		path.join(tmpdir(), "sessionport-prepare-schema-"),
	);
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function expectCode(code, callback) {
	assert.throws(callback, (error) => {
		assert.ok(
			error instanceof SchemaPreparationError,
			"expected SchemaPreparationError",
		);
		assert.equal(error.code, code);
		return true;
	});
}

function expectBusinessCode(code, callback) {
	assert.throws(callback, (error) => {
		assert.ok(
			error instanceof BusinessSchemaAssemblyError,
			"expected BusinessSchemaAssemblyError",
		);
		assert.equal(error.code, code);
		return true;
	});
}

test("reviewed inputs and prepared artifacts match their recorded hashes", () => {
	assert.equal(VENDOR_BYTES.length, 9533);
	assert.equal(sha256(VENDOR_BYTES), VENDOR_SCHEMA_SHA256);

	assert.equal(DRAFT_BYTES.length, 12154);
	assert.equal(sha256(DRAFT_BYTES), REVIEWED_DRAFT_SHA256);
	assert.ok(DRAFT_BODY_START > 0, "reviewed draft body marker must exist");
	assert.equal(DRAFT_BODY.length, 11027);
	assert.equal(sha256(DRAFT_BODY), REVIEWED_DRAFT_BODY_SHA256);

	const preparedSchema = readFileSync(PREPARED_SCHEMA_PATH);
	assert.equal(preparedSchema.length, COMBINED_BYTES_LENGTH);
	assert.equal(sha256(preparedSchema), COMBINED_SCHEMA_SHA256);
	assert.equal(PREPARED_SCHEMA_SHA256, VENDOR_BASELINE_SCHEMA_SHA256);

	const preparedMigration = readFileSync(PREPARED_MIGRATION_PATH);
	assert.equal(sha256(preparedMigration), PREPARED_MIGRATION_SHA256);
	assert.deepEqual(preparedMigration.subarray(-DRAFT_BODY.length), DRAFT_BODY);

	const projectQuotaMigration = readFileSync(PROJECT_QUOTA_MIGRATION_PATH);
	assert.equal(sha256(projectQuotaMigration), PROJECT_QUOTA_MIGRATION_SHA256);
	assert.ok(
		projectQuotaMigration
			.toString("utf8")
			.startsWith('-- CreateEnum\nCREATE TYPE "ProjectState" AS ENUM (\'active\', \'purged\');\n'),
	);
	assert.ok(
		projectQuotaMigration
			.toString("utf8")
			.includes('CONSTRAINT "UserQuota_usage_within_limit_check" CHECK'),
	);

	const protocolMigration = readFileSync(PROTOCOL_MIGRATION_PATH);
	assert.equal(sha256(protocolMigration), PROTOCOL_MIGRATION_SHA256);
	const protocolSql = protocolMigration.toString("utf8");
	assert.ok(
		protocolSql.startsWith(
			'-- CreateEnum\nCREATE TYPE "UploadState" AS ENUM (\'uploading\', \'finalizing\', \'ready\', \'deleting\', \'deleted\', \'expired\');\n',
		),
	);
	for (const required of [
		'CREATE TYPE "NativeGrantState"',
		'CREATE TYPE "NativeAuthorizationState"',
		'ALTER TABLE "Project" ADD COLUMN     "nextSeq" BIGINT NOT NULL DEFAULT 1;',
		'CREATE TABLE "NativeDeviceGrant"',
		'CREATE TABLE "NativePendingAuthorization"',
		'CREATE TABLE "Revision"',
		'CREATE TABLE "Upload"',
		'CONSTRAINT "Device_grantID_fkey" FOREIGN KEY ("grantID") REFERENCES "NativeDeviceGrant"("id") ON DELETE RESTRICT',
		'CONSTRAINT "Revision_storageObjectKey_fkey" FOREIGN KEY ("storageObjectKey") REFERENCES "Upload"("finalKey") ON DELETE RESTRICT',
		'CONSTRAINT "Upload_ready_finalKey_check" CHECK',
		'CREATE UNIQUE INDEX "Upload_active_revision_intent_key"',
		`"deviceCodeFingerprint" ~ '^[0-9a-f]{64}$'`,
		`"fingerprint" ~ '^[0-9a-f]{64}$'`,
		'octet_length("ciphertextSha256") = 32',
		'octet_length("humanCodeDigest") = 32',
	]) {
		assert.ok(protocolSql.includes(required), `protocol migration must include ${required}`);
	}
	for (const forbidden of [
		"CREATE SCHEMA",
		"DROP TABLE",
		"DROP DATABASE",
		"CREATE ROLE",
		"CREATE USER",
		"CREATE EXTENSION",
		'ALTER TABLE "user"',
	]) {
		assert.equal(
			protocolSql.toUpperCase().includes(forbidden.toUpperCase()),
			false,
			`protocol migration must not contain ${forbidden}`,
		);
	}
});

test("derives the exact combined schema and preserves vendor model bytes", () => {
	const result = prepareSchemaBytes(VENDOR_BYTES);
	assert.equal(result.bytes.length, COMBINED_BYTES_LENGTH);
	assert.equal(result.sha256, COMBINED_SCHEMA_SHA256);
	assert.equal(result.vendorSha256, VENDOR_SCHEMA_SHA256);
	assert.equal(result.baselineSha256, VENDOR_BASELINE_SCHEMA_SHA256);

	const text = result.bytes.toString("utf8");
	const expectedHeader =
		'\ngenerator client {\n' +
		'  provider = "prisma-client"\n' +
		`  output   = "${CLIENT_OUTPUT}"\n` +
		'  moduleFormat = "esm"\n' +
		'  importFileExtension = "js"\n' +
		"}\r\n";
	assert.equal(
		result.bytes.subarray(0, Buffer.byteLength(expectedHeader)).toString("utf8"),
		expectedHeader,
	);

	const vendorDatasourceIndex = VENDOR_BYTES.indexOf(DATASOURCE_MARKER);
	const preparedDatasourceIndex = result.bytes.indexOf(DATASOURCE_MARKER);
	const vendorUserIndex = VENDOR_BYTES.indexOf(MODEL_MARKER);
	const preparedUserIndex = result.bytes.indexOf(MODEL_MARKER);
	assert.ok(vendorDatasourceIndex > 0);
	assert.ok(preparedDatasourceIndex > 0);
	assert.ok(preparedUserIndex > vendorDatasourceIndex);
	assert.deepEqual(
		result.bytes.subarray(preparedDatasourceIndex, preparedUserIndex),
		VENDOR_BYTES.subarray(vendorDatasourceIndex, vendorUserIndex),
	);
	assert.ok(
		text.includes(
			"  oauthconsents      OauthConsent[]\r\n" +
				"  projects           Project[]\r\n" +
				"  quota              UserQuota?\r\n" +
				"  devices            Device[]\r\n" +
				"  revisions          Revision[]\r\n" +
				"  uploads            Upload[]\r\n" +
				"  nativeDeviceGrants NativeDeviceGrant[]\r\n" +
				'  nativePendingAuthorizations NativePendingAuthorization[] @relation("NativePendingApprovedUser")\r\n',
		),
		"the seven virtual User fields must be present",
	);

	const sessionMarker = Buffer.from("\nmodel Session {");
	const vendorSessionIndex = VENDOR_BYTES.indexOf(sessionMarker);
	const preparedSessionIndex = result.bytes.indexOf(sessionMarker);
	assert.ok(vendorSessionIndex > 0);
	assert.ok(preparedSessionIndex > 0);
	assert.deepEqual(
		result.bytes.subarray(
			preparedSessionIndex,
			preparedSessionIndex + (VENDOR_BYTES.length - vendorSessionIndex),
		),
		VENDOR_BYTES.subarray(vendorSessionIndex),
	);

	assert.equal((text.match(/^generator\s+\w+\s*\{/gm) ?? []).length, 1);
	assert.equal((text.match(/^datasource\s+\w+\s*\{/gm) ?? []).length, 1);
	assert.equal((text.match(/^model\s+\w+\s*\{/gm) ?? []).length, 23);
	assert.equal((text.match(/^enum\s+\w+\s*\{/gm) ?? []).length, 4);
	assert.equal(text.includes('provider = "prisma-client-js"'), false);
	for (const forbidden of [
		"model DeviceGrant {",
		"model AccountKeyBundle {",
	]) {
		assert.equal(text.includes(forbidden), false, `unexpected ${forbidden}`);
	}
	for (const expected of [
		"model Device {",
		"model NativeDeviceGrant {",
		"model NativePendingAuthorization {",
		"model Revision {",
		"model ProjectHead {",
		"model Upload {",
	]) {
		assert.ok(text.includes(expected), `missing ${expected}`);
	}

	const second = prepareSchemaBytes(VENDOR_BYTES);
	assert.deepEqual(second.bytes, result.bytes);
	assert.equal(second.sha256, result.sha256);
	assert.deepEqual(prepareSchemaBytes(VENDOR_BYTES.toString("utf8")).bytes, result.bytes);
});

test("writes deterministic combined schema output to a temp-owned path", (t) => {
	const directory = tempDirectory(t);
	const vendorPath = path.join(directory, "auth.generated.prisma");
	const outputPath = path.join(directory, "nested", "schema.prisma");
	writeFileSync(vendorPath, VENDOR_BYTES);

	const first = prepareSchemaFile({ vendorPath, outputPath });
	assert.equal(first.changed, true);
	assert.equal(first.sha256, COMBINED_SCHEMA_SHA256);
	assert.equal(first.baselineSha256, VENDOR_BASELINE_SCHEMA_SHA256);
	assert.equal(existsSync(outputPath), true);
	assert.equal(first.sha256, sha256(readFileSync(outputPath)));
	assert.equal(
		readFileSync(outputPath).subarray(0, 3).toString("hex"),
		"0a6765",
		"output must not start with a UTF-8 BOM",
	);

	const outputBytes = readFileSync(outputPath);
	assert.equal(
		outputBytes.toString("utf8").startsWith(
			'\ngenerator client {\n  provider = "prisma-client"\n' +
				`  output   = "${CLIENT_OUTPUT}"\n`,
		),
		true,
	);
	assert.equal(
		outputBytes.toString("utf8").endsWith(
			"model Upload {\n" +
				"  uploadID         String       @id @db.Uuid\n" +
				"  userID           String\n" +
				"  user             User         @relation(fields: [userID], references: [id], onDelete: Restrict)\n" +
				"  projectID        String       @db.Uuid\n" +
				"  project          Project      @relation(fields: [projectID], references: [projectID], onDelete: Restrict)\n" +
				"  deviceID         String       @db.Uuid\n" +
				"  device           Device       @relation(fields: [deviceID], references: [id], onDelete: Restrict)\n" +
				"  revisionID       String       @db.Uuid\n" +
				"  parentRevisionID String?      @db.Uuid\n" +
				'  parentRevision   Revision?    @relation("UploadParentRevision", fields: [parentRevisionID], references: [revisionID], onDelete: Restrict)\n' +
				"  keyEpoch         Int\n" +
				"  stagingKey       String       @unique\n" +
				"  finalKey         String?      @unique\n" +
				"  state            UploadState  @default(uploading)\n" +
				"  sizeBytes        BigInt\n" +
				"  ciphertextSha256 Bytes\n" +
				"  leaseToken       BigInt       @default(0)\n" +
				"  leaseOwner       String?\n" +
				"  leaseExpiresAt   DateTime?\n" +
				"  expiresAt        DateTime\n" +
				"  graceExpiresAt   DateTime?\n" +
				"  createdAt        DateTime     @default(now())\n" +
				"  completedAt      DateTime?\n" +
				"\n" +
				'  committedRevision Revision? @relation("RevisionStorageObject")\n' +
				"\n" +
				"  @@index([userID, state])\n" +
				"  @@index([projectID, revisionID])\n" +
				"  @@index([state, expiresAt])\n" +
				"  @@index([state, leaseExpiresAt])\n" +
				"}\n",
		),
		true,
	);

	const second = prepareSchemaFile({ vendorPath, outputPath });
	assert.equal(second.changed, false);
	assert.equal(second.sha256, first.sha256);
});

test("fails closed before writing when the baseline has no exact User anchor", (t) => {
	const directory = tempDirectory(t);
	const vendorPath = path.join(directory, "auth.generated.prisma");
	const outputPath = path.join(directory, "schema.prisma");
	writeFileSync(vendorPath, SYNTHETIC_VENDOR);

	expectBusinessCode("USER_ANCHOR_MISSING", () =>
		prepareSchemaFile({
			vendorPath,
			outputPath,
			expectedVendorSha256: sha256(SYNTHETIC_VENDOR),
		}),
	);
	assert.equal(existsSync(outputPath), false);
});

test("fails closed on vendor hash drift before any output write", (t) => {
	const directory = tempDirectory(t);
	const vendorPath = path.join(directory, "auth.generated.prisma");
	const outputPath = path.join(directory, "schema.prisma");
	const drifted = Buffer.from(VENDOR_BYTES);
	drifted[drifted.length - 1] ^= 0x01;
	writeFileSync(vendorPath, drifted);

	expectCode("VENDOR_SHA256_DRIFT", () =>
		prepareSchemaFile({ vendorPath, outputPath }),
	);
	assert.equal(existsSync(outputPath), false);

	expectCode("INPUT_INVALID", () =>
		prepareSchemaBytes(VENDOR_BYTES, { expectedVendorSha256: "not-a-hash" }),
	);
});

test("derives the prepared migration from the exact reviewed body", () => {
	const result = prepareMigrationBytes(DRAFT_BYTES);
	assert.equal(result.sha256, PREPARED_MIGRATION_SHA256);
	assert.equal(result.bodySha256, REVIEWED_DRAFT_BODY_SHA256);

	const text = result.bytes.toString("utf8");
	assert.ok(
		text.startsWith(
			"-- Prepared Prisma migration artifact for the reviewed vendor authentication DDL.\n" +
				"-- Status: PREPARED_NOT_APPLIED.",
		),
	);
	assert.ok(text.includes(`-- Source draft SHA-256: ${REVIEWED_DRAFT_SHA256}`));
	assert.ok(
		text.includes(
			`-- Source DDL body SHA-256: ${REVIEWED_DRAFT_BODY_SHA256}`,
		),
	);
	assert.ok(text.includes(`-- Source vendor schema SHA-256: ${VENDOR_SCHEMA_SHA256}`));
	assert.ok(text.includes(`-- Prepared schema SHA-256: ${PREPARED_SCHEMA_SHA256}`));
	assert.ok(text.includes("PostgreSQL 16.15"));
	assert.ok(text.includes("13 tables and 13 primary keys"));
	assert.equal(text.includes("DRAFTGENERATEDOFFLINE"), false);
	assert.equal(text.includes("NOT_APPLIED_NOT_POSTGRES16_VERIFIED"), false);
	assert.deepEqual(result.bytes.subarray(-DRAFT_BODY.length), DRAFT_BODY);

	const second = prepareMigrationBytes(DRAFT_BYTES);
	assert.deepEqual(second.bytes, result.bytes);
	assert.equal(second.sha256, result.sha256);
});

test("writes migration output to a temp path and fails closed on draft drift", (t) => {
	const directory = tempDirectory(t);
	const outputPath = path.join(directory, "migration.sql");

	const first = prepareMigrationFile({
		draftPath: REVIEWED_DRAFT_PATH,
		outputPath,
	});
	assert.equal(first.changed, true);
	assert.equal(first.sha256, PREPARED_MIGRATION_SHA256);
	assert.deepEqual(readFileSync(outputPath).subarray(-DRAFT_BODY.length), DRAFT_BODY);

	const second = prepareMigrationFile({
		draftPath: REVIEWED_DRAFT_PATH,
		outputPath,
	});
	assert.equal(second.changed, false);
	assert.equal(second.sha256, first.sha256);

	const driftedPath = path.join(directory, "drifted.sql");
	const driftedOutput = path.join(directory, "drifted-migration.sql");
	const drifted = Buffer.from(DRAFT_BYTES);
	drifted[drifted.length - 1] ^= 0x01;
	writeFileSync(driftedPath, drifted);
	expectCode("DRAFT_SHA256_DRIFT", () =>
		prepareMigrationFile({ draftPath: driftedPath, outputPath: driftedOutput }),
	);
	assert.equal(existsSync(driftedOutput), false);

	const synthetic = prepareMigrationBytes(SYNTHETIC_DRAFT, {
		expectedDraftSha256: sha256(SYNTHETIC_DRAFT),
		expectedDraftBodySha256: sha256(SYNTHETIC_DRAFT_BODY),
	});
	assert.deepEqual(
		synthetic.bytes.subarray(-SYNTHETIC_DRAFT_BODY.length),
		SYNTHETIC_DRAFT_BODY,
	);

	const noMarker = Buffer.from("-- no body marker\nCREATE TABLE \"user\" (\"id\" TEXT);\n");
	expectCode("DRAFT_BODY_SHAPE", () =>
		prepareMigrationBytes(noMarker, {
			expectedDraftSha256: sha256(noMarker),
			expectedDraftBodySha256: sha256(noMarker),
		}),
	);
});

test("preparation does not regenerate or overwrite the project/quota or protocol migrations", () => {
	const projectQuotaBefore = readFileSync(PROJECT_QUOTA_MIGRATION_PATH);
	const protocolBefore = readFileSync(PROTOCOL_MIGRATION_PATH);

	const result = prepareArtifacts();
	assert.equal(result.schema.sha256, COMBINED_SCHEMA_SHA256);
	assert.equal(result.schema.changed, false);
	assert.equal(result.migration.sha256, PREPARED_MIGRATION_SHA256);
	assert.equal(result.migration.changed, false);
	assert.deepEqual(readFileSync(PROJECT_QUOTA_MIGRATION_PATH), projectQuotaBefore);
	assert.equal(sha256(projectQuotaBefore), PROJECT_QUOTA_MIGRATION_SHA256);
	assert.deepEqual(readFileSync(PROTOCOL_MIGRATION_PATH), protocolBefore);
	assert.equal(sha256(protocolBefore), PROTOCOL_MIGRATION_SHA256);
});

test("importing the prepare script has no side effects", () => {
	const schemaBefore = sha256(readFileSync(PREPARED_SCHEMA_PATH));
	const migrationBefore = sha256(readFileSync(PREPARED_MIGRATION_PATH));
	const projectQuotaBefore = sha256(readFileSync(PROJECT_QUOTA_MIGRATION_PATH));
	const protocolBefore = sha256(readFileSync(PROTOCOL_MIGRATION_PATH));

	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`await import(${JSON.stringify(pathToFileURL(PREPARE_SCRIPT_PATH).href)});`,
		],
		{
			cwd: API_ROOT,
			encoding: "utf8",
			windowsHide: true,
			timeout: 30_000,
		},
	);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
	assert.equal(sha256(readFileSync(PREPARED_SCHEMA_PATH)), schemaBefore);
	assert.equal(
		sha256(readFileSync(PREPARED_MIGRATION_PATH)),
		migrationBefore,
	);
	assert.equal(
		sha256(readFileSync(PROJECT_QUOTA_MIGRATION_PATH)),
		projectQuotaBefore,
	);
	assert.equal(
		sha256(readFileSync(PROTOCOL_MIGRATION_PATH)),
		protocolBefore,
	);
});
