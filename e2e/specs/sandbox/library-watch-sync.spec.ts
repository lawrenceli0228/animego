import { test, expect, type Page } from "@playwright/test";
import { collectConsoleErrors } from "../_helpers";
import {
  clearLibrary,
  readSeriesRow,
  seedEpisodeId,
  seedLibrary,
  writeProgress,
} from "../../fixtures/dexie-seed";
import {
  closePg,
  ensureAnimeCached,
  readSubscription,
  resetSubscriptions,
  seedSubscription,
} from "../../fixtures/pg";
import { SEED_USER_EMAIL } from "../../globalSetup";

// Local library ↔ server watch progress (design doc §8.3).
//
// WHAT THESE THREE COVER
//
//   1. click a card → the server holds a `watching` subscription for it, and a
//      title the user set to `dropped` is NOT resurrected by that click.
//   2. completed episodes in Dexie → server `current_episode` → the home page's
//      `N/M` badge; an NCOP marked completed does not move the number.
//   3. progress written with the network down reaches the server on the next
//      visit, with no repair UI and no queue, and replaying it changes nothing.
//
// ══════════════════════════════════════════════════════════════════════════
// WHAT THESE THREE DO **NOT** COVER — read this before trusting the suite
// ══════════════════════════════════════════════════════════════════════════
//
// The first half of the feature — "play to 90% and the episode ticks itself" —
// has NO end-to-end coverage anywhere. Not here, not in any other spec.
//
// The reason is the fixture: `e2e/fixtures/black1s.mp4` is a 144-byte ISO MP4
// skeleton (ftyp + moov/mvhd + an empty mdat, and no `trak` at all). Chromium
// cannot decode it — `player.spec.ts` says as much and filters
// PIPELINE_ERROR / DEMUXER_ERROR / MediaError out of its console assertions.
// No decode means no `timeupdate`, no `duration`, and therefore
// `shouldMarkWatched` can never return true in a browser. Producing a real
// short video needs ffmpeg, which is deliberately not installed here.
//
// So the threshold half is covered by unit tests instead:
//
//   next-app/src/lib/library/watchCompletion.test.ts   (18 cases — the guards,
//       the 90% and tail-margin branches, the §5.1 verification table, the
//       non-finite inputs, and the accepted "seek to the end" trade-off)
//   next-app/src/lib/library/watchHighWater.test.ts    (13 cases — kind
//       filtering, missing episodes, max selection)
//   next-app/src/lib/library/watchSync.test.ts         (56 cases — push
//       planning, failure classification, the attempt ceiling, and the
//       reconcilers against a fake API)
//
// These specs pick the chain up one step later: `dexie-seed` writes the
// `completed: true` rows directly and everything AFTER that point — Dexie →
// high-water → PATCH → home page — runs for real. That split matches §8.2's
// own judgement that the risk lives in the wiring, not in the predicate.
//
// ══════════════════════════════════════════════════════════════════════════
// NOTHING IN CI RUNS THIS FILE
// ══════════════════════════════════════════════════════════════════════════
//
// `.github/workflows/e2e.yml` runs `--project=chromium-prod`, which excludes
// `specs/sandbox/**`. `playwright.config.ts` points at an `e2e-sandbox.yml`
// workflow that does not exist in this repo. So this file only ever runs when
// somebody runs it. The recipe below is the one these three were written and
// verified against — backend in Docker, frontend on `next dev`, per
// `local_fullstack_verify_recipe`:
//
//   # 1. go-api needs :8080 on the host (next dev's /api rewrite targets it)
//   #    and pg.ts needs :5432; neither is published by the prod compose file.
//   cat > /tmp/animego-e2e-override.yml <<'YML'
//   services:
//     go-api:
//       ports: ["8080:8080"]
//       environment:
//         JWT_EXPIRES_IN: 2h
//         AUTH_RATELIMIT_MAX: "1000"
//         API_RATELIMIT_BURST: "0"
//     postgres:
//       ports: ["5432:5432"]
//   YML
//   CO="docker compose --env-file .env.production -f docker-compose.yml -f /tmp/animego-e2e-override.yml"
//   $CO build go-api && $CO up -d postgres go-api
//   $CO --profile migrate run --rm migrate
//
//   # 2. globalSetup still seeds Mongo before it browser-logs-in. Mongo is
//   #    retired in prod but the fixture is not, so it has to be up or the
//   #    whole run dies in globalSetup.
//   docker compose -f docker-compose.dev.yml up -d mongo
//
//   # 3. Frontend on dev, not the prod image: the image is built from whatever
//   #    was committed, and `next.config.ts` returns no /api rewrites under
//   #    NODE_ENV=production (nginx does that job there).
//   cd next-app && set -a && source <(grep '^JWT_SECRET=' ../.env.production) \
//     && export GO_API_INTERNAL_URL=http://localhost:8080 && set +a && bun run dev
//
//   # 4. E2E_SANDBOX=1 is what opts globalSetup in at all.
//   cd e2e && E2E_SANDBOX=1 E2E_SANDBOX_BASE_URL=http://localhost:3000 \
//     bunx playwright test --project=chromium-sandbox specs/sandbox/library-watch-sync.spec.ts

// AniList ids are the isolation boundary. The sandbox project is
// `fullyParallel` over ONE shared seed user, so two specs touching the same id
// would race on the same `subscriptions` row. Every test below owns its own
// block and never reads the others'.
const ANI_TRACK_FRESH = 900101; // test 1 — no subscription to start with
const ANI_TRACK_DROPPED = 900102; // test 1 — user set this to `dropped` by hand
const ANI_HOME = 900201; // test 2
const ANI_OFFLINE = 900301; // test 3

const HOME_TOTAL_EPISODES = 24;

// Card titles double as locators, so they have to be distinct AND they have to
// be what the card actually renders: `SeriesCard.tsx:504` reads
// `titleEn || titleZh || titleJa || id`, and the seed mirrors that by
// defaulting `titleEn` to whatever `titleZh` it was given.
//
// NOTE: keep "E2E" out of anything that reaches the episode parser — the "E2"
// inside "[E2E]" reads as episode 2 (see library-autorescan.spec.ts:27). These
// titles never hit the parser (the seed bypasses import), but the convention is
// cheaper to keep than to re-learn.
const TITLE_FRESH = "追踪测试 · 全新";
const TITLE_DROPPED = "追踪测试 · 已弃番";
const TITLE_HOME = "首页进度测试";
const TITLE_OFFLINE = "离线补推测试";

/**
 * Stub every outbound dandanplay call.
 *
 * Opening a card mounts `SeriesDetailSheet`, and the binding resolver behind it
 * searches by title whenever a series has no `anilistId`. Every series seeded
 * below is already bound, so this stub is a guard rather than a fixture: if a
 * regression ever makes the grid search on click anyway, the spec fails on its
 * own assertion instead of on somebody else's rate limit.
 */
async function stubDandanplay(page: Page): Promise<void> {
  await page.route("**/api/dandanplay/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ matched: false, results: [] }),
    }),
  );
}

/** Poll Postgres until the subscription reaches a state, or fail loudly. */
async function expectSubscription(
  anilistId: number,
  expected: { status?: string; currentEpisode?: number },
  timeout = 20_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = await readSubscription(SEED_USER_EMAIL, anilistId);
        if (!row) return null;
        const out: Record<string, unknown> = {};
        if (expected.status !== undefined) out.status = row.status;
        if (expected.currentEpisode !== undefined) {
          out.currentEpisode = row.currentEpisode;
        }
        return out;
      },
      { timeout, message: `subscription ${anilistId} never reached the expected state` },
    )
    .toEqual(expected);
}

test.describe("/library ↔ server watch progress", () => {
  test.afterAll(async () => {
    // pg.ts holds a lazy singleton connection; Playwright will not exit while
    // the socket is open.
    await closePg();
  });

  test.beforeEach(async ({ page }) => {
    await stubDandanplay(page);
  });

  test.afterEach(async ({ page }) => {
    await clearLibrary(page).catch(() => {});
  });

  // ───────────────────────────────────────────────────────────────────────
  // §8.3 #1 — import it, click it, it is tracked. Plus decision 3: a status
  // the user set by hand is not something an automated click may overwrite.
  // ───────────────────────────────────────────────────────────────────────
  test("clicking a card starts tracking, and never resurrects a dropped title", async ({
    page,
  }) => {
    // Two card clicks, two round trips, a detail sheet open/close in between —
    // the 30s default is not enough against a dev-mode server.
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);

    await ensureAnimeCached({ anilistId: ANI_TRACK_FRESH, episodes: 12 });
    await ensureAnimeCached({ anilistId: ANI_TRACK_DROPPED, episodes: 12 });
    await resetSubscriptions(SEED_USER_EMAIL, [ANI_TRACK_FRESH]);
    // The precondition decision 3 exists for: a title the user consciously
    // abandoned. Seeded straight into Postgres rather than through the API,
    // because arranging it via POST would run the very upsert branch under test.
    await seedSubscription(SEED_USER_EMAIL, ANI_TRACK_DROPPED, "dropped", 4);

    await page.goto("/welcome");
    await clearLibrary(page);
    const seeded = await seedLibrary(page, {
      series: [
        { id: "sync-fresh", titleZh: TITLE_FRESH, anilistId: ANI_TRACK_FRESH },
        { id: "sync-dropped", titleZh: TITLE_DROPPED, anilistId: ANI_TRACK_DROPPED },
      ],
    });
    expect(seeded.seriesIds).toEqual(["sync-fresh", "sync-dropped"]);

    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("series-card-root")).toHaveCount(2, {
      timeout: 30_000,
    });

    // ── the fresh title ──────────────────────────────────────────────────
    const freshCard = page
      .getByTestId("series-card-root")
      .filter({ hasText: TITLE_FRESH });
    const freshPost = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/subscriptions",
      { timeout: 30_000 },
    );
    await freshCard.locator('[data-series-card-button="true"]').click();
    // Waiting on the response, not on a timer: the click is fire-and-forget by
    // design (the episode picker must open at click speed) so there is no UI
    // state that means "the POST landed".
    expect((await freshPost).status()).toBe(201);

    await expectSubscription(ANI_TRACK_FRESH, {
      status: "watching",
      currentEpisode: 0,
    });

    // …and the same fact through the product's own read surface, which is what
    // the home page and the profile list actually consume.
    const listRes = await page.request.get("/api/subscriptions");
    expect(listRes.ok()).toBe(true);
    const list = (await listRes.json()).data as Array<{
      anilistId: number;
      status: string;
    }>;
    expect(
      list.find((s) => s.anilistId === ANI_TRACK_FRESH),
      "GET /api/subscriptions must list the title the click just started tracking",
    ).toMatchObject({ status: "watching" });

    // ── the dropped title ────────────────────────────────────────────────
    await page.getByTestId("series-detail-close").click();
    await expect(page.getByTestId("series-detail-sheet")).toHaveCount(0);

    const droppedCard = page
      .getByTestId("series-card-root")
      .filter({ hasText: TITLE_DROPPED });
    const droppedPost = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/subscriptions",
      { timeout: 30_000 },
    );
    await droppedCard.locator('[data-series-card-button="true"]').click();
    // 201 either way — `ifAbsent` makes the endpoint idempotent, so "already
    // there" is a success, not a conflict. The interesting part is the row.
    await droppedPost;

    const stillDropped = await readSubscription(SEED_USER_EMAIL, ANI_TRACK_DROPPED);
    expect(
      stillDropped,
      "decision 3: `ifAbsent` must leave a hand-set status alone — status is human-only",
    ).toMatchObject({ status: "dropped", currentEpisode: 4 });

    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // §8.3 #2 — local completed episodes surface as `N/M` on the home page.
  // Plus decision 10: only `kind === 'main'` may move the number.
  // ───────────────────────────────────────────────────────────────────────
  test("library progress reaches the home page, and an NCOP does not inflate it", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);

    await ensureAnimeCached({
      anilistId: ANI_HOME,
      titleChinese: TITLE_HOME,
      episodes: HOME_TOTAL_EPISODES,
    });
    await resetSubscriptions(SEED_USER_EMAIL, [ANI_HOME]);

    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        {
          id: "sync-home",
          titleZh: TITLE_HOME,
          anilistId: ANI_HOME,
          totalEpisodes: HOME_TOTAL_EPISODES,
          episodes: [
            { number: 1, progress: { completed: true } },
            { number: 2, progress: { completed: true } },
            { number: 3, progress: { completed: true } },
            // Started but not finished — must not count.
            { number: 4, progress: { completed: false, positionSec: 300 } },
            // The decision-10 trap. Numbered ABOVE the main high-water mark on
            // purpose: if `resolveHighWater` ever stops filtering on `kind`,
            // the server jumps to 9 and this test says so out loud. (The
            // realistic `NCOP01 → number 1` shape, which hides inside a max(),
            // is covered in watchHighWater.test.ts.)
            { number: 9, kind: "ncop", progress: { completed: true } },
          ],
        },
      ],
    });

    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 30_000 });

    // The reconciler had no subscription to PATCH, so it 404s once, creates the
    // row with `ifAbsent`, and retries — all without the user clicking anything.
    await expectSubscription(ANI_HOME, { status: "watching", currentEpisode: 3 });

    // Client half of the no-queue contract: the pushed value is recorded only
    // after the server accepted it (design doc decision 5).
    await expect
      .poll(async () => (await readSeriesRow(page, "sync-home"))?.lastSyncedEpisode, {
        timeout: 15_000,
      })
      .toBe(3);

    // ── the home page ────────────────────────────────────────────────────
    await page.goto("/");
    const card = page.locator(`a[href="/anime/${ANI_HOME}"]`).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    // `${currentEpisode}/${episodes} ${epUnit}` — ContinueWatching.badgeText.
    await expect(card).toContainText(`3/${HOME_TOTAL_EPISODES}`, {
      timeout: 15_000,
    });

    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // §8.3 #3 — finished an episode with no network; coming back is the whole
  // repair mechanism (decision 5: state is the truth, no queue, replay-safe).
  // ───────────────────────────────────────────────────────────────────────
  test("progress written offline syncs itself on the next visit, and replays as a no-op", async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await ensureAnimeCached({ anilistId: ANI_OFFLINE, episodes: 12 });
    await resetSubscriptions(SEED_USER_EMAIL, [ANI_OFFLINE]);

    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        {
          id: "sync-offline",
          titleZh: TITLE_OFFLINE,
          anilistId: ANI_OFFLINE,
          episodes: [
            { number: 1, progress: { completed: true } },
            { number: 2 },
            { number: 3 },
            { number: 4 },
          ],
        },
      ],
    });

    // ── online baseline ──────────────────────────────────────────────────
    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 30_000 });
    await expectSubscription(ANI_OFFLINE, { status: "watching", currentEpisode: 1 });
    const afterFirstPush = await readSubscription(SEED_USER_EMAIL, ANI_OFFLINE);

    // ── the plane ────────────────────────────────────────────────────────
    await context.setOffline(true);

    // Two more episodes finished with the radio off. Written straight to
    // IndexedDB: raw writes are invisible to Dexie's liveQuery, which is
    // exactly the shape of the scenario — nothing in the running tab reacts,
    // and the only record that the user watched anything is the row itself.
    await writeProgress(page, [
      { episodeId: seedEpisodeId("sync-offline", "main", 2), seriesId: "sync-offline", completed: true },
      { episodeId: seedEpisodeId("sync-offline", "main", 3), seriesId: "sync-offline", completed: true },
    ]);

    // Opening the app on the plane gets nothing — and must corrupt nothing.
    // Asserted rather than swallowed: if this navigation ever quietly succeeds
    // (bfcache, a service worker, a Playwright change), the "offline" premise
    // of everything below it is false and the test should say so.
    const offlineNav = await page.goto("/library").then(
      () => null,
      (err: Error) => err,
    );
    expect(
      offlineNav?.message ?? "navigation unexpectedly succeeded while offline",
    ).toMatch(/net::ERR_/);

    // Node is still online even though the browser context is not, so this
    // reads the real server state: untouched, and — the part that matters —
    // `lastSyncedEpisode` was NOT advanced on a push that never happened.
    expect(
      await readSubscription(SEED_USER_EMAIL, ANI_OFFLINE),
      "an offline session must not move the server",
    ).toMatchObject({ currentEpisode: 1 });

    // ── back on the ground ───────────────────────────────────────────────
    await context.setOffline(false);
    // No repair UI, no retry button, no drained queue: the user simply opens
    // the library again and the difference between the high-water mark and
    // `lastSyncedEpisode` is the entire instruction.
    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 30_000 });
    await expectSubscription(ANI_OFFLINE, { status: "watching", currentEpisode: 3 });

    const afterRepair = await readSubscription(SEED_USER_EMAIL, ANI_OFFLINE);
    expect(afterRepair?.lastWatchedAt?.getTime()).toBeGreaterThan(
      afterFirstPush?.lastWatchedAt?.getTime() ?? 0,
    );

    // ── replay ───────────────────────────────────────────────────────────
    // Same state, same visit, third time. `decidePush` should not even reach
    // the network, so `last_watched_at` must not move — the server-side proof
    // that a monotonic no-op is a true no-op and the activity feed stays quiet.
    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");

    const afterReplay = await readSubscription(SEED_USER_EMAIL, ANI_OFFLINE);
    expect(afterReplay).toMatchObject({ currentEpisode: 3, status: "watching" });
    expect(
      afterReplay?.lastWatchedAt?.getTime(),
      "replaying an already-synced state must be a no-op all the way to the server",
    ).toBe(afterRepair?.lastWatchedAt?.getTime());

    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
