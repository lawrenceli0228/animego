import { test, expect, type Page } from "@playwright/test";
import { expectSignedIn, navbar } from "../_helpers";
import { waitForHydration } from "../../fixtures/hydration";

// The site header: AniList's structure, on every page.
//
// What is pinned here is behaviour a reader depends on and a unit test cannot
// see — which page is marked current, that the search box navigates and gives
// focus back, that the genre menu works from a keyboard, that the phone drawer
// is a real modal (focus in, focus trapped, page underneath not scrolling,
// focus back to ☰), and that the bar gets out of the way while scrolling down
// and comes back on the way up.
//
// Every interaction waits for React to own the control first. A click or a
// keystroke that lands on server HTML does nothing at all, and the failure
// reads as "the menu is broken" (fixtures/hydration.ts).

test.use({ storageState: { cookies: [], origins: [] } });

const SEARCH_TOGGLE = 'header button[aria-label="搜索番剧"]';
const GENRE_TRIGGER = "header nav ul button[aria-expanded]";
const LANGUAGE_TRIGGER = 'header button[aria-label="语言"]';
const AVATAR_TRIGGER = 'header button[aria-label="账户菜单"]';
const MENU_BUTTON = 'header button[aria-haspopup="dialog"]';

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

/**
 * Park the page part-way down with the bar showing, the way a reader gets
 * there: a scroll down (which tucks the bar away) and a short one back up
 * (which brings it back). Returns the position every "the page did not move"
 * assertion compares against.
 *
 * Each step waits until the header has SEEN it: scroll decisions run once per
 * animation frame, and two scrolls inside one frame are a single net move
 * (y → y + 20 → y would read as "down", and the bar would stay hidden). The
 * first step also waits until the page is long enough to stand at y + 20: on
 * a page still filling in, the browser clamps the scroll, and the way back up
 * to y then reads as a scroll DOWN. The last step waits out the slide back
 * in, so nothing is measured mid-move.
 *
 * Why so much of this file is about the page NOT moving: html carries
 * `scroll-padding-top: var(--nav-h)`, and before the bar's own controls were
 * exempted from it, every focus that landed on one — Escape handing focus back
 * to a trigger, the search field opening, ☰ getting focus back from the
 * drawer, a Tab into the bar — made the browser scroll the page to "reveal" a
 * control that was already on screen. Playwright's `locator.click()` scrolls
 * its target into view first and was thrown back the same way; that was the
 * page, not Playwright — a page without the padding stays put for the same
 * click. These tests click with `locator.click()` on purpose: it is one more
 * way into exactly that path.
 */
async function parkMidPage(page: Page, y: number): Promise<number> {
  const header = page.locator("header").first();
  await expect
    .poll(() => page.evaluate((to) => (window.scrollTo(0, to), window.scrollY), y + 20))
    .toBe(y + 20);
  await expect(header).toHaveAttribute("data-hidden", "true");
  await page.evaluate((to) => window.scrollTo(0, to), y);
  await expect(header).toHaveAttribute("data-hidden", "false");
  await expect.poll(async () => Math.round((await header.boundingBox())?.y ?? -1)).toBe(0);
  const at = await scrollY(page);
  expect(at).toBe(y);
  return at;
}

/** The centre link strip, in order: [label, href, aria-current]. */
async function centreLinks(page: Page) {
  return navbar(page)
    .locator("ul")
    .first()
    .locator(":scope > li > a, :scope > li > div > button")
    .evaluateAll((els) =>
      els.map((el) => [
        el.textContent?.trim() ?? "",
        el.getAttribute("href"),
        el.getAttribute("aria-current"),
      ]),
    );
}

test.describe("the desktop bar", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("links the agreed pages in order and marks the current one", async ({ page }) => {
    await page.goto("/calendar");
    const links = await centreLinks(page);
    expect(links.map(([label]) => label)).toEqual(["首页", "放送表", "季度", "分类", "关于"]);
    expect(links[0]?.[1]).toBe("/");
    expect(links[1]?.[1]).toBe("/calendar");
    expect(links[2]?.[1]).toMatch(/^\/seasonal\/(winter|spring|summer|fall)\/\d{4}$/);
    expect(links[4]?.[1]).toBe("/welcome");
    // Only 放送表 is current, and a visitor gets no 我的追番 and no
    // placeholder for it.
    expect(links.map(([, , current]) => current)).toEqual([null, "page", null, null, null]);
    await expect(navbar(page).locator('a[href="/profile"]')).toHaveCount(0);
    // /library is never a top-level link.
    await expect(navbar(page).locator('ul a[href="/library"]')).toHaveCount(0);
  });

  test("marks the current page under a locale prefix too", async ({ page }) => {
    // The strip is server-rendered, current marker included; nothing here
    // needs the page's images, so the DOM is enough to read it from.
    await page.goto("/en/calendar", { waitUntil: "domcontentloaded" });
    const links = await centreLinks(page);
    expect(links.map(([label]) => label)).toEqual(["Home", "Schedule", "Season", "Genres", "About"]);
    expect(links[1]).toEqual(["Schedule", "/en/calendar", "page"]);
    expect(links.filter(([, , current]) => current === "page")).toHaveLength(1);
  });

  test("search opens into a field, Enter goes to /search, Escape folds it back", async ({ page }) => {
    await page.goto("/faq");
    await waitForHydration(page, SEARCH_TOGGLE);
    const toggle = page.locator(SEARCH_TOGGLE);

    // Closed, the bar holds no field at all — /search's own box must stay the
    // only input[name=q] / form[role=search] on its page.
    await expect(navbar(page).locator("input")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const field = navbar(page).getByRole("searchbox", { name: "搜索番剧" });
    await expect(field).toBeFocused();

    // Escape folds it and hands focus back to the magnifier.
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();

    // Enter navigates.
    await toggle.click();
    await field.fill("frieren");
    await field.press("Enter");
    await page.waitForURL(/\/search\?q=frieren$/);
    await expect(page.locator('input[name="q"]')).toHaveValue("frieren");
    await expect(navbar(page).locator("input")).toHaveCount(0);
  });

  test("the Enter that confirms an input-method candidate does not search", async ({ page }) => {
    await page.goto("/faq");
    await waitForHydration(page, SEARCH_TOGGLE);
    await page.locator(SEARCH_TOGGLE).click();
    const field = navbar(page).getByRole("searchbox", { name: "搜索番剧" });
    await expect(field).toBeFocused();
    await field.fill("葬送");

    // Replays the two orders browsers really use for an IME commit, then a
    // submit — which is what a browser that does submit on that Enter does
    // next. Chrome/Firefox: keydown carries isComposing. Safari: the
    // composition has already ended, but the keydown's code is still 229.
    for (const init of [
      { key: "Enter", isComposing: true },
      { key: "Enter", keyCode: 229 },
    ]) {
      await field.evaluate((el, keyInit) => {
        const input = el as HTMLInputElement;
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "葬送" }));
        input.dispatchEvent(new KeyboardEvent("keydown", { ...keyInit, bubbles: true, cancelable: true }));
        input.form?.requestSubmit();
      }, init);
      await page.waitForTimeout(500);
      expect(new URL(page.url()).pathname).toBe("/faq");
      await expect(field).toBeVisible();
    }

    // A real Enter afterwards still searches.
    await field.press("Enter");
    await page.waitForURL(/\/search\?q=/);
    expect(decodeURIComponent(new URL(page.url()).search)).toBe("?q=葬送");
  });

  test("分类 opens from the keyboard, lists the genre hubs, and closes on Escape", async ({ page }) => {
    await page.goto("/faq");
    await waitForHydration(page, GENRE_TRIGGER);
    const trigger = page.locator(GENRE_TRIGGER);
    const action = navbar(page).getByRole("link", { name: "动作" });

    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(action).toBeHidden();

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute("href", "/genre/action");
    // Every browsable genre is there: the dropdown is the genre index.
    await expect(navbar(page).locator('ul a[href^="/genre/"]')).toHaveCount(18);

    // Tab walks into the panel's links.
    await page.keyboard.press("Tab");
    await expect(action).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(action).toBeHidden();
    await expect(trigger).toBeFocused();

    // Space opens it as well.
    await page.keyboard.press(" ");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("分类 also opens for a resting mouse and closes when it leaves", async ({ page }) => {
    await page.goto("/faq");
    await waitForHydration(page, GENRE_TRIGGER);
    const trigger = page.locator(GENRE_TRIGGER);
    await trigger.hover();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Down onto the panel: crossing the gap must not close it.
    await navbar(page).getByRole("link", { name: "动作" }).hover();
    await page.waitForTimeout(400);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    // And away.
    await page.mouse.move(700, 700);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("hides while scrolling down and comes back on the way up", async ({ page }) => {
    await page.goto("/welcome");
    await waitForHydration(page, "header nav");
    const header = page.locator("header").first();

    await expect(header).toHaveAttribute("data-hidden", "false");
    await expect(header).toHaveAttribute("data-glass", "false");
    expect((await header.boundingBox())?.y).toBe(0);

    await page.mouse.move(700, 600);
    await page.mouse.wheel(0, 900);
    await expect(header).toHaveAttribute("data-hidden", "true");
    // It is sticky, so out of the way means translated off the top edge — not
    // scrolled away with the page (it used to be: <body> was a scroll
    // container and sticky stuck inside it).
    await expect.poll(async () => Math.round((await header.boundingBox())?.y ?? 0)).toBe(-64);

    await page.mouse.wheel(0, -200);
    await expect(header).toHaveAttribute("data-hidden", "false");
    await expect(header).toHaveAttribute("data-glass", "true");
    await expect.poll(async () => Math.round((await header.boundingBox())?.y ?? -1)).toBe(0);
  });

  test("stays put while a menu is open", async ({ page }) => {
    await page.goto("/welcome");
    await waitForHydration(page, GENRE_TRIGGER);
    await page.locator(GENRE_TRIGGER).focus();
    await page.keyboard.press("Enter");
    await page.mouse.move(700, 600);
    await page.mouse.wheel(0, 900);
    // Glass is decided in the same step as hidden, so once it is on, the
    // scroll has been seen — "still visible" below is a decision, not a
    // header that simply has not looked yet.
    const header = page.locator("header").first();
    await expect(header).toHaveAttribute("data-glass", "true");
    await expect(header).toHaveAttribute("data-hidden", "false");
  });

  test("search, 分类 and the language menu take and give back focus without moving the page", async ({ page }) => {
    await page.goto("/welcome");
    await waitForHydration(page, SEARCH_TOGGLE);
    const at = await parkMidPage(page, 2400);

    // Search: the field takes the caret as it opens; Escape gives it back to
    // the magnifier. Was 2400 → 1500 on opening.
    const toggle = page.locator(SEARCH_TOGGLE);
    await toggle.click();
    const field = navbar(page).getByRole("searchbox", { name: "搜索番剧" });
    await expect(field).toBeFocused();
    expect(await scrollY(page)).toBe(at);
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(toggle).toBeFocused();
    expect(await scrollY(page)).toBe(at);

    // 分类 from the keyboard: focus, Enter, Tab into the panel, Escape.
    const trigger = page.locator(GENRE_TRIGGER);
    await trigger.focus();
    expect(await scrollY(page)).toBe(at);
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await expect(navbar(page).getByRole("link", { name: "动作" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
    expect(await scrollY(page)).toBe(at);

    // The language menu moves focus onto the current option as it opens and
    // back to its trigger on Escape.
    const language = page.locator(LANGUAGE_TRIGGER);
    await language.click();
    await expect(page.getByRole("menuitem", { name: "简体中文" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(language).toHaveAttribute("aria-expanded", "false");
    await expect(language).toBeFocused();
    expect(await scrollY(page)).toBe(at);
  });

  test("Tab into the bar does not move the page, shown or tucked away", async ({ page }) => {
    await page.goto("/welcome");
    await waitForHydration(page, "header nav");
    const header = page.locator("header").first();
    const at = await parkMidPage(page, 2400);

    // Shown: the first Tab on the page lands on the wordmark.
    await page.keyboard.press("Tab");
    await expect(navbar(page).getByRole("link", { name: "AnimeGoClub" })).toBeFocused();
    expect(await scrollY(page)).toBe(at);

    // Tucked away: the bar comes back at once and the page stays where it is.
    // (The browser scrolls toward a focused control before the header's own
    // scroll logic runs; measured on a hidden bar, that was hundreds of
    // pixels even with no scroll-padding at all.)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.evaluate(() => window.scrollTo(0, window.scrollY + 600));
    await expect(header).toHaveAttribute("data-hidden", "true");
    await expect.poll(async () => Math.round((await header.boundingBox())?.y ?? 0)).toBe(-64);
    const hiddenAt = await scrollY(page);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("header"))).toBe(true);
    expect(await scrollY(page)).toBe(hiddenAt);
    expect(Math.round((await header.boundingBox())?.y ?? -1)).toBe(0);
    await expect(header).toHaveAttribute("data-hidden", "false");
  });

  test("an anchor, and a control focused under the bar, still land clear of it", async ({ page }) => {
    // The other half of the bargain: html's scroll-padding-top is still there
    // for everything that is not in the bar.
    await page.goto("/welcome");
    await waitForHydration(page, "header nav");
    const anchorTop = await page.evaluate(() => {
      location.hash = "#hero-heading";
      return document.getElementById("hero-heading")?.getBoundingClientRect().top ?? -1;
    });
    expect(Math.round(anchorTop)).toBe(64);

    await page.goto("/calendar");
    await waitForHydration(page, "header nav");
    const tab = page.locator('button[id^="weekly-schedule-tab-"]').first();
    // Parked 20px from the top of the window: on screen, but where the bar is.
    await tab.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 20));
    expect(Math.round(await tab.evaluate((el) => el.getBoundingClientRect().top))).toBe(20);
    await tab.focus();
    expect(await tab.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(64);
  });
});

test.describe("the phone bar and its drawer", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("☰ opens a modal drawer that traps focus, locks the page and gives focus back", async ({ page }) => {
    await page.goto("/welcome");
    await waitForHydration(page, MENU_BUTTON);
    const menuButton = page.locator(MENU_BUTTON);
    // The phone bar has no centre strip: the links are in the drawer.
    await expect(navbar(page).locator("ul").first()).toBeHidden();

    // Start part-way down, so "did not move" is a real claim.
    const scrolledTo = await parkMidPage(page, 300);
    // Closed, there is no drawer for aria-controls to point at.
    expect(await menuButton.getAttribute("aria-controls")).toBeNull();

    await menuButton.click();
    const drawer = page.getByRole("dialog", { name: "菜单" });
    await expect(drawer).toBeVisible();
    await expect(menuButton).toHaveAttribute("aria-expanded", "true");
    await expect(menuButton).toHaveAttribute("aria-controls", (await drawer.getAttribute("id")) ?? "");

    // Focus moved in.
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))
      .toBe(true);

    // Tab never leaves it, in either direction, however long it is held.
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    }
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    }

    // The page underneath does not scroll — and opening the drawer did not
    // move it either. Measured, not inferred from a style: "overflow: hidden
    // is set" was true for years on a lock that locked nothing.
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBe(scrolledTo);
    await page.mouse.move(370, 600); // over the dimmed page, beside the drawer
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);

    // Escape closes it and focus goes back to ☰ — with the page where it was.
    // (It used to land at 0: focus coming back to ☰ scrolled the page to
    // "reveal" it, and the next check still passed because the wheel below
    // scrolls down from wherever the page had jumped to.)
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    await expect(menuButton).toBeFocused();
    expect(await scrollY(page)).toBe(before);
    expect(await menuButton.getAttribute("aria-controls")).toBeNull();

    // And the page scrolls again.
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  });

  test("however it is closed — ✕, the dimmed page, Escape — the page stays where it was", async ({ page }) => {
    await page.goto("/welcome");
    await waitForHydration(page, MENU_BUTTON);
    const menuButton = page.locator(MENU_BUTTON);
    const drawer = page.getByRole("dialog", { name: "菜单" });
    const at = await parkMidPage(page, 1200);

    const ways: Array<[string, () => Promise<void>]> = [
      ["✕", () => drawer.getByRole("button", { name: "关闭菜单" }).click()],
      ["the dimmed page", () => page.mouse.click(370, 700)],
      ["Escape", () => page.keyboard.press("Escape")],
    ];
    for (const [way, close] of ways) {
      await menuButton.click();
      await expect(drawer, `open before closing by ${way}`).toBeVisible();
      expect(await scrollY(page), `opening, before closing by ${way}`).toBe(at);
      await close();
      await expect(drawer, `closed by ${way}`).toHaveCount(0);
      await expect(menuButton, `focus back on ☰ after ${way}`).toBeFocused();
      expect(await scrollY(page), `the page after closing by ${way}`).toBe(at);
    }
  });

  test("the dimmed page closes it, and so does following a link", async ({ page }) => {
    await page.goto("/faq");
    await waitForHydration(page, MENU_BUTTON);
    const menuButton = page.locator(MENU_BUTTON);
    const drawer = page.getByRole("dialog", { name: "菜单" });

    await menuButton.click();
    await expect(drawer).toBeVisible();
    await page.mouse.click(370, 700);
    await expect(drawer).toHaveCount(0);
    await expect(menuButton).toBeFocused();

    await menuButton.click();
    await expect(drawer).toBeVisible();
    // 分类 expands into the genre hubs inside the drawer.
    await drawer.getByRole("button", { name: "分类" }).click();
    await expect(drawer.getByRole("link", { name: "动作" })).toHaveAttribute("href", "/genre/action");

    await drawer.getByRole("link", { name: "放送表" }).click();
    await page.waitForURL(/\/calendar$/);
    await expect(drawer).toHaveCount(0);
  });

  test("keeps the language switcher reachable", async ({ page }) => {
    await page.goto("/faq");
    await waitForHydration(page, MENU_BUTTON);
    await page.locator(MENU_BUTTON).click();
    const drawer = page.getByRole("dialog", { name: "菜单" });
    await expect(drawer.getByRole("button", { name: "简体中文" })).toHaveAttribute("aria-current", "true");
    await drawer.getByRole("button", { name: "English" }).click();
    await page.waitForURL(/\/en\/faq$/);
  });
});

test.describe("signed in", () => {
  test.use({ storageState: "./.auth/user.json", viewport: { width: 1440, height: 900 } });

  test("我的追番 joins the strip just before 关于", async ({ page }) => {
    await page.goto("/");
    await expectSignedIn(page, "e2e-sandbox");
    const links = await centreLinks(page);
    expect(links.map(([label]) => label)).toEqual(["首页", "放送表", "季度", "分类", "我的追番", "关于"]);
    expect(links[4]?.[1]).toBe("/profile");
    // No visitor chrome once the probe has answered.
    await expect(navbar(page).locator('a[href^="/login"]')).toHaveCount(0);
  });

  test("the account menu gives focus back on Escape without moving the page", async ({ page }) => {
    await page.goto("/welcome");
    await expectSignedIn(page, "e2e-sandbox");
    await waitForHydration(page, AVATAR_TRIGGER);
    const at = await parkMidPage(page, 2400);

    const trigger = page.locator(AVATAR_TRIGGER);
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await scrollY(page)).toBe(at);
    // Into the menu from the keyboard, then out again.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("menuitem", { name: "我的追番" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
    expect(await scrollY(page)).toBe(at);
  });
});
