import { test, expect } from "@playwright/test";

// What each route tells a crawler about itself.
//
// This is checked in a browser rather than by unit-testing metadata objects
// because the thing that went wrong was not any single page's declaration —
// every one of them was individually correct. It was that the root layout
// declared `index, follow` for the whole site, which INHERITED into the
// not-found page, and that page adds its own `noindex`. Every 404 shipped
// two contradictory robots tags:
//
//     <meta name="robots" content="index, follow">
//     <meta name="robots" content="noindex">
//
// Google resolves that by taking the most restrictive, so nothing was
// actually being indexed that should not have been. But the guarantee rested
// on a tie-break rule rather than on the page saying one thing.
//
// When this file was written `noindex` was the ONLY signal on these routes,
// because a loading.tsx made them stream and a streamed response cannot set a
// 404 status. That boundary is gone and they answer a real 404 now, so the tag
// is corroboration — but a page saying two contradictory things is still the
// defect this file exists to catch.
//
// Only the rendered HTML shows an inherited tag colliding with a declared
// one, which is why this is an e2e and not a unit test.

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

/** Seeded by globalSetup as the routing fixture. */
const REAL_ANIME = 21;
/** Nothing will ever have this id. */
const MISSING_ANIME = 999_999_999;

/**
 * Every robots directive in the SERVER-RENDERED html.
 *
 * `page.request.get` runs no JavaScript, so this is the document a crawler is
 * handed — the same reason episode-display.spec.ts reads it this way. Reading
 * the live DOM instead measures the wrong thing: a crawler never hydrates. The
 * first version of this file did read the DOM and CI caught it
 * (`["noindex","noindex"]`, green on retry) — at the time these routes streamed
 * and the tag could appear twice mid-hydration. They no longer stream, so that
 * race is gone, but the reason for reading the SERVED document rather than the
 * rendered one is unchanged.
 */
async function robotsTags(page: import("@playwright/test").Page, path: string) {
  const res = await page.request.get(path);
  const html = await res.text();
  return {
    status: res.status(),
    tags: [...html.matchAll(/<meta[^>]+name="robots"[^>]*>/gi)]
      .map((m) => /content="([^"]*)"/i.exec(m[0])?.[1] ?? "")
      .map((c) => c.toLowerCase().trim())
      .filter(Boolean),
  };
}

/** Whether a set of directives disagrees with itself about indexability. */
function contradicts(tags: string[]): boolean {
  const saysNo = tags.some((t) => t.includes("noindex"));
  // "index" alone, not the "index" inside "noindex".
  const saysYes = tags.some((t) => /(^|[\s,])index\b/.test(t));
  return saysNo && saysYes;
}

test.describe("no page contradicts itself", () => {
  // The actual regression guard. A page may say nothing, or say one thing —
  // never two things that disagree.
  const ROUTES = [
    "/",
    `/anime/${REAL_ANIME}`,
    `/anime/${MISSING_ANIME}`,
    "/calendar",
    "/faq",
    "/terms",
    "/smoke",
    "/login",
    "/register",
    "/en",
    `/zh-Hant/anime/${REAL_ANIME}`,
  ];

  for (const path of ROUTES) {
    test(`${path} does not disagree with itself about indexing`, async ({ page }) => {
      // Not "emits at most one tag" — that was the first version of this
      // assertion and it was testing the wrong property. Two identical
      // `noindex` tags are redundant, not contradictory; what breaks a page
      // is `index` and `noindex` in the same document, which is what the
      // root layout's blanket directive produced on every 404.
      const { tags } = await robotsTags(page, path);
      expect(contradicts(tags), `robots tags on ${path}: ${JSON.stringify(tags)}`).toBe(false);
    });
  }
});

test.describe("indexable surfaces", () => {
  // These are the pages the site exists to have found. "No robots tag" is the
  // correct state for them — it means indexable, and it is what a page that
  // never had to think about the question should look like.
  for (const path of ["/", `/anime/${REAL_ANIME}`, "/calendar", "/faq"]) {
    test(`${path} does not tell a crawler to stay away`, async ({ page }) => {
      const { status, tags } = await robotsTags(page, path);
      expect(status).toBe(200);
      for (const tag of tags) expect(tag).not.toContain("noindex");
    });
  }
});

test.describe("off-index surfaces", () => {
  // Each of these declares its own noindex. The point of asserting them here
  // is that removing the layout's blanket directive must not have quietly
  // taken any of them with it — /smoke was exactly that case: it had no
  // declaration of its own and only looked covered.
  for (const path of ["/smoke", "/login", "/register"]) {
    test(`${path} declares noindex for itself`, async ({ page }) => {
      const { tags } = await robotsTags(page, path);
      expect(tags.join(" ")).toContain("noindex");
    });
  }
});

test.describe("a missing anime", () => {
  test("says noindex, and nothing that argues with it", async ({ page }) => {
    // The one signal keeping 17,603-per-locale worth of potential soft 404s
    // out of the index. It used to arrive alongside an `index, follow` it had
    // to out-rank.
    //
    // Asserted as "every directive is a noindex" rather than "the array is
    // exactly ['noindex']". Pinning the count made this test fail on a
    // duplicate that changed nothing about what a crawler concludes; the
    // duplicate came from streaming, which this route no longer does, but the
    // looser assertion is still the one that states the requirement.
    const { status, tags } = await robotsTags(page, `/anime/${MISSING_ANIME}`);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain("noindex");

    // And the status, which is strictly stronger than anything above: while
    // this route streamed, `noindex` was the only signal available and the
    // response was a 200. It is a real 404 now.
    expect(status).toBe(404);
  });

  test("renders the not-found page, not a half-empty detail page", async ({ page }) => {
    // Guards the other direction: a 404 is only the right answer because the
    // page genuinely is the not-found UI. If a data failure ever started
    // rendering an empty hero here instead, the status and the robots tag
    // would both still pass and the page would be junk.
    await page.goto(`/anime/${MISSING_ANIME}`);
    await expect(page.locator("h1, h2").first()).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  });
});
