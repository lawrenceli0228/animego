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

// ─── Traditional Chinese title channel (migration 0022) ────────────
//
// Every endpoint that returns a displayed title now carries three hant
// fields, and the third one is the whole point:
//
//   titleHant        the Traditional title, from the best available tier
//   titleHantSource  'wikipedia' | 'anilist' | 'opencc' | 'manual'
//   titleHantSeo     the same string with the 'opencc' tier projected out
//                    by the database (a GENERATED column, not a filter
//                    this code applies)
//
// **Anything that reaches a search engine — <title>, og:title, JSON-LD
// name, canonical link text — must read `titleHantSeo` and nothing
// else.** `titleHant` may be a machine conversion (s2twp), which
// measures 85.3% sentence accuracy and whose misses correlate with
// popularity, so its errors land on exactly the titles people search
// for. A wrong title in a SERP is what Google learns the page is about,
// and that is the least reversible mistake available here.
//
// `titleHantSeo` being null is a correct answer, not a missing value —
// fall back down the existing title ladder as you already do for
// `titleChinese`.
//
// All three are optional here rather than `| null` because they are
// absent from any response served by a go-api older than this commit,
// and every consumer already falls back. Null on every row until the
// backfill runs.

// ─── Trending (/api/anime/trending) ────────────────────────────────

export interface TrendingItem {
  rank: number;
  watcherCount: number;
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  titleHant?: string | null;
  titleHantSource?: string | null;
  /** SERP-safe projection — see the hant channel note above. */
  titleHantSeo?: string | null;
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
  titleHant?: string | null;
  titleHantSource?: string | null;
  /** SERP-safe projection — see the hant channel note above. */
  titleHantSeo?: string | null;
  coverImageUrl: string | null;
  coverImageColor: string | null;
  posterAccent: string | null;
  averageScore: number | null;
  episodes: number | null;
  season: string | null;
  seasonYear: number | null;
  status: string | null;
  format: string | null;
  /** Total episode discussion rows; optional during mixed-version deploys. */
  discussionCount?: number;
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

// ─── Community discovery (/api/community/discussions/trending) ───

export interface HotDiscussion {
  anilistId: number;
  episode: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  titleHant?: string | null;
  titleHantSource?: string | null;
  /** SERP-safe projection — see the hant channel note above. */
  titleHantSeo?: string | null;
  coverImageUrl: string | null;
  posterAccent: string | null;
  commentCount: number;
  participantCount: number;
  reactionCount: number;
  latest: {
    id: string;
    username: string;
    avatarUrl: string | null;
    content: string;
    isSpoiler: boolean;
    createdAt: string;
  };
}

// ─── AnimeDetail (/api/anime/:id) ──────────────────────────────────
// Phase 5 consumer; included here so lib/types.ts is the single source.

export interface AnimeDetail {
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  titleHant?: string | null;
  titleHantSource?: string | null;
  /** SERP-safe projection — see the hant channel note above. */
  titleHantSeo?: string | null;
  coverImageUrl: string | null;
  coverImageColor: string | null;
  posterAccent: string | null;
  posterAccentRgb: string | null;
  posterAccentContrastOnBlack: number | null;
  bannerImageUrl: string | null;
  description: string | null;
  // Chinese synopsis channel (anime_cache.description_cn, migration 0014).
  // Detail endpoint only — the list endpoints deliberately omit both, so
  // TrendingItem and friends must NOT grow them. Null on every row until the
  // enrichment backfill runs; pickDescription falls back to `description`
  // whenever they are, which is why adding them changes nothing rendered.
  //
  // Declared here rather than left implicit because pickDescription's
  // parameter type makes both fields optional: the call in the detail page
  // type-checks whether or not this interface carries them, so without these
  // two lines a go-api rename would silently pin zh readers to English with
  // nothing red anywhere. See the wire-contract test in lib/formatters.test.ts.
  descriptionCn: string | null;
  /** 'bangumi' | 'llm' | 'manual' — see anime_cache.description_cn_source. */
  descriptionCnSource: string | null;
  // Traditional Chinese synopsis (anime_cache.description_hant, migration
  // 0022). Detail endpoint only, exactly like descriptionCn above — the
  // list endpoints must NOT grow it. Narrower source vocabulary than the
  // title channel because no dataset ships a Traditional synopsis to
  // import: it is either a conversion or a human wrote it.
  descriptionHant?: string | null;
  /** 'opencc' | 'manual' — see anime_cache.description_hant_source. */
  descriptionHantSource?: string | null;
  episodes: number | null;
  // Inferred total from an external episode source (anime_cache.episodes_bgm,
  // migration 0023). Detail endpoint plus the batch /api/anime/episodes read;
  // null until the sweep reaches the row.
  //
  // Deliberately a SECOND field rather than a fallback folded into `episodes`.
  // `episodes` is AniList's authoritative count and is the only one allowed to
  // reach schema.org numberOfEpisodes — an inferred count there is a factual
  // claim to a search engine about the work, which is a different kind of
  // statement from a number rendered on the page. Visible text (the count
  // badge, the episode grid) may fall back to this one; structured data may
  // not. Merging them would make every call site downstream look identical
  // and leave the one that must refuse the guess no way to tell.
  episodesBgm?: number | null;
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
  // Wire shape: relations carry a flat `title` (romaji from AniList) +
  // `titleChinese` (Bangumi enrichment). They do NOT have `titleRomaji`
  // — that field exists only on the top-level AnimeDetail, not the
  // relation children. Legacy AnimeDetailHero.jsx reads r.title directly.
  title: string | null;
  titleChinese: string | null;
  titleHant?: string | null;
  titleHantSource?: string | null;
  /** SERP-safe projection — see the hant channel note above. */
  titleHantSeo?: string | null;
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
  // Wire shape from /api/anime/:id is `{nameEn, nameJa, role, imageUrl}`
  // — there is no top-level `name`. The previous shape declared `name`
  // which made every staff row render as "—" on the detail page. Use
  // pickStaffName(s, lang) to render; zh prefers Japanese (matches the
  // legacy StaffSection.jsx convention).
  nameEn: string | null;
  nameJa: string | null;
  role: string;
  imageUrl: string | null;
}

export interface DetailRecommendation {
  anilistId: number;
  // Wire shape: recommendations carry a flat `title` (romaji from AniList).
  // No titleRomaji/titleChinese — same shape as DetailRelation. Legacy
  // RecommendationSection.jsx reads r.title directly.
  title: string | null;
  titleChinese: string | null;
  coverImageUrl: string | null;
  averageScore: number | null;
}

// ─── Watchers (/api/anime/:id/watchers) ────────────────────────────

export interface WatcherItem {
  username: string;
  avatarUrl?: string | null;
  /** Chosen backdrop anime's cover — avatar fallback before the default. */
  backdropCoverUrl?: string | null;
}

// Wire shape for /api/anime/:id/watchers — flat envelope with `data`
// (the list) plus `total` (overall count, useful when `limit` truncates
// the list). Unlike most endpoints, the watchers handler does NOT use
// the paged envelope (no page / hasMore / nextPage); the total is a
// scalar so the UI can render "N 人在追" beside the avatar overflow row.
export interface WatchersResponse {
  data: WatcherItem[];
  total: number;
}

// ─── Subscriptions detail row (/api/subscriptions/:anilistId) ──────
// 404 means "viewer has no subscription record for this anime". 200
// returns the raw Subscription doc — status + currentEpisode + score.
// Used by the SubscriptionButton to flip between "+ 追番" and the
// progress / score / remove inline controls.

export interface SubscriptionDetail {
  anilistId: number;
  status: string;
  currentEpisode: number;
  score: number | null;
  lastWatchedAt: string | null;
}

// ─── Subscriptions (/api/subscriptions?status=...) — requires session ─
// One row per anime the viewer has marked in a status bucket. The
// "watching" subset drives the homepage ContinueWatching cards
// (progress bar + ep counter). Backend joins AnimeCache on anilistId
// so title/cover/episodes come pre-resolved.

export interface WatchingItem {
  anilistId: number;
  status: string;
  currentEpisode: number;
  episodes: number | null;
  // Inferred total (anime_cache.episodes_bgm). Optional because a go-api
  // older than this commit does not send it. Use it only as a denominator
  // of last resort — see resolveWatchingTotal in ContinueWatching.
  episodesBgm?: number | null;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  titleHant?: string | null;
  titleHantSource?: string | null;
  /** SERP-safe projection — see the hant channel note above. */
  titleHantSeo?: string | null;
  coverImageUrl: string | null;
  lastWatchedAt: string | null;
}

// ─── Activity feed (/api/feed) — requires session ─────────────────
// Each row is one Subscription record from a user the viewer follows,
// joined with the AnimeCache. lastWatchedAt drives ORDER BY DESC and
// the timeAgo render.

export interface FeedItem {
  /** Stable id/kind on the append-only event feed; absent on legacy rows. */
  id?: string;
  kind?: string;
  username: string;
  anilistId: number;
  title: string;
  titleChinese: string | null;
  titleHant?: string | null;
  titleHantSource?: string | null;
  /** SERP-safe projection — see the hant channel note above. */
  titleHantSeo?: string | null;
  coverImageUrl: string | null;
  episode: number;
  status: string;
  lastWatchedAt?: string;
  /** Event timestamp and discussion fields on the extended feed contract. */
  createdAt?: string;
  commentId?: string | null;
  content?: string | null;
  excerpt?: string | null;
  isSpoiler?: boolean;
  /** Follow-event subject; absent for anime/watch/comment events. */
  targetUsername?: string | null;
}

export interface FeedResponse {
  data: FeedItem[];
  hasMore: boolean;
  nextPage: number | null;
}

// ─── LandingPoster ─────────────────────────────────────────────────
// Cover-card payload shared by landing surfaces. The landing page hydrates
// 3 known anilist IDs with full AnimeDetail (banner image, accent contrast,
// full description) and falls back to the lighter TrendingItem when detail
// enrichment lags or 404s. Components only read the common fields
// (title*, coverImageUrl, posterAccent, seasonYear, episodes, averageScore,
// description), so the union type is structurally safe.

export type LandingPoster = TrendingItem | AnimeDetail;
