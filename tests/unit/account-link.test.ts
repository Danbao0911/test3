import { describe, expect, it } from "vitest";
import { accountLinkDto, canonicalAccountPair } from "../../src/lib/account-link-service";
import { readAccountLinkJson } from "../../src/lib/account-link-http";
import { accountLinkReviewSchema } from "../../src/lib/validation";

describe("T06 account link invariants", () => {
  it("uses one canonical pair key and rejects self-links", () => {
    const left = "00000000-0000-4000-8000-000000000001";
    const right = "00000000-0000-4000-8000-000000000002";
    expect(canonicalAccountPair(right, left)).toEqual([left, right]);
    expect(() => canonicalAccountPair(left, left)).toThrowError("不能把账号关联到自身");
  });

  it("does not expose reviewer reason to VIEWER and derives usability from current source state", () => {
    const item = {
      id: "00000000-0000-4000-8000-000000000003",
      leftAccountId: "00000000-0000-4000-8000-000000000001",
      rightAccountId: "00000000-0000-4000-8000-000000000002",
      sourceId: "00000000-0000-4000-8000-000000000004",
      policyVersion: 4,
      status: "CONFIRMED" as const,
      basis: "MANUAL" as const,
      version: 2,
      reason: "人工核对两个主体后确认",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      leftAccount: { id: "00000000-0000-4000-8000-000000000001", platform: "X" as const, displayName: "同名账号", organization: null, isDemo: true },
      rightAccount: { id: "00000000-0000-4000-8000-000000000002", platform: "X" as const, displayName: "同名账号", organization: null, isDemo: true },
      source: { id: "00000000-0000-4000-8000-000000000004", name: "测试来源", status: "REVOKED" as const, allowRelate: false, policyVersion: 4, expiresAt: null },
      createdBy: { id: "00000000-0000-4000-8000-000000000005", email: "reviewer@example.test" },
      reviewedBy: { id: "00000000-0000-4000-8000-000000000006", email: "admin@example.test" },
      basisContactId: null,
      matchingContactId: null,
      createdById: "00000000-0000-4000-8000-000000000005",
      reviewedById: "00000000-0000-4000-8000-000000000006",
    };
    expect(accountLinkDto(item, "VIEWER")).toMatchObject({ usable: false, reason: null, createdBy: null, reviewedBy: null, source: { id: item.source.id, name: item.source.name, status: "REVOKED" } });
    expect(accountLinkDto(item, "REVIEWER")).toMatchObject({ usable: false, reason: item.reason, createdBy: item.createdBy });
  });

  it("normalizes UUID case before same-account and pair checks", () => {
    const left = "00000000-0000-4000-8000-000000000001";
    const right = "00000000-0000-4000-8000-000000000002";
    expect(canonicalAccountPair(left.toUpperCase(), right.toUpperCase())).toEqual([left, right]);
    expect(() => canonicalAccountPair(left, left.toUpperCase())).toThrowError("不能把账号关联到自身");
  });

  it("requires relation evidence for confirmation and rejects unknown fields", () => {
    const parsed = accountLinkReviewSchema.safeParse({ expectedVersion: 1, status: "CONFIRMED", reason: "有理由但没有证据" });
    expect(parsed.success).toBe(true);
    const unknown = accountLinkReviewSchema.safeParse({ expectedVersion: 1, status: "REVOKED", reason: "复核", unexpected: true });
    expect(unknown.success).toBe(false);
  });

  it("enforces JSON byte limits without trusting Content-Length", async () => {
    const oversized = new Request("https://example.test/api/account-links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "x".repeat(20_000) }) });
    await expect(readAccountLinkJson(oversized)).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE", status: 413 });
    const malformed = new Request("https://example.test/api/account-links", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
    await expect(readAccountLinkJson(malformed)).rejects.toMatchObject({ code: "INVALID_JSON", status: 400 });
  });
});
