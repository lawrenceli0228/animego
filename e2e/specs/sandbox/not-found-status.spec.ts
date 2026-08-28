import { test, expect, type Page } from "@playwright/test";
import { closePg, deletePgUserByEmail, insertPgUser } from "../../fixtures/pg";

// HTTP status on the routes that can answer "not found".
//
// Before this file the suite asserted a 404 status exactly zero times, which is
// how five route families answered 200 for content that does not exist for as
// long as they did. Next states the rule plainly:
//
//   "Next.js will return a 200 HTTP status code for streamed responses, and
//    404 for non-streamed responses"
//   — node_modules/next/dist/docs/01-app/03-api-reference/
//     03-file-conventions/not-found.md
//
// A loading.tsx above these routes opened a Suspense boundary, so the shell
// flushed, so the response was "streamed", so the status was committed as 200
// before any page could call notFound(). Google calls that a soft 404.
//
// Two layers guard it now, and they catch different things:
//   - next-app/src/app/routeBoundaries.test.ts fails if a loading.tsx is ever
//     placed above a route that can call notFound(). That is the mechanism.
//   - this file checks the number on the wire, which is the thing that
//     actually reaches a crawler, and stays true however the mechanism moves.
//
// Status and SEO tags are read with page.request.get, never page.goto: a
// crawler runs no JavaScript, and the status is a property of the response
// rather than of the rendered DOM. The 404 UI is the one thing that CANNOT be
// checked that way — see "the 404 page a reader actually sees" below.
//
// Not asserted here: the 404's Cache-Control. On a production build
// /anime/{missing} carries `s-maxage=60, stale-while-revalidate=31535940`,
// byte-identical to a real anime page, so an edge-cached 404 outlives the
// moment the id becomes real. That is worth knowing and is unchanged by the
// status fix (production serves the same header today). It is left untested
// because this suite runs against `next dev`, where the header is
// `no-cache, must-revalidate` — an assertion would pass without ever being
// able to fail, which is worse than no assertion. See TODOS.md.
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

/** Seeded by globalSetup as the routing fixture. */
const REAL_ANIME = 21;
/** Nothing will ever have this id. */
const MISSING_ANIME = 999_999_999;
const MISSING_USER = "definitelynosuchuser99";

// A user whose stored username is contact-shaped, so go-api serves it under a
// masked handle (internal/pii.PublicUsername → "user-" + md5[:10]) and the
// profile route has an alias to redirect off. Contact-shaped is what the PII
// incident was about: these are the addresses of real registrants.
const ALIAS_EMAIL = "e2e-alias-probe@animego.test";

test.beforeAll(async () => {
  await insertPgUser({
    username: ALIAS_EMAIL,
    email: ALIAS_EMAIL,
    // Never authenticated as; the profile is public and this file only reads it.
    passwordHash: "e2e-not-a-real-hash",
  });
});

test.afterAll(async () => {
  await deletePgUserByEmail(ALIAS_EMAIL);
  await closePg();
});

/** Status of the served response, following no redirects. */
async function statusOf(page: Page, path: string): Promise<number> {
  const res = await page.request.get(path, { maxRedirects: 0 });
  return res.status();
}

test.describe("a resource that does not exist answers 404", () => {
  // Every page route that calls notFound(). The issue named two; the other
  // three turned up while checking, and they are the ones with guessable URLs.
  const MISSING = [
    `/anime/${MISSING_ANIME}`,
    "/seasonal/notaseason/2026",
    `/u/${MISSING_USER}`,
    `/u/${MISSING_USER}/followers`,
    `/u/${MISSING_USER}/following`,
  ];

  for (const path of MISSING) {
    test(`${path}`, async ({ page }) => {
      expect(await statusOf(page, path), `${path} must not be a soft 404`).toBe(404);
    });
  }

  test("an id that is not a usable number is a 404, not a 500", async ({ page }) => {
    // These bail in the route's own guard, before any data fetch, so they
    // exercise the guard rather than the API. /anime/0 is the path the CI
    // warm-up step uses for exactly that reason.
    //
    // Deliberately NOT including a decimal like /anime/1.5 here: that one is a
    // 404 for an unrelated reason (see the dot-suffix defect at the bottom of
    // this file), so it would pass whether the guard worked or not.
    for (const path of ["/anime/0", "/anime/abc", "/anime/-1"]) {
      expect(await statusOf(page, path), path).toBe(404);
    }
  });
});

test.describe("every locale form of the same missing anime", () => {
  // The Cloudflare cache rule matches the bare /anime/ prefix only, so the
  // prefixed forms reach the edge differently, and the bare form is the one
  // that needs proxy.ts to rewrite it under a locale segment at all. Three
  // different paths through the routing layer; one required answer.
  for (const prefix of ["", "/en", "/zh-Hant"]) {
    test(`${prefix || "(bare)"} answers 404`, async ({ page }) => {
      expect(await statusOf(page, `${prefix}/anime/${MISSING_ANIME}`)).toBe(404);
    });
  }

  test("a real anime still answers 200 in every locale form", async ({ page }) => {
    // The other direction, and the one that would actually cost traffic: a
    // change that 404s the whole catalogue passes every assertion above.
    for (const prefix of ["", "/en", "/zh-Hant"]) {
      const path = `${prefix}/anime/${REAL_ANIME}`;
      expect(await statusOf(page, path), path).toBe(200);
    }
  });
});

test.describe("what a crawler is handed", () => {
  test("noindex, once, and no canonical", async ({ page }) => {
    // A 404 offering a canonical is inviting consolidation onto a page that
    // does not exist. And the tag must not appear twice saying different
    // things — the root layout's blanket `index, follow` used to inherit into
    // this page and argue with its own noindex, which robots-posture.spec.ts
    // covers across the whole site.
    //
    // Next injects a noindex of its own on any 404 response (same docs file as
    // the header of this test), so "at least one, none of them permissive" is
    // the honest assertion here rather than an exact count.
    const res = await page.request.get(`/anime/${MISSING_ANIME}`, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    const html = await res.text();

    const robots = [...html.matchAll(/<meta[^>]+name="robots"[^>]*>/gi)].map(
      (m) => /content="([^"]*)"/i.exec(m[0])?.[1]?.toLowerCase() ?? "",
    );
    expect(robots.length).toBeGreaterThan(0);
    for (const tag of robots) expect(tag).toContain("noindex");
    expect(html).not.toMatch(/<link[^>]+rel="canonical"/i);
  });

  test("the <title> follows the URL's language", async ({ page }) => {
    // The head is built by generateMetadata, which does get params — so unlike
    // the body it is locale-correct in the first HTML chunk. Asserted as "these
    // two differ, and each is in its own script" rather than by pinning the
    // marketing copy, which changes without this behaviour changing.
    const titleOf = async (path: string) => {
      const html = await (await page.request.get(path, { maxRedirects: 0 })).text();
      return /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
    };
    const zh = await titleOf(`/anime/${MISSING_ANIME}`);
    const en = await titleOf(`/en/anime/${MISSING_ANIME}`);

    expect(zh, "the bare 404 should carry a title").toBeTruthy();
    expect(en).not.toBe(zh);
    expect(zh, "the zh title should contain Chinese").toMatch(/[一-鿿]/);
    expect(en, "the en title should not").not.toMatch(/[一-鿿]/);
  });
});

test.describe("the 404 page a reader actually sees", () => {
  // This group uses a browser on purpose, and it is the one group that has to.
  //
  // Measured on a production build: a 404 response's <body> is an empty
  // Suspense placeholder and the UI arrives in the RSC payload. Reading the
  // served HTML would therefore find nothing and prove nothing — the page is
  // only observable once React has rendered it. That is fine for SEO (the
  // status settles indexing, and the body of a 404 is not indexed anyway) but
  // it means a blank 404 page would be invisible to every other check here.
  // The `lang` values are HTML_LANG from next-app/src/lib/i18n/lang.ts, written
  // out rather than imported: that map is deliberately asymmetric with
  // OG_LOCALE (html gets `zh-Hant`, og:locale gets `zh_TW`, because Facebook's
  // vocabulary has no script variants), and a change to it should fail here and
  // be looked at rather than be followed silently.
  for (const [path, lang, heading] of [
    [`/anime/${MISSING_ANIME}`, "zh-CN", /找不到这一页/],
    [`/en/anime/${MISSING_ANIME}`, "en", /Page not found/],
    [`/zh-Hant/anime/${MISSING_ANIME}`, "zh-Hant", /找不到這一頁/],
  ] as const) {
    test(`${path} renders the 404 UI in ${lang}`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(404);

      // Not "some element exists" — the actual designed page, in the language
      // the URL asked for. NotFoundBody is a client component precisely so it
      // can answer this question without not-found.tsx having params.
      await expect(page.locator("h1")).toHaveText(heading);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
    });
  }
});

test.describe("REGRESSION — a redirect can set a status again", () => {
  // Same mechanism, different symbol. permanentRedirect() froze on the flush
  // too, so an aliased profile answered 200 and fell back to a client-side
  // navigation; the route carried a noindex for that reason alone.
  test("an aliased profile handle redirects at the HTTP level", async ({ page }) => {
    const res = await page.request.get(`/en/u/${encodeURIComponent(ALIAS_EMAIL)}`, {
      maxRedirects: 0,
    });

    expect([301, 302, 307, 308], `expected a redirect, got ${res.status()}`).toContain(
      res.status(),
    );
    const location = res.headers()["location"] ?? "";
    expect(location, "a redirect must say where to").toBeTruthy();
    // The masked handle, whatever md5 makes it — never the address asked for.
    expect(location, "the address must not survive into the redirect target").not.toContain("@");
    expect(location).toMatch(/^\/u\/user-[0-9a-f]{10}$/);
  });

  test("KNOWN DEFECT: the redirect drops the locale prefix", async ({ page }) => {
    // /en/u/{alias} redirects to a BARE /u/..., losing the locale. Pre-existing
    // in the /u/ redirect call sites and not introduced by the status fix;
    // recorded here so it is not rediscovered as a mystery. When it is fixed
    // this test fails, and the fix is to assert the prefix survives.
    const res = await page.request.get(`/en/u/${encodeURIComponent(ALIAS_EMAIL)}`, {
      maxRedirects: 0,
    });
    expect(res.headers()["location"] ?? "").not.toContain("/en/");
  });

  test("KNOWN DEFECT: a handle ending in a dot-suffix is unreachable bare", async ({
    page,
  }) => {
    // proxy.ts:94 treats any path ending in `.<alnum>` as a non-page, so it
    // skips the locale rewrite that a bare URL needs to match /[lang]/...; the
    // request then matches no route and gets Next's built-in 404 instead of
    // the alias redirect. The guard exists to keep /sitemap.xml and /robots.txt
    // from being rewritten under a locale, which is load-bearing — narrowing it
    // to a real extension list is its own change, so this records the cost.
    //
    // It bites any email-shaped alias, since every common mail domain ends in
    // a dot-suffix — but only on the bare form, and only on the alias rather
    // than the canonical /u/user-xxxx that everything actually links to.
    //
    // Status-wise this is harmless — 404 is a defensible answer for a URL that
    // should not be public. It is the redirect that is lost.
    expect(await statusOf(page, `/u/${encodeURIComponent(ALIAS_EMAIL)}`)).toBe(404);
    // The canonical handle has no dot and is reachable bare, which is what
    // makes the line above a routing defect rather than a broken fixture.
    const res = await page.request.get(`/en/u/${encodeURIComponent(ALIAS_EMAIL)}`, {
      maxRedirects: 0,
    });
    const canonical = res.headers()["location"] ?? "";
    expect(await statusOf(page, canonical)).toBe(200);
  });
});
