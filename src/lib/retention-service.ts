import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { suppressionFingerprint, suppressionFingerprintCandidates, stableIdentityFingerprints, ACCOUNT_IDENTITY_FINGERPRINT_VERSION, SUPPRESSION_FINGERPRINT_KEY_ID, SUPPRESSION_FINGERPRINT_VERSION } from "./data-protection";
import { deletionRuleMatchesAccount } from "./identity-rules";
import { clearAccountDependencies, clearContactDependencies } from "./retention-dependencies";
import { lockContactValueKeys, lockRows } from "./resource-locks";
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

async function suppressAllCopies(tx: Prisma.TransactionClient, actorId: string, input: { normalizedValue: string; type: string; accountId?: string; contactId?: string; reasonCode: string; basis: string; expiresAt: Date }, now: Date) {
  const suppression = await upsertSuppression(tx, actorId, input);
  const contacts = await tx.contactPoint.findMany({ where: { type: input.type as never, normalizedValue: input.normalizedValue }, select: { id: true, status: true, version: true } });
  await lockRows(tx, "ContactPoint", contacts.map((item) => item.id));
  let changed = suppression.changed;
  for (const item of contacts) {
    if (item.status === "INVALID") {
      await tx.contactPoint.update({ where: { id: item.id }, data: { suppressed: true } });
      continue;
    }
    const version = item.version + 1;
    await tx.contactPoint.update({ where: { id: item.id }, data: { status: "INVALID", suppressed: true, ownershipConfirmed: false, businessConfirmed: false, reviewedAt: now, version } });
    await tx.reviewDecision.create({ data: { contactId: item.id, reviewerId: actorId, status: "INVALID", reason: input.basis, ownershipConfirmed: false, businessConfirmed: false, version } });
    changed = true;
  }
  return { ...suppression, changed, affectedCount: contacts.length };
}

export async function suppressContact(db: PrismaClient, actorId: string, contactId: string, input: SuppressionInput) {
  const now = new Date();
  const expiresAt = suppressionExpiry(input, now);
  return db.$transaction(async (tx) => {
    const initial = await tx.contactPoint.findUnique({ where: { id: contactId }, include: { evidence: { select: { accountId: true } } } });
    if (!initial) throw new RetentionError("NOT_FOUND", "联系项不存在", 404);
    await lockContactValueKeys(tx, [{ type: initial.type, normalizedValue: initial.normalizedValue }]);
    await lockRows(tx, "Account", [initial.evidence.accountId]);
    await lockRows(tx, "ContactPoint", [contactId]);
    const contact = await tx.contactPoint.findUnique({ where: { id: contactId }, include: { evidence: { select: { accountId: true } } } });
    if (!contact) throw new RetentionError("NOT_FOUND", "联系项不存在", 404);
    const suppression = await suppressAllCopies(tx, actorId, { normalizedValue: contact.normalizedValue, type: contact.type, accountId: contact.evidence.accountId, contactId, reasonCode: input.reasonCode, basis: input.basis, expiresAt }, now);
    const changed = suppression.changed;
    if (!changed) return { id: contactId, changed: false, expiresAt };
    await tx.auditEvent.create({ data: { actorId, action: "CONTACT_SUPPRESSED", targetId: contactId } });
    return { id: contactId, changed: true, expiresAt, affectedCount: suppression.affectedCount };
  });
}

export async function deleteTarget(db: PrismaClient, actorId: string, input: DeletionRequestInput) {
  return db.$transaction(async (tx) => {
    if (input.accountId) {
      const initial = await tx.account.findUnique({ where: { id: input.accountId }, include: { evidence: { include: { contact: true } } } });
      if (!initial) throw new RetentionError("NOT_FOUND", "账号不存在", 404);
      await lockContactValueKeys(tx, initial.evidence.flatMap((evidence) => evidence.contact ? [{ type: evidence.contact.type, normalizedValue: evidence.contact.normalizedValue }] : []));
      await lockRows(tx, "Account", [input.accountId]);
      const account = await tx.account.findUnique({ where: { id: input.accountId }, include: { evidence: { include: { contact: true } } } });
      if (!account) throw new RetentionError("NOT_FOUND", "账号不存在", 404);
      const expiresAt = new Date(Date.now() + SUPPRESSION_TTL_MS);
      for (const evidence of account.evidence) {
        if (evidence.contact) await suppressAllCopies(tx, actorId, { normalizedValue: evidence.contact.normalizedValue, type: evidence.contact.type, accountId: account.id, reasonCode: "USER_REQUEST", basis: input.reason, expiresAt }, new Date());
      }
      const identity = stableIdentityFingerprints({ platform: account.platform, nativeId: account.nativeId, normalizedProfileUrl: account.normalizedProfileUrl });
      const request = await tx.deletionRequest.create({ data: { targetHash: suppressionFingerprint("ACCOUNT_ID", account.id), targetType: "ACCOUNT", accountId: account.id, identityNativeFingerprint: identity.nativeId, identityProfileFingerprint: identity.profileUrl, identityType: "ACCOUNT_PLATFORM_IDENTITY_V2", identityVersion: ACCOUNT_IDENTITY_FINGERPRINT_VERSION, identityKeyId: SUPPRESSION_FINGERPRINT_KEY_ID, scope: "ACCOUNT_REIMPORT_BLOCK", identityExpiresAt: new Date(Date.now() + SUPPRESSION_TTL_MS), reason: input.reason, requestedById: actorId, completedById: actorId } });
      await clearAccountDependencies(tx, account.id, account.evidence.map((evidence) => evidence.id));
      await tx.auditEvent.create({ data: { actorId, action: "ACCOUNT_DELETED", targetId: account.id } });
      await tx.auditEvent.create({ data: { actorId, action: "DELETION_COMPLETED", targetId: request.id } });
      await tx.account.delete({ where: { id: account.id } });
      return { id: account.id, targetType: "ACCOUNT", requestId: request.id };
    }
    if (!input.contactId) throw new RetentionError("VALIDATION_ERROR", "必须选择删除目标");
    const initial = await tx.contactPoint.findUnique({ where: { id: input.contactId }, include: { evidence: { select: { id: true, accountId: true } } } });
    if (!initial) throw new RetentionError("NOT_FOUND", "联系项不存在", 404);
    const initialValue = await tx.contactPoint.findUnique({ where: { id: input.contactId }, select: { type: true, normalizedValue: true } });
    if (!initialValue) throw new RetentionError("NOT_FOUND", "联系项不存在", 404);
    await lockContactValueKeys(tx, [initialValue]);
    await lockRows(tx, "Account", [initial.evidence.accountId]);
    await lockRows(tx, "ContactPoint", [input.contactId]);
    const contact = await tx.contactPoint.findUnique({ where: { id: input.contactId }, include: { evidence: { select: { id: true, accountId: true } } } });
    if (!contact) throw new RetentionError("NOT_FOUND", "联系项不存在", 404);
    const expiresAt = new Date(Date.now() + SUPPRESSION_TTL_MS);
    await suppressAllCopies(tx, actorId, { normalizedValue: contact.normalizedValue, type: contact.type, accountId: contact.evidence.accountId, contactId: contact.id, reasonCode: "USER_REQUEST", basis: input.reason, expiresAt }, new Date());
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

export type ReplayOptions = { dryRun?: boolean; now?: Date; batchSize?: number; accountCursor?: string; contactCursor?: string; accountDone?: boolean; contactDone?: boolean };

/**
 * Replays only scoped, versioned rules in an isolated restore database. Legacy
 * UUID-only rules are reported as unknown instead of guessing a replacement.
 */
export async function replayDeletionRules(db: PrismaClient, actorId: string, options: ReplayOptions = {}) {
  const now = options.now ?? new Date();
  const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1_000);
  const rules = await db.deletionRequest.findMany({ where: { scope: "ACCOUNT_REIMPORT_BLOCK", identityVersion: ACCOUNT_IDENTITY_FINGERPRINT_VERSION, OR: [{ identityExpiresAt: null }, { identityExpiresAt: { gt: now } }] }, select: { id: true, identityNativeFingerprint: true, identityProfileFingerprint: true, identityVersion: true, identityKeyId: true } });
  const legacyUnknown = await db.deletionRequest.count({ where: { scope: "LEGACY_UNKNOWN" } });
  const blockedRules = rules.filter((rule) => rule.identityKeyId !== SUPPRESSION_FINGERPRINT_KEY_ID || rule.identityVersion !== ACCOUNT_IDENTITY_FINGERPRINT_VERSION);
  const accounts = options.accountDone ? [] : await db.account.findMany({ where: options.accountCursor ? { id: { gt: options.accountCursor } } : {}, take: batchSize + 1, orderBy: { id: "asc" }, select: { id: true, platform: true, nativeId: true, normalizedProfileUrl: true, evidence: { select: { id: true } } } });
  const accountPage = accounts.slice(0, batchSize);
  const accountHasMore = accounts.length > batchSize;
  const validRules = rules.filter((rule) => !blockedRules.includes(rule));
  const matched = accountPage.filter((account) => validRules.some((rule) => deletionRuleMatchesAccount(account, rule)));
  const suppressions = await db.contactSuppression.findMany({ where: { expiresAt: { gt: now } }, select: { fingerprint: true, fingerprintVersion: true, fingerprintKeyId: true } });
  const supportedSuppression = (suppression: { fingerprintVersion: number; fingerprintKeyId: string }) => (suppression.fingerprintVersion === SUPPRESSION_FINGERPRINT_VERSION && suppression.fingerprintKeyId === SUPPRESSION_FINGERPRINT_KEY_ID) || (suppression.fingerprintVersion === 1 && suppression.fingerprintKeyId === "legacy-v1");
  const blockedSuppressions = suppressions.filter((suppression) => !supportedSuppression(suppression));
  const restoredContacts = options.contactDone ? [] : await db.contactPoint.findMany({ where: options.contactCursor ? { id: { gt: options.contactCursor } } : {}, take: batchSize + 1, orderBy: { id: "asc" }, select: { id: true, type: true, normalizedValue: true, evidence: { select: { id: true, accountId: true } } } });
  const contactPage = restoredContacts.slice(0, batchSize);
  const contactHasMore = restoredContacts.length > batchSize;
  const matchedContacts = contactPage.filter((contact) => suppressionFingerprintCandidates(contact.type, contact.normalizedValue).some((fingerprint) => suppressions.some((suppression) => suppression.fingerprint === fingerprint && supportedSuppression(suppression))));
  const next = { accountCursor: accountPage.length === batchSize ? accountPage.at(-1)?.id ?? null : null, accountDone: options.accountDone === true || !accountHasMore, contactCursor: contactPage.length === batchSize ? contactPage.at(-1)?.id ?? null : null, contactDone: options.contactDone === true || !contactHasMore };
  const resultBase = { scanned: { accounts: accountPage.length, contacts: contactPage.length }, matched: { accounts: matched.length, contacts: matchedContacts.length }, legacyUnknown, rules: rules.length, blockedRules: blockedRules.length + blockedSuppressions.length, hasMore: (!next.accountDone && accountHasMore) || (!next.contactDone && contactHasMore), next };
  if (options.dryRun) return { dryRun: true, accounts: matched.length, contacts: matchedContacts.length, deleted: { accounts: 0, contacts: 0 }, ...resultBase };
  let removedAccounts = 0;
  for (const account of matched) {
    await db.$transaction(async (tx) => {
      const current = await tx.account.findUnique({ where: { id: account.id }, include: { evidence: { include: { contact: true } } } });
      if (!current) return;
      await lockContactValueKeys(tx, current.evidence.flatMap((evidence) => evidence.contact ? [{ type: evidence.contact.type, normalizedValue: evidence.contact.normalizedValue }] : []));
      await lockRows(tx, "Account", [current.id]);
      for (const evidence of current.evidence) if (evidence.contact) await suppressAllCopies(tx, actorId, { normalizedValue: evidence.contact.normalizedValue, type: evidence.contact.type, accountId: current.id, reasonCode: "USER_REQUEST", basis: "恢复重放删除规则", expiresAt: new Date(now.getTime() + SUPPRESSION_TTL_MS) }, now);
      await clearAccountDependencies(tx, current.id, current.evidence.map((evidence) => evidence.id));
      await tx.account.delete({ where: { id: current.id } });
      await tx.auditEvent.create({ data: { actorId, action: "DELETION_REPLAYED", targetId: current.id } });
      removedAccounts += 1;
    });
  }
  let removedContacts = 0;
  for (const contact of matchedContacts) {
    await db.$transaction(async (tx) => {
      const current = await tx.contactPoint.findUnique({ where: { id: contact.id }, include: { evidence: { select: { id: true, accountId: true } } } });
      if (!current) return;
      await lockContactValueKeys(tx, [{ type: current.type, normalizedValue: current.normalizedValue }]);
      await lockRows(tx, "Account", [current.evidence.accountId]);
      await lockRows(tx, "ContactPoint", [current.id]);
      await clearContactDependencies(tx, current.id, current.evidence.id, current.evidence.accountId);
      await tx.auditEvent.create({ data: { actorId, action: "CONTACT_DELETION_REPLAYED", targetId: current.id } });
      removedContacts += 1;
    });
  }
  return { dryRun: false, accounts: removedAccounts, contacts: removedContacts, deleted: { accounts: removedAccounts, contacts: removedContacts }, ...resultBase };
}
