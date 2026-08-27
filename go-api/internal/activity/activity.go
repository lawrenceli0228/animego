// Package activity records that people were here.
//
// The rest of this codebase can already tell you what users DID -- every
// subscription, comment, follow and watch mark is durable and queryable.  What
// none of it can tell you is who was PRESENT.  A reader who opens the site
// most evenings, browses the catalogue and closes the tab leaves no row
// anywhere, so "daily active users", "when was this account last here" and
// "did last week's signups come back" were not slow queries against the old
// schema -- they had no answer in it at all.  Migration 0025 adds the two
// tables; this package is what writes them.
//
// It has three entry points and they carry very different weight:
//
//	Middleware   server-side, from a verified JWT.  Cannot be forged by a
//	             client, cannot be inflated, and is what DAU/WAU/MAU and
//	             retention are computed from.
//	Login        server-side, one increment per successful password check.
//	Beacon       client-reported page arrivals and video starts, including
//	             from anonymous visitors.  Anyone can call it.  See handlers.go
//	             for exactly how far it may be trusted.
//
// The trustworthy metrics deliberately do not read the beacon's table, so the
// one surface an outsider can influence cannot move the numbers a decision
// would rest on.
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

// Surface is a coarse bucket for "which part of the site was this".
//
// Coarse on purpose.  The finest thing this feature stores about where anyone
// went is one of the ten values below, aggregated per day with no user column
// -- see migration 0025's activity_surface_daily.  A path, a query string or a
// title id would turn the same table into a browsing history, and 0020 already
// settled that question for community telemetry: aggregate only, no
// identifier, no IP, no user agent.  This is the same line, drawn again.
type Surface = string

// The allow-list.  MUST stay equal to the CHECK constraint on
// activity_surface_daily (migration 0025) -- that constraint is the durable
// copy and binds every writer; this one exists so the API can answer 400 with
// a readable message instead of surfacing a constraint violation as a 500.
const (
	SurfaceHome      Surface = "home"
	SurfaceAnime     Surface = "anime"
	SurfaceWatch     Surface = "watch"
	SurfaceSeasonal  Surface = "seasonal"
	SurfaceLibrary   Surface = "library"
	SurfaceCommunity Surface = "community"
	SurfaceProfile   Surface = "profile"
	SurfaceSearch    Surface = "search"
	SurfaceAuth      Surface = "auth"

	// SurfaceOther is the catch-all, and it is load-bearing rather than
	// defensive padding.  A page that ships before somebody remembers to add
	// its name here should lose its label, not its count: a rejected beacon is
	// a hole in the traffic record that nothing ever fills in, whereas an
	// "other" bucket that starts growing is a visible prompt to name the new
	// surface.
	SurfaceOther Surface = "other"
)

// validSurfaces is the set form of the constants above.  A map rather than a
// slice scan because NormalizeSurface runs on a public endpoint's hot path.
var validSurfaces = map[Surface]struct{}{
	SurfaceHome:      {},
	SurfaceAnime:     {},
	SurfaceWatch:     {},
	SurfaceSeasonal:  {},
	SurfaceLibrary:   {},
	SurfaceCommunity: {},
	SurfaceProfile:   {},
	SurfaceSearch:    {},
	SurfaceAuth:      {},
	SurfaceOther:     {},
}

// maxSurfaceLen bounds what NormalizeSurface will even look at.  The body cap
// upstream is 1 MiB, so without this a caller could hand us a megabyte of text
// to hash against the map on every request.  No legitimate surface name comes
// close to 32 bytes.
const maxSurfaceLen = 32

// NormalizeSurface maps caller-supplied text onto the allow-list, collapsing
// anything unrecognised to SurfaceOther.
//
// It never fails, and that is a decision rather than laziness.  The beacon
// exists to count arrivals; refusing to count one because the client sent a
// label we do not recognise trades a small loss of resolution for a total loss
// of the datum.  The endpoint still rejects malformed BODIES -- what it will
// not do is reject a well-formed report for having an unfamiliar name.
//
// Because every value it returns is one of the ten constants, the string that
// reaches the INSERT is never caller-controlled, so the CHECK constraint can
// never be the thing that fails a request.
func NormalizeSurface(raw string) Surface {
	if len(raw) > maxSurfaceLen {
		return SurfaceOther
	}
	if _, ok := validSurfaces[raw]; ok {
		return raw
	}
	return SurfaceOther
}

// Kind is what a beacon reports happened.
type Kind = string

const (
	// KindPageView is one page arrival.  Fired per navigation, including
	// client-side ones, which is why it cannot be derived from request counts:
	// a soft navigation between two cached routes issues no API call at all.
	KindPageView Kind = "page_view"

	// KindPlayback is one video start.  Distinct from a page view of the watch
	// surface because arriving at a player and actually pressing play are
	// different facts, and the gap between them is the interesting one.
	KindPlayback Kind = "playback"
)

// ValidKind reports whether k is a kind the beacon accepts.
//
// Unlike NormalizeSurface this one DOES reject: kind decides which counter
// column moves, so an unrecognised value has no honest home.  Silently
// bucketing an unknown kind into page views would corrupt a number rather than
// coarsen it.
func ValidKind(k Kind) bool {
	return k == KindPageView || k == KindPlayback
}
