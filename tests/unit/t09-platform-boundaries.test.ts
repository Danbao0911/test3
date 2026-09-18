import { describe, expect, it } from "vitest";
import { getPlatformAdapter, platformCapabilityList } from "../../src/connectors/registry";

describe("T09 小红书与抖音能力边界", () => {
  it.each([
    ["XIAOHONGSHU", "AUTHORIZED_SUBJECT_ONLY", "basic_info"],
    ["DOUYIN", "AUTHORIZED_SUBJECT_ONLY", "user_info"],
  ] as const)("%s 明确标为仅主动授权主体资料，不能当成任意账号发现", async (platform, accessPath, scope) => {
    const capabilities = platformCapabilityList().find(item => item.platform === platform);
    expect(capabilities).toMatchObject({ accessPath, state: "not_supported", verifiedAt: null, externalRequestsEnabled: false });
    expect(capabilities?.limitation).toContain("授权");
    expect(capabilities?.limitation).toContain(scope === "basic_info" ? "basic_info" : "user_info");
    expect((await getPlatformAdapter(platform).discoverAccounts()).status).toBe("not_supported");
    expect((await getPlatformAdapter(platform).fetchProfile()).status).toBe("not_supported");
  });

  it("未登记应用、scope、主体范围和最小调用证据时不显示已接入", () => {
    const items = platformCapabilityList().filter(item => item.platform === "XIAOHONGSHU" || item.platform === "DOUYIN");
    expect(items).toHaveLength(2);
    expect(items.every(item => item.verifiedAt === null && item.requestBudget.maxRequests === 0 && item.requestBudget.automaticRetries === 0)).toBe(true);
  });
});
