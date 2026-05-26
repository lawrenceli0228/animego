// P10 sandbox — /admin access control.
//
// Two flows:
//   1. logged-in non-admin → /admin returns 403 (proxy.ts:69)
//   2. logged-in admin     → /admin renders the dashboard
//
// proxy.ts gates /admin/:path*. Behavior:
//   - no session cookie         → redirect /login?from=/admin
//   - role !== "admin"          → 403 Forbidden (raw response, no HTML)
//   - role === "admin"          → through to layout.tsx + page.tsx
//
// layout.tsx repeats the role check as belt-and-suspenders; the layout
// only renders when both checks pass. We assert on the visible
// "管理后台" h1 from layout.tsx + the "用户管理" h2 from UsersSection.

import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "../_helpers";
import {
  cleanupAllTestUsers,
  closeMongo,
  insertAdmin,
  insertUser,
} from "../../fixtures/mongo";
import { makeUser } from "../../fixtures/users";

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  await cleanupAllTestUsers();
});

test.afterAll(async () => {
  await cleanupAllTestUsers();
  await closeMongo();
});

async function loginViaForm(
  page: import("@playwright/test").Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login")),
    page.locator('button[type="submit"]').click(),
  ]);
}

test.describe("admin access control", () => {
  test("non-admin user is rejected from /admin with 403", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const user = makeUser("user");
    await insertUser(user);

    await loginViaForm(page, user.email, user.password);

    // proxy.ts:69 returns `new NextResponse("Forbidden", { status: 403 })`
    // for authed-but-non-admin requests. page.goto returns the final
    // response so we can read the status code directly without parsing
    // the page body. The body is plain text "Forbidden" — no HTML
    // landmarks to assert against, status code is the contract.
    const response = await page.goto("/admin");
    expect(response, "page.goto should return a response").not.toBeNull();
    expect(response!.status()).toBe(403);

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("admin user sees the admin dashboard", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const { user } = await insertAdmin(
      `e2e-test-admin-${Date.now()}@animego.test`,
    );

    await loginViaForm(page, user.email, user.password);

    await page.goto("/admin");

    // layout.tsx renders <h1>管理后台</h1> for every admin page; that's
    // the most stable landmark for "we got past the gate". UsersSection
    // renders <section id="users"> with <h2 id="users-heading">用户管理
    // </h2>. Both must be visible — picking two assertions reduces
    // false-positives if a future refactor moves one heading.
    await expect(
      page.getByRole("heading", { level: 1, name: /管理后台/ }),
    ).toBeVisible();
    await expect(page.locator("#users")).toBeVisible();

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });
});
