import { NextResponse } from "next/server";
import { canMaintain } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { accountWorkspaceDto, accountWorkspaceInclude, findUsableAccountIds } from "@/lib/account-workspace";
import { prisma } from "@/lib/db";
import { accountPatchSchema, uuidSchema, validationMessage } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  const account = await prisma.account.findUnique({
    where: { id },
    include: { ...accountWorkspaceInclude, source: true },
  });
  if (!account) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  const usableIds = await findUsableAccountIds(prisma, [id]);
  return NextResponse.json({ item: accountWorkspaceDto(account, usableIds.has(id)) });
}

export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (!canMaintain(user.role)) return forbidden("当前角色无此操作权限");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 });
  }
  const parsed = accountPatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.account.findUnique({ where: { id } });
      if (!current) throw new Error("ACCOUNT_NOT_FOUND");
      if (parsed.data.ownerId !== undefined && parsed.data.ownerId !== null) {
        const owner = await tx.user.findUnique({ where: { id: parsed.data.ownerId }, select: { id: true } });
        if (!owner) throw new Error("OWNER_NOT_FOUND");
      }
      const account = await tx.account.update({ where: { id }, data: parsed.data });
      if (parsed.data.ownerId !== undefined && parsed.data.ownerId !== current.ownerId) {
        await tx.auditEvent.create({ data: { actorId: user.id, action: "ACCOUNT_OWNER_CHANGED", targetId: account.id } });
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ACCOUNT_NOT_FOUND") return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
    if (error instanceof Error && error.message === "OWNER_NOT_FOUND") return NextResponse.json({ error: "OWNER_NOT_FOUND", message: "负责人不存在" }, { status: 422 });
    return NextResponse.json({ error: "DATABASE_ERROR", message: "账号保存失败，请稍后重试" }, { status: 500 });
  }
  const account = await prisma.account.findUnique({ where: { id }, include: { ...accountWorkspaceInclude, source: true } });
  if (!account) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  const usableIds = await findUsableAccountIds(prisma, [id]);
  return NextResponse.json({ item: accountWorkspaceDto(account, usableIds.has(id)) });
}
