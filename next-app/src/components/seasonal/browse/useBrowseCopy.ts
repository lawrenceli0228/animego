"use client";

// Every string the browse tree shows, read once per language.
//
// Each key is a literal t("…") call on purpose: spaDictCoverage.test.ts finds
// client keys by scanning for exactly that shape, so a computed key here
// would be invisible to the gate that stops dictionary keys reaching the page
// as text. The card strings are typed by lib/seasonal/display.ts (CardCopy),
// which builds the airing lines from them.

import { useMemo } from "react";
import type { HueFamilyKey } from "@/lib/home/hueFamilies";
import type { CardCopy } from "@/lib/seasonal/display";
import { useLang } from "@/lib/lang-client";

export interface BrowseCopy extends CardCopy {
  count: string;
  barsAiring: string;
  barsPremiere: string;
  barDay: string;
  barToday: string;
  barMonth: string;
  barTbd: string;
  tbd: string;
  search: string;
  searchPlaceholder: string;
  genres: string;
  year: string;
  yearOption: string;
  season: string;
  format: string;
  more: string;
  status: string;
  source: string;
  sequel: string;
  any: string;
  all: string;
  newOnly: string;
  sequelOnly: string;
  sourceOther: string;
  tagSearch: string;
  tagRemove: string;
  tagRemoveSearch: string;
  tagWeekday: string;
  tagMonth: string;
  tagTbd: string;
  tagRemoveMonth: string;
  clearAll: string;
  hueDot: string;
  sort: string;
  sortPop: string;
  sortScore: string;
  sortFav: string;
  sortNext: string;
  sortTime: string;
  sortStart: string;
  sortTitle: string;
  views: string;
  viewGrid: string;
  viewChart: string;
  viewTable: string;
  showMore: string;
  moreLeft: string;
  empty: string;
  clearFilters: string;
  noSynopsis: string;
  phoneSearch: string;
  filterSort: string;
  reset: string;
  apply: string;
  closeSheet: string;
  hueGroup: string;
  hueFamily: Record<HueFamilyKey, string>;
  follow: string;
  followed: string;
  followLogin: string;
  viewDetails: string;
}

export function useBrowseCopy(): BrowseCopy {
  const { t } = useLang();
  return useMemo<BrowseCopy>(
    () => ({
      count: t("seasonPage.count"),
      barsAiring: t("seasonPage.barsAiring"),
      barsPremiere: t("seasonPage.barsPremiere"),
      barDay: t("seasonPage.barDay"),
      barToday: t("seasonPage.barToday"),
      barMonth: t("seasonPage.barMonth"),
      barTbd: t("seasonPage.barTbd"),
      tbd: t("seasonPage.tbd"),
      search: t("seasonPage.search"),
      searchPlaceholder: t("seasonPage.searchPlaceholder"),
      genres: t("seasonPage.genres"),
      year: t("seasonPage.year"),
      yearOption: t("seasonPage.yearOption"),
      season: t("seasonPage.season"),
      format: t("seasonPage.format"),
      more: t("seasonPage.more"),
      status: t("seasonPage.status"),
      source: t("seasonPage.source"),
      sequel: t("seasonPage.sequel"),
      any: t("seasonPage.any"),
      all: t("seasonPage.all"),
      newOnly: t("seasonPage.newOnly"),
      sequelOnly: t("seasonPage.sequelOnly"),
      sourceOther: t("seasonPage.sourceOther"),
      tagSearch: t("seasonPage.tagSearch"),
      tagRemove: t("seasonPage.tagRemove"),
      tagRemoveSearch: t("seasonPage.tagRemoveSearch"),
      tagWeekday: t("seasonPage.tagWeekday"),
      tagMonth: t("seasonPage.tagMonth"),
      tagTbd: t("seasonPage.tagTbd"),
      tagRemoveMonth: t("seasonPage.tagRemoveMonth"),
      clearAll: t("seasonPage.clearAll"),
      hueDot: t("seasonPage.hueDot"),
      sort: t("seasonPage.sort"),
      sortPop: t("seasonPage.sortPop"),
      sortScore: t("seasonPage.sortScore"),
      sortFav: t("seasonPage.sortFav"),
      sortNext: t("seasonPage.sortNext"),
      sortTime: t("seasonPage.sortTime"),
      sortStart: t("seasonPage.sortStart"),
      sortTitle: t("seasonPage.sortTitle"),
      views: t("seasonPage.views"),
      viewGrid: t("seasonPage.viewGrid"),
      viewChart: t("seasonPage.viewChart"),
      viewTable: t("seasonPage.viewTable"),
      showMore: t("seasonPage.showMore"),
      moreLeft: t("seasonPage.moreLeft"),
      empty: t("seasonPage.empty"),
      clearFilters: t("seasonPage.clearFilters"),
      noSynopsis: t("seasonPage.noSynopsis"),
      airIn: t("seasonPage.airIn"),
      inDays: t("seasonPage.inDays"),
      inDay: t("seasonPage.inDay"),
      inHours: t("seasonPage.inHours"),
      inHour: t("seasonPage.inHour"),
      inMinutes: t("seasonPage.inMinutes"),
      airedNow: t("seasonPage.airedNow"),
      finishedEps: t("seasonPage.finishedEps"),
      finishedEpsOne: t("seasonPage.finishedEpsOne"),
      allEps: t("seasonPage.allEps"),
      allEpsOne: t("seasonPage.allEpsOne"),
      premieresOn: t("seasonPage.premieresOn"),
      premiereTbd: t("seasonPage.premiereTbd"),
      premiereTbdShort: t("seasonPage.premiereTbdShort"),
      cdAiring: t("seasonPage.cdAiring"),
      cdEp: t("seasonPage.cdEp"),
      cdDH: t("seasonPage.cdDH"),
      cdHM: t("seasonPage.cdHM"),
      cdM: t("seasonPage.cdM"),
      cdOut: t("seasonPage.cdOut"),
      cdPremiere: t("seasonPage.cdPremiere"),
      cdTbd: t("seasonPage.cdTbd"),
      badgeToday: t("seasonPage.badgeToday"),
      badgeTomorrow: t("seasonPage.badgeTomorrow"),
      badgeEpOut: t("seasonPage.badgeEpOut"),
      epCount: t("seasonPage.epCount"),
      epCountOne: t("seasonPage.epCountOne"),
      epsTbd: t("seasonPage.epsTbd"),
      runtimeTbd: t("seasonPage.runtimeTbd"),
      runtimeHM: t("seasonPage.runtimeHM"),
      runtimeH: t("seasonPage.runtimeH"),
      runtimeM: t("seasonPage.runtimeM"),
      popularity: t("seasonPage.popularity"),
      sequelTag: t("seasonPage.sequelTag"),
      phoneSearch: t("seasonPage.phoneSearch"),
      filterSort: t("seasonPage.filterSort"),
      reset: t("seasonPage.reset"),
      apply: t("seasonPage.apply"),
      closeSheet: t("seasonPage.closeSheet"),
      hueGroup: t("home.hueGroup"),
      hueFamily: {
        red: t("home.hueRed"),
        orange: t("home.hueOrange"),
        yellow: t("home.hueYellow"),
        green: t("home.hueGreen"),
        cyan: t("home.hueCyan"),
        blue: t("home.hueBlue"),
        purple: t("home.huePurple"),
      },
      follow: t("card.quickAdd"),
      followed: t("card.quickAdded"),
      followLogin: t("card.quickAddLogin"),
      viewDetails: t("detail.viewDetails"),
    }),
    [t],
  );
}
