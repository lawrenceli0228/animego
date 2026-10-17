import { test, expect, type Page } from "@playwright/test";
import { waitForHydration } from "../../fixtures/hydration";
import {
  closePg,
  ensureAnimeDetail,
  insertPgUser,
  readSubscription,
  removeAnimeFixture,
} from "../../fixtures/pg";
import { makeUser, type TestUser } from "../../fixtures/users";

// The first episode a reader marks on a show that is not on their list yet.
//
// GET /api/subscriptions/{id} answers "no row" with 200 + `{ data: null }`.
// The grid only recognised a 404 as "no row", read the null envelope as a
// default `watching` subscription, skipped creating one, and sent the episode
// write against a row that did not exist. The server refused it, the cell
// rolled back, and on any show not already followed no cell could be marked.
//
// Unit tests could not see it: they fed the parser the shape the grid
// expected, not the one go-api sends. This runs against the real server, and
// asserts on Postgres rather than on the cell, because the optimistic check
// paints before the write lands and stays painted until the rollback.
//
// A reader of its own (an e2e-test-* user, swept by globalSetup), so "not on
// the list" is true by construction rather than by cleanup order.

test.use({ storageState: { cookies: [], origins: [] } });

const SHOW = 990_100_030;
const EPISODES = 12;
const MARKED = 2;

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

/** The toggle for one episode, once the grid knows whose it is. */
const toggle = (page: Page, episode: number) =>
  page.locator('[data-episode-toggle="true"]').nth(episode - 1);

test.beforeAll(async () => {
  await ensureAnimeDetail({
    anilistId: SHOW,
    titleRomaji: "E2E First Mark",
    titleChinese: "E2E 首次标记",
    status: "RELEASING",
    episodes: EPISODES,
  });
});

test.afterAll(async () => {
  await removeAnimeFixture(SHOW);
  await closePg();
});

test("marking an episode of a show not yet followed adds it and keeps the mark", async ({ page }) => {
  test.setTimeout(90_000);
  const user = makeUser();
  await insertPgUser({ username: user.username, email: user.email, passwordHash: user.passwordHash });
  expect(await readSubscription(user.email, SHOW)).toBeNull();

  await signIn(page, user);
  await page.goto(`/anime/${SHOW}`);
  // The hint renders only once the subscription probe has answered, which is
  // when a cell stops being an inert placeholder and becomes the reader's.
  await expect(page.getByText("点一下某一集，记录你真正看过的那一集。")).toBeVisible();
  await waitForHydration(page, '[data-episode-toggle="true"]');

  await toggle(page, MARKED).click();

  await expect
    .poll(async () => (await readSubscription(user.email, SHOW))?.currentEpisode ?? null, {
      message: "the click should create the subscription and record the episode",
    })
    .toBe(MARKED);
  await expect(page.getByText(`第 ${MARKED} 集没记上`)).toHaveCount(0);

  await page.reload();
  await expect(toggle(page, MARKED)).toHaveAttribute("data-state", "watched");
  await expect(toggle(page, MARKED - 1)).toHaveAttribute("data-state", "unwatched");
});
