import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

type Credentials = { email: string; password: string };

async function main() {
  const credentialsPath = path.join(process.cwd(), ".local/admin-credentials.json");
  const credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as Credentials;
  if (!credentials.email || !credentials.password) {
    throw new Error("本地管理员凭据文件缺少 email 或 password");
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
  const prisma = new PrismaClient({ adapter });

  try {
    const passwordHash = await bcrypt.hash(credentials.password, 12);
    await prisma.user.upsert({
      where: { email: credentials.email.toLowerCase() },
      update: { passwordHash },
      create: { email: credentials.email.toLowerCase(), passwordHash },
    });
    console.log(`管理员已就绪：${credentials.email.toLowerCase()}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
