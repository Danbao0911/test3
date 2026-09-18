import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseTestDatabaseConfig, assertRestrictedTestRole } from "../helpers/test-database";
import pg from "pg";

const database = parseTestDatabaseConfig();
const baseUrl = "http://127.0.0.1:3111";
const password = "T05-R1-integration-password";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url }) });
const createdSourceIds: string[] = [];
const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];
const users = {
  admin: { id: "", email: `t05-admin-${database.runId}-${randomUUID()}@example.test`, role: "ADMIN" as const },
  reviewerA: { id: "", email: `t05-reviewer-a-${database.runId}-${randomUUID()}@example.test`, role: "REVIEWER" as const },
  reviewerB: { id: "", email: `t05-reviewer-b-${database.runId}-${randomUUID()}@example.test`, role: "REVIEWER" as const },
  viewer: { id: "", email: `t05-viewer-${database.runId}-${randomUUID()}@example.test`, role: "VIEWER" as const },
};
const cookies = new Map<keyof typeof users, string>();
let server: ChildProcess | undefined;
const serverOutput: string[] = [];
let databaseReady = false;

type ApiData = { item?: Record<string, unknown>; items?: Array<Record<string, unknown>>; total?: number; favorite?: boolean; error?: string; message?: string; ids?: string[]; createdCount?: number; [key: string]: unknown };
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

function jsonBody(value: unknown) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`T05-R1 专用 HTTP 服务未就绪：${serverOutput.join("").slice(-8_000)}`);
}

async function stopTestServer(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // The process may have exited between the check and the signal.
  }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
}

async function login(user: UserKey) {
  const result = await request(null, "/api/auth/login", { method: "POST", ...jsonBody({ email: users[user].email, password }) });
  expect(result.response.status).toBe(200);
  const cookie = result.response.headers.get("set-cookie");
  expect(cookie).toContain("test3_session=");
  cookies.set(user, cookie!.split(";")[0]);
}

async function createSource(name = `T05-R1 source ${randomUUID()}`) {
  const created = await request("admin", "/api/sources", { method: "POST", ...jsonBody({ name, type: "DEMO", permissionNote: "T05-R1 隔离测试授权依据" }) });
  expect(created.response.status).toBe(201);
  const id = created.data.item!.id as string;
  createdSourceIds.push(id);
  const approved = await request("admin", `/api/sources/${id}`, { method: "PATCH", ...jsonBody({ expectedPolicyVersion: created.data.item!.policyVersion, status: "APPROVED", allowImport: true, allowExtract: true, allowEvidenceText: true }) });
  expect(approved.response.status).toBe(200);
  return id;
}

function accountBody(sourceId: string, suffix = randomUUID()) {
  return { platform: "X", nativeId: `t05-r1-${suffix}`, displayName: `T05-R1 账号 ${suffix}`, profileUrl: `https://example.com/demo/x/t05-r1-${suffix}`, organization: "T05-R1 测试机构", serviceTags: ["财富规划"], region: "上海", sourceId, sourceUrl: `https://example.com/demo/source/t05-r1-${suffix}` };
}

async function createAccount(sourceId: string) {
  const created = await request("admin", "/api/accounts", { method: "POST", ...jsonBody(accountBody(sourceId)) });
  expect(created.response.status).toBe(201);
  const id = created.data.item!.id as string;
  createdAccountIds.push(id);
  return created;
}

describe("CODEX-002-T05-R1 real multi-user HTTP contract", () => {
  beforeAll(async () => {
    const guard = new pg.Client({ connectionString: database.url });
    try { await guard.connect(); await assertRestrictedTestRole(guard, database.databaseName); databaseReady = true; }
    finally { await guard.end(); }
    for (const user of Object.values(users)) {
      const created = await prisma.user.create({ data: { email: user.email, passwordHash: await bcrypt.hash(password, 4), role: user.role } });
      user.id = created.id;
      createdUserIds.push(created.id);
    }
    server = spawn(process.env.PNPM_BIN ?? "pnpm", ["dev", "-p", "3111"], {
      cwd: process.cwd(),
      env: { ...process.env, APP_MODE: "test", APP_ORIGIN: baseUrl, DATABASE_URL: database.url, TEST_DATABASE_URL: database.url, TEST_DATABASE_NAME: database.databaseName, TEST_DATABASE_MODE: "isolated", TEST_RUN_ID: database.runId, AUTH_COOKIE_NAME: "test3_session" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    server.stdout?.on("data", (chunk: Buffer) => { serverOutput.push(chunk.toString()); });
    server.stderr?.on("data", (chunk: Buffer) => { serverOutput.push(chunk.toString()); });
    await waitForHealth();
    await Promise.all((Object.keys(users) as UserKey[]).map(login));
  }, 120_000);

  afterAll(async () => {
    if (!databaseReady) { await prisma.$disconnect(); return; }
    await stopTestServer(server);
    if (createdAccountIds.length) await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
    if (createdSourceIds.length) await prisma.sourcePolicySnapshot.deleteMany({ where: { sourceId: { in: createdSourceIds } } });
    if (createdSourceIds.length) await prisma.source.deleteMany({ where: { id: { in: createdSourceIds } } });
    if (createdUserIds.length) await prisma.auditEvent.deleteMany({ where: { actorId: { in: createdUserIds } } });
    if (createdUserIds.length) await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  }, 30_000);

  it("T05W01/W02 A/B 收藏隔离、并发幂等和无变化审计", async () => {
    const sourceId = await createSource();
    const account = await createAccount(sourceId);
    const accountId = account.data.item!.id as string;

    const first = await request("reviewerA", `/api/accounts/${accountId}/favorite`, { method: "POST" });
    expect(first.response.status).toBe(200);
    expect((await request("reviewerA", `/api/accounts/${accountId}`)).data.item).toMatchObject({ favorite: true });
    expect((await request("reviewerB", `/api/accounts/${accountId}`)).data.item).toMatchObject({ favorite: false });
    expect((await request("reviewerB", `/api/accounts?favorite=YES&q=${encodeURIComponent(account.data.item!.displayName as string)}`)).data.items).toHaveLength(0);
    expect((await request("reviewerB", `/api/accounts?favorite=NO&q=${encodeURIComponent(account.data.item!.displayName as string)}`)).data.items?.map((item) => item.id)).toContain(accountId);
    expect((await request("reviewerB", `/api/accounts/${accountId}/favorite`, { method: "DELETE" })).response.status).toBe(200);
    expect((await request("reviewerA", `/api/accounts/${accountId}`)).data.item).toMatchObject({ favorite: true });
    expect((await request("viewer", `/api/accounts/${accountId}/favorite`, { method: "POST" })).response.status).toBe(403);
    expect((await request("viewer", `/api/accounts/${accountId}/favorite`, { method: "DELETE" })).response.status).toBe(403);

    const beforeFavoriteAudits = await prisma.auditEvent.count({ where: { targetId: accountId, action: "ACCOUNT_FAVORITED" } });
    const posts = await Promise.all([
      request("reviewerA", `/api/accounts/${accountId}/favorite`, { method: "POST" }),
      request("reviewerA", `/api/accounts/${accountId}/favorite`, { method: "POST" }),
    ]);
    expect(posts.map((result) => result.response.status).sort()).toEqual([200, 200]);
    expect(await prisma.accountFavorite.count({ where: { accountId, userId: users.reviewerA.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { targetId: accountId, action: "ACCOUNT_FAVORITED" } })).toBe(beforeFavoriteAudits);

    const beforeUnfavoriteAudits = await prisma.auditEvent.count({ where: { targetId: accountId, action: "ACCOUNT_UNFAVORITED" } });
    const deletes = await Promise.all([
      request("reviewerA", `/api/accounts/${accountId}/favorite`, { method: "DELETE" }),
      request("reviewerA", `/api/accounts/${accountId}/favorite`, { method: "DELETE" }),
    ]);
    expect(deletes.map((result) => result.response.status).sort()).toEqual([200, 200]);
    expect(await prisma.accountFavorite.count({ where: { accountId, userId: users.reviewerA.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { targetId: accountId, action: "ACCOUNT_UNFAVORITED" } })).toBe(beforeUnfavoriteAudits + 1);
  }, 30_000);

  it("T05W03/W04 旧版本不能覆盖不再联系，负责人和跟进一次原子提交", async () => {
    const sourceId = await createSource();
    const account = await createAccount(sourceId);
    const accountId = account.data.item!.id as string;
    const version = account.data.item!.workspaceVersion as number;
    const blocked = await request("reviewerB", `/api/accounts/${accountId}/workspace`, { method: "PATCH", ...jsonBody({ expectedWorkspaceVersion: version, ownerId: users.reviewerB.id, followUp: { status: "DO_NOT_CONTACT", note: "人工确认不再联系" } }) });
    expect(blocked.response.status).toBe(200);
    const stale = await request("reviewerA", `/api/accounts/${accountId}/workspace`, { method: "PATCH", ...jsonBody({ expectedWorkspaceVersion: version, ownerId: users.reviewerA.id, followUp: { status: "CONTACTING", note: "旧页面备注" } }) });
    expect(stale.response.status).toBe(409);
    expect(stale.data.error).toBe("WORKSPACE_CONFLICT");
    expect((await request("reviewerB", `/api/accounts/${accountId}`)).data.item).toMatchObject({ owner: { id: users.reviewerB.id }, followUp: { status: "DO_NOT_CONTACT", note: "人工确认不再联系" }, workspaceVersion: version + 1 });

    const atomic = await createAccount(sourceId);
    const atomicId = atomic.data.item!.id as string;
    const beforeAudit = await prisma.auditEvent.count({ where: { targetId: atomicId } });
    const failedBody = jsonBody({ expectedWorkspaceVersion: 1, ownerId: users.reviewerA.id, followUp: { status: "CONTACTING", note: "应回滚的原子操作" } });
    const failed = await request("reviewerA", `/api/accounts/${atomicId}/workspace`, { method: "PATCH", headers: { ...failedBody.headers, "x-test-fail-after-workspace-owner": "1" }, body: failedBody.body });
    expect(failed.response.status).toBe(500);
    expect(await prisma.auditEvent.count({ where: { targetId: atomicId } })).toBe(beforeAudit);
    expect((await request("reviewerA", `/api/accounts/${atomicId}`)).data.item).toMatchObject({ owner: null, followUp: { status: "NOT_CONTACTED", note: "" }, workspaceVersion: 1 });

    const unchanged = await request("reviewerB", `/api/accounts/${accountId}/workspace`, { method: "PATCH", ...jsonBody({ expectedWorkspaceVersion: version + 1, ownerId: users.reviewerB.id, followUp: { status: "DO_NOT_CONTACT", note: "人工确认不再联系" } }) });
    expect(unchanged.response.status).toBe(200);
    expect(unchanged.data.item!.workspaceVersion).toBe(version + 1);
    const needsConfirmation = await request("reviewerB", `/api/accounts/${accountId}/workspace`, { method: "PATCH", ...jsonBody({ expectedWorkspaceVersion: version + 1, ownerId: users.reviewerB.id, followUp: { status: "CONTACTING", note: "" } }) });
    expect(needsConfirmation.response.status).toBe(422);
    expect(needsConfirmation.data.error).toBe("REACTIVATION_CONFIRMATION_REQUIRED");
    const reactivated = await request("reviewerB", `/api/accounts/${accountId}/workspace`, { method: "PATCH", ...jsonBody({ expectedWorkspaceVersion: version + 1, ownerId: users.reviewerB.id, followUp: { status: "CONTACTING", note: "明确确认后恢复人工跟进", confirmReactivation: true } }) });
    expect(reactivated.response.status).toBe(200);
    expect(reactivated.data.item).toMatchObject({ followUp: { status: "CONTACTING" }, workspaceVersion: version + 2 });
  }, 30_000);

  it("T05W05 备注按角色脱敏，来源和列表不会透传自由文本", async () => {
    const sourceId = await createSource();
    const account = await createAccount(sourceId);
    const accountId = account.data.item!.id as string;
    const note = "sentinel@example.com wechat-sentinel +1 202 555 0100 evidence-sentinel";
    const saved = await request("reviewerA", `/api/accounts/${accountId}/workspace`, { method: "PATCH", ...jsonBody({ expectedWorkspaceVersion: 1, followUp: { status: "CONTACTING", note } }) });
    expect(saved.response.status).toBe(200);
    expect((await request("reviewerA", `/api/accounts/${accountId}`)).data.item!.followUp).toMatchObject({ note, noteMasked: false });
    const maintainerPatch = await request("reviewerA", `/api/accounts/${accountId}`, { method: "PATCH", ...jsonBody({ displayName: "T05-R1 备注映射账号" }) });
    expect(maintainerPatch.response.status).toBe(200);
    expect(maintainerPatch.data.item!.followUp).toMatchObject({ note, noteMasked: false });
    const viewerDetail = await request("viewer", `/api/accounts/${accountId}`);
    const viewerList = await request("viewer", `/api/accounts?q=${encodeURIComponent(account.data.item!.displayName as string)}`);
    expect(viewerDetail.data.item!.followUp).toMatchObject({ note: null, noteMasked: true });
    expect(JSON.stringify(viewerDetail.data)).not.toContain(note);
    expect(JSON.stringify(viewerList.data)).not.toContain(note);
    expect((await request("viewer", `/api/accounts/${accountId}`, { method: "PATCH", ...jsonBody({ displayName: "viewer should not write" }) })).response.status).toBe(403);
    expect((await request("viewer", `/api/accounts/${accountId}/workspace`, { method: "PATCH", ...jsonBody({ expectedWorkspaceVersion: 2, followUp: { status: "REPLIED", note: "viewer" } }) })).response.status).toBe(403);
  }, 30_000);

  it("T05W06/W07 收藏筛选和空范围查询保持 total 一致", async () => {
    const sourceId = await createSource();
    const account = await createAccount(sourceId);
    const accountId = account.data.item!.id as string;
    await request("reviewerA", `/api/accounts/${accountId}/favorite`, { method: "POST" });
    const selected = await request("reviewerA", `/api/accounts?favorite=YES&q=${encodeURIComponent(account.data.item!.displayName as string)}`);
    expect(selected.data.total).toBe(1);
    expect(selected.data.items?.map((item) => item.id)).toEqual([accountId]);
    expect((await request("reviewerA", `/api/accounts/${accountId}/favorite`, { method: "DELETE" })).data.favorite).toBe(false);
    const emptySelected = await request("reviewerA", `/api/accounts?favorite=YES&q=${encodeURIComponent(account.data.item!.displayName as string)}`);
    expect(emptySelected.data).toMatchObject({ total: 0, items: [] });
    const emptyUsable = await request("reviewerA", "/api/accounts?serviceTag=does-not-exist&hasContact=YES&page=4&pageSize=20");
    expect(emptyUsable.data).toMatchObject({ total: 0, items: [], page: 4 });
  }, 30_000);

  it("T05W08 来源撤销后列表和详情的可用性一致", async () => {
    const sourceId = await createSource();
    const account = await createAccount(sourceId);
    const accountId = account.data.item!.id as string;
    const extracted = await request("reviewerA", "/api/contacts/extract", { method: "POST", ...jsonBody({ accountId, sourceId, sourceUrl: "https://example.com/demo/evidence/t05-r1", capturedAt: new Date(Date.now() - 60_000).toISOString(), fieldLocation: "T05-R1 synthetic field", context: "ACCOUNT_PROFILE", text: "商务邮箱：workspace-review@example.com" }) });
    expect(extracted.response.status).toBe(200);
    const contactId = extracted.data.ids![0];
    const contact = await request("reviewerA", `/api/contacts/${contactId}`);
    const approved = await request("reviewerA", `/api/contacts/${contactId}`, { method: "PATCH", ...jsonBody({ version: contact.data.item!.version, status: "APPROVED", ownershipConfirmed: true, businessConfirmed: true, reason: "T05-R1 synthetic confirmation" }) });
    expect(approved.response.status).toBe(200);
    expect((await request("reviewerA", `/api/accounts/${accountId}`)).data.item).toMatchObject({ hasUsableContact: true });
    const source = await request("admin", `/api/sources/${sourceId}`);
    const revoked = await request("admin", `/api/sources/${sourceId}`, { method: "PATCH", ...jsonBody({ expectedPolicyVersion: source.data.item!.policyVersion, status: "REVOKED", allowImport: false }) });
    expect(revoked.response.status).toBe(200);
    expect((await request("reviewerA", `/api/accounts/${accountId}`)).data.item).toMatchObject({ hasUsableContact: false });
    const list = await request("reviewerA", `/api/accounts?hasContact=YES&q=${encodeURIComponent(account.data.item!.displayName as string)}`);
    expect(list.data.items?.map((item) => item.id)).not.toContain(accountId);
  }, 30_000);

  it("T05W09/W10 并发负责人写入只有一个成功，旧数据版本从 1 开始", async () => {
    const sourceId = await createSource();
    const account = await createAccount(sourceId);
    const accountId = account.data.item!.id as string;
    expect(account.data.item!.workspaceVersion).toBe(1);
    const results = await Promise.all([
      request("reviewerA", `/api/accounts/${accountId}/workspace`, { method: "PATCH", ...jsonBody({ expectedWorkspaceVersion: 1, ownerId: users.reviewerA.id }) }),
      request("reviewerB", `/api/accounts/${accountId}/workspace`, { method: "PATCH", ...jsonBody({ expectedWorkspaceVersion: 1, ownerId: users.reviewerB.id }) }),
    ]);
    expect(results.map((result) => result.response.status).sort()).toEqual([200, 409]);
    expect((await request("viewer", `/api/accounts/${accountId}`)).data.item!.workspaceVersion).toBe(2);
    expect((await request("admin", `/api/accounts/${randomUUID()}/workspace`, { method: "PATCH", ...jsonBody({ expectedWorkspaceVersion: 1, followUp: { status: "CONTACTING", note: "unknown" } }) })).response.status).toBe(404);
  }, 30_000);
});
