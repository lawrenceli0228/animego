// The lines a genre page's cards say about a show.
//
// The cards are the seasonal page's, and so is everything about a show on
// air: "第 4 集 · 6 天后". The difference is the rest. A season's page never
// has to say which year a show is from; a genre's spans decades, so a show
// that is not airing is placed in time first and then said to be finished:
// "2019 年 春季 · 全 25 集". On a phone the line under the cover is the year
// and the format, "2019 · TV".
//
// Pure: no React, no DOM.

import { formatLabel, seasonLabel, statusLabel } from "@/lib/contentLabels";
import { fillTemplate } from "@/lib/home/time";
import type { Lang } from "@/lib/i18n/lang";
import { airingText, infoLine, type AiringVariant, type CardCopy } from "@/lib/seasonal/display";
import type { SeasonalItem } from "@/lib/seasonal/model";
import type { GenreItem } from "./items";

/** The dictionary strings these lines read, on top of the seasonal cards' own. */
export interface GenreCardCopy extends CardCopy {
  /** "{{year}} 年 {{season}}" / "{{season}} {{year}}". */
  yearSeason: string;
  /** "{{year}} 年" / "{{year}}". */
  yearOnly: string;
  /** A film that has come out: "已上映". */
  released: string;
}

/** The item's year and season, when it has them (a seasonal item has neither). */
function timeOf(item: SeasonalItem): { year: number | null; season: string | null } {
  const g = item as Partial<GenreItem>;
  return {
    year: typeof g.year === "number" ? g.year : null,
    season: typeof g.season === "string" ? g.season : null,
  };
}

const join = (parts: ReadonlyArray<string | null | undefined>) => parts.filter((p): p is string => !!p).join(" · ");

/** "2019 年 春季" / "Spring 2019"; "2019 年" without a season; "" without a year. */
export function yearSeasonText(item: SeasonalItem, copy: GenreCardCopy, lang: Lang): string {
  const { year, season } = timeOf(item);
  if (year === null) return "";
  return season
    ? fillTemplate(copy.yearSeason, { year, season: seasonLabel(season, lang) })
    : fillTemplate(copy.yearOnly, { year });
}

/** How a show that is not on air stands: "全 25 集", "已上映", "未开播". */
function standingText(item: SeasonalItem, copy: GenreCardCopy, lang: Lang): string {
  if (item.status === "FINISHED") {
    if (item.format === "MOVIE") return copy.released;
    if (item.episodes) return fillTemplate(item.episodes === 1 ? copy.allEpsOne : copy.allEps, { n: item.episodes });
    return statusLabel("FINISHED", lang);
  }
  return item.status ? statusLabel(item.status, lang) : "";
}

/** The card's line about when: the popover's first line (`full`), or the phone card's (`short`). */
export function genreAiringText(
  item: SeasonalItem,
  nowMs: number,
  copy: GenreCardCopy,
  lang: Lang,
  variant: AiringVariant = "full",
): string {
  if (item.next && item.status === "RELEASING") return airingText(item, nowMs, copy, lang, variant);
  if (variant === "short") {
    const { year } = timeOf(item);
    return join([year === null ? null : String(year), item.format ? formatLabel(item.format, lang) : null]);
  }
  return join([yearSeasonText(item, copy, lang), standingText(item, copy, lang)]);
}

/** A ranked row's second line: "2019 · TV · 25 集", "2016 · 剧场版 · 1 小时 47 分". */
export function rankSubLine(item: SeasonalItem, copy: GenreCardCopy, lang: Lang): string {
  const { year } = timeOf(item);
  return join([year === null ? null : String(year), infoLine(item, copy, lang)]);
}
