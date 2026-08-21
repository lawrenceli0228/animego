import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { Suspense } from "react";
import SeasonNav from "@/components/seasonal/SeasonNav";
import SeasonalFilterChips from "@/components/seasonal/SeasonalFilterChips";
import AnimeCard from "@/components/anime/AnimeCard";
import { SubscriptionSetProvider } from "@/components/anime/SubscriptionSetProvider";
import SeasonalShowMore from "@/components/seasonal/SeasonalShowMore";
import { apiGetPaged } from "@/lib/api";
import { FILTER_GENRES, type FilterGenre } from "@/lib/contentLabels";
import { resolveLocale } from "@/lib/i18n/route";
import { pickTitle } from "@/lib/formatters";
import { buildAlternates } from "@/lib/seo/alternates";
import { OG_LOCALE, alternateOgLocales, type Lang } from "@/lib/i18n/lang";
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

const SEASONAL_PAGE_SIZE = 200;
const INITIAL_COUNT = 20;
const LOAD_MORE = 20;

const FORMATS = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA"] as const;
type Format = (typeof FORMATS)[number];

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
  lang: Lang,
): SeasonalAnime[] {
  let list = items;
  // `genre` is the raw AniList enum in the query string (the chips only
  // translate their label), so the whitelist check stays an English compare.
  if (genre && FILTER_GENRES.includes(genre as FilterGenre)) {
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

export default async function SeasonalPage({ params, searchParams }: SeasonalPageProps) {
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
  const [{ dict, lang }, items] = await Promise.all([
    resolveLocale(params),
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
        {/* No `lang` prop, still: the chips resolve their language client-side
            via useLang(). This used to be a workaround for getLang() being
            pinned to "zh"; now that the server resolves the route locale it is
            a deliberate difference. useLang() follows the `lang` COOKIE — the
            visitor's stated preference — which the LanguageProvider reconciles
            after hydration for every client leaf on the site. Handing these
            chips the route locale instead would make them the one control that
            ignores that preference. Reconciling URL locale against cookie
            preference is its own decision; do not settle it here. */}
        <SeasonalFilterChips filteredCount={filtered.length} />
      </Suspense>

      {displayed.length === 0 ? (
        <div style={emptyStyle}>{emptyLabel}</div>
      ) : (
        // Client provider around server-rendered children: the cards stay RSC
        // output and travel through the boundary as an already-rendered
        // `children` node, so this page does NOT become a Client Component.
        // Scope is the grid only — one subscription-set fetch shared by every
        // quick-add button, instead of one probe per card.
        <SubscriptionSetProvider>
          <div className="anime-grid-5col">
            {displayed.map((a, i) => (
              <AnimeCard key={a.anilistId} anime={a} lang={lang} prefetch={false} priority={i === 0} />
            ))}
          </div>
        </SubscriptionSetProvider>
      )}

      {hasMore && (
        <Suspense>
          <SeasonalShowMore lang={lang} currentCount={visibleCount} step={LOAD_MORE} />
        </Suspense>
      )}
    </main>
  );
}
