import { NextResponse } from "next/server";
import { getCurrentUser, unauthorized } from "@/lib/auth";
import { canMaintain } from "@/lib/permissions";
import { prisma } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canMaintain(user.role)) return NextResponse.json({ error: "FORBIDDEN", message: "当前角色无权读取负责人列表" }, { status: 403 });
  const items = await prisma.user.findMany({ orderBy: { email: "asc" }, select: { id: true, email: true, role: true } });
  return NextResponse.json({ items });
}
