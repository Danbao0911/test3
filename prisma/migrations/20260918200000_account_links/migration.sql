-- T06 account identity links are reviewable records, never automatic account merges.
ALTER TABLE "Source" ADD COLUMN "allowRelate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SourcePolicySnapshot" ADD COLUMN "allowRelate" BOOLEAN;

CREATE TYPE "AccountLinkStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REVOKED');
CREATE TYPE "AccountLinkBasis" AS ENUM ('MANUAL', 'SHARED_CONTACT_CANDIDATE');

CREATE TABLE "AccountLink" (
    "id" UUID NOT NULL,
    "leftAccountId" UUID NOT NULL,
    "rightAccountId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "basis" "AccountLinkBasis" NOT NULL,
    "status" "AccountLinkStatus" NOT NULL DEFAULT 'PENDING',
    "basisContactId" UUID,
    "matchingContactId" UUID,
    "reason" VARCHAR(500) NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "reviewedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AccountLink_distinct_accounts_check" CHECK ("leftAccountId" <> "rightAccountId"),
    CONSTRAINT "AccountLink_canonical_pair_check" CHECK ("leftAccountId" < "rightAccountId")
);

CREATE UNIQUE INDEX "AccountLink_leftAccountId_rightAccountId_key" ON "AccountLink"("leftAccountId", "rightAccountId");
CREATE INDEX "AccountLink_status_createdAt_idx" ON "AccountLink"("status", "createdAt");
CREATE INDEX "AccountLink_sourceId_status_idx" ON "AccountLink"("sourceId", "status");
CREATE INDEX "AccountLink_leftAccountId_status_idx" ON "AccountLink"("leftAccountId", "status");
CREATE INDEX "AccountLink_rightAccountId_status_idx" ON "AccountLink"("rightAccountId", "status");

ALTER TABLE "AccountLink" ADD CONSTRAINT "AccountLink_leftAccountId_fkey"
  FOREIGN KEY ("leftAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountLink" ADD CONSTRAINT "AccountLink_rightAccountId_fkey"
  FOREIGN KEY ("rightAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountLink" ADD CONSTRAINT "AccountLink_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountLink" ADD CONSTRAINT "AccountLink_basisContactId_fkey"
  FOREIGN KEY ("basisContactId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccountLink" ADD CONSTRAINT "AccountLink_matchingContactId_fkey"
  FOREIGN KEY ("matchingContactId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccountLink" ADD CONSTRAINT "AccountLink_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountLink" ADD CONSTRAINT "AccountLink_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
