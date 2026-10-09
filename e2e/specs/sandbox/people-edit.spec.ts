import { test, expect, type Page } from "@playwright/test";
import { closePg } from "../../fixtures/pg";
import { waitForHydration } from "../../fixtures/hydration";
import {
  STARK,
  createEditUsers,
  deleteEditUsers,
  restoreOverlay,
  takeOverlay,
  type SavedOverlay,
} from "../../fixtures/edits";
import type { TestUser } from "../../fixtures/users";

// Editing a character page and reviewing the edit, against the local stack:
// real go-api, real Postgres, `next dev`. One story in order -- a signed-out
// reader is sent to log in and back, a reader edits Stark's Chinese name and
// photo link and submits, an admin accepts the name and rejects the photo
// with a note, the public page shows the new name and the old photo, and the
// reader is told -- then the phone's edit state and the 404s.
//
// Serial, in one worker: the steps build on each other, and the fixtures
// (two users, Stark's overlay set aside) are made once and undone once.
//
// The photo link is fetched by go-api at submission, so this spec needs the
// network: E2E_EDIT_IMAGE_URL overrides the public https image it uses.
//
// Locators are roles, labels and text, never CSS-module class names, which
// `next dev` and the production build spell differently.

test.use({ storageState: { cookies: [], origins: [] } });
// Each test signs in and opens pages `next dev` may still have to compile:
// more than the default 30 seconds on a cold run.
test.describe.configure({ mode: "serial", timeout: 120_000 });

const PHOTO = process.env.E2E_EDIT_IMAGE_URL ?? "https://raw.githubusercontent.com/github/explore/main/topics/go/go.png";
const NEW_NAME = `史塔克 ${Date.now().toString(36)}`;
const REJECT_NOTE = "这张图不是角色本人";

let reader: TestUser;
let admin: TestUser;
let savedOverlay: SavedOverlay | null = null;

test.beforeAll(async () => {
  savedOverlay = await takeOverlay("character", STARK);
  ({ reader, admin } = await createEditUsers());
});

test.afterAll(async () => {
  await deleteEditUsers([reader, admin].filter(Boolean));
  await restoreOverlay("character", STARK, savedOverlay);
  await closePg();
});

/** Fill the login form and wait to leave it. */
async function signIn(page: Page, user: TestUser) {
  await waitForHydration(page, "#login-email");
  await page.locator("#login-email").fill(user.email);
  await page.locator("#login-password").fill(user.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}

async function login(page: Page, user: TestUser) {
  await page.goto("/login");
  await signIn(page, user);
}

/**
 * The page's heading, once it says `text`. The page is ISR: a render made
 * before this spec set Stark's overlay aside can be served once more while
 * it regenerates (stale-while-revalidate, as in production), so this
 * reloads until the regenerated page arrives.
 */
async function expectHeading(page: Page, path: string, text: string) {
  await expect
    .poll(
      async () => {
        await page.goto(path);
        return (await page.getByRole("heading", { level: 1 }).textContent())?.trim();
      },
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(text);
}

test.describe("desktop", () => {
  test("signed out, 编辑 goes to log in and comes back to the edit state", async ({ page }) => {
    await expectHeading(page, `/character/${STARK}`, "修塔尔克");

    const edit = page.getByRole("link", { name: "编辑" });
    await expect(edit).toHaveAttribute("rel", "nofollow");
    await edit.click();
    await page.waitForURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("from")).toBe(`/character/${STARK}/edit`);

    await signIn(page, reader);
    await page.waitForURL((url) => url.pathname === `/character/${STARK}/edit`);
    await waitForHydration(page, "#edit-name");
    await expect(page.getByRole("textbox", { name: "中文名" })).toHaveValue("修塔尔克");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("a reader changes the Chinese name and the photo, cites a source, and submits", async ({ page }) => {
    await login(page, reader);
    await page.goto(`/character/${STARK}/edit`);
    await waitForHydration(page, "#edit-name");

    // In place: the same header, voices and titles, each value in a field.
    await expect(page.getByRole("textbox", { name: "日文名" })).toHaveValue("シュタルク");
    await expect(page.getByRole("textbox", { name: "配音备注" }).first()).toHaveValue("日配");
    await expect(page.getByRole("combobox", { name: /葬送的芙莉莲/ }).first()).toHaveValue("MAIN");
    const submit = page.getByRole("button", { name: "提交审核" });
    await expect(submit).toBeDisabled();

    await page.getByRole("textbox", { name: "中文名" }).fill(NEW_NAME);
    await page.getByRole("button", { name: "更换图片" }).click();
    await page.getByRole("textbox", { name: "新图片的链接" }).fill(PHOTO);
    // Both bars carry the count; the desktop's is the one shown.
    await expect(page.getByText("已改 2 处").filter({ visible: true })).toHaveCount(1);

    // No source: nothing is sent, and the field says so.
    let posted = false;
    page.on("request", (r) => {
      if (r.url().endsWith("/api/edits") && r.method() === "POST") posted = true;
    });
    await submit.click();
    await expect(page.getByText("请填写来源链接")).toBeVisible();
    expect(posted).toBe(false);

    await page.getByRole("textbox", { name: "来源链接" }).fill("https://frieren-anime.jp/character/");
    await page.getByRole("textbox", { name: "说明" }).fill("官网角色页");
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/edits") && r.request().method() === "POST"),
      submit.click(),
    ]);
    expect(response.status()).toBe(201);
    await page.waitForURL((url) => url.pathname === `/character/${STARK}`);
    // Nothing is public before the review.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("修塔尔克");
  });

  test("the admin accepts the name and rejects the photo, with a note", async ({ page }) => {
    await login(page, admin);
    await page.goto("/admin/edits");
    await page.getByRole("link", { name: new RegExp(reader.username) }).click();
    await waitForHydration(page, 'input[type="checkbox"]');

    // Item by item, the photos side by side.
    await expect(page.getByRole("img", { name: "原来的图片" })).toBeVisible();
    await expect(page.getByRole("img", { name: "新图片" })).toBeVisible();
    await expect(page.getByRole("table", { name: "改动对比" })).toContainText(NEW_NAME);
    await expect(page.getByText("https://frieren-anime.jp/character/")).toBeVisible();

    await page.getByRole("checkbox", { name: "图片" }).uncheck();
    const accept = page.getByRole("button", { name: "采纳勾选的 1 处" });
    await expect(accept).toBeDisabled();
    await page.getByRole("textbox", { name: /不采纳的理由/ }).fill(REJECT_NOTE);
    await expect(accept).toBeEnabled();
    await accept.click();

    await expect(page.getByText("已采纳")).toBeVisible();
    await expect(page.getByText("未采纳")).toBeVisible();
    await expect(page.getByText(REJECT_NOTE)).toBeVisible();
  });

  test("the page shows the accepted name and keeps the old photo", async ({ page }) => {
    await expectHeading(page, `/character/${STARK}`, NEW_NAME);
    const portrait = page.locator("main section").first().locator("img").first();
    await expect(portrait).toHaveAttribute("src", /anilistcdn[^"]*b184313/);
    await expect(page.locator(`img[src*="/api/edit-images/"]`)).toHaveCount(0);
  });

  test("the reader is told, with the note", async ({ page }) => {
    await login(page, reader);
    await page.goto(`/character/${STARK}`);
    const bell = 'button[aria-controls="notification-panel"]';
    await waitForHydration(page, bell);
    await page.locator(bell).click();
    const panel = page.locator("#notification-panel");
    await expect(panel).toContainText("你对「修塔尔克」的修改：采纳 1 处，未采纳 1 处");
    await expect(panel).toContainText(REJECT_NOTE);
    await expect(panel.getByRole("link").first()).toHaveAttribute("href", `/character/${STARK}`);
  });

  test("unknown ids are a real 404 on the edit routes", async ({ page }) => {
    for (const path of ["/character/999999999/edit", "/person/999999999/edit", "/character/abc/edit", "/en/character/0/edit"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
    }
  });
});

test.describe("phone (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("signed out, 编辑 goes to log in and back", async ({ page }) => {
    await page.goto(`/person/133507`);
    await page.getByRole("link", { name: "编辑" }).click();
    await page.waitForURL((url) => url.pathname === "/login");
    await signIn(page, reader);
    await page.waitForURL((url) => url.pathname === "/person/133507/edit");
  });

  test("the edit state has exactly one submit, in the top bar, and fits", async ({ page }) => {
    await login(page, reader);
    await page.goto(`/character/${STARK}/edit`);
    await waitForHydration(page, "#edit-name");

    await expect(page.getByRole("button", { name: /提交/ })).toHaveCount(1);
    const submit = page.getByRole("button", { name: "提交", exact: true });
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(page.getByRole("link", { name: "取消" })).toHaveCount(1);

    await page.getByRole("textbox", { name: "中文名" }).fill("手机改名");
    await expect(page.getByText("已改 1 处").filter({ visible: true })).toHaveCount(1);
    await expect(submit).toBeEnabled();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("the person page's edit state too", async ({ page }) => {
    await login(page, reader);
    await page.goto(`/person/133507/edit`);
    await waitForHydration(page, "#edit-name");
    await expect(page.getByRole("button", { name: /提交/ })).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "出生年" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
