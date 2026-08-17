import { chromium, type FullConfig } from "@playwright/test";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cleanupTestUsersInPostgres,
  closePg,
  ensureSeedUserInPostgres,
} from "./fixtures/pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep this default in step with playwright.config.ts's chromium-sandbox
// baseURL — they point at the same server and drifting them means the
// login here succeeds against one host while the specs run against another.
const BASE_URL = process.env.E2E_SANDBOX_BASE_URL ?? "http://localhost:3000";
const STORAGE_STATE_PATH = path.join(__dirname, ".auth", "user.json");

export const SEED_USER_EMAIL = "e2e+sandbox@animegoclub.com";
export const SEED_USER_PASSWORD = "e2e-test-pass-123";
const SEED_USER_USERNAME = "e2e-sandbox";

// ─── Why there is no Mongo seed here any more ───────────────────────────
//
// This function used to open a MongoClient and insert the seed user plus
// three subscriptions before the Postgres seed below. Every one of those
// writes was landing in a database no running process reads:
//
//   - docker-compose.yml has no `mongodb` service. The P9 cutover left
//     next-app / ws-server / postgres / go-api / nginx and nothing else.
//   - go-api's only mention of Mongo is test/integration/migrate_test.go,
//     the one-shot Mongo→Postgres migration tool's own test. No runtime
//     path imports the driver.
//   - The login this file performs goes through go-api, and
//     auth/handlers.go:326 resolves the account with
//     `h.db.GetUserByEmail` — sqlc over pgx. Postgres is authoritative
//     for credentials, full stop.
//
// The cost was not just a wasted insert: the seed was the FIRST thing
// globalSetup did, so a sandbox run died at connect() before reaching any
// spec unless somebody remembered to hand-start `docker-compose.dev.yml
// mongo`. Requiring a retired database to be running is what kept this
// suite off CI. `cleanupTestUsersInPostgres` is the straight port of the
// old `cleanupAllTestUsers` prefix sweep, so the "wipe stragglers before
// seeding" guarantee the specs rely on is preserved, not dropped.
//
// The three seeded subscriptions (anilistId 21 / 11061 / 1535) were NOT
// ported: no spec reads them. The specs that touch subscriptions
// (library-watch-sync) seed their own ids through fixtures/pg.ts, which
// is what makes them safe to run fullyParallel against one shared user.

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // Sandbox-only setup: seed Postgres, then browser-login to mint the
  // storageState the chromium-sandbox project reuses. The read-only
  // chromium-prod project (and any `playwright test --project=chromium-prod`,
  // e.g. .github/workflows/e2e.yml) needs none of it — and would trip over
  // an absent POSTGRES_PASSWORD. Opt IN via E2E_SANDBOX so prod-style runs
  // are a no-op by default.
  if (!process.env.E2E_SANDBOX) return;

  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });

  // Wipe stragglers from prior runs BEFORE seeding, so per-spec cleanup
  // can be dropped (it races with parallel workers).
  const wiped = await cleanupTestUsersInPostgres();
  if (wiped > 0) {
    console.log(`[globalSetup] removed ${wiped} leftover e2e-test-* user(s)`);
  }

  // The seed user backs the storageState every sandbox spec inherits.
  await ensureSeedUserInPostgres(SEED_USER_USERNAME, SEED_USER_EMAIL);
  await closePg();

  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/login`);
  await page.locator("#login-email").fill(SEED_USER_EMAIL);
  await page.locator("#login-password").fill(SEED_USER_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);

  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
}
