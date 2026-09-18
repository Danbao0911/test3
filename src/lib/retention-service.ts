import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { deleteExportArtifactsForAccounts } from "./export-service";
import { suppressionFingerprint } from "./data-protection";
import type { DeletionRequestInput, SuppressionInput } from "./validation";

const SUPPRESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export class RetentionError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

function suppressionExpiry(input: SuppressionInput, now: Date) {
  const requested = input.expiresAt ? new Date(input.expiresAt) : new Date(now.getTime() + SUPPRESSION_TTL_MS);
  if (!Number.isFinite(requested.getTime()) || requested <= now || requested.getTime() > now.getTime() + SUPPRESSION_TTL_MS) {
    throw new RetentionError("SUPPRESSION_EXPIRY_INVALID", "拒绝联系抑制必须有未来且不超过 180 天的到期时间");
  }
  return requested;
}

async function upsertSuppression(tx: Prisma.TransactionClient, actorId: string, input: { normalizedValue: string; type: string; accountId?: string; contactId?: string; reasonCode: string; basis: string; expiresAt: Date }) {
  const fingerprint = suppressionFingerprint(input.type, input.normalizedValue);
  const existing = await tx.contactSuppression.findUnique({ where: { fingerprint } });
  if (!existing || existing.expiresAt <= new Date()) {
    if (existing) {
      await tx.contactSuppression.update({ where: { id: existing.id }, data: { accountId: input.accountId, contactId: input.contactId, contactType: input.type as "EMAIL" | "WECHAT" | "PHONE" | "CONTACT_URL" | "BOOKING_URL", reasonCode: input.reasonCode, basis: input.basis, expiresAt: input.expiresAt, createdById: actorId } });
    } else {
      await tx.contactSuppression.create({ data: { fingerprint, accountId: input.accountId, contactId: input.contactId, contactType: input.type as "EMAIL" | "WECHAT" | "PHONE" | "CONTACT_URL" | "BOOKING_URL", reasonCode: input.reasonCode, basis: input.basis, expiresAt: input.expiresAt, createdById: actorId } });
    }
    return { fingerprint, changed: true };
  }
  if (existing.expiresAt < input.expiresAt) await tx.contactSuppression.update({ where: { id: existing.id }, data: { expiresAt: input.expiresAt } });
  return { fingerprint, changed: false };
}

export async function suppressContact(db: PrismaClient, actorId: string, contactId: string, input: SuppressionInput) {
  const now = new Date();
  const expiresAt = suppressionExpiry(input, now);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ContactPoint" WHERE "id" = ${contactId}::uuid FOR UPDATE`;
    const contact = await tx.contactPoint.findUnique({ where: { id: contactId }, include: { evidence: { select: { accountId: true } } } });
    if (!contact) throw new RetentionError("NOT_FOUND", "联系项不存在", 404);
    const suppression = await upsertSuppression(tx, actorId, { normalizedValue: contact.normalizedValue, type: contact.type, accountId: contact.evidence.accountId, contactId, reasonCode: input.reasonCode, basis: input.basis, expiresAt });
    if (!suppression.changed && contact.status === "INVALID") return { id: contactId, changed: false, expiresAt };
    const version = contact.version + 1;
    await tx.contactPoint.update({ where: { id: contactId }, data: { status: "INVALID", ownershipConfirmed: false, businessConfirmed: false, reviewedAt: now, version } });
    await tx.reviewDecision.create({ data: { contactId, reviewerId: actorId, status: "INVALID", reason: input.basis, ownershipConfirmed: false, businessConfirmed: false, version } });
    await tx.auditEvent.create({ data: { actorId, action: "CONTACT_SUPPRESSED", targetId: contactId } });
    return { id: contactId, changed: true, expiresAt };
  });
}

export async function deleteTarget(db: PrismaClient, actorId: string, input: DeletionRequestInput) {
  return db.$transaction(async (tx) => {
    if (input.accountId) {
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${input.accountId}::uuid FOR UPDATE`;
      const account = await tx.account.findUnique({ where: { id: input.accountId }, include: { evidence: { include: { contact: true } } } });
      if (!account) throw new RetentionError("NOT_FOUND", "账号不存在", 404);
      const expiresAt = new Date(Date.now() + SUPPRESSION_TTL_MS);
      for (const evidence of account.evidence) {
        if (evidence.contact) await upsertSuppression(tx, actorId, { normalizedValue: evidence.contact.normalizedValue, type: evidence.contact.type, accountId: account.id, reasonCode: "USER_REQUEST", basis: input.reason, expiresAt });
      }
      const request = await tx.deletionRequest.create({ data: { targetHash: suppressionFingerprint("ACCOUNT_ID", account.id), targetType: "ACCOUNT", accountId: account.id, reason: input.reason, requestedById: actorId, completedById: actorId } });
      await deleteExportArtifactsForAccounts(tx, [account.id]);
      await tx.auditEvent.create({ data: { actorId, action: "ACCOUNT_DELETED", targetId: account.id } });
      await tx.auditEvent.create({ data: { actorId, action: "DELETION_COMPLETED", targetId: request.id } });
      await tx.account.delete({ where: { id: account.id } });
      return { id: account.id, targetType: "ACCOUNT", requestId: request.id };
    }
    if (!input.contactId) throw new RetentionError("VALIDATION_ERROR", "必须选择删除目标");
    await tx.$queryRaw`SELECT "id" FROM "ContactPoint" WHERE "id" = ${input.contactId}::uuid FOR UPDATE`;
    const contact = await tx.contactPoint.findUnique({ where: { id: input.contactId }, include: { evidence: { select: { id: true, accountId: true } } } });
    if (!contact) throw new RetentionError("NOT_FOUND", "联系项不存在", 404);
    const expiresAt = new Date(Date.now() + SUPPRESSION_TTL_MS);
    await upsertSuppression(tx, actorId, { normalizedValue: contact.normalizedValue, type: contact.type, accountId: contact.evidence.accountId, reasonCode: "USER_REQUEST", basis: input.reason, expiresAt });
    const request = await tx.deletionRequest.create({ data: { targetHash: suppressionFingerprint("CONTACT_ID", contact.id), targetType: "CONTACT", contactId: contact.id, reason: input.reason, requestedById: actorId, completedById: actorId } });
    await deleteExportArtifactsForAccounts(tx, [contact.evidence.accountId]);
    await tx.auditEvent.create({ data: { actorId, action: "CONTACT_DELETED", targetId: contact.id } });
    await tx.auditEvent.create({ data: { actorId, action: "DELETION_COMPLETED", targetId: request.id } });
    await tx.evidence.delete({ where: { id: contact.evidence.id } });
    return { id: contact.id, targetType: "CONTACT", requestId: request.id };
  });
}

export async function listDeletionRequests(db: PrismaClient) {
  return db.deletionRequest.findMany({ orderBy: { completedAt: "desc" }, take: 100, select: { id: true, targetHash: true, targetType: true, reason: true, status: true, requestedBy: { select: { email: true } }, completedAt: true } });
}
