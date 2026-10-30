// /sitemaps/hubs/sitemap.xml — the hub pages: genres, studios, the rankings
// (/top and every year with one) and every season the catalogue has. A
// separate document from the static sitemap for the reason the anime shards
// are: it fetches, and the static one deliberately does not.

import type { MetadataRoute } from "next";
import { apiGet } from "@/lib/api";
import { hubSitemapRows, type HubsPayload } from "@/lib/seo/hubSitemap";
import { parseTopYears } from "@/lib/top/years";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    // Anonymous: the same answer for every reader (see lib/genre/fetch.ts).
    const [hubs, topYears] = await Promise.all([
      apiGet<HubsPayload>("/api/anime/hubs", { revalidate: 3600, auth: false }),
      apiGet<unknown>("/api/anime/top/years", { revalidate: 3600, auth: false }),
    ]);
    return hubSitemapRows(hubs, parseTopYears(topYears), new Date());
  } catch (err) {
    // Same contract as the anime shards: an empty but well-formed <urlset>
    // over a 500 that would drop the document from the crawl queue.
    console.warn("[sitemap] hubs fetch failed:", err);
    return [];
  }
}
