import { test, expect, type Page } from "@playwright/test";
import { waitForHydration } from "../../fixtures/hydration";
import { closePg } from "../../fixtures/pg";
import { removeSeasonFixture, seedSeason, type SeasonEnum, type SeedSeasonRow } from "../../fixtures/seasonal";
import { collectConsoleErrors } from "../_helpers";

/**
 * The genre page (/genre/{slug}): the hub and its grid views, on a genre of
 * its own — 机战 (Mecha) — that no other spec seeds, so every count below is
 * this file's rows and nothing else.
 *
 *   45 shows, popularity falling with the index (so the popular order is
 *   the index order), scores all different (so the top ten is a known
 *   permutation), seven of them airing, ten from this year and last, the rest
 *   spread over every decade down to the 1960s. Each also carries some of
 *   seven other genres in different numbers (and an eighth, too rare to be
 *   shown), and one of seven main studios, again in different numbers.
 *
 * Nothing else depends on the clock: no show has a next episode, and the ten
 * recent ones are dated this year and last (on the site's clock), inside the
 * page's "recent" (from six years back) whenever the suite runs. The rows are
 * the same on every run and retry of a day, so the page's cached answers can
 * never disagree with this file. What is pinned: the hub's sections and their links in the server
 * HTML; 查看全部 → the grid → back; show more by press and by scrolling; the
 * decade, related-genre and studio tiles; the strip moving before the next
 * genre arrives; the popover; the phone's tracks; the old ?page=N's redirect;
 * each view's canonical; and the status codes.
 */

test.describe.configure({ mode: "default" });

const BASE_ID = 990_700_000;
const COUNT = 45;
const GENRE = "Mecha";
const HUB = "/genre/mecha";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** This year on the site's clock (UTC+8), where the page's "recent" is counted from. */
const THIS_YEAR = new Date(Date.now() + 8 * 3_600_000).getUTCFullYear();
/** The first year "recent" covers: six years back, as the API counts it. */
const RECENT_FROM = THIS_YEAR - 6;

/** Release years: ten recent, then 8 / 8 / 6 / 5 / 4 down the decades, and four before 1970. */
function yearOf(i: number): number {
  if (i < 10) return THIS_YEAR - (i % 2);
  if (i < 18) return 2011 + (i - 10);
  if (i < 26) return 2001 + (i - 18);
  if (i < 32) return 1991 + (i - 26);
  if (i < 37) return 1981 + (i - 32);
  if (i < 41) return 1971 + (i - 37);
  return 1961 + (i - 41);
}

/** The other genres, each in a different number of shows (15, 11, 9, 7, 6, 4, 3 — and 2, an eighth). */
const CO_GENRES: ReadonlyArray<[string, (i: number) => boolean]> = [
  ["Sports", (i) => i % 3 === 0],
  ["Thriller", (i) => i % 4 === 1],
  ["Psychological", (i) => i % 5 === 2],
  ["Supernatural", (i) => i % 6 === 4],
  ["Music", (i) => i % 8 === 3],
  ["Horror", (i) => i % 11 === 6],
  ["Mystery", (i) => i % 15 === 7],
  ["Mahou Shoujo", (i) => i % 20 === 9],
];

/** Main studios in different numbers: 12, 10, 8, 6, 4, 3, 2. */
const STUDIOS: ReadonlyArray<[string, number]> = [
  ["E2E 机甲工房", 12],
  ["E2E Gear Studio", 10],
  ["E2E Orbit Works", 8],
  ["E2E Piston", 6],
  ["E2E Rivet & Bolt", 4],
  ["E2E Servo", 3],
  ["E2E Torque", 2],
];

function studioOf(i: number): string {
  let left = i;
  for (const [name, n] of STUDIOS) {
    if (left < n) return name;
    left -= n;
  }
  throw new Error(`no studio for ${i}`);
}

const SEASONS: readonly SeasonEnum[] = ["WINTER", "SPRING", "SUMMER", "FALL"];

/**
 * Every show's cover: a local image the page shows as it is. The query string
 * keeps it away from the image optimizer (FadeImage leaves a local src with a
 * query unoptimized), which under `next dev`, asked for one variant by dozens
 * of cards at once, has been seen to stall that variant for good — and with
 * it the page's load event.
 */
const COVER = "/mascot-wink.png?e2e=genre";
const ACCENTS = ["#3b6fe0", "#d9483b", "#3bd96f", "#d9b23b", null] as const;

interface Show extends SeedSeasonRow {
  year: number;
  genres: string[];
  studio: string;
}

const SHOWS: Show[] = Array.from({ length: COUNT }, (_, i) => {
  const year = yearOf(i);
  return {
    anilistId: BASE_ID + i,
    season: SEASONS[i % 4] as SeasonEnum,
    seasonYear: year,
    titleChinese: `机战测 ${pad2(i)}`,
    titleRomaji: `Kisen Probe ${pad2(i)}`,
    titleEnglish: `Mecha Probe ${pad2(i)}`,
    posterAccent: ACCENTS[i % ACCENTS.length] ?? null,
    coverImageUrl: COVER,
    // (i × 17) mod 45 runs through 0…44 once each: every score different.
    averageScore: 50 + ((i * 17) % 45),
    episodes: 12,
    status: i < 7 ? "RELEASING" : "FINISHED",
    format: "TV",
    popularity: 200_000 - i * 1_000,
    favourites: 100,
    source: "ORIGINAL",
    startDate: `${year}-04-0${(i % 9) + 1}`,
    duration: 24,
    genres: [GENRE, ...CO_GENRES.filter(([, has]) => has(i)).map(([g]) => g)],
    studio: studioOf(i),
    year,
  };
});

const IDS = SHOWS.map((s) => s.anilistId);
const count = (pred: (s: Show, i: number) => boolean) => SHOWS.filter(pred).length;
const hasGenre = (g: string) => (s: Show) => s.genres.includes(g);
const decadeOf = (y: number) => (y < 1970 ? "old" : String(Math.floor(y / 10) * 10));
const byScore = [...SHOWS].sort((a, b) => (b.averageScore ?? 0) - (a.averageScore ?? 0));

test.beforeAll(async () => {
  await seedSeason(SHOWS);
});

test.afterAll(async () => {
  await removeSeasonFixture(IDS);
  await closePg();
});

/**
 * Open a page and wait until React owns it. Not until `load`: that waits for
 * every cover the dev server's image optimizer encodes, which is not what is
 * under test and, three workers deep, can outlast a test's budget.
 */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await waitForHydration(page, "[data-genre-page]");
}

/** A server-HTML request's budget: under three workers the dev server can be slow to answer the first. */
const GET = { timeout: 30_000 };

/**
 * Watch the elements matching `selector` frame by frame from now on: for each
 * element that comes to match it (a route change mounts the page afresh, so
 * the arriving page's header is a new one), the lowest opacity it was drawn
 * at — its own times its ancestors', as the reader sees it.
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
  // Read after two more frames, so the element just mounted has been drawn.
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

const cardsIn = (page: Page, scope: string) => page.locator(`${scope} [data-anime-card]`);
const gridCards = (page: Page) => cardsIn(page, "[data-grid]");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Shanghai" });

  test("the hub's server HTML: heading, strip, rails, top ten and tiles are all links", async ({ request }) => {
    const res = await request.get(HUB, GET);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<h1[^>]*>机战番剧<\/h1>/);
    expect(html).toContain(`${COUNT} 部 · 7 部连载中`);
    // Eighteen genres in the strip.
    const strip = html.slice(html.indexOf("data-genre-strip"), html.indexOf("</nav>", html.indexOf("data-genre-strip")));
    expect(strip.match(/href="\/genre\/[a-z-]+"/g)).toHaveLength(18);
    // The rails' first six, by popularity: the index order.
    for (const s of SHOWS.slice(0, 6)) expect(html).toContain(`href="/anime/${s.anilistId}">${s.titleChinese}</a>`);
    for (const list of ["airing", "popular", "recent", "classic"]) expect(html).toContain(`href="/genre/mecha?list=${list}"`);
    // The top ten, by score, each link saying its rank in words.
    byScore.slice(0, 10).forEach((s, i) => {
      expect(html).toMatch(new RegExp(`href="/anime/${s.anilistId}"><span[^>]*>第 ${i + 1} 名 </span>${s.titleChinese}</a>`));
    });
    expect(html).toContain('href="/genre/mecha?list=top"');
    // Tiles.
    for (const d of ["2020", "2010", "2000", "1990", "1980", "1970", "old"]) expect(html).toContain(`href="/genre/mecha?decade=${d}"`);
    for (const slug of ["sports", "thriller", "psychological", "supernatural", "music", "horror", "mystery"]) {
      expect(html).toContain(`href="/genre/mecha?with=${slug}"`);
    }
    expect(html).not.toContain('href="/genre/mecha?with=mahou-shoujo"');
    expect(html).toContain(`href="/studio/${encodeURIComponent("E2E 机甲工房")}"`);
    // Canonical: the hub itself.
    expect(html).toMatch(/<link rel="canonical" href="[^"]*\/genre\/mecha"/);
  });

  test("the hub in a browser: the rails with their counts, the ranking, the three tile rows", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await open(page, HUB);
    await expect(page.locator("[data-genre-page]")).toHaveAttribute("data-view", "hub");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("机战番剧");
    await expect(page.locator("[data-count]")).toHaveText(`${COUNT} 部 · 7 部连载中`);

    const heads = page.locator("[data-section^='rail-'] h2");
    await expect(heads).toHaveText([
      `正在连载${count((s) => s.status === "RELEASING")} 部`,
      "人气最高",
      `近年新作${count((s) => s.year >= RECENT_FROM)} 部`,
      `经典老番${count((s) => s.year <= 2009)} 部`,
    ]);
    for (const rail of ["airing", "popular", "recent", "classic"]) {
      await expect(cardsIn(page, `[data-rail="${rail}"]`)).toHaveCount(6);
    }

    const ranks = page.locator("[data-ranks] [data-rank]");
    await expect(ranks).toHaveCount(10);
    const ids = await ranks.evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-id"))));
    expect(ids).toEqual(byScore.slice(0, 10).map((s) => s.anilistId));

    const decades = page.locator('[data-tiles="decades"] a');
    await expect(decades).toHaveCount(7);
    // A tile's name is its visible text (the browser spaces its two lines),
    // with what the tile alone does not say read after it.
    await expect(decades.first()).toHaveAccessibleName(
      new RegExp(`^2020 年代\\s*${count((s) => decadeOf(s.year) === "2020")} 部$`),
    );
    const related = page.locator('[data-tiles="related"] a');
    await expect(related).toHaveCount(7);
    await expect(related.first()).toHaveAccessibleName(
      new RegExp(`^运动\\s*${count(hasGenre("Sports"))} 部\\s*（机战和运动都有）$`),
    );
    for (const tile of await page.locator("[data-tile]").all()) expect(await tile.getAttribute("aria-label")).toBeNull();
    const studios = page.locator('[data-tiles="studios"] a');
    await expect(studios).toHaveCount(7);
    await expect(studios.first()).toHaveAttribute("href", `/studio/${encodeURIComponent("E2E 机甲工房")}`);
    // Each tile fans covers no earlier tile showed, while there are new ones.
    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("查看全部 opens the grid on the rail's titles, and the way back is the hub", async ({ page }) => {
    await open(page, HUB);
    const backLink = await watchOpacity(page, "[data-back]");
    await page.locator('[data-see-all="airing"]').click();
    await page.waitForURL(/\/genre\/mecha\?list=airing$/);
    await waitForHydration(page, '[data-genre-page][data-view="grid"]');
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("机战 · 正在连载");
    // The way back came in as the grid's header went up, before the grid
    // landed; the grid that landed kept it as it stood, with no second fade.
    expect((await backLink()).at(-1)).toBe(1);
    await expect(page.locator("[data-count]")).toHaveText("7 部");
    const ids = await gridCards(page).evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-id"))));
    expect(ids).toEqual(SHOWS.filter((s) => s.status === "RELEASING").map((s) => s.anilistId));
    await expect(page.locator("[data-load-more]")).toHaveCount(0);

    const heading = await watchOpacity(page, "main h1");
    await page.locator("[data-back]").click();
    await page.waitForURL((url) => url.pathname === HUB && url.search === "");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("机战番剧");
    await expect(page.locator("[data-genre-page]")).toHaveAttribute("data-view", "hub");
    await expect(page.locator("[data-count]")).toBeVisible();
    expect((await heading()).at(-1)).toBe(1);
  });

  test("a grid opens behind the skeleton while it loads", async ({ page }) => {
    await open(page, HUB);
    await page.route(/\/genre\/mecha\?list=top/, async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      await route.continue();
    });
    await page.locator('[data-see-all="top"]').click();
    await expect(page.locator('[data-skeleton="grid"]')).toBeVisible();
    await page.waitForURL(/list=top/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("机战 · 评分排行");
    await expect(page.locator("[data-skeleton]")).toHaveCount(0);
    const ids = await gridCards(page).evaluateAll((els) => els.slice(0, 10).map((el) => Number(el.getAttribute("data-id"))));
    expect(ids).toEqual(byScore.slice(0, 10).map((s) => s.anilistId));
  });

  test("show more loads the next page in place when pressed", async ({ page }) => {
    // Tall enough that the link is on screen unscrolled: scrolling to it would load on its own.
    await page.setViewportSize({ width: 1440, height: 3200 });
    await open(page, `${HUB}?list=popular`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("机战 · 人气最高");
    await expect(gridCards(page)).toHaveCount(36);
    const more = page.locator("[data-load-more]");
    await expect(more).toHaveAttribute("href", "/genre/mecha?list=popular&page=2");
    await expect(more).toContainText(`还有 ${COUNT - 36} 部`);
    // The press is the script's: wait until React owns the link, or the click
    // is an ordinary one and opens page 2.
    await waitForHydration(page, "[data-load-more]");
    await more.click();
    await expect(gridCards(page)).toHaveCount(COUNT, { timeout: 15_000 });
    await expect(more).toHaveCount(0);
    // In place: the address did not move.
    await expect(page).toHaveURL(/\/genre\/mecha\?list=popular$/);
    const ids = await gridCards(page).evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-id"))));
    expect(ids).toEqual(IDS);
  });

  test("from the keyboard, show more hands focus to the first new title", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 3200 });
    await open(page, `${HUB}?list=popular`);
    await waitForHydration(page, "[data-load-more]");
    const more = page.locator("[data-load-more]");
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(gridCards(page)).toHaveCount(COUNT, { timeout: 15_000 });
    // The link it was on is gone (that was the last page): focus is on the
    // first title that came in, not dropped on <body>.
    await expect(page.locator(":focus")).toHaveAttribute("href", `/anime/${SHOWS[36]?.anilistId}`);
  });

  test("scrolling near show more loads the next page on its own", async ({ page }) => {
    await open(page, `${HUB}?list=popular`);
    await expect(gridCards(page)).toHaveCount(36);
    for (let i = 0; i < 14 && (await gridCards(page).count()) === 36; i += 1) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(150);
    }
    await expect.poll(() => gridCards(page).count(), { timeout: 10_000 }).toBe(COUNT);
  });

  test("Back from a show reopens the pages that were loaded", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 3200 });
    await open(page, `${HUB}?list=popular`);
    await waitForHydration(page, "[data-load-more]");
    await page.locator("[data-load-more]").click();
    await expect(gridCards(page)).toHaveCount(COUNT, { timeout: 15_000 });
    await gridCards(page).nth(40).locator("a").last().click();
    await page.waitForURL(/\/anime\/\d+/);
    await page.goBack();
    await page.waitForURL(/\/genre\/mecha\?list=popular$/);
    await waitForHydration(page, '[data-genre-page][data-view="grid"]');
    await expect(gridCards(page)).toHaveCount(COUNT);
  });

  test("a decade tile opens that decade", async ({ page }) => {
    await open(page, HUB);
    await page.locator('[data-tiles="decades"] a[href$="decade=1990"]').click();
    await page.waitForURL(/decade=1990$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("机战 · 1990 年代");
    const nineties = SHOWS.filter((s) => decadeOf(s.year) === "1990");
    await expect(page.locator("[data-count]")).toHaveText(`${nineties.length} 部`);
    const ids = await gridCards(page).evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-id"))));
    expect(ids).toEqual(nineties.map((s) => s.anilistId));
  });

  test("an old decade, and the decade before 1970, open as headings say", async ({ page }) => {
    await open(page, `${HUB}?decade=old`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("机战 · 1970 年以前");
    await expect(gridCards(page)).toHaveCount(count((s) => s.year < 1970));
  });

  test("a related genre's tile opens the titles carrying both", async ({ page }) => {
    await open(page, HUB);
    await page.locator('[data-tiles="related"] a[href$="with=sports"]').click();
    await page.waitForURL(/with=sports$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("机战 × 运动");
    await expect(page.locator("[data-count]")).toHaveText(`${count(hasGenre("Sports"))} 部`);
    await expect(gridCards(page)).toHaveCount(count(hasGenre("Sports")));
  });

  test("a studio's tile is a link to the studio's own page", async ({ page }) => {
    await open(page, HUB);
    const tile = page.locator('[data-tiles="studios"] a').nth(1);
    await expect(tile).toHaveAttribute("href", `/studio/${encodeURIComponent("E2E Gear Studio")}`);
    await tile.click();
    await page.waitForURL(/\/studio\//);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E Gear Studio 制作的番剧");
  });

  test("the strip: the block moves to a genre at once, and its page follows", async ({ page }) => {
    await open(page, HUB);
    const indicator = page.locator("[data-strip-indicator]");
    await expect(indicator).toHaveAttribute("data-strip-indicator", "mecha");
    await expect(page.locator('[data-genre-strip] a[aria-current="page"]')).toHaveAttribute("data-genre", "mecha");
    await page.route(/\/genre\/sports/, async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      await route.continue();
    });
    const heading = await watchOpacity(page, "main h1");
    await page.locator('[data-genre-strip] a[data-genre="sports"]').click();
    // Before the page arrives: the block is under 运动 and the hub's skeleton stands in.
    await expect(indicator).toHaveAttribute("data-strip-indicator", "sports");
    await expect(page.locator('[data-skeleton="hub"]')).toBeVisible();
    await page.waitForURL(/\/genre\/sports$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("运动番剧");
    await expect(page.locator('[data-genre-strip] a[aria-current="page"]')).toHaveAttribute("data-genre", "sports");
    await expect(page.locator("[data-count]")).toHaveText(
      `${count(hasGenre("Sports"))} 部 · ${count((s) => hasGenre("Sports")(s) && s.status === "RELEASING")} 部连载中`,
    );
    // The heading and the strip were on screen the whole time, and the page
    // that landed kept them: they never faded out and back in.
    const drawn = await heading();
    expect(drawn.length).toBeGreaterThan(0);
    expect(Math.min(...drawn)).toBe(1);
  });

  test("the popover says what the show's data says", async ({ page }) => {
    await open(page, `${HUB}?list=popular`);
    const s = SHOWS[12] as Show;
    const card = page.locator(`[data-anime-card][data-id="${s.anilistId}"]`);
    await card.locator(`a[href="/anime/${s.anilistId}"]:not([aria-hidden])`).hover();
    const pop = card.locator("[data-popover]");
    await expect(pop).toBeVisible();
    const season = { WINTER: "冬季", SPRING: "春季", SUMMER: "夏季", FALL: "秋季" }[s.season];
    await expect(pop).toContainText(`${s.year} 年 ${season} · 全 12 集`);
    await expect(pop).toContainText(s.studio);
    await expect(pop).toContainText(((s.averageScore as number) / 10).toFixed(1));
    await expect(pop.getByText("机战", { exact: true })).toBeVisible();
  });

  test("the old ?page=N goes, for good, to the popular grid's page holding its first title", async ({ page, request }) => {
    // The old list had 24 to a page, the grid has 36: old page 2 (titles
    // 25–48) starts on the grid's page 1, old page 3 (49–72) on its page 2.
    const target = (res: { headers(): Record<string, string> }) => {
      const url = new URL(res.headers()["location"] ?? "", "http://localhost");
      return url.pathname + url.search;
    };
    const old2 = await request.get(`${HUB}?page=2`, { ...GET, maxRedirects: 0 });
    expect(old2.status()).toBe(308);
    expect(target(old2)).toBe(`${HUB}?list=popular`);
    const old3 = await request.get(`/en${HUB}?page=3`, { ...GET, maxRedirects: 0 });
    expect(old3.status()).toBe(308);
    expect(target(old3)).toBe(`/en${HUB}?list=popular&page=2`);

    // The page it lands on is a page of its own: its canonical is itself.
    const html = await (await request.get(`${HUB}?list=popular&page=2`, GET)).text();
    expect(html).toMatch(/<h1[^>]*>机战 · 人气最高<\/h1>/);
    expect(html).toMatch(/<link rel="canonical" href="[^"]*\/genre\/mecha\?list=popular&amp;page=2"/);
    expect(html).toMatch(/<title>机战番剧 · 人气最高 · 2<\/title>/);
    for (const s of SHOWS.slice(36)) expect(html).toContain(`href="/anime/${s.anilistId}">${s.titleChinese}</a>`);
    await open(page, `${HUB}?page=3`);
    await expect(page).toHaveURL(new RegExp(`${HUB}\\?list=popular&page=2$`));
    await expect(gridCards(page)).toHaveCount(COUNT - 36);
    await expect(page.locator("[data-load-more]")).toHaveCount(0);
  });

  test("statuses: an unknown genre is a 404; an unknown view is the hub, never an error", async ({ request }) => {
    // Ten requests in a row, each a server render.
    test.slow();
    expect((await request.get("/genre/notagenre", GET)).status()).toBe(404);
    expect((await request.get("/genre/hentai", GET)).status()).toBe(404);
    // A page past the end of a slice is not an empty page: 45 titles are two
    // pages, seven airing are one.
    expect((await request.get(`${HUB}?list=popular&page=3`, GET)).status()).toBe(404);
    expect((await request.get(`${HUB}?list=airing&page=2`, GET)).status()).toBe(404);
    for (const q of ["list=bogus", "list=constructor", "decade=__proto__", "with=mecha", "with=toString", "page=abc"]) {
      const res = await request.get(`${HUB}?${q}`, GET);
      expect(res.status(), q).toBe(200);
      expect(await res.text(), q).toMatch(/<h1[^>]*>机战番剧<\/h1>/);
    }
  });

  test("English and Traditional render their own words", async ({ request }) => {
    const en = await (await request.get(`/en${HUB}`, GET)).text();
    expect(en).toMatch(/<h1[^>]*>Mecha Anime<\/h1>/);
    expect(en).toContain(`${COUNT} anime · 7 airing`);
    expect(en).toContain(">See all<");
    const hant = await (await request.get(`/zh-Hant${HUB}?list=classic`, GET)).text();
    expect(hant).toMatch(/<h1[^>]*>機戰 · 經典老番<\/h1>/);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Asia/Shanghai" });

  test("the strip and the rails scroll sideways; the ranking follows the rails; the grid is three across", async ({ page }) => {
    await open(page, HUB);
    await expect(page.locator("[data-genre-page]")).toHaveAttribute("data-layout", "phone");
    const strip = page.locator("[data-genre-strip]");
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    // A rail is one row that overflows: six cards side by side.
    const rail = page.locator('[data-rail="popular"]');
    const tops = await rail
      .locator("[data-anime-card]")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).offsetTop));
    expect(new Set(tops).size).toBe(1);
    expect(await rail.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // The phone card carries its line under the title.
    await expect(rail.locator("[data-anime-card]").first()).toContainText(`${SHOWS[0]?.year} · TV`);

    // 评分前 10 comes after the last rail, and the tiles after it, as tracks too.
    const lastRail = await page.locator('[data-section="rail-classic"]').boundingBox();
    const top = await page.locator('[data-section="top"]').boundingBox();
    expect(lastRail && top && top.y > lastRail.y).toBe(true);
    const tiles = page.locator('[data-tiles="decades"]');
    expect(await tiles.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    // Touch targets: the strip's cells and 查看全部 are at least 44px tall.
    const seg = await page.locator('[data-genre-strip] a[data-genre="mecha"]').boundingBox();
    expect(seg?.height ?? 0).toBeGreaterThanOrEqual(44);
    const all = await page.locator('[data-see-all="airing"]').boundingBox();
    expect(all?.height ?? 0).toBeGreaterThanOrEqual(44);

    await open(page, `${HUB}?list=popular`);
    const cards = gridCards(page);
    const rowTops = await cards.evaluateAll((els) => els.slice(0, 4).map((el) => (el as HTMLElement).offsetTop));
    expect(new Set(rowTops.slice(0, 3)).size).toBe(1);
    expect(rowTops[3]).toBeGreaterThan(rowTops[0] as number);
  });

  test("the current genre is brought into view in the strip", async ({ page }) => {
    await open(page, "/genre/thriller");
    const strip = page.locator("[data-genre-strip]");
    const pill = page.locator('[data-genre-strip] a[data-genre="thriller"]');
    const [box, at] = await Promise.all([strip.boundingBox(), pill.boundingBox()]);
    expect(box && at).toBeTruthy();
    if (box && at) {
      expect(at.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(at.x + at.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }
  });
});
