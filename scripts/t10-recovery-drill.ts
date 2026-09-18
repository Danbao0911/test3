import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { deleteTarget, replayDeletionRules } from "../src/lib/retention-service";
import { assertT10IsolatedEnvironment, stableOperationalRunId } from "../src/lib/operational-controls";
import { assertRuntimeConfiguration } from "../src/lib/runtime-config";
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

async function fixture() {
  const id = randomUUID();
  const user = await sourcePrisma.user.create({ data: { email: `t10-recovery-${id}@example.com`, passwordHash: "T10 synthetic fixture only", role: "ADMIN" } });
  const source = await sourcePrisma.source.create({ data: {
    name: `T10 recovery ${id}`,
    type: "DEMO",
    status: "APPROVED",
    permissionNote: "T10 synthetic fixture only",
    allowImport: true,
    allowExtract: true,
    allowEvidenceText: true,
    policyVersion: 1,
  } });
  const snapshot = await sourcePrisma.sourcePolicySnapshot.create({ data: {
    sourceId: source.id,
    version: 1,
    status: "APPROVED",
    allowImport: true,
    allowExtract: true,
    allowEvidenceText: true,
    allowRelate: false,
    allowExport: false,
    allowedExportFields: "",
    retentionDays: 30,
    permissionNote: source.permissionNote,
    authorizationBasis: "T10 synthetic fixture only",
    changedById: user.id,
    changeType: "CREATE",
  } });
  const account = await sourcePrisma.account.create({ data: {
    platform: "X",
    nativeId: `t10-${id}`,
    displayName: "T10 synthetic recovery account",
    profileUrl: `https://example.com/t10/${id}`,
    normalizedProfileUrl: `https://example.com/t10/${id}`,
    serviceTags: ["T10_SYNTHETIC"],
    sourceId: source.id,
    sourceUrl: `https://example.com/t10/source/${id}`,
    capturedAt: new Date(),
    isDemo: true,
  } });
  const evidence = await sourcePrisma.evidence.create({ data: {
    accountId: account.id,
    sourceId: source.id,
    policyVersion: 1,
    policySnapshotId: snapshot.id,
    sourceUrl: `https://example.com/t10/evidence/${id}`,
    capturedAt: new Date(),
    fieldLocation: "T10 synthetic fixture",
    excerpt: "T10 synthetic fixture only",
    contact: { create: {
      dedupeKey: createHash("sha256").update(`T10:${id}`).digest("hex"),
      type: "EMAIL",
      rawValue: `t10-${id}@example.com`,
      normalizedValue: `t10-${id}@example.com`,
      status: "APPROVED",
      ownershipConfirmed: true,
      businessConfirmed: true,
      reviewedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    } },
  }, include: { contact: true } });
  if (!evidence.contact) throw new Error("T10 fixture contact creation failed");
  return { id, user, source, snapshot, account, evidence, contact: evidence.contact };
}

async function cleanupFixture(item: Awaited<ReturnType<typeof fixture>>) {
  const deletionRequests = await sourcePrisma.deletionRequest.findMany({ where: { requestedById: item.user.id }, select: { id: true } });
  for (const row of deletionRequests) await sourcePrisma.deletionRequest.delete({ where: { id: row.id } });
  await sourcePrisma.contactSuppression.deleteMany({ where: { createdById: item.user.id } });
  await sourcePrisma.auditEvent.deleteMany({ where: { actorId: item.user.id } });
  const remainingAccount = await sourcePrisma.account.findUnique({ where: { id: item.account.id } });
  if (remainingAccount) await sourcePrisma.account.delete({ where: { id: item.account.id } });
  await sourcePrisma.sourcePolicySnapshot.delete({ where: { id: item.snapshot.id } }).catch(() => undefined);
  await sourcePrisma.source.delete({ where: { id: item.source.id } }).catch(() => undefined);
  await sourcePrisma.user.delete({ where: { id: item.user.id } }).catch(() => undefined);
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
  const rulesDump = join(workdir, "rules.dump");
  let target: PrismaClient | undefined;
  let fixtureItem: Awaited<ReturnType<typeof fixture>> | undefined;
  let targetCreated = false;
  try {
    fixtureItem = await fixture();
    await runTool("pg_dump", [...connectionArgs(source), "--format=custom", "--no-owner", "--no-acl", "--file", baseDump], source, workdir);
    await deleteTarget(sourcePrisma, fixtureItem.user.id, { accountId: fixtureItem.account.id, reason: "T10 synthetic recovery drill", confirm: true });
    await runTool("pg_dump", [...connectionArgs(source), "--format=custom", "--data-only", "--no-owner", "--no-acl", `--table=public."ContactSuppression"`, `--table=public."DeletionRequest"`, "--file", rulesDump], source, workdir);
    await createDatabase(admin, targetName, source.username);
    targetCreated = true;
    const restoredConnection = parseConnection(targetUrl(source, targetName), "恢复数据库");
    await runTool("pg_restore", [...connectionArgs(restoredConnection), "--exit-on-error", "--no-owner", "--no-acl", baseDump], restoredConnection, workdir);
    await runTool("pg_restore", [...connectionArgs(restoredConnection), "--exit-on-error", "--data-only", "--no-owner", "--no-acl", rulesDump], restoredConnection, workdir);
    target = newPrisma(restoredConnection.url.toString());
    const first = await replayDeletionRules(target, fixtureItem.user.id, { batchSize: 1, now: new Date() });
    const remainingAccount = await target.account.findUnique({ where: { id: fixtureItem.account.id }, select: { id: true } });
    const remainingContact = await target.contactPoint.findUnique({ where: { id: fixtureItem.contact.id }, select: { id: true } });
    if (remainingAccount || remainingContact || first.deleted.accounts !== 1) throw new Error("恢复库重放未删除备份中的已撤回账号和联系项");
    const second = await replayDeletionRules(target, fixtureItem.user.id, { batchSize: 1, now: new Date() });
    if (second.deleted.accounts !== 0 || second.deleted.contacts !== 0 || !second.complete) throw new Error("重复重放不是幂等操作");
    const [baseStats, rulesStats] = await Promise.all([stat(baseDump), stat(rulesDump)]);
    console.log(JSON.stringify({ status: "passed", operation: "backup-restore-replay", sourceDatabase: source.database, restoredDatabase: targetName, firstReplay: { deletedAccounts: first.deleted.accounts, deletedContacts: first.deleted.contacts, complete: first.complete }, secondReplay: { deletedAccounts: second.deleted.accounts, deletedContacts: second.deleted.contacts, complete: second.complete }, artifacts: { baseDumpBytes: baseStats.size, rulesDumpBytes: rulesStats.size }, run: stableOperationalRunId(run) }));
  } finally {
    await target?.$disconnect().catch(() => undefined);
    if (fixtureItem) await cleanupFixture(fixtureItem).catch(() => undefined);
    await sourcePrisma.$disconnect().catch(() => undefined);
    if (targetCreated) await dropDatabase(admin, targetName).catch(() => undefined);
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ status: "failed", operation: "backup-restore-replay", error: error instanceof Error ? error.message : "T10 恢复演练失败" }));
  process.exitCode = 1;
});
