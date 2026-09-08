// control_test.go — unit tests for the queue control surface
// (PauseV3, ResumeV3, Status).
//
// Tests use a fakeQueueController so each path can be exercised
// without standing up Postgres + river.  The integration test
// against a REAL *river.Client[pgx.Tx] backed by a testcontainer
// lives in test/integration/queue_smoke_test.go (the file
// queue_control_smoke_test.go added in P2.3.1) — the unit suite
// here covers the happy paths, error wrapping, and the
// QueueController interface contract.

package queue

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeQueueController is a programmable stand-in for *river.Client.
// Each method's behavior is set per-test via the *Fn fields; calls
// are recorded under a mutex so concurrent tests don't race.
type fakeQueueController struct {
	mu          sync.Mutex
	pauseFn     func(ctx context.Context, name string, opts *river.QueuePauseOpts) error
	resumeFn    func(ctx context.Context, name string, opts *river.QueuePauseOpts) error
	getFn       func(ctx context.Context, name string) (*rivertype.Queue, error)
	pauseCalls  []string
	resumeCalls []string
	getCalls    []string
}

func (f *fakeQueueController) QueuePause(ctx context.Context, name string, opts *river.QueuePauseOpts) error {
	f.mu.Lock()
	f.pauseCalls = append(f.pauseCalls, name)
	fn := f.pauseFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, name, opts)
}

func (f *fakeQueueController) QueueResume(ctx context.Context, name string, opts *river.QueuePauseOpts) error {
	f.mu.Lock()
	f.resumeCalls = append(f.resumeCalls, name)
	fn := f.resumeFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, name, opts)
}

func (f *fakeQueueController) QueueGet(ctx context.Context, name string) (*rivertype.Queue, error) {
	f.mu.Lock()
	f.getCalls = append(f.getCalls, name)
	fn := f.getFn
	f.mu.Unlock()
	if fn == nil {
		return nil, nil
	}
	return fn(ctx, name)
}

func (f *fakeQueueController) snapshotPauseCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.pauseCalls))
	copy(out, f.pauseCalls)
	return out
}

func (f *fakeQueueController) snapshotResumeCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.resumeCalls))
	copy(out, f.resumeCalls)
	return out
}

// snapshotAllCalls reports every call that reached the controller, whichever
// method it went through.  The validation tests below assert on this rather
// than on one method's list: a refused name must not reach river AT ALL, and
// checking only pauseCalls would miss a refusal that leaked into QueueGet.
func (f *fakeQueueController) snapshotAllCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.pauseCalls)+len(f.resumeCalls)+len(f.getCalls))
	out = append(out, f.pauseCalls...)
	out = append(out, f.resumeCalls...)
	out = append(out, f.getCalls...)
	return out
}

func (f *fakeQueueController) snapshotGetCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.getCalls))
	copy(out, f.getCalls)
	return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestBangumiV3QueueName_Stable — guards against accidental rename of
// the queue name constant.  Callers (admin handler, frontend) rely on
// the exact string "bangumi_v3".
func TestBangumiV3QueueName_Stable(t *testing.T) {
	t.Parallel()
	assert.Equal(t, "bangumi_v3", BangumiV3QueueName,
		"queue name is part of the API contract; renaming requires a coordinated client+server update")
}

// TestPauseV3_CallsQueuePause — happy path: PauseV3 must invoke
// QueuePause with the V3 queue name and no opts.
func TestPauseV3_CallsQueuePause(t *testing.T) {
	t.Parallel()

	f := &fakeQueueController{}
	require.NoError(t, PauseV3(context.Background(), f))

	calls := f.snapshotPauseCalls()
	require.Len(t, calls, 1, "PauseV3 must invoke QueuePause exactly once")
	assert.Equal(t, BangumiV3QueueName, calls[0], "must pause the V3 queue, not some other queue")
}

// TestPauseV3_WrapsError — when QueuePause returns an error,
// PauseV3 must wrap it with the queue name + return the wrapped form.
// errors.Is must still find the underlying sentinel through the wrap.
func TestPauseV3_WrapsError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("river: queue not found")
	f := &fakeQueueController{
		pauseFn: func(_ context.Context, _ string, _ *river.QueuePauseOpts) error {
			return sentinel
		},
	}
	err := PauseV3(context.Background(), f)
	require.Error(t, err)
	assert.True(t, errors.Is(err, sentinel), "underlying error must remain unwrappable")
	// The wrap names PauseQueue, not PauseV3: PauseV3 is now a thin alias
	// for the general form, and the general form is where the wrapping
	// lives.  What the message has to carry is the queue, which is the part
	// an operator acts on.
	assert.Contains(t, err.Error(), "queue.PauseQueue", "wrap must name the operation")
	assert.Contains(t, err.Error(), BangumiV3QueueName, "wrap must include the queue name")
}

// TestResumeV3_CallsQueueResume — happy path: ResumeV3 must invoke
// QueueResume with the V3 queue name and no opts.
func TestResumeV3_CallsQueueResume(t *testing.T) {
	t.Parallel()

	f := &fakeQueueController{}
	require.NoError(t, ResumeV3(context.Background(), f))

	calls := f.snapshotResumeCalls()
	require.Len(t, calls, 1)
	assert.Equal(t, BangumiV3QueueName, calls[0])
}

// TestResumeV3_WrapsError — same error-wrap contract as PauseV3.
func TestResumeV3_WrapsError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("river: connection failed")
	f := &fakeQueueController{
		resumeFn: func(_ context.Context, _ string, _ *river.QueuePauseOpts) error {
			return sentinel
		},
	}
	err := ResumeV3(context.Background(), f)
	require.Error(t, err)
	assert.True(t, errors.Is(err, sentinel))
	assert.Contains(t, err.Error(), "queue.ResumeQueue", "wrap must name the operation")
	assert.Contains(t, err.Error(), BangumiV3QueueName)
}

// TestStatus_PausedAtNil_ReturnsV3PausedFalse — Status must report
// V3Paused=false when the queue's PausedAt is nil (i.e. the queue
// exists and is actively serving jobs).
func TestStatus_PausedAtNil_ReturnsV3PausedFalse(t *testing.T) {
	t.Parallel()

	f := &fakeQueueController{
		getFn: func(_ context.Context, _ string) (*rivertype.Queue, error) {
			return &rivertype.Queue{
				Name:     BangumiV3QueueName,
				PausedAt: nil,
			}, nil
		},
	}
	got, err := Status(context.Background(), f)
	require.NoError(t, err)
	assert.False(t, got.V3Paused, "PausedAt=nil must map to V3Paused=false")

	calls := f.snapshotGetCalls()
	require.Len(t, calls, 1)
	assert.Equal(t, BangumiV3QueueName, calls[0])
}

// TestStatus_PausedAtSet_ReturnsV3PausedTrue — Status must report
// V3Paused=true when PausedAt is a non-nil timestamp.
func TestStatus_PausedAtSet_ReturnsV3PausedTrue(t *testing.T) {
	t.Parallel()

	pausedAt := time.Now().Add(-5 * time.Minute)
	f := &fakeQueueController{
		getFn: func(_ context.Context, _ string) (*rivertype.Queue, error) {
			return &rivertype.Queue{
				Name:     BangumiV3QueueName,
				PausedAt: &pausedAt,
			}, nil
		},
	}
	got, err := Status(context.Background(), f)
	require.NoError(t, err)
	assert.True(t, got.V3Paused, "non-nil PausedAt must map to V3Paused=true")
}

// TestStatus_WrapsError — when QueueGet returns an error, Status
// must wrap it with the queue name + return zero Stats.
func TestStatus_WrapsError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("river: not found")
	f := &fakeQueueController{
		getFn: func(_ context.Context, _ string) (*rivertype.Queue, error) {
			return nil, sentinel
		},
	}
	got, err := Status(context.Background(), f)
	require.Error(t, err)
	assert.True(t, errors.Is(err, sentinel))
	assert.Contains(t, err.Error(), "queue.QueuePaused", "wrap must name the operation")
	assert.Contains(t, err.Error(), BangumiV3QueueName)
	assert.Equal(t, Stats{}, got, "error path must return zero Stats")
}

// TestPauseResumeStatus_RoundTrip — call PauseV3 then ResumeV3 then
// Status against the same fake; verify the call sequence is recorded
// in order and that each helper only touches its own surface.
func TestPauseResumeStatus_RoundTrip(t *testing.T) {
	t.Parallel()

	now := time.Now()
	pausedFlag := false
	f := &fakeQueueController{
		pauseFn: func(_ context.Context, _ string, _ *river.QueuePauseOpts) error {
			pausedFlag = true
			return nil
		},
		resumeFn: func(_ context.Context, _ string, _ *river.QueuePauseOpts) error {
			pausedFlag = false
			return nil
		},
		getFn: func(_ context.Context, _ string) (*rivertype.Queue, error) {
			if pausedFlag {
				p := now
				return &rivertype.Queue{Name: BangumiV3QueueName, PausedAt: &p}, nil
			}
			return &rivertype.Queue{Name: BangumiV3QueueName, PausedAt: nil}, nil
		},
	}

	// Initial status — not paused.
	s, err := Status(context.Background(), f)
	require.NoError(t, err)
	assert.False(t, s.V3Paused, "initial state must be unpaused")

	// Pause — status flips to true.
	require.NoError(t, PauseV3(context.Background(), f))
	s, err = Status(context.Background(), f)
	require.NoError(t, err)
	assert.True(t, s.V3Paused, "after PauseV3, status must report V3Paused=true")

	// Resume — status flips back to false.
	require.NoError(t, ResumeV3(context.Background(), f))
	s, err = Status(context.Background(), f)
	require.NoError(t, err)
	assert.False(t, s.V3Paused, "after ResumeV3, status must report V3Paused=false")

	// Verify each helper only called its own underlying surface.
	assert.Len(t, f.snapshotPauseCalls(), 1)
	assert.Len(t, f.snapshotResumeCalls(), 1)
	assert.Len(t, f.snapshotGetCalls(), 3, "Status was called three times")
}

// Compile-time assertion for the real *river.Client[pgx.Tx] living
// in control.go covers the interface satisfaction.  No runtime test
// here — the package-level guard catches drift at build time.

// ---------------------------------------------------------------------------
// The generalised pause surface
// ---------------------------------------------------------------------------

// TestPauseQueue_RefusesDefault is the constraint control.go's package doc has
// carried since the surface was V3-only: the admin endpoint must not be able
// to freeze the whole queue subsystem.
//
// default is not one workload, it is four — V1, V2, warm_season and
// orphan_scan — so pausing it stops the enrichment a page load is waiting on.
// Widening pause to the other eight queues is only safe while this holds.
func TestPauseQueue_RefusesDefault(t *testing.T) {
	t.Parallel()

	f := &fakeQueueController{}
	err := PauseQueue(context.Background(), f, river.QueueDefault)

	require.Error(t, err)
	assert.ErrorIs(t, err, ErrQueueNotPausable)
	assert.Contains(t, err.Error(), "V1, V2, warm_season and orphan_scan",
		"the refusal must say what pausing default would have stopped")
	assert.Empty(t, f.snapshotAllCalls(), "a refused pause must not reach river")
}

// TestPauseQueue_RefusesWildcard covers river's all-queues form, which would
// freeze everything default would and then some.
func TestPauseQueue_RefusesWildcard(t *testing.T) {
	t.Parallel()

	f := &fakeQueueController{}
	err := PauseQueue(context.Background(), f, "*")

	require.Error(t, err)
	assert.ErrorIs(t, err, ErrQueueNotPausable)
	assert.Empty(t, f.snapshotAllCalls())
}

// TestPauseQueue_RefusesUnknownName covers the operator's typo.  Passing it
// through would hand river a name it has never heard of, and river's
// QueuePause is happy to record a pause for a queue that does not exist —
// so the operator would get a success for a queue that keeps running.
func TestPauseQueue_RefusesUnknownName(t *testing.T) {
	t.Parallel()

	for _, name := range []string{"", "ratings ", "rating", "bangumi_v4"} {
		f := &fakeQueueController{}
		err := PauseQueue(context.Background(), f, name)

		require.Error(t, err, "name %q", name)
		assert.ErrorIs(t, err, ErrQueueNotPausable)
		assert.Empty(t, f.snapshotAllCalls(), "name %q must not reach river", name)
	}
}

// TestPauseQueue_AcceptsEveryDedicatedQueue asserts the whole point: the eight
// queues that were given their own pool precisely so they could be stopped
// independently are all reachable.
func TestPauseQueue_AcceptsEveryDedicatedQueue(t *testing.T) {
	t.Parallel()

	names := PausableQueues()
	require.Len(t, names, 8)

	for _, name := range names {
		f := &fakeQueueController{}
		require.NoError(t, PauseQueue(context.Background(), f, name), "pause %q", name)
		assert.Equal(t, []string{name}, f.snapshotAllCalls())

		f2 := &fakeQueueController{}
		require.NoError(t, ResumeQueue(context.Background(), f2, name), "resume %q", name)
		assert.Equal(t, []string{name}, f2.snapshotAllCalls())
	}
}

func TestResumeQueue_RefusesDefault(t *testing.T) {
	t.Parallel()

	f := &fakeQueueController{}
	err := ResumeQueue(context.Background(), f, river.QueueDefault)

	require.Error(t, err)
	assert.ErrorIs(t, err, ErrQueueNotPausable)
	assert.Empty(t, f.snapshotAllCalls())
}

func TestQueuePaused_RefusesDefault(t *testing.T) {
	t.Parallel()

	f := &fakeQueueController{}
	_, err := QueuePaused(context.Background(), f, river.QueueDefault)

	require.Error(t, err)
	assert.ErrorIs(t, err, ErrQueueNotPausable)
	assert.Empty(t, f.snapshotAllCalls())
}

// TestQueuePaused_ReadsPausedAt is the other half of the switch: being able to
// stop a queue without being able to see whether it stopped is half a control.
func TestQueuePaused_ReadsPausedAt(t *testing.T) {
	t.Parallel()

	at := time.Now()
	for _, tc := range []struct {
		name     string
		pausedAt *time.Time
		want     bool
	}{
		{"paused", &at, true},
		{"running", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			f := &fakeQueueController{
				getFn: func(_ context.Context, name string) (*rivertype.Queue, error) {
					return &rivertype.Queue{Name: name, PausedAt: tc.pausedAt}, nil
				},
			}
			got, err := QueuePaused(context.Background(), f, RatingsQueueName)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

// TestStatusAll_ReportsEveryPausableQueue pins the generalised read.
func TestStatusAll_ReportsEveryPausableQueue(t *testing.T) {
	t.Parallel()

	at := time.Now()
	f := &fakeQueueController{
		getFn: func(_ context.Context, name string) (*rivertype.Queue, error) {
			q := &rivertype.Queue{Name: name}
			if name == BangumiV3QueueName || name == RatingsQueueName {
				q.PausedAt = &at
			}
			return q, nil
		},
	}

	got, err := StatusAll(context.Background(), f)
	require.NoError(t, err)

	assert.Len(t, got.Paused, 8, "every pausable queue must be reported")
	assert.True(t, got.Paused[BangumiV3QueueName])
	assert.True(t, got.Paused[RatingsQueueName])
	assert.False(t, got.Paused[HantBackfillQueueName])
	assert.NotContains(t, got.Paused, river.QueueDefault,
		"default is not pausable, so it has no flag to report")
	assert.True(t, got.V3Paused,
		"the legacy field must stay in step with the map the frontend has not moved to yet")
}

// TestStatusAll_OmitsQueuesRiverHasNoRowFor is the distinction that keeps the
// status honest.  river creates a river_queue row when a producer starts, so a
// missing one means "not started here" — reporting it as false would put a
// confident "running" next to a queue nobody is draining.
func TestStatusAll_OmitsQueuesRiverHasNoRowFor(t *testing.T) {
	t.Parallel()

	f := &fakeQueueController{
		getFn: func(_ context.Context, name string) (*rivertype.Queue, error) {
			if name == HantBackfillQueueName {
				return nil, river.ErrNotFound
			}
			return &rivertype.Queue{Name: name}, nil
		},
	}

	got, err := StatusAll(context.Background(), f)
	require.NoError(t, err, "a queue river has no row for is not an error")
	assert.NotContains(t, got.Paused, HantBackfillQueueName,
		"absent, not false — the two are different claims")
	assert.Len(t, got.Paused, 7)
}

// TestStatusAll_PropagatesRealErrors — a status surface that hides failures is
// the shape this whole change exists to remove.
func TestStatusAll_PropagatesRealErrors(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("river: connection refused")
	f := &fakeQueueController{
		getFn: func(_ context.Context, _ string) (*rivertype.Queue, error) {
			return nil, sentinel
		},
	}

	got, err := StatusAll(context.Background(), f)
	require.Error(t, err)
	assert.ErrorIs(t, err, sentinel)
	assert.Equal(t, Stats{}, got, "error path must return zero Stats")
}
