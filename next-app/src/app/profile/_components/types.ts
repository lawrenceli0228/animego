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
  coverImageUrl: string | null;
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
