import { defineConfig, devices } from "@playwright/test";

/**
 * P10 Lane B — Playwright E2E config.
 *
 * v1 targets the public read-only surface against live prod by default
 * (no docker required in CI). To run against a local stack instead:
 *   E2E_BASE_URL=https://localhost bunx playwright test
 *
 * Self-signed certs from the local nginx are accepted via
 * `ignoreHTTPSErrors`. CI sets `E2E_BASE_URL=https://animegoclub.com`
 * (the default below), so no docker stack is needed.
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
  use: {
    baseURL: process.env.E2E_BASE_URL || "https://animegoclub.com",
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
