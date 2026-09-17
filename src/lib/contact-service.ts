import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { normalizeSourceUrl } from "./account-normalizer";
import { extractContacts, isSyntheticContact } from "./contact-extractor";
import { extractionAllowed, contactUsable } from "./contact-policy";
import { canMaintain, type Role } from "./permissions";
import { currentRuntimeMode, sourceTypeAllowed } from "./runtime-config";
import type { ExtractionInput, ReviewInput } from "./contact-validation";

export class ContactError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message); }
}

async function requireWriter(tx: Prisma.TransactionClient, actorId: string) {
  const actor = await tx.user.findUnique({ where: { id: actorId } });
  if (!actor || !canMaintain(actor.role)) throw new ContactError("FORBIDDEN", "当前角色无操作权限", 403);
}

async function lockSource(tx: Prisma.TransactionClient, sourceId: string) {
  // Same lock as source editing and import: revocation and writes have a defined commit order.
  await tx.$queryRaw`SELECT "id" FROM "Source" WHERE "id" = ${sourceId}::uuid FOR UPDATE`;
  const source = await tx.source.findUnique({ where: { id: sourceId } });
  if (!source) throw new ContactError("NOT_FOUND", "来源不存在", 404);
  return source;
}

export async function extractForAccount(db: PrismaClient, actorId: string, input: ExtractionInput) {
  // Real-data rollout waits for T07 deletion/suppression/retention work.
  if (currentRuntimeMode() === "production") throw new ContactError("PRODUCTION_DISABLED", "联系处理暂仅开放隔离演示/测试环境；真实数据需等待删除与抑制流程验收", 403);
  return db.$transaction(async tx => {
    await requireWriter(tx, actorId);
    const source = await lockSource(tx, input.sourceId);
    if (!sourceTypeAllowed(source.type) || !extractionAllowed(source)) throw new ContactError("SOURCE_NOT_ALLOWED", "来源未获准提取和保留证据，或已撤销/到期", 403);
    const account = await tx.account.findUnique({ where: { id: input.accountId } });
    if (!account) throw new ContactError("NOT_FOUND", "账号不存在", 404);
    if (!account.isDemo || account.sourceId !== source.id) throw new ContactError("SOURCE_MISMATCH", "当前阶段只能使用该演示账号登记的同一来源", 403);
    let sourceUrl: string;
    try { sourceUrl = normalizeSourceUrl(input.sourceUrl); } catch { throw new ContactError("INVALID_SOURCE_URL", "证据地址必须是安全的 HTTPS 链接"); }
    if (!isSyntheticContact("CONTACT_URL", sourceUrl)) throw new ContactError("SYNTHETIC_ONLY", "演示证据链接只允许 example.com/net/org");
    const now = new Date();
    const capturedAt = new Date(input.capturedAt);
    const expiresAt = new Date(Math.min(capturedAt.getTime() + source.retentionDays * 86400000, source.expiresAt?.getTime() ?? Infinity));
    if (capturedAt > now || expiresAt <= now) throw new ContactError("EVIDENCE_EXPIRED", "取得时间不能在未来，且证据必须仍在有效期内");
    const candidates = extractContacts(input.text, input.context);
    if (candidates.length > 20) throw new ContactError("TOO_MANY_CANDIDATES", "每次最多 20 条候选，请拆分文本");
    if (candidates.some(c => !isSyntheticContact(c.type, c.normalizedValue))) throw new ContactError("SYNTHETIC_ONLY", "仅接受示例域邮箱/链接、demo_ 微信及 +1 202 555 01xx 虚构电话");
    let createdCount = 0;
    const ids: string[] = [];
    for (const candidate of candidates) {
      const dedupeKey = createHash("sha256").update(JSON.stringify([account.id, source.id, source.policyVersion, candidate.type, candidate.normalizedValue])).digest("hex");
      const existing = await tx.contactPoint.findUnique({ where: { dedupeKey } });
      if (existing) { ids.push(existing.id); continue; }
      const item = await tx.contactPoint.create({ data: {
        dedupeKey, type: candidate.type, rawValue: candidate.rawValue, normalizedValue: candidate.normalizedValue, expiresAt,
        evidence: { create: { accountId: account.id, sourceId: source.id, policyVersion: source.policyVersion, sourceUrl,
          capturedAt, fieldLocation: `${input.fieldLocation} · ${candidate.locator}`, excerpt: candidate.excerpt } },
      } });
      await tx.auditEvent.create({ data: { actorId, action: "CONTACT_CANDIDATE_CREATED", targetId: item.id } });
      ids.push(item.id); createdCount++;
    }
    return { ids, createdCount, duplicateCount: candidates.length - createdCount,
      message: candidates.length ? "候选已保存，尚不可用，必须人工核验" : "未识别到明确商务联系字段；没有猜测或补全任何联系值" };
  });
}

export async function reviewContact(db: PrismaClient, actorId: string, contactId: string, input: ReviewInput) {
  return db.$transaction(async tx => {
    await requireWriter(tx, actorId);
    const initial = await tx.contactPoint.findUnique({ where: { id: contactId }, include: { evidence: true } });
    if (!initial) throw new ContactError("NOT_FOUND", "联系项不存在", 404);
    const source = await lockSource(tx, initial.evidence.sourceId);
    await tx.$queryRaw`SELECT "id" FROM "ContactPoint" WHERE "id" = ${contactId}::uuid FOR UPDATE`;
    const current = await tx.contactPoint.findUniqueOrThrow({ where: { id: contactId }, include: { evidence: true } });
    if (current.version !== input.version) throw new ContactError("REVIEW_CONFLICT", "联系项已被其他操作更新，请刷新后再审核", 409);
    const now = new Date();
    if (input.status === "APPROVED") {
      if (currentRuntimeMode() === "production") throw new ContactError("PRODUCTION_DISABLED", "真实数据联系处理尚未开放", 403);
      if (!sourceTypeAllowed(source.type) || !extractionAllowed(source) || source.policyVersion !== current.evidence.policyVersion) throw new ContactError("SOURCE_NOT_ALLOWED", "当前来源策略不允许批准；请核对权限并重新取得证据", 403);
      if (current.expiresAt <= now) throw new ContactError("CONTACT_EXPIRED", "联系证据已过期");
      if (current.status !== "PENDING") throw new ContactError("INVALID_TRANSITION", "仅待审核项可批准；已驳回或失效项不能直接恢复", 409);
      if (!input.ownershipConfirmed || !input.businessConfirmed || !current.evidence.excerpt.trim()) throw new ContactError("CONFIRMATION_REQUIRED", "必须核对证据并分别确认账号归属及明确商务用途");
    }
    const version = current.version + 1;
    const data = { status: input.status, ownershipConfirmed: input.status === "APPROVED" && input.ownershipConfirmed,
      businessConfirmed: input.status === "APPROVED" && input.businessConfirmed, reviewedAt: now, version };
    await tx.contactPoint.update({ where: { id: contactId }, data });
    await tx.reviewDecision.create({ data: { contactId, reviewerId: actorId, version, status: data.status,
      ownershipConfirmed: data.ownershipConfirmed, businessConfirmed: data.businessConfirmed, reason: input.reason } });
    await tx.auditEvent.create({ data: { actorId, action: `CONTACT_${input.status}`, targetId: contactId } });
    return { id: contactId, status: data.status, version };
  });
}

export const contactInclude = {
  evidence: { include: { source: true, account: { select: { id: true, displayName: true, isDemo: true } } } },
  reviews: { orderBy: { version: "desc" }, take: 30, include: { reviewer: { select: { id: true, email: true } } } },
} satisfies Prisma.ContactPointInclude;

type ContactRecord = Prisma.ContactPointGetPayload<{ include: typeof contactInclude }>;

export function contactDto(item: ContactRecord, role: Role) {
  const usable = contactUsable(item);
  const visible = canMaintain(role) && extractionAllowed(item.evidence.source) && item.expiresAt > new Date() && item.evidence.policyVersion === item.evidence.source.policyVersion;
  // Allowlist projection: no raw values hidden elsewhere in evidence, reasons or normalized keys.
  return { id: item.id, type: item.type, value: visible ? item.rawValue : "***", status: item.status, version: item.version,
    usable, masked: !visible, expiresAt: item.expiresAt, reviewedAt: item.reviewedAt, account: item.evidence.account,
    source: { id: item.evidence.sourceId, name: item.evidence.source.name, policyVersion: item.evidence.policyVersion, currentVersion: item.evidence.source.policyVersion },
    evidence: visible ? { sourceUrl: item.evidence.sourceUrl, capturedAt: item.evidence.capturedAt, fieldLocation: item.evidence.fieldLocation, excerpt: item.evidence.excerpt } : null,
    reviews: item.reviews.map(r => ({ id: r.id, status: r.status, createdAt: r.createdAt, reviewerId: r.reviewerId,
      reviewer: canMaintain(role) ? r.reviewer.email : null, reason: visible ? r.reason : null })),
  };
}
