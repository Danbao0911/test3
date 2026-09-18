import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseTestDatabaseConfig, assertRestrictedTestRole } from "../helpers/test-database";
import pg from "pg";

const database = parseTestDatabaseConfig();
const baseUrl = "http://127.0.0.1:3122";
const password = "T07-integration-password";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url }) });
const users = {
  admin: { id: "", email: `t07-admin-${database.runId}-${randomUUID()}@example.test`, role: "ADMIN" as const },
  reviewer: { id: "", email: `t07-reviewer-${database.runId}-${randomUUID()}@example.test`, role: "REVIEWER" as const },
  viewer: { id: "", email: `t07-viewer-${database.runId}-${randomUUID()}@example.test`, role: "VIEWER" as const },
};
const cookies = new Map<keyof typeof users, string>();
const createdSourceIds: string[] = [];
const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];
let server: ChildProcess | undefined;
let databaseReady = false;

type ApiData = { item?: Record<string, unknown>; items?: Array<Record<string, unknown>>; [key: string]: unknown };
type UserKey = keyof typeof users;

async function responseData(response: Response): Promise<ApiData> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as ApiData; } catch { return { raw: text }; }
}

async function request(user: UserKey | null, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", baseUrl);
  const cookie = user ? cookies.get(user) : undefined;
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  return { response, data: await responseData(response) };
}

function jsonBody(value: unknown) { return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }; }

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("T07 专用 HTTP 服务未就绪");
}

async function login(user: UserKey) {
  const result = await request(null, "/api/auth/login", { method: "POST", ...jsonBody({ email: users[user].email, password }) });
  expect(result.response.status).toBe(200);
  cookies.set(user, result.response.headers.get("set-cookie")!.split(";")[0]);
}

async function createFixture(displayName: string) {
  const contactValue = `t07-${randomUUID()}@example.com`;
  const sourceResponse = await request("admin", "/api/sources", { method: "POST", ...jsonBody({ name: `T07 来源 ${randomUUID()}`, type: "DEMO", permissionNote: "T07 隔离测试授权依据" }) });
  expect(sourceResponse.response.status).toBe(201);
  const sourceId = sourceResponse.data.item!.id as string;
  createdSourceIds.push(sourceId);
  const approved = await request("admin", `/api/sources/${sourceId}`, { method: "PATCH", ...jsonBody({ expectedPolicyVersion: sourceResponse.data.item!.policyVersion, status: "APPROVED", allowImport: true, allowExtract: true, allowEvidenceText: true, allowExport: true }) });
  expect(approved.response.status).toBe(200);
  const accountResponse = await request("admin", "/api/accounts", { method: "POST", ...jsonBody({ platform: "X", nativeId: `t07-${randomUUID()}`, displayName, profileUrl: `https://example.com/demo/x/${randomUUID()}`, organization: "T07 虚构机构", serviceTags: ["财富规划"], region: "上海", sourceId, sourceUrl: `https://example.com/demo/source/${randomUUID()}` }) });
  expect(accountResponse.response.status).toBe(201);
  const accountId = accountResponse.data.item!.id as string;
  createdAccountIds.push(accountId);
  const extracted = await request("reviewer", "/api/contacts/extract", { method: "POST", ...jsonBody({ accountId, sourceId, sourceUrl: "https://example.com/demo/evidence/t07", capturedAt: new Date(Date.now() - 60_000).toISOString(), fieldLocation: "T07 虚构商务栏", context: "ACCOUNT_PROFILE", text: `商务邮箱：${contactValue}` }) });
  expect(extracted.response.status).toBe(200);
  const contacts = await request("reviewer", `/api/contacts?accountId=${accountId}`);
  const contactId = contacts.data.items![0].id as string;
  const reviewed = await request("reviewer", `/api/contacts/${contactId}`, { method: "PATCH", ...jsonBody({ version: 1, status: "APPROVED", ownershipConfirmed: true, businessConfirmed: true, reason: "T07 隔离测试中人工核对" }) });
  expect(reviewed.response.status).toBe(200);
  return { sourceId, accountId, contactId, contactValue };
}

describe("CODEX-002-T07 real HTTP export, suppression and deletion contract", () => {
  beforeAll(async () => {
    const guard = new pg.Client({ connectionString: database.url });
    try { await guard.connect(); await assertRestrictedTestRole(guard, database.databaseName); databaseReady = true; }
    finally { await guard.end(); }
    for (const user of Object.values(users)) {
      const created = await prisma.user.create({ data: { email: user.email, passwordHash: await bcrypt.hash(password, 4), role: user.role } });
      user.id = created.id; createdUserIds.push(created.id);
    }
    server = spawn(process.env.PNPM_BIN ?? "pnpm", ["dev", "-p", "3122"], { cwd: process.cwd(), env: { ...process.env, APP_MODE: "test", APP_ORIGIN: baseUrl, DATABASE_URL: database.url, TEST_DATABASE_URL: database.url, TEST_DATABASE_NAME: database.databaseName, TEST_DATABASE_MODE: "isolated", TEST_RUN_ID: database.runId, AUTH_COOKIE_NAME: "test3_session" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    await waitForHealth();
    await Promise.all((Object.keys(users) as UserKey[]).map(login));
  }, 120_000);

  afterAll(async () => {
    if (!databaseReady) { await prisma.$disconnect(); return; }
    if (server && server.exitCode === null) { try { process.kill(-server.pid!, "SIGTERM"); } catch { server.kill("SIGTERM"); } }
    await prisma.deletionRequest.deleteMany({ where: { requestedById: { in: createdUserIds } } });
    await prisma.exportJob.deleteMany({ where: { createdById: { in: createdUserIds } } });
    await prisma.contactSuppression.deleteMany({ where: { createdById: { in: createdUserIds } } });
    if (createdAccountIds.length) await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
    if (createdSourceIds.length) await prisma.sourcePolicySnapshot.deleteMany({ where: { sourceId: { in: createdSourceIds } } });
    if (createdSourceIds.length) await prisma.source.deleteMany({ where: { id: { in: createdSourceIds } } });
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: createdUserIds } } });
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  }, 30_000);

  it("T07W01/W02 只导出当前允许且人工核验的字段，并执行公式防护和一次性下载", async () => {
    const fixture = await createFixture("=T07 公式测试账号");
    const created = await request("admin", "/api/exports", { method: "POST", ...jsonBody({ fields: ["DISPLAY_NAME", "CONTACT_VALUE", "SOURCE_URL"], accountIds: [fixture.accountId], expiresInMinutes: 10 }) });
    expect(created.response.status).toBe(201);
    expect(created.data.item).toMatchObject({ rowCount: 1, excludedCount: 0 });
    const downloadUrl = created.data.item!.downloadUrl as string;
    const download = await request("admin", downloadUrl);
    expect(download.response.status).toBe(200);
    const csv = download.data.raw as string;
    expect(csv).toContain("'=T07 公式测试账号");
    expect(csv).toContain(fixture.contactValue);
    const second = await request("admin", downloadUrl);
    expect(second.response.status).toBe(410);
    expect((await request("viewer", "/api/exports", { method: "POST", ...jsonBody({ fields: ["DISPLAY_NAME"], accountIds: [fixture.accountId] }) })).response.status).toBe(403);

    const staleJob = await request("admin", "/api/exports", { method: "POST", ...jsonBody({ fields: ["DISPLAY_NAME"], accountIds: [fixture.accountId] }) });
    expect(staleJob.response.status).toBe(201);
    const source = await request("admin", `/api/sources/${fixture.sourceId}`);
    const closed = await request("admin", `/api/sources/${fixture.sourceId}`, { method: "PATCH", ...jsonBody({ expectedPolicyVersion: source.data.item!.policyVersion, allowExport: false }) });
    expect(closed.response.status).toBe(200);
    expect((await request("admin", staleJob.data.item!.downloadUrl as string)).response.status).toBe(410);
    const blocked = await request("admin", "/api/exports", { method: "POST", ...jsonBody({ fields: ["DISPLAY_NAME"], accountIds: [fixture.accountId] }) });
    expect(blocked.response.status).toBe(422);
    expect(blocked.data.error).toBe("NO_EXPORTABLE_ROWS");
  }, 45_000);

  it("T07W03/W04 拒绝联系使用有期限指纹，删除物理清除并清理临时导出", async () => {
    const fixture = await createFixture("T07 删除测试账号");
    const suppressed = await request("reviewer", `/api/contacts/${fixture.contactId}/suppression`, { method: "POST", ...jsonBody({ reasonCode: "DO_NOT_CONTACT", basis: "测试中明确拒绝后续联系" }) });
    expect(suppressed.response.status).toBe(200);
    expect(await prisma.contactSuppression.count({ where: { contactId: fixture.contactId } })).toBe(1);
    const extraction = await request("reviewer", "/api/contacts/extract", { method: "POST", ...jsonBody({ accountId: fixture.accountId, sourceId: fixture.sourceId, sourceUrl: "https://example.com/demo/evidence/t07-again", capturedAt: new Date(Date.now() - 60_000).toISOString(), fieldLocation: "T07 再次提取", context: "ACCOUNT_PROFILE", text: `商务邮箱：${fixture.contactValue}` }) });
    expect(extraction.response.status).toBe(200);
    expect(extraction.data).toMatchObject({ createdCount: 0, suppressedCount: 1 });
    expect((await request("admin", "/api/exports", { method: "POST", ...jsonBody({ fields: ["CONTACT_VALUE"], accountIds: [fixture.accountId] }) })).response.status).toBe(422);
    const deletedContact = await request("admin", "/api/deletion-requests", { method: "POST", ...jsonBody({ contactId: fixture.contactId, reason: "测试中确认删除联系人和证据", confirm: true }) });
    expect(deletedContact.response.status).toBe(201);
    expect(await prisma.contactPoint.findUnique({ where: { id: fixture.contactId } })).toBeNull();
    expect(await prisma.evidence.count({ where: { accountId: fixture.accountId } })).toBe(0);

    const account = await createFixture("T07 账号删除测试");
    const job = await request("admin", "/api/exports", { method: "POST", ...jsonBody({ fields: ["DISPLAY_NAME"], accountIds: [account.accountId] }) });
    expect(job.response.status).toBe(201);
    const deletedAccount = await request("admin", "/api/deletion-requests", { method: "POST", ...jsonBody({ accountId: account.accountId, reason: "测试中确认删除账号及临时导出", confirm: true }) });
    expect(deletedAccount.response.status).toBe(201);
    expect(await prisma.account.findUnique({ where: { id: account.accountId } })).toBeNull();
    expect(await prisma.exportJob.findUnique({ where: { id: job.data.item!.id as string } })).toBeNull();
    expect((await request("viewer", "/api/deletion-requests", { method: "GET" })).response.status).toBe(403);
  }, 60_000);
});
