import { NextResponse } from "next/server";
import { canMaintain } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { followUpPatchSchema, uuidSchema, validationMessage } from "@/lib/validation";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (!canMaintain(user.role)) return forbidden("当前角色无操作权限");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 }); }
  const parsed = followUpPatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  const account = await prisma.account.findUnique({ where: { id }, select: { id: true } });
  if (!account) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  const followUp = await prisma.$transaction(async (tx) => {
    const result = await tx.accountFollowUp.upsert({
      where: { accountId: id },
      create: { accountId: id, status: parsed.data.status, note: parsed.data.note, updatedById: user.id },
      update: { status: parsed.data.status, note: parsed.data.note, updatedById: user.id },
    });
    await tx.auditEvent.create({ data: { actorId: user.id, action: "ACCOUNT_FOLLOWUP_UPDATED", targetId: id } });
    return result;
  });
  return NextResponse.json({ item: { status: followUp.status, note: followUp.note, updatedAt: followUp.updatedAt, updatedById: followUp.updatedById } });
}
