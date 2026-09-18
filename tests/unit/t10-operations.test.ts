import { describe, expect, it } from "vitest";
import { collectOperationalPreflight, PLATFORM_OPERATIONAL_CONTROL, stableOperationalRunId, T10_ALERT_POLICY } from "../../src/lib/operational-controls";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_MODE: "test",
    DATABASE_URL: "postgresql://test3:test3@127.0.0.1:5432/test3_ci_run001",
    TEST_DATABASE_URL: "postgresql://test3:test3@127.0.0.1:5432/test3_ci_run001",
    TEST_DATABASE_MODE: "isolated",
    TEST_RUN_ID: "run001",
    ...overrides,
  };
}

describe("T10 operational controls", () => {
  it("keeps platform requests and automatic retries hard-closed", () => {
    expect(PLATFORM_OPERATIONAL_CONTROL).toEqual({ externalRequestsEnabled: false, maxRequests: 0, automaticRetries: 0 });
    expect(T10_ALERT_POLICY.productionChannel).toBe("not_deployed");
  });

  it("reports an isolated test preflight without exposing credentials", () => {
    const result = collectOperationalPreflight(env());
    expect(result.status).toBe("ready");
    expect(result.database).toEqual({ host: "127.0.0.1", name: "test3_ci_run001" });
    expect(result.platformCredentialCount).toBe(0);
    expect(JSON.stringify(result)).not.toContain("password");
  });

  it("blocks a non-isolated target and configured platform credentials", () => {
    const result = collectOperationalPreflight(env({ DATABASE_URL: "postgresql://test3:secret@db.example/prod", TEST_DATABASE_URL: "postgresql://test3:secret@db.example/prod", YOUTUBE_API_KEY: "do-not-print" }));
    expect(result.status).toBe("blocked");
    expect(result.issues).toEqual(expect.arrayContaining(["TEST_DATABASE_NOT_ISOLATED", "PLATFORM_CREDENTIALS_MUST_REMAIN_UNCONFIGURED"]));
    expect(JSON.stringify(result)).not.toContain("do-not-print");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("creates a non-sensitive stable run identifier", () => {
    expect(stableOperationalRunId("run001")).toHaveLength(16);
    expect(stableOperationalRunId("run001")).toBe(stableOperationalRunId("run001"));
    expect(stableOperationalRunId("run001")).not.toBe(stableOperationalRunId("run002"));
  });
});
