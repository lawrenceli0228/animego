import { describe, expect, test } from "bun:test";
import {
  buildAlternates,
  buildAlternatesUntranslated,
  untranslatedRobots,
  absoluteUrl,
  SITE_ORIGIN,
} from "./alternates";
import { LOCALES, DEFAULT_LOCALE, isLocale, localizePath, type Locale } from "@/lib/i18n/locale";

// These rules were written against a three-locale set months before the third
// locale existed, using a cast to describe a shape the site did not serve yet.
// zh-Hant is published now, so the cast is gone and every rule below runs
// against the real LOCALES.
//
// Writing them early was the right call and worth recording: hreflang fails
// silently AND collectively. One page whose map is missing an entry voids the
// group for every page in it — no build error, no failing render, nothing
// visible in a screenshot. There is no moment at which a broken hreflang set
// announces itself, so the tests have to exist before the locale does.
//
// Deliberately iterating LOCALES rather than a literal list: a fourth locale
// joins every rule here automatically instead of being silently untested.
const ALL: readonly Locale[] = LOCALES;

describe("buildAlternates — the published locales", () => {
  test("the default locale keeps the bare path and names every locale", () => {
    expect(buildAlternates("/faq")).toEqual({
      canonical: "/faq",
      languages: {
        "zh-Hans": "/faq",
        en: "/en/faq",
        "zh-Hant": "/zh-Hant/faq",
        "x-default": "/faq",
      },
    });
  });

  test("leaves the root path as /", () => {
    expect(buildAlternates("/").canonical).toBe("/");
  });

  test("a page with no translation makes no claim", () => {
    // /privacy, /terms and /copyright are hardcoded Chinese with no English
    // body. Advertising an /en/ alternate for them would rebuild the exact
    // bug this module removed, from the other direction.
    expect(buildAlternatesUntranslated("/privacy")).toEqual({ canonical: "/privacy" });
    expect(buildAlternatesUntranslated("/privacy", "en")).toEqual({ canonical: "/en/privacy" });
    expect(buildAlternatesUntranslated("/privacy", "zh-Hant")).toEqual({
      canonical: "/zh-Hant/privacy",
    });
  });

  test("only the default-locale copy of an untranslated page is indexable", () => {
    // Silence in the hreflang map keeps these out of the reciprocal group; it
    // does NOT keep them out of the index. They are prerendered and linked
    // from every footer, so without this each legal page had one indexable
    // URL per locale carrying the identical Simplified body — including a
    // Simplified body under /zh-Hant/, which is the exact class of mistake
    // the locale work exists to prevent.
    expect(untranslatedRobots(DEFAULT_LOCALE)).toEqual({ index: true, follow: true });
    for (const locale of ALL) {
      if (locale === DEFAULT_LOCALE) continue;
      expect(untranslatedRobots(locale)).toEqual({ index: false, follow: true });
    }
  });

  test("never mentions ?lang=en", () => {
    // The exact string that was advertised to Google from eight files while
    // the server ignored the parameter and served Chinese.
    const serialized = JSON.stringify([
      buildAlternates("/"),
      buildAlternates("/faq", DEFAULT_LOCALE),
    ]);
    expect(serialized).not.toContain("lang=en");
  });
});

describe("buildAlternates — the reciprocity rules", () => {
  const PATHS = ["/", "/faq", "/anime/21", "/seasonal/spring/2026"];

  test("every locale is listed, plus x-default", () => {
    const { languages } = buildAlternates("/faq", "zh-Hans");
    expect(Object.keys(languages!).sort()).toEqual(
      ["en", "x-default", "zh-Hans", "zh-Hant"].sort(),
    );
  });

  test("each locale's map lists itself", () => {
    // Google: "Each language version must list itself as well as all other
    // language versions." A map that omits its own locale is ignored.
    for (const locale of ALL) {
      const { canonical, languages } = buildAlternates("/faq", locale);
      expect(languages![locale]).toBe(canonical);
    }
  });

  test("the group is reciprocal — every page points at every other", () => {
    // Google: "If two pages don't both point to each other, the tags will be
    // ignored." Closure is the actual invariant: for any pair (a, b), the URL
    // a advertises for b must be the URL b calls its own canonical.
    for (const path of PATHS) {
      for (const a of ALL) {
        const from = buildAlternates(path, a);
        for (const b of ALL) {
          const to = buildAlternates(path, b);
          expect(from.languages![b]).toBe(to.canonical);
        }
      }
    }
  });

  test("x-default points at the un-prefixed tree from every locale", () => {
    // Existing indexed URLs are all un-prefixed. x-default has to keep
    // pointing there or the migration starts moving the index.
    for (const path of PATHS) {
      for (const locale of ALL) {
        const { languages } = buildAlternates(path, locale);
        expect(languages!["x-default"]).toBe(buildAlternates(path, DEFAULT_LOCALE).canonical);
      }
    }
  });

  test("the default locale keeps bare paths and the others take a prefix", () => {
    // D1 of the migration plan: simplified Chinese does not move, so no
    // existing indexed URL 301s.
    expect(buildAlternates("/faq", "zh-Hans").canonical).toBe("/faq");
    expect(buildAlternates("/faq", "zh-Hant").canonical).toBe("/zh-Hant/faq");
    expect(buildAlternates("/faq", "en").canonical).toBe("/en/faq");
  });

  test("the root path does not grow a trailing slash under a prefix", () => {
    expect(buildAlternates("/", "en").canonical).toBe("/en");
    expect(buildAlternates("/", "zh-Hans").canonical).toBe("/");
  });
});

describe("absoluteUrl", () => {
  test("prefixes the origin", () => {
    expect(absoluteUrl("/anime/21")).toBe("https://animegoclub.com/anime/21");
    expect(absoluteUrl("/")).toBe("https://animegoclub.com/");
  });

  test("uses the same origin as metadataBase in the root layout", () => {
    // If these diverge, every canonical stops being self-referential and
    // Google consolidates the page onto an origin we do not serve.
    expect(SITE_ORIGIN).toBe("https://animegoclub.com");
  });
});

describe("locale vocabulary", () => {
  test("the default locale is one of the published locales", () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  test("isLocale accepts published locales and rejects everything else", () => {
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true);
    // "zh" is a UI dictionary key, not a locale id. The two vocabularies now
    // overlap on "en" and "zh-Hant" and nowhere else, which makes conflating
    // them easier rather than harder: "zh-Hant" is both, "zh" is only ever a
    // Lang, and "zh-Hans" is only ever a Locale.
    for (const notALocale of ["zh", "zh-CN", "zh-hant", "en-US", "fr", "", "ZH-HANS", "zh-Hans/"]) {
      expect(isLocale(notALocale)).toBe(false);
    }
  });

  test("localizePath is idempotent for the default locale", () => {
    for (const path of ["/", "/faq", "/anime/21"]) {
      expect(localizePath(path, DEFAULT_LOCALE)).toBe(path);
    }
  });
});
