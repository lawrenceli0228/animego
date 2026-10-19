"use client";

// Every string the genre page's own chrome shows, read once per language. The
// cards' strings are the seasonal page's (useBrowseCopy), which the genre
// lines in lib/genre/display.ts extend with three of their own.
//
// Each key is a literal t("…") call on purpose: spaDictCoverage.test.ts finds
// client keys by scanning for exactly that shape.

import { useMemo } from "react";
import type { GenreCardCopy } from "@/lib/genre/display";
import { useLang } from "@/lib/lang-client";
import { useBrowseCopy, type BrowseCopy } from "@/components/seasonal/browse/useBrowseCopy";

export interface GenreCopy {
  count: string;
  countLine: string;
  strip: string;
  /** Read after a strip count, for a screen reader: "5,242" → "5,242 部". */
  stripUnit: string;
  seeAll: string;
  seeAllAria: string;
  topTitle: string;
  topAll: string;
  rank: string;
  decades: string;
  related: string;
  studios: string;
  /** Read after a related tile's name and count: which two genres the titles carry. */
  relatedHint: string;
  /** Read after a studio tile's name and count: whose titles it counted. */
  studioHint: string;
  back: string;
  backShort: string;
  showMore: string;
  moreLeft: string;
  empty: string;
}

export interface GenreCopies {
  copy: GenreCopy;
  /** What CoverCard reads (the seasonal page's card strings). */
  browse: BrowseCopy;
  /** The genre cards' lines: the seasonal strings and three more. */
  card: GenreCardCopy;
}

export function useGenreCopy(): GenreCopies {
  const { t } = useLang();
  const browse = useBrowseCopy();
  return useMemo<GenreCopies>(
    () => ({
      copy: {
        count: t("genrePage.count"),
        countLine: t("genrePage.countLine"),
        strip: t("genrePage.strip"),
        stripUnit: t("genrePage.stripUnit"),
        seeAll: t("genrePage.seeAll"),
        seeAllAria: t("genrePage.seeAllAria"),
        topTitle: t("genrePage.topTitle"),
        topAll: t("genrePage.topAll"),
        rank: t("genrePage.rank"),
        decades: t("genrePage.decades"),
        related: t("genrePage.related"),
        studios: t("genrePage.studios"),
        relatedHint: t("genrePage.relatedHint"),
        studioHint: t("genrePage.studioHint"),
        back: t("genrePage.back"),
        backShort: t("genrePage.backShort"),
        showMore: t("seasonPage.showMore"),
        moreLeft: t("seasonPage.moreLeft"),
        empty: t("seasonPage.empty"),
      },
      browse,
      card: {
        ...browse,
        yearSeason: t("genrePage.yearSeason"),
        yearOnly: t("seasonPage.yearOption"),
        released: t("genrePage.released"),
      },
    }),
    [t, browse],
  );
}
