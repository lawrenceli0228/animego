import type { Metadata } from "next";
import type { CSSProperties } from "react";
import HeroCarousel from "@/components/anime/HeroCarousel";
import TrendingSection from "@/components/home/TrendingSection";
import ContinueWatching from "@/components/anime/ContinueWatching";
import WeeklySchedule, {
  type ScheduleResponse,
} from "@/components/anime/WeeklySchedule";
import CompletedGems from "@/components/home/CompletedGems";
import ActivityFeed from "@/components/social/ActivityFeed";
import SeasonRankings from "@/components/home/SeasonRankings";
import { apiGet, apiGetPaged, ApiError } from "@/lib/api";
import { getDict, getLang } from "@/lib/i18n";
import type {
  SeasonalAnime,
  TrendingItem,
  YearlyTopItem,
  ApiPagedEnvelope,
} from "@/lib/types";

// Phase 8.0: HomePage replaces the LandingPage at /. The marketing
// page moved to /welcome.
//
// dynamic = "force-dynamic" — and it STAYS, deliberately:
//
//   1. go-api is unreachable at `next build` (GO_API_INTERNAL_URL is a runtime
//      env, not a build arg), so ISR would prerender an EMPTY homepage and keep
//      serving it for the whole revalidate window after every deploy. Detail
//      pages dodge this via generateStaticParams → [] → ISR-on-demand; a
//      paramless static route has no such escape hatch. force-dynamic keeps the
//      page rendering REAL data on first request.
//   2. The two per-user sections (ContinueWatching, ActivityFeed) are now
//      CLIENT islands, so this dynamic HTML is byte-identical for every
//      anonymous visitor — no per-user data, no cache-poisoning risk.
//
// Caching is therefore done at the EDGE, not via Next ISR: a Cloudflare Cache
// Rule on `/` with Edge TTL "override origin" (60s) + stale-while-revalidate
// caches the anonymous render despite the no-store header force-dynamic emits,
// and bypasses on the session / refreshToken cookie so logged-in users always
// hit the origin. Anonymous + crawler traffic (the load that drove the
// detail-page 500 incident) is served from the CF edge; the origin renders
// ~once per 60s per PoP. Per-fetcher freshness (schedule no-store, etc.) still
// holds at the origin; CF just caps how often anonymous traffic reaches it.
export const dynamic = "force-dynamic";

type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";

function getCurrentSeason(): Season {
  const m = new Date().getMonth() + 1;
  if (m <= 3) return "WINTER";
  if (m <= 6) return "SPRING";
  if (m <= 9) return "SUMMER";
  return "FALL";
}

const EMPTY_PAGE: ApiPagedEnvelope<SeasonalAnime> = {
  data: [],
  total: 0,
  page: 1,
  hasMore: false,
  nextPage: null,
};

const EMPTY_SCHEDULE: ScheduleResponse = { today: "", groups: {} };

async function safeSeasonal(
  season: Season,
  year: number,
): Promise<ApiPagedEnvelope<SeasonalAnime>> {
  try {
    return await apiGetPaged<SeasonalAnime>(
      `/api/anime/seasonal?season=${season}&year=${year}&page=1`,
      { revalidate: 300 },
    );
  } catch (err) {
    console.warn("[HomePage] seasonal fetch failed:", err);
    return EMPTY_PAGE;
  }
}

async function safeTrending(): Promise<TrendingItem[]> {
  try {
    return await apiGet<TrendingItem[]>("/api/anime/trending?limit=10", {
      revalidate: 60,
    });
  } catch (err) {
    console.warn("[HomePage] trending fetch failed:", err);
    return [];
  }
}

// Match legacy useCompletedGems(10) — 10 cards in a 5-col grid (3 mobile / 2
// narrow). Endpoint returns a random sample per call; the component owns
// "换一批" client-side refetch, so revalidate stays low to avoid serving
// the same SSR cache for too long.
const COMPLETED_GEMS_LIMIT = 10;

async function safeCompletedGems(): Promise<TrendingItem[]> {
  try {
    return await apiGet<TrendingItem[]>(
      `/api/anime/completed-gems?limit=${COMPLETED_GEMS_LIMIT}`,
      { revalidate: 60 },
    );
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) {
      console.warn("[HomePage] completed-gems fetch failed:", err);
    }
    return [];
  }
}

// /api/anime/schedule is a rolling 7-day window keyed off "today".
// Mongo rotates the window every day, and within a day items get
// re-scored / re-counted as enrichment lands. With revalidate=60 Next
// 16 would serve a build-time static snapshot until the first stale
// hit triggers a background regen — so per-day counts on the tab bar
// (今天 18 / 周一 6 / ...) lag behind the legacy SPA by hours/days.
// cache: "no-store" forces every RSC render to re-fetch and matches
// the legacy useWeeklySchedule() React Query default (refetch on focus,
// no long stale window). Cost is one upstream HTTP per page hit, which
// the upstream nginx-cache layer can still absorb in prod.
async function safeSchedule(): Promise<ScheduleResponse> {
  try {
    return await apiGet<ScheduleResponse>("/api/anime/schedule", {
      cache: "no-store",
    });
  } catch (err) {
    console.warn("[HomePage] schedule fetch failed:", err);
    return EMPTY_SCHEDULE;
  }
}

async function safeYearlyTop(year: number): Promise<YearlyTopItem[]> {
  try {
    return await apiGet<YearlyTopItem[]>(
      `/api/anime/yearly-top?year=${year}&limit=10`,
      { revalidate: 300 },
    );
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) {
      console.warn("[HomePage] yearly-top fetch failed:", err);
    }
    return [];
  }
}

// Visually-hidden style for the SEO <h1> — keeps the hero design intact
// while giving the homepage a brand+category primary heading.
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

// schema.org Organization + WebSite for the homepage (the entity's
// canonical URL). inLanguage zh-CN + alternateName "AnimeGo" disambiguate
// us from the Russian piracy site "AnimeGO.org" that Google's AI Overview
// conflates with this brand; the SearchAction can earn a sitelinks box.
const HOME_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://animegoclub.com/#organization",
      name: "AnimeGoClub",
      alternateName: "AnimeGo",
      url: "https://animegoclub.com",
      logo: "https://animegoclub.com/favicon-192.png",
      description:
        "番剧追番与动漫发现平台 — 每季新番、评分、声优、弹幕评论与追番管理。",
      sameAs: ["https://github.com/lawrenceli0228/animego"],
    },
    {
      "@type": "WebSite",
      "@id": "https://animegoclub.com/#website",
      url: "https://animegoclub.com",
      name: "AnimeGoClub",
      alternateName: "AnimeGo",
      inLanguage: "zh-CN",
      publisher: { "@id": "https://animegoclub.com/#organization" },
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: "https://animegoclub.com/search?q={search_term_string}",
        },
        "query-input": "required name=search_term_string",
      },
    },
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict();
  // Homepage title + description lead with the brand and the 番剧 category
  // keyword (dict.meta.home*) so the brand+category query "animegoclub 番剧"
  // resolves to the homepage rather than a detail page.
  return {
    title: { absolute: dict.meta.homeTitle },
    description: dict.meta.homeDescription,
    alternates: {
      canonical: "/",
      languages: { "zh-CN": "/", "en-US": "/?lang=en" },
    },
    openGraph: {
      title: dict.meta.homeTitle,
      description: dict.meta.homeDescription,
      url: "/",
      type: "website",
      images: ["/og-default.png"],
    },
    twitter: {
      card: "summary_large_image",
      title: dict.meta.homeTitle,
      description: dict.meta.homeDescription,
      images: ["/og-default.png"],
    },
  };
}

export default async function HomePage() {
  const season = getCurrentSeason();
  const year = new Date().getFullYear();

  const [dict, lang, seasonal, trending, gems, schedule, yearlyTop] =
    await Promise.all([
      getDict(),
      getLang(),
      safeSeasonal(season, year),
      safeTrending(),
      safeCompletedGems(),
      safeSchedule(),
      safeYearlyTop(year),
    ]);

  // Hero takes the top 5 of the current season. SeasonRankings is the
  // 年度榜 (annual top 10) ranking list — not the same data set as the
  // season grid, matches legacy client/src/components/home/SeasonRankings.jsx.
  const heroList = seasonal.data.slice(0, 5);

  return (
    <main>
      {/* SEO: the homepage's primary heading is the brand + category, not
          the rotating hero anime title (an <h2> inside HeroCarousel).
          Visually hidden so the hero design is unchanged. */}
      <h1 style={SR_ONLY}>{dict.meta.homeH1}</h1>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(HOME_JSON_LD) }}
      />
      <HeroCarousel animeList={heroList} dict={dict} lang={lang} />
      <div
        className="container"
        style={{ paddingTop: 8, paddingBottom: 60 }}
      >
        <TrendingSection items={trending} dict={dict} lang={lang} />
        <ContinueWatching dict={dict} lang={lang} />
        <WeeklySchedule schedule={schedule} dict={dict} lang={lang} />
        <CompletedGems
          initialItems={gems}
          dict={dict}
          lang={lang}
          limit={COMPLETED_GEMS_LIMIT}
        />
        <ActivityFeed dict={dict} lang={lang} />
        <SeasonRankings items={yearlyTop} dict={dict} lang={lang} />
      </div>
    </main>
  );
}
