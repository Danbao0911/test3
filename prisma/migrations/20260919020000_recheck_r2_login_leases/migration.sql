CREATE TABLE "LoginThrottleReservation" (
    "id" UUID NOT NULL,
    "keyHash" VARCHAR(64) NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginThrottleReservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginThrottleReservation_keyHash_releasedAt_expiresAt_idx"
  ON "LoginThrottleReservation"("keyHash", "releasedAt", "expiresAt");

ALTER TABLE "LoginThrottleReservation"
  ADD CONSTRAINT "LoginThrottleReservation_keyHash_fkey"
  FOREIGN KEY ("keyHash") REFERENCES "LoginThrottle"("keyHash")
  ON DELETE CASCADE ON UPDATE CASCADE;
