import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseTestDatabaseConfig, assertRestrictedTestRole } from "../helpers/test-database";
import pg from "pg";

const database = parseTestDatabaseConfig();
const baseUrl = process.env.TEST_APP_ORIGIN ?? "http://127.0.0.1:3100";
const password = "R1-integration-password";
const runId = database.runId;
const fixture = readFileSync(path.join(process.cwd(), "tests/fixtures/accounts-90.csv"));
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url }) });
const createdSourceIds: string[] = [];
const createdBatchIds: string[] = [];
let server: ChildProcess | undefined;
const serverOutput: string[] = [];
let userId = "";
let cookie = "";
let adminEmail = "";
let identityANative = "";
let identityBProfileUrl = "";
let databaseReady = false;

type ApiItem = { id: string; status?: string; rows?: unknown[]; [key: string]: unknown };
type ApiError = { rowNumber: number; errorCode?: string; errorMessage?: string };
type ApiData = { item: ApiItem; items: ApiItem[]; errors: ApiError[]; total: number; page: number; error: string; message: string; [key: string]: unknown };
type HttpResult = { response: Response; data: ApiData };

async function request(pathname: string, init: RequestInit = {}, authenticated = true): Promise<HttpResult> {
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", baseUrl);
  if (authenticated && cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie?.includes("test3_session=")) cookie = setCookie.split(";")[0] ?? cookie;
  const text = await response.text();
  let data: ApiData = {} as ApiData;
  if (text) {
    try { data = JSON.parse(text) as ApiData; } catch { data = { raw: text } as unknown as ApiData; }
  }
  return { response, data };
}

function jsonBody(value: unknown) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

function csvForm(sourceId: string, bytes: Uint8Array | Buffer = fixture) {
  const form = new FormData();
  form.set("sourceId", sourceId);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  form.set("file", new File([copy.buffer], "accounts-90.csv", { type: "text/csv" }));
  return form;
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `health ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`集成测试服务器未就绪：${lastError}`);
}

async function createSource(name: string, approve = true) {
  const result = await request("/api/sources", { method: "POST", ...jsonBody({ name, type: "DEMO", permissionNote: "R1 隔离测试专用的虚构来源。" }) });
  expect(result.response.status).toBe(201);
  const id = result.data.item.id as string;
  createdSourceIds.push(id);
  if (approve) {
    const approved = await request(`/api/sources/${id}`, { method: "PATCH", ...jsonBody({ status: "APPROVED", allowImport: true }) });
    expect(approved.response.status).toBe(200);
  }
  return id;
}

function accountBody(sourceId: string, suffix: string, nativeId = `r1-${suffix}`) {
  return { platform: "X", nativeId, displayName: `R1 ${suffix}`, profileUrl: `https://example.com/demo/x/${suffix}`, organization: "R1 测试机构", serviceTags: ["财富规划"], region: "上海", sourceId, sourceUrl: `https://example.com/demo/source/${suffix}` };
}

describe("CODEX-001-R1 real HTTP account/import contract", () => {
  let primarySourceId = "";
  let accountSourceId = "";
  let firstBatchId = "";
  let contactSourceId = "";
  let contactAccountId = "";
  let contactIds: string[] = [];
  const contactText = "商务邮箱：review@example.com\n商务微信：demo_review\n企业电话：+1 202 555 0100\n官网联系页：https://example.com/contact\n商务预约：https://example.com/book";
  const extractInput = (text = contactText) => ({ accountId: contactAccountId, sourceId: contactSourceId, sourceUrl: "https://example.com/demo/evidence/contacts", capturedAt: new Date(Date.now() - 60000).toISOString(), fieldLocation: "账号简介商务栏", context: "ACCOUNT_PROFILE", text });
  const reviewInput = (version = 1, status = "APPROVED") => ({ version, status, ownershipConfirmed: true, businessConfirmed: true, reason: "已核对字段证据，主体和商务用途一致" });

  beforeAll(async () => {
    const guard = new pg.Client({ connectionString: database.url });
    try { await guard.connect(); await assertRestrictedTestRole(guard, database.databaseName); databaseReady = true; }
    finally { await guard.end(); }
    adminEmail = `r1-${runId}-${randomUUID()}@example.test`;
    const user = await prisma.user.create({ data: { email: adminEmail, passwordHash: await bcrypt.hash(password, 4), role: "ADMIN" } });
    userId = user.id;
    server = spawn(process.env.PNPM_BIN ?? "pnpm", ["dev", "-p", "3100"], {
      cwd: process.cwd(),
      env: { ...process.env, APP_MODE: "test", APP_ORIGIN: baseUrl, DATABASE_URL: database.url, TEST_DATABASE_URL: database.url, TEST_DATABASE_NAME: database.databaseName, TEST_DATABASE_MODE: "isolated", TEST_RUN_ID: runId, AUTH_COOKIE_NAME: "test3_session" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk: Buffer) => { serverOutput.push(chunk.toString()); });
    server.stderr?.on("data", (chunk: Buffer) => { serverOutput.push(chunk.toString()); });
    await waitForHealth();
    const login = await request("/api/auth/login", { method: "POST", ...jsonBody({ email: adminEmail, password }) }, false);
    expect(login.response.status, serverOutput.join("").slice(-8_000)).toBe(200);
    expect(cookie).toContain("test3_session=");
  }, 120_000);

  afterAll(async () => {
    if (!databaseReady) { await prisma.$disconnect(); return; }
    if (server && server.exitCode === null) server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (createdBatchIds.length) await prisma.importBatch.deleteMany({ where: { id: { in: createdBatchIds } } });
    if (createdSourceIds.length) await prisma.account.deleteMany({ where: { sourceId: { in: createdSourceIds } } });
    if (userId) await prisma.auditEvent.deleteMany({ where: { actorId: userId } });
    if (createdSourceIds.length) await prisma.source.deleteMany({ where: { id: { in: createdSourceIds } } });
    const throttleKey = createHash("sha256").update(adminEmail.toLowerCase()).digest("hex");
    if (userId) {
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.loginThrottle.deleteMany({ where: { keyHash: { in: [throttleKey, createHash("sha256").update("missing@example.test").digest("hex")] } } });
    await prisma.$disconnect();
  }, 30_000);

  it("T01 未认证用户访问业务 API 得到 401", async () => {
    const oldCookie = cookie;
    cookie = "";
    const result = await request("/api/accounts", {}, false);
    cookie = oldCookie;
    expect(result.response.status).toBe(401);
  });

  it("T02 登录、错误凭据、退出登录和旧会话失效", async () => {
    cookie = "";
    const bad = await request("/api/auth/login", { method: "POST", ...jsonBody({ email: "missing@example.test", password: "wrong" }) }, false);
    expect(bad.response.status).toBe(401);
    const login = await request("/api/auth/login", { method: "POST", ...jsonBody({ email: adminEmail, password }) }, false);
    expect(login.response.status).toBe(200);
    const sessionCookie = cookie;
    const logout = await request("/api/auth/logout", { method: "POST" });
    expect(logout.response.status).toBe(200);
    cookie = sessionCookie;
    const denied = await request("/api/accounts");
    expect(denied.response.status).toBe(401);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const restored = await request("/api/auth/login", { method: "POST", ...jsonBody({ email: user.email, password }) }, false);
    expect(restored.response.status).toBe(200);
  });

  it("T03 DRAFT、撤销和过期来源均在服务端阻止写入", async () => {
    const draft = await createSource(`R1 draft ${randomUUID()}`, false);
    const draftState = await request(`/api/sources/${draft}`);
    expect(draftState.data.item.status).toBe("DRAFT");
    const draftBlocked = await request("/api/accounts", { method: "POST", ...jsonBody(accountBody(draft, `draft-blocked-${randomUUID()}`)) });
    expect(draftBlocked.response.status).toBe(403);
    const approved = await request(`/api/sources/${draft}`, { method: "PATCH", ...jsonBody({ status: "APPROVED", allowImport: true }) });
    expect(approved.response.status).toBe(200);
    const revoked = await request(`/api/sources/${draft}`, { method: "PATCH", ...jsonBody({ status: "REVOKED", allowImport: false }) });
    expect(revoked.response.status).toBe(200);
    const blocked = await request("/api/accounts", { method: "POST", ...jsonBody(accountBody(draft, `blocked-${randomUUID()}`)) });
    expect(blocked.response.status).toBe(403);
    const expiring = await createSource(`R1 expiring ${randomUUID()}`);
    const expires = await request(`/api/sources/${expiring}`, { method: "PATCH", ...jsonBody({ expiresAt: new Date(Date.now() - 60_000).toISOString() }) });
    expect(expires.response.status).toBe(200);
    const expired = await request("/api/accounts", { method: "POST", ...jsonBody(accountBody(expiring, `expired-${randomUUID()}`)) });
    expect(expired.response.status).toBe(403);
  });

  it("T04 创建同名不同主页账号不会错误合并", async () => {
    accountSourceId = await createSource(`R1 account API ${randomUUID()}`);
    const first = accountBody(accountSourceId, `same-a-${randomUUID()}`, `same-native-a-${randomUUID()}`);
    const second = { ...first, nativeId: `same-native-b-${randomUUID()}`, profileUrl: `https://example.com/demo/x/same-b-${randomUUID()}` };
    first.displayName = "相同名称"; second.displayName = "相同名称";
    const one = await request("/api/accounts", { method: "POST", ...jsonBody(first) });
    const two = await request("/api/accounts", { method: "POST", ...jsonBody(second) });
    expect(one.response.status).toBe(201); expect(two.response.status).toBe(201); expect(one.data.item.id).not.toBe(two.data.item.id);
  });

  it("T05 单条重复返回 existingAccountId", async () => {
    const body = accountBody(accountSourceId, `single-duplicate-${randomUUID()}`);
    const first = await request("/api/accounts", { method: "POST", ...jsonBody(body) });
    expect(first.response.status).toBe(201);
    const duplicate = await request("/api/accounts", { method: "POST", ...jsonBody(body) });
    expect(duplicate.response.status).toBe(409); expect(duplicate.data.existingAccountId).toBe(first.data.item.id);
  });

  it("T06 平台身份 ID 与主页分别命中不同账号时返回 409", async () => {
    const a = accountBody(accountSourceId, `identity-a-${randomUUID()}`, `identity-a-${randomUUID()}`);
    const b = accountBody(accountSourceId, `identity-b-${randomUUID()}`, `identity-b-${randomUUID()}`);
    const first = await request("/api/accounts", { method: "POST", ...jsonBody(a) });
    const second = await request("/api/accounts", { method: "POST", ...jsonBody(b) });
    expect(first.response.status).toBe(201); expect(second.response.status).toBe(201);
    identityANative = a.nativeId!; identityBProfileUrl = b.profileUrl;
    const conflict = await request("/api/accounts", { method: "POST", ...jsonBody({ ...a, profileUrl: b.profileUrl }) });
    expect(conflict.response.status).toBe(409); expect(conflict.data.error).toBe("IDENTITY_CONFLICT");
  });

  it("T07 首次 90 行导入得到 60 新增、20 重复、10 失败", async () => {
    primarySourceId = await createSource(`R1 import ${randomUUID()}`);
    const result = await request("/api/imports", { method: "POST", headers: { "Idempotency-Key": `r1-first-${randomUUID()}` }, body: csvForm(primarySourceId) });
    expect(result.response.status).toBe(201); expect(result.data.item).toMatchObject({ totalRows: 90, createdCount: 60, duplicateCount: 20, invalidCount: 10, replayed: false });
    firstBatchId = result.data.item.id; createdBatchIds.push(firstBatchId);
    const detail = await request(`/api/imports/${firstBatchId}`);
    expect(detail.response.status).toBe(200); expect(detail.data.item.rows).toHaveLength(90);
  });

  it("T08 相同幂等键和相同内容只重放同一批次", async () => {
    const key = `r1-replay-${randomUUID()}`;
    const first = await request("/api/imports", { method: "POST", headers: { "Idempotency-Key": key }, body: csvForm(primarySourceId) });
    expect(first.response.status).toBe(201); createdBatchIds.push(first.data.item.id);
    const replay = await request("/api/imports", { method: "POST", headers: { "Idempotency-Key": key }, body: csvForm(primarySourceId) });
    expect(replay.response.status).toBe(200); expect(replay.data.item).toMatchObject({ id: first.data.item.id, replayed: true, createdCount: 0, duplicateCount: 80, invalidCount: 10 });
  });

  it("T09 相同幂等键的不同文件或来源返回 409", async () => {
    const key = `r1-mismatch-${randomUUID()}`;
    const first = await request("/api/imports", { method: "POST", headers: { "Idempotency-Key": key }, body: csvForm(primarySourceId) });
    expect(first.response.status).toBe(201); createdBatchIds.push(first.data.item.id);
    const altered = Buffer.from(fixture.toString().replace("虚构小红书账号 001", "改动小红书账号 001"));
    const mismatch = await request("/api/imports", { method: "POST", headers: { "Idempotency-Key": key }, body: csvForm(primarySourceId, altered) });
    expect(mismatch.response.status).toBe(409); expect(mismatch.data.error).toBe("IDEMPOTENCY_MISMATCH");
    const secondSource = await createSource(`R1 mismatch source ${randomUUID()}`);
    const sourceMismatch = await request("/api/imports", { method: "POST", headers: { "Idempotency-Key": key }, body: csvForm(secondSource) });
    expect(sourceMismatch.response.status).toBe(409);
  });

  it("T10 新幂等键重复提交得到 0 新增、80 重复、10 失败", async () => {
    const result = await request("/api/imports", { method: "POST", headers: { "Idempotency-Key": `r1-new-${randomUUID()}` }, body: csvForm(primarySourceId) });
    expect(result.response.status).toBe(201); expect(result.data.item).toMatchObject({ totalRows: 90, createdCount: 0, duplicateCount: 80, invalidCount: 10 });
    createdBatchIds.push(result.data.item.id);
  });

  it("T11 两个不同幂等键并发导入不会制造重复账号", async () => {
    const [left, right] = await Promise.all([
      request("/api/imports", { method: "POST", headers: { "Idempotency-Key": `r1-concurrent-a-${randomUUID()}` }, body: csvForm(primarySourceId) }),
      request("/api/imports", { method: "POST", headers: { "Idempotency-Key": `r1-concurrent-b-${randomUUID()}` }, body: csvForm(primarySourceId) }),
    ]);
    expect(left.response.status).toBe(201); expect(right.response.status).toBe(201);
    expect(left.data.item).toMatchObject({ createdCount: 0, duplicateCount: 80, invalidCount: 10 }); expect(right.data.item).toMatchObject({ createdCount: 0, duplicateCount: 80, invalidCount: 10 });
    createdBatchIds.push(left.data.item.id, right.data.item.id);
    expect(await prisma.account.count({ where: { sourceId: primarySourceId } })).toBe(60);
  });

  it("T12 账号列表支持平台筛选和分页", async () => {
    const filtered = await request(`/api/accounts?platform=X&sourceId=${primarySourceId}&page=1&pageSize=10`);
    expect(filtered.response.status).toBe(200); expect(filtered.data.total).toBe(15); expect(filtered.data.items).toHaveLength(10); expect(filtered.data.page).toBe(1);
    const next = await request(`/api/accounts?platform=X&sourceId=${primarySourceId}&page=2&pageSize=10`);
    expect(next.response.status).toBe(200); expect(next.data.items).toHaveLength(5);
  });

  it("T13 CSV 行列数、BOM/引号、大小、来源和联系方式列错误均明确返回", async () => {
    const malformedColumns = "platform,nativeId,displayName,profileUrl,organization,serviceTags,region,sourceUrl\nYOUTUBE,a,b,https://example.com/demo/youtube/a,c,d,e\nYOUTUBE,a,b,https://example.com/demo/youtube/b,c,d,e,f,g\n";
    const columns = await request("/api/imports/preview", { method: "POST", body: csvForm(primarySourceId, Buffer.from(`\uFEFF${malformedColumns}`)) });
    expect(columns.response.status).toBe(200); expect(columns.data.errors.map((row) => row.errorCode)).toEqual(["CSV_COLUMN_COUNT", "CSV_COLUMN_COUNT"]); expect(columns.data.errors.map((row) => row.rowNumber)).toEqual([2, 3]);
    const malformed = await request("/api/imports/preview", { method: "POST", body: csvForm(primarySourceId, Buffer.from("platform,nativeId,displayName,profileUrl,organization,serviceTags,region,sourceUrl\nYOUTUBE,a,\"unterminated")) });
    expect(malformed.response.status).toBe(422); expect(malformed.data.error).toBe("CSV_FORMAT");
    const oversized = await request("/api/imports/preview", { method: "POST", body: csvForm(primarySourceId, new Uint8Array(2 * 1024 * 1024 + 1)) });
    expect(oversized.response.status).toBe(413); expect(oversized.data.error).toBe("FILE_TOO_LARGE");
    const badSource = await request("/api/imports/preview", { method: "POST", body: csvForm("not-a-uuid") });
    expect(badSource.response.status).toBe(422); expect(badSource.data.error).toBe("FILE_REQUIRED");
    const contacts = await request("/api/imports/preview", { method: "POST", body: csvForm(primarySourceId, Buffer.from("platform,nativeId,displayName,profileUrl,organization,serviceTags,region,sourceUrl,email\n")) });
    expect(contacts.response.status).toBe(422); expect(contacts.data.error).toBe("CSV_COLUMNS");
    const conflictRows = Array.from({ length: 25 }, (_, index) => `X,${identityANative},冲突 ${index},${identityBProfileUrl},机构,财富规划,上海,https://example.com/demo/source/conflict-${index}`).join("\n");
    const allConflicts = await request("/api/imports/preview", { method: "POST", body: csvForm(primarySourceId, Buffer.from(`platform,nativeId,displayName,profileUrl,organization,serviceTags,region,sourceUrl\n${conflictRows}\n`)) });
    expect(allConflicts.response.status).toBe(200); expect(allConflicts.data.errors.filter((row) => row.errorCode === "IDENTITY_CONFLICT")).toHaveLength(25);
  });

  it("T14 测试注入的数据库异常会回滚整批且不泄漏内部错误", async () => {
    const before = await prisma.account.count({ where: { sourceId: primarySourceId } });
    const oneRow = Buffer.from("platform,nativeId,displayName,profileUrl,organization,serviceTags,region,sourceUrl\nX,rollback-unique,回滚测试,https://example.com/demo/x/rollback-unique,机构,财富规划,上海,https://example.com/demo/source/rollback\n");
    const key = `r1-rollback-${randomUUID()}`;
    const failed = await request("/api/imports", { method: "POST", headers: { "Idempotency-Key": key, "x-test-fail-after-row": "2" }, body: csvForm(primarySourceId, oneRow) });
    expect(failed.response.status).toBe(500); expect(failed.data.error).toBe("DATABASE_ERROR"); expect(failed.data.message).not.toContain("TEST_INJECTED");
    expect(await prisma.account.count({ where: { sourceId: primarySourceId } })).toBe(before);
    expect(await prisma.importBatch.count({ where: { createdById: userId, idempotencyKey: key } })).toBe(0);
  });

  it("C01 仅批准账号录入不能提取；拒绝前不持久化证据", async () => {
    contactSourceId = await createSource(`C01 ${randomUUID()}`);
    const account = await request("/api/accounts", { method: "POST", ...jsonBody(accountBody(contactSourceId, `contact-${randomUUID()}`)) });
    expect(account.response.status).toBe(201); contactAccountId = account.data.item.id;
    const rejected = await request("/api/contacts/extract", { method: "POST", ...jsonBody(extractInput()) });
    expect(rejected.response.status).toBe(403);
    expect(await prisma.evidence.count({ where: { accountId: contactAccountId } })).toBe(0);
    const badPolicy = await request(`/api/sources/${contactSourceId}`, { method: "PATCH", ...jsonBody({ allowExtract: true }) });
    expect(badPolicy.response.status).toBe(422);
    const policy = await request(`/api/sources/${contactSourceId}`, { method: "PATCH", ...jsonBody({ allowExtract: true, allowEvidenceText: true, retentionDays: 30 }) });
    expect(policy.response.status).toBe(200);
  });

  it("C02 五类候选真实落库且各有独立证据、默认待审核", async () => {
    const result = await request("/api/contacts/extract", { method: "POST", ...jsonBody(extractInput()) });
    expect(result.response.status).toBe(200); expect(result.data.createdCount).toBe(5);
    contactIds = result.data.ids as string[];
    const stored = await prisma.contactPoint.findMany({ where: { id: { in: contactIds } }, include: { evidence: true } });
    expect(stored).toHaveLength(5);
    expect(stored.every(c => c.status === "PENDING" && !c.ownershipConfirmed && !c.businessConfirmed)).toBe(true);
    expect(new Set(stored.map(c => c.evidenceId)).size).toBe(5);
    for (const item of stored) { expect(item.evidence.excerpt).toContain(item.rawValue); expect(item.evidence.excerpt).not.toContain("\n"); }
  });

  it("C03 并发及重复提取不重复写入，不覆盖已审核状态", async () => {
    const results = await Promise.all([1, 2].map(() => request("/api/contacts/extract", { method: "POST", ...jsonBody(extractInput()) })));
    for (const result of results) { expect(result.response.status).toBe(200); expect(result.data.createdCount).toBe(0); expect(result.data.duplicateCount).toBe(5); }
    expect(await prisma.evidence.count({ where: { accountId: contactAccountId } })).toBe(5);
  });

  it("C04 拒绝无确认/空原因，审核员可以核验但不能管理来源", async () => {
    await prisma.user.update({ where: { id: userId }, data: { role: "REVIEWER" } });
    try {
      expect((await request(`/api/sources/${contactSourceId}`, { method: "PATCH", ...jsonBody({ allowExtract: false }) })).response.status).toBe(403);
      expect((await request(`/api/contacts/${contactIds[0]}`, { method: "PATCH", ...jsonBody({ ...reviewInput(), ownershipConfirmed: false }) })).response.status).toBe(422);
      expect((await request(`/api/contacts/${contactIds[0]}`, { method: "PATCH", ...jsonBody({ ...reviewInput(), reason: " " }) })).response.status).toBe(422);
      expect(await prisma.reviewDecision.count({ where: { contactId: contactIds[0] } })).toBe(0);
      const approved = await request(`/api/contacts/${contactIds[0]}`, { method: "PATCH", ...jsonBody(reviewInput()) });
      expect(approved.response.status).toBe(200);
      const detail = await request(`/api/contacts/${contactIds[0]}`);
      expect(detail.data.item).toMatchObject({ status: "APPROVED", usable: true, value: "review@example.com", version: 2 });
      expect(await prisma.reviewDecision.count({ where: { contactId: contactIds[0], reviewerId: userId } })).toBe(1);
    } finally { await prisma.user.update({ where: { id: userId }, data: { role: "ADMIN" } }); }
  });

  it("C05 只读 API 无原值/证据泄漏且所有写入均 403", async () => {
    await prisma.user.update({ where: { id: userId }, data: { role: "VIEWER" } });
    try {
      const paths = [`/api/contacts/${contactIds[0]}`, `/api/contacts?accountId=${contactAccountId}`, `/api/accounts/${contactAccountId}`];
      for (const pathname of paths) {
        const result = await request(pathname);
        expect(result.response.status).toBe(200);
        expect(JSON.stringify(result.data)).not.toContain("review@example.com");
        expect(JSON.stringify(result.data)).not.toContain("账号简介商务栏");
      }
      const detail = await request(`/api/contacts/${contactIds[0]}`);
      expect(detail.data.item).toMatchObject({ value: "***", evidence: null, masked: true });
      for (const [pathname, method, body] of [
        ["/api/contacts/extract", "POST", extractInput()], [`/api/contacts/${contactIds[0]}`, "PATCH", reviewInput(2, "INVALID")],
        ["/api/accounts", "POST", accountBody(contactSourceId, "viewer")], [`/api/accounts/${contactAccountId}`, "PATCH", { displayName: "changed" }],
        ["/api/sources", "POST", { name: "viewer", type: "DEMO" }], [`/api/sources/${contactSourceId}`, "PATCH", { status: "REVOKED" }],
      ] as const) expect((await request(pathname, { method, ...jsonBody(body) })).response.status).toBe(403);
      for (const pathname of ["/api/imports", "/api/imports/preview"]) expect((await request(pathname, { method: "POST", body: csvForm(contactSourceId) })).response.status).toBe(403);
    } finally { await prisma.user.update({ where: { id: userId }, data: { role: "ADMIN" } }); }
  });

  it("C06 并发审核只能提交一个版本，冲突返回 409", async () => {
    const results = await Promise.all(["APPROVED", "REJECTED"].map(status => request(`/api/contacts/${contactIds[1]}`, { method: "PATCH", ...jsonBody(reviewInput(1, status)) })));
    expect(results.map(r => r.response.status).sort()).toEqual([200, 409]);
    expect(await prisma.reviewDecision.count({ where: { contactId: contactIds[1] } })).toBe(1);
  });

  it("C07 驳回/失效留存历史，不能直接重新批准，重复提取不复活", async () => {
    expect((await request(`/api/contacts/${contactIds[2]}`, { method: "PATCH", ...jsonBody(reviewInput(1, "REJECTED")) })).response.status).toBe(200);
    expect((await request(`/api/contacts/${contactIds[2]}`, { method: "PATCH", ...jsonBody(reviewInput(2)) })).response.status).toBe(409);
    expect((await request(`/api/contacts/${contactIds[0]}`, { method: "PATCH", ...jsonBody(reviewInput(2, "INVALID")) })).response.status).toBe(200);
    expect((await request(`/api/contacts/${contactIds[0]}`)).data.item.usable).toBe(false);
    await request("/api/contacts/extract", { method: "POST", ...jsonBody(extractInput()) });
    expect((await prisma.contactPoint.findUniqueOrThrow({ where: { id: contactIds[2] } })).status).toBe("REJECTED");
    expect(await prisma.reviewDecision.count({ where: { contactId: contactIds[0] } })).toBe(2);
  });

  it("C08 缺失、评论、广告、第三方文本返回零候选且不持久化原文", async () => {
    for (const context of ["COMMENT", "ADVERTISEMENT", "THIRD_PARTY"]) {
      const result = await request("/api/contacts/extract", { method: "POST", ...jsonBody({ ...extractInput(), context }) });
      expect(result.response.status).toBe(200); expect(result.data.ids).toEqual([]);
    }
    const empty = await request("/api/contacts/extract", { method: "POST", ...jsonBody(extractInput("提供财富规划，没有提供联系方式")) });
    expect(empty.data.createdCount).toBe(0);
    expect(await prisma.evidence.count({ where: { accountId: contactAccountId } })).toBe(5);
  });

  it("C09 请求体/时间/地址/真实联系值/来源不匹配均被拒绝", async () => {
    const malformed = await request("/api/contacts/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(malformed.response.status).toBe(400);
    const large = await request("/api/contacts/extract", { method: "POST", ...jsonBody({ ...extractInput(), text: "a".repeat(33000) }) });
    expect(large.response.status).toBe(413);
    for (const patch of [{ sourceUrl: "https://[::1]/proof" }, { capturedAt: new Date(Date.now() + 86400000).toISOString() }, { capturedAt: new Date(0).toISOString() }, { text: "商务邮箱：nobody@invalid.invalid" }]) {
      expect((await request("/api/contacts/extract", { method: "POST", ...jsonBody({ ...extractInput(), ...patch }) })).response.status).toBe(422);
    }
    expect((await request("/api/contacts/extract", { method: "POST", ...jsonBody({ ...extractInput(), accountId: randomUUID() }) })).response.status).toBe(404);
    const different = await createSource(`different ${randomUUID()}`);
    await request(`/api/sources/${different}`, { method: "PATCH", ...jsonBody({ allowExtract: true, allowEvidenceText: true }) });
    expect((await request("/api/contacts/extract", { method: "POST", ...jsonBody({ ...extractInput(), sourceId: different }) })).response.status).toBe(403);
    expect(await prisma.evidence.count({ where: { accountId: contactAccountId } })).toBe(5);
  });

  it("C10 数据库拒绝无证据及无确认的已批准记录", async () => {
    await expect(prisma.contactPoint.update({ where: { id: contactIds[3] }, data: { status: "APPROVED" } })).rejects.toThrow();
    await expect(prisma.contactPoint.create({ data: { evidenceId: randomUUID(), dedupeKey: randomUUID(), type: "EMAIL", rawValue: "invalid@example.com", normalizedValue: "invalid@example.com", expiresAt: new Date(Date.now() + 1000) } })).rejects.toThrow();
    expect((await prisma.contactPoint.findUniqueOrThrow({ where: { id: contactIds[3] } })).status).toBe("PENDING");
  });

  it("C11 联系过期后不可批准；审计中没有原值、正文或原因", async () => {
    await prisma.contactPoint.update({ where: { id: contactIds[4] }, data: { expiresAt: new Date(0) } });
    expect((await request(`/api/contacts/${contactIds[4]}`, { method: "PATCH", ...jsonBody(reviewInput()) })).response.status).toBe(422);
    expect((await request(`/api/contacts/${contactIds[4]}`)).data.item).toMatchObject({ masked: true, usable: false });
    const audit = JSON.stringify(await prisma.auditEvent.findMany({ where: { actorId: userId } }));
    expect(audit).not.toContain("review@example.com"); expect(audit).not.toContain("已核对字段证据"); expect(audit).not.toContain("商务邮箱");
  });

  it("C12 来源变更即时使旧批准失效，新版本必须重新取证", async () => {
    expect((await request(`/api/contacts/${contactIds[3]}`, { method: "PATCH", ...jsonBody(reviewInput()) })).response.status).toBe(200);
    expect((await request(`/api/contacts/${contactIds[3]}`)).data.item.usable).toBe(true);
    expect((await request(`/api/sources/${contactSourceId}`, { method: "PATCH", ...jsonBody({ permissionNote: "更新的虚构处理依据" }) })).response.status).toBe(200);
    expect((await request(`/api/contacts/${contactIds[3]}`)).data.item).toMatchObject({ usable: false, masked: true });
    const newEvidence = await request("/api/contacts/extract", { method: "POST", ...jsonBody(extractInput("商务邮箱：fresh@example.com")) });
    expect(newEvidence.response.status).toBe(200); expect(newEvidence.data.createdCount).toBe(1);
    contactIds.push((newEvidence.data.ids as string[])[0]);
  });

  it("C13 来源撤销与审核串行化，撤销后新请求一律拒绝", async () => {
    const id = contactIds[5];
    const [review, revoke] = await Promise.all([
      request(`/api/contacts/${id}`, { method: "PATCH", ...jsonBody(reviewInput()) }),
      request(`/api/sources/${contactSourceId}`, { method: "PATCH", ...jsonBody({ status: "REVOKED" }) }),
    ]);
    expect([200, 403]).toContain(review.response.status); expect(revoke.response.status).toBe(200);
    expect((await request(`/api/contacts/${id}`)).data.item).toMatchObject({ usable: false, masked: true });
    expect((await request("/api/contacts/extract", { method: "POST", ...jsonBody(extractInput()) })).response.status).toBe(403);
    const item = await prisma.contactPoint.findUniqueOrThrow({ where: { id } });
    expect((await request(`/api/contacts/${id}`, { method: "PATCH", ...jsonBody(reviewInput(item.version)) })).response.status).toBe(403);
    await request(`/api/sources/${contactSourceId}`, { method: "PATCH", ...jsonBody({ status: "APPROVED", allowImport: true, allowExtract: true, allowEvidenceText: true, expiresAt: new Date(0).toISOString() }) });
    expect((await request("/api/contacts/extract", { method: "POST", ...jsonBody(extractInput()) })).response.status).toBe(403);
  });

  it("C14 未登录/伪造 Origin/未知联系 ID 明确拒绝", async () => {
    expect((await request("/api/contacts", {}, false)).response.status).toBe(401);
    expect((await request(`/api/contacts/${contactIds[0]}`, {}, false)).response.status).toBe(401);
    expect((await request("/api/contacts/extract", { method: "POST", ...jsonBody(extractInput()) }, false)).response.status).toBe(401);
    expect((await request(`/api/contacts/${randomUUID()}`)).response.status).toBe(404);
    const body = jsonBody(reviewInput());
    expect((await request(`/api/contacts/${contactIds[0]}`, { method: "PATCH", ...body, headers: { ...body.headers, Origin: "https://attacker.invalid", "x-forwarded-host": "127.0.0.1:3100" } })).response.status).toBe(403);
  });

  it("T15 过期会话不能继续访问业务 API", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const fresh = await request("/api/auth/login", { method: "POST", ...jsonBody({ email: user.email, password }) }, false);
    expect(fresh.response.status).toBe(200);
    await prisma.session.updateMany({ where: { userId }, data: { expiresAt: new Date(0) } });
    const expired = await request("/api/accounts");
    expect(expired.response.status).toBe(401);
  });
});
