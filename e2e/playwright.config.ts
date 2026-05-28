import { defineConfig, devices } from "@playwright/test";

/**
 * P10 — Playwright E2E config.
 *
 * Two test projects:
 *
 *   chromium-prod    — v1 read-only specs against live prod by default
 *                      (specs/*.spec.ts at top level). Used by
 *                      .github/workflows/e2e.yml.
 *   chromium-sandbox — v2 write-path specs against a docker compose
 *                      stack (specs/sandbox/**\/*.spec.ts). Used by
 *                      .github/workflows/e2e-sandbox.yml. baseURL
 *                      defaults to https://localhost (the nginx self-
 *                      signed-cert container in docker compose).
 *
 * Override per project at runtime:
 *   E2E_BASE_URL=... bunx playwright test --project=chromium-prod
 *   E2E_SANDBOX_BASE_URL=... bunx playwright test --project=chromium-sandbox
 *   MONGO_URL=mongodb://localhost:27017 ... (sandbox fixture inserts)
 *
 * Self-signed certs from the local nginx are accepted via
 * `ignoreHTTPSErrors`.
 */

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 3,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ...(isCI ? [["github"] as ["github"]] : []),
  ],
  globalSetup: "./globalSetup.ts",
  use: {
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium-prod",
      // Glob is relative to testDir. Top-level *.spec.ts only — sandbox/
      // is excluded so this project never tries to hit a docker stack.
      testMatch: "*.spec.ts",
      testIgnore: "sandbox/**",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.E2E_BASE_URL || "https://animegoclub.com",
      },
    },
    {
      name: "chromium-sandbox",
      // Everything under sandbox/.
      testMatch: "sandbox/**/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.E2E_SANDBOX_BASE_URL || "https://localhost",
        storageState: "./.auth/user.json",
      },
    },
  ],
});
