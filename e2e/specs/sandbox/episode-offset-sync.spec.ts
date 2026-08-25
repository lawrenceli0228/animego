import { test, expect } from "@playwright/test";
import {
  clearLibrary,
  seedEpisodeId,
  seedLibrary,
  writeProgress,
} from "../../fixtures/dexie-seed";
import {
  closePg,
  ensureAnimeCached,
  readSubscription,
  resetSubscriptions,
  seedPrequelRelation,
} from "../../fixtures/pg";
import { SEED_USER_EMAIL } from "../../globalSetup";

// Cross-season episode numbering, from a library that already has the series.
//
// WHAT THIS EXISTS TO CATCH
//
// Release groups number continuously across seasons. A file holding the finale
// of a 10-episode second season is called 38 on disk when the first season ran
// 28, and 38 is what the watch push used to send — into a range check that
// stops at 10. Every push 400'd, so that season's progress never synced, and
// nothing said so.
//
// Three separate things have to line up for the fix to reach a reader, and the
// first two shipped without the third:
//
//   1. the offset is derivable (PREQUEL edges → 28);
//   2. an already-bound series gets it, which needs a backfill sweep because
//      `resolveSeriesBinding` returns early for one;
//   3. THE RECONCILE RUNS AFTER THAT SWEEP. `reconcileLibrary` latches for the
//      life of the mount and fires before the sweep finishes, so without a
//      re-arm the one visit that matters pushes the untranslated number, takes
//      its 400, and is latched out of ever retrying with the offset the sweep
//      just wrote. The reader sees the exact failure they reported, on the
//      visit that was supposed to fix it.
//
// (3) is why this is an e2e and not a unit test. The ordering lives in React
// effects, and this repo's component tests use `renderToStaticMarkup`, which
// never runs effects at all — the same blind spot the binding sweep's own
// re-arm had to be tested from outside for.
//
// The assertion is deliberately the SERVER's state rather than anything on
// screen: `currentEpisode = 10` can only happen if the number was translated
// before it went on the wire. A 38 would have been rejected, and a grid
// showing "10" while the wire carried 38 is precisely the silent disagreement
// the shared rule in `lib/library/episodeOffset` exists to prevent.

const SEASON_ONE = 9200101; // 28 episodes
const SEASON_TWO = 9200102; // 10 episodes, the one in the library
const SERIES_ID = "e2e-offset-series-001";
const TITLE = "E2E Offset Subject Second Season";

/** 28 episodes of season one precede this season's first. */
const OFFSET = 28;
/** The finale, as the group numbered it: 28 + 10. */
const LOCAL_FINALE = 38;
/** What the season itself calls it, and the only number the server accepts. */
const SITE_FINALE = 10;

test.describe("/library — cross-season episode numbering", () => {
  test.beforeAll(async () => {
    await ensureAnimeCached({
      anilistId: SEASON_ONE,
      titleRomaji: "E2E Offset Subject",
      episodes: OFFSET,
      // The walk sums TV ancestors only. Seeded without this the chain counts
      // nothing and reports offset 0 with full confidence — a plausible wrong
      // answer, which is the failure mode the query's comment calls out.
      format: "TV",
    });
    await ensureAnimeCached({
      anilistId: SEASON_TWO,
      titleRomaji: TITLE,
      episodes: SITE_FINALE,
      format: "TV",
    });
    await seedPrequelRelation(SEASON_TWO, SEASON_ONE);
  });

  test.beforeEach(async () => {
    await resetSubscriptions(SEED_USER_EMAIL, [SEASON_ONE, SEASON_TWO]);
  });

  test.afterAll(async () => {
    await closePg();
  });

  test("★ a continuously-numbered finale syncs as the season's own episode, on the same visit", async ({
    page,
  }) => {
    await page.goto("/welcome");
    await clearLibrary(page);

    // Already bound and already knowing its length — the state of every
    // library that existed before offsets did, and the state in which
    // `resolveSeriesBinding` returns on its first line. No `episodeOffset`:
    // that is what the sweep has to supply.
    await seedLibrary(page, {
      series: [
        {
          id: SERIES_ID,
          titleZh: TITLE,
          titleEn: TITLE,
          anilistId: SEASON_TWO,
          totalEpisodes: SITE_FINALE,
          episodes: [{ number: LOCAL_FINALE }],
        },
      ],
    });
    await writeProgress(page, [
      {
        episodeId: seedEpisodeId(SERIES_ID, "main", LOCAL_FINALE),
        seriesId: SERIES_ID,
        completed: true,
      },
    ]);

    expect(await readSubscription(SEED_USER_EMAIL, SEASON_TWO)).toBeNull();

    // Count, do not intercept — a re-arm that fires on every liveQuery
    // emission looks like a push storm from out here, and the sweep's own
    // writes change the series list this effect depends on.
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
          (await readSubscription(SEED_USER_EMAIL, SEASON_TWO))?.currentEpisode ?? null,
        {
          timeout: 30_000,
          message:
            "never reached the server as episode 10 — either the offset was not " +
            "backfilled, or the reconcile was not re-armed after it was",
        },
      )
      .toBe(SITE_FINALE);

    // Bound after settling. Two is the honest ceiling for one series: the
    // first PUT 404s with no subscription, `ensureSubscription` creates one,
    // and the push retries. A third would mean the reconcile ran again for
    // nothing.
    await page.waitForTimeout(3_000);
    expect(
      episodePushes,
      `expected at most two pushes, saw ${episodePushes}`,
    ).toBeLessThanOrEqual(2);
  });

  test("a season with nothing before it is not shifted", async ({ page }) => {
    // The other half of the rule, and the reason the endpoint returns
    // `{known, offset}` rather than a nullable number: season one's offset is
    // a confident 0, and 0 must move nothing. If "no prequel" were treated as
    // "unknown" this would still pass; if 0 were applied as a shift it would
    // not.
    const soloSeries = "e2e-offset-series-002";
    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        {
          id: soloSeries,
          titleZh: "E2E Offset Subject",
          titleEn: "E2E Offset Subject",
          anilistId: SEASON_ONE,
          totalEpisodes: OFFSET,
          episodes: [{ number: 3 }],
        },
      ],
    });
    await writeProgress(page, [
      {
        episodeId: seedEpisodeId(soloSeries, "main", 3),
        seriesId: soloSeries,
        completed: true,
      },
    ]);

    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () =>
          (await readSubscription(SEED_USER_EMAIL, SEASON_ONE))?.currentEpisode ?? null,
        { timeout: 30_000, message: "episode 3 of a first season should sync as 3" },
      )
      .toBe(3);
  });
});
