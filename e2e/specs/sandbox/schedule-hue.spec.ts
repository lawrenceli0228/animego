import { test, expect, type Page } from "@playwright/test";
import { waitForHydration } from "../../fixtures/hydration";
import { collectConsoleErrors } from "../_helpers";

/**
 * The hue schedule page (/calendar).
 *
 * What is pinned:
 *   - choosing a day — by its tab, or by its bar in 本周更新 on a wide
 *     screen — shows that day's list and nothing else, and the page takes the
 *     colour of one of that day's shows (its best-rated coloured one);
 *   - the 现在 HH:MM rule exists on today and on no other day;
 *   - on a phone the tabs are a sideways pill row, and choosing a pill that
 *     is off-screen scrolls the ROW to show it — the page itself stays put.
 *
 * The schedule is whatever the stack's go-api returns for this week, so
 * assertions that need a second day with airings skip rather than fail when
 * there is none. If the schedule did not load at all the page renders no
 * tabs, and every test here skips.
 *
 * Clicks wait for hydration first: a click on server HTML with no handlers
 * does nothing, and the failure would look exactly like a broken tab.
 */

const TABLIST = '[role="tablist"]';

/** The --home-tone the page is wearing, as written inline on <main>. */
const pageTone = (page: Page) =>
  page.evaluate(() => (document.querySelector("main") as HTMLElement).style.getPropertyValue("--home-tone").trim());

/** Every row tone in a panel: each row carries its own anime's --tone inline. */
const rowTones = (page: Page, index: number) =>
  page.evaluate(
    (i) =>
      Array.from(document.querySelectorAll<HTMLElement>(`#schedule-panel-${i} a[href*="/anime/"]`)).map((a) =>
        a.style.getPropertyValue("--tone").trim(),
      ),
    index,
  );

/** Index of a day after today that has at least one airing, or -1. */
const busyDayAfterToday = (page: Page) =>
  page.evaluate(() => {
    for (let i = 1; i < 7; i++) {
      if (document.querySelector(`#schedule-panel-${i} a[href*="/anime/"]`)) return i;
    }
    return -1;
  });

async function open(page: Page): Promise<number> {
  await page.goto("/calendar");
  const count = await page.locator(`${TABLIST} [role="tab"]`).count();
  if (count > 0) await waitForHydration(page, `${TABLIST} [role="tab"]`);
  return count;
}

test.describe("schedule page", () => {
  test("a day's tab shows that day and dresses the page in one of its shows' colour", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const count = await open(page);
    test.skip(count === 0, "the schedule did not load in this stack");
    expect(count).toBe(7);

    const tabs = page.getByRole("tab");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#schedule-panel-0")).toBeVisible();

    const target = await busyDayAfterToday(page);
    test.skip(target === -1, "no airings after today in this stack");

    const ground = () => page.evaluate(() => getComputedStyle(document.querySelector("main") as Element).backgroundColor);
    const toneBefore = await pageTone(page);
    const groundBefore = await ground();

    await tabs.nth(target).click();
    await expect(tabs.nth(target)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "false");
    await expect(page.locator(`#schedule-panel-${target}`)).toBeVisible();
    await expect(page.locator("#schedule-panel-0")).toBeHidden();
    // Exactly one day's list is on screen.
    await expect(page.locator('[role="tabpanel"]:visible')).toHaveCount(1);

    // The page's tone is one of the selected day's own row tones — it came
    // from that day, not from a constant or from the day before.
    const toneAfter = await pageTone(page);
    expect(await rowTones(page, target)).toContain(toneAfter);
    if (toneAfter !== toneBefore) {
      // The ground re-tints over 0.9s; poll until it lands somewhere new.
      await expect.poll(ground, { timeout: 5_000 }).not.toBe(groundBefore);
    }

    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("a bar in 本周更新 selects its day like the tab does", async ({ page }) => {
    const count = await open(page);
    test.skip(count === 0, "the schedule did not load in this stack");

    const target = await busyDayAfterToday(page);
    test.skip(target === -1, "no airings after today in this stack");

    const bars = page.getByRole("group", { name: "本周更新" }).getByRole("button");
    await expect(bars).toHaveCount(7);
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");

    await bars.nth(target).click();
    await expect(bars.nth(target)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("tab").nth(target)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`#schedule-panel-${target}`)).toBeVisible();
    expect(await rowTones(page, target)).toContain(await pageTone(page));
  });

  test("the 现在 rule is on today and on no other day", async ({ page }) => {
    const count = await open(page);
    test.skip(count === 0, "the schedule did not load in this stack");
    const todayHasAirings = (await page.locator('#schedule-panel-0 a[href*="/anime/"]').count()) > 0;
    test.skip(!todayHasAirings, "nothing airs today in this stack");

    await expect(page.locator("#schedule-panel-0").getByText(/现在 \d{2}:\d{2}/)).toHaveCount(1);
    for (let i = 1; i < 7; i++) {
      await expect(page.locator(`#schedule-panel-${i}`).getByText(/现在 \d{2}:\d{2}/)).toHaveCount(0);
    }

    const target = await busyDayAfterToday(page);
    if (target !== -1) {
      await page.getByRole("tab").nth(target).click();
      await expect(page.getByText(/现在 \d{2}:\d{2}/).filter({ visible: true })).toHaveCount(0);
    }
  });
});

test.describe("schedule page on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the selected pill is scrolled into its row, and the page does not move", async ({ page }) => {
    const count = await open(page);
    test.skip(count === 0, "the schedule did not load in this stack");

    // The chart is a wide-screen control; on a phone the pills carry the counts.
    await expect(page.getByRole("group", { name: "本周更新" })).toBeHidden();

    const row = page.locator(TABLIST);
    const last = page.getByRole("tab").nth(6);
    const rowBox = await row.boundingBox();
    const before = await last.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(before).not.toBeNull();
    // Seven pills do not fit across a 390px phone; the last one starts cut off.
    test.skip(before!.x + before!.width <= rowBox!.x + rowBox!.width, "the pill row fits without scrolling here");

    const scrollY = await page.evaluate(() => window.scrollY);
    // Keyboard, not a click: Playwright scrolls a click target into view on
    // its own, which would pass this test without the page doing anything.
    await page.getByRole("tab").nth(0).focus();
    await page.keyboard.press("End");

    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect(last).toBeFocused();
    await expect
      .poll(async () => {
        const box = await last.boundingBox();
        return box ? box.x >= rowBox!.x && box.x + box.width <= rowBox!.x + rowBox!.width : false;
      })
      .toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

    // And back: ArrowRight wraps from the last day to today.
    await page.keyboard.press("ArrowRight");
    const first = page.getByRole("tab").nth(0);
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(async () => {
        const box = await first.boundingBox();
        return box ? box.x >= rowBox!.x : false;
      })
      .toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  });
});
