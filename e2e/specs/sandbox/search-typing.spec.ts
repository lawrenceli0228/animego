import { test, expect, type Page } from "@playwright/test";
import { closePg, ensureAnimeCached, removeAnimeFixture } from "../../fixtures/pg";
import { waitForHydration } from "../../fixtures/hydration";

// What typing into /search costs.
//
// The sibling search.spec.ts asks whether a title can be FOUND. This one asks
// what the act of typing does, which used to be a separate and much worse
// story: the filter row pushed a new URL through the Server Component on every
// settled keystroke. Measured against production by typing 进击的巨人 one
// character at a time — four full server round trips for one five-character
// title, no pending state on screen for any of them, and the reply for an
// earlier keystroke rewinding the input so the URL ended up at 进击的人.
//
// A pinyin IME made it worse still. Chrome fires `input` (so React's onChange)
// for every letter of a composition, so the same title also searched for `j`,
// `jin`, `jinj` and `jinji` on the way. Those match nothing in the catalogue
// by construction, which means each one fell through the local query and out
// to AniList — the upstream this project is already rate-limited by.
//
// So the assertions here are about request counts and about what survives in
// the box, NOT about results. That is deliberate: it means this file needs no
// seeded row, and it fails for the reason it is named after rather than
// because a fixture drifted.

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Resolve once React owns the search box.
 *
 * This started as a private function here, written for #129. It is general
 * knowledge — every spec that types is exposed to the same race — so the
 * implementation and the reasoning now live in fixtures/hydration.ts, where
 * globalSetup can reach them too. What stays here is the selector.
 */
const hydrated = (page: Page): Promise<void> =>
  waitForHydration(page, 'input[name="q"]');

/** Every GET /api/anime/search the browser issues from now on. */
function recordSearches(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path === "/api/anime/search") seen.push(decodeURIComponent(req.url()));
  });
  return seen;
}

/** Every full-page navigation from now on. Typing must produce none. */
function recordNavigations(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (req) => {
    if (req.isNavigationRequest() && req.resourceType() === "document") {
      seen.push(req.url());
    }
  });
  return seen;
}

test.describe("typing a title", () => {
  test("costs one request, not one per character", async ({ page }) => {
    await page.goto("/search");
    await hydrated(page);
    const searches = recordSearches(page);
    const navigations = recordNavigations(page);

    const input = page.locator('input[name="q"]');
    await input.click();
    // 500ms between characters is a normal pace for a reader picking each one
    // out of an IME candidate list, and it is what the old 400ms debounce
    // turned into one request per character.
    for (const ch of "进击的巨人") {
      await input.pressSequentially(ch);
      await page.waitForTimeout(500);
    }
    // Longer than the debounce plus a slow round trip, so a straggler would be
    // counted rather than missed.
    await page.waitForTimeout(4_000);

    expect(
      searches,
      "typing one five-character title should not cost five searches",
    ).toHaveLength(1);
    expect(searches[0]).toContain("q=进击的巨人");
    expect(navigations, "typing must not navigate the document").toEqual([]);
  });

  test("does not eat characters typed while a search is in flight", async ({
    page,
  }) => {
    // The regression: the page re-seeded the input from the server's `q` on
    // every response, so typing faster than the round trip rewound the box to
    // an earlier prefix. Typed here with no pauses at all, which is the worst
    // case for that bug and a no-op for a correct implementation.
    await page.goto("/search");
    await hydrated(page);

    const input = page.locator('input[name="q"]');
    await input.click();
    await input.pressSequentially("进击的巨人", { delay: 30 });
    await page.waitForTimeout(4_000);

    await expect(input).toHaveValue("进击的巨人");
    expect(decodeURIComponent(page.url())).toContain("q=进击的巨人");
  });

  test("keeps the URL shareable without pushing a history entry per prefix", async ({
    page,
  }) => {
    await page.goto("/search");
    await hydrated(page);
    const before = await page.evaluate(() => window.history.length);

    const input = page.locator('input[name="q"]');
    await input.click();
    await input.pressSequentially("frieren", { delay: 30 });
    await page.waitForTimeout(4_000);
    expect(page.url()).toContain("q=frieren");

    await input.fill("bleach");
    await page.waitForTimeout(4_000);
    expect(page.url()).toContain("q=bleach");

    // replaceState, not pushState — otherwise Back becomes a slow-motion
    // replay of the typing instead of the way out of the search.
    expect(
      await page.evaluate(() => window.history.length),
      "searching must not grow the history stack",
    ).toBe(before);
  });
});

test.describe("an IME composition", () => {
  test("searches nothing until the character is committed", async ({ page }) => {
    await page.goto("/search");
    await hydrated(page);
    const searches = recordSearches(page);

    const cdp = await page.context().newCDPSession(page);
    await page.locator('input[name="q"]').click();

    // A pinyin composition, letter by letter, with a pause after each that is
    // longer than the pre-fix 400ms debounce. Every one of these produced a
    // search before compositionstart/compositionend were accounted for.
    for (const pinyin of ["j", "ji", "jin", "jinj", "jinji"]) {
      await cdp.send("Input.imeSetComposition", {
        text: pinyin,
        selectionStart: pinyin.length,
        selectionEnd: pinyin.length,
      });
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2_000);

    expect(
      searches,
      "a search fired while the IME was still composing pinyin",
    ).toEqual([]);

    // Anti-vacuity: the guard must suppress the composition, not the feature.
    // Without this, a component that never searched at all would pass above.
    await cdp.send("Input.insertText", { text: "进击" });
    await page.waitForTimeout(4_000);
    expect(searches, "committing the composition should search once").toHaveLength(1);
    expect(searches[0]).toContain("q=进击");
  });
});

test.describe("the ways out of the wait", () => {
  test("Enter searches without sitting through the debounce", async ({ page }) => {
    await page.goto("/search");
    await hydrated(page);
    const searches = recordSearches(page);

    const input = page.locator('input[name="q"]');
    await input.click();
    await input.pressSequentially("frieren", { delay: 10 });
    const pressedAt = Date.now();
    await input.press("Enter");
    await expect
      .poll(() => searches.length, { timeout: 5_000 })
      .toBeGreaterThan(0);

    // The debounce is 1000ms. Anything under that proves Enter skipped it
    // rather than happening to coincide with it.
    expect(Date.now() - pressedAt).toBeLessThan(1_000);
  });

  test("a genre chip searches immediately", async ({ page }) => {
    await page.goto("/search");
    await hydrated(page);
    const searches = recordSearches(page);

    // By aria-pressed rather than by label: the chips are localised, and this
    // spec should not also be a translation test.
    const chip = page.locator('[aria-label="genre filter"] button').first();
    await chip.click();
    await expect
      .poll(() => searches.length, { timeout: 1_000 })
      .toBe(1);
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(page.url()).toContain("genre=");
  });
});

test.describe("turning the page", () => {
  // The one block here that needs rows: pagination only exists above one page
  // of results, and the sandbox catalogue is otherwise a handful of fixtures.
  //
  // It found a real bug and would have been the only thing that could. The
  // debounce compared the whole query — keyword, genre AND page — against what
  // was on screen. The input can only ever express page 1, so a reader on page
  // 2 looked like a pending change back to page 1, and one second after
  // clicking Next they were silently returned to where they started.
  // Serial, so the whole group runs in ONE worker. The suite is
  // fullyParallel: without this, beforeAll seeds in each worker that picks up
  // a test and the first afterAll deletes the rows out from under the others —
  // which reads exactly like the product bug this file is about.
  test.describe.configure({ mode: "serial" });

  const FIRST_ID = 990_401_000;
  const COUNT = 25; // one full page of 20, plus a second page
  const TITLE = "E2E Paging Probe";
  const ids = Array.from({ length: COUNT }, (_, i) => FIRST_ID + i);

  test.beforeAll(async () => {
    for (const [i, anilistId] of ids.entries()) {
      await ensureAnimeCached({
        anilistId,
        titleRomaji: `${TITLE} ${String(i).padStart(2, "0")}`,
        titleChinese: `分页探针${i}`,
        episodes: 12,
      });
    }
  });

  test.afterAll(async () => {
    for (const anilistId of ids) await removeAnimeFixture(anilistId);
    await closePg();
  });

  const pagination = (page: Page) => page.locator('nav[aria-label="search pagination"]');

  test("Next moves to page 2 and stays there", async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent(TITLE)}`);
    await hydrated(page);
    const navigations = recordNavigations(page);

    const nav = pagination(page);
    await expect(nav).toBeVisible();
    // A real href, so middle-click and "open in new tab" still work.
    await expect(nav.locator("a").last()).toHaveAttribute("href", /page=2/);

    await nav.locator("a").last().click();
    await expect(page).toHaveURL(/page=2/);
    await expect(nav).toContainText("2 / 2");

    // The bug was on a timer: page 1 came back one debounce later, so a check
    // that ran immediately would have passed against the broken build.
    await page.waitForTimeout(2_500);
    await expect(page, "the reader was returned to page 1 on their own").toHaveURL(
      /page=2/,
    );
    await expect(nav).toContainText("2 / 2");
    expect(navigations, "turning the page must not reload the document").toEqual([]);
  });

  test("editing the keyword goes back to page 1", async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent(TITLE)}&page=2`);
    await hydrated(page);
    await expect(pagination(page)).toContainText("2 / 2");

    await page.locator('input[name="q"]').fill(`${TITLE} 0`);
    await page.waitForTimeout(3_000);
    // A new search showing page 2 of the previous one would be results the
    // reader never asked for.
    expect(page.url()).not.toContain("page=2");
  });
});

test.describe("the form works before React does", () => {
  // The window between the content appearing (this route streams: the inline
  // $RC script reveals it) and React hydrating it. Typing in that gap reaches
  // the DOM and nothing else — so Enter has to mean something without React.
  test("carries a GET action and a named field, per locale", async ({ page }) => {
    for (const [prefix, action] of [
      ["", "/search"],
      ["/en", "/en/search"],
      ["/zh-Hant", "/zh-Hant/search"],
    ] as const) {
      await page.goto(`${prefix}/search`);
      const form = page.locator("form[role='search']");
      await expect(form).toHaveAttribute("method", "get");
      // Locale-prefixed, or an English reader's pre-hydration Enter would drop
      // them into the Chinese tree.
      await expect(form).toHaveAttribute("action", action);
      await expect(page.locator('input[name="q"]')).toHaveCount(1);
    }
  });
});
