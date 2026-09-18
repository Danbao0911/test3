import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { requireE2EConfig } from "../helpers/e2e-config";

const { email, password } = requireE2EConfig();
const origin = "http://127.0.0.1:3000";

async function setup(page: Page) {
  await page.goto("/login");
  await page.getByLabel("管理员邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  const name = `T08 E2E ${randomUUID()}`;
  const created = await page.request.post("/api/sources", { headers: { Origin: origin }, data: { name, type: "DEMO", permissionNote: "T08 浏览器隔离测试 PRIVATE_NOTE_SENTINEL" } });
  expect(created.status()).toBe(201);
  const source = (await created.json()).item;
  const approved = await page.request.patch(`/api/sources/${source.id}`, { headers: { Origin: origin }, data: { expectedPolicyVersion: source.policyVersion, status: "APPROVED", allowImport: true } });
  expect(approved.status()).toBe(200);
  await page.goto("/platforms");
  await expect(page.getByRole("heading", { name: "平台接入", exact: true })).toBeVisible();
  await selectSource(page, source.id);
  return (await approved.json()).item as { id: string; policyVersion: number };
}

async function selectSource(page: Page, id: string) {
  await expect(page.getByLabel("已登记来源")).toBeEnabled();
  for (let i = 0; i < 30; i++) {
    const option = page.locator(`option[value="${id}"]`);
    if (await option.count()) { await page.getByLabel("已登记来源").selectOption(id); return; }
    const next = page.getByRole("button", { name: "下一页来源" });
    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.getByLabel("已登记来源")).toBeEnabled();
  }
  throw new Error("T08 test source not found in bounded source pages");
}

test("T08 平台能力与预检不冒充真实采集", async ({ page }) => {
  const outbound: string[] = [];
  page.on("request", request => { if (new URL(request.url()).origin !== origin) outbound.push(request.url()); });
  await setup(page);
  for (const label of ["YouTube", "X", "小红书", "抖音"]) await expect(page.getByRole("button", { name: `${label} 外部搜索不可用`, exact: true })).toBeDisabled();
  await expect(page.locator("body")).not.toContainText("PRIVATE_NOTE_SENTINEL");
  const response = page.waitForResponse(response => response.url().endsWith("/api/platforms/preflight"));
  await page.getByRole("button", { name: "核对接入条件", exact: true }).click();
  const checked = await response;
  expect(checked.status()).toBe(200);
  expect((await checked.json()).item).toMatchObject({ status: "permission_required", executed: false, outboundRequests: 0 });
  await expect(page.getByRole("status")).toContainText("尚不能调用平台");
  await expect(page.getByRole("status")).toContainText("演示来源只能用于合成数据");
  expect(outbound).toEqual([]);
});

test("T08 旧策略、断网和非 JSON 错误保持草稿，不自动重试", async ({ page }) => {
  const source = await setup(page);
  await page.getByLabel("平台", { exact: true }).selectOption("X");
  const revoked = await page.request.patch(`/api/sources/${source.id}`, { headers: { Origin: origin }, data: { expectedPolicyVersion: source.policyVersion, status: "REVOKED" } });
  expect(revoked.status()).toBe(200);
  let calls = 0;
  page.on("request", request => { if (request.url().endsWith("/api/platforms/preflight")) calls++; });
  const conflict = page.waitForResponse(response => response.url().endsWith("/api/platforms/preflight"));
  const check = page.getByRole("button", { name: "核对接入条件", exact: true });
  await check.click();
  expect((await conflict).status()).toBe(409);
  await expect(page.locator(".notice.error[role='alert']")).toContainText("来源策略已变化");
  await expect(page.getByLabel("平台", { exact: true })).toHaveValue("X");
  await expect(page.getByLabel("已登记来源")).toHaveValue(source.id);
  await expect(check).toBeEnabled();
  expect(calls).toBe(1);

  await page.route("**/api/platforms/preflight", route => route.abort("failed"));
  await check.click();
  await expect(page.locator(".notice.error[role='alert']")).toBeVisible();
  await expect(check).toBeEnabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.unroute("**/api/platforms/preflight");
  await page.route("**/api/platforms/preflight", route => route.fulfill({ status: 502, contentType: "text/html", body: "upstream unavailable" }));
  await check.click();
  await expect(page.locator(".notice.error[role='alert']")).toContainText("请求失败");
  await expect(check).toBeEnabled();
  await expect(page.getByLabel("已登记来源")).toHaveValue(source.id);
  await page.unroute("**/api/platforms/preflight");

  await page.getByRole("button", { name: "刷新来源", exact: true }).click();
  await selectSource(page, source.id);
  await check.click();
  await expect(page.getByRole("status")).toContainText("当前来源尚未批准或已撤销");
});
