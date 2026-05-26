import { test, expect, type Page } from "@playwright/test";
import { collectConsoleErrors } from "../_helpers";
import { seedLibrary, clearLibrary } from "../../fixtures/dexie-seed";

/**
 * `/library` (sandbox) — Dexie-seeded card render + empty state.
 *
 * The Library page is auth-gated by `app/library/layout.tsx`
 * (cookie `session` JWT, verified server-side). Subagent B owns the
 * canonical `users.ts` / `mongo.ts` storageState fixture; until that
 * is wired up, this spec logs in interactively via the `/login` form
 * using sandbox credentials from env.
 *
 * Env contract (sandbox docker-compose seeds the user):
 *   E2E_SANDBOX_EMAIL=...
 *   E2E_SANDBOX_PASSWORD=...
 *
 * If either is missing, the test is `skip`ped so CI surfaces a clear
 * "not configured" signal instead of a fake pass.
 *
 * v2.2 TODO: replace the inline login with the auth storageState
 * fixture from `e2e/fixtures/users.ts` once subagent B's PR lands.
 */

const E2E_EMAIL = process.env.E2E_SANDBOX_EMAIL;
const E2E_PASSWORD = process.env.E2E_SANDBOX_PASSWORD;

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

test.describe("/library — sandbox journeys", () => {
  test.skip(
    !E2E_EMAIL || !E2E_PASSWORD,
    "E2E_SANDBOX_EMAIL / E2E_SANDBOX_PASSWORD must be set to drive the auth-gated /library route",
  );

  test("seeded library renders at least one series card", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await loginViaForm(page);

    // After login we land somewhere (e.g. /) — visit /welcome to get
    // a known same-origin surface that does NOT itself touch Dexie.
    // From there we seed IndexedDB before /library opens its own
    // Dexie connection.
    await page.goto("/welcome");
    const { seriesId } = await seedLibrary(page);
    expect(seriesId).toBe("e2e-test-series-001");

    await page.goto("/library");

    // Header is a HUD landmark that mounts unconditionally once the
    // shell hydrates. Waiting on it confirms LibraryShell has booted
    // before we assert on card content.
    await expect(page.getByTestId("library-hud-header")).toBeVisible({
      timeout: 10_000,
    });

    // SeriesGrid renders at least one `series-card-root`. The grid is
    // gated by `availabilityReady`; with no fileHandles it short-circuits
    // to `ready` immediately (see `useFileHandles` — empty roots → status
    // 'ready'), and `useSeriesLibraryStatus` reports `ready: true` after
    // its first liveQuery emission (empty index).
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

    await loginViaForm(page);

    // Make sure no rows linger from a prior test on the same context.
    await page.goto("/welcome");
    await clearLibrary(page);

    await page.goto("/library");

    // With no series rows, `LibraryShell` renders `<DropZone />`
    // (FSA supported in Chromium) as the empty-state surface. The
    // DropZone exposes `data-testid="dropzone"` and a primary picker
    // button at `data-testid="dropzone-pick"`.
    //
    // We DO NOT click the picker — `window.showDirectoryPicker()`
    // needs a real user gesture Playwright can't synthesize.
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
