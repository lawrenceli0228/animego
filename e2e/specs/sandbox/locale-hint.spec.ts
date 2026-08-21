import { test, expect, type Browser, type Page } from "@playwright/test";

// The one-time offer to read the page in the browser's language.
//
// Everything here needs its own browser context, because the input under test
// is `navigator.languages` and Playwright can only set that per context. That
// is also why these guards live in a file of their own rather than joining
// locale-routing.spec.ts, which shares one page across its tests.
//
// Two failure modes are worth the cost of these tests. The first is the hint
// pointing the wrong way — offering Traditional to someone already reading it,
// or offering anything to a reader whose language we do not publish. The
// second is quieter and worse: the hint reappearing after a visitor has
// answered. It is shown unprompted, so a visitor who dismisses it and sees it
// again has no way to make it stop.

/** A fresh context with a given Accept-Language, and no stored decision. */
async function visit(browser: Browser, locale: string, path: string) {
  const context = await browser.newContext({
    locale,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  return { context, page, errors };
}

const card = (page: Page) => page.locator(".agc-locale-hint-card");

test.describe("who gets offered what", () => {
  // Both halves matter. A hint that never fires is invisible; a hint that
  // fires for everyone is a popup on every first page view of the site.
  const cases: Array<{ locale: string; path: string; offer: string | null; why: string }> = [
    { locale: "zh-TW", path: "/faq", offer: "以繁體中文瀏覽？", why: "Taiwan reads Traditional" },
    { locale: "zh-HK", path: "/faq", offer: "以繁體中文瀏覽？", why: "so does Hong Kong" },
    { locale: "en-US", path: "/faq", offer: "View this page in English?", why: "English exists too" },
    { locale: "zh-CN", path: "/zh-Hant/faq", offer: "用简体中文浏览？", why: "and it works in reverse" },
    { locale: "zh-CN", path: "/faq", offer: null, why: "already on their language" },
    { locale: "en-US", path: "/en/faq", offer: null, why: "same, on the English tree" },
    { locale: "ja-JP", path: "/faq", offer: null, why: "we do not publish Japanese" },
  ];

  for (const { locale, path, offer, why } of cases) {
    test(`${locale} on ${path} — ${why}`, async ({ browser }) => {
      const { context, page, errors } = await visit(browser, locale, path);
      if (offer === null) {
        await expect(card(page)).toHaveCount(0);
      } else {
        await expect(card(page)).toBeVisible();
        // The copy is in the language being offered, not the one being read.
        // A reader on the Simplified tree has to see Traditional characters to
        // know what is on the other side of the button.
        await expect(page.locator(".agc-locale-hint-text")).toHaveText(offer);
      }
      expect(errors, "the hint must not throw during hydration").toEqual([]);
      await context.close();
    });
  }
});

test.describe("it asks once", () => {
  test("dismissing it keeps it away, on reload and on other routes", async ({ browser }) => {
    const { context, page } = await visit(browser, "zh-TW", "/faq");
    await expect(card(page)).toBeVisible();

    await page.locator(".agc-locale-hint-close").click();
    await expect(card(page)).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(card(page), "it came back after a reload").toHaveCount(0);

    await page.goto("/calendar");
    await page.waitForLoadState("networkidle");
    await expect(card(page), "it came back on another route").toHaveCount(0);

    await context.close();
  });

  test("accepting switches locale and does not ask again", async ({ browser }) => {
    const { context, page } = await visit(browser, "zh-TW", "/faq");

    await page.locator(".agc-locale-hint-accept").click();
    await page.waitForURL(/\/zh-Hant\//);
    expect(new URL(page.url()).pathname).toBe("/zh-Hant/faq");
    expect(await page.locator("html").getAttribute("lang")).toBe("zh-Hant");

    await page.waitForLoadState("networkidle");
    await expect(card(page)).toHaveCount(0);

    await context.close();
  });

  test("accepting keeps the page and its query string", async ({ browser }) => {
    // A switcher that drops the reader on the home page is a worse
    // experience and tells Google the alternate is not really an alternate.
    const { context, page } = await visit(browser, "zh-TW", "/search?q=frieren");

    await page.locator(".agc-locale-hint-accept").click();
    await page.waitForURL(/\/zh-Hant\/search/);
    expect(page.url()).toContain("q=frieren");

    await context.close();
  });
});

test.describe("it stays out of the way", () => {
  test("the server sends no hint markup at all", async ({ browser }) => {
    // The decision is client-side precisely so the HTML is identical for
    // every visitor — that is what keeps pages cacheable at the edge and
    // keeps a crawler from being served a variant. If this fails, the hint
    // has started varying the response.
    // The empty storageState is not optional: without it the context inherits
    // the project's ./.auth/user.json, which only exists after globalSetup has
    // run. A signed-in session would also change what the proxy does.
    const context = await browser.newContext({
      locale: "zh-TW",
      storageState: { cookies: [], origins: [] },
    });
    const res = await context.request.get("/faq");
    const body = await res.text();
    expect(body).not.toContain("agc-locale-hint-card");
    expect(body).not.toContain("以繁體中文瀏覽");
    await context.close();
  });

  test("it does not push the page down", async ({ browser }) => {
    // The navbar is position: sticky, so a hint inserted above it in flow
    // would move the whole document after hydration — a layout shift on the
    // one view Core Web Vitals measures. Fixed positioning is what prevents
    // that, and this asserts the navbar has not moved.
    const { context, page } = await visit(browser, "zh-TW", "/faq");
    await expect(card(page)).toBeVisible();

    const nav = await page.locator("nav").first().boundingBox();
    await page.locator(".agc-locale-hint-close").click();
    await expect(card(page)).toHaveCount(0);
    const navAfter = await page.locator("nav").first().boundingBox();

    expect(nav?.y).toBe(navAfter?.y);
    await context.close();
  });

  test("it does not steal focus", async ({ browser }) => {
    // It appears without being asked for. Taking the caret from someone
    // mid-sentence to offer them a translation is worse than not offering.
    const { context, page } = await visit(browser, "zh-TW", "/faq");
    await expect(card(page)).toBeVisible();
    const focused = await page.evaluate(() => document.activeElement?.className ?? "");
    expect(focused).not.toContain("agc-locale-hint");
    await context.close();
  });
});
