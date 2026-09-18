import { NextResponse } from "next/server";
import { getCurrentUser, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canExport } from "@/lib/export-service";
import { downloadExport, ExportError } from "@/lib/export-service";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canExport(user.role)) return NextResponse.json({ error: "FORBIDDEN", message: "当前角色不能下载导出" }, { status: 403 });
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!uuidSchema.safeParse(id).success || token.length < 32) return NextResponse.json({ error: "EXPORT_NOT_FOUND", message: "导出链接无效" }, { status: 404 });
  try {
    const result = await downloadExport(prisma, user.id, id, token);
    return new NextResponse(result.csv, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${result.filename}"`, "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ExportError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    return NextResponse.json({ error: "EXPORT_FAILED", message: "导出下载失败" }, { status: 500 });
  }
}
