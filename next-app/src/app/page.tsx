import type { Metadata } from "next";
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
// dynamic = "force-dynamic" instead of revalidate = 60:
// The homepage aggregates 6 different upstream fetches with different
// freshness needs (schedule changes hourly as Mongo rotates the
// window; trending tightens every minute; yearly-top barely changes).
// A single page-level revalidate window forces every fetch through
// the same ISR cache and effectively silences each fetcher's own
// `cache` / `revalidate` option — that's how schedule ended up
// showing day-old tab counts even after we switched it to "no-store"
// (the page-level revalidate=60 overrode it). Force-dynamic keeps
// the page SSR per request; each safe* fetcher then honors its own
// revalidate / cache mode, so schedule stays live while trending /
// yearly-top can still cache. Cost: ~one server render per page
// hit. The actual cards still benefit from Cloudflare HTML cache
// in prod, and the per-page render is cheap because the upstream
// API responses are themselves cached on the Express side.
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

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict();
  // Use the legacy site title and a discovery-oriented description.
  // The marketing copy from LandingPage now lives on /welcome.
  return {
    title: { absolute: "AnimeGoClub" },
    description: dict.landing.hero.sub,
    alternates: { canonical: "/" },
    openGraph: {
      title: "AnimeGoClub",
      description: dict.landing.hero.sub,
      url: "/",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "AnimeGoClub",
      description: dict.landing.hero.sub,
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
