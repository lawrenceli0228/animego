import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "./_helpers";

/**
 * `/seasonal/[season]/[year]` (RSC + ISR 300s) — list renders.
 *
 * Each AnimeCard renders as a <Link> wrapping the cover image; the grid
 * uses `grid-template-columns: repeat(auto-fill, minmax(180px, 1fr))`.
 * We assert ≥3 anime links (`/anime/<id>`) which is a stable, semantic
 * indicator regardless of card markup churn.
 */
test("seasonal spring 2026 renders at least 3 anime cards", async ({ page }) => {
  const errors = collectConsoleErrors(page);

  await page.goto("/seasonal/spring/2026");

  // h1 heading: e.g. "2026年 春季新番" / "Spring 2026 Anime".
  await expect(page.locator("h1").first()).toBeVisible();

  // Each AnimeCard wraps the poster in a Link to /anime/<id>.
  const animeLinks = page.locator('a[href^="/anime/"]');
  // Wait until at least 3 cards have rendered. ISR caching makes this
  // deterministic — spring 2026 has well more than 3 entries in prod.
  await expect(animeLinks.nth(2)).toBeVisible();
  const count = await animeLinks.count();
  expect(count).toBeGreaterThanOrEqual(3);

  await page.waitForLoadState("networkidle");

  expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
});
