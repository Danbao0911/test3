import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { parseTestDatabaseConfig, assertRestrictedTestRole } from "../helpers/test-database";

const database = parseTestDatabaseConfig();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url }) });
const baseUrl = "http://127.0.0.1:3123";
const users = { admin: "ADMIN", reviewer: "REVIEWER", viewer: "VIEWER" } as const;
type UserKey = keyof typeof users;
const userIds: string[] = [];
const sourceIds: string[] = [];
const cookies = new Map<UserKey, string>();
const sentinel = `private-source-note-${randomUUID()}@example.com`;
let server: ChildProcess | undefined;
let databaseReady = false;

function body(data: unknown) { return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }; }
async function request(user: UserKey | null, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", baseUrl);
  if (user) headers.set("Cookie", cookies.get(user)!);
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}
async function createSource() {
  const created = await request("admin", "/api/sources", { method: "POST", ...body({ name: `T08 source ${randomUUID()}`, type: "DEMO", permissionNote: sentinel }) });
  expect(created.status).toBe(201);
  const source = (await created.json()).item as { id: string; policyVersion: number };
  sourceIds.push(source.id);
  return source;
}
async function approveSource() {
  const source = await createSource();
  const approved = await request("admin", `/api/sources/${source.id}`, { method: "PATCH", ...body({ expectedPolicyVersion: source.policyVersion, status: "APPROVED", allowImport: true, allowExtract: true, allowEvidenceText: true, allowRelate: true, allowExport: true, allowedExportFields: ["DISPLAY_NAME"] }) });
  expect(approved.status).toBe(200);
  return (await approved.json()).item as { id: string; policyVersion: number };
}
function input(source: { id: string; policyVersion: number }) { return { platform: "YOUTUBE", operation: "fetchProfile", sourceId: source.id, expectedPolicyVersion: source.policyVersion }; }

describe("T08 real HTTP platform preflight", () => {
  beforeAll(async () => {
    const guard = new pg.Client({ connectionString: database.url });
    try { await guard.connect(); await assertRestrictedTestRole(guard, database.databaseName); databaseReady = true; }
    finally { await guard.end(); }
    const password = `T08-test-${randomUUID()}`;
    const emails = new Map<UserKey, string>();
    for (const key of Object.keys(users) as UserKey[]) {
      const user = await prisma.user.create({ data: { email: `t08-${key}-${randomUUID()}@example.test`, role: users[key], passwordHash: await bcrypt.hash(password, 4) } });
      userIds.push(user.id); emails.set(key, user.email);
    }
    server = spawn(process.env.PNPM_BIN ?? "pnpm", ["dev", "-p", "3123"], { cwd: process.cwd(), env: { ...process.env, APP_ORIGIN: baseUrl }, stdio: "ignore", detached: process.platform !== "win32" });
    let ready = false;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      try { ready = (await fetch(`${baseUrl}/api/health`)).ok; } catch { /* starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error("T08 dedicated HTTP server did not start");
    for (const key of Object.keys(users) as UserKey[]) {
      const response = await request(null, "/api/auth/login", { method: "POST", ...body({ email: emails.get(key), password }) });
      expect(response.status).toBe(200);
      cookies.set(key, response.headers.get("set-cookie")!.split(";")[0]);
    }
  }, 120_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      const stopped = new Promise(resolve => server!.once("exit", resolve));
      try { process.kill(-server.pid!, "SIGTERM"); } catch { server.kill("SIGTERM"); }
      await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 5_000))]);
    }
    if (databaseReady) {
      if (sourceIds.length) {
        await prisma.sourcePolicySnapshot.deleteMany({ where: { sourceId: { in: sourceIds } } });
        await prisma.source.deleteMany({ where: { id: { in: sourceIds } } });
      }
      if (userIds.length) {
        await prisma.auditEvent.deleteMany({ where: { actorId: { in: userIds } } });
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    }
    await prisma.$disconnect();
  }, 30_000);

  it("T08C01 requires authentication and serves four truthful, minimal capability records", async () => {
    for (const path of ["/api/platforms", "/api/platforms/sources"]) expect((await request(null, path)).status).toBe(401);
    const page = await request(null, "/platforms", { redirect: "manual" });
    expect(page.status).toBe(307);
    for (const user of Object.keys(users) as UserKey[]) {
      const response = await request(user, "/api/platforms");
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
      const data = await response.json();
      expect(data.items).toHaveLength(4);
      for (const item of data.items) expect(item).toMatchObject({ verifiedAt: null, externalRequestsEnabled: false, requestBudget: { maxRequests: 0 } });
      expect(JSON.stringify(data)).not.toContain(sentinel);
    }
  });

  it("T08C02 denies roles, forgery, invalid bodies and oversized streams", async () => {
    const source = await createSource();
    expect((await request(null, "/api/platforms/preflight", { method: "POST", ...body(input(source)) })).status).toBe(401);
    for (const user of ["reviewer", "viewer"] as const) {
      expect((await request(user, "/api/platforms/sources")).status).toBe(403);
      expect((await request(user, "/api/platforms/preflight", { method: "POST", ...body({ ...input(source), role: "ADMIN" }) })).status).toBe(403);
      const html = await (await request(user, "/platforms")).text();
      expect(html).not.toContain(sentinel); expect(html).not.toContain(source.id);
    }
    expect((await request("admin", "/api/platforms/preflight", { method: "POST", ...body(input(source)), headers: { "Content-Type": "application/json", Origin: "https://example.org" } })).status).toBe(403);
    for (const invalid of [{ ...input(source), apiKey: sentinel }, { ...input(source), url: "http://127.0.0.1/" }, { ...input(source), platform: "UNKNOWN" }]) {
      const rejected = await request("admin", "/api/platforms/preflight", { method: "POST", ...body(invalid) });
      expect(rejected.status).toBe(422); expect(await rejected.text()).not.toContain(sentinel);
    }
    expect((await request("admin", "/api/platforms/preflight", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status).toBe(400);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...input(source), excess: "a".repeat(5000) }))); controller.close(); } });
    const oversized = await request("admin", "/api/platforms/preflight", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect(oversized.status).toBe(413);
  });

  it("T08C03 full manual-source permissions never authorize platform calls or create records", async () => {
    const source = await approveSource();
    const before = await prisma.auditEvent.count({ where: { actorId: { in: userIds } } });
    const unchanged = await prisma.source.findUnique({ where: { id: source.id } });
    for (const platform of ["YOUTUBE", "X", "XIAOHONGSHU", "DOUYIN"]) {
      const response = await request("admin", "/api/platforms/preflight", { method: "POST", ...body({ ...input(source), platform }) });
      expect(response.status).toBe(200);
      const { item } = await response.json();
      expect(item).toMatchObject({ executed: false, outboundRequests: 0, advisoryOnly: true, source: { policyVersion: source.policyVersion } });
      expect(["permission_required", "not_supported"]).toContain(item.status);
      expect(item.blockers.map((entry: { code: string }) => entry.code)).toContain("OFFICIAL_API_GRANT_MISSING");
      expect(JSON.stringify(item)).not.toContain(sentinel);
    }
    expect(await prisma.source.findUnique({ where: { id: source.id } })).toEqual(unchanged);
    expect(await prisma.auditEvent.count({ where: { actorId: { in: userIds } } })).toBe(before);
    expect(await prisma.account.count({ where: { sourceId: source.id } })).toBe(0);
    expect(await prisma.evidence.count({ where: { sourceId: source.id } })).toBe(0);
    expect(await prisma.exportJob.count({ where: { createdById: { in: userIds } } })).toBe(0);
  });

  it("T08C04 reads current policy, conflicts with stale input, reports revocation and expiry", async () => {
    const source = await approveSource();
    const changed = await request("admin", `/api/sources/${source.id}`, { method: "PATCH", ...body({ expectedPolicyVersion: source.policyVersion, status: "REVOKED", expiresAt: new Date(Date.now() - 1000).toISOString() }) });
    expect(changed.status).toBe(200);
    const stale = await request("admin", "/api/platforms/preflight", { method: "POST", ...body(input(source)) });
    expect(stale.status).toBe(409); expect((await stale.json()).error).toBe("SOURCE_POLICY_CONFLICT");
    const current = (await changed.json()).item;
    const response = await request("admin", "/api/platforms/preflight", { method: "POST", ...body(input(current)) });
    const codes = (await response.json()).item.blockers.map((entry: { code: string }) => entry.code);
    expect(codes).toContain("SOURCE_NOT_APPROVED"); expect(codes).toContain("SOURCE_EXPIRED"); expect(codes).toContain("IMPORT_NOT_ALLOWED");
    expect((await request("admin", "/api/platforms/preflight", { method: "POST", ...body(input({ id: randomUUID(), policyVersion: 1 })) })).status).toBe(404);
  });

  it("T08C05 missing and legacy snapshots remain unknown; no authorization is backfilled", async () => {
    for (const legacy of [false, true]) {
      const source = await prisma.source.create({ data: { name: "T08 legacy", type: "DEMO", status: "APPROVED", allowImport: true } });
      sourceIds.push(source.id);
      if (legacy) await prisma.sourcePolicySnapshot.create({ data: { sourceId: source.id, version: 1, isLegacy: true, changeType: "LEGACY_UNKNOWN", authorizationBasis: "unknown" } });
      const response = await request("admin", "/api/platforms/preflight", { method: "POST", ...body(input(source)) });
      expect(response.status).toBe(200);
      expect((await response.json()).item.blockers.map((entry: { code: string }) => entry.code)).toContain("POLICY_HISTORY_UNKNOWN");
      expect(await prisma.sourcePolicySnapshot.count({ where: { sourceId: source.id } })).toBe(legacy ? 1 : 0);
    }
  });

  it("T08C06 source pagination is bounded and excludes free-text policy contents", async () => {
    const rows = await prisma.source.createManyAndReturn({ data: Array.from({ length: 23 }, () => ({ name: "T08 pagination", type: "DEMO" as const, permissionNote: sentinel })) });
    sourceIds.push(...rows.map(row => row.id));
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await request("admin", `/api/platforms/sources${cursor ? `?after=${cursor}` : ""}`);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.items.length).toBeLessThanOrEqual(20);
      expect(JSON.stringify(data)).not.toContain(sentinel);
      for (const item of data.items) { expect(item).not.toHaveProperty("permissionNote"); expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
      cursor = data.nextCursor;
    } while (cursor);
    for (const id of sourceIds) expect(seen.has(id)).toBe(true);
    expect((await request("admin", "/api/platforms/sources?after=bad")).status).toBe(422);
  });
});
