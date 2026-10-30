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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/activity"
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

// flushLikeUpsert adds to one activity day the way the recorder's flush does
// (internal/activity, recordUserActivitySQL): the same ON CONFLICT path, so
// the same locks.  An existing day is updated in place -- its row locked, the
// users row not locked at all, because the foreign key does not change -- and
// a new day is inserted, with the foreign-key check taking a KEY SHARE lock
// on the users row.  Run inside a test-held transaction so the locks stay
// held for as long as the test needs.
func flushLikeUpsert(t *testing.T, ctx context.Context, tx pgx.Tx, userID uuid.UUID, first, last time.Time, requests, logins int64) error {
	t.Helper()
	_, err := tx.Exec(ctx, `
		INSERT INTO user_activity_daily AS uad
			(user_id, activity_date, first_seen_at, last_seen_at, request_count, login_count)
		VALUES ($1, ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date, $2, $3, $4, $5)
		ON CONFLICT (activity_date, user_id) DO UPDATE
		SET first_seen_at = LEAST(uad.first_seen_at, EXCLUDED.first_seen_at),
		    last_seen_at  = GREATEST(uad.last_seen_at, EXCLUDED.last_seen_at),
		    request_count = uad.request_count + EXCLUDED.request_count,
		    login_count   = uad.login_count   + EXCLUDED.login_count`,
		userID, first, last, requests, logins)
	return err
}

// waitForAnotherBackendOnLock blocks until a backend other than pid is
// waiting on a lock, so a test can force an interleaving instead of hoping
// for it.
func waitForAnotherBackendOnLock(t *testing.T, pool *pgxpool.Pool, pid uint32) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		require.NoError(t, pool.QueryRow(context.Background(), `
			SELECT count(*) FROM pg_stat_activity
			WHERE wait_event_type = 'Lock' AND pid <> $1 AND datname = current_database()`,
			int64(pid)).Scan(&waiting))
		if waiting > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("no other backend ever waited on a lock")
}

type archiveOutcome struct {
	deleted bool
	err     error
}

// archiveInBackground runs ArchiveAndDeleteUser on its own goroutine.
func archiveInBackground(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) <-chan archiveOutcome {
	done := make(chan archiveOutcome, 1)
	go func() {
		deleted, err := NewUserStore(pool).ArchiveAndDeleteUser(ctx, id)
		done <- archiveOutcome{deleted, err}
	}()
	return done
}

func awaitArchive(t *testing.T, done <-chan archiveOutcome) {
	t.Helper()
	select {
	case out := <-done:
		require.NoError(t, out.err)
		require.True(t, out.deleted)
	case <-time.After(15 * time.Second):
		t.Fatal("the archive never finished")
	}
}

// A flush that adds to a day the account already has does not lock the users
// row, so locking that row first did not wait for it: the copy read the day
// as it was before the flush, the cascade then deleted the day as the flush
// left it, and the flush's counters ended up in neither table.  The archive
// now locks the account's activity rows first and moves them, so it waits
// for the flush and archives the day as it finally stands.
func TestArchiveAndDeleteUser_WaitsForAFlushAddingToAnExistingDay(t *testing.T) {
	pool := newStorePool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	at := func(hhmm string) time.Time {
		ts, err := time.Parse("2006-01-02 15:04 -0700", "2026-10-20 "+hhmm+" +0800")
		require.NoError(t, err)
		return ts
	}
	victim := seedUserAt(t, pool, "victim", "victim@example.com", at("08:00"))
	archiveSeedDay(t, pool, victim, "2026-10-20", at("10:00"), at("10:00"), 1, 0)

	flush, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = flush.Rollback(ctx) }()
	var flushPID uint32
	require.NoError(t, flush.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&flushPID))
	require.NoError(t, flushLikeUpsert(t, ctx, flush, victim, at("11:00"), at("11:30"), 5, 1))

	done := archiveInBackground(ctx, pool, victim)
	waitForAnotherBackendOnLock(t, pool, flushPID)
	select {
	case out := <-done:
		t.Fatalf("the archive finished while the flush was still open: %+v", out)
	default:
	}
	require.NoError(t, flush.Commit(ctx))
	awaitArchive(t, done)

	days := readArchivedDays(t, pool)
	require.Len(t, days, 1)
	assert.EqualValues(t, 6, days[0].Requests, "the flush's +5 must be archived with the day")
	assert.EqualValues(t, 1, days[0].Logins)
	assert.True(t, days[0].FirstSeen.Equal(at("10:00")))
	assert.True(t, days[0].LastSeen.Equal(at("11:30")))
	assert.EqualValues(t, 0, countRows(t, pool, `SELECT count(*) FROM user_activity_daily WHERE user_id = $1`, victim))
}

// One flush can carry two days for the same account across +08 midnight: it
// adds to yesterday's row (locking it) and inserts today's (whose foreign-key
// check then wants the users row).  The archive used to lock the users row
// first and then need yesterday's row for the cascade: a lock cycle, and
// whichever side Postgres aborted, a delete failed or everybody's counters
// for the interval were lost.  The archive now takes the rows in the flush's
// order, so the flush finishes and the archive waits for it.
//
// The two days go in as two statements of one transaction.  That holds the
// same locks in the same order as the recorder's single statement (the
// update's row lock first, the insert's foreign-key lock at the end), and it
// lets the test start the delete between them, which is exactly where the
// cycle formed.
func TestArchiveAndDeleteUser_FlushAcrossMidnightDoesNotDeadlock(t *testing.T) {
	pool := newStorePool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	at := func(day, hhmm string) time.Time {
		ts, err := time.Parse("2006-01-02 15:04:05 -0700", day+" "+hhmm+" +0800")
		require.NoError(t, err)
		return ts
	}
	victim := seedUserAt(t, pool, "victim", "victim@example.com", at("2026-10-01", "12:00:00"))
	archiveSeedDay(t, pool, victim, "2026-10-20", at("2026-10-20", "23:00:00"), at("2026-10-20", "23:40:00"), 3, 0)

	flush, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = flush.Rollback(ctx) }()
	var flushPID uint32
	require.NoError(t, flush.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&flushPID))
	require.NoError(t, flushLikeUpsert(t, ctx, flush, victim,
		at("2026-10-20", "23:50:00"), at("2026-10-20", "23:59:00"), 2, 0), "yesterday: update in place")

	done := archiveInBackground(ctx, pool, victim)
	waitForAnotherBackendOnLock(t, pool, flushPID)

	require.NoError(t, flushLikeUpsert(t, ctx, flush, victim,
		at("2026-10-21", "00:00:30"), at("2026-10-21", "00:01:00"), 1, 0),
		"today: insert, whose foreign-key check must not be left waiting on the archive")
	require.NoError(t, flush.Commit(ctx))
	awaitArchive(t, done)

	days := readArchivedDays(t, pool)
	require.Len(t, days, 2)
	assert.Equal(t, "2026-10-20", days[0].ActivityDate)
	assert.EqualValues(t, 5, days[0].Requests)
	assert.True(t, days[0].LastSeen.Equal(at("2026-10-20", "23:59:00")))
	assert.Equal(t, "2026-10-21", days[1].ActivityDate)
	assert.EqualValues(t, 1, days[1].Requests)
	assert.EqualValues(t, 0, countRows(t, pool, `SELECT count(*) FROM user_activity_daily WHERE user_id = $1`, victim))
}

// The recorder writes its buffer once a minute and skips accounts that no
// longer exist, so an account deleted within a minute of its last request
// lost that minute -- for an account whose only visit that day it was, a
// whole day in the statistics.  DeleteUser flushes the recorder first.
func TestDeleteUser_ArchivesActivityStillInTheRecorder(t *testing.T) {
	pool := newStorePool(t)
	target := seedUserAt(t, pool, "target", "target@example.com", time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC))
	at := time.Date(2026, 10, 21, 2, 0, 0, 0, time.UTC)

	rec := activity.NewRecorder(pool, discardLogger(), time.Hour)
	rec.Touch(target, at)
	rec.Touch(target, at.Add(time.Minute))

	h := NewUserHandlers(NewUserStore(pool), fakeEnqueuer{})
	h.SetActivityFlusher(rec)
	ctx := withAdminClaims(t, context.Background(), uuid.New(), "admin")
	req := requestWithUserID(t, http.MethodDelete, "/api/admin/users/"+target.String(), "", target.String()).WithContext(
		chiCtxOver(t, ctx, target.String()))
	w := httptest.NewRecorder()
	h.DeleteUser(w, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	days := readArchivedDays(t, pool)
	require.Len(t, days, 1, "the buffered day must reach the archive")
	assert.Equal(t, "2026-10-21", days[0].ActivityDate)
	assert.EqualValues(t, 2, days[0].Requests)
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
