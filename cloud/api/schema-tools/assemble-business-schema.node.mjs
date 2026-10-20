/**
 * Focused offline tests for the additive business/protocol schema transform.
 *
 * Run explicitly:
 *   node --test cloud/api/schema-tools/assemble-business-schema.node.mjs
 *
 * These tests read the reviewed vendor artifact and assemble in memory. They do
 * not write files, read environment variables, invoke a CLI, or connect to a
 * database.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assembleAuthSchema } from "./assemble-auth-schema.mjs";
import {
	BusinessSchemaAssemblyError,
	BUSINESS_MODELS_TEXT,
	transformBusinessSchema,
	USER_END_ANCHOR,
	USER_END_ANCHOR_SHA256,
	USER_END_FIELD_ANCHOR,
	USER_FIELDS_TEXT,
} from "./assemble-business-schema.mjs";

const VENDOR_PATH = fileURLToPath(
	new URL("../prisma/auth.generated.prisma", import.meta.url),
);
const VENDOR_BYTES = readFileSync(VENDOR_PATH);
const VENDOR_BYTES_LENGTH = 9533;
const VENDOR_SHA256 =
	"092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C";
const CLIENT_OUTPUT = "generated/client";
const BASELINE_SHA256 =
	"5CF9B275F85B324587255F933ACA4297DDF1DACB4370E0A5D05C5A4DD4252FA2";
const COMBINED_SCHEMA_SHA256 =
	"33161BC5C59388974652D9E562E0CB5A558B2DC91C2971AD50997DAAF856FBFA";
const COMBINED_BYTES_LENGTH = 16632;

const BASELINE = assembleAuthSchema(VENDOR_BYTES, CLIENT_OUTPUT);

const EXPECTED_USER_END_WITH_FIELDS =
	USER_END_FIELD_ANCHOR +
	USER_FIELDS_TEXT +
	"\r\n" +
	'  @@unique([email])\r\n  @@map("user")\n}\r\n';

const EXPECTED_PROJECT_MODEL =
	"model Project {\n" +
	"  projectID      String       @id @db.Uuid\n" +
	"  userID         String\n" +
	"  user           User         @relation(fields: [userID], references: [id], onDelete: Restrict)\n" +
	"  encryptedLabel Bytes?\n" +
	"  state          ProjectState @default(active)\n" +
	"  nextSeq        BigInt       @default(1)\n" +
	"  createdAt      DateTime     @default(now())\n" +
	"\n" +
	"  revisions Revision[]\n" +
	"  heads     ProjectHead[]\n" +
	"  uploads   Upload[]\n" +
	"\n" +
	"  @@index([userID, state])\n" +
	"}\n";

const EXPECTED_USER_QUOTA_MODEL =
	"model UserQuota {\n" +
	"  userID        String   @id\n" +
	"  user          User     @relation(fields: [userID], references: [id], onDelete: Restrict)\n" +
	"  limitBytes    BigInt\n" +
	"  usedBytes     BigInt   @default(0)\n" +
	"  reservedBytes BigInt   @default(0)\n" +
	"  updatedAt     DateTime @updatedAt\n" +
	"}\n";

const EXPECTED_BUSINESS_MODELS = [
	"Device",
	"NativeDeviceGrant",
	"NativePendingAuthorization",
	"NativeAccessToken",
	"NativeRefreshToken",
	"Revision",
	"ProjectHead",
	"Upload",
];

const EXPECTED_BUSINESS_ENUMS = [
	"ProjectState",
	"NativeGrantState",
	"NativeAuthorizationState",
	"UploadState",
];

function modelBlock(text, name) {
	const match = new RegExp(`\\nmodel ${name} \\{\\n([\\s\\S]*?)\\n\\}\\n`).exec(text);
	assert.ok(match, `model ${name} must exist`);
	return match[1];
}

function assertFragment(block, fragment) {
	assert.ok(block.includes(fragment), `expected model fragment: ${fragment}`);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function expectCode(code, callback) {
	assert.throws(callback, (error) => {
		assert.ok(
			error instanceof BusinessSchemaAssemblyError,
			"expected BusinessSchemaAssemblyError",
		);
		assert.equal(error.code, code);
		return true;
	});
}

test("reviewed vendor input and derived baseline remain pinned", () => {
	assert.equal(VENDOR_BYTES.length, VENDOR_BYTES_LENGTH);
	assert.equal(sha256(VENDOR_BYTES), VENDOR_SHA256);
	assert.equal(BASELINE.length, 9617);
	assert.equal(sha256(BASELINE), BASELINE_SHA256);

	assert.equal(sha256(Buffer.from(USER_END_ANCHOR, "utf8")), USER_END_ANCHOR_SHA256);
	const baselineText = BASELINE.toString("utf8");
	assert.equal(
		baselineText.split(USER_END_ANCHOR).length - 1,
		1,
		"baseline must contain exactly one User end anchor",
	);
});

test("adds only seven virtual User fields and the fixed business declarations", () => {
	const combined = transformBusinessSchema(BASELINE);
	const text = combined.toString("utf8");

	assert.equal(combined.length, COMBINED_BYTES_LENGTH);
	assert.equal(sha256(combined), COMBINED_SCHEMA_SHA256);

	assert.equal(
		text.split(EXPECTED_USER_END_WITH_FIELDS).length - 1,
		1,
		"expected User end with exactly the seven inserted fields",
	);
	assert.equal(text.endsWith(BUSINESS_MODELS_TEXT), true);

	const projectStart = text.indexOf("model Project {");
	const quotaStart = text.indexOf("model UserQuota {");
	assert.ok(projectStart > 0, "Project model must exist");
	assert.ok(quotaStart > projectStart, "UserQuota model must follow Project");
	assert.equal(
		text.slice(projectStart, quotaStart),
		`${EXPECTED_PROJECT_MODEL}\n`,
	);
	assert.equal(text.slice(quotaStart, quotaStart + EXPECTED_USER_QUOTA_MODEL.length), EXPECTED_USER_QUOTA_MODEL);

	assert.equal((text.match(/^model\s+\w+\s*\{/gm) ?? []).length, 23);
	assert.equal((text.match(/^enum\s+\w+\s*\{/gm) ?? []).length, 4);
	for (const name of EXPECTED_BUSINESS_MODELS) {
		assert.ok(text.includes(`\nmodel ${name} {`), `model ${name} must exist`);
	}
	for (const name of EXPECTED_BUSINESS_ENUMS) {
		assert.ok(text.includes(`\nenum ${name} {`), `enum ${name} must exist`);
	}
	assert.equal(text.includes("model AccountKeyBundle {"), false);

	// The inserted User fields are relation metadata only.
	const userStart = text.indexOf("model User {");
	const userEnd = text.indexOf("model Session {");
	const userBlock = text.slice(userStart, userEnd);
	for (const field of [
		"  projects           Project[]",
		"  quota              UserQuota?",
		"  devices            Device[]",
		"  revisions          Revision[]",
		"  uploads            Upload[]",
		"  nativeDeviceGrants NativeDeviceGrant[]",
		'  nativePendingAuthorizations NativePendingAuthorization[] @relation("NativePendingApprovedUser")',
	]) {
		assert.ok(userBlock.includes(field), `missing User relation field: ${field}`);
	}
	assert.equal(/\bprojectID\b/.test(userBlock), false);
	assert.equal(/\blimitBytes\b/.test(userBlock), false);
	assert.equal(/\busedBytes\b/.test(userBlock), false);
	assert.equal(/\breservedBytes\b/.test(userBlock), false);
});

test("records the frozen durable device and native grant contract", () => {
	const text = transformBusinessSchema(BASELINE).toString("utf8");

	const device = modelBlock(text, "Device");
	assertFragment(device, "  grantID    String   @unique @db.Uuid");
	assertFragment(device, "  grant      NativeDeviceGrant @relation(fields: [grantID], references: [id], onDelete: Restrict)");
	assertFragment(device, "  lastSeenAt DateTime?");
	assert.equal(/\b(status|name|revokedAt)\b/.test(device.replace("lastSeenAt", "")), false);

	const grant = modelBlock(text, "NativeDeviceGrant");
	for (const fragment of [
		"  id        String           @id @db.Uuid",
		"  userID    String",
		"  status    NativeGrantState @default(active)",
		"  audience  String",
		"  resource  String",
		"  scopes    String[]",
		"  createdAt DateTime         @default(now())",
		"  expiresAt DateTime",
		"  revokedAt DateTime?",
		"  device       Device?",
		"  accessTokens NativeAccessToken[]",
		"  refreshTokens NativeRefreshToken[]",
	]) {
		assertFragment(grant, fragment);
	}
	assert.equal(grant.includes("session"), false, "no browser session token is cached in a grant");

	const pending = modelBlock(text, "NativePendingAuthorization");
	for (const fragment of [
		"  deviceCodeFingerprint String                   @unique",
		"  humanCodeDigest       Bytes",
		"  humanCodeKeyID        String",
		"  status                NativeAuthorizationState @default(pending)",
		"  approvedUserID        String?",
		"  audience              String",
		"  resource              String",
		"  scopes                String[]",
		"  createdAt             DateTime                 @default(now())",
		"  expiresAt             DateTime",
		"  lastPolledAt          DateTime?",
		"  nextPollAt            DateTime?",
		"  pollIntervalSeconds   Int",
		"  consumedAt            DateTime?",
		"  @@unique([humanCodeKeyID, humanCodeDigest])",
		"  @@index([status, expiresAt])",
		"  @@index([expiresAt])",
	]) {
		assertFragment(pending, fragment);
	}
	assert.equal(/humanCode[^D]*String|deviceCode[^F]*String/.test(pending), false, "no raw code column");

	const access = modelBlock(text, "NativeAccessToken");
	assertFragment(access, "  fingerprint String            @unique");
	assertFragment(access, "  grantID     String            @db.Uuid");
	assertFragment(access, "  expiresAt   DateTime");

	const refresh = modelBlock(text, "NativeRefreshToken");
	for (const fragment of [
		"  fingerprint String             @unique",
		"  spentAt     DateTime?",
		"  successorID String?            @unique @db.Uuid",
		'  successor   NativeRefreshToken? @relation("NativeRefreshRotation", fields: [successorID], references: [id], onDelete: Restrict)',
		"  predecessor NativeRefreshToken? @relation(\"NativeRefreshRotation\")",
	]) {
		assertFragment(refresh, fragment);
	}

	for (const name of ["NativeGrantState", "NativeAuthorizationState"]) {
		const block = new RegExp(`enum ${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(text);
		assert.ok(block, `enum ${name} must exist`);
	}
	assert.ok(text.includes("enum NativeGrantState {\n  active\n  revoked\n}"));
	assert.ok(
		text.includes(
			"enum NativeAuthorizationState {\n  pending\n  approved\n  denied\n  consumed\n}",
		),
	);
});

test("records the frozen project, revision, head, and upload contract", () => {
	const text = transformBusinessSchema(BASELINE).toString("utf8");

	const project = modelBlock(text, "Project");
	assertFragment(project, "  nextSeq        BigInt       @default(1)");
	assertFragment(project, "  revisions Revision[]");
	assertFragment(project, "  heads     ProjectHead[]");
	assertFragment(project, "  uploads   Upload[]");

	const revision = modelBlock(text, "Revision");
	for (const fragment of [
		"  revisionID       String    @id @db.Uuid",
		"  projectID        String    @db.Uuid",
		"  parentRevisionID String?   @db.Uuid",
		'  parentRevision   Revision? @relation("RevisionParent", fields: [parentRevisionID], references: [revisionID], onDelete: Restrict)',
		"  childRevisions   Revision[] @relation(\"RevisionParent\")",
		"  seq              BigInt",
		"  deviceID         String    @db.Uuid",
		"  keyEpoch         Int",
		"  sizeBytes        BigInt",
		"  ciphertextSha256 Bytes",
		"  storageObjectKey String    @unique",
		'  storageUpload    Upload    @relation("RevisionStorageObject", fields: [storageObjectKey], references: [finalKey], onDelete: Restrict)',
		"  @@unique([projectID, seq])",
		"  @@index([parentRevisionID])",
	]) {
		assertFragment(revision, fragment);
	}

	const head = modelBlock(text, "ProjectHead");
	assertFragment(head, "  @@id([projectID, revisionID])");
	assertFragment(head, "  @@index([revisionID])");

	const upload = modelBlock(text, "Upload");
	for (const fragment of [
		"  revisionID       String       @db.Uuid",
		"  parentRevisionID String?      @db.Uuid",
		'  parentRevision   Revision?    @relation("UploadParentRevision", fields: [parentRevisionID], references: [revisionID], onDelete: Restrict)',
		"  keyEpoch         Int",
		"  stagingKey       String       @unique",
		"  finalKey         String?      @unique",
		"  state            UploadState  @default(uploading)",
		"  sizeBytes        BigInt",
		"  ciphertextSha256 Bytes",
		"  leaseToken       BigInt       @default(0)",
		"  leaseOwner       String?",
		"  leaseExpiresAt   DateTime?",
		"  expiresAt        DateTime",
		"  graceExpiresAt   DateTime?",
		"  completedAt      DateTime?",
		"  @@index([userID, state])",
		"  @@index([projectID, revisionID])",
		"  @@index([state, expiresAt])",
		"  @@index([state, leaseExpiresAt])",
	]) {
		assertFragment(upload, fragment);
	}
	assert.equal(/\brevision\s+Revision\s+@relation/.test(upload), false, "revisionID is an intent without an FK");
	assert.ok(
		text.includes(
			"enum UploadState {\n  uploading\n  finalizing\n  ready\n  deleting\n  deleted\n  expired\n}",
		),
	);
});

test("is deterministic across byte input, text input, and repeated calls", () => {
	const first = transformBusinessSchema(BASELINE);
	const second = transformBusinessSchema(BASELINE);
	const fromText = transformBusinessSchema(BASELINE.toString("utf8"));
	const copiedInput = Uint8Array.from(BASELINE);
	const fromUint8Array = transformBusinessSchema(copiedInput);

	assert.deepEqual(second, first);
	assert.deepEqual(fromText, first);
	assert.deepEqual(fromUint8Array, first);
	assert.equal(sha256(first), COMBINED_SCHEMA_SHA256);
	assert.equal(sha256(second), COMBINED_SCHEMA_SHA256);
});

test("removing the fixed additions restores the baseline bytes exactly", () => {
	const combined = transformBusinessSchema(BASELINE);
	const combinedText = combined.toString("utf8");

	const withoutFields = combinedText.replace(
		USER_FIELDS_TEXT,
		"",
	);
	assert.equal(
		withoutFields.includes(USER_FIELDS_TEXT),
		false,
		"the inserted field text must be unique",
	);

	const withoutBusiness = Buffer.from(
		withoutFields.slice(0, -BUSINESS_MODELS_TEXT.length),
		"utf8",
	);
	assert.deepEqual(withoutBusiness, BASELINE);
	assert.equal(sha256(withoutBusiness), BASELINE_SHA256);

	// Every vendor model after User is byte-identical to the baseline.
	const vendorModelMarker = Buffer.from("\nmodel Session {");
	const vendorModelIndex = BASELINE.indexOf(vendorModelMarker);
	const combinedModelIndex = combined.indexOf(vendorModelMarker);
	assert.ok(vendorModelIndex > 0);
	assert.ok(combinedModelIndex > 0);
	assert.deepEqual(
		combined.subarray(combinedModelIndex, combinedModelIndex + (BASELINE.length - vendorModelIndex)),
		BASELINE.subarray(vendorModelIndex),
	);
});

test("fails closed on malformed input and missing or duplicate anchors", () => {
	expectCode("INPUT_INVALID", () => transformBusinessSchema(null));
	expectCode("INPUT_INVALID", () => transformBusinessSchema(42));
	expectCode("INPUT_INVALID", () => transformBusinessSchema({}));

	const invalidUtf8 = Buffer.from(BASELINE);
	invalidUtf8[invalidUtf8.length - 1] = 0xff;
	expectCode("INPUT_UTF8_INVALID", () => transformBusinessSchema(invalidUtf8));

	expectCode("USER_ANCHOR_MISSING", () => transformBusinessSchema(""));
	expectCode("USER_ANCHOR_MISSING", () =>
		transformBusinessSchema(
			'\ngenerator client {\n  provider = "prisma-client"\n}\n',
		),
	);
	expectCode("USER_ANCHOR_MISSING", () =>
		transformBusinessSchema(BASELINE.toString("utf8").replace(USER_END_ANCHOR, "}\r\n")),
	);

	const duplicated = Buffer.concat([BASELINE, Buffer.from(USER_END_ANCHOR, "utf8")]);
	expectCode("USER_ANCHOR_DUPLICATE", () => transformBusinessSchema(duplicated));
});

test("fails closed on pre-existing business fields or declarations", () => {
	for (const field of USER_FIELDS_TEXT.split("\r\n").filter(Boolean)) {
		const withField = BASELINE.toString("utf8").replace(
			USER_END_ANCHOR,
			USER_END_FIELD_ANCHOR + `${field}\r\n` + USER_END_ANCHOR.slice(USER_END_FIELD_ANCHOR.length),
		);
		expectCode("USER_FIELD_PRESENT", () => transformBusinessSchema(withField));
	}

	for (const name of EXPECTED_BUSINESS_MODELS) {
		expectCode("BUSINESS_DECLARATION_PRESENT", () =>
			transformBusinessSchema(`${BASELINE.toString("utf8")}\nmodel ${name} {\n}\n`),
		);
	}
	for (const name of EXPECTED_BUSINESS_ENUMS) {
		expectCode("BUSINESS_DECLARATION_PRESENT", () =>
			transformBusinessSchema(`${BASELINE.toString("utf8")}\nenum ${name} {\n}\n`),
		);
	}
});

test("fails closed on input hash and tail drift", () => {
	const wrongHash = "0".repeat(64);
	expectCode("INPUT_SHA256_DRIFT", () =>
		transformBusinessSchema(BASELINE, { expectedInputSha256: wrongHash }),
	);
	expectCode("INPUT_INVALID", () =>
		transformBusinessSchema(BASELINE, { expectedInputSha256: "not-a-hash" }),
	);
	assert.equal(
		sha256(transformBusinessSchema(BASELINE, { expectedInputSha256: BASELINE_SHA256 })),
		COMBINED_SCHEMA_SHA256,
	);

	const withoutFinalNewline = BASELINE.subarray(0, BASELINE.length - 1);
	expectCode("BASELINE_TAIL_DRIFT", () =>
		transformBusinessSchema(withoutFinalNewline),
	);
});
