import { test, expect, type Page } from "@playwright/test";
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

/**
 * Did these two rows end up merged, in EITHER direction?
 *
 * Direction-agnostic on purpose. The target is the older row by `createdAt`,
 * and `seedLibrary` assigns those itself — the first series in the list gets
 * the LATER timestamp, so a fixture named for its own intent gets the
 * direction backwards. That is not a detail worth encoding here: which of two
 * duplicates survives is pinned by the unit tests, which set `createdAt`
 * directly. What this file is for is whether the merge happens on mount at
 * all.
 *
 * Checking one side only is how the split test passed while proving nothing:
 * the merge it was supposed to forbid would have been recorded on the row it
 * never looked at.
 */
async function mergedEitherWay(page: Page, a: string, b: string): Promise<boolean> {
  const [rowA, rowB] = await Promise.all([
    readSeriesRow(page, a, "userOverride"),
    readSeriesRow(page, b, "userOverride"),
  ]);
  const inA = (rowA?.mergedFrom as string[] | undefined) ?? [];
  const inB = (rowB?.mergedFrom as string[] | undefined) ?? [];
  return inA.includes(b) || inB.includes(a);
}

const ANILIST_ID = 9200201;
// Named for their place in the fixture, NOT for age: `seedLibrary` assigns
// `createdAt` itself and gives the first entry the later timestamp, so a name
// like "older" would be a lie the reader has to discover from a failure.
const CARD_A = "e2e-dedupe-a";
const CARD_B = "e2e-dedupe-b";

test.describe("/library — duplicate cards", () => {
  test("★ two rows bound to the same title become one card on mount", async ({
    page,
  }) => {
    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        { id: CARD_A, titleZh: "重复卡片 A", anilistId: ANILIST_ID, episodes: [{ number: 1 }] },
        { id: CARD_B, titleZh: "重复卡片 B", anilistId: ANILIST_ID, episodes: [{ number: 2 }] },
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
      .poll(() => mergedEitherWay(page, CARD_A, CARD_B), {
        timeout: 20_000,
        message:
          "the two cards never merged — either the identity key is not being " +
          `resolved, or the sweep does not run on mount. seeded=${JSON.stringify(seeded)}`,
      })
      .toBe(true);
  });

  test("★ a pair the reader split apart is NOT re-merged", async ({ page }) => {
    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        { id: CARD_A, titleZh: "拆开过 A", anilistId: ANILIST_ID, episodes: [{ number: 1 }] },
        {
          id: CARD_B,
          titleZh: "拆开过 B",
          anilistId: ANILIST_ID,
          // Exactly what splitSeries records, on the new row only.
          splitFrom: CARD_A,
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

    expect(
      await mergedEitherWay(page, CARD_A, CARD_B),
      "an automatic merge undid a deliberate split",
    ).toBe(false);
  });
});
