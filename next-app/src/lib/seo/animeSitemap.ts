import type { MetadataRoute } from "next";
import { SITE_ORIGIN as SITE } from "@/lib/seo/alternates";
import { expandLocales } from "@/lib/seo/sitemapEntry";
import type { SitemapAnime } from "@/lib/types";

/**
 * How many files the anime catalogue is split across.
 *
 * The site publishes one URL per anime per locale, so the ceiling that
 * matters is Google's 50,000 `<url>` entries per sitemap, not the anime
 * count: 17,603 anime × 3 locales is 52,809 URLs and would overflow a
 * single document by itself.
 *
 * Four shards leaves a lot of headroom on purpose — the catalogue can
 * roughly triple before a fifth is needed — because raising this number is
 * not free. Shards are `anilist_id % ANIME_SITEMAP_SHARDS`, so changing it
 * moves most anime into a different file, and a crawler re-reading the set
 * sees the whole catalogue as churn. Prefer to change it rarely.
 *
 * The Go endpoint takes the shard count as a parameter and has no opinion
 * about it, so this constant is the only place the layout is decided.
 */
export const ANIME_SITEMAP_SHARDS = 4;

/**
 * The path Next publishes shard `id` at.
 *
 * Derived from the `generateSitemaps` convention for `app/sitemaps/anime/
 * sitemap.ts`, which is `<segment>/sitemap/<id>.xml`. It lives here so
 * robots.txt and the sitemap route cannot disagree — robots.txt naming a
 * file that does not exist is the failure mode this indirection exists to
 * prevent, and it is silent: the sitemap still works, Google just never
 * finds it.
 *
 * Note this is NOT under `/anime/`. A route segment at `app/anime/` would
 * be a static sibling of `app/[lang]/`, and static segments win — which
 * would put the site's most valuable URLs, `/anime/{id}`, behind a segment
 * that has no page to serve them.
 */
export function animeSitemapPath(id: number): string {
  return `/sitemaps/anime/sitemap/${id}.xml`;
}

/**
 * Every anime sitemap URL, absolute, for the `Sitemap:` lines in robots.txt.
 *
 * robots.txt takes any number of Sitemap directives and Google reads all of
 * them, which is why this set needs no index document — Next's sitemap
 * convention emits `<urlset>` and cannot emit `<sitemapindex>`, and
 * hand-rolling one would mean hand-rolling the hreflang XML with it.
 */
export function animeSitemapUrls(): string[] {
  return Array.from(
    { length: ANIME_SITEMAP_SHARDS },
    (_, id) => `${SITE}${animeSitemapPath(id)}`,
  );
}

/**
 * API rows to sitemap rows, one per anime per locale.
 *
 * Pure, and exported for that reason: the route module around it can only be
 * tested by mocking `@/lib/api`, and `mock.module` in bun:test is process-
 * global — a mock installed here would follow into every other test file
 * sharing the process, which is a failure this repo has already paid for
 * once. Everything worth asserting about the anime sitemap is in here.
 */
export function animeSitemapRows(items: readonly SitemapAnime[]): MetadataRoute.Sitemap {
  return items.flatMap((a) =>
    expandLocales({
      path: `/anime/${a.anilistId}`,
      // The row's real modification time. The sitemap this replaces sent
      // `new Date()` for every row on every fetch, which told Google the
      // whole catalogue had changed one second ago — a claim it can
      // disprove by crawling, and the documented response to a lastmod it
      // cannot trust is to stop trusting lastmod for the site.
      lastModified: new Date(a.updatedAt),
      changeFrequency: "weekly",
      priority: 0.8,
    }),
  );
}
