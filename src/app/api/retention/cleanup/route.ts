import { NextResponse } from "next/server";
import { canManageSources } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { runRetentionCleanup } from "@/lib/export-service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canManageSources(user.role) || !isSameOrigin(request)) return forbidden("仅管理员可执行到期清理");
  try { return NextResponse.json({ item: await runRetentionCleanup(prisma, user.id) }); }
  catch { return NextResponse.json({ error: "CLEANUP_FAILED", message: "到期清理未完成，数据库事务已回滚" }, { status: 500 }); }
}
