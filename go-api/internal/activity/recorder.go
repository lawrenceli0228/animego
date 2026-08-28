package activity

// recorder.go -- the buffer between "a request happened" and "a row moved".
//
// NOTHING IN THIS FEATURE TOUCHES THE DATABASE ON A REQUEST PATH.  The two
// entry points -- the middleware and the login hook -- end in a map write
// under a mutex and return.  Postgres is written once per flush interval,
// from a background goroutine, in one statement.  That is the whole design
// constraint and the rest of this comment is why it had to be.
//
// The naive version writes one UPSERT per authenticated request.  At this
// site's scale that is not a throughput problem -- it is a churn problem.
// Every UPSERT against user_activity_daily targets the SAME row for the same
// person for the whole day, so a reader who spends an evening on the site
// rewrites one row hundreds of times, each rewrite leaving a dead tuple behind
// for autovacuum.  A row written eight hundred times a day and read twice is a
// table that bloats for no reader's benefit.
//
// So hits accumulate in memory keyed by (user, day) and are flushed on a
// ticker as one statement covering every user seen in the interval.  The
// counters are identical either way, because a flush adds a delta rather than
// overwriting a total.
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
// Close drains synchronously, and main.go calls it on BOTH shutdown paths
// (not via defer) inside a stop_grace_period wide enough to finish -- see the
// note on drainTimeout.

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

	// flushTimeout bounds one flush statement on the normal ticker path.
	// Matches the 5s query budget used across internal/admin and internal/auth.
	flushTimeout = 5 * time.Second

	// drainTimeout bounds the FINAL flush, and it is deliberately shorter.
	//
	// Docker's default stop grace is 10s and docker-compose.yml now gives
	// go-api 30s, but the drain runs after srv.Shutdown has already spent part
	// of that window waiting for in-flight requests.  A drain that could take
	// the full 5s stacks on top of a shutdown that may take 15s, and the sum
	// has to stay under the grace period or the kernel SIGKILLs the process
	// mid-flush -- which loses the exact minute Close exists to save.  3s is
	// more than enough for a single-statement upsert of a few hundred rows.
	drainTimeout = 3 * time.Second
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
// FOUR BEHAVIOURS WORTH NAMING:
//
//   - `WHERE EXISTS (SELECT 1 FROM users …)` is not belt-and-braces, it is
//     load-bearing.  user_id carries a foreign key to users, and an access
//     token stays valid for fifteen minutes after an admin deletes the account
//     it belongs to.  Every request that token makes enqueues a uuid with no
//     row behind it.  Without this guard the whole flush -- one statement,
//     every user in the interval -- fails on 23503 and gets dropped, so ONE
//     deleted account silently zeroes EVERYBODY's counters, once a minute,
//     until the token expires.  The only trace is a foreign-key line in the
//     log and a dent in the DAU chart nobody can explain.  Skipping the row
//     costs one primary-key probe per user per flush and makes the failure
//     structurally impossible rather than merely handled.
//
//   - counters ADD.  A flush is an increment, not a snapshot, so the second
//     flush of a day accumulates onto the first instead of replacing it.
//
//   - the window WIDENS via LEAST/GREATEST, so a late flush (a retry, or the
//     shutdown drain landing after a newer tick) cannot drag last_seen_at
//     backwards.  This is also what makes migration 0025's
//     last_seen_at >= first_seen_at CHECK true by construction.
//
//   - activity_date is CAST FROM first_seen_at rather than sent by Go.  The
//     buffer already keys on the same +08 day, so first and last agree; doing
//     the cast in SQL keeps the database the single authority on what date a
//     row carries instead of trusting two implementations to agree forever.
const recordUserActivitySQL = `
INSERT INTO user_activity_daily AS uad (
    user_id, activity_date, first_seen_at, last_seen_at,
    request_count, login_count
)
SELECT
    batch.user_id,
    (batch.first_seen_at AT TIME ZONE 'Asia/Shanghai')::date,
    batch.first_seen_at,
    batch.last_seen_at,
    batch.request_count,
    batch.login_count
FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[],
            $4::bigint[], $5::bigint[])
     AS batch (user_id, first_seen_at, last_seen_at,
               request_count, login_count)
WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = batch.user_id)
ON CONFLICT (activity_date, user_id) DO UPDATE
SET first_seen_at = LEAST(uad.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at  = GREATEST(uad.last_seen_at, EXCLUDED.last_seen_at),
    request_count = uad.request_count + EXCLUDED.request_count,
    login_count   = uad.login_count   + EXCLUDED.login_count`

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
	Logins    int64
}

// Recorder accumulates presence in memory and flushes it in batches.
//
// The zero value is not usable; construct with NewRecorder and call Start
// once.  Every method is safe for concurrent use -- they are called from HTTP
// handler goroutines.
//
// A nil *Recorder is a valid no-op receiver on every method.  That is not
// defensive habit, it is what lets the middleware and the login hook be wired
// unconditionally in main.go and still behave in tests and tooling that never
// construct one.  The alternative -- a nil check at every call site -- is
// several places to forget instead of one.
type Recorder struct {
	pool  execer
	log   *slog.Logger
	every time.Duration

	mu  sync.Mutex
	buf map[bufferKey]*bufferEntry

	// kick asks the flush loop to run early because the buffer hit its cap.
	//
	// Buffered with capacity 1 and sent to non-blockingly, which gives
	// single-flight for free: while one early flush is pending, every further
	// overflow send finds the channel full and drops.  The previous shape --
	// `go r.Flush(...)` straight from the request path -- had no such guard,
	// so during a database outage every request past the cap span
	// a fresh goroutine, each holding a pool connection and competing to
	// UPSERT overlapping row sets in map-iteration (i.e. arbitrary) order.
	// That is a goroutine storm and a deadlock risk, arriving precisely when
	// the database is already unwell.
	kick chan struct{}

	// stop closes on Close; done closes when the flush loop has drained and
	// exited.  Two channels rather than a sync.WaitGroup because Close needs
	// to WAIT for the final drain, and a caller that returns before the drain
	// completes is a caller that loses the data Close exists to save.
	stop      chan struct{}
	done      chan struct{}
	startOnce sync.Once
	stopOnce  sync.Once
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
		kick:  make(chan struct{}, 1),
		stop:  make(chan struct{}),
		done:  make(chan struct{}),
	}
}

// Start launches the flush loop.
//
// Guarded by sync.Once because a second loop would close the same `done`
// channel and panic -- and it would panic at shutdown, in production, far from
// the line that called Start twice.  A misuse that only shows up under SIGTERM
// is the worst kind to leave to a doc comment.
func (r *Recorder) Start() {
	if r == nil {
		return
	}
	r.startOnce.Do(func() { go r.loop() })
}

// Close stops the flush loop and drains whatever is still buffered.
//
// Synchronous by design: it blocks until the final flush has been attempted,
// so a shutdown path that calls it loses nothing.  Safe to call more than once
// and safe on a nil receiver.
//
// Call it explicitly on every exit path rather than with defer -- an os.Exit
// anywhere in the shutdown sequence skips deferred calls, and this one is the
// difference between draining and discarding.  See main.go.
func (r *Recorder) Close() {
	if r == nil {
		return
	}
	// A Recorder that was never started has no loop to close `done`, so
	// waiting on it would block forever.  Starting it here is the cheapest
	// correct answer: the loop runs once, sees `stop` already closed, drains,
	// and exits.
	r.Start()
	r.stopOnce.Do(func() { close(r.stop) })
	<-r.done
}

// Touch records one authenticated API request for userID at t.
func (r *Recorder) Touch(userID uuid.UUID, t time.Time) {
	r.add(userID, t, func(e *bufferEntry) { e.Requests++ })
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
			//
			// Kick on the way out.  An earlier version signalled only from the
			// add that CROSSED the cap, which meant that once the buffer was
			// genuinely full -- the state where data is actively being thrown
			// away -- nothing asked for an early flush again until the next
			// tick.  If the loop was mid-flush when that one kick arrived, it
			// was consumed for a flush that had already started, and the next
			// sixty seconds of hits were dropped in silence.
			r.requestFlush()
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
		r.requestFlush()
	}
}

// requestFlush asks the loop to flush early, at most once per pending flush.
//
// Non-blocking send into a capacity-1 channel: while one early flush is
// pending, every further call finds the channel full and returns immediately.
// Never spawn a goroutine from a request path to do this -- see the note on
// the kick field for what that cost during an outage.
func (r *Recorder) requestFlush() {
	select {
	case r.kick <- struct{}{}:
	default:
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
			r.flush(context.Background(), flushTimeout)
		case <-r.kick:
			r.flush(context.Background(), flushTimeout)
		case <-r.stop:
			// The final drain gets its own context rather than inheriting a
			// cancelled one: at this point the caller is shutting down, and a
			// context that is already dead would turn "drain on exit" into
			// "discard on exit" without saying so.  Its budget is shorter than
			// the ticker path's -- see drainTimeout.
			r.flush(context.Background(), drainTimeout)
			return
		}
	}
}

// Flush writes everything buffered and empties the buffer.  Exported so tests
// can drive it deterministically instead of waiting on a ticker.
func (r *Recorder) Flush(ctx context.Context) {
	r.flush(ctx, flushTimeout)
}

// flush is Flush with an explicit budget, so the shutdown drain can be given a
// tighter one than the ticker.
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
//
// Note this is now genuinely "a minute of counters" and not "everyone's
// counters because of one bad row" -- see the WHERE EXISTS guard in the
// statement above.
func (r *Recorder) flush(ctx context.Context, budget time.Duration) {
	if r == nil {
		return
	}
	r.mu.Lock()
	if len(r.buf) == 0 {
		r.mu.Unlock()
		return
	}
	batch := r.buf
	r.buf = make(map[bufferKey]*bufferEntry)
	r.mu.Unlock()

	n := len(batch)
	userIDs := make([]uuid.UUID, 0, n)
	firstSeen := make([]time.Time, 0, n)
	lastSeen := make([]time.Time, 0, n)
	requests := make([]int64, 0, n)
	logins := make([]int64, 0, n)

	for key, entry := range batch {
		userIDs = append(userIDs, key.UserID)
		firstSeen = append(firstSeen, entry.FirstSeen)
		lastSeen = append(lastSeen, entry.LastSeen)
		requests = append(requests, entry.Requests)
		logins = append(logins, entry.Logins)
	}

	execCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	if _, err := r.pool.Exec(execCtx, recordUserActivitySQL,
		userIDs, firstSeen, lastSeen, requests, logins,
	); err != nil {
		if errors.Is(err, context.Canceled) {
			// A cancelled parent means the process is going away mid-flush.
			// Same data loss, but not a fault worth an ERROR line during a
			// deliberate shutdown.
			r.log.Warn("activity: flush cancelled during shutdown", "rows", n)
			return
		}
		r.log.Error("activity: flush failed; this interval's counters are lost",
			"err", err.Error(), "rows", n)
	}
}
