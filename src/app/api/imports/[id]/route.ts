import { NextResponse } from "next/server";
import { getCurrentUser, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const batch = await prisma.importBatch.findFirst({
    where: { id, createdById: user.id },
    include: {
      source: { select: { id: true, name: true, status: true, type: true } },
      rows: { orderBy: { rowNumber: "asc" }, include: { account: { select: { id: true, displayName: true, platform: true } } } },
    },
  });
  if (!batch) return NextResponse.json({ error: "NOT_FOUND", message: "导入批次不存在" }, { status: 404 });
  return NextResponse.json({ item: batch });
}
