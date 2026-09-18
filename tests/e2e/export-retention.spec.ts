import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { requireE2EConfig } from "../helpers/e2e-config";

const { email, password } = requireE2EConfig();

test("T07 管理员导出前检查策略并生成一次性 CSV 链接", async ({ page }) => {
  const suffix = randomUUID();
  await page.goto("/login");
  await page.getByLabel("管理员邮箱").fill(email!);
  await page.getByLabel("密码").fill(password!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  const origin = "http://127.0.0.1:3000";
  const sourceResponse = await page.request.post("/api/sources", { headers: { Origin: origin }, data: { name: `T07 E2E 来源 ${suffix}`, type: "DEMO", permissionNote: "T07 浏览器隔离测试授权依据" } });
  expect(sourceResponse.status()).toBe(201);
  const source = await sourceResponse.json();
  const sourceId = source.item.id as string;
  const approved = await page.request.patch(`/api/sources/${sourceId}`, { headers: { Origin: origin }, data: { expectedPolicyVersion: source.item.policyVersion, status: "APPROVED", allowImport: true, allowExtract: true, allowEvidenceText: true, allowExport: true } });
  expect(approved.status()).toBe(200);
  const accountResponse = await page.request.post("/api/accounts", { headers: { Origin: origin }, data: { platform: "X", nativeId: `t07-e2e-${suffix}`, displayName: `=T07 E2E 账号 ${suffix}`, profileUrl: `https://example.com/demo/x/t07-e2e-${suffix}`, organization: "T07 E2E 虚构机构", serviceTags: ["财富规划"], region: "上海", sourceId, sourceUrl: `https://example.com/demo/source/${suffix}` } });
  expect(accountResponse.status()).toBe(201);
  const accountId = (await accountResponse.json()).item.id as string;
  const extracted = await page.request.post("/api/contacts/extract", { headers: { Origin: origin }, data: { accountId, sourceId, sourceUrl: "https://example.com/demo/evidence/t07-e2e", capturedAt: new Date(Date.now() - 60_000).toISOString(), fieldLocation: "T07 E2E 商务栏", context: "ACCOUNT_PROFILE", text: "商务邮箱：t07-e2e@example.com" } });
  expect(extracted.status()).toBe(200);
  const contactList = await page.request.get(`/api/contacts?accountId=${accountId}`);
  const contactId = (await contactList.json()).items[0].id as string;
  const reviewed = await page.request.patch(`/api/contacts/${contactId}`, { headers: { Origin: origin }, data: { version: 1, status: "APPROVED", ownershipConfirmed: true, businessConfirmed: true, reason: "T07 E2E 人工核对" } });
  expect(reviewed.status()).toBe(200);

  await page.goto("/exports");
  await expect(page.getByRole("heading", { name: "受控导出" })).toBeVisible();
  const exportResponse = page.waitForResponse((response) => response.url().endsWith("/api/exports") && response.request().method() === "POST");
  await page.getByRole("button", { name: "生成一次性下载链接" }).click();
  const created = await exportResponse;
  expect(created.status()).toBe(201);
  const link = page.getByRole("link", { name: /下载 CSV/ });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  const downloaded = await page.request.get(href!);
  expect(downloaded.status()).toBe(200);
  expect(await downloaded.text()).toContain("'=T07 E2E 账号");
  expect((await page.request.get(href!)).status()).toBe(410);
  const deleted = await page.request.post("/api/deletion-requests", { headers: { Origin: origin }, data: { accountId, reason: "T07 E2E 清理虚构账号", confirm: true } });
  expect(deleted.status()).toBe(201);
});
