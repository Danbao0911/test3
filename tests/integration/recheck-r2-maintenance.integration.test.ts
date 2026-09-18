import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTestDatabaseConfig, assertRestrictedTestRole } from "../helpers/test-database";
import { stableIdentityFingerprints, suppressionFingerprint, SUPPRESSION_FINGERPRINT_KEY_ID } from "../../src/lib/data-protection";

const database = parseTestDatabaseConfig();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url }) });
let databaseReady = false;
let actorId = "";
let sourceId = "";
let snapshotId = "";
let replayAccountId = "";
let replayDeletionId = "";

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
    const source = await prisma.source.create({ data: { name: `recheck-r3-${randomUUID()}`, type: "DEMO", status: "APPROVED", permissionNote: "R3 isolated checkpoint test", allowImport: true, allowExtract: true, allowEvidenceText: true, policyVersion: 1 } });
    sourceId = source.id;
    const snapshot = await prisma.sourcePolicySnapshot.create({ data: { sourceId, version: 1, status: "APPROVED", allowImport: true, allowExtract: true, allowEvidenceText: true, allowExport: false, allowRelate: false, authorizationBasis: "R3 isolated checkpoint test", changeType: "TEST", changedById: actorId } });
    snapshotId = snapshot.id;
  });

  afterAll(async () => {
    if (replayDeletionId) await prisma.deletionRequest.delete({ where: { id: replayDeletionId } }).catch(() => undefined);
    if (replayAccountId) await prisma.account.delete({ where: { id: replayAccountId } }).catch(() => undefined);
    if (snapshotId) await prisma.sourcePolicySnapshot.delete({ where: { id: snapshotId } }).catch(() => undefined);
    if (sourceId) await prisma.source.delete({ where: { id: sourceId } }).catch(() => undefined);
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

  it("拒绝把 dry-run 游标交给 execute，并允许全新 execute 从头完成", async () => {
    if (!databaseReady) return;
    const account = await prisma.account.create({ data: {
      id: "00000000-0000-4000-9000-000000000001", platform: "X", nativeId: `recheck-r3-${randomUUID()}`,
      displayName: "R3 checkpoint account", profileUrl: "https://example.com/recheck-r3/checkpoint",
      normalizedProfileUrl: "https://example.com/recheck-r3/checkpoint", serviceTags: ["R3"], sourceId,
      sourceUrl: "https://example.com/recheck-r3/source", capturedAt: new Date(), isDemo: true,
    } });
    replayAccountId = account.id;
    const identity = stableIdentityFingerprints(account);
    const deletion = await prisma.deletionRequest.create({ data: {
      targetHash: suppressionFingerprint("ACCOUNT_ID", account.id), targetType: "ACCOUNT", accountId: account.id,
      identityNativeFingerprint: identity.nativeId, identityProfileFingerprint: identity.profileUrl,
      identityType: "ACCOUNT_PLATFORM_IDENTITY_V2", identityVersion: 2, identityKeyId: SUPPRESSION_FINGERPRINT_KEY_ID,
      scope: "ACCOUNT_REIMPORT_BLOCK", identityExpiresAt: new Date(Date.now() + 86_400_000), reason: "R3 checkpoint test",
      requestedById: actorId, completedById: actorId,
    } });
    replayDeletionId = deletion.id;
    const preview = await runMaintenance(["replay", "--dry-run", "--batch-size", "1", "--max-batches", "1"]);
    expect(preview.code).toBe(2);
    const previewJson = outputJson(preview.stdout);
    expect(previewJson.enforcementComplete).toBeNull();
    expect(previewJson.mode).toBe("dry-run");
    expect(typeof previewJson.continuation).toBe("string");
    const reused = await runMaintenance(["replay", "--batch-size", "1", "--max-batches", "10", "--checkpoint", String(previewJson.continuation)]);
    expect(reused.code).toBe(1);
    expect(`${reused.stdout}\n${reused.stderr}`).toContain("模式");
    expect(await prisma.account.findUnique({ where: { id: replayAccountId }, select: { id: true } })).not.toBeNull();
    const execute = await runMaintenance(["replay", "--batch-size", "1", "--max-batches", "1000"]);
    expect(execute.code).toBe(0);
    expect(outputJson(execute.stdout)).toMatchObject({ mode: "execute", executionComplete: true, complete: true });
    expect(await prisma.account.findUnique({ where: { id: replayAccountId }, select: { id: true } })).toBeNull();
  }, 120_000);
});
