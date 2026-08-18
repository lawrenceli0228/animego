import { expect, type Page, type Locator, type ConsoleMessage } from "@playwright/test";

/**
 * Console-error noise filters.
 *
 * Each pattern matches text we expect to see but do not want to fail
 * the test on:
 *   - Sentry SDK init warnings when DSN is missing (defensive — prod
 *     ships the DSN at build time per commit f45f710, but the guard
 *     keeps the spec robust if Sentry is ever disabled).
 *   - Cloudflare Insights beacon noise (third-party, served from
 *     cloudflareinsights.com).
 *   - Favicon / image 404s — transient and not user-visible.
 *   - AniList CDN image fetch failures — upstream-owned, not a regression
 *     in our code.
 *   - React DevTools / hydration informational logs that occasionally
 *     surface as `error` in dev modes.
 */
const KNOWN_NOISE_PATTERNS: RegExp[] = [
  /sentry/i,
  /cloudflareinsights\.com/i,
  /favicon/i,
  /anilist\.co\/.*\.(jpg|jpeg|png|webp)/i,
  /s4\.anilist\.co/i,
  /Failed to load resource.*4\d{2}/i,
  /\bnet::ERR_/i,
  /Download the React DevTools/i,
];

export function isKnownNoise(text: string): boolean {
  return KNOWN_NOISE_PATTERNS.some((rx) => rx.test(text));
}

/**
 * Attaches a console-error collector to a page. Call before navigation
 * and assert on the returned array at the end of the test.
 *
 *   const errors = collectConsoleErrors(page);
 *   await page.goto("/");
 *   // ... assertions ...
 *   expect(errors).toEqual([]);
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isKnownNoise(text)) return;
    errors.push(text);
  });
  // Page errors (uncaught exceptions) are separate from console.error
  // and should also fail the spec.
  page.on("pageerror", (err) => {
    const text = err.message;
    if (isKnownNoise(text)) return;
    errors.push(`pageerror: ${text}`);
  });
  return errors;
}

// ─── Navbar auth chrome ─────────────────────────────────────────────────
//
// Read this before writing "assert the user is logged in" by hand.
//
// The logged-in navbar is no longer a labelled strip. The auth-islanding
// rework collapsed `Hi <name> / 我的追番 / 我的库 / 设置 / 登出` into a 36×36
// avatar dropdown (Navbar.tsx renders <AvatarMenu>), so:
//
//   - the username appears ONLY as the avatar <img alt> and inside the
//     dropdown body — `expect(navbar).toContainText(username)` cannot pass;
//   - the logout control is a role="menuitem" button that does not exist in
//     the DOM until the avatar button is clicked — a page-level
//     getByRole("button", { name: /登出|Logout/ }) cannot pass either;
//   - auth resolves from a CLIENT-side /api/auth/me probe after hydration,
//     not from SSR, so all of it arrives late (lib/authChrome.ts).
//
// Both of the pre-rework assertions were still sitting in auth.spec.ts and
// admin.spec.ts, red, for months — nothing in CI ran the sandbox suite until
// .github/workflows/e2e-sandbox.yml. Centralizing the locators here means the
// next chrome rework has one file to fix instead of four.

/** The main nav, under either locale's aria-label. */
export function navbar(page: Page): Locator {
  return page.locator(
    'nav[aria-label="主导航"], nav[aria-label="Main navigation"]',
  );
}

// The /api/auth/me probe is client-side and post-hydration, and on a cold
// `next dev` route the compile happens first. 15s is empirically enough and
// still far short of a hang.
const AUTH_CHROME_TIMEOUT = 15_000;

/** Wait until the navbar shows `username`'s logged-in chrome. */
export async function expectSignedIn(
  page: Page,
  username: string,
): Promise<void> {
  await expect(page.locator(`img[alt="${username}"]`).first()).toBeVisible({
    timeout: AUTH_CHROME_TIMEOUT,
  });
}

/** Wait until the navbar shows the anonymous CTAs. */
export async function expectSignedOut(page: Page): Promise<void> {
  await expect(navbar(page).locator('a[href="/login"]')).toBeVisible({
    timeout: AUTH_CHROME_TIMEOUT,
  });
}

/**
 * Log out through the UI: open the avatar dropdown, click its logout
 * menuitem. Does NOT wait for the signed-out chrome — assert that with
 * `expectSignedOut` so a caller can decide the timeout.
 */
export async function logoutViaNavbar(page: Page): Promise<void> {
  await navbar(page)
    .getByRole("button", { name: /账户菜单|Account menu/ })
    .click();
  await page.getByRole("menuitem", { name: /登出|Logout/ }).click();
}
