import { NextResponse } from "next/server";
import { canManageSources } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sourcePatchSchema, uuidSchema, validationMessage } from "@/lib/validation";
import { sourceTypeAllowed, RUNTIME_MODE } from "@/lib/runtime-config";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
  const source = await prisma.source.findUnique({ where: { id } });
  if (!source) return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
  return NextResponse.json({ item: source });
}

export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (!canManageSources(user.role)) return forbidden("当前角色无此操作权限");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 }); }
  const parsed = sourcePatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  try {
    const source = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Source" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const current = await tx.source.findUnique({ where: { id } });
      if (!current) throw new Error("SOURCE_NOT_FOUND");
      if (current.policyVersion !== parsed.data.expectedPolicyVersion) throw new Error("SOURCE_POLICY_CONFLICT");
      if (!sourceTypeAllowed(current.type)) throw new Error("SOURCE_TYPE_NOT_ALLOWED");
      const nextStatus = parsed.data.status ?? current.status;
      const nextNote = parsed.data.permissionNote ?? current.permissionNote;
      if (nextStatus === "APPROVED" && !nextNote.trim()) throw new Error("PERMISSION_NOTE_REQUIRED");
      const allowExtract = nextStatus === "APPROVED" && (parsed.data.allowExtract ?? current.allowExtract);
      const allowEvidenceText = nextStatus === "APPROVED" && (parsed.data.allowEvidenceText ?? current.allowEvidenceText);
      const allowRelate = nextStatus === "APPROVED" && (parsed.data.allowRelate ?? current.allowRelate);
      if (allowExtract && !allowEvidenceText) throw new Error("EVIDENCE_PERMISSION_REQUIRED");
      const allowImport = nextStatus === "APPROVED" ? parsed.data.allowImport ?? current.allowImport : false;
      const retentionDays = parsed.data.retentionDays ?? current.retentionDays;
      const expiresAt = parsed.data.expiresAt === undefined ? current.expiresAt : parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
      const changed = current.status !== nextStatus || current.permissionNote !== nextNote || current.allowImport !== allowImport ||
        current.allowExtract !== allowExtract || current.allowEvidenceText !== allowEvidenceText || current.allowRelate !== allowRelate || current.retentionDays !== retentionDays ||
        (current.expiresAt?.getTime() ?? null) !== (expiresAt?.getTime() ?? null);
      if (!changed) return current;
      const version = current.policyVersion + 1;
      const changeType = current.status !== nextStatus ? `STATUS_${nextStatus}` : "POLICY_CHANGED";
      const updated = await tx.source.update({ where: { id }, data: {
        permissionNote: nextNote, status: nextStatus, allowImport, allowExtract, allowEvidenceText, allowRelate, retentionDays,
        policyVersion: version, policyChangedById: user.id, expiresAt,
      } });
      await tx.sourcePolicySnapshot.create({ data: {
        sourceId: id, version, status: nextStatus, allowImport, allowExtract, allowEvidenceText, allowRelate, retentionDays, expiresAt,
        permissionNote: nextNote, authorizationBasis: nextNote || "DRAFT：尚未批准，授权依据待补充",
        changedById: user.id, changeType, isLegacy: false,
      } });
      await tx.auditEvent.create({ data: { actorId: user.id, action: "SOURCE_POLICY_CHANGED", targetId: id } });
      return updated;
    });
    return NextResponse.json({ item: source });
  } catch (error) {
    const message = error instanceof Error ? error.message : "来源更新失败";
    if (message === "SOURCE_NOT_FOUND") return NextResponse.json({ error: "NOT_FOUND", message: "来源不存在" }, { status: 404 });
    if (message === "SOURCE_POLICY_CONFLICT") return NextResponse.json({ error: message, message: "来源策略已被其他管理员更新，请刷新后重新确认；本次未修改任何权限" }, { status: 409 });
    if (message === "SOURCE_TYPE_NOT_ALLOWED") return NextResponse.json({ error: "SOURCE_TYPE_NOT_ALLOWED", message: `${RUNTIME_MODE} 模式不能使用此来源类型` }, { status: 403 });
    if (message === "PERMISSION_NOTE_REQUIRED") return NextResponse.json({ error: message, message: "批准来源前必须填写录入依据" }, { status: 422 });
    if (message === "EVIDENCE_PERMISSION_REQUIRED") return NextResponse.json({ error: message, message: "当前提取仅支持获准保留最小证据文本的来源" }, { status: 422 });
    return NextResponse.json({ error: "DATABASE_ERROR", message: "来源更新失败，请稍后重试" }, { status: 500 });
  }
}
