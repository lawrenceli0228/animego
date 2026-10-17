// /api/anime/seasonal rows → the compact, already-localised items the seasonal
// page browses.
//
// Built on the server and handed to the client tree as props, so what crosses
// the boundary is a few fields per show rather than whole API rows (each row
// carries three title channels and three synopsis channels). Labels for
// genres, formats and statuses are NOT resolved here: they come from
// lib/contentLabels.ts on whichever side renders them, from the raw enums
// kept below.
//
// Every field the API added for this page is optional on the wire. A missing
// one comes out as null and the page offers fewer controls (see facets.ts);
// nothing here throws on an older go-api.
//
// Pure: no React, no DOM, no dictionaries.

import { pickDescription, pickTitle, stripHtml, truncateVisual } from "@/lib/formatters";
import { parseDayKey } from "@/lib/home/time";
import { animeHue } from "@/lib/home/tone";
import type { Lang } from "@/lib/i18n/lang";
import type { SeasonalAnime } from "@/lib/types";
import { siteDateKey } from "./clock";

export interface NextAiring {
  /** Epoch ms. */
  at: number;
  ep: number;
}

export interface SeasonalItem {
  id: number;
  /** The reader's title, never empty while the row has any title at all. */
  title: string;
  /** Every title the row carries, lower-cased and joined: what the search box matches. */
  haystack: string;
  /** API order (the endpoint sorts by score): the last tie-break of every sort. */
  rank: number;
  /**
   * Position in the reader's title collation. Decided once, on the server:
   * Node and the browser ship different ICU data, so sorting by localeCompare
   * on both sides could order a hydrating list differently from its HTML.
   */
  titleRank: number;
  cover: string | null;
  /** The cover's OKLCH hue, or null for grey / fallback accents. */
  hue: number | null;
  /** AniList score, 0–100. */
  score: number | null;
  /** Bangumi score, 0–10. */
  bangumi: number | null;
  format: string | null;
  status: string | null;
  episodes: number | null;
  /** Minutes per episode. */
  duration: number | null;
  /** AniList genre enums. */
  genres: string[];
  studio: string | null;
  next: NextAiring | null;
  popularity: number | null;
  favourites: number | null;
  /** AniList source enum. */
  source: string | null;
  /**
   * The premiere date, `YYYY-MM-DD`: the stored start date, or — when there
   * is none and the next episode is the first — the day that episode airs.
   */
  start: string | null;
  /** null when the API did not say. */
  sequel: boolean | null;
  synopsis: string;
}

/** A synopsis long enough to fill the chart card, short enough to keep the page light. */
const SYNOPSIS_WIDTH = 600;

/** The title collation each language sorts by. */
const COLLATION: Record<Lang, string> = {
  zh: "zh-Hans-CN",
  en: "en",
  "zh-Hant": "zh-Hant-TW",
};

const positive = (n: number | null | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;

const nonNegative = (n: number | null | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;

const text = (s: string | null | undefined): string | null => {
  const v = typeof s === "string" ? s.trim() : "";
  return v ? v : null;
};

/** The reader's title, or any title at all rather than an anchor with no text. */
function titleOf(row: SeasonalAnime, lang: Lang): string {
  return (
    pickTitle(row, lang) ||
    row.titleChinese ||
    row.titleNative ||
    row.titleRomaji ||
    row.titleEnglish ||
    ""
  ).trim();
}

function nextOf(row: SeasonalAnime): NextAiring | null {
  const ep = positive(row.nextAiringEpisode);
  if (!row.nextAiringAt || ep === null) return null;
  const at = Date.parse(row.nextAiringAt);
  return Number.isFinite(at) ? { at, ep: Math.trunc(ep) } : null;
}

/** `YYYY-MM-DD` when the value starts with a real calendar date. */
function dateKey(value: string | null | undefined): string | null {
  const head = typeof value === "string" ? value.slice(0, 10) : "";
  return parseDayKey(head) ? head : null;
}

/** AniList credit lines that read as noise inside a small card. */
const CREDIT_LINE = /\(Source:[^)]*\)|\[Written by[^\]]*\]/gi;

function synopsisOf(row: SeasonalAnime, lang: Lang): string {
  // <br> first: stripHtml drops tags without leaving a space, which would
  // glue the last word of one paragraph to the first of the next.
  const body = pickDescription(row, lang).text.replace(/<br\s*\/?>/gi, " ");
  const plain = stripHtml(body).replace(CREDIT_LINE, " ");
  return truncateVisual(plain.replace(/\s+/g, " ").trim(), SYNOPSIS_WIDTH);
}

function itemOf(row: SeasonalAnime, rank: number, lang: Lang): SeasonalItem {
  const next = nextOf(row);
  const titles = [row.titleChinese, row.titleHant, row.titleNative, row.titleRomaji, row.titleEnglish]
    .map(text)
    .filter((t): t is string => t !== null);
  return {
    id: row.anilistId,
    title: titleOf(row, lang),
    haystack: titles.join("\n").toLowerCase(),
    rank,
    titleRank: 0,
    cover: text(row.coverImageUrl),
    hue: animeHue(row.posterAccent),
    score: positive(row.averageScore),
    bangumi: positive(row.bangumiScore),
    format: text(row.format),
    status: text(row.status),
    episodes: positive(row.episodes),
    duration: positive(row.duration),
    genres: (row.genres ?? []).filter((g) => g && g !== "Hentai"),
    studio: text(row.studio),
    next,
    popularity: nonNegative(row.popularity),
    favourites: nonNegative(row.favourites),
    source: text(row.source),
    start: dateKey(row.startDate) ?? (next && next.ep === 1 ? siteDateKey(next.at) : null),
    sequel: typeof row.isSequel === "boolean" ? row.isSequel : null,
    synopsis: synopsisOf(row, lang),
  };
}

/**
 * The season's rows out of the endpoint's envelope — and only them.
 *
 * The envelope's `pagination.total` is not a count of what came back: on a
 * season's first, cold fetch it is AniList's own figure (a placeholder, at
 * the time of writing) while `data` holds one page of at most 50. Nothing on
 * the page reads it; every count is the length of this list.
 */
export function seasonRowsOf(
  envelope: { data?: readonly SeasonalAnime[] | null } | null | undefined,
): SeasonalAnime[] {
  const data = envelope?.data;
  return Array.isArray(data) ? [...data] : [];
}

/**
 * The season's rows as browse items, in API order, one per anime.
 *
 * A repeated id is dropped rather than rendered twice: the items are keyed by
 * id on the client, and two cards for one show are a bug either way.
 */
export function toSeasonalItems(rows: readonly SeasonalAnime[], lang: Lang): SeasonalItem[] {
  const seen = new Set<number>();
  const items: SeasonalItem[] = [];
  for (const row of rows) {
    if (!row || typeof row.anilistId !== "number" || seen.has(row.anilistId)) continue;
    seen.add(row.anilistId);
    items.push(itemOf(row, items.length, lang));
  }
  const collated = [...items].sort(
    (a, b) => a.title.localeCompare(b.title, COLLATION[lang]) || a.rank - b.rank,
  );
  const titleRank = new Map(collated.map((item, i) => [item.id, i]));
  return items.map((item) => ({ ...item, titleRank: titleRank.get(item.id) ?? item.rank }));
}
