// enqueue_test.go — unit tests for the Enqueuer surface.
//
// The happy-path / error-path tests for RealEnqueuer.EnqueueV1Many that
// exercise river.Client.InsertMany against a real driver live in
// test/integration/queue_smoke_test.go (testcontainers Postgres).  Here
// we cover only the early-return (empty slice) path and the NoopEnqueuer
// contract — neither path requires a river client, so a nil client is
// safe.
package queue

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestNoopEnqueuer_NoError asserts NoopEnqueuer never returns an error
// regardless of input (nil slice, empty slice, populated slice).
func TestNoopEnqueuer_NoError(t *testing.T) {
	t.Parallel()

	n := NoopEnqueuer{}

	require.NoError(t, n.EnqueueV1Many(context.Background(), nil))
	require.NoError(t, n.EnqueueV1Many(context.Background(), []int32{}))
	require.NoError(t, n.EnqueueV1Many(context.Background(), []int32{1, 2, 3}))
}

// TestRealEnqueuer_EmptyList_NoCall asserts the early-return path runs
// without touching the underlying river client.  We pass nil for the
// client — if the implementation tried to call client.InsertMany the
// test would panic with a nil-pointer dereference.
func TestRealEnqueuer_EmptyList_NoCall(t *testing.T) {
	t.Parallel()

	e := NewEnqueuer(nil)

	// Both nil and empty must short-circuit before the nil client is
	// dereferenced.  If the early-return guard regresses, this test
	// panics — which testify treats as a failure for this subtest.
	require.NoError(t, e.EnqueueV1Many(context.Background(), nil))
	require.NoError(t, e.EnqueueV1Many(context.Background(), []int32{}))
}

// TestEnqueuer_InterfaceSatisfaction is a runtime sanity check — the
// var blocks at the bottom of enqueue.go give us compile-time
// guarantees, but an extra runtime guard documents the intent for
// readers who skim test files looking for the "what does this package
// expose" map.
func TestEnqueuer_InterfaceSatisfaction(t *testing.T) {
	t.Parallel()

	var _ Enqueuer = (*RealEnqueuer)(nil)
	var _ Enqueuer = NoopEnqueuer{}
}
