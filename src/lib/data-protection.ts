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

function configuredSuppressionSecrets() {
  const configured = new Map<string, string>();
  const raw = process.env.SUPPRESSION_HMAC_KEYS_JSON;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      for (const [keyId, secret] of Object.entries(parsed)) {
        if (typeof secret !== "string" || !keyId || keyId.length > 80) throw new Error("invalid key entry");
        configured.set(keyId, secret);
      }
    } catch {
      throw new DataProtectionError("KEY_MISSING", "SUPPRESSION_HMAC_KEYS_JSON 配置无效");
    }
  }
  if (process.env.SUPPRESSION_HMAC_KEY) configured.set(SUPPRESSION_FINGERPRINT_KEY_ID, process.env.SUPPRESSION_HMAC_KEY);
  return configured;
}

/** Returns identifiers only; secret material is never returned or logged. */
export function configuredSuppressionKeyIds() {
  const keys = new Set(configuredSuppressionSecrets().keys());
  // Non-production retains the deterministic test fallback used by existing
  // isolated fixtures. Production must configure the current key explicitly.
  if (currentRuntimeMode() !== "production") keys.add(SUPPRESSION_FINGERPRINT_KEY_ID);
  return [...keys];
}

function suppressionSecretBytes(keyId: string) {
  const configured = configuredSuppressionSecrets().get(keyId);
  if (configured) return createHash("sha256").update(configured).digest();
  if (keyId === SUPPRESSION_FINGERPRINT_KEY_ID && currentRuntimeMode() !== "production") {
    return createHash("sha256").update(`test3-SUPPRESSION_HMAC_KEY-${process.env.TEST_RUN_ID ?? "local"}`).digest();
  }
  throw new DataProtectionError("KEY_MISSING", `抑制指纹密钥 ${keyId} 不可用`);
}

export function suppressionKeyAvailable(keyId: string) {
  try {
    suppressionSecretBytes(keyId);
    return true;
  } catch (error) {
    if (error instanceof DataProtectionError && error.code === "KEY_MISSING") return false;
    throw error;
  }
}

function normalizeSuppressionValue(type: string, value: string) {
  const normalizedType = type.trim().toUpperCase();
  const trimmed = value.trim();
  // Email identity is case-insensitive. URL path/query/fragment and opaque
  // business identifiers are not lower-cased without an explicit equivalence rule.
  return normalizedType === "EMAIL" ? trimmed.toLowerCase() : trimmed;
}

function fingerprintFor(type: string, normalizedValue: string, keyId: string, valueNormalizer: (value: string) => string) {
  return createHmac("sha256", suppressionSecretBytes(keyId))
    .update(`${type.trim().toUpperCase()}\0${valueNormalizer(normalizedValue)}`)
    .digest("hex");
}

export function suppressionFingerprintForKey(type: string, normalizedValue: string, keyId: string, legacy = false) {
  return fingerprintFor(type, normalizedValue, keyId, (value) => legacy ? value.trim().toLowerCase() : normalizeSuppressionValue(type, value));
}

export function suppressionFingerprint(type: string, normalizedValue: string) {
  return suppressionFingerprintForKey(type, normalizedValue, SUPPRESSION_FINGERPRINT_KEY_ID);
}

export function legacySuppressionFingerprint(type: string, normalizedValue: string) {
  return suppressionFingerprintForKey(type, normalizedValue, "legacy-v1", true);
}

export function suppressionFingerprintCandidates(type: string, normalizedValue: string) {
  const candidates: string[] = [];
  for (const keyId of configuredSuppressionKeyIds()) {
    if (!suppressionKeyAvailable(keyId)) continue;
    // The algorithm version is part of the rule record.  The well-known
    // legacy id is the only v1 format; every other configured id is v2.
    candidates.push(suppressionFingerprintForKey(type, normalizedValue, keyId, keyId === "legacy-v1"));
  }
  return [...new Set(candidates)];
}

function identityFingerprint(prefix: string, platform: string, value: string, keyId = SUPPRESSION_FINGERPRINT_KEY_ID) {
  return createHmac("sha256", suppressionSecretBytes(keyId))
    .update(`${prefix}\0${platform.trim().toUpperCase()}\0${value.trim()}`)
    .digest("hex");
}

export function stableNativeIdFingerprintForKey(input: { platform: string; nativeId?: string | null }, keyId: string) {
  const nativeId = input.nativeId?.trim();
  return nativeId ? identityFingerprint("ACCOUNT_NATIVE_ID_V2", input.platform, nativeId, keyId) : null;
}

export function stableProfileFingerprintForKey(input: { platform: string; normalizedProfileUrl: string }, keyId: string) {
  return identityFingerprint("ACCOUNT_PROFILE_URL_V2", input.platform, input.normalizedProfileUrl, keyId);
}

export function stableIdentityFingerprintsForKey(input: { platform: string; nativeId?: string | null; normalizedProfileUrl: string }, keyId: string) {
  return {
    nativeId: stableNativeIdFingerprintForKey(input, keyId),
    profileUrl: stableProfileFingerprintForKey(input, keyId),
  };
}

export function stableNativeIdFingerprint(input: { platform: string; nativeId?: string | null }) {
  return stableNativeIdFingerprintForKey(input, SUPPRESSION_FINGERPRINT_KEY_ID);
}

export function stableProfileFingerprint(input: { platform: string; normalizedProfileUrl: string }) {
  return stableProfileFingerprintForKey(input, SUPPRESSION_FINGERPRINT_KEY_ID);
}

export function stableIdentityFingerprints(input: { platform: string; nativeId?: string | null; normalizedProfileUrl: string }) {
  return stableIdentityFingerprintsForKey(input, SUPPRESSION_FINGERPRINT_KEY_ID);
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
