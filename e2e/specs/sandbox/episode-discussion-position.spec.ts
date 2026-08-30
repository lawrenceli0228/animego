import { test, expect } from "@playwright/test";
import { closePg, ensureAnimeDetail, removeAnimeFixture } from "../../fixtures/pg";

// Where the discussion panel opens.
//
// It used to render after the whole grid: click episode 1 of a 28-episode
// show and the panel appeared below episode 28, six rows down and usually
// off-screen. Nothing failed — the panel was correct, complete and
// reachable, it was just nowhere near the thing it belonged to, and no
// assertion in the repo described where it should be.
//
// It is now a grid child spanning every column, so the browser puts it on
// the row after the cell that opened it. The property worth pinning is that
// relationship, not a pixel offset: the track count comes from auto-fill and
// changes with the viewport.

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

const BANNER = "/og-default.png";
const COVER = "/mascot-wink.png";

/** Enough episodes that a mid-list cell is several rows from the end. */
const MANY = 990_100_010;

test.beforeAll(async () => {
  await ensureAnimeDetail({
    anilistId: MANY,
    titleRomaji: "E2E Discussion Position",
    titleChinese: "E2E 讨论位置",
    status: "FINISHED",
    episodes: 24,
    bannerImageUrl: BANNER,
    coverImageUrl: COVER,
    averageScore: 70,
    description: "A synopsis long enough that the page has its usual shape.",
  });
});

test.afterAll(async () => {
  await removeAnimeFixture(MANY);
  await closePg();
});

test.describe("the episode discussion panel", () => {
  test("opens directly under the cell that was clicked", async ({ page }) => {
    await page.goto(`/anime/${MANY}`);

    // Episode 3 — early enough that "after the whole grid" and "after this
    // row" are hundreds of pixels apart, which is the regression this pins.
    const opener = page.locator('[data-episode-discussion="true"]').nth(2);
    await expect(opener).toBeVisible();

    await opener.click();

    const panel = page.locator('[id^="episode-discussion-"]');
    await expect(panel).toBeVisible();

    // Both boxes read AFTER the click. Inserting the panel reflows the grid,
    // so a cell position captured beforehand describes a layout that no
    // longer exists — which is what made the first version of this test fail
    // against a page that was behaving correctly.
    const cellBox = await page
      .locator('[data-episode-toggle="true"]')
      .nth(2)
      .boundingBox();
    const panelBox = await panel.boundingBox();

    expect(cellBox).not.toBeNull();
    expect(panelBox).not.toBeNull();

    // Below its own cell...
    expect(panelBox!.y).toBeGreaterThan(cellBox!.y);

    // ...and within one row of it. A row is the cell's own height; two of
    // them is generous and still nowhere near the bottom of a 24-episode
    // grid, which is where this used to land.
    expect(panelBox!.y - (cellBox!.y + cellBox!.height)).toBeLessThan(
      cellBox!.height * 2,
    );
  });

  test("spans the full width of the grid, not one column", async ({ page }) => {
    await page.goto(`/anime/${MANY}`);
    const opener = page.locator('[data-episode-discussion="true"]').first();
    await opener.click();

    const panel = page.locator('[id^="episode-discussion-"]');
    await expect(panel).toBeVisible();

    const panelBox = await panel.boundingBox();
    const cellBox = await page
      .locator('[data-episode-toggle="true"]')
      .first()
      .boundingBox();

    // A panel that inherited a single track would be about one cell wide and
    // would push the remaining cells of that row out, which reads as the
    // grid breaking rather than as a panel opening.
    expect(panelBox!.width).toBeGreaterThan(cellBox!.width * 2);
  });

  test("only one panel is open at a time", async ({ page }) => {
    await page.goto(`/anime/${MANY}`);

    await page.locator('[data-episode-discussion="true"]').nth(0).click();
    await expect(page.locator('[id^="episode-discussion-"]')).toHaveCount(1);

    await page.locator('[data-episode-discussion="true"]').nth(5).click();
    // Opening a second must close the first — two panels would mean two
    // elements claiming the same id prefix and two aria-controls targets.
    await expect(page.locator('[id^="episode-discussion-"]')).toHaveCount(1);
  });

  test("aria-controls points at the panel that exists", async ({ page }) => {
    await page.goto(`/anime/${MANY}`);
    const opener = page.locator('[data-episode-discussion="true"]').nth(2);
    await opener.click();
    await expect(page.locator('[id^="episode-discussion-"]')).toBeVisible();

    // The relationship a screen reader follows. A dangling aria-controls is
    // invisible in review and silent at runtime.
    const controls = await opener.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    await expect(page.locator(`#${controls}`)).toHaveCount(1);
    await expect(opener).toHaveAttribute("aria-expanded", "true");
  });
});
