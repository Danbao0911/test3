import { defineConfig, devices } from "@playwright/test";
import { requireE2EConfig } from "./tests/helpers/e2e-config";

requireE2EConfig(); // Validate before Playwright can start a server or touch a database.

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:3000", trace: "on-first-retry", ...devices["Desktop Chrome"] },
  webServer: { command: "pnpm exec tsx scripts/verify-test-database.ts && pnpm dev", url: "http://127.0.0.1:3000/api/health", reuseExistingServer: false, timeout: 120_000 },
});
