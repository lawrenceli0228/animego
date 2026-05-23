import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import AnimeCard from "@/components/anime/AnimeCard";
import SeasonNav from "@/components/seasonal/SeasonNav";
import SeasonalPagination from "@/components/seasonal/SeasonalPagination";
import { apiGetPaged } from "@/lib/api";
import { getDict, getDictByLang, getLang } from "@/lib/i18n";
import type { SeasonalAnime } from "@/lib/types";

// 5-minute ISR window keeps the seasonal listing fresh enough for the
// "new airing today" use case without forcing a Go-API hit on every
// request. Aligned with the explicit fetch revalidate below so Next
// does not generate two different cache buckets.
export const revalidate = 300;

const VALID_SEASONS = new Set(["spring", "summer", "fall", "winter"]);

type SeasonKey = "spring" | "summer" | "fall" | "winter";

const SEASON_ZH: Record<SeasonKey, string> = {
  spring: "春",
  summer: "夏",
  fall: "秋",
  winter: "冬",
};

// Empty envelope returned when the Go API throws. Keeps the page render
// strictly client-shaped (no error UI here -- it just looks like "0
// anime") so a flapping API does not produce a 500.
const EMPTY_PAGE = {
  data: [] as SeasonalAnime[],
  total: 0,
  page: 1,
  hasMore: false,
  nextPage: null,
};

interface PageProps {
  params: Promise<{ season: string; year: string }>;
  searchParams: Promise<{ page?: string }>;
}

function parseSeasonYear(season: string, year: string): { season: SeasonKey; year: number } | null {
  if (!VALID_SEASONS.has(season)) return null;
  const yearNum = Number(year);
  if (!Number.isFinite(yearNum) || yearNum < 1990 || yearNum > 2100) return null;
  return { season: season as SeasonKey, year: yearNum };
}

function headingFor(season: SeasonKey, year: number, lang: "zh" | "en"): string {
  if (lang === "zh") {
    return `${year}年 ${SEASON_ZH[season]}季新番`;
  }
  const capitalized = season.charAt(0).toUpperCase() + season.slice(1);
  return `${capitalized} ${year} Anime`;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { season, year } = await params;
  const parsed = parseSeasonYear(season, year);
  if (!parsed) return { title: "Seasonal Anime" };
  const lang = await getLang();
  const dict = getDictByLang(lang);
  const title = headingFor(parsed.season, parsed.year, lang);
  const description =
    lang === "zh"
      ? `${title} — 评分、集数、剧情简介一站搞定。${dict.landing.hero.sub}`
      : `${title} -- scores, episodes, synopses in one place. ${dict.landing.hero.sub}`;
  const canonical = `/seasonal/${parsed.season}/${parsed.year}`;
  const altSeason = parsed.season; // canonical path identical between locales
  return {
    title: { absolute: title },
    description,
    alternates: {
      canonical,
      languages: {
        "zh-CN": canonical,
        "en-US": `${canonical}?lang=en`,
      },
    },
    openGraph: {
      title,
      description,
      siteName: "AnimeGo",
      locale: lang === "en" ? "en_US" : "zh_CN",
      alternateLocale: lang === "en" ? ["zh_CN"] : ["en_US"],
      type: "website",
      url: canonical,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
    other: { "x-season-key": altSeason },
  };
}

const containerStyle: CSSProperties = {
  paddingTop: 40,
  paddingBottom: 40,
};

const headingStyle: CSSProperties = {
  fontSize: "clamp(22px,3vw,34px)",
  marginBottom: 24,
  color: "#ffffff",
  fontFamily: "'Sora', sans-serif",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: 12,
  animation: "fadeUp 0.4s ease both",
};

const emptyStyle: CSSProperties = {
  textAlign: "center",
  padding: "60px 0",
  color: "rgba(235,235,245,0.30)",
  fontFamily: "'Sora', sans-serif",
};

const countStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(235,235,245,0.30)",
  marginBottom: 12,
  display: "block",
};

export default async function SeasonalPage({ params, searchParams }: PageProps) {
  const { season, year } = await params;
  const parsed = parseSeasonYear(season, year);
  if (!parsed) notFound();

  const { page: pageStr } = await searchParams;
  const page = Math.max(1, Number(pageStr) || 1);

  const apiSeason = parsed.season.toUpperCase();
  const [dict, lang, response] = await Promise.all([
    getDict(),
    getLang(),
    apiGetPaged<SeasonalAnime>(
      `/api/anime/seasonal?season=${apiSeason}&year=${parsed.year}&page=${page}`,
      { revalidate: 300 },
    ).catch(() => EMPTY_PAGE),
  ]);

  const heading = headingFor(parsed.season, parsed.year, lang);
  const items = response.data;

  return (
    <main className="container" style={containerStyle}>
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: none; }
        }
      `}</style>
      <h1 style={headingStyle}>{heading}</h1>

      <SeasonNav season={parsed.season} year={parsed.year} dict={dict} lang={lang} />

      {response.total > 0 ? (
        <span style={countStyle}>
          {response.total} {lang === "zh" ? "部" : "anime"}
        </span>
      ) : null}

      {items.length === 0 ? (
        <div style={emptyStyle}>{dict.anime.noAnime}</div>
      ) : (
        <div style={gridStyle}>
          {items.map((a) => (
            <AnimeCard key={a.anilistId} anime={a} lang={lang} prefetch={false} />
          ))}
        </div>
      )}

      <SeasonalPagination
        season={parsed.season}
        year={parsed.year}
        page={page}
        total={response.total}
        lang={lang}
      />
    </main>
  );
}
