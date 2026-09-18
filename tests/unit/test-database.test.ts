import { describe, expect, it } from "vitest";
import { parseTestDatabaseConfig, assertRestrictedTestRole } from "../helpers/test-database";

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

  it("缺失配置、目标不一致和附加连接参数均失败", () => {
    expect(() => parseTestDatabaseConfig({ NODE_ENV: "test" })).toThrow();
    expect(() => parseTestDatabaseConfig({ ...env("test3_ci_12345"), DATABASE_URL: "postgresql://test3:test3@127.0.0.1:5432/test3" })).toThrow();
    const configured = env("test3_ci_12345");
    const url = configured.DATABASE_URL + "?options=-csearch_path%3Dproduction";
    expect(() => parseTestDatabaseConfig({ ...configured, DATABASE_URL: url, TEST_DATABASE_URL: url })).toThrow();
  });

  it("连接后拒绝超级用户或可创建数据库的角色", async () => {
    const role = { database: "test3_ci_12345", rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false };
    for (const key of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"]) {
      await expect(assertRestrictedTestRole({ query: async () => ({ rows: [{ ...role, [key]: true }] }) }, role.database)).rejects.toThrow();
    }
    await expect(assertRestrictedTestRole({ query: async sql => ({ rows: sql.includes("pg_auth_members") ? [] : [role] }) }, role.database)).resolves.toBeUndefined();
  });
});
