import { NextResponse } from "next/server";
import { canMaintain } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { accountWorkspaceDto, accountWorkspaceInclude, findUsableAccountIds } from "@/lib/account-workspace";
import { updateAccountWorkspace, WorkspaceServiceError } from "@/lib/account-workspace-service";
import { prisma } from "@/lib/db";
import { followUpPatchSchema, uuidSchema, validationMessage } from "@/lib/validation";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (!canMaintain(user.role)) return forbidden("当前角色无此操作权限");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 }); }
  const parsed = followUpPatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  try {
    await updateAccountWorkspace(prisma, {
      accountId: id,
      userId: user.id,
      expectedWorkspaceVersion: parsed.data.expectedWorkspaceVersion,
      followUp: { status: parsed.data.status, note: parsed.data.note, confirmReactivation: parsed.data.confirmReactivation },
    });
  } catch (error) {
    if (error instanceof WorkspaceServiceError) {
      if (error.code === "ACCOUNT_NOT_FOUND") return NextResponse.json({ error: "NOT_FOUND", message: error.message }, { status: 404 });
      if (error.code === "WORKSPACE_CONFLICT") return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
      if (error.code === "REACTIVATION_CONFIRMATION_REQUIRED") return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
      if (error.code === "OWNER_NOT_FOUND") return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: "DATABASE_ERROR", message: "跟进记录保存失败，请稍后重试" }, { status: 500 });
  }
  const account = await prisma.account.findUnique({ where: { id }, include: { ...accountWorkspaceInclude(user.id), source: { select: { id: true, name: true, status: true, type: true, allowImport: true, expiresAt: true } } } });
  if (!account) return NextResponse.json({ error: "NOT_FOUND", message: "账号不存在" }, { status: 404 });
  const usableIds = await findUsableAccountIds(prisma, [id]);
  return NextResponse.json({ item: accountWorkspaceDto(account, user, usableIds.has(id)) });
}
