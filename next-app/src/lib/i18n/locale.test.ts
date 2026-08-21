import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_LANG,
  PUBLIC_LOCALE_PREFIXES,
  isLocale,
  localeForLang,
  localizePath,
  nextLocale,
  routerPath,
  splitLocale,
} from "./locale";
import { LANGS } from "./lang";

// The routing primitives. Everything downstream — the proxy's rewrite, the
// hreflang set, the sitemap expansion, every link on the site — is a thin
// layer over these four functions, so a mistake here is a mistake
// everywhere and it is worth pinning the awkward cases directly.

describe("splitLocale", () => {
  test("a bare path belongs to the default locale", () => {
    expect(splitLocale("/anime/21")).toEqual({ locale: "zh-Hans", path: "/anime/21" });
    expect(splitLocale("/")).toEqual({ locale: "zh-Hans", path: "/" });
  });

  test("a published prefix is stripped", () => {
    expect(splitLocale("/en/anime/21")).toEqual({ locale: "en", path: "/anime/21" });
    expect(splitLocale("/en")).toEqual({ locale: "en", path: "/" });
  });

  test("the default locale is NOT a public prefix", () => {
    // "/zh-Hans/anime/21" must not be a second address for "/anime/21".
    // Leaving the segment in the path is what makes the router fail to
    // match it, which is how the duplicate URL never exists.
    expect(splitLocale("/zh-Hans/anime/21")).toEqual({
      locale: "zh-Hans",
      path: "/zh-Hans/anime/21",
    });
  });

  test("an unknown first segment stays in the path", () => {
    // A [lang] route segment matches anything. If splitLocale accepted "fr"
    // as a locale, /fr/anime/21 would render the site in the default
    // language with a 200 — a soft 404 on an unbounded surface.
    expect(splitLocale("/fr/anime/21").path).toBe("/fr/anime/21");
    expect(splitLocale("/wp-admin").path).toBe("/wp-admin");
  });

  test("only one prefix is stripped", () => {
    // The no-double-prefix guard falls out of this rather than needing its
    // own check: /en/en/faq asks the router for a path that matches nothing.
    expect(splitLocale("/en/en/faq")).toEqual({ locale: "en", path: "/en/faq" });
  });

  test("a prefix must be a whole segment", () => {
    expect(splitLocale("/english-guide")).toEqual({
      locale: "zh-Hans",
      path: "/english-guide",
    });
  });
});

describe("localizePath", () => {
  test("round-trips with splitLocale for every locale", () => {
    for (const locale of LOCALES) {
      for (const path of ["/", "/faq", "/anime/21", "/u/alice/followers"]) {
        expect(splitLocale(localizePath(path, locale))).toEqual({ locale, path });
      }
    }
  });

  test("the root path never grows a trailing slash", () => {
    expect(localizePath("/", "en")).toBe("/en");
    expect(localizePath("/", "zh-Hans")).toBe("/");
  });
});

describe("routerPath", () => {
  test("always carries a locale segment, including the default one", () => {
    // This is a rewrite target, not an address: one route tree serves every
    // locale, so even the bare tree resolves to /zh-Hans/… internally.
    expect(routerPath("/anime/21", "zh-Hans")).toBe("/zh-Hans/anime/21");
    expect(routerPath("/", "zh-Hans")).toBe("/zh-Hans");
    expect(routerPath("/faq", "en")).toBe("/en/faq");
  });

  test("is a no-op for an already-prefixed locale", () => {
    // Which is why the proxy can skip the rewrite entirely on /en/*.
    expect(routerPath("/faq", "en")).toBe(localizePath("/faq", "en"));
  });
});

describe("nextLocale", () => {
  test("cycles and wraps", () => {
    let seen = nextLocale(DEFAULT_LOCALE);
    const visited = new Set([DEFAULT_LOCALE, seen]);
    for (let i = 0; i < LOCALES.length; i += 1) {
      seen = nextLocale(seen);
      visited.add(seen);
    }
    // Every locale is reachable from any other by clicking the control.
    expect(visited.size).toBe(LOCALES.length);
    expect(seen).toBeDefined();
  });

  test("returns to where it started after a full lap", () => {
    let at = DEFAULT_LOCALE;
    for (let i = 0; i < LOCALES.length; i += 1) at = nextLocale(at);
    expect(at).toBe(DEFAULT_LOCALE);
  });
});

describe("the locale/language bridge", () => {
  test("every locale names a dictionary", () => {
    for (const locale of LOCALES) expect(LANGS).toContain(LOCALE_LANG[locale]);
  });

  test("localeForLang is the inverse of LOCALE_LANG", () => {
    for (const locale of LOCALES) {
      expect(localeForLang(LOCALE_LANG[locale])).toBe(locale);
    }
  });

  test("no two locales claim the same dictionary", () => {
    // They will one day — zh-Hant is its own language — but while the map is
    // one-to-one, localeForLang has a single correct answer. If this fails,
    // localeForLang has become ambiguous and its callers need a real choice.
    //
    // Still one-to-one now that zh-Hant is published: it brought its own Lang
    // with it rather than borrowing zh's. That is the whole reason widening
    // LANGS had to come first — during the build zh-Hant was a fully
    // implemented language with no URL at all, and the only value that
    // typechecked in LOCALE_LANG if you did it the other way round was
    // `"zh-Hant": "zh"`, which serves Simplified text under a Traditional URL
    // and errs nowhere.
    const langs = LOCALES.map((locale) => LOCALE_LANG[locale]);
    expect(new Set(langs).size).toBe(langs.length);
  });
});

describe("vocabulary", () => {
  test("the default locale is published and has no public prefix", () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE);
    expect(PUBLIC_LOCALE_PREFIXES).not.toContain(DEFAULT_LOCALE);
  });

  test("every other locale does have one", () => {
    for (const locale of LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      expect(PUBLIC_LOCALE_PREFIXES).toContain(locale);
    }
  });

  test("isLocale rejects near-misses", () => {
    // "zh-Hant" was in this list for the whole build and has been moved out,
    // which is what its previous comment asked whoever published it to do.
    // The list stays because it is still the only thing that fails when
    // someone widens LOCALES: doing so produces ZERO tsc errors while
    // publishing an entire prefix tree into the sitemap and hreflang set.
    // A fourth locale should sit here first, and leave when its URLs resolve
    // and its content exists.
    //
    // "zh" and "zh-Hant" are different vocabularies and the pair below is the
    // point: "zh-Hant" is both a Lang and a Locale, "zh" is only ever a Lang.
    for (const value of ["zh", "zh-CN", "zh-hant", "en-US", "fr", "", "ZH-HANS", "/en"]) {
      expect(isLocale(value)).toBe(false);
    }
    expect(isLocale("zh-Hant")).toBe(true);
  });
});
