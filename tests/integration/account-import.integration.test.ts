import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseTestDatabaseConfig } from "../helpers/test-database";

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
  let firstBatchId = "";

  beforeAll(async () => {
    adminEmail = `r1-${runId}-${randomUUID()}@example.test`;
    const user = await prisma.user.create({ data: { email: adminEmail, passwordHash: await bcrypt.hash(password, 4) } });
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
    if (server && server.exitCode === null) server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (createdBatchIds.length) await prisma.importBatch.deleteMany({ where: { id: { in: createdBatchIds } } });
    if (createdSourceIds.length) await prisma.account.deleteMany({ where: { sourceId: { in: createdSourceIds } } });
    if (createdSourceIds.length) await prisma.source.deleteMany({ where: { id: { in: createdSourceIds } } });
    const throttleKey = createHash("sha256").update(adminEmail.toLowerCase()).digest("hex");
    if (userId) {
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.loginThrottle.deleteMany({ where: { keyHash: throttleKey } });
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
    primarySourceId = await createSource(`R1 primary ${randomUUID()}`);
    const first = accountBody(primarySourceId, `same-a-${randomUUID()}`, `same-native-a-${randomUUID()}`);
    const second = { ...first, nativeId: `same-native-b-${randomUUID()}`, profileUrl: `https://example.com/demo/x/same-b-${randomUUID()}` };
    first.displayName = "相同名称"; second.displayName = "相同名称";
    const one = await request("/api/accounts", { method: "POST", ...jsonBody(first) });
    const two = await request("/api/accounts", { method: "POST", ...jsonBody(second) });
    expect(one.response.status).toBe(201); expect(two.response.status).toBe(201); expect(one.data.item.id).not.toBe(two.data.item.id);
  });

  it("T05 单条重复返回 existingAccountId", async () => {
    const body = accountBody(primarySourceId, `single-duplicate-${randomUUID()}`);
    const first = await request("/api/accounts", { method: "POST", ...jsonBody(body) });
    expect(first.response.status).toBe(201);
    const duplicate = await request("/api/accounts", { method: "POST", ...jsonBody(body) });
    expect(duplicate.response.status).toBe(409); expect(duplicate.data.existingAccountId).toBe(first.data.item.id);
  });

  it("T06 平台身份 ID 与主页分别命中不同账号时返回 409", async () => {
    const a = accountBody(primarySourceId, `identity-a-${randomUUID()}`, `identity-a-${randomUUID()}`);
    const b = accountBody(primarySourceId, `identity-b-${randomUUID()}`, `identity-b-${randomUUID()}`);
    const first = await request("/api/accounts", { method: "POST", ...jsonBody(a) });
    const second = await request("/api/accounts", { method: "POST", ...jsonBody(b) });
    expect(first.response.status).toBe(201); expect(second.response.status).toBe(201);
    identityANative = a.nativeId!; identityBProfileUrl = b.profileUrl;
    const conflict = await request("/api/accounts", { method: "POST", ...jsonBody({ ...a, profileUrl: b.profileUrl }) });
    expect(conflict.response.status).toBe(409); expect(conflict.data.error).toBe("IDENTITY_CONFLICT");
  });

  it("T07 首次 90 行导入得到 60 新增、20 重复、10 失败", async () => {
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
    expect(await prisma.account.count({ where: { sourceId: primarySourceId } })).toBe(65);
  });

  it("T12 账号列表支持平台筛选和分页", async () => {
    const filtered = await request("/api/accounts?platform=X&page=1&pageSize=10");
    expect(filtered.response.status).toBe(200); expect(filtered.data.total).toBe(15); expect(filtered.data.items).toHaveLength(10); expect(filtered.data.page).toBe(1);
    const next = await request("/api/accounts?platform=X&page=2&pageSize=10");
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

  it("T15 过期会话不能继续访问业务 API", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const fresh = await request("/api/auth/login", { method: "POST", ...jsonBody({ email: user.email, password }) }, false);
    expect(fresh.response.status).toBe(200);
    await prisma.session.updateMany({ where: { userId }, data: { expiresAt: new Date(0) } });
    const expired = await request("/api/accounts");
    expect(expired.response.status).toBe(401);
  });
});
