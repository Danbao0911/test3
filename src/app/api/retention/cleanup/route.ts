import { NextResponse } from "next/server";
import { canManageSources } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { runRetentionCleanup } from "@/lib/export-service";
import { readBoundedJson, RequestJsonError } from "@/lib/request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canManageSources(user.role) || !isSameOrigin(request)) return forbidden("仅管理员可执行到期清理");
  let body: unknown = {};
  try { body = await readBoundedJson(request, 4 * 1024); } catch (error) { const code = error instanceof RequestJsonError ? error.code : "INVALID_JSON"; return NextResponse.json({ error: code, message: code === "REQUEST_TOO_LARGE" ? "清理请求不能超过 4 KiB" : "请求格式错误" }, { status: code === "REQUEST_TOO_LARGE" ? 413 : 400 }); }
  const options = body && typeof body === "object" ? body as { batchSize?: number; contactCursor?: string; exportCursor?: string; suppressionCursor?: string; dryRun?: boolean } : {};
  try { return NextResponse.json({ item: await runRetentionCleanup(prisma, user.id, new Date(), options) }); }
  catch { return NextResponse.json({ error: "CLEANUP_FAILED", message: "到期清理未完成，数据库事务已回滚" }, { status: 500 }); }
}
