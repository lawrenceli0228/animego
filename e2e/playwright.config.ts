import { defineConfig, devices } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Source .env.production from the repo root so e2e/fixtures/pg.ts can
// reach Postgres without a hard-coded password fallback. CI sets these
// vars directly via the workflow env block; locally we read the dotenv.
// Don't fail if the file is missing — CI / fresh checkouts won't have it.
(function loadRepoEnv() {
  const envFile = path.resolve(__dirname, "..", ".env.production");
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) process.env[k] = v.trim();
  }
})();

/**
 * Playwright E2E config.
 *
 * Two test projects, with very different blast radii. Run them through
 * the package scripts (`bun run test:prod` / `bun run test:sandbox`) —
 * a bare `playwright test` runs BOTH, which points the write-path specs
 * at live prod.
 *
 *   chromium-prod    — read-only specs against live prod by default
 *                      (specs/*.spec.ts at top level). Used by
 *                      .github/workflows/e2e.yml.
 *   chromium-sandbox — write-path specs against a locally-booted stack
 *                      (specs/sandbox/**\/*.spec.ts). Used by
 *                      .github/workflows/e2e-sandbox.yml. Requires
 *                      E2E_SANDBOX=1 — globalSetup no-ops without it and
 *                      the run then fails on a missing storageState.
 *
 * The sandbox baseURL defaults to http://localhost:3000, i.e. `next dev`
 * on the host, NOT the nginx container it used to point at. Two reasons
 * nginx is out of the loop: it needs nginx/selfsigned.{crt,key}, which
 * are not in a checkout, and the prod next-app image serves no /api
 * rewrite (next.config.ts:26 returns [] under NODE_ENV=production —
 * nginx does that hop in prod), so browser-side /api calls 404 against
 * it. `next dev` supplies the rewrite. `ignoreHTTPSErrors` stays for
 * anyone pointing E2E_SANDBOX_BASE_URL back at a TLS front end.
 *
 * Override per project at runtime:
 *   E2E_BASE_URL=... bun run test:prod
 *   E2E_SANDBOX_BASE_URL=... bun run test:sandbox
 *   POSTGRES_PASSWORD=... (sandbox fixture inserts; see fixtures/pg.ts)
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
        baseURL: process.env.E2E_SANDBOX_BASE_URL || "http://localhost:3000",
        storageState: "./.auth/user.json",
      },
    },
  ],
});
