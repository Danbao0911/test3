import { Prisma } from "../generated/prisma/client";
import type { PrismaClient } from "../generated/prisma/client";

export type WorkspaceUser = { id: string; role: "ADMIN" | "REVIEWER" | "VIEWER" };

export function accountWorkspaceInclude(userId: string) {
  return {
    owner: { select: { id: true, email: true, role: true } },
    favorites: { where: { userId }, select: { id: true }, take: 1 },
    followUp: { select: { status: true, note: true, updatedAt: true, updatedById: true } },
    evidence: { select: { contact: { select: { status: true, suppressed: true } } } },
  } satisfies Prisma.AccountInclude;
}

type AccountWorkspaceSource = {
  id: string;
  name: string;
  type: string;
  status: string;
  allowImport: boolean;
  expiresAt: Date | null;
};

export type AccountWorkspaceRecord = {
  id: string;
  platform: string;
  nativeId: string | null;
  displayName: string;
  normalizedProfileUrl: string;
  organization: string | null;
  serviceTags: string[];
  region: string | null;
  profileUrl: string;
  sourceId: string;
  sourceUrl: string;
  capturedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  isDemo: boolean;
  ownerId: string | null;
  workspaceVersion: number;
  source: AccountWorkspaceSource;
  owner: { id: string; email: string; role: string } | null;
  favorites: Array<{ id: string }>;
  followUp: { status: string; note: string; updatedAt: Date; updatedById: string | null } | null;
  evidence: Array<{ contact: { status: string; suppressed: boolean } | null }>;
};

function usableContactPredicate() {
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "Evidence" e
      JOIN "ContactPoint" c ON c."evidenceId" = e."id"
      JOIN "Source" s ON s."id" = e."sourceId"
      JOIN "SourcePolicySnapshot" ps ON ps."id" = e."policySnapshotId"
      WHERE e."accountId" = a."id"
        AND c."status" = 'APPROVED'::"ContactStatus"
        AND c."ownershipConfirmed" = true
        AND c."businessConfirmed" = true
        AND c."suppressed" = false
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
    )
  `;
}

export type WorkspaceListFilters = {
  q?: string;
  platform?: string;
  serviceTag?: string;
  sourceId?: string;
  contactStatus?: string;
  hasContact?: "YES" | "NO";
  followUpStatus?: string;
  favorite?: "YES" | "NO";
};

function workspaceFilterSql(filters: WorkspaceListFilters, userId: string) {
  const clauses: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (filters.q) {
    const query = `%${filters.q}%`;
    clauses.push(Prisma.sql`(a."displayName" ILIKE ${query} OR a."organization" ILIKE ${query})`);
  }
  if (filters.platform) clauses.push(Prisma.sql`a."platform" = ${filters.platform}::"Platform"`);
  if (filters.serviceTag) clauses.push(Prisma.sql`${filters.serviceTag} = ANY(a."serviceTags")`);
  if (filters.sourceId) clauses.push(Prisma.sql`a."sourceId" = ${filters.sourceId}::uuid`);
  if (filters.contactStatus) {
    clauses.push(Prisma.sql`
      EXISTS (
        SELECT 1 FROM "Evidence" ces
        JOIN "ContactPoint" ccs ON ccs."evidenceId" = ces."id"
        WHERE ces."accountId" = a."id"
          AND ccs."status" = ${filters.contactStatus}::"ContactStatus"
      )
    `);
  }
  if (filters.followUpStatus) {
    clauses.push(Prisma.sql`
      EXISTS (
        SELECT 1 FROM "AccountFollowUp" afs
        WHERE afs."accountId" = a."id"
          AND afs."status" = ${filters.followUpStatus}::"FollowUpStatus"
      )
    `);
  }
  if (filters.favorite === "YES") {
    clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM "AccountFavorite" afs WHERE afs."accountId" = a."id" AND afs."userId" = ${userId}::uuid)`);
  } else if (filters.favorite === "NO") {
    clauses.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "AccountFavorite" afs WHERE afs."accountId" = a."id" AND afs."userId" = ${userId}::uuid)`);
  }
  if (filters.hasContact === "YES") clauses.push(usableContactPredicate());
  if (filters.hasContact === "NO") clauses.push(Prisma.sql`NOT ${usableContactPredicate()}`);
  return Prisma.join(clauses, " AND ");
}

export async function findWorkspaceAccountPage(
  db: PrismaClient,
  userId: string,
  filters: WorkspaceListFilters,
  page: number,
  pageSize: number,
) {
  const where = workspaceFilterSql(filters, userId);
  const offset = (page - 1) * pageSize;
  const [rows, countRows] = await Promise.all([
    db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT a."id"
      FROM "Account" a
      WHERE ${where}
      ORDER BY a."createdAt" DESC, a."id" DESC
      OFFSET ${offset}
      LIMIT ${pageSize}
    `),
    db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "Account" a
      WHERE ${where}
    `),
  ]);
  return { ids: rows.map((row) => row.id), total: Number(countRows[0]?.count ?? 0) };
}

export async function findUsableAccountIds(db: PrismaClient, accountIds?: string[]) {
  if (accountIds?.length === 0) return new Set<string>();
  const idFilter = accountIds
    ? Prisma.sql`AND a."id" IN (${Prisma.join(accountIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT a."id"
    FROM "Account" a
    WHERE ${usableContactPredicate()}
      ${idFilter}
  `);
  return new Set(rows.map((row) => row.id));
}

export function accountWorkspaceDto(record: AccountWorkspaceRecord, user: WorkspaceUser, hasUsableContact: boolean) {
  const statuses = [...new Set(record.evidence.flatMap((item) => item.contact ? [item.contact.status] : []))];
  const reviewStatus = statuses.includes("APPROVED") ? "APPROVED" : statuses.includes("PENDING") ? "PENDING" : statuses.includes("REJECTED") ? "REJECTED" : statuses.includes("INVALID") ? "INVALID" : null;
  const canReadNote = user.role === "ADMIN" || user.role === "REVIEWER";
  const source = record.source;
  return {
    id: record.id,
    platform: record.platform,
    nativeId: record.nativeId,
    displayName: record.displayName,
    normalizedProfileUrl: record.normalizedProfileUrl,
    organization: record.organization,
    serviceTags: record.serviceTags,
    region: record.region,
    profileUrl: record.profileUrl,
    sourceId: record.sourceId,
    sourceUrl: record.sourceUrl,
    capturedAt: record.capturedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    isDemo: record.isDemo,
    ownerId: record.ownerId,
    workspaceVersion: record.workspaceVersion,
    source: { id: source.id, name: source.name, type: source.type, status: source.status, allowImport: source.allowImport, expiresAt: source.expiresAt },
    owner: record.owner,
    favorite: record.favorites.length > 0,
    followUp: {
      status: record.followUp?.status ?? "NOT_CONTACTED",
      note: canReadNote ? record.followUp?.note ?? "" : null,
      noteMasked: !canReadNote,
      updatedAt: record.followUp?.updatedAt ?? null,
    },
    reviewStatus,
    contactStatuses: statuses,
    hasUsableContact,
  };
}
