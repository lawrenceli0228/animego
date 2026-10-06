// API rows → the small, already-localised shapes the homepage renders.
//
// Everything a card shows is decided here, on the server, so the props that
// cross into client components are a few strings per card rather than whole
// API rows (the seasonal row alone carries three synopsis channels). The
// completed-gems refresh also runs gemCard() in the browser, which is why this
// module stays pure: no React, no DOM, no dictionary imports.

import { formatLabel, genreLabel, seasonLabel, seasonYearLabel, statusLabel } from "@/lib/contentLabels";
import { pickDescription, pickTitle, stripHtml, truncate } from "@/lib/formatters";
import type { Lang } from "@/lib/i18n/lang";
import type { Airing } from "./heroStatus";
import { titleTokens } from "./titleTokens";
import { animeHue } from "./tone";

/** The fields every list endpoint shares. Structural, so any of them fits. */
export interface AnimeRow {
  anilistId: number;
  titleChinese?: string | null;
  titleNative?: string | null;
  titleRomaji?: string | null;
  titleEnglish?: string | null;
  titleHant?: string | null;
  coverImageUrl: string | null;
  bannerImageUrl?: string | null;
  posterAccent?: string | null;
  averageScore?: number | null;
  bangumiScore?: number | null;
  episodes?: number | null;
  season?: string | null;
  seasonYear?: number | null;
  status?: string | null;
  format?: string | null;
  genres?: string[] | null;
  description?: string | null;
  descriptionCn?: string | null;
  descriptionCnSource?: string | null;
  descriptionHant?: string | null;
  descriptionHantSource?: string | null;
}

export interface EpisodeCopy {
  /** dict.detail.epUnit — "集" / "Eps" */
  epUnit: string;
  /** dict.detail.epUnitOne — "集" / "Ep" */
  epUnitOne: string;
}

/** A schedule row, reduced to what the homepage needs from it. */
export interface ScheduleRow {
  scheduleId?: number;
  anilistId: number;
  airingAt: number;
  episode: number;
  titleChinese?: string | null;
  titleNative?: string | null;
  titleRomaji?: string | null;
  titleEnglish?: string | null;
  titleHant?: string | null;
  coverImageUrl?: string | null;
  posterAccent?: string | null;
}

const SYNOPSIS_CHARS = 160;
const HERO_GENRES = 3;
const POPOVER_GENRES = 3;

export function scoreText(averageScore: number | null | undefined): string | null {
  return averageScore ? (averageScore / 10).toFixed(1) : null;
}

export function bangumiScoreText(score: number | null | undefined): string | null {
  // Round in tenths first: 7.85.toFixed(1) is "7.8", because 7.85 is stored as
  // 7.8499…, and a reader comparing with bgm.tv expects "7.9".
  return score ? (Math.round(score * 10) / 10).toFixed(1) : null;
}

export function episodesText(n: number | null | undefined, copy: EpisodeCopy): string | null {
  if (!n || n <= 0) return null;
  return `${n} ${n === 1 ? copy.epUnitOne : copy.epUnit}`;
}

/** The language's title, or any title at all rather than a blank card. */
function titleOf(row: Parameters<typeof pickTitle>[0], lang: Lang): string {
  return pickTitle(row, lang) || row.titleNative || row.titleRomaji || row.titleEnglish || "";
}

const hrefOf = (id: number) => `/anime/${id}`;

function joinMeta(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p).join(" · ");
}

function seasonText(row: AnimeRow, lang: Lang): string | null {
  return row.season && row.seasonYear ? seasonYearLabel(row.season, row.seasonYear, lang) : null;
}

function localGenres(row: AnimeRow, lang: Lang, max: number): string[] {
  return (row.genres ?? []).slice(0, max).map((g) => genreLabel(g, lang));
}

export interface CardBase {
  id: number;
  href: string;
  title: string;
  cover: string | null;
  hue: number | null;
}

function base(row: AnimeRow, lang: Lang): CardBase {
  return {
    id: row.anilistId,
    href: hrefOf(row.anilistId),
    title: titleOf(row, lang),
    cover: row.coverImageUrl,
    hue: animeHue(row.posterAccent),
  };
}

// ── Hero ────────────────────────────────────────────────────────────────────

export interface HeroSlide extends CardBase {
  tokens: string[];
  /** The banner, or the cover standing in for it. */
  banner: string | null;
  hasBanner: boolean;
  genres: string[];
  score: string | null;
  status: string | null;
  statusLabel: string;
  episodes: number | null;
  /** This show's airings inside the schedule window, epoch ms, ascending. */
  airings: Airing[];
  synopsis: string;
}

export function heroSlide(row: AnimeRow, schedule: readonly ScheduleRow[], lang: Lang): HeroSlide {
  const b = base(row, lang);
  const airings = schedule
    .filter((s) => s.anilistId === row.anilistId)
    .map((s) => ({ at: s.airingAt * 1000, ep: s.episode }))
    .sort((a, c) => a.at - c.at);
  const synopsis = truncate(stripHtml(pickDescription(row, lang).text), SYNOPSIS_CHARS);
  return {
    ...b,
    tokens: titleTokens(b.title),
    banner: row.bannerImageUrl || row.coverImageUrl,
    hasBanner: !!row.bannerImageUrl,
    genres: localGenres(row, lang, HERO_GENRES),
    score: scoreText(row.averageScore),
    status: row.status ?? null,
    statusLabel: row.status ? statusLabel(row.status, lang) : "",
    episodes: row.episodes ?? null,
    airings,
    synopsis,
  };
}

// ── 本季高分 ────────────────────────────────────────────────────────────────

export interface SeasonCard extends CardBase {
  score: string | null;
  /** "TV · 连载中" */
  meta: string;
  statusLabel: string;
  /** Popover: "TV · 12 集 · 2026 夏季" */
  popMeta: string;
  bangumi: string | null;
  genres: string[];
  /** The next airing, as of the server render; the popover's client leaf re-checks it. */
  nextAiring: Airing | null;
}

export function seasonCard(row: AnimeRow, nextAiring: Airing | null, lang: Lang, copy: EpisodeCopy): SeasonCard {
  const format = row.format ? formatLabel(row.format, lang) : null;
  const status = row.status ? statusLabel(row.status, lang) : "";
  return {
    ...base(row, lang),
    score: scoreText(row.averageScore),
    meta: joinMeta([format, status]),
    statusLabel: status,
    popMeta: joinMeta([format, row.format === "MOVIE" ? null : episodesText(row.episodes, copy), seasonText(row, lang)]),
    bangumi: bangumiScoreText(row.bangumiScore),
    genres: localGenres(row, lang, POPOVER_GENRES),
    nextAiring,
  };
}

// ── 按色调逛 ────────────────────────────────────────────────────────────────

export interface HueCard extends CardBase {
  score: string | null;
  meta: string;
}

export function hueCard(row: AnimeRow, lang: Lang): HueCard {
  return {
    ...base(row, lang),
    score: scoreText(row.averageScore),
    meta: joinMeta([row.format ? formatLabel(row.format, lang) : null, row.status ? statusLabel(row.status, lang) : null]),
  };
}

// ── 今日更新 ────────────────────────────────────────────────────────────────

export interface TodayCard extends CardBase {
  /** scheduleId — one show can air twice in a day. */
  key: number;
  /** Epoch ms. */
  at: number;
  ep: number;
}

export function todayCard(row: ScheduleRow, lang: Lang): TodayCard {
  return {
    id: row.anilistId,
    href: hrefOf(row.anilistId),
    title: titleOf(row, lang),
    cover: row.coverImageUrl ?? null,
    hue: animeHue(row.posterAccent),
    key: row.scheduleId ?? row.anilistId * 1000 + row.episode,
    at: row.airingAt * 1000,
    ep: row.episode,
  };
}

// ── 大家都在追 ──────────────────────────────────────────────────────────────

export interface TrendCard extends CardBase {
  rank: number;
  watchers: number;
  /** "AniList 8.5", else "Bangumi 7.9", else "". */
  scoreLine: string;
}

export function trendCard(row: AnimeRow & { rank: number; watcherCount: number }, lang: Lang): TrendCard {
  const anilist = scoreText(row.averageScore);
  const bangumi = bangumiScoreText(row.bangumiScore);
  return {
    ...base(row, lang),
    rank: row.rank,
    watchers: row.watcherCount,
    scoreLine: anilist ? `AniList ${anilist}` : bangumi ? `Bangumi ${bangumi}` : "",
  };
}

// ── 完结佳作 ────────────────────────────────────────────────────────────────

export interface GemCard extends CardBase {
  native: string | null;
  meta: string;
  score: string | null;
  scoreSource: "Bangumi" | "AniList" | null;
}

export function gemCard(row: AnimeRow, lang: Lang, copy: EpisodeCopy): GemCard {
  const format = row.format ? formatLabel(row.format, lang) : null;
  const count = row.format === "MOVIE" ? null : episodesText(row.episodes, copy);
  const bangumi = bangumiScoreText(row.bangumiScore);
  const anilist = scoreText(row.averageScore);
  const b = base(row, lang);
  return {
    ...b,
    // The original title under the display one — unless they are the same.
    native: row.titleNative && row.titleNative !== b.title ? row.titleNative : null,
    meta: joinMeta([seasonText(row, lang), format && count ? `${format} · ${count}` : format ?? count]),
    score: bangumi ?? anilist,
    scoreSource: bangumi ? "Bangumi" : anilist ? "AniList" : null,
  };
}

// ── 年度榜 ──────────────────────────────────────────────────────────────────

export interface YearCard extends CardBase {
  rank: number;
  /** The bare season word — the year is in the section title. */
  season: string;
  score: string | null;
}

export function yearCard(row: AnimeRow, rank: number, lang: Lang): YearCard {
  return {
    ...base(row, lang),
    rank,
    season: row.season ? seasonLabel(row.season, lang) : "",
    score: scoreText(row.averageScore),
  };
}

// ── 继续看 ──────────────────────────────────────────────────────────────────

export interface ContinueRow extends AnimeRow {
  currentEpisode: number;
  episodesBgm?: number | null;
  /** The subscriptions endpoint names the anime's own status this way. */
  animeStatus?: string | null;
  lastWatchedAt?: string | null;
}

export interface ContinueCard extends CardBase {
  banner: string | null;
  current: number;
  /** AniList's count, else the inferred Bangumi one; null when unknown. */
  total: number | null;
  /** The episode "continue" points at: current + 1, never past the total. */
  nextEpisode: number;
  statusLabel: string;
  live: boolean;
  seasonLine: string;
  lastWatchedAt: string | null;
}

export function continueCard(row: ContinueRow, lang: Lang): ContinueCard {
  const total =
    row.episodes && row.episodes > 0 ? row.episodes : row.episodesBgm && row.episodesBgm > 0 ? row.episodesBgm : null;
  const current = Math.max(0, row.currentEpisode || 0);
  const status = row.animeStatus ?? row.status ?? null;
  return {
    ...base(row, lang),
    banner: row.bannerImageUrl || row.coverImageUrl,
    current,
    total,
    nextEpisode: total ? Math.min(current + 1, total) : current + 1,
    statusLabel: status ? statusLabel(status, lang) : "",
    live: status === "RELEASING",
    seasonLine: joinMeta([seasonText(row, lang), row.format ? formatLabel(row.format, lang) : null]),
    lastWatchedAt: row.lastWatchedAt ?? null,
  };
}

/**
 * The reader's watching list as 继续看 cards, in the order 继续看 shows them:
 * the API's own, most recently updated first (`ORDER BY s.updated_at DESC` in
 * go-api's ListUserSubscriptions — a progress mark bumps a show to the
 * front). The homepage section and the 全部在追 page both go through here,
 * so the page's first three are the section's three.
 */
export function continueCards(rows: readonly ContinueRow[], lang: Lang): ContinueCard[] {
  return rows.map((row) => continueCard(row, lang));
}
