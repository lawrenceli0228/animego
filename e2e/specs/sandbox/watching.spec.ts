import { test, expect, type Page } from "@playwright/test";
import { waitForHydration } from "../../fixtures/hydration";
import {
  closePg,
  ensureAnimeCached,
  ensureAnimeRowExists,
  insertPgUser,
  seedSubscription,
} from "../../fixtures/pg";
import { makeUser, type TestUser } from "../../fixtures/users";
import { collectConsoleErrors } from "../_helpers";

/**
 * 全部在追 (/watching): every show the reader is watching, as 继续看 cards.
 *
 * What is pinned:
 *   - signed in, the page lists exactly the shows being watched — not the
 *     completed one — each as a 继续看 card with its progress, next episode
 *     and continue label, in the same order as the homepage's 继续看;
 *   - both 全部在追 links lead to it: the homepage's 继续看 header, and the
 *     schedule page's 我追的 · 本周, which links out once the reader follows
 *     more than eight of the week's shows;
 *   - anonymous, it is a trip to log in that comes back here, in the
 *     visitor's locale — never an empty shell.
 *
 * Each signed-in run makes its own reader (an e2e-test-* user, swept by
 * globalSetup) so the list is exactly what this spec seeded: the shared
 * storageState user's subscriptions belong to other specs running in
 * parallel. The fixture shows use ids no other spec seeds.
 */

const FIXTURE = [
  { anilistId: 990_101, titleChinese: "E2E 在追 甲", episodes: 12, progress: 3 },
  { anilistId: 990_102, titleChinese: "E2E 在追 乙", episodes: 12, progress: 0 },
  { anilistId: 990_103, titleChinese: "E2E 在追 丙", episodes: 24, progress: 7 },
] as const;
const COMPLETED = { anilistId: 990_104, titleChinese: "E2E 已看完", episodes: 12 } as const;

/** The 继续看 cards on /watching, in page order. */
const cardHrefs = (page: Page) =>
  page.locator("main ul a[href*='/anime/']").evaluateAll((els) => els.map((el) => el.getAttribute("href")));

async function signIn(page: Page, user: TestUser) {
  await page.goto("/login");
  await waitForHydration(page, "#login-email");
  await page.locator("#login-email").fill(user.email);
  await page.locator("#login-password").fill(user.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login")),
    page.locator('button[type="submit"]').click(),
  ]);
}

test.describe("全部在追, signed in", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.afterAll(async () => {
    await closePg();
  });

  test("lists every show being watched as a 继续看 card, and both 全部在追 links lead here", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectConsoleErrors(page);
    const user = makeUser();
    await insertPgUser({ username: user.username, email: user.email, passwordHash: user.passwordHash });
    for (const show of [...FIXTURE, COMPLETED]) {
      await ensureAnimeCached({ anilistId: show.anilistId, titleChinese: show.titleChinese, episodes: show.episodes });
    }
    for (const show of FIXTURE) await seedSubscription(user.email, show.anilistId, "watching", show.progress);
    await seedSubscription(user.email, COMPLETED.anilistId, "completed", COMPLETED.episodes);

    await signIn(page, user);
    await page.goto("/watching");
    await expect(page.getByRole("heading", { level: 1, name: "全部在追" })).toBeVisible();
    await expect(page.getByText("3 部在追")).toBeVisible();

    // Exactly the three being watched — not the completed one.
    const hrefs = await cardHrefs(page);
    expect([...hrefs].sort()).toEqual(FIXTURE.map((s) => `/anime/${s.anilistId}`).sort());

    // Each is a 继续看 card: progress, the next episode, the continue label.
    const card = (id: number) => page.locator(`main ul a[href="/anime/${id}"]`);
    await expect(card(990_101)).toContainText("看到第 3 集");
    await expect(card(990_101)).toContainText("继续看第 4 集");
    await expect(card(990_101)).toContainText("3/12 集");
    await expect(card(990_102)).toContainText("还没开始看");
    await expect(card(990_102)).toContainText("从第 1 集开始");
    await expect(card(990_103)).toContainText("继续看第 8 集");
    await expect(card(990_103)).toContainText("7/24 集");
    // Each wears its own anime's colour, written on the card itself.
    for (const show of FIXTURE) {
      expect(await card(show.anilistId).evaluate((el) => (el as HTMLElement).style.getPropertyValue("--tone"))).toMatch(
        /^oklch\(/,
      );
    }
    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);

    // The homepage's 继续看 shows the same shows first, in the same order,
    // and its 全部在追 link opens this page.
    await page.goto("/");
    const continueSection = page.locator('section[aria-labelledby="home-continue"]');
    await expect(continueSection).toBeVisible();
    const homeOrder = await continueSection
      .locator("a[href*='/anime/']")
      .evaluateAll((els) => els.map((el) => el.getAttribute("href")));
    expect(homeOrder).toEqual(hrefs.slice(0, homeOrder.length));
    await waitForHydration(page, 'section[aria-labelledby="home-continue"] a');
    await continueSection.getByRole("link", { name: "全部在追" }).click();
    await expect(page).toHaveURL(/\/watching$/);
    await expect(page.getByRole("heading", { level: 1, name: "全部在追" })).toBeVisible();

    // The schedule page links out once the reader follows more than eight of
    // the week's shows. Follow nine of the week this stack is serving.
    await page.goto("/calendar");
    const weekIds = await page.evaluate(() => {
      const ids = new Set<number>();
      for (const a of Array.from(document.querySelectorAll('[id^="schedule-panel-"] a[href^="/anime/"]'))) {
        const id = Number((a.getAttribute("href") ?? "").split("/")[2]);
        if (Number.isInteger(id) && id > 0) ids.add(id);
      }
      return [...ids];
    });
    test.skip(weekIds.length < 9, "fewer than nine shows air this week in this stack");
    for (const id of weekIds.slice(0, 9)) {
      await ensureAnimeRowExists(id);
      await seedSubscription(user.email, id, "watching", 0);
    }
    await page.reload();
    const mine = page.locator('section[aria-labelledby="schedule-mine"]');
    await expect(mine).toBeVisible();
    await waitForHydration(page, 'section[aria-labelledby="schedule-mine"] a');
    await mine.getByRole("link", { name: "全部在追" }).click();
    await expect(page).toHaveURL(/\/watching$/);
    // Now twelve: the three fixtures and the nine from the week.
    await expect(page.locator("main ul a[href*='/anime/']")).toHaveCount(12);
  });
});

test.describe("全部在追, anonymous", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("is a trip to log in that comes back here, in the visitor's locale", async ({ page }) => {
    await page.goto("/watching");
    await expect(page).toHaveURL(/\/login\?from=%2Fwatching$/);

    await page.goto("/en/watching");
    await expect(page).toHaveURL(/\/en\/login\?from=%2Fen%2Fwatching$/);
  });
});
