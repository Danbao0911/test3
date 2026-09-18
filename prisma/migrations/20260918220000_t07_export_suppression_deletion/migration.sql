-- T07: controlled export, expiring suppression fingerprints, and physical deletion records.
ALTER TABLE "Source" ADD COLUMN "allowExport" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SourcePolicySnapshot" ADD COLUMN "allowExport" BOOLEAN;

CREATE TYPE "ExportJobStatus" AS ENUM ('READY', 'DOWNLOADED', 'EXPIRED', 'REVOKED');
CREATE TYPE "DeletionRequestStatus" AS ENUM ('COMPLETED');

CREATE TABLE "ContactSuppression" (
    "id" UUID NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "contactType" "ContactType",
    "accountId" UUID,
    "contactId" UUID,
    "reasonCode" VARCHAR(80) NOT NULL,
    "basis" VARCHAR(500) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactSuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactSuppression_fingerprint_key" ON "ContactSuppression"("fingerprint");
CREATE INDEX "ContactSuppression_expiresAt_idx" ON "ContactSuppression"("expiresAt");
CREATE INDEX "ContactSuppression_accountId_expiresAt_idx" ON "ContactSuppression"("accountId", "expiresAt");

CREATE TABLE "ExportJob" (
    "id" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "accountIds" UUID[] NOT NULL,
    "fieldSet" TEXT[] NOT NULL,
    "filterSummary" VARCHAR(1000) NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "excludedCount" INTEGER NOT NULL,
    "status" "ExportJobStatus" NOT NULL DEFAULT 'READY',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "downloadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExportJob_tokenHash_key" ON "ExportJob"("tokenHash");
CREATE INDEX "ExportJob_createdById_createdAt_idx" ON "ExportJob"("createdById", "createdAt");
CREATE INDEX "ExportJob_expiresAt_status_idx" ON "ExportJob"("expiresAt", "status");

CREATE TABLE "DeletionRequest" (
    "id" UUID NOT NULL,
    "targetHash" VARCHAR(64) NOT NULL,
    "targetType" VARCHAR(30) NOT NULL,
    "accountId" UUID,
    "contactId" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "status" "DeletionRequestStatus" NOT NULL DEFAULT 'COMPLETED',
    "requestedById" UUID NOT NULL,
    "completedById" UUID NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeletionRequest_targetHash_completedAt_idx" ON "DeletionRequest"("targetHash", "completedAt");
CREATE INDEX "DeletionRequest_accountId_completedAt_idx" ON "DeletionRequest"("accountId", "completedAt");
CREATE INDEX "DeletionRequest_contactId_completedAt_idx" ON "DeletionRequest"("contactId", "completedAt");

ALTER TABLE "ContactSuppression" ADD CONSTRAINT "ContactSuppression_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactSuppression" ADD CONSTRAINT "ContactSuppression_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactSuppression" ADD CONSTRAINT "ContactSuppression_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeletionRequest" ADD CONSTRAINT "DeletionRequest_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DeletionRequest" ADD CONSTRAINT "DeletionRequest_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DeletionRequest" ADD CONSTRAINT "DeletionRequest_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeletionRequest" ADD CONSTRAINT "DeletionRequest_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
