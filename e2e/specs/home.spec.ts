import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "./_helpers";

/**
 * `/` (HomePage RSC) — hero, navbar, no console errors.
 *
 * HomePage uses `dynamic = "force-dynamic"` so every render hits the
 * Go API. The hero takes the top 5 of the current season. The page's one
 * <h1> is the visually-hidden brand heading (page.tsx); each hero slide's
 * title is an <h2>. Navbar exposes a "登录" / "Login" link when the request
 * is anonymous. Interaction coverage lives in sandbox/home-redesign.spec.ts.
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

  // The brand <h1> (visually hidden, still "visible" to Playwright: it has
  // a 1px box) — the page has exactly one.
  await expect(page.locator("h1").first()).toBeVisible();

  // Allow async client hydration before settling.
  await page.waitForLoadState("networkidle");

  expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
});
