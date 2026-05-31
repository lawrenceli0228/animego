import type { Page, ConsoleMessage } from "@playwright/test";

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
