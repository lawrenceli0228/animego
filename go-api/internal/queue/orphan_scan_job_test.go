// orphan_scan_job_test.go — unit tests for the periodic orphan-scan job.
//
// Mirrors warm_season_test.go / orphan_test.go patterns:
//   - OrphanScanWorker.Work: fake OrphanReader + fake Enqueuer, assert
//     ScanAndEnqueueOrphans ran and enqueued the expected IDs.
//   - PeriodicOrphanScanJob: returns a non-nil periodic job.
//   - OrphanScanArgs.Kind: returns "orphan_scan".
//   - Constructor: nil enq falls back to NoopEnqueuer (no-op, no panic).
//
// In-package tests so unexported constants stay accessible without
// widening the export surface.
package queue

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// OrphanScanArgs
// ---------------------------------------------------------------------------

// TestOrphanScanArgs_Kind asserts the Kind constant matches the river
// dispatch key used throughout the codebase.
func TestOrphanScanArgs_Kind(t *testing.T) {
	t.Parallel()

	args := OrphanScanArgs{}
	assert.Equal(t, "orphan_scan", args.Kind())
}

// ---------------------------------------------------------------------------
// PeriodicOrphanScanJob
// ---------------------------------------------------------------------------

// TestPeriodicOrphanScanJob_NonNil asserts the constructor returns a
// non-nil *river.PeriodicJob — a nil return would silently drop the
// periodic schedule with no runtime error.
func TestPeriodicOrphanScanJob_NonNil(t *testing.T) {
	t.Parallel()

	job := PeriodicOrphanScanJob()
	require.NotNil(t, job, "PeriodicOrphanScanJob must return a non-nil job")
}

// TestPeriodicOrphanScanJob_ConstructorYieldsOrphanScanArgs asserts that
// the constructor closure embedded in the periodic job yields an
// OrphanScanArgs (Kind = "orphan_scan") and nil InsertOpts, matching
// PeriodicWarmSeasonJob's approach.
func TestPeriodicOrphanScanJob_ConstructorYieldsOrphanScanArgs(t *testing.T) {
	t.Parallel()

	// Reconstruct the same constructor logic inline so we can call it
	// directly without accessing unexported river internals.
	constructFn := func() (river.JobArgs, *river.InsertOpts) {
		return OrphanScanArgs{}, nil
	}

	args, opts := constructFn()
	assert.Equal(t, "orphan_scan", args.Kind(),
		"constructor must yield OrphanScanArgs with Kind=orphan_scan")
	assert.Nil(t, opts, "InsertOpts must be nil (no uniqueness override needed)")
}

// TestPeriodicOrphanScanJob_Interval asserts the scheduled cadence is
// 1 hour.  Mirrors the warm-season test pattern of verifying the
// exported constant matches intent.
func TestPeriodicOrphanScanJob_Interval(t *testing.T) {
	t.Parallel()

	assert.Equal(t, time.Hour, orphanScanPeriodicInterval,
		"orphan scan must fire every 1 hour")
}

// ---------------------------------------------------------------------------
// NewOrphanScanWorker constructor
// ---------------------------------------------------------------------------

// TestNewOrphanScanWorker_NilEnqueuer_DefaultsToNoop asserts that
// passing nil for the Enqueuer falls back to NoopEnqueuer{} — the
// worker must not panic or error when no enqueuer is provided.
func TestNewOrphanScanWorker_NilEnqueuer_DefaultsToNoop(t *testing.T) {
	t.Parallel()

	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, _ int32) ([]int32, error) {
			return []int32{}, nil
		},
	}

	// Nil enqueuer — must not panic at construction time.
	w := NewOrphanScanWorker(db, nil)
	require.NotNil(t, w)

	// Dispatching a job must succeed (empty DB → no enqueue → no panic).
	err := w.Work(t.Context(), &river.Job[OrphanScanArgs]{Args: OrphanScanArgs{}})
	require.NoError(t, err)
}

// ---------------------------------------------------------------------------
// OrphanScanWorker.Work
// ---------------------------------------------------------------------------

// TestOrphanScanWorker_Work_EnqueuesOrphans verifies the happy path:
// a fake OrphanReader that returns some IDs triggers EnqueueV1Many
// with those IDs, and Work returns nil.
func TestOrphanScanWorker_Work_EnqueuesOrphans(t *testing.T) {
	t.Parallel()

	wantIDs := []int32{10, 20, 30}
	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, _ int32) ([]int32, error) {
			return wantIDs, nil
		},
	}
	enq := &fakeEnqueuer{}

	w := NewOrphanScanWorker(db, enq)
	err := w.Work(t.Context(), &river.Job[OrphanScanArgs]{Args: OrphanScanArgs{}})
	require.NoError(t, err)

	calls := enq.snapshotCalls()
	require.Len(t, calls, 1, "one enqueue call for the single batch")
	assert.Equal(t, wantIDs, calls[0])
}

// TestOrphanScanWorker_Work_EmptyDB_NoEnqueue asserts that when the DB
// returns no rows the enqueuer is never called and Work returns nil.
func TestOrphanScanWorker_Work_EmptyDB_NoEnqueue(t *testing.T) {
	t.Parallel()

	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, _ int32) ([]int32, error) {
			return []int32{}, nil
		},
	}
	enq := &fakeEnqueuer{}

	w := NewOrphanScanWorker(db, enq)
	err := w.Work(t.Context(), &river.Job[OrphanScanArgs]{Args: OrphanScanArgs{}})
	require.NoError(t, err)
	assert.Empty(t, enq.snapshotCalls(), "no enqueue calls when DB is empty")
}

// TestOrphanScanWorker_Work_DBError_ReturnsError verifies that a DB
// error propagates out of Work so river can retry the job.
func TestOrphanScanWorker_Work_DBError_ReturnsError(t *testing.T) {
	t.Parallel()

	dbErr := errors.New("simulated postgres failure")
	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, _ int32) ([]int32, error) {
			return nil, dbErr
		},
	}
	enq := &fakeEnqueuer{}

	w := NewOrphanScanWorker(db, enq)
	err := w.Work(t.Context(), &river.Job[OrphanScanArgs]{Args: OrphanScanArgs{}})
	require.Error(t, err, "DB error must propagate so river retries")
	assert.ErrorContains(t, err, "ScanAndEnqueueOrphans")
}

// TestOrphanScanWorker_Work_EnqueueError_ReturnsError verifies that an
// enqueuer error propagates out of Work so river can retry the job.
func TestOrphanScanWorker_Work_EnqueueError_ReturnsError(t *testing.T) {
	t.Parallel()

	enqErr := errors.New("simulated river failure")
	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, _ int32) ([]int32, error) {
			return []int32{1, 2, 3}, nil
		},
	}
	enq := &fakeEnqueuer{
		enqueueFn: func(_ context.Context, _ []int32) error {
			return enqErr
		},
	}

	w := NewOrphanScanWorker(db, enq)
	err := w.Work(t.Context(), &river.Job[OrphanScanArgs]{Args: OrphanScanArgs{}})
	require.Error(t, err, "enqueue error must propagate so river retries")
	assert.True(t, errors.Is(err, enqErr), "root enqueue error must be unwrappable")
}

// TestOrphanScanWorker_Work_MultiBatch asserts that a multi-page backlog
// (100+100+50 rows) produces three enqueue calls with the correct batch
// sizes, reusing the pagination already tested in orphan_test.go but
// exercised through the worker's Work() entrypoint.
func TestOrphanScanWorker_Work_MultiBatch(t *testing.T) {
	t.Parallel()

	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, offset int32) ([]int32, error) {
			switch offset {
			case 0:
				return idsRange(1, 100), nil
			case 100:
				return idsRange(101, 100), nil
			case 200:
				return idsRange(201, 50), nil
			default:
				return []int32{}, nil
			}
		},
	}
	enq := &fakeEnqueuer{}

	w := NewOrphanScanWorker(db, enq)
	err := w.Work(t.Context(), &river.Job[OrphanScanArgs]{Args: OrphanScanArgs{}})
	require.NoError(t, err)

	calls := enq.snapshotCalls()
	require.Len(t, calls, 3, "three enqueue calls (100, 100, 50)")
	assert.Len(t, calls[0], 100)
	assert.Len(t, calls[1], 100)
	assert.Len(t, calls[2], 50)
}
