CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "SourceType" AS ENUM ('DEMO', 'AUTHORIZED_MANUAL');
CREATE TYPE "SourceStatus" AS ENUM ('DRAFT', 'APPROVED', 'REVOKED');
CREATE TYPE "Platform" AS ENUM ('XIAOHONGSHU', 'YOUTUBE', 'X', 'DOUYIN');
CREATE TYPE "ImportRowStatus" AS ENUM ('CREATED', 'DUPLICATE', 'INVALID');

CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Source" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "SourceType" NOT NULL,
    "status" "SourceStatus" NOT NULL DEFAULT 'DRAFT',
    "permissionNote" VARCHAR(2000) NOT NULL DEFAULT '',
    "allowImport" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "nativeId" VARCHAR(200),
    "displayName" VARCHAR(120) NOT NULL,
    "profileUrl" VARCHAR(2048) NOT NULL,
    "normalizedProfileUrl" VARCHAR(2048) NOT NULL,
    "organization" VARCHAR(200),
    "serviceTags" TEXT[],
    "region" VARCHAR(100),
    "sourceId" UUID NOT NULL,
    "sourceUrl" VARCHAR(2048) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportBatch" (
    "id" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportRowResult" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "accountId" UUID,
    "errorCode" VARCHAR(80),
    "errorMessage" VARCHAR(500),
    CONSTRAINT "ImportRowResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");
CREATE INDEX "Source_status_allowImport_idx" ON "Source"("status", "allowImport");
CREATE INDEX "Source_expiresAt_idx" ON "Source"("expiresAt");
CREATE INDEX "Account_platform_createdAt_id_idx" ON "Account"("platform", "createdAt", "id");
CREATE INDEX "Account_sourceId_createdAt_idx" ON "Account"("sourceId", "createdAt");
CREATE UNIQUE INDEX "Account_platform_normalizedProfileUrl_key" ON "Account"("platform", "normalizedProfileUrl");
CREATE UNIQUE INDEX "Account_platform_nativeId_key" ON "Account"("platform", "nativeId");
CREATE INDEX "ImportBatch_createdById_createdAt_idx" ON "ImportBatch"("createdById", "createdAt");
CREATE INDEX "ImportBatch_sourceId_createdAt_idx" ON "ImportBatch"("sourceId", "createdAt");
CREATE UNIQUE INDEX "ImportBatch_createdById_idempotencyKey_key" ON "ImportBatch"("createdById", "idempotencyKey");
CREATE INDEX "ImportRowResult_batchId_status_idx" ON "ImportRowResult"("batchId", "status");
CREATE UNIQUE INDEX "ImportRowResult_batchId_rowNumber_key" ON "ImportRowResult"("batchId", "rowNumber");

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Account" ADD CONSTRAINT "Account_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportRowResult" ADD CONSTRAINT "ImportRowResult_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportRowResult" ADD CONSTRAINT "ImportRowResult_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
