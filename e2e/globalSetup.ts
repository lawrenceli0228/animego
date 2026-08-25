import { chromium, type FullConfig } from "@playwright/test";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cleanupTestUsersInPostgres,
  closePg,
  ensureAnimeDetail,
  ensureSeedUserInPostgres,
} from "./fixtures/pg";

/**
 * The AniList id the routing specs use as "a detail page".
 *
 * `locale-routing.spec.ts` asserts `/anime/21`, `/en/anime/21` and
 * `/zh-Hant/anime/21` all render and self-canonicalise, and nothing seeded it —
 * so a cold `/anime/21` fell through to a LIVE, UNAUTHENTICATED AniList fetch.
 * The workflow says as much in its own comment: leaving `ANILIST_TOKEN` unset
 * "just means unauthenticated upstream calls".
 *
 * That put a rate-limited third party in the critical path of a merge gate.
 * When it refused, the page rendered not-found and every `/anime/21` assertion
 * in the run failed together — intermittently, and more often as the suite grew
 * and ran more of it concurrently.
 *
 * Removing the dependency takes `ensureAnimeDetail`, NOT `ensureAnimeCached`.
 * That distinction is the whole fix and it is not obvious: a row from
 * `ensureAnimeCached` exists but has no studios and no characters, and
 * `isStale` (go-api/internal/anime/detail.go) trips on either of those
 * independently of `cached_at`. A stale row sends the handler to AniList
 * anyway, so seeding it that way changes nothing that matters here — which is
 * exactly what happened when this fixture was first added, and why the
 * assertions kept failing after it.
 *
 * The specs only ever assert status, `h1` presence and the canonical URL, so
 * the row's CONTENTS do not matter. What matters is that it looks complete
 * enough that nothing goes upstream to complete it.
 */
const ROUTING_FIXTURE_ANILIST_ID = 21;

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
  // Seeded here rather than in the spec that reads it: `locale-routing` never
  // writes to Postgres at all, and a per-spec fixture would race the other
  // workers under `fullyParallel`. Global setup runs once, before any of them.
  await ensureAnimeDetail({
    anilistId: ROUTING_FIXTURE_ANILIST_ID,
    titleRomaji: "E2E Routing Fixture",
    titleChinese: "E2E 路由固定装置",
    episodes: 12,
  });
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
