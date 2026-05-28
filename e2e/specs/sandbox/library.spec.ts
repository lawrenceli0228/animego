import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "../_helpers";
import { seedLibrary, clearLibrary } from "../../fixtures/dexie-seed";

test.describe("/library — sandbox journeys", () => {
  test.beforeEach(async ({ page }) => {
    const navbar = page.locator('nav[aria-label="主导航"], nav[aria-label="Main navigation"]');
    await page.goto("/");
    await expect(navbar).toContainText("e2e-sandbox");
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
