import type { MetadataRoute } from "next";
import { apiGet } from "@/lib/api";
import { ANIME_SITEMAP_SHARDS, animeSitemapRows } from "@/lib/seo/animeSitemap";
import type { SitemapAnime } from "@/lib/types";

// The anime catalogue, sharded.
//
// This is the half of the sitemap that was missing. /sitemap.xml built its
// anime rows out of /api/anime/yearly-top, an endpoint that answers "the
// top-rated titles of one year" and caps itself at 20 — so the site
// advertised 20 of 17,603 anime to Google and the other 99.9% were
// reachable only by a crawler guessing ids. The request asked for 100 and
// the cap clamped it silently, which is why nothing ever looked broken.
//
// It lives at /sitemaps/anime/ rather than /anime/ because a route segment
// at app/anime/ would be a static sibling of app/[lang]/, and static
// segments win — /anime/{id}, the site's whole SEO surface, would start
// resolving against a segment with no page to serve it.
//
// The proxy leaves these URLs alone: NON_PAGE_PATH in src/proxy.ts skips
// anything ending in a file extension, so .xml is never rewritten under a
// locale prefix. That guard exists because rewriting /sitemap.xml to
// /zh-Hans/sitemap.xml 404s it.

// Revalidate window for the upstream Go API fetch. One hour keeps the
// sitemap reasonably fresh while letting the route stay cached between
// crawler hits.
const REVALIDATE_SECONDS = 3600;

/**
 * The shard list, from a constant rather than a count query.
 *
 * This runs at build time, and a build-time fetch is a build-time failure
 * mode: a Go API that is unreachable while the image builds — which is the
 * normal case, the API is not up during `docker build` — would return zero
 * shards and bake a site with no anime sitemap at all. A constant cannot
 * fail. The per-shard fetch below still degrades gracefully on its own.
 */
export function generateSitemaps(): Array<{ id: number }> {
  return Array.from({ length: ANIME_SITEMAP_SHARDS }, (_, id) => ({ id }));
}

export default async function sitemap({
  id,
}: {
  // Next 16 changed this: `id` is a promise resolving to a STRING, where
  // earlier versions passed the number through directly. The framework's
  // own example still does arithmetic on it and survives on JS coercion;
  // parsing is the honest version, and it is what makes the range check
  // below mean anything.
  id: Promise<string>;
}): Promise<MetadataRoute.Sitemap> {
  const shard = Number(await id);

  // A shard outside the declared set can only come from a hand-typed URL.
  // Returning empty beats forwarding it: the Go endpoint would answer 400,
  // the catch below would swallow it, and the difference would show up as
  // a warning in a log nobody reads.
  if (!Number.isInteger(shard) || shard < 0 || shard >= ANIME_SITEMAP_SHARDS) {
    return [];
  }

  try {
    const items = await apiGet<SitemapAnime[]>(
      `/api/anime/sitemap?shards=${ANIME_SITEMAP_SHARDS}&shard=${shard}`,
      { revalidate: REVALIDATE_SECONDS },
    );
    return animeSitemapRows(items);
  } catch (err) {
    // Graceful degradation, same contract as the static sitemap: an empty
    // but well-formed <urlset> is valid per Sitemaps 0.9. A 500 here would
    // make Googlebot drop the document from its crawl queue entirely,
    // which costs more than one stale hour.
    console.warn(`[sitemap] anime shard ${shard} fetch failed:`, err);
    return [];
  }
}
