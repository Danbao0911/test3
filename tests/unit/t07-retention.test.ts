import { describe, expect, it } from "vitest";
import { buildCsv, decryptPayload, encryptPayload, suppressionFingerprint } from "../../src/lib/data-protection";
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
  });

  it("encrypts/decrypts temporary payloads and neutralizes CSV formulas", () => {
    const csv = buildCsv(["display_name", "contact_value"], [{ display_name: "=HYPERLINK(\"https://evil.test\")", contact_value: "+1 202 555 0100" }]);
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
