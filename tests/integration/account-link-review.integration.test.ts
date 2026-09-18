import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseTestDatabaseConfig, assertRestrictedTestRole } from "../helpers/test-database";
import pg from "pg";

const database = parseTestDatabaseConfig();
const baseUrl = "http://127.0.0.1:3112";
const password = "T06-link-review-integration-password";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url }) });
const createdSourceIds: string[] = [];
const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];
const users = {
  admin: { id: "", email: `t06-admin-${database.runId}-${randomUUID()}@example.test`, role: "ADMIN" as const },
  reviewerA: { id: "", email: `t06-reviewer-a-${database.runId}-${randomUUID()}@example.test`, role: "REVIEWER" as const },
  reviewerB: { id: "", email: `t06-reviewer-b-${database.runId}-${randomUUID()}@example.test`, role: "REVIEWER" as const },
  viewer: { id: "", email: `t06-viewer-${database.runId}-${randomUUID()}@example.test`, role: "VIEWER" as const },
};
type UserKey = keyof typeof users;
const cookies = new Map<UserKey, string>();
let server: ChildProcess | undefined;
const serverOutput: string[] = [];
let databaseReady = false;

type ApiItem = { id?: string; policyVersion?: number; version?: number; [key: string]: unknown };
type ApiData = { item?: ApiItem; items?: ApiItem[]; ids?: string[]; createdCount?: number; error?: string; message?: string; [key: string]: unknown };

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

function relationEvidence(sourceId: string, leftAccountId: string, rightAccountId: string) {
  return [{ sourceId, sourceUrl: "https://example.com/demo/evidence/t06-link-review", capturedAt: new Date(Date.now() - 60_000).toISOString(), fieldLocation: "公开主体资料关联说明", summary: "人工分别核对两侧账号主体资料后确认关联", leftAccountId, rightAccountId, leftAccountVerified: true, rightAccountVerified: true }];
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`T06 专用 HTTP 服务未就绪：${serverOutput.join("").slice(-8_000)}`);
}

async function stopTestServer(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { /* the process may have exited between the check and the signal */ }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
}

async function login(user: UserKey) {
  const result = await request(null, "/api/auth/login", { method: "POST", ...jsonBody({ email: users[user].email, password }) });
  expect(result.response.status).toBe(200);
  const cookie = result.response.headers.get("set-cookie");
  expect(cookie).toContain("test3_session=");
  cookies.set(user, cookie!.split(";")[0]);
}

async function createSource(name = `T06 source ${randomUUID()}`) {
  const created = await request("admin", "/api/sources", { method: "POST", ...jsonBody({ name, type: "DEMO", permissionNote: "T06 隔离测试授权依据" }) });
  expect(created.response.status).toBe(201);
  const id = created.data.item!.id as string;
  createdSourceIds.push(id);
  const approved = await request("admin", `/api/sources/${id}`, { method: "PATCH", ...jsonBody({ expectedPolicyVersion: created.data.item!.policyVersion as number, status: "APPROVED", allowImport: true, allowExtract: true, allowEvidenceText: true, allowRelate: true }) });
  expect(approved.response.status).toBe(200);
  return id;
}

async function createAccount(sourceId: string, suffix: string = randomUUID(), displayName = "T06 同名账号") {
  const created = await request("admin", "/api/accounts", { method: "POST", ...jsonBody({ platform: "X", nativeId: `t06-${suffix}`, displayName, profileUrl: `https://example.com/demo/x/t06-${suffix}`, organization: "T06 测试机构", serviceTags: ["财富规划"], region: "上海", sourceId, sourceUrl: `https://example.com/demo/source/t06-${suffix}` }) });
  expect(created.response.status).toBe(201);
  createdAccountIds.push(created.data.item!.id as string);
  return created.data.item!.id as string;
}

async function createReviewedContact(accountId: string, sourceId: string, value: string) {
  const extracted = await request("reviewerA", "/api/contacts/extract", { method: "POST", ...jsonBody({ accountId, sourceId, sourceUrl: "https://example.com/demo/evidence/t06", capturedAt: new Date(Date.now() - 60_000).toISOString(), fieldLocation: "T06 账号资料商务栏", context: "ACCOUNT_PROFILE", text: `商务邮箱：${value}` }) });
  expect(extracted.response.status).toBe(200);
  expect(extracted.data.createdCount).toBe(1);
  const contactId = extracted.data.ids![0];
  const current = await request("reviewerA", `/api/contacts/${contactId}`);
  const reviewed = await request("reviewerA", `/api/contacts/${contactId}`, { method: "PATCH", ...jsonBody({ version: current.data.item!.version as number, status: "APPROVED", ownershipConfirmed: true, businessConfirmed: true, reason: "T06 隔离测试中人工核对字段归属和用途" }) });
  expect(reviewed.response.status).toBe(200);
  return contactId;
}

describe("CODEX-002-T06 real HTTP account dedupe and link review", () => {
  beforeAll(async () => {
    const guard = new pg.Client({ connectionString: database.url });
    try { await guard.connect(); await assertRestrictedTestRole(guard, database.databaseName); databaseReady = true; }
    finally { await guard.end(); }
    for (const user of Object.values(users)) {
      const created = await prisma.user.create({ data: { email: user.email, passwordHash: await bcrypt.hash(password, 4), role: user.role } });
      user.id = created.id;
      createdUserIds.push(created.id);
    }
    server = spawn(process.env.PNPM_BIN ?? "pnpm", ["dev", "-p", "3112"], {
      cwd: process.cwd(),
      env: { ...process.env, APP_MODE: "test", APP_ORIGIN: baseUrl, DATABASE_URL: database.url, TEST_DATABASE_URL: database.url, TEST_DATABASE_NAME: database.databaseName, TEST_DATABASE_MODE: "isolated", TEST_RUN_ID: database.runId, AUTH_COOKIE_NAME: "test3_session" },
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    server.stdout?.on("data", (chunk: Buffer) => { serverOutput.push(chunk.toString()); });
    server.stderr?.on("data", (chunk: Buffer) => { serverOutput.push(chunk.toString()); });
    await waitForHealth();
    await Promise.all((Object.keys(users) as UserKey[]).map(login));
  }, 120_000);

  afterAll(async () => {
    if (!databaseReady) { await prisma.$disconnect(); return; }
    await stopTestServer(server);
    const fixtureAccounts = createdSourceIds.length ? await prisma.account.findMany({ where: { sourceId: { in: createdSourceIds } }, select: { id: true } }) : [];
    const allAccountIds = [...new Set([...createdAccountIds, ...fixtureAccounts.map((account) => account.id)])];
    if (allAccountIds.length) await prisma.accountLink.deleteMany({ where: { OR: [{ leftAccountId: { in: allAccountIds } }, { rightAccountId: { in: allAccountIds } }] } });
    if (allAccountIds.length) await prisma.account.deleteMany({ where: { id: { in: allAccountIds } } });
    if (createdSourceIds.length) await prisma.sourcePolicySnapshot.deleteMany({ where: { sourceId: { in: createdSourceIds } } });
    if (createdSourceIds.length) await prisma.source.deleteMany({ where: { id: { in: createdSourceIds } } });
    if (createdUserIds.length) await prisma.auditEvent.deleteMany({ where: { actorId: { in: createdUserIds } } });
    if (createdUserIds.length) await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  }, 30_000);

  it("同名不同身份不合并，精确重复保持幂等，共享联系只生成待核验候选", async () => {
    const sourceId = await createSource();
    const left = await createAccount(sourceId, "same-left");
    const right = await createAccount(sourceId, "same-right");
    const duplicate = await request("admin", "/api/accounts", { method: "POST", ...jsonBody({ platform: "X", nativeId: "t06-duplicate", displayName: "另一个名称", profileUrl: "https://example.com/demo/x/t06-same-left", organization: "T06 测试机构", serviceTags: ["财富规划"], region: "上海", sourceId, sourceUrl: "https://example.com/demo/source/duplicate" }) });
    expect(duplicate.response.status, JSON.stringify(duplicate.data)).toBe(409);
    expect(duplicate.data.error).toBe("DUPLICATE");
    expect((await request("viewer", `/api/accounts/${left}`)).data.item).toMatchObject({ id: left, displayName: "T06 同名账号" });
    expect((await request("viewer", `/api/accounts/${right}`)).data.item).toMatchObject({ id: right, displayName: "T06 同名账号" });

    const firstContact = await createReviewedContact(left, sourceId, "shared-t06@example.com");
    const secondContact = await createReviewedContact(right, sourceId, "shared-t06@example.com");
    const suggested = await request("reviewerA", "/api/account-links/suggest", { method: "POST", ...jsonBody({ contactId: firstContact }) });
    expect(suggested.response.status).toBe(201);
    expect(suggested.data.items).toHaveLength(1);
    expect(suggested.data.items![0]).toMatchObject({ status: "PENDING", basis: "SHARED_CONTACT_CANDIDATE", usable: false });
    expect(JSON.stringify(suggested.data)).not.toContain("shared-t06@example.com");
    expect(suggested.data.items![0]).not.toHaveProperty("basisContactId");
    expect(suggested.data.items![0]).not.toHaveProperty("matchingContactId");
    expect((await prisma.account.count({ where: { id: { in: [left, right] } } }))).toBe(2);
    const duplicateSuggestion = await request("reviewerB", "/api/account-links/suggest", { method: "POST", ...jsonBody({ contactId: secondContact }) });
    expect(duplicateSuggestion.response.status).toBe(201);
    expect(duplicateSuggestion.data.items).toHaveLength(0);
  }, 30_000);

  it("关联确认使用版本冲突，撤销不可静默恢复，来源撤销令已确认关联不可用", async () => {
    const sourceId = await createSource();
    const left = await createAccount(sourceId, "review-left");
    const right = await createAccount(sourceId, "review-right");
    const link = await request("reviewerA", "/api/account-links", { method: "POST", ...jsonBody({ leftAccountId: left, rightAccountId: right, sourceId, basis: "MANUAL" }) });
    expect(link.response.status, `${JSON.stringify(link.data)}\n${serverOutput.join("").slice(-4_000)}`).toBe(201);
    expect(link.data.item).toMatchObject({ status: "PENDING", usable: false, basis: "MANUAL", version: 1 });
    const linkId = link.data.item!.id as string;
    const confirmed = await request("reviewerB", `/api/account-links/${linkId}`, { method: "PATCH", ...jsonBody({ expectedVersion: 1, status: "CONFIRMED", reason: "人工核对两个账号的公开主体资料后确认", evidence: relationEvidence(sourceId, left, right) }) });
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.data.item).toMatchObject({ status: "CONFIRMED", usable: true, version: 2 });
    const stale = await request("reviewerA", `/api/account-links/${linkId}`, { method: "PATCH", ...jsonBody({ expectedVersion: 1, status: "REVOKED", reason: "过期审核页" }) });
    expect(stale.response.status).toBe(409);
    expect(stale.data.error).toBe("LINK_CONFLICT");
    const source = await request("admin", `/api/sources/${sourceId}`);
    const sourceRevoked = await request("admin", `/api/sources/${sourceId}`, { method: "PATCH", ...jsonBody({ expectedPolicyVersion: source.data.item!.policyVersion as number, status: "REVOKED", allowRelate: false }) });
    expect(sourceRevoked.response.status).toBe(200);
    const current = await request("reviewerA", `/api/account-links/${linkId}`);
    expect(current.response.status).toBe(200);
    expect(current.data.item).toMatchObject({ status: "CONFIRMED", usable: false, unusableReason: "SOURCE_REVOKED", version: 2 });
    const listed = await request("reviewerA", `/api/account-links?status=CONFIRMED`);
    expect(listed.data.items?.find((item) => item.id === linkId)).toMatchObject({ status: "CONFIRMED", usable: false, unusableReason: "SOURCE_REVOKED" });
    const revoked = await request("reviewerA", `/api/account-links/${linkId}`, { method: "PATCH", ...jsonBody({ expectedVersion: 2, status: "REVOKED", reason: "人工复核后撤销关联" }) });
    expect(revoked.response.status).toBe(200);
    expect(revoked.data.item).toMatchObject({ status: "REVOKED", usable: false, version: 3 });
    const cannotRestore = await request("reviewerB", `/api/account-links/${linkId}`, { method: "PATCH", ...jsonBody({ expectedVersion: 3, status: "CONFIRMED", reason: "不能静默恢复" }) });
    expect(cannotRestore.response.status).toBe(409);
    expect(cannotRestore.data.error).toBe("INVALID_TRANSITION");
  }, 30_000);

  it("确认必须有关系证据，旧策略候选和同版本并发确认均被保护", async () => {
    const sourceId = await createSource();
    const left = await createAccount(sourceId, "evidence-left");
    const right = await createAccount(sourceId, "evidence-right");
    const created = await request("reviewerA", "/api/account-links", { method: "POST", ...jsonBody({ leftAccountId: left, rightAccountId: right, sourceId, basis: "MANUAL" }) });
    expect(created.response.status).toBe(201);
    const linkId = created.data.item!.id as string;
    const withoutEvidence = await request("reviewerA", `/api/account-links/${linkId}`, { method: "PATCH", ...jsonBody({ expectedVersion: 1, status: "CONFIRMED", reason: "只有理由没有关系证据" }) });
    expect(withoutEvidence.response.status).toBe(422);
    expect(withoutEvidence.data.error).toBe("VALIDATION_ERROR");
    const changed = await request("admin", `/api/sources/${sourceId}`);
    const policyChanged = await request("admin", `/api/sources/${sourceId}`, { method: "PATCH", ...jsonBody({ expectedPolicyVersion: changed.data.item!.policyVersion as number, permissionNote: "T06 隔离测试授权依据 v2" }) });
    expect(policyChanged.response.status).toBe(200);
    const stale = await request("reviewerA", `/api/account-links/${linkId}`, { method: "PATCH", ...jsonBody({ expectedVersion: 1, status: "CONFIRMED", reason: "旧策略候选不能确认", evidence: relationEvidence(sourceId, left, right) }) });
    expect(stale.response.status).toBe(409);
    expect(stale.data.error).toBe("LINK_POLICY_STALE");
    const current = await request("reviewerA", `/api/account-links/${linkId}`);
    expect(current.data.item).toMatchObject({ status: "PENDING", version: 1 });
    const source2 = await createSource();
    const left2 = await createAccount(source2, "concurrent-left");
    const right2 = await createAccount(source2, "concurrent-right");
    const link2 = await request("reviewerA", "/api/account-links", { method: "POST", ...jsonBody({ leftAccountId: left2, rightAccountId: right2, sourceId: source2, basis: "MANUAL" }) });
    const link2Id = link2.data.item!.id as string;
    const responses = await Promise.all(["reviewerA", "reviewerB"].map((user) => request(user as UserKey, `/api/account-links/${link2Id}`, { method: "PATCH", ...jsonBody({ expectedVersion: 1, status: "CONFIRMED", reason: "并发人工核对", evidence: relationEvidence(source2, left2, right2) }) })));
    expect(responses.map((item) => item.response.status).sort()).toEqual([200, 409]);
    expect((await request("reviewerA", `/api/account-links/${link2Id}`)).data.item).toMatchObject({ status: "CONFIRMED", version: 2 });
  }, 30_000);

  it("关联请求体有界、坏 JSON 和大小写 UUID 不会落成数据库错误", async () => {
    const tooLarge = await request("reviewerA", "/api/account-links", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "20000" }, body: "{}" });
    expect(tooLarge.response.status).toBe(413);
    const badJson = await request("reviewerA", "/api/account-links", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
    expect(badJson.response.status).toBe(400);
    const unknownField = await request("reviewerA", "/api/account-links", { method: "POST", ...jsonBody({ contactId: "00000000-0000-4000-8000-000000000001" }) });
    expect(unknownField.response.status).toBe(422);
  }, 30_000);

  it("来源关联许可、VIEWER 权限和审核理由隔离有效", async () => {
    const sourceId = await createSource();
    const left = await createAccount(sourceId, "permissions-left");
    const right = await createAccount(sourceId, "permissions-right");
    const crossPlatform = await request("admin", "/api/accounts", { method: "POST", ...jsonBody({ platform: "YOUTUBE", nativeId: "t06-permissions-youtube", displayName: "T06 跨平台账号", profileUrl: "https://example.com/demo/youtube/t06-permissions-youtube", organization: "T06 测试机构", serviceTags: ["财富规划"], region: "上海", sourceId, sourceUrl: "https://example.com/demo/source/t06-permissions-youtube" }) });
    expect(crossPlatform.response.status).toBe(201);
    const crossPlatformId = crossPlatform.data.item!.id as string;
    createdAccountIds.push(crossPlatformId);
    const created = await request("reviewerA", "/api/account-links", { method: "POST", ...jsonBody({ leftAccountId: left, rightAccountId: right, sourceId, basis: "MANUAL" }) });
    expect(created.response.status, `${JSON.stringify(created.data)}\n${serverOutput.join("").slice(-4_000)}`).toBe(201);
    const linkId = created.data.item!.id as string;
    const viewerList = await request("viewer", "/api/account-links?status=PENDING");
    const viewerItem = viewerList.data.items?.find((item) => item.id === linkId);
    expect(viewerItem).toMatchObject({ status: "PENDING", reason: null });
    expect((await request("viewer", `/api/account-links/${linkId}`, { method: "PATCH", ...jsonBody({ expectedVersion: 1, status: "CONFIRMED", reason: "viewer" }) })).response.status).toBe(403);
    const source = await request("admin", `/api/sources/${sourceId}`);
    const closed = await request("admin", `/api/sources/${sourceId}`, { method: "PATCH", ...jsonBody({ expectedPolicyVersion: source.data.item!.policyVersion as number, allowRelate: false }) });
    expect(closed.response.status).toBe(200);
    const blocked = await request("reviewerB", "/api/account-links", { method: "POST", ...jsonBody({ leftAccountId: left, rightAccountId: right, sourceId, basis: "MANUAL" }) });
    expect(blocked.response.status).toBe(403);
    expect(blocked.data.error).toBe("SOURCE_RELATE_NOT_ALLOWED");
    const blockedCrossPlatform = await request("reviewerB", "/api/account-links", { method: "POST", ...jsonBody({ leftAccountId: left, rightAccountId: crossPlatformId, sourceId, basis: "MANUAL" }) });
    expect(blockedCrossPlatform.response.status).toBe(403);
    expect(blockedCrossPlatform.data.error).toBe("SOURCE_RELATE_NOT_ALLOWED");
  }, 30_000);
});
