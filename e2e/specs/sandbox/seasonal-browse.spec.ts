import { test, expect, type Page } from "@playwright/test";
import { waitForHydration } from "../../fixtures/hydration";
import { closePg, insertPgUser, readSubscription, resetSubscriptions, seedSubscription } from "../../fixtures/pg";
import { removeSeasonFixture, seedSeason, type SeedSeasonRow } from "../../fixtures/seasonal";
import { makeUser } from "../../fixtures/users";
import { collectConsoleErrors } from "../_helpers";

/**
 * The seasonal browse page (/seasonal/{season}/{year}), on two seasons of its
 * own that no real data has:
 *
 *   SPRING 2099  45 shows, 40 of them scheduled — the weekday chart, more
 *                than one batch of covers, badges, sources, sequels, hues
 *   FALL 2099    10 finished shows — the premiere-month chart
 *
 * What is pinned: every show is a link in the server HTML with the ones past
 * the batch hidden; the filters, their tags and the URL move together and
 * removing a tag undoes exactly that filter; views switch and keep their
 * batch sizes; "show more" reveals by button and by scrolling; weekday and
 * month bars filter and sort; a hue dot filters and tints the page; the
 * popover says what the card's data says; Escape and an outside press close
 * a menu; another season loads behind the page's one skeleton; the follow
 * button writes a subscription; and on a phone, the sheet.
 *
 * Times are seeded from the hour this run started in (ANCHOR), so every
 * worker — and a retry — writes the same rows: the page's server fetch is
 * cached for minutes, and a row re-seeded with other seconds would make it
 * answer with the first worker's data while this one computes from its own.
 * The file runs in order in one worker for the same reason.
 */

test.describe.configure({ mode: "default" });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BEIJING = 8 * HOUR;
const ANCHOR = Math.floor(Date.now() / HOUR) * HOUR;

const pad2 = (n: number) => String(n).padStart(2, "0");
/** 1 = Monday … 7 = Sunday, on the Beijing clock. */
const bjWeekday = (ms: number) => ((new Date(ms + BEIJING).getUTCDay() + 6) % 7) + 1;
const bjDay = (ms: number) => Math.floor((ms + BEIJING) / DAY);
const bjHhmm = (ms: number) => {
  const d = new Date(ms + BEIJING);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};

/** Accents whose OKLCH hue lands in the blue (263°) and red (29°) families. */
const BLUE = "#3b6fe0";
const RED = "#d9483b";

const WEEK_BASE = 990_600_001;
const WEEK_COUNT = 45;
const MONTH_BASE = 990_600_101;

interface WeekShow extends SeedSeasonRow {
  /** Epoch ms of the next episode, or null. */
  at: number | null;
}

/** The next episode of show `i`: a week of weekdays, the first of each seven within the day. */
function nextOf(i: number): { at: number; ep: number } | null {
  if (i >= 40) return null;
  // Aired three hours ago: the next one is a week after that.
  if (i === 1) return { at: ANCHOR + 7 * DAY - 3 * HOUR, ep: 5 };
  return { at: ANCHOR + (i % 7) * DAY + 2 * HOUR + (i % 3) * 30 * 60_000, ep: 2 + (i % 10) };
}

const GENRES: readonly (readonly string[])[] = [["Action", "Comedy"], ["Drama"], ["Action", "Fantasy"]];
const SOURCES = ["MANGA", "LIGHT_NOVEL", "ORIGINAL", "VISUAL_NOVEL"] as const;

const WEEK: WeekShow[] = Array.from({ length: WEEK_COUNT }, (_, i) => {
  const next = nextOf(i);
  const finished = i >= 40 && i <= 42;
  return {
    anilistId: WEEK_BASE + i,
    season: "SPRING",
    seasonYear: 2099,
    titleChinese: `季测 ${pad2(i)}`,
    titleRomaji: `Kisetsu Probe ${pad2(i)}`,
    titleNative: `季節テスト ${pad2(i)}`,
    titleEnglish: `Season Probe ${pad2(i)}`,
    posterAccent: i % 6 === 0 ? BLUE : i % 6 === 3 ? RED : null,
    averageScore: i % 11 === 10 ? null : 50 + ((i * 7) % 45),
    bangumiScore: i % 4 === 0 ? 7.5 : null,
    episodes: finished || i % 2 === 1 ? 12 : null,
    status: i < 40 ? "RELEASING" : finished ? "FINISHED" : "NOT_YET_RELEASED",
    format: i % 9 === 8 ? "MOVIE" : i % 7 === 6 ? "ONA" : "TV",
    popularity: 100_000 - i * 1_000,
    favourites: (i * 37) % 900,
    source: SOURCES[i % 4] ?? null,
    startDate: i === 44 ? null : i === 43 ? "2099-05-10" : `2099-04-${pad2((i % 28) + 1)}`,
    duration: i % 9 === 8 ? 105 : 24,
    nextAiringAt: next ? new Date(next.at).toISOString() : null,
    nextAiringEpisode: next?.ep ?? null,
    genres: GENRES[i % 3] ?? [],
    studio: i % 2 === 0 ? `季测工作室${i % 4 === 0 ? "甲" : "乙"}` : null,
    prequelFormat: i % 5 === 0 ? "TV" : i % 5 === 1 ? "MANGA" : null,
    at: next?.at ?? null,
  };
});

/** Premiere months: four in October, three in November, one in December, two without a date. */
const MONTH_STARTS = ["2099-10-04", "2099-10-11", "2099-10-18", "2099-10-25", "2099-11-01", "2099-11-08", "2099-11-15", "2099-12-02", null, null];
const MONTH: SeedSeasonRow[] = MONTH_STARTS.map((start, i) => ({
  anilistId: MONTH_BASE + i,
  season: "FALL",
  seasonYear: 2099,
  titleChinese: `月测 ${pad2(i)}`,
  titleRomaji: `Tsuki Probe ${pad2(i)}`,
  episodes: 12,
  status: "FINISHED",
  format: "TV",
  popularity: 50_000 - i * 1_000,
  startDate: start,
  genres: ["Drama"],
}));

const IDS = [...WEEK, ...MONTH].map((r) => r.anilistId);
const WEEK_URL = "/seasonal/spring/2099";
const MONTH_URL = "/seasonal/fall/2099";

const show = (i: number) => WEEK[i] as WeekShow;
const count = (pred: (s: WeekShow) => boolean) => WEEK.filter(pred).length;

test.beforeAll(async () => {
  await seedSeason([...WEEK, ...MONTH]);
});

test.afterAll(async () => {
  await removeSeasonFixture(IDS);
  await closePg();
});

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page, "[data-seasonal-browse]");
}

const visibleCards = (page: Page) => page.locator("[data-anime-card]:visible");
const countText = (page: Page) => page.locator("[data-count]");

test.describe("desktop", () => {
  // On a UTC+8 browser the page's clock is Beijing's before and after
  // hydration alike, so the weekday and badge cases below can be worked out
  // on the Beijing clock wherever the suite runs. A reader elsewhere has
  // their own describe block further down.
  test.use({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Shanghai" });

  test("every show is a link in the server HTML; past the first batch they wait hidden", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const html = await (await page.request.get(WEEK_URL)).text();
    for (const s of WEEK) expect(html).toContain(`href="/anime/${s.anilistId}">${s.titleChinese}</a>`);
    const cards = html.match(/<div[^>]*data-anime-card="true"[^>]*>/g) ?? [];
    expect(cards).toHaveLength(WEEK_COUNT);
    expect(cards.filter((c) => /\shidden=""/.test(c))).toHaveLength(WEEK_COUNT - 36);

    await open(page, WEEK_URL);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("2099年 春季新番");
    await expect(countText(page)).toHaveText(`${WEEK_COUNT} 部`);
    await expect(visibleCards(page)).toHaveCount(36);
    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("filters, their tags and the URL move together; a tag removes only its filter", async ({ page }) => {
    await open(page, WEEK_URL);
    const action = count((s) => s.genres?.includes("Action") ?? false);
    const actionTv = count((s) => (s.genres?.includes("Action") ?? false) && s.format === "TV");

    await page.locator('[data-field="genre"] button[aria-haspopup]').click();
    await page.locator('[data-field="genre"] [data-option="Action"]').click();
    await expect(countText(page)).toHaveText(`${action} 部`);
    await expect(page).toHaveURL(/[?&]genre=Action(&|$)/);

    await page.locator('[data-field="format"] button[aria-haspopup]').click();
    await page.locator('[data-field="format"] [data-option="TV"]').click();
    await expect(countText(page)).toHaveText(`${actionTv} 部`);
    await expect(page.locator("[data-tag]")).toHaveText(["动作", "TV"]);

    // The more-filters panel: the source and sequel groups are there because the data has them.
    await page.locator('[data-field="more"] button').click();
    await page.locator('[data-field="more"] [data-chip="MANGA"]').click();
    const mangaActionTv = count(
      (s) => (s.genres?.includes("Action") ?? false) && s.format === "TV" && s.source === "MANGA",
    );
    await expect(countText(page)).toHaveText(`${mangaActionTv} 部`);
    await page.locator('[data-field="more"] [data-chip="sequel"]').click();
    const sequels = count(
      (s) => (s.genres?.includes("Action") ?? false) && s.format === "TV" && s.source === "MANGA" && s.prequelFormat === "TV",
    );
    await expect(countText(page)).toHaveText(`${sequels} 部`);
    await expect(page).toHaveURL(/source=MANGA/);
    await expect(page).toHaveURL(/seq=sequel/);

    // Removing the genre tag leaves the other three filters in place.
    await page.locator('[data-tag="genre"]').click();
    const noGenre = count((s) => s.format === "TV" && s.source === "MANGA" && s.prequelFormat === "TV");
    await expect(countText(page)).toHaveText(`${noGenre} 部`);
    await expect(page).not.toHaveURL(/genre=/);
    await expect(page).toHaveURL(/format=TV/);

    // 清除全部.
    await page.locator("[data-clear-all]").click();
    await expect(countText(page)).toHaveText(`${WEEK_COUNT} 部`);
    await expect(page).toHaveURL(new RegExp(`${WEEK_URL}$`));

    // A shared URL lands on the same filtered page.
    await open(page, `${WEEK_URL}?genre=Drama&status=RELEASING`);
    const drama = count((s) => (s.genres?.includes("Drama") ?? false) && s.status === "RELEASING");
    await expect(countText(page)).toHaveText(`${drama} 部`);
    await expect(page.locator("[data-tag]")).toHaveText(["剧情", "连载中"]);
  });

  test("search matches any of a show's titles", async ({ page }) => {
    await open(page, WEEK_URL);
    const box = page.locator('[data-search="desktop"]');
    await box.fill("季節テスト 07");
    await expect(visibleCards(page)).toHaveCount(1);
    await expect(visibleCards(page).first()).toHaveAttribute("data-id", String(show(7).anilistId));
    await box.fill("season probe 1");
    // Season Probe 10 to 19 ("Season Probe 01" reads "probe 01").
    await expect(countText(page)).toHaveText("10 部");
    await expect(page).toHaveURL(/q=season\+probe\+1/);
    await page.locator('[data-tag="q"]').click();
    await expect(box).toHaveValue("");
    await expect(countText(page)).toHaveText(`${WEEK_COUNT} 部`);
  });

  test("the views switch in place and keep their own batch sizes", async ({ page }) => {
    await open(page, WEEK_URL);
    await page.locator('[data-view-toggle="chart"]').click();
    await expect(page.locator("[data-charts]")).toBeVisible();
    await expect(visibleCards(page)).toHaveCount(12);
    await expect(page).toHaveURL(/view=chart/);

    await page.locator('[data-view-toggle="table"]').click();
    await expect(page.locator("[data-rows]")).toBeVisible();
    await expect(visibleCards(page)).toHaveCount(16);

    // The URL is the page: reloaded, it opens in the table.
    await page.reload();
    await waitForHydration(page, "[data-seasonal-browse]");
    await expect(page.locator("[data-rows]")).toBeVisible();
    await expect(page.locator('[data-view-toggle="table"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("show more reveals the next batch when pressed", async ({ page }) => {
    // Tall enough that the button is on screen unscrolled: scrolling to it
    // would reveal the batch on its own (the next test) before the press.
    await page.setViewportSize({ width: 1440, height: 3000 });
    await open(page, WEEK_URL);
    const more = page.locator("[data-load-more]");
    await expect(more).toContainText(`还有 ${WEEK_COUNT - 36} 部`);
    await expect(visibleCards(page)).toHaveCount(36);
    await more.click();
    await expect(visibleCards(page)).toHaveCount(WEEK_COUNT);
    await expect(more).toHaveCount(0);
  });

  test("scrolling near show more reveals the next batch on its own", async ({ page }) => {
    await open(page, `${WEEK_URL}?view=chart`);
    await expect(visibleCards(page)).toHaveCount(12);
    // Down towards the button, the way a reader scrolls: it never has to be pressed.
    for (let i = 0; i < 12 && (await visibleCards(page).count()) === 12; i += 1) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(150);
    }
    await expect.poll(() => visibleCards(page).count(), { timeout: 10_000 }).toBeGreaterThan(12);
  });

  test("weekday bars count Beijing weekdays, mark today, and filter by air time", async ({ page }) => {
    await open(page, WEEK_URL);
    const bars = page.locator('[data-bars][data-mode="weekday"]');
    await expect(bars).toBeVisible();
    for (let wd = 1; wd <= 7; wd += 1) {
      const n = count((s) => s.at !== null && bjWeekday(s.at) === wd);
      await expect(page.locator(`[data-bar="wd-${wd}"] em`)).toHaveText(String(n));
    }
    const today = bjWeekday(Date.now());
    await expect(page.locator(`[data-bar="wd-${today}"]`)).toHaveAttribute("data-today", "true");
    await expect(page.locator("[data-bar][data-today]")).toHaveCount(1);

    // Filter to the busiest day whose shows carry no live badge, so every card
    // shows its air time. Today's shows are hours away ("今天 10:00"), the
    // ones six days out had their previous episode, inferred a week earlier,
    // go out under a day ago ("第 N 集更新"), and which day is busiest overall
    // turns on the hour the run started in: picked blindly, the test failed
    // through most of the Beijing day.
    const now = Date.now();
    const onDay = (wd: number) => WEEK.filter((s) => s.at !== null && bjWeekday(s.at) === wd);
    const quiet = (s: WeekShow) => s.at !== null && s.at - now > DAY + HOUR && s.at - now < 6 * DAY - HOUR;
    const quietDays = [1, 2, 3, 4, 5, 6, 7].filter((wd) => onDay(wd).length > 0 && onDay(wd).every(quiet));
    expect(quietDays.length).toBeGreaterThan(0);
    const busiest = quietDays.reduce((best, wd) => (onDay(wd).length > onDay(best).length ? wd : best));
    await page.locator(`[data-bar="wd-${busiest}"]`).click();
    await expect(page.locator(`[data-bar="wd-${busiest}"]`)).toHaveAttribute("aria-pressed", "true");
    await expect(countText(page)).toHaveText(`${onDay(busiest).length} 部`);
    await expect(page).toHaveURL(new RegExp(`wd=${busiest}`));
    await expect(page).toHaveURL(/sort=time/);
    await expect(page.locator("[data-sort-trigger]")).toHaveText("放送时间");
    // In air-time order, each card showing its time.
    const ids = await visibleCards(page).evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-id"))));
    const expected = onDay(busiest).sort((a, b) => {
      const ka = new Date((a.at as number) + BEIJING);
      const kb = new Date((b.at as number) + BEIJING);
      return ka.getUTCHours() * 60 + ka.getUTCMinutes() - (kb.getUTCHours() * 60 + kb.getUTCMinutes()) || (b.popularity ?? 0) - (a.popularity ?? 0);
    });
    expect(ids).toEqual(expected.map((s) => s.anilistId));
    await expect(visibleCards(page).locator('[data-badge="plain"]')).toHaveText(expected.map((s) => bjHhmm(s.at as number)));

    // Pressed again: back to everything, sorted by popularity.
    await page.locator(`[data-bar="wd-${busiest}"]`).click();
    await expect(countText(page)).toHaveText(`${WEEK_COUNT} 部`);
    await expect(page).not.toHaveURL(/wd=|sort=/);
  });

  test("cover badges: today's or tomorrow's air time, and the episode that just went out", async ({ page }) => {
    await open(page, WEEK_URL);
    const soon = show(0).at as number;
    const label = bjDay(soon) === bjDay(Date.now()) ? `今天 ${bjHhmm(soon)}` : `明天 ${bjHhmm(soon)}`;
    const card0 = page.locator(`[data-anime-card][data-id="${show(0).anilistId}"]`);
    await expect(card0.locator('[data-badge="soon"]')).toHaveText(label);
    const card1 = page.locator(`[data-anime-card][data-id="${show(1).anilistId}"]`);
    await expect(card1.locator('[data-badge="new"]')).toHaveText("第 4 集更新");
    // Further out: no badge.
    await expect(page.locator(`[data-anime-card][data-id="${show(2).anilistId}"] [data-badge]`)).toHaveCount(0);
  });

  test("the month chart for a season with nothing scheduled", async ({ page }) => {
    await open(page, MONTH_URL);
    const bars = page.locator('[data-bars][data-mode="month"]');
    await expect(bars).toBeVisible();
    await expect(bars.locator("[data-bar]")).toHaveCount(4);
    await expect(page.locator('[data-bar="mon-2099-10"] em')).toHaveText("4");
    await expect(page.locator('[data-bar="mon-2099-11"] em')).toHaveText("3");
    await expect(page.locator('[data-bar="mon-2099-12"] em')).toHaveText("1");
    await expect(page.locator('[data-bar="mon-tbd"] em')).toHaveText("2");

    await page.locator('[data-bar="mon-2099-11"]').click();
    await expect(countText(page)).toHaveText("3 部");
    await expect(page).toHaveURL(/mon=2099-11/);
    await expect(page).toHaveURL(/sort=start/);
    await expect(page.locator('[data-badge="plain"]')).toHaveText(["11 月 1 日", "11 月 8 日", "11 月 15 日"]);
    await expect(page.locator('[data-tag="mon"]')).toHaveText("11 月开播");
  });

  test("a hue dot filters to its family and tints the page", async ({ page }) => {
    await open(page, WEEK_URL);
    const main = page.locator("main[data-seasonal-browse]");
    const ground = () => main.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await ground()).toBe("rgb(0, 0, 0)");
    await page.locator('[data-hues="desktop"] [data-hue="blue"]').click();
    await expect(countText(page)).toHaveText(`${count((s) => s.posterAccent === BLUE)} 部`);
    await expect(page).toHaveURL(/hue=blue/);
    await expect.poll(ground, { timeout: 5_000 }).not.toBe("rgb(0, 0, 0)");
    await expect(page.locator('[data-tag="hue"]')).toHaveText("蓝调");
  });

  test("the popover says what the show's data says", async ({ page }) => {
    await open(page, WEEK_URL);
    const s = show(4);
    const card = page.locator(`[data-anime-card][data-id="${s.anilistId}"]`);
    await card.locator(`a[href="/anime/${s.anilistId}"]:not([aria-hidden])`).hover();
    const pop = card.locator("[data-popover]");
    await expect(pop).toBeVisible();
    const days = Math.floor(((s.at as number) - Date.now()) / DAY);
    await expect(pop).toContainText(`第 ${s.nextAiringEpisode} 集 · ${days} 天后`);
    await expect(pop).toContainText(s.studio as string);
    await expect(pop).toContainText("TV");
    await expect(pop).toContainText("Bangumi7.5");
    await expect(pop).toContainText(((s.averageScore as number) / 10).toFixed(1));
    // Show 4's genre (GENRES[4 % 3]) as a pill.
    await expect(pop.getByText("剧情", { exact: true })).toBeVisible();
  });

  test("Escape and a press outside close a menu, and Escape gives focus back to its trigger", async ({ page }) => {
    await open(page, WEEK_URL);
    const trigger = page.locator('[data-field="genre"] button[aria-haspopup]');
    await trigger.click();
    await expect(page.locator('[data-field="genre"] [role="listbox"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-field="genre"] [role="listbox"]')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.locator("[data-sort-trigger]").click();
    await expect(page.locator("[data-sort]").first()).toBeVisible();
    await page.mouse.click(10, 500);
    await expect(page.locator("[data-sort]")).toHaveCount(0);

    // The year and season menus are links, there for crawlers even while closed.
    await expect(page.locator('[data-menu-panel="year"]')).toBeHidden();
    await expect(page.locator('[data-menu-panel="year"] a[href="/seasonal/spring/2025"]')).toHaveCount(1);
  });

  test("arriving by a client navigation reads the new address, not the page being left", async ({ page }) => {
    // From a page with its own query, the navbar's season link.
    await page.goto(`/search?q=${encodeURIComponent("季测")}`);
    await waitForHydration(page, "body");
    await page.locator('nav a[href^="/seasonal/"]').first().click();
    await page.waitForURL(/\/seasonal\/(winter|spring|summer|fall)\/\d{4}/);
    await waitForHydration(page, "[data-seasonal-browse]");
    await expect(page.locator('[data-search="desktop"]')).toHaveValue("");
    await expect(page).not.toHaveURL(/[?&]q=/);

    // From a month-filtered season, a year link (it drops the month and the sort it implied).
    // (The year menu runs from 2000 to next year, plus the year on screen.)
    await open(page, `${MONTH_URL}?mon=2099-10&sort=start`);
    await page.locator('[data-field="year"] > button').click();
    await page.locator('[data-menu-panel="year"] a[href*="/seasonal/fall/2020"]').click();
    await page.waitForURL(/\/seasonal\/fall\/2020/);
    await waitForHydration(page, "[data-seasonal-browse]");
    await expect(page).not.toHaveURL(/mon=|sort=/);
  });

  test("the navbar's link to this season clears the filters with the URL", async ({ page }) => {
    // The navbar links the current season; open it filtered, then follow that link.
    await page.goto("/");
    const href = await page.locator('nav a[href^="/seasonal/"]').first().getAttribute("href");
    expect(href).toMatch(/^\/seasonal\/(winter|spring|summer|fall)\/\d{4}$/);
    await open(page, `${href}?format=TV`);
    await expect(page.locator('[data-field="format"] > button')).toHaveAttribute("data-set", "true");
    await page.locator('nav a[href^="/seasonal/"]').first().click();
    await page.waitForURL((url) => url.pathname === href && !url.search.includes("format="));
    await waitForHydration(page, "[data-seasonal-browse]");
    await expect(page.locator('[data-field="format"] > button')).not.toHaveAttribute("data-set", "true");
  });

  test("Back from a show reopens the batches that were open", async ({ page }) => {
    await open(page, WEEK_URL);
    await page.locator("[data-load-more]").evaluate((el) => (el as HTMLButtonElement).click());
    await expect(visibleCards(page)).toHaveCount(WEEK_COUNT);
    await visibleCards(page).nth(40).locator("a").last().click();
    await page.waitForURL(/\/anime\/\d+/);
    await page.goBack();
    await page.waitForURL(/\/seasonal\/spring\/2099/);
    await waitForHydration(page, "[data-seasonal-browse]");
    await expect(visibleCards(page)).toHaveCount(WEEK_COUNT);
  });

  test("Escape closes a menu even when focus is not inside it", async ({ page }) => {
    // Safari does not focus a clicked button; reproduce that by blurring.
    await open(page, WEEK_URL);
    await page.locator('[data-field="genre"] > button').click();
    await expect(page.locator('[data-field="genre"] [role="listbox"]')).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-field="genre"] [role="listbox"]')).toHaveCount(0);
    await expect(page.locator('[data-field="genre"] > button')).toBeFocused();
  });

  test("query values that name Object.prototype members still answer 200", async ({ request }) => {
    for (const q of ["sort=constructor", "sort=__proto__", "sort=toString", "view=constructor", "hue=__proto__"]) {
      const res = await request.get(`${WEEK_URL}?${q}`);
      expect(res.status(), q).toBe(200);
    }
  });

  test("another season loads behind the skeleton", async ({ page }) => {
    await open(page, WEEK_URL);
    // Hold the route change long enough to see what stands in for it.
    await page.route(/\/seasonal\/fall\/2099/, async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      await route.continue();
    });
    await page.locator('[data-field="season"] > button').click();
    await page.locator('[data-menu-panel="season"] a[href^="/seasonal/fall/2099"]').click();
    await expect(page.locator("[data-skeleton]")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${MONTH_URL}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("2099年 秋季新番");
    await expect(page.locator("[data-skeleton]")).toHaveCount(0);
    await expect(countText(page)).toHaveText("10 部");
  });

  test("with reduced motion the cards do not animate in", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, WEEK_URL);
    const duration = await visibleCards(page)
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
    expect(duration).toBeLessThan(0.01);
  });
});

test.describe("a reader outside UTC+8", () => {
  // After hydration the page reads the reader's own zone, as the home page and
  // /calendar do: a late-night Beijing slot sits under the weekday it airs
  // where the reader is, and "今天 / 明天" is the reader's today.
  const ZONE = "America/Los_Angeles";
  test.use({ viewport: { width: 1440, height: 900 }, timezoneId: ZONE });

  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const local = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return {
      weekday: WEEKDAYS.indexOf(get("weekday")) + 1,
      day: `${get("year")}-${get("month")}-${get("day")}`,
      hhmm: `${get("hour")}:${get("minute")}`,
    };
  };

  test("the weekday bars, today and the cover badges follow the reader's clock", async ({ page }) => {
    await open(page, WEEK_URL);
    for (let wd = 1; wd <= 7; wd += 1) {
      const n = count((s) => s.at !== null && local(s.at).weekday === wd);
      await expect(page.locator(`[data-bar="wd-${wd}"] em`)).toHaveText(String(n));
    }
    await expect(page.locator(`[data-bar="wd-${local(Date.now()).weekday}"]`)).toHaveAttribute("data-today", "true");
    await expect(page.locator("[data-bar][data-today]")).toHaveCount(1);

    const soon = local(show(0).at as number);
    const label = `${soon.day === local(Date.now()).day ? "今天" : "明天"} ${soon.hhmm}`;
    await expect(page.locator(`[data-anime-card][data-id="${show(0).anilistId}"] [data-badge="soon"]`)).toHaveText(label);
  });
});

test.describe("following from a card", () => {
  test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

  test("the + writes a subscription and turns into a ✓ that stops tracking", async ({ page }) => {
    test.setTimeout(90_000);
    const user = makeUser();
    await insertPgUser({ username: user.username, email: user.email, passwordHash: user.passwordHash });
    const target = show(3);
    try {
      await page.goto("/login");
      await waitForHydration(page, "#login-email");
      await page.locator("#login-email").fill(user.email);
      await page.locator("#login-password").fill(user.password);
      await Promise.all([
        page.waitForURL((url) => !url.pathname.startsWith("/login")),
        page.locator('button[type="submit"]').click(),
      ]);

      await open(page, WEEK_URL);
      const card = page.locator(`[data-anime-card][data-id="${target.anilistId}"]`);
      await card.hover();
      const add = card.locator('[data-follow="off"]');
      await expect(add).toBeVisible();
      await add.click();
      const check = card.locator('[data-follow="on"]');
      await expect(check).toHaveJSProperty("tagName", "BUTTON");
      await expect(check).toHaveAttribute("aria-label", `取消追番: ${target.titleChinese}`);
      await expect.poll(async () => (await readSubscription(user.email, target.anilistId))?.status).toBe("watching");
    } finally {
      await resetSubscriptions(user.email, [target.anilistId]);
    }
  });

  test("a run of follows keeps one toast on screen, at the bottom, naming the last show", async ({ page }) => {
    test.setTimeout(90_000);
    const user = makeUser();
    await insertPgUser({ username: user.username, email: user.email, passwordHash: user.passwordHash });
    const run = [show(6), show(7), show(8)];
    try {
      await page.goto("/login");
      await waitForHydration(page, "#login-email");
      await page.locator("#login-email").fill(user.email);
      await page.locator("#login-password").fill(user.password);
      await Promise.all([
        page.waitForURL((url) => !url.pathname.startsWith("/login")),
        page.locator('button[type="submit"]').click(),
      ]);
      await open(page, WEEK_URL);

      for (const s of run) {
        const card = page.locator(`[data-anime-card][data-id="${s.anilistId}"]`);
        // Mid-screen: a card at the bottom edge would sit under the toast.
        await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await card.hover();
        await card.locator('[data-follow="off"]').click();
        await expect(card.locator('[data-follow="on"]')).toBeAttached();
        await expect(page.locator('[data-toast][data-visible="true"]')).toHaveCount(1);
      }
      const toast = page.locator('[data-toast][data-visible="true"]');
      const last = run[run.length - 1] as WeekShow;
      await expect(toast).toContainText(last.titleChinese as string);
      await expect(toast).toContainText("已加入「在看」");
      await expect(toast.getByRole("button", { name: "撤销" })).toBeVisible();

      // At the bottom of the window, clear of the navigation.
      const box = await toast.boundingBox();
      const viewport = page.viewportSize();
      expect(box && viewport).toBeTruthy();
      if (box && viewport) {
        expect(box.y).toBeGreaterThan(viewport.height / 2);
        expect(viewport.height - (box.y + box.height)).toBeLessThan(60);
      }
    } finally {
      await resetSubscriptions(user.email, run.map((s) => s.anilistId));
    }
  });

  test("✓ pressed again unfollows a bare follow, and asks first before progress goes", async ({ page }) => {
    test.setTimeout(90_000);
    const user = makeUser();
    await insertPgUser({ username: user.username, email: user.email, passwordHash: user.passwordHash });
    const bare = show(4);
    const watched = show(5);
    await seedSubscription(user.email, watched.anilistId, "watching", 3);
    try {
      await page.goto("/login");
      await waitForHydration(page, "#login-email");
      await page.locator("#login-email").fill(user.email);
      await page.locator("#login-password").fill(user.password);
      await Promise.all([
        page.waitForURL((url) => !url.pathname.startsWith("/login")),
        page.locator('button[type="submit"]').click(),
      ]);
      await open(page, WEEK_URL);

      // Followed here and nothing more: ✓ takes it straight back off the list.
      const bareCard = page.locator(`[data-anime-card][data-id="${bare.anilistId}"]`);
      await bareCard.hover();
      await bareCard.locator('[data-follow="off"]').click();
      await expect(bareCard.locator('[data-follow="on"]')).toBeVisible();
      await expect.poll(async () => (await readSubscription(user.email, bare.anilistId))?.status).toBe("watching");
      await bareCard.locator('[data-follow="on"]').click();
      await expect(bareCard.locator('[data-follow="off"]')).toBeAttached();
      await expect.poll(() => readSubscription(user.email, bare.anilistId)).toBeNull();
      await expect(page.locator("[data-unfollow-dialog]")).toHaveCount(0);
      // The toast's Undo follows it again.
      await page.locator("[data-toast]", { hasText: "已取消追番" }).getByRole("button", { name: "撤销" }).click();
      await expect(bareCard.locator('[data-follow="on"]')).toBeAttached();
      await expect.poll(async () => (await readSubscription(user.email, bare.anilistId))?.status).toBe("watching");

      // Three episodes in: the server keeps the row and the page asks, focus on 保留.
      const watchedCard = page.locator(`[data-anime-card][data-id="${watched.anilistId}"]`);
      const check = watchedCard.locator('[data-follow="on"]');
      await check.click();
      const dialog = page.locator("[data-unfollow-dialog]");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("看到第 3 集");
      await expect(page.locator("[data-unfollow-keep]")).toBeFocused();
      // A click on its text must not drop the keyboard out of it: Escape still answers.
      await dialog.locator("h2").click();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(check).toBeFocused();
      // A click on the dark outside keeps it as well.
      await check.click();
      await expect(dialog).toBeVisible();
      await page.mouse.click(4, 4);
      await expect(dialog).toHaveCount(0);
      expect((await readSubscription(user.email, watched.anilistId))?.currentEpisode).toBe(3);

      // Asked again and answered yes: the row goes, progress and all.
      await check.click();
      await page.locator("[data-unfollow-confirm]").click();
      await expect(watchedCard.locator('[data-follow="off"]')).toBeAttached();
      await expect.poll(() => readSubscription(user.email, watched.anilistId)).toBeNull();
    } finally {
      await resetSubscriptions(user.email, [bare.anilistId, watched.anilistId]);
    }
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Asia/Shanghai" });

  test("three covers a row, 21 at a time, each with its airing line", async ({ page }) => {
    await open(page, WEEK_URL);
    await expect(page.locator("[data-seasonal-browse]")).toHaveAttribute("data-layout", "phone");
    await expect(visibleCards(page)).toHaveCount(21);
    // offsetTop, not the bounding box: the cards scale in on arrival, and a
    // box measured mid-animation is not where the card sits.
    const tops = await visibleCards(page).evaluateAll((els) => els.slice(0, 4).map((el) => (el as HTMLElement).offsetTop));
    expect(new Set(tops.slice(0, 3)).size).toBe(1);
    expect(tops[3]).toBeGreaterThan(tops[0] as number);
    await expect(page.locator('[data-filter-bar]')).toBeHidden();
    await expect(page.locator('[data-view-toggle="table"]')).toBeHidden();
    const s = show(0);
    const hours = Math.floor(((s.at as number) - Date.now()) / HOUR);
    const line = hours >= 1 ? `第 ${s.nextAiringEpisode} 集 · ${hours} 小时后` : `第 ${s.nextAiringEpisode} 集 ·`;
    await expect(page.locator(`[data-anime-card][data-id="${s.anilistId}"]`)).toContainText(line);
  });

  test("the filter sheet: a dialog that holds focus, locks the page and closes three ways", async ({ page }) => {
    await open(page, WEEK_URL);
    const opener = page.locator("[data-sheet-open]");
    await opener.tap();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAccessibleName("筛选与排序");
    // Focus moved in, and the page under it does not scroll.
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);

    // A genre chip filters at once; the button counts what is left.
    await sheet.locator('[data-chip="Drama"]').tap();
    const drama = count((s) => s.genres?.includes("Drama") ?? false);
    await expect(sheet.locator("[data-sheet-apply]")).toHaveText(`查看 ${drama} 部`);
    await sheet.locator("[data-sheet-apply]").tap();
    await expect(sheet).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(opener.locator("b")).toHaveText("1");
    await expect(countText(page)).toHaveText(`${drama} 部`);

    // Escape closes it; so does the backdrop.
    await opener.tap();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await opener.tap();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.mouse.click(195, 30);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the sheet's season control is links, with the pill on this season", async ({ page }) => {
    await open(page, WEEK_URL);
    await page.locator("[data-sheet-open]").tap();
    const sheet = page.getByRole("dialog");
    await expect(sheet.locator('nav [aria-current="page"]').first()).toHaveText("春季");
    await expect(sheet.locator('nav a[href="/seasonal/fall/2099"]')).toHaveCount(1);
  });
});
