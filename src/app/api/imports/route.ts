import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { forbidden, getCurrentUser, isSameOrigin, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  hashImportPayload,
  parseCsvBytes,
  prepareImportRows,
  sourceBlockMessage,
  sourceCanImport,
  type DbClient,
} from "@/lib/import-service";

export const runtime = "nodejs";

class SourceNotAllowedError extends Error {}

function isUniqueError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function findExisting(tx: DbClient, input: NonNullable<ReturnType<typeof prepareImportRows>[number]["input"]>, normalizedProfileUrl: string) {
  const byNativeId = input.nativeId ? await tx.account.findUnique({ where: { platform_nativeId: { platform: input.platform, nativeId: input.nativeId } } }) : null;
  const byUrl = await tx.account.findUnique({ where: { platform_normalizedProfileUrl: { platform: input.platform, normalizedProfileUrl } } });
  return { byNativeId, byUrl };
}

async function loadBatch(userId: string, key: string) {
  return prisma.importBatch.findUnique({ where: { createdById_idempotencyKey: { createdById: userId, idempotencyKey: key } } });
}

function batchResponse(batch: { id: string; totalRows: number; createdCount: number; duplicateCount: number; invalidCount: number }, replayed = false) {
  return { id: batch.id, totalRows: batch.totalRows, createdCount: batch.createdCount, duplicateCount: batch.duplicateCount, invalidCount: batch.invalidCount, replayed };
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden("请求来源校验失败");
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 200) return NextResponse.json({ error: "IDEMPOTENCY_KEY_REQUIRED", message: "必须提供有效的 Idempotency-Key" }, { status: 422 });
  const form = await request.formData();
  const sourceId = String(form.get("sourceId") ?? "");
  const file = form.get("file");
  if (!(file instanceof File) || !sourceId) return NextResponse.json({ error: "FILE_REQUIRED", message: "请选择来源并上传 CSV 文件" }, { status: 422 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const payloadHash = hashImportPayload(bytes, sourceId);
  const existingBatch = await loadBatch(user.id, idempotencyKey);
  if (existingBatch) {
    if (existingBatch.payloadHash !== payloadHash) return NextResponse.json({ error: "IDEMPOTENCY_MISMATCH", message: "相同幂等键对应了不同的导入内容" }, { status: 409 });
    return NextResponse.json({ item: batchResponse(existingBatch, true) }, { status: 200 });
  }

  let prepared;
  try {
    const source = await prisma.source.findUnique({ where: { id: sourceId } });
    if (!source) return NextResponse.json({ error: "SOURCE_NOT_FOUND", message: "来源不存在" }, { status: 422 });
    if (!sourceCanImport(source)) return NextResponse.json({ error: "SOURCE_NOT_ALLOWED", message: sourceBlockMessage(source) }, { status: 403 });
    prepared = prepareImportRows(parseCsvBytes(bytes), sourceId);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "IMPORT_FILE_ERROR";
    return NextResponse.json({ error: code, message: error instanceof Error ? error.message : "CSV 文件无法处理" }, { status: 422 });
  }

  try {
    const batch = await prisma.$transaction(async (tx) => {
      const source = await tx.source.findUnique({ where: { id: sourceId } });
      if (!source || !sourceCanImport(source)) throw new SourceNotAllowedError(source ? sourceBlockMessage(source) : "来源不存在");
      const createdBatch = await tx.importBatch.create({
        data: {
          createdById: user.id,
          sourceId,
          idempotencyKey,
          payloadHash,
          totalRows: prepared.length,
        },
      });
      let createdCount = 0;
      let duplicateCount = 0;
      let invalidCount = 0;
      for (const row of prepared) {
        if (!row.input || !row.normalizedProfileUrl || !row.normalizedSourceUrl) {
          invalidCount += 1;
          await tx.importRowResult.create({ data: { batchId: createdBatch.id, rowNumber: row.rowNumber, status: "INVALID", errorCode: row.errorCode ?? "VALIDATION_ERROR", errorMessage: row.errorMessage ?? "数据校验失败" } });
          continue;
        }
        const { byNativeId, byUrl } = await findExisting(tx, row.input, row.normalizedProfileUrl);
        if (byNativeId && byUrl && byNativeId.id !== byUrl.id) {
          invalidCount += 1;
          await tx.importRowResult.create({ data: { batchId: createdBatch.id, rowNumber: row.rowNumber, status: "INVALID", errorCode: "IDENTITY_CONFLICT", errorMessage: "平台身份 ID 和主页链接分别命中不同账号" } });
          continue;
        }
        const existing = byNativeId ?? byUrl;
        if (existing) {
          duplicateCount += 1;
          await tx.importRowResult.create({ data: { batchId: createdBatch.id, rowNumber: row.rowNumber, status: "DUPLICATE", accountId: existing.id } });
          continue;
        }
        try {
          const account = await tx.account.create({
            data: {
              platform: row.input.platform,
              nativeId: row.input.nativeId,
              displayName: row.input.displayName,
              profileUrl: row.input.profileUrl.trim(),
              normalizedProfileUrl: row.normalizedProfileUrl,
              organization: row.input.organization,
              serviceTags: row.input.serviceTags,
              region: row.input.region,
              sourceId,
              sourceUrl: row.normalizedSourceUrl,
              capturedAt: new Date(),
              isDemo: source.type === "DEMO",
            },
          });
          createdCount += 1;
          await tx.importRowResult.create({ data: { batchId: createdBatch.id, rowNumber: row.rowNumber, status: "CREATED", accountId: account.id } });
        } catch (error) {
          if (!isUniqueError(error)) throw error;
          const raced = await findExisting(tx, row.input, row.normalizedProfileUrl);
          const racedAccount = raced.byNativeId ?? raced.byUrl;
          if (!racedAccount || (raced.byNativeId && raced.byUrl && raced.byNativeId.id !== raced.byUrl.id)) throw error;
          duplicateCount += 1;
          await tx.importRowResult.create({ data: { batchId: createdBatch.id, rowNumber: row.rowNumber, status: "DUPLICATE", accountId: racedAccount.id } });
        }
      }
      return tx.importBatch.update({ where: { id: createdBatch.id }, data: { createdCount, duplicateCount, invalidCount } });
    });
    return NextResponse.json({ item: batchResponse(batch) }, { status: 201 });
  } catch (error) {
    if (error instanceof SourceNotAllowedError) return NextResponse.json({ error: "SOURCE_NOT_ALLOWED", message: error.message }, { status: 403 });
    if (isUniqueError(error)) {
      const racedBatch = await loadBatch(user.id, idempotencyKey);
      if (racedBatch) {
        if (racedBatch.payloadHash !== payloadHash) return NextResponse.json({ error: "IDEMPOTENCY_MISMATCH", message: "相同幂等键对应了不同的导入内容" }, { status: 409 });
        return NextResponse.json({ item: batchResponse(racedBatch, true) }, { status: 200 });
      }
    }
    throw error;
  }
}
