import pg from "pg";
import { parseTestDatabaseConfig, assertRestrictedTestRole } from "../tests/helpers/test-database";

async function main() {
  const config = parseTestDatabaseConfig();
  const client = new pg.Client({ connectionString: config.url });
  try { await client.connect(); await assertRestrictedTestRole(client, config.databaseName); }
  finally { await client.end(); }
}
void main().catch(() => { console.error("测试数据库保护失败，停止启动服务器。"); process.exitCode = 1; });
