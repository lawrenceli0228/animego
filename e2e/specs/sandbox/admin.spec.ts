// P10 sandbox — /admin access control, and the user list.
//
// The flows:
//   1. logged-in non-admin → /admin returns 403 (proxy.ts:69)
//   2. logged-in admin     → /admin renders the dashboard
//   3. logged-in admin     → the user list: segment chips with their sizes,
//      the activity panel's depth hand-off, the row menu, search, and the
//      detail drawer opening and closing with Escape
//   4. logged-in admin     → the drawer after an inline confirmation is
//      cancelled: focus stays in it, Escape closes it, focus goes back
//   5. logged-in admin     → a chip and straight back, before the first
//      request answers, leaves the table not loading
//   6. logged-in admin on a phone → the page is no wider than the screen
//
// The globalSetup storageState user has role=null (plain user), so the
// non-admin block uses it via the project-level storageState. The admin
// blocks opt out of that state and log in fresh with a per-run admin
// account they insert themselves.

import { test, expect, type Page } from "@playwright/test";
import { collectConsoleErrors, expectSignedIn } from "../_helpers";
import { closePg, insertPgUser } from "../../fixtures/pg";
import { makeUser, type TestUser } from "../../fixtures/users";
import { waitForHydration } from "../../fixtures/hydration";

// Cleanup is centralized in globalSetup so it runs once before any
// worker starts. Doing it per-spec races with parallel test files.
test.afterAll(async () => {
  await closePg();
});

/**
 * A fresh admin, signed in through the real form.
 *
 * The Postgres row is the whole account. The old two-step — mint the record
 * via a Mongo `insertAdmin`, then re-insert it into Postgres "so Go API login
 * can authenticate the admin" — kept a Mongo write whose only surviving
 * purpose was to hand back a user object. makeUser does that without a
 * database.
 */
async function signInAsNewAdmin(page: Page): Promise<TestUser> {
  const user = makeUser("admin");
  await insertPgUser({
    username: user.username,
    email: user.email,
    passwordHash: user.passwordHash,
    role: "admin",
  });

  await page.goto("/login");
  // See fixtures/hydration.ts. An unhydrated fill posts an empty form, the
  // login never happens, and the test then fails on the /admin assertion —
  // reading exactly like an access-control regression.
  await waitForHydration(page, "#login-email");
  await page.locator("#login-email").fill(user.email);
  await page.locator("#login-password").fill(user.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login")),
    page.locator('button[type="submit"]').click(),
  ]);
  return user;
}

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
    await signInAsNewAdmin(page);

    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { level: 1, name: /管理后台/ }),
    ).toBeVisible();
    await expect(page.locator("#users")).toBeVisible();

    // The admin bar sticks under the site header and, while the site header
    // is tucked away, moves up into its place — no strip of page scrolling
    // past above it. Measured as boxes, not read off a style.
    const siteHeader = page.locator("body > header");
    const adminBar = page.locator('header:has(nav[aria-label="Admin navigation"])');
    const barTop = async () => Math.round((await adminBar.boundingBox())?.y ?? -1);
    await waitForHydration(page, "body > header nav");
    await page.mouse.move(700, 600);
    await page.mouse.wheel(0, 600);
    await expect(siteHeader).toHaveAttribute("data-hidden", "true");
    await expect.poll(barTop).toBe(0);
    await page.mouse.wheel(0, -200);
    await expect(siteHeader).toHaveAttribute("data-hidden", "false");
    await expect.poll(barTop).toBe(64);

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });
});

test.describe("admin user list", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Two logins' worth of `next dev` compiles, the debounced search and the
  // drawer's own chunk do not fit Playwright's 30s default.
  const SPEC_TIMEOUT_MS = 120_000;
  // The drawer is loaded on first open (next/dynamic), which under
  // `next dev` is a compile, then it fetches the account.
  const DRAWER_MS = 20_000;

  test("chips carry their sizes, search finds one account, its drawer opens and Escape closes it", async ({
    page,
  }) => {
    test.setTimeout(SPEC_TIMEOUT_MS);
    const errors = collectConsoleErrors(page);

    // The account to look for: never signed in, so nothing about it depends
    // on what other specs in this run have done.
    const target = makeUser();
    await insertPgUser({
      username: target.username,
      email: target.email,
      passwordHash: target.passwordHash,
    });
    await signInAsNewAdmin(page);
    await page.goto("/admin");

    const users = page.locator("#users");
    // The search box is part of the same client tree as the chips, rows and
    // menus: once React owns it, their handlers are attached too.
    await waitForHydration(page, '#users input[type="search"]');

    // ── Segment chips: six, each with a count, 全部 selected ───────────────
    // Counts are over every account in this run's database, which parallel
    // specs keep adding to — so they are checked for shape, not value.
    const chips = users.getByRole("group", { name: "按人群筛选" }).getByRole("button");
    await expect(chips).toHaveCount(6);
    const segments: Array<[string, string]> = [
      ["all", "全部"],
      ["active7", "近 7 天来过"],
      ["returned", "回访过"],
      ["neverReturned", "没有回访记录"],
      ["subscribed", "有追番"],
      ["admin", "管理员"],
    ];
    for (const [segment, label] of segments) {
      await expect(users.locator(`[data-segment="${segment}"]`)).toHaveText(new RegExp(`^${label}\\s*\\d[\\d,]*$`));
    }
    await expect(users.locator('[data-segment="all"]')).toHaveAttribute("aria-pressed", "true");

    // ── The activity panel's depth rows hand over through a window event ──
    // Dispatched here directly: this pins the list's side of the contract.
    // The listener is attached in an effect, which runs after hydration, so
    // the event is re-sent until the chip appears (see fixtures/hydration.ts).
    const depthChip = users.locator("[data-depth-chip]");
    await expect(async () => {
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("admin:users-depth", { detail: { days: 30, min: 3, max: 6 } }),
        ),
      );
      await expect(depthChip).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(depthChip).toHaveText(/^近 30 天来过 3–6 天\s*×$/);
    await depthChip.click();
    await expect(depthChip).toHaveCount(0);

    // ── Search narrows the table to the one account ────────────────────────
    // The username is unique to this run (a uuid prefix), and the account's
    // email starts with it, so exactly one row matches.
    await users.getByRole("searchbox", { name: "搜索用户名或邮箱" }).fill(target.username);
    const rows = users.locator("tbody tr[data-user-row]");
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
    const row = rows.first();
    await expect(row).toContainText(target.email);

    // ── The row menu: portalled, five actions, Escape gives focus back ────
    const dots = row.getByRole("button", { name: `${target.username} 的更多操作` });
    await dots.click();
    const menu = page.getByRole("menu", { name: `${target.username} 的更多操作` });
    await expect(menu.getByRole("menuitem")).toHaveCount(5);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(dots).toBeFocused();

    // ── The drawer: opens on the username, closes on Escape ───────────────
    const opener = row.getByRole("button", { name: target.username, exact: true });
    await opener.click();
    const drawer = page.getByRole("dialog", { name: target.username });
    await expect(drawer).toBeVisible({ timeout: DRAWER_MS });
    await expect(drawer).toContainText(target.email);
    await expect(drawer).toContainText("普通用户");
    // The detail endpoint answered: the tiles and the calendar are drawn.
    await expect(drawer.locator('[data-tile="activeDays"]')).toBeVisible({ timeout: DRAWER_MS });
    await expect(drawer.locator('[data-block="calendar"]')).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    // Focus goes back to what opened it.
    await expect(opener).toBeFocused();

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("after 取消 in the drawer's confirmation, Escape still closes it and focus returns to the opener", async ({
    page,
  }) => {
    test.setTimeout(SPEC_TIMEOUT_MS);
    const errors = collectConsoleErrors(page);

    // An account of this run's own, found by searching for its unique name.
    const target = makeUser();
    await insertPgUser({
      username: target.username,
      email: target.email,
      passwordHash: target.passwordHash,
    });
    await signInAsNewAdmin(page);
    await page.goto("/admin");

    const users = page.locator("#users");
    await waitForHydration(page, '#users input[type="search"]');
    await users.getByRole("searchbox", { name: "搜索用户名或邮箱" }).fill(target.username);
    const rows = users.locator("tbody tr[data-user-row]");
    await expect(rows).toHaveCount(1, { timeout: 15_000 });

    const opener = rows.first().getByRole("button", { name: target.username, exact: true });
    await opener.click();
    const drawer = page.getByRole("dialog", { name: target.username });
    await expect(drawer).toBeVisible({ timeout: DRAWER_MS });
    await expect(drawer.locator('[data-tile="activeDays"]')).toBeVisible({ timeout: DRAWER_MS });

    // The confirmation opens with focus on 取消; pressing it closes the
    // confirmation, and focus must stay in the drawer, on what opened it.
    const revokeAll = drawer.getByRole("button", { name: "退出全部设备", exact: true });
    await revokeAll.click();
    const confirm = drawer.getByRole("alertdialog", { name: "确认退出全部设备" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(revokeAll).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(opener).toBeFocused();

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("a chip and straight back, before the first answer, leaves nothing loading", async ({ page }) => {
    test.setTimeout(SPEC_TIMEOUT_MS);
    const errors = collectConsoleErrors(page);
    await signInAsNewAdmin(page);

    // Hold the 管理员 request open until the switch back has happened, so the
    // test cannot pass by the answer simply arriving first. The page aborts
    // it on the switch back; continuing an aborted request can throw.
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = () => {};
    const handled = new Promise<void>((resolve) => {
      settled = resolve;
    });
    await page.route(/\/api\/admin\/users\?(.*&)?segment=admin(&|$)/, async (route) => {
      await released;
      await route.continue().catch(() => {});
      settled();
    });

    await page.goto("/admin");
    const users = page.locator("#users");
    await waitForHydration(page, '#users input[type="search"]');

    const asked = page.waitForRequest(/\/api\/admin\/users\?(.*&)?segment=admin(&|$)/);
    await users.locator('[data-segment="admin"]').click();
    await asked;
    await users.locator('[data-segment="all"]').click();

    await expect(users.locator('[data-segment="all"]')).toHaveAttribute("aria-pressed", "true");
    await expect(users.locator('[aria-busy="true"]')).toHaveCount(0);

    // And it stays that way once the held request is let go.
    release();
    await handled;
    await expect(users.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(users.locator('[data-segment="all"]')).toHaveAttribute("aria-pressed", "true");
    await expect(users.locator("tbody tr[data-user-row]").first()).toBeVisible();

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });
});

test.describe("admin on a phone", () => {
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });

  test("the page is no wider than the screen", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    await signInAsNewAdmin(page);

    await page.goto("/admin");
    await waitForHydration(page, '#users input[type="search"]');
    await expect(page.locator("#users table")).toBeVisible();

    // The document's scroll width, not a scroll attempt: html clips sideways
    // overflow, so a user cannot pan, but a positioned element escaping a
    // scroll container (the table's visually hidden header text once did)
    // still widens the page.
    const width = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      screen: window.innerWidth,
    }));
    expect(width.page).toBeLessThanOrEqual(width.screen);

    expect(errors, `Unexpected console errors: ${errors.join("\n")}`).toEqual([]);
  });
});
