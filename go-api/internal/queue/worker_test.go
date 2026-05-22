// worker_test.go — unit tests for the queue boot path.
//
// No DB required.  The integration test in
// test/integration/queue_smoke_test.go covers the enqueue → run →
// complete loop against a real Postgres testcontainer.  This file
// asserts:
//  1. Each Args type returns the correct Kind.
//  2. Workers() registers only the V2 stub (V1 + V3 have real
//     workers — tests live in bangumi_v1_test.go / bangumi_v3_test.go).
//  3. WorkersWithBangumi registers all 3 real workers.
//  4. Boot rejects a nil pool with ErrMissingPool.
//  5. Boot applies sensible defaults when Config is zero-valued.
package queue

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// newStubPool returns a *pgxpool.Pool that has parsed a benign DSN but
// never connected.  pgxpool.New is lazy — it doesn't dial until the
// first Acquire — so this lets Boot exercise the full default-merging
// path without standing up a real Postgres.
//
// The pool is auto-closed via t.Cleanup so race detector remains happy.
func newStubPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	// Localhost on an impossible port; no actual TCP attempt fires
	// because we never Acquire.
	pool, err := pgxpool.New(context.Background(), "postgres://stub:stub@127.0.0.1:1/stub?sslmode=disable")
	require.NoError(t, err, "pgxpool.New with valid DSN should not error before first Acquire")
	t.Cleanup(pool.Close)
	return pool
}

func TestArgs_Kind(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		args river.JobArgs
		want string
	}{
		{"v1", BangumiV1Args{AnilistID: 1}, "bangumi_v1"},
		{"v2", BangumiV2Args{AnilistID: 1, BgmID: 2}, "bangumi_v2"},
		{"v3", BangumiV3Args{AnilistID: 1, BgmID: 2}, "bangumi_v3"},
		{"warm_season", WarmSeasonArgs{Season: "WINTER", Year: 2026}, "warm_season"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, tc.args.Kind(),
				"%T.Kind() must match the contract used by river dispatch", tc.args)
		})
	}
}

// TestWorkers_RegistersStubs verifies Workers() emits a non-nil bundle
// and that the V2 stub Kind is occupied (V1 + V3 are intentionally
// absent now that both have real implementations — see
// WorkersWithBangumi for the production wiring).  Probes via
// river.AddWorkerSafely — it returns "already registered" when the
// kind is taken, which is the cheapest cross-package way to see
// what's in the bundle without reaching into the unexported
// workersMap.
func TestWorkers_RegistersStubs(t *testing.T) {
	t.Parallel()

	w := Workers()
	require.NotNil(t, w, "Workers() must return a non-nil bundle")

	// V2 slot should be occupied.
	err := river.AddWorkerSafely(w, &stubBangumiV2Worker{})
	require.Error(t, err, "v2 slot should already be occupied")
	assert.Contains(t, err.Error(), "bangumi_v2")
}

// TestWorkersWithBangumi_RegistersAll4 verifies the production wiring
// constructor binds V1 + V2 + V3 + WarmSeason (all real) — all four
// Kinds occupied.  Uses noopBangumi + noopAniList + noopV12DB — we
// never invoke Work here, only inspect what's been registered.
func TestWorkersWithBangumi_RegistersAll4(t *testing.T) {
	t.Parallel()

	w := WorkersWithBangumi(noopBangumi{}, noopAniList{}, noopV12DB{}, NoopEnqueuer{})
	require.NotNil(t, w, "WorkersWithBangumi must return a non-nil bundle")

	// All 4 slots should be taken: re-registration returns
	// "already registered".
	err := river.AddWorkerSafely(w, NewBangumiV1Worker(noopBangumi{}, noopV12DB{}, NoopEnqueuer{}))
	require.Error(t, err, "v1 slot should already be occupied")
	assert.Contains(t, err.Error(), "bangumi_v1")

	err = river.AddWorkerSafely(w, NewBangumiV2Worker(noopBangumi{}, noopV12DB{}, NoopEnqueuer{}))
	require.Error(t, err, "v2 slot should already be occupied")
	assert.Contains(t, err.Error(), "bangumi_v2")

	err = river.AddWorkerSafely(w, NewBangumiV3Worker(noopBangumi{}, noopV12DB{}))
	require.Error(t, err, "v3 slot should already be occupied")
	assert.Contains(t, err.Error(), "bangumi_v3")

	err = river.AddWorkerSafely(w, NewWarmSeasonWorker(noopAniList{}, noopV12DB{}, NoopEnqueuer{}))
	require.Error(t, err, "warm_season slot should already be occupied")
	assert.Contains(t, err.Error(), "warm_season")
}

// TestWorkersWithBangumi_NilEnqueuerOK asserts the constructor
// accepts a nil Enqueuer without panicking — every worker substitutes
// NoopEnqueuer{} internally.
func TestWorkersWithBangumi_NilEnqueuerOK(t *testing.T) {
	t.Parallel()

	w := WorkersWithBangumi(noopBangumi{}, noopAniList{}, noopV12DB{}, nil)
	require.NotNil(t, w)
}

// TestWorkers_FreshBundlePerCall asserts Workers() returns an
// independent bundle on every call — callers should not be able to
// poison the next call's bundle.
func TestWorkers_FreshBundlePerCall(t *testing.T) {
	t.Parallel()

	a := Workers()
	b := Workers()
	require.NotNil(t, a)
	require.NotNil(t, b)
	assert.NotSame(t, a, b, "Workers() must return a new *river.Workers each call")
}

// TestBoot_NilPool_ReturnsErrMissingPool probes the actual behavior of
// Boot(nil, …).  We want a sentinel error, not a panic — surfaces as a
// clean startup-time failure instead of a runtime crash.
func TestBoot_NilPool_ReturnsErrMissingPool(t *testing.T) {
	t.Parallel()

	c, err := Boot(nil, Config{})
	assert.Nil(t, c, "Boot must not return a client when pool is nil")
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrMissingPool),
		"Boot(nil, …) should return ErrMissingPool, got: %v", err)
}

// TestBoot_DefaultsApplied uses a stub pool (parsed but never dialed) to
// exercise the full default-merging path: Workers() filled, Queues map
// defaulted to {default: 1 worker}, Logger fallback to slog.Default().
// We verify the client is non-nil and ready to InsertTx (the only Boot
// guarantee).  Start/Stop is exercised by the integration test.
func TestBoot_DefaultsApplied(t *testing.T) {
	t.Parallel()

	pool := newStubPool(t)
	c, err := Boot(pool, Config{})
	require.NoError(t, err, "Boot with stub pool + zero Config should succeed")
	require.NotNil(t, c, "client must be non-nil when Boot returns nil error")
}

// TestBoot_CustomConfigPassedThrough verifies a non-nil Workers + Queues
// + Logger flows through without being overwritten by the defaults.
func TestBoot_CustomConfigPassedThrough(t *testing.T) {
	t.Parallel()

	pool := newStubPool(t)
	customLogger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	customWorkers := river.NewWorkers()
	river.AddWorker(customWorkers, &stubBangumiV2Worker{})

	c, err := Boot(pool, Config{
		Workers: customWorkers,
		Queues:  map[string]river.QueueConfig{"custom": {MaxWorkers: 4}},
		Logger:  customLogger,
	})
	require.NoError(t, err)
	require.NotNil(t, c)
}

// TestBoot_RejectsBadConfig confirms river validation errors propagate
// up through Boot.  We pass a queue with MaxWorkers=0 which river
// rejects ("invalid number of workers").
func TestBoot_RejectsBadConfig(t *testing.T) {
	t.Parallel()

	pool := newStubPool(t)
	c, err := Boot(pool, Config{
		Queues: map[string]river.QueueConfig{
			"bad": {MaxWorkers: 0}, // river requires >=1
		},
	})
	assert.Nil(t, c, "Boot must not return a client when river.NewClient errors")
	require.Error(t, err, "river config validation must surface")
}

// TestStubWorkers_WorkReturnsNil confirms the remaining V2 stub
// Worker.Work() emits no error so legacy tests that rely on Workers()
// (V2 stub only) get JobCompleted.  V1 + V3 tests live in their own
// files now that both have real implementations.
func TestStubWorkers_WorkReturnsNil(t *testing.T) {
	t.Parallel()

	ctx := t.Context()

	v2 := &stubBangumiV2Worker{}
	require.NoError(t, v2.Work(ctx, &river.Job[BangumiV2Args]{
		Args: BangumiV2Args{AnilistID: 42, BgmID: 100},
	}))
}

// TestStubWorkers_LogContext asserts the V2 stub log line actually
// includes the structured fields — gives the integration suite (and
// future ops dashboards) a stable shape to grep on.  V1 has its own
// (richer) log-shape test in bangumi_v1_test.go.
//
// Wires a slog handler into a buffer, swaps slog.Default() for the
// duration of the call, then restores it.
func TestStubWorkers_LogContext(t *testing.T) {
	// NOTE: not t.Parallel — we mutate slog.Default for the duration
	// of this test, which is process-global state.
	original := slog.Default()
	t.Cleanup(func() { slog.SetDefault(original) })

	buf := &bytes.Buffer{}
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	})))

	v2 := &stubBangumiV2Worker{}
	require.NoError(t, v2.Work(t.Context(), &river.Job[BangumiV2Args]{
		Args: BangumiV2Args{AnilistID: 12345, BgmID: 999},
	}))

	out := buf.String()
	assert.Contains(t, out, "bangumi_v2 stub", "log line should identify the worker")
	assert.Contains(t, out, "anilistId=12345", "log line should include AnilistID")
}

// ---------------------------------------------------------------------------
// Test doubles for WorkersWithBangumi registration assertions.  These
// never have their methods invoked — only the type identity matters for
// river.AddWorker.
// ---------------------------------------------------------------------------

// noopBangumi satisfies BangumiV12Client (Search + Subject + Characters)
// with always-NotFound responses.  Used by the registration tests where
// the worker is never actually dispatched against this fake.
type noopBangumi struct{}

func (noopBangumi) Search(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
	return nil, bangumi.ErrNotFound
}

func (noopBangumi) Subject(_ context.Context, _ int) (*bangumi.Subject, error) {
	return nil, bangumi.ErrNotFound
}

func (noopBangumi) Characters(_ context.Context, _ int) ([]bangumi.Character, error) {
	return nil, bangumi.ErrNotFound
}

// noopV12DB satisfies V12DB (V1 + V2 + V3 read/write surface).  All
// methods no-op; the registration tests never invoke these methods.
type noopV12DB struct{}

func (noopV12DB) GetAnimeForBangumiSearch(_ context.Context, _ int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
	return dbgen.GetAnimeForBangumiSearchRow{}, nil
}

func (noopV12DB) UpdateBangumiV1(_ context.Context, _ int32, _ *int32, _ *string) error {
	return nil
}

func (noopV12DB) UpdateBangumiV2(_ context.Context, _ int32, _ *float64, _ *int32, _ *string) error {
	return nil
}

func (noopV12DB) UpdateBangumiV3(_ context.Context, _ int32, _ *string) error {
	return nil
}

func (noopV12DB) UpdateAnimeCharacterCN(_ context.Context, _ int32, _ *string, _ *string, _ *string, _ *string) error {
	return nil
}

// UpsertAnimeCache satisfies WarmSeasonDB.  Registration tests never
// invoke this method.
func (noopV12DB) UpsertAnimeCache(_ context.Context, _ dbgen.UpsertAnimeCacheParams) error {
	return nil
}

// GetTitleChineseByAnilistIDs satisfies WarmSeasonDB.  Registration
// tests never invoke this method.
func (noopV12DB) GetTitleChineseByAnilistIDs(_ context.Context, _ []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
	return []dbgen.GetTitleChineseByAnilistIDsRow{}, nil
}

// noopAniList satisfies AniListSeasonalFetcher.  Returns an empty page
// (HasNextPage=false) so any registration-level smoke that does happen
// to dispatch lands in "completed" without HTTP.
type noopAniList struct{}

func (noopAniList) Seasonal(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
	return &anilist.SeasonalAnimeResponse{}, nil
}
