// P10 sandbox — auth journey end-to-end.
//
// Three flows against the live sandbox stack (Express + Mongo + Next-app
// + nginx on https://localhost). Every spec uses a fresh user; no shared
// state between tests so order doesn't matter.
//
// Why this lives in specs/sandbox/ (not the top-level specs/): the
// chromium-prod project explicitly ignores sandbox/** so these writes
// never hit the live VPS. See e2e/playwright.config.ts.

import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "../_helpers";
import {
  cleanupAllTestUsers,
  closeMongo,
  getResetTokenForEmail,
  insertUser,
} from "../../fixtures/mongo";
import { makeUser } from "../../fixtures/users";

// Start every test with a clean cookie jar so the already-authed
// bypass on /login + /register doesn't redirect us off the form.
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  await cleanupAllTestUsers();
});

test.afterAll(async () => {
  await cleanupAllTestUsers();
  await closeMongo();
});

test.describe("auth journey", () => {
  test("register → logout → login lands authenticated", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const user = makeUser();

    // ── Register
    await page.goto("/register");
    await page.locator("#register-username").fill(user.username);
    await page.locator("#register-email").fill(user.email);
    await page.locator("#register-password").fill(user.password);
    await page.locator('button[type="submit"]').click();

    // Successful register replaces the route to `from` (default "/").
    // Wait for the navbar's logged-in CTAs to surface so we know the
    // session cookie has been committed and the layout's /api/auth/me
    // fetch resolved.
    await expect(page).toHaveURL(/\/$/);
    const navbar = page.locator('nav[aria-label="主导航"], nav[aria-label="Main navigation"]');
    await expect(navbar.getByRole("button", { name: /登出|Logout/ })).toBeVisible();

    // ── Logout (navbar button — see Navbar.tsx:222-229)
    //
    // The button fires POST /api/auth/logout then router.refresh().
    // Wait for the anonymous CTAs to come back before asserting we're
    // signed out — otherwise we race with the RSC re-render.
    await navbar.getByRole("button", { name: /登出|Logout/ }).click();
    await expect(navbar.locator('a[href="/login"]')).toBeVisible();

    // ── Login with the just-registered credentials
    await page.goto("/login");
    await page.locator("#login-email").fill(user.email);
    await page.locator("#login-password").fill(user.password);
    await page.locator('button[type="submit"]').click();

    // Same authenticated-landing signal as the register branch.
    await expect(page).toHaveURL(/\/$/);
    await expect(navbar.getByRole("button", { name: /登出|Logout/ })).toBeVisible();

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("login with wrong password surfaces inline error", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const user = makeUser();
    await insertUser(user);

    await page.goto("/login");
    await page.locator("#login-email").fill(user.email);
    await page.locator("#login-password").fill("definitely-not-the-password");
    await page.locator('button[type="submit"]').click();

    // Inline error sits in <p role="alert" aria-live="polite"> inside
    // the form. Backend returns Chinese "邮箱或密码错误" verbatim (see
    // server/controllers/auth.controller.js:90); the dict lookup misses
    // the Chinese key and falls through to the raw server message. We
    // match on the message substring rather than the entire `t.fail`
    // fallback because the form actually shows the backend wording.
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(/邮箱或密码错误|Invalid email or password|登录失败|Login failed/);

    // URL stayed on /login — the failed submit must not redirect.
    await expect(page).toHaveURL(/\/login(\?|$)/);

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("forgot-password → reset-password → login with new password", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    const user = makeUser();
    await insertUser(user);

    // ── Forgot password — submit the email
    await page.goto("/forgot-password");
    await page.locator("#forgot-email").fill(user.email);
    await page.locator('button[type="submit"]').click();

    // Form swaps to the "sent" view (✉️ + success message + back link).
    // The success copy is dict.forgotPassword.success — match a
    // substring stable across locales (the ✉️ glyph is aria-hidden so
    // pick the back-to-login link as the "sent" sentinel).
    await expect(page.getByRole("link", { name: /返回登录|Back to login/ })).toBeVisible();

    // ── Read token directly from Mongo. The sandbox stack does not
    // wire a real mail provider (sendPasswordResetEmail is best-effort
    // and the test runner never sees the email), so we sidestep email
    // entirely and pull `resetPasswordToken` straight off the user doc.
    const reset = await getResetTokenForEmail(user.email);
    expect(reset).not.toBeNull();
    const token = reset!.token;

    // ── Visit /reset-password/<token>, set the new password
    const newPassword = "e2e-test-newpass-456";
    await page.goto(`/reset-password/${token}`);
    await page.locator("#reset-password").fill(newPassword);
    await page.locator("#reset-confirm").fill(newPassword);
    await page.locator('button[type="submit"]').click();

    // Reset success → router.replace("/login") + router.refresh(). The
    // form unmounts; assert the URL settled on /login.
    await expect(page).toHaveURL(/\/login(\?|$)/);

    // ── Log in with the new password
    await page.locator("#login-email").fill(user.email);
    await page.locator("#login-password").fill(newPassword);
    await page.locator('button[type="submit"]').click();

    const navbar = page.locator('nav[aria-label="主导航"], nav[aria-label="Main navigation"]');
    await expect(navbar.getByRole("button", { name: /登出|Logout/ })).toBeVisible();

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });
});
