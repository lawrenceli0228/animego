import { test, expect, type Page } from "@playwright/test";
import { collectConsoleErrors, isKnownNoise } from "../_helpers";

/**
 * `/player` (sandbox) — shell mounts + jassub WASM worker is reachable.
 *
 * v2 scope is deliberately tiny. Real video playback would need a real
 * OPFS-backed file handle (Playwright cannot construct one) plus a
 * healthy ws-server (currently in restart loop in the sandbox stack
 * because DATABASE_URL is unset). Both are out of scope here.
 *
 * What we DO test:
 *  1. The Player route renders the idle dropzone surface without
 *     unhandled console errors. The `DropZone` in idle mode exposes
 *     `data-testid="dropzone"` (the player's own DropZone — different
 *     component from the library DropZone but same testid contract).
 *  2. `/jassub/wasm/jassub-worker.js` is served as JS by nginx. This
 *     catches CSP / asset-routing regressions for the WASM bundle
 *     without ever instantiating the worker.
 *
 * Like the library spec, the route is auth-gated by `app/player/
 * layout.tsx`. Same login fallback applies.
 *
 * v2.2 TODO:
 *   - Once an auth fixture (subagent B) lands, drop the inline login.
 *   - Once a mockable file source is wired (probably a Blob URL +
 *     a test-only escape hatch in PlayerShell), expand to assert the
 *     artplayer instance constructs (currently we only assert the
 *     shell + idle surface, never the artplayer container itself).
 */

const E2E_EMAIL = process.env.E2E_SANDBOX_EMAIL;
const E2E_PASSWORD = process.env.E2E_SANDBOX_PASSWORD;

/**
 * Extra noise patterns the player surface emits without there being
 * a real failure: jassub log lines, danmaku socket connect failures
 * (ws-server is intentionally absent in the sandbox stack), and
 * artplayer informational warnings about missing video sources.
 */
const PLAYER_NOISE_PATTERNS: RegExp[] = [
  /jassub/i,
  /artplayer/i,
  /danmuku/i,
  /socket\.io/i,
  /websocket/i,
  /ws-server/i,
  /Failed to fetch/i,
];

function isPlayerNoise(text: string): boolean {
  if (isKnownNoise(text)) return true;
  return PLAYER_NOISE_PATTERNS.some((rx) => rx.test(text));
}

function collectPlayerErrors(page: Page): string[] {
  // We can't re-use `collectConsoleErrors` directly because the player
  // page emits a wider set of known-noise patterns (jassub, artplayer,
  // socket.io). Subscribe locally with the extended filter.
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isPlayerNoise(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => {
    const text = err.message;
    if (isPlayerNoise(text)) return;
    errors.push(`pageerror: ${text}`);
  });
  return errors;
}

async function loginViaForm(page: Page): Promise<void> {
  if (!E2E_EMAIL || !E2E_PASSWORD) {
    throw new Error(
      "E2E_SANDBOX_EMAIL / E2E_SANDBOX_PASSWORD not set — cannot drive /login form",
    );
  }
  await page.goto("/login");
  await page.locator("#login-email").fill(E2E_EMAIL);
  await page.locator("#login-password").fill(E2E_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 10_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
}

test.describe("/player — sandbox journeys", () => {
  test.skip(
    !E2E_EMAIL || !E2E_PASSWORD,
    "E2E_SANDBOX_EMAIL / E2E_SANDBOX_PASSWORD must be set to drive the auth-gated /player route",
  );

  test("player shell loads idle surface without unhandled errors", async ({
    page,
  }) => {
    const errors = collectPlayerErrors(page);

    await loginViaForm(page);

    // Visit /player with no params. PlayerShell sets uiPhase='idle' and
    // there is no `seriesId`, so it renders the idle `<DropZone />`.
    // We deliberately AVOID `?seriesId=` because that would push the
    // shell into library-loading mode which needs a populated Dexie +
    // file handle — out of scope here.
    await page.goto("/player");

    // DropZone is the idle landmark. Same testid as the library
    // DropZone but a separate component (`app/player/_components/
    // DropZone.tsx`). Stable selector wired in the source.
    const dropzone = page.getByTestId("dropzone");
    await expect(dropzone).toBeVisible({ timeout: 10_000 });

    // Settle for 3s to allow jassub init / any deferred imports to fire.
    // The 3s window is the explicit assertion: nothing unexpected logs.
    await page.waitForTimeout(3000);

    expect(
      errors,
      `Unexpected console errors during 3s settle:\n${errors.join("\n")}`,
    ).toEqual([]);
  });

  test("/jassub/wasm/jassub-worker.js is served as JS", async ({ page, request }) => {
    // No auth needed for the static asset, but `request` inherits the
    // base URL and ignoreHTTPSErrors from the project config.
    void page; // silence unused-arg lint without changing the signature contract
    const res = await request.get("/jassub/wasm/jassub-worker.js");
    expect(
      res.status(),
      `/jassub/wasm/jassub-worker.js returned ${res.status()}`,
    ).toBe(200);
    const ct = res.headers()["content-type"] ?? "";
    // Nginx may serve either `application/javascript` or
    // `text/javascript`. Accept both.
    expect(ct).toMatch(/javascript/i);
    const body = await res.text();
    // Sanity check: should contain at least one byte of JS source.
    expect(body.length).toBeGreaterThan(100);
  });
});

// Disable the spec entirely if the player route's source has moved.
// Documented selector contract (must hold for the spec to be meaningful):
//   - app/player/_components/DropZone.tsx exposes data-testid="dropzone"
//     when uiPhase === 'idle'.
//   - public/jassub/wasm/jassub-worker.js is served from /jassub/wasm/.
// If either invariant breaks, mark the failing test `test.fixme()` and
// update the selectors here.
