import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { deleteTarget, replayDeletionRules } from "../src/lib/retention-service";
import { assertT10IsolatedEnvironment, stableOperationalRunId } from "../src/lib/operational-controls";
import { recoveryOutcome, runRecoveryCleanup } from "../src/lib/recovery-cleanup";
import { assertRuntimeConfiguration } from "../src/lib/runtime-config";
import { SUPPRESSION_FINGERPRINT_KEY_ID, SUPPRESSION_FINGERPRINT_VERSION, stableIdentityFingerprints, suppressionFingerprint } from "../src/lib/data-protection";
import { prisma as sourcePrisma } from "../src/lib/db";

const execFileAsync = promisify(execFile);

type Connection = { url: URL; database: string; username: string; password: string; host: string; port: string };

function parseConnection(raw: string | undefined, name: string): Connection {
  if (!raw) throw new Error(`${name} 未配置`);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} 不是有效 PostgreSQL URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || !url.username || !url.password) throw new Error(`${name} 连接参数不符合隔离演练要求`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error(`${name} 缺少数据库名称`);
  return { url, database, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, port: url.port || "5432" };
}

function connectionArgs(connection: Connection, database = connection.database) {
  return ["--host", connection.host, "--port", connection.port, "--username", connection.username, "--dbname", database];
}

async function runTool(tool: "pg_dump" | "pg_restore", args: string[], connection: Connection, mountedWorkdir?: string) {
  const image = process.env.T10_PG_TOOL_IMAGE;
  const command = image ? "docker" : tool;
  const mappedArgs = image && mountedWorkdir ? args.map((arg) => arg.startsWith(`${mountedWorkdir}/`) ? `/t10-work/${arg.slice(mountedWorkdir.length + 1)}` : arg) : args;
  const commandArgs = image ? ["run", "--rm", "--network", "host", ...(mountedWorkdir ? ["--volume", `${mountedWorkdir}:/t10-work`] : []), "--env", "PGPASSWORD", image, tool, ...mappedArgs] : args;
  try {
    await execFileAsync(command, commandArgs, { env: { ...process.env, PGPASSWORD: connection.password }, maxBuffer: 256 * 1024 });
  } catch (error) {
    const exitCode = typeof error === "object" && error && "code" in error ? String(error.code) : "unknown";
    const stderr = typeof error === "object" && error && "stderr" in error ? String(error.stderr ?? "") : "";
    const safeStderr = stderr.replaceAll(connection.password, "[redacted]").replaceAll(connection.url.toString(), "[redacted]").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-url]").trim().slice(0, 300);
    throw new Error(`${tool} 执行失败（退出码 ${exitCode}）${safeStderr ? `：${safeStderr}` : "；未输出数据库工具原文"}`);
  }
}

function quoteIdentifier(value: string) {
  if (!/^[a-z0-9_-]+$/i.test(value)) throw new Error("恢复数据库名称无效");
  return `"${value.replaceAll('"', '""')}"`;
}

function targetUrl(source: Connection, database: string) {
  const url = new URL(source.url.toString());
  url.pathname = `/${database}`;
  return url.toString();
}

function newPrisma(connectionString: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function createDatabase(admin: Connection, target: string, owner: string) {
  const client = new pg.Client({ connectionString: admin.url.toString() });
  await client.connect();
  try { await client.query(`CREATE DATABASE ${quoteIdentifier(target)} OWNER ${quoteIdentifier(owner)}`); }
  finally { await client.end(); }
}

async function dropDatabase(admin: Connection, target: string) {
  const client = new pg.Client({ connectionString: admin.url.toString() });
  await client.connect();
  try { await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(target)}`); }
  finally { await client.end(); }
}

async function createTarget(id: string, sourceId: string, snapshotId: string, label: string) {
  const account = await sourcePrisma.account.create({ data: {
    platform: "X", nativeId: `t10-${label}-${id}`, displayName: `T10 synthetic ${label}`,
    profileUrl: `https://example.com/t10/${label}/${id}`, normalizedProfileUrl: `https://example.com/t10/${label}/${id}`,
    serviceTags: ["T10_SYNTHETIC"], sourceId, sourceUrl: `https://example.com/t10/source/${id}`,
    capturedAt: new Date(), isDemo: true,
  } });
  const evidence = await sourcePrisma.evidence.create({ data: {
    accountId: account.id, sourceId, policyVersion: 1, policySnapshotId: snapshotId,
    sourceUrl: `https://example.com/t10/evidence/${label}/${id}`, capturedAt: new Date(),
    fieldLocation: `T10 synthetic ${label}`, excerpt: "T10 synthetic fixture only",
    contact: { create: {
      dedupeKey: createHash("sha256").update(`T10:${label}:${id}`).digest("hex"), type: "EMAIL",
      rawValue: `t10-${label}-${id}@example.com`, normalizedValue: `t10-${label}-${id}@example.com`,
      status: "APPROVED", ownershipConfirmed: true, businessConfirmed: true, reviewedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    } },
  }, include: { contact: true } });
  if (!evidence.contact) throw new Error(`T10 ${label} fixture contact creation failed`);
  return { account, evidence, contact: evidence.contact };
}

async function fixture() {
  const id = randomUUID();
  const user = await sourcePrisma.user.create({ data: { email: `t10-recovery-${id}@example.com`, passwordHash: "T10 synthetic fixture only", role: "ADMIN" } });
  const source = await sourcePrisma.source.create({ data: {
    name: `T10 recovery ${id}`, type: "DEMO", status: "APPROVED", permissionNote: "T10 synthetic fixture only",
    allowImport: true, allowExtract: true, allowEvidenceText: true, policyVersion: 1,
  } });
  const snapshot = await sourcePrisma.sourcePolicySnapshot.create({ data: {
    sourceId: source.id, version: 1, status: "APPROVED", allowImport: true, allowExtract: true,
    allowEvidenceText: true, allowRelate: false, allowExport: false, allowedExportFields: "",
    retentionDays: 30, permissionNote: source.permissionNote, authorizationBasis: "T10 synthetic fixture only",
    changedById: user.id, changeType: "CREATE",
  } });
  const baseline = await createTarget(id, source.id, snapshot.id, "baseline");
  const postA = await createTarget(id, source.id, snapshot.id, "post-a");
  const postB = await createTarget(id, source.id, snapshot.id, "post-b");
  const sentinel = await createTarget(id, source.id, snapshot.id, "sentinel");
  const identity = stableIdentityFingerprints({ platform: baseline.account.platform, nativeId: baseline.account.nativeId, normalizedProfileUrl: baseline.account.normalizedProfileUrl });
  const baselineDeletion = await sourcePrisma.deletionRequest.create({ data: {
    targetHash: suppressionFingerprint("ACCOUNT_ID", baseline.account.id), targetType: "ACCOUNT", accountId: baseline.account.id,
    identityNativeFingerprint: identity.nativeId, identityProfileFingerprint: identity.profileUrl,
    identityType: "ACCOUNT_PLATFORM_IDENTITY_V2", identityVersion: 2, identityKeyId: SUPPRESSION_FINGERPRINT_KEY_ID,
    scope: "ACCOUNT_REIMPORT_BLOCK", identityExpiresAt: new Date(Date.now() + 86_400_000), reason: "T10 existing baseline rule",
    requestedById: user.id, completedById: user.id,
  } });
  const baselineSuppression = await sourcePrisma.contactSuppression.create({ data: {
    fingerprint: suppressionFingerprint(baseline.contact.type, baseline.contact.normalizedValue), fingerprintVersion: SUPPRESSION_FINGERPRINT_VERSION,
    fingerprintKeyId: SUPPRESSION_FINGERPRINT_KEY_ID, scope: "CONTACT_VALUE_GLOBAL", contactType: baseline.contact.type,
    contactId: baseline.contact.id, accountId: baseline.account.id, reasonCode: "DO_NOT_CONTACT", basis: "T10 existing baseline rule",
    expiresAt: new Date(Date.now() + 86_400_000), createdById: user.id,
  } });
  return { id, user, source, snapshot, baseline, postA, postB, sentinel, baselineDeletion, baselineSuppression };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cleanupFixture(item: Fixture) {
  const deletionRequests = await sourcePrisma.deletionRequest.findMany({ where: { requestedById: item.user.id }, select: { id: true } });
  for (const row of deletionRequests) await sourcePrisma.deletionRequest.delete({ where: { id: row.id } });
  const suppressions = await sourcePrisma.contactSuppression.findMany({ where: { createdById: item.user.id }, select: { id: true } });
  for (const row of suppressions) await sourcePrisma.contactSuppression.delete({ where: { id: row.id } });
  const accounts = [item.baseline.account, item.postA.account, item.postB.account, item.sentinel.account];
  for (const account of accounts) {
    const existing = await sourcePrisma.account.findUnique({ where: { id: account.id } });
    if (existing) await sourcePrisma.account.delete({ where: { id: account.id } });
  }
  await sourcePrisma.auditEvent.deleteMany({ where: { actorId: item.user.id } });
  await sourcePrisma.sourcePolicySnapshot.delete({ where: { id: item.snapshot.id } });
  await sourcePrisma.source.delete({ where: { id: item.source.id } });
  await sourcePrisma.user.delete({ where: { id: item.user.id } });
}

type RulePackage = {
  formatVersion: 1;
  backupCutoff: string;
  capturedAt: string;
  requiredUserIds: string[];
  deletionRequests: Array<Record<string, unknown>>;
  contactSuppressions: Array<Record<string, unknown>>;
};

async function buildRulePackage(item: Fixture, deletionIds: string[], suppressionIds: string[], backupCutoff: Date): Promise<RulePackage> {
  const [deletionRequests, contactSuppressions] = await Promise.all([
    sourcePrisma.deletionRequest.findMany({ where: { id: { in: deletionIds } } }),
    sourcePrisma.contactSuppression.findMany({ where: { id: { in: suppressionIds } } }),
  ]);
  return {
    formatVersion: 1, backupCutoff: backupCutoff.toISOString(), capturedAt: new Date().toISOString(), requiredUserIds: [item.user.id],
    deletionRequests: deletionRequests as unknown as Array<Record<string, unknown>>,
    contactSuppressions: contactSuppressions as unknown as Array<Record<string, unknown>>,
  };
}

async function applyRulePackage(target: PrismaClient, packet: RulePackage) {
  if (packet.formatVersion !== 1) throw new Error("RULE_PACKAGE_VERSION_UNSUPPORTED");
  if (!Number.isFinite(Date.parse(packet.backupCutoff)) || !Number.isFinite(Date.parse(packet.capturedAt)) || Date.parse(packet.capturedAt) <= Date.parse(packet.backupCutoff)) throw new Error("RULE_PACKAGE_TIME_INVALID");
  const users = await target.user.findMany({ where: { id: { in: packet.requiredUserIds } }, select: { id: true } });
  const existingUsers = new Set(users.map((user) => user.id));
  if (packet.requiredUserIds.some((id) => !existingUsers.has(id))) throw new Error("RULE_DEPENDENCY_MISSING");
  let inserted = 0;
  await target.$transaction(async (tx) => {
    for (const row of packet.deletionRequests) {
      const id = String(row.id);
      const data = {
        targetHash: String(row.targetHash), targetType: String(row.targetType), accountId: row.accountId ? String(row.accountId) : null,
        contactId: row.contactId ? String(row.contactId) : null, reason: String(row.reason), status: row.status as never,
        requestedById: String(row.requestedById), completedById: String(row.completedById), requestedAt: new Date(String(row.requestedAt)),
        completedAt: new Date(String(row.completedAt)), identityFingerprint: row.identityFingerprint ? String(row.identityFingerprint) : null,
        identityNativeFingerprint: row.identityNativeFingerprint ? String(row.identityNativeFingerprint) : null,
        identityProfileFingerprint: row.identityProfileFingerprint ? String(row.identityProfileFingerprint) : null,
        identityType: row.identityType ? String(row.identityType) : null, identityVersion: Number(row.identityVersion), identityKeyId: String(row.identityKeyId),
        scope: String(row.scope), identityExpiresAt: row.identityExpiresAt ? new Date(String(row.identityExpiresAt)) : null,
      };
      const existing = await tx.deletionRequest.findUnique({ where: { id }, select: { id: true } });
      if (!existing) { await tx.deletionRequest.create({ data: { id, ...data } }); inserted += 1; }
      else await tx.deletionRequest.update({ where: { id }, data });
    }
    for (const row of packet.contactSuppressions) {
      const id = String(row.id);
      const data = {
        fingerprint: String(row.fingerprint), contactType: row.contactType as never, accountId: row.accountId ? String(row.accountId) : null,
        contactId: row.contactId ? String(row.contactId) : null, reasonCode: String(row.reasonCode), basis: String(row.basis),
        expiresAt: new Date(String(row.expiresAt)), fingerprintVersion: Number(row.fingerprintVersion), fingerprintKeyId: String(row.fingerprintKeyId),
        scope: String(row.scope), createdById: String(row.createdById), createdAt: new Date(String(row.createdAt)),
      };
      const existing = await tx.contactSuppression.findUnique({ where: { id }, select: { id: true } });
      if (!existing) { await tx.contactSuppression.create({ data: { id, ...data } }); inserted += 1; }
      else await tx.contactSuppression.update({ where: { id }, data });
    }
  });
  return { inserted };
}

async function replayUntilComplete(target: PrismaClient, actorId: string) {
  let accountCursor: string | undefined;
  let contactCursor: string | undefined;
  let accountDone = false;
  let contactDone = false;
  const total = { batches: 0, scannedAccounts: 0, scannedContacts: 0, deletedAccounts: 0, deletedContacts: 0 };
  let last: Awaited<ReturnType<typeof replayDeletionRules>> | undefined;
  do {
    last = await replayDeletionRules(target, actorId, { batchSize: 1, accountCursor, contactCursor, accountDone, contactDone });
    total.batches += 1; total.scannedAccounts += last.scanned.accounts; total.scannedContacts += last.scanned.contacts;
    total.deletedAccounts += last.deleted.accounts; total.deletedContacts += last.deleted.contacts;
    accountCursor = last.next.accountCursor ?? undefined; contactCursor = last.next.contactCursor ?? undefined;
    accountDone = last.next.accountDone; contactDone = last.next.contactDone;
  } while (last.hasMore);
  if (!last.complete) throw new Error("恢复规则仍未完成或存在阻塞规则");
  return { ...total, complete: true };
}

async function main() {
  const dryRun = !process.argv.includes("--execute");
  assertRuntimeConfiguration();
  const preflight = assertT10IsolatedEnvironment();
  if (dryRun) {
    console.log(JSON.stringify({ status: "dry-run", operation: "backup-restore-replay", database: preflight.database, platform: preflight.platform, requires: ["--execute", "T10_RECOVERY_CONFIRM=1", "T10_RECOVERY_ADMIN_URL"] }));
    return;
  }
  if (process.env.T10_RECOVERY_CONFIRM !== "1") throw new Error("实际演练必须设置 T10_RECOVERY_CONFIRM=1");
  const source = parseConnection(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL");
  const admin = parseConnection(process.env.T10_RECOVERY_ADMIN_URL, "T10_RECOVERY_ADMIN_URL");
  if (source.host !== "127.0.0.1" || admin.host !== "127.0.0.1") throw new Error("恢复演练只允许 127.0.0.1");
  const run = (process.env.T10_RUN_ID ?? process.env.TEST_RUN_ID ?? "local").toLowerCase();
  if (!/^[a-z0-9-]{1,24}$/.test(run)) throw new Error("T10_RUN_ID 格式无效");
  const targetName = `test3_recovery_${run}`;
  const workdir = await mkdtemp(join(tmpdir(), "test3-t10-recovery-"));
  const baseDump = join(workdir, "base.dump");
  const packagePath = join(workdir, "rules-package.json");
  let target: PrismaClient | undefined;
  let fixtureItem: Fixture | undefined;
  let targetCreated = false;
  let recoveryVerified = false;
  let primaryError: unknown;
  let replayStats: Record<string, unknown> | undefined;
  try {
    fixtureItem = await fixture();
    const backupCutoff = new Date();
    await runTool("pg_dump", [...connectionArgs(source), "--format=custom", "--no-owner", "--no-acl", "--file", baseDump], source, workdir);
    const deletedA = await deleteTarget(sourcePrisma, fixtureItem.user.id, { accountId: fixtureItem.postA.account.id, reason: "T10 post-backup rule A", confirm: true });
    const deletedB = await deleteTarget(sourcePrisma, fixtureItem.user.id, { accountId: fixtureItem.postB.account.id, reason: "T10 post-backup rule B", confirm: true });
    const updatedSuppression = await sourcePrisma.contactSuppression.findUnique({ where: { fingerprint: suppressionFingerprint(fixtureItem.postA.contact.type, fixtureItem.postA.contact.normalizedValue) } });
    if (!updatedSuppression) throw new Error("T10 post-backup suppression missing");
    await sourcePrisma.contactSuppression.update({ where: { id: updatedSuppression.id }, data: { basis: "T10 post-backup rule updated", expiresAt: new Date(Date.now() + 172_800_000) } });
    const postBSuppression = await sourcePrisma.contactSuppression.findUniqueOrThrow({ where: { fingerprint: suppressionFingerprint(fixtureItem.postB.contact.type, fixtureItem.postB.contact.normalizedValue) } });
    const packet = await buildRulePackage(fixtureItem, [deletedA.requestId, deletedB.requestId], [updatedSuppression.id, postBSuppression.id], backupCutoff);
    await writeFile(packagePath, JSON.stringify(packet), "utf8");
    const restoredPacket = JSON.parse(await readFile(packagePath, "utf8")) as RulePackage;
    await createDatabase(admin, targetName, source.username);
    targetCreated = true;
    const restoredConnection = parseConnection(targetUrl(source, targetName), "恢复数据库");
    await runTool("pg_restore", [...connectionArgs(restoredConnection), "--exit-on-error", "--no-owner", "--no-acl", baseDump], restoredConnection, workdir);
    target = newPrisma(restoredConnection.url.toString());
    const preImportRules = { deletions: await target.deletionRequest.count(), suppressions: await target.contactSuppression.count() };
    const firstImport = await applyRulePackage(target, restoredPacket);
    const secondImport = await applyRulePackage(target, restoredPacket);
    const postImportRules = { deletions: await target.deletionRequest.count(), suppressions: await target.contactSuppression.count() };
    if (preImportRules.deletions !== 1 || preImportRules.suppressions !== 1 || postImportRules.deletions !== 3 || postImportRules.suppressions !== 3) throw new Error("恢复规则基线/规则包计数不符合预期");
    const replay = await replayUntilComplete(target, fixtureItem.user.id);
    replayStats = { replay, preImportRules, postImportRules, firstPackageInsertions: firstImport.inserted, secondPackageInsertions: secondImport.inserted };
    const remaining = {
      baseline: await target.account.findUnique({ where: { id: fixtureItem.baseline.account.id }, select: { id: true } }),
      postA: await target.account.findUnique({ where: { id: fixtureItem.postA.account.id }, select: { id: true } }),
      postB: await target.account.findUnique({ where: { id: fixtureItem.postB.account.id }, select: { id: true } }),
      sentinel: await target.account.findUnique({ where: { id: fixtureItem.sentinel.account.id }, select: { id: true } }),
    };
    if (remaining.baseline || remaining.postA || remaining.postB || !remaining.sentinel) throw new Error("恢复重放未完整删除受规则目标或误删无关哨兵");
    const secondReplay = await replayUntilComplete(target, fixtureItem.user.id);
    if (secondReplay.deletedAccounts !== 0 || secondReplay.deletedContacts !== 0) throw new Error("第二轮完整重放不是幂等操作");
    replayStats = { ...replayStats, secondReplay, remaining: { sentinelPresent: true } };
    recoveryVerified = true;
  } catch (error) {
    primaryError = error;
  }
  const cleanup = await runRecoveryCleanup({
    fixture: async () => { if (fixtureItem) await cleanupFixture(fixtureItem); },
    disconnect: async () => { await target?.$disconnect(); await sourcePrisma.$disconnect(); },
    drop: async () => { if (targetCreated) await dropDatabase(admin, targetName); },
    files: async () => { await rm(workdir, { recursive: true, force: false }); },
  });
  const outcome = recoveryOutcome(recoveryVerified, cleanup);
  console.log(JSON.stringify({ ...outcome, operation: "backup-restore-replay", sourceDatabase: source.database, restoredDatabase: targetName, run: stableOperationalRunId(run), recovery: replayStats, primaryError: primaryError instanceof Error ? primaryError.message : primaryError ? "T10_RECOVERY_FAILED" : undefined, resources: { database: targetCreated ? targetName : null, run: stableOperationalRunId(run) } }));
  if (outcome.exitCode !== 0) process.exitCode = 1;
}

main().catch((error) => {
  console.log(JSON.stringify({ status: "failed", operation: "backup-restore-replay", recoveryVerified: false, cleanupVerified: false, error: error instanceof Error ? error.message : "T10 恢复演练失败" }));
  process.exitCode = 1;
});
