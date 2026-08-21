// Profile-local types mirroring go-api/internal/subscriptions/types.go listItem.
// The subscriptions list endpoint joins anime_cache base columns only —
// averageScore and genres are NOT in the join (no anime_cache.average_score
// in the SQL, no anime_genres child-table join). Callers must treat both as
// absent and degrade gracefully.
//
// If these types become broadly useful they should move to src/lib/types.ts.

export interface SubscriptionListItem {
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  // Traditional Chinese title channel (migration 0022). Repeated here rather
  // than inherited because this file declares its own anime shape — a field
  // go-api sends but this interface omits is one the shared pickTitle()
  // ladder cannot see, so zh-Hant would fall straight past its first rung.
  //
  // Optional (not `| null`) because they are absent from any response served
  // by a go-api older than 0022. See the channel note in lib/types.ts: only
  // titleHantSeo may reach a <title>, og:title or JSON-LD name.
  titleHant?: string | null;
  titleHantSource?: string | null;
  /** SERP-safe projection — see the hant channel note in lib/types.ts. */
  titleHantSeo?: string | null;
  coverImageUrl: string | null;
  /** Wide landscape banner (AniList bannerImage); used for the cinematic backdrop. */
  bannerImageUrl: string | null;
  coverImageColor: string | null;
  posterAccent: string | null;
  episodes: number | null;
  season: string | null;
  seasonYear: number | null;
  format: string | null;
  animeStatus: string | null;
  // Subscription fields
  subscriptionId: null; // always null from Go API (composite PK, no row id)
  status: string;
  currentEpisode: number;
  score: number | null;
  lastWatchedAt: string | null;
  subscribedAt: string | null;
  updatedAt: string | null;
}

export type SubscriptionStatus =
  | "watching"
  | "completed"
  | "plan_to_watch"
  | "dropped";
