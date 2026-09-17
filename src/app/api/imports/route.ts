import { NextResponse } from "next/server";
import { canMaintain } from "@/lib/permissions";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  executeImport,
  hashImportPayload,
  ImportFileError,
  IdempotencyMismatchError,
  parseCsvBytes,
  prepareImportRows,
  sourceBlockMessage,
  sourceCanImport,
  SourceNotAllowedError,
} from "@/lib/import-service";
import { RUNTIME_MODE, sourceTypeAllowed } from "@/lib/runtime-config";
import { InvalidMultipartError, readBoundedFormData, RequestBodyTooLargeError } from "@/lib/request";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";

function batchResponse(batch: { id: string; totalRows: number; createdCount: number; duplicateCount: number; invalidCount: number }, replayed: boolean) {
  return { id: batch.id, totalRows: batch.totalRows, createdCount: batch.createdCount, duplicateCount: batch.duplicateCount, invalidCount: batch.invalidCount, replayed };
}

function multipartError(error: unknown) {
  const tooLarge = error instanceof RequestBodyTooLargeError;
  const invalid = error instanceof InvalidMultipartError;
  return NextResponse.json({ error: tooLarge ? "REQUEST_TOO_LARGE" : "INVALID_MULTIPART", message: error instanceof Error ? error.message : "请求格式无效" }, { status: tooLarge ? 413 : invalid ? 400 : 422 });
}

function databaseError() {
  return NextResponse.json({ error: "DATABASE_ERROR", message: "导入失败，数据库事务已回滚，请稍后重试" }, { status: 500 });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  if (!canMaintain(user.role)) return forbidden("当前角色无此操作权限");
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 200) return NextResponse.json({ error: "IDEMPOTENCY_KEY_REQUIRED", message: "必须提供有效的 Idempotency-Key" }, { status: 422 });
  let form: FormData;
  try { form = await readBoundedFormData(request); } catch (error) { return multipartError(error); }
  const sourceIdValue = String(form.get("sourceId") ?? "");
  const file = form.get("file");
  const sourceIdResult = uuidSchema.safeParse(sourceIdValue);
  if (!sourceIdResult.success || !(file instanceof File)) return NextResponse.json({ error: "FILE_REQUIRED", message: "请选择有效来源并上传 CSV 文件" }, { status: 422 });
  if (file.size > 2 * 1024 * 1024) return NextResponse.json({ error: "FILE_TOO_LARGE", message: "CSV 文件不能超过 2 MiB" }, { status: 413 });
  const sourceId = sourceIdResult.data;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const payloadHash = hashImportPayload(bytes, sourceId);
  let prepared;
  try {
    const source = await prisma.source.findUnique({ where: { id: sourceId } });
    if (!source) return NextResponse.json({ error: "SOURCE_NOT_FOUND", message: "来源不存在" }, { status: 422 });
    if (!sourceTypeAllowed(source.type)) return NextResponse.json({ error: "SOURCE_TYPE_NOT_ALLOWED", message: `${RUNTIME_MODE} 模式不能使用此来源类型` }, { status: 403 });
    if (!sourceCanImport(source)) return NextResponse.json({ error: "SOURCE_NOT_ALLOWED", message: sourceBlockMessage(source) }, { status: 403 });
    prepared = prepareImportRows(parseCsvBytes(bytes), sourceId);
  } catch (error) {
    if (error instanceof ImportFileError) return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
    return databaseError();
  }
  try {
    const result = await executeImport(prisma, {
      userId: user.id,
      sourceId,
      idempotencyKey,
      payloadHash,
      preparedRows: prepared,
      failureRowNumber: RUNTIME_MODE === "test" ? Number(request.headers.get("x-test-fail-after-row") ?? 0) || undefined : undefined,
    });
    return NextResponse.json({ item: batchResponse(result.batch, result.replayed) }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    if (error instanceof IdempotencyMismatchError) return NextResponse.json({ error: "IDEMPOTENCY_MISMATCH", message: error.message }, { status: 409 });
    if (error instanceof SourceNotAllowedError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.code === "SOURCE_NOT_FOUND" ? 422 : 403 });
    return databaseError();
  }
}
