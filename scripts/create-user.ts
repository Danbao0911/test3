import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { z } from "zod";
import { assertRuntimeConfiguration } from "../src/lib/runtime-config";

async function main() {
  assertRuntimeConfiguration();
  const [roleValue, credentialsPath] = process.argv.slice(2);
  const role = z.enum(["ADMIN", "REVIEWER", "VIEWER"]).parse(roleValue);
  if (!credentialsPath) throw new Error("用法：pnpm user:create ROLE /绝对路径/credentials.json（文件权限 600）");
  if (((await stat(credentialsPath)).mode & 0o077) !== 0) throw new Error("凭据文件须仅当前用户可读写（chmod 600）");
  const input = z.object({ email: z.email().max(320), password: z.string().min(12).max(200) }).strict().safeParse(JSON.parse(await readFile(credentialsPath, "utf8")));
  if (!input.success) throw new Error("凭据格式错误：需 email 及至少 12 字符 password");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    await prisma.user.create({ data: { email: input.data.email.toLowerCase(), passwordHash: await bcrypt.hash(input.data.password, 12), role } });
    console.log(`成员已创建，角色 ${role}；未输出密码。已有邮箱不会被覆盖。`);
  } finally { await prisma.$disconnect(); }
}
void main().catch(() => { console.error("成员创建失败；请检查角色、受保护凭据文件、邮箱是否已存在及数据库配置。未输出凭据。"); process.exitCode = 1; });
