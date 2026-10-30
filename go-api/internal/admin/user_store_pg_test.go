package admin

// user_store_pg_test.go — deleting an account against the real schema
// (migration 0054): the account goes, the history it was counted in stays.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

func newStorePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	return pool
}

// archiveSeedDay writes one activity day for userID at a fixed instant.
func archiveSeedDay(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, date string, first, last time.Time, requests, logins int64) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO user_activity_daily
			(user_id, activity_date, first_seen_at, last_seen_at, request_count, login_count)
		VALUES ($1, $2::date, $3, $4, $5, $6)`,
		userID, date, first, last, requests, logins)
	require.NoError(t, err, "archiveSeedDay")
}

type archivedDay struct {
	ArchiveID    uuid.UUID
	ActivityDate string
	FirstSeen    time.Time
	LastSeen     time.Time
	Requests     int64
	Logins       int64
}

func readArchivedDays(t *testing.T, pool *pgxpool.Pool) []archivedDay {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT archive_id, activity_date::text, first_seen_at, last_seen_at, request_count, login_count
		FROM archived_user_activity_daily
		ORDER BY activity_date`)
	require.NoError(t, err)
	defer rows.Close()
	var out []archivedDay
	for rows.Next() {
		var d archivedDay
		require.NoError(t, rows.Scan(&d.ArchiveID, &d.ActivityDate, &d.FirstSeen, &d.LastSeen, &d.Requests, &d.Logins))
		out = append(out, d)
	}
	require.NoError(t, rows.Err())
	return out
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int64 {
	t.Helper()
	var n int64
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&n), sql)
	return n
}

// The whole point of 0054: every number the activity panel draws over these
// days is the same before and after the delete, and nothing that identifies
// the account is left behind.
func TestArchiveAndDeleteUser_KeepsTheHistoryAndForgetsThePerson(t *testing.T) {
	pool := newStorePool(t)
	ctx := context.Background()

	signup := time.Date(2026, 9, 1, 23, 30, 0, 0, time.UTC) // 07:30 on 09-02 in +08
	victim := seedUserAt(t, pool, "victim", "victim@example.com", signup)
	bystander := seedUserAt(t, pool, "bystander", "bystander@example.com", signup)

	at := func(day string, hhmm string) time.Time {
		ts, err := time.Parse("2006-01-02 15:04 -0700", day+" "+hhmm+" +0800")
		require.NoError(t, err)
		return ts
	}
	// A reconstructed day (0026 writes request_count = 0), the signup day and a
	// return visit, plus the bystander on one of the same days.
	archiveSeedDay(t, pool, victim, "2026-08-20", at("2026-08-20", "21:00"), at("2026-08-20", "21:00"), 0, 0)
	archiveSeedDay(t, pool, victim, "2026-09-02", at("2026-09-02", "07:30"), at("2026-09-02", "23:10"), 40, 1)
	archiveSeedDay(t, pool, victim, "2026-09-05", at("2026-09-05", "20:15"), at("2026-09-05", "20:45"), 12, 0)
	archiveSeedDay(t, pool, bystander, "2026-09-05", at("2026-09-05", "09:00"), at("2026-09-05", "09:05"), 3, 0)

	perDay := `SELECT count(*) FROM activity_days WHERE activity_date = $1::date`
	beforePeople := countRows(t, pool, `SELECT count(*) FROM activity_people`)
	beforeSep05 := countRows(t, pool, perDay, "2026-09-05")
	beforeSignupsSep02 := countRows(t, pool, `
		SELECT count(*) FROM activity_people
		WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date = '2026-09-02'`)
	require.EqualValues(t, 2, beforeSep05)
	require.EqualValues(t, 2, beforeSignupsSep02)

	deleted, err := NewUserStore(pool).ArchiveAndDeleteUser(ctx, victim)
	require.NoError(t, err)
	require.True(t, deleted)

	// The account and its live rows are gone; the bystander is untouched.
	assert.EqualValues(t, 0, countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, victim))
	assert.EqualValues(t, 0, countRows(t, pool, `SELECT count(*) FROM user_activity_daily WHERE user_id = $1`, victim))
	assert.EqualValues(t, 1, countRows(t, pool, `SELECT count(*) FROM user_activity_daily WHERE user_id = $1`, bystander))

	// The statistics read the same.
	assert.Equal(t, beforePeople, countRows(t, pool, `SELECT count(*) FROM activity_people`))
	assert.Equal(t, beforeSep05, countRows(t, pool, perDay, "2026-09-05"))
	assert.EqualValues(t, 1, countRows(t, pool, perDay, "2026-09-02"))
	assert.EqualValues(t, 1, countRows(t, pool, perDay, "2026-08-20"))
	assert.Equal(t, beforeSignupsSep02, countRows(t, pool, `
		SELECT count(*) FROM activity_people
		WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date = '2026-09-02'`))

	// One archived person, carrying the signup instant and not the user id.
	var archiveID uuid.UUID
	var archivedSignup time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT archive_id, created_at FROM archived_users`).Scan(&archiveID, &archivedSignup))
	assert.NotEqual(t, victim, archiveID, "the archive must not carry the account's id")
	assert.True(t, archivedSignup.Equal(signup), "signup instant: got %s want %s", archivedSignup, signup)

	// Every day copied unchanged, including the reconstructed marker.
	days := readArchivedDays(t, pool)
	require.Len(t, days, 3)
	for _, d := range days {
		assert.Equal(t, archiveID, d.ArchiveID)
	}
	assert.Equal(t, "2026-08-20", days[0].ActivityDate)
	assert.EqualValues(t, 0, days[0].Requests, "request_count = 0 marks a reconstructed day and must survive the copy")
	assert.Equal(t, "2026-09-02", days[1].ActivityDate)
	assert.True(t, days[1].FirstSeen.Equal(at("2026-09-02", "07:30")))
	assert.True(t, days[1].LastSeen.Equal(at("2026-09-02", "23:10")))
	assert.EqualValues(t, 40, days[1].Requests)
	assert.EqualValues(t, 1, days[1].Logins)
	assert.Equal(t, "2026-09-05", days[2].ActivityDate)
	assert.EqualValues(t, 12, days[2].Requests)
}

// An account that never made a recorded request still signed up on a day,
// and that day's signup bar must not shrink.
func TestArchiveAndDeleteUser_NoActivityStillKeepsTheSignup(t *testing.T) {
	pool := newStorePool(t)
	signup := time.Date(2026, 10, 3, 4, 0, 0, 0, time.UTC)
	id := seedUserAt(t, pool, "quiet", "quiet@example.com", signup)

	deleted, err := NewUserStore(pool).ArchiveAndDeleteUser(context.Background(), id)
	require.NoError(t, err)
	require.True(t, deleted)

	assert.EqualValues(t, 1, countRows(t, pool, `SELECT count(*) FROM archived_users WHERE created_at = $1`, signup))
	assert.EqualValues(t, 0, countRows(t, pool, `SELECT count(*) FROM archived_user_activity_daily`))
	assert.EqualValues(t, 1, countRows(t, pool, `SELECT count(*) FROM activity_people`))
}

// Nothing is written for an account that is not there.
func TestArchiveAndDeleteUser_MissingAccountWritesNothing(t *testing.T) {
	pool := newStorePool(t)
	deleted, err := NewUserStore(pool).ArchiveAndDeleteUser(context.Background(), uuid.New())
	require.NoError(t, err)
	assert.False(t, deleted)
	assert.EqualValues(t, 0, countRows(t, pool, `SELECT count(*) FROM archived_users`))
}

// The HTTP handler with the production store: the route an operator actually
// uses archives before it deletes.
func TestDeleteUser_ThroughTheHandlerArchives(t *testing.T) {
	pool := newStorePool(t)
	target := seedUserAt(t, pool, "target", "target@example.com", time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC))
	archiveSeedDay(t, pool, target, "2026-10-01",
		time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC), time.Date(2026, 10, 1, 12, 5, 0, 0, time.UTC), 5, 1)

	h := NewUserHandlers(NewUserStore(pool), fakeEnqueuer{})
	ctx := withAdminClaims(t, context.Background(), uuid.New(), "admin")
	req := requestWithUserID(t, http.MethodDelete, "/api/admin/users/"+target.String(), "", target.String()).WithContext(
		chiCtxOver(t, ctx, target.String()))
	rec := httptest.NewRecorder()
	h.DeleteUser(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.EqualValues(t, 0, countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, target))
	assert.EqualValues(t, 1, countRows(t, pool, `SELECT count(*) FROM archived_users`))
	assert.EqualValues(t, 1, countRows(t, pool, `SELECT count(*) FROM archived_user_activity_daily`))
}

// The prune job's own SQL, run as pg_cron would run it: rows past the 400-day
// horizon go, a signup row goes only once it is old AND has no activity left,
// and everything inside the horizon stays.
func TestArchivePruneJob_KeepsTheHorizon(t *testing.T) {
	pool := newStorePool(t)
	ctx := context.Background()

	var command string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT command FROM cron.job WHERE jobname = 'user-activity-archive-prune'`).Scan(&command))

	insertPerson := func(createdAt time.Time) uuid.UUID {
		var id uuid.UUID
		require.NoError(t, pool.QueryRow(ctx,
			`INSERT INTO archived_users (created_at) VALUES ($1) RETURNING archive_id`, createdAt).Scan(&id))
		return id
	}
	insertDay := func(id uuid.UUID, daysAgo int) {
		_, err := pool.Exec(ctx, `
			INSERT INTO archived_user_activity_daily (archive_id, activity_date, first_seen_at, last_seen_at, request_count)
			VALUES ($1, (now() AT TIME ZONE 'Asia/Shanghai')::date - $2::int, now(), now(), 1)`, id, daysAgo)
		require.NoError(t, err)
	}

	now := time.Now()
	oldAndEmpty := insertPerson(now.AddDate(0, 0, -500))
	oldButActive := insertPerson(now.AddDate(0, 0, -500))
	insertDay(oldButActive, 10)
	insertDay(oldButActive, 401)
	recent := insertPerson(now.AddDate(0, 0, -20))
	insertDay(recent, 3)

	_, err := pool.Exec(ctx, command)
	require.NoError(t, err, "the scheduled command must run as written")

	assert.EqualValues(t, 0, countRows(t, pool, `SELECT count(*) FROM archived_users WHERE archive_id = $1`, oldAndEmpty))
	assert.EqualValues(t, 1, countRows(t, pool, `SELECT count(*) FROM archived_users WHERE archive_id = $1`, oldButActive))
	assert.EqualValues(t, 1, countRows(t, pool, `SELECT count(*) FROM archived_user_activity_daily WHERE archive_id = $1`, oldButActive),
		"the 401-day-old row goes, the 10-day-old one stays")
	assert.EqualValues(t, 1, countRows(t, pool, `SELECT count(*) FROM archived_users WHERE archive_id = $1`, recent))
	assert.EqualValues(t, 1, countRows(t, pool, `SELECT count(*) FROM archived_user_activity_daily WHERE archive_id = $1`, recent))
}
