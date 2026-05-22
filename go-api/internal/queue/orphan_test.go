// orphan_test.go — unit tests for the boot-time orphan scan.
//
// Tests use a hand-rolled fakeOrphanReader (function-pointer reader)
// and fakeEnqueuer (function-pointer enqueuer) so each test can dictate
// the exact pagination + error scenarios without needing Postgres or
// river.
package queue

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeOrphanReader is an OrphanReader stub whose readFn is set per-test.
// All calls (limit/offset pairs) are recorded so tests can assert the
// pagination loop hit the expected boundary conditions.
type fakeOrphanReader struct {
	mu     sync.Mutex
	readFn func(ctx context.Context, limit, offset int32) ([]int32, error)
	calls  []readCall
}

type readCall struct {
	limit  int32
	offset int32
}

func (f *fakeOrphanReader) ListUnenrichedAnilistIDs(ctx context.Context, limit, offset int32) ([]int32, error) {
	f.mu.Lock()
	f.calls = append(f.calls, readCall{limit: limit, offset: offset})
	fn := f.readFn
	f.mu.Unlock()
	if fn == nil {
		return nil, errors.New("fakeOrphanReader: readFn not set")
	}
	return fn(ctx, limit, offset)
}

func (f *fakeOrphanReader) snapshotCalls() []readCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]readCall, len(f.calls))
	copy(dup, f.calls)
	return dup
}

// fakeEnqueuer records each EnqueueV1Many call.  Tests inspect calls
// to verify the orphan loop batches correctly (1 enqueue per DB read
// that returns rows).
type fakeEnqueuer struct {
	mu        sync.Mutex
	enqueueFn func(ctx context.Context, ids []int32) error
	calls     [][]int32
}

func (f *fakeEnqueuer) EnqueueV1Many(ctx context.Context, ids []int32) error {
	f.mu.Lock()
	dup := make([]int32, len(ids))
	copy(dup, ids)
	f.calls = append(f.calls, dup)
	fn := f.enqueueFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, ids)
}

// EnqueueV2Many is a no-op stub — ScanAndEnqueueOrphans only dispatches
// V1 jobs.  Satisfies the Enqueuer interface contract added in P2.1.7
// (when the V1 worker started chaining V2).
func (f *fakeEnqueuer) EnqueueV2Many(_ context.Context, _ []BangumiV2Args) error {
	return nil
}

// EnqueueV3Many is a no-op stub — ScanAndEnqueueOrphans only
// dispatches V1 jobs (V3 chains from V2 worker, not the orphan
// scan).  Satisfies the Enqueuer interface contract added in P2.1.8.
func (f *fakeEnqueuer) EnqueueV3Many(_ context.Context, _ []BangumiV3Args) error {
	return nil
}

func (f *fakeEnqueuer) snapshotCalls() [][]int32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([][]int32, len(f.calls))
	for i, c := range f.calls {
		dupInner := make([]int32, len(c))
		copy(dupInner, c)
		dup[i] = dupInner
	}
	return dup
}

// idsRange returns the sequence [start, start+n) as []int32 — used by
// tests that fill a 100-row "full batch".  Saves a hand-rolled loop in
// every test.
func idsRange(start int32, n int32) []int32 {
	out := make([]int32, n)
	for i := int32(0); i < n; i++ {
		out[i] = start + i
	}
	return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestScanOrphans_SmallBatch_OneCall — first read returns 5 rows
// (<batchSize), so the loop breaks after one read and one enqueue.
func TestScanOrphans_SmallBatch_OneCall(t *testing.T) {
	t.Parallel()

	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, _ int32) ([]int32, error) {
			return []int32{1, 2, 3, 4, 5}, nil
		},
	}
	e := &fakeEnqueuer{}

	total, err := ScanAndEnqueueOrphans(context.Background(), db, e)
	require.NoError(t, err)
	assert.Equal(t, 5, total)

	calls := e.snapshotCalls()
	require.Len(t, calls, 1, "exactly one enqueue call expected")
	assert.Equal(t, []int32{1, 2, 3, 4, 5}, calls[0])

	dbCalls := db.snapshotCalls()
	require.Len(t, dbCalls, 1, "one DB read sufficient when first batch is short")
	assert.Equal(t, orphanBatchSize, dbCalls[0].limit)
	assert.Equal(t, int32(0), dbCalls[0].offset)
}

// TestScanOrphans_FullBatch_TwoCalls — first read returns 100 rows
// (== batchSize), second read returns 0.  Loop must do 2 DB reads but
// only 1 enqueue.
func TestScanOrphans_FullBatch_TwoCalls(t *testing.T) {
	t.Parallel()

	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, offset int32) ([]int32, error) {
			if offset == 0 {
				return idsRange(1, 100), nil
			}
			return []int32{}, nil
		},
	}
	e := &fakeEnqueuer{}

	total, err := ScanAndEnqueueOrphans(context.Background(), db, e)
	require.NoError(t, err)
	assert.Equal(t, 100, total)

	calls := e.snapshotCalls()
	require.Len(t, calls, 1, "single 100-row enqueue expected")
	assert.Len(t, calls[0], 100)

	dbCalls := db.snapshotCalls()
	require.Len(t, dbCalls, 2, "second DB read required to discover the empty page")
	assert.Equal(t, int32(0), dbCalls[0].offset)
	assert.Equal(t, int32(100), dbCalls[1].offset)
}

// TestScanOrphans_ThreeBatches — paging across 3 reads: 100, 100, 50.
// Total enqueued = 250 across 3 enqueue calls.  Last batch is short so
// the loop exits without a 4th read.
func TestScanOrphans_ThreeBatches(t *testing.T) {
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
	e := &fakeEnqueuer{}

	total, err := ScanAndEnqueueOrphans(context.Background(), db, e)
	require.NoError(t, err)
	assert.Equal(t, 250, total)

	calls := e.snapshotCalls()
	require.Len(t, calls, 3, "three enqueue calls (100, 100, 50)")
	assert.Len(t, calls[0], 100)
	assert.Len(t, calls[1], 100)
	assert.Len(t, calls[2], 50)

	dbCalls := db.snapshotCalls()
	require.Len(t, dbCalls, 3, "short last batch (50<100) terminates loop without an extra read")
}

// TestScanOrphans_EmptyDB_NoEnqueue — DB returns empty on first read;
// no enqueue should fire, total=0.
func TestScanOrphans_EmptyDB_NoEnqueue(t *testing.T) {
	t.Parallel()

	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, _ int32) ([]int32, error) {
			return []int32{}, nil
		},
	}
	e := &fakeEnqueuer{}

	total, err := ScanAndEnqueueOrphans(context.Background(), db, e)
	require.NoError(t, err)
	assert.Equal(t, 0, total)
	assert.Empty(t, e.snapshotCalls(), "empty backlog should not produce any enqueue calls")
}

// TestScanOrphans_DBError_Propagates — DB returns an error on the first
// read; ScanAndEnqueueOrphans must return that error wrapped with the
// offset context, with total still tracking what was enqueued so far
// (zero in this case).
func TestScanOrphans_DBError_Propagates(t *testing.T) {
	t.Parallel()

	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, _ int32) ([]int32, error) {
			return nil, errors.New("simulated postgres failure")
		},
	}
	e := &fakeEnqueuer{}

	total, err := ScanAndEnqueueOrphans(context.Background(), db, e)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "queue.ScanAndEnqueueOrphans", "error should be wrapped with the helper's name")
	assert.Contains(t, err.Error(), "offset=0", "error should include the offset that failed")
	assert.Contains(t, err.Error(), "simulated postgres failure", "underlying cause must be preserved")
	assert.Equal(t, 0, total)
	assert.Empty(t, e.snapshotCalls(), "enqueue must not be called when DB fails")
}

// TestScanOrphans_EnqueueError_Propagates — DB succeeds but the
// enqueuer returns an error; scan returns the enqueue error directly
// (not wrapped a second time — keeps the call-site error chain shallow).
func TestScanOrphans_EnqueueError_Propagates(t *testing.T) {
	t.Parallel()

	enqueueErr := errors.New("simulated river failure")
	db := &fakeOrphanReader{
		readFn: func(_ context.Context, _, _ int32) ([]int32, error) {
			return []int32{1, 2, 3}, nil
		},
	}
	e := &fakeEnqueuer{
		enqueueFn: func(_ context.Context, _ []int32) error {
			return enqueueErr
		},
	}

	total, err := ScanAndEnqueueOrphans(context.Background(), db, e)
	require.Error(t, err)
	assert.True(t, errors.Is(err, enqueueErr), "underlying enqueue error must be unwrappable")
	assert.Equal(t, 0, total, "total reflects rows successfully enqueued before failure (none here)")
}
