#!/usr/bin/env node
/**
 * Deterministic preparation of the tracked Prisma schema and migration artifact.
 *
 * WHAT THIS DOES
 * - Reads the reviewed vendor Better Auth schema bytes and verifies their exact
 *   reviewed SHA-256 before assembly. Any byte drift fails closed.
 * - Invokes the existing pure `assembleAuthSchema(vendorBytes, "generated/client")`
 *   helper, then the narrow additive `transformBusinessSchema` helper, and
 *   writes the single derived `prisma/schema.prisma` file. The vendor
 *   datasource block and all 13 vendor models are preserved byte-for-byte,
 *   except for the seven reviewed virtual inverse relation fields on `User`.
 * - Reads the reviewed SQL draft, verifies its exact reviewed SHA-256 and DDL
 *   body SHA-256, then writes the initial Prisma migration artifact with a
 *   prepared, not-applied header followed by the reviewed DDL body bytes
 *   unchanged. The historical vendor-baseline schema hash in that header is
 *   intentionally retained and is not replaced with the combined schema hash.
 * - Does not generate, rewrite, or overwrite the separately reviewed
 *   `202610190002_project_quota` or `202610200003_protocol_native` migration
 *   artifacts.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * - It does not connect to PostgreSQL, apply a migration, create a database,
 *   role, user, extension, or `_prisma_migrations` row.
 * - It does not invoke Prisma, generate a client, or read any environment
 *   variable. The pinned Prisma CLI is invoked only by the package scripts.
 * - It does not parse, merge, format, or rewrite models, fields, relations,
 *   indexes, or SQL statements. It is not a Prisma or SQL parser.
 * - It does not infer or synthesize additional business models, fields,
 *   relations, indexes, or foreign keys beyond the fixed reviewed additive
 *   business/protocol transform.
 *
 * Run explicitly from `cloud/api`:
 *   node scripts/prepare-schema.mjs
 *
 * Importing this module has no side effects. `main` runs only when the file is
 * the process entry point.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembleAuthSchema } from "../schema-tools/assemble-auth-schema.mjs";
import { transformBusinessSchema } from "../schema-tools/assemble-business-schema.mjs";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VENDOR_SCHEMA_PATH = path.join(
	API_ROOT,
	"prisma",
	"auth.generated.prisma",
);
export const PREPARED_SCHEMA_PATH = path.join(
	API_ROOT,
	"prisma",
	"schema.prisma",
);
export const REVIEWED_DRAFT_PATH = path.join(
	API_ROOT,
	"prisma",
	"drafts",
	"0001_vendor_auth.sql",
);
export const PREPARED_MIGRATION_PATH = path.join(
	API_ROOT,
	"prisma",
	"migrations",
	"202610190001_vendor_auth",
	"migration.sql",
);

/**
 * Separately reviewed additive migration artifact. Preparation must not
 * regenerate or overwrite it; it is tracked and validated on its own.
 */
export const PROJECT_QUOTA_MIGRATION_PATH = path.join(
	API_ROOT,
	"prisma",
	"migrations",
	"202610190002_project_quota",
	"migration.sql",
);

/**
 * Separately reviewed M1-M3 protocol migration artifact. Preparation must not
 * regenerate or overwrite it; it is tracked and validated on its own.
 */
export const PROTOCOL_MIGRATION_PATH = path.join(
	API_ROOT,
	"prisma",
	"migrations",
	"202610200003_protocol_native",
	"migration.sql",
);

/** Relative to the prepared schema file; Prisma resolves it from `prisma/`. */
export const CLIENT_OUTPUT = "generated/client";

/** Exact reviewed vendor schema hash from docs/evidence/prisma-auth-offline.md. */
export const VENDOR_SCHEMA_SHA256 =
	"092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C";

/**
 * Historical hash of the prepared vendor-baseline schema for `CLIENT_OUTPUT`.
 * This value is embedded in the reviewed `202610190001_vendor_auth` header and
 * must not be replaced with the combined business-schema hash.
 */
export const VENDOR_BASELINE_SCHEMA_SHA256 =
	"5CF9B275F85B324587255F933ACA4297DDF1DACB4370E0A5D05C5A4DD4252FA2";

/** @deprecated Historical alias for `VENDOR_BASELINE_SCHEMA_SHA256`. */
export const PREPARED_SCHEMA_SHA256 = VENDOR_BASELINE_SCHEMA_SHA256;

/** Expected full combined business/protocol schema hash for `CLIENT_OUTPUT`. */
export const COMBINED_SCHEMA_SHA256 =
	"33161BC5C59388974652D9E562E0CB5A558B2DC91C2971AD50997DAAF856FBFA";

/** Exact reviewed draft hash from docs/evidence/prisma-auth-offline.md. */
export const REVIEWED_DRAFT_SHA256 =
	"09523E4601DC71D124477EC833861C90FF14F2D4C60BA023C8389DBA61E2A6EA";

/** SHA-256 of the reviewed draft's DDL body (its CLI stdout bytes). */
export const REVIEWED_DRAFT_BODY_SHA256 =
	"61229B920E30CA38F77F19AF6DD39246AEE095E834A8B76B6A8FA020A7709D40";

/** Expected deterministic prepared migration artifact hash. */
export const PREPARED_MIGRATION_SHA256 =
	"EFAB4C8E3CB87EAAC11B98D9613A0A2DC3B20826C22E04E31D2CBC091E6581CD";

/** Expected deterministic M1-M3 protocol migration artifact hash. */
export const PROTOCOL_MIGRATION_SHA256 =
	"82C420E972C6F7C50CDA9ED8E9C6C0407DB7D6DCE3EA76058DCCD14802EC9C26";

const DRAFT_BODY_START_MARKER = "-- CreateSchema\n";
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Fail-closed preparation error with a stable code. Messages never include
 * schema bytes, SQL bytes, environment values, or secrets.
 */
export class SchemaPreparationError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "SchemaPreparationError";
		this.code = code;
	}
}

function fail(code, message) {
	throw new SchemaPreparationError(code, message);
}

function sha256Upper(bytes) {
	return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function toBytes(value, label) {
	if (typeof value === "string") {
		return Buffer.from(value, "utf8");
	}
	if (value instanceof Uint8Array) {
		return Buffer.from(value);
	}
	fail("INPUT_INVALID", `${label} must be a string, Buffer, or Uint8Array`);
}

function requireExpectedHash(value, label) {
	if (typeof value !== "string" || !SHA256_HEX.test(value)) {
		fail("INPUT_INVALID", `${label} must be exactly 64 hexadecimal characters`);
	}
	return value.toUpperCase();
}

function requirePath(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		fail("INPUT_INVALID", `${label} must be a non-empty file path`);
	}
	return value;
}

function assertExactHash(bytes, expected, code, label) {
	const actual = sha256Upper(bytes);
	if (actual !== expected) {
		fail(code, `${label} SHA-256 does not match the reviewed value`);
	}
	return actual;
}

function readExact(filePath) {
	try {
		return readFileSync(filePath);
	} catch {
		fail("READ_FAILED", "a required reviewed input file could not be read");
	}
}

function writeIfChanged(filePath, bytes) {
	if (existsSync(filePath)) {
		let existing;
		try {
			existing = readFileSync(filePath);
		} catch {
			fail("WRITE_FAILED", "the derived output path could not be read");
		}
		if (existing.equals(bytes)) {
			return false;
		}
	}
	try {
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(filePath, bytes);
	} catch {
		fail("WRITE_FAILED", "the derived output file could not be written");
	}
	return true;
}

/**
 * Pure combined schema derivation from explicit vendor bytes.
 *
 * The vendor baseline is assembled first, then the fixed additive business
 * transform is applied. The returned `baselineSha256` is the historical
 * vendor-baseline hash used by the initial migration header; `sha256` is the
 * full combined schema hash.
 *
 * @param {string | Uint8Array} vendorBytesOrText
 * @param {{ expectedVendorSha256?: string }} [options]
 * @returns {{ bytes: Buffer, sha256: string, vendorSha256: string, baselineSha256: string, changed: false }}
 */
export function prepareSchemaBytes(vendorBytesOrText, options = {}) {
	const expectedVendorSha256 = requireExpectedHash(
		options.expectedVendorSha256 ?? VENDOR_SCHEMA_SHA256,
		"expectedVendorSha256",
	);
	const vendorBytes = toBytes(vendorBytesOrText, "vendorBytesOrText");
	const vendorSha256 = assertExactHash(
		vendorBytes,
		expectedVendorSha256,
		"VENDOR_SHA256_DRIFT",
		"vendor schema",
	);
	const baselineBytes = assembleAuthSchema(vendorBytes, CLIENT_OUTPUT);
	const baselineSha256 = sha256Upper(baselineBytes);
	const bytes = transformBusinessSchema(baselineBytes);
	return {
		bytes,
		sha256: sha256Upper(bytes),
		vendorSha256,
		baselineSha256,
		changed: false,
	};
}

/**
 * Pure migration derivation from explicit reviewed draft bytes.
 *
 * @param {string | Uint8Array} draftBytesOrText
 * @param {{ expectedDraftSha256?: string, expectedDraftBodySha256?: string }} [options]
 * @returns {{ bytes: Buffer, sha256: string, bodySha256: string }}
 */
export function prepareMigrationBytes(draftBytesOrText, options = {}) {
	const expectedDraftSha256 = requireExpectedHash(
		options.expectedDraftSha256 ?? REVIEWED_DRAFT_SHA256,
		"expectedDraftSha256",
	);
	const expectedBodySha256 = requireExpectedHash(
		options.expectedDraftBodySha256 ?? REVIEWED_DRAFT_BODY_SHA256,
		"expectedDraftBodySha256",
	);
	const draftBytes = toBytes(draftBytesOrText, "draftBytesOrText");
	assertExactHash(
		draftBytes,
		expectedDraftSha256,
		"DRAFT_SHA256_DRIFT",
		"reviewed draft",
	);

	const markerIndex = draftBytes.indexOf(DRAFT_BODY_START_MARKER);
	if (
		markerIndex < 0 ||
		markerIndex !== draftBytes.lastIndexOf(DRAFT_BODY_START_MARKER)
	) {
		fail(
			"DRAFT_BODY_SHAPE",
			"reviewed draft must contain exactly one DDL body start marker",
		);
	}

	const body = draftBytes.subarray(markerIndex);
	const bodySha256 = assertExactHash(
		body,
		expectedBodySha256,
		"DRAFT_BODY_SHA256_DRIFT",
		"reviewed draft body",
	);

	const header = Buffer.from(
		"-- Prepared Prisma migration artifact for the reviewed vendor authentication DDL.\n" +
			"-- Status: PREPARED_NOT_APPLIED. This file does not record or claim an applied migration.\n" +
			"-- Apply only through an explicit operator invocation of `npm run db:deploy` (or `bun run db:deploy`)\n" +
			"-- from cloud/api with SESSIONPORT_MIGRATOR_DATABASE_URL set in the process environment.\n" +
			"-- Preparation itself does not connect to PostgreSQL and does not create _prisma_migrations.\n" +
			"-- Source reviewed draft: cloud/api/prisma/drafts/0001_vendor_auth.sql\n" +
			`-- Source draft SHA-256: ${REVIEWED_DRAFT_SHA256}\n` +
			`-- Source DDL body SHA-256: ${REVIEWED_DRAFT_BODY_SHA256}\n` +
			`-- Source vendor schema SHA-256: ${VENDOR_SCHEMA_SHA256}\n` +
			`-- Prepared schema SHA-256: ${VENDOR_BASELINE_SCHEMA_SHA256}\n` +
			"-- Owner/server-reported validation: reviewed vendor DDL rollback on PostgreSQL 16.15\n" +
			"-- produced 13 tables and 13 primary keys, then 0 tables and 0 primary keys after\n" +
			"-- rollback; psql exit 0. This is not an independent PostgreSQL proof and does not\n" +
			"-- claim a migration-history row, server deployment, or production compatibility.\n" +
			"-- The SQL body below is the reviewed draft body copied byte-for-byte after its original header.\n" +
			"-- No business models, fields, or foreign keys are added. No database, role, extension,\n" +
			"-- or role/user account is created. `CREATE TABLE \"user\"` is a vendor table statement,\n" +
			"-- not a CREATE USER role statement. No CREATE/DROP DATABASE, ROLE, or EXTENSION\n" +
			"-- statement is present.\n" +
			"\n",
		"utf8",
	);

	const bytes = Buffer.concat([header, body]);
	return { bytes, sha256: sha256Upper(bytes), bodySha256 };
}

/**
 * Read, verify, assemble, transform, and write `prisma/schema.prisma`.
 *
 * @param {{
 *   vendorPath?: string,
 *   outputPath?: string,
 *   expectedVendorSha256?: string,
 * }} [options]
 * @returns {{ outputPath: string, bytes: number, sha256: string, vendorSha256: string, baselineSha256: string, changed: boolean }}
 */
export function prepareSchemaFile(options = {}) {
	const vendorPath = requirePath(
		options.vendorPath ?? VENDOR_SCHEMA_PATH,
		"vendorPath",
	);
	const outputPath = requirePath(
		options.outputPath ?? PREPARED_SCHEMA_PATH,
		"outputPath",
	);
	const vendorBytes = readExact(vendorPath);
	const prepared = prepareSchemaBytes(vendorBytes, {
		expectedVendorSha256: options.expectedVendorSha256,
	});
	const changed = writeIfChanged(outputPath, prepared.bytes);
	return {
		outputPath,
		bytes: prepared.bytes.length,
		sha256: prepared.sha256,
		vendorSha256: prepared.vendorSha256,
		baselineSha256: prepared.baselineSha256,
		changed,
	};
}

/**
 * Read, verify, transform, and write the prepared migration artifact.
 *
 * @param {{
 *   draftPath?: string,
 *   outputPath?: string,
 *   expectedDraftSha256?: string,
 *   expectedDraftBodySha256?: string,
 * }} [options]
 * @returns {{ outputPath: string, bytes: number, sha256: string, bodySha256: string, changed: boolean }}
 */
export function prepareMigrationFile(options = {}) {
	const draftPath = requirePath(
		options.draftPath ?? REVIEWED_DRAFT_PATH,
		"draftPath",
	);
	const outputPath = requirePath(
		options.outputPath ?? PREPARED_MIGRATION_PATH,
		"outputPath",
	);
	const draftBytes = readExact(draftPath);
	const prepared = prepareMigrationBytes(draftBytes, {
		expectedDraftSha256: options.expectedDraftSha256,
		expectedDraftBodySha256: options.expectedDraftBodySha256,
	});
	const changed = writeIfChanged(outputPath, prepared.bytes);
	return {
		outputPath,
		bytes: prepared.bytes.length,
		sha256: prepared.sha256,
		bodySha256: prepared.bodySha256,
		changed,
	};
}

/**
 * Prepare both tracked derived artifacts generated by this script. No
 * environment or database access. The separately reviewed project/quota and
 * protocol-native migrations are not prepared or written here.
 *
 * @returns {{ schema: ReturnType<typeof prepareSchemaFile>, migration: ReturnType<typeof prepareMigrationFile> }}
 */
export function prepareArtifacts() {
	return {
		schema: prepareSchemaFile(),
		migration: prepareMigrationFile(),
	};
}

function main() {
	try {
		const result = prepareArtifacts();
		process.stdout.write(
			`[db:prepare] schema ${result.schema.sha256} (${result.schema.bytes} bytes, ${result.schema.changed ? "written" : "unchanged"}); ` +
				`migration ${result.migration.sha256} (${result.migration.bytes} bytes, ${result.migration.changed ? "written" : "unchanged"})\n`,
		);
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? error.code
				: "UNKNOWN";
		process.stderr.write(`[db:prepare] failed: ${String(code)}\n`);
		process.exitCode = 1;
	}
}

const invokedDirectly = process.argv[1]
	? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
	: false;
if (invokedDirectly) main();
