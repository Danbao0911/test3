import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { suppressionFingerprint, suppressionFingerprintCandidates, stableIdentityFingerprint, SUPPRESSION_FINGERPRINT_KEY_ID, SUPPRESSION_FINGERPRINT_VERSION } from "./data-protection";
import { clearAccountDependencies, clearContactDependencies } from "./retention-dependencies";
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
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`test3:suppression:${fingerprint}`}))::text AS locked`;
  const existing = (await tx.contactSuppression.findMany({ where: { fingerprint: { in: suppressionFingerprintCandidates(input.type, input.normalizedValue) } }, orderBy: { expiresAt: "desc" }, take: 1 }))[0];
  if (!existing || existing.expiresAt <= new Date()) {
    if (existing) {
      await tx.contactSuppression.update({ where: { id: existing.id }, data: { fingerprint, fingerprintVersion: SUPPRESSION_FINGERPRINT_VERSION, fingerprintKeyId: SUPPRESSION_FINGERPRINT_KEY_ID, scope: "CONTACT_VALUE_GLOBAL", accountId: input.accountId, contactId: input.contactId, contactType: input.type as "EMAIL" | "WECHAT" | "PHONE" | "CONTACT_URL" | "BOOKING_URL", reasonCode: input.reasonCode, basis: input.basis, expiresAt: input.expiresAt, createdById: actorId } });
    } else {
      await tx.contactSuppression.create({ data: { fingerprint, fingerprintVersion: SUPPRESSION_FINGERPRINT_VERSION, fingerprintKeyId: SUPPRESSION_FINGERPRINT_KEY_ID, scope: "CONTACT_VALUE_GLOBAL", accountId: input.accountId, contactId: input.contactId, contactType: input.type as "EMAIL" | "WECHAT" | "PHONE" | "CONTACT_URL" | "BOOKING_URL", reasonCode: input.reasonCode, basis: input.basis, expiresAt: input.expiresAt, createdById: actorId } });
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
    const contacts = await tx.contactPoint.findMany({ where: { type: contact.type, normalizedValue: contact.normalizedValue }, select: { id: true, status: true, version: true } });
    for (const item of contacts.sort((left, right) => left.id.localeCompare(right.id))) await tx.$queryRaw`SELECT "id" FROM "ContactPoint" WHERE "id" = ${item.id}::uuid FOR UPDATE`;
    let changed = suppression.changed;
    for (const item of contacts) {
      if (item.status === "INVALID") { await tx.contactPoint.update({ where: { id: item.id }, data: { suppressed: true } }); continue; }
      const version = item.version + 1;
      await tx.contactPoint.update({ where: { id: item.id }, data: { status: "INVALID", suppressed: true, ownershipConfirmed: false, businessConfirmed: false, reviewedAt: now, version } });
      await tx.reviewDecision.create({ data: { contactId: item.id, reviewerId: actorId, status: "INVALID", reason: input.basis, ownershipConfirmed: false, businessConfirmed: false, version } });
      changed = true;
    }
    if (!changed) return { id: contactId, changed: false, expiresAt };
    await tx.auditEvent.create({ data: { actorId, action: "CONTACT_SUPPRESSED", targetId: contactId } });
    return { id: contactId, changed: true, expiresAt, affectedCount: contacts.length };
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
      const identityFingerprint = stableIdentityFingerprint({ platform: account.platform, nativeId: account.nativeId, normalizedProfileUrl: account.normalizedProfileUrl });
      const request = await tx.deletionRequest.create({ data: { targetHash: suppressionFingerprint("ACCOUNT_ID", account.id), targetType: "ACCOUNT", accountId: account.id, identityFingerprint, identityType: "ACCOUNT_PLATFORM_IDENTITY", identityVersion: 1, identityKeyId: SUPPRESSION_FINGERPRINT_KEY_ID, scope: "ACCOUNT_REIMPORT_BLOCK", identityExpiresAt: new Date(Date.now() + SUPPRESSION_TTL_MS), reason: input.reason, requestedById: actorId, completedById: actorId } });
      await clearAccountDependencies(tx, account.id, account.evidence.map((evidence) => evidence.id));
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
    await clearContactDependencies(tx, contact.id, contact.evidence.id, contact.evidence.accountId);
    await tx.auditEvent.create({ data: { actorId, action: "CONTACT_DELETED", targetId: contact.id } });
    await tx.auditEvent.create({ data: { actorId, action: "DELETION_COMPLETED", targetId: request.id } });
    return { id: contact.id, targetType: "CONTACT", requestId: request.id };
  });
}

export async function listDeletionRequests(db: PrismaClient) {
  return db.deletionRequest.findMany({ orderBy: { completedAt: "desc" }, take: 100, select: { id: true, targetHash: true, targetType: true, reason: true, status: true, requestedBy: { select: { email: true } }, completedAt: true } });
}

export type ReplayOptions = { dryRun?: boolean; now?: Date; batchSize?: number };

/**
 * Replays only scoped, versioned rules in an isolated restore database. Legacy
 * UUID-only rules are reported as unknown instead of guessing a replacement.
 */
export async function replayDeletionRules(db: PrismaClient, actorId: string, options: ReplayOptions = {}) {
  const now = options.now ?? new Date();
  const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1_000);
  const rules = await db.deletionRequest.findMany({ where: { scope: "ACCOUNT_REIMPORT_BLOCK", identityFingerprint: { not: null }, OR: [{ identityExpiresAt: null }, { identityExpiresAt: { gt: now } }] }, select: { id: true, identityFingerprint: true, identityVersion: true, identityKeyId: true } });
  const legacyUnknown = await db.deletionRequest.count({ where: { scope: "LEGACY_UNKNOWN" } });
  const accounts = await db.account.findMany({ take: batchSize, orderBy: { id: "asc" }, select: { id: true, platform: true, nativeId: true, normalizedProfileUrl: true, evidence: { select: { id: true } } } });
  const matched = accounts.filter((account) => rules.some((rule) => rule.identityFingerprint === stableIdentityFingerprint(account)));
  const suppressions = await db.contactSuppression.findMany({ where: { expiresAt: { gt: now } }, select: { fingerprint: true } });
  const restoredContacts = await db.contactPoint.findMany({ take: batchSize, orderBy: { id: "asc" }, select: { id: true, type: true, normalizedValue: true, evidence: { select: { id: true, accountId: true } } } });
  const matchedContacts = restoredContacts.filter((contact) => suppressionFingerprintCandidates(contact.type, contact.normalizedValue).some((fingerprint) => suppressions.some((suppression) => suppression.fingerprint === fingerprint)));
  if (options.dryRun) return { dryRun: true, accounts: matched.length, contacts: matchedContacts.length, legacyUnknown, rules: rules.length };
  let removedAccounts = 0;
  for (const account of matched) {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${account.id}::uuid FOR UPDATE`;
      const current = await tx.account.findUnique({ where: { id: account.id }, include: { evidence: { select: { id: true } } } });
      if (!current) return;
      await clearAccountDependencies(tx, current.id, current.evidence.map((evidence) => evidence.id));
      await tx.account.delete({ where: { id: current.id } });
      await tx.auditEvent.create({ data: { actorId, action: "DELETION_REPLAYED", targetId: current.id } });
      removedAccounts += 1;
    });
  }
  let removedContacts = 0;
  for (const contact of matchedContacts) {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ContactPoint" WHERE "id" = ${contact.id}::uuid FOR UPDATE`;
      const current = await tx.contactPoint.findUnique({ where: { id: contact.id }, include: { evidence: { select: { id: true, accountId: true } } } });
      if (!current) return;
      await clearContactDependencies(tx, current.id, current.evidence.id, current.evidence.accountId);
      await tx.auditEvent.create({ data: { actorId, action: "CONTACT_DELETION_REPLAYED", targetId: current.id } });
      removedContacts += 1;
    });
  }
  return { dryRun: false, accounts: removedAccounts, contacts: removedContacts, legacyUnknown, rules: rules.length };
}
