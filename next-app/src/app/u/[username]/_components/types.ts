// Local types for /u/[username] pages.
// These mirror the Go social API shapes from go-api/internal/social/types.go.
// Candidates to promote to src/lib/types.ts once the orchestrator confirms
// no other agent is writing that file concurrently.

export interface UserProfileData {
  /** User uuid — drives the deterministic member number (#AGC-…). */
  id: string;
  username: string;
  createdAt: string;
  /** DB-persisted pass photo (card face + avatar); null → cover. */
  avatarUrl: string | null;
  /** DB-persisted chosen backdrop anime; null → first list item. */
  backdropAnilistId: number | null;
  followerCount: number;
  followingCount: number;
  /** null when the requesting user is anonymous */
  isFollowing: boolean | null;
  watching: WatchingEntry[];
}

export interface WatchingEntry {
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  coverImageUrl: string | null;
  /** Wide landscape banner; used to resolve the cinematic backdrop. */
  bannerImageUrl: string | null;
  coverImageColor: string | null;
  posterAccent: string | null;
  episodes: number | null;
  season: string | null;
  seasonYear: number | null;
  format: string | null;
  /** anime's own release status (FINISHED / RELEASING / …) */
  status: string | null;
  /** subscription status renamed from `status` on the wire to avoid collision */
  subscriptionStatus: string;
  currentEpisode: number;
  lastWatchedAt: string;
  genres?: string[] | null;
}

export interface FollowListItem {
  username: string;
  avatarUrl?: string | null;
  backdropCoverUrl?: string | null;
}
