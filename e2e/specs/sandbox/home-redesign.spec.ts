import { test, expect, type Locator, type Page } from "@playwright/test";
import { collectConsoleErrors } from "../_helpers";

/**
 * The redesigned homepage's two interactive pieces: the hero and 按色调逛.
 *
 * What is pinned:
 *   - a bar press and the arrow keys move focus between the five slides, and
 *     only the focused slide is exposed to assistive tech;
 *   - the page ground follows the focused anime (it changes colour on switch);
 *   - the hero moves on by itself every 8 seconds, and a switch by hand starts
 *     the new slide's 8 seconds over;
 *   - it holds (WCAG 2.2.2) while the mouse is over it, while keyboard focus
 *     is inside it, while the pause button is pressed, while the tab is
 *     hidden — after which the slide's 8 seconds start over — and while it is
 *     scrolled out of view; under reduced motion it never moves on its own
 *     and offers no pause button;
 *   - 按色调逛 shows one hue family at a time.
 *
 * The rotation tests run on Playwright's fake clock: installed before the
 * page loads, so the page hydrates on time that flows, then paused and moved
 * by hand. Eight real seconds per case would make this the slowest spec in
 * the suite, and "it did not move in 30 seconds" would cost 30 of them.
 *
 * Data comes from whatever the sandbox's go-api holds for the current season,
 * so the assertions that need two or more titles skip when there are fewer
 * rather than fail for a reason that has nothing to do with the page.
 */

/**
 * Clicks before hydration land on server HTML with no handlers and do nothing
 * — the failure looks exactly like "the button is broken". Wait for React to
 * have attached to the hero first.
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    },
    selector,
    { timeout: 30_000 },
  );
}

const HERO = 'section[aria-label="本季焦点"]';

/** A point inside the hero, clear of the site header that lies over its top. */
const HERO_SPOT = { x: 240, y: 420 };

/** A point well below the hero (540px tall), where the mouse holds nothing. */
const AWAY = { x: 12, y: 700 };

/** The 8 seconds the hero gives each slide (lib/home/heroRotation.ts). */
const INTERVAL_MS = 8_000;

interface OpenedHero {
  hero: Locator;
  bars: Locator;
  count: number;
}

/**
 * Load the homepage on a fake clock that is still running, wait for the hero
 * to hydrate (and, unless motion is reduced, to start rotating), then pause
 * the clock. From there only `page.clock.runFor` moves time, so the
 * countdowns below are exact.
 */
async function openHero(page: Page, { rotates = true } = {}): Promise<OpenedHero> {
  await page.clock.install();
  await page.goto("/");
  const hero = page.locator(HERO);
  await expect(hero).toBeVisible();
  const bars = hero.getByRole("group").getByRole("button");
  const count = await bars.count();
  test.skip(count < 2, "fewer than two current-season titles in this stack");
  await waitForHydration(page, `${HERO} [role="group"] button`);
  await expect(hero).toHaveAttribute("data-rotates", rotates ? "true" : "false");
  await page.mouse.move(AWAY.x, AWAY.y);
  // A second ahead: the clock keeps flowing while this round trip is made,
  // and pausing at a moment it has already passed is an error.
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1_000);
  // The first slide has been counting since hydration, for however long this
  // machine took to get here. Send the tab away and back — by the hero's own
  // rule that gives the slide a fresh 8 seconds — so every case starts from
  // exactly zero at the paused instant, however slow the runner.
  if (rotates) {
    await setTabVisibility(page, "hidden");
    await setTabVisibility(page, "visible");
    await expect(hero).toHaveAttribute("data-held", "false");
  }
  return { hero, bars, count };
}

/** The tab going to the background and back, as the page sees it. */
async function setTabVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test.describe("homepage", () => {
  test("a bar or an arrow key switches the hero, and the page takes the focused anime's colour", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/");

    const hero = page.locator(HERO);
    await expect(hero).toBeVisible();
    const bars = hero.getByRole("group").getByRole("button");
    const count = await bars.count();
    test.skip(count < 2, "fewer than two current-season titles in this stack");
    await waitForHydration(page, `${HERO} [role="group"] button`);

    // The mouse rests on the hero from here on, which holds the rotation:
    // every switch below is one this test made.
    await hero.hover({ position: HERO_SPOT });
    await expect(hero).toHaveAttribute("data-held", "true");
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(hero.locator('article:not([aria-hidden="true"])')).toHaveCount(1);

    const ground = () => page.evaluate(() => getComputedStyle(document.querySelector("main") as Element).backgroundColor);
    const before = await ground();

    await bars.nth(1).click();
    await expect(bars.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "false");
    await expect(hero.locator('article:not([aria-hidden="true"])')).toHaveCount(1);

    // The ground is oklch(13% c h) of the focused anime. Two titles can share
    // a hue family, but not an identical accent, so the value changes unless
    // both fell back to the neutral ground.
    // Polled: while the 0.9s transition runs, the computed value is an
    // interpolated oklab() colour.
    await expect.poll(ground, { timeout: 5_000 }).toMatch(/^oklch\(0\.13 /);
    const after = await ground();
    if (!/^oklch\(0\.13 0 0\)$/.test(before) || !/^oklch\(0\.13 0 0\)$/.test(after)) {
      expect(after).not.toBe(before);
    }

    // Arrow keys move along the bars and take focus with them.
    await bars.nth(1).focus();
    await page.keyboard.press("ArrowRight");
    const third = 2 % count;
    await expect(bars.nth(third)).toHaveAttribute("aria-pressed", "true");
    await expect(bars.nth(third)).toBeFocused();

    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("按色调逛 shows one colour family at a time", async ({ page }) => {
    await page.goto("/");
    const pills = page.getByRole("group", { name: "按色调筛选" }).getByRole("button");
    const count = await pills.count();
    test.skip(count < 2, "fewer than two hue families in this stack");
    await waitForHydration(page, '[aria-label="按色调筛选"] button');

    await expect(page.getByRole("group", { name: "按色调筛选" }).locator('[aria-pressed="true"]')).toHaveCount(1);
    // Resolve to a fixed index: a locator that means "the first unpressed
    // pill" would re-resolve to a different pill after the click.
    const pressed = await pills.evaluateAll((els) => els.map((el) => el.getAttribute("aria-pressed")));
    const target = pills.nth(pressed.indexOf("false"));
    await target.click();
    await expect(target).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("group", { name: "按色调筛选" }).locator('[aria-pressed="true"]')).toHaveCount(1);
  });
});

test.describe("the hero's rotation", () => {
  test("moves on by itself every 8 seconds, and a switch by hand starts the 8 seconds over", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const { hero, bars, count } = await openHero(page);

    // Nothing is touching it: it runs, and moves on by itself at 8 seconds.
    await expect(hero).toHaveAttribute("data-held", "false");
    await page.clock.runFor(INTERVAL_MS - 200);
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");
    await page.clock.runFor(400);
    await expect(bars.nth(1)).toHaveAttribute("aria-pressed", "true");

    // Five seconds into the second slide, pick the third by hand, then let
    // go of the hero. Its 8 seconds count from the switch: had the countdown
    // merely carried on, it would move on 3 seconds later.
    await page.clock.runFor(5_000);
    await expect(bars.nth(1)).toHaveAttribute("aria-pressed", "true");
    const third = 2 % count;
    await bars.nth(third).click();
    await expect(bars.nth(third)).toHaveAttribute("aria-pressed", "true");
    await page.mouse.move(AWAY.x, AWAY.y);
    await expect(hero).toHaveAttribute("data-held", "false");
    await page.clock.runFor(INTERVAL_MS - 200);
    await expect(bars.nth(third)).toHaveAttribute("aria-pressed", "true");
    await page.clock.runFor(400);
    await expect(bars.nth((third + 1) % count)).toHaveAttribute("aria-pressed", "true");
    // Still exactly one slide exposed to assistive tech.
    await expect(hero.locator('article:not([aria-hidden="true"])')).toHaveCount(1);

    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("holds while the mouse is over it, and carries on when it leaves", async ({ page }) => {
    const { hero, bars } = await openHero(page);

    await hero.hover({ position: HERO_SPOT });
    await expect(hero).toHaveAttribute("data-held", "true");
    await page.clock.runFor(30_000);
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");

    await page.mouse.move(AWAY.x, AWAY.y);
    await expect(hero).toHaveAttribute("data-held", "false");
    await page.clock.runFor(INTERVAL_MS + 200);
    await expect(bars.nth(1)).toHaveAttribute("aria-pressed", "true");
  });

  test("holds while keyboard focus is inside it", async ({ page }) => {
    const { hero, bars } = await openHero(page);

    // Script focus with no pointer interaction before it counts as keyboard
    // focus (:focus-visible) — checked rather than assumed.
    await bars.nth(0).focus();
    expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible"))).toBe(true);
    await expect(hero).toHaveAttribute("data-held", "true");
    await page.clock.runFor(30_000);
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(hero).toHaveAttribute("data-held", "false");
    await page.clock.runFor(INTERVAL_MS + 200);
    await expect(bars.nth(1)).toHaveAttribute("aria-pressed", "true");
  });

  test("the pause button holds it until it is pressed again", async ({ page }) => {
    const { hero, bars } = await openHero(page);

    await hero.getByRole("button", { name: "暂停自动切换" }).click();
    const play = hero.getByRole("button", { name: "继续自动切换" });
    await expect(play).toBeVisible();
    // The mouse is gone; only the button holds it now.
    await page.mouse.move(AWAY.x, AWAY.y);
    await expect(hero).toHaveAttribute("data-held", "true");
    await page.clock.runFor(30_000);
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");

    await play.click();
    await expect(hero.getByRole("button", { name: "暂停自动切换" })).toBeVisible();
    await page.mouse.move(AWAY.x, AWAY.y);
    await expect(hero).toHaveAttribute("data-held", "false");
    await page.clock.runFor(INTERVAL_MS + 200);
    await expect(bars.nth(1)).toHaveAttribute("aria-pressed", "true");
  });

  test("holds while the tab is hidden, and gives the slide its 8 seconds again when it comes back", async ({ page }) => {
    const { hero, bars } = await openHero(page);

    // Five of the first slide's 8 seconds go by, then the tab goes away.
    await page.clock.runFor(5_000);
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");
    await setTabVisibility(page, "hidden");
    await expect(hero).toHaveAttribute("data-held", "true");
    await page.clock.runFor(60_000);
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");

    // Back: a full 8 seconds, not the 3 that were left.
    await setTabVisibility(page, "visible");
    await expect(hero).toHaveAttribute("data-held", "false");
    await page.clock.runFor(INTERVAL_MS - 200);
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");
    await page.clock.runFor(400);
    await expect(bars.nth(1)).toHaveAttribute("aria-pressed", "true");
  });

  test("holds while it is scrolled out of view, so the page keeps its colour", async ({ page }) => {
    const { hero, bars } = await openHero(page);
    const ground = () => page.evaluate(() => getComputedStyle(document.querySelector("main") as Element).backgroundColor);

    await page.evaluate(() => window.scrollTo(0, 1600));
    await expect(hero).toHaveAttribute("data-held", "true");
    const before = await ground();
    await page.clock.runFor(30_000);
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");
    expect(await ground()).toBe(before);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(hero).toHaveAttribute("data-held", "false");
    await page.clock.runFor(INTERVAL_MS + 200);
    await expect(bars.nth(1)).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("the hero under reduced motion", () => {
  // Not a top-level `use` option: it lives in contextOptions.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("never moves on by itself, and has no pause button to offer", async ({ page }) => {
    const { hero, bars } = await openHero(page, { rotates: false });

    expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await expect(hero.getByRole("button", { name: /自动切换/ })).toHaveCount(0);
    await page.clock.runFor(60_000);
    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");
    // Switching by hand still works.
    await bars.nth(1).click();
    await expect(bars.nth(1)).toHaveAttribute("aria-pressed", "true");
  });
});
