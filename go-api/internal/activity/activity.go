// Package activity records that people were here.
//
// The rest of this codebase can already tell you what users DID -- every
// subscription, comment, follow and watch mark is durable and queryable.  What
// none of it can tell you is who was PRESENT.  A reader who opens the site
// most evenings, browses the catalogue and closes the tab leaves no row
// anywhere, so "daily active users", "when was this account last here" and
// "did last week's signups come back" were not slow queries against the old
// schema -- they had no answer in it at all.  Migration 0025 adds the table;
// this package is what writes it.
//
// It has two entry points, and both are server-side and unforgeable:
//
//	Middleware  attributed from a verified JWT on any authenticated /api call.
//	Login       one increment per successful password check.
//
// There is deliberately NO client-reported input.  An earlier revision had a
// public beacon endpoint for page views and playback starts; it was removed
// because every report was an origin request that Cloudflare's edge cache
// would otherwise have absorbed, and because it spent from the same per-IP
// rate-limit budget as real API calls.  Nothing that reaches this package can
// be sent by a stranger.
package activity

import "time"

// reportingZone is the +08:00 day boundary every date in this feature is
// bucketed on.  It MUST stay equal to the `AT TIME ZONE 'Asia/Shanghai'` used
// by migration 0025, by 0026's backfill, and by every query in
// internal/db/queries/activity.sql.
//
// Why a fixed offset instead of time.LoadLocation("Asia/Shanghai"):
// LoadLocation reads the operating system's tzdata, which a scratch or
// distroless container may not carry, and its failure mode is a nil location
// and a silent fall back to UTC -- an eight-hour bucketing error that looks
// like nothing at all.  China has observed no daylight saving since 1991, so
// +08 is not an approximation of Asia/Shanghai for any timestamp this system
// will ever bucket; it is the same answer with no runtime dependency.
//
// Why +08 rather than UTC at all: under UTC the 00:00-08:00 local slice of an
// evening lands on the previous calendar day.  That is prime viewing time for
// this catalogue, so UTC bucketing would split single evenings across two
// "active days" -- inflating visit-day counts and smearing the daily trend.
var reportingZone = time.FixedZone("UTC+8", 8*60*60)

// Day returns the reporting-day boundary t falls in, as midnight in the
// reporting zone.
//
// Used as a map key by the recorder so a buffered entry can never straddle
// midnight: without it, a flush at 00:01 would carry an hour of yesterday's
// requests into today's row, and the row's first_seen_at would claim the
// account was present before the day began (which migration 0025's
// last_seen_at >= first_seen_at CHECK would not catch, because both would be
// on the same wrong side).
//
// The stored `activity_date` column is NOT derived from this value -- the
// INSERT casts first_seen_at in SQL, so the database stays the single
// authority for what date a row carries.  This function only decides which
// rows get merged before they are sent.
func Day(t time.Time) time.Time {
	local := t.In(reportingZone)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, reportingZone)
}
