import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "./_helpers";

/**
 * `/` (HomePage RSC) — hero carousel, navbar, no console errors.
 *
 * HomePage uses `dynamic = "force-dynamic"` so every render hits the
 * Go API. The hero takes the top 5 of the current season; the carousel
 * renders an <h1> per slide (see HeroCarousel.tsx:306). Navbar exposes
 * a "登录" / "Login" link when the request is anonymous.
 */
test("home page renders hero + navbar without console errors", async ({ page }) => {
  const errors = collectConsoleErrors(page);

  await page.goto("/");

  // Navbar landmark — stable aria-label.
  const nav = page.locator('nav[aria-label="主导航"], nav[aria-label="Main navigation"]');
  await expect(nav).toBeVisible();

  // Anonymous CTA — login link sits inside the navbar. Locale-agnostic
  // selector: any <a> pointing at /login.
  const loginLink = nav.locator('a[href="/login"]');
  await expect(loginLink).toBeVisible();

  // Hero carousel renders an <h1> for the current slide. The home page
  // currently has exactly one <h1> at a time (carousel cycles state).
  await expect(page.locator("h1").first()).toBeVisible();

  // Allow async client hydration + carousel mount before settling.
  await page.waitForLoadState("networkidle");

  expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
});
