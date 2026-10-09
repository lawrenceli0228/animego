import { test, expect, type Page } from "@playwright/test";
import { closePg } from "../../fixtures/pg";
import { waitForHydration } from "../../fixtures/hydration";
import {
  ADULT_ONLY,
  CHARACTER_BASE,
  CHILD_VOICE,
  LEAD,
  LEAD_SPOILER,
  LEAD_TITLES,
  STAFF,
  TITLE_BASE,
  TITLES,
  VOICE,
  removePeopleFixtures,
  seedPeopleFixtures,
} from "../../fixtures/people";

// The person and character pages, /person/[id] and /character/[id], against
// the local stack: real go-api, real Postgres, `next dev`.
//
// Serial, in one worker: the fixtures are one set of rows that every test
// reads, seeded once and removed once. (fullyParallel would run beforeAll per
// worker and let one worker's afterAll delete rows another is still reading.)
//
// Anonymous: these are public ISR pages, and a session would only change the
// navbar.
//
// Locators are roles, text and hrefs — never CSS-module class names, which
// are spelled differently by `next dev` and the production build.

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedPeopleFixtures();
});

test.afterAll(async () => {
  await removePeopleFixtures();
  await closePg();
});

const voiceSection = (page: Page) => page.locator('section[aria-labelledby="voice-roles-heading"]');

/** The distinct characters linked from a set of cards. */
async function characterIds(page: Page, scope: ReturnType<Page["locator"]>): Promise<number[]> {
  const hrefs = await scope.locator('a[href^="/character/"]').evaluateAll((as) =>
    as.map((a) => a.getAttribute("href") ?? ""),
  );
  return [...new Set(hrefs.map((h) => Number(h.split("/").pop())))];
}

test.describe("desktop", () => {
  test("a character: names, collapsed spoiler, voices, titles, breadcrumb", async ({ page }) => {
    const res = await page.goto(`/character/${LEAD}`);
    expect(res?.status()).toBe(200);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E 主角");
    const main = page.locator("main");
    await expect(main.getByText("イーツーイー主役", { exact: true })).toBeVisible();
    await expect(main.getByText("The E2E Lead", { exact: true })).toBeVisible();
    // AniList hides this alias as a spoiler; it is never part of the page.
    await expect(page.getByText("E2E Secret Name")).toHaveCount(0);

    // The breadcrumb: the title it leads, that title's cast, the character.
    const crumbs = page.getByRole("navigation", { name: "位置" });
    await expect(crumbs.getByRole("link", { name: "E2E 人物番 1" })).toHaveAttribute("href", `/anime/${TITLE_BASE + 1}`);
    await expect(crumbs.getByRole("link", { name: "角色" })).toHaveAttribute(
      "href",
      `/anime/${TITLE_BASE + 1}/characters`,
    );

    // The description: link text without the link, and the spoiler shut.
    await expect(main.getByText("E2E lead fights alongside E2E Friend.")).toBeVisible();
    await expect(main).not.toContainText("~!");
    await expect(page.getByText(LEAD_SPOILER)).toHaveCount(0);
    const spoiler = page.getByRole("button", { name: "显示剧透" });
    await waitForHydration(page, "main button[aria-expanded]");
    await spoiler.click();
    await expect(main.getByText(LEAD_SPOILER)).toBeVisible();
    await expect(main.getByText("After the spoiler.")).toBeVisible();

    // Every voice, with its note, to the person's page.
    const voices = page.locator('section[aria-labelledby="voices-heading"]');
    await expect(voices.locator(`a[href="/person/${VOICE}"]`)).toContainText("E2E 声优");
    await expect(voices.locator(`a[href="/person/${CHILD_VOICE}"]`)).toContainText("日配 · 童年");

    // Two titles, earliest first, to the anime pages, each with its role.
    const titles = page.locator('section[aria-labelledby="appearances-heading"] a');
    await expect(titles).toHaveCount(2);
    await expect(titles.nth(0)).toHaveAttribute("href", `/anime/${TITLE_BASE + 1}`);
    await expect(titles.nth(0)).toContainText("主角");
    await expect(titles.nth(1)).toContainText("配角");

    // 「编辑」 leads to the edit state; nothing says where the data came from.
    await expect(main.getByRole("link", { name: "编辑" })).toHaveAttribute("href", `/character/${LEAD}/edit`);
    await expect(main).not.toContainText("资料来自");
  });

  test("a voice actor: header, representative roles, the timeline's two controls", async ({ page }) => {
    const res = await page.goto(`/person/${VOICE}`);
    expect(res?.status()).toBe(200);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E 声优");
    await expect(page.locator("main dl")).toContainText("1990年9月27日");
    await expect(page.locator("main dl")).toContainText("大分县");
    await expect(page.locator("main dl")).toContainText("A型");

    // Leads in the most popular titles first: titles 1, 4 and 7.
    const rep = page.locator('section[aria-labelledby="representative-heading"]');
    expect(await characterIds(page, rep)).toEqual([1, 4, 7].map((t) => CHARACTER_BASE + t));
    await expect(rep.locator(`a[href="/anime/${TITLE_BASE + 1}"]`)).toBeVisible();

    // The timeline: newest year first, a first view of 21 cards (31 roles in
    // all: one per title, and the lead's supporting turn on title 2).
    const timeline = voiceSection(page);
    const cards = timeline.locator("article");
    await expect(timeline.getByRole("heading", { level: 3 }).first()).toHaveText("2026");
    await expect(cards).toHaveCount(21);
    const viewAll = timeline.getByRole("button", { name: `查看全部 ${TITLES} 部` });
    await expect(viewAll).toBeVisible();

    await waitForHydration(page, 'main button[aria-pressed="true"]');

    // 只看主角: the leads only — fewer than 21, so no 查看全部.
    await timeline.getByRole("button", { name: "只看主角" }).click();
    await expect(timeline.getByRole("button", { name: "只看主角" })).toHaveAttribute("aria-pressed", "true");
    expect((await characterIds(page, timeline)).sort()).toEqual(LEAD_TITLES.map((t) => CHARACTER_BASE + t).sort());
    await expect(timeline.getByRole("button", { name: /查看全部/ })).toHaveCount(0);

    // 新到旧 again, then everything.
    await timeline.getByRole("button", { name: "新到旧" }).click();
    await expect(cards).toHaveCount(21);
    await timeline.getByRole("button", { name: `查看全部 ${TITLES} 部` }).click();
    await expect(cards).toHaveCount(TITLES + 1);
    expect(await characterIds(page, timeline)).toHaveLength(TITLES);
    await expect(timeline.getByRole("heading", { level: 3 }).last()).toHaveText("2021");

    // A card goes to the character, and its title line to the anime.
    const card = cards
      .filter({ has: page.locator(`a[href="/character/${LEAD}"]`) })
      .filter({ has: page.locator(`a[href="/anime/${TITLE_BASE + 1}"]`) });
    await expect(card.locator(`a[href="/anime/${TITLE_BASE + 1}"]`).last()).toHaveText("E2E 人物番 1");

    // And the character link lands on the character page.
    await card.getByRole("link", { name: "E2E 主角" }).click();
    await expect(page).toHaveURL(new RegExp(`/character/${LEAD}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E 主角");
  });

  test("production staff with no profile: 制作作品, and not indexed", async ({ page }) => {
    const res = await page.goto(`/person/${STAFF}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("イーツーイー監督");
    const works = page.locator('section[aria-labelledby="staff-works-heading"]');
    await expect(works.getByRole("heading", { level: 2 })).toHaveText("制作作品");
    await expect(works.locator(`a[href="/anime/${TITLE_BASE + 1}"]`)).toContainText("监督 · 分镜 (eps 1, 5)");
    await expect(page.locator('section[aria-labelledby="voice-roles-heading"]')).toHaveCount(0);
    // Two titles is under the staff threshold: served, followed, not indexed.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
  });

  test("an indexed voice actor carries no noindex, a Person and a breadcrumb in JSON-LD", async ({ page }) => {
    await page.goto(`/person/${VOICE}`);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://animegoclub.com/person/${VOICE}`);
    const docs = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll((ss) => ss.map((s) => JSON.parse(s.textContent ?? "{}") as { "@type": string; name?: string }));
    expect(docs.map((d) => d["@type"]).sort()).toEqual(["BreadcrumbList", "Person"]);
    expect(docs.find((d) => d["@type"] === "Person")?.name).toBe("E2E 声优");
  });

  test("English and Traditional pages render in their language", async ({ page }) => {
    await page.goto(`/en/person/${VOICE}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E Voice Actor");
    await expect(voiceSection(page).getByRole("heading", { level: 2 })).toHaveText("Voice roles");
    await page.goto(`/zh-Hant/character/${LEAD}`);
    await expect(page.locator('section[aria-labelledby="voices-heading"] h2')).toHaveText("聲優");
  });

  test("ids with no page answer a real 404", async ({ page }) => {
    for (const path of [
      "/person/999999999",
      `/person/${ADULT_ONLY}`, // credited only on an adult title
      "/character/999999999",
      `/character/${CHARACTER_BASE + 99}`, // listed only on an adult title
      "/person/0",
      `/person/0${VOICE}`, // not the canonical spelling of a real id
      "/character/abc",
    ]) {
      const res = await page.request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
    }
    // The paired positive case: a run where everything 404s must not pass.
    expect((await page.request.get(`/person/${VOICE}`)).status()).toBe(200);
    expect((await page.request.get(`/en/character/${LEAD}`)).status()).toBe(200);
  });
});

test.describe("phone (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function noSidewaysScroll(page: Page) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }

  test("the character page fits, with its voices as a list and its titles as a strip", async ({ page }) => {
    await page.goto(`/character/${LEAD}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E 主角");
    await noSidewaysScroll(page);
    // The phone shows the description's heading and the role under the name.
    await expect(page.getByRole("heading", { name: "简介" })).toBeVisible();
    await expect(page.locator("main").getByText("主角", { exact: true }).first()).toBeVisible();
    const voice = page.locator(`section[aria-labelledby="voices-heading"] a[href="/person/${VOICE}"]`);
    await expect(voice).toBeVisible();
    await expect(voice.locator("svg")).toBeVisible();
  });

  test("the person page fits, and its controls work on touch", async ({ page }) => {
    await page.goto(`/person/${VOICE}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E 声优");
    await noSidewaysScroll(page);

    // Representative roles are a strip that scrolls on its own.
    const strip = page.locator('section[aria-labelledby="representative-heading"] > div');
    const scrolls = await strip.evaluate((el) => getComputedStyle(el).overflowX);
    expect(scrolls).toBe("auto");

    // click(), not tap(): Linux Chromium in CI does not deliver CDP-synthesised
    // touch gestures, and what is under test is the control, not the gesture.
    const timeline = voiceSection(page);
    const cards = timeline.locator("article");
    await waitForHydration(page, 'main button[aria-pressed="true"]');
    await timeline.getByRole("button", { name: "只看主角" }).click();
    await expect(cards).toHaveCount(LEAD_TITLES.length);
    await timeline.getByRole("button", { name: "新到旧" }).click();
    await timeline.getByRole("button", { name: `查看全部 ${TITLES} 部` }).click();
    await expect(cards).toHaveCount(TITLES + 1);
    await noSidewaysScroll(page);
  });
});
