// Mirrored from go-api/internal/anime/{handlers,detail}.go field-for-field.
// JSON field names match Go json tags exactly (camelCase).
// When go-api adds/removes fields, this file must be updated in the same commit.

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
  startDate: string | null;
  genres: string[];
  studios: string[];
  relations: DetailRelation[];
  characters: DetailCharacter[];
  staff: DetailStaff[];
  recommendations: DetailRecommendation[];
  bgmId: number | null;
  bangumiScore: number | null;
  bangumiVotes: number | null;
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
  name: string;
  role: string;
  imageUrl: string | null;
  voiceActor: string | null;
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
