import crypto from "node:crypto";
import Papa from "papaparse";
import { Prisma } from "../generated/prisma/client";
import type { PrismaClient, Source } from "../generated/prisma/client";
import { normalizeProfileUrl, normalizeSourceUrl, UrlValidationError } from "./account-normalizer";
import { accountInputSchema, type AccountInput, validationMessage } from "./validation";
import { currentRuntimeMode, sourceTypeAllowed } from "./runtime-config";

export const IMPORT_FORMAT_VERSION = "v1";
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 500;
export const IMPORT_COLUMNS = [
  "platform",
  "nativeId",
  "displayName",
  "profileUrl",
  "organization",
  "serviceTags",
  "region",
  "sourceUrl",
] as const;

export class ImportFileError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

export type CsvRow = Record<(typeof IMPORT_COLUMNS)[number], string>;
export type ParsedCsvRow = { rowNumber: number; row?: CsvRow; errorCode?: string; errorMessage?: string };
export type PreparedImportRow = {
  rowNumber: number;
  input?: AccountInput;
  normalizedProfileUrl?: string;
  normalizedSourceUrl?: string;
  errorCode?: string;
  errorMessage?: string;
};

export function parseCsvBytes(bytes: Uint8Array): ParsedCsvRow[] {
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new ImportFileError("FILE_TOO_LARGE", "CSV 文件不能超过 2 MiB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new ImportFileError("FILE_ENCODING", "CSV 必须使用 UTF-8 编码");
  }
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  if (parsed.errors.length) {
    throw new ImportFileError("CSV_FORMAT", `CSV 格式错误：第 ${parsed.errors[0]?.row ?? "?"} 行无法解析`);
  }
  if (!parsed.data.length) throw new ImportFileError("CSV_EMPTY", "CSV 文件没有数据");
  const header = parsed.data[0]?.map((value) => value.trim()) ?? [];
  if (header.length !== IMPORT_COLUMNS.length || header.some((value, index) => value !== IMPORT_COLUMNS[index])) {
    throw new ImportFileError("CSV_COLUMNS", `CSV 列必须严格为：${IMPORT_COLUMNS.join(",")}`);
  }
  const dataRows = parsed.data.slice(1);
  if (dataRows.length > MAX_IMPORT_ROWS) throw new ImportFileError("ROW_LIMIT", "CSV 数据行不能超过 500 行");
  return dataRows.map((cells, index) => {
    const rowNumber = index + 2;
    if (cells.length !== IMPORT_COLUMNS.length) {
      return { rowNumber, errorCode: "CSV_COLUMN_COUNT", errorMessage: `第 ${rowNumber} 行必须正好有 ${IMPORT_COLUMNS.length} 列，实际为 ${cells.length} 列` };
    }
    const row = Object.fromEntries(IMPORT_COLUMNS.map((column, cellIndex) => [column, (cells[cellIndex] ?? "").trim()])) as CsvRow;
    return { rowNumber, row };
  });
}

export function prepareImportRows(rows: ParsedCsvRow[], sourceId: string): PreparedImportRow[] {
  return rows.map(({ rowNumber, row }) => {
    if (!row) return { rowNumber, errorCode: "CSV_COLUMN_COUNT", errorMessage: `第 ${rowNumber} 行列数不正确` };
    const candidate = {
      platform: row.platform,
      nativeId: row.nativeId || null,
      displayName: row.displayName,
      profileUrl: row.profileUrl,
      organization: row.organization || null,
      serviceTags: row.serviceTags ? row.serviceTags.split("|").map((tag) => tag.trim()).filter(Boolean) : [],
      region: row.region || null,
      sourceId,
      sourceUrl: row.sourceUrl,
    };
    const validation = accountInputSchema.safeParse(candidate);
    if (!validation.success) {
      return { rowNumber, errorCode: "VALIDATION_ERROR", errorMessage: validationMessage(validation.error) };
    }
    try {
      return {
        rowNumber,
        input: validation.data,
        normalizedProfileUrl: normalizeProfileUrl(validation.data.platform, validation.data.profileUrl),
        normalizedSourceUrl: normalizeSourceUrl(validation.data.sourceUrl),
      };
    } catch (error) {
      const isUrlError = error instanceof UrlValidationError;
      return {
        rowNumber,
        errorCode: isUrlError ? error.code : "URL_ERROR",
        errorMessage: isUrlError ? error.message : "链接校验失败",
      };
    }
  });
}

export function hashImportPayload(bytes: Uint8Array, sourceId: string) {
  return crypto.createHash("sha256").update(bytes).update("\0").update(sourceId).update("\0").update(IMPORT_FORMAT_VERSION).digest("hex");
}

export function sourceCanImport(source: Pick<Source, "status" | "allowImport" | "permissionNote" | "expiresAt">) {
  return source.status === "APPROVED" && source.allowImport && Boolean(source.permissionNote.trim()) && (!source.expiresAt || source.expiresAt > new Date());
}

export function sourceBlockMessage(source: Pick<Source, "status" | "allowImport" | "permissionNote" | "expiresAt">) {
  if (source.status !== "APPROVED") return "来源尚未获准录入";
  if (!source.allowImport) return "来源未开启录入能力";
  if (!source.permissionNote.trim()) return "来源缺少录入依据说明";
  if (source.expiresAt && source.expiresAt <= new Date()) return "来源录入授权已过期";
  return "来源当前不可用于录入";
}

export type DbClient = Prisma.TransactionClient;

export class SourceNotAllowedError extends Error {
  constructor(public readonly code: "SOURCE_NOT_FOUND" | "SOURCE_NOT_ALLOWED" | "SOURCE_TYPE_NOT_ALLOWED", message: string) {
    super(message);
    this.name = "SourceNotAllowedError";
  }
}

export class IdempotencyMismatchError extends Error {
  constructor() {
    super("相同幂等键对应了不同的导入内容");
    this.name = "IdempotencyMismatchError";
  }
}

export type AccountCreateResult =
  | { kind: "created"; account: Awaited<ReturnType<DbClient["account"]["create"]>> }
  | { kind: "duplicate"; existingAccountId: string }
  | { kind: "conflict" };

export type ImportExecutionResult = {
  batch: Awaited<ReturnType<DbClient["importBatch"]["update"]>>;
  replayed: boolean;
};

function knownErrorCode(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
}

function shouldRetry(error: unknown) {
  const code = knownErrorCode(error);
  return code === "P2002" || code === "P2034";
}

async function lockKey(tx: DbClient, key: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked`;
}

async function lockKeys(tx: DbClient, keys: string[]) {
  for (const key of [...new Set(keys)].sort()) await lockKey(tx, key);
}

async function lockSource(tx: DbClient, sourceId: string) {
  const rows = await tx.$queryRaw<Source[]>`
    SELECT "id", "name", "type", "status", "permissionNote", "allowImport", "expiresAt", "createdAt", "updatedAt"
    FROM "Source" WHERE "id" = ${sourceId}::uuid FOR UPDATE
  `;
  return rows[0] ?? null;
}

function sourceForWrite(source: Source | null) {
  if (!source) throw new SourceNotAllowedError("SOURCE_NOT_FOUND", "来源不存在");
  if (!sourceTypeAllowed(source.type)) throw new SourceNotAllowedError("SOURCE_TYPE_NOT_ALLOWED", `${currentRuntimeMode()} 模式不能使用此来源类型`);
  if (!sourceCanImport(source)) throw new SourceNotAllowedError("SOURCE_NOT_ALLOWED", sourceBlockMessage(source));
  return source;
}

function accountLockKeys(input: Pick<AccountInput, "platform" | "nativeId">, normalizedProfileUrl: string) {
  return [
    `test3:account:${input.platform}:url:${normalizedProfileUrl}`,
    ...(input.nativeId ? [`test3:account:${input.platform}:native:${input.nativeId}`] : []),
  ];
}

async function findExistingAccount(tx: DbClient, input: Pick<AccountInput, "platform" | "nativeId">, normalizedProfileUrl: string) {
  const byNativeId = input.nativeId ? await tx.account.findUnique({ where: { platform_nativeId: { platform: input.platform, nativeId: input.nativeId } } }) : null;
  const byUrl = await tx.account.findUnique({ where: { platform_normalizedProfileUrl: { platform: input.platform, normalizedProfileUrl } } });
  return { byNativeId, byUrl };
}

export async function createAccountWithRules(
  client: PrismaClient,
  input: AccountInput,
  normalizedProfileUrl: string,
  normalizedSourceUrl: string,
): Promise<AccountCreateResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.$transaction(async (tx) => {
        const source = sourceForWrite(await lockSource(tx, input.sourceId));
        await lockKeys(tx, accountLockKeys(input, normalizedProfileUrl));
        const { byNativeId, byUrl } = await findExistingAccount(tx, input, normalizedProfileUrl);
        if (byNativeId && byUrl && byNativeId.id !== byUrl.id) return { kind: "conflict" };
        const existing = byNativeId ?? byUrl;
        if (existing) return { kind: "duplicate", existingAccountId: existing.id };
        const account = await tx.account.create({
          data: {
            platform: input.platform,
            nativeId: input.nativeId,
            displayName: input.displayName,
            profileUrl: input.profileUrl.trim(),
            normalizedProfileUrl,
            organization: input.organization,
            serviceTags: input.serviceTags,
            region: input.region,
            sourceId: input.sourceId,
            sourceUrl: normalizedSourceUrl,
            capturedAt: new Date(),
            isDemo: source.type === "DEMO" && currentRuntimeMode() !== "production",
            followUp: { create: {} },
          },
        });
        return { kind: "created", account };
      });
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) throw error;
    }
  }
  throw lastError;
}

export async function executeImport(
  client: PrismaClient,
  options: {
    userId: string;
    sourceId: string;
    idempotencyKey: string;
    payloadHash: string;
    preparedRows: PreparedImportRow[];
    failureRowNumber?: number;
  },
): Promise<ImportExecutionResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.$transaction(async (tx) => {
        await lockKey(tx, `test3:import:${options.userId}:${options.idempotencyKey}`);
        const existing = await tx.importBatch.findUnique({ where: { createdById_idempotencyKey: { createdById: options.userId, idempotencyKey: options.idempotencyKey } } });
        if (existing) {
          if (existing.payloadHash !== options.payloadHash) throw new IdempotencyMismatchError();
          return { batch: existing, replayed: true };
        }
        const source = sourceForWrite(await lockSource(tx, options.sourceId));
        const validRows = options.preparedRows.filter((row) => row.input && row.normalizedProfileUrl && row.normalizedSourceUrl);
        await lockKeys(tx, validRows.flatMap((row) => accountLockKeys(row.input!, row.normalizedProfileUrl!)));
        const createdBatch = await tx.importBatch.create({
          data: { createdById: options.userId, sourceId: options.sourceId, idempotencyKey: options.idempotencyKey, payloadHash: options.payloadHash, totalRows: options.preparedRows.length },
        });
        let createdCount = 0;
        let duplicateCount = 0;
        let invalidCount = 0;
        for (const row of options.preparedRows) {
          if (options.failureRowNumber === row.rowNumber) throw new Error("TEST_INJECTED_IMPORT_FAILURE");
          if (!row.input || !row.normalizedProfileUrl || !row.normalizedSourceUrl) {
            invalidCount += 1;
            await tx.importRowResult.create({ data: { batchId: createdBatch.id, rowNumber: row.rowNumber, status: "INVALID", errorCode: row.errorCode ?? "VALIDATION_ERROR", errorMessage: row.errorMessage ?? "数据校验失败" } });
            continue;
          }
          const { byNativeId, byUrl } = await findExistingAccount(tx, row.input, row.normalizedProfileUrl);
          if (byNativeId && byUrl && byNativeId.id !== byUrl.id) {
            invalidCount += 1;
            await tx.importRowResult.create({ data: { batchId: createdBatch.id, rowNumber: row.rowNumber, status: "INVALID", errorCode: "IDENTITY_CONFLICT", errorMessage: "平台身份 ID 和主页链接分别命中不同账号" } });
            continue;
          }
          const existingAccount = byNativeId ?? byUrl;
          if (existingAccount) {
            duplicateCount += 1;
            await tx.importRowResult.create({ data: { batchId: createdBatch.id, rowNumber: row.rowNumber, status: "DUPLICATE", accountId: existingAccount.id } });
            continue;
          }
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
              sourceId: options.sourceId,
              sourceUrl: row.normalizedSourceUrl,
              capturedAt: new Date(),
              isDemo: source.type === "DEMO" && currentRuntimeMode() !== "production",
              followUp: { create: {} },
            },
          });
          createdCount += 1;
          await tx.importRowResult.create({ data: { batchId: createdBatch.id, rowNumber: row.rowNumber, status: "CREATED", accountId: account.id } });
        }
        const batch = await tx.importBatch.update({ where: { id: createdBatch.id }, data: { createdCount, duplicateCount, invalidCount } });
        return { batch, replayed: false };
      });
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) throw error;
    }
  }
  throw lastError;
}
