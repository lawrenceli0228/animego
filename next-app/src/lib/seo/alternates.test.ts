import { describe, expect, test } from "bun:test";
import { buildAlternates, absoluteUrl, SITE_ORIGIN } from "./alternates";
import { LOCALES, DEFAULT_LOCALE, isLocale, localizePath, type Locale } from "@/lib/i18n/locale";

// The multi-locale set this file tests against. Only zh-Hans is published
// today, so the reciprocity rules below describe a shape that does not exist
// on the site yet — on purpose. hreflang fails silently and collectively: one
// page whose map is missing an entry voids the group for every page in it,
// with no build error, no failing render, and nothing visible in a screenshot.
// The rules are worth having under test before the locales that would expose
// a mistake go live, not after.
const FUTURE = ["zh-Hans", "zh-Hant", "en"] as const;

/**
 * `buildAlternates` against the future locale set.
 *
 * The one cast in this file, and it is confined to the test. The production
 * signature stays narrowed to the locales that are actually published, so a
 * call site cannot name a locale the site does not serve — which is the
 * check worth keeping. Widening it here to describe a set that does not
 * exist yet is the test's business, not the caller's.
 */
const futureAlternates = (path: string, locale: (typeof FUTURE)[number]) =>
  buildAlternates(path, locale as Locale, FUTURE as unknown as readonly Locale[]);

describe("buildAlternates — today, with one published locale", () => {
  test("emits a canonical and no language map", () => {
    // A lone self-referential hreflang says nothing the canonical has not
    // already said. The site previously emitted a two-entry map in which the
    // second entry was a lie, which is how this helper came to exist.
    expect(buildAlternates("/faq")).toEqual({ canonical: "/faq" });
  });

  test("leaves the root path as /", () => {
    expect(buildAlternates("/").canonical).toBe("/");
  });

  test("never mentions ?lang=en", () => {
    // The exact string that was advertised to Google from eight files while
    // the server ignored the parameter and served Chinese.
    const serialized = JSON.stringify([
      buildAlternates("/"),
      futureAlternates("/faq", DEFAULT_LOCALE),
    ]);
    expect(serialized).not.toContain("lang=en");
  });
});

describe("buildAlternates — the multi-locale shape", () => {
  const PATHS = ["/", "/faq", "/anime/21", "/seasonal/spring/2026"];

  test("every locale is listed, plus x-default", () => {
    const { languages } = futureAlternates("/faq", "zh-Hans");
    expect(Object.keys(languages!).sort()).toEqual(
      ["en", "x-default", "zh-Hans", "zh-Hant"].sort(),
    );
  });

  test("each locale's map lists itself", () => {
    // Google: "Each language version must list itself as well as all other
    // language versions." A map that omits its own locale is ignored.
    for (const locale of FUTURE) {
      const { canonical, languages } = futureAlternates("/faq", locale);
      expect(languages![locale]).toBe(canonical);
    }
  });

  test("the group is reciprocal — every page points at every other", () => {
    // Google: "If two pages don't both point to each other, the tags will be
    // ignored." Closure is the actual invariant: for any pair (a, b), the URL
    // a advertises for b must be the URL b calls its own canonical.
    for (const path of PATHS) {
      for (const a of FUTURE) {
        const from = futureAlternates(path, a);
        for (const b of FUTURE) {
          const to = futureAlternates(path, b);
          expect(from.languages![b]).toBe(to.canonical);
        }
      }
    }
  });

  test("x-default points at the un-prefixed tree from every locale", () => {
    // Existing indexed URLs are all un-prefixed. x-default has to keep
    // pointing there or the migration starts moving the index.
    for (const path of PATHS) {
      for (const locale of FUTURE) {
        const { languages } = futureAlternates(path, locale);
        expect(languages!["x-default"]).toBe(futureAlternates(path, DEFAULT_LOCALE).canonical);
      }
    }
  });

  test("the default locale keeps bare paths and the others take a prefix", () => {
    // D1 of the migration plan: simplified Chinese does not move, so no
    // existing indexed URL 301s.
    expect(futureAlternates("/faq", "zh-Hans").canonical).toBe("/faq");
    expect(futureAlternates("/faq", "zh-Hant").canonical).toBe("/zh-Hant/faq");
    expect(futureAlternates("/faq", "en").canonical).toBe("/en/faq");
  });

  test("the root path does not grow a trailing slash under a prefix", () => {
    expect(futureAlternates("/", "en").canonical).toBe("/en");
    expect(futureAlternates("/", "zh-Hans").canonical).toBe("/");
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
    // "zh" and "en" are the UI dictionary keys, not locale ids — a third
    // vocabulary sneaking in here is how the two drift apart.
    for (const notALocale of ["zh", "en", "zh-CN", "en-US", "fr", "", "ZH-HANS", "zh-Hans/"]) {
      expect(isLocale(notALocale)).toBe(false);
    }
  });

  test("localizePath is idempotent for the default locale", () => {
    for (const path of ["/", "/faq", "/anime/21"]) {
      expect(localizePath(path, DEFAULT_LOCALE)).toBe(path);
    }
  });
});
