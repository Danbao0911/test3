-- T06-R1: relation-specific evidence and immutable review rounds.
-- This migration is append-only; no existing account, contact, or audit rows are rewritten.
CREATE TABLE "AccountLinkEvidence" (
    "id" UUID NOT NULL,
    "accountLinkId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "policySnapshotId" UUID NOT NULL,
    "referenceEvidenceId" UUID,
    "sourceUrl" VARCHAR(2048) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "fieldLocation" VARCHAR(240) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "leftAccountVerified" BOOLEAN NOT NULL,
    "rightAccountVerified" BOOLEAN NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountLinkEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountLinkDecision" (
    "id" UUID NOT NULL,
    "accountLinkId" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "fromStatus" "AccountLinkStatus" NOT NULL,
    "toStatus" "AccountLinkStatus" NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "evidenceId" UUID,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountLinkDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountLinkDecision_accountLinkId_round_key" ON "AccountLinkDecision"("accountLinkId", "round");
CREATE INDEX "AccountLinkEvidence_accountLinkId_createdAt_idx" ON "AccountLinkEvidence"("accountLinkId", "createdAt");
CREATE INDEX "AccountLinkEvidence_sourceId_policyVersion_idx" ON "AccountLinkEvidence"("sourceId", "policyVersion");
CREATE INDEX "AccountLinkDecision_accountLinkId_createdAt_idx" ON "AccountLinkDecision"("accountLinkId", "createdAt");

ALTER TABLE "AccountLinkEvidence" ADD CONSTRAINT "AccountLinkEvidence_accountLinkId_fkey"
  FOREIGN KEY ("accountLinkId") REFERENCES "AccountLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountLinkEvidence" ADD CONSTRAINT "AccountLinkEvidence_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountLinkEvidence" ADD CONSTRAINT "AccountLinkEvidence_policySnapshotId_fkey"
  FOREIGN KEY ("policySnapshotId") REFERENCES "SourcePolicySnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountLinkEvidence" ADD CONSTRAINT "AccountLinkEvidence_referenceEvidenceId_fkey"
  FOREIGN KEY ("referenceEvidenceId") REFERENCES "Evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccountLinkEvidence" ADD CONSTRAINT "AccountLinkEvidence_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccountLinkDecision" ADD CONSTRAINT "AccountLinkDecision_accountLinkId_fkey"
  FOREIGN KEY ("accountLinkId") REFERENCES "AccountLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountLinkDecision" ADD CONSTRAINT "AccountLinkDecision_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "AccountLinkEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccountLinkDecision" ADD CONSTRAINT "AccountLinkDecision_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
