import { test, expect, type Page } from "@playwright/test";
import { waitForHydration } from "../../fixtures/hydration";
import { closePg } from "../../fixtures/pg";
import {
  TOP_BASE_ID,
  TOP_NEVER,
  TOP_NO_RANKING_YEAR,
  TOP_OLD,
  TOP_OLD_YEAR,
  TOP_RANKED,
  TOP_YEAR,
  seedTopRankings,
  topTitle,
  type TopShow,
} from "../../fixtures/topRankings";
import { collectConsoleErrors, navbar } from "../_helpers";

/**
 * The rankings (/top, /top/{year}) on a catalogue of their own: 27 rankable
 * 2019 shows, five 2019 shows that must never be ranked, and a 1955 for the
 * 更早 menu (fixtures/topRankings.ts says what each one is for). globalSetup
 * seeds it before any spec runs: the list of ranked years is one cached answer
 * for the whole site, and other specs ask for it first.
 *
 * The leaders score 95 and up, above anything another spec seeds (94 at
 * most), so the all-time ranking opens on them whatever else is in the
 * shard's database. Nothing depends on the clock but the strip's window,
 * which holds 2019 until 2031. The rows are the same on every run, so the
 * pages' cached answers can never disagree with this file.
 */

test.describe.configure({ mode: "default" });
// Read in Simplified Chinese, the site's own language: an English browser
// would be offered the English page in a card over the content.
test.use({ locale: "zh-CN" });

const BASE_ID = TOP_BASE_ID;
const YEAR = TOP_YEAR;
const OLD_YEAR = TOP_OLD_YEAR;
const NO_RANKING_YEAR = TOP_NO_RANKING_YEAR;
const RANKED = TOP_RANKED;
const NEVER = TOP_NEVER;
const OLD = TOP_OLD;
const title = topTitle;

/** The ranking rule, written out: score, then popularity, then id. */
function ranked(shows: readonly TopShow[]): number[] {
  return [...shows]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.popularity - a.popularity || a.id - b.id)
    .map((s) => s.id);
}

// globalSetup has seeded these already; seeding again (an upsert) keeps the
// spec whole when it is run on a database whose setup predates the fixture.
test.beforeAll(async () => {
  await seedTopRankings();
});

test.afterAll(async () => {
  await closePg();
});

const GET = { timeout: 30_000 };

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await waitForHydration(page, "[data-top-page]");
}

/** The ids of every ranked card on the page, in order — the hidden ones included. */
const cardIds = (page: Page) =>
  page.locator("[data-results] [data-anime-card]").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-id"))));
const visibleCards = (page: Page) => page.locator("[data-results] [data-anime-card]:visible");

test.describe("a year's ranking on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Shanghai" });

  test("ranks by score, then popularity, then id — and never the five that do not count", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await open(page, `/top/${YEAR}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${YEAR} 年度 Top 100`);
    const expected = ranked(RANKED);
    expect(await cardIds(page)).toEqual(expected);
    for (const s of NEVER) await expect(page.locator(`[data-id="${s.id}"]`)).toHaveCount(0);
    // Each place, read before the title and drawn on the cover.
    const first = page.locator(`[data-id="${expected[0]}"]`);
    await expect(first.getByRole("link", { name: `第 1 名 ${title(expected[0] ?? 0)}` })).toBeVisible();
    await expect(first.locator("[data-rank]")).toHaveText("#1");
    await expect(page.locator(`[data-id="${expected[26]}"] [data-rank]`)).toHaveText("#27");
    // The film without a season is 2019's, by its premiere.
    expect(expected).toContain(BASE_ID + 30);
    expect(errors).toEqual([]);
  });

  test("twenty at first; 显示更多 shows the rest, and then is gone", async ({ page }) => {
    await open(page, `/top/${YEAR}`);
    await expect(visibleCards(page)).toHaveCount(20);
    const more = page.locator("[data-load-more]");
    await expect(more).toContainText("还有 7 部");
    await more.click();
    await expect(visibleCards(page)).toHaveCount(27);
    await expect(more).toHaveCount(0);
  });

  test("the format, genre and season filters are links, and each re-ranks what it leaves", async ({ page }) => {
    await open(page, `/top/${YEAR}`);
    const movies = RANKED.filter((s) => s.format === "MOVIE");
    await page.locator('[data-top-filters] a[data-option="format:MOVIE"]').click();
    await page.waitForURL(`**/top/${YEAR}?format=movie`);
    await waitForHydration(page, '[data-option="format:MOVIE"][aria-current="page"]');
    expect(await cardIds(page)).toEqual(ranked(movies));
    await expect(page.locator(`[data-id="${ranked(movies)[0]}"] [data-rank]`)).toHaveText("#1");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    await page.locator("[data-genre-picker]").click();
    await page.locator('[data-genre-menu] a[data-option="genre:Comedy"]').click();
    await page.waitForURL(`**/top/${YEAR}?format=movie&genre=comedy`);
    await waitForHydration(page, '[data-genre-picker][data-on="true"]');
    expect(await cardIds(page)).toEqual(ranked(movies.filter((s) => s.genres.includes("Comedy"))));

    await page.locator('[data-top-filters] a[data-option="format:all"]').click();
    await page.waitForURL(`**/top/${YEAR}?genre=comedy`);
    await waitForHydration(page, '[data-option="format:all"][aria-current="page"]');
    await page.locator('[data-top-filters] a[data-option="season:FALL"]').click();
    await page.waitForURL(`**/top/${YEAR}?genre=comedy&season=fall`);
    await waitForHydration(page, '[data-option="season:FALL"][aria-current="page"]');
    expect(await cardIds(page)).toEqual(ranked(RANKED.filter((s) => s.genres.includes("Comedy") && s.season === "FALL")));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${YEAR} 年度 Top 100`);
  });

  test("the header is the next ranking's at once, and the page that lands does not fade it in again", async ({ page }) => {
    await open(page, `/top/${YEAR}`);
    await page.route(/\/top\?/, async (route) => {
      await new Promise((r) => setTimeout(r, 1_200));
      await route.continue();
    });
    await page.route(/\/top$/, async (route) => {
      await new Promise((r) => setTimeout(r, 1_200));
      await route.continue();
    });
    const heading = await watchOpacity(page, "[data-top-head]");
    await page.locator('[data-top-strip] a[data-year="all"]').click();
    // Before the page lands: the heading, the strip's block and the skeleton.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("历代 Top 100");
    await expect(page.locator("[data-strip-indicator]")).toHaveAttribute("data-strip-indicator", "all");
    await expect(page.locator("[data-skeleton]")).toBeVisible();
    await page.waitForURL((url) => url.pathname === "/top");
    await expect(page.locator("[data-skeleton]")).toHaveCount(0);
    await expect(page.locator('[data-top-page="all"]')).toBeVisible();
    expect((await heading()).at(-1)).toBe(1);
  });

  test("three views of the same ranking; the address keeps the reader's choice", async ({ page }) => {
    await open(page, `/top/${YEAR}`);
    const expected = ranked(RANKED);
    await page.locator('[data-view-toggle="chart"]').click();
    await expect(page).toHaveURL(new RegExp(`/top/${YEAR}\\?view=chart$`));
    await expect(page.locator("[data-charts] [data-anime-card]").first()).toBeVisible();
    expect(await cardIds(page)).toEqual(expected);
    await expect(page.locator(`[data-charts] [data-id="${expected[1]}"] [data-rank]`)).toHaveText("#2");
    await page.locator('[data-view-toggle="table"]').click();
    await expect(page).toHaveURL(new RegExp(`/top/${YEAR}\\?view=table$`));
    await expect(page.locator("[data-rows] [data-anime-card]").first()).toBeVisible();
    await expect(page.locator(`[data-rows] [data-id="${expected[2]}"] [data-rank]`)).toHaveText("#3");
    // A reload draws the chosen view, and a filter link carries it along.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-rows]")).toBeVisible();
    await expect(page.locator('[data-top-filters] a[data-option="format:TV"]')).toHaveAttribute(
      "href",
      `/top/${YEAR}?format=tv&view=table`,
    );
    await page.locator('[data-view-toggle="grid"]').click();
    await expect(page).toHaveURL(new RegExp(`/top/${YEAR}$`));
    await expect(page.locator("[data-grid]")).toBeVisible();
  });

  test("after a change of view, the batches open are still open on the way back", async ({ page }) => {
    await open(page, `/top/${YEAR}`);
    await page.locator('[data-view-toggle="chart"]').click();
    await expect(page).toHaveURL(new RegExp(`/top/${YEAR}\\?view=chart$`));
    await page.locator("[data-load-more]").click();
    await expect(visibleCards(page)).toHaveCount(27);
    // Away by a link in the page (a client navigation), and Back.
    await navbar(page).locator('a[href="/welcome"]').click();
    await page.waitForURL("**/welcome");
    await page.goBack();
    await page.waitForURL(new RegExp(`/top/${YEAR}\\?view=chart$`));
    await expect(page.locator("[data-charts]")).toBeVisible();
    await expect(visibleCards(page)).toHaveCount(27);
    await expect(page.locator("[data-load-more]")).toHaveCount(0);
  });

  test("更早 opens the years before the strip's; an older year shows itself in that cell", async ({ page }) => {
    await open(page, `/top/${YEAR}`);
    const older = page.locator("[data-older]");
    await older.click();
    await expect(older).toHaveAttribute("aria-expanded", "true");
    const link = page.locator(`[data-older-years] a[data-year="${OLD_YEAR}"]`);
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(`**/top/${OLD_YEAR}`);
    await waitForHydration(page, `[data-top-page="${OLD_YEAR}"]`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${OLD_YEAR} 年度 Top 100`);
    await expect(page.locator("[data-older]")).toHaveText(String(OLD_YEAR));
    await expect(page.locator("[data-older]")).toHaveAttribute("aria-current", "page");
    expect(await cardIds(page)).toEqual(ranked(OLD));
  });

  test("the all-time ranking opens on the best of every year", async ({ page }) => {
    await open(page, "/top");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("历代 Top 100");
    const leaders = ranked(RANKED.filter((s) => (s.score ?? 0) >= 95));
    expect((await cardIds(page)).slice(0, leaders.length)).toEqual(leaders);
    await expect(page.locator('[data-top-strip] a[data-year="all"]')).toHaveAttribute("aria-current", "page");
    // No season chips without a year.
    await expect(page.locator('[data-option^="season:"]')).toHaveCount(0);
    // 排行 in the bar is current here.
    await expect(navbar(page).locator('a[href="/top"]')).toHaveAttribute("aria-current", "page");
  });
});

test.describe("status codes", () => {
  test("the old year page answers 308 to its ranking; a year with nothing ranked is a 404 either way", async ({ request }) => {
    const target = (res: { headers(): Record<string, string> }) => new URL(res.headers()["location"] ?? "", "http://x").pathname;
    const old = await request.get(`/year/${YEAR}?page=3`, { ...GET, maxRedirects: 0 });
    expect(old.status()).toBe(308);
    expect(target(old)).toBe(`/top/${YEAR}`);
    const en = await request.get(`/en/year/${YEAR}`, { ...GET, maxRedirects: 0 });
    expect(en.status()).toBe(308);
    expect(target(en)).toBe(`/en/top/${YEAR}`);
    expect((await request.get(`/year/${NO_RANKING_YEAR}`, { ...GET, maxRedirects: 0 })).status()).toBe(404);
    expect((await request.get(`/top/${NO_RANKING_YEAR}`, GET)).status()).toBe(404);
    expect((await request.get("/top/abcd", GET)).status()).toBe(404);
    // A filter that names nothing is no filter, never a server error.
    const odd = await request.get(`/top/${YEAR}?format=constructor&genre=__proto__&season=toString`, GET);
    expect(odd.status()).toBe(200);
    const html = await odd.text();
    expect(html).toMatch(/<link rel="canonical" href="[^"]*\/top\/2019"/);
    expect(html).not.toMatch(/<meta name="robots" content="noindex/);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Asia/Shanghai" });

  test("three covers to a row, a strip that scrolls to its year, nothing wider than the screen", async ({ page }) => {
    await open(page, `/top/${YEAR}`);
    const cards = visibleCards(page);
    await expect(cards).toHaveCount(21);
    const tops = await cards.evaluateAll((els) => els.slice(0, 4).map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(tops[0]).toBe(tops[1]);
    expect(tops[1]).toBe(tops[2]);
    expect(tops[3]).toBeGreaterThan(tops[0] ?? Infinity);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // The strip's cells keep their width and the strip scrolls sideways in a
    // box of its own (how far depends on how many years the shard's database
    // ranks); 2019 is in view.
    const strip = await page.locator("[data-top-strip]").evaluate((nav) => {
      const scroller = nav.parentElement as HTMLElement;
      const cell = nav.querySelector('[data-on="true"]') as HTMLElement;
      const box = scroller.getBoundingClientRect();
      const at = cell.getBoundingClientRect();
      return {
        overflowX: getComputedStyle(scroller).overflowX,
        cellWidth: Math.round(at.width),
        inView: at.left >= box.left - 1 && at.right <= box.right + 1,
      };
    });
    expect(strip).toEqual({ overflowX: "auto", cellWidth: 64, inView: true });
    // A phone offers the grid and the list, no chart.
    await expect(page.locator('[data-view-toggle="chart"]')).toBeHidden();
  });

  test("the list: place, cover, title over when and what, score", async ({ page }) => {
    await open(page, `/top/${YEAR}`);
    await page.locator('[data-view-toggle="table"]').click();
    const first = page.locator("[data-rows] [data-anime-card]").first();
    await expect(first).toBeVisible();
    // The phone's column is the bare number (its "#" is not drawn).
    await expect(first.locator("[data-rank]")).toHaveText("1", { useInnerText: true });
    await expect(page.locator("[data-rows] [data-anime-card]:visible")).toHaveCount(20);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("the drawer lists 排行", async ({ page }) => {
    await open(page, "/top");
    await page.locator('button[aria-label="打开菜单"]').click();
    const drawer = page.getByRole("dialog", { name: "菜单" });
    await expect(drawer.getByRole("link", { name: "排行" })).toHaveAttribute("href", "/top");
  });
});

/**
 * Watch the element matching `selector` frame by frame from now on (the
 * genre spec's helper): for each element that comes to match it, the lowest
 * opacity it was drawn at, its ancestors' included.
 */
async function watchOpacity(page: Page, selector: string): Promise<() => Promise<number[]>> {
  const key = await page.evaluate((sel) => {
    const drawn: { el: Element; min: number }[] = [];
    const key = `__opacity${Math.random().toString(36).slice(2)}`;
    (window as unknown as Record<string, unknown>)[key] = drawn;
    const seen = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return Math.round(o * 1000) / 1000;
    };
    const tick = () => {
      const el = document.querySelector(sel);
      if (el) {
        const last = drawn.at(-1);
        if (last?.el === el) last.min = Math.min(last.min, seen(el));
        else drawn.push({ el, min: seen(el) });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return key;
  }, selector);
  return () =>
    page.evaluate(
      (k) =>
        new Promise<number[]>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(((window as unknown as Record<string, { min: number }[]>)[k] ?? []).map((d) => d.min)),
            ),
          ),
        ),
      key,
    );
}
