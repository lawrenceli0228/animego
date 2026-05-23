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
  ApiPagedEnvelope,
} from "@/lib/types";

// Phase 8.0: HomePage replaces the LandingPage at /. The marketing page
// moved to /welcome. revalidate=60 mirrors trending freshness; seasonal
// + gems + schedule tolerate the same window.
export const revalidate = 60;

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

async function safeCompletedGems(): Promise<TrendingItem[]> {
  try {
    return await apiGet<TrendingItem[]>(
      "/api/anime/completed-gems?limit=6",
      { revalidate: 60 },
    );
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) {
      console.warn("[HomePage] completed-gems fetch failed:", err);
    }
    return [];
  }
}

async function safeSchedule(): Promise<ScheduleResponse> {
  try {
    return await apiGet<ScheduleResponse>("/api/anime/schedule", {
      revalidate: 60,
    });
  } catch (err) {
    console.warn("[HomePage] schedule fetch failed:", err);
    return EMPTY_SCHEDULE;
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

  const [dict, lang, seasonal, trending, gems, schedule] = await Promise.all([
    getDict(),
    getLang(),
    safeSeasonal(season, year),
    safeTrending(),
    safeCompletedGems(),
    safeSchedule(),
  ]);

  // Hero takes the top 5 of the current season; SeasonRankings shows the
  // full first page (overlap with hero is intentional, matches legacy).
  const heroList = seasonal.data.slice(0, 5);
  const rankingsList = seasonal.data;

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
        <CompletedGems items={gems} dict={dict} lang={lang} />
        <ActivityFeed dict={dict} lang={lang} />
        <SeasonRankings
          items={rankingsList}
          dict={dict}
          lang={lang}
          season={season}
          year={year}
        />
      </div>
    </main>
  );
}
