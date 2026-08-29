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
import { waitForHydration } from "./fixtures/hydration";

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
  // The positive probe for the `[lang]/anime/[id]` route class, which until
  // now had none anywhere in the pipeline.
  //
  // Under the Turbopack dev server, every route carrying a dynamic segment
  // NESTED inside `[lang]` intermittently 404s for a whole run —
  // `[lang]/anime/[id]`, `[lang]/reset-password/[token]`, `[lang]/u/[username]`,
  // `[lang]/seasonal/[season]/[year]` — while routes where `[lang]` is the only
  // dynamic segment keep serving throughout. Measured on the 2026-08-29 failure:
  // three-segment paths went 0 for 19.
  //
  // Nothing in the run could see it. The workflow warms `/anime/0`, and 0
  // answers 404 in BOTH states — healthy, because the page bails on
  // `anilistId <= 0` before calling loadDetail (a real product 404), and broken,
  // because the router 404s without compiling the segment. A probe whose answer
  // is identical either way is not a probe, so the class went unwatched and the
  // specs met the defect instead, as a dozen unrelated-looking failures.
  //
  // Directly after the seed is the EARLIEST point at which a real id is a valid
  // probe, and that ordering is load-bearing in both directions. Earlier is a
  // genuine miss, and `loadDetail` fetches with `revalidate: 60`, so Next would
  // hand that 404 back for a minute after the row existed. The workflow's
  // warm-up step documents the same reasoning for why it warms 0 and not 21 —
  // the two halves are a pair, and neither is safe to "simplify" alone.
  await assertRoutingFixtureRenders();
  await closePg();

  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/login`);

  // The most expensive place in the repo to lose the hydration race.
  //
  // A fill that lands before React claims the input goes into the DOM and never
  // reaches state, so the submit posts an empty form, the login never happens,
  // and `.auth/user.json` is never written — which fails EVERY sandbox spec on a
  // missing storage state, loudly and repeatedly, describing a file. Nobody
  // reading that goes looking for a keystroke. Same red herring the routing
  // fixture guards against, reached by a different road.
  //
  // 30s rather than the helper's 15s default: there is no per-test budget out
  // here (no `timeout`, no `globalTimeout` in playwright.config.ts) to make a
  // longer wait unreportable, and this is the coldest the dev server ever is —
  // /login may be the first React route it has been asked to compile.
  try {
    await waitForHydration(page, "#login-email", { timeout: 30_000 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Close before rethrowing. This is the first throw between launch() and
    // close(), and a leaked Chromium is one more confusing thing to find
    // afterwards — locally it survives the run and keeps the port.
    await browser.close().catch(() => {});
    throw new Error(`${detail}\n\n${STORAGE_STATE_RED_HERRING}`);
  }

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

// Appended to every failure below, because the loudest error in the log will
// not be one of them.
//
// globalSetup throws before the browser login, so `.auth/user.json` is never
// written, and Playwright then fails EVERY sandbox spec on a missing storage
// state. That message arrives later, repeats once per spec, and describes a
// file — it out-shouts the single line above it that says what actually broke.
// Someone who chases it goes looking at auth, at the seed user, at
// `storageState` config, and finds nothing wrong with any of them.
const STORAGE_STATE_RED_HERRING =
  `DO NOT CHASE THE NEXT ERROR IN THIS LOG. globalSetup stops here, before the ` +
  `browser login, so e2e/.auth/user.json is never written and every sandbox spec ` +
  `afterwards reports "storage state file not found". That is downstream of this ` +
  `failure, not a second one. Fix this line and it goes away.`;

/**
 * Demand a 200 from `/anime/{ROUTING_FIXTURE_ANILIST_ID}`.
 *
 * The check is one fetch; the messages are the reason this function exists.
 * The condition it detects has three plausible-looking explanations that are
 * all wrong — the fixture, the login, the database — and the reader gets
 * exactly one error before the storage-state noise buries it, so each throw
 * has to rule those out by name rather than leave them open.
 *
 * Deliberately one request, not a retry loop. The failure is per dev-server
 * process, not per request (0 for 19 in the failed run), so a retry would only
 * spend time before reporting the same thing — and the workflow's warm-up step
 * has already absorbed the separate startup window where Turbopack answers 5xx
 * for a few seconds with nothing logged.
 *
 * A throw skips the `closePg()` that follows the call site and leaves the pool
 * open. Not worth guarding: Playwright ends a failed run through
 * `gracefullyProcessExitDoNotHang`, which calls `process.exit()` outright.
 */
async function assertRoutingFixtureRenders(): Promise<void> {
  const url = `${BASE_URL}/anime/${ROUTING_FIXTURE_ANILIST_ID}`;

  let status: number;
  try {
    // Redirects followed on purpose: the specs reach this page with a browser,
    // so the status that matters is the one at the end of the chain, not a
    // locale-prefix hop along the way.
    const response = await fetch(url, { redirect: "follow" });
    status = response.status;
  } catch (cause) {
    // Without this catch the whole diagnosis is replaced by `TypeError: fetch
    // failed`, which names neither the URL nor the reason and is followed
    // immediately by the storage-state cascade.
    throw new Error(
      `${url} could not be reached at all — nothing is answering on that host.\n\n` +
        `This is not the fixture and not auth. globalSetup got this far, which means ` +
        `Postgres accepted the seed and ensureAnimeDetail() verified its own ` +
        `postcondition; this request never reached a server at all. Check that the ` +
        `app server is up and that E2E_SANDBOX_BASE_URL (currently ${BASE_URL}) matches ` +
        `the baseURL in playwright.config.ts.\n\n` +
        STORAGE_STATE_RED_HERRING,
      { cause },
    );
  }

  if (status !== 200) {
    throw new Error(
      `GET ${url} answered ${status}, not 200.\n\n` +
        `The anime_cache row for ${ROUTING_FIXTURE_ANILIST_ID} EXISTS. ` +
        `ensureAnimeDetail() checks its own postcondition — one studio, one ` +
        `character with a role, the two things isStale trips on — and it returned ` +
        `without throwing on the line above this probe. So the seed is not the ` +
        `problem. Neither is auth: this request carried no cookies and /anime/* is ` +
        `public to anonymous readers.\n\n` +
        `The page was asked for a row that is there and did not render it. That is ` +
        `the nested-dynamic-segment failure: under the dev server, routes with a ` +
        `dynamic segment inside [lang] — [lang]/anime/[id], ` +
        `[lang]/reset-password/[token], [lang]/u/[username], ` +
        `[lang]/seasonal/[season]/[year] — 404 for an entire run, while routes ` +
        `where [lang] is the only dynamic segment keep serving. It is a property ` +
        `of the dev-server process, not of any one request: re-running a single ` +
        `spec proves nothing, because the whole run is affected or none of it is.\n\n` +
        STORAGE_STATE_RED_HERRING,
    );
  }
}
