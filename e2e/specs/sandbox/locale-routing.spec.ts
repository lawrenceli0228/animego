import { test, expect } from "@playwright/test";

// The regression guards for the locale URL migration.
//
// Every route moved under app/[lang]/ and the proxy rewrites bare paths into
// the default locale segment. That is invisible when it works and expensive
// when it does not, because the failure modes are silent: a bare path that
// starts redirecting moves the entire indexed surface of a site whose only
// acquisition channel is organic search, and nobody notices until traffic
// has already eroded. These assertions are cheap; the alternative is
// noticing in Search Console weeks later.
//
// This file needs no authentication and no seeded data, so it deliberately
// clears the shared storageState — a signed-in session would change what the
// proxy does (the cache-bypass cookie checks) and mask exactly the behaviour
// under test.
test.use({ storageState: { cookies: [], origins: [] } });

/** Follow nothing: the status code IS the assertion. */
async function status(page: import("@playwright/test").Page, path: string) {
  const res = await page.request.get(path, { maxRedirects: 0 });
  return res.status();
}

test.describe("bare paths keep their URL", () => {
  // The single most expensive way this migration could go wrong.
  const INDEXED = ["/", "/anime/21", "/calendar", "/faq", "/welcome", "/search"];

  for (const path of INDEXED) {
    test(`${path} responds 200, not a redirect`, async ({ page }) => {
      expect(await status(page, path)).toBe(200);
    });
  }

  test("the homepage still renders Simplified Chinese", async ({ page }) => {
    await page.goto("/");
    // The nav label is the shortest thing that differs between the two
    // dictionaries and is present on every page.
    await expect(page.locator('nav[aria-label="主导航"]')).toBeVisible();
  });

  test("a detail page still renders and keeps its canonical bare", async ({ page }) => {
    await page.goto("/anime/21");
    await expect(page.locator("h1")).toBeVisible();
    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    expect(canonical).toMatch(/\/anime\/21$/);
    expect(canonical).not.toContain("/zh-Hans/");
  });
});

test.describe("the English tree", () => {
  test("/en responds 200", async ({ page }) => {
    expect(await status(page, "/en")).toBe(200);
  });

  test("/en/faq renders English, not Chinese", async ({ page }) => {
    await page.goto("/en/faq");
    await expect(page.locator('nav[aria-label="Main navigation"]')).toBeVisible();
  });

  test("/en/anime/21 renders and self-canonicalises under /en", async ({ page }) => {
    await page.goto("/en/anime/21");
    await expect(page.locator("h1")).toBeVisible();
    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    expect(canonical).toMatch(/\/en\/anime\/21$/);
  });

  test("html lang follows the URL", async ({ page }) => {
    await page.goto("/en/faq");
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
    await page.goto("/faq");
    expect(await page.locator("html").getAttribute("lang")).toBe("zh-CN");
  });
});

test.describe("hreflang is reciprocal on real HTML", () => {
  // Google ignores the entire group when two pages fail to point at each
  // other, and nothing in a build or a screenshot shows it.
  test("both locales of /faq list each other and agree", async ({ page }) => {
    const read = async (path: string) => {
      await page.goto(path);
      const links = page.locator('link[rel="alternate"][hreflang]');
      const out: Record<string, string> = {};
      for (const el of await links.all()) {
        const lang = await el.getAttribute("hreflang");
        const href = await el.getAttribute("href");
        if (lang && href) out[lang] = href;
      }
      return {
        canonical: await page.locator('link[rel="canonical"]').getAttribute("href"),
        alternates: out,
      };
    };

    const zh = await read("/faq");
    const en = await read("/en/faq");

    for (const side of [zh, en]) {
      expect(Object.keys(side.alternates).sort()).toEqual(["en", "x-default", "zh-Hans"]);
    }
    // Closure: the URL each side advertises for the other is the URL that
    // other side calls its own canonical.
    expect(zh.alternates["en"]).toBe(en.canonical);
    expect(en.alternates["zh-Hans"]).toBe(zh.canonical);
    // x-default points at the un-prefixed tree from both sides.
    expect(zh.alternates["x-default"]).toBe(zh.canonical);
    expect(en.alternates["x-default"]).toBe(zh.canonical);
  });

  test("the untranslated legal pages claim no English version", async ({ page }) => {
    // /privacy is hardcoded Chinese. Advertising an English alternate for it
    // is the bug this whole project started from, and would be trivially
    // easy to reintroduce by dropping the untranslated opt-out.
    await page.goto("/privacy");
    await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(0);
  });
});

test.describe("unknown first segments are real 404s, not soft ones", () => {
  // A [lang] segment matches anything. Without the proxy leaving unknown
  // segments in the path, every junk URL on the internet would render the
  // homepage with a 200.
  for (const path of ["/fr/anime/21", "/wp-admin", "/nosuchpath", "/zh-Hans/anime/21"]) {
    test(`${path} does not resolve`, async ({ page }) => {
      const code = await status(page, path);
      expect(code).toBe(404);
    });
  }

  test("a doubled locale prefix does not loop", async ({ page }) => {
    // splitLocale strips one prefix only, so this asks the router for
    // /en/en/faq and gets nothing. The guard against a redirect loop is that
    // there is no redirect at all.
    const res = await page.request.get("/en/en/faq", { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });
});

test.describe("legacy ?lang= URLs", () => {
  test("?lang=en permanently redirects into /en and drops the parameter", async ({ page }) => {
    const res = await page.request.get("/faq?lang=en", { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    const location = res.headers()["location"];
    expect(location).toContain("/en/faq");
    expect(location).not.toContain("lang=");
  });

  test("other query parameters survive the redirect", async ({ page }) => {
    const res = await page.request.get("/search?q=frieren&lang=en", { maxRedirects: 0 });
    const location = res.headers()["location"];
    expect(location).toContain("/en/search");
    expect(location).toContain("q=frieren");
    expect(location).not.toContain("lang=");
  });
});

test.describe("non-page routes are untouched by the locale step", () => {
  test("sitemap.xml is served, and lists both locales", async ({ page }) => {
    const res = await page.request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain("<loc>");
    // If the locale step ever rewrote this route it would 404 outright, so
    // the status above is the real guard; this checks the expansion landed.
    expect(body).toContain("/en/faq");
  });

  test("robots.txt is served", async ({ page }) => {
    const res = await page.request.get("/robots.txt");
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("Sitemap:");
  });
});
