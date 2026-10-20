-- CreateEnum
CREATE TYPE "UploadState" AS ENUM ('uploading', 'finalizing', 'ready', 'deleting', 'deleted', 'expired');

-- CreateEnum
CREATE TYPE "NativeGrantState" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "NativeAuthorizationState" AS ENUM ('pending', 'approved', 'denied', 'consumed');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "nextSeq" BIGINT NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "userID" TEXT NOT NULL,
    "grantID" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeDeviceGrant" (
    "id" UUID NOT NULL,
    "userID" TEXT NOT NULL,
    "status" "NativeGrantState" NOT NULL DEFAULT 'active',
    "audience" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "NativeDeviceGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativePendingAuthorization" (
    "id" UUID NOT NULL,
    "deviceCodeFingerprint" TEXT NOT NULL,
    "humanCodeDigest" BYTEA NOT NULL,
    "humanCodeKeyID" TEXT NOT NULL,
    "status" "NativeAuthorizationState" NOT NULL DEFAULT 'pending',
    "approvedUserID" TEXT,
    "audience" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3),
    "pollIntervalSeconds" INTEGER NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "NativePendingAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAccessToken" (
    "id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "grantID" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeRefreshToken" (
    "id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "grantID" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "spentAt" TIMESTAMP(3),
    "successorID" UUID,

    CONSTRAINT "NativeRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Revision" (
    "revisionID" UUID NOT NULL,
    "projectID" UUID NOT NULL,
    "userID" TEXT NOT NULL,
    "parentRevisionID" UUID,
    "seq" BIGINT NOT NULL,
    "deviceID" UUID NOT NULL,
    "keyEpoch" INTEGER NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "ciphertextSha256" BYTEA NOT NULL,
    "storageObjectKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Revision_pkey" PRIMARY KEY ("revisionID")
);

-- CreateTable
CREATE TABLE "ProjectHead" (
    "projectID" UUID NOT NULL,
    "revisionID" UUID NOT NULL,

    CONSTRAINT "ProjectHead_pkey" PRIMARY KEY ("projectID","revisionID")
);

-- CreateTable
CREATE TABLE "Upload" (
    "uploadID" UUID NOT NULL,
    "userID" TEXT NOT NULL,
    "projectID" UUID NOT NULL,
    "deviceID" UUID NOT NULL,
    "revisionID" UUID NOT NULL,
    "parentRevisionID" UUID,
    "keyEpoch" INTEGER NOT NULL,
    "stagingKey" TEXT NOT NULL,
    "finalKey" TEXT,
    "state" "UploadState" NOT NULL DEFAULT 'uploading',
    "sizeBytes" BIGINT NOT NULL,
    "ciphertextSha256" BYTEA NOT NULL,
    "leaseToken" BIGINT NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "graceExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("uploadID")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_grantID_key" ON "Device"("grantID");

-- CreateIndex
CREATE INDEX "Device_userID_idx" ON "Device"("userID");

-- CreateIndex
CREATE INDEX "NativeDeviceGrant_userID_status_idx" ON "NativeDeviceGrant"("userID", "status");

-- CreateIndex
CREATE INDEX "NativeDeviceGrant_status_expiresAt_idx" ON "NativeDeviceGrant"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativePendingAuthorization_deviceCodeFingerprint_key" ON "NativePendingAuthorization"("deviceCodeFingerprint");

-- CreateIndex
CREATE INDEX "NativePendingAuthorization_status_expiresAt_idx" ON "NativePendingAuthorization"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "NativePendingAuthorization_expiresAt_idx" ON "NativePendingAuthorization"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativePendingAuthorization_humanCodeKeyID_humanCodeDigest_key" ON "NativePendingAuthorization"("humanCodeKeyID", "humanCodeDigest");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAccessToken_fingerprint_key" ON "NativeAccessToken"("fingerprint");

-- CreateIndex
CREATE INDEX "NativeAccessToken_grantID_idx" ON "NativeAccessToken"("grantID");

-- CreateIndex
CREATE INDEX "NativeAccessToken_expiresAt_idx" ON "NativeAccessToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeRefreshToken_fingerprint_key" ON "NativeRefreshToken"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "NativeRefreshToken_successorID_key" ON "NativeRefreshToken"("successorID");

-- CreateIndex
CREATE INDEX "NativeRefreshToken_grantID_idx" ON "NativeRefreshToken"("grantID");

-- CreateIndex
CREATE INDEX "NativeRefreshToken_expiresAt_idx" ON "NativeRefreshToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Revision_storageObjectKey_key" ON "Revision"("storageObjectKey");

-- CreateIndex
CREATE INDEX "Revision_parentRevisionID_idx" ON "Revision"("parentRevisionID");

-- CreateIndex
CREATE INDEX "Revision_userID_idx" ON "Revision"("userID");

-- CreateIndex
CREATE INDEX "Revision_deviceID_idx" ON "Revision"("deviceID");

-- CreateIndex
CREATE UNIQUE INDEX "Revision_projectID_seq_key" ON "Revision"("projectID", "seq");

-- CreateIndex
CREATE INDEX "ProjectHead_revisionID_idx" ON "ProjectHead"("revisionID");

-- CreateIndex
CREATE UNIQUE INDEX "Upload_stagingKey_key" ON "Upload"("stagingKey");

-- CreateIndex
CREATE UNIQUE INDEX "Upload_finalKey_key" ON "Upload"("finalKey");

-- CreateIndex
CREATE INDEX "Upload_userID_state_idx" ON "Upload"("userID", "state");

-- CreateIndex
CREATE INDEX "Upload_projectID_revisionID_idx" ON "Upload"("projectID", "revisionID");

-- CreateIndex
CREATE INDEX "Upload_state_expiresAt_idx" ON "Upload"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "Upload_state_leaseExpiresAt_idx" ON "Upload"("state", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userID_fkey" FOREIGN KEY ("userID") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_grantID_fkey" FOREIGN KEY ("grantID") REFERENCES "NativeDeviceGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceGrant" ADD CONSTRAINT "NativeDeviceGrant_userID_fkey" FOREIGN KEY ("userID") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativePendingAuthorization" ADD CONSTRAINT "NativePendingAuthorization_approvedUserID_fkey" FOREIGN KEY ("approvedUserID") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAccessToken" ADD CONSTRAINT "NativeAccessToken_grantID_fkey" FOREIGN KEY ("grantID") REFERENCES "NativeDeviceGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeRefreshToken" ADD CONSTRAINT "NativeRefreshToken_grantID_fkey" FOREIGN KEY ("grantID") REFERENCES "NativeDeviceGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeRefreshToken" ADD CONSTRAINT "NativeRefreshToken_successorID_fkey" FOREIGN KEY ("successorID") REFERENCES "NativeRefreshToken"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_projectID_fkey" FOREIGN KEY ("projectID") REFERENCES "Project"("projectID") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_userID_fkey" FOREIGN KEY ("userID") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_parentRevisionID_fkey" FOREIGN KEY ("parentRevisionID") REFERENCES "Revision"("revisionID") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_deviceID_fkey" FOREIGN KEY ("deviceID") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_storageObjectKey_fkey" FOREIGN KEY ("storageObjectKey") REFERENCES "Upload"("finalKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectHead" ADD CONSTRAINT "ProjectHead_projectID_fkey" FOREIGN KEY ("projectID") REFERENCES "Project"("projectID") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectHead" ADD CONSTRAINT "ProjectHead_revisionID_fkey" FOREIGN KEY ("revisionID") REFERENCES "Revision"("revisionID") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_userID_fkey" FOREIGN KEY ("userID") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_projectID_fkey" FOREIGN KEY ("projectID") REFERENCES "Project"("projectID") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_deviceID_fkey" FOREIGN KEY ("deviceID") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_parentRevisionID_fkey" FOREIGN KEY ("parentRevisionID") REFERENCES "Revision"("revisionID") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The pinned Prisma 7.10.1 diff does not render CHECK constraints or partial
-- unique indexes. Added explicitly. Cross-row invariants (parent/project/tenant
-- consistency, token expiry <= grant expiry, lease fencing, and spent-refresh
-- retention) remain service-enforced transaction rules and are not SQL CHECKs.

-- Project sequence allocation starts at 1 and never decreases below 1.
ALTER TABLE "Project" ADD CONSTRAINT "Project_nextSeq_positive_check" CHECK ("nextSeq" >= 1);

-- Native grant state and revocation timestamp must agree.
ALTER TABLE "NativeDeviceGrant" ADD CONSTRAINT "NativeDeviceGrant_status_revokedAt_check" CHECK (("status" = 'active' AND "revokedAt" IS NULL) OR ("status" = 'revoked' AND "revokedAt" IS NOT NULL));

-- Pending authorization state owns the approval/consumption timestamps. Expiry
-- is authoritative through "expiresAt"; there is deliberately no expired state.
ALTER TABLE "NativePendingAuthorization" ADD CONSTRAINT "NativePendingAuthorization_status_check" CHECK (("status" = 'pending' AND "approvedUserID" IS NULL AND "consumedAt" IS NULL) OR ("status" = 'approved' AND "approvedUserID" IS NOT NULL AND "consumedAt" IS NULL) OR ("status" = 'denied' AND "approvedUserID" IS NULL AND "consumedAt" IS NULL) OR ("status" = 'consumed' AND "approvedUserID" IS NOT NULL AND "consumedAt" IS NOT NULL));

-- Persisted credential fingerprints are canonical lowercase SHA-256 hex, as
-- produced by src/native-auth/credentials.ts.
ALTER TABLE "NativePendingAuthorization" ADD CONSTRAINT "NativePendingAuthorization_deviceFingerprint_canonical_check" CHECK ("deviceCodeFingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "NativePendingAuthorization" ADD CONSTRAINT "NativePendingAuthorization_humanCodeDigest_length_check" CHECK (octet_length("humanCodeDigest") = 32);
ALTER TABLE "NativeAccessToken" ADD CONSTRAINT "NativeAccessToken_fingerprint_canonical_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "NativeRefreshToken" ADD CONSTRAINT "NativeRefreshToken_fingerprint_canonical_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$');

-- A refresh rotation link cannot point at itself, and a spent record must carry
-- its replacement. Spent records are retained while the grant can still be used.
ALTER TABLE "NativeRefreshToken" ADD CONSTRAINT "NativeRefreshToken_successor_not_self_check" CHECK ("successorID" IS NULL OR "successorID" <> "id");
ALTER TABLE "NativeRefreshToken" ADD CONSTRAINT "NativeRefreshToken_spent_successor_check" CHECK (("spentAt" IS NULL AND "successorID" IS NULL) OR ("spentAt" IS NOT NULL AND "successorID" IS NOT NULL));

-- Revision invariants. The parent-belongs-to-project rule is enforced in the
-- commit transaction, not by a SQL CHECK.
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_seq_positive_check" CHECK ("seq" > 0);
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_keyEpoch_positive_check" CHECK ("keyEpoch" > 0);
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_sizeBytes_positive_check" CHECK ("sizeBytes" > 0);
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_ciphertextSha256_length_check" CHECK (octet_length("ciphertextSha256") = 32);

-- Upload invariants. A ready upload must have a final object key.
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_keyEpoch_positive_check" CHECK ("keyEpoch" > 0);
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_sizeBytes_positive_check" CHECK ("sizeBytes" > 0);
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_leaseToken_nonnegative_check" CHECK ("leaseToken" >= 0);
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_ciphertextSha256_length_check" CHECK (octet_length("ciphertextSha256") = 32);
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_ready_finalKey_check" CHECK ("state" <> 'ready' OR "finalKey" IS NOT NULL);

-- Revision intent: at most one non-terminal upload per user/project/revision.
-- This partial unique index is not representable in the Prisma schema.
CREATE UNIQUE INDEX "Upload_active_revision_intent_key" ON "Upload"("userID", "projectID", "revisionID") WHERE "state" IN ('uploading', 'finalizing', 'ready', 'deleting');