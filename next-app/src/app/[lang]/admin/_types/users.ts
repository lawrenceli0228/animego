// The admin user list, one user's detail, and the session actions.
//
// This file is the wire contract.  go-api/internal/admin encodes exactly these
// field names; change one side and the other in the same commit.
//
// Dates and instants: `today` and every YYYY-MM-DD string is a reporting day
// in Asia/Shanghai (+08).  Fields ending in `At` are RFC 3339 instants; show
// them in +08 (fixed offset, never the browser's zone) so server and client
// render the same text.

/** GET /api/admin/users?segment= */
export type AdminUserSegment =
  | "all"
  | "active7"
  | "returned"
  | "neverReturned"
  | "subscribed"
  | "admin";

/** GET /api/admin/users?sort=  — all descending, unknown values mean lastSeen. */
export type AdminUserSort = "lastSeen" | "joined" | "activeDays" | "subscriptions" | "watched";

/**
 * GET /api/admin/users?page=&q=&segment=&sort=&depthDays=&depthMin=&depthMax=
 *
 * depthDays (7 | 30 | 90), depthMin and depthMax filter to people active on
 * between depthMin and depthMax distinct days (inclusive) in the last
 * depthDays days — the activity panel's depth rows link here.  All three or
 * none; partial or invalid values are ignored.
 */
export interface AdminUsersPage {
  data: AdminUserRow[];
  hasMore: boolean;
  /** Rows matching q + segment + depth filter. */
  total: number;
  page: number;
  /** The current reporting day, for the 30-day strip and relative times. */
  today: string;
  /** Every segment's size over all accounts (ignores q and the depth filter). */
  segments: Record<AdminUserSegment, number>;
}

export interface AdminUserRow {
  _id: string;
  username: string;
  email: string;
  role: string | null;
  createdAt: string;
  /** Newest recorded presence; null when nothing was ever recorded. */
  lastSeenAt: string | null;
  /** Distinct recorded days, all time (a floor before instrumentation). */
  activeDays: number;
  /** Password logins, all time. Not sessions: renewals do not count. */
  logins: number;
  subscriptions: number;
  followers: number;
  /** Subscriptions carrying a score. */
  ratings: number;
  /** Episodes marked watched (episode_watches rows). */
  watchedEpisodes: number;
  /** Active on any day after the signup day. */
  returned: boolean;
  /** Active days within [today-29, today], ascending. */
  recentActiveDates: string[];
  /** The live session used most recently; null when none. */
  lastDevice: AdminUserDevice | null;
}

export interface AdminUserDevice {
  /** "phone" | "tablet" | "laptop" | "desktop" | "unknown". */
  kind: string;
  /** "" when unknown. */
  os: string;
  /** "" when unknown. */
  browser: string;
  /** ISO country code from the CDN; null when unknown. */
  country: string | null;
  lastUsedAt: string;
}

/** GET /api/admin/users/{userId} */
export interface AdminUserDetail {
  today: string;
  instrumentedSince: string | null;
  user: {
    _id: string;
    username: string;
    email: string;
    role: string | null;
    createdAt: string;
    isPublic: boolean;
    avatarUrl: string | null;
  };
  activity: {
    activeDays: number;
    /** Days with per-request data (the rest were reconstructed). */
    recordedDays: number;
    lastSeenAt: string | null;
    logins: number;
    requests: number;
    /** Active days within [today-89, today], ascending. */
    days90: { date: string; recorded: boolean }[];
  };
  subscriptions: {
    total: number;
    watching: number;
    completed: number;
    planToWatch: number;
    dropped: number;
    rated: number;
    /** Mean score over rated subscriptions; null when none are rated. */
    avgScore: number | null;
    lastUpdatedAt: string | null;
  };
  watches: { total: number; lastWatchedAt: string | null };
  /** The six most recent episode_watches, newest first. */
  recentWatches: AdminUserWatch[];
  /** The six most recently updated subscriptions, newest first. */
  recentSubscriptions: AdminUserSubscription[];
  /** Live sessions, most recently used first. */
  sessions: AdminUserSession[];
  community: {
    comments: number;
    replies: number;
    threads: number;
    reviews: number;
    danmaku: number;
    following: number;
    followers: number;
    reportsFiled: number;
    editSubmissions: number;
  };
}

/** The title fields pickTitle() reads, as anime_cache holds them. */
export interface AdminAnimeTitles {
  anilistId: number;
  titleChinese: string | null;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleHant: string | null;
  /** Total episodes; null when unknown. */
  episodes: number | null;
}

export interface AdminUserWatch extends AdminAnimeTitles {
  episode: number;
  watchedAt: string;
}

export interface AdminUserSubscription extends AdminAnimeTitles {
  /** "watching" | "completed" | "plan_to_watch" | "dropped". */
  status: string;
  score: number | null;
  currentEpisode: number;
  updatedAt: string;
}

export interface AdminUserSession {
  id: string;
  kind: string;
  os: string;
  browser: string;
  country: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

/** DELETE /api/admin/users/{userId}/sessions and …/sessions/{sessionId}. */
export interface AdminRevokeSessionsResult {
  /**
   * Signed-in devices signed out. "Every device" deletes expired session rows
   * and clears a refresh token from before per-device sessions too, but
   * counts only the live sessions, the ones `sessions` above lists.
   */
  revoked: number;
}
