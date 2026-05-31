import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { Suspense } from "react";
import SeasonNav from "@/components/seasonal/SeasonNav";
import SeasonalFilterChips, { GENRES } from "@/components/seasonal/SeasonalFilterChips";
import type { Genre } from "@/components/seasonal/SeasonalFilterChips";
import AnimeCard from "@/components/anime/AnimeCard";
import SeasonalShowMore from "@/components/seasonal/SeasonalShowMore";
import { apiGetPaged } from "@/lib/api";
import { getDict, getDictByLang, getLang } from "@/lib/i18n";
import { pickTitle } from "@/lib/formatters";
import type { SeasonalAnime } from "@/lib/types";

export const revalidate = 300;

const VALID_SEASONS = new Set(["spring", "summer", "fall", "winter"]);

type SeasonKey = "spring" | "summer" | "fall" | "winter";

const SEASON_ZH: Record<SeasonKey, string> = {
  spring: "春",
  summer: "夏",
  fall: "秋",
  winter: "冬",
};

const SEASONAL_PAGE_SIZE = 200;
const INITIAL_COUNT = 20;
const LOAD_MORE = 20;

const FORMATS = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA"] as const;
type Format = (typeof FORMATS)[number];

const EMPTY_ITEMS: SeasonalAnime[] = [];

interface PageProps {
  params: Promise<{ season: string; year: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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

function getString(v: string | string[] | undefined): string {
  if (!v) return "";
  return Array.isArray(v) ? v[0] : v;
}

function applyFilters(
  items: SeasonalAnime[],
  genre: string,
  format: string,
  status: string,
  sortBy: string,
  lang: "zh" | "en",
): SeasonalAnime[] {
  let list = items;
  if (genre && GENRES.includes(genre as Genre)) {
    list = list.filter((a) => a.genres?.includes(genre));
  }
  if (format && FORMATS.includes(format as Format)) {
    list = list.filter((a) => a.format === format);
  }
  if (status) {
    list = list.filter((a) => a.status === status);
  }

  const sorted = [...list];
  switch (sortBy) {
    case "title":
      sorted.sort((a, b) => pickTitle(a, lang).localeCompare(pickTitle(b, lang)));
      break;
    case "format":
      sorted.sort(
        (a, b) =>
          FORMATS.indexOf(a.format as Format) - FORMATS.indexOf(b.format as Format) ||
          (b.averageScore ?? 0) - (a.averageScore ?? 0),
      );
      break;
    default:
      break;
  }
  return sorted;
}

export async function generateMetadata({ params }: { params: PageProps["params"] }): Promise<Metadata> {
  const { season, year } = await params;
  const parsed = parseSeasonYear(season, year);
  if (!parsed) return { title: "Seasonal Anime" };
  const lang = await getLang();
  const dict = getDictByLang(lang);
  const title = headingFor(parsed.season, parsed.year, lang);
  const description = `${title} — ${dict.seasonPage.metaDescSuffix} ${dict.landing.hero.sub}`;
  const canonical = `/seasonal/${parsed.season}/${parsed.year}`;
  const altSeason = parsed.season;
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

const emptyStyle: CSSProperties = {
  textAlign: "center",
  padding: "60px 0",
  color: "rgba(235,235,245,0.30)",
  fontFamily: "'Sora', sans-serif",
};

export default async function SeasonalPage({ params, searchParams }: PageProps) {
  const { season, year } = await params;
  const parsed = parseSeasonYear(season, year);
  if (!parsed) notFound();

  const sp = await searchParams;
  const genre = getString(sp.genre);
  const format = getString(sp.format);
  const status = getString(sp.status);
  const sortBy = getString(sp.sort) || "score";
  const visibleCount = Math.max(INITIAL_COUNT, Number(getString(sp.show)) || INITIAL_COUNT);

  const apiSeason = parsed.season.toUpperCase();
  const [dict, lang, items] = await Promise.all([
    getDict(),
    getLang(),
    apiGetPaged<SeasonalAnime>(
      `/api/anime/seasonal?season=${apiSeason}&year=${parsed.year}&page=1&perPage=${SEASONAL_PAGE_SIZE}`,
      { revalidate: 300 },
    )
      .then((env) => env.data ?? EMPTY_ITEMS)
      .catch(() => EMPTY_ITEMS),
  ]);

  const heading = headingFor(parsed.season, parsed.year, lang);
  const filtered = applyFilters(items, genre, format, status, sortBy, lang);
  const displayed = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;
  const emptyLabel = dict.seasonPage.noAnime;

  return (
    <main className="container" style={containerStyle}>
      <h1 style={headingStyle}>{heading}</h1>

      <SeasonNav season={parsed.season} year={parsed.year} dict={dict} lang={lang} />

      <Suspense>
        <SeasonalFilterChips lang={lang} filteredCount={filtered.length} />
      </Suspense>

      {displayed.length === 0 ? (
        <div style={emptyStyle}>{emptyLabel}</div>
      ) : (
        <div className="anime-grid-5col">
          {displayed.map((a, i) => (
            <AnimeCard key={a.anilistId} anime={a} lang={lang} prefetch={false} priority={i === 0} />
          ))}
        </div>
      )}

      {hasMore && (
        <Suspense>
          <SeasonalShowMore lang={lang} currentCount={visibleCount} step={LOAD_MORE} />
        </Suspense>
      )}
    </main>
  );
}
