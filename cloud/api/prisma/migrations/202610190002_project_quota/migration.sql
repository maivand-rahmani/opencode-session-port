-- CreateEnum
CREATE TYPE "ProjectState" AS ENUM ('active', 'purged');

-- CreateTable
CREATE TABLE "Project" (
    "projectID" UUID NOT NULL,
    "userID" TEXT NOT NULL,
    "encryptedLabel" BYTEA,
    "state" "ProjectState" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("projectID")
);

-- CreateTable
CREATE TABLE "UserQuota" (
    "userID" TEXT NOT NULL,
    "limitBytes" BIGINT NOT NULL,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "reservedBytes" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserQuota_pkey" PRIMARY KEY ("userID")
);

-- CreateIndex
CREATE INDEX "Project_userID_state_idx" ON "Project"("userID", "state");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userID_fkey" FOREIGN KEY ("userID") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserQuota" ADD CONSTRAINT "UserQuota_userID_fkey" FOREIGN KEY ("userID") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The pinned Prisma 7.10.1 diff does not render CHECK constraints.
-- Added explicitly so stored byte accounting cannot be negative and the
-- numeric sum of used plus reserved bytes cannot exceed the limit. The
-- casts avoid BIGINT addition overflow before comparison.
ALTER TABLE "UserQuota" ADD CONSTRAINT "UserQuota_bytes_nonnegative_check" CHECK ("limitBytes" >= 0 AND "usedBytes" >= 0 AND "reservedBytes" >= 0);
ALTER TABLE "UserQuota" ADD CONSTRAINT "UserQuota_usage_within_limit_check" CHECK ("usedBytes"::numeric + "reservedBytes"::numeric <= "limitBytes"::numeric);
