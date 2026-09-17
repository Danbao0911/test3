import { parseTestDatabaseConfig } from "./test-database";

export function requireE2EConfig() {
  const database = parseTestDatabaseConfig();
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("E2E 环境缺少 E2E_ADMIN_EMAIL 或 E2E_ADMIN_PASSWORD，禁止以 skip 代替配置错误");
  if (process.env.APP_ORIGIN !== "http://127.0.0.1:3000") throw new Error("E2E 必须使用固定可信 APP_ORIGIN=http://127.0.0.1:3000");
  return { database, email, password };
}
