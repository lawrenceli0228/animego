package admin

// activity_unit_test.go — the pure decisions behind the activity panel, tested
// without a database.  The DB-backed half lives in activity_pg_test.go.

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/activity"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

func day(s string) pgtype.Date {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		panic(err)
	}
	return pgtype.Date{Time: t, Valid: true}
}

func TestParseActivityDays(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int
	}{
		{"absent falls back to the default", "", defaultActivityDays},
		// A typo in a dashboard query string should show the default view, not
		// an error page.
		{"garbage falls back to the default", "thirty", defaultActivityDays},
		{"in range passes through", "45", 45},
		{"below the floor clamps up", "1", minActivityDays},
		{"negative clamps up", "-9", minActivityDays},
		{"above the ceiling clamps down", "3650", maxActivityDays},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, parseActivityDays(tc.in))
		})
	}
}

// TestParseActivityDays_CeilingStaysInsideRetention: the window may never
// exceed what migration 0025's prune keeps, or the far end of the chart would
// be a run of empty days caused by retention and read as a collapse in usage.
func TestParseActivityDays_CeilingStaysInsideRetention(t *testing.T) {
	const retentionDays = 400 // migration 0025's 'user-activity-daily-prune'
	assert.Less(t, maxActivityDays, retentionDays,
		"the widest requestable window must stay inside the retention horizon")
}

func TestRatio(t *testing.T) {
	assert.InDelta(t, 0.25, ratio(1, 4), 1e-9)
	// Zero rather than NaN, and not for tidiness: NaN is not representable in
	// JSON, so encoding/json would fail the entire response rather than emit a
	// funny number.
	assert.Equal(t, 0.0, ratio(3, 0))
	assert.Equal(t, 0.0, ratio(0, 0))
	assert.Equal(t, 0.0, ratio(5, -2))
}

// TestBuildDailySeries_FillsGapsWithZeroes is the reason gap-filling is in Go.
//
// A missing bar and a zero bar are different claims — "we did not look" versus
// "nobody came" — and only the caller knows the window well enough to tell
// them apart.
func TestBuildDailySeries_FillsGapsWithZeroes(t *testing.T) {
	today := activity.Day(time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC))
	totals := []dbgen.ListActivityDailyTotalsRow{
		{ActivityDate: day("2026-08-26"), ActiveUsers: 4, Requests: 40, Logins: 1},
		{ActivityDate: day("2026-08-28"), ActiveUsers: 7, Requests: 70, Logins: 3},
	}
	signups := []dbgen.ListNewUserCountsByDayRow{
		{SignupDate: day("2026-08-27"), NewUsers: 2},
	}

	got := buildDailySeries(4, today, totals, signups, nil)

	require.Len(t, got, 4, "one point per day in the window, present or not")
	assert.Equal(t, "2026-08-25", got[0].Date, "oldest first")
	assert.Equal(t, "2026-08-28", got[3].Date, "window is inclusive of today")

	// 25th: nothing at all.
	assert.Equal(t, int64(0), got[0].ActiveUsers)
	// 26th: activity, no signups.
	assert.Equal(t, int64(4), got[1].ActiveUsers)
	assert.Equal(t, int64(40), got[1].Requests)
	assert.Equal(t, int64(0), got[1].NewUsers)
	// 27th: signups but nobody active — the two series are independent and a
	// day can legitimately have one without the other.
	assert.Equal(t, int64(0), got[2].ActiveUsers)
	assert.Equal(t, int64(2), got[2].NewUsers)
	// 28th: everything.
	assert.Equal(t, int64(7), got[3].ActiveUsers)
	assert.Equal(t, int64(70), got[3].Requests)
	assert.Equal(t, int64(3), got[3].Logins)
}

// TestBuildDailySeries_InstrumentedFlagMarksTheSeam.
//
// Left of the seam the numbers are migration 0026's reconstruction —
// interaction days, a strict and small subset of real visits.  Right of it
// they are visits.  Graphed as one line with no divider, the changeover looks
// like the product suddenly took off, and it will be read that way.  The flag
// travels per point so the browser cannot get the comparison subtly wrong.
func TestBuildDailySeries_InstrumentedFlagMarksTheSeam(t *testing.T) {
	today := activity.Day(time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC))
	since := "2026-08-27"

	got := buildDailySeries(4, today, nil, nil, &since)

	require.Len(t, got, 4)
	assert.False(t, got[0].Instrumented, "2026-08-25 predates instrumentation")
	assert.False(t, got[1].Instrumented, "2026-08-26 predates instrumentation")
	assert.True(t, got[2].Instrumented, "the boundary day itself counts as instrumented")
	assert.True(t, got[3].Instrumented)
}

// TestBuildDailySeries_NilInstrumentedSinceMarksNothing: a null from the
// database means per-request recording has never produced data (a container
// that ran the migrations but has not served traffic).  Every point must then
// be un-instrumented; treating nil as "always on" would relabel the entire
// reconstructed history as measured.
func TestBuildDailySeries_NilInstrumentedSinceMarksNothing(t *testing.T) {
	today := activity.Day(time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC))
	for _, p := range buildDailySeries(7, today, nil, nil, nil) {
		assert.False(t, p.Instrumented, "%s should not be marked instrumented", p.Date)
	}
}

// TestBuildDailySeries_IgnoresInvalidDates: a NULL date cannot be placed on the
// axis, and silently mapping it to the zero time would put a bar on year 1 —
// or, worse, collide with a real day after formatting.
func TestBuildDailySeries_IgnoresInvalidDates(t *testing.T) {
	today := activity.Day(time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC))
	totals := []dbgen.ListActivityDailyTotalsRow{
		{ActivityDate: pgtype.Date{}, ActiveUsers: 99},
	}
	signups := []dbgen.ListNewUserCountsByDayRow{
		{SignupDate: pgtype.Date{}, NewUsers: 99},
	}

	for _, p := range buildDailySeries(3, today, totals, signups, nil) {
		assert.Equal(t, int64(0), p.ActiveUsers)
		assert.Equal(t, int64(0), p.NewUsers)
	}
}

// TestBuildDailySeries_WindowMatchesTheSQLPredicate.
//
// The queries filter on `activity_date >= today - (day_count - 1)`.  If this
// function generated one more day than that, the oldest bar would be a day the
// query never fetches — permanently zero, and indistinguishable from a real
// quiet day.
func TestBuildDailySeries_WindowMatchesTheSQLPredicate(t *testing.T) {
	today := activity.Day(time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC))
	const days = 30

	got := buildDailySeries(days, today, nil, nil, nil)

	require.Len(t, got, days)
	oldest := today.AddDate(0, 0, -(days - 1)).Format(dateLayout)
	assert.Equal(t, oldest, got[0].Date)
	assert.Equal(t, today.Format(dateLayout), got[len(got)-1].Date)
}

func TestRetentionBucket(t *testing.T) {
	b := retentionBucket(10, 3)
	assert.Equal(t, int64(10), b.Cohort)
	assert.Equal(t, int64(3), b.Returned)
	assert.InDelta(t, 0.3, b.Rate, 1e-9)

	// An empty cohort is the normal state on a young deployment, not an error.
	empty := retentionBucket(0, 0)
	assert.Equal(t, 0.0, empty.Rate)
}
