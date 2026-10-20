/**
 * Deterministic, additive business-schema transform for the derived Better Auth
 * Prisma schema produced by `assembleAuthSchema`.
 *
 * WHAT THIS DOES
 * - Accepts the already-derived vendor authentication schema bytes.
 * - Verifies one exact, unique `User` model end anchor before changing anything.
 * - Adds exactly seven Prisma virtual inverse relation fields to `User`:
 *   `projects Project[]`, `quota UserQuota?`, `devices Device[]`,
 *   `revisions Revision[]`, `uploads Upload[]`, `nativeDeviceGrants
 *   NativeDeviceGrant[]`, and `nativePendingAuthorizations
 *   NativePendingAuthorization[]`. These are relation metadata, not database
 *   columns.
 * - Appends exactly one fixed business section: the `ProjectState`,
 *   `NativeGrantState`, `NativeAuthorizationState`, and `UploadState` enums and
 *   the `Project`, `UserQuota`, `Device`, `NativeDeviceGrant`,
 *   `NativePendingAuthorization`, `NativeAccessToken`, `NativeRefreshToken`,
 *   `Revision`, `ProjectHead`, and `Upload` models.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * - It does not edit the vendor artifact, regenerate vendor models, or
 *   decode-and-re-encode vendor model bytes. The only in-model change is the
 *   additive insertion of the seven virtual inverse relation fields in the
 *   derived `User` block.
 * - It does not add a `User` database column, account-key-bundle, quota-cap, or
 *   configuration field.
 * - It does not write files, invoke a CLI, read environment variables, or
 *   connect to a database. The caller owns output placement.
 * - It does not repair drifted input. Every unexpected shape fails closed.
 *
 * Reversibility contract: removing the seven inserted `User` field lines and
 * the appended fixed business section reproduces the input baseline bytes
 * exactly.
 *
 * API
 *   transformBusinessSchema(authSchemaBytesOrText, options?) -> Buffer
 *
 * Error instances are `BusinessSchemaAssemblyError` with a stable `code`:
 *   INPUT_INVALID, INPUT_UTF8_INVALID, INPUT_SHA256_DRIFT,
 *   USER_ANCHOR_MISSING, USER_ANCHOR_DUPLICATE, USER_ANCHOR_HASH_DRIFT,
 *   USER_FIELD_PRESENT, BUSINESS_DECLARATION_PRESENT, BASELINE_TAIL_DRIFT
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

/**
 * Exact reviewed end of the vendor `User` model. The derived baseline preserves
 * the vendor's mixed line endings, so the anchor intentionally mixes CRLF and
 * LF bytes.
 */
export const USER_END_FIELD_ANCHOR =
	"  oauthconsents      OauthConsent[]\r\n";

export const USER_END_ANCHOR =
	USER_END_FIELD_ANCHOR +
	"\r\n" +
	"  @@unique([email])\r\n" +
	'  @@map("user")\n' +
	"}\r\n";

/** Integrity pin for the exact anchor bytes above. */
export const USER_END_ANCHOR_SHA256 =
	"4AE82B00796D7146E7F94495D345EE5839BEEEE317BC751B3DC0C421C8FBD794";

/** The only relation fields this transform adds to the derived `User` model. */
export const USER_FIELDS_TEXT =
	"  projects           Project[]\r\n" +
	"  quota              UserQuota?\r\n" +
	"  devices            Device[]\r\n" +
	"  revisions          Revision[]\r\n" +
	"  uploads            Upload[]\r\n" +
	"  nativeDeviceGrants NativeDeviceGrant[]\r\n" +
	'  nativePendingAuthorizations NativePendingAuthorization[] @relation("NativePendingApprovedUser")\r\n';

/** The only business declarations this transform appends. */
export const BUSINESS_MODELS_TEXT = `
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
  nextSeq        BigInt       @default(1)
  createdAt      DateTime     @default(now())

  revisions Revision[]
  heads     ProjectHead[]
  uploads   Upload[]

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

enum UploadState {
  uploading
  finalizing
  ready
  deleting
  deleted
  expired
}

model Device {
  id         String   @id @db.Uuid
  userID     String
  user       User     @relation(fields: [userID], references: [id], onDelete: Restrict)
  grantID    String   @unique @db.Uuid
  grant      NativeDeviceGrant @relation(fields: [grantID], references: [id], onDelete: Restrict)
  createdAt  DateTime @default(now())
  lastSeenAt DateTime?

  revisions Revision[]
  uploads   Upload[]

  @@index([userID])
}

enum NativeGrantState {
  active
  revoked
}

model NativeDeviceGrant {
  id        String           @id @db.Uuid
  userID    String
  user      User             @relation(fields: [userID], references: [id], onDelete: Restrict)
  status    NativeGrantState @default(active)
  audience  String
  resource  String
  scopes    String[]
  createdAt DateTime         @default(now())
  expiresAt DateTime
  revokedAt DateTime?

  device       Device?
  accessTokens NativeAccessToken[]
  refreshTokens NativeRefreshToken[]

  @@index([userID, status])
  @@index([status, expiresAt])
}

enum NativeAuthorizationState {
  pending
  approved
  denied
  consumed
}

model NativePendingAuthorization {
  id                    String                   @id @db.Uuid
  deviceCodeFingerprint String                   @unique
  humanCodeDigest       Bytes
  humanCodeKeyID        String
  status                NativeAuthorizationState @default(pending)
  approvedUserID        String?
  approvedUser          User?                    @relation("NativePendingApprovedUser", fields: [approvedUserID], references: [id], onDelete: Restrict)
  audience              String
  resource              String
  scopes                String[]
  createdAt             DateTime                 @default(now())
  expiresAt             DateTime
  lastPolledAt          DateTime?
  nextPollAt            DateTime?
  pollIntervalSeconds   Int
  consumedAt            DateTime?

  @@unique([humanCodeKeyID, humanCodeDigest])
  @@index([status, expiresAt])
  @@index([expiresAt])
}

model NativeAccessToken {
  id          String            @id @db.Uuid
  fingerprint String            @unique
  grantID     String            @db.Uuid
  grant       NativeDeviceGrant @relation(fields: [grantID], references: [id], onDelete: Restrict)
  createdAt   DateTime          @default(now())
  expiresAt   DateTime

  @@index([grantID])
  @@index([expiresAt])
}

model NativeRefreshToken {
  id          String             @id @db.Uuid
  fingerprint String             @unique
  grantID     String             @db.Uuid
  grant       NativeDeviceGrant  @relation(fields: [grantID], references: [id], onDelete: Restrict)
  createdAt   DateTime           @default(now())
  expiresAt   DateTime
  spentAt     DateTime?
  successorID String?            @unique @db.Uuid
  successor   NativeRefreshToken? @relation("NativeRefreshRotation", fields: [successorID], references: [id], onDelete: Restrict)
  predecessor NativeRefreshToken? @relation("NativeRefreshRotation")

  @@index([grantID])
  @@index([expiresAt])
}

model Revision {
  revisionID       String    @id @db.Uuid
  projectID        String    @db.Uuid
  project          Project   @relation(fields: [projectID], references: [projectID], onDelete: Restrict)
  userID           String
  user             User      @relation(fields: [userID], references: [id], onDelete: Restrict)
  parentRevisionID String?   @db.Uuid
  parentRevision   Revision? @relation("RevisionParent", fields: [parentRevisionID], references: [revisionID], onDelete: Restrict)
  childRevisions   Revision[] @relation("RevisionParent")
  seq              BigInt
  deviceID         String    @db.Uuid
  device           Device    @relation(fields: [deviceID], references: [id], onDelete: Restrict)
  keyEpoch         Int
  sizeBytes        BigInt
  ciphertextSha256 Bytes
  storageObjectKey String    @unique
  storageUpload    Upload    @relation("RevisionStorageObject", fields: [storageObjectKey], references: [finalKey], onDelete: Restrict)
  createdAt        DateTime  @default(now())

  heads            ProjectHead[]
  dependentUploads Upload[]    @relation("UploadParentRevision")

  @@unique([projectID, seq])
  @@index([parentRevisionID])
  @@index([userID])
  @@index([deviceID])
}

model ProjectHead {
  projectID  String   @db.Uuid
  revisionID String   @db.Uuid
  project    Project  @relation(fields: [projectID], references: [projectID], onDelete: Restrict)
  revision   Revision @relation(fields: [revisionID], references: [revisionID], onDelete: Restrict)

  @@id([projectID, revisionID])
  @@index([revisionID])
}

model Upload {
  uploadID         String       @id @db.Uuid
  userID           String
  user             User         @relation(fields: [userID], references: [id], onDelete: Restrict)
  projectID        String       @db.Uuid
  project          Project      @relation(fields: [projectID], references: [projectID], onDelete: Restrict)
  deviceID         String       @db.Uuid
  device           Device       @relation(fields: [deviceID], references: [id], onDelete: Restrict)
  revisionID       String       @db.Uuid
  parentRevisionID String?      @db.Uuid
  parentRevision   Revision?    @relation("UploadParentRevision", fields: [parentRevisionID], references: [revisionID], onDelete: Restrict)
  keyEpoch         Int
  stagingKey       String       @unique
  finalKey         String?      @unique
  state            UploadState  @default(uploading)
  sizeBytes        BigInt
  ciphertextSha256 Bytes
  leaseToken       BigInt       @default(0)
  leaseOwner       String?
  leaseExpiresAt   DateTime?
  expiresAt        DateTime
  graceExpiresAt   DateTime?
  createdAt        DateTime     @default(now())
  completedAt      DateTime?

  committedRevision Revision? @relation("RevisionStorageObject")

  @@index([userID, state])
  @@index([projectID, revisionID])
  @@index([state, expiresAt])
  @@index([state, leaseExpiresAt])
}
`;

/** Reviewed tail of the derived baseline immediately before appended models. */
const BASELINE_TAIL = "}\r\n";
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

const PREEXISTING_FIELD_PATTERNS = [
	/(^|\r?\n)[ \t]*projects[ \t]+Project\[\]/m,
	/(^|\r?\n)[ \t]*quota[ \t]+UserQuota\?/m,
	/(^|\r?\n)[ \t]*devices[ \t]+Device\[\]/m,
	/(^|\r?\n)[ \t]*revisions[ \t]+Revision\[\]/m,
	/(^|\r?\n)[ \t]*uploads[ \t]+Upload\[\]/m,
	/(^|\r?\n)[ \t]*nativeDeviceGrants[ \t]+NativeDeviceGrant\[\]/m,
	/(^|\r?\n)[ \t]*nativePendingAuthorizations[ \t]+NativePendingAuthorization\[\]/m,
];

const PREEXISTING_DECLARATION =
	/(^|\r?\n)[ \t]*(?:model[ \t]+(?:Project|UserQuota|Device|NativeDeviceGrant|NativePendingAuthorization|NativeAccessToken|NativeRefreshToken|Revision|ProjectHead|Upload)|enum[ \t]+(?:ProjectState|NativeGrantState|NativeAuthorizationState|UploadState))[ \t]*\{/m;

export class BusinessSchemaAssemblyError extends Error {
	/**
	 * @param {string} code stable fail-closed category
	 * @param {string} message human-readable detail; never includes secrets
	 */
	constructor(code, message) {
		super(message);
		this.name = "BusinessSchemaAssemblyError";
		this.code = code;
	}
}

function fail(code, message) {
	throw new BusinessSchemaAssemblyError(code, message);
}

function sha256Upper(bytes) {
	return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function toBytes(value) {
	if (typeof value === "string") {
		return Buffer.from(value, "utf8");
	}
	if (value instanceof Uint8Array) {
		// Copy so later caller mutation cannot affect the result or checks.
		return Buffer.from(value);
	}
	fail("INPUT_INVALID", "input must be a string, Buffer, or Uint8Array");
}

function requireExpectedSha256(value) {
	if (typeof value !== "string" || !SHA256_HEX.test(value)) {
		fail("INPUT_INVALID", "expectedInputSha256 must be exactly 64 hexadecimal characters");
	}
	return value.toUpperCase();
}

function countOccurrences(text, needle) {
	let count = 0;
	let index = 0;
	while ((index = text.indexOf(needle, index)) >= 0) {
		count += 1;
		index += needle.length;
	}
	return count;
}

/**
 * Applies the fixed additive business slice to an already-assembled vendor
 * authentication schema.
 *
 * @param {string | Uint8Array} authSchemaBytesOrText derived auth schema bytes
 * @param {{ expectedInputSha256?: string }} [options]
 * @returns {Buffer} combined schema bytes
 */
export function transformBusinessSchema(authSchemaBytesOrText, options = {}) {
	const inputBytes = toBytes(authSchemaBytesOrText);

	try {
		new TextDecoder("utf-8", { fatal: true }).decode(inputBytes);
	} catch {
		fail("INPUT_UTF8_INVALID", "input schema is not valid UTF-8");
	}

	if (options.expectedInputSha256 !== undefined) {
		const expected = requireExpectedSha256(options.expectedInputSha256);
		if (sha256Upper(inputBytes) !== expected) {
			fail("INPUT_SHA256_DRIFT", "input schema SHA-256 does not match the reviewed value");
		}
	}

	const inputText = inputBytes.toString("utf8");

	if (sha256Upper(Buffer.from(USER_END_ANCHOR, "utf8")) !== USER_END_ANCHOR_SHA256) {
		fail("USER_ANCHOR_HASH_DRIFT", "reviewed User end anchor bytes no longer match their hash");
	}

	for (const pattern of PREEXISTING_FIELD_PATTERNS) {
		if (pattern.test(inputText)) {
			fail("USER_FIELD_PRESENT", "User already declares a business relation field");
		}
	}
	if (PREEXISTING_DECLARATION.test(inputText)) {
		fail(
			"BUSINESS_DECLARATION_PRESENT",
			"input already declares a reviewed business model or enum",
		);
	}

	const anchorCount = countOccurrences(inputText, USER_END_ANCHOR);
	if (anchorCount === 0) {
		fail("USER_ANCHOR_MISSING", "input is missing the exact User end anchor");
	}
	if (anchorCount > 1) {
		fail("USER_ANCHOR_DUPLICATE", "input contains more than one exact User end anchor");
	}
	if (!inputText.endsWith(BASELINE_TAIL)) {
		fail("BASELINE_TAIL_DRIFT", "input does not end with the reviewed model tail");
	}

	const anchorIndex = inputText.indexOf(USER_END_ANCHOR);
	const insertAt = anchorIndex + USER_END_FIELD_ANCHOR.length;
	const withFields = Buffer.concat([
		inputBytes.subarray(0, insertAt),
		Buffer.from(USER_FIELDS_TEXT, "utf8"),
		inputBytes.subarray(insertAt),
	]);
	return Buffer.concat([withFields, Buffer.from(BUSINESS_MODELS_TEXT, "utf8")]);
}
