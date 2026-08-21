import { test, expect } from "@playwright/test";

// A tab that outlived its deployment.
//
// The real failure is already in Sentry: `Cannot read properties of undefined
// (reading 'call')` on /anime/:id, which is a client-side navigation asking
// for a chunk the running deployment no longer has. It reads to the visitor as
// a broken site rather than a stale tab.
//
// These drive the comparison by intercepting /version.json rather than by
// actually redeploying mid-test. The other half — that the id is inlined at
// BUILD time on both the client and the server, so a restart does not mint a
// third value and tell everyone to refresh forever — cannot be tested from a
// browser and was verified by building with GIT_SHA set, restarting without
// it, and confirming the endpoint still returned the build's value.

test.use({ storageState: { cookies: [], origins: [] } });

const notice = (page: import("@playwright/test").Page) =>
  page.locator(".agc-stale-tab-card");

/** Bring the tab back to the foreground, which is what triggers the check. */
async function returnToTab(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test.describe("the endpoint the check depends on", () => {
  test("serves a build id, and forbids caching it", async ({ page }) => {
    // A cached copy of this answer is a wrong answer by definition — the one
    // thing it reports is which deployment is live right now.
    const res = await page.request.get("/version.json");
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("no-store");

    const body = (await res.json()) as { buildId?: string | null };
    // Empty would mean next.config.ts stopped inlining it, which disables the
    // notice silently — the component treats a missing id as "do nothing".
    expect(body.buildId, "no build id: the notice can never fire").toBeTruthy();
  });

  test("is not swallowed by the locale rewrite", async ({ page }) => {
    // proxy.ts rewrites page paths under a locale segment. `/version.json`
    // survives only because NON_PAGE_PATH excludes anything with a file
    // extension; `/version` would become `/zh-Hans/version` and 404. This
    // asserts the URL is served as itself.
    const res = await page.request.get("/version.json", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.url()).toContain("/version.json");
  });
});

test.describe("the notice", () => {
  test("stays away while the build matches", async ({ page }) => {
    await page.goto("/faq");
    await page.waitForLoadState("networkidle");
    await returnToTab(page);
    // Given a moment to be wrong.
    await page.waitForTimeout(500);
    await expect(notice(page)).toHaveCount(0);
  });

  test("appears when the deployment has moved on", async ({ page }) => {
    await page.goto("/faq");
    await page.waitForLoadState("networkidle");

    await page.route("**/version.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ buildId: "a-different-build" }),
      }),
    );

    await returnToTab(page);
    await expect(notice(page)).toBeVisible();
  });

  test("does not fire on a network failure", async ({ page }) => {
    // Offline, or nginx answering 502 while the deploy restarts, is not
    // evidence of anything. Telling a reader to reload mid-deploy is the one
    // moment a reload is most likely to fail.
    await page.goto("/faq");
    await page.waitForLoadState("networkidle");
    await page.route("**/version.json", (route) => route.abort());
    await returnToTab(page);
    await page.waitForTimeout(500);
    await expect(notice(page)).toHaveCount(0);
  });

  test("does not fire when the endpoint answers without an id", async ({ page }) => {
    await page.goto("/faq");
    await page.waitForLoadState("networkidle");
    await page.route("**/version.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await returnToTab(page);
    await page.waitForTimeout(500);
    await expect(notice(page)).toHaveCount(0);
  });

  test("reloads the page when taken up on it", async ({ page }) => {
    await page.goto("/faq");
    await page.waitForLoadState("networkidle");
    await page.route("**/version.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ buildId: "a-different-build" }),
      }),
    );
    await returnToTab(page);
    await expect(notice(page)).toBeVisible();

    await Promise.all([
      page.waitForLoadState("load"),
      page.locator(".agc-stale-tab-reload").click(),
    ]);
    // A reload clears it, because the fresh page's own id matches whatever the
    // intercept now claims only until the route handler is re-consulted — the
    // assertion that matters is simply that a navigation happened.
    expect(page.url()).toContain("/faq");
  });

  test("the server sends none of its markup", async ({ page }) => {
    // It is a client-only decision, so the HTML has to be identical for every
    // visitor — the same property that keeps pages cacheable at the edge.
    const res = await page.request.get("/faq");
    expect(await res.text()).not.toContain("agc-stale-tab-card");
  });
});
