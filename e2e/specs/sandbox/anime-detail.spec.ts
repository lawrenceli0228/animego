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
 * The site's own score, not Bangumi's.
 *
 * Anchored on the source name, which is what the hero prints: "AniList 87"
 * beside "Bangumi 7.9". It was `/^★/` back when both were stars and only the
 * Bangumi one carried a "BGM" prefix — the star said nothing the word does
 * not, and a 0-100 value shown as "8.7" had to be mentally converted before
 * it could be compared against the site it came from.
 *
 * Still a text anchor rather than a CSS-module class (hashed at build time)
 * or a test id (which would exist only for this file).
 */
const scoreBadge = (page: import("@playwright/test").Page) =>
  page.locator("main span").filter({ hasText: /^AniList\s/ }).first();

test.describe("the score", () => {
  // What this file used to pin here was a colour BAND: an 87 had to render
  // rgb(48,209,88) green and a 30 rgb(255,69,58) red, because production
  // once shipped green text on an amber pill — the fill named one band and
  // the text another.
  //
  // The hero no longer bands its scores. A band turns a number into a
  // verdict, and the page carries three of them (AniList, Bangumi, and one
  // per recommendation card) at a point where the reader has not decided to
  // care yet. The hero's score now carries the anime's own colour, and the
  // band mapping survives where a verdict IS the point — on the
  // recommendation covers, via scoreScrimStyle.
  //
  // So the assertions invert. What has to hold now is that the score does
  // NOT change colour with its value, and that the colour it does take is
  // the one derived from the artwork.

  test("carries the anime's colour, not a score band", async ({ page }) => {
    await page.goto(`/anime/${HIGH}`);
    const badge = scoreBadge(page);
    await expect(badge).toBeVisible();

    const seen = await badge.evaluate((el) => {
      const scope = el.closest(".poster-scope");
      const tone = scope
        ? getComputedStyle(scope).getPropertyValue("--poster-tone").trim()
        : "";
      // Both sides through the same canvas so an oklch() string and an rgb()
      // string are compared as pixels rather than as text.
      const paint = (colour: string) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).join(",");
      };
      return { score: paint(getComputedStyle(el).color), tone: tone ? paint(tone) : "" };
    });

    expect(seen.tone).not.toBe("");
    expect(seen.score).toBe(seen.tone);
  });

  test("does not change colour with its value", async ({ page }) => {
    // The inverse of the old "the two bands actually differ". A high score
    // and a low one are the same colour now, and that is the property: if
    // banding is reintroduced here these two diverge and this fails.
    await page.goto(`/anime/${HIGH}`);
    const high = await scoreBadge(page).evaluate((el) => getComputedStyle(el).color);
    await page.goto(`/anime/${LOW}`);
    const low = await scoreBadge(page).evaluate((el) => getComputedStyle(el).color);
    expect(high).toBe(low);
  });

  test("the source name stays quiet next to the number", async ({ page }) => {
    // "AniList 91" is a label plus a value, and at one weight the pair reads
    // as a single unparsed token. The label must be dimmer than the number.
    await page.goto(`/anime/${HIGH}`);
    const pair = await scoreBadge(page).evaluate((el) => {
      const label = el.querySelector("span");
      const lum = (c: string) => {
        const [r, g, b] = c.match(/[\d.]+/g)!.map(Number);
        const f = (v: number) => {
          const n = v / 255;
          return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      return {
        hasLabel: !!label,
        labelLum: label ? lum(getComputedStyle(label).color) : 0,
        valueLum: lum(getComputedStyle(el).color),
      };
    });
    expect(pair.hasLabel).toBe(true);
    expect(pair.labelLum).toBeLessThan(pair.valueLum);
  });
});

test.describe("the hero on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the synopsis starts on the first screen", async ({ page }) => {
    // Measured on production before this assertion existed: the synopsis
    // began at y=799 on an 844-tall screen — about 45px of visible text, one
    // line, under a 400px banner and a 300px poster. This is the assertion
    // that keeps the hero from growing back.
    await page.goto(`/anime/${HIGH}`);

    const synopsis = page.locator("main p").filter({ hasText: "A test synopsis" }).first();
    await expect(synopsis).toBeVisible();

    const box = await synopsis.boundingBox();
    expect(box).not.toBeNull();

    // The bound is stated as "how much text is readable", not as a y
    // coordinate, because that is the property being defended and the y that
    // satisfies it depends on the layout.
    //
    // It was `y < 422` — half the fold — while the synopsis lived inside the
    // hero. It no longer does: the hero is artwork with the title and the
    // controls on it, and the body copy is its own band underneath, which
    // costs the synopsis roughly 90px. Worst case in the catalogue (a
    // 20-character title beside seven genres) now starts at 490, and typical
    // titles at 407.
    //
    // 300px is nine or ten lines of Chinese body copy. The old defect fails
    // this by a wide margin — 844 − 799 = 45 — so the guard still catches
    // the regression it was written for.
    const VISIBLE_SYNOPSIS_MIN = 300;
    expect(box!.y).toBeLessThan(844 - VISIBLE_SYNOPSIS_MIN);
  });

  test("the artwork and the poster scale down together", async ({ page }) => {
    // Both halves of the hero shrink on a phone, so a future change to one
    // clamp without the other fails here rather than looking merely odd.
    await page.goto(`/anime/${HIGH}`);

    const banner = page.locator("main img[aria-hidden='true']").first();
    const bannerBox = await banner.boundingBox();
    expect(bannerBox).not.toBeNull();
    // The artwork is the hero's full background now, not a strip above it,
    // so this is the hero's own height. It was `< 200` when the banner was a
    // separate 150px band; the floor is 340 and it must stay well under half
    // the 844px screen.
    expect(bannerBox!.height).toBeLessThan(420);

    const cover = page.locator("img.hero-cover").first();
    const coverBox = await cover.boundingBox();
    expect(coverBox).not.toBeNull();
    expect(coverBox!.width).toBeLessThan(140);

    // The poster sits ON the artwork, fully inside it.
    //
    // This assertion is inverted from what it was. It used to require the
    // poster to STRADDLE the banner's lower edge, and the comment called
    // that overlap "the hero's whole visual idea" — true of the design it
    // was written for, where a fixed-height banner sat above content that a
    // negative margin pulled up into it. The artwork is now the background
    // of the whole hero and the content is laid on top of it, so there is no
    // seam left to straddle; a poster crossing the lower edge would mean the
    // content had overflowed the hero, which is the actual defect worth
    // catching here.
    expect(coverBox!.y).toBeGreaterThanOrEqual(bannerBox!.y);
    expect(coverBox!.y + coverBox!.height).toBeLessThanOrEqual(
      bannerBox!.y + bannerBox!.height,
    );
  });
});

test.describe("the hero on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps its full-size artwork and poster", async ({ page }) => {
    // The other half of the clamp. Phone work must not reach desktop, and
    // "untouched" is a claim worth holding.
    await page.goto(`/anime/${HIGH}`);

    const bannerBox = await page
      .locator("main img[aria-hidden='true']")
      .first()
      .boundingBox();
    // 556 at 1440px — the hero is `clamp(340px, 38.6vw, 560px)` and 38.6vw
    // is 555.84 here. It was 400, back when this was a fixed-height banner
    // strip rather than the full background of the hero.
    //
    // Rounded before comparing: 38.6vw lands on 555.828125 and a bounding
    // box is a float, so an exact toBe() would pin the number to whatever
    // sub-pixel the current viewport happens to produce.
    expect(Math.round(bannerBox?.height ?? 0)).toBe(556);

    const coverBox = await page.locator("img.hero-cover").first().boundingBox();
    expect(coverBox?.width).toBe(210);
    expect(Math.round(coverBox?.height ?? 0)).toBe(300);
  });
});
