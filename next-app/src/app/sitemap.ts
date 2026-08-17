import type { MetadataRoute } from "next";
import { apiGet } from "@/lib/api";
import { DEFAULT_LOCALE, LOCALES, localizePath, type Locale } from "@/lib/i18n/locale";
import { SITE_ORIGIN as SITE } from "@/lib/seo/alternates";
import type { YearlyTopItem } from "@/lib/types";

// Stays at app/ rather than moving under app/[lang]/ with the route tree.
// There is one sitemap for the site and it enumerates every locale itself; a
// per-locale /en/sitemap.xml would be a second document making claims about
// the same URLs.

// Number of anime detail pages to enumerate. Google's per-sitemap cap is
// 50,000 URLs; 100 covers the SEO-relevant head without re-fetching the
// whole catalog on every revalidate. Phase 4.4 can split via generateSitemaps
// once /anime/* page yield justifies a larger surface.
const YEARLY_TOP_LIMIT = 100;

// Revalidate window for the upstream Go API fetch. One hour keeps the
// sitemap reasonably fresh while letting the route stay cached between
// crawler hits.
const REVALIDATE_SECONDS = 3600;

type Entry = Omit<MetadataRoute.Sitemap[number], "url"> & { path: string };

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

/**
 * Pages whose CONTENT exists only in the default locale.
 *
 * The legal pages are hardcoded Chinese JSX with no English body. Listing an
 * /en/ URL for them, or advertising one as an alternate, would tell Google
 * about an English page that serves Chinese — the exact defect this project
 * spent a commit removing from eight route files. They ship as a single
 * default-locale URL with no alternates until someone translates them.
 */
const UNTRANSLATED_PATHS = new Set(["/terms", "/privacy", "/copyright"]);

/**
 * One sitemap row per locale, cross-linked.
 *
 * Google reads sitemap `alternates.languages` the same way it reads the
 * `<link rel="alternate">` tags in the head, reciprocity requirement
 * included — so every row lists every locale, itself among them. Both
 * surfaces derive from LOCALES for that reason: a sitemap that disagrees
 * with the pages it lists is worse than one that says nothing.
 */
function expand(entry: Entry): MetadataRoute.Sitemap {
  const { path, ...rest } = entry;

  if (UNTRANSLATED_PATHS.has(path)) {
    return [{ ...rest, url: `${SITE}${localizePath(path, DEFAULT_LOCALE)}` }];
  }

  const languages = Object.fromEntries(
    LOCALES.map((locale) => [locale, `${SITE}${localizePath(path, locale)}`]),
  );

  return LOCALES.map((locale: Locale) => ({
    ...rest,
    url: `${SITE}${localizePath(path, locale)}`,
    alternates: { languages },
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticEntries: Entry[] = [
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

  let animeEntries: Entry[] = [];
  try {
    const items = await apiGet<YearlyTopItem[]>(
      `/api/anime/yearly-top?limit=${YEARLY_TOP_LIMIT}`,
      { revalidate: REVALIDATE_SECONDS },
    );
    animeEntries = items.map((a) => ({
      path: `/anime/${a.anilistId}`,
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

  return [...staticEntries, ...animeEntries].flatMap(expand);
}
