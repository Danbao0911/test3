import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env");
const localDir = path.join(root, ".local");
const credentialsPath = path.join(localDir, "admin-credentials.json");

await mkdir(localDir, { recursive: true, mode: 0o700 });

try {
  await readFile(envPath, "utf8");
} catch {
  const env = [
    "DATABASE_URL=postgresql://test3:test3@127.0.0.1:5432/test3_demo",
    "APP_MODE=demo",
    "APP_ORIGIN=http://127.0.0.1:3000",
    "TEST_DATABASE_URL=",
    "AUTH_COOKIE_NAME=test3_session",
    "NEXT_PUBLIC_APP_NAME=专业服务账号与商务线索工作台",
    "",
  ].join("\n");
  await writeFile(envPath, env, { mode: 0o600 });
}

try {
  await readFile(credentialsPath, "utf8");
} catch {
  const password = randomBytes(18).toString("base64url");
  const credentials = JSON.stringify(
    { email: "admin@example.test", password, generatedAt: new Date().toISOString() },
    null,
    2,
  );
  await writeFile(credentialsPath, `${credentials}\n`, { mode: 0o600 });
}

await chmod(localDir, 0o700);
await chmod(credentialsPath, 0o600).catch(() => undefined);
console.log(`本地配置已就绪：${envPath}`);
console.log(`管理员凭据已保存到：${credentialsPath}`);
