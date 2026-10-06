import { test, expect, type Locator, type Page } from "@playwright/test";
import { waitForHydration } from "../../fixtures/hydration";
import { collectConsoleErrors } from "../_helpers";

/**
 * 今日更新 — the homepage's rail of today's episodes.
 *
 * What is pinned:
 *   - on a desktop the row is dragged with the mouse: it scrolls, and letting
 *     go over a card does not open that card — while a plain click still does;
 *   - the ← → buttons page it a view at a time, from the mouse and from the
 *     keyboard, and say so at either end (aria-disabled);
 *   - on a phone every show of the day is its own card (the aired half used
 *     to fold into one tile) and the row swipes;
 *   - a show that airs while the page is open stays in the row and turns
 *     aired. It used to drop into the phone's fold at its airing minute — the
 *     reported "today's shows suddenly disappear". That case runs on
 *     Playwright's fake clock, set just before a real airing on the page.
 *
 * The rail shows whatever the stack's schedule has for today, so cases that
 * need a row longer than the screen skip when there is none.
 */

const RAIL = "#home-today-rail";

/** The count beside 今日更新 is the number of shows today. */
const headerCount = (page: Page) => page.locator("#home-today + span");

const scrollLeftOf = (rail: Locator) => rail.evaluate((el) => el.scrollLeft);
const maxScrollOf = (rail: Locator) => rail.evaluate((el) => el.scrollWidth - el.clientWidth);

/** Wait until a (possibly smooth) scroll has come to rest, and return where. */
async function settled(rail: Locator): Promise<number> {
  let last = await scrollLeftOf(rail);
  for (let i = 0; i < 40; i++) {
    await rail.page().waitForTimeout(80);
    const now = await scrollLeftOf(rail);
    if (Math.abs(now - last) < 0.5) return now;
    last = now;
  }
  return last;
}

async function openRail(page: Page): Promise<Locator | null> {
  await page.goto("/");
  const rail = page.locator(RAIL);
  if ((await rail.count()) === 0) return null;
  await waitForHydration(page, `${RAIL} a`);
  return rail;
}

test.describe("今日更新 on a desktop", () => {
  test("dragging the row scrolls it, and letting go over a card does not open the card", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");
    const max = await maxScrollOf(rail!);
    test.skip(max < 120, "today's row fits on one screen here");

    await rail!.scrollIntoViewIfNeeded();
    const before = await scrollLeftOf(rail!);
    const url = page.url();
    // Toward whichever end has room.
    const direction = before < max / 2 ? -1 : 1;
    const box = (await rail!.boundingBox())!;
    const y = box.y + 100; // over a card's cover
    const x0 = box.x + box.width / 2;

    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x0 + direction * 260, y, { steps: 12 });
    await expect(rail!).toHaveAttribute("data-dragging", "true");
    await page.mouse.up();

    const after = await scrollLeftOf(rail!);
    expect(Math.abs(after - before)).toBeGreaterThan(200);
    expect(Math.sign(after - before)).toBe(-direction);
    await expect(rail!).not.toHaveAttribute("data-dragging", "true");
    // Released over a card: still on the homepage.
    await page.waitForTimeout(600);
    expect(page.url()).toBe(url);

    // A short drag that starts and ends on the same card — the case where a
    // click would land on that card's link — moves the row and opens nothing.
    const card0 = rail!.locator('a[href*="/anime/"]').nth(1);
    await card0.scrollIntoViewIfNeeded();
    const c = (await card0.boundingBox())!;
    const start = await scrollLeftOf(rail!);
    await page.mouse.move(c.x + c.width / 2 + 20, c.y + 80);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 - 20, c.y + 80, { steps: 6 });
    await page.mouse.up();
    expect(Math.abs((await scrollLeftOf(rail!)) - start)).toBeGreaterThan(20);
    await page.waitForTimeout(600);
    expect(page.url()).toBe(url);

    // Checked before leaving: what the detail page logs is not this test's.
    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);

    // A plain click on a card still opens it.
    const card = rail!.locator('a[href*="/anime/"]').first();
    await card.scrollIntoViewIfNeeded();
    const href = await card.getAttribute("href");
    await card.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test("the ← → buttons page the row, from the mouse and the keyboard, and say so at the ends", async ({ page }) => {
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");
    const max = await maxScrollOf(rail!);
    test.skip(max < 120, "today's row fits on one screen here");

    const prev = page.getByRole("button", { name: "上一组" });
    const next = page.getByRole("button", { name: "下一组" });
    await expect(prev).toBeVisible();
    await expect(next).toBeVisible();

    // From the start: back is unavailable, forward is not.
    await rail!.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
    await expect(prev).toHaveAttribute("aria-disabled", "true");
    await expect(next).toHaveAttribute("aria-disabled", "false");

    // Forward with the mouse until the end: each press moves the row on.
    let position = 0;
    for (let i = 0; i < 30 && (await next.getAttribute("aria-disabled")) !== "true"; i++) {
      await next.click();
      const now = await settled(rail!);
      expect(now).toBeGreaterThan(position);
      position = now;
    }
    expect(position).toBeGreaterThanOrEqual(max - 1);
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await expect(prev).toHaveAttribute("aria-disabled", "false");

    // Back with the keyboard until the start. The button keeps focus at the
    // end of the row (aria-disabled, not disabled), so the keys keep working.
    await prev.focus();
    for (let i = 0; i < 30 && (await prev.getAttribute("aria-disabled")) !== "true"; i++) {
      await page.keyboard.press("Enter");
      const now = await settled(rail!);
      expect(now).toBeLessThan(position);
      position = now;
    }
    expect(position).toBeLessThanOrEqual(1);
    await expect(prev).toHaveAttribute("aria-disabled", "true");
    await expect(prev).toBeFocused();
    // At the end a press does nothing.
    await page.keyboard.press("Enter");
    expect(await settled(rail!)).toBeLessThanOrEqual(1);
  });
});

test.describe("今日更新 on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("every show of the day is its own card, and the row swipes", async ({ page }) => {
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");

    const total = Number(await headerCount(page).textContent());
    const cards = rail!.locator('a[href*="/anime/"]');
    await expect(cards).toHaveCount(total);
    for (let i = 0; i < total; i++) await expect(cards.nth(i)).toBeVisible();
    // No fold, no tile standing in for the aired half.
    await expect(rail!.locator("[aria-expanded]")).toHaveCount(0);
    // A phone gets no ← →: the row is swiped.
    await expect(page.getByRole("button", { name: "下一组" })).toBeHidden();

    const max = await maxScrollOf(rail!);
    test.skip(max < 120, "today's row fits on one phone screen here");
    await rail!.scrollIntoViewIfNeeded();
    const before = await settled(rail!);
    const box = (await rail!.boundingBox())!;
    const direction = before < max / 2 ? -1 : 1;
    // A real touch swipe, not a scrollTo: Chromium synthesises the gesture.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.synthesizeScrollGesture", {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + 100),
      xDistance: direction * 240,
      yDistance: 0,
      gestureSourceType: "touch",
      speed: 1200,
    });
    const after = await settled(rail!);
    expect(Math.abs(after - before)).toBeGreaterThan(60);
  });

  test("a show that airs while the page is open stays in the row, marked aired", async ({ page }) => {
    // Pick a real airing from the row as served…
    const served = await openRail(page);
    test.skip(served === null, "nothing airs today in this stack");
    const times = await served!
      .locator("time[datetime]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("datetime") as string));
    test.skip(times.length === 0, "no airing times on the cards");
    const target = times[Math.floor(times.length / 2)] ?? "";
    const airsAt = Date.parse(target);

    // …and come back two minutes before it.
    await page.clock.install({ time: airsAt - 2 * 60_000 });
    const rail = await openRail(page);
    const card = rail!.locator(`a:has(time[datetime="${target}"])`).first();
    await expect(card).toHaveAttribute("data-state", "soon");
    const total = await rail!.locator('a[href*="/anime/"]').count();

    // Three minutes on, it has aired — and it is still a card in the row.
    await page.clock.fastForward("03:00");
    await expect(card).toHaveAttribute("data-state", "aired");
    await expect(card).toBeVisible();
    await expect(card).toContainText("已播");
    await expect(rail!.locator('a[href*="/anime/"]')).toHaveCount(total);

    // In view in the row, too, not merely laid out somewhere off to the side.
    await card.evaluate((el) => {
      const row = el.parentElement as HTMLElement;
      row.scrollLeft = (el as HTMLElement).offsetLeft - 20;
    });
    const rowBox = (await rail!.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    expect(cardBox.x).toBeGreaterThanOrEqual(rowBox.x - 1);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  });
});
