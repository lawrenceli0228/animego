import { describe, expect, test } from "bun:test";

import { LOCALES, localizePath } from "@/lib/i18n/locale";
import { SITE_ORIGIN } from "@/lib/seo/alternates";
import type { SitemapEntity } from "@/lib/people/types";
import {
  CHARACTER_SITEMAP_SHARDS,
  PEOPLE_SITEMAP_SHARDS,
  characterSitemapPath,
  characterSitemapRows,
  peopleSitemapPath,
  peopleSitemapUrls,
  personSitemapRows,
} from "./peopleSitemap";

const ROWS: SitemapEntity[] = [
  { anilistId: 133507, updatedAt: "2026-10-08T19:24:30Z" },
  { anilistId: 95185, updatedAt: "2026-09-01T00:00:00Z" },
];

describe("layout", () => {
  test("paths follow the generateSitemaps convention and stay off the page routes", () => {
    expect(peopleSitemapPath(0)).toBe("/sitemaps/people/sitemap/0.xml");
    expect(characterSitemapPath(3)).toBe("/sitemaps/characters/sitemap/3.xml");
    for (let id = 0; id < PEOPLE_SITEMAP_SHARDS; id++) {
      expect(peopleSitemapPath(id).startsWith("/person/")).toBe(false);
    }
  });

  test("one absolute url per shard, no duplicates", () => {
    const urls = peopleSitemapUrls();
    expect(urls).toHaveLength(PEOPLE_SITEMAP_SHARDS + CHARACTER_SITEMAP_SHARDS);
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) expect(url.startsWith(`${SITE_ORIGIN}/sitemaps/`)).toBe(true);
  });
});

describe("rows", () => {
  test("one url per page per locale, each with the full reciprocal language map", () => {
    const people = personSitemapRows(ROWS);
    expect(people).toHaveLength(ROWS.length * LOCALES.length);
    for (const p of ROWS) {
      for (const locale of LOCALES) {
        expect(people.map((r) => r.url)).toContain(`${SITE_ORIGIN}${localizePath(`/person/${p.anilistId}`, locale)}`);
      }
    }
    for (const row of people) {
      expect(Object.keys(row.alternates?.languages ?? {}).sort()).toEqual([...LOCALES].sort());
    }
    expect(characterSitemapRows(ROWS)[0].url).toBe(`${SITE_ORIGIN}/character/133507`);
  });

  test("lastmod is the row's own, not the time of the fetch", () => {
    for (const row of personSitemapRows(ROWS)) {
      const source = ROWS.find((p) => row.url.endsWith(`/person/${p.anilistId}`));
      expect(new Date(row.lastModified as Date).toISOString()).toBe(new Date(source!.updatedAt).toISOString());
    }
  });
});
