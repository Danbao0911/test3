import { Prisma } from "../generated/prisma/client";
import type { AccountLinkBasis, AccountLinkStatus, PrismaClient } from "../generated/prisma/client";
import { canMaintain, type Role } from "./permissions";
import { sourceTypeAllowed } from "./runtime-config";

export class AccountLinkError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) {
    super(message);
    this.name = "AccountLinkError";
  }
}

export const accountLinkInclude = {
  leftAccount: { select: { id: true, platform: true, displayName: true, organization: true, isDemo: true } },
  rightAccount: { select: { id: true, platform: true, displayName: true, organization: true, isDemo: true } },
  source: { select: { id: true, name: true, status: true, allowRelate: true, policyVersion: true, expiresAt: true } },
  createdBy: { select: { id: true, email: true } },
  reviewedBy: { select: { id: true, email: true } },
} satisfies Prisma.AccountLinkInclude;

type AccountLinkRecord = Prisma.AccountLinkGetPayload<{ include: typeof accountLinkInclude }>;

export type AccountLinkCreateInput = {
  leftAccountId: string;
  rightAccountId: string;
  sourceId: string;
  basis: AccountLinkBasis;
  basisContactId?: string;
  matchingContactId?: string;
};

export type AccountLinkReviewInput = {
  expectedVersion: number;
  status: Extract<AccountLinkStatus, "CONFIRMED" | "REVOKED">;
  reason: string;
};

export function canonicalAccountPair(leftAccountId: string, rightAccountId: string) {
  if (leftAccountId === rightAccountId) throw new AccountLinkError("SAME_ACCOUNT", "不能把账号关联到自身", 422);
  return leftAccountId < rightAccountId ? [leftAccountId, rightAccountId] as const : [rightAccountId, leftAccountId] as const;
}

async function requireWriter(tx: Prisma.TransactionClient, actorId: string) {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, role: true } });
  if (!actor || !canMaintain(actor.role)) throw new AccountLinkError("FORBIDDEN", "当前角色无账号关联操作权限", 403);
}

async function lockSourceForRelating(tx: Prisma.TransactionClient, sourceId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Source" WHERE "id" = ${sourceId}::uuid FOR UPDATE`;
  const source = await tx.source.findUnique({ where: { id: sourceId } });
  if (!source) throw new AccountLinkError("SOURCE_NOT_FOUND", "来源不存在", 404);
  const snapshot = await tx.sourcePolicySnapshot.findUnique({ where: { sourceId_version: { sourceId, version: source.policyVersion } } });
  const allowed = source.status === "APPROVED" && source.allowRelate && Boolean(source.permissionNote.trim()) &&
    (!source.expiresAt || source.expiresAt > new Date()) && sourceTypeAllowed(source.type) &&
    snapshot && !snapshot.isLegacy && snapshot.version === source.policyVersion && snapshot.allowRelate === true;
  if (!allowed) throw new AccountLinkError("SOURCE_RELATE_NOT_ALLOWED", "来源当前未批准账号关联，或关联策略已撤销/到期", 403);
  return { source, snapshot };
}

async function lockAccountPair(tx: Prisma.TransactionClient, leftAccountId: string, rightAccountId: string) {
  const [left, right] = canonicalAccountPair(leftAccountId, rightAccountId);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`test3:account-link:${left}:${right}`}))`;
  await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" IN (${left}::uuid, ${right}::uuid) ORDER BY "id" FOR UPDATE`;
  const accounts = await tx.account.findMany({ where: { id: { in: [left, right] } }, select: { id: true } });
  if (accounts.length !== 2) throw new AccountLinkError("ACCOUNT_NOT_FOUND", "待关联账号不存在", 404);
  return [left, right] as const;
}

async function validateSharedContactCandidate(
  tx: Prisma.TransactionClient,
  sourceId: string,
  leftAccountId: string,
  rightAccountId: string,
  basisContactId: string,
  matchingContactId: string,
) {
  const contacts = await tx.contactPoint.findMany({
    where: { id: { in: [basisContactId, matchingContactId] } },
    select: { id: true, type: true, normalizedValue: true, status: true, expiresAt: true, evidence: { select: { accountId: true, sourceId: true, policyVersion: true } } },
  });
  const basis = contacts.find((item) => item.id === basisContactId);
  const matching = contacts.find((item) => item.id === matchingContactId);
  if (!basis || !matching) throw new AccountLinkError("CANDIDATE_NOT_FOUND", "共享联系候选证据不存在", 422);
  const accountsMatch = new Set([basis.evidence.accountId, matching.evidence.accountId]);
  if (accountsMatch.size !== 2 || !accountsMatch.has(leftAccountId) || !accountsMatch.has(rightAccountId)) {
    throw new AccountLinkError("CANDIDATE_ACCOUNT_MISMATCH", "共享联系候选与待关联账号不匹配", 422);
  }
  if (basis.type !== matching.type || basis.normalizedValue !== matching.normalizedValue || basis.status !== "APPROVED" || matching.status !== "APPROVED" ||
      basis.expiresAt <= new Date() || matching.expiresAt <= new Date() ||
      basis.evidence.sourceId !== sourceId || matching.evidence.sourceId !== sourceId) {
    throw new AccountLinkError("CANDIDATE_NOT_VALID", "共享联系只能作为当前获准来源下的待核验候选，不能直接确认关联", 422);
  }
}

async function loadLink(tx: Prisma.TransactionClient, id: string) {
  return tx.accountLink.findUnique({ where: { id }, include: accountLinkInclude });
}

export function accountLinkDto(item: AccountLinkRecord, role: Role) {
  const sourceUsable = item.source.status === "APPROVED" && item.source.allowRelate &&
    (!item.source.expiresAt || item.source.expiresAt > new Date()) && item.source.policyVersion === item.policyVersion;
  return {
    id: item.id,
    status: item.status,
    basis: item.basis,
    version: item.version,
    usable: item.status === "CONFIRMED" && sourceUsable,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    leftAccount: item.leftAccount,
    rightAccount: item.rightAccount,
    source: role === "VIEWER" ? { id: item.source.id, name: item.source.name, status: item.source.status } : item.source,
    reason: canMaintain(role) ? item.reason : null,
    createdBy: canMaintain(role) ? item.createdBy : null,
    reviewedBy: canMaintain(role) ? item.reviewedBy : null,
  };
}

export async function createAccountLink(db: PrismaClient, actorId: string, input: AccountLinkCreateInput) {
  return db.$transaction(async (tx) => {
    await requireWriter(tx, actorId);
    const [leftAccountId, rightAccountId] = await lockAccountPair(tx, input.leftAccountId, input.rightAccountId);
    const { source } = await lockSourceForRelating(tx, input.sourceId);
    if (input.basis === "SHARED_CONTACT_CANDIDATE") {
      if (!input.basisContactId || !input.matchingContactId) throw new AccountLinkError("CANDIDATE_REQUIRED", "共享联系候选必须保留两条联系证据的内部引用", 422);
      await validateSharedContactCandidate(tx, input.sourceId, leftAccountId, rightAccountId, input.basisContactId, input.matchingContactId);
    }
    const existing = await tx.accountLink.findUnique({ where: { leftAccountId_rightAccountId: { leftAccountId, rightAccountId } }, include: accountLinkInclude });
    if (existing) {
      if (existing.status === "REVOKED") throw new AccountLinkError("LINK_REVOKED", "该关联已撤销，不能静默恢复；请建立新的人工核验记录", 409);
      return { created: false, item: existing };
    }
    const link = await tx.accountLink.create({
      data: { leftAccountId, rightAccountId, sourceId: source.id, policyVersion: source.policyVersion, basis: input.basis,
        basisContactId: input.basisContactId, matchingContactId: input.matchingContactId, createdById: actorId },
      include: accountLinkInclude,
    });
    await tx.auditEvent.create({ data: { actorId, action: "ACCOUNT_LINK_SUGGESTED", targetId: link.id } });
    return { created: true, item: link };
  });
}

export async function suggestAccountLinksForContact(db: PrismaClient, actorId: string, contactId: string) {
  return db.$transaction(async (tx) => {
    await requireWriter(tx, actorId);
    const contact = await tx.contactPoint.findUnique({
      where: { id: contactId },
      select: { id: true, type: true, normalizedValue: true, status: true, expiresAt: true, evidence: { select: { accountId: true, sourceId: true, policyVersion: true } } },
    });
    if (!contact) throw new AccountLinkError("CONTACT_NOT_FOUND", "联系项不存在", 404);
    const { source } = await lockSourceForRelating(tx, contact.evidence.sourceId);
    if (contact.status !== "APPROVED" || contact.expiresAt <= new Date() || contact.evidence.policyVersion !== source.policyVersion) {
      throw new AccountLinkError("CONTACT_NOT_CURRENT", "只有当前来源策略下已审核通过的联系项才能生成待核验关联候选", 422);
    }
    const matches = await tx.contactPoint.findMany({
      where: { id: { not: contact.id }, type: contact.type, normalizedValue: contact.normalizedValue, status: "APPROVED", expiresAt: { gt: new Date() },
        evidence: { sourceId: source.id, policyVersion: source.policyVersion, accountId: { not: contact.evidence.accountId } } },
      select: { id: true, evidence: { select: { accountId: true } } },
    });
    const suggestions: AccountLinkRecord[] = [];
    for (const match of matches) {
      const [leftAccountId, rightAccountId] = await lockAccountPair(tx, contact.evidence.accountId, match.evidence.accountId);
      const existing = await tx.accountLink.findUnique({ where: { leftAccountId_rightAccountId: { leftAccountId, rightAccountId } }, include: accountLinkInclude });
      if (existing) continue;
      const link = await tx.accountLink.create({
        data: { leftAccountId, rightAccountId, sourceId: source.id, policyVersion: source.policyVersion, basis: "SHARED_CONTACT_CANDIDATE",
          basisContactId: contact.id, matchingContactId: match.id, createdById: actorId },
        include: accountLinkInclude,
      });
      await tx.auditEvent.create({ data: { actorId, action: "ACCOUNT_LINK_SUGGESTED", targetId: link.id } });
      suggestions.push(link);
    }
    return suggestions;
  });
}

export async function listAccountLinks(db: PrismaClient, options: { accountId?: string; status?: AccountLinkStatus }) {
  return db.accountLink.findMany({
    where: { ...(options.accountId ? { OR: [{ leftAccountId: options.accountId }, { rightAccountId: options.accountId }] } : {}), ...(options.status ? { status: options.status } : {}) },
    include: accountLinkInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  });
}

export async function reviewAccountLink(db: PrismaClient, actorId: string, linkId: string, input: AccountLinkReviewInput) {
  return db.$transaction(async (tx) => {
    await requireWriter(tx, actorId);
    await tx.$queryRaw`SELECT "id" FROM "AccountLink" WHERE "id" = ${linkId}::uuid FOR UPDATE`;
    const current = await loadLink(tx, linkId);
    if (!current) throw new AccountLinkError("LINK_NOT_FOUND", "账号关联不存在", 404);
    if (current.version !== input.expectedVersion) throw new AccountLinkError("LINK_CONFLICT", "账号关联已被其他操作更新，请刷新后再审核", 409);
    if (input.status === "CONFIRMED") {
      if (current.status !== "PENDING") throw new AccountLinkError("INVALID_TRANSITION", "只有待核验关联才能确认；已撤销记录不能直接恢复", 409);
      await lockSourceForRelating(tx, current.sourceId);
    } else if (current.status === "REVOKED") {
      throw new AccountLinkError("INVALID_TRANSITION", "账号关联已经撤销", 409);
    }
    const updated = await tx.accountLink.update({ where: { id: linkId }, data: { status: input.status, reason: input.reason, version: input.expectedVersion + 1, reviewedById: actorId }, include: accountLinkInclude });
    await tx.auditEvent.create({ data: { actorId, action: `ACCOUNT_LINK_${input.status}`, targetId: linkId } });
    return updated;
  });
}
