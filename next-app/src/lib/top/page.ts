// What both ranking routes (/top and /top/[year]) render and say about
// themselves, in one place: the data the client tree takes, and the metadata.
//
// Server-side only (it fetches); no React.

import type { Metadata } from "next";
import type { Dict } from "@/lib/i18n";
import { OG_LOCALE, alternateOgLocales, type Lang } from "@/lib/i18n/lang";
import type { Locale } from "@/lib/i18n/locale";
import { buildAlternates } from "@/lib/seo/alternates";
import type { TopPageData } from "./data";
import { fetchTopRows, fetchTopYears } from "./fetch";
import { toTopItems } from "./items";
import { topItemListJsonLd } from "./jsonLd";
import { hasFilters, topCanonical, type TopState } from "./query";
import { topTitle } from "./titles";
import { isRankedYear, siteYear, stripYears, withYearListed } from "./years";

export interface LoadedTopPage {
  data: TopPageData;
  /** The schema.org ItemList of what the page lists. */
  jsonLd: ReturnType<typeof topItemListJsonLd>;
}

/**
 * The page for `state`, or null when there is no such page: a year with
 * nothing ranked. Judged by the years the API ranks, and — so that a year
 * whose first show was ranked a moment ago is not a 404 cached for five
 * minutes while the list of years catches up — by the ranking itself. When
 * the API does not answer, the page is the empty list, never a 404: the same
 * contract every hub page keeps.
 */
export async function loadTopPage(state: TopState, lang: Lang, locale: Locale, nowMs: number): Promise<LoadedTopPage | null> {
  const [rows, listed] = await Promise.all([fetchTopRows(state), fetchTopYears()]);
  let years = listed;
  if (state.year !== null && years !== null && !isRankedYear(years, state.year)) {
    if (!rows?.length) return null;
    // The list of years lags the ranking: this year has one all the same.
    years = withYearListed(years, state.year, rows.length);
  }
  const items = toTopItems(rows ?? [], lang);
  return {
    data: { state, items, strip: stripYears(years, siteYear(nowMs)) },
    jsonLd: topItemListJsonLd(
      topTitle(state, lang),
      topCanonical(state),
      items.map((i) => ({ id: i.id, title: i.title, place: i.place })),
      locale,
    ),
  };
}

/** Title, description, canonical and Open Graph; a filtered ranking is noindex (only the unfiltered ones are in the sitemap). */
export function topMetadata(state: TopState, lang: Lang, locale: Locale, dict: Dict): Metadata {
  const title = topTitle(state, lang);
  const description = `${title} — ${dict.topPage.metaSuffix}`;
  const canonical = topCanonical(state);
  return {
    title: { absolute: title },
    description,
    alternates: buildAlternates(canonical, locale),
    ...(hasFilters(state) ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      title,
      description,
      siteName: "AnimeGoClub",
      locale: OG_LOCALE[lang],
      alternateLocale: alternateOgLocales(lang),
      type: "website",
      url: canonical,
    },
    twitter: { card: "summary", title, description },
  };
}
