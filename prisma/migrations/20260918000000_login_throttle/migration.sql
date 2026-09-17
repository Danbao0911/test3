CREATE TABLE "LoginThrottle" (
    "id" UUID NOT NULL,
    "keyHash" VARCHAR(64) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoginThrottle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoginThrottle_keyHash_key" ON "LoginThrottle"("keyHash");
CREATE INDEX "LoginThrottle_updatedAt_idx" ON "LoginThrottle"("updatedAt");
