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

export const SUPPRESSION_FINGERPRINT_VERSION = 2;
export const SUPPRESSION_FINGERPRINT_KEY_ID = process.env.SUPPRESSION_HMAC_KEY_ID ?? "default-v2";
export const ACCOUNT_IDENTITY_FINGERPRINT_VERSION = 2;

function normalizeSuppressionValue(type: string, value: string) {
  const normalizedType = type.trim().toUpperCase();
  const trimmed = value.trim();
  // Email identity is case-insensitive. URL path/query/fragment and opaque
  // business identifiers are not lower-cased without an explicit equivalence rule.
  return normalizedType === "EMAIL" ? trimmed.toLowerCase() : trimmed;
}

function fingerprintFor(type: string, normalizedValue: string, valueNormalizer: (value: string) => string) {
  return createHmac("sha256", secretBytes("SUPPRESSION_HMAC_KEY"))
    .update(`${type.trim().toUpperCase()}\0${valueNormalizer(normalizedValue)}`)
    .digest("hex");
}

export function suppressionFingerprint(type: string, normalizedValue: string) {
  return fingerprintFor(type, normalizedValue, (value) => normalizeSuppressionValue(type, value));
}

export function legacySuppressionFingerprint(type: string, normalizedValue: string) {
  return fingerprintFor(type, normalizedValue, (value) => value.trim().toLowerCase());
}

export function suppressionFingerprintCandidates(type: string, normalizedValue: string) {
  return [...new Set([suppressionFingerprint(type, normalizedValue), legacySuppressionFingerprint(type, normalizedValue)])];
}

function identityFingerprint(prefix: string, platform: string, value: string) {
  return createHmac("sha256", secretBytes("SUPPRESSION_HMAC_KEY"))
    .update(`${prefix}\0${platform.trim().toUpperCase()}\0${value.trim()}`)
    .digest("hex");
}

export function stableNativeIdFingerprint(input: { platform: string; nativeId?: string | null }) {
  const nativeId = input.nativeId?.trim();
  return nativeId ? identityFingerprint("ACCOUNT_NATIVE_ID_V2", input.platform, nativeId) : null;
}

export function stableProfileFingerprint(input: { platform: string; normalizedProfileUrl: string }) {
  return identityFingerprint("ACCOUNT_PROFILE_URL_V2", input.platform, input.normalizedProfileUrl);
}

export function stableIdentityFingerprints(input: { platform: string; nativeId?: string | null; normalizedProfileUrl: string }) {
  return {
    nativeId: stableNativeIdFingerprint(input),
    profileUrl: stableProfileFingerprint(input),
  };
}

/**
 * Kept only for callers that need to identify the pre-LATEST-REVIEW composite
 * format. New deletion rules must use stableIdentityFingerprints instead.
 */
export function legacyStableIdentityFingerprint(input: { platform: string; nativeId?: string | null; normalizedProfileUrl: string }) {
  const identity = `${input.platform.trim().toUpperCase()}\0${input.nativeId?.trim() ?? ""}\0${input.normalizedProfileUrl.trim()}`;
  return createHmac("sha256", secretBytes("SUPPRESSION_HMAC_KEY")).update(`ACCOUNT_IDENTITY_V1\0${identity}`).digest("hex");
}

/** @deprecated Composite digests are legacy-only and must not back new rules. */
export const stableIdentityFingerprint = legacyStableIdentityFingerprint;

export function payloadDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
