package activity

// recorder.go -- the buffer between "a request happened" and "a row moved".
//
// NOTHING IN THIS FEATURE TOUCHES THE DATABASE ON A REQUEST PATH.  Every
// entry point -- the middleware, the beacon, the login hook -- ends in a map
// write under a mutex and returns.  Postgres is written once per flush
// interval, from a background goroutine, in two statements.  That is the whole
// design constraint and the rest of this comment is why it had to be.
//
// THE USER COUNTERS.  The naive version writes one UPSERT per authenticated
// request.  At this site's scale that is not a throughput problem -- it is a
// churn problem.  Every UPSERT against user_activity_daily targets the SAME
// row for the same person for the whole day, so a reader who spends an evening
// on the site rewrites one row hundreds of times, each rewrite leaving a dead
// tuple behind for autovacuum.  A row written eight hundred times a day and
// read twice is a table that bloats for no reader's benefit.
//
// THE SURFACE COUNTERS ARE WORSE, AND THIS IS THE ONE THAT WOULD ACTUALLY
// HURT.  activity_surface_daily is keyed on (date, surface, authenticated) --
// twenty rows a day, total.  Every anonymous visit to any anime page in the
// catalogue increments the SAME row.  Written per beacon, that is one row lock
// serialising the site's entire logged-out page-view volume, on a
// search-traffic-led catalogue whose logged-out volume is the majority.  Under
// a crawl it degrades from "a small extra write" to a contention point that
// slows the pages it is measuring.  Buffered, twenty rows are touched once a
// minute no matter how much traffic arrives, and the beacon endpoint does no
// database work at all.
//
// So both buffers accumulate in memory keyed by their target row and are
// flushed on a ticker as one statement each.  The counters are identical
// either way, because a flush adds a delta rather than overwriting a total.
//
// WHAT THE BUFFER COSTS, STATED PLAINLY.
//
// Up to one flush interval of activity is lost if the process dies without
// running Close.  For an activity dashboard that is the right trade: the
// numbers are read in aggregate by one operator, and losing a minute of
// counters changes nothing anyone would decide.  It would be the wrong trade
// for anything a user can see or that money depends on, which is why this
// package writes nothing of that kind.
//
// Close drains synchronously, so an orderly shutdown loses nothing.

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// DefaultFlushInterval is how long a hit may sit in memory before it
	// reaches Postgres.
	//
	// One minute, because that is well under any interval at which somebody
	// reloads an admin dashboard, and because the row-churn saving is already
	// nearly all captured at this length: the difference between flushing
	// every 60s and every 10s is 6x the writes, while the difference between
	// 60s and 600s is a ten-minute hole in a crash and almost no further
	// saving.
	DefaultFlushInterval = time.Minute

	// maxBufferedUsers forces an early flush when the buffer grows past this
	// many (user, day) keys.
	//
	// A ticker alone bounds TIME but not MEMORY, and the two come apart in
	// exactly the situation you would least like to add an unbounded map to: a
	// database outage, where flushes fail and the buffer keeps accepting.  The
	// cap is not really about the memory (an entry is a few dozen bytes); it
	// is about having a defined ceiling rather than an unexamined one.
	maxBufferedUsers = 10_000

	// flushTimeout bounds one flush statement.  Matches the 5s query budget
	// used across internal/admin and internal/auth.
	flushTimeout = 5 * time.Second
)

// recordUserActivitySQL is the flush statement.
//
// It lives here rather than in internal/db/queries/activity.sql because sqlc
// cannot analyse a multi-argument unnest -- that form is a ROWS FROM construct
// and sqlc's catalogue has no signature for it, so `sqlc generate` fails with
// `function unnest(unknown, unknown, ...) does not exist`.  The same escape
// hatch is already used by internal/admin/list_enrichment.go and list_users.go
// for SQL sqlc cannot express.
//
// Unlike those two, nothing here is composed from user input: the statement
// text is a constant and every value is a uuid or an int64 this process
// counted itself.  There is no allow-list to keep because there is no
// interpolation.
//
// The three behaviours worth naming, all in the ON CONFLICT clause:
//
//   - counters ADD.  A flush is an increment, not a snapshot, so the second
//     flush of a day accumulates onto the first instead of replacing it.
//   - the window WIDENS via LEAST/GREATEST, so a late flush (a retry, or the
//     shutdown drain landing after a newer tick) cannot drag last_seen_at
//     backwards.  This is also what makes migration 0025's
//     last_seen_at >= first_seen_at CHECK true by construction.
//   - activity_date is CAST FROM first_seen_at rather than sent by Go.  The
//     buffer already keys on the same +08 day, so first and last agree; doing
//     the cast in SQL keeps the database the single authority on what date a
//     row carries instead of trusting two implementations to agree forever.
const recordUserActivitySQL = `
INSERT INTO user_activity_daily AS uad (
    user_id, activity_date, first_seen_at, last_seen_at,
    request_count, page_view_count, playback_count, login_count
)
SELECT
    batch.user_id,
    (batch.first_seen_at AT TIME ZONE 'Asia/Shanghai')::date,
    batch.first_seen_at,
    batch.last_seen_at,
    batch.request_count,
    batch.page_view_count,
    batch.playback_count,
    batch.login_count
FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[],
            $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[])
     AS batch (user_id, first_seen_at, last_seen_at,
               request_count, page_view_count, playback_count, login_count)
ON CONFLICT (activity_date, user_id) DO UPDATE
SET first_seen_at   = LEAST(uad.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at    = GREATEST(uad.last_seen_at, EXCLUDED.last_seen_at),
    request_count   = uad.request_count   + EXCLUDED.request_count,
    page_view_count = uad.page_view_count + EXCLUDED.page_view_count,
    playback_count  = uad.playback_count  + EXCLUDED.playback_count,
    login_count     = uad.login_count     + EXCLUDED.login_count`

// recordSurfaceSQL is the aggregate half of the flush, and it is here rather
// than in the sqlc query file for the same reason as the statement above: it
// unnests three parallel arrays, which sqlc cannot analyse.
//
// The stored date is derived from the passed timestamp, not from now(), so a
// flush that crosses local midnight files each buffered bucket on the day it
// actually belongs to instead of on the day the flush happened to run.
//
// The surface strings come from NormalizeSurface, so every value is one of the
// ten the CHECK constraint accepts -- the caller's text never reaches here.
const recordSurfaceSQL = `
INSERT INTO activity_surface_daily AS asd (
    activity_date, surface, authenticated, event_count, updated_at
)
SELECT
    (batch.bucket_at AT TIME ZONE 'Asia/Shanghai')::date,
    batch.surface,
    batch.authenticated,
    batch.event_count,
    now()
FROM unnest($1::timestamptz[], $2::text[], $3::boolean[], $4::bigint[])
     AS batch (bucket_at, surface, authenticated, event_count)
ON CONFLICT (activity_date, surface, authenticated) DO UPDATE
SET event_count = asd.event_count + EXCLUDED.event_count,
    updated_at  = now()`

// execer is the pgxpool surface the recorder needs -- one method, satisfied by
// *pgxpool.Pool as-is.  Declared here, where it is consumed, so tests can
// substitute a fake without a database and without depending on the whole pool
// type.
type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// bufferKey identifies one row of user_activity_daily.
//
// The day is part of the key, not derived at flush time, and that is the whole
// reason this type exists.  Keyed on user alone, a buffer filled at 23:59 and
// flushed at 00:01 would post an hour of yesterday's requests onto today's row
// and stamp a first_seen_at from before the day began.  With the day in the
// key, midnight simply starts a second entry and both are flushed correctly on
// the next tick.
type bufferKey struct {
	UserID uuid.UUID
	Day    time.Time
}

// bufferEntry is the accumulated delta for one bufferKey.
type bufferEntry struct {
	FirstSeen time.Time
	LastSeen  time.Time
	Requests  int64
	PageViews int64
	Playbacks int64
	Logins    int64
}

// surfaceKey identifies one row of activity_surface_daily.
//
// Needs no cap of its own, unlike the user buffer: the key space is (days
// buffered) x (10 surfaces) x 2, so a flush interval can hold at most twenty
// entries and a total outage measured in days would hold a few hundred.
type surfaceKey struct {
	Day           time.Time
	Surface       Surface
	Authenticated bool
}

// Recorder accumulates presence in memory and flushes it in batches.
//
// The zero value is not usable; construct with NewRecorder and call Start
// once.  Every method is safe for concurrent use -- they are called from HTTP
// handler goroutines.
//
// A nil *Recorder is a valid no-op receiver on every method.  That is not
// defensive habit, it is what lets the middleware, the beacon handler and the
// login path be wired unconditionally in main.go and still behave in tests and
// tooling that never construct one.  The alternative -- a nil check at every
// call site -- is four places to forget instead of one.
type Recorder struct {
	pool  execer
	log   *slog.Logger
	every time.Duration

	mu   sync.Mutex
	buf  map[bufferKey]*bufferEntry
	surf map[surfaceKey]int64

	// stop closes on Close; done closes when the flush loop has drained and
	// exited.  Two channels rather than a sync.WaitGroup because Close needs
	// to WAIT for the final drain, and a caller that returns before the drain
	// completes is a caller that loses the data Close exists to save.
	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

// NewRecorder builds a Recorder over pool.  A nil pool yields a nil Recorder,
// so a deployment that has not wired the database yet degrades to "records
// nothing" instead of panicking on the first request.
//
// every <= 0 falls back to DefaultFlushInterval.
func NewRecorder(pool *pgxpool.Pool, log *slog.Logger, every time.Duration) *Recorder {
	if pool == nil {
		return nil
	}
	return newRecorder(pool, log, every)
}

func newRecorder(pool execer, log *slog.Logger, every time.Duration) *Recorder {
	if log == nil {
		log = slog.Default()
	}
	if every <= 0 {
		every = DefaultFlushInterval
	}
	return &Recorder{
		pool:  pool,
		log:   log,
		every: every,
		buf:   make(map[bufferKey]*bufferEntry),
		surf:  make(map[surfaceKey]int64),
		stop:  make(chan struct{}),
		done:  make(chan struct{}),
	}
}

// Start launches the flush loop.  Call once; calling twice starts two loops,
// which is harmless but pointless.
func (r *Recorder) Start() {
	if r == nil {
		return
	}
	go r.loop()
}

// Close stops the flush loop and drains whatever is still buffered.
//
// Synchronous by design: it blocks until the final flush has been attempted,
// so a shutdown path that calls it loses nothing.  Safe to call more than once
// and safe on a nil receiver.
func (r *Recorder) Close() {
	if r == nil {
		return
	}
	r.stopOnce.Do(func() { close(r.stop) })
	<-r.done
}

// Touch records one authenticated API request for userID at t.
func (r *Recorder) Touch(userID uuid.UUID, t time.Time) {
	r.add(userID, t, func(e *bufferEntry) { e.Requests++ })
}

// PageView records one client-reported page arrival.
func (r *Recorder) PageView(userID uuid.UUID, t time.Time) {
	r.add(userID, t, func(e *bufferEntry) { e.PageViews++ })
}

// Playback records one client-reported video start.
func (r *Recorder) Playback(userID uuid.UUID, t time.Time) {
	r.add(userID, t, func(e *bufferEntry) { e.Playbacks++ })
}

// Login records one successful password authentication.
//
// Kept separate from Touch rather than folded into it even though a login is
// also a request: the login endpoint is not behind the recorder middleware
// (nobody is authenticated yet when it runs), so without this the one event
// that unambiguously means "a human deliberately came back" would be the one
// event this package could not see.
func (r *Recorder) Login(userID uuid.UUID, t time.Time) {
	r.add(userID, t, func(e *bufferEntry) { e.Logins++ })
}

// Surface records one visit to a coarse area of the site, anonymous callers
// included.  surface must already have been through NormalizeSurface.
//
// This is the counter that would be a contention point if it were written
// through: twenty rows carry the whole site's page-view volume, so every
// logged-out anime page view targets one row.  Buffered, the row is touched
// once per flush regardless of how much traffic arrives, and the endpoint that
// feeds it does no database work in the request path at all.
func (r *Recorder) Surface(surface Surface, authenticated bool, t time.Time) {
	if r == nil {
		return
	}
	key := surfaceKey{Day: Day(t), Surface: surface, Authenticated: authenticated}
	r.mu.Lock()
	r.surf[key]++
	r.mu.Unlock()
}

// add is the single mutation path.  It holds the lock for the duration of a
// map lookup and a couple of comparisons -- deliberately no I/O, no allocation
// beyond the first entry for a key, and no call back into user code.
func (r *Recorder) add(userID uuid.UUID, t time.Time, apply func(*bufferEntry)) {
	if r == nil || userID == uuid.Nil {
		return
	}
	key := bufferKey{UserID: userID, Day: Day(t)}

	r.mu.Lock()
	entry, ok := r.buf[key]
	if !ok {
		// The cap is checked only on the path that GROWS the map.  An existing
		// key must always be allowed through, or a sustained outage would stop
		// counting the very users who are still using the site while
		// continuing to count nobody else.
		if len(r.buf) >= maxBufferedUsers {
			r.mu.Unlock()
			// Deliberately not logged per drop: the condition that produces
			// one produces thousands, and a per-event log turns a database
			// outage into a disk-space incident.  The flush failure that
			// caused it is logged, once per interval, with its error.
			return
		}
		entry = &bufferEntry{FirstSeen: t, LastSeen: t}
		r.buf[key] = entry
	}
	if t.Before(entry.FirstSeen) {
		entry.FirstSeen = t
	}
	if t.After(entry.LastSeen) {
		entry.LastSeen = t
	}
	apply(entry)
	overflow := len(r.buf) >= maxBufferedUsers
	r.mu.Unlock()

	if overflow {
		// Flush off the request goroutine.  Doing it inline would make one
		// unlucky reader wait on a database round-trip for a counter they will
		// never see.
		go r.Flush(context.Background())
	}
}

// loop is the ticker.  It exits on Close after one final drain.
func (r *Recorder) loop() {
	defer close(r.done)
	ticker := time.NewTicker(r.every)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			r.Flush(context.Background())
		case <-r.stop:
			// The final drain gets its own context rather than inheriting a
			// cancelled one: at this point the caller is shutting down, and a
			// context that is already dead would turn "drain on exit" into
			// "discard on exit" without saying so.
			r.Flush(context.Background())
			return
		}
	}
}

// Flush writes everything buffered and empties the buffer.  Exported so tests
// can drive it deterministically instead of waiting on a ticker.
//
// The buffer is swapped out under the lock and written outside it, so requests
// arriving mid-flush accumulate into the fresh map rather than blocking on a
// database round-trip.
//
// On failure the batch is DROPPED, not retried, and the error is logged.  That
// is the deliberate choice: re-queueing would either double-count on a partial
// success (the statement is one transaction, but a timeout cannot tell a
// caller which side of the commit it landed on) or grow without bound during a
// sustained outage.  Losing a minute of activity counters is a smaller harm
// than either, and the log line is the signal that it happened.
func (r *Recorder) Flush(ctx context.Context) {
	if r == nil {
		return
	}
	r.mu.Lock()
	batch, surfaces := r.buf, r.surf
	if len(batch) > 0 {
		r.buf = make(map[bufferKey]*bufferEntry)
	}
	if len(surfaces) > 0 {
		r.surf = make(map[surfaceKey]int64)
	}
	r.mu.Unlock()

	// Two independent statements rather than one transaction.  They write
	// unrelated tables and neither is meaningful without the other being
	// exactly right, so pairing them would only mean a failure in the
	// low-trust aggregate could roll back the high-trust per-user counters.
	r.flushUsers(ctx, batch)
	r.flushSurfaces(ctx, surfaces)
}

func (r *Recorder) flushUsers(ctx context.Context, batch map[bufferKey]*bufferEntry) {
	n := len(batch)
	if n == 0 {
		return
	}
	userIDs := make([]uuid.UUID, 0, n)
	firstSeen := make([]time.Time, 0, n)
	lastSeen := make([]time.Time, 0, n)
	requests := make([]int64, 0, n)
	pageViews := make([]int64, 0, n)
	playbacks := make([]int64, 0, n)
	logins := make([]int64, 0, n)

	for key, entry := range batch {
		userIDs = append(userIDs, key.UserID)
		firstSeen = append(firstSeen, entry.FirstSeen)
		lastSeen = append(lastSeen, entry.LastSeen)
		requests = append(requests, entry.Requests)
		pageViews = append(pageViews, entry.PageViews)
		playbacks = append(playbacks, entry.Playbacks)
		logins = append(logins, entry.Logins)
	}

	execCtx, cancel := context.WithTimeout(ctx, flushTimeout)
	defer cancel()
	if _, err := r.pool.Exec(execCtx, recordUserActivitySQL,
		userIDs, firstSeen, lastSeen, requests, pageViews, playbacks, logins,
	); err != nil {
		if errors.Is(err, context.Canceled) {
			// A cancelled parent means the process is going away mid-flush.
			// Same data loss, but not a fault worth an ERROR line during a
			// deliberate shutdown.
			r.log.Warn("activity: user flush cancelled during shutdown", "rows", n)
			return
		}
		r.log.Error("activity: user flush failed; this interval's counters are lost",
			"err", err.Error(), "rows", n)
	}
}

// flushSurfaces writes the aggregate half.  Same drop-on-failure policy as
// flushUsers, and a weaker claim on the data: this table is fed by a public
// endpoint and nothing on the dashboard that matters reads it.
func (r *Recorder) flushSurfaces(ctx context.Context, batch map[surfaceKey]int64) {
	n := len(batch)
	if n == 0 {
		return
	}

	bucketAts := make([]time.Time, 0, n)
	surfaces := make([]string, 0, n)
	authed := make([]bool, 0, n)
	counts := make([]int64, 0, n)
	for key, count := range batch {
		bucketAts = append(bucketAts, key.Day)
		surfaces = append(surfaces, key.Surface)
		authed = append(authed, key.Authenticated)
		counts = append(counts, count)
	}

	execCtx, cancel := context.WithTimeout(ctx, flushTimeout)
	defer cancel()
	if _, err := r.pool.Exec(execCtx, recordSurfaceSQL, bucketAts, surfaces, authed, counts); err != nil {
		if errors.Is(err, context.Canceled) {
			r.log.Warn("activity: surface flush cancelled during shutdown", "rows", n)
			return
		}
		r.log.Error("activity: surface flush failed; this interval's counters are lost",
			"err", err.Error(), "rows", n)
	}
}
