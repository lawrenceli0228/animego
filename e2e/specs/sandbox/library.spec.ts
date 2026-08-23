import { test, expect } from "@playwright/test";
import { collectConsoleErrors, expectSignedIn } from "../_helpers";
import { seedLibrary, clearLibrary } from "../../fixtures/dexie-seed";

test.describe("/library — sandbox journeys", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Logged-in sanity check. Why this is an avatar and not navbar text is
    // documented once, in _helpers.
    await expectSignedIn(page, "e2e-sandbox");
  });

  test("seeded library renders at least one series card", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/welcome");
    const { seriesId } = await seedLibrary(page);
    expect(seriesId).toBe("e2e-test-series-001");

    await page.goto("/library");

    await expect(page.getByTestId("library-hud-header")).toBeVisible({
      timeout: 10_000,
    });

    const grid = page.getByTestId("series-grid");
    await expect(grid).toBeVisible({ timeout: 10_000 });
    const cards = page.getByTestId("series-card-root");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    expect(await cards.count()).toBeGreaterThanOrEqual(1);

    // Watch-folder auto-rescan must be a silent no-op here (no fileHandles
    // seeded): the full-screen import drawer/scrim must never cover the grid.
    await expect(page.getByTestId("import-drawer")).toHaveCount(0);
    await expect(page.getByTestId("import-drawer-scrim")).toHaveCount(0);

    await page.waitForLoadState("networkidle");

    expect(
      errors,
      `Unexpected console errors:\n${errors.join("\n")}`,
    ).toEqual([]);
  });

  // Regression: 3.13.0 moved FadeImage onto next/image and /library rendered
  // 26 empty cards with 115 console 400s. `remotePatterns` allows only
  // s4.anilist.co, while these covers are whatever the dandanplay match
  // returned — img.dandanplay.net, a bgm mirror, sometimes plain http. The
  // optimizer 400s on those and FadeImage has no onError, so nothing appears.
  //
  // Nothing caught it. The build, the type check and the lint cannot: it is a
  // runtime host check against an optional prop. The library specs could not
  // either, because the fixture seeded `posterUrl: ""` and the card fell back
  // to its monogram — the page never requested an image.
  //
  // Two assertions, because either alone would have missed it:
  //   · the src must not be routed through /_next/image — the actual rule
  //   · naturalWidth > 0 — the element, its box and its layout were all
  //     correct while it was broken; only the decode was missing, so every
  //     visibility- or geometry-based check was blind to it
  test("library cover from a non-AniList host actually loads", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    // A 1x1 PNG, so "did it decode" is answerable without reaching the real
    // host. The URL still has to be a foreign one — that is what is on trial.
    const POSTER = "https://img.dandanplay.net/e2e/cover.jpg";
    await page.route(POSTER, (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      }),
    );

    await page.goto("/welcome");
    await seedLibrary(page, { series: [{ posterUrl: POSTER }] });

    await page.goto("/library");
    await expect(page.getByTestId("series-grid")).toBeVisible({ timeout: 10_000 });

    // By testid, not `.locator("img").first()`. The card has exactly one <img>
    // today, so position would work — and would silently retarget the day
    // someone adds a badge image above it.
    const cover = page.getByTestId("series-poster").first();
    await expect(cover).toBeVisible({ timeout: 10_000 });

    // The rule: a cover whose host we cannot enumerate must bypass the
    // optimizer. If someone drops `unoptimized`, this is the line that fails,
    // and it fails for the right reason rather than on a timeout.
    await expect(cover).toHaveAttribute("src", POSTER);

    await expect
      .poll(() => cover.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 10_000,
        message: "cover element rendered but never decoded",
      })
      .toBeGreaterThan(0);

    await page.waitForLoadState("networkidle");
    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("empty library shows DropZone import prompt", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/welcome");
    await clearLibrary(page);

    await page.goto("/library");

    const dropzone = page.getByTestId("dropzone");
    await expect(dropzone).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("dropzone-pick")).toBeVisible();

    await page.waitForLoadState("networkidle");

    expect(
      errors,
      `Unexpected console errors:\n${errors.join("\n")}`,
    ).toEqual([]);
  });
});
