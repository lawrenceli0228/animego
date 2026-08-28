package admin

// activity_pg_test.go — the activity panel against the real schema, using the
// testcontainers Postgres shared by handlers_test.go's TestMain.
//
// These tests are where migrations 0025 and 0026 are actually exercised: the
// unit tests in activity_unit_test.go can prove the gap-filling and the
// clamping, but only real SQL can prove that the +08 bucketing, the rolling
// windows, the retention eligibility gates and the backfill's UNION agree with
// what their comments claim.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/activity"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// reportingToday is the same "today" every query in activity.sql computes.
// Derived through internal/activity so the test cannot quietly disagree with
// production about where the day boundary is.
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

func getActivity(t *testing.T, pool *pgxpool.Pool, query string) ActivityResp {
	t.Helper()
	h := NewActivityHandlers(dbgen.New(pool), nil)
	rec := httptest.NewRecorder()
	h.GetActivity(rec, httptest.NewRequest(http.MethodGet, "/api/admin/activity"+query, nil))
	require.Equal(t, http.StatusOK, rec.Code, "body: %s", rec.Body.String())

	var envelope struct {
		Data ActivityResp `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	return envelope.Data
}

// TestGetActivity_RollingWindows pins DAU/WAU/MAU to their documented bounds.
//
// The off-by-one here is the kind that survives review and then quietly
// misstates a headline number for months: WAU is today plus the six days
// before it, so a user last seen exactly six days ago is IN and one last seen
// seven days ago is OUT.
func TestGetActivity_RollingWindows(t *testing.T) {
	_, pool := makeHandlers(t)

	today := seedUser(t, pool, "today_user", "today@example.com")
	sixDays := seedUser(t, pool, "six_days", "six@example.com")
	sevenDays := seedUser(t, pool, "seven_days", "seven@example.com")
	twentyNine := seedUser(t, pool, "twentynine", "twentynine@example.com")
	thirty := seedUser(t, pool, "thirty", "thirty@example.com")

	seedActivity(t, pool, today, 0, 5)
	seedActivity(t, pool, sixDays, 6, 5)
	seedActivity(t, pool, sevenDays, 7, 5)
	seedActivity(t, pool, twentyNine, 29, 5)
	seedActivity(t, pool, thirty, 30, 5)

	got := getActivity(t, pool, "")

	assert.Equal(t, int64(1), got.Dau, "only the user seen today")
	assert.Equal(t, int64(2), got.Wau, "today + exactly six days ago; seven days ago is outside")
	assert.Equal(t, int64(4), got.Mau, "everything down to twenty-nine days ago; thirty is outside")
	assert.InDelta(t, 0.25, got.Stickiness, 1e-9, "DAU/MAU")
}

// TestGetActivity_CountsPeopleNotRows: a person active on several days inside
// the window is one active user, not several.  Getting this wrong would make
// WAU and MAU grow with the window length regardless of how many people used
// the site.
func TestGetActivity_CountsPeopleNotRows(t *testing.T) {
	_, pool := makeHandlers(t)

	user := seedUser(t, pool, "regular", "regular@example.com")
	for d := range 10 {
		seedActivity(t, pool, user, d, 3)
	}

	got := getActivity(t, pool, "")
	assert.Equal(t, int64(1), got.Dau)
	assert.Equal(t, int64(1), got.Wau)
	assert.Equal(t, int64(1), got.Mau)
}

// TestGetActivity_InstrumentedSinceComesFromTheData.
//
// The seam between reconstructed history and recorded traffic is derived from
// request_count rather than from a stored constant: migration 0026 writes 0
// and the live recorder never leaves one there.  A backfilled row must not be
// able to claim instrumentation.
func TestGetActivity_InstrumentedSinceComesFromTheData(t *testing.T) {
	_, pool := makeHandlers(t)
	user := seedUser(t, pool, "seam", "seam@example.com")

	// Reconstructed: request_count stays 0, exactly as 0026 writes it.
	seedActivity(t, pool, user, 5, 0)
	seedActivity(t, pool, user, 4, 0)
	// Recorded.
	seedActivity(t, pool, user, 3, 12)
	seedActivity(t, pool, user, 0, 20)

	got := getActivity(t, pool, "?days=10")

	require.NotNil(t, got.InstrumentedSince)
	want := reportingToday().AddDate(0, 0, -3).Format(dateLayout)
	assert.Equal(t, want, *got.InstrumentedSince)

	byDate := map[string]ActivityDayPoint{}
	for _, p := range got.Daily {
		byDate[p.Date] = p
	}
	assert.False(t, byDate[reportingToday().AddDate(0, 0, -4).Format(dateLayout)].Instrumented,
		"a day whose only rows came from the backfill is not instrumented")
	assert.True(t, byDate[want].Instrumented, "the boundary day is instrumented")
	assert.True(t, byDate[reportingToday().Format(dateLayout)].Instrumented)
}

// TestGetActivity_InstrumentedSinceNullOnFreshDatabase: no recorded traffic
// yet is a real state (migrations applied, nothing served), and it must
// serialise as null so the UI says "not instrumented" instead of printing a
// date it made up.
func TestGetActivity_InstrumentedSinceNullOnFreshDatabase(t *testing.T) {
	_, pool := makeHandlers(t)
	user := seedUser(t, pool, "fresh", "fresh@example.com")
	seedActivity(t, pool, user, 2, 0)

	got := getActivity(t, pool, "")
	assert.Nil(t, got.InstrumentedSince)
}

// TestGetActivity_DailySeriesLinesUpWithSignups checks the two independently
// bucketed series land on the same axis.  Bucketing them differently is what
// produces a chart where a cohort appears the day before it exists.
func TestGetActivity_DailySeriesLinesUpWithSignups(t *testing.T) {
	_, pool := makeHandlers(t)

	threeDaysAgo := reportingToday().AddDate(0, 0, -3).Add(9 * time.Hour)
	user := seedUserAt(t, pool, "cohorted", "cohorted@example.com", threeDaysAgo)
	seedActivity(t, pool, user, 3, 4)

	got := getActivity(t, pool, "?days=7")
	require.Len(t, got.Daily, 7)

	target := reportingToday().AddDate(0, 0, -3).Format(dateLayout)
	for _, p := range got.Daily {
		if p.Date != target {
			continue
		}
		assert.Equal(t, int64(1), p.NewUsers, "the signup lands on its own local day")
		assert.Equal(t, int64(1), p.ActiveUsers, "so does the activity")
		return
	}
	t.Fatalf("day %s missing from the series", target)
}

// TestGetActivity_RetentionEligibilityGates is the arithmetic most likely to
// be wrong and least likely to look wrong.
//
// An account that registered today has not failed to return tomorrow; counting
// it in the day-1 denominator drags every retention figure down by exactly the
// share of the window too young to answer — so the numbers get WORSE on the
// days you gain signups.
func TestGetActivity_RetentionEligibilityGates(t *testing.T) {
	_, pool := makeHandlers(t)
	today := reportingToday()

	// Registered today: too young for either horizon.
	seedUserAt(t, pool, "today_signup", "t@example.com", today.Add(9*time.Hour))

	// Registered two days ago and came back the next day: counts for d1, still
	// too young for d7.
	returner := seedUserAt(t, pool, "d1_returner", "d1@example.com", today.AddDate(0, 0, -2).Add(9*time.Hour))
	seedActivity(t, pool, returner, 2, 3)
	seedActivity(t, pool, returner, 1, 3)

	// Registered two days ago and never came back: counts for d1's
	// denominator only.
	seedUserAt(t, pool, "d1_lost", "lost@example.com", today.AddDate(0, 0, -2).Add(9*time.Hour))

	// Registered ten days ago, active on day 7 exactly: counts for both.
	veteran := seedUserAt(t, pool, "d7_returner", "d7@example.com", today.AddDate(0, 0, -10).Add(9*time.Hour))
	seedActivity(t, pool, veteran, 10, 3)
	seedActivity(t, pool, veteran, 3, 3) // signup + 7

	got := getActivity(t, pool, "?days=30")
	require.NotNil(t, got.Retention)

	assert.Equal(t, int64(3), got.Retention.D1.Cohort,
		"everyone at least a day old: the two two-day-olds and the ten-day-old, but not today's signup")
	assert.Equal(t, int64(1), got.Retention.D1.Returned, "only d1_returner was active on signup+1")

	assert.Equal(t, int64(1), got.Retention.D7.Cohort, "only the ten-day-old is old enough to answer")
	assert.Equal(t, int64(1), got.Retention.D7.Returned)

	assert.Equal(t, int64(4), got.Retention.Ever.Cohort, "no eligibility gate: every signup in the window")
	assert.Equal(t, int64(2), got.Retention.Ever.Returned, "d1_returner and d7_returner")
	assert.Equal(t, 30, got.Retention.WindowDays)
}

// TestGetActivity_RetentionIsDayExact: "returned on day 7" means day 7, not
// "within 7 days".  A user active on day 6 and day 8 but not day 7 is not
// retained by this definition, and quietly widening it would make the number
// incomparable with every other product's.
func TestGetActivity_RetentionIsDayExact(t *testing.T) {
	_, pool := makeHandlers(t)
	today := reportingToday()

	user := seedUserAt(t, pool, "near_miss", "near@example.com", today.AddDate(0, 0, -10).Add(9*time.Hour))
	seedActivity(t, pool, user, 4, 1) // signup + 6
	seedActivity(t, pool, user, 2, 1) // signup + 8

	got := getActivity(t, pool, "?days=30")
	require.NotNil(t, got.Retention)
	assert.Equal(t, int64(1), got.Retention.D7.Cohort)
	assert.Equal(t, int64(0), got.Retention.D7.Returned, "day 6 and day 8 are not day 7")
	assert.Equal(t, int64(1), got.Retention.Ever.Returned, "but they do count as having come back at all")
}

// TestGetActivity_EmptyDatabaseIsAllZeroesNotAnError: a brand-new deployment
// must render the panel rather than an error, and every list must be an empty
// array rather than null — null is reserved for "the query failed".
func TestGetActivity_EmptyDatabaseIsAllZeroesNotAnError(t *testing.T) {
	_, pool := makeHandlers(t)

	got := getActivity(t, pool, "")

	assert.Equal(t, int64(0), got.Dau)
	assert.Equal(t, int64(0), got.Wau)
	assert.Equal(t, int64(0), got.Mau)
	assert.Equal(t, 0.0, got.Stickiness)
	assert.Len(t, got.Daily, defaultActivityDays, "the axis exists even with no data on it")
	assert.NotNil(t, got.Retention)
}

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
// expires.  The only trace would be a foreign-key line in the log and a dent
// in the DAU chart that nobody could explain.
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

// TestGetActivity_RetentionSoftFailsToNull.
//
// Retention is the most expensive read on this endpoint -- users joined
// against the activity table with three correlated EXISTS probes per cohort
// member -- so it is the one most likely to time out first.  Losing it must
// not take the headline numbers with it, and it must come back as null rather
// than as zeroes: a zero here is the claim "nobody returned", which is exactly
// what a failed query has no right to assert.
func TestGetActivity_RetentionSoftFailsToNull(t *testing.T) {
	_, pool := makeHandlers(t)
	user := seedUser(t, pool, "soft_fail", "soft@example.com")
	seedActivity(t, pool, user, 0, 5)

	h := NewActivityHandlers(retentionFailingQuerier{dbgen.New(pool)}, discardLogger())
	rec := httptest.NewRecorder()
	h.GetActivity(rec, httptest.NewRequest(http.MethodGet, "/api/admin/activity", nil))

	require.Equal(t, http.StatusOK, rec.Code,
		"a failed retention query must not 500 the whole panel; body=%s", rec.Body.String())

	var envelope struct {
		Data ActivityResp `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	assert.Nil(t, envelope.Data.Retention, "must be null, never a zeroed object")
	assert.Equal(t, int64(1), envelope.Data.Dau, "the headline numbers still ship")
	assert.NotEmpty(t, envelope.Data.Daily)
}

// retentionFailingQuerier delegates everything to a real querier except the
// retention read.  Embedding rather than reimplementing keeps the other
// numbers genuine, which is the whole point of the assertion above -- the same
// shape handlers_test.go uses for descCnFailingQuerier.
type retentionFailingQuerier struct{ activityQuerier }

func (retentionFailingQuerier) GetActivityRetention(_ context.Context, _ int32) (dbgen.GetActivityRetentionRow, error) {
	return dbgen.GetActivityRetentionRow{}, errors.New("simulated retention query failure")
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
