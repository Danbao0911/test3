-- LATEST-REVIEW: independent identity rules and bounded concurrent login admission.
-- Existing composite identity rows remain explicit legacy/unknown records; their
-- original native ID/profile URL cannot be reconstructed from the old digest.
ALTER TABLE "DeletionRequest"
  ADD COLUMN "identityNativeFingerprint" VARCHAR(64),
  ADD COLUMN "identityProfileFingerprint" VARCHAR(64);

ALTER TABLE "LoginThrottle"
  ADD COLUMN "inFlightCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "DeletionRequest_identityNativeFingerprint_idx"
  ON "DeletionRequest"("identityNativeFingerprint", "completedAt");
CREATE INDEX "DeletionRequest_identityProfileFingerprint_idx"
  ON "DeletionRequest"("identityProfileFingerprint", "completedAt");

-- Do not infer either independent identity from a composite digest.
UPDATE "DeletionRequest"
SET "scope" = 'LEGACY_UNKNOWN'
WHERE "scope" = 'ACCOUNT_REIMPORT_BLOCK'
  AND "identityVersion" = 1
  AND "identityNativeFingerprint" IS NULL
  AND "identityProfileFingerprint" IS NULL;
