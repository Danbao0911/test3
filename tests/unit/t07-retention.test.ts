import { describe, expect, it } from "vitest";
import { buildCsv, decryptPayload, encryptPayload, stableIdentityFingerprints, suppressionFingerprint, suppressionFingerprintForKey, suppressionKeyAvailable } from "../../src/lib/data-protection";
import { accountIdentityLockKeys } from "../../src/lib/identity-rules";
import { decodeMaintenanceCheckpoint, encodeMaintenanceCheckpoint } from "../../src/lib/maintenance-checkpoint";
import { deletionRequestSchema, exportCreateSchema } from "../../src/lib/validation";

process.env.APP_MODE = "test";
process.env.TEST_RUN_ID = "t07-unit";

describe("T07 retention and export guards", () => {
  it("uses a keyed, non-reversible suppression fingerprint", () => {
    const first = suppressionFingerprint("EMAIL", "Person@example.com");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(suppressionFingerprint("EMAIL", "person@example.com")).toBe(first);
    expect(suppressionFingerprint("PHONE", "person@example.com")).not.toBe(first);
    expect(first).not.toContain("example.com");
    expect(suppressionFingerprint("CONTACT_URL", "https://example.com/Book#A")).not.toBe(suppressionFingerprint("CONTACT_URL", "https://example.com/book#a"));
  });

  it("requires the real legacy key instead of treating the current key as legacy", () => {
    const previous = process.env.SUPPRESSION_HMAC_KEYS_JSON;
    try {
      process.env.SUPPRESSION_HMAC_KEYS_JSON = JSON.stringify({ "default-v2": "new-key", "legacy-v1": "old-key" });
      const oldFingerprint = suppressionFingerprintForKey("EMAIL", "legacy@example.com", "legacy-v1", true);
      expect(suppressionKeyAvailable("legacy-v1")).toBe(true);
      expect(oldFingerprint).not.toBe(suppressionFingerprint("EMAIL", "legacy@example.com"));
      process.env.SUPPRESSION_HMAC_KEYS_JSON = JSON.stringify({ "default-v2": "new-key" });
      expect(suppressionKeyAvailable("legacy-v1")).toBe(false);
      expect(() => suppressionFingerprintForKey("EMAIL", "legacy@example.com", "legacy-v1", true)).toThrow("不可用");
    } finally {
      if (previous === undefined) delete process.env.SUPPRESSION_HMAC_KEYS_JSON;
      else process.env.SUPPRESSION_HMAC_KEYS_JSON = previous;
    }
  });

  it("uses identical database lock keys for native ID and profile deletion races", () => {
    const first = accountIdentityLockKeys({ platform: "X", nativeId: "native-1", normalizedProfileUrl: "https://example.com/x/one" });
    const sameIdentity = accountIdentityLockKeys({ platform: "X", nativeId: "native-1", normalizedProfileUrl: "https://example.com/x/one" });
    const changedProfile = accountIdentityLockKeys({ platform: "X", nativeId: "native-1", normalizedProfileUrl: "https://example.com/x/two" });
    expect(first).toEqual(sameIdentity);
    expect(first).not.toEqual(changedProfile);
    expect(first.every((key) => !key.includes("native-1") && !key.includes("example.com"))).toBe(true);
  });

  it("signs checkpoints to the operation, database and run identity", () => {
    const previous = process.env.RETENTION_CHECKPOINT_KEY;
    process.env.RETENTION_CHECKPOINT_KEY = "checkpoint-test-key";
    try {
      const token = encodeMaintenanceCheckpoint({ operation: "replay", database: "test3_ci_r2", runId: "r2", cutoff: "2026-09-18T00:00:00.000Z", cursors: { accountCursor: "00000000-0000-4000-8000-000000000001", accountDone: false } });
      expect(decodeMaintenanceCheckpoint(token, { operation: "replay", database: "test3_ci_r2", runId: "r2" }).cursors.accountDone).toBe(false);
      expect(() => decodeMaintenanceCheckpoint(token, { operation: "cleanup", database: "test3_ci_r2", runId: "r2" })).toThrow("目标");
      expect(() => decodeMaintenanceCheckpoint(`${token.slice(0, -1)}x`, { operation: "replay", database: "test3_ci_r2", runId: "r2" })).toThrow("签名");
    } finally {
      if (previous === undefined) delete process.env.RETENTION_CHECKPOINT_KEY;
      else process.env.RETENTION_CHECKPOINT_KEY = previous;
    }
  });

  it("stores independent account identity rules instead of requiring a composite match", () => {
    const withId = stableIdentityFingerprints({ platform: "X", nativeId: "native-1", normalizedProfileUrl: "https://example.com/x/one" });
    const changedProfile = stableIdentityFingerprints({ platform: "X", nativeId: "native-1", normalizedProfileUrl: "https://example.com/x/two" });
    const missingId = stableIdentityFingerprints({ platform: "X", normalizedProfileUrl: "https://example.com/x/one" });
    expect(withId.nativeId).toBe(changedProfile.nativeId);
    expect(withId.profileUrl).not.toBe(changedProfile.profileUrl);
    expect(withId.profileUrl).toBe(missingId.profileUrl);
    expect(withId.nativeId).not.toBeNull();
    expect(missingId.nativeId).toBeNull();
  });

  it("encrypts/decrypts temporary payloads and neutralizes CSV formulas", () => {
    const csv = buildCsv(["display_name", "contact_value", "note"], [{ display_name: "=HYPERLINK(\"https://evil.test\")", contact_value: "+1 202 555 0100", note: "line one\nline two" }]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("+1 202 555 0100");
    expect(decryptPayload(encryptPayload(csv))).toBe(csv);
  });

  it("rejects duplicate/unknown export fields and unconfirmed deletion", () => {
    expect(exportCreateSchema.safeParse({ fields: ["DISPLAY_NAME", "DISPLAY_NAME"] }).success).toBe(false);
    expect(exportCreateSchema.safeParse({ fields: ["DISPLAY_NAME"], unexpected: true }).success).toBe(false);
    expect(deletionRequestSchema.safeParse({ accountId: "00000000-0000-0000-0000-000000000001", reason: "清理", confirm: false }).success).toBe(false);
  });
});
