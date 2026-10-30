package activity

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeExecer captures flush calls instead of running SQL.  The recorder never
// reads the CommandTag, so returning the zero value is faithful.
type fakeExecer struct {
	mu    sync.Mutex
	calls []fakeCall
	err   error
}

type fakeCall struct {
	UserIDs   []uuid.UUID
	FirstSeen []time.Time
	LastSeen  []time.Time
	Requests  []int64
	Logins    []int64
}

func (f *fakeExecer) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return pgconn.CommandTag{}, f.err
	}
	f.calls = append(f.calls, fakeCall{
		UserIDs:   args[0].([]uuid.UUID),
		FirstSeen: args[1].([]time.Time),
		LastSeen:  args[2].([]time.Time),
		Requests:  args[3].([]int64),
		Logins:    args[4].([]int64),
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
// closures — the kind of bug that files requests under logins and is invisible
// until somebody compares two numbers that should not match.
func TestRecorder_CountersAreIndependent(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)

	user := uuid.New()
	at := time.Date(2026, 8, 27, 9, 0, 0, 0, reportingZone)
	rec.Touch(user, at)
	rec.Touch(user, at)
	rec.Touch(user, at)
	rec.Login(user, at)
	rec.Flush(context.Background())

	got := exec.snapshot()[0]
	if got.Requests[0] != 3 || got.Logins[0] != 1 {
		t.Fatalf("counters crossed: requests=%d logins=%d; want 3/1", got.Requests[0], got.Logins[0])
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

// TestRecorder_NilReceiverIsSafe is what lets main.go wire the middleware and
// the login hook unconditionally.  Without it, each of those call sites needs
// its own nil check, which is several places to forget instead of one.
func TestRecorder_NilReceiverIsSafe(t *testing.T) {
	var rec *Recorder
	rec.Start()
	rec.Touch(uuid.New(), time.Now())
	rec.Login(uuid.New(), time.Now())
	rec.Flush(context.Background())
	rec.Close()
}

// TestRecorder_StartIsIdempotent.
//
// Each flush loop closes the same `done` channel on exit, so a second loop
// panics on the second close — and it panics at SHUTDOWN, in production, a
// long way from whatever line called Start twice.  The doc comment used to say
// calling it twice was "harmless but pointless"; it was neither.
func TestRecorder_StartIsIdempotent(t *testing.T) {
	rec := quietRecorder(t, &fakeExecer{})
	rec.Start()
	rec.Start()
	rec.Start()
	rec.Close() // would panic on a duplicated close(done)
}

// TestRecorder_CloseWithoutStartDoesNotHang.
//
// Close waits on `done`, which only the flush loop closes.  A Recorder that
// was constructed but never started has no loop, so a naive Close would block
// the whole shutdown sequence forever — a hang, not a crash, which is the
// harder one to diagnose from a container that will not stop.
func TestRecorder_CloseWithoutStartDoesNotHang(t *testing.T) {
	exec := &fakeExecer{}
	rec := quietRecorder(t, exec)
	rec.Touch(uuid.New(), time.Now())

	done := make(chan struct{})
	go func() {
		rec.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Close blocked on a Recorder that was never started")
	}

	if calls := exec.snapshot(); len(calls) != 1 {
		t.Fatalf("Close must still drain what was buffered; got %d flushes", len(calls))
	}
}

// TestRecorder_IgnoresNilUUID: a zero uuid means "no user".  The flush
// statement's WHERE EXISTS guard would skip it harmlessly, but keeping it out
// of the buffer entirely means it never occupies a slot against
// maxBufferedUsers either.
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

// TestRecorder_OverflowKicksTheLoopOnceNotPerRequest.
//
// The buffer cap is only ever reached during a sustained database outage --
// which is exactly when the previous shape was worst: it spawned a fresh
// `go r.Flush(...)` from the REQUEST path for every hit past the cap, each one
// taking a pool connection and racing the others to UPSERT overlapping row
// sets in map-iteration order.  A goroutine storm, arriving while the database
// is already unwell.
//
// The kick channel is buffered to 1 and sent to non-blockingly, so a thousand
// overflow hits produce at most one pending early flush and zero goroutines.
func TestRecorder_OverflowKicksTheLoopOnceNotPerRequest(t *testing.T) {
	rec := quietRecorder(t, &fakeExecer{})
	at := time.Date(2026, 8, 27, 9, 0, 0, 0, reportingZone)

	// Fill past the cap without a loop running, so nothing drains the kick.
	rec.mu.Lock()
	for range maxBufferedUsers {
		rec.buf[bufferKey{UserID: uuid.New(), Day: Day(at)}] = &bufferEntry{FirstSeen: at, LastSeen: at}
	}
	rec.mu.Unlock()

	for range 1000 {
		rec.Touch(uuid.New(), at)
	}

	if got := len(rec.kick); got != 1 {
		t.Fatalf("pending early flushes = %d, want exactly 1 — the kick must coalesce", got)
	}
	// And the cap really is a cap: none of those 1000 new users got in.
	rec.mu.Lock()
	size := len(rec.buf)
	rec.mu.Unlock()
	if size != maxBufferedUsers {
		t.Fatalf("buffer grew past the cap to %d", size)
	}
}

// scriptedExecer answers each Exec from a script -- the i-th call returns
// script[i], calls past the end succeed -- and records every attempt, failed
// ones included, so a test can tell a single call from a retry.
type scriptedExecer struct {
	mu       sync.Mutex
	script   []error
	sqls     []string
	attempts []fakeCall
}

func (s *scriptedExecer) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sqls = append(s.sqls, sql)
	s.attempts = append(s.attempts, fakeCall{
		UserIDs:   args[0].([]uuid.UUID),
		FirstSeen: args[1].([]time.Time),
		LastSeen:  args[2].([]time.Time),
		Requests:  args[3].([]int64),
		Logins:    args[4].([]int64),
	})
	if i := len(s.attempts) - 1; i < len(s.script) {
		return pgconn.CommandTag{}, s.script[i]
	}
	return pgconn.CommandTag{}, nil
}

func (s *scriptedExecer) snapshot() ([]string, []fakeCall) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.sqls...), append([]fakeCall(nil), s.attempts...)
}

// TestRecorder_FlushRetriesOnlyARaceWithAnotherTransaction.
//
// An account deleted while a flush is running makes the flush's foreign-key
// check fail with 23503 for the WHOLE batch, after the statement's WHERE
// EXISTS guard has already let the account through; a lock cycle with another
// transaction fails it with 40P01, again for the whole batch.  The recorder
// runs the statement once more in exactly those cases: a failed statement
// wrote nothing, so the retry cannot double-count, and its fresh snapshot
// skips the account that is gone.  Nothing else is retried, and neither is a
// failed retry.
func TestRecorder_FlushRetriesOnlyARaceWithAnotherTransaction(t *testing.T) {
	fkRace := func() error {
		return &pgconn.PgError{Code: "23503", Message: "violates foreign key constraint"}
	}
	deadlock := func() error {
		return &pgconn.PgError{Code: "40P01", Message: "deadlock detected"}
	}

	cases := []struct {
		name         string
		script       []error
		wantAttempts int
		wantLost     bool
	}{
		{"a foreign-key race is retried and the batch lands",
			[]error{fkRace()}, 2, false},
		{"a wrapped foreign-key race is recognised",
			[]error{fmt.Errorf("flush: %w", fkRace())}, 2, false},
		{"a failing retry is not retried again",
			[]error{fkRace(), errors.New("connection reset by peer")}, 2, true},
		{"a second foreign-key failure is not retried again",
			[]error{fkRace(), fkRace()}, 2, true},
		{"a deadlock victim is retried and the batch lands",
			[]error{deadlock()}, 2, false},
		{"a wrapped deadlock is recognised",
			[]error{fmt.Errorf("flush: %w", deadlock())}, 2, false},
		{"a deadlock on the retry is not retried again",
			[]error{fkRace(), deadlock()}, 2, true},
		{"another SQLSTATE is not retried",
			[]error{&pgconn.PgError{Code: "57014", Message: "canceling statement due to statement timeout"}}, 1, true},
		{"a non-database error is not retried",
			[]error{errors.New("connection reset by peer")}, 1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			exec := &scriptedExecer{script: tc.script}
			var logs bytes.Buffer
			rec := newRecorder(exec, slog.New(slog.NewTextHandler(&logs, nil)), time.Hour)

			alice, bob := uuid.New(), uuid.New()
			at := time.Date(2026, 8, 27, 9, 0, 0, 0, reportingZone)
			rec.Touch(alice, at)
			rec.Touch(alice, at.Add(time.Second))
			rec.Touch(bob, at)
			rec.Login(bob, at)
			rec.Flush(context.Background())

			sqls, attempts := exec.snapshot()
			if len(attempts) != tc.wantAttempts {
				t.Fatalf("attempts = %d, want %d", len(attempts), tc.wantAttempts)
			}
			for i, sql := range sqls {
				if sql != recordUserActivitySQL {
					t.Fatalf("attempt %d ran a different statement", i)
				}
			}
			if tc.wantAttempts == 2 {
				// The same batch, not a re-read of the buffer: identical rows
				// in identical order.
				if !reflect.DeepEqual(attempts[0], attempts[1]) {
					t.Fatalf("the retry must resend the same batch:\nfirst  %+v\nsecond %+v", attempts[0], attempts[1])
				}
				if !strings.Contains(logs.String(), "retrying once") {
					t.Fatalf("a retry should be visible in the log; got %q", logs.String())
				}
			}
			if lost := strings.Contains(logs.String(), "counters are lost"); lost != tc.wantLost {
				t.Fatalf("batch lost = %v, want %v; log %q", lost, tc.wantLost, logs.String())
			}

			// Retried or dropped, the batch has left the buffer: the next
			// flush must not send it again.
			rec.Flush(context.Background())
			if _, after := exec.snapshot(); len(after) != tc.wantAttempts {
				t.Fatalf("a later flush resent the batch: %d attempts, want %d", len(after), tc.wantAttempts)
			}
		})
	}
}

// TestRecorder_RetrySendsEveryBufferedRow pins what a successful retry
// delivers: the whole batch, counters intact.  (The real statement skips the
// deleted account by itself; this fake cannot, so every row comes back.)
func TestRecorder_RetrySendsEveryBufferedRow(t *testing.T) {
	exec := &scriptedExecer{script: []error{&pgconn.PgError{Code: "23503"}}}
	rec := quietRecorder(t, exec)

	alice, bob := uuid.New(), uuid.New()
	at := time.Date(2026, 8, 27, 9, 0, 0, 0, reportingZone)
	rec.Touch(alice, at)
	rec.Touch(alice, at)
	rec.Touch(bob, at)
	rec.Login(bob, at)
	rec.Flush(context.Background())

	_, attempts := exec.snapshot()
	if len(attempts) != 2 {
		t.Fatalf("attempts = %d, want 2", len(attempts))
	}
	retry := attempts[1]
	got := map[uuid.UUID][2]int64{}
	for i, id := range retry.UserIDs {
		got[id] = [2]int64{retry.Requests[i], retry.Logins[i]}
	}
	want := map[uuid.UUID][2]int64{alice: {2, 0}, bob: {1, 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("retried rows = %v, want %v", got, want)
	}
}

// gatedExecer holds every statement until release is closed, and records how
// many ran at once.
type gatedExecer struct {
	release chan struct{}
	entered chan struct{}

	mu          sync.Mutex
	inFlight    int
	maxInFlight int
	calls       []fakeCall
}

func (g *gatedExecer) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	g.mu.Lock()
	g.inFlight++
	if g.inFlight > g.maxInFlight {
		g.maxInFlight = g.inFlight
	}
	g.mu.Unlock()
	g.entered <- struct{}{}
	<-g.release

	g.mu.Lock()
	defer g.mu.Unlock()
	g.inFlight--
	g.calls = append(g.calls, fakeCall{
		UserIDs:   args[0].([]uuid.UUID),
		FirstSeen: args[1].([]time.Time),
		LastSeen:  args[2].([]time.Time),
		Requests:  args[3].([]int64),
		Logins:    args[4].([]int64),
	})
	return pgconn.CommandTag{}, nil
}

// TestRecorder_FlushWaitsForTheFlushAlreadyRunning pins flushMu.  A Flush
// called while another flush's statement is still running must not start a
// second statement next to it (two upserts over overlapping rows can deadlock
// each other), and must not return before what was buffered at the call has
// been written -- the account delete relies on that to get the account's last
// minute into the database before archiving it.
func TestRecorder_FlushWaitsForTheFlushAlreadyRunning(t *testing.T) {
	exec := &gatedExecer{release: make(chan struct{}), entered: make(chan struct{}, 2)}
	rec := quietRecorder(t, exec)

	alice, bob := uuid.New(), uuid.New()
	at := time.Date(2026, 8, 27, 9, 0, 0, 0, reportingZone)

	rec.Touch(alice, at)
	firstDone := make(chan struct{})
	go func() { rec.Flush(context.Background()); close(firstDone) }()
	<-exec.entered // the first statement is running with alice's batch

	rec.Touch(bob, at)
	secondDone := make(chan struct{})
	go func() { rec.Flush(context.Background()); close(secondDone) }()

	select {
	case <-exec.entered:
		t.Fatal("a second flush statement started while the first was still running")
	case <-secondDone:
		t.Fatal("Flush returned before the activity buffered at the call was written")
	case <-time.After(100 * time.Millisecond):
	}

	close(exec.release)
	<-firstDone
	<-secondDone

	exec.mu.Lock()
	defer exec.mu.Unlock()
	if exec.maxInFlight != 1 {
		t.Fatalf("statements in flight at once = %d, want 1", exec.maxInFlight)
	}
	if len(exec.calls) != 2 {
		t.Fatalf("statements = %d, want 2", len(exec.calls))
	}
	if got := exec.calls[0].UserIDs; len(got) != 1 || got[0] != alice {
		t.Fatalf("first statement wrote %v, want only alice", got)
	}
	if got := exec.calls[1].UserIDs; len(got) != 1 || got[0] != bob {
		t.Fatalf("second statement wrote %v, want only bob", got)
	}
}
