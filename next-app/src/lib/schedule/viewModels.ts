// /api/anime/schedule → the seven slim, localised days the schedule page
// renders.
//
// Decided on the server, like the homepage's view models: what crosses into
// the client board is a handful of strings per airing, not the API row with
// its three title channels and accent triple. Everything that depends on the
// clock (aired / upcoming, the "now" rule, times in the reader's zone) stays
// out of here — the board derives it from `at` once it knows what time it is.
//
// Pure: no React, no DOM, no dictionary imports.

import { formatLabel, genreLabel } from "@/lib/contentLabels";
import type { Lang } from "@/lib/i18n/lang";
import { fillTemplate, parseDayKey, weekdayLabel } from "@/lib/home/time";
import { animeHue } from "@/lib/home/tone";
import { scoreText, todayCard, type TodayCard } from "@/lib/home/viewModels";
import type { ScheduleItem, ScheduleResponse } from "@/lib/types";
import { leadOf, monthDay, weekKeys, weekdayShort } from "./week";

/** Genres on a row's meta line; the board shows two. */
const ROW_GENRES = 2;

export interface ScheduleItemView extends TodayCard {
  /** "第 12 集 · TV · 动作 / 冒险" */
  meta: string;
  /** "8.5", or null when AniList has no score. */
  score: string | null;
}

export interface ScheduleDayView {
  /** `YYYY-MM-DD`, the API's group key. */
  key: string;
  isToday: boolean;
  /** "今天" / "周四" */
  label: string;
  /** The bar chart's axis: "今" / "四". */
  short: string;
  /** "9/24" */
  md: string;
  /** The day's best-rated coloured show's hue: the page's colour while it is selected. */
  hue: number | null;
  /** In airing order. */
  items: ScheduleItemView[];
}

export interface WeekCopy {
  /** dict.home.today — "今天" */
  today: string;
  /** dict.schedule.todayShort — "今" */
  todayShort: string;
  /** dict.home.todayEp — "第 {{ep}} 集" */
  ep: string;
}

export function scheduleItemView(row: ScheduleItem, lang: Lang, epTemplate: string): ScheduleItemView {
  const genres = (row.genres ?? []).slice(0, ROW_GENRES).map((g) => genreLabel(g, lang));
  const meta = [
    fillTemplate(epTemplate, { ep: row.episode }),
    row.format ? formatLabel(row.format, lang) : null,
    genres.length ? genres.join(" / ") : null,
  ]
    .filter((part): part is string => !!part)
    .join(" · ");
  return { ...todayCard(row, lang), meta, score: scoreText(row.averageScore) };
}

/**
 * The page's seven days, today first; empty when the schedule did not load.
 *
 * A day the API has no group for still gets its entry (and its tab), with no
 * items and no hue.
 *
 * A day's colour is its best-rated show that HAS a colour. The lead paints the
 * whole page, and a show on the brand-fallback accent would paint it grey —
 * the homepage hero makes the same call (hueFamilies.colouredFirst). Only a
 * day with no coloured show at all is neutral.
 */
export function buildWeek(schedule: ScheduleResponse, lang: Lang, copy: WeekCopy): ScheduleDayView[] {
  return weekKeys(schedule.today).map((key, i) => {
    const rows = [...(schedule.groups?.[key] ?? [])].sort((a, b) => a.airingAt - b.airingAt);
    const lead = leadOf(rows.filter((r) => animeHue(r.posterAccent) !== null));
    const weekday = parseDayKey(key)?.weekday ?? 0;
    return {
      key,
      isToday: i === 0,
      label: i === 0 ? copy.today : weekdayLabel(weekday, lang),
      short: i === 0 ? copy.todayShort : weekdayShort(weekday, lang),
      md: monthDay(key),
      hue: lead ? animeHue(lead.posterAccent) : null,
      items: rows.map((r) => scheduleItemView(r, lang, copy.ep)),
    };
  });
}
