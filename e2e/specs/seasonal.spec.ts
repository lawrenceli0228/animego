import { test, expect, type Page } from "@playwright/test";
import { collectConsoleErrors } from "./_helpers";

/**
 * `/seasonal/[season]/[year]` on the deployed site — read-only.
 *
 * This file runs in chromium-prod (.github/workflows/e2e.yml), on every pull
 * request, against what is LIVE — not against the pull request's code. So
 * while a redesign of this page is in review, prod still serves the page it
 * replaces, and every assertion here has to hold for both:
 *
 *   - the shared contract: an h1, real `/anime/<id>` links with their titles
 *     as text, the season link graph in the HTML, no console errors;
 *   - the browse page's own behaviour, checked only once prod serves it
 *     (it marks its <main> with data-seasonal-browse). Each such test says
 *     which page it saw in its annotations.
 *
 * The write paths and the deterministic checks (filters, bars, badges, the
 * sheet) are the sandbox suite's: e2e/specs/sandbox/seasonal-browse.spec.ts.
 */

const SEASON = "/seasonal/spring/2026";

async function isBrowsePage(page: Page): Promise<boolean> {
  const browse = (await page.locator("main[data-seasonal-browse]").count()) > 0;
  test.info().annotations.push({ type: "seasonal-page", description: browse ? "browse" : "legacy" });
  return browse;
}

test("seasonal spring 2026 renders at least 3 anime cards", async ({ page }) => {
  const errors = collectConsoleErrors(page);

  await page.goto(SEASON);

  // h1 heading: e.g. "2026年 春季新番" / "Spring 2026 Anime".
  await expect(page.locator("h1").first()).toBeVisible();

  // Every card on either page links its show at /anime/<id>.
  const animeLinks = page.locator('a[href^="/anime/"]:visible');
  await expect(animeLinks.nth(2)).toBeVisible();
  expect(await animeLinks.count()).toBeGreaterThanOrEqual(3);

  await page.waitForLoadState("networkidle");

  expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
});

test("the HTML links the other seasons of the year and this season of other years", async ({ request }) => {
  // The season graph a crawler walks. The old season nav and the browse
  // page's season / year menus both put these links in the server HTML.
  const res = await request.get(SEASON);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('href="/seasonal/summer/2026"');
  expect(html).toContain('href="/seasonal/winter/2026"');
  expect(html).toContain('href="/seasonal/spring/2025"');
});

test("browse page: every show is a titled link, and only the first batch is visible", async ({ page }) => {
  await page.goto(SEASON);
  test.skip(!(await isBrowsePage(page)), "prod still serves the page the browse page replaces");

  const cards = page.locator("[data-anime-card]");
  const total = await cards.count();
  expect(total).toBeGreaterThan(0);
  // Each card's title link carries the show's name.
  const empty = await page
    .locator('[data-anime-card] a[href^="/anime/"]:not([aria-hidden="true"])')
    .evaluateAll((els) => els.filter((el) => !(el.textContent ?? "").trim()).length);
  expect(empty).toBe(0);
  // Desktop batch: 36 covers; the rest wait hidden (and are still links).
  await expect(page.locator("[data-anime-card]:visible")).toHaveCount(Math.min(total, 36));
});

test("browse page: switching the view stays on the page and goes into the URL", async ({ page }) => {
  await page.goto(SEASON);
  test.skip(!(await isBrowsePage(page)), "prod still serves the page the browse page replaces");
  await page.waitForFunction(() =>
    Object.keys(document.querySelector("main[data-seasonal-browse]") ?? {}).some((k) => k.startsWith("__react")),
  );
  await page.locator('[data-view-toggle="chart"]').click();
  await expect(page.locator("[data-charts]")).toBeVisible();
  await expect(page).toHaveURL(/view=chart/);
});
