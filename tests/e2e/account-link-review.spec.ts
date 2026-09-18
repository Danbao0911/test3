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

test("T06 账号关联只能人工确认，确认后仍可按来源策略计算可用性", async ({ page }) => {
  const suffix = randomUUID();
  await login(page);
  const origin = "http://127.0.0.1:3000";
  const sourceResponse = await page.request.post("/api/sources", { headers: { Origin: origin }, data: { name: `T06 E2E 来源 ${suffix}`, type: "DEMO", permissionNote: "T06 浏览器隔离测试授权依据" } });
  expect(sourceResponse.status()).toBe(201);
  const source = await sourceResponse.json();
  const sourceId = source.item.id as string;
  const approved = await page.request.patch(`/api/sources/${sourceId}`, { headers: { Origin: origin }, data: { expectedPolicyVersion: source.item.policyVersion, status: "APPROVED", allowImport: true, allowRelate: true } });
  expect(approved.status()).toBe(200);

  async function createAccount(name: string, id: string) {
    const response = await page.request.post("/api/accounts", { headers: { Origin: origin }, data: { platform: "X", nativeId: id, displayName: name, profileUrl: `https://example.com/demo/x/${id}`, organization: "T06 E2E 测试机构", serviceTags: ["财富规划"], region: "上海", sourceId, sourceUrl: `https://example.com/demo/source/${id}` } });
    expect(response.status()).toBe(201);
    return (await response.json()).item.id as string;
  }
  const leftId = await createAccount(`T06 E2E 同名账号 ${suffix}`, `t06-e2e-left-${suffix}`);
  const rightId = await createAccount(`T06 E2E 同名账号 ${suffix}`, `t06-e2e-right-${suffix}`);
  const candidate = await page.request.post("/api/account-links", { headers: { Origin: origin }, data: { leftAccountId: leftId, rightAccountId: rightId, sourceId, basis: "MANUAL" } });
  expect(candidate.status()).toBe(201);
  const candidateData = await candidate.json();

  await page.goto("/account-links");
  const row = page.locator(`[data-link-id="${candidateData.item.id}"]`);
  await expect(row).toContainText("待人工核验");
  await row.getByLabel(/审核理由/).fill("浏览器中人工核对两个独立账号的主体资料");
  await row.getByLabel("关系证据来源地址").fill("https://example.com/demo/e2e/account-link");
  await row.getByLabel("证据定位").fill("公开主体资料关联说明");
  await row.getByLabel("最小说明").fill("浏览器中分别核对两侧账号主体资料");
  await row.getByRole("button", { name: "确认关联" }).click();
  await expect(page.getByText("没有符合条件的账号关联记录。")).toBeVisible();
  await page.getByLabel("关联状态").selectOption("CONFIRMED");
  const confirmedRow = page.locator(`[data-link-id="${candidateData.item.id}"]`);
  await expect(confirmedRow).toContainText("已确认");
  await expect(confirmedRow).toContainText("当前可用");
  await confirmedRow.getByLabel("撤销理由（不得复制联系值）").fill("浏览器中复核后撤销本轮关联");
  await confirmedRow.getByRole("button", { name: "撤销关联" }).click();
  await expect(page.getByText("没有符合条件的账号关联记录。")).toBeVisible();
  await page.getByLabel("关联状态").selectOption("REVOKED");
  const revokedRow = page.locator(`[data-link-id="${candidateData.item.id}"]`);
  await expect(revokedRow).toContainText("已撤销");
  await expect(revokedRow).toContainText("CONFIRMED→REVOKED");
});
