import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E configuration.
 *
 * Targets a locally running Gluecron server at http://localhost:3000.
 * Run the server first with `bun dev` or `bun start`, then: `bun run e2e`
 */
export default defineConfig({
  testDir: "./",
  testMatch: "**/*.spec.ts",

  /* Maximum time one test can run. */
  timeout: 30_000,

  /* Fail the build on CI if you accidentally left `test.only`. */
  forbidOnly: !!process.env.CI,

  /* No retries in CI — flaky tests should be fixed, not hidden. */
  retries: process.env.CI ? 0 : 0,

  /* Run tests serially by default to avoid auth/DB contention. */
  workers: process.env.CI ? 1 : 1,

  /* Reporter */
  reporter: process.env.CI
    ? [["github"], ["list"]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    /* Collect trace on first retry to ease debugging. */
    trace: "on-first-retry",
    /* Give each navigation a generous budget. */
    navigationTimeout: 15_000,
    actionTimeout: 10_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
