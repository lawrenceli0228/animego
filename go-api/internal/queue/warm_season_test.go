// warm_season_test.go — unit tests for the periodic seasonal warm worker.
//
// No real AniList HTTP, no real DB.  Each test wires a fake
// AniListSeasonalFetcher + fake WarmSeasonDB + fake Enqueuer to assert
// the Work() decision tree:
//
//   - Pagination loop (single page, multi-page, HasNextPage handling)
//   - Pagination cap (20 pages even if HasNextPage stays true)
//   - Per-row upsert error tolerance (continue on individual failure)
//   - AniList error returns wrapped for retry
//   - Enrichment trigger only fires for bangumi_version=0 rows
//   - Empty season → no upsert, no enqueue, no error
//   - Enqueuer failure is non-fatal
//   - Season/year helpers (CurrentSeason, NextSeason boundary cases)
//
// In-package tests so unexported helpers stay testable without
// widening the export surface.
package queue

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeAniListSeasonal is a programmable stand-in for *anilist.Client.
// The seasonalFn closure decides the response per call so tests can
// drive HasNextPage transitions and error injection on the same fetcher.
type fakeAniListSeasonal struct {
	mu         sync.Mutex
	seasonalFn func(ctx context.Context, v anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error)
	calls      []anilist.SeasonalVars
}

func (f *fakeAniListSeasonal) Seasonal(ctx context.Context, v anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
	f.mu.Lock()
	f.calls = append(f.calls, v)
	fn := f.seasonalFn
	f.mu.Unlock()
	if fn == nil {
		return &anilist.SeasonalAnimeResponse{}, nil
	}
	return fn(ctx, v)
}

func (f *fakeAniListSeasonal) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// fakeWarmDB is a programmable WarmSeasonDB.  UpsertAnimeCache,
// GetTitleChineseByAnilistIDs and the episodes_bgm candidate query all record
// into the same struct so a single test can assert on every surface without
// juggling pointers.
type fakeWarmDB struct {
	mu              sync.Mutex
	upsertFn        func(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error
	getChineseFn    func(ctx context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error)
	epCandidatesFn  func(ctx context.Context, arg dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error)
	upsertCalls     []dbgen.UpsertAnimeCacheParams
	getChineseCalls [][]int32
	epCandidateArgs []dbgen.ListEpisodesBgmCandidatesParams
}

// ListEpisodesBgmCandidates records the params the warm worker narrowed the
// sweep's candidate query with.  Recording the whole params struct — not just
// the ids — is deliberate: the seed reusing the sweep's cooldowns rather than
// inventing its own is the property that stops it becoming a route around them.
func (f *fakeWarmDB) ListEpisodesBgmCandidates(ctx context.Context, arg dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
	f.mu.Lock()
	f.epCandidateArgs = append(f.epCandidateArgs, arg)
	fn := f.epCandidatesFn
	f.mu.Unlock()
	if fn == nil {
		return []dbgen.ListEpisodesBgmCandidatesRow{}, nil
	}
	return fn(ctx, arg)
}

func (f *fakeWarmDB) snapshotEpCandidateArgs() []dbgen.ListEpisodesBgmCandidatesParams {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]dbgen.ListEpisodesBgmCandidatesParams, len(f.epCandidateArgs))
	copy(dup, f.epCandidateArgs)
	return dup
}

func (f *fakeWarmDB) UpsertAnimeCache(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error {
	f.mu.Lock()
	f.upsertCalls = append(f.upsertCalls, arg)
	fn := f.upsertFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, arg)
}

func (f *fakeWarmDB) GetTitleChineseByAnilistIDs(ctx context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
	dup := make([]int32, len(ids))
	copy(dup, ids)
	f.mu.Lock()
	f.getChineseCalls = append(f.getChineseCalls, dup)
	fn := f.getChineseFn
	f.mu.Unlock()
	if fn == nil {
		return []dbgen.GetTitleChineseByAnilistIDsRow{}, nil
	}
	return fn(ctx, ids)
}

func (f *fakeWarmDB) upsertCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.upsertCalls)
}

// fakeWarmEnqueuer records EnqueueV1Many and EnqueueEpisodesBgmMany calls so
// tests can assert which IDs were chained.  The remaining Enqueuer methods are
// no-ops since WarmSeasonWorker triggers only those two.
type fakeWarmEnqueuer struct {
	mu        sync.Mutex
	v1Fn      func(ctx context.Context, ids []int32) error
	v1Calls   [][]int32
	epFn      func(ctx context.Context, jobs []EpisodesBgmArgs) error
	epBatches [][]EpisodesBgmArgs
}

// EnqueueEpisodesBgmMany satisfies EpisodesBgmEnqueuer, which the warm worker
// reaches by type assertion off the general Enqueuer.  A double WITHOUT this
// method is a valid Enqueuer and simply gets no seed — so every assertion that
// the seed fired has to run against a double that has it.
func (f *fakeWarmEnqueuer) EnqueueEpisodesBgmMany(ctx context.Context, jobs []EpisodesBgmArgs) error {
	dup := make([]EpisodesBgmArgs, len(jobs))
	copy(dup, jobs)
	f.mu.Lock()
	f.epBatches = append(f.epBatches, dup)
	fn := f.epFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, jobs)
}

func (f *fakeWarmEnqueuer) snapshotEpBatches() [][]EpisodesBgmArgs {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([][]EpisodesBgmArgs, len(f.epBatches))
	copy(dup, f.epBatches)
	return dup
}

func (f *fakeWarmEnqueuer) EnqueueV1Many(ctx context.Context, ids []int32) error {
	dup := make([]int32, len(ids))
	copy(dup, ids)
	f.mu.Lock()
	f.v1Calls = append(f.v1Calls, dup)
	fn := f.v1Fn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, ids)
}

func (f *fakeWarmEnqueuer) EnqueueV2Many(_ context.Context, _ []BangumiV2Args) error {
	return nil
}

func (f *fakeWarmEnqueuer) EnqueueV3Many(_ context.Context, _ []BangumiV3Args) error {
	return nil
}

func (f *fakeWarmEnqueuer) EnqueueWarmSeasonNow(_ context.Context, _ WarmSeasonArgs) error {
	return nil
}

// EnqueueHantBackfillNow is a no-op stub: nothing in this test
// touches the zh-Hant sweep, and reporting "inserted" would be a lie
// no assertion here is watching for.
func (f *fakeWarmEnqueuer) EnqueueHantBackfillNow(_ context.Context) (bool, error) {
	return false, nil
}

func (f *fakeWarmEnqueuer) EnqueueDescriptionBackfillMany(_ context.Context, _ []DescriptionBackfillArgs) error {
	return nil
}

func (f *fakeWarmEnqueuer) EnqueueDescriptionLlmBackfillMany(_ context.Context, _ []DescriptionLlmBackfillArgs) error {
	return nil
}

func (f *fakeWarmEnqueuer) snapshotV1Calls() [][]int32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([][]int32, len(f.v1Calls))
	for i, c := range f.v1Calls {
		dupInner := make([]int32, len(c))
		copy(dupInner, c)
		dup[i] = dupInner
	}
	return dup
}

// makeMediaPage builds a fake AniList SeasonalAnimeResponse with the
// given IDs and the HasNextPage flag.  Cover image / title / colour
// fields stay nil — NormalizeMainRow tolerates that path (brand-fallback
// colour is applied internally).
func makeMediaPage(ids []int, hasNext bool) *anilist.SeasonalAnimeResponse {
	media := make([]anilist.Media, 0, len(ids))
	for _, id := range ids {
		media = append(media, anilist.Media{ID: id})
	}
	return &anilist.SeasonalAnimeResponse{
		Page: anilist.MediaPage{
			PageInfo: anilist.PageInfo{HasNextPage: hasNext, PerPage: warmSeasonPerPage},
			Media:    media,
		},
	}
}

// makeWorkJob constructs the *river.Job[WarmSeasonArgs] that worker.Work
// expects.  river embeds Args directly into Job, so a literal works.
func makeWorkJob(season string, year int) *river.Job[WarmSeasonArgs] {
	return &river.Job[WarmSeasonArgs]{
		Args: WarmSeasonArgs{Season: season, Year: year},
	}
}

// ---------------------------------------------------------------------------
// CurrentSeason / NextSeason
// ---------------------------------------------------------------------------

// TestCurrentSeason_PerMonthBoundaries asserts the quarter→season
// mapping over all 12 months.  Q1 Jan-Mar → WINTER, Q2 Apr-Jun →
// SPRING, Q3 Jul-Sep → SUMMER, Q4 Oct-Dec → FALL.  Year passes
// through unchanged.
func TestCurrentSeason_PerMonthBoundaries(t *testing.T) {
	t.Parallel()

	cases := []struct {
		month       time.Month
		wantSeason  string
		description string
	}{
		{time.January, "WINTER", "Jan is Q1 → WINTER"},
		{time.February, "WINTER", "Feb is Q1 → WINTER"},
		{time.March, "WINTER", "Mar is Q1 → WINTER"},
		{time.April, "SPRING", "Apr is Q2 → SPRING"},
		{time.May, "SPRING", "May is Q2 → SPRING"},
		{time.June, "SPRING", "Jun is Q2 → SPRING"},
		{time.July, "SUMMER", "Jul is Q3 → SUMMER"},
		{time.August, "SUMMER", "Aug is Q3 → SUMMER"},
		{time.September, "SUMMER", "Sep is Q3 → SUMMER"},
		{time.October, "FALL", "Oct is Q4 → FALL"},
		{time.November, "FALL", "Nov is Q4 → FALL"},
		{time.December, "FALL", "Dec is Q4 → FALL"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.month.String(), func(t *testing.T) {
			t.Parallel()
			tm := time.Date(2026, tc.month, 15, 12, 0, 0, 0, time.UTC)
			gotSeason, gotYear := CurrentSeason(tm)
			assert.Equal(t, tc.wantSeason, gotSeason, tc.description)
			assert.Equal(t, 2026, gotYear, "year passes through")
		})
	}
}

// TestNextSeason_ChainAndRollover walks all four canonical transitions
// + the FALL→WINTER year-rollover.  Defensive case: unknown season is
// returned as-is (worker should never see this in production).
func TestNextSeason_ChainAndRollover(t *testing.T) {
	t.Parallel()

	cases := []struct {
		season     string
		year       int
		wantSeason string
		wantYear   int
	}{
		{"WINTER", 2026, "SPRING", 2026},
		{"SPRING", 2026, "SUMMER", 2026},
		{"SUMMER", 2026, "FALL", 2026},
		{"FALL", 2025, "WINTER", 2026},     // year rollover
		{"FALL", 2026, "WINTER", 2027},     // another rollover
		{"unknown", 2026, "unknown", 2026}, // defensive passthrough
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.season, func(t *testing.T) {
			t.Parallel()
			s, y := NextSeason(tc.season, tc.year)
			assert.Equal(t, tc.wantSeason, s)
			assert.Equal(t, tc.wantYear, y)
		})
	}
}

// ---------------------------------------------------------------------------
// WarmSeasonWorker.Work
// ---------------------------------------------------------------------------

// TestWarmSeason_HappyPath_SinglePage covers the most common path:
// AniList returns one page (HasNextPage=false) with 5 media → 5
// upserts, one GetTitleChineseByAnilistIDs call, EnqueueV1Many called
// once with the subset where BangumiVersion=0.
func TestWarmSeason_HappyPath_SinglePage(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return makeMediaPage([]int{1, 2, 3, 4, 5}, false), nil
		},
	}
	// IDs 1, 3, 5 still at version=0; 2, 4 already enriched.
	db := &fakeWarmDB{
		getChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			rows := make([]dbgen.GetTitleChineseByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				ver := int32(0)
				if id == 2 || id == 4 {
					ver = 2
				}
				rows = append(rows, dbgen.GetTitleChineseByAnilistIDsRow{
					AnilistID: id, BangumiVersion: ver,
				})
			}
			return rows, nil
		},
	}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	err := w.Work(context.Background(), makeWorkJob("WINTER", 2026))
	require.NoError(t, err)

	assert.Equal(t, 1, ali.callCount(), "exactly one AniList page fetch")
	assert.Equal(t, 5, db.upsertCount(), "5 rows upserted")

	calls := enq.snapshotV1Calls()
	require.Len(t, calls, 1, "exactly one EnqueueV1Many call")
	assert.ElementsMatch(t, []int32{1, 3, 5}, calls[0],
		"only the bangumi_version=0 ids are chained")
}

// TestWarmSeason_Pagination_MultiPage covers the multi-page loop:
// HasNextPage=true on page 1 then false on page 2.  Asserts 2 AniList
// calls + 10 total upserts + one chained enqueue with all 10 IDs.
func TestWarmSeason_Pagination_MultiPage(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{}
	ali.seasonalFn = func(_ context.Context, v anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
		switch v.Page {
		case 1:
			return makeMediaPage([]int{1, 2, 3, 4, 5}, true), nil
		case 2:
			return makeMediaPage([]int{6, 7, 8, 9, 10}, false), nil
		default:
			t.Fatalf("unexpected page %d", v.Page)
			return nil, nil
		}
	}
	db := &fakeWarmDB{
		getChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			rows := make([]dbgen.GetTitleChineseByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				rows = append(rows, dbgen.GetTitleChineseByAnilistIDsRow{
					AnilistID: id, BangumiVersion: 0,
				})
			}
			return rows, nil
		},
	}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	err := w.Work(context.Background(), makeWorkJob("SPRING", 2026))
	require.NoError(t, err)

	assert.Equal(t, 2, ali.callCount(), "two AniList pages fetched")
	assert.Equal(t, 10, db.upsertCount(), "10 rows upserted across pages")

	calls := enq.snapshotV1Calls()
	require.Len(t, calls, 1)
	assert.ElementsMatch(t,
		[]int32{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}, calls[0])
}

// TestWarmSeason_PaginationCap_20Pages asserts the worker stops at the
// hard 20-page cap even when AniList stubbornly keeps returning
// HasNextPage=true.  Final outcome is success (nil) — the sanity cap
// logs a warning but does NOT retry, because retrying wouldn't fix the
// runaway response anyway.
func TestWarmSeason_PaginationCap_20Pages(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			// Always say "more pages incoming" — worker must stop on its own.
			return makeMediaPage([]int{42}, true), nil
		},
	}
	db := &fakeWarmDB{}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	err := w.Work(context.Background(), makeWorkJob("SUMMER", 2026))
	require.NoError(t, err, "sanity-cap hit returns nil, not error")

	assert.Equal(t, warmSeasonMaxPages, ali.callCount(),
		"worker stops at warmSeasonMaxPages even on runaway HasNextPage")
}

// TestWarmSeason_AniListError_ReturnsWrappedForRetry asserts an
// AniList ErrUpstream surfaces as a wrapped error from Work so river
// retries the job per its default policy.
func TestWarmSeason_AniListError_ReturnsWrappedForRetry(t *testing.T) {
	t.Parallel()

	upstream := &anilist.ErrUpstream{Status: 502, Message: "bad gateway"}
	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return nil, upstream
		},
	}
	db := &fakeWarmDB{}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	err := w.Work(context.Background(), makeWorkJob("FALL", 2026))
	require.Error(t, err, "AniList upstream error must propagate for retry")

	var asUpstream *anilist.ErrUpstream
	require.True(t, errors.As(err, &asUpstream),
		"wrapped error must preserve ErrUpstream for handler classification")
	assert.Equal(t, 502, asUpstream.Status)

	assert.Equal(t, 0, db.upsertCount(), "no upserts on AniList failure")
	assert.Empty(t, enq.snapshotV1Calls(), "no enqueue on AniList failure")
}

// TestWarmSeason_AniListRateLimit_ReturnsWrappedForRetry asserts the
// ErrRateLimited sentinel also bubbles up wrapped — distinct branch
// in the worker's error classification, deserves its own test.
func TestWarmSeason_AniListRateLimit_ReturnsWrappedForRetry(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return nil, anilist.ErrRateLimited
		},
	}
	w := NewWarmSeasonWorker(ali, &fakeWarmDB{}, &fakeWarmEnqueuer{})
	err := w.Work(context.Background(), makeWorkJob("WINTER", 2026))
	require.Error(t, err)
	assert.True(t, errors.Is(err, anilist.ErrRateLimited),
		"wrapped error must preserve ErrRateLimited sentinel")
}

// TestWarmSeason_UpsertErrorPerRow_Continues asserts a single bad
// UpsertAnimeCache does NOT abort the page — other rows still upsert,
// the chain still fires for the survivors, and Work returns nil.
func TestWarmSeason_UpsertErrorPerRow_Continues(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return makeMediaPage([]int{1, 2, 3, 4, 5}, false), nil
		},
	}
	db := &fakeWarmDB{
		upsertFn: func(_ context.Context, arg dbgen.UpsertAnimeCacheParams) error {
			if arg.AnilistID == 3 {
				return errors.New("simulated upsert failure")
			}
			return nil
		},
		getChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			rows := make([]dbgen.GetTitleChineseByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				rows = append(rows, dbgen.GetTitleChineseByAnilistIDsRow{
					AnilistID: id, BangumiVersion: 0,
				})
			}
			return rows, nil
		},
	}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	err := w.Work(context.Background(), makeWorkJob("WINTER", 2026))
	require.NoError(t, err, "per-row upsert failure is non-fatal")

	// All 5 attempted (upsertCount counts attempts, not successes).
	assert.Equal(t, 5, db.upsertCount(), "all 5 rows attempted")

	// Only the 4 successful upserts are chained for enrichment.
	calls := enq.snapshotV1Calls()
	require.Len(t, calls, 1)
	assert.ElementsMatch(t, []int32{1, 2, 4, 5}, calls[0],
		"failed-upsert row 3 must NOT be in the V1 enqueue batch")
}

// TestWarmSeason_EnqueueErrorIsNonFatal asserts that a failing
// EnqueueV1Many call does NOT propagate — Work still returns nil
// because the cache rows have already landed.  Missing the enqueue
// just means titleChinese stays null until the next miss; ScanAndEnqueueOrphans
// will catch it on next boot.
func TestWarmSeason_EnqueueErrorIsNonFatal(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return makeMediaPage([]int{1, 2}, false), nil
		},
	}
	db := &fakeWarmDB{
		getChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			rows := make([]dbgen.GetTitleChineseByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				rows = append(rows, dbgen.GetTitleChineseByAnilistIDsRow{
					AnilistID: id, BangumiVersion: 0,
				})
			}
			return rows, nil
		},
	}
	enq := &fakeWarmEnqueuer{
		v1Fn: func(_ context.Context, _ []int32) error {
			return errors.New("river temporarily unavailable")
		},
	}

	w := NewWarmSeasonWorker(ali, db, enq)
	err := w.Work(context.Background(), makeWorkJob("FALL", 2026))
	require.NoError(t, err, "enqueue failure must not block worker completion")
	assert.Equal(t, 2, db.upsertCount(), "upserts happen regardless of enqueue outcome")
}

// TestWarmSeason_GetTitleChineseError_NoEnqueue asserts a failing
// GetTitleChineseByAnilistIDs lookup is logged + swallowed (no enqueue
// fires).  Work still returns nil — the row data is in the cache,
// missing the enqueue is non-fatal.
func TestWarmSeason_GetTitleChineseError_NoEnqueue(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return makeMediaPage([]int{1, 2}, false), nil
		},
	}
	db := &fakeWarmDB{
		getChineseFn: func(_ context.Context, _ []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			return nil, errors.New("simulated lookup failure")
		},
	}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	err := w.Work(context.Background(), makeWorkJob("SPRING", 2026))
	require.NoError(t, err)
	assert.Empty(t, enq.snapshotV1Calls(), "lookup failure means no enqueue")
}

// TestWarmSeason_EmptySeason_NoEnqueue asserts a season with no media
// (AniList returns empty Page.Media) completes cleanly without
// touching the DB lookup or the enqueuer.
func TestWarmSeason_EmptySeason_NoEnqueue(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return makeMediaPage([]int{}, false), nil
		},
	}
	db := &fakeWarmDB{}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	err := w.Work(context.Background(), makeWorkJob("WINTER", 2026))
	require.NoError(t, err)
	assert.Equal(t, 0, db.upsertCount())
	assert.Empty(t, enq.snapshotV1Calls())
	// No GetTitleChineseByAnilistIDs call either — short-circuited
	// because upsertedIDs is empty after the page loop.
	db.mu.Lock()
	getCalls := len(db.getChineseCalls)
	db.mu.Unlock()
	assert.Equal(t, 0, getCalls,
		"empty media must skip GetTitleChineseByAnilistIDs")
}

// TestWarmSeason_AllRowsEnriched_NoEnqueue asserts the path where all
// upserted IDs are already at bangumi_version>0 — no V1 chain fires,
// no error, GetTitleChineseByAnilistIDs is still called (we need it to
// know).
func TestWarmSeason_AllRowsEnriched_NoEnqueue(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return makeMediaPage([]int{1, 2, 3}, false), nil
		},
	}
	db := &fakeWarmDB{
		getChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			rows := make([]dbgen.GetTitleChineseByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				rows = append(rows, dbgen.GetTitleChineseByAnilistIDsRow{
					AnilistID: id, BangumiVersion: 3,
				})
			}
			return rows, nil
		},
	}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	require.NoError(t, w.Work(context.Background(), makeWorkJob("SUMMER", 2026)))
	assert.Empty(t, enq.snapshotV1Calls(),
		"no enqueue when every row is already enriched")
}

// TestNewWarmSeasonWorker_NilEnqueuer_DefaultsToNoop is a constructor
// guard.  Passing nil for enq must not nil-panic on the first Work()
// call — the constructor swaps in NoopEnqueuer{} matching V1 + V2
// worker behaviour.
func TestNewWarmSeasonWorker_NilEnqueuer_DefaultsToNoop(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return makeMediaPage([]int{1}, false), nil
		},
	}
	db := &fakeWarmDB{
		getChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			return []dbgen.GetTitleChineseByAnilistIDsRow{
				{AnilistID: ids[0], BangumiVersion: 0},
			}, nil
		},
	}

	w := NewWarmSeasonWorker(ali, db, nil)
	require.NotNil(t, w.enq, "nil enq must be replaced with NoopEnqueuer{}")
	require.NoError(t, w.Work(context.Background(), makeWorkJob("FALL", 2026)))
}

// TestPeriodicWarmSeasonJob_NotNil is a smoke check that the factory
// returns a usable *river.PeriodicJob.  The schedule/constructor
// internals are river's responsibility (not the worker's contract);
// we only own returning a non-nil value with a sensible Kind on its
// emitted Args.
func TestPeriodicWarmSeasonJob_NotNil(t *testing.T) {
	t.Parallel()

	pj := PeriodicWarmSeasonJob()
	require.NotNil(t, pj, "factory must return a non-nil PeriodicJob")
}

// ---------------------------------------------------------------------------
// The inferred-episode-count seed
// ---------------------------------------------------------------------------

// The warm worker is the ONE call site hooked as an event producer for the
// episode-count sweep, out of five that upsert anime_cache from AniList.  This
// pins that it fires, and that it narrows the sweep's own candidate query to
// the ids this warm touched rather than re-deriving candidacy from the AniList
// payload in hand.
func TestWarmSeason_SeedsEpisodesBgmForRowsItRefreshed(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return makeMediaPage([]int{10, 20, 30}, false), nil
		},
	}
	// Only 20 is a candidate: 10 already has an AniList episode count, 30 has
	// no binding yet.  The query decides that, not the worker.
	db := &fakeWarmDB{
		epCandidatesFn: func(_ context.Context, _ dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
			return []dbgen.ListEpisodesBgmCandidatesRow{
				{AnilistID: 20, BgmID: ptr(int32(222))},
			}, nil
		},
	}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	require.NoError(t, w.Work(context.Background(), makeWorkJob("WINTER", 2026)))

	args := db.snapshotEpCandidateArgs()
	require.Len(t, args, 1, "exactly one candidate lookup per warm")
	assert.ElementsMatch(t, []int32{10, 20, 30}, args[0].AnilistIds,
		"the seed must narrow to the ids this warm upserted, not sweep the catalogue")

	batches := enq.snapshotEpBatches()
	require.Len(t, batches, 1)
	assert.Equal(t, []EpisodesBgmArgs{{AnilistID: 20, BgmID: 222}}, batches[0])
}

// The seed reuses the sweep's cooldowns rather than inventing its own.  That is
// what stops it becoming a route AROUND them — a daily warm that ignored the
// rejected/undecided cooldowns would re-fetch every refused binding in the
// current season every single day.
func TestWarmSeason_SeedReusesTheSweepsCooldowns(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return makeMediaPage([]int{1}, false), nil
		},
	}
	db := &fakeWarmDB{}

	w := NewWarmSeasonWorker(ali, db, &fakeWarmEnqueuer{})
	require.NoError(t, w.Work(context.Background(), makeWorkJob("WINTER", 2026)))

	args := db.snapshotEpCandidateArgs()
	require.Len(t, args, 1)
	assert.Equal(t, episodesBgmCandidateParams([]int32{1}, 1), args[0],
		"the seed and the hourly sweep must build their params from one definition")
}

// A warm that upserted nothing must not issue the lookup at all — an empty id
// array would read as "the whole catalogue" in the candidate query, which is
// the opposite of what a zero-row warm should trigger.
func TestWarmSeason_EmptySeasonSkipsTheSeedEntirely(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{
		seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return makeMediaPage(nil, false), nil
		},
	}
	db := &fakeWarmDB{}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	require.NoError(t, w.Work(context.Background(), makeWorkJob("WINTER", 2026)))

	assert.Empty(t, db.snapshotEpCandidateArgs(),
		"an empty AnilistIds array means 'the whole catalogue' to the query — never send one")
	assert.Empty(t, enq.snapshotEpBatches())
}

// Seeding is an optimisation on top of an hourly sweep that covers the same
// rows, so neither a lookup failure nor an enqueue failure may fail the warm —
// the season data has already landed.
func TestWarmSeason_SeedFailuresAreNonFatal(t *testing.T) {
	t.Parallel()

	newAli := func() *fakeAniListSeasonal {
		return &fakeAniListSeasonal{
			seasonalFn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
				return makeMediaPage([]int{1}, false), nil
			},
		}
	}

	t.Run("candidate lookup fails", func(t *testing.T) {
		t.Parallel()
		db := &fakeWarmDB{
			epCandidatesFn: func(_ context.Context, _ dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
				return nil, errors.New("pool exhausted")
			},
		}
		w := NewWarmSeasonWorker(newAli(), db, &fakeWarmEnqueuer{})
		assert.NoError(t, w.Work(context.Background(), makeWorkJob("WINTER", 2026)))
	})

	t.Run("enqueue fails", func(t *testing.T) {
		t.Parallel()
		db := &fakeWarmDB{
			epCandidatesFn: func(_ context.Context, _ dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
				return []dbgen.ListEpisodesBgmCandidatesRow{{AnilistID: 1, BgmID: ptr(int32(11))}}, nil
			},
		}
		enq := &fakeWarmEnqueuer{
			epFn: func(_ context.Context, _ []EpisodesBgmArgs) error { return errors.New("river down") },
		}
		w := NewWarmSeasonWorker(newAli(), db, enq)
		assert.NoError(t, w.Work(context.Background(), makeWorkJob("WINTER", 2026)))
	})
}

// The seed must not become a second, unguarded producer.  The per-row worker
// enqueues nothing and never writes anime_cache.episodes, so nothing it does
// can put a row back into the candidate set — the only way a seeded row returns
// is the 24h warm schedule, and ByArgs dedupe collapses that against anything
// still queued.  This pins the half of that the queue package owns: one warm,
// one lookup, one batch.
func TestWarmSeason_SeedFiresOncePerWarm(t *testing.T) {
	t.Parallel()

	ali := &fakeAniListSeasonal{}
	ali.seasonalFn = func(_ context.Context, v anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
		if v.Page == 1 {
			return makeMediaPage([]int{1, 2}, true), nil
		}
		return makeMediaPage([]int{3, 4}, false), nil
	}
	db := &fakeWarmDB{
		epCandidatesFn: func(_ context.Context, arg dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
			rows := make([]dbgen.ListEpisodesBgmCandidatesRow, 0, len(arg.AnilistIds))
			for _, id := range arg.AnilistIds {
				rows = append(rows, dbgen.ListEpisodesBgmCandidatesRow{AnilistID: id, BgmID: ptr(id * 10)})
			}
			return rows, nil
		},
	}
	enq := &fakeWarmEnqueuer{}

	w := NewWarmSeasonWorker(ali, db, enq)
	require.NoError(t, w.Work(context.Background(), makeWorkJob("WINTER", 2026)))

	assert.Len(t, db.snapshotEpCandidateArgs(), 1,
		"the seed runs once after the page loop, not once per page")
	batches := enq.snapshotEpBatches()
	require.Len(t, batches, 1)
	assert.Len(t, batches[0], 4, "all four upserted ids reach the one batch")
}
