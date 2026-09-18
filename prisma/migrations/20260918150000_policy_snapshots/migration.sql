CREATE TABLE "SourcePolicySnapshot" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "SourceStatus",
    "allowImport" BOOLEAN,
    "allowExtract" BOOLEAN,
    "allowEvidenceText" BOOLEAN,
    "retentionDays" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "permissionNote" VARCHAR(2000),
    "authorizationBasis" VARCHAR(2000) NOT NULL,
    "changedById" UUID,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changeType" VARCHAR(50) NOT NULL,
    "isLegacy" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "SourcePolicySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SourcePolicySnapshot_sourceId_version_key" ON "SourcePolicySnapshot"("sourceId", "version");
CREATE INDEX "SourcePolicySnapshot_sourceId_recordedAt_idx" ON "SourcePolicySnapshot"("sourceId", "recordedAt");

ALTER TABLE "SourcePolicySnapshot" ADD CONSTRAINT "SourcePolicySnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourcePolicySnapshot" ADD CONSTRAINT "SourcePolicySnapshot_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing policy history is unknowable. Preserve only a clearly labelled legacy
-- baseline, never claim its current fields were the historical authorization.
INSERT INTO "SourcePolicySnapshot" ("id", "sourceId", "version", "status", "allowImport", "allowExtract", "allowEvidenceText", "retentionDays", "expiresAt", "permissionNote", "authorizationBasis", "changedById", "recordedAt", "changeType", "isLegacy")
SELECT md5("id"::text || ':legacy:' || "policyVersion")::uuid, "id", "policyVersion", NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'legacy/unknown: 迁移前没有策略快照，不能还原历史授权', NULL, CURRENT_TIMESTAMP, 'LEGACY_BASELINE', true
FROM "Source";

ALTER TABLE "Evidence" ADD COLUMN "policySnapshotId" UUID;
UPDATE "Evidence" e
SET "policySnapshotId" = s."id"
FROM "SourcePolicySnapshot" s
WHERE s."sourceId" = e."sourceId" AND s."version" = e."policyVersion";

-- Old evidence whose source version was not present in Source at migration time is
-- represented as an explicit unknown legacy version before the FK becomes required.
INSERT INTO "SourcePolicySnapshot" ("id", "sourceId", "version", "status", "allowImport", "allowExtract", "allowEvidenceText", "retentionDays", "expiresAt", "permissionNote", "authorizationBasis", "changedById", "recordedAt", "changeType", "isLegacy")
SELECT DISTINCT md5(e."sourceId"::text || ':legacy:' || e."policyVersion")::uuid, e."sourceId", e."policyVersion", NULL::"SourceStatus", NULL::boolean, NULL::boolean, NULL::boolean, NULL::integer, NULL::timestamp(3), NULL::varchar(2000), 'legacy/unknown: 迁移前没有策略快照，不能还原历史授权', NULL::uuid, CURRENT_TIMESTAMP, 'LEGACY_EVIDENCE_VERSION', true
FROM "Evidence" e
WHERE e."policySnapshotId" IS NULL;

UPDATE "Evidence" e
SET "policySnapshotId" = s."id"
FROM "SourcePolicySnapshot" s
WHERE e."policySnapshotId" IS NULL AND s."sourceId" = e."sourceId" AND s."version" = e."policyVersion";

ALTER TABLE "Evidence" ALTER COLUMN "policySnapshotId" SET NOT NULL;
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_policySnapshotId_fkey" FOREIGN KEY ("policySnapshotId") REFERENCES "SourcePolicySnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
