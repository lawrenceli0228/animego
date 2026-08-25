import { test, expect } from "@playwright/test";
import { clearLibrary, readSeriesRow, seedLibrary } from "../../fixtures/dexie-seed";

// Duplicate cards for the same title, merged on library mount.
//
// WHY IT STOPPED WORKING
//
// The pass grouped on `Season.animeId`. #105 removed the fallback filling that
// field — the value was a bgm.tv subject id in a dandanplay-shaped column, so
// it was not a fallback but the only branch that ever fired — and correctly
// so. It left this pass with nothing to group by: an automatically imported
// series has no `Season.animeId` at all, so two cards for one show never met.
// `Series.anilistId` is the key now, and #105's binding sweep is also what
// made it reliably present.
//
// WHY THIS IS AN E2E
//
// The unit tests cover the grouping rules, the id-space namespacing and the
// split guard. What they cannot see is the part that decides whether a reader
// ever benefits: whether the merge runs at all on mount, and in an order where
// the bindings the binding sweep writes are visible to it. That lives in React
// effects, and this repo's component tests use `renderToStaticMarkup`, which
// never runs effects.
//
// The second test is the one that would matter most if it regressed. Automatic
// merging is only safe because a deliberate split survives it — an automatic
// action undoing a manual one, on every visit, with no way for the reader to
// make it stop, is worse than not automating at all.

const ANILIST_ID = 9200201;
const OLDER = "e2e-dedupe-older";
const NEWER = "e2e-dedupe-newer";

test.describe("/library — duplicate cards", () => {
  test("★ two rows bound to the same title become one card on mount", async ({
    page,
  }) => {
    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        { id: OLDER, titleZh: "重复卡片 A", anilistId: ANILIST_ID, episodes: [{ number: 1 }] },
        { id: NEWER, titleZh: "重复卡片 B", anilistId: ANILIST_ID, episodes: [{ number: 2 }] },
      ],
    });

    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 10_000 });

    // Prove the premise before asserting the conclusion. If the seed did not
    // write `anilistId`, nothing downstream could group these two and the
    // real failure would be reported as "the sweep did not run".
    const seeded = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((ok, no) => {
        const r = indexedDB.open("animego-library");
        r.onsuccess = () => ok(r.result);
        r.onerror = () => no(r.error);
      });
      const all = (store: string) =>
        new Promise<unknown[]>((ok) => {
          const q = db.transaction(store, "readonly").objectStore(store).getAll();
          q.onsuccess = () => ok(q.result as unknown[]);
          q.onerror = () => ok([]);
        });
      const [series, overrides] = await Promise.all([all("series"), all("userOverride")]);
      db.close();
      return {
        stores: Array.from(db.objectStoreNames),
        series: (series as Array<Record<string, unknown>>).map((r) => ({
          id: r.id,
          anilistId: r.anilistId,
          createdAt: r.createdAt,
        })),
        overrides,
      };
    });
    expect(
      seeded.series.map((r) => r.anilistId),
      `seeded rows lack the grouping key: ${JSON.stringify(seeded)}`,
    ).toEqual([ANILIST_ID, ANILIST_ID]);

    // The merge is SOFT: no row moves, and the only record it leaves is
    // `mergedFrom` on the target. Asserting the record rather than the card
    // count is what makes this test independent of how the grid chooses to
    // hide a merged-away row.
    await expect
      .poll(
        async () => {
          const row = await readSeriesRow(page, OLDER, "userOverride");
          return (row?.mergedFrom as string[] | undefined) ?? null;
        },
        {
          timeout: 20_000,
          message:
            "the two cards never merged — either the identity key is not being " +
            `resolved, or the sweep does not run on mount. seeded=${JSON.stringify(seeded)}`,
        },
      )
      .toContain(NEWER);
  });

  test("★ a pair the reader split apart is NOT re-merged", async ({ page }) => {
    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        { id: OLDER, titleZh: "拆开过 A", anilistId: ANILIST_ID, episodes: [{ number: 1 }] },
        {
          id: NEWER,
          titleZh: "拆开过 B",
          anilistId: ANILIST_ID,
          // Exactly what splitSeries records, on the new row only.
          splitFrom: OLDER,
          episodes: [{ number: 2 }],
        },
      ],
    });

    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 10_000 });

    // No polling for an absence — wait out the window the merge would have
    // happened in, then assert nothing did. Polling for "still not merged"
    // passes instantly and proves nothing.
    await page.waitForTimeout(8_000);

    const row = await readSeriesRow(page, OLDER, "userOverride");
    expect(
      (row?.mergedFrom as string[] | undefined) ?? [],
      "an automatic merge undid a deliberate split",
    ).not.toContain(NEWER);
  });
});
