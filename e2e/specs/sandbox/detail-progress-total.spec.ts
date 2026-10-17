import { test, expect, type Page } from "@playwright/test";
import { waitForHydration } from "../../fixtures/hydration";
import {
  closePg,
  ensureAnimeDetail,
  insertPgUser,
  removeAnimeFixture,
  seedSubscription,
} from "../../fixtures/pg";
import { makeUser, type TestUser } from "../../fixtures/users";

// The "watched N / total" readout beside the status select, on a show AniList
// has no episode count for yet.
//
// Every airing show is in that state until its run ends. The episode grid
// draws its cells from the inferred count (episodesBgm) and says "2 / 12";
// the readout beside the select read AniList's count alone and hid itself as
// unknown, right above a list that knew the answer. Both now read the grid's
// total (gridTotal), and this pins the case that differed: AniList null, an
// inferred twelve.
//
// A reader of its own (an e2e-test-* user, swept by globalSetup), so the
// subscription is exactly what this spec seeded.

test.use({ storageState: { cookies: [], origins: [] } });

const SHOW = 990_100_031;
const INFERRED_TOTAL = 12;

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

/** The readout beside the select: "已看", the count, "/total", a bar. */
const readout = (page: Page, watched: number) =>
  page.getByText(new RegExp(`^已看\\s*${watched}\\s*/${INFERRED_TOTAL}$`));

test.beforeAll(async () => {
  await ensureAnimeDetail({
    anilistId: SHOW,
    titleRomaji: "E2E Progress Total",
    titleChinese: "E2E 进度总集数",
    status: "RELEASING",
    episodes: null,
    episodesBgm: INFERRED_TOTAL,
  });
});

test.afterAll(async () => {
  await removeAnimeFixture(SHOW);
  await closePg();
});

test("an airing show with no AniList count still shows watched N / total beside the status", async ({ page }) => {
  test.setTimeout(90_000);
  const user = makeUser();
  await insertPgUser({ username: user.username, email: user.email, passwordHash: user.passwordHash });
  await seedSubscription(user.email, SHOW, "watching", 2);

  await signIn(page, user);
  await page.goto(`/anime/${SHOW}`);

  await expect(readout(page, 2)).toBeVisible();

  // And it follows the grid, which owns the set.
  await waitForHydration(page, '[data-episode-toggle="true"]');
  await page.locator('[data-episode-toggle="true"]').nth(2).click();
  await expect(readout(page, 3)).toBeVisible();
});
