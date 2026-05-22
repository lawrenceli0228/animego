// warm_all_test.go — unit tests for EnqueueWarmAllSeasons.
//
// Tests use a fake Enqueuer that records calls so each test can drive
// the loop with a fixed clock (via nowFn) and assert exact (season,
// year) pair counts without standing up Postgres or river.

package queue

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// warmAllEnqueuer records each EnqueueWarmSeasonNow invocation so
// tests can assert the exact (season, year) sequence.  errOnCall lets
// a test fire an error on the Nth call (0-indexed) so the
// partial-success path is testable without a real river client.
//
// A blockCh, when non-nil, causes EnqueueWarmSeasonNow to wait until
// the test releases it — used by the TryLock concurrency test to hold
// the first call open while a second call races in.
type warmAllEnqueuer struct {
	mu        sync.Mutex
	calls     []WarmSeasonArgs
	errOnCall map[int]error
	blockCh   chan struct{}
	blocked   atomic.Bool
}

func (f *warmAllEnqueuer) EnqueueV1Many(_ context.Context, _ []int32) error { return nil }
func (f *warmAllEnqueuer) EnqueueV2Many(_ context.Context, _ []BangumiV2Args) error {
	return nil
}
func (f *warmAllEnqueuer) EnqueueV3Many(_ context.Context, _ []BangumiV3Args) error {
	return nil
}

func (f *warmAllEnqueuer) EnqueueWarmSeasonNow(ctx context.Context, args WarmSeasonArgs) error {
	f.mu.Lock()
	idx := len(f.calls)
	f.calls = append(f.calls, args)
	err, has := f.errOnCall[idx]
	bch := f.blockCh
	f.mu.Unlock()

	// Block the FIRST call only if blockCh is set; subsequent calls
	// pass through.  Signals "blocked" via the atomic so the test
	// can poll for the lock-held state.
	if bch != nil && idx == 0 {
		f.blocked.Store(true)
		select {
		case <-bch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if has {
		return err
	}
	return nil
}

func (f *warmAllEnqueuer) snapshot() []WarmSeasonArgs {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]WarmSeasonArgs, len(f.calls))
	copy(out, f.calls)
	return out
}

// stubNow returns a nowFn that always reports the given year (mid-year
// so CurrentSeason-style derivations are unambiguous).  Used by tests
// that need a deterministic endYear without test-clock flakiness.
func stubNow(year int) func() time.Time {
	t := time.Date(year, time.June, 15, 12, 0, 0, 0, time.UTC)
	return func() time.Time { return t }
}

// withFixedClock swaps the package-level nowFn for the duration of
// the test and restores it via t.Cleanup.  Returns the original so
// chained swaps still work (rare).
func withFixedClock(t *testing.T, fn func() time.Time) {
	t.Helper()
	original := nowFn
	nowFn = fn
	t.Cleanup(func() { nowFn = original })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestEnqueueWarmAllSeasons_TotalCount — startYear=2020 with clock
// fixed to 2026 produces 4 seasons * (2027 - 2020 + 1) = 32 jobs.
func TestEnqueueWarmAllSeasons_TotalCount(t *testing.T) {
	// Not parallel — mutates nowFn (process-global).
	withFixedClock(t, stubNow(2026))

	enq := &warmAllEnqueuer{}
	got, err := EnqueueWarmAllSeasons(context.Background(), enq, 2020)
	require.NoError(t, err)

	// endYear = nowFn().Year() + 1 = 2027; range [2020,2027] = 8 years.
	wantYears := 2027 - 2020 + 1
	wantTotal := 4 * wantYears
	assert.Equal(t, wantTotal, got, "enqueued count: 4 seasons * %d years", wantYears)
	assert.Len(t, enq.snapshot(), wantTotal, "fake enqueuer should record all jobs")
}

// TestEnqueueWarmAllSeasons_FirstAndLast — assert the first and last
// (season, year) pairs are exactly WINTER startYear and FALL endYear.
func TestEnqueueWarmAllSeasons_FirstAndLast(t *testing.T) {
	withFixedClock(t, stubNow(2026))

	enq := &warmAllEnqueuer{}
	_, err := EnqueueWarmAllSeasons(context.Background(), enq, 2020)
	require.NoError(t, err)

	calls := enq.snapshot()
	require.NotEmpty(t, calls)
	assert.Equal(t, WarmSeasonArgs{Season: "WINTER", Year: 2020}, calls[0],
		"first job must be WINTER startYear")
	assert.Equal(t, WarmSeasonArgs{Season: "FALL", Year: 2027}, calls[len(calls)-1],
		"last job must be FALL (currentYear+1)")
}

// TestEnqueueWarmAllSeasons_SeasonOrderingWithinYear — for every year
// in the range, the four seasons must appear in WINTER → SPRING →
// SUMMER → FALL order.
func TestEnqueueWarmAllSeasons_SeasonOrderingWithinYear(t *testing.T) {
	withFixedClock(t, stubNow(2026))

	enq := &warmAllEnqueuer{}
	_, err := EnqueueWarmAllSeasons(context.Background(), enq, 2024)
	require.NoError(t, err)

	calls := enq.snapshot()
	// Group consecutive calls by year and check season order.
	byYear := map[int][]string{}
	for _, c := range calls {
		byYear[c.Year] = append(byYear[c.Year], c.Season)
	}
	for year, seasons := range byYear {
		assert.Equal(t, []string{"WINTER", "SPRING", "SUMMER", "FALL"}, seasons,
			"year %d season order", year)
	}
}

// TestEnqueueWarmAllSeasons_NoDuplicates — every (season, year) pair
// must appear at most once.
func TestEnqueueWarmAllSeasons_NoDuplicates(t *testing.T) {
	withFixedClock(t, stubNow(2026))

	enq := &warmAllEnqueuer{}
	_, err := EnqueueWarmAllSeasons(context.Background(), enq, 2024)
	require.NoError(t, err)

	seen := map[string]int{}
	for _, c := range enq.snapshot() {
		key := c.Season + "-" + strconv.Itoa(c.Year)
		seen[key]++
	}
	for k, n := range seen {
		assert.Equal(t, 1, n, "duplicate pair %s enqueued %d times", k, n)
	}
}

// TestEnqueueWarmAllSeasons_ErrorPropagation — fail the 4th enqueue
// (index 3 = WINTER 2021 when starting 2020), assert error chains to
// sentinel + only 4 calls observed (the failing one counts).
func TestEnqueueWarmAllSeasons_ErrorPropagation(t *testing.T) {
	withFixedClock(t, stubNow(2026))

	sentinel := errors.New("river insert failed")
	enq := &warmAllEnqueuer{
		errOnCall: map[int]error{3: sentinel},
	}
	got, err := EnqueueWarmAllSeasons(context.Background(), enq, 2020)
	require.Error(t, err)
	assert.True(t, errors.Is(err, sentinel), "error must chain to sentinel: %v", err)
	assert.Contains(t, err.Error(), "warmAllSeasons:", "error must be wrapped with the helper name")

	// 3 successful + 1 failed = 3 enqueued (the failing one doesn't count).
	assert.Equal(t, 3, got, "enqueued = count BEFORE the failing call")
	assert.Len(t, enq.snapshot(), 4, "fake records all attempts including the failure")
}

// TestEnqueueWarmAllSeasons_NilEnqueuerPanics — passing nil must
// crash loudly per the contract.  defer/recover is the standard
// pattern.
func TestEnqueueWarmAllSeasons_NilEnqueuerPanics(t *testing.T) {
	t.Parallel()

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on nil Enqueuer")
		}
	}()
	_, _ = EnqueueWarmAllSeasons(context.Background(), nil, 2020)
}

// TestEnqueueWarmAllSeasons_NoopEnqueuer — passing NoopEnqueuer{}
// (the boot-time default before river is wired) must succeed without
// error and report the same count as the real path.
func TestEnqueueWarmAllSeasons_NoopEnqueuer(t *testing.T) {
	withFixedClock(t, stubNow(2026))

	got, err := EnqueueWarmAllSeasons(context.Background(), NoopEnqueuer{}, 2024)
	require.NoError(t, err)

	wantYears := 2027 - 2024 + 1
	assert.Equal(t, 4*wantYears, got)
}

// TestEnqueueWarmAllSeasons_TryLockConcurrent — fire two concurrent
// calls.  The first holds the mutex via the blocking fake; the
// second must return (0, ErrWarmAllInProgress) immediately.  Then
// release the first and confirm it finishes successfully.
//
// Not parallel — mutates nowFn AND the package-level warmAllMu via
// the function under test.
func TestEnqueueWarmAllSeasons_TryLockConcurrent(t *testing.T) {
	withFixedClock(t, stubNow(2026))

	block := make(chan struct{})
	enq := &warmAllEnqueuer{blockCh: block}

	// Start the first call in a goroutine — it will block in the
	// fake's EnqueueWarmSeasonNow on the first call.
	type result struct {
		n   int
		err error
	}
	firstCh := make(chan result, 1)
	go func() {
		n, err := EnqueueWarmAllSeasons(context.Background(), enq, 2024)
		firstCh <- result{n: n, err: err}
	}()

	// Wait for the first goroutine to have taken the lock + entered
	// the loop.  Spin-poll on the blocked atomic; bounded sleep is
	// fine here because the goroutine is hot.
	deadline := time.Now().Add(2 * time.Second)
	for !enq.blocked.Load() {
		if time.Now().After(deadline) {
			t.Fatal("first call never reached the blocked enqueue")
		}
		time.Sleep(time.Millisecond)
	}

	// Second call MUST observe the lock held and return immediately.
	secondN, secondErr := EnqueueWarmAllSeasons(context.Background(), enq, 2024)
	assert.Equal(t, 0, secondN, "second call must report 0 enqueued")
	require.Error(t, secondErr, "second concurrent call must error")
	assert.ErrorIs(t, secondErr, ErrWarmAllInProgress,
		"second concurrent call must return ErrWarmAllInProgress, got: %v", secondErr)

	// Release the first call and wait for it to finish cleanly.
	close(block)
	select {
	case r := <-firstCh:
		require.NoError(t, r.err, "first call should complete after release")
		// endYear = 2027; range 2024..2027 = 4 years * 4 seasons = 16.
		assert.Equal(t, 16, r.n, "first call enqueued count")
	case <-time.After(5 * time.Second):
		t.Fatal("first call never finished after release")
	}

	// Third call AFTER the first completes: mutex must be released.
	thirdN, thirdErr := EnqueueWarmAllSeasons(context.Background(), &warmAllEnqueuer{}, 2024)
	require.NoError(t, thirdErr, "post-completion call must succeed")
	assert.Equal(t, 16, thirdN, "post-completion call should run normally")
}

// cancellingEnqueuer is a warm-all fake that cancels the supplied
// context once a fixed number of calls have landed.  Used to make
// the context-cancellation test deterministic (vs. racing a
// goroutine against a tight enqueue loop).
type cancellingEnqueuer struct {
	mu          sync.Mutex
	calls       int
	cancelAfter int
	cancel      context.CancelFunc
}

func (c *cancellingEnqueuer) EnqueueV1Many(_ context.Context, _ []int32) error { return nil }
func (c *cancellingEnqueuer) EnqueueV2Many(_ context.Context, _ []BangumiV2Args) error {
	return nil
}
func (c *cancellingEnqueuer) EnqueueV3Many(_ context.Context, _ []BangumiV3Args) error {
	return nil
}
func (c *cancellingEnqueuer) EnqueueWarmSeasonNow(_ context.Context, _ WarmSeasonArgs) error {
	c.mu.Lock()
	c.calls++
	if c.calls == c.cancelAfter {
		c.cancel()
	}
	c.mu.Unlock()
	return nil
}

// TestEnqueueWarmAllSeasons_ContextCancellation — cancel the context
// from inside the Enqueuer after N successful calls; the helper must
// detect ctx.Err() on the next iteration and return the partial
// count wrapped with context.Canceled.
func TestEnqueueWarmAllSeasons_ContextCancellation(t *testing.T) {
	withFixedClock(t, stubNow(2026))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // belt-and-braces; cancellingEnqueuer cancels too
	enq := &cancellingEnqueuer{cancelAfter: 5, cancel: cancel}

	got, err := EnqueueWarmAllSeasons(ctx, enq, 2020)
	require.Error(t, err, "cancellation must surface as an error")
	assert.ErrorIs(t, err, context.Canceled, "error should chain to context.Canceled")
	assert.Equal(t, 5, got, "partial count equals the number of successful calls before cancel was observed")
}
