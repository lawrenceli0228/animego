// Mirrored from go-api/internal/anime/{handlers,detail}.go field-for-field.
// JSON field names match Go json tags exactly (camelCase).
// When go-api adds/removes fields, this file must be updated in the same commit.

import type { FuzzyDate } from "./formatters";

// ─── Envelope ──────────────────────────────────────────────────────

export interface ApiEnvelope<T> {
  data: T;
}

export interface ApiPagedEnvelope<T> {
  data: T[];
  total: number;
  page: number;
  hasMore: boolean;
  nextPage: number | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// ─── Trending (/api/anime/trending) ────────────────────────────────

export interface TrendingItem {
  rank: number;
  watcherCount: number;
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  coverImageUrl: string | null;
  coverImageColor: string | null;
  posterAccent: string | null;
  averageScore: number | null;
  bangumiScore: number | null;
  episodes: number | null;
  season: string | null;
  seasonYear: number | null;
  status: string | null;
  format: string | null;
  description: string | null;
}

// ─── YearlyTop (/api/anime/yearly-top) ─────────────────────────────
// Same shape as TrendingItem without rank/watcherCount.

export type YearlyTopItem = Omit<TrendingItem, "rank" | "watcherCount">;

// Re-exported so consumers can `import type { FuzzyDate }` from the
// same surface as AnimeDetail itself.
export type { FuzzyDate };

// ─── Seasonal (/api/anime/seasonal) ────────────────────────────────

export interface SeasonalAnime {
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  coverImageUrl: string | null;
  coverImageColor: string | null;
  posterAccent: string | null;
  averageScore: number | null;
  episodes: number | null;
  season: string | null;
  seasonYear: number | null;
  status: string | null;
  format: string | null;
  // Optional because the Go API's /seasonal endpoint plan returns only
  // the 16-column main row (see go-api/internal/anime/seasonal.go
  // header) — child tables like genres are not joined. The legacy
  // Express endpoint that still serves /api/anime/seasonal today DOES
  // surface genres from the Mongo enrichment cache, and the seasonal
  // page client-side filter relies on that. When the Go cutover
  // (P8.5/P9) lands, either the seasonal handler grows a genre join or
  // this field stays optional and the filter quietly no-ops.
  genres?: string[] | null;
}

// ─── AnimeDetail (/api/anime/:id) ──────────────────────────────────
// Phase 5 consumer; included here so lib/types.ts is the single source.

export interface AnimeDetail {
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  coverImageUrl: string | null;
  coverImageColor: string | null;
  posterAccent: string | null;
  posterAccentRgb: string | null;
  posterAccentContrastOnBlack: number | null;
  bannerImageUrl: string | null;
  description: string | null;
  episodes: number | null;
  status: string | null;
  season: string | null;
  seasonYear: number | null;
  averageScore: number | null;
  format: string | null;
  duration: number | null;
  source: string | null;
  // AniList fuzzy date: {year, month, day} with each component nullable
  // when the source only knows part of the date. The Mongo cache stores
  // the raw shape, so consumers must format via lib/formatters before
  // rendering. Legacy ISO strings are tolerated by formatFuzzyDate.
  startDate: FuzzyDate | string | null;
  genres: string[];
  studios: string[];
  relations: DetailRelation[];
  characters: DetailCharacter[];
  staff: DetailStaff[];
  recommendations: DetailRecommendation[];
  bgmId: number | null;
  bangumiScore: number | null;
  bangumiVotes: number | null;
  // Bangumi-enriched per-episode titles. Sparse by design: many shows
  // have an empty array even when `episodes > 0` (enrichment ran but the
  // upstream had no titles). Express schema:
  // `{ episode: number, nameCn: string|null, name: string|null }`.
  episodeTitles: DetailEpisodeTitle[];
}

export interface DetailEpisodeTitle {
  episode: number;
  nameCn: string | null;
  name: string | null;
}

export interface DetailRelation {
  anilistId: number;
  relationType: string;
  titleRomaji: string | null;
  titleChinese: string | null;
  coverImageUrl: string | null;
  format: string | null;
}

export interface DetailCharacter {
  // Raw shape from `/api/anime/:id` — Express stores characters as the
  // AniList payload + Bangumi `nameCn` / `voiceActorCn` merged in. The
  // server does NOT pre-resolve a single display name per request lang;
  // the client picks via pickCharacterName() per the Accept-Language.
  // Bug from 2026-05-27: previous shape declared `{name, voiceActor}`
  // which doesn't exist on the wire — every render fell back to "—".
  nameEn: string | null;
  nameJa: string | null;
  nameCn: string | null;
  role: string;
  imageUrl: string | null;
  voiceActorEn: string | null;
  voiceActorJa: string | null;
  voiceActorCn: string | null;
  voiceActorImageUrl: string | null;
}

export interface DetailStaff {
  name: string;
  role: string;
  imageUrl: string | null;
}

export interface DetailRecommendation {
  anilistId: number;
  titleRomaji: string | null;
  titleChinese: string | null;
  coverImageUrl: string | null;
  averageScore: number | null;
}

// ─── Watchers (/api/anime/:id/watchers) ────────────────────────────

export interface WatcherItem {
  username: string;
}

// ─── LandingPoster ─────────────────────────────────────────────────
// Cover-card payload shared by landing surfaces. The landing page hydrates
// 3 known anilist IDs with full AnimeDetail (banner image, accent contrast,
// full description) and falls back to the lighter TrendingItem when detail
// enrichment lags or 404s. Components only read the common fields
// (title*, coverImageUrl, posterAccent, seasonYear, episodes, averageScore,
// description), so the union type is structurally safe.

export type LandingPoster = TrendingItem | AnimeDetail;
