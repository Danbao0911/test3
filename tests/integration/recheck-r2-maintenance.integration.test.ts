import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTestDatabaseConfig, assertRestrictedTestRole } from "../helpers/test-database";
import { suppressionFingerprint } from "../../src/lib/data-protection";

const database = parseTestDatabaseConfig();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url }) });
let databaseReady = false;
let actorId = "";

function runMaintenance(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "scripts/retention-maintenance.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_MODE: "test",
        DATABASE_URL: database.url,
        TEST_DATABASE_URL: database.url,
        TEST_DATABASE_NAME: database.databaseName,
        TEST_DATABASE_MODE: "isolated",
        TEST_DATABASE_ALLOWED_HOSTS: database.host,
        TEST_RUN_ID: database.runId,
        APP_ORIGIN: process.env.APP_ORIGIN ?? "http://127.0.0.1:3000",
        RETENTION_CHECKPOINT_KEY: "recheck-r2-checkpoint-key",
        RETENTION_MAINTENANCE_CONFIRM: "1",
        RETENTION_MAINTENANCE_ACTOR_ID: actorId,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function outputJson(stdout: string) {
  const line = stdout.split(/\r?\n/).reverse().find((value) => value.trim().startsWith("{"));
  if (!line) throw new Error(`维护命令没有 JSON 输出：${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}

describe("CODEX-002-RECHECK-R2 maintenance subprocess", () => {
  beforeAll(async () => {
    const guard = new pg.Client({ connectionString: database.url });
    try { await guard.connect(); await assertRestrictedTestRole(guard, database.databaseName); databaseReady = true; }
    finally { await guard.end(); }
    const actor = await prisma.user.create({ data: { email: `recheck-r2-${database.runId}-${randomUUID()}@example.test`, passwordHash: "not-used", role: "ADMIN" } });
    actorId = actor.id;
  });

  afterAll(async () => {
    if (actorId) {
      await prisma.contactSuppression.deleteMany({ where: { createdById: actorId } });
      await prisma.auditEvent.deleteMany({ where: { actorId } });
      await prisma.user.delete({ where: { id: actorId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it("consumes its own cleanup checkpoint in a new process", async () => {
    if (!databaseReady) return;
    await prisma.contactSuppression.create({ data: {
      fingerprint: suppressionFingerprint("EMAIL", `recheck-r2-${randomUUID()}@example.com`),
      contactType: "EMAIL",
      reasonCode: "TEST",
      basis: "R2 subprocess checkpoint",
      expiresAt: new Date(Date.now() - 1_000),
      createdById: actorId,
    } });
    const first = await runMaintenance(["cleanup", "--batch-size", "1", "--max-batches", "1"]);
    expect(first.code).toBe(2);
    const firstOutput = outputJson(first.stdout);
    expect(firstOutput.complete).toBe(false);
    expect(typeof firstOutput.continuation).toBe("string");
    const second = await runMaintenance(["cleanup", "--batch-size", "1", "--max-batches", "1", "--checkpoint", String(firstOutput.continuation)]);
    expect(second.code).toBe(0);
    expect(outputJson(second.stdout)).toMatchObject({ complete: true, incomplete: false });
  }, 60_000);

  it("rejects a damaged checkpoint with a non-zero exit", async () => {
    if (!databaseReady) return;
    const result = await runMaintenance(["cleanup", "--checkpoint", "bad.checkpoint"]);
    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("checkpoint");
  }, 30_000);
});
