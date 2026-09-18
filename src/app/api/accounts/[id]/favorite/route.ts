import { NextResponse } from "next/server";
import { canMaintain } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

async function accountExists(id: string) {
  return Boolean(await prisma.account.findUnique({ where: { id }, select: { id: true } }));
}

export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (!canMaintain(user.role)) return forbidden("当前角色无操作权限");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success || !(await accountExists(id))) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  const existing = await prisma.accountFavorite.findUnique({ where: { accountId_userId: { accountId: id, userId: user.id } } });
  if (!existing) {
    await prisma.$transaction([
      prisma.accountFavorite.create({ data: { accountId: id, userId: user.id } }),
      prisma.auditEvent.create({ data: { actorId: user.id, action: "ACCOUNT_FAVORITED", targetId: id } }),
    ]);
  }
  return NextResponse.json({ favorite: true });
}

export async function DELETE(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (!canMaintain(user.role)) return forbidden("当前角色无操作权限");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success || !(await accountExists(id))) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  const existing = await prisma.accountFavorite.findUnique({ where: { accountId_userId: { accountId: id, userId: user.id } } });
  if (existing) {
    await prisma.$transaction([
      prisma.accountFavorite.delete({ where: { id: existing.id } }),
      prisma.auditEvent.create({ data: { actorId: user.id, action: "ACCOUNT_UNFAVORITED", targetId: id } }),
    ]);
  }
  return NextResponse.json({ favorite: false });
}
