//go:build integration

// queue_smoke_test.go — end-to-end smoke for the internal/queue boot path.
//
// Builds with `//go:build integration`.  Container lifecycle (Postgres
// testcontainer + migration apply) is owned by TestMain in
// migrate_test.go; this file reuses pgURIGlobal and opens its own
// pgxpool per test so a leak in one test cannot poison another.
//
// What this asserts (the contract the P2.1.2 enrichment package will
// rely on):
//
//   1. queue.Boot accepts a real pool and returns a non-nil client
//      that can Start without error against the river schema already
//      applied by migrations 0007 + 0008.
//   2. client.Insert publishes the job AND the worker fires AND the
//      Subscribe(EventKindJobCompleted) channel reports completion
//      with the right Kind.
//   3. client.InsertTx inside a transaction defers the work until
//      Commit and then dispatches to the worker.
//   4. The stub workers actually return nil so jobs complete (not
//      fail) — important because the integration suite is the first
//      place we see a panic/error from the stubs.
//
// Why subscribe rather than poll river_job table:  river's Subscribe
// channel is buffered (1000 events default) and non-blocking — drop
// is possible only under load, which this 3-job test cannot trigger.
// Polling would race against river's own retention sweep, which can
// delete completed jobs before our SELECT lands.
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// noHitBangumi is a stub BangumiV12Client used by the queue smoke
// tests to exercise the REAL V1 + V2 + V3 workers without hitting
// api.bgm.tv.  Search/Subject/Characters all return ErrNotFound, which
// drives V1.Work() and V2.Work() down the "permanent no-hit → return
// nil" branch and V3.Work() down its "Subject not found → still bump
// version=3" terminal branch.  Combined with noRowV12DB below this
// keeps the V1/V2/V3 completion paths deterministic while still
// going through the production wiring.
type noHitBangumi struct{}

func (noHitBangumi) Search(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
	return nil, bangumi.ErrNotFound
}

func (noHitBangumi) Subject(_ context.Context, _ int) (*bangumi.Subject, error) {
	return nil, bangumi.ErrNotFound
}

func (noHitBangumi) Characters(_ context.Context, _ int) ([]bangumi.Character, error) {
	return nil, bangumi.ErrNotFound
}

// noRowV12DB is a stub V12DB used alongside noHitBangumi.  ErrNoRows
// on the V1 read short-circuits V1.Work() before Search is even
// called.  UpdateBangumiV2 / UpdateAnimeCharacterCN are unreachable
// because V2.Work() bails on Subject ErrNotFound first.  V3.Work()
// always calls UpdateBangumiV3 (terminal heal bumps version=3 even
// on 404) so the V3 write is implemented as a no-op so the smoke
// test path doesn't fail on row-not-found.
// Belt-and-braces so the smoke test never accidentally races against
// a real Bangumi HTTP request.
type noRowV12DB struct{}

func (noRowV12DB) GetAnimeForBangumiSearch(_ context.Context, _ int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
	return dbgen.GetAnimeForBangumiSearchRow{}, pgx.ErrNoRows
}

func (noRowV12DB) UpdateBangumiV1(_ context.Context, _ int32, _ *int32, _ *string) error {
	return nil
}

func (noRowV12DB) UpdateBangumiV2(_ context.Context, _ int32, _ *float64, _ *int32, _ *string) error {
	return nil
}

func (noRowV12DB) UpdateBangumiV3(_ context.Context, _ int32, _ *string) error {
	return nil
}

func (noRowV12DB) UpdateAnimeCharacterCN(_ context.Context, _ int32, _ *string, _ *string, _ *string, _ *string) error {
	return nil
}

// UpsertAnimeCache satisfies queue.WarmSeasonDB.  The warm-season smoke
// test uses a stub AniList that returns an empty page, so this method
// is never actually called — but it must exist for the V12DB embedding
// to compile.
func (noRowV12DB) UpsertAnimeCache(_ context.Context, _ dbgen.UpsertAnimeCacheParams) error {
	return nil
}

// GetTitleChineseByAnilistIDs satisfies queue.WarmSeasonDB.  Returns
// an empty slice so any code path that reaches it short-circuits the
// "filter version=0" branch cleanly.
func (noRowV12DB) GetTitleChineseByAnilistIDs(_ context.Context, _ []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
	return []dbgen.GetTitleChineseByAnilistIDsRow{}, nil
}

// emptyAniList is a stub AniListSeasonalFetcher used by the queue
// smoke tests.  Seasonal() returns an empty page with HasNextPage=false
// so the warm-season worker's page loop exits after one fetch — clean
// "completed" terminal state without dragging a real AniList HTTP
// fake into the smoke suite.
type emptyAniList struct{}

func (emptyAniList) Seasonal(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
	return &anilist.SeasonalAnimeResponse{
		Page: anilist.MediaPage{
			PageInfo: anilist.PageInfo{HasNextPage: false},
			Media:    []anilist.Media{},
		},
	}, nil
}

// queueSmokeWaitTimeout bounds how long we wait for a stub job to
// land in the JobCompleted subscription channel.  Stubs return nil
// immediately, but river's fetch interval (~100ms FetchCooldown +
// LISTEN/NOTIFY latency) is the real floor.  Keep generous so flakey
// CI runners don't surface as false failures.
const queueSmokeWaitTimeout = 10 * time.Second

// bootQueueForTest constructs a queue.Boot result against a freshly
// opened pool and starts the client.  Pool + client are auto-cleaned
// via t.Cleanup so each Test* gets an independent dispatch loop and
// teardown is deterministic even on test failure.
//
// All three workers (V1, V2, V3) are REAL — bound to noHitBangumi +
// noRowV12DB so they always land on the deterministic "no-hit /
// no-subject → return nil" branches.  This exercises the production
// WorkersWithBangumi wiring (including V3 which is new in P2.1.8)
// while keeping the smoke deterministic (no live HTTP, no real DB
// row).
//
// Returns the client (typed concretely for the Subscribe + Insert
// surface the tests need).
func bootQueueForTest(t *testing.T, ctx context.Context) *river.Client[pgx.Tx] {
	t.Helper()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	c, err := queue.Boot(pool, queue.Config{
		Workers: queue.WorkersWithBangumi(noHitBangumi{}, emptyAniList{}, noRowV12DB{}, queue.NoopEnqueuer{}),
	})
	require.NoError(t, err, "queue.Boot")
	require.NotNil(t, c, "queue.Boot must return a client")

	require.NoError(t, c.Start(ctx), "client.Start")
	t.Cleanup(func() {
		// Bounded shutdown so the suite doesn't hang on a stuck client.
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = c.Stop(stopCtx)
	})

	return c
}

// TestQueue_EnqueueRunComplete is the gold-standard happy path:
// enqueue a v1 job, wait for the JobCompleted event, assert kind.
func TestQueue_EnqueueRunComplete(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	c := bootQueueForTest(t, ctx)

	subscribeChan, subscribeCancel := c.Subscribe(river.EventKindJobCompleted)
	defer subscribeCancel()

	_, err := c.Insert(ctx, queue.BangumiV1Args{AnilistID: 1234}, nil)
	require.NoError(t, err, "client.Insert v1")

	waitCtx, waitCancel := context.WithTimeout(ctx, queueSmokeWaitTimeout)
	defer waitCancel()

	select {
	case ev := <-subscribeChan:
		require.NotNil(t, ev, "subscribe channel must not deliver nil events")
		require.NotNil(t, ev.Job, "event.Job must be populated")
		assert.Equal(t, "bangumi_v1", ev.Job.Kind, "completed job kind drift")
		assert.Equal(t, "completed", string(ev.Job.State), "job must reach completed state")
	case <-waitCtx.Done():
		t.Fatalf("timed out after %s waiting for v1 completion: %v",
			queueSmokeWaitTimeout, waitCtx.Err())
	}
}

// TestQueue_TransactionalInsert verifies the InsertTx surface: a job
// enqueued inside a transaction is NOT dispatched until Commit, and
// IS dispatched after Commit.  This is the path the P2.1.2 enrichment
// pipeline will use to atomically write anime_cache row + enqueue v1.
func TestQueue_TransactionalInsert(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	c, err := queue.Boot(pool, queue.Config{})
	require.NoError(t, err)
	require.NoError(t, c.Start(ctx))
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer stopCancel()
		_ = c.Stop(stopCtx)
	})

	subscribeChan, subscribeCancel := c.Subscribe(river.EventKindJobCompleted)
	defer subscribeCancel()

	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "pool.Begin")

	_, err = c.InsertTx(ctx, tx, queue.BangumiV2Args{AnilistID: 9999, BgmID: 42}, nil)
	require.NoError(t, err, "InsertTx v2")

	// Pre-commit:  the worker must NOT see the job yet (snapshot
	// visibility).  Give the fetcher a generous beat to NOT pick it up.
	select {
	case ev := <-subscribeChan:
		t.Fatalf("worker fired pre-commit (data leak): kind=%s", ev.Job.Kind)
	case <-time.After(500 * time.Millisecond):
		// expected — no event yet
	}

	require.NoError(t, tx.Commit(ctx), "tx.Commit")

	// Post-commit:  the job becomes visible and fires.
	waitCtx, waitCancel := context.WithTimeout(ctx, queueSmokeWaitTimeout)
	defer waitCancel()

	select {
	case ev := <-subscribeChan:
		require.NotNil(t, ev.Job)
		assert.Equal(t, "bangumi_v2", ev.Job.Kind)
		assert.Equal(t, "completed", string(ev.Job.State))
	case <-waitCtx.Done():
		t.Fatalf("InsertTx job didn't fire post-commit: %v", waitCtx.Err())
	}
}

// TestQueue_AllThreeKindsDispatch confirms all 3 stubs are wired by
// dispatching one of each, then waiting for 3 JobCompleted events.
// Uses a set rather than a slice so the assertion is order-independent
// (river's fetcher does not guarantee order).
func TestQueue_AllThreeKindsDispatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	c := bootQueueForTest(t, ctx)

	subscribeChan, subscribeCancel := c.Subscribe(river.EventKindJobCompleted)
	defer subscribeCancel()

	_, err := c.Insert(ctx, queue.BangumiV1Args{AnilistID: 1}, nil)
	require.NoError(t, err)
	_, err = c.Insert(ctx, queue.BangumiV2Args{AnilistID: 1, BgmID: 100}, nil)
	require.NoError(t, err)
	_, err = c.Insert(ctx, queue.BangumiV3Args{AnilistID: 1, BgmID: 100}, nil)
	require.NoError(t, err)

	seen := map[string]bool{}
	waitCtx, waitCancel := context.WithTimeout(ctx, queueSmokeWaitTimeout)
	defer waitCancel()

	for len(seen) < 3 {
		select {
		case ev := <-subscribeChan:
			require.NotNil(t, ev.Job)
			seen[ev.Job.Kind] = true
		case <-waitCtx.Done():
			t.Fatalf("only saw %d/3 kinds before timeout: %v (err=%v)",
				len(seen), seen, waitCtx.Err())
		}
	}

	assert.True(t, seen["bangumi_v1"], "v1 should have completed")
	assert.True(t, seen["bangumi_v2"], "v2 should have completed")
	assert.True(t, seen["bangumi_v3"], "v3 should have completed")
}

// TestQueue_BootRejectsNilPool reconfirms the unit-test invariant in
// the integration env — surfaces if a dependency upgrade changes the
// nil-pool semantics.
func TestQueue_BootRejectsNilPool(t *testing.T) {
	t.Parallel()
	c, err := queue.Boot(nil, queue.Config{})
	assert.Nil(t, c)
	assert.True(t, errors.Is(err, queue.ErrMissingPool),
		"Boot(nil, …) should return ErrMissingPool, got: %v", err)
}

// TestQueue_WarmSeason_Dispatched exercises the new warm-season worker
// end-to-end through the river dispatch loop.  Uses emptyAniList so the
// worker's page loop exits after one fetch (empty media → empty upsert
// batch → no enqueue) and lands in "completed" state — no real AniList
// HTTP, no real cache row needed.
//
// This validates that:
//   - WorkersWithBangumi registers the warm_season kind correctly
//   - WarmSeasonArgs round-trips through river's serializer
//   - The worker completes without error on an empty season
func TestQueue_WarmSeason_Dispatched(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	c := bootQueueForTest(t, ctx)

	subscribeChan, subscribeCancel := c.Subscribe(river.EventKindJobCompleted)
	defer subscribeCancel()

	_, err := c.Insert(ctx, queue.WarmSeasonArgs{Season: "WINTER", Year: 2026}, nil)
	require.NoError(t, err, "client.Insert warm_season")

	waitCtx, waitCancel := context.WithTimeout(ctx, queueSmokeWaitTimeout)
	defer waitCancel()

	select {
	case ev := <-subscribeChan:
		require.NotNil(t, ev, "subscribe channel must not deliver nil events")
		require.NotNil(t, ev.Job, "event.Job must be populated")
		assert.Equal(t, "warm_season", ev.Job.Kind,
			"completed job kind drift")
		assert.Equal(t, "completed", string(ev.Job.State),
			"warm_season job must reach completed state")
	case <-waitCtx.Done():
		t.Fatalf("timed out after %s waiting for warm_season completion: %v",
			queueSmokeWaitTimeout, waitCtx.Err())
	}
}
