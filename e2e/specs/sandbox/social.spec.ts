import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { collectConsoleErrors } from "../_helpers";
import { closePg, ensureAnimeDetail, insertPgUser } from "../../fixtures/pg";
import { makeUser, type TestUser } from "../../fixtures/users";
import { waitForHydration } from "../../fixtures/hydration";

// The 社区 tab of an anime page (/anime/[id]/social), the write-review page
// and a thread's page, end to end against the local stack: next dev in front
// of go-api and Postgres.
//
// Every flow runs twice, at a desktop viewport and at the 390px phone width
// the canvas's mobile boards are drawn at.
//
// Isolation is by anime id, not by cleanup. The sandbox project runs
// fullyParallel, so each test owns its own seeded anime (and its own fresh
// users, which globalSetup's `e2e-test-%` sweep removes — with everything they
// wrote — at the start of the next run). Nothing here asserts on a list some
// other test also writes to. A run's first render of an anime can still be the
// previous run's (see serverRenderHas), so what a test wrote is found by its id
// or waited for, never read off the first render.
//
// Seeding through ensureAnimeDetail keeps every read off AniList: a complete
// cached row is what the detail read and the subscription write accept without
// going upstream, and the community endpoints never go upstream at all.

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, base: 9_904_600 },
  { name: "phone", viewport: { width: 390, height: 844 }, base: 9_904_700 },
] as const;

const BASE_URL = process.env.E2E_SANDBOX_BASE_URL ?? "http://localhost:3000";

test.afterAll(async () => {
  await closePg();
});

// A move to another route waits for it as long as detail-tabs.spec.ts does:
// `next dev` compiles a route on its first request, and evicts one nobody
// has asked for in a while, so the first click into the write-review page or
// a thread can take far longer than an assertion's default 5s.
const NAVIGATION = { timeout: 30_000 };

async function seedAnime(id: number, title: string): Promise<void> {
  await ensureAnimeDetail({ anilistId: id, titleRomaji: `E2E Social ${id}`, titleChinese: title, episodes: 12 });
}

async function newUser(): Promise<TestUser> {
  const user = makeUser();
  await insertPgUser({ username: user.username, email: user.email, passwordHash: user.passwordHash });
  return user;
}

/** Sign `request` in as `user`; the session cookies land in its jar. */
async function signIn(request: APIRequestContext, user: TestUser): Promise<void> {
  const res = await request.post("/api/auth/login", { data: { email: user.email, password: user.password } });
  expect(res.ok(), `login ${user.username}: ${res.status()}`).toBe(true);
}

/** Write through the API as `user` from a context of its own. */
async function asUser<T>(
  playwright: typeof import("@playwright/test")["request"],
  user: TestUser,
  work: (api: APIRequestContext) => Promise<T>,
): Promise<T> {
  const api = await playwright.newContext({ baseURL: BASE_URL });
  try {
    await signIn(api, user);
    return await work(api);
  } finally {
    await api.dispose();
  }
}

const REVIEW_BODY = "芙莉莲的旅途是一场关于时间的告别。".repeat(20);

async function gotoSocial(page: Page, id: number): Promise<void> {
  const res = await page.goto(`/anime/${id}/social`);
  expect(res?.status()).toBe(200);
}

/**
 * Whether the server render of `path` includes `text`, waiting briefly for it.
 *
 * The server keeps its read of the community for 60s and answers the first
 * visit after that from the old copy while it refreshes, and every run of this
 * file reuses the same anime ids — so a first render can be the previous run's,
 * showing reviews and people that globalSetup has since deleted. Under next dev
 * the refreshed read arrives within a request or two. A production build also
 * keeps the rendered page for those 60s, so there it may not arrive in time.
 */
async function serverRenderHas(page: Page, path: string, text: string): Promise<boolean> {
  try {
    await expect.poll(async () => (await page.request.get(path)).text(), { timeout: 5_000 }).toContain(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hold back the answer to the page's signed-in re-read (GET of exactly
 * `pathname`) until `release()`.
 *
 * The answer is fetched at once, so it carries the state from before whatever
 * the test does next, and is handed to the page only afterwards. That is the
 * order a quick click produces against a production build, which hydrates
 * before the re-read comes back; under next dev it would almost never happen
 * on its own. `reads()` counts the re-reads answered so far.
 */
async function holdReread(page: Page, pathname: RegExp): Promise<{ release: () => void; reads: () => number }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route(
    (url) => pathname.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      await released;
      await route.fulfill({ response });
      reads += 1;
    },
  );
  return { release, reads: () => reads };
}

for (const { name, viewport, base } of VIEWPORTS) {
  test.describe(`社区 tab · ${name}`, () => {
    test.use({ viewport, storageState: { cookies: [], origins: [] } });

    test("signed out: the four sections and their empty states, no score, and 写评价 asks to log in", async ({ page }) => {
      const id = base + 1;
      await seedAnime(id, "E2E 社区空番");
      const errors = collectConsoleErrors(page);

      await gotoSocial(page, id);
      await expect(page.getByRole("heading", { level: 1, name: "E2E 社区空番" })).toBeVisible();
      for (const heading of ["评价", "讨论帖", "最近动态", "谁在追"]) {
        await expect(page.getByRole("heading", { level: 2, name: heading, exact: true })).toBeVisible();
      }
      for (const empty of ["还没有人写评价", "还没有讨论帖", "还没有动态", "还没有人追这部番"]) {
        await expect(page.getByText(empty, { exact: true })).toBeVisible();
      }
      // The tab's own column, under the shared tab bar: the hero above it
      // keeps the AniList / Bangumi scores the overview always had.
      const tab = await page.locator("#detail-tabs ~ div").innerText();
      expect(tab).not.toMatch(/评分|★/);
      expect(tab).not.toContain("评价是完整的观后感");

      await waitForHydration(page, `a[href$="/anime/${id}/social/review"]`);
      await page.getByRole("link", { name: "写评价" }).click();
      await expect(page).toHaveURL(new RegExp(`/anime/${id}/social/review$`), NAVIGATION);
      await expect(page.getByText("登录后写评价")).toBeVisible();
      expect(errors, errors.join("\n")).toEqual([]);
    });

    test("write a review: short text is held back, then it publishes and shows on the tab", async ({ page }) => {
      const id = base + 2;
      await seedAnime(id, "E2E 写评价");
      const author = await newUser();
      await signIn(page.request, author);

      await page.goto(`/anime/${id}/social/review`);
      await waitForHydration(page, "#review-summary", { timeout: 20_000 });
      await expect(page.getByRole("heading", { level: 1, name: "写评价" })).toBeVisible();

      await page.locator("#review-summary").fill("太短了");
      await page.locator("#review-body").fill("也太短");
      await page.getByRole("button", { name: "发布评价" }).click();
      await expect(page.locator("#review-summary")).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator("#review-body")).toHaveAttribute("aria-invalid", "true");
      await expect(page).toHaveURL(/\/social\/review$/);

      // Unique per attempt: a retry runs against the same anime, whose
      // earlier attempt's review is still there.
      const summary = `一部关于时间与告别的温柔之作 ${randomUUID().slice(0, 4)}`;
      await page.locator("#review-summary").fill(summary);
      await page.locator("#review-body").fill(REVIEW_BODY);
      await expect(page.getByText(`${Array.from(REVIEW_BODY).length} 字，至少 300 字`)).toBeVisible();
      await page.getByRole("button", { name: "发布评价" }).click();

      await expect(page).toHaveURL(new RegExp(`/anime/${id}/social#review-`), NAVIGATION);
      await expect(page.getByRole("heading", { level: 3, name: summary })).toBeVisible();
      await expect(page.getByRole("link", { name: "修改我的评价" })).toBeVisible();
    });

    test("vote 有用 on someone else's review, and it stays voted", async ({ page, playwright }) => {
      const id = base + 3;
      await seedAnime(id, "E2E 有用");
      const [author, voter] = [await newUser(), await newUser()];
      const reviewId = await asUser(playwright.request, author, async (api) => {
        const res = await api.post(`/api/anime/${id}/community/reviews`, {
          data: { summary: "值得一看的一部温柔的番", body: REVIEW_BODY, isSpoiler: false, isPrivate: false },
        });
        expect(res.status()).toBe(201);
        return ((await res.json()) as { data: { id: string } }).data.id;
      });
      await signIn(page.request, voter);

      // By id: a first render may still show the previous run's review (see
      // serverRenderHas); this one arrives with the reader's re-read if not.
      await gotoSocial(page, id);
      const helpful = page.locator(`#review-${reviewId}`).getByRole("button", { name: /有用/ });
      await waitForHydration(page, `#review-${reviewId} button[aria-pressed]`);
      await helpful.click();
      await expect(helpful).toHaveAttribute("aria-pressed", "true");
      await expect(helpful).toContainText("1");

      await page.reload();
      await expect(page.locator(`#review-${reviewId}`).getByRole("button", { name: /有用/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    test("start a thread, open it and reply", async ({ page }) => {
      const id = base + 4;
      await seedAnime(id, "E2E 讨论帖");
      const poster = await newUser();
      await signIn(page.request, poster);

      await gotoSocial(page, id);
      await waitForHydration(page, "#threads button[aria-expanded]");
      await page.locator("#threads").getByRole("button", { name: "发帖" }).click();
      // Unique per attempt, as the review's summary above.
      const title = `第五集的回忆杀大家怎么看 ${randomUUID().slice(0, 4)}`;
      await page.locator("#community-thread-title").fill(title);
      await page.locator("#community-thread-body").fill("辛美尔那段真的好戳我。");
      await page.getByRole("button", { name: "发布", exact: true }).click();

      const row = page.getByRole("link", { name: new RegExp(title) });
      await expect(row).toBeVisible();
      // The thread page re-reads the thread for its signed-in reader; that
      // answer arrives only after the reply below is posted.
      const reread = await holdReread(page, new RegExp(`^/api/anime/${id}/community/threads/[0-9a-f-]{36}$`));
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/anime/${id}/social/threads/[0-9a-f-]{36}$`), NAVIGATION);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

      const box = page.getByPlaceholder("写回复，最多 500 字");
      await waitForHydration(page, 'input[placeholder="写回复，最多 500 字"]');
      await box.fill("我觉得她是第一次意识到时间的意义。");
      await page.getByRole("button", { name: "发送" }).click();
      const posted = page.getByText("我觉得她是第一次意识到时间的意义。");
      await expect(posted).toBeVisible();
      await expect(box).toHaveValue("");

      // The re-read answers now, from before the reply. It must not take the
      // reply off the page (it is thrown away and read again).
      reread.release();
      await expect.poll(reread.reads).toBe(2);
      await expect(posted).toBeVisible();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });

    test("reply to an activity and like it", async ({ page, playwright }) => {
      const id = base + 5;
      await seedAnime(id, "E2E 动态");
      const [finisher, friend] = [await newUser(), await newUser()];
      await asUser(playwright.request, finisher, async (api) => {
        const res = await api.post("/api/subscriptions", { data: { anilistId: id, status: "completed" } });
        expect(res.status()).toBe(201);
      });
      await signIn(page.request, friend);

      // For the like below to race the page's re-read, the server render has
      // to show the card already. It does once the server's read has caught up
      // (see serverRenderHas); if it never does here, the card comes only with
      // the re-read and there is no race to set up.
      const fresh = await serverRenderHas(page, `/anime/${id}/social`, finisher.username);
      const reread = await holdReread(page, new RegExp(`^/api/anime/${id}/community$`));
      await gotoSocial(page, id);
      const card = page.locator("article", { hasText: `${finisher.username} 看完了《E2E 动态》` });
      const racing = fresh && (await card.count()) > 0;
      if (!racing) reread.release();
      await expect(card).toBeVisible();
      await waitForHydration(page, '#activity button[aria-pressed]');

      const like = card.getByRole("button", { name: /赞/ });
      await like.click();
      await expect(like).toHaveAttribute("aria-pressed", "true");
      await expect(like).toContainText("1");
      if (racing) {
        // The re-read sent on load answers only now, from before the like.
        // It must not undo the like (it is thrown away and read again).
        reread.release();
        await expect.poll(reread.reads).toBe(2);
        await expect(like).toHaveAttribute("aria-pressed", "true");
        await expect(like).toContainText("1");
      }

      await card.getByRole("button", { name: /回复/ }).click();
      await card.getByPlaceholder("写回复，最多 500 字").fill("我也刚看完，后劲好大");
      await card.getByRole("button", { name: "发送" }).click();
      await expect(card.getByText("我也刚看完，后劲好大")).toBeVisible();

      // 谁在追 lists the finisher, and the summary line says so.
      await expect(page.getByText("1 人 · 都已看完")).toBeVisible();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });

    test("a private review is seen by its author and nobody else", async ({ page, browser, playwright }) => {
      // Three sessions and three full page loads: past 30s on a busy machine.
      test.slow();
      const id = base + 6;
      await seedAnime(id, "E2E 私密评价");
      const [writer, other] = [await newUser(), await newUser()];
      await asUser(playwright.request, writer, (api) =>
        api.post(`/api/anime/${id}/community/reviews`, {
          data: { summary: "只给自己看的私密评价笔记", body: REVIEW_BODY, isSpoiler: false, isPrivate: true },
        }),
      );

      await signIn(page.request, other);
      await gotoSocial(page, id);
      await waitForHydration(page, "#threads button[aria-expanded]");
      await expect(page.getByText("还没有人写评价")).toBeVisible();
      await expect(page.getByText("只给自己看的私密评价笔记")).toHaveCount(0);

      const anonymous = await browser.newContext({ viewport, storageState: { cookies: [], origins: [] } });
      const anonPage = await anonymous.newPage();
      await anonPage.goto(`${BASE_URL}/anime/${id}/social`);
      await expect(anonPage.getByText("还没有人写评价")).toBeVisible();
      await expect(anonPage.getByText("只给自己看的私密评价笔记")).toHaveCount(0);
      await anonymous.close();

      const own = await browser.newContext({ viewport, storageState: { cookies: [], origins: [] }, baseURL: BASE_URL });
      const ownPage = await own.newPage();
      await signIn(ownPage.request, writer);
      await ownPage.goto(`/anime/${id}/social`);
      await expect(ownPage.getByText("只给自己看的私密评价笔记")).toBeVisible();
      await expect(ownPage.getByText("仅自己可见")).toBeVisible();
      await own.close();
    });

    test("an unknown anime, thread or id answers a real 404", async ({ page }) => {
      const id = base + 7;
      await seedAnime(id, "E2E 404");
      // The paired positive: without it a run where every route 404s would
      // satisfy every assertion below (see not-found-status.spec.ts).
      expect((await page.request.get(`/anime/${id}/social`)).status()).toBe(200);
      expect((await page.request.get(`/anime/0/social`)).status()).toBe(404);
      expect((await page.request.get(`/anime/not-an-id/social`)).status()).toBe(404);
      expect((await page.request.get(`/anime/${id}/social/threads/${randomUUID()}`)).status()).toBe(404);
      expect((await page.request.get(`/anime/${id}/social/threads/not-a-uuid`)).status()).toBe(404);
      expect((await page.request.get(`/anime/0/social/review`)).status()).toBe(404);
      // The API itself: an anime the catalogue does not hold is a 404 from
      // the cache alone — nothing is fetched upstream.
      expect((await page.request.get(`/api/anime/2147480000/community`)).status()).toBe(404);
    });
  });
}
