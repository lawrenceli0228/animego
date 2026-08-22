// The schema.org TVSeries document injected into /anime/[id].
//
// Pure logic, no React and no DOM, split out of page.tsx for the reason
// testImportHygiene.test.ts states as the repo convention: a test cannot
// import the page. `page.tsx -> DetailActions.tsx -> SubscriptionButton.tsx
// -> react-hot-toast`, and react-hot-toast touches `document` while its module
// is still evaluating, so any suite reaching it dies before its first
// assertion. Same split as episodeGridSkeleton.ts and continueWatchingState.ts
// next door.
//
// It is worth a module of its own rather than a grep-able line in the page,
// because the one rule it carries (see numberOfEpisodes below) is the kind
// that only stays true if something executes it.

import { formatFuzzyDate, pickSeoTitle, stripHtml } from "@/lib/formatters";
import type { Lang } from "@/lib/i18n/lang";
import type { AnimeDetail } from "@/lib/types";

export interface JsonLdAggregateRating {
  "@type": "AggregateRating";
  ratingValue: number;
  // Google rejects AggregateRating without a count (ratingCount/reviewCount).
  // Only Bangumi gives us a real vote count, so the rating is sourced from
  // Bangumi (score + votes), matching the visible "★ x.x (n)" badge on-page.
  ratingCount: number;
  bestRating: number;
  worstRating: number;
}

export interface JsonLdTVSeries {
  "@context": "https://schema.org";
  "@type": "TVSeries";
  name: string;
  alternateName?: string[];
  image?: string;
  description?: string;
  numberOfEpisodes?: number;
  startDate?: string;
  genre?: string[];
  aggregateRating?: JsonLdAggregateRating;
  productionCompany?: { "@type": "Organization"; name: string }[];
}

export function buildJsonLd(detail: AnimeDetail, lang: Lang): JsonLdTVSeries {
  const alts = [detail.titleRomaji, detail.titleEnglish, detail.titleNative].filter(
    (s): s is string => Boolean(s),
  );
  const ld: JsonLdTVSeries = {
    "@context": "https://schema.org",
    "@type": "TVSeries",
    // JSON-LD `name` is the most explicit "this page is about a thing called
    // X" signal on the page, so it takes the SERP-safe field for the same
    // reason <title> does.
    name: pickSeoTitle(detail, lang),
  };
  if (alts.length) ld.alternateName = alts;
  if (detail.coverImageUrl) ld.image = detail.coverImageUrl;
  const desc = stripHtml(detail.description || "");
  if (desc) ld.description = desc;
  // R3, and the reason AnimeDetail carries two episode counts instead of one.
  //
  // `detail.episodes` is AniList's authoritative total. `detail.episodesBgm`
  // is a sweep's inference from an external episode source, and it is
  // populated for exactly the rows this one is NULL for — so a fallback here
  // would fire precisely when it must not.
  //
  // numberOfEpisodes is not a number on a page. It is a machine-readable
  // claim about the work, addressed to a search engine that will treat it as
  // fact and may surface it away from any page that could qualify it. The
  // badge and the episode grid on this same route DO fall back to the
  // inferred count; this line is where that permission stops.
  //
  // Omitting the property entirely is the correct answer when the
  // authoritative count is unknown. An absent numberOfEpisodes says nothing;
  // a guessed one says something false.
  if (detail.episodes) ld.numberOfEpisodes = detail.episodes;
  const formattedStartDate = formatFuzzyDate(detail.startDate);
  if (formattedStartDate) ld.startDate = formattedStartDate;
  if (detail.genres?.length) ld.genre = detail.genres;
  // Bangumi rating carries a real vote count (Subject.Rating.Count), which
  // Google requires for a valid AggregateRating. AniList's averageScore has
  // no count, so an AniList-sourced rating is always rejected — omit it.
  if (
    detail.bangumiScore &&
    detail.bangumiScore > 0 &&
    detail.bangumiVotes &&
    detail.bangumiVotes > 0
  ) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: detail.bangumiScore,
      ratingCount: detail.bangumiVotes,
      bestRating: 10,
      worstRating: 1,
    };
  }
  if (detail.studios?.length) {
    ld.productionCompany = detail.studios.map((name) => ({
      "@type": "Organization",
      name,
    }));
  }
  return ld;
}
