package admin

// activity.go — GET /api/admin/activity, the user-activity panel.
//
// WHAT THIS ENDPOINT EXISTS TO FIX.  Before migration 0025 the admin page
// could report how many accounts existed and what each of them had subscribed
// to, commented on or followed — and nothing else.  Every one of those is a
// deliberate social action, so a reader who visited every evening without
// performing one was, to every query this codebase could write, identical to
// somebody who registered once and never came back.  "Daily active users",
// "when was this account last here", "did last week's signups return" were not
// slow queries; they had no answer.  This endpoint is the answer, and its
// entire credibility rests on being clear about which parts of it are
// measured and which are inferred.
//
// FOUR RELIABILITY TIERS, AND THE PAYLOAD KEEPS THEM APART:
//
//	dau/wau/mau, retention  server-side, derived from a signed access token.
//	                        Unforgeable.  These are the numbers to decide on.
//	daily.activeUsers       same source.  Trustworthy at any point after
//	                        instrumentedSince; a floor before it (see below).
//	daily.pageViews,
//	daily.playbacks,
//	surfaces                client-reported through a public beacon.  Anyone
//	                        can move them.  Directional only — never read as
//	                        an audited figure.
//	everything before
//	instrumentedSince       reconstructed by migration 0026 from whatever
//	                        other tables happened to witness.  Interaction
//	                        days, not visits: a strict and small subset.
//
// instrumentedSince is returned precisely so the last tier can be drawn as a
// different thing rather than blended into the same line.  Plotted
// continuously with no divider, the switch from "interactions" to "visits"
// looks like the product suddenly took off, and it will be read that way.

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/activity"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

const (
	// defaultActivityDays is the window the panel opens on.  Thirty days is
	// long enough for a weekly rhythm to be visible (four repeats, so a dip is
	// distinguishable from a weekend) and short enough that a single day is
	// still a readable bar.
	defaultActivityDays = 30
	// minActivityDays keeps the window wider than a week.  Below that, weekday
	// effects dominate anything the chart could show.
	minActivityDays = 7
	// maxActivityDays caps the scan.  Ninety days is a full quarter and stays
	// well inside migration 0025's 400-day retention, so the endpoint can
	// never ask for a range the table has already pruned and return a
	// misleading run of empty days at the far end.
	maxActivityDays = 90

	// activityTimezoneLabel is reported in the payload so a reader can tell
	// which midnight the buckets are cut on without going to the schema.  It
	// MUST stay equal to the zone in internal/activity and in
	// internal/db/queries/activity.sql.
	activityTimezoneLabel = "Asia/Shanghai (UTC+8)"

	// dateLayout is the wire format for every date in this payload.  Plain
	// YYYY-MM-DD rather than RFC3339: these are calendar days in a named zone,
	// not instants, and rendering them as timestamps invites a browser to
	// re-interpret them in the reader's own timezone and shift every bar by
	// one day.
	dateLayout = "2006-01-02"
)

// activityQuerier is the sqlc subset this surface reads.  Declared here per
// "accept interfaces, return structs"; dbgen.Queries satisfies it.
type activityQuerier interface {
	GetActivitySnapshot(ctx context.Context) (dbgen.GetActivitySnapshotRow, error)
	ListActivityDailyTotals(ctx context.Context, dayCount int32) ([]dbgen.ListActivityDailyTotalsRow, error)
	ListNewUserCountsByDay(ctx context.Context, dayCount int32) ([]dbgen.ListNewUserCountsByDayRow, error)
	GetActivityRetention(ctx context.Context, windowDays int32) (dbgen.GetActivityRetentionRow, error)
	ListActivitySurfaceTotals(ctx context.Context, dayCount int32) ([]dbgen.ListActivitySurfaceTotalsRow, error)
}

// ActivityHandlers carries the deps for the activity panel.  Its own bundle
// rather than more methods on Handlers, following HantHandlers: this is a
// self-contained surface with its own querier, and widening the shared
// adminQuerier interface would force every existing test double to grow five
// methods it will never call.
type ActivityHandlers struct {
	Queries activityQuerier
	Log     *slog.Logger
}

// NewActivityHandlers constructs the bundle.  A nil querier panics at boot
// rather than at request time, matching NewHantHandlers.
func NewActivityHandlers(queries activityQuerier, log *slog.Logger) *ActivityHandlers {
	if queries == nil {
		panic("admin.NewActivityHandlers: nil querier")
	}
	if log == nil {
		log = slog.Default()
	}
	return &ActivityHandlers{Queries: queries, Log: log}
}

// ActivityDayPoint is one bar of the trend.
//
// Date is a calendar day in the reporting zone — see dateLayout.
type ActivityDayPoint struct {
	Date string `json:"date"`
	// ActiveUsers is distinct people, not events.  Unaffected by SSR fan-out
	// or polling, because a person counts once per day however many requests
	// they generate.
	ActiveUsers int64 `json:"activeUsers"`
	// NewUsers is signups bucketed on the same boundary, so the two series
	// line up bar for bar.
	NewUsers int64 `json:"newUsers"`
	Logins   int64 `json:"logins"`
	// Requests counts authenticated API calls, INCLUDING server-side rendering
	// fan-out and client polling.  A volume signal, not an engagement one; it
	// is in the payload mainly because it is what makes instrumentedSince
	// derivable, and because a sudden change in requests-per-active-user is a
	// useful smell.
	Requests int64 `json:"requests"`
	// PageViews and Playbacks are client-reported.  See the header's tiers.
	PageViews int64 `json:"pageViews"`
	Playbacks int64 `json:"playbacks"`
	// Instrumented is false for days that predate per-request recording, i.e.
	// days whose numbers came out of migration 0026's reconstruction.  The
	// flag travels with the point rather than being recomputed in the browser
	// from instrumentedSince, so a client cannot get the comparison subtly
	// wrong (off-by-one on the boundary day, or a timezone-shifted parse of
	// the date string).
	Instrumented bool `json:"instrumented"`
}

// ActivityRetentionBucket is one horizon's cohort and how much of it came back.
//
// Cohort is always reported next to Returned, never a bare rate, because at
// this scale a horizon can have a single-digit cohort and "33%" of three
// people is not a percentage anybody should act on.
type ActivityRetentionBucket struct {
	Cohort   int64 `json:"cohort"`
	Returned int64 `json:"returned"`
	// Rate is Returned/Cohort, 0 when the cohort is empty.  Computed here
	// rather than in the browser only so that the zero-denominator case has
	// exactly one definition.
	Rate float64 `json:"rate"`
}

// ActivityRetention is the three horizons.
//
// D1 and D7 are DAY-EXACT: active on precisely signup+1 and signup+7.  That is
// the definition every analytics product in this market uses and the one an
// operator will assume.  Their cohorts differ from each other and from Ever's,
// on purpose — an account that registered this morning has not failed to
// return tomorrow, so it is excluded from the D1 denominator until tomorrow
// exists.  D1Cohort > D7Cohort is normal.
//
// Ever is the companion worth reading first: any activity on any day after
// signup, across the whole window, with no eligibility gate.  At a few hundred
// signups it has enough mass to mean something, and it is what makes a 0/3
// day-7 figure legible as sparsity rather than as catastrophe.
type ActivityRetention struct {
	WindowDays int                     `json:"windowDays"`
	D1         ActivityRetentionBucket `json:"d1"`
	D7         ActivityRetentionBucket `json:"d7"`
	Ever       ActivityRetentionBucket `json:"ever"`
}

// ActivitySurfaceRow is one bucket of the traffic breakdown.
type ActivitySurfaceRow struct {
	Surface string `json:"surface"`
	// Authenticated and Anonymous are kept apart because the anonymous column
	// is the majority of this site and is invisible to every other number on
	// the panel, all of which are keyed on a user id.
	Authenticated int64 `json:"authenticated"`
	Anonymous     int64 `json:"anonymous"`
	Total         int64 `json:"total"`
}

// ActivityResp is the GET /api/admin/activity body.
//
// Retention and Surfaces are POINTERS/NIL-ABLE and that is load-bearing: when
// their query fails they are emitted as null, never as zeroes.  A zero in this
// payload is a claim ("nobody returned", "nobody visited"), so a failed fetch
// rendered as zeroes would be the panel asserting the exact thing it exists to
// measure.  Null lets the UI say "unavailable", which is true.
//
// The headline block (Dau/Wau/Mau/Daily) does NOT soft-fail: it is the panel.
// Emitting zeroes there would read as "the site is dead", which is worse than
// an error the operator can retry.
type ActivityResp struct {
	Days     int    `json:"days"`
	Timezone string `json:"timezone"`
	// InstrumentedSince is the first day per-request recording produced data,
	// derived from the data itself (the earliest row with a non-zero request
	// count; migration 0026's reconstruction always writes zero).  Null means
	// recording has not started — a container that has run the migrations but
	// not yet served traffic — and must be rendered as "not instrumented", not
	// as a date.
	InstrumentedSince *string `json:"instrumentedSince"`

	Dau int64 `json:"dau"`
	Wau int64 `json:"wau"`
	Mau int64 `json:"mau"`
	// Stickiness is DAU/MAU: of the people who used the site this month, what
	// share used it today.  0 when MAU is 0.
	Stickiness float64 `json:"stickiness"`

	Daily     []ActivityDayPoint   `json:"daily"`
	Retention *ActivityRetention   `json:"retention"`
	Surfaces  []ActivitySurfaceRow `json:"surfaces"`
}

// GetActivity implements GET /api/admin/activity?days=N.
func (h *ActivityHandlers) GetActivity(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	days := parseActivityDays(r.URL.Query().Get("days"))

	snapshot, err := h.Queries.GetActivitySnapshot(ctx)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "activity snapshot query failed"))
		return
	}

	totals, err := h.Queries.ListActivityDailyTotals(ctx, int32(days))
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "activity daily query failed"))
		return
	}

	signups, err := h.Queries.ListNewUserCountsByDay(ctx, int32(days))
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "activity signup query failed"))
		return
	}

	var instrumentedSince *string
	if snapshot.InstrumentedSince.Valid {
		s := snapshot.InstrumentedSince.Time.Format(dateLayout)
		instrumentedSince = &s
	}

	resp := ActivityResp{
		Days:              days,
		Timezone:          activityTimezoneLabel,
		InstrumentedSince: instrumentedSince,
		Dau:               snapshot.Dau,
		Wau:               snapshot.Wau,
		Mau:               snapshot.Mau,
		Stickiness:        ratio(snapshot.Dau, snapshot.Mau),
		Daily:             buildDailySeries(days, activity.Day(time.Now()), totals, signups, instrumentedSince),
	}

	// Retention soft-fails to null.  It reads users joined against the
	// activity table with three correlated EXISTS probes per cohort member —
	// the most expensive read on this endpoint and the one most likely to time
	// out first — and losing it must not take the headline numbers with it.
	if row, rerr := h.Queries.GetActivityRetention(ctx, int32(days)); rerr != nil {
		h.Log.WarnContext(ctx, "admin activity: retention query failed; omitting the block",
			"err", rerr.Error(), "days", days)
	} else {
		resp.Retention = &ActivityRetention{
			WindowDays: days,
			D1:         retentionBucket(row.D1Cohort, row.D1Returned),
			D7:         retentionBucket(row.D7Cohort, row.D7Returned),
			Ever:       retentionBucket(row.EverCohort, row.EverReturned),
		}
	}

	// Surfaces soft-fails to null for the same reason, plus one of its own:
	// it is the only block fed by a public endpoint, so it is the block whose
	// absence costs the least.
	if rows, serr := h.Queries.ListActivitySurfaceTotals(ctx, int32(days)); serr != nil {
		h.Log.WarnContext(ctx, "admin activity: surface query failed; omitting the block",
			"err", serr.Error(), "days", days)
	} else {
		// Allocated even when empty so "[]" (nothing recorded) stays
		// distinguishable from "null" (query failed) on the wire.
		surfaces := make([]ActivitySurfaceRow, 0, len(rows))
		for _, row := range rows {
			surfaces = append(surfaces, ActivitySurfaceRow{
				Surface:       row.Surface,
				Authenticated: row.AuthedCount,
				Anonymous:     row.AnonCount,
				Total:         row.TotalCount,
			})
		}
		resp.Surfaces = surfaces
	}

	httpx.Data(w, http.StatusOK, resp)
}

// parseActivityDays clamps the window.  A missing or unparseable value falls
// back to the default rather than 400-ing: this is a dashboard knob, and the
// worst outcome of a typo should be the default view, not an error page.
func parseActivityDays(raw string) int {
	days := defaultActivityDays
	if raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			days = parsed
		}
	}
	if days < minActivityDays {
		return minActivityDays
	}
	if days > maxActivityDays {
		return maxActivityDays
	}
	return days
}

// ratio is n/d with a defined answer at d == 0.
//
// Zero rather than NaN, and the difference matters on the wire: NaN is not
// representable in JSON, so encoding/json fails the whole response rather than
// emitting a funny number.  An empty denominator genuinely means "no rate to
// report", and every consumer already renders 0 as 0%.
func ratio(n, d int64) float64 {
	if d <= 0 {
		return 0
	}
	return float64(n) / float64(d)
}

func retentionBucket(cohort, returned int64) ActivityRetentionBucket {
	return ActivityRetentionBucket{
		Cohort:   cohort,
		Returned: returned,
		Rate:     ratio(returned, cohort),
	}
}

// buildDailySeries turns the two sparse query results into one dense series,
// oldest day first, with a point for every day in the window.
//
// GAPS ARE FILLED HERE, NOT IN SQL, and the reason is that this is a judgement
// rather than a lookup.  "No row" and "a row of zeroes" are different claims —
// one says nobody came, the other says we did not look — and only the caller
// knows the window well enough to tell them apart.  A generate_series join
// would bury that decision in a query plan; here it is a pure function with a
// unit test and no database attached.
//
// `today` is the current reporting day (midnight in the +08 zone), passed in
// rather than read from the clock so the function is deterministic under test.
// The window is [today-(days-1), today] inclusive, which is the same range the
// SQL predicates use — they must agree, or the first bar would be a
// permanently empty day the query never fetches.
//
// Instrumented is decided by string comparison on YYYY-MM-DD, which is
// correct because that format sorts lexicographically in date order and both
// sides come from the same +08 bucketing. Comparing parsed instants instead
// would reintroduce exactly the timezone ambiguity dateLayout exists to avoid.
func buildDailySeries(
	days int,
	today time.Time,
	totals []dbgen.ListActivityDailyTotalsRow,
	signups []dbgen.ListNewUserCountsByDayRow,
	instrumentedSince *string,
) []ActivityDayPoint {
	byDate := make(map[string]dbgen.ListActivityDailyTotalsRow, len(totals))
	for _, row := range totals {
		if !row.ActivityDate.Valid {
			continue
		}
		byDate[row.ActivityDate.Time.Format(dateLayout)] = row
	}
	newByDate := make(map[string]int64, len(signups))
	for _, row := range signups {
		if !row.SignupDate.Valid {
			continue
		}
		newByDate[row.SignupDate.Time.Format(dateLayout)] = row.NewUsers
	}

	out := make([]ActivityDayPoint, 0, days)
	for i := days - 1; i >= 0; i-- {
		date := today.AddDate(0, 0, -i).Format(dateLayout)
		point := ActivityDayPoint{
			Date:     date,
			NewUsers: newByDate[date],
			// A day before instrumentation began is never "instrumented", and
			// a nil instrumentedSince means recording has not started at all,
			// so nothing is.
			Instrumented: instrumentedSince != nil && date >= *instrumentedSince,
		}
		if row, ok := byDate[date]; ok {
			point.ActiveUsers = row.ActiveUsers
			point.Logins = row.Logins
			point.Requests = row.Requests
			point.PageViews = row.PageViews
			point.Playbacks = row.Playbacks
		}
		out = append(out, point)
	}
	return out
}
