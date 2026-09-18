import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { requireE2EConfig } from "../helpers/e2e-config";

const { email, password } = requireE2EConfig();

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("管理员邮箱").fill(email!);
  await page.getByLabel("密码").fill(password!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts$/);
}

test("T05-R1 工作台保存冲突、备注草稿保留和收藏筛选刷新", async ({ page, browser }) => {
  const suffix = randomUUID();
  const sourceName = `T05-R1 E2E 来源 ${suffix}`;
  const accountName = `T05-R1 E2E 账号 ${suffix}`;
  await login(page);
  await page.goto("/sources");
  await page.getByLabel("来源名称").fill(sourceName);
  await page.getByLabel("允许录入依据说明").fill("T05-R1 浏览器隔离测试来源");
  await page.getByRole("button", { name: "创建 DRAFT 来源" }).click();
  const sourceRow = page.locator("tbody tr").filter({ hasText: sourceName });
  await sourceRow.getByRole("button", { name: "批准录入" }).click();
  await expect(sourceRow).toContainText("APPROVED");
  const sourceId = await sourceRow.getAttribute("data-source-id");

  await page.goto("/accounts/new");
  await page.getByLabel("账号名称").fill(accountName);
  await page.getByLabel("账号主页 HTTPS 链接").fill(`https://example.com/demo/x/t05-r1-${suffix}`);
  await page.getByLabel("服务标签（用 | 分隔）").fill("财富规划");
  await page.getByLabel("数据来源").selectOption(sourceId!);
  await page.getByLabel("来源页面 HTTPS 链接").fill(`https://example.com/demo/source/t05-r1-${suffix}`);
  await page.getByRole("button", { name: "保存账号" }).click();
  await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}$/);
  const detailUrl = page.url();
  await expect(page.getByText("收藏与人工跟进")).toBeVisible();

  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  try {
    await login(second);
    await second.goto(detailUrl);
    await expect(second.getByText("收藏与人工跟进")).toBeVisible();

    await page.getByLabel("跟进状态").selectOption("CONTACTING");
    await page.getByLabel("跟进备注").fill("A 已人工确认公开业务方向");
    await page.getByRole("button", { name: "保存工作台状态" }).click();
    await expect(page.getByText("收藏、负责人和跟进状态已保存。")).toBeVisible();

    await second.getByLabel("跟进备注").fill("B 旧页面草稿 sentinel@example.com");
    await second.getByRole("button", { name: "保存工作台状态" }).click();
    await expect(second.locator(".notice.error")).toContainText("工作台已被其他用户更新");
    await expect(second.getByLabel("跟进备注")).toHaveValue("B 旧页面草稿 sentinel@example.com");
    await expect(second.getByLabel("跟进状态")).toHaveValue("NOT_CONTACTED");

    await page.getByRole("button", { name: "收藏账号" }).click();
    await expect(page.getByRole("button", { name: "取消收藏" })).toBeVisible();
    await page.goto("/accounts");
    await page.getByLabel("搜索已入库账号").fill(accountName);
    await page.getByLabel("收藏").selectOption("YES");
    await page.getByRole("button", { name: "筛选" }).click();
    const accountRow = page.getByRole("row", { name: accountName });
    await expect(accountRow).toBeVisible();
    await accountRow.getByRole("button", { name: "取消收藏" }).click();
    await expect(page.getByText("暂无符合条件的已入库账号。")).toBeVisible();
    await expect(page.getByText("共 0 条")).not.toBeVisible();
  } finally {
    await secondContext.close();
  }
});

test("T05-R1 最新账号筛选响应优先于延迟旧响应", async ({ page }) => {
  const staleId = "00000000-0000-4000-8000-000000000001";
  const latestId = "00000000-0000-4000-8000-000000000002";
  const source = { id: "00000000-0000-4000-8000-000000000003", name: "测试来源", status: "APPROVED", type: "DEMO" };
  const item = (id: string, platform: string, displayName: string) => ({ id, platform, displayName, organization: null, serviceTags: [], region: null, profileUrl: "https://example.com/demo/x/filter", source, createdAt: new Date().toISOString(), isDemo: true, owner: null, favorite: false, followUp: { status: "NOT_CONTACTED", note: null, noteMasked: false }, reviewStatus: null, hasUsableContact: false });
  await page.route("**/api/accounts?*", async (route) => {
    const platform = new URL(route.request().url()).searchParams.get("platform");
    try {
      if (platform === "X") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [item(staleId, "X", "延迟旧筛选")], total: 1, page: 1, pageSize: 20 }) });
        return;
      }
      if (platform === "YOUTUBE") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [item(latestId, "YOUTUBE", "最新筛选结果")], total: 1, page: 1, pageSize: 20 }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 20 }) });
    } catch { /* the browser may abort the stale route after the latest response wins */ }
  });
  await login(page);
  await expect(page.getByText("暂无符合条件的已入库账号。")).toBeVisible();
  await page.getByLabel("平台").selectOption("X");
  await page.getByRole("button", { name: "筛选" }).click();
  await page.getByLabel("平台").selectOption("YOUTUBE");
  await page.getByRole("button", { name: "筛选" }).click();
  await expect(page.getByText("最新筛选结果")).toBeVisible();
  await expect(page.getByText("延迟旧筛选")).not.toBeVisible();
});
