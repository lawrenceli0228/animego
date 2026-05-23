import type { MetadataRoute } from "next";
import { apiGet } from "@/lib/api";
import type { YearlyTopItem } from "@/lib/types";

// Public canonical origin. Sitemap URLs must be absolute and match the host
// search engines see, otherwise crawlers reject or de-duplicate them.
const SITE = "https://animegoclub.com";

// Number of anime detail pages to enumerate. Google's per-sitemap cap is
// 50,000 URLs; 100 covers the SEO-relevant head without re-fetching the
// whole catalog on every revalidate. Phase 4.4 can split via generateSitemaps
// once /anime/* page yield justifies a larger surface.
const YEARLY_TOP_LIMIT = 100;

// Revalidate window for the upstream Go API fetch. One hour keeps the
// sitemap reasonably fresh while letting the route stay cached between
// crawler hits.
const REVALIDATE_SECONDS = 3600;

/**
 * Season URL for the current quarter. Matches the App Router shape
 * /seasonal/[season]/[year] that Phase 4.2 will land. Hardcoded for now
 * because the seasonal page is not yet migrated; revisit when the route
 * is dynamic and we can derive season from server time.
 */
const CURRENT_SEASON_URL = `${SITE}/seasonal/spring/2026`;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticUrls: MetadataRoute.Sitemap = [
    {
      url: `${SITE}/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: CURRENT_SEASON_URL,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.9,
    },
  ];

  let animeUrls: MetadataRoute.Sitemap = [];
  try {
    const items = await apiGet<YearlyTopItem[]>(
      `/api/anime/yearly-top?limit=${YEARLY_TOP_LIMIT}`,
      { revalidate: REVALIDATE_SECONDS },
    );
    animeUrls = items.map((a) => ({
      url: `${SITE}/anime/${a.anilistId}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }));
  } catch (err) {
    // Graceful degradation: a sitemap that only lists the static URLs is
    // still valid per the Sitemaps 0.9 protocol. We never want a Go API
    // outage to turn /sitemap.xml into a 500, which would cause Googlebot
    // to drop the entire sitemap from its crawl queue.
    console.warn("[sitemap] yearly-top fetch failed:", err);
  }

  return [...staticUrls, ...animeUrls];
}
