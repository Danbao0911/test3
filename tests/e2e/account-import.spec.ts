import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { requireE2EConfig } from "../helpers/e2e-config";

const { email, password } = requireE2EConfig();

test("登录—来源批准—90行导入—平台筛选—详情", async ({ page }) => {
  const suffix = randomUUID();
  const sourceName = `E2E 虚构来源 ${suffix}`;
  await page.goto("/login");
  await page.getByLabel("管理员邮箱").fill(email!);
  await page.getByLabel("密码").fill(password!);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await page.goto("/sources");
  await page.getByLabel("来源名称").fill(sourceName);
  await expect(page.getByLabel("来源类型")).toHaveValue("DEMO");
  await page.getByLabel("允许录入依据说明").fill("仅用于 E2E 隔离测试的虚构来源。");
  await page.getByRole("button", { name: "创建 DRAFT 来源" }).click();
  const sourceRow = page.locator("tbody tr").filter({ hasText: sourceName });
  await expect(sourceRow).toContainText("DRAFT");
  await sourceRow.getByRole("button", { name: "批准录入" }).click();
  await expect(sourceRow).toContainText("APPROVED");
  const sourceId = await sourceRow.getAttribute("data-source-id");
  await page.goto("/imports");
  await expect(page.getByLabel("获准数据来源").locator(`option[value="${sourceId}"]`)).toBeAttached();
  await page.getByLabel("获准数据来源").selectOption(sourceId!);
  const fixture = readFileSync(path.join(process.cwd(), "tests/fixtures/accounts-90.csv"), "utf8")
    .replaceAll("https://example.com/demo/", `https://example.com/demo/${suffix}/`)
    .replace(/^(XIAOHONGSHU|YOUTUBE|X|DOUYIN),([^,]+),/gm, `$1,$2-${suffix},`);
  await page.getByLabel("CSV 文件").setInputFiles({ name: "accounts-90.csv", mimeType: "text/csv", buffer: Buffer.from(fixture) });
  await page.getByRole("button", { name: "预览导入" }).click();
  await expect(page.getByText("共 90 条数据行")).toBeVisible();
  await page.getByRole("button", { name: "确认导入有效行" }).click();
  await page.getByRole("link", { name: "查看导入结果" }).click();
  await expect(page.getByText("导入结果")).toBeVisible();
  await expect(page.locator(".stat-value").nth(1)).toHaveText("60");
  await expect(page.locator(".stat-value").nth(2)).toHaveText("20");
  await expect(page.locator(".stat-value").nth(3)).toHaveText("10");
  await page.goto(`/accounts?sourceId=${sourceId}`);
  await page.getByLabel("平台").selectOption("X");
  await page.getByRole("button", { name: "筛选" }).click();
  await expect(page.getByText("共 15 条")).toBeVisible();
  await page.getByRole("link", { name: "虚构 X 账号 001" }).click();
  await expect(page.getByText("账号详情")).toBeVisible();
});
