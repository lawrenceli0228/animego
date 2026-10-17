import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SeasonalBrowse from "@/components/seasonal/browse/SeasonalBrowse";
import { apiGetPaged } from "@/lib/api";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";
import { OG_LOCALE, alternateOgLocales, type Lang } from "@/lib/i18n/lang";
import { siteTime } from "@/lib/seasonal/clock";
import { toSeasonalItems } from "@/lib/seasonal/model";
import { parseBrowseState, queryFromRecord } from "@/lib/seasonal/state";
import type { SeasonalAnime } from "@/lib/types";

export const revalidate = 300;

const VALID_SEASONS = new Set(["spring", "summer", "fall", "winter"]);

type SeasonKey = "spring" | "summer" | "fall" | "winter";

const SEASON_CHAR: Record<SeasonKey, string> = {
  spring: "春",
  summer: "夏",
  fall: "秋",
  winter: "冬",
};

// A sentence template per language, not a label table: the two read
// differently enough ("2026年 春季新番" against "Spring 2026 Anime") that
// there is no shared skeleton to fill in. A third language writes its own
// line here, and tsc asks for it.
//
// Not lib/contentLabels.ts SEASON_LABEL, which is a different vocabulary —
// that one is keyed by AniList's "SPRING" and reads "春季"; this is the URL
// segment "spring" and the single character the heading wants.
const SEASON_HEADING: Record<Lang, (season: SeasonKey, year: number) => string> = {
  zh: (season, year) => `${year}年 ${SEASON_CHAR[season]}季新番`,
  en: (season, year) => `${season.charAt(0).toUpperCase()}${season.slice(1)} ${year} Anime`,
  // Same sentence as zh: 年/季/新番 and all four season characters are
  // script-identical, so only the template's own glyphs would have differed
  // and none of them do. SEASON_CHAR is shared rather than duplicated.
  "zh-Hant": (season, year) => `${year}年 ${SEASON_CHAR[season]}季新番`,
};

// The whole season in one request: the endpoint caps a page at 200 and a
// season runs to about a hundred, so every show is in the first page and the
// page can filter, sort and reveal without asking again.
const SEASONAL_PAGE_SIZE = 200;

const EMPTY_ITEMS: SeasonalAnime[] = [];

type SeasonalPageProps = PageProps<"/[lang]/seasonal/[season]/[year]">;

function parseSeasonYear(season: string, year: string): { season: SeasonKey; year: number } | null {
  if (!VALID_SEASONS.has(season)) return null;
  const yearNum = Number(year);
  if (!Number.isFinite(yearNum) || yearNum < 1990 || yearNum > 2100) return null;
  return { season: season as SeasonKey, year: yearNum };
}

function headingFor(season: SeasonKey, year: number, lang: Lang): string {
  return SEASON_HEADING[lang](season, year);
}

/**
 * This request's render time — a helper rather than Date.now() in the
 * component body, which react-hooks/purity rejects (same as the calendar
 * page). The page's countdowns start from it, so the first paint and
 * hydration agree; the browser's clock takes over after.
 */
function requestTime(): number {
  return Date.now();
}

export async function generateMetadata({
  params,
}: Pick<SeasonalPageProps, "params">): Promise<Metadata> {
  const { season, year } = await params;
  const parsed = parseSeasonYear(season, year);
  if (!parsed) return { title: "Seasonal Anime" };
  const { locale, lang, dict } = await resolveLocale(params);
  const title = headingFor(parsed.season, parsed.year, lang);
  const description = `${title} — ${dict.seasonPage.metaDescSuffix} ${dict.landing.hero.sub}`;
  const canonical = `/seasonal/${parsed.season}/${parsed.year}`;
  const altSeason = parsed.season;
  return {
    title: { absolute: title },
    description,
    alternates: buildAlternates(canonical, locale),
    openGraph: {
      title,
      description,
      siteName: "AnimeGoClub",
      locale: OG_LOCALE[lang],
      alternateLocale: alternateOgLocales(lang),
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

export default async function SeasonalPage({ params, searchParams }: SeasonalPageProps) {
  const { season, year } = await params;
  const parsed = parseSeasonYear(season, year);
  if (!parsed) notFound();

  const apiSeason = parsed.season.toUpperCase();
  const [{ lang }, rows, query] = await Promise.all([
    resolveLocale(params),
    apiGetPaged<SeasonalAnime>(
      `/api/anime/seasonal?season=${apiSeason}&year=${parsed.year}&page=1&perPage=${SEASONAL_PAGE_SIZE}`,
      { revalidate: 300 },
    )
      .then((env) => env.data ?? EMPTY_ITEMS)
      .catch(() => EMPTY_ITEMS),
    searchParams,
  ]);
  const nowMs = requestTime();

  // The heading and everything under it are one client tree: the filters, the sort,
  // the views and "show more" all work on this list in the browser, and every
  // show in it is still a real link in the HTML this request returns.
  return (
    <SeasonalBrowse
      items={toSeasonalItems(rows, lang)}
      initial={parseBrowseState(queryFromRecord(query))}
      serverNowMs={nowMs}
      season={parsed.season}
      year={parsed.year}
      clockYear={siteTime(nowMs).year}
      heading={headingFor(parsed.season, parsed.year, lang)}
    />
  );
}
