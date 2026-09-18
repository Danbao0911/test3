-- T05 account workspace: owner, per-user favorites, and current follow-up state.
CREATE TYPE "FollowUpStatus" AS ENUM ('NOT_CONTACTED', 'CONTACTING', 'REPLIED', 'NOT_MATCH', 'DO_NOT_CONTACT');

ALTER TABLE "Account" ADD COLUMN "ownerId" UUID;

CREATE TABLE "AccountFavorite" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountFavorite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountFollowUp" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'NOT_CONTACTED',
    "note" VARCHAR(1000) NOT NULL DEFAULT '',
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountFollowUp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountFavorite_accountId_userId_key" ON "AccountFavorite"("accountId", "userId");
CREATE INDEX "AccountFavorite_userId_createdAt_idx" ON "AccountFavorite"("userId", "createdAt");
CREATE UNIQUE INDEX "AccountFollowUp_accountId_key" ON "AccountFollowUp"("accountId");
CREATE INDEX "AccountFollowUp_status_updatedAt_idx" ON "AccountFollowUp"("status", "updatedAt");
CREATE INDEX "Account_ownerId_createdAt_idx" ON "Account"("ownerId", "createdAt");

ALTER TABLE "Account" ADD CONSTRAINT "Account_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccountFavorite" ADD CONSTRAINT "AccountFavorite_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountFavorite" ADD CONSTRAINT "AccountFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountFollowUp" ADD CONSTRAINT "AccountFollowUp_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountFollowUp" ADD CONSTRAINT "AccountFollowUp_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing accounts receive the neutral state; no historical follow-up is inferred.
INSERT INTO "AccountFollowUp" ("id", "accountId", "status", "note", "updatedById", "createdAt", "updatedAt")
SELECT md5("id"::text || ':follow-up')::uuid, "id", 'NOT_CONTACTED', '', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Account";
