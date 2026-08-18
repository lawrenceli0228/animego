import { describe, expect, test } from "bun:test";
import sitemap from "./sitemap";
import { DEFAULT_LOCALE, LOCALES, localizePath } from "@/lib/i18n/locale";
import { SITE_ORIGIN } from "@/lib/seo/alternates";

// The Go API is unreachable here, so the anime rows are absent and the
// static rows are what gets asserted — which is the interesting half anyway:
// the anime rows are a map() over the same expansion.
//
// Worth stating plainly because it is the reason this file exists: the
// sitemap and the per-page hreflang tags are two documents making the same
// claims to the same crawler, and Google will drop a reciprocal group when
// they disagree. Both are generated from LOCALES so they cannot.

const rows = await sitemap();
const urls = rows.map((r) => r.url);

describe("locale expansion", () => {
  test("every translated page appears once per locale", () => {
    for (const path of ["/", "/calendar", "/faq"]) {
      for (const locale of LOCALES) {
        expect(urls).toContain(`${SITE_ORIGIN}${localizePath(path, locale)}`);
      }
    }
  });

  test("the language map is reciprocal and self-referential", () => {
    // Same rule as the head tags: every row lists every locale, itself
    // included, and each entry is the URL that row's counterpart claims.
    for (const row of rows) {
      if (!row.alternates?.languages) continue;
      const languages = row.alternates.languages as Record<string, string>;
      expect(Object.keys(languages).sort()).toEqual([...LOCALES].sort());
      expect(Object.values(languages)).toContain(row.url);
    }
  });
});

describe("untranslated pages", () => {
  // Hardcoded Chinese bodies. An /en/ URL for them would be a promise the
  // page does not keep.
  const LEGAL = ["/terms", "/privacy", "/copyright"];

  test("appear only at the default locale", () => {
    for (const path of LEGAL) {
      expect(urls).toContain(`${SITE_ORIGIN}${localizePath(path, DEFAULT_LOCALE)}`);
      expect(urls).not.toContain(`${SITE_ORIGIN}/en${path}`);
    }
  });

  test("carry no alternates at all", () => {
    for (const path of LEGAL) {
      const row = rows.find((r) => r.url === `${SITE_ORIGIN}${path}`);
      expect(row?.alternates).toBeUndefined();
    }
  });
});

describe("the current season", () => {
  test("is derived from the clock, not a literal", () => {
    // This was pinned to /seasonal/spring/2026 behind a comment promising to
    // revisit it, and went stale while next.config.ts computed the right
    // answer for its own redirect.
    const now = new Date();
    const season = ["winter", "spring", "summer", "fall"][Math.floor(now.getMonth() / 3)];
    expect(urls).toContain(`${SITE_ORIGIN}/seasonal/${season}/${now.getFullYear()}`);
  });
});

describe("URL hygiene", () => {
  test("every url is absolute and on the canonical origin", () => {
    // Relative or wrong-origin URLs make a crawler reject the whole document.
    for (const url of urls) expect(url.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
  });

  test("no url is listed twice", () => {
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("no url carries the legacy ?lang= parameter", () => {
    for (const url of urls) expect(url).not.toContain("lang=");
  });
});
