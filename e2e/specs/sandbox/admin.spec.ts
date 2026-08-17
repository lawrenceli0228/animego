// P10 sandbox — /admin access control.
//
// Two flows:
//   1. logged-in non-admin → /admin returns 403 (proxy.ts:69)
//   2. logged-in admin     → /admin renders the dashboard
//
// The globalSetup storageState user has role=null (plain user), so the
// non-admin block uses it via the project-level storageState. The admin
// block opts out of that state and logs in fresh with a per-run admin
// account it inserts itself.

import { test, expect } from "@playwright/test";
import { collectConsoleErrors, expectSignedIn } from "../_helpers";
import { closePg, insertPgUser } from "../../fixtures/pg";
import { makeUser } from "../../fixtures/users";

// Cleanup is centralized in globalSetup so it runs once before any
// worker starts. Doing it per-spec races with parallel test files.
test.afterAll(async () => {
  await closePg();
});

test.describe("non-admin rejection", () => {
  test("non-admin user is rejected from /admin with 403", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    // Precondition, not the assertion under test: confirm the storageState
    // really carries a session before reading /admin, so a 403 below can
    // only mean "logged in and not an admin". The old form of this line
    // read the username out of the navbar as text, which the avatar-menu
    // rework made impossible — see _helpers.
    await page.goto("/");
    await expectSignedIn(page, "e2e-sandbox");

    const response = await page.goto("/admin");
    expect(response, "page.goto should return a response").not.toBeNull();
    expect(response!.status()).toBe(403);

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });
});

test.describe("admin dashboard", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("admin user sees the admin dashboard", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    // The Postgres row is the whole account. The old two-step — mint the
    // record via a Mongo `insertAdmin`, then re-insert it into Postgres
    // "so Go API login can authenticate the admin" — kept a Mongo write
    // whose only surviving purpose was to hand back a user object.
    // makeUser does that without a database.
    const user = makeUser("admin");
    await insertPgUser({
      username: user.username,
      email: user.email,
      passwordHash: user.passwordHash,
      role: "admin",
    });

    await page.goto("/login");
    await page.locator("#login-email").fill(user.email);
    await page.locator("#login-password").fill(user.password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/login")),
      page.locator('button[type="submit"]').click(),
    ]);

    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { level: 1, name: /管理后台/ }),
    ).toBeVisible();
    await expect(page.locator("#users")).toBeVisible();

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });
});
