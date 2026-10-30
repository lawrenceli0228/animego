"use client";

// Every string the ranking pages' own chrome shows, read once per language.
// The cards' strings are the seasonal page's (useBrowseCopy), with the genre
// page's three lines about when a show is from.
//
// Each key is a literal t("…") call on purpose: spaDictCoverage.test.ts finds
// client keys by scanning for exactly that shape.

import { useMemo } from "react";
import { useBrowseCopy, type BrowseCopy } from "@/components/seasonal/browse/useBrowseCopy";
import type { GenreCardCopy } from "@/lib/genre/display";
import { useLang } from "@/lib/lang-client";

export interface TopCopy {
  strip: string;
  allTime: string;
  older: string;
  olderYears: string;
  filters: string;
  /** The format chips' "all" and the genre menu's. */
  all: string;
  formats: string;
  genre: string;
  seasons: string;
  wholeYear: string;
  /** "第 {{n}} 名": read before a ranked title. */
  rank: string;
  views: string;
  viewGrid: string;
  viewChart: string;
  viewTable: string;
  showMore: string;
  moreLeft: string;
  empty: string;
  clearFilters: string;
}

export interface TopCopies {
  copy: TopCopy;
  browse: BrowseCopy;
  card: GenreCardCopy;
}

export function useTopCopy(): TopCopies {
  const { t } = useLang();
  const browse = useBrowseCopy();
  return useMemo<TopCopies>(
    () => ({
      copy: {
        strip: t("topPage.strip"),
        allTime: t("topPage.allTime"),
        older: t("topPage.older"),
        olderYears: t("topPage.olderYears"),
        filters: t("topPage.filters"),
        all: t("seasonPage.all"),
        formats: t("seasonPage.format"),
        genre: t("seasonPage.genres"),
        seasons: t("seasonPage.season"),
        wholeYear: t("topPage.wholeYear"),
        rank: t("genrePage.rank"),
        views: t("seasonPage.views"),
        viewGrid: t("seasonPage.viewGrid"),
        viewChart: t("seasonPage.viewChart"),
        viewTable: t("seasonPage.viewTable"),
        showMore: t("seasonPage.showMore"),
        moreLeft: t("seasonPage.moreLeft"),
        empty: t("seasonPage.empty"),
        clearFilters: t("seasonPage.clearFilters"),
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
