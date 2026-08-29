import { test, expect, type Page } from "@playwright/test";

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

const notice = (page: Page) => page.locator(".agc-stale-tab-card");

/** Bring the tab back to the foreground, which is what triggers the check. */
async function returnToTab(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

// ─── Why the return above is repeated rather than performed once ──────────
//
// StaleTabNotice registers its visibilitychange listener inside a useEffect:
// the effect opens at StaleTabNotice.tsx:44 and the addEventListener is on
// :74, so the listener exists only once React has flushed that effect. A
// dispatch that lands before then arrives at an empty listener set, and
// visibilitychange is one-shot — nothing re-delivers it. The check never
// runs, the notice never appears, and the test dies on `.agc-stale-tab-card`
// not being found. It was intermittent for a long time and then, under a
// slower dev-server build, stopped being intermittent: the two tests here
// that need the notice failed on six runs out of six.
//
// Waiting for React's `__reactFiber$…` keys, the way search-typing.spec.ts
// does for its input, does NOT close this. Those keys prove React owns the
// node; effects are scheduled after commit and run later still. That wait
// would narrow the window rather than remove it, and a narrower race is the
// same bug with a longer mean time between failures.
//
// So the shape is: dispatch, look for what the listener produces, dispatch
// again if it is not there yet. Re-dispatching is close to free, because the
// component throttles itself to one check per MIN_CHECK_INTERVAL_MS
// (StaleTabNotice.tsx:38, 60 s) — every poke after the first one it hears
// returns before touching the network. The whole loop costs one
// /version.json request no matter how many times it goes round.

// The per-test budget is Playwright's default 30 s: playwright.config.ts sets
// `actionTimeout` and `navigationTimeout` but no top-level `timeout`. Each
// test spends the front of that budget on goto("/faq") plus networkidle,
// which is where the seconds go on a `next dev` route compiling on demand.
// Holding the loop to 8 s means it can only exhaust its own budget if setup
// finished inside 22 s — and a setup slower than that has already lost the
// test on its own terms. Whenever the loop is the thing that failed, in other
// words, the throw below is still reachable, and the reader gets the
// explanation instead of a bare "Test timeout of 30000ms exceeded".
const POKE_BUDGET_MS = 8_000;

// Long enough that a poke the component hears has time to produce its effect
// before the next one goes out; short enough that the budget above buys
// roughly thirty attempts.
const POKE_INTERVAL_MS = 250;

/**
 * Every /version.json exchange the page completes from now on.
 *
 * Both outcomes are recorded because both are evidence: a fulfilled reply and
 * an aborted one each prove the listener ran and called check(). Only the
 * absence of any entry means nobody heard the dispatch.
 */
function recordVersionChecks(page: Page): string[] {
  const seen: string[] = [];
  const isCheck = (url: string) => new URL(url).pathname === "/version.json";
  page.on("requestfinished", (req) => {
    if (isCheck(req.url())) seen.push("answered");
  });
  page.on("requestfailed", (req) => {
    if (isCheck(req.url())) {
      seen.push(`failed (${req.failure()?.errorText ?? "no reason given"})`);
    }
  });
  return seen;
}

/**
 * Return to the tab until `reached` says the listener was there to hear it.
 *
 * The stop condition is an observable the listener itself produces, never a
 * sleep and never a fixed number of tries that happened to be enough on the
 * machine it was written on.
 */
async function returnToTabUntil(
  page: Page,
  what: string,
  reached: (checks: readonly string[]) => boolean | Promise<boolean>,
): Promise<void> {
  const checks = recordVersionChecks(page);
  const deadline = Date.now() + POKE_BUDGET_MS;
  let pokes = 0;

  for (;;) {
    await returnToTab(page);
    pokes += 1;
    if (await reached(checks)) return;

    if (Date.now() >= deadline) {
      throw new Error(
        `Returned to the tab ${pokes} time(s) over ${POKE_BUDGET_MS}ms and ` +
          `${what} never happened.\n\n` +
          (checks.length === 0
            ? `The page never asked for /version.json, so no listener heard any ` +
              `of those dispatches. Two separate things produce that. Either ` +
              `StaleTabNotice's effect had still not run after ${POKE_BUDGET_MS}ms ` +
              `— the race this loop exists to close, which at that length means ` +
              `the page never hydrated at all rather than merely hydrated late. ` +
              `Or the effect DID run and returned early at StaleTabNotice.tsx:48 ` +
              `because NEXT_PUBLIC_BUILD_ID is empty, in which case it never ` +
              `reached the addEventListener on :74 and never will; "serves a ` +
              `build id" at the top of this file fails for the same reason, so ` +
              `read that result before suspecting anything here.`
            : `The page did reach /version.json (${checks.join(", ")}), so the ` +
              `listener was attached and heard us. This is NOT the hydration ` +
              `race. The component ran its check and decided against showing the ` +
              `notice, which is what it does for a non-OK response, an ` +
              `unreadable body, or a buildId equal to its own ` +
              `(StaleTabNotice.tsx:59-63). Start with the page.route intercept in ` +
              `this test: a pattern that stopped matching leaves the real — and ` +
              `therefore matching — build id in the reply.`),
      );
    }

    await page.waitForTimeout(POKE_INTERVAL_MS);
  }
}

/** Poke until the notice is on screen, which is what the listener produces. */
function returnToTabUntilNoticed(page: Page): Promise<void> {
  return returnToTabUntil(page, "the notice appeared", () =>
    notice(page).isVisible(),
  );
}

/**
 * Poke until the component has been to /version.json and back.
 *
 * For the tests that assert the notice is ABSENT, the notice appearing cannot
 * be the stop condition — it is the failure. Those tests used to fire once and
 * assert nothing was there, which is exactly what a dispatch nobody heard also
 * produces: they agreed with the bug and passed while the feature was silently
 * doing nothing at all. The nearest observable that proves the listener ran is
 * the request the listener makes, so they wait for that first and only then
 * ask whether the notice stayed away.
 */
function returnToTabUntilChecked(page: Page): Promise<void> {
  return returnToTabUntil(
    page,
    "the component asked /version.json",
    (checks) => checks.length > 0,
  );
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
    await returnToTabUntilChecked(page);
    // Given a moment to be wrong, now that we know it was asked.
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

    await returnToTabUntilNoticed(page);
    await expect(notice(page)).toBeVisible();
  });

  test("does not fire on a network failure", async ({ page }) => {
    // Offline, or nginx answering 502 while the deploy restarts, is not
    // evidence of anything. Telling a reader to reload mid-deploy is the one
    // moment a reload is most likely to fail.
    await page.goto("/faq");
    await page.waitForLoadState("networkidle");
    await page.route("**/version.json", (route) => route.abort());
    await returnToTabUntilChecked(page);
    await page.waitForTimeout(500);
    await expect(notice(page)).toHaveCount(0);
  });

  test("does not fire when the endpoint answers without an id", async ({ page }) => {
    await page.goto("/faq");
    await page.waitForLoadState("networkidle");
    await page.route("**/version.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await returnToTabUntilChecked(page);
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
    await returnToTabUntilNoticed(page);
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
