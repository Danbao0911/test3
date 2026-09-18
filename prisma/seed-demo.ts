import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { assertRuntimeConfiguration } from "../src/lib/runtime-config";

async function main() {
  if (process.env.APP_MODE !== "demo") throw new Error("演示种子只允许在 APP_MODE=demo 时执行");
  assertRuntimeConfiguration();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    const existing = await prisma.source.findFirst({ where: { name: "演示来源（虚构数据）" } });
    if (!existing) await prisma.source.create({ data: {
      name: "演示来源（虚构数据）", type: "DEMO", status: "APPROVED",
      permissionNote: "仅用于隔离演示的虚构账号来源；不代表真实平台授权。联系提取及证据保留需管理员另行登记。",
      allowImport: true, allowExtract: false, allowEvidenceText: false,
    } });
    console.log("演示来源已就绪；未覆盖既有策略或撤销状态，未创建真实平台数据。");
  } finally { await prisma.$disconnect(); }
}
void main().catch(() => { console.error("演示初始化失败，请检查演示模式与独立数据库配置。"); process.exitCode = 1; });
