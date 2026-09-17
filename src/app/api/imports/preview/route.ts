import { NextResponse } from "next/server";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ImportFileError, parseCsvBytes, prepareImportRows, sourceBlockMessage, sourceCanImport } from "@/lib/import-service";
import { sourceTypeAllowed, RUNTIME_MODE } from "@/lib/runtime-config";
import { readBoundedFormData, RequestBodyTooLargeError, InvalidMultipartError } from "@/lib/request";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  if (error instanceof ImportFileError) return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
  return NextResponse.json({ error: "DATABASE_ERROR", message: "预览失败，请稍后重试" }, { status: 500 });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  let form: FormData;
  try { form = await readBoundedFormData(request); } catch (error) {
    const isTooLarge = error instanceof RequestBodyTooLargeError;
    const isInvalid = error instanceof InvalidMultipartError;
    return NextResponse.json({ error: isTooLarge ? "REQUEST_TOO_LARGE" : "INVALID_MULTIPART", message: error instanceof Error ? error.message : "请求格式无效" }, { status: isTooLarge ? 413 : isInvalid ? 400 : 422 });
  }
  const sourceIdValue = String(form.get("sourceId") ?? "");
  const sourceIdResult = uuidSchema.safeParse(sourceIdValue);
  const file = form.get("file");
  if (!sourceIdResult.success || !(file instanceof File)) return NextResponse.json({ error: "FILE_REQUIRED", message: "请选择有效来源并上传 CSV 文件" }, { status: 422 });
  if (file.size > 2 * 1024 * 1024) return NextResponse.json({ error: "FILE_TOO_LARGE", message: "CSV 文件不能超过 2 MiB" }, { status: 413 });
  const sourceId = sourceIdResult.data;
  const source = await prisma.source.findUnique({ where: { id: sourceId } });
  if (!source) return NextResponse.json({ error: "SOURCE_NOT_FOUND", message: "来源不存在" }, { status: 422 });
  if (!sourceTypeAllowed(source.type)) return NextResponse.json({ error: "SOURCE_TYPE_NOT_ALLOWED", message: `${RUNTIME_MODE} 模式不能使用此来源类型` }, { status: 403 });
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
    const errors = [
      ...prepared.filter((row) => row.errorCode).map((row) => ({ rowNumber: row.rowNumber, errorCode: row.errorCode, errorMessage: row.errorMessage })),
      ...duplicateCandidates.filter((candidate) => candidate.identityConflict).map((candidate) => ({ rowNumber: candidate.rowNumber, errorCode: "IDENTITY_CONFLICT", errorMessage: "平台身份 ID 和主页链接分别命中不同账号" })),
    ].sort((left, right) => left.rowNumber - right.rowNumber);
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
