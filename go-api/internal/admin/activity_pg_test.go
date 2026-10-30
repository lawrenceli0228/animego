package admin

// activity_pg_test.go — the activity panel against the real schema, using the
// testcontainers Postgres shared by handlers_test.go's TestMain.
//
// The unit tests in activity_unit_test.go prove the gap filling, the flags and
// the bucketing given rows; only real SQL can prove the rows.  These tests
// seed explicit timestamps and read the panel through the real handler.
//
// THE DATABASE CLOCK IS FROZEN.  Every panel query derives today from now(),
// so a test that seeded "yesterday" from the wall clock could cross midnight
// before the handler ran, and a test of "one minute before 24 hours ago"
// would depend on how fast it ran.  newPanelEnv instead opens the handler's
// pool with a search_path that puts activity_test_clock ahead of pg_catalog,
// where now() returns the instant in the session setting activity_test.now
// (see installPanelFrozenNow).  Nothing else changes: the same views, the same
// statements, the same casts.  The frozen instant is a fixed weekday and time
// of day in the CURRENT week, so every boundary below is exact and every
// seeded date stays well inside the 400-day prune that pg_cron runs against
// the real clock.  Each test still reads its today back from the database.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/activity"
)

// reportingToday is today's reporting day by the wall clock.  Only the tests
// that do not read the panel use it; the panel tests use the frozen clock.
func reportingToday() time.Time { return activity.Day(time.Now()) }

// seedActivity writes one user_activity_daily row `daysAgo` days before the
// current reporting day.  Written as raw SQL rather than through the recorder
// because these tests are about the READS: the recorder has its own tests, and
// routing through it would make the seed depend on flush timing.
func seedActivity(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, daysAgo int, requests int64) {
	t.Helper()
	date := reportingToday().AddDate(0, 0, -daysAgo)
	// Noon local keeps the timestamps unambiguously inside the day whichever
	// side of midnight the test happens to run on.
	at := date.Add(12 * time.Hour)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO user_activity_daily
			(user_id, activity_date, first_seen_at, last_seen_at, request_count)
		VALUES ($1, $2, $3, $3, $4)
		ON CONFLICT (activity_date, user_id) DO UPDATE
		SET request_count = user_activity_daily.request_count + EXCLUDED.request_count`,
		userID, date.Format(dateLayout), at, requests)
	require.NoError(t, err, "seedActivity")
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// --- the frozen clock ---------------------------------------------------------

// panelZone is the reporting zone, +08 with no DST.
var panelZone = time.FixedZone("UTC+8", 8*60*60)

var installPanelFrozenNowOnce sync.Once

// installPanelFrozenNow creates activity_test_clock.now(), once per container.  A
// session only reaches it when its search_path names the schema before
// pg_catalog, which only panelFrozenClockPool's sessions do; every other
// connection keeps the real now().
func installPanelFrozenNow(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var err error
	installPanelFrozenNowOnce.Do(func() {
		_, err = pool.Exec(context.Background(), `
			CREATE SCHEMA IF NOT EXISTS activity_test_clock;
			CREATE OR REPLACE FUNCTION activity_test_clock.now() RETURNS timestamptz
				LANGUAGE sql STABLE
				AS $$ SELECT current_setting('activity_test.now')::timestamptz $$;`)
	})
	require.NoError(t, err, "install the frozen now()")
}

// panelFrozenClockPool opens a pool whose sessions see now() fixed at `at`.
func panelFrozenClockPool(t *testing.T, at time.Time) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(pgURI)
	require.NoError(t, err)
	cfg.MaxConns = 4
	cfg.ConnConfig.RuntimeParams["jit"] = "off" // as db.NewPool sets it for production
	cfg.ConnConfig.RuntimeParams["search_path"] = "activity_test_clock, pg_catalog, public"
	cfg.ConnConfig.RuntimeParams["activity_test.now"] = at.Format(time.RFC3339Nano)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	var got time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT now()`).Scan(&got))
	require.True(t, got.Equal(at), "frozen now() = %s, want %s", got, at)
	return pool
}

// panelFrozenAt is hh:mm in +08 on `weekday` of the current Monday-start week.
func panelFrozenAt(weekday time.Weekday, hh, mm int) time.Time {
	today := activity.Day(time.Now())
	monday := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
	offset := (int(weekday) + 6) % 7 // Monday 0 … Sunday 6
	return time.Date(monday.Year(), monday.Month(), monday.Day()+offset, hh, mm, 0, 0, panelZone)
}

// panelFrozenNow is the default instant: Wednesday 10:00 +08.  The current week's
// Monday is then today-2 and its Tuesday today-1, which puts both sides of
// the one-day eligibility boundary in the same week.
func panelFrozenNow() time.Time { return panelFrozenAt(time.Wednesday, 10, 0) }

// --- seeding ------------------------------------------------------------------

// panelEnv is one test's database: a truncated schema, a pool to seed with,
// and the handler's pool, whose now() is frozen.
type panelEnv struct {
	pool   *pgxpool.Pool
	frozen *pgxpool.Pool
	now    time.Time
	today  time.Time // 00:00 +08 of the frozen clock's reporting day
}

func newPanelEnv(t *testing.T, now time.Time) panelEnv {
	t.Helper()
	_, pool := makeHandlers(t)
	installPanelFrozenNow(t, pool)
	frozen := panelFrozenClockPool(t, now)

	// Today as the DATABASE computes it, the way the panel's queries do.
	var d time.Time
	require.NoError(t, frozen.QueryRow(context.Background(),
		`SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date`).Scan(&d))
	today := time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, panelZone)
	require.True(t, today.Equal(activity.Day(now)), "SQL and internal/activity must agree on the day")
	return panelEnv{pool: pool, frozen: frozen, now: now, today: today}
}

// at is hh:mm +08 on today+offset.
func (e panelEnv) at(offset, hh, mm int) time.Time {
	return time.Date(e.today.Year(), e.today.Month(), e.today.Day()+offset, hh, mm, 0, 0, panelZone)
}

// date is today+offset as a wire date.
func (e panelEnv) date(offset int) string { return e.at(offset, 0, 0).Format(dateLayout) }

// panelPerson is somebody in activity_people: a live account, or a deleted
// one that exists only in the archive.
type panelPerson struct {
	id       uuid.UUID
	archived bool
}

var panelNames struct {
	sync.Mutex
	n int
}

// person adds somebody who signed up at `signup`.
func (e panelEnv) person(t *testing.T, signup time.Time, archived bool) panelPerson {
	t.Helper()
	if archived {
		var id uuid.UUID
		require.NoError(t, e.pool.QueryRow(context.Background(),
			`INSERT INTO archived_users (created_at) VALUES ($1) RETURNING archive_id`, signup).Scan(&id))
		return panelPerson{id: id, archived: true}
	}
	panelNames.Lock()
	panelNames.n++
	name := fmt.Sprintf("panel_%d", panelNames.n)
	panelNames.Unlock()
	return panelPerson{id: seedUserAt(t, e.pool, name, name+"@example.com", signup)}
}

// visit records p active on today+offset, first seen at 09:00 +08 (before the
// frozen 10:00), with one request.
func (e panelEnv) visit(t *testing.T, p panelPerson, offset int) {
	t.Helper()
	e.visitAt(t, p, offset, e.at(offset, 9, 0), 1, 0)
}

// visitAt records p active on the reporting day today+offset, first seen at
// firstSeen.  requests = 0 marks the row reconstructed, exactly as migration
// 0026 writes it.
func (e panelEnv) visitAt(t *testing.T, p panelPerson, offset int, firstSeen time.Time, requests, logins int64) {
	t.Helper()
	table, column := "user_activity_daily", "user_id"
	if p.archived {
		table, column = "archived_user_activity_daily", "archive_id"
	}
	_, err := e.pool.Exec(context.Background(), fmt.Sprintf(`
		INSERT INTO %s (%s, activity_date, first_seen_at, last_seen_at, request_count, login_count)
		VALUES ($1, $2::date, $3, $3, $4, $5)`, table, column),
		p.id, e.date(offset), firstSeen, requests, logins)
	require.NoError(t, err, "visitAt")
}

// panel reads GET /api/admin/activity through the frozen clock.
func (e panelEnv) panel(t *testing.T, query string) ActivityPanel {
	t.Helper()
	h := NewActivityHandlers(e.frozen)
	rec := httptest.NewRecorder()
	h.GetActivity(rec, httptest.NewRequest(http.MethodGet, "/api/admin/activity"+query, nil))
	require.Equal(t, http.StatusOK, rec.Code, "body: %s", rec.Body.String())

	var envelope struct {
		Data ActivityPanel `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	require.Equal(t, e.date(0), envelope.Data.Today, "the panel's today is the database's")
	return envelope.Data
}

func panelDailyOn(p ActivityPanel, date string) (ActivityDay, bool) {
	for _, d := range p.Daily {
		if d.Date == date {
			return d, true
		}
	}
	return ActivityDay{}, false
}

func panelBucketCounts(d ActivityDepth) map[int]int64 {
	out := map[int]int64{}
	for _, b := range d.Buckets {
		out[b.Min] = b.Count
	}
	return out
}

func panelCohortWeek(t *testing.T, p ActivityPanel, weekStart string) ActivityCohortWeek {
	t.Helper()
	for _, w := range p.Cohorts {
		if w.WeekStart == weekStart {
			return w
		}
	}
	t.Fatalf("week %s is not in the cohort table", weekStart)
	return ActivityCohortWeek{}
}

func panelHorizonOf(t *testing.T, w ActivityCohortWeek, days int) ActivityCohortHorizon {
	t.Helper()
	for _, h := range w.Horizons {
		if h.Days == days {
			return h
		}
	}
	t.Fatalf("week %s has no %d-day horizon", w.WeekStart, days)
	return ActivityCohortHorizon{}
}

// --- deleted people ------------------------------------------------------------

// seedMixedHistory is a small history touching every block of the panel:
// a person who signed up ten days ago and came back three times (one of them
// yesterday before the frozen time of day, one of them today), and a person
// who signed up yesterday after that time and was only here then.
func seedMixedHistory(t *testing.T, e panelEnv, archivedA, archivedB bool) {
	t.Helper()
	a := e.person(t, e.at(-10, 8, 30), archivedA)
	e.visitAt(t, a, -10, e.at(-10, 8, 30), 4, 1)
	e.visitAt(t, a, -3, e.at(-3, 21, 0), 2, 0)
	e.visitAt(t, a, -1, e.at(-1, 9, 15), 3, 0)
	e.visitAt(t, a, 0, e.at(0, 7, 45), 5, 0)

	b := e.person(t, e.at(-1, 11, 0), archivedB)
	e.visitAt(t, b, -1, e.at(-1, 11, 0), 6, 1)
}

// TestActivityPanel_ArchivedPersonCountsLikeALiveOne: the same history read as
// two live accounts, as two archived people and as one of each produces the
// same panel, block for block.  A person kept only in the archive (migration
// 0054) is counted in todayActive, the windows, the signups, the daily bars,
// depth and the cohorts exactly like an account.
func TestActivityPanel_ArchivedPersonCountsLikeALiveOne(t *testing.T) {
	now := panelFrozenNow()
	read := func(archivedA, archivedB bool) (ActivityPanel, panelEnv) {
		e := newPanelEnv(t, now)
		seedMixedHistory(t, e, archivedA, archivedB)
		return e.panel(t, "?days=30"), e
	}

	live, _ := read(false, false)
	mixed, _ := read(false, true)
	archived, e := read(true, true)

	assert.Equal(t, live, archived, "archive-only history must read exactly like live accounts")
	assert.Equal(t, live, mixed)

	// And the history is really in there.
	assert.Equal(t, int64(1), archived.TodayActive.Active)
	require.NotNil(t, archived.TodayActive.SameTimeYesterday)
	assert.Equal(t, int64(1), *archived.TodayActive.SameTimeYesterday, "a's 09:15 counts, b's 11:00 does not")
	assert.Equal(t, int64(2), archived.TodayActive.YesterdayTotal)
	assert.Equal(t, ActivityWindow{Days: 7, Active: 2, Returning: 1, SignupOnly: 1, PrevActive: 1, PrevSignupOnly: 1,
		PrevReconstructed: true}, archived.Windows.D7)
	assert.Equal(t, int64(2), archived.Signups30.Count)
	assert.Equal(t, int64(1), archived.Signups30.ReturnedAfter)
	yesterday, _ := panelDailyOn(archived, e.date(-1))
	assert.Equal(t, ActivityDay{Date: e.date(-1), Returning: 1, SignupDay: 1, Requests: 9, Logins: 1, Instrumented: true}, yesterday)
	assert.Equal(t, map[int]int64{1: 1, 2: 0, 3: 1, 7: 0, 14: 0}, panelBucketCounts(archived.Depth))
	assert.Equal(t, int64(2), archived.Depth.Total)
	week := panelCohortWeek(t, archived, e.date(-2)) // b signed up on the Tuesday
	assert.Equal(t, int64(1), week.Signups)
	older := panelCohortWeek(t, archived, e.date(-16)) // a signed up on the Sunday of week 2
	assert.Equal(t, int64(1), older.Signups)
	assert.Equal(t, int64(1), panelHorizonOf(t, older, 7).Returned, "a came back on day 7")
}

// TestActivityPanel_DeletingAnAccountChangesNoNumber runs the real delete path
// (UserStore.ArchiveAndDeleteUser) between two reads of the same snapshot
// clock: every number about the past is unchanged.
func TestActivityPanel_DeletingAnAccountChangesNoNumber(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())
	seedMixedHistory(t, e, false, false)
	var victim uuid.UUID
	require.NoError(t, e.pool.QueryRow(context.Background(),
		`SELECT id FROM users ORDER BY created_at LIMIT 1`).Scan(&victim))

	before := e.panel(t, "?days=90")
	deleted, err := NewUserStore(e.pool).ArchiveAndDeleteUser(context.Background(), victim)
	require.NoError(t, err)
	require.True(t, deleted)
	after := e.panel(t, "?days=90")

	assert.Equal(t, before, after)
}

// --- returning vs signup-only ---------------------------------------------------

// TestActivityPanel_ReturningVersusSignupOnly: returning means active on a day
// that is not the signup day; signup-only means active in the window but only
// on the signup day.
func TestActivityPanel_ReturningVersusSignupOnly(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())

	// a: signup day and again later in the same 7-day window -> returning.
	a := e.person(t, e.at(-3, 9, 0), false)
	e.visit(t, a, -3)
	e.visit(t, a, -1)
	// b: only on the signup day -> signup-only.
	b := e.person(t, e.at(-2, 9, 0), false)
	e.visit(t, b, -2)
	// c: only on the signup day, outside the 7-day window.
	c := e.person(t, e.at(-20, 9, 0), true)
	e.visit(t, c, -20)
	// d: signup day and later, both outside the 7-day window.
	d := e.person(t, e.at(-20, 9, 30), false)
	e.visit(t, d, -20)
	e.visit(t, d, -15)
	// f: signed up before the 30-day window, one visit inside it.  One active
	// day, and still returning: it is not their signup day.
	f := e.person(t, e.at(-40, 9, 0), false)
	e.visit(t, f, -5)
	// g: signed up an hour ago.
	g := e.person(t, e.at(0, 9, 0), true)
	e.visit(t, g, 0)

	p := e.panel(t, "?days=30")

	w7, w30 := p.Windows.D7, p.Windows.D30
	assert.Equal(t, [3]int64{4, 2, 2}, [3]int64{w7.Active, w7.Returning, w7.SignupOnly}, "d7: a,f returning; b,g signup-only")
	assert.Equal(t, [3]int64{6, 3, 3}, [3]int64{w30.Active, w30.Returning, w30.SignupOnly}, "d30: a,d,f returning; b,c,g signup-only")

	want := map[string][2]int64{ // date -> {returning, signupDay}
		e.date(-20): {0, 2}, e.date(-15): {1, 0}, e.date(-5): {1, 0},
		e.date(-3): {0, 1}, e.date(-2): {0, 1}, e.date(-1): {1, 0}, e.date(0): {0, 1},
	}
	for _, day := range p.Daily {
		got := [2]int64{day.Returning, day.SignupDay}
		assert.Equal(t, want[day.Date], got, day.Date)
	}

	// Depth over 30 days: a and d came on two days, everyone else on one.  f's
	// single day is not a signup day, so the one-day bucket (4) is larger than
	// signupOnly (3) -- exactly the distinction the card's footer draws.
	assert.Equal(t, map[int]int64{1: 4, 2: 2, 3: 0, 7: 0, 14: 0}, panelBucketCounts(p.Depth))
	assert.Equal(t, int64(6), p.Depth.Total)
	assert.Equal(t, int64(3), p.Depth.SignupOnly)

	p7 := e.panel(t, "?days=7")
	assert.Equal(t, map[int]int64{1: 3, 2: 1, 3: 0, 7: 0}, panelBucketCounts(p7.Depth))
	assert.Equal(t, p7.Windows.D7.Active, p7.Depth.Total)
	assert.Equal(t, p7.Windows.D7.SignupOnly, p7.Depth.SignupOnly)
}

// --- same time yesterday / last week --------------------------------------------

// TestActivityPanel_SameTimeComparisons: "by this time yesterday" is a first
// visit no later than exactly 24 hours before now().  The frozen clock makes
// the minute either side exact.
func TestActivityPanel_SameTimeComparisons(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow()) // 10:00
	visitor := func(offset, hh, mm int) {
		p := e.person(t, e.at(-30, 9, 0), false)
		e.visitAt(t, p, offset, e.at(offset, hh, mm), 1, 0)
	}
	// Recording began on day -8, so -7 and -1 are measured whole.
	visitor(-8, 12, 0)
	visitor(-1, 9, 59)  // a minute before: counted
	visitor(-1, 10, 0)  // exactly 24 hours before: counted
	visitor(-1, 10, 1)  // a minute after: not yet, by this time of day
	visitor(-1, 23, 50) // late evening
	visitor(-7, 9, 59)
	visitor(-7, 10, 1)
	visitor(0, 9, 30)

	got := e.panel(t, "").TodayActive

	assert.Equal(t, int64(1), got.Active)
	assert.Equal(t, int64(4), got.YesterdayTotal, "yesterday's whole day")
	require.NotNil(t, got.SameTimeYesterday)
	assert.Equal(t, int64(2), *got.SameTimeYesterday, "09:59 and 10:00, not 10:01 or 23:50")
	require.NotNil(t, got.SameTimeLastWeek)
	assert.Equal(t, int64(1), *got.SameTimeLastWeek, "09:59 seven days ago, not 10:01")
}

// TestActivityPanel_SameTimeIsNullBeforeInstrumentation: a reconstructed day's
// first_seen_at is the time of an interaction, not of a visit, so the
// comparison is withheld rather than guessed.  The seam day counts as
// reconstructed: recording began during it, so its morning is interactions.
func TestActivityPanel_SameTimeIsNullBeforeInstrumentation(t *testing.T) {
	cases := []struct {
		name          string
		seam          int // the earliest day with request_count > 0
		wantYesterday bool
		wantLastWeek  bool
	}{
		{"recording began today", 0, false, false},
		{"yesterday is the seam day", -1, false, false},
		{"yesterday is the first day measured whole", -2, true, false},
		{"seven days ago is the seam day", -7, true, false},
		{"seven days ago is the first day measured whole", -8, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newPanelEnv(t, panelFrozenNow())
			p := e.person(t, e.at(-30, 9, 0), false)
			for _, offset := range []int{-8, -7, -2, -1, 0} {
				requests := int64(0)
				if offset >= tc.seam {
					requests = 3
				}
				e.visitAt(t, p, offset, e.at(offset, 8, 0), requests, 0)
			}

			got := e.panel(t, "")
			require.NotNil(t, got.InstrumentedSince)
			assert.Equal(t, e.date(tc.seam), *got.InstrumentedSince)
			assert.Equal(t, tc.wantYesterday, got.TodayActive.SameTimeYesterday != nil, "sameTimeYesterday present")
			assert.Equal(t, tc.wantLastWeek, got.TodayActive.SameTimeLastWeek != nil, "sameTimeLastWeek present")
			assert.Equal(t, int64(1), got.TodayActive.YesterdayTotal, "the whole-day count is never withheld")
		})
	}
}

// --- flags ----------------------------------------------------------------------

// TestActivityPanel_FlagsFollowTheSeam: per-day instrumented flips the day
// after instrumentedSince (the seam day is part reconstructed), only today is
// partial, and each range is reconstructed exactly when the first day it
// depends on is not measured whole.
func TestActivityPanel_FlagsFollowTheSeam(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())
	p := e.person(t, e.at(-60, 9, 0), false)
	for _, offset := range []int{-40, -20, -11} {
		e.visitAt(t, p, offset, e.at(offset, 20, 0), 0, 0) // reconstructed by 0026
	}
	for _, offset := range []int{-10, -5, 0} {
		e.visit(t, p, offset)
	}

	got := e.panel(t, "?days=30")
	require.NotNil(t, got.InstrumentedSince)
	require.Equal(t, e.date(-10), *got.InstrumentedSince)

	for i, day := range got.Daily {
		offset := i - 29
		assert.Equal(t, offset > -10, day.Instrumented, "%s instrumented", day.Date)
		assert.Equal(t, offset == 0, day.Partial, "%s partial", day.Date)
	}

	assert.False(t, got.Windows.D7.Reconstructed, "d7 starts on today-6, after the seam")
	assert.True(t, got.Windows.D7.PrevReconstructed, "its previous window starts on today-13")
	assert.True(t, got.Windows.D30.Reconstructed)
	assert.True(t, got.Windows.D30.PrevReconstructed)
	assert.True(t, got.Signups30.Reconstructed)
	assert.True(t, got.Depth.Reconstructed, "a 30-day depth starts before the seam")
	assert.False(t, e.panel(t, "?days=7").Depth.Reconstructed, "a 7-day depth does not")
}

// TestActivityPanel_CohortReconstructedBoundary: a week is reconstructed when
// its Tuesday -- the earliest day a Monday signup can come back -- is not
// measured whole: when it is the seam day or before it.
func TestActivityPanel_CohortReconstructedBoundary(t *testing.T) {
	// Wednesday: week 1 starts on today-9, so its Tuesday is today-8.
	for _, tc := range []struct {
		seam            int
		wantWeek1Recons bool
	}{
		{-9, false}, // the seam is the day before the Tuesday
		{-8, true},  // the seam is the Tuesday itself
		{-7, true},  // the seam is the day after it
	} {
		t.Run(fmt.Sprintf("seam today%d", tc.seam), func(t *testing.T) {
			e := newPanelEnv(t, panelFrozenNow())
			p := e.person(t, e.at(-60, 9, 0), false)
			e.visit(t, p, tc.seam)

			got := e.panel(t, "")
			assert.False(t, panelCohortWeek(t, got, e.date(-2)).Reconstructed, "week 0")
			assert.Equal(t, tc.wantWeek1Recons, panelCohortWeek(t, got, e.date(-9)).Reconstructed, "week 1")
			assert.True(t, panelCohortWeek(t, got, e.date(-16)).Reconstructed, "week 2")
		})
	}
}

// TestActivityPanel_NothingInstrumentedYet: no row with a request count is a
// real state (migrations applied, nothing served yet).  It reads as null and
// as "reconstructed" everywhere, never as a date or a measurement.
func TestActivityPanel_NothingInstrumentedYet(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())
	p := e.person(t, e.at(-3, 9, 0), false)
	e.visitAt(t, p, -3, e.at(-3, 9, 0), 0, 0)
	e.visitAt(t, p, -1, e.at(-1, 9, 0), 0, 0)

	got := e.panel(t, "")
	assert.Nil(t, got.InstrumentedSince)
	assert.Nil(t, got.TodayActive.SameTimeYesterday)
	assert.Nil(t, got.TodayActive.SameTimeLastWeek)
	assert.Equal(t, int64(1), got.TodayActive.YesterdayTotal)
	for _, day := range got.Daily {
		assert.False(t, day.Instrumented, day.Date)
	}
	assert.True(t, got.Windows.D7.Reconstructed)
	assert.True(t, got.Depth.Reconstructed)
	for _, w := range got.Cohorts {
		assert.True(t, w.Reconstructed, w.WeekStart)
	}
	assert.Equal(t, int64(1), got.Windows.D7.Returning, "reconstructed rows still count, as a floor")
}

// --- cohorts --------------------------------------------------------------------

// TestActivityPanel_CohortEligibilityBoundary: a week is eligible for horizon
// h once its members are final (its Sunday, weekStart + 6, is a whole day in
// the past) and lastSignup + h <= today - 1.  With today a Wednesday, the
// current week's Monday is today-2 and its Tuesday today-1; the previous
// week runs from today-9 to its Sunday, today-3.
func TestActivityPanel_CohortEligibilityBoundary(t *testing.T) {
	cases := []struct {
		name      string
		signups   []int // signup days, as offsets from today
		weekStart int
		horizon   int
		eligible  bool
	}{
		{"the current week is not eligible although its Monday's day 1 is over", []int{-2}, -2, 1, false},
		{"last signup on the previous Sunday (today-3) is eligible for 1 day", []int{-9, -3}, -9, 1, true},
		{"last signup today-8 is eligible for 7 days", []int{-9, -8}, -9, 7, true},
		{"last signup today-7 is not", []int{-9, -7}, -9, 7, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newPanelEnv(t, panelFrozenNow())
			for _, s := range tc.signups {
				e.person(t, e.at(s, 12, 0), false)
			}
			week := panelCohortWeek(t, e.panel(t, ""), e.date(tc.weekStart))
			require.NotNil(t, week.LastSignup)
			assert.Equal(t, e.date(tc.signups[len(tc.signups)-1]), *week.LastSignup)
			assert.Equal(t, int64(len(tc.signups)), week.Signups)
			assert.Equal(t, tc.eligible, panelHorizonOf(t, week, tc.horizon).Eligible)
		})
	}
}

// TestActivityPanel_CohortReturnedCountsDayHNotHPlusOne: "back within h days"
// includes a first return on day h exactly and excludes one on day h+1.  A
// visit on the signup day itself is not a return.
func TestActivityPanel_CohortReturnedCountsDayHNotHPlusOne(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())
	const signup = -44 // the Monday of week 6
	for _, back := range []int{1, 2, 7, 8, 14, 15, 30, 31, 0} {
		p := e.person(t, e.at(signup, 9, 0), back%2 == 0)
		e.visit(t, p, signup)
		if back > 0 {
			e.visit(t, p, signup+back)
		}
	}

	week := panelCohortWeek(t, e.panel(t, ""), e.date(signup))
	assert.Equal(t, int64(9), week.Signups)
	got := map[int]int64{}
	for _, h := range week.Horizons {
		got[h.Days] = h.Returned
		assert.True(t, h.Eligible, "%d days: the week is old enough for every horizon", h.Days)
	}
	assert.Equal(t, map[int]int64{1: 1, 7: 3, 14: 5, 30: 7}, got)
}

// TestActivityPanel_CohortWeeksAreMondayStart: ten weeks, newest first, each
// starting on a Monday, whatever day today is -- and a signup on Sunday 23:59
// +08 belongs to the week before the one a signup at Monday 00:00 starts.
func TestActivityPanel_CohortWeeksAreMondayStart(t *testing.T) {
	for _, now := range []time.Time{
		panelFrozenAt(time.Monday, 0, 30),
		panelFrozenAt(time.Sunday, 23, 30),
		panelFrozenAt(time.Thursday, 15, 0),
	} {
		t.Run(now.Weekday().String(), func(t *testing.T) {
			e := newPanelEnv(t, now)
			got := e.panel(t, "")
			require.Len(t, got.Cohorts, activityCohortWeeks)

			// A calendar day, so read it in the reporting zone, the same zone
			// e.today is midnight in.
			first, err := time.ParseInLocation(dateLayout, got.Cohorts[0].WeekStart, panelZone)
			require.NoError(t, err)
			assert.Equal(t, time.Monday, first.Weekday())
			assert.False(t, first.After(e.today), "the current week starts no later than today")
			assert.True(t, first.AddDate(0, 0, 7).After(e.today), "and contains it")
			for i, w := range got.Cohorts {
				assert.Equal(t, first.AddDate(0, 0, -7*i).Format(dateLayout), w.WeekStart, "week %d", i)
			}
		})
	}

	e := newPanelEnv(t, panelFrozenNow())
	monday := e.at(-2, 0, 0)
	e.person(t, monday.Add(-time.Minute), false) // Sunday 23:59
	e.person(t, monday, false)                   // Monday 00:00
	got := e.panel(t, "")
	assert.Equal(t, int64(1), panelCohortWeek(t, got, e.date(-2)).Signups)
	assert.Equal(t, int64(1), panelCohortWeek(t, got, e.date(-9)).Signups)
}

// --- ranges ---------------------------------------------------------------------

// TestActivityPanel_RangeBoundaries pins every window's ends: d7 is
// [today-6, today] and its previous window [today-13, today-7]; d30 is
// [today-29, today] and [today-59, today-30]; the chart covers exactly
// `days` days.
func TestActivityPanel_RangeBoundaries(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())
	activeOn := func(offset int) {
		p := e.person(t, e.at(-120, 9, 0), false)
		e.visit(t, p, offset)
	}
	for _, offset := range []int{-6, -7, -13, -14, -29, -30, -59, -60, -89, -90} {
		activeOn(offset)
	}

	got := e.panel(t, "?days=90")
	assert.Equal(t, [2]int64{1, 2}, [2]int64{got.Windows.D7.Active, got.Windows.D7.PrevActive},
		"today-6 in d7; today-7 and today-13 in its previous window")
	assert.Equal(t, [2]int64{5, 2}, [2]int64{got.Windows.D30.Active, got.Windows.D30.PrevActive},
		"today-6..-29 in d30; today-30 and today-59 in its previous window, today-60 in neither")

	require.Len(t, got.Daily, 90)
	assert.Equal(t, e.date(-89), got.Daily[0].Date)
	_, has90 := panelDailyOn(got, e.date(-90))
	assert.False(t, has90)
	first, _ := panelDailyOn(got, e.date(-89))
	assert.Equal(t, int64(1), first.Returning, "today-89 is the first bar of a 90-day chart")
	assert.Equal(t, int64(9), got.Depth.Total, "everyone but today-90")

	p30 := e.panel(t, "?days=30")
	require.Len(t, p30.Daily, 30)
	assert.Equal(t, e.date(-29), p30.Daily[0].Date)
	assert.Equal(t, int64(5), p30.Depth.Total)
}

// TestActivityPanel_SignupBoundaries: signups30 is [today-29, today], its
// previous window [today-59, today-30]; returnedAfter needs a day strictly
// after the signup day.
func TestActivityPanel_SignupBoundaries(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())
	for _, offset := range []int{-60, -59, -30} {
		e.person(t, e.at(offset, 12, 0), false)
	}
	edge := e.person(t, e.at(-29, 0, 0), true) // the first minute of the window
	e.visit(t, edge, -29)
	e.visit(t, edge, -28)
	stayer := e.person(t, e.at(-10, 9, 0), false)
	e.visit(t, stayer, -10) // only the signup day
	e.person(t, e.at(0, 9, 59), false)

	got := e.panel(t, "").Signups30
	assert.Equal(t, int64(3), got.Count, "today-29 00:00, today-10, today")
	assert.Equal(t, int64(2), got.PrevCount, "today-59 and today-30; today-60 is in neither")
	assert.Equal(t, int64(1), got.ReturnedAfter, "only the person seen the day after signing up")
}

// TestActivityPanel_IgnoresRowsDatedAfterToday: a row can be dated after the
// snapshot's today (a flush committing just after midnight, a clock a second
// ahead).  Every block stops at today, together.
func TestActivityPanel_IgnoresRowsDatedAfterToday(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())
	p := e.person(t, e.at(-2, 9, 0), false)
	e.visit(t, p, -2)
	e.visitAt(t, p, 1, e.at(1, 0, 0), 1, 0) // tomorrow

	got := e.panel(t, "?days=7")
	assert.Equal(t, int64(0), got.TodayActive.Active)
	assert.Equal(t, int64(1), got.Windows.D7.Active)
	assert.Equal(t, int64(1), got.Windows.D7.SignupOnly, "tomorrow's return has not happened yet")
	assert.Equal(t, int64(0), got.Signups30.ReturnedAfter)
	assert.Equal(t, map[int]int64{1: 1, 2: 0, 3: 0, 7: 0}, panelBucketCounts(got.Depth))
	assert.Equal(t, int64(0), panelHorizonOf(t, panelCohortWeek(t, got, e.date(-2)), 7).Returned)
	assert.Equal(t, e.date(0), got.Daily[len(got.Daily)-1].Date)
}

// --- +08 ------------------------------------------------------------------------

// TestActivityPanel_PlusEightDayBoundary: 23:30 UTC is 07:30 the next day in
// +08, and that is the day a signup lands on.  Bucketed in UTC, the person
// below would sign up the day before their first visit and that visit would
// read as a return.
func TestActivityPanel_PlusEightDayBoundary(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())
	y, m, d := e.at(-2, 0, 0).Date()
	signup := time.Date(y, m, d, 23, 30, 0, 0, time.UTC) // today-1 07:30 +08
	require.Equal(t, e.date(-1), signup.In(panelZone).Format(dateLayout))

	p := e.person(t, signup, false)
	e.visitAt(t, p, -1, signup, 2, 1)
	// 16:00 UTC is midnight +08: the last second before it is still today-1.
	e.person(t, time.Date(y, m, d+1, 15, 59, 59, 0, time.UTC), false)
	e.person(t, time.Date(y, m, d+1, 16, 0, 0, 0, time.UTC), false)

	got := e.panel(t, "?days=7")
	yesterday, _ := panelDailyOn(got, e.date(-1))
	assert.Equal(t, int64(1), yesterday.SignupDay, "the visit is on the +08 signup day")
	assert.Equal(t, int64(0), yesterday.Returning)
	assert.Equal(t, int64(1), got.Windows.D7.SignupOnly)
	week := panelCohortWeek(t, got, e.date(-2))
	assert.Equal(t, int64(3), week.Signups)
	require.NotNil(t, week.LastSignup)
	assert.Equal(t, e.date(0), *week.LastSignup, "16:00 UTC is today in +08")
}

// --- an independent model -------------------------------------------------------

// modelPerson is one synthetic person for TestActivityPanel_MatchesAModel, in
// offsets from today.
type modelPerson struct {
	signup int
	// signupAt is the +08 clock time of the signup, in minutes.  Spread over
	// the whole day so a third of the signups fall on the previous UTC day.
	signupAt int
	archived bool
	days     map[int]modelVisit
}

type modelVisit struct {
	hour     int
	requests int64
	logins   int64
}

// TestActivityPanel_MatchesAModel seeds a deterministic pseudo-random history
// -- live and archived people, a reconstructed stretch, visits before and
// after the frozen time of day -- and checks every block of the panel against
// a direct computation of the definitions in activity.ts.  It is also where
// the cross-block guarantees are asserted: depth.total equals the window's
// active count, and the daily bars sum to the rows seeded.
func TestActivityPanel_MatchesAModel(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())
	rng := rand.New(rand.NewSource(7))
	const seam = -40 // rows before it are reconstructed (request_count 0)

	people := make([]modelPerson, 0, 40)
	for i := 0; i < 40; i++ {
		mp := modelPerson{signup: -rng.Intn(80), archived: i%3 == 0, days: map[int]modelVisit{}}
		mp.signupAt = rng.Intn(24 * 60)
		if mp.signup == 0 {
			mp.signupAt = rng.Intn(10 * 60) // today's signups are before the frozen 10:00
		}
		visits := rng.Intn(12)
		if rng.Intn(4) > 0 {
			visits++ // most people are seen on their signup day
			mp.days[mp.signup] = modelVisit{hour: 9}
		}
		// No more distinct days than [signup, today] holds.
		visits = min(visits, -mp.signup+1)
		for len(mp.days) < visits {
			offset := mp.signup + rng.Intn(-mp.signup+1)
			mp.days[offset] = modelVisit{hour: 8 + rng.Intn(4)} // 08:xx .. 11:xx
		}
		for offset, v := range mp.days {
			if offset == 0 {
				v.hour = 9 // today's visits have happened by the frozen 10:00
			}
			if offset >= seam {
				v.requests = int64(1 + rng.Intn(30))
				v.logins = int64(rng.Intn(2))
			}
			mp.days[offset] = v
		}
		people = append(people, mp)
	}
	for _, mp := range people {
		p := e.person(t, e.at(mp.signup, mp.signupAt/60, mp.signupAt%60), mp.archived)
		for offset, v := range mp.days {
			e.visitAt(t, p, offset, e.at(offset, v.hour, 30), v.requests, v.logins)
		}
	}

	for _, days := range []int{7, 30, 90} {
		t.Run(fmt.Sprintf("days=%d", days), func(t *testing.T) {
			got := e.panel(t, fmt.Sprintf("?days=%d", days))
			want := modelPanel(e, people, days)

			assert.Equal(t, want.InstrumentedSince, got.InstrumentedSince)
			assert.Equal(t, want.TodayActive, got.TodayActive)
			assert.Equal(t, want.Windows, got.Windows)
			assert.Equal(t, want.Signups30, got.Signups30)
			assert.Equal(t, want.Daily, got.Daily)
			assert.Equal(t, want.Depth, got.Depth)
			assert.Equal(t, want.Cohorts, got.Cohorts)

			// The guarantees the UI relies on, stated directly.
			switch days {
			case 7:
				assert.Equal(t, got.Windows.D7.Active, got.Depth.Total)
				assert.Equal(t, got.Windows.D7.SignupOnly, got.Depth.SignupOnly)
			case 30:
				assert.Equal(t, got.Windows.D30.Active, got.Depth.Total)
				assert.Equal(t, got.Windows.D30.SignupOnly, got.Depth.SignupOnly)
			}
			var bars, requests, seeded, seededRequests int64
			for _, d := range got.Daily {
				bars += d.Returning + d.SignupDay
				requests += d.Requests
			}
			for _, mp := range people {
				for offset, v := range mp.days {
					if offset > -days {
						seeded++
						seededRequests += v.requests
					}
				}
			}
			assert.Equal(t, seeded, bars, "every seeded row in the window is one person on one bar")
			assert.Equal(t, seededRequests, requests)
			last := got.Daily[len(got.Daily)-1]
			assert.Equal(t, got.TodayActive.Active, last.Returning+last.SignupDay)
			prev := got.Daily[len(got.Daily)-2]
			assert.Equal(t, got.TodayActive.YesterdayTotal, prev.Returning+prev.SignupDay)
		})
	}
}

// modelPanel computes the panel from the definitions, independently of the
// SQL: a person is active in a range if they have a day in it, returning if
// one of those days is not their signup day, and so on.
func modelPanel(e panelEnv, people []modelPerson, days int) ActivityPanel {
	since, hasSince := 1, false
	for _, mp := range people {
		for offset, v := range mp.days {
			if v.requests > 0 && (!hasSince || offset < since) {
				since, hasSince = offset, true
			}
		}
	}
	// The seam day itself is part reconstructed; the day after it is the
	// first one measured whole (activityClock.instrumented).
	instrumented := func(offset int) bool { return hasSince && offset > since }
	var out ActivityPanel
	if hasSince {
		s := e.date(since)
		out.InstrumentedSince = &s
	}

	var yesterdaySame, lastWeekSame int64
	for _, mp := range people {
		if _, ok := mp.days[0]; ok {
			out.TodayActive.Active++
		}
		if v, ok := mp.days[-1]; ok {
			out.TodayActive.YesterdayTotal++
			if v.hour < 10 { // first seen hh:30, so before 10:00 means hh <= 9
				yesterdaySame++
			}
		}
		if v, ok := mp.days[-7]; ok && v.hour < 10 {
			lastWeekSame++
		}
	}
	if instrumented(-1) {
		out.TodayActive.SameTimeYesterday = &yesterdaySame
	}
	if instrumented(-7) {
		out.TodayActive.SameTimeLastWeek = &lastWeekSame
	}

	split := func(lo, hi int) (returning, signupOnly int64) {
		for _, mp := range people {
			in, back := false, false
			for offset := range mp.days {
				if offset >= lo && offset <= hi {
					in = true
					back = back || offset != mp.signup
				}
			}
			switch {
			case back:
				returning++
			case in:
				signupOnly++
			}
		}
		return returning, signupOnly
	}
	window := func(n int) ActivityWindow {
		r, s := split(-(n - 1), 0)
		pr, ps := split(-(2*n - 1), -n)
		return ActivityWindow{Days: n, Active: r + s, Returning: r, SignupOnly: s,
			PrevActive: pr + ps, PrevReturning: pr, PrevSignupOnly: ps,
			Reconstructed: !instrumented(-(n - 1)), PrevReconstructed: !instrumented(-(2*n - 1))}
	}
	out.Windows = ActivityWindows{D7: window(7), D30: window(30)}

	for _, mp := range people {
		switch {
		case mp.signup >= -29:
			out.Signups30.Count++
			for offset := range mp.days {
				if offset > mp.signup {
					out.Signups30.ReturnedAfter++
					break
				}
			}
		case mp.signup >= -59:
			out.Signups30.PrevCount++
		}
	}
	// The earliest day a return can be on is the day after the window starts.
	out.Signups30.Reconstructed = !instrumented(-28)

	for offset := -(days - 1); offset <= 0; offset++ {
		d := ActivityDay{Date: e.date(offset), Instrumented: instrumented(offset), Partial: offset == 0}
		for _, mp := range people {
			v, ok := mp.days[offset]
			if !ok {
				continue
			}
			if offset == mp.signup {
				d.SignupDay++
			} else {
				d.Returning++
			}
			d.Requests += v.requests
			d.Logins += v.logins
		}
		out.Daily = append(out.Daily, d)
	}

	out.Depth = ActivityDepth{Days: days, Buckets: activityDepthBuckets(days), Reconstructed: !instrumented(-(days - 1))}
	for _, mp := range people {
		n, back := 0, false
		for offset := range mp.days {
			if offset > -days {
				n++
				back = back || offset != mp.signup
			}
		}
		if n == 0 {
			continue
		}
		for i := range out.Depth.Buckets {
			if n >= out.Depth.Buckets[i].Min && n <= out.Depth.Buckets[i].Max {
				out.Depth.Buckets[i].Count++
			}
		}
		out.Depth.Total++
		if !back {
			out.Depth.SignupOnly++
		}
	}

	monday := -2 // panelFrozenNow is a Wednesday
	for k := 0; k < activityCohortWeeks; k++ {
		start := monday - 7*k
		w := ActivityCohortWeek{WeekStart: e.date(start), Reconstructed: !instrumented(start + 1)}
		returned := map[int]int64{}
		last, hasLast := 0, false
		for _, mp := range people {
			if mp.signup < start || mp.signup > start+6 {
				continue
			}
			w.Signups++
			if !hasLast || mp.signup > last {
				last, hasLast = mp.signup, true
			}
			firstBack, back := 0, false
			for offset := range mp.days {
				if offset > mp.signup && (!back || offset < firstBack) {
					firstBack, back = offset, true
				}
			}
			for _, h := range activityCohortHorizons {
				if back && firstBack <= mp.signup+h {
					returned[h]++
				}
			}
		}
		if hasLast {
			s := e.date(last)
			w.LastSignup = &s
		}
		for _, h := range activityCohortHorizons {
			w.Horizons = append(w.Horizons, ActivityCohortHorizon{
				Days: h, Returned: returned[h], Eligible: hasLast && start+6 <= -1 && last+h <= -1,
			})
		}
		out.Cohorts = append(out.Cohorts, w)
	}
	return out
}

// --- an empty database, the real clock -------------------------------------------

// TestActivityPanel_EmptyDatabase: a brand-new deployment renders the panel --
// zeroes, nulls and full axes -- rather than an error.
func TestActivityPanel_EmptyDatabase(t *testing.T) {
	e := newPanelEnv(t, panelFrozenNow())
	got := e.panel(t, "")

	assert.Equal(t, defaultActivityDays, got.Days)
	assert.Equal(t, activityTimezoneLabel, got.Timezone)
	assert.Equal(t, e.date(0)+" 10:00", got.AsOf)
	assert.Nil(t, got.InstrumentedSince)
	assert.Equal(t, ActivityTodayActive{}, got.TodayActive)
	assert.Equal(t, ActivityWindow{Days: 7, Reconstructed: true, PrevReconstructed: true}, got.Windows.D7)
	assert.Equal(t, ActivityWindow{Days: 30, Reconstructed: true, PrevReconstructed: true}, got.Windows.D30)
	assert.Equal(t, ActivitySignupWindow{Reconstructed: true}, got.Signups30)
	require.Len(t, got.Daily, defaultActivityDays, "the axis exists even with no data on it")
	assert.Equal(t, ActivityDepth{Days: 30, Reconstructed: true, Buckets: activityDepthBuckets(30)}, got.Depth)
	require.Len(t, got.Cohorts, activityCohortWeeks)
	for _, w := range got.Cohorts {
		assert.Zero(t, w.Signups)
		assert.Nil(t, w.LastSignup)
		require.Len(t, w.Horizons, len(activityCohortHorizons))
		for _, h := range w.Horizons {
			assert.False(t, h.Eligible)
		}
	}
}

// TestGetActivity_RealClockAgreesWithTheDatabase runs the handler on an
// ordinary pool: today and asOf come from the database's real now().  The day
// is read before and after so a run across midnight cannot fail it.
func TestGetActivity_RealClockAgreesWithTheDatabase(t *testing.T) {
	_, pool := makeHandlers(t)
	ctx := context.Background()
	dbToday := func() string {
		var s string
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`).Scan(&s))
		return s
	}

	before := dbToday()
	rec := httptest.NewRecorder()
	NewActivityHandlers(pool).GetActivity(rec, httptest.NewRequest(http.MethodGet, "/api/admin/activity?days=7", nil))
	after := dbToday()
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var envelope struct {
		Data ActivityPanel `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	got := envelope.Data
	assert.Contains(t, []string{before, after}, got.Today)
	assert.Regexp(t, `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$`, got.AsOf)
	assert.Equal(t, got.Today, got.AsOf[:10], "asOf is a moment of today")
	assert.Equal(t, got.Today, got.Daily[len(got.Daily)-1].Date)
	assert.Len(t, got.Cohorts, activityCohortWeeks)
}

// --- schema, backfill and recorder ------------------------------------------------

// TestUserActivityDaily_RejectsInvertedWindow proves migration 0025's CHECK is
// real.  The recorder's LEAST/GREATEST upsert is what keeps it true; this is
// the backstop for every writer that is not the recorder.
func TestUserActivityDaily_RejectsInvertedWindow(t *testing.T) {
	_, pool := makeHandlers(t)
	user := seedUser(t, pool, "invert", "invert@example.com")
	at := reportingToday().Add(12 * time.Hour)

	_, err := pool.Exec(context.Background(), `
		INSERT INTO user_activity_daily
			(user_id, activity_date, first_seen_at, last_seen_at)
		VALUES ($1, $2, $3, $4)`,
		user, reportingToday().Format(dateLayout), at, at.Add(-time.Hour))
	require.Error(t, err, "last_seen_at < first_seen_at must be rejected by the database")
}

// TestBackfillMigration_ReconstructsInteractionDays runs migration 0026's SQL
// against seeded history.
//
// The migration itself ran on an empty database when the container came up, so
// without re-running it here the whole reconstruction — the UNION, the +08
// bucketing, the idempotent ON CONFLICT — would ship untested.
func TestBackfillMigration_ReconstructsInteractionDays(t *testing.T) {
	_, pool := makeHandlers(t)
	ctx := context.Background()
	today := reportingToday()

	sql, err := os.ReadFile("../../migrations/0026_user_activity_backfill.up.sql")
	require.NoError(t, err, "the backfill migration must stay at this path")

	// A user who registered five days ago and commented three days ago.
	user := seedUserAt(t, pool, "historic", "historic@example.com", today.AddDate(0, 0, -5).Add(9*time.Hour))
	seedAnime(t, pool, animeSeed{AnilistID: 90001, TitleRomaji: "Backfill Test"})
	_, err = pool.Exec(ctx, `
		INSERT INTO episode_comments (anilist_id, episode, user_id, username, content, created_at)
		VALUES (90001, 1, $1, 'historic', 'a comment', $2)`,
		user, today.AddDate(0, 0, -3).Add(20*time.Hour))
	require.NoError(t, err)

	_, err = pool.Exec(ctx, string(sql))
	require.NoError(t, err, "the backfill must apply cleanly")

	rows, err := pool.Query(ctx, `
		SELECT activity_date, request_count FROM user_activity_daily
		WHERE user_id = $1 ORDER BY activity_date`, user)
	require.NoError(t, err)
	defer rows.Close()

	var dates []string
	for rows.Next() {
		var d time.Time
		var requests int64
		require.NoError(t, rows.Scan(&d, &requests))
		dates = append(dates, d.Format(dateLayout))
		assert.Equal(t, int64(0), requests,
			"backfilled rows must carry request_count 0 — it is the marker instrumentedSince is derived from")
	}
	require.NoError(t, rows.Err())

	assert.Equal(t, []string{
		today.AddDate(0, 0, -5).Format(dateLayout), // signup day
		today.AddDate(0, 0, -3).Format(dateLayout), // comment day
	}, dates, "one row per interaction day, signup included")

	// Idempotent: re-running must converge, not double up or fail.
	_, err = pool.Exec(ctx, string(sql))
	require.NoError(t, err, "the backfill must be safe to re-run")

	var count int64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM user_activity_daily WHERE user_id = $1`, user).Scan(&count))
	assert.Equal(t, int64(2), count, "a second run must not add rows")
}

// TestBackfillMigration_DoesNotClobberRecordedCounters: the reconstruction can
// legitimately run on a container that has already served traffic, and its
// ON CONFLICT must widen the window without touching a counter the recorder
// owns.  DO NOTHING would have dropped the historical first_seen_at instead.
func TestBackfillMigration_DoesNotClobberRecordedCounters(t *testing.T) {
	_, pool := makeHandlers(t)
	ctx := context.Background()
	today := reportingToday()

	sql, err := os.ReadFile("../../migrations/0026_user_activity_backfill.up.sql")
	require.NoError(t, err)

	// Registered this morning, and the recorder has already logged traffic
	// today — with a LATER first_seen_at than the signup timestamp.
	user := seedUserAt(t, pool, "live", "live@example.com", today.Add(8*time.Hour))
	_, err = pool.Exec(ctx, `
		INSERT INTO user_activity_daily
			(user_id, activity_date, first_seen_at, last_seen_at, request_count)
		VALUES ($1, $2, $3, $4, 42)`,
		user, today.Format(dateLayout), today.Add(15*time.Hour), today.Add(16*time.Hour))
	require.NoError(t, err)

	_, err = pool.Exec(ctx, string(sql))
	require.NoError(t, err)

	var first, last time.Time
	var requests int64
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT first_seen_at, last_seen_at, request_count
		FROM user_activity_daily WHERE user_id = $1`, user).Scan(&first, &last, &requests))

	assert.Equal(t, int64(42), requests, "the recorder's counter must survive the backfill untouched")
	assert.True(t, first.Equal(today.Add(8*time.Hour)),
		"first_seen_at widens back to the signup, the earlier of the two")
	assert.True(t, last.Equal(today.Add(16*time.Hour)),
		"last_seen_at keeps the later of the two")
}

// TestListUsers_CarriesActivityColumns closes the loop on the other half of
// this feature: the per-user numbers on the user-management table.
func TestListUsers_CarriesActivityColumns(t *testing.T) {
	h, pool := makeHandlers(t)

	seen := seedUser(t, pool, "seen_user", "seen@example.com")
	seedUser(t, pool, "unseen_user", "unseen@example.com")
	seedActivity(t, pool, seen, 0, 7)
	seedActivity(t, pool, seen, 3, 2)
	_, err := pool.Exec(context.Background(),
		`UPDATE user_activity_daily SET login_count = 2 WHERE user_id = $1 AND activity_date = $2`,
		seen, reportingToday().Format(dateLayout))
	require.NoError(t, err)

	rec := httptest.NewRecorder()
	h.ListUsers(rec, httptest.NewRequest(http.MethodGet, "/api/admin/users", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	var got struct {
		Data []userItem `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Len(t, got.Data, 2)

	byName := map[string]userItem{}
	for _, u := range got.Data {
		byName[u.Username] = u
	}

	active := byName["seen_user"]
	require.NotNil(t, active.LastSeenAt, "an account with recorded activity has a last-seen")
	assert.Equal(t, int64(2), active.ActiveDays)
	assert.Equal(t, int64(2), active.Logins)

	quiet := byName["unseen_user"]
	assert.Nil(t, quiet.LastSeenAt,
		"never recorded must serialise as null, not as an epoch that reads as a visit in year 1")
	assert.Equal(t, int64(0), quiet.ActiveDays)
	assert.Equal(t, int64(0), quiet.Logins)
}

// TestRecorderFlush_SkipsDeletedUsersWithoutDroppingTheBatch.
//
// THE FAILURE THIS EXISTS FOR, spelled out because the code that prevents it
// is one inconspicuous WHERE clause.
//
// user_activity_daily.user_id carries a foreign key to users, and an access
// token stays valid for fifteen minutes after an admin deletes the account it
// belongs to.  Every request that token makes enqueues a uuid with no row
// behind it.  The recorder flushes ALL users in one statement and drops the
// whole batch on any error -- so without the guard, one deleted account
// silently zeroes EVERYBODY's counters, once a minute, until the token
// expires.
//
// This runs the real statement against the real schema, because the guard is
// SQL and a fake execer would prove nothing about it.
func TestRecorderFlush_SkipsDeletedUsersWithoutDroppingTheBatch(t *testing.T) {
	_, pool := makeHandlers(t)
	ctx := context.Background()

	alive := seedUser(t, pool, "still_here", "alive@example.com")
	ghost := uuid.New() // never existed; stands in for "deleted a minute ago"
	at := reportingToday().Add(12 * time.Hour)

	rec := activity.NewRecorder(pool, nil, time.Hour)
	rec.Touch(alive, at)
	rec.Touch(alive, at)
	rec.Touch(ghost, at)
	rec.Flush(ctx)

	var requests int64
	err := pool.QueryRow(ctx,
		`SELECT request_count FROM user_activity_daily WHERE user_id = $1`, alive).Scan(&requests)
	require.NoError(t, err,
		"the live user's row must exist: a deleted account in the same batch must not take it down")
	assert.Equal(t, int64(2), requests)

	var ghostRows int64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM user_activity_daily WHERE user_id = $1`, ghost).Scan(&ghostRows))
	assert.Equal(t, int64(0), ghostRows, "the orphan row must be skipped, not inserted")
}

// TestRecorderFlush_SurvivesADeleteThatLandsMidFlush is the race the WHERE
// EXISTS guard cannot see.  The account still exists when the flush statement
// starts, so the guard lets its row through; the foreign-key check then waits
// on the deleting transaction's row lock, and when the delete commits the
// whole statement fails with 23503.  Without the recorder's one retry,
// everybody else's counters for that interval were lost with it.
//
// The interleaving is forced, not hoped for: the test holds the account's row
// lock the way ArchiveAndDeleteUser does, waits until pg_stat_activity shows
// the flush parked on that lock, and only then deletes and commits.
func TestRecorderFlush_SurvivesADeleteThatLandsMidFlush(t *testing.T) {
	_, pool := makeHandlers(t)
	ctx := context.Background()

	survivor := seedUser(t, pool, "survivor", "survivor@example.com")
	doomed := seedUser(t, pool, "doomed", "doomed@example.com")
	at := reportingToday().Add(12 * time.Hour)

	rec := activity.NewRecorder(pool, discardLogger(), time.Hour)
	rec.Touch(survivor, at)
	rec.Touch(survivor, at)
	rec.Touch(doomed, at)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, doomed)
	require.NoError(t, err)

	flushed := make(chan struct{})
	go func() {
		defer close(flushed)
		rec.Flush(ctx)
	}()
	waitForFlushOnRowLock(t, pool)

	_, err = tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, doomed)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))

	select {
	case <-flushed:
	case <-time.After(10 * time.Second):
		t.Fatal("the flush did not finish after the delete committed")
	}

	var requests int64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT request_count FROM user_activity_daily WHERE user_id = $1`, survivor).Scan(&requests),
		"the survivor's row must land although an account in its batch was deleted mid-flush")
	assert.Equal(t, int64(2), requests)
	var doomedRows int64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM user_activity_daily WHERE user_id = $1`, doomed).Scan(&doomedRows))
	assert.Zero(t, doomedRows)
}

// waitForFlushOnRowLock blocks until a recorder flush is waiting on a lock.
func waitForFlushOnRowLock(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		require.NoError(t, pool.QueryRow(context.Background(), `
			SELECT count(*) FROM pg_stat_activity
			WHERE wait_event_type = 'Lock'
			  AND query LIKE '%INSERT INTO user_activity_daily AS uad%'`).Scan(&waiting))
		if waiting > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the flush never blocked on the account's row lock")
}

// TestRecorderFlush_StampsThePlusEightDay: the write side of the +08 rule.  A
// request at 23:30 UTC is 07:30 the next morning in +08, and the row lands
// on that day -- the statement derives activity_date from first_seen_at in
// SQL, not from the server's zone.
func TestRecorderFlush_StampsThePlusEightDay(t *testing.T) {
	_, pool := makeHandlers(t)
	ctx := context.Background()
	user := seedUser(t, pool, "night_owl", "owl@example.com")

	y, m, d := reportingToday().AddDate(0, 0, -2).Date()
	at := time.Date(y, m, d, 23, 30, 0, 0, time.UTC)
	rec := activity.NewRecorder(pool, discardLogger(), time.Hour)
	rec.Touch(user, at)
	rec.Flush(ctx)

	var got string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT activity_date::text FROM user_activity_daily WHERE user_id = $1`, user).Scan(&got))
	assert.Equal(t, time.Date(y, m, d+1, 0, 0, 0, 0, time.UTC).Format(dateLayout), got)
}
