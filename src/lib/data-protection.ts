import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { currentRuntimeMode } from "./runtime-config";

export class DataProtectionError extends Error {
  constructor(public readonly code: "KEY_MISSING" | "PAYLOAD_INVALID", message: string) { super(message); }
}

function secretBytes(name: "SUPPRESSION_HMAC_KEY" | "EXPORT_ENCRYPTION_KEY") {
  const configured = process.env[name];
  if (!configured && currentRuntimeMode() === "production") throw new DataProtectionError("KEY_MISSING", `${name} 未配置`);
  const fallback = configured ?? `test3-${name}-${process.env.TEST_RUN_ID ?? "local"}`;
  return createHash("sha256").update(fallback).digest();
}

export function suppressionFingerprint(type: string, normalizedValue: string) {
  return createHmac("sha256", secretBytes("SUPPRESSION_HMAC_KEY")).update(`${type}\0${normalizedValue.trim().toLowerCase()}`).digest("hex");
}

export function createDownloadToken() {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function encryptPayload(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretBytes("EXPORT_ENCRYPTION_KEY"), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptPayload(value: string) {
  const parts = value.split(".");
  if (parts.length !== 3) throw new DataProtectionError("PAYLOAD_INVALID", "导出载荷格式无效");
  try {
    const decipher = createDecipheriv("aes-256-gcm", secretBytes("EXPORT_ENCRYPTION_KEY"), Buffer.from(parts[0], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new DataProtectionError("PAYLOAD_INVALID", "导出载荷无法解密");
  }
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function buildCsv(headers: string[], rows: Array<Record<string, unknown>>) {
  return [headers.map(csvCell).join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n") + "\r\n";
}
