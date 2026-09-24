import { test, expect, type Page } from "@playwright/test";
import { collectConsoleErrors } from "../_helpers";

/**
 * The redesigned homepage's two interactive pieces: the hero and 按色调逛.
 *
 * What is pinned:
 *   - the hero does NOT rotate on its own (DESIGN.md bans auto-rotating
 *     carousels; the old one ran every 5s);
 *   - a bar press and the arrow keys move focus between the five slides, and
 *     only the focused slide is exposed to assistive tech;
 *   - the page ground follows the focused anime (it changes colour on switch);
 *   - 按色调逛 shows one hue family at a time.
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

test.describe("homepage", () => {
  test("the hero only switches when asked, and the page takes the focused anime's colour", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/");

    const hero = page.locator(HERO);
    await expect(hero).toBeVisible();
    const bars = hero.getByRole("group").getByRole("button");
    const count = await bars.count();
    test.skip(count < 2, "fewer than two current-season titles in this stack");
    await waitForHydration(page, `${HERO} [role="group"] button`);

    await expect(bars.nth(0)).toHaveAttribute("aria-pressed", "true");
    // Well past the old carousel's 5s interval: still on the first slide.
    await page.waitForTimeout(6_000);
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
