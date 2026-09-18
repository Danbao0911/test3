import { NextResponse } from "next/server";
import { canManageSources } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deletionRequestSchema, validationMessage } from "@/lib/validation";
import { deleteTarget, listDeletionRequests, RetentionError } from "@/lib/retention-service";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canManageSources(user.role)) return forbidden("当前角色不能查看删除记录");
  return NextResponse.json({ items: await listDeletionRequests(prisma) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canManageSources(user.role) || !isSameOrigin(request)) return forbidden("仅管理员可执行删除");
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_JSON", message: "请求格式错误" }, { status: 400 }); }
  const parsed = deletionRequestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  try { return NextResponse.json({ item: await deleteTarget(prisma, user.id, parsed.data) }, { status: 201 }); }
  catch (error) {
    if (error instanceof RetentionError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    return NextResponse.json({ error: "DELETION_FAILED", message: "删除未完成，数据库事务已回滚" }, { status: 500 });
  }
}
