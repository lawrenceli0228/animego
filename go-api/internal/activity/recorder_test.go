package activity

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeExecer captures flush calls instead of running SQL.  The recorder never
// reads the CommandTag, so returning the zero value is faithful.
type fakeExecer struct {
	mu           sync.Mutex
	calls        []fakeCall
	surfaceCalls []surfaceCall
	err          error
}

type fakeCall struct {
	UserIDs   []uuid.UUID
	FirstSeen []time.Time
	LastSeen  []time.Time
	Requests  []int64
	PageViews []int64
	Playbacks []int64
	Logins    []int64
}

// surfaceCall is the aggregate half of a flush.
type surfaceCall struct {
	BucketAts []time.Time
	Surfaces  []string
	Authed    []bool
	Counts    []int64
}

// Exec sorts the two statements apart by their first argument's type, which is
// the only thing that distinguishes them without matching on SQL text.
func (f *fakeExecer) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return pgconn.CommandTag{}, f.err
	}
	if ids, ok := args[0].([]uuid.UUID); ok {
		f.calls = append(f.calls, fakeCall{
			UserIDs:   ids,
			FirstSeen: args[1].([]time.Time),
			LastSeen:  args[2].([]time.Time),
			Requests:  args[3].([]int64),
			PageViews: args[4].([]int64),
			Playbacks: args[5].([]int64),
			Logins:    args[6].([]int64),
		})
		return pgconn.CommandTag{}, nil
	}
	f.surfaceCalls = append(f.surfaceCalls, surfaceCall{
		BucketAts: args[0].([]time.Time),
		Surfaces:  args[1].([]string),
		Authed:    args[2].([]bool),
		Counts:    args[3].([]int64),
	})
	return pgconn.CommandTag{}, nil
}

func (f *fakeExecer) snapshot() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]fakeCall, len(f.calls))
	copy(out, f.calls)
	return out
}

func (f *fakeExecer) surfaceSnapshot() []surfaceCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]surfaceCall, len(f.surfaceCalls))
	copy(out, f.surfaceCalls)
	return out
}

func quietRecorder(t *testing.T, exec execer) *Recorder {
	t.Helper()
	// Discard the logger: the failure test deliberately provokes an ERROR line
	// and a test run should not print it.
	return newRecorder(exec, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Hour)
}

// TestRecorder_CoalescesManyHitsIntoOneRow is the reason the buffer exists.
// Without it, one reader's evening is hundreds of UPSERTs against a single row
// — a table that bloats for no reader's benefit.
func TestRecorder_CoalescesManyHitsIntoOneRow(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	user := uuid.New()
	base := time.Date(2026, 8, 27, 10, 0, 0, 0, reportingZone)
	for i := range 250 {
		rec.Touch(user, base.Add(time.Duration(i)*time.Second))
	}
	rec.Flush(context.Background())

	calls := exec.snapshot()
	if len(calls) != 1 {
		t.Fatalf("expected exactly one flush statement, got %d", len(calls))
	}
	got := calls[0]
	if len(got.UserIDs) != 1 {
		t.Fatalf("expected one row for one user, got %d", len(got.UserIDs))
	}
	if got.Requests[0] != 250 {
		t.Fatalf("requests = %d, want 250 — the flush must send the accumulated delta, not 1", got.Requests[0])
	}
	if !got.FirstSeen[0].Equal(base) {
		t.Fatalf("firstSeen = %v, want the earliest hit %v", got.FirstSeen[0], base)
	}
	if !got.LastSeen[0].Equal(base.Add(249 * time.Second)) {
		t.Fatalf("lastSeen = %v, want the latest hit", got.LastSeen[0])
	}
}

// TestRecorder_OutOfOrderHitsWidenTheWindow covers the case where a later call
// carries an earlier timestamp (concurrent handlers stamping time.Now() and
// racing to the lock).  The window must widen in both directions, or migration
// 0025's last_seen_at >= first_seen_at CHECK becomes a hope rather than an
// invariant.
func TestRecorder_OutOfOrderHitsWidenTheWindow(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	user := uuid.New()
	noon := time.Date(2026, 8, 27, 12, 0, 0, 0, reportingZone)
	rec.Touch(user, noon)
	rec.Touch(user, noon.Add(-30*time.Minute)) // arrives second, happened first
	rec.Touch(user, noon.Add(30*time.Minute))
	rec.Flush(context.Background())

	got := exec.snapshot()[0]
	if !got.FirstSeen[0].Equal(noon.Add(-30 * time.Minute)) {
		t.Fatalf("firstSeen = %v, want the earliest of the three", got.FirstSeen[0])
	}
	if !got.LastSeen[0].Equal(noon.Add(30 * time.Minute)) {
		t.Fatalf("lastSeen = %v, want the latest of the three", got.LastSeen[0])
	}
	if got.LastSeen[0].Before(got.FirstSeen[0]) {
		t.Fatal("last_seen_at < first_seen_at would violate the table's CHECK constraint")
	}
}

// TestRecorder_SplitsAcrossMidnight is the reason bufferKey carries the day.
//
// Keyed on user alone, a buffer filled at 23:59 and flushed at 00:01 posts an
// hour of yesterday's requests onto today's row AND stamps a first_seen_at
// from before the day began — a wrong row that no database constraint would
// reject, because both timestamps sit on the same wrong side.
func TestRecorder_SplitsAcrossMidnight(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	user := uuid.New()
	lastMinute := time.Date(2026, 8, 27, 23, 59, 0, 0, reportingZone)
	firstMinute := time.Date(2026, 8, 28, 0, 1, 0, 0, reportingZone)
	rec.Touch(user, lastMinute)
	rec.Touch(user, lastMinute.Add(10*time.Second))
	rec.Touch(user, firstMinute)
	rec.Flush(context.Background())

	got := exec.snapshot()[0]
	if len(got.UserIDs) != 2 {
		t.Fatalf("expected two rows (one per local day) for one user, got %d", len(got.UserIDs))
	}
	// Map order is unspecified, so identify the rows by their day rather than
	// by position.
	perDay := map[string]int64{}
	for i := range got.UserIDs {
		perDay[Day(got.FirstSeen[i]).Format("2006-01-02")] = got.Requests[i]
	}
	if perDay["2026-08-27"] != 2 {
		t.Fatalf("2026-08-27 requests = %d, want 2", perDay["2026-08-27"])
	}
	if perDay["2026-08-28"] != 1 {
		t.Fatalf("2026-08-28 requests = %d, want 1", perDay["2026-08-28"])
	}
}

// TestRecorder_CountersAreIndependent guards against a copy-paste in add's
// four closures — the kind of bug that puts logins in the page-view column and
// is invisible until somebody compares two dashboards.
func TestRecorder_CountersAreIndependent(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	user := uuid.New()
	at := time.Date(2026, 8, 27, 9, 0, 0, 0, reportingZone)
	rec.Touch(user, at)
	rec.PageView(user, at)
	rec.PageView(user, at)
	rec.Playback(user, at)
	rec.Playback(user, at)
	rec.Playback(user, at)
	rec.Login(user, at)
	rec.Flush(context.Background())

	got := exec.snapshot()[0]
	if got.Requests[0] != 1 || got.PageViews[0] != 2 || got.Playbacks[0] != 3 || got.Logins[0] != 1 {
		t.Fatalf("counters crossed: requests=%d pageViews=%d playbacks=%d logins=%d; want 1/2/3/1",
			got.Requests[0], got.PageViews[0], got.Playbacks[0], got.Logins[0])
	}
}

// TestRecorder_FlushEmptiesTheBuffer proves a flush is an increment and not a
// running total: the second flush must send nothing rather than re-sending the
// first flush's counts, which the ADD-on-conflict clause would double.
func TestRecorder_FlushEmptiesTheBuffer(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	user := uuid.New()
	at := time.Date(2026, 8, 27, 9, 0, 0, 0, reportingZone)
	rec.Touch(user, at)
	rec.Flush(context.Background())
	rec.Flush(context.Background())

	if calls := exec.snapshot(); len(calls) != 1 {
		t.Fatalf("second flush of an empty buffer must not issue a statement; got %d calls", len(calls))
	}
}

// TestRecorder_FlushFailureDropsTheBatch documents the deliberate loss.
// Re-queueing would either double-count on a partial success or grow without
// bound during an outage; losing an interval of counters is the smaller harm.
func TestRecorder_FlushFailureDropsTheBatch(t *testing.T) {
	exec := &fakeExecer{err: errors.New("simulated database outage")}
	rec := quietRecorder(t, exec)

	user := uuid.New()
	at := time.Date(2026, 8, 27, 9, 0, 0, 0, reportingZone)
	rec.Touch(user, at)
	rec.Flush(context.Background())

	// Recovery: the next flush must carry only what arrived AFTER the failure.
	exec.mu.Lock()
	exec.err = nil
	exec.mu.Unlock()
	rec.Touch(user, at.Add(time.Minute))
	rec.Flush(context.Background())

	calls := exec.snapshot()
	if len(calls) != 1 {
		t.Fatalf("expected one successful flush after recovery, got %d", len(calls))
	}
	if calls[0].Requests[0] != 1 {
		t.Fatalf("requests = %d, want 1 — the failed batch must not be replayed", calls[0].Requests[0])
	}
}

// TestRecorder_CloseDrains covers the orderly-shutdown promise.  Close is
// synchronous precisely so a caller that returns after it has not lost the
// final interval.
func TestRecorder_CloseDrains(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)
	rec.Start()

	rec.Touch(uuid.New(), time.Now())
	rec.Close()

	if calls := exec.snapshot(); len(calls) != 1 {
		t.Fatalf("Close must drain the buffer; got %d flushes", len(calls))
	}
	// Idempotent — a second Close from a duplicated shutdown path must not
	// panic on a closed channel.
	rec.Close()
}

// TestRecorder_SurfaceCountsCollapseToOneRowPerBucket is the contention fix.
//
// activity_surface_daily holds twenty rows for a whole day, so a per-beacon
// write would put the site's entire logged-out page-view volume behind one row
// lock.  Ten thousand anonymous anime views must arrive as ONE row carrying
// 10000, not as ten thousand statements.
func TestRecorder_SurfaceCountsCollapseToOneRowPerBucket(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	at := time.Date(2026, 8, 27, 14, 0, 0, 0, reportingZone)
	for range 10_000 {
		rec.Surface(SurfaceAnime, false, at)
	}
	rec.Surface(SurfaceAnime, true, at)
	rec.Surface(SurfaceHome, false, at)
	rec.Flush(context.Background())

	calls := exec.surfaceSnapshot()
	if len(calls) != 1 {
		t.Fatalf("expected one aggregate statement, got %d", len(calls))
	}
	got := calls[0]
	if len(got.Surfaces) != 3 {
		t.Fatalf("expected three buckets (anime/anon, anime/authed, home/anon), got %d", len(got.Surfaces))
	}
	for i := range got.Surfaces {
		if got.Surfaces[i] == SurfaceAnime && !got.Authed[i] {
			if got.Counts[i] != 10_000 {
				t.Fatalf("anonymous anime count = %d, want 10000", got.Counts[i])
			}
			return
		}
	}
	t.Fatal("the anonymous anime bucket is missing from the flush")
}

// TestRecorder_SurfaceBucketsSplitAcrossMidnight: the aggregate buffer carries
// the day in its key for the same reason the user buffer does.  Deriving the
// date from now() at flush time would file a 23:59 visit under the following
// day whenever a flush crossed midnight.
func TestRecorder_SurfaceBucketsSplitAcrossMidnight(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	rec.Surface(SurfaceHome, false, time.Date(2026, 8, 27, 23, 59, 0, 0, reportingZone))
	rec.Surface(SurfaceHome, false, time.Date(2026, 8, 28, 0, 1, 0, 0, reportingZone))
	rec.Flush(context.Background())

	got := exec.surfaceSnapshot()[0]
	if len(got.BucketAts) != 2 {
		t.Fatalf("expected two day buckets for one surface, got %d", len(got.BucketAts))
	}
	seen := map[string]bool{}
	for _, at := range got.BucketAts {
		seen[at.Format("2006-01-02")] = true
	}
	if !seen["2026-08-27"] || !seen["2026-08-28"] {
		t.Fatalf("buckets landed on the wrong days: %v", seen)
	}
}

// TestRecorder_FlushIsIndependentPerTable: the two statements are not in one
// transaction, so an empty user buffer must not suppress the aggregate write
// (and vice versa).  Fusing them would mean a quiet hour with only anonymous
// traffic recorded nothing at all.
func TestRecorder_FlushIsIndependentPerTable(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	rec.Surface(SurfaceSearch, false, time.Now())
	rec.Flush(context.Background())

	if n := len(exec.snapshot()); n != 0 {
		t.Fatalf("no users were touched; expected no user statement, got %d", n)
	}
	if n := len(exec.surfaceSnapshot()); n != 1 {
		t.Fatalf("expected the aggregate statement to run on its own, got %d", n)
	}
}

// TestRecorder_NilReceiverIsSafe is what lets main.go wire the middleware, the
// beacon handler and the login hook unconditionally.  Without it, each of
// those four call sites needs its own nil check, which is four places to
// forget instead of one.
func TestRecorder_NilReceiverIsSafe(t *testing.T) {
	var rec *Recorder
	rec.Start()
	rec.Touch(uuid.New(), time.Now())
	rec.PageView(uuid.New(), time.Now())
	rec.Playback(uuid.New(), time.Now())
	rec.Login(uuid.New(), time.Now())
	rec.Surface(SurfaceHome, false, time.Now())
	rec.Flush(context.Background())
	rec.Close()
}

// TestRecorder_IgnoresNilUUID: a zero uuid means "no user", and writing one
// would violate the foreign key on user_activity_daily.user_id — turning every
// subsequent flush in the same batch into a lost statement.
func TestRecorder_IgnoresNilUUID(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	rec.Touch(uuid.Nil, time.Now())
	rec.Flush(context.Background())

	if calls := exec.snapshot(); len(calls) != 0 {
		t.Fatalf("a nil uuid must not reach the database; got %d flushes", len(calls))
	}
}

// TestRecorder_ConcurrentTouchesAreCounted runs the mutation path the way
// production does — from many goroutines at once — so `go test -race` has
// something to find if the locking is ever loosened.
func TestRecorder_ConcurrentTouchesAreCounted(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	const goroutines, each = 16, 50
	user := uuid.New()
	at := time.Date(2026, 8, 27, 9, 0, 0, 0, reportingZone)

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for range goroutines {
		go func() {
			defer wg.Done()
			for range each {
				rec.Touch(user, at)
			}
		}()
	}
	wg.Wait()
	rec.Flush(context.Background())

	got := exec.snapshot()[0]
	if want := int64(goroutines * each); got.Requests[0] != want {
		t.Fatalf("requests = %d, want %d — a lost update means the lock is not covering the increment", got.Requests[0], want)
	}
}
