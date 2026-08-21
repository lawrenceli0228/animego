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

test.describe("the Traditional Chinese tree", () => {
  // zh-Hant is the locale most likely to fail invisibly, because a wrong
  // answer here is still Chinese. An English string under /en is obvious in a
  // screenshot; a Simplified string under /zh-Hant is not, and the readers who
  // would notice are the ones least likely to be reviewing the diff.
  test("/zh-Hant/faq responds 200", async ({ page }) => {
    expect(await status(page, "/zh-Hant/faq")).toBe(200);
  });

  test("html lang follows the URL", async ({ page }) => {
    await page.goto("/zh-Hant/faq");
    expect(await page.locator("html").getAttribute("lang")).toBe("zh-Hant");
  });

  test("the body is Traditional, not Simplified", async ({ page }) => {
    // The character pairs below are the highest-frequency ones in this UI and
    // are script-exclusive: 這/这, 個/个, 開/开, 關/关, 點/点. Counting beats
    // asserting one known string, which a copy edit would break for the wrong
    // reason.
    await page.goto("/zh-Hant/faq");
    await expect(page.locator("h1")).toBeVisible();
    // textContent, not innerText. This page keeps its answers in collapsed
    // <details>, and innerText returns only what is painted — 477 characters
    // against textContent's 59,757. An innerText assertion here passes or
    // fails on how many questions happen to be open, which is not what is
    // being tested.
    const text = (await page.locator("body").textContent()) || "";
    const simplified = (text.match(/[这个开关点说时长发网页样验后问]/g) ?? []).length;
    const traditional = (text.match(/[這個開關點說時長發網頁樣驗後問]/g) ?? []).length;
    expect(traditional).toBeGreaterThan(20);
    expect(simplified).toBe(0);
  });

  test("/zh-Hant/anime/21 renders and self-canonicalises under its prefix", async ({ page }) => {
    await page.goto("/zh-Hant/anime/21");
    await expect(page.locator("h1")).toBeVisible();
    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    expect(canonical).toMatch(/\/zh-Hant\/anime\/21$/);
  });

  test("the locale prefix is case-sensitive", async ({ page }) => {
    // /zh-hant/ resolving would be a second address for the same document.
    expect(await status(page, "/zh-hant/faq")).toBe(404);
  });
});

test.describe("hreflang is reciprocal on real HTML", () => {
  // Google ignores the entire group when two pages fail to point at each
  // other, and nothing in a build or a screenshot shows it.
  //
  // Kept as a literal list rather than imported from the app: a spec that
  // derives its expectations from the code under test cannot catch the code
  // being wrong. Adding a locale should require editing this line.
  const PUBLISHED = ["zh-Hans", "en", "zh-Hant"] as const;
  const PATH_OF: Record<(typeof PUBLISHED)[number], string> = {
    "zh-Hans": "/faq",
    en: "/en/faq",
    "zh-Hant": "/zh-Hant/faq",
  };

  test("every locale of /faq lists every other, and they agree", async ({ page }) => {
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

    const sides: Record<string, Awaited<ReturnType<typeof read>>> = {};
    for (const locale of PUBLISHED) sides[locale] = await read(PATH_OF[locale]);

    const expected = [...PUBLISHED, "x-default"].sort();
    for (const locale of PUBLISHED) {
      expect(Object.keys(sides[locale].alternates).sort()).toEqual(expected);
    }

    // Closure over every ordered pair, not just the round trip: the URL `a`
    // advertises for `b` must be the URL `b` calls its own canonical. With
    // three locales there are six directed edges and a partial fix can
    // satisfy two of them.
    for (const a of PUBLISHED) {
      for (const b of PUBLISHED) {
        expect(sides[a].alternates[b]).toBe(sides[b].canonical);
      }
    }

    // x-default points at the un-prefixed tree from every side.
    for (const locale of PUBLISHED) {
      expect(sides[locale].alternates["x-default"]).toBe(sides["zh-Hans"].canonical);
    }
  });

  test("the untranslated legal pages claim no translation", async ({ page }) => {
    // /privacy is hardcoded Chinese. Advertising an English alternate for it
    // is the bug this whole project started from, and would be trivially
    // easy to reintroduce by dropping the untranslated opt-out.
    await page.goto("/privacy");
    await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(0);
  });

  test("only the bare copy of an untranslated page is indexable", async ({ page }) => {
    // Making no hreflang claim keeps these out of the reciprocal group but
    // not out of the index. They are prerendered and linked from every
    // footer, so without an explicit noindex each legal page has one
    // indexable URL per locale carrying the identical Simplified body —
    // including one under /zh-Hant/, which is the exact class of mistake this
    // whole migration exists to prevent.
    const robots = async (path: string) => {
      await page.goto(path);
      return page.locator('meta[name="robots"]').getAttribute("content");
    };
    for (const doc of ["/privacy", "/terms", "/copyright"]) {
      expect(await robots(doc)).toContain("index");
      expect(await robots(doc)).not.toContain("noindex");
      for (const prefix of ["/en", "/zh-Hant"]) {
        expect(await robots(`${prefix}${doc}`)).toContain("noindex");
      }
    }
  });
});

test.describe("the language menu", () => {
  // The control that replaced a two-state EN/中 toggle. The toggle was not
  // merely incomplete at three locales, it was actively misleading: a reader
  // on a Traditional page was invited to "switch to Chinese".
  test("offers every locale, in its own script, with the current one marked", async ({ page }) => {
    await page.goto("/zh-Hant/faq");
    await page.getByRole("button", { name: /language|語言|语言/i }).first().click();

    const options = page.getByRole("menuitem");
    await expect(options).toHaveCount(3);
    // Endonyms, not translations: a reader looking for Traditional Chinese is
    // looking for these exact characters, whatever page they are on.
    for (const label of ["简体中文", "繁體中文", "English"]) {
      await expect(page.getByRole("menuitem", { name: label })).toBeVisible();
    }
    await expect(page.getByRole("menuitem", { name: "繁體中文" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  test("switching locale keeps the page and its query string", async ({ page }) => {
    // The failure this catches is a switcher that sends everyone to the home
    // page, which is both a worse experience and a signal Google reads as the
    // alternate not really being an alternate.
    await page.goto("/zh-Hant/search?q=frieren");
    await page.getByRole("button", { name: /language|語言|语言/i }).first().click();
    await page.getByRole("menuitem", { name: "English" }).click();
    await page.waitForURL(/\/en\/search/);
    expect(page.url()).toContain("q=frieren");
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
  test("sitemap.xml is served, and lists every locale", async ({ page }) => {
    const res = await page.request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain("<loc>");
    // If the locale step ever rewrote this route it would 404 outright, so
    // the status above is the real guard; this checks the expansion landed.
    expect(body).toContain("/en/faq");
    expect(body).toContain("/zh-Hant/faq");
    // …and that the untranslated pages did NOT get expanded. A sitemap that
    // submits /zh-Hant/privacy asks Google to index a Simplified body under a
    // Traditional URL, which is what the noindex above is cleaning up after.
    expect(body).not.toContain("/zh-Hant/privacy");
    expect(body).not.toContain("/en/privacy");
  });

  test("robots.txt is served", async ({ page }) => {
    const res = await page.request.get("/robots.txt");
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("Sitemap:");
  });
});
