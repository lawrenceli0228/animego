import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import SeasonNav from "@/components/seasonal/SeasonNav";
import SeasonalFilters from "@/components/seasonal/SeasonalFilters";
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

// Fetch the full season in one shot (capped at 200 by the API). The
// legacy SeasonPage.jsx requested ?perPage=200 too — anything smaller
// regresses the user-visible count from ~96 back to 20. Client-side
// filtering and show-more pagination then operate on the cached list
// with zero extra round-trips.
//
// Note: the API param is `perPage` (Go-API + Express both use this).
// Earlier drafts of this page used the implicit default (20) which is
// the exact "20 vs 96" gap users reported.
const SEASONAL_PAGE_SIZE = 200;

// Empty fallback returned when the API throws. Keeps the page render
// strictly client-shaped (no error UI here — it just looks like "0
// anime") so a flapping API does not produce a 500.
const EMPTY_ITEMS: SeasonalAnime[] = [];

interface PageProps {
  params: Promise<{ season: string; year: string }>;
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

export async function generateMetadata({ params }: { params: PageProps["params"] }): Promise<Metadata> {
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

export default async function SeasonalPage({ params }: PageProps) {
  const { season, year } = await params;
  const parsed = parseSeasonYear(season, year);
  if (!parsed) notFound();

  const apiSeason = parsed.season.toUpperCase();
  const [dict, lang, items] = await Promise.all([
    getDict(),
    getLang(),
    // Fetch the full season once on the server, hand off to the client
    // <SeasonalFilters> for filter/sort/show-more. Page=1 + perPage=200
    // is enough to cover every real season (currently caps in the 90s
    // for any given quarter — see verify.md in the plan).
    apiGetPaged<SeasonalAnime>(
      `/api/anime/seasonal?season=${apiSeason}&year=${parsed.year}&page=1&perPage=${SEASONAL_PAGE_SIZE}`,
      { revalidate: 300 },
    )
      .then((env) => env.data ?? EMPTY_ITEMS)
      .catch(() => EMPTY_ITEMS),
  ]);

  const heading = headingFor(parsed.season, parsed.year, lang);

  return (
    <main className="container" style={containerStyle}>
      <h1 style={headingStyle}>{heading}</h1>

      <SeasonNav season={parsed.season} year={parsed.year} dict={dict} lang={lang} />

      <SeasonalFilters items={items} lang={lang} />
    </main>
  );
}
