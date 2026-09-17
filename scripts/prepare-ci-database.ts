import pg from "pg";
import { parseTestDatabaseConfig } from "../tests/helpers/test-database";

async function main() {
  const config = parseTestDatabaseConfig();
  if (process.env.CI !== "true") throw new Error("仅允许在临时 CI PostgreSQL 服务中初始化测试角色");
  const target = new URL(config.url);
  target.username = "test3_bootstrap";
  target.password = "bootstrap-ci-only";
  const client = new pg.Client({ connectionString: target.toString() });
  try {
    await client.connect();
    await client.query("CREATE ROLE test3 LOGIN PASSWORD 'test3' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT");
    // Name is already restricted to [a-z0-9_-] by the pre-connection guard.
    await client.query(`REVOKE ALL ON DATABASE "${config.databaseName}" FROM PUBLIC`);
    // Initial migration contains CREATE SCHEMA IF NOT EXISTS; PostgreSQL still checks database CREATE.
    // This is scoped to this ephemeral database, not the role-level CREATEDB privilege.
    await client.query(`GRANT CONNECT, CREATE ON DATABASE "${config.databaseName}" TO test3`);
    await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    await client.query("GRANT USAGE, CREATE ON SCHEMA public TO test3");
    console.log("隔离 CI 数据库已配置非特权测试角色。");
  } finally { await client.end(); }
}
void main().catch(() => { console.error("隔离测试角色初始化失败，禁止继续迁移或测试。"); process.exitCode = 1; });
