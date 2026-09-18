import { createHash } from "node:crypto";

export type TestDatabaseConfig = {
  url: string;
  databaseName: string;
  host: string;
  runId: string;
};

function failure(message: string): never {
  throw new Error(`测试数据库保护拒绝执行：${message}`);
}

export function parseTestDatabaseConfig(env: NodeJS.ProcessEnv = process.env): TestDatabaseConfig {
  const rawUrl = env.TEST_DATABASE_URL;
  const databaseName = env.TEST_DATABASE_NAME;
  const runId = env.TEST_RUN_ID;
  if (!rawUrl || !databaseName || !runId) failure("必须提供 TEST_DATABASE_URL、TEST_DATABASE_NAME 和 TEST_RUN_ID");
  if (env.TEST_DATABASE_MODE !== "isolated") failure("TEST_DATABASE_MODE 必须为 isolated");
  if (env.APP_MODE !== "test") failure("集成测试必须使用 APP_MODE=test");
  if (rawUrl !== env.DATABASE_URL) failure("DATABASE_URL 必须与 TEST_DATABASE_URL 完全一致");
  let url: URL;
  try { url = new URL(rawUrl); } catch { failure("TEST_DATABASE_URL 不是有效 URL"); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) failure("只允许 PostgreSQL URL");
  if (url.search || url.hash || !url.username || !url.password) failure("拒绝额外连接参数、片段和缺失凭据");
  const allowedHosts = (env.TEST_DATABASE_ALLOWED_HOSTS ?? "127.0.0.1").split(",").map((host) => host.trim()).filter(Boolean);
  if (!allowedHosts.includes(url.hostname)) failure(`数据库主机 ${url.hostname} 不在明确白名单中`);
  const actualName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (actualName !== databaseName) failure("TEST_DATABASE_NAME 与 URL 目标不一致");
  if (!/^test3_(?:ci|e2e|test)_[a-z0-9-]+$/i.test(actualName)) failure("数据库名称必须是本轮专用的 test3_ci/test3_e2e/test3_test 标记目标");
  if (!actualName.endsWith(`_${runId}`)) failure("数据库名称必须绑定当前运行 ID");
  if (url.port && url.port !== "5432") failure("测试数据库只允许端口 5432");
  return { url: rawUrl, databaseName: actualName, host: url.hostname, runId };
}

export function scopedCleanupKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function assertRestrictedTestRole(client: { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> }, expectedDatabase: string) {
  const result = await client.query("SELECT current_database() AS database, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  const role = result.rows[0];
  if (!role || role.database !== expectedDatabase || ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"].some(key => role[key] !== false)) failure("当前数据库或角色权限不符合专用非特权测试目标");
  const memberships = await client.query("SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)");
  if (memberships.rows.length) failure("测试角色不能继承其他角色权限");
}
