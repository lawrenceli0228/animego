import type { MetadataRoute } from "next";
import { SITE_ORIGIN as SITE } from "@/lib/seo/alternates";
import { expandLocales } from "@/lib/seo/sitemapEntry";
import { characterPath, personPath } from "@/lib/people/paths";
import type { SitemapEntity } from "@/lib/people/types";

/**
 * The indexed person and character pages, sharded like the anime catalogue
 * (animeSitemap.ts, whose notes on modulo shards and on why there is no index
 * document apply here unchanged).
 *
 * Only pages that ask to be indexed are listed — the go-api listing applies
 * the same threshold the page's robots tag does (internal/people), so the
 * sitemap never advertises a noindex page. Four shards each: one URL per page
 * per locale, and the shards should sit well under Google's 50,000 per file
 * as the credit tables fill in, because changing a shard count moves most
 * pages into another file.
 */
export const PEOPLE_SITEMAP_SHARDS = 4;
export const CHARACTER_SITEMAP_SHARDS = 4;

/** Where Next publishes shard `id` of app/sitemaps/people/sitemap.ts. */
export function peopleSitemapPath(id: number): string {
  return `/sitemaps/people/sitemap/${id}.xml`;
}

/** Where Next publishes shard `id` of app/sitemaps/characters/sitemap.ts. */
export function characterSitemapPath(id: number): string {
  return `/sitemaps/characters/sitemap/${id}.xml`;
}

/** Every person and character sitemap URL, absolute, for robots.txt. */
export function peopleSitemapUrls(): string[] {
  return [
    ...Array.from({ length: PEOPLE_SITEMAP_SHARDS }, (_, id) => `${SITE}${peopleSitemapPath(id)}`),
    ...Array.from({ length: CHARACTER_SITEMAP_SHARDS }, (_, id) => `${SITE}${characterSitemapPath(id)}`),
  ];
}

/**
 * API rows to sitemap rows, one per page per locale. lastmod is the row's:
 * the latest change to the profile or to any title the page lists.
 */
function rows(items: readonly SitemapEntity[], pathOf: (id: number) => string): MetadataRoute.Sitemap {
  return items.flatMap((item) =>
    expandLocales({
      path: pathOf(item.anilistId),
      lastModified: new Date(item.updatedAt),
      changeFrequency: "weekly",
      priority: 0.6,
    }),
  );
}

export function personSitemapRows(items: readonly SitemapEntity[]): MetadataRoute.Sitemap {
  return rows(items, personPath);
}

export function characterSitemapRows(items: readonly SitemapEntity[]): MetadataRoute.Sitemap {
  return rows(items, characterPath);
}
