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
const MENU_BUTTON = 'header button[aria-haspopup="dialog"]';

/**
 * A real pointer click at the control's centre.
 *
 * `locator.click()` first scrolls its target into view, and for a control in
 * a sticky header Chromium computes that from the header's place at the top
 * of the document: the page jumps back to y = 0 before the click lands —
 * measured, 300 → 0, while a pointer click at the same spot leaves it at 300.
 * A reader's tap does no such thing, and the scroll-lock assertion below
 * needs the page to stay where it was.
 */
async function tap(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`tap: ${selector} has no box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
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
});

test.describe("the phone bar and its drawer", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("☰ opens a modal drawer that traps focus, locks the page and gives focus back", async ({ page }) => {
    await page.goto("/welcome");
    await waitForHydration(page, MENU_BUTTON);
    const menuButton = page.locator(MENU_BUTTON);
    // The phone bar has no centre strip: the links are in the drawer.
    await expect(navbar(page).locator("ul").first()).toBeHidden();

    // Start part-way down, so "did not move" is a real claim. The jump down
    // hides the bar; a short scroll back up brings it back to tap. Each step
    // waits until the header has SEEN it: scroll decisions run once per
    // animation frame, and two scrolls inside one frame are a single net
    // move (0 → 300, i.e. "down" — the bar would stay hidden).
    const header = page.locator("header").first();
    await page.evaluate(() => window.scrollTo(0, 320));
    await expect(header).toHaveAttribute("data-hidden", "true");
    await page.evaluate(() => window.scrollTo(0, 300));
    await expect(header).toHaveAttribute("data-hidden", "false");
    // Wait out the header's slide back in before aiming at it: a box measured
    // mid-slide sends the tap past the button.
    await expect
      .poll(async () => Math.round((await page.locator(MENU_BUTTON).boundingBox())?.y ?? -1))
      .toBeGreaterThanOrEqual(0);
    const scrolledTo = await page.evaluate(() => window.scrollY);
    expect(scrolledTo).toBe(300);
    // Closed, there is no drawer for aria-controls to point at.
    expect(await menuButton.getAttribute("aria-controls")).toBeNull();

    await tap(page, MENU_BUTTON);
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

    // Escape closes it and focus goes back to ☰.
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    await expect(menuButton).toBeFocused();
    expect(await menuButton.getAttribute("aria-controls")).toBeNull();

    // And the page scrolls again.
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
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
});
