import { describe, expect, it } from "vitest";
import { parseTestDatabaseConfig } from "../helpers/test-database";

function env(databaseName: string): NodeJS.ProcessEnv {
  const url = `postgresql://test3:test3@127.0.0.1:5432/${databaseName}`;
  return { NODE_ENV: "test", DATABASE_URL: url, TEST_DATABASE_URL: url, TEST_DATABASE_NAME: databaseName, TEST_DATABASE_MODE: "isolated", TEST_DATABASE_ALLOWED_HOSTS: "127.0.0.1", TEST_RUN_ID: "12345", APP_MODE: "test" };
}

describe("test database guard", () => {
  it("只接受绑定当前运行 ID 的隔离目标", () => {
    expect(parseTestDatabaseConfig(env("test3_ci_12345")).databaseName).toBe("test3_ci_12345");
    expect(() => parseTestDatabaseConfig(env("test3"))).toThrow("测试数据库保护拒绝执行");
    expect(() => parseTestDatabaseConfig(env("financial_prod"))).toThrow("测试数据库保护拒绝执行");
    expect(() => parseTestDatabaseConfig(env("financial_ci_prod"))).toThrow("测试数据库保护拒绝执行");
  });

  it("不会通过解析配置修改哨兵环境值", () => {
    const input = env("test3_e2e_12345");
    const snapshot = JSON.stringify(input);
    parseTestDatabaseConfig(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
