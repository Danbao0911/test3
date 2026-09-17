import crypto from "node:crypto";
import Papa from "papaparse";
import type { Prisma, Source } from "../generated/prisma/client";
import { normalizeProfileUrl, normalizeSourceUrl, UrlValidationError } from "./account-normalizer";
import { accountInputSchema, type AccountInput, validationMessage } from "./validation";

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
export type PreparedImportRow = {
  rowNumber: number;
  input?: AccountInput;
  normalizedProfileUrl?: string;
  normalizedSourceUrl?: string;
  errorCode?: string;
  errorMessage?: string;
};

export function parseCsvBytes(bytes: Uint8Array) {
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
    const row = Object.fromEntries(IMPORT_COLUMNS.map((column, cellIndex) => [column, (cells[cellIndex] ?? "").trim()])) as CsvRow;
    return { rowNumber: index + 2, row };
  });
}

export function prepareImportRows(rows: Array<{ rowNumber: number; row: CsvRow }>, sourceId: string): PreparedImportRow[] {
  return rows.map(({ rowNumber, row }) => {
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
