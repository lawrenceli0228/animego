import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "./_helpers";

/**
 * `/welcome` (landing marketing page) — h1 + CTA visible.
 *
 * The landing page renders the HUD-styled HeroSection with an <h1
 * id="hero-heading"> (see components/landing/HeroSection.tsx:566).
 * FinalCta + HeroSection both expose a primary CTA <a class="*-cta">
 * pointing at "/".
 */
test("welcome page renders hero heading + primary CTA", async ({ page }) => {
  const errors = collectConsoleErrors(page);

  await page.goto("/welcome");

  // Hero heading by id — stable selector wired in the source.
  const heading = page.locator("#hero-heading");
  await expect(heading).toBeVisible();
  await expect(heading).not.toBeEmpty();

  // At least one CTA <a> on the page pointing at /. HeroSection +
  // FinalCta both ship one, so .first() is deterministic.
  const cta = page.locator('a[href="/"]').first();
  await expect(cta).toBeVisible();

  await page.waitForLoadState("networkidle");

  expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
});
