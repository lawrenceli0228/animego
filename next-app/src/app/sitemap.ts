import type { MetadataRoute } from "next";
import { expandLocales, type SitemapEntry } from "@/lib/seo/sitemapEntry";

// Stays at app/ rather than moving under app/[lang]/ with the route tree.
// This document enumerates every locale itself; a per-locale /en/sitemap.xml
// would be a second document making claims about the same URLs.
//
// It also stays a plain sitemap.ts rather than growing generateSitemaps,
// which would move it to /sitemap/0.xml and retire the one sitemap URL
// Search Console has on file and robots.txt has always pointed at. The
// anime catalogue is sharded at app/sitemaps/anime/ instead, and robots.txt
// names every file.
//
// What used to be here: an /api/anime/yearly-top fetch asking for 100 rows
// from a handler that caps at 20 — a silent clamp that published 20 of
// 17,603 anime. It moved rather than being fixed in place, because the
// endpoint was answering a different question (one year's top-rated titles)
// and no limit would have made it enumerate a catalogue.

/**
 * Keep regenerating hourly now that nothing in here fetches.
 *
 * This used to be implicit: the route held an `apiGet` with a revalidate
 * window, and that fetch was what kept the document from being frozen at
 * build time. Moving the anime rows out took the fetch with it, which would
 * have quietly pinned `currentSeasonPath(new Date())` to whenever the Docker
 * image was built — reintroducing, by accident, the exact stale-season bug
 * the function below exists to have fixed.
 */
export const revalidate = 3600;

const SEASONS = ["winter", "spring", "summer", "fall"] as const;

/**
 * The season URL for the current quarter.
 *
 * Derived, not hardcoded. This was a literal `/seasonal/spring/2026` with a
 * comment promising to revisit it "when the route is dynamic" — the route
 * became dynamic and the literal stayed, so the sitemap has been handing
 * Google a stale quarter while next.config.ts computed the right one for its
 * own 308. Two sources of truth for "what season is it" is one too many when
 * only one of them is what a crawler reads.
 */
function currentSeasonPath(now: Date): string {
  return `/seasonal/${SEASONS[Math.floor(now.getMonth() / 3)]}/${now.getFullYear()}`;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticEntries: SitemapEntry[] = [
    { path: "/", lastModified: now, changeFrequency: "daily", priority: 1.0 },
    {
      path: currentSeasonPath(now),
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      // P11: weekly airing calendar (migrated off legacy SPA).
      path: "/calendar",
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.6,
    },
    {
      // P11: FAQ (migrated off legacy SPA).
      path: "/faq",
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.4,
    },
    { path: "/terms", lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { path: "/privacy", lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { path: "/copyright", lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ];

  return staticEntries.flatMap(expandLocales);
}
