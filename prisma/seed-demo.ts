import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

if (process.env.APP_MODE !== "demo") {
  throw new Error("演示种子只允许在 APP_MODE=demo 时执行");
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
const prisma = new PrismaClient({ adapter });

try {
  const existing = await prisma.source.findFirst({ where: { name: "演示来源（虚构数据）" } });
  const data = {
      type: "DEMO",
      status: "APPROVED",
      permissionNote: "仅用于隔离演示和自动化测试的虚构来源；不代表真实平台授权。",
      allowImport: true,
      expiresAt: null,
  } as const;
  if (existing) {
    await prisma.source.update({ where: { id: existing.id }, data });
  } else {
    await prisma.source.create({
      data: {
      name: "演示来源（虚构数据）",
        ...data,
      },
    });
  }
  console.log("演示来源已就绪；未创建真实平台数据。");
} finally {
  await prisma.$disconnect();
}
