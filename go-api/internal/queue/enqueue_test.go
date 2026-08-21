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

// TestNoopEnqueuer_V2NoError asserts NoopEnqueuer.EnqueueV2Many is
// equally inert for all input shapes — nil, empty, populated.
func TestNoopEnqueuer_V2NoError(t *testing.T) {
	t.Parallel()

	n := NoopEnqueuer{}

	require.NoError(t, n.EnqueueV2Many(context.Background(), nil))
	require.NoError(t, n.EnqueueV2Many(context.Background(), []BangumiV2Args{}))
	require.NoError(t, n.EnqueueV2Many(context.Background(),
		[]BangumiV2Args{{AnilistID: 1, BgmID: 100}, {AnilistID: 2, BgmID: 200}}))
}

// TestNoopEnqueuer_V3NoError — same inert-for-all-inputs guarantee
// for the V3 method.  Documents that NoopEnqueuer is safe as a
// drop-in default in tests that don't care about the V3 chain.
func TestNoopEnqueuer_V3NoError(t *testing.T) {
	t.Parallel()

	n := NoopEnqueuer{}

	require.NoError(t, n.EnqueueV3Many(context.Background(), nil))
	require.NoError(t, n.EnqueueV3Many(context.Background(), []BangumiV3Args{}))
	require.NoError(t, n.EnqueueV3Many(context.Background(),
		[]BangumiV3Args{{AnilistID: 1, BgmID: 100}, {AnilistID: 2, BgmID: 200}}))
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

// TestRealEnqueuer_V2EmptyList_NoCall — same guard for the V2 path.
// Empty / nil must short-circuit before the nil client is touched.
func TestRealEnqueuer_V2EmptyList_NoCall(t *testing.T) {
	t.Parallel()

	e := NewEnqueuer(nil)

	require.NoError(t, e.EnqueueV2Many(context.Background(), nil))
	require.NoError(t, e.EnqueueV2Many(context.Background(), []BangumiV2Args{}))
}

// TestRealEnqueuer_V3EmptyList_NoCall — same guard for the V3 path.
// Empty / nil must short-circuit before the nil client is touched.
func TestRealEnqueuer_V3EmptyList_NoCall(t *testing.T) {
	t.Parallel()

	e := NewEnqueuer(nil)

	require.NoError(t, e.EnqueueV3Many(context.Background(), nil))
	require.NoError(t, e.EnqueueV3Many(context.Background(), []BangumiV3Args{}))
}

// TestLateBoundEnqueuer_V3Unbound_NoOp asserts the LateBoundEnqueuer
// V3 path silently no-ops when the inner *RealEnqueuer hasn't been
// bound yet — matches the V1 + V2 contracts so the constructor can
// safely accept a not-yet-bound *LateBoundEnqueuer without surprising
// callers.
func TestLateBoundEnqueuer_V3Unbound_NoOp(t *testing.T) {
	t.Parallel()

	l := &LateBoundEnqueuer{}
	require.NoError(t, l.EnqueueV3Many(context.Background(), nil))
	require.NoError(t, l.EnqueueV3Many(context.Background(), []BangumiV3Args{}))
	require.NoError(t, l.EnqueueV3Many(context.Background(),
		[]BangumiV3Args{{AnilistID: 1, BgmID: 100}}))
}

// TestNoopEnqueuer_WarmSeasonNoError asserts NoopEnqueuer's
// EnqueueWarmSeasonNow path is equally inert.  Both the zero-value
// and populated WarmSeasonArgs return nil — documents that
// NoopEnqueuer is a safe drop-in default for tests that don't care
// about the warm-season trigger.
func TestNoopEnqueuer_WarmSeasonNoError(t *testing.T) {
	t.Parallel()

	n := NoopEnqueuer{}

	require.NoError(t, n.EnqueueWarmSeasonNow(context.Background(), WarmSeasonArgs{}))
	require.NoError(t, n.EnqueueWarmSeasonNow(context.Background(),
		WarmSeasonArgs{Season: "WINTER", Year: 2026}))
}

// TestLateBoundEnqueuer_WarmSeasonUnbound_NoOp asserts the
// LateBoundEnqueuer WarmSeason path silently no-ops when the inner
// *RealEnqueuer hasn't been bound yet — matches the V1/V2/V3
// contracts so main.go can safely call EnqueueWarmSeasonNow before
// (or in the same nanosecond as) Bind without spurious errors.
func TestLateBoundEnqueuer_WarmSeasonUnbound_NoOp(t *testing.T) {
	t.Parallel()

	l := &LateBoundEnqueuer{}
	require.NoError(t, l.EnqueueWarmSeasonNow(context.Background(),
		WarmSeasonArgs{Season: "SPRING", Year: 2026}))
}

// TestNoopEnqueuer_DescriptionBackfillNoError asserts the P3 method is
// as inert as the rest of NoopEnqueuer.  Every Enqueuer test double in
// the repo now carries this method, so the no-op contract is what those
// doubles are implicitly promising.
func TestNoopEnqueuer_DescriptionBackfillNoError(t *testing.T) {
	t.Parallel()

	n := NoopEnqueuer{}

	require.NoError(t, n.EnqueueDescriptionBackfillMany(context.Background(), nil))
	require.NoError(t, n.EnqueueDescriptionBackfillMany(context.Background(), []DescriptionBackfillArgs{}))
	require.NoError(t, n.EnqueueDescriptionBackfillMany(context.Background(),
		[]DescriptionBackfillArgs{{AnilistID: 1, BgmID: 100}}))
}

// TestRealEnqueuer_DescriptionBackfillEmptyList_NoCall — same guard as
// the V2/V3 paths.  This one matters more than it looks: the method
// dereferences e.client to call InsertMany, and the scan worker calls it
// on every pass including the steady-state passes that find nothing, so
// the empty-slice short-circuit is on the hot path forever once the
// backlog drains.
func TestRealEnqueuer_DescriptionBackfillEmptyList_NoCall(t *testing.T) {
	t.Parallel()

	e := NewEnqueuer(nil)

	require.NoError(t, e.EnqueueDescriptionBackfillMany(context.Background(), nil))
	require.NoError(t, e.EnqueueDescriptionBackfillMany(context.Background(), []DescriptionBackfillArgs{}))
}

// TestLateBoundEnqueuer_DescriptionBackfillUnbound_NoOp asserts the
// unbound path no-ops rather than panicking.  Production can't reach it
// — river's periodic scheduler only fires after Start, which is after
// Bind — but the contract has to match V1/V2/V3 so a bare
// &LateBoundEnqueuer{} stays a valid test fixture.
func TestLateBoundEnqueuer_DescriptionBackfillUnbound_NoOp(t *testing.T) {
	t.Parallel()

	l := &LateBoundEnqueuer{}
	require.NoError(t, l.EnqueueDescriptionBackfillMany(context.Background(), nil))
	require.NoError(t, l.EnqueueDescriptionBackfillMany(context.Background(),
		[]DescriptionBackfillArgs{{AnilistID: 1, BgmID: 100}}))
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
	var _ Enqueuer = (*LateBoundEnqueuer)(nil)
}

// TestNoopEnqueuer_HantBackfillReportsNotInserted pins the ONE thing that
// makes this method different from every other inert path above: it has to
// answer false, not true.
//
// The others return only an error, so "did nothing" and "did something"
// are indistinguishable by design.  This one feeds the admin endpoint's
// `enqueued` flag, which an operator reads as "a sweep is now scheduled".
// A Noop that answered true would make a mis-wired deployment look exactly
// like a working button.
func TestNoopEnqueuer_HantBackfillReportsNotInserted(t *testing.T) {
	t.Parallel()

	inserted, err := NoopEnqueuer{}.EnqueueHantBackfillNow(context.Background())
	require.NoError(t, err)
	require.False(t, inserted, "a no-op enqueuer must not claim it scheduled a sweep")
}

// TestLateBoundEnqueuer_HantBackfillUnbound_ReportsNotInserted is the same
// contract on the unbound path.  Unlike the sweeps fed only by river's
// periodic scheduler — which cannot fire before Bind — this method's caller
// is an HTTP route registered on the same router, so the unbound branch has
// to be honest rather than convenient.
func TestLateBoundEnqueuer_HantBackfillUnbound_ReportsNotInserted(t *testing.T) {
	t.Parallel()

	inserted, err := (&LateBoundEnqueuer{}).EnqueueHantBackfillNow(context.Background())
	require.NoError(t, err)
	require.False(t, inserted, "an unbound enqueuer must not claim it scheduled a sweep")
}
