import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    pool: "forks",
    // Integration files each start an isolated Next dev server. Run them one at a
    // time so they do not contend for the shared .next development lock.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
