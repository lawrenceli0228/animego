import { test, expect, type Page } from "@playwright/test";
import { SEED_USER_EMAIL } from "../../globalSetup";
import {
  closePg,
  ensureAnimeDetail,
  removeAnimeFixture,
  seedSubscription,
} from "../../fixtures/pg";

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
/** Valid by shape; the test inspects the embed URL without depending on YouTube. */
const TRAILER_ID = "abcdefghijk";

// The UI should be deterministic even when YouTube is slow or unavailable in
// CI. Keep the production URLs in the DOM (the assertions below inspect them),
// but satisfy the thumbnail locally and abort the player navigation. This also
// proves opening the dialog does not depend on the third-party frame loading.
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function isolateTrailerNetwork(page: Page): Promise<void> {
  await page.route("**/_next/image?*", async (route) => {
    const source = new URL(route.request().url()).searchParams.get("url");
    if (source?.startsWith("https://i.ytimg.com/")) {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: TRANSPARENT_PNG,
      });
      return;
    }
    await route.continue();
  });
  await page.route("https://www.youtube-nocookie.com/**", (route) => route.abort());
}

test.beforeEach(async ({ page }) => {
  await isolateTrailerNetwork(page);
});

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
    trailerId: TRAILER_ID,
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
  await seedSubscription(SEED_USER_EMAIL, HIGH, "watching", 4);
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
    //
    // Both reads wait for [data-accent-ready="true"] first, and that wait is
    // the whole reason this test is trustworthy. These two fixtures carry no
    // poster_accent (fixtures/pg.ts seeds title/episodes/format and nothing
    // else), so unlike a catalogue row — which ships --poster-hue inline in
    // the SSR markup — HeroAccent has to sample the cover on a canvas after
    // the image decodes. Until it does, --poster-tone resolves against the
    // :root placeholder hue.
    //
    // Read without waiting, this compares "whichever of the two navigations
    // happened to lose the race" against the other, and it fails in EITHER
    // direction from run to run: observed as expected-292.7/received-260.6 on
    // one attempt and the exact reverse on its retry. Both fixtures share one
    // cover (COVER above), so once both have settled they are the same hue by
    // construction and the assertion is about banding, which is what it is
    // for.
    const settledScoreColour = async (id: number) => {
      await page.goto(`/anime/${id}`);
      await page.locator('.poster-scope[data-accent-ready="true"]').waitFor();
      return scoreBadge(page).evaluate((el) => getComputedStyle(el).color);
    };

    const high = await settledScoreColour(HIGH);
    const low = await settledScoreColour(LOW);
    expect(high).toBe(low);

    // Guards the guard. If the wait above ever stops working, both sides
    // would agree on the placeholder and this test would pass while measuring
    // nothing at all. The placeholder is read off :root at runtime rather
    // than typed here, so it cannot go stale when globals.css changes.
    const placeholder = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
        .getPropertyValue("--poster-tone")
        .trim();
      const probe = document.createElement("span");
      probe.style.color = root;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    });
    expect(high).not.toBe(placeholder);
  });

  test("the source name is neutral, the value is not", async ({ page }) => {
    // "AniList 91" is a label plus a value, and they have to read as two
    // different kinds of thing — otherwise the pair is one unparsed token.
    //
    // The separation is chroma, not lightness. An earlier version of this
    // asserted the label was DARKER, which is wrong in both directions: the
    // reference design's label (#c5bbb9, luminance 0.499) is brighter than
    // its value (#e29d93, 0.424), because a neutral is always brighter than
    // a saturated colour at the same perceived lightness. Asserting on
    // luminance would pin an accident of which hue the anime happens to be.
    //
    // What actually has to hold: the label carries no hue and the value
    // carries the anime's.
    await page.goto(`/anime/${HIGH}`);
    const pair = await scoreBadge(page).evaluate((el) => {
      // Through a canvas so a half-transparent label is measured as it is
      // COMPOSITED, not as its unmultiplied channels — the earlier version
      // read rgba(235,235,245,0.52) as near-white and compared that against
      // a fully opaque value.
      const paint = (colour: string) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const spread = (rgb: number[]) => Math.max(...rgb) - Math.min(...rgb);
      const label = el.querySelector("span");
      return {
        hasLabel: !!label,
        labelSpread: label ? spread(paint(getComputedStyle(label).color)) : -1,
        valueSpread: spread(paint(getComputedStyle(el).color)),
      };
    });

    expect(pair.hasLabel).toBe(true);
    // A neutral's channels sit within a few points of each other; the site's
    // text ramp is rgba(235,235,245,...), a 10-point spread by design.
    expect(pair.labelSpread).toBeLessThanOrEqual(12);
    // The value is a real colour, so its channels are far apart.
    expect(pair.valueSpread).toBeGreaterThan(20);
  });
});

test.describe("the hero on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("keeps the trailer compact and centers its theater", async ({ page }) => {
    await page.goto(`/anime/${HIGH}`);

    const trigger = page.getByRole("button", {
      name: "播放《E2E 高分》的官方预告",
    });
    await expect(trigger).toBeVisible();
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(triggerBox!.height).toBeGreaterThanOrEqual(44);
    expect(triggerBox!.width).toBeLessThan(250);

    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "E2E 高分" });
    await expect(dialog).toBeVisible();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(
      Math.abs(dialogBox!.y + dialogBox!.height / 2 - 844 / 2),
    ).toBeLessThan(4);
    await expect(dialog.locator("iframe")).toHaveAttribute(
      "src",
      `https://www.youtube-nocookie.com/embed/${TRAILER_ID}?autoplay=1&rel=0&playsinline=1`,
    );

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

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

  test(
    "places the trailer beside the synopsis without covering the artwork",
    async ({ page }) => {
      await page.goto(`/anime/${HIGH}`);

      const trigger = page.getByRole("button", {
        name: "播放《E2E 高分》的官方预告",
      });
      await expect(trigger).toBeVisible();
      const box = await trigger.boundingBox();
      const heroBox = await page.locator("[data-banner]").boundingBox();
      const synopsisBox = await page
        .locator('section[aria-labelledby="synopsis-heading"]')
        .boundingBox();
      expect(box).not.toBeNull();
      expect(heroBox).not.toBeNull();
      expect(synopsisBox).not.toBeNull();
      // The still remains recognisable and actionable, but is deliberately a
      // content card rather than a second full-width hero.
      expect(box!.width).toBeGreaterThanOrEqual(360);
      expect(box!.width).toBeLessThanOrEqual(480);
      expect(box!.width / box!.height).toBeCloseTo(16 / 9, 1);
      // It starts below the artwork and lives inside the same reading band as
      // the synopsis, so the page gains media without burying either image or
      // pushing the description behind a standalone promotional slab.
      expect(box!.y).toBeGreaterThanOrEqual(heroBox!.y + heroBox!.height);
      expect(box!.y).toBeGreaterThanOrEqual(synopsisBox!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        synopsisBox!.y + synopsisBox!.height,
      );

      await trigger.click();
      await expect(
        page.getByRole("dialog", { name: "E2E 高分" }),
      ).toBeVisible();
    },
  );

  test(
    "does not invent a trailer action when the database has none",
    async ({ page }) => {
      await page.goto(`/anime/${LOW}`);
      await expect(
        page.getByRole("button", { name: "播放《E2E 低分》的官方预告" }),
      ).toHaveCount(0);
    },
  );

  test("keeps its full-size artwork and poster", async ({ page }) => {
    // The other half of the clamp. Phone work must not reach desktop, and
    // "untouched" is a claim worth holding.
    await page.goto(`/anime/${HIGH}`);

    const bannerBox = await page
      .locator("main img[aria-hidden='true']")
      .first()
      .boundingBox();
    // 556 at 1440px. The hero is `clamp(400px, 44vw, 556px)` and 44vw is
    // 633.6 here, so this is the ceiling. It reached the same number by a
    // different route before — `clamp(340px, 38.6vw, 560px)`, where 38.6vw
    // landed on 555.83 — which is why the assertion did not move when the
    // formula did. Do not read that as the formula being unchanged.
    //
    // Rounded before comparing: a bounding box is a float, so an exact toBe()
    // would pin the number to whatever sub-pixel the viewport produces.
    expect(Math.round(bannerBox?.height ?? 0)).toBe(556);

    // 216 at 1440px — the cover is `clamp(124px, 15.5vw, 216px)` and 15.5vw
    // is 223.2 here, so this is the ceiling too. It was 210 under the earlier
    // `clamp(112px, 22vw, 210px)`; both halves moved together when the hero
    // was recalibrated against the real 1400px content width (DESIGN.md >
    // Anime Detail Page > Hero).
    //
    // The height is derived rather than typed, because it is not an
    // independent fact: `aspect-ratio: 210 / 300` owns it, and a hardcoded
    // second number is just a chance for the two to disagree silently. What
    // this asserts is that the ratio is intact at the ceiling.
    const coverBox = await page.locator("img.hero-cover").first().boundingBox();
    expect(coverBox?.width).toBe(216);
    expect(Math.round(coverBox?.height ?? 0)).toBe(Math.round(216 * (300 / 210)));
  });
});

const TRAILER_LOCALES = [
  {
    language: "简体中文",
    path: `/anime/${HIGH}`,
    title: "E2E 高分",
    official: "官方预告",
    watch: "观看预告",
    trigger: "播放《E2E 高分》的官方预告",
    close: "关闭预告",
    openYouTube: "在 YouTube 观看",
  },
  {
    language: "繁體中文",
    path: `/zh-Hant/anime/${HIGH}`,
    title: "E2E 高分",
    official: "官方預告",
    watch: "觀看預告",
    trigger: "播放《E2E 高分》的官方預告",
    close: "關閉預告",
    openYouTube: "在 YouTube 觀看",
  },
  {
    language: "English",
    path: `/en/anime/${HIGH}`,
    title: "E2E High Score",
    official: "Official trailer",
    watch: "Watch trailer",
    trigger: "Play the official trailer for E2E High Score",
    close: "Close trailer",
    openYouTube: "Watch on YouTube",
  },
] as const;

test.describe("the trailer in every supported language", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const locale of TRAILER_LOCALES) {
    test(`${locale.language} labels the trigger and theater`, async ({ page }) => {
      await page.goto(locale.path);

      const trigger = page.getByRole("button", { name: locale.trigger });
      await expect(trigger).toBeVisible();
      await expect(
        page.getByText(locale.official, { exact: true }).filter({ visible: true }),
      ).toHaveCount(1);
      await expect(
        page.getByText(locale.watch, { exact: true }).filter({ visible: true }),
      ).toHaveCount(1);

      await trigger.click();
      const dialog = page.getByRole("dialog", { name: locale.title });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(locale.official, { exact: true })).toBeVisible();
      await expect(
        dialog.getByRole("link", { name: locale.openYouTube }),
      ).toHaveAttribute(
        "href",
        `https://www.youtube.com/watch?v=${TRAILER_ID}`,
      );

      await dialog.getByRole("button", { name: locale.close }).click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    });
  }
});

test.describe("the trailer with an expanded signed-in action set", () => {
  test.use({
    storageState: "./.auth/user.json",
    viewport: { width: 390, height: 844 },
  });

  test("stays ahead of subscription controls without being squeezed", async ({
    page,
  }) => {
    await page.goto(`/anime/${HIGH}`);

    const trailer = page.getByRole("button", {
      name: "播放《E2E 高分》的官方预告",
    });
    const status = page.getByRole("combobox", { name: "在看" });
    await expect(trailer).toBeVisible();
    await expect(status).toBeVisible();

    const [trailerBox, statusBox] = await Promise.all([
      trailer.boundingBox(),
      status.boundingBox(),
    ]);
    expect(trailerBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    expect(trailerBox!.height).toBeGreaterThanOrEqual(44);
    expect(trailerBox!.y + trailerBox!.height).toBeLessThanOrEqual(statusBox!.y);
  });
});
