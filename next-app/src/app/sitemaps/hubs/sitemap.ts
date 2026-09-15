// /sitemaps/hubs/sitemap.xml — the hub pages: genres, studios, years and
// every season the catalogue has. A separate document from the static
// sitemap for the reason the anime shards are: it fetches, and the static
// one deliberately does not.

import type { MetadataRoute } from "next";
import { apiGet } from "@/lib/api";
import { hubSitemapRows, type HubsPayload } from "@/lib/seo/hubSitemap";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const hubs = await apiGet<HubsPayload>("/api/anime/hubs", { revalidate: 3600 });
    return hubSitemapRows(hubs, new Date());
  } catch (err) {
    // Same contract as the anime shards: an empty but well-formed <urlset>
    // over a 500 that would drop the document from the crawl queue.
    console.warn("[sitemap] hubs fetch failed:", err);
    return [];
  }
}
