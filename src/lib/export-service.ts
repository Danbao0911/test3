import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { canManageSources, type Role } from "./permissions";
import { sourceTypeAllowed } from "./runtime-config";
import { buildCsv, createDownloadToken, decryptPayload, encryptPayload, suppressionFingerprint, tokenHash } from "./data-protection";
import type { ExportInput } from "./validation";

export class ExportError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

const MAX_EXPORT_ROWS = 500;
const EXPORT_FIELD_HEADERS = {
  ACCOUNT_ID: "account_id",
  PLATFORM: "platform",
  DISPLAY_NAME: "display_name",
  ORGANIZATION: "organization",
  SERVICE_TAGS: "service_tags",
  REGION: "region",
  CONTACT_TYPE: "contact_type",
  CONTACT_VALUE: "contact_value",
  SOURCE_URL: "source_url",
  CAPTURED_AT: "captured_at",
  REVIEWED_AT: "reviewed_at",
} as const;

type ExportField = keyof typeof EXPORT_FIELD_HEADERS;

function accountWhere(userId: string, input: ExportInput): Prisma.AccountWhereInput {
  const filters = input.filters;
  return {
    ...(input.accountIds ? { id: { in: input.accountIds } } : {}),
    ...(filters.q ? { OR: [{ displayName: { contains: filters.q, mode: "insensitive" } }, { organization: { contains: filters.q, mode: "insensitive" } }] } : {}),
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
    ...(filters.followUpStatus ? { followUp: { status: filters.followUpStatus } } : {}),
    ...(filters.favorite === "YES" ? { favorites: { some: { userId } } } : {}),
    ...(filters.favorite === "NO" ? { favorites: { none: { userId } } } : {}),
  };
}

function sourceExportable(source: { status: string; type: string; allowExport: boolean; policyVersion: number; expiresAt: Date | null; policySnapshots: Array<{ version: number; allowExport: boolean | null; isLegacy: boolean }> }, now: Date) {
  const snapshot = source.policySnapshots[0];
  return sourceTypeAllowed(source.type as "DEMO" | "AUTHORIZED_MANUAL") && source.status === "APPROVED" && source.allowExport &&
    (!source.expiresAt || source.expiresAt > now) && Boolean(snapshot && !snapshot.isLegacy && snapshot.version === source.policyVersion && snapshot.allowExport === true);
}

function contactExportable(item: { contact: { status: string; ownershipConfirmed: boolean; businessConfirmed: boolean; reviewedAt: Date | null; expiresAt: Date; normalizedValue: string; type: string; rawValue: string }; evidence: { source: { status: string; type: string; allowExport: boolean; policyVersion: number; expiresAt: Date | null }; policyVersion: number; policySnapshot: { version: number; allowExport: boolean | null; isLegacy: boolean }; sourceUrl: string; capturedAt: Date } }, now: Date, suppressed: Set<string>) {
  const contact = item.contact;
  const source = item.evidence.source;
  const snapshot = item.evidence.policySnapshot;
  return contact.status === "APPROVED" && contact.ownershipConfirmed && contact.businessConfirmed && Boolean(contact.reviewedAt) && contact.expiresAt > now &&
    sourceExportable({ ...source, policySnapshots: [snapshot] }, now) && item.evidence.policyVersion === source.policyVersion &&
    !suppressed.has(suppressionFingerprint(contact.type, contact.normalizedValue));
}

function fieldsNeedContact(fields: ExportField[]) {
  return fields.some((field) => ["CONTACT_TYPE", "CONTACT_VALUE", "SOURCE_URL", "CAPTURED_AT", "REVIEWED_AT"].includes(field));
}

function rowFor(account: { id: string; platform: string; displayName: string; organization: string | null; serviceTags: string[]; region: string | null }, fields: ExportField[], contact?: { type: string; rawValue: string; evidence: { sourceUrl: string; capturedAt: Date }; reviewedAt: Date | null }) {
  const row: Record<string, unknown> = {};
  for (const field of fields) {
    const key = EXPORT_FIELD_HEADERS[field];
    row[key] = field === "ACCOUNT_ID" ? account.id : field === "PLATFORM" ? account.platform : field === "DISPLAY_NAME" ? account.displayName :
      field === "ORGANIZATION" ? account.organization : field === "SERVICE_TAGS" ? account.serviceTags.join("|") : field === "REGION" ? account.region :
      field === "CONTACT_TYPE" ? contact?.type : field === "CONTACT_VALUE" ? contact?.rawValue : field === "SOURCE_URL" ? contact?.evidence.sourceUrl :
      field === "CAPTURED_AT" ? contact?.evidence.capturedAt.toISOString() : field === "REVIEWED_AT" ? contact?.reviewedAt?.toISOString() : "";
  }
  return row;
}

async function exportJobStillAllowed(tx: Prisma.TransactionClient, userId: string, job: { accountIds: string[]; fieldSet: string[]; rowCount: number }, now: Date) {
  const sourceRefs = await tx.account.findMany({ where: { id: { in: job.accountIds } }, select: { sourceId: true }, distinct: ["sourceId"] });
  for (const sourceId of sourceRefs.map((row) => row.sourceId).sort()) {
    await tx.$queryRaw`SELECT "id" FROM "Source" WHERE "id" = ${sourceId}::uuid FOR UPDATE`;
  }
  const accounts = await tx.account.findMany({
    where: { id: { in: job.accountIds } },
    include: {
      source: { include: { policySnapshots: { orderBy: { version: "desc" }, take: 1 } } },
      followUp: { select: { status: true } },
      favorites: { where: { userId }, select: { id: true }, take: 1 },
      evidence: { include: { contact: true, source: true, policySnapshot: true } },
    },
  });
  if (accounts.length !== new Set(job.accountIds).size) return false;
  const fields = job.fieldSet as ExportField[];
  const needContact = fieldsNeedContact(fields);
  const allContacts = accounts.flatMap((account) => account.evidence.flatMap((evidence) => evidence.contact ? [evidence.contact] : []));
  const fingerprints = allContacts.map((contact) => suppressionFingerprint(contact.type, contact.normalizedValue));
  const activeSuppressions = await tx.contactSuppression.findMany({ where: { fingerprint: { in: fingerprints }, expiresAt: { gt: now } }, select: { fingerprint: true } });
  const suppressed = new Set(activeSuppressions.map((item) => item.fingerprint));
  let rowCount = 0;
  for (const account of accounts) {
    if (account.followUp?.status === "DO_NOT_CONTACT" || !sourceExportable(account.source, now)) return false;
    const contacts = account.evidence.flatMap((evidence) => evidence.contact && contactExportable({ contact: evidence.contact, evidence }, now, suppressed) ? [evidence.contact] : []);
    if (needContact && contacts.length === 0) return false;
    rowCount += needContact ? contacts.length : 1;
  }
  return rowCount === job.rowCount;
}

export async function createExportJob(db: PrismaClient, userId: string, input: ExportInput) {
  const token = createDownloadToken();
  const now = new Date();
  return db.$transaction(async (tx) => {
    const sourceRows = await tx.account.findMany({ where: accountWhere(userId, input), select: { sourceId: true }, distinct: ["sourceId"] });
    for (const sourceId of sourceRows.map((row) => row.sourceId).sort()) {
      await tx.$queryRaw`SELECT "id" FROM "Source" WHERE "id" = ${sourceId}::uuid FOR UPDATE`;
    }
    const accounts = await tx.account.findMany({
      where: accountWhere(userId, input),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_EXPORT_ROWS + 1,
      include: {
        source: { include: { policySnapshots: { orderBy: { version: "desc" }, take: 1 } } },
        followUp: { select: { status: true } },
        favorites: { where: { userId }, select: { id: true }, take: 1 },
        evidence: { include: { contact: true, source: true, policySnapshot: true } },
      },
    });
    if (accounts.length > MAX_EXPORT_ROWS) throw new ExportError("EXPORT_TOO_LARGE", `导出最多 ${MAX_EXPORT_ROWS} 行，请缩小筛选范围`);

    const contactFingerprints = accounts.flatMap((account) => account.evidence.flatMap((evidence) => evidence.contact ? [evidence.contact] : []));
    const fingerprints = contactFingerprints.map((contact) => suppressionFingerprint(contact.type, contact.normalizedValue));
    const activeSuppressions = await tx.contactSuppression.findMany({ where: { fingerprint: { in: fingerprints }, expiresAt: { gt: now } }, select: { fingerprint: true } });
    const suppressed = new Set(activeSuppressions.map((item) => item.fingerprint));
    const fields = input.fields as ExportField[];
    const needContact = fieldsNeedContact(fields);
    const rows: Array<Record<string, unknown>> = [];
    let excludedCount = 0;
    const accountIds: string[] = [];
    for (const account of accounts) {
      if (account.followUp?.status === "DO_NOT_CONTACT" || !sourceExportable(account.source, now)) { excludedCount++; continue; }
      const contacts = account.evidence.flatMap((evidence) => evidence.contact && contactExportable({ contact: evidence.contact, evidence }, now, suppressed) ? [{ contact: evidence.contact, evidence }] : []);
      if (needContact && contacts.length === 0) { excludedCount++; continue; }
      const selectedContacts = needContact ? contacts : [undefined];
      for (const contact of selectedContacts) {
        rows.push(rowFor(account, fields, contact ? { type: contact.contact.type, rawValue: contact.contact.rawValue, evidence: { sourceUrl: contact.evidence.sourceUrl, capturedAt: contact.evidence.capturedAt }, reviewedAt: contact.contact.reviewedAt } : undefined));
        accountIds.push(account.id);
      }
    }
    if (!rows.length) throw new ExportError("NO_EXPORTABLE_ROWS", "没有同时满足当前来源策略、人工审核、有效期和拒绝联系规则的记录");
    const headers = fields.map((field) => EXPORT_FIELD_HEADERS[field]);
    const csv = buildCsv(headers, rows);
    const expiresAt = new Date(now.getTime() + input.expiresInMinutes * 60_000);
    const job = await tx.exportJob.create({ data: {
      createdById: userId, tokenHash: tokenHash(token), encryptedPayload: encryptPayload(csv), accountIds: [...new Set(accountIds)],
      fieldSet: fields, filterSummary: JSON.stringify(input.filters), rowCount: rows.length, excludedCount, expiresAt,
    } });
    await tx.auditEvent.create({ data: { actorId: userId, action: "EXPORT_CREATED", targetId: job.id } });
    return { id: job.id, token, expiresAt, rowCount: rows.length, excludedCount };
  });
}

export async function downloadExport(db: PrismaClient, userId: string, jobId: string, token: string) {
  const job = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ExportJob" WHERE "id" = ${jobId}::uuid FOR UPDATE`;
    const current = await tx.exportJob.findUnique({ where: { id: jobId } });
    if (!current || current.createdById !== userId || current.tokenHash !== tokenHash(token)) throw new ExportError("EXPORT_NOT_FOUND", "导出链接不存在", 404);
    if (current.expiresAt <= new Date()) {
      await tx.exportJob.update({ where: { id: jobId }, data: { status: "EXPIRED" } });
      throw new ExportError("EXPORT_EXPIRED", "导出链接已过期", 410);
    }
    if (current.status !== "READY") throw new ExportError("EXPORT_USED", "导出链接已使用或已撤销", 410);
    if (!(await exportJobStillAllowed(tx, userId, current, new Date()))) {
      await tx.exportJob.update({ where: { id: jobId }, data: { status: "REVOKED" } });
      throw new ExportError("EXPORT_REVOKED", "来源策略、联系人有效性或拒绝联系状态已变化，导出链接已撤销", 410);
    }
    const updated = await tx.exportJob.update({ where: { id: jobId }, data: { status: "DOWNLOADED", downloadedAt: new Date() } });
    await tx.auditEvent.create({ data: { actorId: userId, action: "EXPORT_DOWNLOADED", targetId: jobId } });
    return updated;
  });
  return { csv: decryptPayload(job.encryptedPayload), filename: `test3-export-${job.id}.csv` };
}

export async function listExportJobs(db: PrismaClient, userId: string) {
  return db.exportJob.findMany({ where: { createdById: userId }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, fieldSet: true, rowCount: true, excludedCount: true, status: true, expiresAt: true, downloadedAt: true, createdAt: true } });
}

export async function deleteExportArtifactsForAccounts(tx: Prisma.TransactionClient, accountIds: string[]) {
  let count = 0;
  for (const accountId of accountIds) {
    const deleted = await tx.exportJob.deleteMany({ where: { accountIds: { has: accountId } } });
    count += deleted.count;
  }
  return count;
}

export async function runRetentionCleanup(db: PrismaClient, actorId: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    const expiredContacts = await tx.contactPoint.findMany({ where: { expiresAt: { lte: now } }, select: { id: true } });
    for (const contact of expiredContacts) await tx.contactPoint.delete({ where: { id: contact.id } });
    const expiredExports = await tx.exportJob.deleteMany({ where: { expiresAt: { lte: now } } });
    const expiredSuppressions = await tx.contactSuppression.deleteMany({ where: { expiresAt: { lte: now } } });
    await tx.auditEvent.create({ data: { actorId, action: "RETENTION_CLEANUP", targetId: actorId } });
    return { contacts: expiredContacts.length, exports: expiredExports.count, suppressions: expiredSuppressions.count };
  });
}

export function canExport(role: Role) { return canManageSources(role); }
