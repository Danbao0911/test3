import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseCsvBytes, prepareImportRows } from "../../src/lib/import-service";

const testUrl = process.env.TEST_DATABASE_URL;
const isExplicitTestDb = Boolean(testUrl && /(?:test|ci|e2e)/i.test(new URL(testUrl).pathname));

const suite = isExplicitTestDb ? describe : describe.skip;

suite("PostgreSQL account import persistence", () => {
  let db: PrismaClient;
  let userId: string;
  let sourceId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg({ connectionString: testUrl! });
    db = new PrismaClient({ adapter });
    await db.$connect();
    await db.importRowResult.deleteMany();
    await db.importBatch.deleteMany();
    await db.account.deleteMany();
    await db.session.deleteMany();
    await db.source.deleteMany();
    await db.user.deleteMany();
    const user = await db.user.create({ data: { email: "integration@example.test", passwordHash: await bcrypt.hash("not-used", 4) } });
    userId = user.id;
    const source = await db.source.create({ data: { name: "集成测试虚构来源", type: "DEMO", status: "APPROVED", allowImport: true, permissionNote: "隔离测试依据" } });
    sourceId = source.id;
  });

  afterAll(async () => { await db?.$disconnect(); });

  it("persists 60 unique accounts and fixed import counters", async () => {
    process.env.APP_MODE = "demo";
    const fixture = readFileSync(path.join(process.cwd(), "tests/fixtures/accounts-90.csv"));
    const prepared = prepareImportRows(parseCsvBytes(fixture), sourceId);
    let createdCount = 0; let duplicateCount = 0; let invalidCount = 0;
    const batch = await db.importBatch.create({ data: { createdById: userId, sourceId, idempotencyKey: "fixed-90", payloadHash: "fixed-90-hash", totalRows: prepared.length } });
    for (const row of prepared) {
      if (!row.input || !row.normalizedProfileUrl || !row.normalizedSourceUrl) { invalidCount++; await db.importRowResult.create({ data: { batchId: batch.id, rowNumber: row.rowNumber, status: "INVALID", errorCode: row.errorCode, errorMessage: row.errorMessage } }); continue; }
      const existing = await db.account.findUnique({ where: { platform_normalizedProfileUrl: { platform: row.input.platform, normalizedProfileUrl: row.normalizedProfileUrl } } });
      if (existing) { duplicateCount++; await db.importRowResult.create({ data: { batchId: batch.id, rowNumber: row.rowNumber, status: "DUPLICATE", accountId: existing.id } }); continue; }
      const account = await db.account.create({ data: { platform: row.input.platform, nativeId: row.input.nativeId, displayName: row.input.displayName, profileUrl: row.input.profileUrl, normalizedProfileUrl: row.normalizedProfileUrl, organization: row.input.organization, serviceTags: row.input.serviceTags, region: row.input.region, sourceId, sourceUrl: row.normalizedSourceUrl, capturedAt: new Date(), isDemo: true } });
      createdCount++; await db.importRowResult.create({ data: { batchId: batch.id, rowNumber: row.rowNumber, status: "CREATED", accountId: account.id } });
    }
    const updated = await db.importBatch.update({ where: { id: batch.id }, data: { createdCount, duplicateCount, invalidCount } });
    expect(updated.totalRows).toBe(90); expect(updated.createdCount).toBe(60); expect(updated.duplicateCount).toBe(20); expect(updated.invalidCount).toBe(10); expect(await db.account.count()).toBe(60);
    for (const platform of ["XIAOHONGSHU", "YOUTUBE", "X", "DOUYIN"] as const) expect(await db.account.count({ where: { platform } })).toBe(15);
  });

  it("rolls back account writes when a transaction fails", async () => {
    const before = await db.account.count();
    await expect(db.$transaction(async (tx) => { await tx.account.create({ data: { platform: "X", nativeId: "rollback", displayName: "回滚测试", profileUrl: "https://example.com/demo/x/rollback", normalizedProfileUrl: "https://example.com/demo/x/rollback", serviceTags: [], sourceId, sourceUrl: "https://example.com/demo/source/rollback", capturedAt: new Date(), isDemo: true } }); throw new Error("forced rollback"); })).rejects.toThrow("forced rollback");
    expect(await db.account.count()).toBe(before);
  });
});
