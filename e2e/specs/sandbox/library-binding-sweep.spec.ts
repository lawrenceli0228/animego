import { test, expect } from "@playwright/test";
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
} from "../../fixtures/pg";
import { SEED_USER_EMAIL } from "../../globalSetup";

// The binding sweep: unbound series get resolved on library mount.
//
// WHAT THIS EXISTS TO CATCH
//
// Watch-progress sync hangs off `Series.anilistId`, and until this change the
// only things that could write one were three user actions — clicking a card,
// opening the single-series route, entering the player. A card nobody clicked
// was never bound, was therefore skipped by every reconcile, and failed
// silently forever. Measured on a real library: 19 of 26 series had no binding
// at all, and 18 of those 19 resolved through the existing matcher at an exact
// score. Nobody had ever asked.
//
// So the two facts under test are ones no unit test can establish, because
// both are about a browser actually mounting the page:
//
//   1. a series nobody touched gets bound — no click anywhere in the test;
//   2. it SYNCS ON THE SAME VISIT. This is the half that is easy to get wrong
//      and impossible to notice: `reconcileLibrary` latches for the life of
//      the mount, so a sweep that binds and does not re-arm it leaves every
//      newly-bound series unpushed until the reader comes back. From their
//      seat, opening the library would appear to do nothing at all.
//
// The search is intercepted rather than hit for real. The point of these two
// is the trigger and the ordering, not dandanplay's matching — that is covered
// by unit tests against the real matcher, and a live search would make the
// spec depend on an upstream catalogue that changes under it.

const ANILIST_ID = 9200001;
const SERIES_ID = "e2e-sweep-series-001";
const TITLE = "E2E Sweep Subject";

test.describe("/library — binding sweep", () => {
  test.beforeAll(async () => {
    await ensureAnimeCached({
      anilistId: ANILIST_ID,
      titleRomaji: TITLE,
      episodes: 12,
    });
  });

  test.beforeEach(async () => {
    await resetSubscriptions(SEED_USER_EMAIL, [ANILIST_ID]);
  });

  test.afterAll(async () => {
    await closePg();
  });

  /**
   * One animeCache row whose Chinese title equals the query.
   *
   * `pickBestHit` folds both sides and requires the season/part ordinals to
   * agree, so an exact-equal title with no ordinal on either side is the
   * unambiguous case — which is what keeps this spec about the trigger rather
   * than about scoring.
   */
  async function stubSearch(page: import("@playwright/test").Page) {
    await page.route("**/api/dandanplay/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [
            {
              source: "animeCache",
              anilistId: ANILIST_ID,
              titleChinese: TITLE,
              titleRomaji: TITLE,
              episodes: 12,
            },
          ],
        }),
      });
    });
  }

  test("binds a series nobody clicked, on mount", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await stubSearch(page);

    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [{ id: SERIES_ID, titleZh: TITLE, titleEn: TITLE }],
    });

    // Precondition, asserted rather than assumed: the fixture must leave this
    // series UNBOUND, or the test proves nothing.
    const before = await readSeriesRow(page, SERIES_ID);
    expect(before?.anilistId).toBeUndefined();

    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 10_000 });

    // No click, no navigation to the series, no player. Just the mount.
    await expect
      .poll(async () => (await readSeriesRow(page, SERIES_ID))?.anilistId, {
        timeout: 20_000,
        message: "the sweep never wrote a binding for an untouched series",
      })
      .toBe(ANILIST_ID);

    await page.waitForLoadState("networkidle");
    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("★ the newly-bound series reaches the server on the SAME visit", async ({
    page,
  }) => {
    // The re-arm. Without it the binding lands and the push waits for the next
    // mount — which is indistinguishable, from the reader's side, from the bug
    // this whole change exists to fix.
    await stubSearch(page);

    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        {
          id: SERIES_ID,
          titleZh: TITLE,
          titleEn: TITLE,
          episodes: [{ number: 1 }, { number: 2 }],
        },
      ],
    });
    // Two finished episodes, so there is something for the reconcile to push
    // once the binding exists. Without progress the reconcile has nothing to
    // do and the test would pass for the wrong reason.
    await writeProgress(page, [
      {
        episodeId: seedEpisodeId(SERIES_ID, "main", 1),
        seriesId: SERIES_ID,
        completed: true,
      },
      {
        episodeId: seedEpisodeId(SERIES_ID, "main", 2),
        seriesId: SERIES_ID,
        completed: true,
      },
    ]);

    expect(await readSubscription(SEED_USER_EMAIL, ANILIST_ID)).toBeNull();

    // Count, do not intercept. The re-arm clears a latch that guards an effect
    // whose dependency list includes `series` — and the sweep's own writes
    // change `series`. Get that wrong and the reconcile re-runs on every
    // liveQuery emission, which from the outside looks like a push storm.
    //
    // This is the only automated check on that: the re-arm lives in a React
    // effect, and this repo's render tests use `renderToStaticMarkup`, which
    // never runs effects at all. The guard is also structurally redundant with
    // the sweep's own once-per-mount latch — but redundant is not tested.
    let episodePushes = 0;
    page.on("request", (req) => {
      if (req.method() === "PUT" && /\/api\/subscriptions\/\d+\/episodes/.test(req.url())) {
        episodePushes += 1;
      }
    });

    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () =>
          (await readSubscription(SEED_USER_EMAIL, ANILIST_ID))?.currentEpisode ?? null,
        {
          timeout: 30_000,
          message:
            "bound but never pushed — reconcileLibrary was not re-armed after the sweep",
        },
      )
      .toBe(2);

    // Settle, then bound it. Two is the honest ceiling for one series: the
    // first PUT 404s because no subscription exists yet, `ensureSubscription`
    // creates one, and the push is retried. A third would mean the reconcile
    // ran again for no reason; a loop would be far past this.
    await page.waitForTimeout(3_000);
    expect(
      episodePushes,
      `re-arm should fire once — saw ${episodePushes} episode pushes`,
    ).toBeLessThanOrEqual(2);
  });

  test("a series that is already bound costs no search at all", async ({ page }) => {
    // The convergence property, from the outside: the candidate set is derived
    // from the rows, so a bound series is not a candidate and the sweep does
    // not spend a request on it. This is what stops the liveQuery that the
    // sweep's own writes re-trigger from looping.
    let searches = 0;
    await page.route("**/api/dandanplay/search**", async (route) => {
      searches += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ results: [] }),
      });
    });

    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        { id: SERIES_ID, titleZh: TITLE, titleEn: TITLE, anilistId: ANILIST_ID },
      ],
    });

    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    // Give the sweep a beat to have run, so "zero" means "declined to run"
    // rather than "had not started yet".
    await page.waitForTimeout(2_000);

    expect(searches, "a bound series must not be searched for").toBe(0);
  });
});
