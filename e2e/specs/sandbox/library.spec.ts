import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "../_helpers";
import { seedLibrary, clearLibrary } from "../../fixtures/dexie-seed";

test.describe("/library — sandbox journeys", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Logged-in sanity check. The navbar no longer renders the username as
    // text — since the auth-islanding rework the logged-in chrome collapses
    // into an avatar dropdown (username only in the img alt / menu body), and
    // auth resolves via a client-side /api/auth/me probe after hydration. So
    // assert the seed user's avatar instead of navbar text, with a timeout
    // generous enough for the probe.
    await expect(page.locator('img[alt="e2e-sandbox"]').first()).toBeVisible({
      timeout: 15_000,
    });
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
