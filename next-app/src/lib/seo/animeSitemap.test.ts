import { describe, expect, test } from "bun:test";
import {
  ANIME_SITEMAP_SHARDS,
  animeSitemapPath,
  animeSitemapRows,
  animeSitemapUrls,
} from "./animeSitemap";
import { LOCALES, localizePath } from "@/lib/i18n/locale";
import { SITE_ORIGIN } from "@/lib/seo/alternates";
import type { SitemapAnime } from "@/lib/types";

// Prod at the time of writing: 17,603 anime. Kept as a literal because the
// point of the shard-count assertion is to fail when the catalogue outgrows
// the layout, and a value read from the same constant it is checking would
// never fail.
const CATALOGUE_SIZE = 17_603;
const GOOGLE_URLS_PER_SITEMAP = 50_000;

const rows: SitemapAnime[] = [
  { anilistId: 1474, updatedAt: "2026-08-27T11:29:16.681137Z" },
  { anilistId: 21, updatedAt: "2026-05-01T00:00:00Z" },
];

describe("shard layout", () => {
  test("the whole catalogue fits, in every locale", () => {
    // The constraint that decides this number: Google caps a sitemap at
    // 50,000 <url> entries, and the site publishes one URL per anime per
    // locale. One document would overflow on the anime count alone.
    const perShard = Math.ceil(CATALOGUE_SIZE / ANIME_SITEMAP_SHARDS) * LOCALES.length;
    expect(perShard).toBeLessThan(GOOGLE_URLS_PER_SITEMAP);
  });

  test("paths follow the generateSitemaps convention and stay off /anime/", () => {
    // Next publishes app/sitemaps/anime/sitemap.ts at <segment>/sitemap/<id>.xml.
    expect(animeSitemapPath(0)).toBe("/sitemaps/anime/sitemap/0.xml");

    // A segment at app/anime/ would be a static sibling of app/[lang]/, and
    // static wins — /anime/{id} would resolve against a segment with no page.
    for (let id = 0; id < ANIME_SITEMAP_SHARDS; id++) {
      expect(animeSitemapPath(id).startsWith("/anime/")).toBe(false);
    }
  });

  test("one absolute url per shard, no duplicates", () => {
    const urls = animeSitemapUrls();
    expect(urls).toHaveLength(ANIME_SITEMAP_SHARDS);
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) expect(url.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
  });
});

describe("row expansion", () => {
  const expanded = animeSitemapRows(rows);

  test("one url per anime per locale", () => {
    expect(expanded).toHaveLength(rows.length * LOCALES.length);
    for (const a of rows) {
      for (const locale of LOCALES) {
        expect(expanded.map((r) => r.url)).toContain(
          `${SITE_ORIGIN}${localizePath(`/anime/${a.anilistId}`, locale)}`,
        );
      }
    }
  });

  test("lastmod is the row's own updated_at, not the time of the fetch", () => {
    // The sitemap this replaces stamped `new Date()` on every row, which
    // claimed the entire catalogue changed on every crawl. Google's
    // documented response to a lastmod it can disprove is to ignore lastmod
    // for the whole site — so a regression here silently costs the signal
    // for the static pages too.
    for (const row of expanded) {
      const source = rows.find((a) => row.url.endsWith(`/anime/${a.anilistId}`));
      expect(source).toBeDefined();
      expect(new Date(row.lastModified as Date).toISOString()).toBe(
        new Date(source!.updatedAt).toISOString(),
      );
    }
  });

  test("the language map is reciprocal and self-referential", () => {
    // Same rule the static sitemap is held to. Two documents now make
    // hreflang claims about this site; Google drops a reciprocal group when
    // they disagree, so both have to expand through the same function.
    for (const row of expanded) {
      const languages = row.alternates?.languages as Record<string, string>;
      expect(Object.keys(languages).sort()).toEqual([...LOCALES].sort());
      expect(Object.values(languages)).toContain(row.url);
    }
  });

  test("no url is listed twice", () => {
    const urls = expanded.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("an empty shard produces an empty list, not a broken row", () => {
    // The fetch path returns [] on API failure, and Sitemaps 0.9 accepts an
    // empty <urlset>. What it must not do is emit a row with no url.
    expect(animeSitemapRows([])).toEqual([]);
  });
});
