-- T07-R1: immutable export manifests, field-specific grants, suppression compatibility,
-- dependency tombstones, and bounded recovery metadata. This migration is additive.
ALTER TABLE "Source" ADD COLUMN "allowedExportFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SourcePolicySnapshot" ADD COLUMN "allowedExportFields" TEXT;
ALTER TABLE "ContactPoint" ADD COLUMN "suppressed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AccountLinkEvidence" ADD COLUMN "referenceEvidenceMissing" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ContactSuppression" ADD COLUMN "fingerprintVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ContactSuppression" ADD COLUMN "fingerprintKeyId" VARCHAR(80) NOT NULL DEFAULT 'legacy-v1';
ALTER TABLE "ContactSuppression" ADD COLUMN "scope" VARCHAR(80) NOT NULL DEFAULT 'CONTACT_VALUE_GLOBAL';
ALTER TABLE "ExportJob" ADD COLUMN "payloadDigest" VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE "ExportJob" ADD COLUMN "excludedReasonCounts" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "DeletionRequest" ADD COLUMN "identityFingerprint" VARCHAR(64);
ALTER TABLE "DeletionRequest" ADD COLUMN "identityType" VARCHAR(40);
ALTER TABLE "DeletionRequest" ADD COLUMN "identityVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "DeletionRequest" ADD COLUMN "identityKeyId" VARCHAR(80) NOT NULL DEFAULT 'legacy';
ALTER TABLE "DeletionRequest" ADD COLUMN "scope" VARCHAR(80) NOT NULL DEFAULT 'LEGACY_UNKNOWN';
ALTER TABLE "DeletionRequest" ADD COLUMN "identityExpiresAt" TIMESTAMP(3);

CREATE TABLE "ExportJobManifest" (
    "id" UUID NOT NULL,
    "exportJobId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "accountId" UUID NOT NULL,
    "contactId" UUID,
    "contactVersion" INTEGER,
    "evidenceId" UUID,
    "sourceId" UUID NOT NULL,
    "policySnapshotId" UUID,
    "policyVersion" INTEGER NOT NULL,
    "fieldSources" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExportJobManifest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExportJobManifest_exportJobId_rowNumber_key" ON "ExportJobManifest"("exportJobId", "rowNumber");
CREATE INDEX "ExportJobManifest_accountId_idx" ON "ExportJobManifest"("accountId");
CREATE INDEX "ExportJobManifest_contactId_idx" ON "ExportJobManifest"("contactId");
CREATE INDEX "ExportJobManifest_sourceId_policyVersion_idx" ON "ExportJobManifest"("sourceId", "policyVersion");

ALTER TABLE "ExportJobManifest" ADD CONSTRAINT "ExportJobManifest_exportJobId_fkey"
  FOREIGN KEY ("exportJobId") REFERENCES "ExportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExportJobManifest" ADD CONSTRAINT "ExportJobManifest_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExportJobManifest" ADD CONSTRAINT "ExportJobManifest_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExportJobManifest" ADD CONSTRAINT "ExportJobManifest_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExportJobManifest" ADD CONSTRAINT "ExportJobManifest_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExportJobManifest" ADD CONSTRAINT "ExportJobManifest_policySnapshotId_fkey"
  FOREIGN KEY ("policySnapshotId") REFERENCES "SourcePolicySnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
