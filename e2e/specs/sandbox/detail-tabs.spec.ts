import { test, expect, type Page, type Request, type Route } from "@playwright/test";
import {
  closePg,
  ensureAnimeDetail,
  removeAnimeFixture,
  removeDetailCredits,
  resetSubscriptions,
  seedDetailCredits,
  seedSubscription,
  type SeedCastCharacter,
  type SeedStaffCredit,
} from "../../fixtures/pg";
import { waitForHydration } from "../../fixtures/hydration";
import { SEED_USER_EMAIL } from "../../globalSetup";

// The detail page's tabs: 概览 at /anime/:id, 角色 at /anime/:id/characters,
// 制作 at /anime/:id/staff, each its own route with the shared hero and the tab
// bar. What is checked here is what a reader does with them — the counts in
// the bar, the overview's 「全部」 links, the role filter, the dub switch, the
// search and 「再显示」 on the cast, the department filter and the names-only
// department on the staff — at a desktop width and at a phone's, plus the
// status a crawler gets for a title that does not exist.
//
// Own fixture ids, like every sandbox spec. The title has 30 characters with
// AniList ids plus ensureAnimeDetail's protagonist (a row from before ids, no
// voice), so 31; 25 voiced in Japanese, 3 in Chinese, one with a childhood
// voice; and 49 people on the staff, 45 of them key animators — enough for
// that department to list names only.
//
// One worker for the whole file: the fixture is seeded in beforeAll and
// removed in afterAll, and under fullyParallel a second worker's afterAll
// would remove it from under the first.
test.describe.configure({ mode: "default" });
// No login (nothing here is per-user), and a Chinese browser so the
// "view this page in English?" hint stays out of the way.
test.use({ storageState: { cookies: [], origins: [] }, locale: "zh-CN" });

const TITLE = 990_200_001;
const MISSING = 990_209_999;
const CHAR = (n: number) => 990_210_000 + n;
const VOICE = (n: number) => 990_220_000 + n;
const PERSON = (n: number) => 990_230_000 + n;

function role(i: number): SeedCastCharacter["role"] {
  if (i <= 2) return "MAIN";
  if (i <= 20) return "SUPPORTING";
  return "BACKGROUND";
}

const CAST: SeedCastCharacter[] = Array.from({ length: 30 }, (_, k) => {
  const i = k + 1;
  const voices: NonNullable<SeedCastCharacter["voices"]>[number][] = [];
  if (i <= 25) {
    voices.push({
      staffId: VOICE(i),
      language: "Japanese",
      nameFull: `E2E Seiyuu ${i}`,
      nameNative: `試験声優${i}`,
      ...(i === 1 ? { nameCn: "测试声优" } : {}),
    });
  }
  if (i === 1) {
    voices.push({
      staffId: VOICE(101),
      language: "Japanese",
      nameFull: "E2E Child Voice",
      nameNative: "子役試験",
      roleNotes: "Childhood",
      nameCn: "童星测试",
    });
  }
  if (i <= 3) {
    voices.push({ staffId: VOICE(200 + i), language: "Chinese", nameFull: `Zhong ${i}`, nameNative: `中配试验${i}` });
  }
  return {
    characterId: CHAR(i),
    role: role(i),
    nameEn: i === 1 ? "E2E Frieren" : `E2E Character ${i}`,
    nameJa: i === 1 ? "フリーレン試験" : `キャラ${i}`,
    ...(i === 1 ? { nameCn: "测试芙莉莲" } : {}),
    voices,
  };
});

const STAFF: SeedStaffCredit[] = [
  { staffId: PERSON(1), role: "Director", nameEn: "E2E Director", nameJa: "監督試験" },
  { staffId: PERSON(2), role: "Series Composition", nameEn: "E2E Writer", nameJa: "構成試験" },
  { staffId: PERSON(1), role: "Storyboard (eps 1, 2)", nameEn: "E2E Director", nameJa: "監督試験" },
  { staffId: PERSON(3), role: "Music", nameEn: "E2E Composer", nameJa: "作曲試験" },
  { staffId: PERSON(4), role: "Character Design", nameEn: "E2E Designer", nameJa: "人設試験" },
  ...Array.from({ length: 45 }, (_, k) => ({
    staffId: PERSON(100 + k),
    role: "Key Animation",
    nameEn: `E2E Animator ${k + 1}`,
    nameJa: `原画試験${k + 1}`,
  })),
];

test.beforeAll(async () => {
  await ensureAnimeDetail({
    anilistId: TITLE,
    titleRomaji: "E2E Detail Tabs",
    titleChinese: "E2E 标签页",
    status: "FINISHED",
    episodes: 12,
    description: "E2E synopsis for the detail tabs.",
  });
  await seedDetailCredits(TITLE, CAST, STAFF);
});

test.afterAll(async () => {
  await removeAnimeFixture(TITLE);
  await removeDetailCredits(
    CAST.map((c) => c.characterId),
    CAST.flatMap((c) => (c.voices ?? []).map((v) => v.staffId)),
  );
  await closePg();
});

/**
 * The budget for a click to land on the next tab. A tab switch is a client
 * navigation, and on `next dev` its first one per route waits for the RSC
 * render and any compile behind it — seconds past expect's 5s default. The
 * navigation timeout is the budget a page.goto gets for the same work.
 */
const NAVIGATION = { timeout: 30_000 };

const tabs = (page: Page) => page.getByRole("navigation", { name: "作品页标签" });
const castRegion = (page: Page) => page.getByRole("region", { name: "角色与配音" });
const cards = (page: Page) => castRegion(page).getByRole("listitem");
const staffRegion = (page: Page) => page.getByRole("region", { name: "制作人员" });

async function expectActiveTab(page: Page, name: RegExp) {
  await expect(tabs(page).getByRole("link", { name })).toHaveAttribute("aria-current", "page");
  await expect(tabs(page).locator('[aria-current="page"]')).toHaveCount(1);
}

/**
 * Hold the browser's requests for the cast that match `pattern` until
 * `release()`, then let each through — or not, when the page has given up on
 * it in the meantime. `ended` settles once every held request has finished or
 * failed in the browser, so what the page did with it has happened.
 */
async function holdCastRequests(page: Page, pattern: RegExp) {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const pending: Promise<void>[] = [];
  const outcomes: Promise<string>[] = [];
  await page.route(pattern, (route: Route) => {
    const request = route.request();
    outcomes.push(
      new Promise<string>((resolve) => {
        const settle = (outcome: string) => (r: Request) => {
          if (r !== request) return;
          page.off("requestfinished", finished);
          page.off("requestfailed", failed);
          resolve(outcome);
        };
        const finished = settle("finished");
        const failed = settle("failed");
        page.on("requestfinished", finished);
        page.on("requestfailed", failed);
      }),
    );
    const done = (async () => {
      try {
        const response = await route.fetch();
        await released;
        await route.fulfill({ response });
      } catch {
        // The page aborted it while it was held: route.fulfill has nothing
        // left to answer. That is one of the outcomes the callers allow.
      }
    })();
    pending.push(done);
    return done;
  });
  return {
    release,
    held: () => pending.length,
    ended: async () => {
      await Promise.all(pending);
      const result = await Promise.all(outcomes);
      // Two frames: a response the page did take has been rendered by now.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      return result;
    },
  };
}

test.describe("desktop", () => {
  test("every tab carries the tab bar, with the counts, and marks itself", async ({ page }) => {
    // Three routes, each compiled on arrival by `next dev` when it has gone
    // cold: a budget problem, not a race (see locale-routing.spec.ts).
    test.slow();
    await page.goto(`/anime/${TITLE}`);
    await expect(page.locator("h1")).toHaveText("E2E 标签页");
    const bar = tabs(page);
    await expect(bar.getByRole("link", { name: "概览" })).toHaveAttribute("href", `/anime/${TITLE}`);
    await expect(bar.getByRole("link", { name: "角色 31" })).toHaveAttribute("href", `/anime/${TITLE}/characters`);
    await expect(bar.getByRole("link", { name: "制作 49" })).toHaveAttribute("href", `/anime/${TITLE}/staff`);
    await expectActiveTab(page, /^概览$/);

    await page.goto(`/anime/${TITLE}/characters`);
    await expect(page.locator("h1")).toHaveText("E2E 标签页");
    await expectActiveTab(page, /^角色 31$/);

    await page.goto(`/anime/${TITLE}/staff`);
    await expect(page.locator("h1")).toHaveText("E2E 标签页");
    await expectActiveTab(page, /^制作 49$/);
  });

  test("the overview's 「全部」 links and the tab bar lead to the tabs", async ({ page }) => {
    test.slow();
    await page.goto(`/anime/${TITLE}`);
    await waitForHydration(page, `a[href="/anime/${TITLE}/characters"]`);

    // Eight characters on the overview, as before, and the way to the rest.
    await page.getByRole("link", { name: "全部 31 位角色" }).click();
    await expect(page).toHaveURL(new RegExp(`/anime/${TITLE}/characters$`), NAVIGATION);
    await expect(cards(page)).toHaveCount(24);

    // The bar moves between tabs without a reload.
    await tabs(page).getByRole("link", { name: /^制作/ }).click();
    await expect(page).toHaveURL(new RegExp(`/anime/${TITLE}/staff$`), NAVIGATION);
    await expect(staffRegion(page).getByRole("heading", { name: "音乐" })).toBeVisible();

    await tabs(page).getByRole("link", { name: "概览" }).click();
    await expect(page).toHaveURL(new RegExp(`/anime/${TITLE}$`), NAVIGATION);
    await page.getByRole("link", { name: "全部 49 位" }).click();
    await expect(page).toHaveURL(new RegExp(`/anime/${TITLE}/staff$`), NAVIGATION);
  });

  test("characters: role filter, dub switch, search and 「再显示」", async ({ page }) => {
    await page.goto(`/anime/${TITLE}/characters`);
    const roles = page.getByRole("group", { name: "按定位筛选" });
    await waitForHydration(page, "input[type=search]");

    // The first page is in the server's HTML: 24 cards, every role counted.
    await expect(cards(page)).toHaveCount(24);
    await expect(roles.getByRole("button", { name: "全部 31" })).toHaveAttribute("aria-pressed", "true");
    await expect(roles.getByRole("button", { name: "主角 3" })).toBeVisible();
    await expect(roles.getByRole("button", { name: "配角 18" })).toBeVisible();
    await expect(roles.getByRole("button", { name: "客串 10" })).toBeVisible();

    // Bangumi's Chinese names, and the childhood voice under the main one.
    const frieren = cards(page).filter({ hasText: "测试芙莉莲" });
    await expect(frieren).toContainText("フリーレン試験");
    await expect(frieren).toContainText("测试声优");
    await expect(frieren).toContainText("童年 · 童星测试");

    // Only the dubs the title has: no 韩配 button at all.
    const dubs = page.getByRole("group", { name: "配音语言" });
    await expect(dubs.getByRole("button")).toHaveCount(2);
    await expect(dubs.getByRole("button", { name: "日配 25" })).toHaveAttribute("aria-pressed", "true");

    await roles.getByRole("button", { name: "主角 3" }).click();
    await expect(cards(page)).toHaveCount(3);
    await expect(roles.getByRole("button", { name: "主角 3" })).toHaveAttribute("aria-pressed", "true");

    // 中配 swaps the voices, not the characters.
    await dubs.getByRole("button", { name: "中配 3" }).click();
    await expect(cards(page).filter({ hasText: "测试芙莉莲" })).toContainText("中配试验1");
    await expect(cards(page).filter({ hasText: "测试芙莉莲" })).not.toContainText("测试声优");
    await expect(cards(page)).toHaveCount(3);

    await dubs.getByRole("button", { name: "日配 25" }).click();
    await roles.getByRole("button", { name: /^全部/ }).click();
    await expect(cards(page)).toHaveCount(24);

    // The search reads character names and the selected dub's voice names.
    const search = page.getByRole("searchbox", { name: "搜角色或声优" });
    await search.fill("测试声优");
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText("测试芙莉莲");
    await expect(roles.getByRole("button", { name: "全部 1" })).toBeVisible();
    await search.fill("キャラ2");
    // キャラ2, キャラ20 … キャラ29.
    await expect(cards(page)).toHaveCount(11);
    await search.fill("");
    await expect(cards(page)).toHaveCount(24);

    // From the keyboard: the last page arrives, the button goes, and focus
    // moves to the first card it added rather than to the top of the page.
    await page.getByRole("button", { name: "再显示 7 位" }).focus();
    await page.keyboard.press("Enter");
    await expect(cards(page)).toHaveCount(31);
    await expect(page.getByRole("button", { name: /再显示/ })).toHaveCount(0);
    await expect(cards(page).nth(24)).toBeFocused();
  });

  test("characters: an answer that arrives late never paints over a newer choice", async ({ page }) => {
    await page.goto(`/anime/${TITLE}/characters`);
    await waitForHydration(page, "input[type=search]");
    const roles = page.getByRole("group", { name: "按定位筛选" });

    // 主角 is chosen and its answer held; 配角 is chosen and answered at once.
    const main = await holdCastRequests(page, /\/characters\?(?:.*&)?role=main(?:&|$)/);
    await roles.getByRole("button", { name: "主角 3" }).click();
    await expect.poll(main.held).toBe(1);
    await roles.getByRole("button", { name: "配角 18" }).click();
    await expect(cards(page)).toHaveCount(18);
    main.release();
    await main.ended();
    await expect(cards(page)).toHaveCount(18);
    await expect(roles.getByRole("button", { name: "配角 18" })).toHaveAttribute("aria-pressed", "true");
    await expect(roles.getByRole("button", { name: "主角 3" })).toHaveAttribute("aria-pressed", "false");

    // 「再显示」 is pressed and its page held; a filter is chosen meanwhile.
    await roles.getByRole("button", { name: /^全部/ }).click();
    await expect(cards(page)).toHaveCount(24);
    const more = await holdCastRequests(page, /\/characters\?(?:.*&)?offset=24(?:&|$)/);
    await page.getByRole("button", { name: "再显示 7 位" }).click();
    await expect.poll(more.held).toBe(1);
    await roles.getByRole("button", { name: "客串 10" }).click();
    await expect(cards(page)).toHaveCount(10);
    more.release();
    await more.ended();
    await expect(cards(page)).toHaveCount(10);
    await expect(roles.getByRole("button", { name: "客串 10" })).toHaveAttribute("aria-pressed", "true");
  });

  test("characters: a failed request says so, and 重试 asks again", async ({ page }) => {
    await page.goto(`/anime/${TITLE}/characters`);
    await waitForHydration(page, "input[type=search]");
    const roles = page.getByRole("group", { name: "按定位筛选" });

    let failing = true;
    await page.route(/\/api\/anime\/\d+\/characters\?/, (route) =>
      failing
        ? route.fulfill({ status: 500, json: { error: { code: "SERVER_ERROR", message: "query failed" } } })
        : route.continue(),
    );
    await roles.getByRole("button", { name: "客串 10" }).click();
    const alert = castRegion(page).getByRole("alert");
    await expect(alert).toContainText("没能加载，请重试");

    failing = false;
    await alert.getByRole("button", { name: "重试" }).click();
    await expect(alert).toHaveCount(0);
    await expect(cards(page)).toHaveCount(10);
    await expect(roles.getByRole("button", { name: "客串 10" })).toHaveAttribute("aria-pressed", "true");
  });

  test("characters: nothing is searched while an input method is still composing", async ({ page }) => {
    await page.goto(`/anime/${TITLE}/characters`);
    await waitForHydration(page, "input[type=search]");
    const searched: string[] = [];
    page.on("request", (r) => {
      if (/\/characters\?(?:.*&)?q=/.test(r.url())) searched.push(decodeURIComponent(r.url()));
    });

    const cdp = await page.context().newCDPSession(page);
    await page.getByRole("searchbox", { name: "搜角色或声优" }).click();
    // Pinyin, a letter at a time, each pause longer than the 250ms debounce
    // (the same probe as search-typing.spec.ts).
    for (const pinyin of ["c", "ce", "ces", "cesh", "ceshi"]) {
      await cdp.send("Input.imeSetComposition", { text: pinyin, selectionStart: pinyin.length, selectionEnd: pinyin.length });
      await page.waitForTimeout(400);
    }
    expect(searched, "a search went out while the input method was composing").toEqual([]);
    await expect(cards(page)).toHaveCount(24);

    // Anti-vacuity: committing the composition searches.
    await cdp.send("Input.insertText", { text: "测试声优" });
    await expect(cards(page)).toHaveCount(1);
    expect(searched).toHaveLength(1);
    expect(searched[0]).toContain("q=测试声优");
  });

  test("staff: departments, the filter, the search and a names-only department", async ({ page }) => {
    await page.goto(`/anime/${TITLE}/staff`);
    await waitForHydration(page, "input[type=search]");
    const region = staffRegion(page);
    const chips = page.getByRole("group", { name: "按部门筛选" });

    await expect(chips.getByRole("button", { name: "全部 49" })).toHaveAttribute("aria-pressed", "true");
    for (const name of ["监督与演出", "系列构成 / 脚本", "人设与设定", "原画与动画", "音乐"]) {
      await expect(region.getByRole("heading", { name, exact: true })).toBeVisible();
    }

    // A person is one row per department, with every role they have there.
    await expect(region.getByRole("listitem").filter({ hasText: "監督試験" })).toContainText("监督");
    await expect(region.getByRole("listitem").filter({ hasText: "監督試験" })).toContainText("分镜");

    // Forty-five key animators: names only, the first 36, then the rest.
    const keyAnimation = region.getByRole("region", { name: "原画与动画" });
    await expect(keyAnimation.getByRole("listitem")).toHaveCount(36);
    await keyAnimation.getByRole("button", { name: "展开全部 45 位" }).click();
    await expect(keyAnimation.getByRole("listitem")).toHaveCount(45);

    await chips.getByRole("button", { name: "音乐 1" }).click();
    await expect(region.getByRole("heading", { name: "音乐", exact: true })).toBeVisible();
    await expect(region.getByRole("heading", { name: "原画与动画", exact: true })).toHaveCount(0);
    await expect(region.getByRole("listitem")).toHaveCount(1);
    await expect(region.getByRole("listitem")).toContainText("作曲試験");

    await chips.getByRole("button", { name: /^全部/ }).click();
    await page.getByRole("searchbox", { name: "搜人名或职务" }).fill("構成試験");
    await expect(region.getByRole("listitem")).toHaveCount(1);
    await expect(region.getByRole("heading", { name: "系列构成 / 脚本", exact: true })).toBeVisible();
  });

  test("staff: the list holds still while an input method is composing", async ({ page }) => {
    await page.goto(`/anime/${TITLE}/staff`);
    await waitForHydration(page, "input[type=search]");
    const chips = page.getByRole("group", { name: "按部门筛选" });
    const search = page.getByRole("searchbox", { name: "搜人名或职务" });

    const cdp = await page.context().newCDPSession(page);
    await search.click();
    await cdp.send("Input.imeSetComposition", { text: "gou", selectionStart: 3, selectionEnd: 3 });
    await expect(search).toHaveValue("gou");
    // Room for the deferred filter to have run, had it been given "gou".
    await page.waitForTimeout(300);
    await expect(chips.getByRole("button", { name: "全部 49" })).toBeVisible();
    await expect(page.getByText("没有找到对应的制作人员")).toHaveCount(0);

    await cdp.send("Input.insertText", { text: "構成試験" });
    await expect(staffRegion(page).getByRole("listitem")).toHaveCount(1);
    await expect(chips.getByRole("button", { name: "全部 1" })).toBeVisible();
  });

  test("a title the catalogue does not hold is a 404 on every tab", async ({ page }) => {
    // Read as a crawler reads it: the status of the response, no JavaScript.
    for (const path of [`/anime/${MISSING}/characters`, `/anime/${MISSING}/staff`, "/anime/0/characters", "/anime/0/staff"]) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(404);
    }
    // And a real one still answers, so the 404s above mean something.
    expect((await page.request.get(`/anime/${TITLE}/characters`)).status()).toBe(200);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the list tabs fold the hero to one line and keep the tab bar", async ({ page }) => {
    await page.goto(`/anime/${TITLE}/characters`);
    await expect(page.locator("h1")).toBeVisible();
    // The action row is the overview's; here the list starts on the first screen.
    await expect(page.getByRole("button", { name: "分享" })).toBeHidden();
    await expect(tabs(page)).toBeVisible();
    await expect(cards(page).first()).toBeInViewport();

    // A row is the 48x64 portrait and its padding. No voice actor here has a
    // portrait, and a box drawn for the missing one (64x96, as on a desktop)
    // would make every row 96px and take the name's room.
    expect((await cards(page).filter({ hasText: "キャラ5" }).boundingBox())?.height ?? 0).toBeLessThan(90);

    await waitForHydration(page, "input[type=search]");
    await page.getByRole("group", { name: "按定位筛选" }).getByRole("button", { name: "客串 10" }).click();
    await expect(cards(page)).toHaveCount(10);
  });

  test("a tab chosen from a scrolled tab bar opens on its list, the tab focused", async ({ page }) => {
    await page.goto(`/anime/${TITLE}`);
    await waitForHydration(page, `nav a[href="/anime/${TITLE}/characters"]`);
    // The overview's hero is tall on a phone; the list tabs' is one line. A
    // reader who has scrolled the bar to the top and taps 角色 must not land
    // below the filters with nothing focused.
    await tabs(page).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await tabs(page).getByRole("link", { name: /^角色/ }).click();
    await expect(page).toHaveURL(new RegExp(`/anime/${TITLE}/characters$`), NAVIGATION);

    await expect(page.getByRole("group", { name: "按定位筛选" })).toBeInViewport();
    await expect(tabs(page)).toBeInViewport();
    await expect(tabs(page).getByRole("link", { name: /^角色/ })).toBeFocused();
  });

  test("the overview keeps its hero and moves the characters link under the list", async ({ page }) => {
    await page.goto(`/anime/${TITLE}`);
    await expect(page.getByRole("button", { name: "分享" })).toBeVisible();
    // Two in the markup — the head's link and the button under the list — and
    // one shown at each width: on a phone, the full-width one under the list.
    await expect(page.getByRole("link", { name: "全部 31 位角色", includeHidden: true })).toHaveCount(2);
    const shown = page.getByRole("link", { name: "全部 31 位角色" });
    await expect(shown).toHaveCount(1);
    expect((await shown.boundingBox())?.width ?? 0).toBeGreaterThan(300);
    await shown.click();
    await expect(page).toHaveURL(new RegExp(`/anime/${TITLE}/characters$`), NAVIGATION);
  });

  test("staff: the department chips filter on a phone too", async ({ page }) => {
    await page.goto(`/anime/${TITLE}/staff`);
    await waitForHydration(page, "input[type=search]");
    await page.getByRole("group", { name: "按部门筛选" }).getByRole("button", { name: "原画与动画 45" }).click();
    // One department chosen: every name, no 「展开全部」.
    await expect(staffRegion(page).getByRole("listitem")).toHaveCount(45);
    await expect(page.getByRole("button", { name: /展开全部/ })).toHaveCount(0);
  });
});

test.describe("signed in", () => {
  test.use({ storageState: "./.auth/user.json" });

  // Reset first: a subscription outlives the title's fixture, and one a
  // previous run scored would show 「★ 10/10」 where this needs 「★ 评分」.
  test.beforeAll(async () => {
    await resetSubscriptions(SEED_USER_EMAIL, [TITLE]);
    await seedSubscription(SEED_USER_EMAIL, TITLE, "watching");
  });

  test.afterAll(async () => {
    await resetSubscriptions(SEED_USER_EMAIL, [TITLE]);
  });

  // The rating picker opens below the hero's action row and reaches into the
  // tab bar under it. The hero is a stacking context of its own; a positioned
  // bar would paint over the picker and take its clicks — scoring a show 10
  // opened 角色 instead.
  test("the rating picker opens over the tab bar and keeps its clicks", async ({ page }) => {
    await page.goto(`/anime/${TITLE}`);
    const rate = page.getByRole("button", { name: "★ 评分" });
    await waitForHydration(page, `nav a[href="/anime/${TITLE}/characters"]`);
    await rate.click();

    // The picker sits beside its button, in the wrapper they share.
    const ten = rate.locator("xpath=..").getByRole("button", { name: "10", exact: true });
    const box = await ten.boundingBox();
    expect(box).not.toBeNull();
    // The bottom edge of 「10」, where the picker overlaps the bar.
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.textContent ?? null,
      { x: box!.x + box!.width / 2, y: box!.y + box!.height - 2 },
    );
    expect(hit).toBe("10");

    await ten.click();
    await expect(page.getByRole("button", { name: "★ 10/10" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/anime/${TITLE}$`));
  });
});
