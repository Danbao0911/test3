-- T05-R1 workspace optimistic concurrency. Existing rows start at the neutral version 1.
ALTER TABLE "Account" ADD COLUMN "workspaceVersion" INTEGER NOT NULL DEFAULT 1;
