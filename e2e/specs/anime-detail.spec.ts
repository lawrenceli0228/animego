import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "./_helpers";

/**
 * `/anime/[id]` (RSC + ISR 60s) — title, cover image, no console errors.
 *
 * Regression coverage:
 *   - 154587 (Frieren) — primary detail page.
 *   - 171457 (Losing Heroines) — exercises AniList fuzzy date formatting,
 *     which regressed in P10 and was fixed by commit 820accc. If
 *     formatFuzzyDate ever throws again this spec will catch it via the
 *     pageerror channel (which collectConsoleErrors also captures).
 *
 * Cover images come from AniList CDN (s4.anilist.co) or the Go API
 * proxy. We assert at least one rendered <img> finished loading, not
 * specific URLs — image hosts can rotate without being a regression.
 */
async function assertDetailPageLoads(page: import("@playwright/test").Page, id: number) {
  const errors = collectConsoleErrors(page);

  await page.goto(`/anime/${id}`);

  // Title is the page's <h1>. Anime detail uses exactly one <h1>
  // (see app/anime/[id]/page.tsx — title pickTitle()).
  const heading = page.locator("h1").first();
  await expect(heading).toBeVisible();
  await expect(heading).not.toBeEmpty();

  // Wait for at least one image to render. AniList covers are the
  // dominant visual; the Go API also serves Bangumi covers as fallback.
  // Either is acceptable — we just need the hero image not to be broken.
  const coverImg = page
    .locator('img[src*="anilist"], img[src*="bangumi"], img[src*="s4.anilist.co"]')
    .first();
  await expect(coverImg).toBeVisible({ timeout: 15_000 });

  // naturalHeight > 0 proves the bytes actually loaded vs. 404 placeholder.
  const loaded = await coverImg.evaluate(
    (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalHeight > 0,
  );
  expect(loaded).toBe(true);

  await page.waitForLoadState("networkidle");

  expect(errors, `Unexpected console errors on /anime/${id}: ${errors.join("\n")}`).toEqual([]);
}

test("anime detail /anime/154587 (Frieren) renders title + cover", async ({ page }) => {
  await assertDetailPageLoads(page, 154587);
});

test("anime detail /anime/171457 (fuzzy date regression — commit 820accc)", async ({ page }) => {
  await assertDetailPageLoads(page, 171457);
});
