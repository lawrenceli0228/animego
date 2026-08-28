import { test, expect } from "@playwright/test";
import { closePg, ensureAnimeCached, removeAnimeFixture } from "../../fixtures/pg";

// /search — finding a title, and showing it in the reader's script.
//
// The sandbox suite had no search spec at all, which is how two defects lived
// in the same 400-line page at once.
//
//   1. The endpoint was a pure AniList proxy, and AniList does not index
//      Chinese titles. Measured on production: 進擊的巨人 and 鬼滅之刃 both
//      returned zero results while anime_cache held those exact strings.
//      Fixed by searching the local catalogue first.
//
//   2. /zh-Hant/search rendered SIMPLIFIED titles — 12 of 18 cards on
//      production — because the page hand-builds its card object field by
//      field and `titleHant` was not among the fields. Every other surface
//      (home, seasonal, calendar, detail) forwards a row straight through, so
//      the field arrived without anyone having to remember it.
//
// The second only became visible once the first was fixed: before that, a
// Traditional query returned nothing, so there were no cards to render wrongly.
// Worth remembering when a fix seems to "reveal" a new bug.
//
// The unit-level guard for (2) is next-app/src/components/anime/
// cardDataTitles.test.ts, which fails when a hand-built card omits a field the
// ladder reads. This file checks the thing that guard cannot: what reaches the
// DOM.

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

const PROBE_ID = 990_300_001;
// Deliberately not a real title. A shared substring with a seeded fixture or a
// leftover row would let this pass on someone else's data.
const ZH = "测试用番剧进击的巨人";
const HANT = "測試用番劇進擊的巨人";
const ROMAJI = "E2E Search Probe Shingeki";

test.beforeAll(async () => {
  await ensureAnimeCached({
    anilistId: PROBE_ID,
    titleRomaji: ROMAJI,
    titleChinese: ZH,
    titleHant: HANT,
    episodes: 12,
  });
});

test.afterAll(async () => {
  await removeAnimeFixture(PROBE_ID);
  await closePg();
});

/** The probe's card, or null when the search did not find it. */
function probeCard(page: import("@playwright/test").Page) {
  return page.locator(`a[href*="/anime/${PROBE_ID}"]`).first();
}

test.describe("a Chinese title is findable at all", () => {
  // Regression for the AniList-proxy era: these queries returned zero results
  // on production while the row sat in anime_cache the whole time.
  for (const [query, script] of [
    [ZH, "Simplified"],
    [HANT, "Traditional"],
    [ROMAJI, "romaji"],
  ] as const) {
    test(`searching the ${script} title finds it`, async ({ page }) => {
      await page.goto(`/search?q=${encodeURIComponent(query)}`);
      await expect(
        probeCard(page),
        `searching "${query}" did not find the row that literally contains it`,
      ).toBeVisible({ timeout: 20_000 });
    });
  }

  test("a substring of the Traditional title is enough", async ({ page }) => {
    // Not just exact match — the trigram indexes exist so a reader can type
    // part of a name. 進擊的巨人 alone would collide with the real catalogue,
    // so this uses the distinctive half of the probe title.
    await page.goto(`/search?q=${encodeURIComponent("測試用番劇")}`);
    await expect(probeCard(page)).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("the card is titled in the reader's script", () => {
  // The regression this file was added for. Asserted on rendered text rather
  // than on the API payload: the payload was always correct, and the page threw
  // the field away on the way to the card.
  for (const [prefix, expected, other] of [
    ["", ZH, HANT],
    ["/zh-Hant", HANT, ZH],
  ] as const) {
    test(`${prefix || "(bare)"} shows ${expected}`, async ({ page }) => {
      await page.goto(`${prefix}/search?q=${encodeURIComponent(ROMAJI)}`);
      const card = probeCard(page);
      await expect(card).toBeVisible({ timeout: 20_000 });

      await expect(card).toContainText(expected);
      // Both directions. Asserting only the expected string would pass if the
      // card somehow rendered both, and asserting only the absence of the
      // other would pass on an empty card.
      await expect(
        card,
        `${prefix || "(bare)"}/search rendered the wrong script`,
      ).not.toContainText(other);
    });
  }

  test("/en falls back to romaji rather than to Chinese", async ({ page }) => {
    // The en ladder stops after titleEnglish and titleRomaji on purpose — it
    // does NOT fall through to a Chinese title. A probe with no English title
    // is the case that proves it.
    await page.goto(`/en/search?q=${encodeURIComponent(ROMAJI)}`);
    const card = probeCard(page);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(ROMAJI);
    await expect(card).not.toContainText(ZH);
    await expect(card).not.toContainText(HANT);
  });
});

test.describe("the page itself", () => {
  test("answers 200 and declares its locale in all three trees", async ({ page }) => {
    for (const [prefix, lang] of [
      ["", "zh-CN"],
      ["/en", "en"],
      ["/zh-Hant", "zh-Hant"],
    ] as const) {
      const res = await page.goto(`${prefix}/search?q=${encodeURIComponent(ROMAJI)}`);
      expect(res?.status(), `${prefix}/search`).toBe(200);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
    }
  });

  test("a query nobody could match renders the empty state, not an error", async ({
    page,
  }) => {
    const res = await page.goto("/search?q=zzzznosuchanimezzzz");
    expect(res?.status()).toBe(200);
    await expect(page.locator(`a[href*="/anime/"]`)).toHaveCount(0);
  });
});
