import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client";
import { getPlatformAdapter } from "../connectors/registry";
import { platformIds, platformOperations } from "../connectors/types";
import type { Role } from "./permissions";

export const platformPreflightSchema = z.object({
  platform: z.enum(platformIds),
  operation: z.enum(platformOperations),
  sourceId: z.uuid(),
  expectedPolicyVersion: z.number().int().positive(),
}).strict();

export class PlatformPreflightError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

// Explicit select: do not publish source notes, evidence, authorization text or credentials.
const sourceSelect = { id: true, name: true, type: true, status: true, policyVersion: true, expiresAt: true, allowImport: true } as const;

export async function platformSourcePage(db: PrismaClient, user: { role: Role }, after?: string) {
  if (user.role !== "ADMIN") throw new PlatformPreflightError("FORBIDDEN", "仅管理员可核对平台接入条件", 403);
  const rows = await db.source.findMany({
    where: after ? { id: { gt: after } } : {}, orderBy: { id: "asc" }, take: 21, select: sourceSelect,
  });
  return { items: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19].id : null };
}

/** This is an advisory, read-only check. It never issues a grant, task or token.
 * Future real execution must reauthorize independently at execution time.
 */
export async function checkPlatformReadiness(db: PrismaClient, user: { role: Role }, rawInput: unknown) {
  if (user.role !== "ADMIN") throw new PlatformPreflightError("FORBIDDEN", "仅管理员可核对平台接入条件", 403);
  const parsed = platformPreflightSchema.safeParse(rawInput);
  if (!parsed.success) throw new PlatformPreflightError("VALIDATION_ERROR", "请选择平台、操作、来源和当前策略版本；不接受其他字段", 422);
  const input = parsed.data;
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Source" WHERE "id" = ${input.sourceId}::uuid FOR SHARE`;
    const source = await tx.source.findUnique({ where: { id: input.sourceId }, select: sourceSelect });
    if (!source) throw new PlatformPreflightError("NOT_FOUND", "来源不存在", 404);
    if (source.policyVersion !== input.expectedPolicyVersion) throw new PlatformPreflightError("SOURCE_POLICY_CONFLICT", "来源策略已变化，请刷新来源并重新核对", 409);
    const snapshot = await tx.sourcePolicySnapshot.findUnique({
      where: { sourceId_version: { sourceId: source.id, version: source.policyVersion } },
      select: { id: true, isLegacy: true, status: true, allowImport: true },
    });
    const checkedAt = new Date();
    const blockers: Array<{ code: string; message: string }> = [];
    if (source.status !== "APPROVED") blockers.push({ code: "SOURCE_NOT_APPROVED", message: "当前来源尚未批准或已撤销。" });
    if (source.expiresAt && source.expiresAt <= checkedAt) blockers.push({ code: "SOURCE_EXPIRED", message: "当前来源已到期。" });
    if (!snapshot || snapshot.isLegacy) blockers.push({ code: "POLICY_HISTORY_UNKNOWN", message: "当前策略缺少可核验的非历史未知快照。" });
    if (!source.allowImport || snapshot?.allowImport !== true || snapshot.status !== "APPROVED") blockers.push({ code: "IMPORT_NOT_ALLOWED", message: "当前策略不允许账号录入。" });
    blockers.push({ code: "OFFICIAL_API_GRANT_MISSING", message: source.type === "DEMO" ? "演示来源只能用于合成数据，不能授权官方平台调用。" : "人工来源许可只适用于已获准的人工录入，不能授权官方平台调用。" });
    blockers.push({ code: "LIVE_VERIFICATION_MISSING", message: "未登记项目应用、账号范围、字段许可和真实调用证据。" });
    blockers.push({ code: "LIFECYCLE_VERIFICATION_PENDING", message: "真实数据恢复重放与清理运行验收尚未完成。" });
    const result = await getPlatformAdapter(input.platform)[input.operation]();
    return {
      platform: input.platform, operation: input.operation,
      status: result.status === "not_supported" ? "not_supported" as const : "permission_required" as const,
      executed: false as const, outboundRequests: 0, advisoryOnly: true,
      source: { id: source.id, policyVersion: source.policyVersion, status: source.status },
      checkedAt: checkedAt.toISOString(), blockers, adapter: result,
    };
  });
}

export type PlatformPreflight = Awaited<ReturnType<typeof checkPlatformReadiness>>;
