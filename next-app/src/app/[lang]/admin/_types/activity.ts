// GET /api/admin/activity?days=N — the user-activity panel.
//
// This file is the wire contract.  go-api/internal/admin/activity.go encodes
// exactly these field names; change one side and the other in the same
// commit.
//
// DEFINITIONS (every number below uses them; the SQL is in
// go-api/internal/db/queries/activity.sql):
//
//   reporting day   a calendar day in Asia/Shanghai (+08, fixed).  Every date
//                   here is a YYYY-MM-DD string in that zone, never an
//                   instant: parse it as a calendar day, not with `new Date`.
//   person          a live account or a deleted one kept in the anonymous
//                   archive (migration 0054).  Deleting an account no longer
//                   changes any number about the past.
//   signup day      the reporting day of the person's signup.
//   returning       active on a day that is NOT their signup day.
//   signup-only     active in the window, but only on their signup day.
//                   active = returning + signupOnly, always.
//   reconstructed   the range starts before `instrumentedSince` (or nothing is
//                   instrumented yet): days before that were rebuilt from
//                   interaction traces by migration 0026 and undercount
//                   visits.  Show such numbers as a floor, never as a
//                   measurement.
//
// All of it is read in ONE read-only REPEATABLE READ transaction, so the
// parts of one response always agree with each other (depth.total equals the
// window's active count, the daily bars sum to what the cards say, and so on).

export interface AdminActivityPanel {
  /** The window the chart and the depth card cover: 7, 30 or 90. */
  days: number;
  /** "Asia/Shanghai (UTC+8)". */
  timezone: string;
  /** The current reporting day. */
  today: string;
  /** When the snapshot was taken, "YYYY-MM-DD HH:mm" in +08. */
  asOf: string;
  /** First day with per-request data; null when nothing is instrumented. */
  instrumentedSince: string | null;

  todayActive: AdminTodayActive;
  windows: { d7: AdminActivityWindow; d30: AdminActivityWindow };
  signups30: AdminSignupWindow;

  /** Exactly `days` points, oldest first, every day present (gaps are 0). */
  daily: AdminActivityDay[];
  depth: AdminActivityDepth;
  /** The ten most recent signup weeks, newest first. */
  cohorts: AdminCohortWeek[];
}

/** Today so far, against the same moment of earlier days. */
export interface AdminTodayActive {
  /** People active today so far. */
  active: number;
  /**
   * People active yesterday by this time of day (first seen no later than
   * exactly 24 hours ago).  Null when yesterday predates instrumentation:
   * reconstructed days carry no real time of day.
   */
  sameTimeYesterday: number | null;
  /** The same for seven days ago.  Null on the same condition. */
  sameTimeLastWeek: number | null;
  /** Everyone active yesterday, the whole day. */
  yesterdayTotal: number;
}

/**
 * A fixed window ending today ([today-(days-1), today]) and the window of the
 * same length right before it.
 */
export interface AdminActivityWindow {
  /** 7 or 30. */
  days: number;
  active: number;
  returning: number;
  signupOnly: number;
  prevActive: number;
  prevReturning: number;
  prevSignupOnly: number;
  reconstructed: boolean;
  prevReconstructed: boolean;
}

/** People who signed up in the last 30 days, and the 30 days before. */
export interface AdminSignupWindow {
  count: number;
  prevCount: number;
  /** Of `count`, how many were active on any day after their signup day. */
  returnedAfter: number;
  /** `returnedAfter` may undercount (see the header). Signups never do. */
  reconstructed: boolean;
}

export interface AdminActivityDay {
  date: string;
  /** Active this day, signed up on an earlier day. */
  returning: number;
  /** Active this day, which is their signup day. */
  signupDay: number;
  /** Authenticated API calls: a volume signal, includes SSR fan-out. */
  requests: number;
  /** Password logins. */
  logins: number;
  /** date >= instrumentedSince. */
  instrumented: boolean;
  /** date === today: the day is not over. */
  partial: boolean;
}

export interface AdminActivityDepth {
  days: number;
  /** People active in the window (sum of the buckets). */
  total: number;
  /** People whose only active day in the window is their signup day. */
  signupOnly: number;
  reconstructed: boolean;
  /**
   * How many distinct days people were active in the window.  min..max
   * inclusive; buckets 1, 2, 3–6, 7–13, 14+ clipped to the window, so a
   * 7-day window ends with {min: 7, max: 7} and a 30-day one with
   * {min: 14, max: 30}.
   */
  buckets: AdminDepthBucket[];
}

export interface AdminDepthBucket {
  min: number;
  max: number;
  count: number;
}

export interface AdminCohortWeek {
  /** Monday of the signup week. */
  weekStart: string;
  signups: number;
  /** The latest signup day in the week; null when nobody signed up. */
  lastSignup: string | null;
  /** The week's earliest possible return day predates instrumentation. */
  reconstructed: boolean;
  /** Horizons 1, 7, 14 and 30, in that order. */
  horizons: AdminCohortHorizon[];
}

export interface AdminCohortHorizon {
  days: 1 | 7 | 14 | 30;
  /** Members active on some day within `days` days after their signup day. */
  returned: number;
  /**
   * The week's members are final and every one's horizon is over: the week's
   * Sunday (weekStart + 6) <= today - 1 and lastSignup + days <= today - 1.
   * Until then `returned` (or the week's size) is still growing and must not
   * be shown as a rate.
   */
  eligible: boolean;
}
