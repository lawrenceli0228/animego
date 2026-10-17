// The words and numbers each card shows: "第 4 集 · 6 天后", "今天 22:00",
// "TV · 12 集", "10.0 万人追番".
//
// Templates come in through `copy` — the dictionary's seasonPage strings,
// read by the client tree with useLang() — so this module never imports a
// dictionary and the same function renders all three languages. Calendar
// words (weekday and month names) are tables here, the way lib/home/time.ts
// keeps them: they are per-language grammar, not copy.
//
// Times are on the Beijing clock (./clock.ts).
//
// Pure: no React, no DOM.

import { formatLabel, genreLabel, sourceLabel, statusLabel } from "@/lib/contentLabels";
import { fillTemplate, parseDayKey } from "@/lib/home/time";
import { bangumiScoreText, scoreText } from "@/lib/home/viewModels";
import type { Lang } from "@/lib/i18n/lang";
import type { BarMode } from "./bars";
import { DAY_MS, WEEK_MS, siteDayNumber, siteHhmm } from "./clock";
import type { SeasonalItem } from "./model";
import type { BrowseState } from "./state";

export { bangumiScoreText, scoreText };

/** The dictionary strings these builders read (dict.seasonPage). */
export interface CardCopy {
  airIn: string;
  inDays: string;
  inDay: string;
  inHours: string;
  inHour: string;
  inMinutes: string;
  airedNow: string;
  finishedEps: string;
  finishedEpsOne: string;
  allEps: string;
  allEpsOne: string;
  premieresOn: string;
  premiereTbd: string;
  premiereTbdShort: string;
  cdAiring: string;
  cdEp: string;
  cdDH: string;
  cdHM: string;
  cdM: string;
  cdOut: string;
  cdPremiere: string;
  cdTbd: string;
  badgeToday: string;
  badgeTomorrow: string;
  badgeEpOut: string;
  epCount: string;
  epCountOne: string;
  epsTbd: string;
  runtimeTbd: string;
  runtimeHM: string;
  runtimeH: string;
  runtimeM: string;
  popularity: string;
  sequelTag: string;
}

// ── Calendar words ──────────────────────────────────────────────────────────

const WEEKDAY_SHORT: Record<Lang, readonly string[]> = {
  zh: ["一", "二", "三", "四", "五", "六", "日"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  "zh-Hant": ["一", "二", "三", "四", "五", "六", "日"],
};

const WEEKDAY_LONG: Record<Lang, readonly string[]> = {
  zh: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  // 週, as lib/home/time.ts writes it for Traditional.
  "zh-Hant": ["週一", "週二", "週三", "週四", "週五", "週六", "週日"],
};

const EN_MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EN_MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_SHORT: Record<Lang, (m: number) => string> = {
  zh: (m) => `${m}月`,
  en: (m) => EN_MONTH_SHORT[m - 1] ?? "",
  "zh-Hant": (m) => `${m}月`,
};

const MONTH_LONG: Record<Lang, (m: number) => string> = {
  zh: (m) => `${m} 月`,
  en: (m) => EN_MONTH_LONG[m - 1] ?? "",
  "zh-Hant": (m) => `${m} 月`,
};

const DATE_LABEL: Record<Lang, (m: number, d: number) => string> = {
  zh: (m, d) => `${m} 月 ${d} 日`,
  en: (m, d) => `${EN_MONTH_SHORT[m - 1] ?? ""} ${d}`,
  "zh-Hant": (m, d) => `${m} 月 ${d} 日`,
};

/** A bar's axis label, 1 = Monday: "一" / "Mon". */
export function weekdayShortLabel(weekday: number, lang: Lang): string {
  return WEEKDAY_SHORT[lang][weekday - 1] ?? "";
}

/** "周一" / "Monday". */
export function weekdayLongLabel(weekday: number, lang: Lang): string {
  return WEEKDAY_LONG[lang][weekday - 1] ?? "";
}

/** A month bar's axis label: "10月" / "Oct". */
export function monthShortLabel(month: number, lang: Lang): string {
  return MONTH_SHORT[lang](month);
}

/** "10 月" / "October" — inside a sentence. */
export function monthLongLabel(month: number, lang: Lang): string {
  return MONTH_LONG[lang](month);
}

/** "10 月 2 日" / "Oct 2" for a `YYYY-MM-DD` key; "" when it is not a date. */
export function dateLabel(dayKey: string, lang: Lang): string {
  const parts = parseDayKey(dayKey);
  return parts ? DATE_LABEL[lang](parts.month, parts.day) : "";
}

// ── Numbers ─────────────────────────────────────────────────────────────────

const groupThousands = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The unit Chinese counts large numbers in; English has none and groups digits instead. */
const TEN_THOUSAND: Record<Lang, string | null> = {
  zh: "万",
  en: null,
  "zh-Hant": "萬",
};

export interface CountParts {
  /** "10.0" or "9,999". */
  n: string;
  /** "万" past ten thousand in Chinese, otherwise "". */
  unit: string;
}

/** A count as a number and its unit: the dictionary templates place both ("{{n}} {{unit}}人追番"). */
export function countParts(count: number, lang: Lang): CountParts {
  const unit = TEN_THOUSAND[lang];
  return unit && count >= 10_000
    ? { n: (count / 10_000).toFixed(1), unit }
    : { n: groupThousands(count), unit: "" };
}

/** An episode-count template, with the singular English needs for one episode. */
function eps(n: number, many: string, one: string): string {
  return fillTemplate(n === 1 ? one : many, { n });
}

/** "10.0 万人追番" / "On 99,660 lists", or "" without a count. */
export function popularityText(popularity: number | null, copy: CardCopy, lang: Lang): string {
  if (popularity === null) return "";
  const { n, unit } = countParts(popularity, lang);
  return fillTemplate(copy.popularity, { n, unit });
}

// ── Air times ───────────────────────────────────────────────────────────────

interface Span {
  days: number;
  hours: number;
  minutes: number;
}

function spanOf(ms: number): Span {
  return {
    days: Math.floor(ms / DAY_MS),
    hours: Math.floor((ms % DAY_MS) / 3_600_000),
    minutes: Math.floor((ms % 3_600_000) / 60_000),
  };
}

/** "6 天后" / "in 6 days", to the largest whole unit. */
function untilText(ms: number, copy: CardCopy): string {
  const { days, hours, minutes } = spanOf(ms);
  if (days >= 1) return fillTemplate(days === 1 ? copy.inDay : copy.inDays, { n: days });
  if (hours >= 1) return fillTemplate(hours === 1 ? copy.inHour : copy.inHours, { n: hours });
  return fillTemplate(copy.inMinutes, { n: Math.max(1, minutes) });
}

export type AiringVariant = "full" | "short";

/**
 * The popover's (and the phone card's) one line about airing:
 * "第 4 集 · 6 天后", "已完结 · 全 12 集", "10 月 20 日开播". The phone's
 * `short` variant drops the words its narrow line cannot fit.
 */
export function airingText(
  item: SeasonalItem,
  nowMs: number,
  copy: CardCopy,
  lang: Lang,
  variant: AiringVariant = "full",
): string {
  if (item.next) {
    const until = item.next.at - nowMs;
    const when = until <= 0 ? copy.airedNow : untilText(until, copy);
    return fillTemplate(copy.airIn, { ep: item.next.ep, when });
  }
  if (item.status === "FINISHED") {
    if (!item.episodes) return statusLabel("FINISHED", lang);
    return variant === "short"
      ? eps(item.episodes, copy.allEps, copy.allEpsOne)
      : eps(item.episodes, copy.finishedEps, copy.finishedEpsOne);
  }
  if (item.status === "NOT_YET_RELEASED") {
    if (item.start) return fillTemplate(copy.premieresOn, { date: dateLabel(item.start, lang) });
    return variant === "short" ? copy.premiereTbdShort : copy.premiereTbd;
  }
  return item.status ? statusLabel(item.status, lang) : "";
}

export interface Countdown {
  /** The small line: "第 4 集播出还有". */
  label: string;
  /** The big one: "6 天 3 小时". */
  value: string;
}

/** The chart card's countdown block. */
export function countdown(item: SeasonalItem, nowMs: number, copy: CardCopy, lang: Lang): Countdown {
  const allEps = item.episodes ? eps(item.episodes, copy.allEps, copy.allEpsOne) : "";
  if (item.next) {
    const until = item.next.at - nowMs;
    if (until <= 0) return { label: fillTemplate(copy.cdEp, { ep: item.next.ep }), value: copy.cdOut };
    const { days, hours, minutes } = spanOf(until);
    const value =
      days >= 1
        ? fillTemplate(copy.cdDH, { d: days, h: hours })
        : hours >= 1
          ? fillTemplate(copy.cdHM, { h: hours, m: minutes })
          : fillTemplate(copy.cdM, { m: Math.max(1, minutes) });
    return { label: fillTemplate(copy.cdAiring, { ep: item.next.ep }), value };
  }
  if (item.status === "FINISHED") {
    const finished = statusLabel("FINISHED", lang);
    return { label: finished, value: allEps || finished };
  }
  if (item.status === "NOT_YET_RELEASED") {
    return { label: copy.cdPremiere, value: item.start ? dateLabel(item.start, lang) : copy.cdTbd };
  }
  return { label: item.status ? statusLabel(item.status, lang) : "", value: allEps };
}

// ── The cover badge ─────────────────────────────────────────────────────────

/**
 * soon   the next episode is less than a day away (pulsing dot)
 * new    the previous episode went out less than a day ago (solid, in tone)
 * plain  under a weekday or month filter: the air time or the premiere date
 */
export type BadgeKind = "soon" | "new" | "plain";

export interface CoverBadge {
  kind: BadgeKind;
  text: string;
}

export function coverBadge(
  item: SeasonalItem,
  nowMs: number,
  state: BrowseState,
  mode: BarMode,
  copy: CardCopy,
  lang: Lang,
): CoverBadge | null {
  const next = item.next;
  if (next) {
    const until = next.at - nowMs;
    if (until <= 0) {
      // The row is only as fresh as its last sync, so the "next" episode may
      // already be out: within the last day, that is news about that very
      // episode. Further back it says nothing — and a time in the past is
      // never "today".
      if (-until < DAY_MS) return { kind: "new", text: fillTemplate(copy.badgeEpOut, { ep: next.ep }) };
    } else if (until < DAY_MS) {
      const today = siteDayNumber(next.at) === siteDayNumber(nowMs);
      return {
        kind: "soon",
        text: fillTemplate(today ? copy.badgeToday : copy.badgeTomorrow, { time: siteHhmm(next.at) }),
      };
    } else {
      // The previous episode is inferred a week before the next one; the
      // first episode has no previous one to announce.
      const sinceLast = nowMs - (next.at - WEEK_MS);
      if (next.ep >= 2 && sinceLast >= 0 && sinceLast < DAY_MS) {
        return { kind: "new", text: fillTemplate(copy.badgeEpOut, { ep: next.ep - 1 }) };
      }
    }
  }
  if (state.wd && mode === "weekday" && next) return { kind: "plain", text: siteHhmm(next.at) };
  if (state.mon && mode === "month" && item.start) return { kind: "plain", text: dateLabel(item.start, lang) };
  return null;
}

// ── Format, runtime and the meta lines ─────────────────────────────────────

/** "1 小时 45 分" / "1h 45m" / "24 分钟". */
export function runtimeText(minutes: number | null, copy: CardCopy): string {
  if (!minutes) return "";
  if (minutes < 60) return fillTemplate(copy.runtimeM, { m: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? fillTemplate(copy.runtimeHM, { h, m }) : fillTemplate(copy.runtimeH, { h });
}

const join = (parts: Array<string | null | undefined>) => parts.filter((p): p is string => !!p).join(" · ");

/** "TV · 12 集", "剧场版 · 1 小时 45 分". */
export function infoLine(item: SeasonalItem, copy: CardCopy, lang: Lang): string {
  const format = item.format ? formatLabel(item.format, lang) : null;
  if (item.format === "MOVIE") return join([format, runtimeText(item.duration, copy)]);
  return join([format, item.episodes ? eps(item.episodes, copy.epCount, copy.epCountOne) : null]);
}

/** The chart card's meta line: the info line, the source, 续作, the Bangumi score. */
export function metaLine(item: SeasonalItem, copy: CardCopy, lang: Lang): string {
  const bangumi = bangumiScoreText(item.bangumi);
  return join([
    infoLine(item, copy, lang),
    sourceLabel(item.source, lang),
    item.sequel ? copy.sequelTag : null,
    bangumi ? `Bangumi ${bangumi}` : null,
  ]);
}

/** The table's format column, second line: the runtime of a film, the episode count of anything else. */
export function formatSubLine(item: SeasonalItem, copy: CardCopy): string {
  if (item.format === "MOVIE") return runtimeText(item.duration, copy) || copy.runtimeTbd;
  return item.episodes ? eps(item.episodes, copy.epCount, copy.epCountOne) : copy.epsTbd;
}

/**
 * The table's status column, second line: when a finished show aired,
 * otherwise the airing line — or nothing, when that line would only repeat
 * the status above it (an airing show with no episode on the schedule).
 */
export function statusSubLine(
  item: SeasonalItem,
  nowMs: number,
  copy: CardCopy,
  lang: Lang,
  seasonYear: string,
): string {
  if (item.status === "FINISHED") return seasonYear;
  const line = airingText(item, nowMs, copy, lang);
  return item.status && line === statusLabel(item.status, lang) ? "" : line;
}

/** Up to `max` genre labels. */
export function genreLabels(item: SeasonalItem, lang: Lang, max: number): string[] {
  return item.genres.slice(0, max).map((g) => genreLabel(g, lang));
}
