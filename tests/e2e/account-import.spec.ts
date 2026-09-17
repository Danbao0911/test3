import path from "node:path";
import { test, expect } from "@playwright/test";

const email = process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_ADMIN_PASSWORD;

test("登录—来源批准—90行导入—平台筛选—详情", async ({ page }) => {
  test.skip(!email || !password, "未提供 E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD，未运行浏览器验收");
  await page.goto("/login");
  await page.getByLabel("管理员邮箱").fill(email!);
  await page.getByLabel("密码").fill(password!);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await page.goto("/sources");
  await page.getByLabel("来源名称").fill(`E2E 虚构来源 ${Date.now()}`);
  await page.getByLabel("允许录入依据说明").fill("仅用于 E2E 隔离测试的虚构来源。");
  await page.getByRole("button", { name: "创建 DRAFT 来源" }).click();
  await page.getByRole("button", { name: "批准录入" }).last().click();
  await page.goto("/imports");
  const sourceOption = page.locator("#source option").filter({ hasText: /E2E 虚构来源/ }).last();
  await page.getByLabel("获准数据来源").selectOption((await sourceOption.getAttribute("value"))!);
  await page.getByLabel("CSV 文件").setInputFiles(path.join(process.cwd(), "tests/fixtures/accounts-90.csv"));
  await page.getByRole("button", { name: "预览导入" }).click();
  await expect(page.getByText("共 90 条数据行")).toBeVisible();
  await page.getByRole("button", { name: "确认导入有效行" }).click();
  await page.getByRole("link", { name: "查看导入结果" }).click();
  await expect(page.getByText("导入结果")).toBeVisible();
  await expect(page.locator(".stat-value").nth(1)).toHaveText("60");
  await expect(page.locator(".stat-value").nth(2)).toHaveText("20");
  await expect(page.locator(".stat-value").nth(3)).toHaveText("10");
  await page.goto("/accounts");
  await page.getByLabel("平台").selectOption("X");
  await page.getByRole("button", { name: "筛选" }).click();
  await expect(page.getByText("共 15 条")).toBeVisible();
  await page.getByRole("link", { name: "虚构 X 账号 001" }).click();
  await expect(page.getByText("账号详情")).toBeVisible();
});
