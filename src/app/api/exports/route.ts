import { NextResponse } from "next/server";
import { canExport } from "@/lib/export-service";
import { createExportJob, listExportJobs, ExportError } from "@/lib/export-service";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { exportCreateSchema, validationMessage } from "@/lib/validation";
import { readBoundedJson, RequestJsonError } from "@/lib/request";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canExport(user.role)) return forbidden("当前角色不能查看导出记录");
  return NextResponse.json({ items: await listExportJobs(prisma, user.id) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!canExport(user.role) || !isSameOrigin(request)) return forbidden("当前角色不能创建导出");
  let body: unknown;
  try { body = await readBoundedJson(request, 64 * 1024); } catch (error) { const code = error instanceof RequestJsonError ? error.code : "INVALID_JSON"; return NextResponse.json({ error: code, message: code === "REQUEST_TOO_LARGE" ? "导出请求不能超过 64 KiB" : "请求格式错误" }, { status: code === "REQUEST_TOO_LARGE" ? 413 : 400 }); }
  const parsed = exportCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", message: validationMessage(parsed.error) }, { status: 422 });
  try {
    const job = await createExportJob(prisma, user.id, parsed.data);
    return NextResponse.json({ item: { id: job.id, downloadUrl: `/api/exports/${job.id}/download?token=${encodeURIComponent(job.token)}`, expiresAt: job.expiresAt, rowCount: job.rowCount, excludedCount: job.excludedCount, excludedReasonCounts: job.excludedReasonCounts } }, { status: 201 });
  } catch (error) {
    if (error instanceof ExportError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    return NextResponse.json({ error: "EXPORT_FAILED", message: "导出准备失败，请稍后重试" }, { status: 500 });
  }
}
