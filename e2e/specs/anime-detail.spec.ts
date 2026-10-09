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
 * Cover images reach the page through /_next/image, whose source is either
 * our copy of the AniList original (/img/anilist/, when the build sets
 * NEXT_PUBLIC_IMAGE_MIRROR_BASE) or AniList's CDN itself. We assert that
 * images finished loading, not specific URLs — the source can switch
 * without being a regression.
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

// A page with no images would pass "every image loaded" without testing
// anything. The Frieren page renders dozens (cover, banner, cast, staff,
// recommendations); a handful is a floor that only an empty page misses.
const MIN_IMAGES_ON_DETAIL_PAGE = 5;

/**
 * Every <img> on the page ends up with pixels — not only the hero. The cast,
 * staff and recommendation rows are where a broken image source shows first,
 * because they are rarely cached and AniList portraits are the images most
 * often missing upstream.
 *
 * Most of them are lazy. Scrolling through the page requests the ones a
 * reader would see; any still not requested after that (the far end of a
 * horizontal row, say) are switched to eager, so the check covers every image
 * in the page rather than the ones that happened to be near the viewport.
 */
test("anime detail /anime/154587: every image loads", async ({ page }) => {
  await page.goto("/anime/154587");
  await expect(page.locator("h1").first()).toBeVisible();

  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight / 2) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    for (const img of Array.from(document.images)) {
      if (!img.complete) img.loading = "eager";
    }
  });

  // complete is true once an image has loaded or failed, so this waits for
  // every request to settle without deciding which way it went.
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete), null, {
    timeout: 30_000,
  });

  const images = await page.evaluate(() =>
    Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.src,
      width: img.naturalWidth,
    })),
  );
  const broken = images.filter((img) => img.width === 0).map((img) => img.src);

  expect(images.length).toBeGreaterThanOrEqual(MIN_IMAGES_ON_DETAIL_PAGE);
  expect(broken, `Images that loaded with no pixels:\n${broken.join("\n")}`).toEqual([]);
});
