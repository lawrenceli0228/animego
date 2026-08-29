// Sandbox — auth journey end-to-end.
//
// Three flows against the sandbox stack (next-app + go-api + Postgres).
// Every spec uses a fresh user; no shared state between tests so order
// doesn't matter.
//
// Why this lives in specs/sandbox/ (not the top-level specs/): the
// chromium-prod project explicitly ignores sandbox/** so these writes
// never hit the live VPS. See e2e/playwright.config.ts.

import { test, expect } from "@playwright/test";
import {
  collectConsoleErrors,
  expectSignedIn,
  expectSignedOut,
  logoutViaNavbar,
} from "../_helpers";
import { makeUser } from "../../fixtures/users";
import { closePg, getResetTokenFromPg, insertPgUser } from "../../fixtures/pg";
import { waitForHydration } from "../../fixtures/hydration";

// Start every test with a clean cookie jar so the already-authed
// bypass on /login + /register doesn't redirect us off the form.
test.use({ storageState: { cookies: [], origins: [] } });

// Cleanup happens once in globalSetup before any spec runs. Per-spec
// cleanup races with the admin spec in parallel mode (it would nuke
// admin's freshly-inserted user mid-login). Stragglers from killed
// runs are tolerable in the sandbox DB.
test.afterAll(async () => {
  await closePg();
});

test.describe("auth journey", () => {
  test("register → logout → login lands authenticated", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const user = makeUser();

    // ── Register
    await page.goto("/register");
    // Every form in this file is gated on hydration before the first fill.
    // Without it a keystroke can land in the DOM and never reach React state:
    // the field looks filled, `onChange` never ran, and the submit posts an
    // empty value. That failure surfaces as the WRONG assertion failing —
    // "invalid email format" where the test expected a rejected password —
    // which is what made these three tests fail together whenever the dev
    // server was slow enough. One wait per form: React commits the whole form
    // in one pass, so claiming the first field means it claimed the rest.
    await waitForHydration(page, "#register-username");
    await page.locator("#register-username").fill(user.username);
    await page.locator("#register-email").fill(user.email);
    await page.locator("#register-password").fill(user.password);
    // The confirm field is not optional: RegisterForm runs
    // validateRegisterFields(password, confirmPassword) BEFORE it calls the
    // API, so leaving it blank means the form never submits and the spec
    // sits on /register until it times out. It was added after this spec
    // was written, and nothing in CI ran the spec to notice.
    await page.locator("#register-confirmPassword").fill(user.password);
    await page.locator('button[type="submit"]').click();

    // Successful register replaces the route to `from` (default "/").
    // Wait for the navbar's logged-in chrome to surface so we know the
    // session cookie has been committed and the /api/auth/me probe
    // resolved.
    await expect(page).toHaveURL(/\/$/);
    await expectSignedIn(page, user.username);

    // ── Logout, through the avatar dropdown (see _helpers).
    //
    // The menuitem fires POST /api/auth/logout then router.refresh(); the
    // round-trip (clear cookie + re-run the layout's fetchCurrentUser +
    // reconcile) is what expectSignedOut waits out. Asserting the
    // anonymous CTAs rather than the absence of the avatar avoids racing
    // the re-render.
    await logoutViaNavbar(page);
    await expectSignedOut(page);

    // ── Login with the just-registered credentials
    await page.goto("/login");
    await waitForHydration(page, "#login-email");
    await page.locator("#login-email").fill(user.email);
    await page.locator("#login-password").fill(user.password);
    await page.locator('button[type="submit"]').click();

    // Same authenticated-landing signal as the register branch.
    await expect(page).toHaveURL(/\/$/);
    await expectSignedIn(page, user.username);

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("login with wrong password surfaces inline error", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const user = makeUser();
    // Insert into Postgres, which is what go-api authenticates against.
    // This used to be a Mongo insert, i.e. the account did not exist as
    // far as the API was concerned, and the test passed only because
    // "email not found" and "password mismatch" return the SAME 401
    // INVALID_CREDENTIALS by design (auth/handlers.go:302-307, anti-
    // enumeration). Seeding for real moves the assertion onto the branch
    // it claims to cover — the bcrypt comparison at handlers.go:336.
    await insertPgUser({
      username: user.username,
      email: user.email,
      passwordHash: user.passwordHash,
    });

    await page.goto("/login");
    // Load-bearing here specifically: this test asserts on WHICH error the form
    // shows. An unhydrated fill submits an empty email, the client-side format
    // check rejects it first, and the assertion below fails on a message that
    // has nothing to do with passwords.
    await waitForHydration(page, "#login-email");
    await page.locator("#login-email").fill(user.email);
    await page.locator("#login-password").fill("definitely-not-the-password");
    await page.locator('button[type="submit"]').click();

    // Inline error sits in <p role="alert" aria-live="polite"> inside
    // the form. Backend returns Chinese "邮箱或密码错误" verbatim (see
    // server/controllers/auth.controller.js:90); the dict lookup misses
    // the Chinese key and falls through to the raw server message. We
    // match on the message substring rather than the entire `t.fail`
    // fallback because the form actually shows the backend wording.
    // Scope to form — Next.js 16 adds a global `__next-route-announcer__`
    // div with role="alert" that would otherwise trip strict-mode.
    const alert = page.locator("form").getByRole("alert");
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
    await insertPgUser({
      username: user.username,
      email: user.email,
      passwordHash: user.passwordHash,
    });

    // ── Forgot password — submit the email
    await page.goto("/forgot-password");
    await waitForHydration(page, "#forgot-email");
    await page.locator("#forgot-email").fill(user.email);
    await page.locator('button[type="submit"]').click();

    // Wait for the success copy (form unmounts, sent view replaces it).
    // The footer back-to-login link is inside the form too, so matching on
    // the link alone passes prematurely. Match the success message text.
    await expect(
      page.getByText(/Reset link sent|重置链接已发送/),
    ).toBeVisible();

    // ── Read the token straight out of Postgres.
    //
    // There is no delivery channel to read it from: go-api only emails
    // the link, and the sandbox pins GMAIL_USER empty (docker-compose.ci
    // .yml) so email.NoopSender swallows the send. That is safe here
    // because ForgotPassword persists the token BEFORE it attempts the
    // send and treats a send failure as best-effort (handlers.go:642-665).
    //
    // This used to fall back to a Mongo read when Postgres came back
    // empty, from the window where Express and go-api both served /api.
    // Express is retired; a null now means go-api genuinely failed to
    // write the token, and the assertion below should say so rather than
    // consult a database nothing writes to.
    const reset = await getResetTokenFromPg(user.email);
    expect(reset).not.toBeNull();
    const token = reset!.token;

    // ── Visit /reset-password/<token>, set the new password
    const newPassword = "e2e-test-newpass-456";
    await page.goto(`/reset-password/${token}`);
    await waitForHydration(page, "#reset-password");
    await page.locator("#reset-password").fill(newPassword);
    await page.locator("#reset-confirm").fill(newPassword);
    await page.locator('button[type="submit"]').click();

    // Reset success → router.replace("/login") + router.refresh(). The
    // form unmounts; assert the URL settled on /login.
    await expect(page).toHaveURL(/\/login(\?|$)/);

    // ── Log in with the new password
    //
    // This form arrived by router.replace, not a navigation, so its nodes were
    // client-rendered and carry React's keys from birth — the wait resolves at
    // once. It stays because the wait is also what proves the form is on screen
    // (toHaveURL above only proves the URL changed), and because whether this
    // route is reached softly or hard is not something a reader of the next
    // line should have to work out.
    await waitForHydration(page, "#login-email");
    await page.locator("#login-email").fill(user.email);
    await page.locator("#login-password").fill(newPassword);
    await page.locator('button[type="submit"]').click();

    await expectSignedIn(page, user.username);

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });
});
