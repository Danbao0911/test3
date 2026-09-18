import { Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";

export const accountWorkspaceInclude = {
  owner: { select: { id: true, email: true, role: true } },
  favorites: { select: { id: true } },
  followUp: { select: { status: true, note: true, updatedAt: true, updatedById: true } },
  evidence: { select: { contact: { select: { status: true } } } },
} satisfies Prisma.AccountInclude;

export type AccountWorkspaceRecord = {
  id: string;
  platform: string;
  displayName: string;
  organization: string | null;
  serviceTags: string[];
  region: string | null;
  profileUrl: string;
  sourceUrl: string;
  capturedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  isDemo: boolean;
  ownerId: string | null;
  source: Record<string, unknown>;
  owner: { id: string; email: string; role: string } | null;
  favorites: Array<{ id: string }>;
  followUp: { status: string; note: string; updatedAt: Date; updatedById: string | null } | null;
  evidence: Array<{ contact: { status: string } | null }>;
};

export async function findUsableAccountIds(db: PrismaClient, accountIds?: string[]) {
  const idFilter = accountIds?.length
    ? Prisma.sql`AND a."id" IN (${Prisma.join(accountIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT a."id"
    FROM "Account" a
    JOIN "Evidence" e ON e."accountId" = a."id"
    JOIN "ContactPoint" c ON c."evidenceId" = e."id"
    JOIN "Source" s ON s."id" = e."sourceId"
    JOIN "SourcePolicySnapshot" ps ON ps."id" = e."policySnapshotId"
    WHERE c."status" = 'APPROVED'::"ContactStatus"
      AND c."ownershipConfirmed" = true
      AND c."businessConfirmed" = true
      AND c."reviewedAt" IS NOT NULL
      AND c."expiresAt" > CURRENT_TIMESTAMP
      AND s."status" = 'APPROVED'::"SourceStatus"
      AND s."allowExtract" = true
      AND s."allowEvidenceText" = true
      AND length(trim(s."permissionNote")) > 0
      AND (s."expiresAt" IS NULL OR s."expiresAt" > CURRENT_TIMESTAMP)
      AND e."policyVersion" = s."policyVersion"
      AND ps."version" = s."policyVersion"
      AND ps."isLegacy" = false
      ${idFilter}
  `);
  return new Set(rows.map((row) => row.id));
}

export function accountWorkspaceDto(record: AccountWorkspaceRecord, hasUsableContact: boolean) {
  const { favorites, evidence, followUp, ...safe } = record;
  const statuses = [...new Set(evidence.flatMap((item) => item.contact ? [item.contact.status] : []))];
  const reviewStatus = statuses.includes("APPROVED") ? "APPROVED" : statuses.includes("PENDING") ? "PENDING" : statuses.includes("REJECTED") ? "REJECTED" : statuses.includes("INVALID") ? "INVALID" : null;
  return {
    ...safe,
    favorite: favorites.length > 0,
    followUp: followUp ?? { status: "NOT_CONTACTED", note: "", updatedAt: null, updatedById: null },
    reviewStatus,
    contactStatuses: statuses,
    hasUsableContact,
  };
}
