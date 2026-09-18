import { afterEach, describe, expect, it, vi } from "vitest";
import { getPlatformAdapter, platformCapabilityList } from "../../src/connectors/registry";
import { platformIds, platformOperations } from "../../src/connectors/types";
import { checkPlatformReadiness, platformPreflightSchema, platformSourcePage } from "../../src/lib/platform-service";
import type { PrismaClient } from "../../src/generated/prisma/client";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("T08 platform capability boundaries", () => {
  it.each(platformIds.flatMap(platform => platformOperations.map(operation => ({ platform, operation }))))("$platform.$operation never reports fake success or calls a transport", async ({ platform, operation }) => {
    const network = vi.fn(() => { throw new Error("platform network must remain off"); });
    vi.stubGlobal("fetch", network);
    const result = await getPlatformAdapter(platform)[operation]();
    expect(["not_configured", "not_supported"]).toContain(result.status);
    expect(result).toMatchObject({ executed: false, outboundRequests: 0 });
    expect(result).not.toHaveProperty("data");
    expect(result).not.toHaveProperty("items");
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["production", "demo", "test"])("%s and merely having credentials never enable an unverified platform", mode => {
    vi.stubEnv("APP_MODE", mode);
    vi.stubEnv("YOUTUBE_API_KEY", "synthetic-secret-sentinel");
    vi.stubEnv("X_BEARER_TOKEN", "synthetic-secret-sentinel");
    const matrix = platformCapabilityList();
    expect(matrix).toHaveLength(4);
    expect(matrix.every(item => item.verifiedAt === null && !item.externalRequestsEnabled && item.requestBudget.maxRequests === 0 && item.requestBudget.automaticRetries === 0)).toBe(true);
    expect(JSON.stringify(matrix)).not.toContain("synthetic-secret-sentinel");
  });

  it("returns fresh capabilities so a caller cannot persist changes into later checks", () => {
    const first = platformCapabilityList();
    first[0].operations.fetchProfile.message = "caller mutation";
    expect(platformCapabilityList()[0].operations.fetchProfile.message).not.toBe("caller mutation");
  });

  it("rejects credentials, URLs, forged roles, scopes and stale-format grants", () => {
    const base = { platform: "YOUTUBE", sourceId: "080d3f2d-e7a2-43cd-ae93-0df4e7358b26", expectedPolicyVersion: 1, operation: "fetchProfile" };
    expect(platformPreflightSchema.safeParse(base).success).toBe(true);
    for (const extra of [{ apiKey: "secret" }, { url: "https://127.0.0.1/" }, { role: "ADMIN" }, { scopes: ["all"] }, { verified: true }, { allowFetch: true }]) {
      expect(platformPreflightSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
    expect(platformPreflightSchema.safeParse({ ...base, expectedPolicyVersion: 0 }).success).toBe(false);
  });

  it.each(["VIEWER", "REVIEWER"] as const)("%s cannot bypass the service role check", async role => {
    const transaction = vi.fn();
    const query = vi.fn();
    const db = { $transaction: transaction, source: { findMany: query } } as unknown as PrismaClient;
    await expect(checkPlatformReadiness(db, { role }, {})).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(platformSourcePage(db, { role })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(transaction).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
});
