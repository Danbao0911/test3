import { NextResponse } from "next/server";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseCsvBytes, prepareImportRows, sourceBlockMessage, sourceCanImport } from "@/lib/import-service";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  const code = error instanceof Error && "code" in error ? String(error.code) : "IMPORT_FILE_ERROR";
  const message = error instanceof Error ? error.message : "CSV 文件无法处理";
  return NextResponse.json({ error: code, message }, { status: 422 });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  const form = await request.formData();
  const sourceId = String(form.get("sourceId") ?? "");
  const file = form.get("file");
  if (!(file instanceof File) || !sourceId) return NextResponse.json({ error: "FILE_REQUIRED", message: "请选择来源并上传 CSV 文件" }, { status: 422 });
  const source = await prisma.source.findUnique({ where: { id: sourceId } });
  if (!source) return NextResponse.json({ error: "SOURCE_NOT_FOUND", message: "来源不存在" }, { status: 422 });
  if (!sourceCanImport(source)) return NextResponse.json({ error: "SOURCE_NOT_ALLOWED", message: sourceBlockMessage(source) }, { status: 403 });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseCsvBytes(bytes);
    const prepared = prepareImportRows(parsed, sourceId);
    const validRows = prepared.filter((row) => row.input && row.normalizedProfileUrl);
    const duplicateCandidates = await Promise.all(validRows.map(async (row) => {
      const input = row.input!;
      const byNativeId = input.nativeId ? await prisma.account.findUnique({ where: { platform_nativeId: { platform: input.platform, nativeId: input.nativeId } } }) : null;
      const byUrl = await prisma.account.findUnique({ where: { platform_normalizedProfileUrl: { platform: input.platform, normalizedProfileUrl: row.normalizedProfileUrl! } } });
      return { rowNumber: row.rowNumber, duplicate: byNativeId?.id ?? byUrl?.id ?? null, identityConflict: Boolean(byNativeId && byUrl && byNativeId.id !== byUrl.id) };
    }));
    const candidateByRow = new Map(duplicateCandidates.map((candidate) => [candidate.rowNumber, candidate]));
    const errors = prepared.filter((row) => row.errorCode).map((row) => ({ rowNumber: row.rowNumber, errorCode: row.errorCode, errorMessage: row.errorMessage }));
    return NextResponse.json({
      totalRows: prepared.length,
      preview: prepared.slice(0, 20).map((row) => ({
        rowNumber: row.rowNumber,
        status: row.errorCode ? "INVALID" : candidateByRow.get(row.rowNumber)?.identityConflict ? "INVALID" : candidateByRow.get(row.rowNumber)?.duplicate ? "DUPLICATE" : "READY",
        displayName: row.input?.displayName ?? null,
        platform: row.input?.platform ?? null,
        profileUrl: row.input?.profileUrl ?? null,
        errorCode: row.errorCode ?? (candidateByRow.get(row.rowNumber)?.identityConflict ? "IDENTITY_CONFLICT" : null),
        errorMessage: row.errorMessage ?? (candidateByRow.get(row.rowNumber)?.identityConflict ? "平台身份 ID 和主页链接分别命中不同账号" : null),
      })),
      errors,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
