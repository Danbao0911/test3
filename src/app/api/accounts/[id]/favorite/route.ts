import { NextResponse } from "next/server";
import { canMaintain } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { setAccountFavorite, WorkspaceServiceError } from "@/lib/account-workspace-service";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

async function setFavorite(request: Request, id: string, favorite: boolean) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (!canMaintain(user.role)) return forbidden("当前角色无操作权限");
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  try {
    return NextResponse.json(await setAccountFavorite(prisma, id, user.id, favorite));
  } catch (error) {
    if (error instanceof WorkspaceServiceError && error.code === "ACCOUNT_NOT_FOUND") return NextResponse.json({ error: "NOT_FOUND", message: error.message }, { status: 404 });
    return NextResponse.json({ error: "DATABASE_ERROR", message: "收藏状态更新失败，请稍后重试" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return setFavorite(request, id, true);
}

export async function DELETE(request: Request, { params }: Context) {
  const { id } = await params;
  return setFavorite(request, id, false);
}
