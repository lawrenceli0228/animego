package admin

// activity_unit_test.go — the pure decisions behind the activity panel and the
// snapshot wiring, tested without a database.  The SQL half lives in
// activity_pg_test.go.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

func day(s string) pgtype.Date {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		panic(err)
	}
	return pgtype.Date{Time: t, Valid: true}
}

// rd is the panelDay of a YYYY-MM-DD literal.
func actDay(t *testing.T, s string) panelDay {
	t.Helper()
	d, ok := panelDayOf(day(s))
	require.True(t, ok, s)
	return d
}

// actClock is the clock newActivityClock builds for today and, unless since is
// empty, an instrumentation start.
func actClock(t *testing.T, today, since string) activityClock {
	t.Helper()
	row := dbgen.GetActivityClockRow{Today: day(today), AsOf: today + " 10:00"}
	if since != "" {
		row.InstrumentedSince = day(since)
	}
	c, err := newActivityClock(row)
	require.NoError(t, err)
	return c
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
		{"the UI's three windows pass through", "7", 7},
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
	// The previous window of the 30-day card reaches back 59 days.
	assert.Less(t, 2*activityLongWindowDays, retentionDays)
}

// --- panelDay -------------------------------------------------------------

func TestReportingDay_IsCalendarArithmetic(t *testing.T) {
	assert.Equal(t, "2026-03-11", actDay(t, "2026-03-11").String(), "round trip")
	assert.Equal(t, "2027-01-01", (actDay(t, "2026-12-31") + 1).String(), "across a year")
	assert.Equal(t, "2028-02-29", (actDay(t, "2028-02-28") + 1).String(), "a leap day exists")
	assert.Equal(t, "2026-03-01", (actDay(t, "2026-02-28") + 1).String(), "and a common year has none")
	assert.Equal(t, "1969-12-31", (actDay(t, "1970-01-01") - 1).String(), "before the epoch")
	assert.Equal(t, panelDay(29), actDay(t, "2026-03-31")-actDay(t, "2026-03-02"))
}

// TestReportingDayOf_ReadsTheCalendarDayOnly: whatever location a decoded
// date carries, the day is its year, month and day.  Converting the instant
// instead would move a +08 midnight onto the previous UTC day.
func TestReportingDayOf_ReadsTheCalendarDayOnly(t *testing.T) {
	plus8 := time.FixedZone("UTC+8", 8*60*60)
	d, ok := panelDayOf(pgtype.Date{Time: time.Date(2026, 3, 11, 0, 0, 0, 0, plus8), Valid: true})
	require.True(t, ok)
	assert.Equal(t, "2026-03-11", d.String())

	_, ok = panelDayOf(pgtype.Date{})
	assert.False(t, ok, "NULL is not a day")
	_, ok = panelDayOf(pgtype.Date{InfinityModifier: pgtype.Infinity, Valid: true})
	assert.False(t, ok, "infinity is not a day")
}

// --- depth --------------------------------------------------------------------

// TestDepthBuckets pins the three windows the UI offers.  A 7-day window can
// hold at most 7 active days, so 7–13 shrinks to 7–7 and 14+ disappears; a
// longer window closes 14+ at its own length.
func TestDepthBuckets(t *testing.T) {
	b := func(min, max int) ActivityDepthBucket { return ActivityDepthBucket{Min: min, Max: max} }
	cases := []struct {
		days int
		want []ActivityDepthBucket
	}{
		{7, []ActivityDepthBucket{b(1, 1), b(2, 2), b(3, 6), b(7, 7)}},
		{30, []ActivityDepthBucket{b(1, 1), b(2, 2), b(3, 6), b(7, 13), b(14, 30)}},
		{90, []ActivityDepthBucket{b(1, 1), b(2, 2), b(3, 6), b(7, 13), b(14, 90)}},
		// The edges around the open bucket, reachable through ?days=13/14.
		{13, []ActivityDepthBucket{b(1, 1), b(2, 2), b(3, 6), b(7, 13)}},
		{14, []ActivityDepthBucket{b(1, 1), b(2, 2), b(3, 6), b(7, 13), b(14, 14)}},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("%d days", tc.days), func(t *testing.T) {
			assert.Equal(t, tc.want, activityDepthBuckets(tc.days))
		})
	}
}

// TestDepthBuckets_TileEveryAllowedWindow: for every window the endpoint can
// be asked for, each possible day count 1..days falls in exactly one bucket.
// A gap would drop people from the card and make its total disagree with the
// window's active count.
func TestDepthBuckets_TileEveryAllowedWindow(t *testing.T) {
	for days := minActivityDays; days <= maxActivityDays; days++ {
		buckets := activityDepthBuckets(days)
		next := 1
		for _, bk := range buckets {
			require.Equal(t, next, bk.Min, "days=%d: bucket starts must follow on", days)
			require.LessOrEqual(t, bk.Min, bk.Max, "days=%d", days)
			next = bk.Max + 1
		}
		require.Equal(t, days+1, next, "days=%d: the last bucket must end at the window length", days)
	}
}

func TestBuildActivityDepth_FoldsTheHistogram(t *testing.T) {
	c := actClock(t, "2026-03-11", "2026-01-01")
	rows := []dbgen.ListActivityDepthRow{
		{ActiveDays: 1, People: 5, SignupOnly: 3},
		{ActiveDays: 2, People: 4},
		{ActiveDays: 5, People: 2},
		{ActiveDays: 13, People: 1},
		{ActiveDays: 14, People: 1},
		{ActiveDays: 30, People: 2},
	}

	got, err := buildActivityDepth(c, 30, rows)
	require.NoError(t, err)

	counts := make([]int64, 0, len(got.Buckets))
	for _, bk := range got.Buckets {
		counts = append(counts, bk.Count)
	}
	assert.Equal(t, []int64{5, 4, 2, 1, 3}, counts, "13 is in 7–13; 14 and 30 are in 14–30")
	assert.Equal(t, int64(15), got.Total, "total is the sum of the buckets")
	assert.Equal(t, int64(3), got.SignupOnly)
	assert.Equal(t, 30, got.Days)
	assert.False(t, got.Reconstructed)
}

// TestBuildActivityDepth_RejectsAnImpossibleDayCount: a 7-day window cannot
// hold 8 active days.  Dropping the row would make the card's total quietly
// disagree with the window card; refusing it surfaces the bug.
func TestBuildActivityDepth_RejectsAnImpossibleDayCount(t *testing.T) {
	c := actClock(t, "2026-03-11", "")
	for _, n := range []int64{0, 8} {
		_, err := buildActivityDepth(c, 7, []dbgen.ListActivityDepthRow{{ActiveDays: n, People: 1}})
		assert.Error(t, err, "active days %d", n)
	}
}

func TestBuildActivityDepth_ReconstructedFollowsTheWindowStart(t *testing.T) {
	cases := []struct {
		since string
		days  int
		want  bool
	}{
		{"2026-03-05", 7, false}, // window starts on the seam itself
		{"2026-03-06", 7, true},  // window starts the day before it
		{"2026-03-05", 30, true},
		{"2026-02-10", 30, false},
		{"", 7, true}, // nothing instrumented at all
	}
	for _, tc := range cases {
		got, err := buildActivityDepth(actClock(t, "2026-03-11", tc.since), tc.days, nil)
		require.NoError(t, err)
		assert.Equal(t, tc.want, got.Reconstructed, "since=%q days=%d", tc.since, tc.days)
		assert.Zero(t, got.Total, "no rows, nobody active")
	}
}

// --- daily --------------------------------------------------------------------

// TestBuildActivityDaily_FillsGapsAgainstTheSnapshotToday is the reason gap
// filling is in Go, and the reason it takes today from the database.
//
// A missing bar and a zero bar are different claims — "we did not look" versus
// "nobody came".  The axis is laid out from the snapshot's today (2031 here, so
// a slip back to this machine's clock could not pass), across a year boundary.
func TestBuildActivityDaily_FillsGapsAgainstTheSnapshotToday(t *testing.T) {
	c := actClock(t, "2031-01-02", "2030-12-01")
	rows := []dbgen.ListActivityDailyRow{
		{ActivityDate: day("2030-12-28"), ReturningPeople: 3, SignupDayPeople: 1, Requests: 40, Logins: 1},
		{ActivityDate: day("2031-01-02"), ReturningPeople: 6, SignupDayPeople: 2, Requests: 70, Logins: 3},
	}

	got, err := buildActivityDaily(c, 7, rows)
	require.NoError(t, err)

	dates := make([]string, 0, len(got))
	for _, p := range got {
		dates = append(dates, p.Date)
	}
	assert.Equal(t, []string{
		"2030-12-27", "2030-12-28", "2030-12-29", "2030-12-30", "2030-12-31", "2031-01-01", "2031-01-02",
	}, dates, "exactly `days` points, oldest first, ending on the snapshot's today")

	assert.Equal(t, ActivityDay{Date: "2030-12-27", Instrumented: true}, got[0], "a gap is a zero row")
	assert.Equal(t, ActivityDay{Date: "2030-12-28", Returning: 3, SignupDay: 1, Requests: 40, Logins: 1, Instrumented: true}, got[1])
	assert.Equal(t, ActivityDay{Date: "2031-01-02", Returning: 6, SignupDay: 2, Requests: 70, Logins: 3, Instrumented: true, Partial: true}, got[6])
}

// TestBuildActivityDaily_Flags: instrumented flips exactly on
// instrumentedSince (the seam day itself is instrumented), and only today is
// partial.
func TestBuildActivityDaily_Flags(t *testing.T) {
	got, err := buildActivityDaily(actClock(t, "2026-03-11", "2026-03-08"), 7, nil)
	require.NoError(t, err)

	instrumented := map[string]bool{}
	var partial []string
	for _, p := range got {
		instrumented[p.Date] = p.Instrumented
		if p.Partial {
			partial = append(partial, p.Date)
		}
	}
	assert.Equal(t, map[string]bool{
		"2026-03-05": false, "2026-03-06": false, "2026-03-07": false,
		"2026-03-08": true, "2026-03-09": true, "2026-03-10": true, "2026-03-11": true,
	}, instrumented)
	assert.Equal(t, []string{"2026-03-11"}, partial)
}

// TestBuildActivityDaily_NothingInstrumentedMarksNothing: a null seam means
// per-request recording has never produced data.  Treating it as "always on"
// would relabel the whole reconstructed history as measured.
func TestBuildActivityDaily_NothingInstrumentedMarksNothing(t *testing.T) {
	got, err := buildActivityDaily(actClock(t, "2026-03-11", ""), 30, nil)
	require.NoError(t, err)
	require.Len(t, got, 30)
	for _, p := range got {
		assert.False(t, p.Instrumented, "%s should not be marked instrumented", p.Date)
	}
}

// TestBuildActivityDaily_RejectsRowsItCannotPlace: the query only returns days
// inside the window, once each.  A row that breaks that would either vanish
// from the axis or overwrite another day, and the chart would stop adding up
// to the cards without anything on screen to say so.
func TestBuildActivityDaily_RejectsRowsItCannotPlace(t *testing.T) {
	c := actClock(t, "2026-03-11", "")
	cases := map[string][]dbgen.ListActivityDailyRow{
		"before the window": {{ActivityDate: day("2026-03-04")}},
		"after today":       {{ActivityDate: day("2026-03-12")}},
		"no date":           {{ActivityDate: pgtype.Date{}}},
		"the same day twice": {
			{ActivityDate: day("2026-03-10"), ReturningPeople: 1},
			{ActivityDate: day("2026-03-10"), ReturningPeople: 2},
		},
	}
	for name, rows := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := buildActivityDaily(c, 7, rows)
			assert.Error(t, err)
		})
	}
	// The window's first and last days are inside it.
	_, err := buildActivityDaily(c, 7, []dbgen.ListActivityDailyRow{
		{ActivityDate: day("2026-03-05")}, {ActivityDate: day("2026-03-11")},
	})
	assert.NoError(t, err)
}

// --- today / windows / signups ------------------------------------------------

// TestBuildTodayActive_SameTimeIsNullOnReconstructedDays: 0026's rows carry the
// time of an interaction, not of a first visit, so a same-time comparison
// against a reconstructed day would be a made-up number.
func TestBuildTodayActive_SameTimeIsNullOnReconstructedDays(t *testing.T) {
	row := dbgen.GetActivityTodayActiveRow{Active: 9, SameTimeYesterday: 7, SameTimeLastWeek: 5, YesterdayTotal: 11}
	seven, five := int64(7), int64(5)
	cases := []struct {
		since         string
		wantYesterday *int64
		wantLastWeek  *int64
	}{
		{"", nil, nil},
		{"2026-03-11", nil, nil},      // only today is instrumented
		{"2026-03-10", &seven, nil},   // yesterday is the seam day
		{"2026-03-05", &seven, nil},   // seven days ago is still before it
		{"2026-03-04", &seven, &five}, // seven days ago is the seam day
		{"2026-01-01", &seven, &five}, // long instrumented
	}
	for _, tc := range cases {
		t.Run("since="+tc.since, func(t *testing.T) {
			got := buildActivityTodayActive(actClock(t, "2026-03-11", tc.since), row)
			assert.Equal(t, int64(9), got.Active, "today's count is never withheld")
			assert.Equal(t, int64(11), got.YesterdayTotal, "nor is yesterday's whole-day count")
			assert.Equal(t, tc.wantYesterday, got.SameTimeYesterday)
			assert.Equal(t, tc.wantLastWeek, got.SameTimeLastWeek)
		})
	}
}

func TestBuildActivityWindow_PartsAddUpAndFlagsFollowTheStarts(t *testing.T) {
	row := dbgen.GetActivityWindowRow{
		ReturningPeople: 6, SignupOnlyPeople: 2, PrevReturningPeople: 4, PrevSignupOnlyPeople: 3,
	}
	cases := []struct {
		days      int
		since     string
		want      bool
		wantPrev  bool
		situation string
	}{
		{7, "2026-03-05", false, true, "window starts on the seam (today-6); prev starts today-13"},
		{7, "2026-03-06", true, true, "seam one day into the window"},
		{7, "2026-02-26", false, false, "prev starts on the seam (today-13)"},
		{7, "2026-02-27", false, true, "seam one day into prev"},
		{30, "2026-02-10", false, true, "window starts on the seam (today-29)"},
		{30, "2026-01-11", false, false, "prev starts on the seam (today-59)"},
		{30, "2026-01-12", false, true, "seam one day into prev"},
		{30, "", true, true, "nothing instrumented"},
	}
	for _, tc := range cases {
		t.Run(tc.situation, func(t *testing.T) {
			got := buildActivityWindow(actClock(t, "2026-03-11", tc.since), tc.days, row)
			assert.Equal(t, tc.days, got.Days)
			assert.Equal(t, int64(8), got.Active, "active is returning + signupOnly")
			assert.Equal(t, int64(6), got.Returning)
			assert.Equal(t, int64(2), got.SignupOnly)
			assert.Equal(t, int64(7), got.PrevActive)
			assert.Equal(t, int64(4), got.PrevReturning)
			assert.Equal(t, int64(3), got.PrevSignupOnly)
			assert.Equal(t, tc.want, got.Reconstructed, "reconstructed")
			assert.Equal(t, tc.wantPrev, got.PrevReconstructed, "prevReconstructed")
		})
	}
}

func TestBuildSignupWindow(t *testing.T) {
	row := dbgen.GetActivitySignupsRow{Signups: 12, PrevSignups: 9, ReturnedAfter: 4}

	got := buildActivitySignupWindow(actClock(t, "2026-03-11", "2026-02-10"), 30, row)
	assert.Equal(t, ActivitySignupWindow{Count: 12, PrevCount: 9, ReturnedAfter: 4}, got,
		"the window starts on the seam: measured")

	got = buildActivitySignupWindow(actClock(t, "2026-03-11", "2026-02-11"), 30, row)
	assert.True(t, got.Reconstructed, "the first day predates the seam")
}

// --- cohorts ------------------------------------------------------------------

func actCohortRow(weekStart string, signups int64, lastSignup string) dbgen.ListActivityCohortsRow {
	row := dbgen.ListActivityCohortsRow{WeekStart: day(weekStart), Signups: signups}
	if lastSignup != "" {
		row.LastSignup = day(lastSignup)
	}
	return row
}

// TestBuildActivityCohorts_EligibilityBoundary is the arithmetic most likely
// to be wrong and least likely to look wrong.  A horizon of h days is over
// once lastSignup + h is a whole day in the past: lastSignup + h <= today - 1.
// Somebody who signed up yesterday is NOT eligible for the one-day horizon --
// today is their day 1 and it is not over.
func TestBuildActivityCohorts_EligibilityBoundary(t *testing.T) {
	const today = "2026-03-11" // a Wednesday
	horizon := map[int]int{1: 0, 7: 1, 14: 2, 30: 3}
	cases := []struct {
		lastSignup string
		days       int
		want       bool
	}{
		{"2026-03-09", 1, true},  // today-2
		{"2026-03-10", 1, false}, // today-1
		{"2026-03-03", 7, true},  // today-8
		{"2026-03-04", 7, false}, // today-7
		{"2026-02-24", 14, true}, // today-15
		{"2026-02-25", 14, false},
		{"2026-02-08", 30, true}, // today-31
		{"2026-02-09", 30, false},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("last %s, %d days", tc.lastSignup, tc.days), func(t *testing.T) {
			got, err := buildActivityCohorts(actClock(t, today, "2026-01-01"),
				[]dbgen.ListActivityCohortsRow{actCohortRow("2026-02-02", 3, tc.lastSignup)})
			require.NoError(t, err)
			require.Len(t, got, 1)
			h := got[0].Horizons[horizon[tc.days]]
			assert.Equal(t, tc.days, h.Days)
			assert.Equal(t, tc.want, h.Eligible)
		})
	}
}

// TestBuildActivityCohorts_OpenWeekIsNotEligible: until the week's Sunday is
// over, a later signup can still join it with a horizon that has barely
// begun, so no horizon is eligible however early the members so far signed
// up.  Wednesday with every member on Monday was the case that printed a
// one-day rate and took it back that afternoon.
func TestBuildActivityCohorts_OpenWeekIsNotEligible(t *testing.T) {
	const week = "2026-03-09" // a Monday
	cases := []struct {
		today, lastSignup string
		want              bool
	}{
		{"2026-03-11", "2026-03-09", false}, // Wednesday: the week is open
		{"2026-03-15", "2026-03-13", false}, // Sunday: still open, today is not over
		{"2026-03-16", "2026-03-13", true},  // Monday after: final, and Friday's day 1 is over
		{"2026-03-16", "2026-03-15", false}, // final, but Sunday's day 1 is today
		{"2026-03-17", "2026-03-15", true},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("today %s, last %s", tc.today, tc.lastSignup), func(t *testing.T) {
			got, err := buildActivityCohorts(actClock(t, tc.today, "2026-01-01"),
				[]dbgen.ListActivityCohortsRow{actCohortRow(week, 2, tc.lastSignup)})
			require.NoError(t, err)
			require.Len(t, got, 1)
			h := got[0].Horizons[0]
			require.Equal(t, 1, h.Days)
			assert.Equal(t, tc.want, h.Eligible)
		})
	}
}

// TestBuildActivityCohorts_EmptyWeekIsNeverEligible: no members, no last
// signup, nothing to report a rate for.
func TestBuildActivityCohorts_EmptyWeekIsNeverEligible(t *testing.T) {
	got, err := buildActivityCohorts(actClock(t, "2026-03-11", "2025-01-01"),
		[]dbgen.ListActivityCohortsRow{actCohortRow("2026-01-05", 0, "")})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Nil(t, got[0].LastSignup)
	for _, h := range got[0].Horizons {
		assert.False(t, h.Eligible, "%d days", h.Days)
	}
}

// TestBuildActivityCohorts_MapsEveryHorizonInOrder: the payload lists
// horizons 1, 7, 14, 30 and each must carry its own column.
func TestBuildActivityCohorts_MapsEveryHorizonInOrder(t *testing.T) {
	row := actCohortRow("2026-01-05", 9, "2026-01-08")
	row.Returned1, row.Returned7, row.Returned14, row.Returned30 = 2, 4, 5, 7

	got, err := buildActivityCohorts(actClock(t, "2026-03-11", "2025-01-01"), []dbgen.ListActivityCohortsRow{row})
	require.NoError(t, err)
	assert.Equal(t, []ActivityCohortHorizon{
		{Days: 1, Returned: 2, Eligible: true},
		{Days: 7, Returned: 4, Eligible: true},
		{Days: 14, Returned: 5, Eligible: true},
		{Days: 30, Returned: 7, Eligible: true},
	}, got[0].Horizons)
	assert.Equal(t, "2026-01-05", got[0].WeekStart)
	require.NotNil(t, got[0].LastSignup)
	assert.Equal(t, "2026-01-08", *got[0].LastSignup)
	assert.Equal(t, int64(9), got[0].Signups)
}

// TestBuildActivityCohorts_ReconstructedBoundary: a week is reconstructed when
// its earliest possible return day, the Tuesday, predates the seam.
func TestBuildActivityCohorts_ReconstructedBoundary(t *testing.T) {
	cases := []struct {
		since string
		want  bool
	}{
		{"2026-03-03", false}, // the Tuesday is the seam day
		{"2026-03-04", true},  // the Tuesday is the day before it
		{"2026-03-02", false},
		{"", true},
	}
	for _, tc := range cases {
		got, err := buildActivityCohorts(actClock(t, "2026-03-11", tc.since),
			[]dbgen.ListActivityCohortsRow{actCohortRow("2026-03-02", 1, "2026-03-02")})
		require.NoError(t, err)
		assert.Equal(t, tc.want, got[0].Reconstructed, "since=%q", tc.since)
	}
}

func TestBuildActivityCohorts_RejectsInconsistentWeeks(t *testing.T) {
	c := actClock(t, "2026-03-11", "")
	cases := map[string]dbgen.ListActivityCohortsRow{
		"members but no last signup": actCohortRow("2026-03-02", 2, ""),
		"a last signup but nobody":   actCohortRow("2026-03-02", 0, "2026-03-03"),
		"no week start":              {Signups: 0},
	}
	for name, row := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := buildActivityCohorts(c, []dbgen.ListActivityCohortsRow{row})
			assert.Error(t, err)
		})
	}
}

// --- the panel ----------------------------------------------------------------

func TestNewActivityClock_RequiresToday(t *testing.T) {
	_, err := newActivityClock(dbgen.GetActivityClockRow{AsOf: "2026-03-11 10:00"})
	assert.Error(t, err, "a clock without today cannot place a single day")
}

// --- snapshot wiring ----------------------------------------------------------

// actFakeTx is the slice of pgx.Tx the snapshot runner touches.  The embedded
// interface is nil: a call to anything else panics, which would mean the
// runner reached past the reader it handed out.
type actFakeTx struct {
	pgx.Tx
	commits, rollbacks int
	commitErr          error
}

func (f *actFakeTx) Commit(context.Context) error {
	f.commits++
	return f.commitErr
}

func (f *actFakeTx) Rollback(context.Context) error {
	f.rollbacks++
	if f.commits > 0 {
		return pgx.ErrTxClosed // what pgx returns after a commit
	}
	return nil
}

type actFakeBeginner struct {
	opts []pgx.TxOptions
	tx   *actFakeTx
	err  error
}

func (b *actFakeBeginner) BeginTx(_ context.Context, opts pgx.TxOptions) (pgx.Tx, error) {
	b.opts = append(b.opts, opts)
	if b.err != nil {
		return nil, b.err
	}
	return b.tx, nil
}

// TestPgActivitySnapshots_OneReadOnlyRepeatableReadTransaction: every read
// goes through a reader bound to ONE transaction opened REPEATABLE READ READ
// ONLY, and the transaction is committed once the reads succeed.
func TestPgActivitySnapshots_OneReadOnlyRepeatableReadTransaction(t *testing.T) {
	tx := &actFakeTx{}
	beginner := &actFakeBeginner{tx: tx}
	reader := &actFakeReader{}
	var boundTo pgx.Tx
	s := pgActivitySnapshots{db: beginner, newReader: func(tx pgx.Tx) activityReader {
		boundTo = tx
		return reader
	}}

	var got activityReader
	err := s.Read(context.Background(), func(q activityReader) error {
		got = q
		return nil
	})

	require.NoError(t, err)
	assert.Equal(t, []pgx.TxOptions{{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}}, beginner.opts,
		"exactly one transaction, repeatable read and read only")
	assert.Same(t, tx, boundTo, "the reader is built on the transaction, not on the pool")
	assert.Same(t, reader, got, "fn reads through that reader")
	assert.Equal(t, 1, tx.commits)
}

func TestPgActivitySnapshots_AFailedReadRollsBack(t *testing.T) {
	tx := &actFakeTx{}
	s := pgActivitySnapshots{db: &actFakeBeginner{tx: tx}, newReader: func(pgx.Tx) activityReader { return &actFakeReader{} }}
	boom := errors.New("simulated query failure")

	err := s.Read(context.Background(), func(activityReader) error { return boom })

	assert.ErrorIs(t, err, boom)
	assert.Equal(t, 0, tx.commits)
	assert.Equal(t, 1, tx.rollbacks)
}

func TestPgActivitySnapshots_BeginFailureReadsNothing(t *testing.T) {
	refused := errors.New("simulated pool exhaustion")
	s := pgActivitySnapshots{db: &actFakeBeginner{err: refused}, newReader: func(pgx.Tx) activityReader {
		t.Fatal("no reader may be built without a transaction")
		return nil
	}}

	err := s.Read(context.Background(), func(activityReader) error {
		t.Fatal("fn must not run without a transaction")
		return nil
	})
	assert.ErrorIs(t, err, refused)
}

func TestPgActivitySnapshots_CommitFailureIsAnError(t *testing.T) {
	lost := errors.New("simulated connection loss")
	tx := &actFakeTx{commitErr: lost}
	s := pgActivitySnapshots{db: &actFakeBeginner{tx: tx}, newReader: func(pgx.Tx) activityReader { return &actFakeReader{} }}

	err := s.Read(context.Background(), func(activityReader) error { return nil })
	assert.ErrorIs(t, err, lost)
}

// TestNewPgActivitySnapshots_ReadsThroughDbgen: production binds the sqlc
// queries to the transaction it was handed.
func TestNewPgActivitySnapshots_ReadsThroughDbgen(t *testing.T) {
	s := newPgActivitySnapshots(&actFakeBeginner{})
	assert.IsType(t, &dbgen.Queries{}, s.newReader(&actFakeTx{}))
}

// --- the handler, against a fake reader ----------------------------------------

// actFakeReader serves canned rows and records the reads in order.
type actFakeReader struct {
	clock   dbgen.GetActivityClockRow
	today   dbgen.GetActivityTodayActiveRow
	windows map[int32]dbgen.GetActivityWindowRow
	signups dbgen.GetActivitySignupsRow
	daily   []dbgen.ListActivityDailyRow
	depth   []dbgen.ListActivityDepthRow
	cohorts []dbgen.ListActivityCohortsRow
	failOn  string
	calls   []string
}

func (f *actFakeReader) record(call string) error {
	f.calls = append(f.calls, call)
	if f.failOn != "" && f.failOn == call {
		return fmt.Errorf("simulated failure in %s", call)
	}
	return nil
}

func (f *actFakeReader) GetActivityClock(context.Context) (dbgen.GetActivityClockRow, error) {
	return f.clock, f.record("clock")
}

func (f *actFakeReader) GetActivityTodayActive(context.Context) (dbgen.GetActivityTodayActiveRow, error) {
	return f.today, f.record("today")
}

func (f *actFakeReader) GetActivityWindow(_ context.Context, days int32) (dbgen.GetActivityWindowRow, error) {
	return f.windows[days], f.record(fmt.Sprintf("window(%d)", days))
}

func (f *actFakeReader) GetActivitySignups(_ context.Context, days int32) (dbgen.GetActivitySignupsRow, error) {
	return f.signups, f.record(fmt.Sprintf("signups(%d)", days))
}

func (f *actFakeReader) ListActivityDaily(_ context.Context, dayCount int32) ([]dbgen.ListActivityDailyRow, error) {
	return f.daily, f.record(fmt.Sprintf("daily(%d)", dayCount))
}

func (f *actFakeReader) ListActivityDepth(_ context.Context, dayCount int32) ([]dbgen.ListActivityDepthRow, error) {
	return f.depth, f.record(fmt.Sprintf("depth(%d)", dayCount))
}

func (f *actFakeReader) ListActivityCohorts(_ context.Context, weeks int32) ([]dbgen.ListActivityCohortsRow, error) {
	return f.cohorts, f.record(fmt.Sprintf("cohorts(%d)", weeks))
}

// actFakeSnapshots hands every Read the same reader and counts the snapshots.
type actFakeSnapshots struct {
	reader *actFakeReader
	reads  int
}

func (f *actFakeSnapshots) Read(_ context.Context, fn func(activityReader) error) error {
	f.reads++
	return fn(f.reader)
}

// actCannedReader is a small, internally consistent synthetic snapshot whose
// today is far from this machine's clock.
func actCannedReader() *actFakeReader {
	return &actFakeReader{
		clock: dbgen.GetActivityClockRow{
			Today: day("2031-02-12"), AsOf: "2031-02-12 09:41", InstrumentedSince: day("2031-02-01"),
		},
		today: dbgen.GetActivityTodayActiveRow{Active: 3, SameTimeYesterday: 2, SameTimeLastWeek: 1, YesterdayTotal: 4},
		windows: map[int32]dbgen.GetActivityWindowRow{
			7:  {ReturningPeople: 4, SignupOnlyPeople: 1, PrevReturningPeople: 3, PrevSignupOnlyPeople: 2},
			30: {ReturningPeople: 6, SignupOnlyPeople: 2, PrevReturningPeople: 5, PrevSignupOnlyPeople: 1},
		},
		signups: dbgen.GetActivitySignupsRow{Signups: 3, PrevSignups: 2, ReturnedAfter: 1},
		daily: []dbgen.ListActivityDailyRow{
			{ActivityDate: day("2031-02-11"), ReturningPeople: 3, SignupDayPeople: 1, Requests: 30, Logins: 1},
			{ActivityDate: day("2031-02-12"), ReturningPeople: 2, SignupDayPeople: 1, Requests: 12},
		},
		depth: []dbgen.ListActivityDepthRow{{ActiveDays: 1, People: 3, SignupOnly: 2}, {ActiveDays: 4, People: 5}},
		cohorts: []dbgen.ListActivityCohortsRow{
			actCohortRow("2031-02-10", 1, "2031-02-11"),
			actCohortRow("2031-02-03", 0, ""),
		},
	}
}

func actServe(t *testing.T, snaps activitySnapshots, query string) *httptest.ResponseRecorder {
	t.Helper()
	h := &ActivityHandlers{snapshots: snaps}
	rec := httptest.NewRecorder()
	h.GetActivity(rec, httptest.NewRequest(http.MethodGet, "/api/admin/activity"+query, nil))
	return rec
}

// TestGetActivity_ReadsEverythingInOneSnapshot: one Read per request, every
// query inside it, the clock first so the rest of the response is judged
// against it.
func TestGetActivity_ReadsEverythingInOneSnapshot(t *testing.T) {
	reader := actCannedReader()
	snaps := &actFakeSnapshots{reader: reader}

	rec := actServe(t, snaps, "?days=7")

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, 1, snaps.reads, "one transaction per request")
	assert.Equal(t, []string{
		"clock", "today", "window(7)", "window(30)", "signups(30)", "daily(7)", "depth(7)", "cohorts(10)",
	}, reader.calls)

	var envelope struct {
		Data ActivityPanel `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	got := envelope.Data
	assert.Equal(t, 7, got.Days)
	assert.Equal(t, "2031-02-12", got.Today, "today is the database's, not this machine's")
	assert.Equal(t, "2031-02-12 09:41", got.AsOf)
	require.Len(t, got.Daily, 7)
	assert.Equal(t, "2031-02-06", got.Daily[0].Date)
	assert.Equal(t, "2031-02-12", got.Daily[6].Date)
	assert.True(t, got.Daily[6].Partial)
	assert.Equal(t, int64(5), got.Windows.D7.Active)
	assert.Equal(t, int64(8), got.Windows.D30.Active)
	assert.Equal(t, int64(8), got.Depth.Total)
	assert.Len(t, got.Cohorts, 2)
}

// TestGetActivity_ClampsTheWindowItReads: the clamped ?days is what reaches the
// daily and depth queries and what the payload reports.
func TestGetActivity_ClampsTheWindowItReads(t *testing.T) {
	for query, want := range map[string]int{"": 30, "?days=90": 90, "?days=500": 90, "?days=2": 7} {
		reader := actCannedReader()
		reader.daily = nil
		reader.depth = nil
		rec := actServe(t, &actFakeSnapshots{reader: reader}, query)
		require.Equal(t, http.StatusOK, rec.Code, query)
		assert.Contains(t, reader.calls, fmt.Sprintf("daily(%d)", want), query)
		assert.Contains(t, reader.calls, fmt.Sprintf("depth(%d)", want), query)

		var envelope struct {
			Data ActivityPanel `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
		assert.Equal(t, want, envelope.Data.Days, query)
		assert.Len(t, envelope.Data.Daily, want, query)
		assert.Equal(t, activityDepthBuckets(want), envelope.Data.Depth.Buckets, query)
	}
}

// TestGetActivity_AnyFailedReadFailsTheResponse: no block soft-fails to zeroes.
// A zero here is a claim, and a panel built from part of a snapshot would no
// longer be one snapshot.
func TestGetActivity_AnyFailedReadFailsTheResponse(t *testing.T) {
	for _, call := range []string{
		"clock", "today", "window(7)", "window(30)", "signups(30)", "daily(30)", "depth(30)", "cohorts(10)",
	} {
		t.Run(call, func(t *testing.T) {
			reader := actCannedReader()
			reader.failOn = call
			rec := actServe(t, &actFakeSnapshots{reader: reader}, "")

			assert.Equal(t, http.StatusInternalServerError, rec.Code)
			var body map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.NotContains(t, body, "data", "no partial payload")
			assert.Contains(t, body, "error")
		})
	}
}

// TestGetActivity_InconsistentRowsFailTheResponse: the builders' refusals
// reach the client as an error, not as a quietly smaller number.
func TestGetActivity_InconsistentRowsFailTheResponse(t *testing.T) {
	reader := actCannedReader()
	reader.depth = []dbgen.ListActivityDepthRow{{ActiveDays: 31, People: 1}}
	rec := actServe(t, &actFakeSnapshots{reader: reader}, "?days=30")
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

// TestGetActivity_WireShape pins the JSON field names and null encodings to
// next-app/src/app/[lang]/admin/_types/activity.ts.  Every key the TypeScript
// declares is present, and nothing else is.
func TestGetActivity_WireShape(t *testing.T) {
	reader := actCannedReader()
	// Nothing instrumented: the nullable fields come out as null.
	reader.clock.InstrumentedSince = pgtype.Date{}
	rec := actServe(t, &actFakeSnapshots{reader: reader}, "?days=7")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var envelope struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	panel := envelope.Data

	actAssertKeys(t, panel, "days", "timezone", "today", "asOf", "instrumentedSince",
		"todayActive", "windows", "signups30", "daily", "depth", "cohorts")
	assert.JSONEq(t, `null`, string(panel["instrumentedSince"]))
	assert.JSONEq(t, `"Asia/Shanghai (UTC+8)"`, string(panel["timezone"]))

	todayActive := actJSONObject(t, panel["todayActive"])
	actAssertKeys(t, todayActive, "active", "sameTimeYesterday", "sameTimeLastWeek", "yesterdayTotal")
	assert.JSONEq(t, `null`, string(todayActive["sameTimeYesterday"]))
	assert.JSONEq(t, `null`, string(todayActive["sameTimeLastWeek"]))

	windows := actJSONObject(t, panel["windows"])
	actAssertKeys(t, windows, "d7", "d30")
	windowKeys := []string{"days", "active", "returning", "signupOnly", "prevActive", "prevReturning",
		"prevSignupOnly", "reconstructed", "prevReconstructed"}
	actAssertKeys(t, actJSONObject(t, windows["d7"]), windowKeys...)
	actAssertKeys(t, actJSONObject(t, windows["d30"]), windowKeys...)

	actAssertKeys(t, actJSONObject(t, panel["signups30"]), "count", "prevCount", "returnedAfter", "reconstructed")

	daily := actJSONArray(t, panel["daily"])
	require.Len(t, daily, 7)
	actAssertKeys(t, actJSONObject(t, daily[0]), "date", "returning", "signupDay", "requests", "logins", "instrumented", "partial")

	depth := actJSONObject(t, panel["depth"])
	actAssertKeys(t, depth, "days", "total", "signupOnly", "reconstructed", "buckets")
	buckets := actJSONArray(t, depth["buckets"])
	require.NotEmpty(t, buckets)
	actAssertKeys(t, actJSONObject(t, buckets[0]), "min", "max", "count")

	cohorts := actJSONArray(t, panel["cohorts"])
	require.Len(t, cohorts, 2)
	actAssertKeys(t, actJSONObject(t, cohorts[0]), "weekStart", "signups", "lastSignup", "reconstructed", "horizons")
	assert.JSONEq(t, `null`, string(actJSONObject(t, cohorts[1])["lastSignup"]), "an empty week has no last signup")
	horizons := actJSONArray(t, actJSONObject(t, cohorts[0])["horizons"])
	require.Len(t, horizons, 4)
	actAssertKeys(t, actJSONObject(t, horizons[0]), "days", "returned", "eligible")
}

// TestGetActivity_EmptyListsAreArraysNotNull: a fresh deployment's panel is
// all zeroes, and its lists are [] -- null is reserved for "not known".
func TestGetActivity_EmptyListsAreArraysNotNull(t *testing.T) {
	reader := actCannedReader()
	reader.daily, reader.depth, reader.cohorts = nil, nil, nil
	rec := actServe(t, &actFakeSnapshots{reader: reader}, "")
	require.Equal(t, http.StatusOK, rec.Code)

	var envelope struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	assert.JSONEq(t, `[]`, string(envelope.Data["cohorts"]))
	assert.Len(t, actJSONArray(t, envelope.Data["daily"]), defaultActivityDays, "the axis exists with nothing on it")
}

func actJSONObject(t *testing.T, raw json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &m), string(raw))
	return m
}

func actJSONArray(t *testing.T, raw json.RawMessage) []json.RawMessage {
	t.Helper()
	var a []json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &a), string(raw))
	return a
}

func actAssertKeys(t *testing.T, m map[string]json.RawMessage, want ...string) {
	t.Helper()
	got := make([]string, 0, len(m))
	for k := range m {
		got = append(got, k)
	}
	sort.Strings(got)
	sorted := append([]string(nil), want...)
	sort.Strings(sorted)
	assert.Equal(t, sorted, got)
}
