// Sandbox — signing other devices out from /settings (登录设备).
//
// Every login has its own session (go-api migration 0052), and the settings
// page lists them with a 退出 on each one but this browser's. These specs
// drive that list across real browser contexts: separate cookie jars, one
// account, each signed in through the login form.
//
// "Signed out" is checked the way it would be felt, and at once: the device
// that was signed out keeps its cookies — an access token that still
// verifies for up to 15 minutes — and must be turned away on its very next
// request anyway, by each of the three layers that see one:
//   - proxy.ts, when it opens a personal page (/settings → /login);
//   - go-api, when a freshly loaded page asks who is signed in;
//   - the Navbar's recheck, when a page left open is focused again.
// The context that did the signing out is put through an access-token
// expiry (its `session` cookie deleted, so proxy.ts refreshes) and must come
// back signed in — ending the others must not end itself.
//
// Lives in specs/sandbox/ (not the top-level specs/): the chromium-prod
// project ignores sandbox/** so these writes never hit the live VPS.

import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { collectConsoleErrors, expectSignedIn, expectSignedOut } from "../_helpers";
import { makeUser, type TestUser } from "../../fixtures/users";
import { closePg, insertPgUser } from "../../fixtures/pg";
import { waitForHydration } from "../../fixtures/hydration";

// A clean cookie jar per context: the shared storageState is another user.
const BLANK = { storageState: { cookies: [], origins: [] } };

// Three logins, a cold /settings compile under `next dev` and two sign-out
// checks do not fit Playwright's 30s default.
const SPEC_TIMEOUT_MS = 90_000;

test.afterAll(async () => {
  await closePg();
});

interface Device {
  context: BrowserContext;
  page: Page;
}

async function seedUser(): Promise<TestUser> {
  const user = makeUser();
  await insertPgUser({
    username: user.username,
    email: user.email,
    passwordHash: user.passwordHash,
  });
  return user;
}

async function loginThroughForm(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await waitForHydration(page, "#login-email");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);
}

/** A fresh browser, signed in as `user` through the form. */
async function signedInDevice(browser: Browser, user: TestUser): Promise<Device> {
  const context = await browser.newContext(BLANK);
  const page = await context.newPage();
  await loginThroughForm(page, user.email, user.password);
  await expectSignedIn(page, user.username);
  return { context, page };
}

/** /settings, hydrated, and its 登录设备 tiles. */
async function openDevices(page: Page): Promise<Locator> {
  await page.goto("/settings");
  // The username field is part of the same client tree as the 退出 buttons:
  // once React owns it, their handlers are attached too.
  await waitForHydration(page, "#set-username");
  return page.getByRole("region", { name: /登录设备|Signed-in devices/ }).getByRole("listitem");
}

/** The access token runs out; the next navigation refreshes, or cannot. */
async function expireAccessToken(device: Device): Promise<void> {
  await device.context.clearCookies({ name: "session" });
  await device.page.goto("/");
}

/** The reader comes back to a page that was left open. */
async function refocus(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

test.describe("settings · signed-in devices", () => {
  test("退出 on another device's tile signs that device out at once, and only that one", async ({ browser }) => {
    test.setTimeout(SPEC_TIMEOUT_MS);
    const user = await seedUser();
    const a = await signedInDevice(browser, user);
    const b = await signedInDevice(browser, user);
    const errors = collectConsoleErrors(a.page);

    const tiles = await openDevices(a.page);
    await expect(tiles).toHaveCount(2);
    const thisDevice = tiles.filter({ hasText: /本机|This device/ });
    await expect(thisDevice).toHaveCount(1);
    // This browser's own tile offers no 退出; the other one does.
    await expect(thisDevice.getByRole("button")).toHaveCount(0);

    const other = tiles.filter({ hasNotText: /本机|This device/ });
    await other.getByRole("button", { name: /^(退出|Sign out) / }).click();
    await expect(tiles).toHaveCount(1);
    await expect(a.page.getByText(/^(已退出|Signed out) /)).toBeVisible();

    // B still holds an access token that verifies. Its next personal page
    // is refused anyway, and the refusal takes its cookies with it.
    await b.page.goto("/settings");
    await expect(b.page).toHaveURL(/\/login\?from=/);
    await b.page.goto("/");
    await expectSignedOut(b.page);

    await expireAccessToken(a);
    await expectSignedIn(a.page, user.username);

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
    await a.context.close();
    await b.context.close();
  });

  test("退出其他设备 → 全部退出 signs every other device out at once", async ({ browser }) => {
    test.setTimeout(SPEC_TIMEOUT_MS);
    const user = await seedUser();
    const a = await signedInDevice(browser, user);
    const b = await signedInDevice(browser, user);
    const c = await signedInDevice(browser, user);
    const errors = collectConsoleErrors(a.page);

    const tiles = await openDevices(a.page);
    await expect(tiles).toHaveCount(3);

    await a.page.getByRole("button", { name: /^(退出其他设备|Sign out other devices)$/ }).click();
    const confirm = a.page.getByRole("dialog", { name: /退出其他 2 台设备|Sign out 2 other devices/ });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: /^(全部退出|Sign out all)$/ }).click();

    await expect(confirm).toBeHidden();
    await expect(tiles).toHaveCount(1);
    await expect(tiles.first()).toContainText(/本机|This device/);
    // Nothing left to end, so nothing offers to.
    await expect(a.page.getByRole("button", { name: /^(退出其他设备|Sign out other devices)$/ })).toHaveCount(0);

    // B was left open on the home page: coming back to it is enough.
    await refocus(b.page);
    await expectSignedOut(b.page);
    // C loads a page with its cookies untouched: go-api turns its token away.
    await c.page.goto("/");
    await expectSignedOut(c.page);

    await expireAccessToken(a);
    await expectSignedIn(a.page, user.username);

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
    await a.context.close();
    await b.context.close();
    await c.context.close();
  });
});
