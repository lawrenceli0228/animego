import { test, expect } from "@playwright/test";
import {
  closePg,
  ensureAnimeDetail,
  removeAnimeFixture,
  seedRelation,
} from "../../fixtures/pg";

// The phase-2 data on the detail page: the next-episode strip in the hero,
// and the alias / committee / tag rows in the info table.
//
// Reached by navigating inside the site rather than by URL, on purpose. The
// strip is a client leaf that knows the time only once it has a clock
// (useSyncExternalStore against Date.now, so the ISR copy never carries a
// relative time), and a client-side route transition is the path where such
// a leaf mounts with no server HTML to fall back on. A direct load exercises
// hydration; the click exercises the mount. Both must show the strip.
//
// Own fixture ids, like every sandbox spec: the project is fullyParallel on
// one shared database.

const AIRING = 990_100_020;
const PREQUEL = 990_100_021;
/** Three days ahead: enough for the strip to read "3 天后" for the whole run. */
const NEXT_AT = new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString();
/**
 * The synopsis section — and the score panel inside it, where the popularity
 * line lives — renders only when there is a description. A fixture without
 * one has no panel to assert on.
 */
const SYNOPSIS = "E2E synopsis: a second season with a next episode on the calendar.";

test.beforeAll(async () => {
  await ensureAnimeDetail({
    anilistId: PREQUEL,
    titleRomaji: "E2E Facts Season One",
    titleChinese: "E2E 事实 第一季",
    status: "FINISHED",
    episodes: 12,
    description: SYNOPSIS,
  });
  await ensureAnimeDetail({
    anilistId: AIRING,
    titleRomaji: "E2E Facts Season Two",
    titleChinese: "E2E 事实 第二季",
    status: "RELEASING",
    episodes: 12,
    averageScore: 80,
    description: SYNOPSIS,
    popularity: 123_456,
    nextAiringAt: NEXT_AT,
    nextAiringEpisode: 7,
    synonyms: ["E2E Facts 2", "事实二", "E2E 事实 第二季"],
    producers: ["E2E Broadcasting", "E2E Publishing"],
    tags: [
      { source: "anilist", name: "Time Skip", rank: 12 },
      { source: "anilist", name: "Ensemble Cast", rank: 75 },
      { source: "anilist", name: "Tragedy", rank: 90, isSpoiler: true },
      { source: "bangumi", name: "治愈", rank: 40 },
    ],
  });
  // Both edges, so each page has a relation card linking to the other — the
  // in-site path to the strip goes there and back.
  await seedRelation(AIRING, PREQUEL, "PREQUEL");
  await seedRelation(PREQUEL, AIRING, "SEQUEL");
});

test.afterAll(async () => {
  await removeAnimeFixture(AIRING);
  await removeAnimeFixture(PREQUEL);
  await closePg();
});

test("the next episode is in the hero, reached by clicking through from a related title", async ({
  page,
}) => {
  await page.goto(`/anime/${AIRING}`);
  // The relation card back to season one, then season one's card forward.
  // Two hops so the second detail page is a client-side transition, not the
  // page that was server-rendered for the initial request.
  await page.getByRole("link", { name: /E2E Facts Season One|E2E 事实 第一季/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/anime/${PREQUEL}$`));
  await page.getByRole("link", { name: /E2E Facts Season Two|E2E 事实 第二季/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/anime/${AIRING}$`));

  // The strip is the only <time> in <main> on this page.
  const time = page.locator("main time[datetime]");
  await expect(time).toHaveCount(1);
  // `has` is evaluated relative to the outer element, so the inner locator
  // must not repeat the `main` prefix (it would look for a <main> inside <p>).
  const strip = page.locator("main p").filter({ has: page.locator("time[datetime]") });
  await expect(strip).toContainText("第 7 集");
  // The relative part only exists once the client has a clock; it must
  // arrive, and it must say what the fixture said.
  await expect(strip).toContainText("3 天后");
  // Compared as instants: the API serialises the timestamp without the
  // milliseconds toISOString wrote.
  expect(Date.parse((await time.getAttribute("datetime")) ?? "")).toBe(Date.parse(NEXT_AT));
});

test("a finished title has no strip", async ({ page }) => {
  await page.goto(`/anime/${PREQUEL}`);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("main time[datetime]")).toHaveCount(0);
});

test("the info table lists aliases, the committee and the tags, and the score panel the popularity", async ({
  page,
}) => {
  await page.goto(`/anime/${AIRING}`);
  const info = page.locator("section[aria-labelledby='info-heading']");
  await expect(info).toBeVisible();

  // Aliases: the two that are not already the title, Han first.
  const aliases = info.locator("div").filter({ has: page.getByText("别名", { exact: true }) }).first();
  await expect(aliases).toContainText("事实二 / E2E Facts 2");
  await expect(aliases).not.toContainText("第二季 /");

  const committee = info.locator("div").filter({ has: page.getByText("制作委员会", { exact: true }) }).first();
  await expect(committee).toContainText("E2E Broadcasting / E2E Publishing");

  // Tags: Bangumi's first, then AniList's over the rank floor; the spoiler and
  // the 12% tag never appear.
  const tags = info.locator("div").filter({ has: page.getByText("标签", { exact: true }) }).first();
  await expect(tags.locator("li")).toHaveText(["治愈", "Ensemble Cast"]);

  await expect(page.locator("aside").filter({ hasText: "AniList" }).first()).toContainText("123,456 人追番");
});
