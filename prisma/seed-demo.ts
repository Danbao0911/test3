import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

if (process.env.APP_MODE !== "demo") {
  throw new Error("演示种子只允许在 APP_MODE=demo 时执行");
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
const prisma = new PrismaClient({ adapter });

try {
  await prisma.source.upsert({
    where: { name: "演示来源（虚构数据）" },
    update: {
      type: "DEMO",
      status: "APPROVED",
      permissionNote: "仅用于隔离演示和自动化测试的虚构来源；不代表真实平台授权。",
      allowImport: true,
      expiresAt: null,
    },
    create: {
      name: "演示来源（虚构数据）",
      type: "DEMO",
      status: "APPROVED",
      permissionNote: "仅用于隔离演示和自动化测试的虚构来源；不代表真实平台授权。",
      allowImport: true,
    },
  });
  console.log("演示来源已就绪；未创建真实平台数据。");
} finally {
  await prisma.$disconnect();
}
