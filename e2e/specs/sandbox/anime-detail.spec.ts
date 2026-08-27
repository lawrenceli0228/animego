import { test, expect } from "@playwright/test";
import { closePg, ensureAnimeDetail, removeAnimeFixture } from "../../fixtures/pg";

// The two things the detail hero got wrong, pinned against a stack built
// from this branch.
//
// Both were live on production and neither was catchable by any check the
// repo had. The score badge was wrong only for scores of 75 and above, so
// every screenshot of a mid-rated anime looked correct. The mobile hero was
// not "wrong" at all in the sense a test could phrase — it rendered exactly
// what it was told to — it just put the synopsis below the fold on the
// device most visitors arrive on.
//
// specs/anime-detail.spec.ts (top level) runs against the DEPLOYED site, so
// it can only report these after they ship. This file is in the sandbox
// project, which is the one that can fail a pull request.
//
// No authentication: this is the page as a search visitor meets it.
test.use({ storageState: { cookies: [], origins: [] } });

// One worker for the whole file.
//
// The config sets fullyParallel, which spreads a file's tests across
// workers — and `beforeAll` runs once per worker, `afterAll` likewise. With
// a shared database and one set of fixture ids that means several workers
// seed the same rows at once, and the first to finish deletes them while
// the others are still reading. The failure surfaces as a 404 in whichever
// spec drew the short straw, intermittently, which is the most expensive
// kind of red there is.
//
// Serial is the right trade here rather than per-worker fixture ids: six
// short reads cost nothing to run in order, and ids that depend on
// workerIndex make every failure message harder to trace back to a row.
test.describe.configure({ mode: "serial" });

// Local asset paths, not AniList URLs. next/image rejects a host outside
// next.config's remotePatterns with a 400, and a real AniList fetch would put
// an external dependency in the middle of a layout assertion.
const BANNER = "/og-default.png";
const COVER = "/mascot-wink.png";

// A synopsis long enough that the collapsed block has real height — the
// question is where it starts, and a one-line summary would sit above the
// fold no matter how tall the hero was.
const SYNOPSIS =
  "A test synopsis long enough to occupy several lines in the collapsed " +
  "description block, so that the assertion about where it begins is not " +
  "quietly satisfied by it being too short to matter. It repeats itself a " +
  "little on purpose. A test synopsis long enough to occupy several lines.";

/** Scored 87 — the band that rendered green text on an amber pill. */
const HIGH = 990_100_001;
/** Scored 30 — the band that happened to look right, which is why it hid. */
const LOW = 990_100_002;

test.beforeAll(async () => {
  await ensureAnimeDetail({
    anilistId: HIGH,
    titleRomaji: "E2E High Score",
    titleChinese: "E2E 高分",
    status: "RELEASING",
    episodes: 12,
    bannerImageUrl: BANNER,
    coverImageUrl: COVER,
    averageScore: 87,
    description: SYNOPSIS,
  });
  await ensureAnimeDetail({
    anilistId: LOW,
    titleRomaji: "E2E Low Score",
    titleChinese: "E2E 低分",
    status: "FINISHED",
    episodes: 12,
    bannerImageUrl: BANNER,
    coverImageUrl: COVER,
    averageScore: 30,
    description: SYNOPSIS,
  });
});

test.afterAll(async () => {
  await removeAnimeFixture(HIGH);
  await removeAnimeFixture(LOW);
  await closePg();
});

/**
 * The site's own score badge, not Bangumi's.
 *
 * Both are spans beginning with a star, but the Bangumi one is prefixed with
 * a "BGM" label, so anchoring on the star being FIRST separates them without
 * depending on a CSS-module class name (those are hashed at build time) or
 * on a test id in production markup.
 */
const scoreBadge = (page: import("@playwright/test").Page) =>
  page.locator("main span").filter({ hasText: /^★/ }).first();

test.describe("the score badge", () => {
  // The assertion is not "is it green". It was genuinely green — that was
  // never the problem. It is that the background named the same band.
  for (const { id, label, rgb } of [
    { id: HIGH, label: "87 is the high band", rgb: "48, 209, 88" },
    { id: LOW, label: "30 is the low band", rgb: "255, 69, 58" },
  ]) {
    test(`${label}, in both halves`, async ({ page }) => {
      await page.goto(`/anime/${id}`);
      const badge = scoreBadge(page);
      await expect(badge).toBeVisible();

      const style = await badge.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.color, background: cs.backgroundColor };
      });

      expect(style.color).toBe(`rgb(${rgb})`);
      // The pill is the same hue at 12%. Before the fix this was
      // rgba(255, 159, 10, 0.12) — amber — for every score, including this one.
      expect(style.background).toBe(`rgba(${rgb}, 0.12)`);
    });
  }

  test("the two bands actually differ", async ({ page }) => {
    // Guards the guard: if scoreBadgeStyle ever returned a constant, both
    // assertions above would still need the constant to be right, but a
    // future refactor collapsing the bands would be caught here first.
    await page.goto(`/anime/${HIGH}`);
    const high = await scoreBadge(page).evaluate((el) => getComputedStyle(el).color);
    await page.goto(`/anime/${LOW}`);
    const low = await scoreBadge(page).evaluate((el) => getComputedStyle(el).color);
    expect(high).not.toBe(low);
  });
});

test.describe("the hero on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the synopsis starts on the first screen", async ({ page }) => {
    // Measured on production before this change: the synopsis began at
    // y=799 on an 844-tall screen, which is about 45px of visible text under
    // a 400px banner and a 300px poster. This is the assertion that keeps
    // the hero from growing back.
    await page.goto(`/anime/${HIGH}`);

    const synopsis = page.locator("main p").filter({ hasText: "A test synopsis" }).first();
    await expect(synopsis).toBeVisible();

    const box = await synopsis.boundingBox();
    expect(box).not.toBeNull();
    // Half the fold, not all of it: "technically above 844" is what the old
    // layout already satisfied.
    expect(box!.y).toBeLessThan(422);
  });

  test("the banner, the poster and the overlap shrink together", async ({ page }) => {
    // The four hero values are one design. This checks the two that are
    // measurable from outside actually moved, so that a future change to one
    // clamp without the others fails here rather than looking merely odd.
    await page.goto(`/anime/${HIGH}`);

    const banner = page.locator("main img[aria-hidden='true']").first();
    const bannerBox = await banner.boundingBox();
    expect(bannerBox).not.toBeNull();
    expect(bannerBox!.height).toBeLessThan(200);

    const cover = page.locator("img.hero-cover").first();
    const coverBox = await cover.boundingBox();
    expect(coverBox).not.toBeNull();
    expect(coverBox!.width).toBeLessThan(140);

    // The poster still straddles the banner's lower edge — that overlap is
    // the hero's whole visual idea, and a mis-scaled pull would either
    // detach it or bury it.
    expect(coverBox!.y).toBeLessThan(bannerBox!.y + bannerBox!.height);
    expect(coverBox!.y + coverBox!.height).toBeGreaterThan(
      bannerBox!.y + bannerBox!.height,
    );
  });
});

test.describe("the hero on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps its full-size banner and poster", async ({ page }) => {
    // The other half of the clamp. The mobile work was only safe because it
    // left desktop untouched, and "untouched" is a claim worth holding.
    await page.goto(`/anime/${HIGH}`);

    const bannerBox = await page
      .locator("main img[aria-hidden='true']")
      .first()
      .boundingBox();
    expect(bannerBox?.height).toBe(400);

    const coverBox = await page.locator("img.hero-cover").first().boundingBox();
    expect(coverBox?.width).toBe(210);
    expect(Math.round(coverBox?.height ?? 0)).toBe(300);
  });
});
