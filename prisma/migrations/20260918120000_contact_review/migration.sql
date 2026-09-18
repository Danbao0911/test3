-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'REVIEWER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ContactType" AS ENUM ('EMAIL', 'WECHAT', 'PHONE', 'CONTACT_URL', 'BOOKING_URL');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'INVALID');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'VIEWER';

-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "allowEvidenceText" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowExtract" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "policyChangedById" UUID,
ADD COLUMN     "policyVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "retentionDays" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "Evidence" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "sourceUrl" VARCHAR(2048) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "fieldLocation" VARCHAR(240) NOT NULL,
    "excerpt" VARCHAR(300) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactPoint" (
    "id" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "dedupeKey" VARCHAR(64) NOT NULL,
    "type" "ContactType" NOT NULL,
    "rawValue" VARCHAR(2048) NOT NULL,
    "normalizedValue" VARCHAR(2048) NOT NULL,
    "status" "ContactStatus" NOT NULL DEFAULT 'PENDING',
    "ownershipConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "businessConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewDecision" (
    "id" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "reviewerId" UUID NOT NULL,
    "status" "ContactStatus" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "ownershipConfirmed" BOOLEAN NOT NULL,
    "businessConfirmed" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Evidence_accountId_createdAt_idx" ON "Evidence"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "Evidence_sourceId_policyVersion_idx" ON "Evidence"("sourceId", "policyVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ContactPoint_evidenceId_key" ON "ContactPoint"("evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactPoint_dedupeKey_key" ON "ContactPoint"("dedupeKey");

-- CreateIndex
CREATE INDEX "ContactPoint_status_createdAt_id_idx" ON "ContactPoint"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ContactPoint_expiresAt_idx" ON "ContactPoint"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewDecision_contactId_version_key" ON "ReviewDecision"("contactId", "version");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_policyChangedById_fkey" FOREIGN KEY ("policyChangedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactPoint" ADD CONSTRAINT "ContactPoint_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ContactPoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The previous release had only administrator accounts. New accounts default to VIEWER.
UPDATE "User" SET "role" = 'ADMIN';
ALTER TABLE "Source" ADD CONSTRAINT "Source_retentionDays_check" CHECK ("retentionDays" BETWEEN 1 AND 365);
ALTER TABLE "Source" ADD CONSTRAINT "Source_policyVersion_check" CHECK ("policyVersion" > 0);
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_excerpt_check" CHECK (length(trim("excerpt")) > 0);
ALTER TABLE "ContactPoint" ADD CONSTRAINT "ContactPoint_approved_check" CHECK ("status" <> 'APPROVED' OR ("ownershipConfirmed" AND "businessConfirmed" AND "reviewedAt" IS NOT NULL));
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_reason_check" CHECK (length(trim("reason")) > 0);

