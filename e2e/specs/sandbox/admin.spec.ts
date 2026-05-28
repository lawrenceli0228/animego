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
import { collectConsoleErrors } from "../_helpers";
import { closeMongo, insertAdmin } from "../../fixtures/mongo";

// Cleanup is centralized in globalSetup so it runs once before any
// worker starts. Doing it per-spec races with parallel test files.
test.afterAll(async () => {
  await closeMongo();
});

test.describe("non-admin rejection", () => {
  test("non-admin user is rejected from /admin with 403", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    const navbar = page.locator('nav[aria-label="主导航"], nav[aria-label="Main navigation"]');
    await page.goto("/");
    await expect(navbar).toContainText("e2e-sandbox");

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

    const { user } = await insertAdmin(
      `e2e-test-admin-${Date.now()}@animego.test`,
    );

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
